// K2: вердикт по просьбе подчинённого. Модель предлагает, код не пускает категории N1 без руководителя.
import { z } from 'zod';
import { callJson, type JsonSchema } from '../llm.ts';

const FINISH = 'Доделайте просьбу: какое решение предлагаете, какой срок и что нужно от руководителя. Пока возвращаю вам.';

export function hasProposal(text: string): boolean {
  return /предлага|вариант|план\b|прошу согласовать|замен/i.test(text);
}

export function finishTemplate(): string {
  return FINISH;
}

export const VERDICT_KINDS = ['нужен_руководитель', 'вернуть'] as const;
export const MODEL_CATEGORIES = ['деньги', 'кадры', 'обязательства_клиентам', 'иное'] as const;
export const CATEGORIES = [...MODEL_CATEGORIES, 'руководство'] as const;
export type RequestCategory = (typeof CATEGORIES)[number];

const N1 = new Set<RequestCategory>(['деньги', 'кадры', 'обязательства_клиентам', 'руководство']);

export function leaderMustConfirm(category: string): boolean {
  return N1.has(category as RequestCategory);
}

export interface ModelVerdict {
  вердикт: (typeof VERDICT_KINDS)[number];
  в_полномочиях: 'да' | 'нет' | 'неясно';
  есть_предложение: 'да' | 'нет';
  только_руководитель: 'да' | 'нет';
  категория: RequestCategory;
  суть: string;
  контекст: string;
  рекомендация: string;
  черновик_ответа: string;
  предложение_полномочия: string;
  основание: string;
  риски: string;
  если_не_решить: string;
  уверенность: number;
}

export interface Ruled {
  kind: 'нужен_руководитель' | 'вернуть' | 'повтор';
  category: RequestCategory;
  summary: string;
  draft: string;
  basis: string;
  context: string;
  recommendation: string;
  risks: string;
  ifNot: string;
  authorityOffer: string;
  ask: boolean;
  send: boolean;
}

export interface PriorDecision {
  id: string;
  status: string;
  summary: string;
}

const modelZod = z.object({
  вердикт: z.enum(VERDICT_KINDS),
  в_полномочиях: z.enum(['да', 'нет', 'неясно']),
  есть_предложение: z.enum(['да', 'нет']),
  только_руководитель: z.enum(['да', 'нет']),
  категория: z.enum(MODEL_CATEGORIES),
  суть: z.string().min(1).max(800),
  контекст: z.string().max(1200),
  рекомендация: z.string().max(1200),
  черновик_ответа: z.string().max(2000),
  предложение_полномочия: z.string().max(800),
  основание: z.string().min(1).max(800),
  риски: z.string().max(800),
  если_не_решить: z.string().max(800),
  уверенность: z.number().min(0).max(1),
});

const schema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'вердикт',
    'в_полномочиях',
    'есть_предложение',
    'только_руководитель',
    'категория',
    'суть',
    'контекст',
    'рекомендация',
    'черновик_ответа',
    'предложение_полномочия',
    'основание',
    'риски',
    'если_не_решить',
    'уверенность',
  ],
  properties: {
    вердикт: { type: 'string', enum: [...VERDICT_KINDS] },
    в_полномочиях: { type: 'string', enum: ['да', 'нет', 'неясно'] },
    есть_предложение: { type: 'string', enum: ['да', 'нет'] },
    только_руководитель: { type: 'string', enum: ['да', 'нет'] },
    категория: { type: 'string', enum: [...MODEL_CATEGORIES] },
    суть: { type: 'string' },
    контекст: { type: 'string' },
    рекомендация: { type: 'string' },
    черновик_ответа: { type: 'string' },
    предложение_полномочия: { type: 'string' },
    основание: { type: 'string' },
    риски: { type: 'string' },
    если_не_решить: { type: 'string' },
    уверенность: { type: 'number' },
  },
};

const SYSTEM = `Ты — агент полномочий руководителя. По одному письму подчинённого реши: нужен руководитель или вернуть просьбу исполнителю.
Руководитель нужен только если без него нельзя: деньги и бюджеты, кадры, обязательства клиентам, письма его руководству, либо просьба выше полномочий этого человека.
Если зона, цель и KPI подчинённого покрывают просьбу и это не деньги, кадры, обязательство клиенту и не письмо руководству — вердикт "вернуть": черновик возвращает ответственность и спрашивает план.
Скидка выше названного лимита полномочий — всегда "нужен_руководитель", категория "деньги".
Для "нужен_руководитель" заполни контекст (полномочия, KPI, цель, что уже известно), рекомендацию (один вариант, основание, альтернатива), риски и если_не_решить. Поле предложение_полномочия оставь пустым.
Для "вернуть" заполни предложение_полномочия: какое право дать, чтобы такие просьбы больше не приходили. Рекомендацию, риски и если_не_решить оставь пустыми.
Категорию «руководство» не ставь: её назначает код, если письмо от руководителя руководителя. Каждое текстовое поле короче 400 знаков. Эталонных меток писем у тебя нет.`;

export function chainKey(fromEmail: string, subject: string): string {
  return `${fromEmail.trim().toLowerCase()}|${subject.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export function textSignals(text: string): { category: RequestCategory | null; discountPercent: number | null } {
  const discount = text.match(/скидк[а-яё]*[^0-9\n]{0,24}(\d+(?:[.,]\d+)?)\s*%/i);
  if (discount) return { category: 'деньги', discountPercent: Number(discount[1].replace(',', '.')) };
  if (/отпуск|оффер|увольн/i.test(text)) return { category: 'кадры', discountPercent: null };
  if (/\d[\d\s.,]*\s*(₽|руб|млн)/i.test(text)) return { category: 'деньги', discountPercent: null };
  if (/обязательств/i.test(text) && /клиент/i.test(text)) return { category: 'обязательства_клиентам', discountPercent: null };
  return { category: null, discountPercent: null };
}

export function discountLimit(authorities: { area: string; limit: string }[]): number | null {
  const row = authorities.find((item) => item.area.toLowerCase().includes('скидк'));
  if (!row) return null;
  const value = Number(row.limit.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

export function enforce(model: ModelVerdict, letterText: string, limit: number | null, prior: PriorDecision | null, boss: boolean): Ruled {
  if (prior) {
    return {
      kind: 'повтор',
      category: 'иное',
      summary: `Повтор. Решение «${prior.status}»: ${prior.summary}`,
      draft: '',
      basis: 'По этой цепочке уже есть решение, второй раз не спрашиваю',
      context: '',
      recommendation: '',
      risks: '',
      ifNot: '',
      authorityOffer: '',
      ask: false,
      send: false,
    };
  }
  const signal = textSignals(letterText);
  let category: RequestCategory = model.категория;
  const reasons: string[] = [];
  if (boss) {
    category = 'руководство';
    reasons.push('отправитель — руководитель руководителя');
  }
  if (signal.category && signal.category !== category) {
    category = signal.category;
    reasons.push(`в тексте признак категории «${signal.category}»`);
  }
  if (signal.discountPercent !== null && limit !== null && signal.discountPercent > limit) {
    category = 'деньги';
    reasons.push(`скидка ${signal.discountPercent}% выше полномочия ${limit}%`);
  }
  const mustAsk = N1.has(category) || boss;
  const noProposal = !hasProposal(letterText);
  const kind = mustAsk ? 'нужен_руководитель' : noProposal ? 'вернуть' : model.вердикт;
  const basis = reasons.length ? `Код: ${reasons.join('; ')}. ${model.основание}` : model.основание;
  const draft = !mustAsk && noProposal ? finishTemplate() : model.черновик_ответа;
  return {
    kind,
    category,
    summary: model.суть,
    draft,
    basis: !mustAsk && noProposal ? `Нет предложения. ${basis}` : basis,
    context: model.контекст,
    recommendation: kind === 'нужен_руководитель' ? model.рекомендация : '',
    risks: kind === 'нужен_руководитель' ? model.риски : '',
    ifNot: kind === 'нужен_руководитель' ? model.если_не_решить : '',
    authorityOffer: kind === 'вернуть' ? model.предложение_полномочия || 'Вернуть просьбу, пока нет предложения решения' : '',
    ask: kind === 'нужен_руководитель',
    send: kind === 'вернуть',
  };
}

export function cardText(input: {
  who: string;
  вывод: string;
  рекомендация: string;
  основание: string;
  риски: string;
  если_не_решить: string;
  контекст: string;
  draft: string;
}): string {
  const lines = [
    '<b>ИИ-помощник</b>',
    '',
    escapeHtml(input.who),
    '',
    '<b>Вывод</b>',
    escapeHtml(input.вывод),
    '',
    '<b>Рекомендация</b>',
    escapeHtml(input.рекомендация),
    '',
    '<b>Основание</b>',
    escapeHtml(input.основание),
    '',
    '<b>Риски</b>',
    escapeHtml(input.риски),
    '',
    '<b>Если не решить</b>',
    escapeHtml(input.если_не_решить),
    '',
    '<b>Контекст</b>',
    escapeHtml(input.контекст),
    '',
    '<b>Черновик ответа</b>',
    escapeHtml(input.draft || '—'),
  ];
  return lines.join('\n');
}

export async function judgeLetter(input: { purpose: string; prompt: string }): Promise<ModelVerdict> {
  const result = await callJson<unknown>({
    purpose: input.purpose,
    system: SYSTEM,
    user: input.prompt,
    schemaName: 'k2_verdict',
    schema,
  });
  const parsed = modelZod.safeParse(result.data);
  if (!parsed.success) throw new Error('Ответ модели не совпал со схемой вердикта');
  return parsed.data;
}

export function letterPrompt(input: {
  profile: string;
  person: string;
  tasks: string;
  subject: string;
  body: string;
  limit: number | null;
  revisions?: string;
}): string {
  return [
    'Профиль руководителя:',
    input.profile.trim(),
    '',
    'Карточка подчинённого:',
    input.person,
    input.limit === null ? 'Лимит скидки не задан.' : `Лимит скидки: ${input.limit}%.`,
    '',
    'Открытые задачи:',
    input.tasks || 'нет',
    '',
    input.revisions ?? '',
    '',
    `Письмо. Тема: ${input.subject}`,
    input.body.trim(),
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
