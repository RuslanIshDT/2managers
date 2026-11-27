// Кладёт письма в тестовый ящик и разбирает их. По умолчанию — письма подчинённых без повторов;
// --all — все письма каталога (владелец 27.11.2026, T67). Карточки в Telegram — только с --notify.
import { lettersForMailbox, pullInbox } from '../agents/intake.ts';
import { createDb, createPool, migrate } from '../db/client.ts';
import { installLlmRecording } from '../db/llm-record.ts';
import { LEADER_ID } from '../db/seed.ts';
import { loadSynthetic } from '../data/synthetic.ts';
import { appendSynthetic, readSyntheticInbox } from '../mail.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL не задан');
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? new Set((process.argv[onlyArg + 1] ?? '').split(',').filter(Boolean)) : null;

const data = await loadSynthetic();
const subs = new Set(data.people.filter((person) => person.role === 'подчинённый').map((person) => person.email.toLowerCase()));
const all = process.argv.includes('--all');
const notify = process.argv.includes('--notify');
const pool0 = all ? [...data.emails].sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id)) : lettersForMailbox(data.emails, subs);
const chosen = pool0.filter((letter) => !only || only.has(letter.id));
const added = await appendSynthetic(chosen);
console.log(`В ящик добавлено: ${added}, к разбору: ${chosen.map((letter) => letter.id).join(', ')}`);

const pool = createPool(connectionString);
await migrate(pool);
const db = createDb(pool);
// Модель агента — из настроек «Модели», каждый вызов — в «Стоимость», как на сервере.
installLlmRecording(db);
const mailbox = (await readSyntheticInbox()).filter((letter) => !only || only.has(letter.id));
const result = await pullInbox(db, LEADER_ID, mailbox, chosen.length, { notify });
console.log(result.lines.join('\n') || 'Новых писем нет');
console.log(`Вызовов модели: ${result.calls}. Осталось без разбора: ${result.deferred}`);
await pool.end();
