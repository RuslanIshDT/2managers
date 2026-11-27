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

export function rewriteLetter(draft: string, instruction: string, letterText: string): string {
  if (/начинай с действия и срока/i.test(instruction)) return finishDraft(draft, letterText, [{ area: 'письма', instead: instruction }], true);
  const clean = draft.replace(/\n*По вашей правке:[\s\S]*$/u, '').trim();
  if (/^(?:начинай|пиши|убери|добавь|не\s)/i.test(instruction)) return clean;
  return instruction.trim();
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
