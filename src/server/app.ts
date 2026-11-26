import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { count, eq, sql } from 'drizzle-orm';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type PgBoss from 'pg-boss';
import type pg from 'pg';
import { z } from 'zod';
import { hashToken, newSessionToken, verifyPassword } from '../auth.ts';
import type { Db } from '../db/client.ts';
import { agentRuns, emails, flowReports, leaders, meetings, people, sessions, tasks, telegramClicks } from '../db/schema.ts';
import { departmentForLeader } from '../agents/k1.ts';
import { applyClick, pullInbox, requestFeed } from '../agents/intake.ts';
import { acceptWeek, acceptWeekByChat, weekScene } from '../agents/week.ts';
import { checkMail, mailConfig, readSyntheticInbox } from '../mail.ts';
import { applyOrigin, formOrigin } from '../http/origin.ts';
import { assertAuditConfirm, exampleQuote, FLOW_AUDIT_QUEUE, type FlowAuditJob } from '../jobs/flow-audit-job.ts';
import { answerCallback, parseCallback, parseRuleCallback, parseStart, sendMessage, sendRulesCard, telegramConfigured } from '../telegram.ts';

const COOKIE = 'sid';
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

const loginBody = z.object({
  login: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});

const jobBody = z.object({
  mode: z.enum(['from-json', 'model']).default('from-json'),
  confirm: z.boolean().optional(),
});

const telegramUpdate = z.object({
  update_id: z.number(),
  message: z
    .object({
      text: z.string().optional(),
      chat: z.object({ id: z.number() }),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().optional(),
      message: z.object({ chat: z.object({ id: z.number() }) }).optional(),
    })
    .optional(),
});

export interface AppDeps {
  db: Db;
  pool: pg.Pool;
  boss: PgBoss;
  standOrigin?: string;
  distDir?: string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: true, logger: { level: 'info' } });
  await app.register(cookie);
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  const fails = new Map<string, { n: number; at: number }>();

  async function currentLeader(request: FastifyRequest) {
    const token = request.cookies[COOKIE];
    if (!token) return null;
    const rows = await deps.db
      .select({
        id: leaders.id,
        login: leaders.login,
        name: leaders.name,
        telegramChatId: leaders.telegramChatId,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .innerJoin(leaders, eq(leaders.id, sessions.leaderId))
      .where(eq(sessions.tokenHash, hashToken(token)))
      .limit(1);
    const row = rows[0];
    if (!row || row.expiresAt.getTime() < Date.now()) return null;
    return row;
  }

  function setSession(reply: FastifyReply, request: FastifyRequest, token: string) {
    const secure = request.headers['x-forwarded-proto'] === 'https';
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: SESSION_MS / 1000,
    });
  }

  app.get('/api/health', async (_request, reply) => {
    try {
      await deps.pool.query('select 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.post('/api/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Введите логин и пароль' });
    const ip = request.ip;
    const fail = fails.get(ip);
    if (fail && Date.now() - fail.at < 10 * 60_000 && fail.n >= 20) {
      return reply.code(429).send({ error: 'Слишком много попыток. Подождите десять минут' });
    }
    const found = await deps.db.select().from(leaders).where(eq(leaders.login, parsed.data.login)).limit(1);
    const leader = found[0];
    const ok = leader ? await verifyPassword(parsed.data.password, leader.passwordHash) : false;
    if (!leader || !ok) {
      const prev = fails.get(ip);
      fails.set(ip, { n: prev && Date.now() - prev.at < 10 * 60_000 ? prev.n + 1 : 1, at: Date.now() });
      return reply.code(401).send({ error: 'Неверный логин или пароль' });
    }
    fails.delete(ip);
    const token = newSessionToken();
    const id = randomUUID();
    await deps.db.insert(sessions).values({
      id,
      leaderId: leader.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_MS),
    });
    setSession(reply, request, token);
    return { name: leader.name, login: leader.login };
  });

  app.post('/api/logout', async (request, reply) => {
    const token = request.cookies[COOKIE];
    if (token) await deps.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (request) => {
    const leader = await currentLeader(request);
    if (!leader) return { user: null };
    return { user: { name: leader.name, login: leader.login } };
  });

  app.get('/api/cabinet', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const [peopleN, emailN, meetingN, taskN, profileRow, department] = await Promise.all([
      deps.db.select({ n: count() }).from(people).where(eq(people.leaderId, leader.id)),
      deps.db.select({ n: count() }).from(emails).where(eq(emails.leaderId, leader.id)),
      deps.db.select({ n: count() }).from(meetings).where(eq(meetings.leaderId, leader.id)),
      deps.db.select({ n: count() }).from(tasks).where(eq(tasks.leaderId, leader.id)),
      deps.db.select({ profile: leaders.profile, linkCode: leaders.linkCode }).from(leaders).where(eq(leaders.id, leader.id)),
      departmentForLeader(deps.db, leader.id),
    ]);
    const last = await deps.db
      .select({ status: agentRuns.status, reason: agentRuns.reason, startedAt: agentRuns.startedAt })
      .from(agentRuns)
      .where(eq(agentRuns.agent, 'flow-audit'))
      .orderBy(sql`${agentRuns.startedAt} desc`)
      .limit(1);
    return {
      name: leader.name,
      profile: (profileRow[0]?.profile ?? '').slice(0, 700),
      linkCode: profileRow[0]?.linkCode ?? '',
      counts: {
        people: Number(peopleN[0]?.n ?? 0),
        emails: Number(emailN[0]?.n ?? 0),
        meetings: Number(meetingN[0]?.n ?? 0),
        tasks: Number(taskN[0]?.n ?? 0),
      },
      mail: mailConfig() ? 'configured' : 'missing',
      telegram: telegramConfigured() ? 'configured' : 'missing',
      department,
      feed: await requestFeed(deps.db, leader.id),
      week: await weekScene(deps.db, leader.id),
      lastAudit: last[0] ? { status: last[0].status, mode: last[0].reason, at: last[0].startedAt.toISOString() } : null,
    };
  });

  app.post('/api/rules/accept', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const scene = await acceptWeek(deps.db, leader.id);
    if (leader.telegramChatId && telegramConfigured()) {
      try {
        await sendRulesCard(
          `Правила недели приняты на стенде. Индекс ${scene.before}% → ${scene.after}%. Кнопка повторяет то же действие.`,
          leader.telegramChatId,
        );
      } catch (err) {
        console.error('Карточка правил в Telegram не ушла', err);
      }
    }
    return scene;
  });

  app.post('/api/mail/check', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    try {
      return await checkMail();
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'ошибка почты';
      return { configured: true, ok: false, detail };
    }
  });

  app.post('/api/mail/pull', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    try {
      const letters = await readSyntheticInbox();
      return await pullInbox(deps.db, leader.id, letters, 1);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'не удалось разобрать почту';
      return reply.code(502).send({ error: detail });
    }
  });

  app.get('/api/audit/report', async (request) => {
    const leader = await currentLeader(request);
    if (leader) {
      const rows = await deps.db.select().from(flowReports).where(eq(flowReports.leaderId, leader.id)).limit(1);
      const stored = rows[0]?.report;
      if (stored && typeof stored === 'object') return stored;
    }
    const example = JSON.parse(await readFile('reports/flow-audit.json', 'utf8')) as Record<string, unknown>;
    return { ...example, source: 'example' };
  });

  app.get('/api/jobs/flow-audit/quote', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const quote = await exampleQuote();
    return { ...quote, note: 'Цена прошлого прогона примера. Новый запишется только вам и общий отчёт не заменит.' };
  });

  app.post('/api/jobs/flow-audit', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const parsed = jobBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Неизвестный режим задания' });
    try {
      assertAuditConfirm(parsed.data.mode, parsed.data.confirm);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Нужно подтверждение';
      return reply.code(400).send({ error: detail });
    }
    const payload: FlowAuditJob = { mode: parsed.data.mode, leaderId: leader.id };
    const id = await deps.boss.send(FLOW_AUDIT_QUEUE, payload);
    if (!id) return reply.code(503).send({ error: 'Очередь не приняла задание' });
    return { id };
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const rows = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, request.params.id)).limit(1);
    const row = rows[0];
    if (!row || row.leaderId !== leader.id) return reply.code(404).send({ error: 'Задание не найдено' });
    return { id: row.id, status: row.status, detail: row.detail, mode: row.reason };
  });

  app.post('/api/telegram/webhook', async (request, reply) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret || request.headers['x-telegram-bot-api-secret-token'] !== secret) {
      return reply.code(404).send({ error: 'not found' });
    }
    const parsed = telegramUpdate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad update' });
    const update = parsed.data;
    if (update.callback_query?.data) {
      const parsedClick = parseCallback(update.callback_query.data);
      const ruleClick = parseRuleCallback(update.callback_query.data);
      const chatId = String(update.callback_query.message?.chat.id ?? '');
      await deps.db.insert(telegramClicks).values({
        updateId: update.update_id,
        chatId,
        data: update.callback_query.data,
        action: parsedClick?.action ?? (ruleClick ? 'accept' : null),
        receivedAt: new Date(),
      });
      let notice = parsedClick || ruleClick ? 'Кнопка получена' : 'Неизвестная кнопка';
      if (chatId && ruleClick) {
        try {
          notice = await acceptWeekByChat(deps.db, chatId);
        } catch (err) {
          notice = err instanceof Error ? err.message.slice(0, 180) : 'Не удалось выполнить';
        }
      } else if (parsedClick && chatId) {
        try {
          notice = await applyClick(deps.db, parsedClick.action, parsedClick.decisionId, chatId);
        } catch (err) {
          notice = err instanceof Error ? err.message.slice(0, 180) : 'Не удалось выполнить';
        }
      }
      if (telegramConfigured()) {
        try {
          await answerCallback(update.callback_query.id, notice);
        } catch (err) {
          console.error('Ответ Telegram на кнопку не ушёл', err);
        }
      }
      return { ok: true };
    }
    const text = update.message?.text;
    const chatId = update.message ? String(update.message.chat.id) : '';
    if (text && chatId) {
      const code = parseStart(text);
      if (code !== null) {
        if (!code) {
          if (telegramConfigured()) await sendMessage('Напишите /start и код со стенда.', chatId);
          return { ok: true };
        }
        const found = await deps.db.select().from(leaders).where(eq(leaders.linkCode, code)).limit(1);
        const leader = found[0];
        if (!leader) {
          if (telegramConfigured()) await sendMessage('Код не подошёл.', chatId);
          return { ok: true };
        }
        await deps.db.update(leaders).set({ telegramChatId: chatId }).where(eq(leaders.id, leader.id));
        if (telegramConfigured()) await sendMessage(`Чат привязан к ${leader.name}. Сообщения помощника подписаны как от ИИ-помощника.`, chatId);
      }
    }
    return { ok: true };
  });

  app.get('/form/form.json', async (request, reply) => {
    const raw = await readFile('form/form.json', 'utf8');
    const origin = formOrigin(request.headers, deps.standOrigin);
    return reply.type('application/json; charset=utf-8').header('Cache-Control', 'no-store').send(applyOrigin(raw, origin));
  });

  app.get('/form', async (_request, reply) => reply.redirect('/form/'));
  app.get('/form/', async (_request, reply) => {
    const html = await readFile('form/index.html', 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/audit', async (_request, reply) => reply.redirect('/audit/'));
  app.get('/audit/', async (_request, reply) => {
    const html = await readFile('web/audit/index.html', 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/reports/flow-audit.json', async (_request, reply) => {
    const raw = await readFile('reports/flow-audit.json', 'utf8');
    return reply.type('application/json; charset=utf-8').header('Cache-Control', 'no-store').send(raw);
  });
  app.get('/reports/flow-audit.md', async (_request, reply) => {
    const raw = await readFile('reports/flow-audit.md', 'utf8');
    return reply.type('text/markdown; charset=utf-8').send(raw);
  });

  const dist = deps.distDir ?? join(process.cwd(), 'web', 'dist');
  try {
    await readFile(join(dist, 'index.html'));
    await app.register(fastifyStatic, { root: join(dist, 'assets'), prefix: '/assets/', decorateReply: false });
    const index = async (_request: FastifyRequest, reply: FastifyReply) => {
      const html = await readFile(join(dist, 'index.html'), 'utf8');
      return reply.type('text/html; charset=utf-8').send(html);
    };
    app.get('/', index);
    app.get('/app', async (_request, reply) => reply.redirect('/'));
  } catch {
    app.get('/', async (_request, reply) => {
      return reply.type('text/html; charset=utf-8').send('<p>Интерфейс ещё не собран. Откройте /form/ или /audit/.</p>');
    });
  }

  return app;
}
