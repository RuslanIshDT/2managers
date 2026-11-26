// Кладёт письма подчинённых в тестовый ящик и разбирает их. Не гоняет все 80.
import { lettersForMailbox, pullInbox } from '../agents/intake.ts';
import { createDb, createPool, migrate } from '../db/client.ts';
import { llmCalls } from '../db/schema.ts';
import { LEADER_ID } from '../db/seed.ts';
import { loadSynthetic } from '../data/synthetic.ts';
import { setLlmSink } from '../llm.ts';
import { appendSynthetic, readSyntheticInbox } from '../mail.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL не задан');
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? new Set((process.argv[onlyArg + 1] ?? '').split(',').filter(Boolean)) : null;

const data = await loadSynthetic();
const subs = new Set(data.people.filter((person) => person.role === 'подчинённый').map((person) => person.email.toLowerCase()));
const chosen = lettersForMailbox(data.emails, subs).filter((letter) => !only || only.has(letter.id));
const added = await appendSynthetic(chosen);
console.log(`В ящик добавлено: ${added}, к разбору: ${chosen.map((letter) => letter.id).join(', ')}`);

const pool = createPool(connectionString);
await migrate(pool);
const db = createDb(pool);
setLlmSink(async (purpose, result) => {
  await db.insert(llmCalls).values({
    at: new Date(),
    purpose,
    model: result.model,
    ms: result.ms,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: result.costUsd === null ? null : String(result.costUsd),
    leaderId: LEADER_ID,
  });
});
const mailbox = (await readSyntheticInbox()).filter((letter) => !only || only.has(letter.id));
const result = await pullInbox(db, LEADER_ID, mailbox, chosen.length);
console.log(result.lines.join('\n') || 'Новых писем нет');
console.log(`Вызовов модели: ${result.calls}. Осталось без разбора: ${result.deferred}`);
await pool.end();
