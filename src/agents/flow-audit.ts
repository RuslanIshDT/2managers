// Аудитор потока (K5): каких писем и встреч в потоке руководителя не должно быть,
// почему и какое оргизменение их убирает. Один вызов модели на цепочку писем
// и на серию встреч; эталон синтетики модели не отдаётся.
import { callJson, type JsonSchema } from '../llm.ts';
import type { Email, Meeting, Person, Synthetic } from '../data/synthetic.ts';

export const VERDICTS = ['не_должно', 'в_другом_виде', 'должно'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const CAUSES = {
  статус_вместо_данных: {
    label: 'Статус вместо данных',
    change: 'Статус собирается из систем в дайджест, писать и созывать ради него не нужно',
  },
  в_полномочиях_отправителя: {
    label: 'Решение в полномочиях отправителя',
    change: 'Матрица полномочий: это решает исполнитель сам',
  },
  проблема_без_предложения: {
    label: 'Проблема без предложенного решения',
    change: 'Правило «приходи с решением»: просьба без варианта возвращается',
  },
  повтор: {
    label: 'Повтор или напоминание',
    change: 'Единая очередь решений, где виден статус: напоминать не нужно',
  },
  рассылка: {
    label: 'Рассылка или неприоритетное приглашение',
    change: 'Фильтр рассылок и приглашений по приоритетам руководителя',
  },
  не_тот_адресат: {
    label: 'Не тот адресат',
    change: 'Маршрут сразу к ответственному по оргструктуре',
  },
  встреча_без_решения: {
    label: 'Встреча без решения',
    change: 'Встреча — только ради решения; обмен статусом — письменным дайджестом',
  },
  руководитель_лишний: {
    label: 'Руководитель лишний на встрече',
    change: 'Руководитель не участвует: решения у ответственного, итог — в дайджесте',
  },
  нужно: { label: 'Нужно руководителю', change: '' },
} as const;
export type Cause = keyof typeof CAUSES;

export interface Audit {
  вердикт: Verdict;
  руководитель_нужен: boolean;
  причина: Cause;
  что_изменить: string;
  вместо: string;
  основание: string;
  останется_времени: number;
  уверенность: number;
}

export interface ThreadItem {
  kind: 'письма';
  key: string;
  title: string;
  from: string;
  emails: Email[];
}

export interface SeriesItem {
  kind: 'встречи';
  key: string;
  title: string;
  meetings: Meeting[];
}

export type Item = ThreadItem | SeriesItem;

export interface AuditedItem {
  item: Item;
  audit: Audit;
  model: string;
  costUsd: number | null;
  ms: number;
}

const schema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['вердикт', 'руководитель_нужен', 'причина', 'что_изменить', 'вместо', 'основание', 'останется_времени', 'уверенность'],
  properties: {
    вердикт: { type: 'string', enum: [...VERDICTS] },
    руководитель_нужен: { type: 'boolean' },
    причина: { type: 'string', enum: Object.keys(CAUSES) },
    что_изменить: { type: 'string' },
    вместо: { type: 'string' },
    основание: { type: 'string' },
    останется_времени: { type: 'number' },
    уверенность: { type: 'number' },
  },
};

const SYSTEM = `Ты — аудитор потока коммуникаций руководителя, опытный организационный консультант.
Задача не разобрать почту и не ответить на письма, а сказать, должно ли это письмо или эта встреча вообще существовать в потоке руководителя.

Принцип. В потоке руководителя должно быть только то, где без него нельзя: решение выше полномочий команды, которое нельзя делегировать; клиенты и партнёры, где нужен его уровень; стратегия; развитие людей один на один; то, что пункт его профиля оставляет только ему. Всё остальное — симптом плохой организации: не делегированы полномочия, статус узнают письмами вместо данных, люди приносят проблемы без решений, встречи собираются без решения.

Вердикт:
- "не_должно" — в правильно устроенном отделе этого письма или этой встречи в потоке руководителя не было бы вообще;
- "в_другом_виде" — повод реальный, но форма лишняя: например, решение руководителя нужно, но должно прийти один раз, с вариантом и в очередь решений; встреча нужна, но реже, короче или без части участников;
- "должно" — нужно руководителю как есть.
Вердикт — про поток руководителя, а не про компанию: если руководитель здесь не нужен ни в каком виде, вердикт "не_должно", даже если повод реальный и кто-то другой должен им заняться.

Причина — одна, главная:
- статус_вместо_данных — отчёт, статус, «дашборд обновлён», прогноз, который можно собрать из систем;
- в_полномочиях_отправителя — отправитель мог решить сам при нормальной матрице полномочий;
- проблема_без_предложения — принесли проблему или вопрос без своего варианта решения;
- повтор — напоминание или повтор уже заданного;
- рассылка — рассылка, новости, неприоритетное приглашение;
- не_тот_адресат — должно идти сразу ответственному по оргструктуре;
- встреча_без_решения — встреча для обмена статусом, решения на ней не принимаются;
- руководитель_лишний — встреча может быть нужна, но без руководителя;
- нужно — причины убирать нет (только с вердиктом "должно").

Ограничение: пункты раздела профиля «Никогда без подтверждения руководителя» сейчас не исполняются без его подтверждения. Ты можешь предложить изменить порядок, но тогда в "что_изменить" прямо скажи, что это решение руководителя о новых полномочиях.

Поля ответа:
- что_изменить — конкретное оргизменение для этого случая: кому, какое право или правило, с какими границами; одно-два предложения;
- вместо — что происходит вместо письма или встречи: кто решает, откуда берётся статус, куда идёт вопрос;
- основание — почему, со ссылкой на факты из текста, дат и участников; если вывод опирается на допущение (например, о полномочиях, которых нет в данных), так и напиши;
- руководитель_нужен — нужен ли руководитель хоть в каком-то виде;
- останется_времени — какая доля нынешнего времени руководителя на это останется после изменения, от 0 до 1: "не_должно" — 0, "должно" — 1, "в_другом_виде" — твоя оценка (например, 10 планёрок по 30 минут станут двумя по 30 — это 0.2; десять писем-повторов станут одним решением — 0.1);
- уверенность — от 0 до 1.

Не выдумывай факты, которых нет в данных. Пиши по-русски, коротко, без канцелярита.`;

export function buildItems(d: Synthetic): Item[] {
  const threads = new Map<string, ThreadItem>();
  for (const e of [...d.emails].sort((a, b) => a.received.localeCompare(b.received))) {
    const key = `${e.fromEmail}|${normSubject(e.subject)}`;
    let t = threads.get(key);
    if (!t) {
      t = { kind: 'письма', key, title: e.subject, from: e.fromName, emails: [] };
      threads.set(key, t);
    }
    t.emails.push(e);
  }
  const series = new Map<string, SeriesItem>();
  for (const m of [...d.meetings].sort((a, b) => a.start.localeCompare(b.start))) {
    let s = series.get(m.summary);
    if (!s) {
      s = { kind: 'встречи', key: m.summary, title: m.summary, meetings: [] };
      series.set(m.summary, s);
    }
    s.meetings.push(m);
  }
  return [...threads.values(), ...series.values()];
}

function normSubject(s: string): string {
  return s.replace(/^((re|fw|fwd|напоминание|повтор)\s*:\s*)+/i, '').trim().toLowerCase();
}

export function buildPrompt(d: Synthetic, item: Item): string {
  const people = d.people
    .map((p) => `- ${p.name} — ${p.position}; роль относительно руководителя: ${p.role}; ${p.email}`)
    .join('\n');
  const head = `Профиль руководителя:\n${d.profile.trim()}\n\nОргструктура:\n${people}\n\n`;
  if (item.kind === 'письма') {
    const e0 = item.emails[0];
    const who = personBy(d.people, e0.fromEmail);
    const texts = [...new Set(item.emails.map((e) => e.body.trim()))];
    return (
      head +
      `Цепочка писем руководителю: ${item.emails.length} шт.\n` +
      `Отправитель: ${e0.fromName} (${e0.fromEmail}); роль: ${e0.senderRole}` +
      (who ? `; должность: ${who.position}` : '') +
      `\nТема: ${e0.subject}\n` +
      `Пришли: ${item.emails.map((e) => e.received).join('; ')}\n` +
      `Темы писем: ${[...new Set(item.emails.map((e) => e.subject))].join(' | ')}\n` +
      `Тексты (без повторов):\n${texts.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n` +
      'Должна ли эта цепочка существовать в потоке руководителя?'
    );
  }
  const m0 = item.meetings[0];
  const org = personBy(d.people, m0.organizer);
  const attendees = new Map<string, string>();
  for (const m of item.meetings)
    for (const a of m.attendees) {
      const p = personBy(d.people, a.email);
      if (p?.role === 'руководитель') continue;
      attendees.set(a.email, p ? `${p.name} — ${p.position} (${p.role})` : `${a.name || a.email} — внешний участник`);
    }
  const total = item.meetings.reduce((s, m) => s + m.minutes, 0);
  return (
    head +
    `Серия встреч в календаре руководителя за две недели (7–18 декабря): «${item.title}», ${item.meetings.length} шт., всего ${total} мин.\n` +
    `Даты и длительность: ${item.meetings.map((m) => `${m.start.replace('T', ' ')} (${m.minutes} мин)`).join('; ')}\n` +
    `Организатор: ${org ? `${org.name} — ${org.position}` : m0.organizer}\n` +
    `Участники кроме руководителя:\n${[...attendees.values()].map((a) => `- ${a}`).join('\n') || '- нет'}\n\n` +
    'Должна ли эта серия встреч существовать в календаре руководителя в таком виде?'
  );
}

function personBy(people: Person[], email: string): Person | undefined {
  return people.find((p) => p.email.toLowerCase() === email.toLowerCase());
}

export async function auditItem(d: Synthetic, item: Item): Promise<AuditedItem> {
  let last: { data: Audit; model: string; costUsd: number | null; ms: number } | null = null;
  let cost = 0;
  let ms = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await callJson<Audit>({
      purpose: `аудитор потока: ${item.kind} «${item.title}»`,
      system: SYSTEM,
      user: buildPrompt(d, item),
      schemaName: 'flow_audit',
      schema,
    });
    cost += r.costUsd ?? 0;
    ms += r.ms;
    last = r;
    if (consistent(r.data)) break;
  }
  return { item, audit: normalize(last!.data), model: last!.model, costUsd: cost, ms };
}

// Вердикт и причина должны сходиться: «нужно» — только с «должно». Проверяет код.
function consistent(a: Audit): boolean {
  return (
    VERDICTS.includes(a.вердикт) &&
    a.причина in CAUSES &&
    (a.вердикт === 'должно') === (a.причина === 'нужно') &&
    (a.руководитель_нужен || a.вердикт === 'не_должно')
  );
}

function normalize(a: Audit): Audit {
  if (!VERDICTS.includes(a.вердикт)) throw new Error(`Неизвестный вердикт: ${a.вердикт}`);
  if (!(a.причина in CAUSES)) throw new Error(`Неизвестная причина: ${a.причина}`);
  const уверенность = clamp01(a.уверенность);
  const left = clamp01(a.останется_времени);
  const out = normalizeVerdict({ ...a, уверенность, останется_времени: left });
  // Доля оставшегося времени следует из вердикта; для «в другом виде» — оценка модели.
  if (out.вердикт === 'не_должно') out.останется_времени = 0;
  if (out.вердикт === 'должно') out.останется_времени = 1;
  return out;
}

function clamp01(x: unknown): number {
  return Math.min(1, Math.max(0, Number(x) || 0));
}

function normalizeVerdict(a: Audit): Audit {
  // Если и после повтора не сошлось: «должно» — причина «нужно»;
  // причина не названа — убирать не предлагаем, вердикт «должно»;
  // руководитель не нужен ни в каком виде — в его потоке этого быть не должно.
  if (a.вердикт === 'должно') return { ...a, причина: 'нужно' };
  if (a.причина === 'нужно') return { ...a, вердикт: 'должно' };
  if (!a.руководитель_нужен) return { ...a, вердикт: 'не_должно' };
  return a;
}

export async function runAudit(d: Synthetic, items: Item[], concurrency = 4): Promise<AuditedItem[]> {
  const out: AuditedItem[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await auditItem(d, items[i]);
      process.stderr.write(`  ${i + 1}/${items.length} ${items[i].kind}: ${items[i].title} → ${out[i].audit.вердикт}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
