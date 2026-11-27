// Правила руководителя: разовая правка не запоминается, «Запомнить» действует со следующего материала.
import { stepLine, type ProtocolStep } from './protocol-steps.ts';

export type RuleArea = 'письма' | 'протоколы' | 'утро';

export const RULE_AREAS: RuleArea[] = ['письма', 'протоколы', 'утро'];

export function ruleArea(value: string): RuleArea | null {
  return RULE_AREAS.find((area) => area === value) ?? null;
}

export type MemoryChoice = 'once' | 'keep' | 'approve';

// По умолчанию правка разовая. Постоянное правило — только явный выбор «Запомнить». Утверждение письма правило не создаёт.
export function ruleFromChoice(pending: string, choice: MemoryChoice): string | null {
  if (choice !== 'keep') return null;
  const text = pending.trim();
  return text.length >= 3 ? text : null;
}

const MONTHS: Record<string, string> = {
  января: '01',
  февраля: '02',
  марта: '03',
  апреля: '04',
  мая: '05',
  июня: '06',
  июля: '07',
  августа: '08',
  сентября: '09',
  октября: '10',
  ноября: '11',
  декабря: '12',
};

const MONTH_NAMES = Object.keys(MONTHS).join('|');

export function actionAndDue(text: string): { action: string; due: string } | null {
  const dueMatch = new RegExp(`до\\s+\\d{1,2}\\s+(?:${MONTH_NAMES})(?:\\s+\\d{4})?`, 'i').exec(text);
  if (!dueMatch || dueMatch.index === undefined) return null;
  const due = dueMatch[0].replace(/\s+/g, ' ');
  const before = text.slice(0, dueMatch.index).split(/[.!?\n]/).pop() ?? '';
  const action = before
    .replace(/^(?:нужно|надо|прошу|просим|пожалуйста)\s+/i, '')
    .replace(/[,:\s]+$/g, '')
    .trim();
  if (action.length < 3) return null;
  return { action: action.charAt(0).toUpperCase() + action.slice(1), due };
}

function letterRule(rules: { area?: string; category?: string; instead: string }[]): string | null {
  const hit = rules.find((row) => (row.area === 'письма' || row.category === 'письма') && /начинай с действия и срока/i.test(row.instead));
  return hit?.instead ?? null;
}

// Черновик для получателя: без служебной фразы. Правило «начинай с действия и срока» ставит в начало действие и срок этого письма.
export function finishDraft(draft: string, letterText: string, rules: { area?: string; category?: string; instead: string }[], team: boolean): string {
  const clean = draft.replace(/\n*По вашей правке:[\s\S]*$/u, '').trim();
  if (!team || !letterRule(rules)) return clean;
  const opening = actionAndDue(letterText);
  if (!opening) return clean;
  const head = opening.action.slice(0, Math.min(12, opening.action.length)).toLowerCase();
  if (clean.toLowerCase().startsWith(head)) return clean;
  return `${opening.action}, ${opening.due}.\n\n${clean}`.trim();
}

const GREETING = /^(?:здравствуйте|добрый(?:\s+|-)(?:день|вечер|утро)|привет(?:ствую)?|доброго\s+времени(?:\s+суток)?)[!.,…\s]*/i;

function stripService(draft: string): string {
  return draft.replace(/\n*По вашей правке:[\s\S]*$/u, '').trim();
}

function capitalize(text: string): string {
  const next = text.trim();
  if (!next) return next;
  return next.charAt(0).toUpperCase() + next.slice(1);
}

function stripGreeting(text: string): string {
  return capitalize(text.replace(GREETING, ''));
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');
}

function factsOf(text: string): string[] {
  const found =
    text.match(
      /\d+(?:[.,]\d+)?\s*%|\d[\d\s.,]*\s*(?:₽|руб(?:\.|лей|ля|ль)?)|(?:понедельник|вторник|сред[ауы]|четверг|пятниц[аыу]|суббот[аыу]|воскресенье)|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/gi,
    ) ?? [];
  return [...new Set(found.map((item) => item.toLowerCase().replace(/\s+/g, ' ').trim()))];
}

const COURTESY = /^(?:спасибо|благодарю|с уважением|хорошего дня|всего доброго|заранее благодар)/i;

function shorten(text: string): string {
  const bare = stripGreeting(text);
  const sentences = bare
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item && !COURTESY.test(item));
  if (!sentences.length) return bare;
  const joined = `${sentences.map((item) => item.replace(/[.!?]+$/g, '')).join(', ')}.`;
  const lined = sentences.join(' ');
  return joined.length < lined.length ? capitalize(joined) : lined;
}

// Понятная правка делается здесь. null — нужен разбор моделью, текст просьбы черновиком не становится.
export function localRewrite(draft: string, instruction: string): string | null {
  const clean = stripService(draft);
  const ask = instruction.trim();
  if (/убери\s+приветств|без\s+приветств/i.test(ask)) return stripGreeting(clean);
  if (/короче|сократ|покороче/i.test(ask)) {
    const next = shorten(clean);
    return next.length < clean.length ? next : null;
  }
  return null;
}

// Новый текст принимается, только если это всё ещё письмо: не просьба руководителя и факты черновика на месте.
export function acceptRewrite(draft: string, instruction: string, candidate: string): string | null {
  const clean = stripService(draft);
  const next = stripService(candidate);
  if (next.length < 3 || sameText(next, instruction) || sameText(next, clean)) return null;
  if (/убери\s+приветств|без\s+приветств/i.test(instruction) && GREETING.test(next)) return null;
  for (const fact of factsOf(clean)) {
    if (!next.toLowerCase().includes(fact)) return null;
  }
  return next;
}

export function rewriteLetter(draft: string, instruction: string, letterText: string): string | null {
  if (/начинай с действия и срока/i.test(instruction)) return finishDraft(draft, letterText, [{ area: 'письма', instead: instruction }], true);
  return localRewrite(draft, instruction);
}

export function isLetterRule(row: { area?: string; category?: string }): boolean {
  if (row.area === 'протоколы' || row.area === 'утро' || row.category === 'протокол') return false;
  return (row.area ?? 'письма') === 'письма';
}

export function mailRevisions<T extends { area?: string; category?: string }>(rows: T[]): T[] {
  return rows.filter(isLetterRule);
}

export function dueFromInstruction(text: string, year: number): string | null {
  if (!/срок|пятниц/i.test(text)) return null;
  const match = new RegExp(`(\\d{1,2})\\s+(${MONTH_NAMES})`, 'i').exec(text);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  return `${year}-${month}-${match[1].padStart(2, '0')}`;
}

export function stepIndex(steps: { task: string }[], instruction: string): number {
  const lower = instruction.toLowerCase();
  let best = -1;
  let score = 0;
  steps.forEach((step, index) => {
    const task = step.task.trim().toLowerCase();
    const slice = task.slice(0, Math.min(task.length, 48));
    if (slice.length >= 8 && lower.includes(slice) && task.length > score) {
      score = task.length;
      best = index;
    }
  });
  return best;
}

export function replaceStepLine(body: string, before: ProtocolStep, after: ProtocolStep): string {
  const oldLine = stepLine(before);
  const nextLine = stepLine(after);
  if (body.includes(oldLine)) return body.replace(oldLine, nextLine);
  return body;
}

export type MorningBlockId = 'waiting' | 'own' | 'meetings' | 'plan' | 'overdue' | 'questions' | 'share' | 'returned';

const MORNING_ORDER: MorningBlockId[] = ['waiting', 'own', 'meetings', 'plan', 'overdue', 'questions', 'share', 'returned'];

function blockByPhrase(phrase: string): MorningBlockId | null {
  if (/просроч/i.test(phrase)) return 'overdue';
  if (/ожида|ждут|решени/i.test(phrase)) return 'waiting';
  if (/ваши задачи|задач руководителя/i.test(phrase)) return 'own';
  if (/встреч/i.test(phrase)) return 'meetings';
  if (/три дела|дела на сегодня/i.test(phrase)) return 'plan';
  if (/вопрос/i.test(phrase)) return 'questions';
  if (/цел/i.test(phrase)) return 'share';
  if (/ответил/i.test(phrase)) return 'returned';
  return null;
}

// «Сначала …, затем …» меняет порядок двух блоков. Без правила — обычный порядок утра.
export function morningBlockOrder(rules: string[]): MorningBlockId[] {
  const rule = [...rules].reverse().find((text) => /сначала/i.test(text) && /затем/i.test(text));
  if (!rule) return [...MORNING_ORDER];
  const match = /сначала\s+(.+?)\s*,?\s*затем\s+(.+)/i.exec(rule);
  if (!match) return [...MORNING_ORDER];
  const first = blockByPhrase(match[1] ?? '');
  const second = blockByPhrase(match[2] ?? '');
  if (!first || !second || first === second) return [...MORNING_ORDER];
  const rest = MORNING_ORDER.filter((id) => id !== first && id !== second);
  rest.splice(Math.min(MORNING_ORDER.indexOf(first), MORNING_ORDER.indexOf(second)), 0, first, second);
  return rest;
}

export interface ActExample {
  subject: string;
  action: string;
  approvedText: string;
  auto: boolean;
}

// Похожие решения самого руководителя. То, что помощник сделал сам, примером не берётся.
export function exampleBlock(letter: string, acts: ActExample[]): string {
  const words = new Set(letter.toLowerCase().split(/[^a-zа-яё0-9]+/i).filter((word) => word.length >= 5));
  const hits = acts
    .filter((act) => !act.auto && act.approvedText.trim())
    .filter((act) => {
      const bag = `${act.subject} ${act.approvedText}`.toLowerCase();
      return [...words].some((word) => bag.includes(word));
    })
    .slice(0, 3);
  if (!hits.length) return '';
  return [
    'Реальные прошлые решения руководителя — примеры формулировок, не правило и не повод менять действие:',
    ...hits.map((act) => `— «${act.subject}»: ${act.action}. Текст: ${act.approvedText}`),
  ].join('\n');
}

export function ruleHint(rules: { area?: string; instead: string }[]): string {
  const rows = rules.filter((row) => (row.area ?? 'письма') === 'письма' && row.instead.trim());
  if (!rows.length) return '';
  return [
    'Правила писем руководителя. Соблюдай их в черновике и не цитируй формулировку правила.',
    ...rows.slice(-8).map((row) => `— ${row.instead.trim()}`),
    'Деньги, кадры, обещания клиентам и письма начальника по-прежнему только с подтверждением руководителя.',
  ].join('\n');
}
