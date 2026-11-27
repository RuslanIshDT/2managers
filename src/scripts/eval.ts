// npm run eval — замер разбора почты на эталоне (T54). Пишет reports/eval-mail.md и .json.
// Провал (код выхода 1): дошло меньше всех писем N1 или совпадение ниже порога --min (по умолчанию 0.85).
import { writeFile } from 'node:fs/promises';
import { and, eq, gte, like } from 'drizzle-orm';
import { evalReport, evalScore, runEval } from '../agents/eval.ts';
import { createDb, createPool, migrate } from '../db/client.ts';
import { installLlmRecording } from '../db/llm-record.ts';
import { agentModels, llmCalls } from '../db/schema.ts';
import { LEADER_ID } from '../db/seed.ts';
import { llmConfig } from '../llm.ts';

const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? '' : '';
};
const leaderId = arg('leader') || LEADER_ID;
const min = Number(arg('min') || '0.85');
const only = arg('only') ? new Set(arg('only').split(',').filter(Boolean)) : undefined;
const concurrency = Number(arg('concurrency') || '4');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL не задан');
const pool = createPool(connectionString);
await migrate(pool);
const db = createDb(pool);
installLlmRecording(db);

const [chosen] = await db.select({ model: agentModels.model }).from(agentModels).where(and(eq(agentModels.leaderId, leaderId), eq(agentModels.agent, 'k2'))).limit(1);
const model = chosen?.model || llmConfig().model;
const started = new Date();
let done = 0;
const rows = await runEval(db, leaderId, {
  concurrency,
  only,
  onRow: (row) => {
    done += 1;
    console.log(`${done}. ${row.id} ${row.route} → ${row.toLeader ? 'руководителю' : 'не руководителю'} (эталон ${row.expected})${row.error ? ' СБОЙ' : ''}`);
  },
});
const calls = await db
  .select({ cost: llmCalls.costUsd })
  .from(llmCalls)
  .where(and(gte(llmCalls.at, started), like(llmCalls.purpose, 'eval:%')));
const costUsd = calls.reduce((sum, row) => sum + Number(row.cost ?? 0), 0);
const score = evalScore(rows);
const minutes = Math.round((Date.now() - started.getTime()) / 6000) / 10;
const at = started.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК';
const report = evalReport(score, { model, at, costUsd, calls: calls.length, minutes });
const suffix = only ? '-part' : '';
await writeFile(`reports/eval-mail${suffix}.md`, report);
await writeFile(`reports/eval-mail${suffix}.json`, JSON.stringify({ model, at, costUsd, calls: calls.length, minutes, score, rows }, null, 2));
console.log(report);
await pool.end();
const failed = score.n1Caught < score.n1 || score.accuracy < min;
if (failed) console.error(`Замер не прошёл порог: N1 ${score.n1Caught} из ${score.n1}, совпадение ${score.accuracy.toFixed(3)} при пороге ${min}`);
process.exit(failed ? 1 : 0);
