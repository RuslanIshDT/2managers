// Сводка аудита потока: одна и та же для отчёта .md, страницы на стенде и Telegram.
import type { Synthetic } from '../data/synthetic.ts';
import { CAUSES, VERDICTS, type AuditedItem, type Cause, type Verdict } from './flow-audit.ts';

// Допущение для часов: сколько минут руководителя уходит на одно письмо в его потоке
// (прочитать, понять, ответить или переслать). Видно в отчёте.
export const LETTER_MINUTES = 4;
// Письма синтетики — одна неделя (7–11.12), календарь — две (7–18.12).
export const CALENDAR_WEEKS = 2;

export const VERDICT_LABEL: Record<Verdict, string> = {
  не_должно: 'Не должно быть',
  в_другом_виде: 'В другом виде',
  должно: 'Нужно',
};

export interface ViewItem {
  kind: 'письма' | 'встречи';
  title: string;
  from: string;
  count: number;
  hours: number;
  freedHours: number;
  verdict: Verdict;
  verdictLabel: string;
  cause: Cause;
  causeLabel: string;
  change: string;
  instead: string;
  basis: string;
  confidence: number;
}

export interface Summary {
  at: string;
  model: string;
  calls: number;
  costUsd: number;
  letters: number;
  threads: number;
  meetings: number;
  series: number;
  flowHours: number;
  freedHours: number;
  assumptions: string;
  byVerdict: { verdict: Verdict; label: string; letters: number; meetings: number; hours: number; freedHours: number }[];
  byChange: { cause: Cause; change: string; label: string; letters: number; meetings: number; otherLetters: number; otherMeetings: number; freedHours: number }[];
  etalon: { actions: string[]; rows: { label: string; cells: number[] }[] };
}

export function count(a: AuditedItem) {
  return a.item.kind === 'письма' ? a.item.emails.length : a.item.meetings.length;
}

export function weeklyHours(a: AuditedItem): number {
  if (a.item.kind === 'письма') return (a.item.emails.length * LETTER_MINUTES) / 60;
  return a.item.meetings.reduce((s, m) => s + m.minutes, 0) / 60 / CALENDAR_WEEKS;
}

export function freed(a: AuditedItem): number {
  const left = a.audit.останется_времени ?? (a.audit.вердикт === 'не_должно' ? 0 : 1);
  return weeklyHours(a) * (1 - left);
}

const order: Record<Verdict, number> = { не_должно: 0, в_другом_виде: 1, должно: 2 };

export function view(all: AuditedItem[]): ViewItem[] {
  return [...all]
    .sort((a, b) => order[a.audit.вердикт] - order[b.audit.вердикт] || freed(b) - freed(a) || weeklyHours(b) - weeklyHours(a))
    .map((a) => ({
      kind: a.item.kind,
      title: a.item.title,
      from: a.item.kind === 'письма' ? a.item.from : '',
      count: count(a),
      hours: round(weeklyHours(a)),
      freedHours: round(freed(a)),
      verdict: a.audit.вердикт,
      verdictLabel: VERDICT_LABEL[a.audit.вердикт],
      cause: a.audit.причина,
      causeLabel: CAUSES[a.audit.причина].label,
      change: a.audit.что_изменить,
      instead: a.audit.вместо,
      basis: a.audit.основание,
      confidence: a.audit.уверенность,
    }));
}

export function summarize(d: Synthetic, all: AuditedItem[], at: string): Summary {
  const sum = (xs: AuditedItem[], f: (a: AuditedItem) => number) => xs.reduce((s, a) => s + f(a), 0);
  const of = (xs: AuditedItem[], k: 'письма' | 'встречи') => xs.filter((a) => a.item.kind === k);
  const letters = of(all, 'письма');
  const series = of(all, 'встречи');

  const byVerdict = VERDICTS.map((v) => {
    const xs = all.filter((a) => a.audit.вердикт === v);
    return {
      verdict: v,
      label: VERDICT_LABEL[v],
      letters: sum(of(xs, 'письма'), count),
      meetings: sum(of(xs, 'встречи'), count),
      hours: round(sum(xs, weeklyHours)),
      freedHours: round(sum(xs, freed)),
    };
  });

  const byChange = (Object.keys(CAUSES) as Cause[])
    .filter((c) => c !== 'нужно')
    .map((c) => {
      const xs = all.filter((a) => a.audit.причина === c);
      const n = (v: Verdict, k: 'письма' | 'встречи') => sum(of(xs.filter((a) => a.audit.вердикт === v), k), count);
      return {
        cause: c,
        change: CAUSES[c].change,
        label: CAUSES[c].label,
        letters: n('не_должно', 'письма'),
        meetings: n('не_должно', 'встречи'),
        otherLetters: n('в_другом_виде', 'письма'),
        otherMeetings: n('в_другом_виде', 'встречи'),
        freedHours: round(sum(xs, freed)),
      };
    })
    .filter((r) => r.letters + r.meetings + r.otherLetters + r.otherMeetings > 0)
    .sort((a, b) => b.freedHours - a.freedHours);

  const actions = [...new Set([...d.emailEtalon.values()].map((e) => e.expectedAction))];
  const etalonRows = VERDICTS.map((v) => ({
    label: VERDICT_LABEL[v],
    cells: actions.map((act) =>
      letters
        .filter((a) => a.audit.вердикт === v)
        .reduce((s, a) => s + (a.item.kind === 'письма' ? a.item.emails.filter((e) => d.emailEtalon.get(e.id)?.expectedAction === act).length : 0), 0),
    ),
  }));

  return {
    at,
    model: [...new Set(all.map((a) => a.model))].join(', '),
    calls: all.length,
    costUsd: Math.round(sum(all, (a) => a.costUsd ?? 0) * 1000) / 1000,
    letters: sum(letters, count),
    threads: letters.length,
    meetings: sum(series, count),
    series: series.length,
    flowHours: round(sum(all, weeklyHours)),
    freedHours: round(sum(all, freed)),
    assumptions: `Письмо в потоке руководителя — ${LETTER_MINUTES} мин (прочитать, понять, ответить или переслать); встреча — по длительности в календаре; календарь за две недели пересчитан на одну. Освобождается: у «не должно быть» — всё время, у «в другом виде» — доля, которую оценил аудитор.`,
    byVerdict,
    byChange,
    etalon: { actions, rows: etalonRows },
  };
}

export function toMarkdown(s: Summary, items: ViewItem[], d: Synthetic, all: AuditedItem[]): string {
  const L: string[] = [];
  L.push('# Аудит потока руководителя: каких писем и встреч не должно быть');
  L.push('');
  L.push(`Синтетика D2: ${s.letters} писем за неделю 7–11.12 (${s.threads} цепочек) и ${s.meetings} встреч за 7–18.12 (${s.series} серий). Агент — аудитор потока (K5 в docs/tz.md). Модель: ${s.model}. Вызовов: ${s.calls}, цена ≈ ${s.costUsd.toFixed(3)} USD.`);
  L.push('');
  L.push(`Допущения: ${s.assumptions} Поток недели по этим допущениям — ${h(s.flowHours)} ч.`);
  L.push('');
  L.push('## Итог');
  L.push('');
  L.push('| Вердикт | Писем | Встреч | Часов в неделю сейчас | Освобождается часов в неделю |');
  L.push('|---|---|---|---|---|');
  for (const r of s.byVerdict) L.push(`| ${r.label} | ${r.letters} | ${r.meetings} | ${h(r.hours)} | ${h(r.freedHours)} |`);
  L.push(`| **Всего** | ${s.letters} | ${s.meetings} | ${h(s.flowHours)} | **${h(s.freedHours)}** |`);
  L.push('');
  L.push('## Оргизменения: что убирает каждое');
  L.push('');
  L.push('| Оргизменение | Причина | Убрать писем | Убрать встреч | Изменить форму: писем / встреч | Освобождает часов в неделю |');
  L.push('|---|---|---|---|---|---|');
  for (const r of s.byChange) L.push(`| ${r.change} | ${r.label} | ${r.letters} | ${r.meetings} | ${r.otherLetters} / ${r.otherMeetings} | ${h(r.freedHours)} |`);
  L.push('');
  for (const kind of ['письма', 'встречи'] as const) {
    L.push(kind === 'письма' ? '## Письма' : '## Встречи');
    L.push('');
    L.push(`| ${kind === 'письма' ? 'Цепочка' : 'Серия'} | Штук | Часов в неделю | Вердикт | Причина | Освобождает ч/нед | Что изменить | Вместо | Основание |`);
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const i of items.filter((x) => x.kind === kind))
      L.push(`| ${cell(i.from ? `${i.from}: ${i.title}` : i.title)} | ${i.count} | ${h(i.hours)} | ${i.verdictLabel} | ${i.causeLabel} | ${h(i.freedHours)} | ${cell(i.change)} | ${cell(i.instead)} | ${cell(i.basis)} |`);
    L.push('');
  }
  L.push('## Сравнение с эталоном заказчика');
  L.push('');
  L.push('Эталон модели не отдавался. Здесь — что заказчик в синтетике считает нужным действием, а аудитор предлагает убрать или изменить.');
  L.push('');
  L.push(`| Вердикт аудитора \\ эталон \`expected_action\` | ${s.etalon.actions.join(' | ')} |`);
  L.push(`|---|${s.etalon.actions.map(() => '---').join('|')}|`);
  for (const r of s.etalon.rows) L.push(`| ${r.label} | ${r.cells.join(' | ')} |`);
  L.push('');
  const series = all.filter((a) => a.item.kind === 'встречи');
  const cats = [...new Set([...d.meetingEtalon.values()].map((m) => m.category))];
  L.push(`| Вердикт аудитора \\ категория встречи в календаре | ${cats.join(' | ')} |`);
  L.push(`|---|${cats.map(() => '---').join('|')}|`);
  for (const v of VERDICTS) {
    const cells = cats.map((c) =>
      series
        .filter((a) => a.audit.вердикт === v)
        .reduce((n, a) => n + (a.item.kind === 'встречи' ? a.item.meetings.filter((m) => d.meetingEtalon.get(m.uid)?.category === c).length : 0), 0),
    );
    L.push(`| ${VERDICT_LABEL[v]} | ${cells.join(' | ')} |`);
  }
  L.push('');
  return L.join('\n');
}

// Короткое сообщение руководителю в Telegram (HTML-разметка Telegram).
export function toTelegram(s: Summary, items: ViewItem[], pageUrl: string): string {
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const gone = s.byVerdict.find((r) => r.verdict === 'не_должно')!;
  const top = items.filter((i) => i.freedHours > 0).sort((a, b) => b.freedHours - a.freedHours).slice(0, 5);
  const L: string[] = [];
  L.push('<b>Аудит потока за неделю</b>');
  L.push('');
  L.push(`Из ${h(s.flowHours)} ч на почту и встречи можно освободить <b>${h(s.freedHours)} ч</b>.`);
  L.push(`Не должно быть вовсе: ${plural(gone.letters, 'письмо', 'письма', 'писем')} из ${s.letters} и ${plural(gone.meetings, 'встреча', 'встречи', 'встреч')} из ${s.meetings}.`);
  L.push('');
  L.push('<b>Что поменять в отделе</b>');
  for (const r of s.byChange.slice(0, 4)) L.push(`• ${esc(r.change)} — ${h(r.freedHours)} ч`);
  L.push('');
  L.push('<b>Больше всего времени забирают</b>');
  for (const i of top) L.push(`• ${esc(i.from ? `${i.from}: ${i.title}` : i.title)} (${i.count}) — ${esc(i.verdictLabel.toLowerCase())}, ${h(i.freedHours)} ч`);
  L.push('');
  L.push(`Подробно, с причинами по каждому письму и встрече: ${esc(pageUrl)}`);
  L.push('');
  L.push('<i>ИИ-помощник. Часы — по допущениям, они указаны на странице.</i>');
  return L.join('\n');
}

function plural(n: number, one: string, few: string, many: string) {
  const a = n % 10, b = n % 100;
  const w = a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  return `${n} ${w}`;
}

export function h(x: number) {
  return x.toFixed(1).replace('.', ',');
}

function round(x: number) {
  return Math.round(x * 100) / 100;
}

function cell(s: string) {
  return String(s ?? '').replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ');
}
