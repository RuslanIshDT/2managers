// Разово: у уже утверждённого протокола склеенные задачи заменить отдельными поручениями.
// Склеенные в Трекере отменяются. Протокол, который ещё ждёт утверждения, пишется заново.
import { and, eq, like } from 'drizzle-orm';
import { z } from 'zod';
import { createDb, createPool, migrate } from '../db/client.ts';
import { leaders, people, protocols, tasks } from '../db/schema.ts';
import { callJson, withLlmScope, type JsonSchema } from '../llm.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { taskUnique } from '../agents/materials.ts';
import { meetingOfSource, writeProtocol } from '../agents/protocol.ts';
import { cleanSteps, protocolTaskDescription, replaceSection, stepLine, storedSteps } from '../agents/protocol-steps.ts';
import { refreshSeries } from '../agents/stand-sync.ts';
import { publishApproved } from '../yandex/publish.ts';
import { listQueueIssues, moveIssue, trackerConfig } from '../yandex/tracker.ts';

const stepSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['steps'],
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['owner', 'task', 'due'],
        properties: { owner: { type: 'string' }, task: { type: 'string' }, due: { type: 'string' } },
      },
    },
  },
};

const parsed = z.object({ steps: z.array(z.object({ owner: z.string(), task: z.string(), due: z.string() })) });

async function resplit(db: ReturnType<typeof createDb>, leaderId: string, row: { id: string; source: string; body: string }) {
  const meeting = meetingOfSource(row.source);
  const staff = await db.select({ name: people.name, position: people.position }).from(people).where(eq(people.leaderId, leaderId));
  let transcript = '';
  try {
    transcript = await readFile(join(`data/${leaderId}/meetings`, row.source), 'utf8');
  } catch {
    transcript = '';
  }
  const result = await withLlmScope(
    { agent: 'protocol', leaderId, operationId: `protocol-split:${row.id}`, title: 'Разделить поручения протокола' },
    () =>
      callJson<unknown>({
        purpose: `protocol-split:${leaderId}`,
        schemaName: 'protocol_steps',
        schema: stepSchema,
        system: [
          'Разбей шаги протокола на отдельные поручения.',
          'Одно поручение — один элемент, даже если в одной строке их несколько у одного человека. Не объединяй и не выдумывай.',
          'owner — полное имя из списка людей или пустая строка. task — поручение без имени, до 120 знаков. due — ГГГГ-ММ-ДД или пустая строка.',
          '«сегодня» — день встречи.',
        ].join(' '),
        user: [
          meeting ? `Встреча: ${meeting.title}, ${meeting.startsAt}.` : '',
          `Люди: ${staff.map((item) => item.name).join('; ')}.`,
          '',
          transcript ? `Расшифровка:\n${transcript.slice(0, 12_000)}` : '',
          '',
          'Нынешние шаги:',
          row.body,
        ].join('\n'),
      }),
  );
  const data = parsed.safeParse(result.data);
  if (!data.success) throw new Error('Модель не вернула поручения');
  const steps = cleanSteps(data.data.steps, staff);
  if (!steps.length) throw new Error('Поручений не получилось');
  const escaped = steps.map((step) => stepLine(step).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  await db.update(protocols).set({ steps, body: replaceSection(row.body, 'Дальше:', escaped) }).where(eq(protocols.id, row.id));
  const old = (await db.select().from(tasks).where(eq(tasks.leaderId, leaderId))).filter((task) => task.externalId.startsWith(`protocol-${row.id}-`));
  if (trackerConfig() && old.length) {
    const issues = await listQueueIssues();
    for (const task of old) {
      const issue = issues.find((item) => item.unique === taskUnique(leaderId, task.externalId) && item.open);
      if (!issue?.key) continue;
      await moveIssue(issue.key, 'cancel');
    }
  }
  await db.delete(tasks).where(and(eq(tasks.leaderId, leaderId), like(tasks.externalId, `protocol-${row.id}-%`)));
  const fresh = steps.map((step, index) => ({
    externalId: `protocol-${row.id}-p${index + 1}`,
    title: step.task,
    ownerName: step.owner,
    dueOn: step.due,
    status: 'в работе',
    source: 'протокол',
    description: protocolTaskDescription(step.owner, meeting),
  }));
  for (const task of fresh) {
    await db.insert(tasks).values({ leaderId, externalId: task.externalId, title: task.title, ownerName: task.ownerName, dueOn: task.dueOn, status: task.status, source: task.source });
  }
  let tracker = 'Трекер не настроен.';
  if (trackerConfig()) tracker = await publishApproved(leaderId, fresh, null);
  if (meeting) await refreshSeries(db, leaderId, meeting.title);
  console.log(`Протокол ${row.id}: поручений ${fresh.length}. ${tracker}`);
  for (const task of fresh) console.log(`— ${task.ownerName}: ${task.title}${task.dueOn ? `, ${task.dueOn}` : ''}`);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL не задан');
if (!process.argv.includes('--yes')) {
  console.log('Ничего не изменено. Повторите с --yes.');
  process.exit(0);
}

const pool = createPool(connectionString);
await migrate(pool);
const db = createDb(pool);
const rows = await db.select().from(leaders);
for (const leader of rows) {
  const own = await db.select().from(protocols).where(eq(protocols.leaderId, leader.id));
  for (const row of own) {
    if (row.status !== 'утверждён' || storedSteps(row.steps).length) continue;
    await resplit(db, leader.id, row);
  }
  const waiting = own.filter((row) => row.status === 'ждёт');
  if (!waiting.length) continue;
  await db.update(protocols).set({ status: 'отклонён', awaitingEdit: false }).where(and(eq(protocols.leaderId, leader.id), eq(protocols.status, 'ждёт')));
  console.log(`Ждут утверждения, сняты: ${waiting.length}. Пишу протокол заново.`);
  try {
    const created = await writeProtocol(db, leader.id);
    console.log(`Новый протокол ${created.id} отправлен в Telegram.`);
  } catch (err) {
    console.error(leader.id, err instanceof Error ? err.message : err);
  }
}
await pool.end();
