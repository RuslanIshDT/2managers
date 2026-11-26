// Запуск аудитора потока на синтетике D2.
//   npm run flow-audit            — вызывает модель, пишет reports/flow-audit.{json,md}
//   npm run flow-audit:dry        — без модели: показывает цепочки, серии и первый запрос
//   --limit N                     — только первые N цепочек и серий
//   --from-json                   — пересобрать отчёт из reports/flow-audit.json без модели
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadSynthetic } from '../data/synthetic.ts';
import { buildItems, buildPrompt, runAudit, type AuditedItem } from '../agents/flow-audit.ts';
import { summarize, toMarkdown, view, h } from '../agents/flow-audit-report.ts';
import { llmConfig } from '../llm.ts';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const fromJson = args.includes('--from-json');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

const d = await loadSynthetic();
let items = buildItems(d);
if (Number.isFinite(limit)) items = items.slice(0, limit);

if (dry) {
  const threads = items.filter((i) => i.kind === 'письма');
  const series = items.filter((i) => i.kind === 'встречи');
  console.log(`Цепочек писем: ${threads.length} (писем ${d.emails.length}); серий встреч: ${series.length} (встреч ${d.meetings.length})`);
  for (const i of items) console.log(`- ${i.kind}: ${i.title} (${i.kind === 'письма' ? i.emails.length : i.meetings.length})`);
  console.log('\n--- Запрос для первой цепочки ---\n' + buildPrompt(d, items[0]));
  process.exit(0);
}

let audited: AuditedItem[];
let at: string;
if (fromJson) {
  const prev = JSON.parse(await readFile('reports/flow-audit.json', 'utf8'));
  audited = prev.items;
  at = prev.at;
} else {
  console.error(`Аудит: ${items.length} цепочек и серий, модель ${llmConfig().model}`);
  audited = await runAudit(d, items);
  at = new Date().toISOString();
}

const summary = summarize(d, audited, at);
const viewItems = view(audited);
await mkdir('reports', { recursive: true });
// summary и view — для страницы на стенде и Telegram; items — сырые ответы для пересборки.
await writeFile('reports/flow-audit.json', JSON.stringify({ at, summary, view: viewItems, items: audited }, null, 2));
await writeFile('reports/flow-audit.md', toMarkdown(summary, viewItems, d, audited));
const gone = summary.byVerdict.find((r) => r.verdict === 'не_должно')!;
console.log(`Не должно быть: писем ${gone.letters}, встреч ${gone.meetings}; освобождается около ${h(summary.freedHours)} из ${h(summary.flowHours)} ч в неделю`);
console.log('Отчёт: reports/flow-audit.md');
