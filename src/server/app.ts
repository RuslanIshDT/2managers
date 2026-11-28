import { readFile } from 'node:fs/promises';
import { sceneWords } from '../agents/scene.ts';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { asc, count, desc, eq, sql } from 'drizzle-orm';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type PgBoss from 'pg-boss';
import type pg from 'pg';
import { z } from 'zod';
import { hashToken, newSessionToken, verifyPassword } from '../auth.ts';
import type { Db } from '../db/client.ts';
import { agentModels, agentRuns, emails, flowReports, leaderActs, leaders, mailIn, meetings, operations, people, protocols, revisions, sessions, tasks, telegramClicks } from '../db/schema.ts';
import { departmentForLeader } from '../agents/k1.ts';
import { accuracyView } from '../agents/accuracy.ts';
import { controlOf, withLeader } from '../agents/control.ts';
import { approveProtocol, askProtocolEdit, chooseProtocolScope, parseProtocolCallback, protocolCard, rejectProtocol, reviseProtocol, saveProtocolEdit, scopeProtocolByChat } from '../agents/protocol.ts';
import { costView, type OperationRow } from '../agents/cost.ts';
import { loadAudienceState } from '../agents/audience.ts';
import { confirmationPoints } from '../agents/confirm.ts';
import { deskForLeader } from '../agents/desk.ts';
import { combineMorning, interpretMorning, parseMorningStored, shapeWords, storeMorning } from '../agents/morning.ts';
import { standView } from '../agents/stand-sync.ts';
import { catalog, isAgentId, MODEL_AGENTS, priceWords } from '../agents/models.ts';
import { applyClick, applyLeaderAction, hideMailbox, pullInbox, requestFeed, saveEditText, saveLeaderEdit } from '../agents/intake.ts';
import { acceptWeek, acceptWeekByChat, weekScene } from '../agents/week.ts';
import { focusForLeader, sendFocus } from '../agents/focus-run.ts';
import { mirrorForLeader, sendWeeklyNote, setSeriesFate } from '../agents/mirror-run.ts';
import { checkMail, findOutgoing, mailConfig, readSyntheticInbox } from '../mail.ts';
import { standOwner } from '../agents/live-sources.ts';
import { connectLeader, leaderDirectory, leadersInSource, openSources, SOURCE_NOTE, storedLinks, STUB_NOTE, templateLists } from '../agents/connect.ts';
import { applyOrigin, formOrigin } from '../http/origin.ts';
import { assertAuditConfirm, exampleQuote, FLOW_AUDIT_QUEUE, type FlowAuditJob } from '../jobs/flow-audit-job.ts';
import { answerCallback, editChoiceKeyboard, parseCallback, parseRuleCallback, parseStart, sendMessage, sendRulesCard, telegramConfigured } from '../telegram.ts';

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

function confirmationNote(profile: string): string {
  if (confirmationPoints(profile).length) return '';
  return 'Правила подтверждения не заданы: обязательного подтверждения нет, руководителю уходит только то, что разбор письма сам отнёс к его решению.';
}

function revisionNote(understood: string, override = ''): string {
  const shape = parseMorningStored(understood);
  const base = shape ? shapeWords(shape) : '';
  return [base, override].filter(Boolean).join('. ');
}

async function revisionRows(db: Db, leaderId: string) {
  const rows = await db.select().from(revisions).where(eq(revisions.leaderId, leaderId)).orderBy(asc(revisions.createdAt));
  const morning = rows.flatMap((row) => {
    const shape = parseMorningStored(row.understood);
    return shape ? [{ id: row.id, at: row.createdAt.toISOString(), text: row.instead, shape }] : [];
  });
  const notes = combineMorning(morning).notes;
  return rows.map((row) => ({ ...row, note: revisionNote(row.understood, notes[row.id] ?? '') }));
}

async function morningUnderstood(leaderId: string, text: string): Promise<{ stored: string; note: string }> {
  const result = await interpretMorning(leaderId, text);
  if (!result.shape) return { stored: '', note: result.note };
  return { stored: storeMorning(result), note: result.note };
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

  app.get('/api/source', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const query = z
      .object({ kind: z.enum(['protocol', 'letter']), id: z.string().min(1).max(200) })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Некорректный запрос' });
    if (query.data.kind === 'protocol') {
      const [row] = await deps.db.select().from(protocols).where(eq(protocols.id, query.data.id)).limit(1);
      if (!row || row.leaderId !== leader.id) return reply.code(404).send({ error: 'Не найдено' });
      const steps = Array.isArray(row.steps)
        ? row.steps.flatMap((item) => (item && typeof item === 'object' && 'task' in item && typeof item.task === 'string' ? [item.task] : []))
        : [];
      return { title: 'Протокол', text: [row.body, steps.length ? `Поручения:\n${steps.map((step) => `— ${step}`).join('\n')}` : ''].filter(Boolean).join('\n\n') };
    }
    const letter = (await deps.db.select().from(mailIn).where(eq(mailIn.leaderId, leader.id))).find(
      (row) => row.syntheticId === query.data.id || row.messageId === query.data.id,
    );
    const catalog = letter
      ? null
      : (await deps.db.select().from(emails).where(eq(emails.leaderId, leader.id))).find((row) => row.externalId === query.data.id);
    const found = letter ?? catalog;
    if (found) return { title: found.subject, text: `${found.fromName}, ${found.received}\n\n${found.body}` };
    if ((await standOwner(deps.db)) === leader.id) {
      try {
        const sent = await findOutgoing(query.data.id);
        if (sent) return { title: sent.subject, text: `${sent.fromName}, ${sent.received}\n\n${sent.body}` };
      } catch (error) {
        console.error('Исходящее не открылось', error instanceof Error ? error.message : error);
      }
    }
    return reply.code(404).send({ error: 'Не найдено' });
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

  app.get('/api/leaders', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    return {
      note: 'Роли администратора нет. Подключить руководителя может любой, кто вошёл в кабинет.',
      leaders: await leaderDirectory(deps.db),
    };
  });

  app.get('/api/leaders/template', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const lists = templateLists(await readFile('data/profile-template.md', 'utf8'));
    return { note: SOURCE_NOTE, confirm: lists.confirm, time: lists.time };
  });

  app.get('/api/leaders/sources', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const taken = (await deps.db.select({ id: leaders.id }).from(leaders)).map((row) => row.id);
    return { note: SOURCE_NOTE, sources: await openSources('data', taken) };
  });

  app.get('/api/leaders/sources/:id', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const id = (request.params as { id?: string }).id ?? '';
    if (!/^[a-z0-9][a-z0-9._-]{0,40}$/i.test(id)) return reply.code(400).send({ error: 'Некорректный источник' });
    const taken = (await deps.db.select({ id: leaders.id }).from(leaders)).map((row) => row.id);
    if (taken.includes(id)) return reply.code(404).send({ error: 'Этот источник уже подключён' });
    try {
      return { leaders: await leadersInSource(join('data', id)) };
    } catch {
      return reply.code(404).send({ error: 'Источник не читается' });
    }
  });

  const connectBody = z.object({
    source: z.string().max(80),
    personId: z.string().max(80),
    login: z.string().max(80),
    password: z.string().max(200),
    confirm: z.array(z.string().max(300)).max(40).default([]),
    confirmOwn: z.string().max(2000).default(''),
    time: z.array(z.string().max(300)).max(40).default([]),
    timeOwn: z.string().max(2000).default(''),
    hours: z.string().max(20).default(''),
    mailAddress: z.string().max(200).default(''),
    mailPassword: z.string().max(200).default(''),
    calendarPassword: z.string().max(200).default(''),
    trackerOrg: z.string().max(200).default(''),
    trackerQueue: z.string().max(200).default(''),
    trackerToken: z.string().max(200).default(''),
  });

  app.post('/api/leaders', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const parsed = connectBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Проверьте поля формы', errors: ['Проверьте поля формы'] });
    const result = await connectLeader(deps.db, parsed.data);
    if (!result.ok) return reply.code(400).send({ error: 'Руководитель не подключён', errors: result.errors });
    return result.summary;
  });

  const linksBody = z.object({
    mailAddress: z.string().max(200).optional(),
    mailPassword: z.string().max(200).optional(),
    calendarPassword: z.string().max(200).optional(),
    trackerOrg: z.string().max(200).optional(),
    trackerQueue: z.string().max(200).optional(),
    trackerToken: z.string().max(200).optional(),
  });

  app.post('/api/connections', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const [row] = await deps.db.select({ locked: leaders.profileLocked }).from(leaders).where(eq(leaders.id, leader.id));
    if (!row?.locked) return reply.code(400).send({ error: 'Живые подключения этого руководителя задаются на стенде' });
    const parsed = linksBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Проверьте поля' });
    const saved = storedLinks(parsed.data);
    await deps.db.update(leaders).set(saved).where(eq(leaders.id, leader.id));
    return saved;
  });

  app.get('/api/cabinet', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const [peopleN, emailN, meetingN, taskN, profileRow, department] = await Promise.all([
      deps.db.select({ n: count() }).from(people).where(eq(people.leaderId, leader.id)),
      deps.db.select({ n: count() }).from(emails).where(eq(emails.leaderId, leader.id)),
      deps.db.select({ n: count() }).from(meetings).where(eq(meetings.leaderId, leader.id)),
      deps.db.select({ n: count() }).from(tasks).where(eq(tasks.leaderId, leader.id)),
      deps.db
        .select({
          profile: leaders.profile,
          linkCode: leaders.linkCode,
          profileLocked: leaders.profileLocked,
          mailAddress: leaders.mailAddress,
          trackerOrg: leaders.trackerOrg,
          trackerQueue: leaders.trackerQueue,
        })
        .from(leaders)
        .where(eq(leaders.id, leader.id)),
      departmentForLeader(deps.db, leader.id),
    ]);
    const taskRows = await deps.db
      .select({ title: tasks.title, owner: tasks.ownerName, due: tasks.dueOn, status: tasks.status })
      .from(tasks)
      .where(eq(tasks.leaderId, leader.id));
    const last = await deps.db
      .select({ status: agentRuns.status, reason: agentRuns.reason, startedAt: agentRuns.startedAt })
      .from(agentRuns)
      .where(eq(agentRuns.agent, 'flow-audit'))
      .orderBy(sql`${agentRuns.startedAt} desc`)
      .limit(1);
    const mirror = await mirrorForLeader(deps.db, leader.id);
    const ownAudit = await deps.db.select({ leaderId: flowReports.leaderId }).from(flowReports).where(eq(flowReports.leaderId, leader.id)).limit(1);
    const desk = await deskForLeader(
      deps.db,
      leader.id,
      ownAudit.length
        ? mirror.series.map((item) => ({ title: item.title, open: item.action === '' }))
        : [],
    );
    const audienceState = await loadAudienceState(deps.db, leader.id);
    const live = (await standOwner(deps.db)) === leader.id;
    const locked = profileRow[0]?.profileLocked ?? false;
    return {
      name: leader.name,
      scene: sceneWords(leader.id),
      profile: hideMailbox(profileRow[0]?.profile ?? '', mailConfig()?.user ?? ''),
      confirmation: confirmationNote(profileRow[0]?.profile ?? ''),
      audiences: audienceState.audiences.map((row) => ({ point: row.point, people: row.people.map((person) => person.name) })),
      audiencesBuilt: audienceState.built,
      linkCode: profileRow[0]?.linkCode ?? '',
      counts: {
        people: Number(peopleN[0]?.n ?? 0),
        emails: Number(emailN[0]?.n ?? 0),
        meetings: Number(meetingN[0]?.n ?? 0),
        tasks: Number(taskN[0]?.n ?? 0),
      },
      mail: live ? (mailConfig() ? 'configured' : 'missing') : 'stub',
      telegram: live ? (telegramConfigured() ? 'configured' : 'missing') : 'unbound',
      connections: {
        mode: live ? 'live' : 'stub',
        note: live ? '' : STUB_NOTE,
        editable: locked,
        mailAddress: locked ? (profileRow[0]?.mailAddress ?? '') : '',
        trackerOrg: locked ? (profileRow[0]?.trackerOrg ?? '') : '',
        trackerQueue: locked ? (profileRow[0]?.trackerQueue ?? '') : '',
      },
      department,
      feed: await requestFeed(deps.db, leader.id),
      week: await weekScene(deps.db, leader.id),
      focus: await focusForLeader(deps.db, leader.id, leader.name),
      mirror,
      desk,
      accuracy: await accuracyView(deps.db, leader.id),
      protocol: await protocolCard(deps.db, leader.id),
      stubs: {
        tasks: taskRows,
        meetings: await deps.db
          .select({ summary: meetings.summary, starts: meetings.startsAt })
          .from(meetings)
          .where(eq(meetings.leaderId, leader.id)),
      },
      control: controlOf(profileRow[0]?.profile ?? '', withLeader(profileRow[0]?.profile ?? '', leader.name, department.people.map((person) => ({
        name: person.name,
        goal: person.goal,
        leaderGoal: person.leaderGoal,
        emails: person.emails,
        kpis: person.kpis.map((kpi) => ({
          name: kpi.name,
          unit: kpi.unit,
          better: kpi.better,
          weeks: kpi.weeks.map((week) => ({ fact: week.fact, status: week.status })),
          quarter: kpi.quarter,
        })),
      }))), taskRows),
      revisions: await revisionRows(deps.db, leader.id),
      acts: (await deps.db.select().from(leaderActs).where(eq(leaderActs.leaderId, leader.id)).orderBy(desc(leaderActs.at)).limit(30)).map((row) => ({
        id: row.id,
        subject: row.subject,
        when: new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(row.at),
        action: row.action,
        result: row.result,
        original: row.originalDraft,
        approved: row.approvedText,
        auto: row.auto,
      })),
      protocols: (await deps.db.select().from(protocols).where(eq(protocols.leaderId, leader.id)).orderBy(asc(protocols.createdAt))).map((row) => ({
        id: row.id,
        status: row.status,
        title: row.source.replace(/-transcript\.txt$/, ''),
        pending: row.pendingRule.trim().length > 0,
      })),
      lastAudit: last[0] ? { status: last[0].status, mode: last[0].reason, at: last[0].startedAt.toISOString() } : null,
      stand: await standView(leader.id, deps.db),
    };
  });

  app.get('/api/models', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const saved = await deps.db.select().from(agentModels).where(eq(agentModels.leaderId, leader.id));
    const list = await catalog();
    const byId = new Map(list.models.map((model) => [model.id, model]));
    const fallback = process.env.LLM_MODEL || 'anthropic/claude-sonnet-5.5';
    return {
      error: list.error,
      agents: MODEL_AGENTS.map((agent) => {
        const model = saved.find((row) => row.agent === agent.id)?.model || fallback;
        const known = byId.get(model);
        return {
          id: agent.id,
          name: agent.name,
          model,
          price: known
            ? `${priceWords(known.promptPerMillion)} за млн входных, ${priceWords(known.completionPerMillion)} за млн выходных`
            : '',
        };
      }),
      catalog: list.models.map((model) => ({
        id: model.id,
        name: model.name,
        price: `${priceWords(model.promptPerMillion)} / ${priceWords(model.completionPerMillion)}`,
      })),
    };
  });

  app.post('/api/models', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const body = z.object({ agent: z.string(), model: z.string().trim().min(1).max(200) }).safeParse(request.body);
    if (!body.success || !isAgentId(body.data.agent)) return reply.code(400).send({ error: 'Неизвестный агент' });
    const list = await catalog();
    const fallback = process.env.LLM_MODEL || '';
    const allowed = new Set(list.models.map((model) => model.id));
    if (fallback) allowed.add(fallback);
    if (!allowed.has(body.data.model)) return reply.code(400).send({ error: 'Этой модели нет в каталоге с ответом по схеме' });
    await deps.db
      .insert(agentModels)
      .values({ leaderId: leader.id, agent: body.data.agent, model: body.data.model })
      .onConflictDoUpdate({ target: [agentModels.leaderId, agentModels.agent], set: { model: body.data.model } });
    return { ok: true };
  });

  app.get('/api/cost', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const rows = await deps.db
      .select()
      .from(operations)
      .where(eq(operations.leaderId, leader.id))
      .orderBy(desc(operations.createdAt))
      .limit(500);
    const mapped: OperationRow[] = rows.map((row) => ({
      id: row.id,
      leaderId: row.leaderId,
      agent: row.agent,
      title: row.title,
      model: row.model,
      calls: row.calls,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      ms: row.ms,
      costUsd: row.costUsd === null ? null : Number(row.costUsd),
      priced: row.priced,
      traceId: row.traceId,
      createdAt: row.createdAt.toISOString(),
    }));
    return costView(mapped, new Date(), process.env.LANGFUSE_PROJECT_URL ?? '');
  });

  app.post('/api/revisions', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const parsed = z
      .object({
        category: z.string().trim().min(1).max(80).optional(),
        area: z.enum(['письма', 'протоколы', 'утро']).optional(),
        instead: z.string().trim().min(3).max(500),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Нужны область и текст правила' });
    const area = parsed.data.area ?? 'письма';
    const understood = area === 'утро' ? await morningUnderstood(leader.id, parsed.data.instead) : { stored: '', note: '' };
    if (area === 'утро' && !understood.stored) return reply.code(422).send({ error: understood.note });
    await deps.db.insert(revisions).values({
      id: randomUUID(),
      leaderId: leader.id,
      category: parsed.data.category ?? area,
      area,
      instead: parsed.data.instead,
      understood: understood.stored,
      createdAt: new Date(),
    });
    return { ok: true, note: understood.note };
  });

  app.post('/api/revisions/update', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const parsed = z.object({ id: z.string().trim().min(1).max(80), instead: z.string().trim().min(3).max(500) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Нужны правило и текст' });
    const [row] = await deps.db.select().from(revisions).where(eq(revisions.id, parsed.data.id)).limit(1);
    if (!row || row.leaderId !== leader.id) return reply.code(404).send({ error: 'Правило не найдено' });
    const understood = row.area === 'утро' ? await morningUnderstood(leader.id, parsed.data.instead) : { stored: row.understood, note: '' };
    if (row.area === 'утро' && !understood.stored) return reply.code(422).send({ error: understood.note });
    await deps.db.update(revisions).set({ instead: parsed.data.instead, understood: understood.stored }).where(eq(revisions.id, row.id));
    return { ok: true, note: understood.note };
  });

  app.post('/api/revisions/delete', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const parsed = z.object({ id: z.string().trim().min(1).max(80) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Нужно правило' });
    const [row] = await deps.db.select().from(revisions).where(eq(revisions.id, parsed.data.id)).limit(1);
    if (!row || row.leaderId !== leader.id) return reply.code(404).send({ error: 'Правило не найдено' });
    await deps.db.delete(revisions).where(eq(revisions.id, row.id));
    return { ok: true };
  });

  app.post('/api/decisions', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const parsed = z
      .object({
        id: z.string().trim().min(1).max(64),
        action: z.enum(['approve', 'reject', 'defer', 'edit', 'once', 'keep']),
        text: z.string().trim().max(500).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Нужны решение и действие' });
    if (parsed.data.action === 'edit') {
      if (!parsed.data.text || parsed.data.text.trim().length < 3) return reply.code(400).send({ error: 'Напишите правку' });
      const saved = await saveLeaderEdit(deps.db, leader.id, parsed.data.text, parsed.data.id);
      if (!saved) return reply.code(404).send({ error: 'Решение не найдено' });
      return { notice: saved.text, draft: saved.draft, changed: saved.changed };
    }
    const notice = await applyLeaderAction(deps.db, leader.id, parsed.data.action, parsed.data.id);
    return { notice };
  });

  app.post('/api/protocols/edit', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const parsed = z.object({ id: z.string().trim().length(8), text: z.string().trim().min(3).max(500) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Нужны протокол и правка' });
    const result = await reviseProtocol(deps.db, leader.id, parsed.data.id, parsed.data.text);
    if ('error' in result) return reply.code(400).send({ error: result.error });
    return result;
  });

  app.post('/api/protocols/scope', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const parsed = z.object({ id: z.string().trim().length(8), scope: z.enum(['once', 'keep']) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Нужны протокол и выбор' });
    return { notice: await chooseProtocolScope(deps.db, leader.id, parsed.data.id, parsed.data.scope) };
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

  app.post('/api/focus/send', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    try {
      const scene = await sendFocus(deps.db, leader.id);
      return { ok: true, text: scene.text };
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'не удалось отправить';
      return reply.code(502).send({ error: detail });
    }
  });

  app.post('/api/mirror/send', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    try {
      return await sendWeeklyNote(deps.db, leader.id);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'не удалось отправить';
      return reply.code(502).send({ error: detail });
    }
  });

  app.post('/api/series', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const body = z
      .object({
        key: z.string().trim().min(1).max(200),
        action: z.enum(['продлить', 'отпустить']),
        reason: z.string().max(500).optional(),
        use: z.string().max(200).optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Непонятное действие по серии' });
    try {
      return await setSeriesFate(deps.db, leader.id, body.data.key, body.data.action, body.data.reason ?? '', body.data.use ?? '');
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'не удалось записать';
      return reply.code(400).send({ error: detail });
    }
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

  app.post('/api/jobs/accuracy', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const parsed = z.object({ confirm: z.boolean() }).safeParse(request.body ?? {});
    if (!parsed.success || parsed.data.confirm !== true) {
      return reply.code(400).send({ error: 'Нужно подтверждение: один вызов на цепочку, письмо само не отправляется' });
    }
    const id = await deps.boss.send('mail-accuracy', { leaderId: leader.id });
    if (!id) return reply.code(503).send({ error: 'Очередь не приняла задание' });
    return { id };
  });

  app.post('/api/jobs/protocol', async (request, reply) => {
    const leader = await currentLeader(request);
    if (!leader) return reply.code(401).send({ error: 'Нужен вход' });
    const parsed = z.object({ confirm: z.boolean() }).safeParse(request.body ?? {});
    if (!parsed.success || parsed.data.confirm !== true) {
      return reply.code(400).send({ error: 'Нужно подтверждение: один вызов модели и сообщение в Telegram' });
    }
    const id = await deps.boss.send('protocol', { leaderId: leader.id });
    if (!id) return reply.code(503).send({ error: 'Очередь не приняла задание' });
    return { id };
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
      const protocolClick = parseProtocolCallback(update.callback_query.data);
      const chatId = String(update.callback_query.message?.chat.id ?? '');
      await deps.db.insert(telegramClicks).values({
        updateId: update.update_id,
        chatId,
        data: update.callback_query.data,
        action: parsedClick?.action ?? (ruleClick ? 'accept' : protocolClick ? protocolClick.action : null),
        receivedAt: new Date(),
      });
      let notice = parsedClick || ruleClick || protocolClick ? 'Кнопка получена' : 'Неизвестная кнопка';
      if (chatId && ruleClick) {
        try {
          notice = await acceptWeekByChat(deps.db, chatId);
        } catch (err) {
          notice = err instanceof Error ? err.message.slice(0, 180) : 'Не удалось выполнить';
        }
      } else if (protocolClick && chatId) {
        try {
          notice =
            protocolClick.action === 'approve'
              ? await approveProtocol(deps.db, protocolClick.id, chatId)
              : protocolClick.action === 'edit'
                ? await askProtocolEdit(deps.db, protocolClick.id, chatId)
                : protocolClick.action === 'once' || protocolClick.action === 'keep'
                  ? await scopeProtocolByChat(deps.db, protocolClick.id, chatId, protocolClick.action)
                  : await rejectProtocol(deps.db, protocolClick.id, chatId);
          if (protocolClick.action === 'edit' && telegramConfigured()) await sendMessage(notice, chatId);
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
        return { ok: true };
      }
      // Сначала правка протокола, если он ждёт текст; иначе — правка черновика письма.
      const protocolNote = await saveProtocolEdit(deps.db, chatId, text);
      if (protocolNote) {
        if (telegramConfigured()) await sendMessage(protocolNote, chatId);
      } else {
        const letter = await saveEditText(deps.db, chatId, text);
        if (letter && telegramConfigured()) await sendMessage(letter.text, chatId, { reply_markup: editChoiceKeyboard(letter.id) });
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
