// Запуск аудитора потока на синтетике D2.
//   npm run flow-audit            — вызывает модель, пишет reports/flow-audit.{json,md}
//   npm run flow-audit:dry        — без модели: показывает цепочки, серии и первый запрос
//   --limit N                     — только первые N цепочек и серий
//   --from-json                   — пересобрать отчёт из reports/flow-audit.json без модели
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadSynthetic, type Synthetic } from '../data/synthetic.ts';
import { buildItems, buildPrompt, runAudit, CAUSES, VERDICTS, type AuditedItem, type Cause, type Verdict } from '../agents/flow-audit.ts';
import { llmConfig } from '../llm.ts';

// Допущение для часов: сколько минут руководителя уходит на одно письмо в его потоке
// (прочитать, понять, ответить или переслать). Видно в отчёте.
const LETTER_MINUTES = 4;
// Письма синтетики — одна неделя (7–11.12), календарь — две (7–18.12).
const CALENDAR_WEEKS = 2;

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
if (fromJson) {
  audited = JSON.parse(await readFile('reports/flow-audit.json', 'utf8')).items;
} else {
  console.error(`Аудит: ${items.length} цепочек и серий, модель ${llmConfig().model}`);
  audited = await runAudit(d, items);
}

await mkdir('reports', { recursive: true });
await writeFile('reports/flow-audit.json', JSON.stringify({ at: new Date().toISOString(), items: audited }, null, 2));
await writeFile('reports/flow-audit.md', report(d, audited));
console.log(summaryLine(audited));
console.log('Отчёт: reports/flow-audit.md');

// ---------- отчёт ----------

function count(a: AuditedItem) {
  return a.item.kind === 'письма' ? a.item.emails.length : a.item.meetings.length;
}

function weeklyHours(a: AuditedItem): number {
  if (a.item.kind === 'письма') return (a.item.emails.length * LETTER_MINUTES) / 60;
  return a.item.meetings.reduce((s, m) => s + m.minutes, 0) / 60 / CALENDAR_WEEKS;
}

function freed(a: AuditedItem): number {
  return weeklyHours(a) * (1 - (a.audit.останется_времени ?? (a.audit.вердикт === 'не_должно' ? 0 : 1)));
}

function h(x: number) {
  return x.toFixed(1).replace('.', ',');
}

function summaryLine(all: AuditedItem[]) {
  const gone = all.filter((a) => a.audit.вердикт === 'не_должно');
  const letters = gone.filter((a) => a.item.kind === 'письма').reduce((s, a) => s + count(a), 0);
  const meetings = gone.filter((a) => a.item.kind === 'встречи').reduce((s, a) => s + count(a), 0);
  const hours = all.reduce((s, a) => s + freed(a), 0);
  return `Не должно быть: писем ${letters}, встреч ${meetings}; освобождается около ${h(hours)} ч руководителя в неделю`;
}

function report(d: Synthetic, all: AuditedItem[]): string {
  const letters = all.filter((a) => a.item.kind === 'письма');
  const series = all.filter((a) => a.item.kind === 'встречи');
  const totalLetters = letters.reduce((s, a) => s + count(a), 0);
  const totalMeetings = series.reduce((s, a) => s + count(a), 0);
  const totalHours = all.reduce((s, a) => s + weeklyHours(a), 0);
  const cost = all.reduce((s, a) => s + (a.costUsd ?? 0), 0);
  const models = [...new Set(all.map((a) => a.model))].join(', ');

  const L: string[] = [];
  L.push('# Аудит потока руководителя: каких писем и встреч не должно быть');
  L.push('');
  L.push(`Синтетика D2: ${totalLetters} писем за неделю 7–11.12 (${letters.length} цепочек) и ${totalMeetings} встреч за 7–18.12 (${series.length} серий). Агент — аудитор потока (K5 в docs/tz.md). Модель: ${models}. Вызовов: ${all.length}, цена ≈ ${cost.toFixed(3)} USD.`);
  L.push('');
  L.push(`Допущения для часов: письмо в потоке руководителя — ${LETTER_MINUTES} мин (прочитать, понять, ответить или переслать); встреча — по длительности в календаре; календарь за две недели пересчитан на одну. Поток недели по этим допущениям — ${h(totalHours)} ч. Освобождается: у «не должно быть» — всё время, у «в другом виде» — по оценке аудитора, какая доля останется (видна в таблицах).`);
  L.push('');

  L.push('## Итог');
  L.push('');
  L.push('| Вердикт | Писем | Встреч | Часов в неделю сейчас | Освобождается часов в неделю |');
  L.push('|---|---|---|---|---|');
  for (const v of VERDICTS) {
    const xs = all.filter((a) => a.audit.вердикт === v);
    const l = xs.filter((a) => a.item.kind === 'письма').reduce((s, a) => s + count(a), 0);
    const m = xs.filter((a) => a.item.kind === 'встречи').reduce((s, a) => s + count(a), 0);
    L.push(`| ${verdictLabel(v)} | ${l} | ${m} | ${h(xs.reduce((s, a) => s + weeklyHours(a), 0))} | ${h(xs.reduce((s, a) => s + freed(a), 0))} |`);
  }
  L.push(`| **Всего** | ${totalLetters} | ${totalMeetings} | ${h(totalHours)} | **${h(all.reduce((s, a) => s + freed(a), 0))}** |`);
  L.push('');

  L.push('## Оргизменения: что убирает каждое');
  L.push('');
  L.push('| Оргизменение | Причина | Убрать писем | Убрать встреч | Изменить форму: писем / встреч | Освобождает часов в неделю |');
  L.push('|---|---|---|---|---|---|');
  const causes = (Object.keys(CAUSES) as Cause[]).filter((c) => c !== 'нужно');
  const rows = causes
    .map((c) => {
      const xs = all.filter((a) => a.audit.причина === c);
      const n = (v: Verdict, k: 'письма' | 'встречи') =>
        xs.filter((a) => a.audit.вердикт === v && a.item.kind === k).reduce((s, a) => s + count(a), 0);
      return {
        c,
        l: n('не_должно', 'письма'),
        m: n('не_должно', 'встречи'),
        ol: n('в_другом_виде', 'письма'),
        om: n('в_другом_виде', 'встречи'),
        hours: xs.reduce((s, a) => s + freed(a), 0),
      };
    })
    .filter((r) => r.l + r.m + r.ol + r.om > 0)
    .sort((a, b) => b.hours - a.hours);
  for (const r of rows) L.push(`| ${CAUSES[r.c].change} | ${CAUSES[r.c].label} | ${r.l} | ${r.m} | ${r.ol} / ${r.om} | ${h(r.hours)} |`);
  L.push('');

  L.push('## Письма');
  L.push('');
  L.push('| Цепочка | Писем | Вердикт | Причина | Освобождает ч/нед | Что изменить | Вместо | Основание |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const a of sortItems(letters)) {
    const i = a.item as Extract<AuditedItem['item'], { kind: 'письма' }>;
    L.push(`| ${cell(i.from)}: ${cell(i.title)} | ${count(a)} | ${verdictLabel(a.audit.вердикт)} | ${CAUSES[a.audit.причина].label} | ${h(freed(a))} | ${cell(a.audit.что_изменить)} | ${cell(a.audit.вместо)} | ${cell(a.audit.основание)} |`);
  }
  L.push('');

  L.push('## Встречи');
  L.push('');
  L.push('| Серия | Встреч | Часов в неделю | Вердикт | Причина | Освобождает ч/нед | Что изменить | Вместо | Основание |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const a of sortItems(series)) {
    L.push(`| ${cell(a.item.title)} | ${count(a)} | ${h(weeklyHours(a))} | ${verdictLabel(a.audit.вердикт)} | ${CAUSES[a.audit.причина].label} | ${h(freed(a))} | ${cell(a.audit.что_изменить)} | ${cell(a.audit.вместо)} | ${cell(a.audit.основание)} |`);
  }
  L.push('');

  L.push('## Сравнение с эталоном заказчика');
  L.push('');
  L.push('Эталон модели не отдавался. Здесь — что заказчик в синтетике считает нужным действием, а аудитор предлагает убрать из потока совсем.');
  L.push('');
  const actions = [...new Set([...d.emailEtalon.values()].map((e) => e.expectedAction))];
  L.push(`| Вердикт аудитора \\ эталон \`expected_action\` | ${actions.join(' | ')} |`);
  L.push(`|---|${actions.map(() => '---').join('|')}|`);
  for (const v of VERDICTS) {
    const cells = actions.map((act) =>
      letters
        .filter((a) => a.audit.вердикт === v)
        .reduce((s, a) => s + (a.item.kind === 'письма' ? a.item.emails.filter((e) => d.emailEtalon.get(e.id)?.expectedAction === act).length : 0), 0),
    );
    L.push(`| ${verdictLabel(v)} | ${cells.join(' | ')} |`);
  }
  L.push('');
  const cats = [...new Set([...d.meetingEtalon.values()].map((m) => m.category))];
  L.push(`| Вердикт аудитора \\ категория встречи в календаре | ${cats.join(' | ')} |`);
  L.push(`|---|${cats.map(() => '---').join('|')}|`);
  for (const v of VERDICTS) {
    const cells = cats.map((c) =>
      series
        .filter((a) => a.audit.вердикт === v)
        .reduce((s, a) => s + (a.item.kind === 'встречи' ? a.item.meetings.filter((m) => d.meetingEtalon.get(m.uid)?.category === c).length : 0), 0),
    );
    L.push(`| ${verdictLabel(v)} | ${cells.join(' | ')} |`);
  }
  L.push('');
  return L.join('\n');
}

function sortItems(xs: AuditedItem[]) {
  const order: Record<Verdict, number> = { не_должно: 0, в_другом_виде: 1, должно: 2 };
  return [...xs].sort((a, b) => order[a.audit.вердикт] - order[b.audit.вердикт] || freed(b) - freed(a) || weeklyHours(b) - weeklyHours(a));
}

function verdictLabel(v: Verdict) {
  return { не_должно: 'Не должно быть', в_другом_виде: 'В другом виде', должно: 'Нужно' }[v];
}

function cell(s: string) {
  return String(s ?? '').replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ');
}
