// Разбор письма: модель выбирает действие и пункт подтверждения из профиля этого руководителя.
// Код отправляет к руководителю письмо пункта и просьбу выше числового предела полномочия.
import { z } from 'zod';
import { callJson, type ChatMessage, type JsonSchema, type ToolSpec } from '../llm.ts';
import { addresseeHold, personInAudience, type PointAudience } from './audience.ts';
import { breachBasis, canonicalCategory, categoryChoices, type LimitBreach, OTHER } from './confirm.ts';
import { changeWords, type TermChange } from './terms.ts';

export const ACTIONS = ['руководителю', 'ответить', 'передать', 'в_сводку', 'без_ответа'] as const;
export type MailDecision = (typeof ACTIONS)[number];

export interface ModelVerdict {
  действие: MailDecision;
  кому_передать: string;
  в_полномочиях: 'да' | 'нет' | 'неясно';
  есть_предложение: 'да' | 'нет';
  только_руководитель: 'да' | 'нет';
  категория: string;
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

// kind в базе: нужен_руководитель — ждёт руководителя; вернуть — помощник ответил сам; делегировать — передал сотруднику;
// в_сводку — ответ не нужен, для сведения; игнорировать — без ответа; повтор — по переписке уже решено.
export type RuledKind = 'нужен_руководитель' | 'вернуть' | 'делегировать' | 'в_сводку' | 'игнорировать' | 'повтор';

export interface Ruled {
  kind: RuledKind;
  forwardTo?: { name: string; email: string };
  category: string;
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

// Модель не дала разбор: письмо уходит руководителю, повторного вызова нет.
export function failedRuling(_letterText: string, reason: string): Ruled {
  return {
    kind: 'нужен_руководитель',
    category: OTHER,
    summary: 'Разбор не удался, письмо ждёт вас',
    draft: '',
    basis: `Модель не дала ответ по схеме (${reason.slice(0, 160)}). Повторного разбора не будет`,
    context: '',
    recommendation: 'Прочитайте письмо и решите сами',
    risks: '',
    ifNot: 'Письмо останется без ответа',
    authorityOffer: '',
    ask: true,
    send: false,
  };
}

function verdictContract(points: string[]) {
  const choices = categoryChoices(points) as [string, ...string[]];
  const zod = z.object({
    действие: z.enum(ACTIONS),
    кому_передать: z.string().max(200),
    в_полномочиях: z.enum(['да', 'нет', 'неясно']),
    есть_предложение: z.enum(['да', 'нет']),
    только_руководитель: z.enum(['да', 'нет']),
    категория: z.enum(choices),
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
      'действие',
      'кому_передать',
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
      действие: { type: 'string', enum: [...ACTIONS] },
      кому_передать: { type: 'string' },
      в_полномочиях: { type: 'string', enum: ['да', 'нет', 'неясно'] },
      есть_предложение: { type: 'string', enum: ['да', 'нет'] },
      только_руководитель: { type: 'string', enum: ['да', 'нет'] },
      категория: { type: 'string', enum: choices },
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
  return { zod, schema };
}

export function mailSystem(points: string[]): string {
  const list = points.length
    ? `Категория — дословно один из пунктов профиля «Никогда без подтверждения руководителя»: ${points.map((point) => `«${point}»`).join('; ')}. Если письмо не про такой пункт, категория «${OTHER}». Письмо пункта руководитель увидит в любом случае: это проверит код.`
    : `В профиле нет пунктов «Никогда без подтверждения руководителя». Категория всегда «${OTHER}». Обязательного подтверждения нет.`;
  return `Ты разбираешь одно письмо, пришедшее руководителю, и решаешь, что с ним сделать. Прочитай письмо целиком и опирайся на контекст: кто пишет, о чём переписка, что уже решено, чьё это дело.
Действие — одно из пяти:
руководителю — без него нельзя: письмо относится к пункту подтверждения из профиля, просьба выше полномочий отправителя, решение только его уровня, приглашение, где нужно его согласие.
ответить — нужен ответ, и помощник может дать его сам: подтвердить участие или перенос внутренней встречи по правилам профиля, ответить на вопрос по данным, сказать сотруднику, что решение в его полномочиях (назови полномочие), попросить предложить вариант, если человек принёс проблему без решения.
передать — письмо по зоне сотрудника руководителя: в кому_передать впиши его имя и фамилию из списка людей, в черновик_ответа — короткую записку ему, что сделать и к какому сроку.
в_сводку — ответа не нужно: статус, отчёт, информация, уведомление, напоминание о том, что уже в работе. Руководитель прочтёт это в сводке.
без_ответа — рассылка, реклама, автоуведомление: ни ответ, ни сводка не нужны.
Черновик ответа пишется от имени ИИ-помощника руководителя, по существу этого письма, с конкретным следующим шагом. Никаких шаблонов, общих фраз и заглушек вроде [дата], не обещай того, чего нет в данных. Для в_сводку и без_ответа черновик пустой.
Для «руководителю» заполни контекст (что известно из данных), рекомендацию (один вариант и основание), риски и если_не_решить; черновик — ответ, который уйдёт после согласия руководителя.
предложение_полномочия — если такие письма можно больше не носить руководителю: какое право дать и кому. Иначе пусто.
суть — одна фраза, о чём письмо. основание — одна фраза: какое правило, полномочие, данные или прошлое решение привели к действию.
${list}
Каждое текстовое поле короче 400 знаков. Эталонных меток писем у тебя нет.`;
}

// Ответ и пересылка — та же цепочка: «Re:», «Fwd:», «Отв:» в начале темы не учитываются.
export function chainKey(fromEmail: string, subject: string): string {
  let topic = subject.trim().toLowerCase().replace(/\s+/g, ' ');
  for (let i = 0; i < 5; i += 1) {
    const next = topic.replace(/^(?:re|fwd?|fw|отв|ответ|пересл)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*/i, '');
    if (next === topic) break;
    topic = next;
  }
  return `${fromEmail.trim().toLowerCase()}|${topic}`;
}

// changes — новые условия против прежних писем цепочки. С ними письмо не повтор.
// points — пункты подтверждения этого руководителя. breaches — числа выше предела полномочия отправителя.
// audiences — люди, которых модель отнесла к пункту про адресата. Ответ или пересылка им ждёт руководителя.
export function enforce(
  model: ModelVerdict,
  _letterText: string,
  points: string[],
  breaches: LimitBreach[],
  prior: PriorDecision | null,
  changes: TermChange[] = [],
  staff: { name: string; email: string }[] = [],
  senderEmail = '',
  audiences: PointAudience[] = [],
  senderName = '',
): Ruled {
  if (prior && !changes.length) {
    return {
      kind: 'повтор',
      category: OTHER,
      summary: `Повтор. Решение «${prior.status}»: ${prior.summary}`,
      draft: '',
      basis: 'По этой переписке уже есть решение, второй раз не спрашиваю',
      context: '',
      recommendation: '',
      risks: '',
      ifNot: '',
      authorityOffer: '',
      ask: false,
      send: false,
    };
  }
  let category = canonicalCategory(model.категория, points);
  const reasons: string[] = [];
  const over = breachBasis(breaches);
  if (over) reasons.push(over);
  if (changes.length) reasons.push(`по переписке уже было решение${prior ? ` «${prior.status}»` : ''}, условия изменились (${changeWords(changes)}) — это не повтор`);
  let target = model.действие === 'передать' ? findPerson(model.кому_передать, staff) : null;
  const toSender = Boolean(target && senderEmail && target.email.toLowerCase() === senderEmail.toLowerCase());
  if (toSender) target = null;
  const action: MailDecision = toSender ? 'ответить' : model.действие;
  const sender = { name: senderName, email: senderEmail };
  const hold = addresseeHold(audiences, action, sender, target) ?? (action === 'руководителю' ? personInAudience(audiences, sender) : null);
  if (hold) {
    reasons.push(`${hold.point}: ${hold.name}`);
    category = hold.point;
  }
  if (action === 'передать' && !target) reasons.push(`передать «${model.кому_передать || 'не указано'}» — такого человека нет в списке`);
  if ((action === 'ответить' || action === 'передать') && !model.черновик_ответа.trim()) reasons.push('нет текста ответа');
  const protectedPoint = category !== OTHER;
  const mustAsk =
    Boolean(hold) ||
    protectedPoint ||
    breaches.length > 0 ||
    action === 'руководителю' ||
    (action === 'передать' && !target) ||
    ((action === 'ответить' || action === 'передать') && !model.черновик_ответа.trim());
  const kind: RuledKind = mustAsk
    ? 'нужен_руководитель'
    : action === 'ответить'
      ? 'вернуть'
      : action === 'передать'
        ? 'делегировать'
        : action === 'в_сводку'
          ? 'в_сводку'
          : 'игнорировать';
  const basis = reasons.length ? `Код: ${reasons.join('; ')}. ${model.основание}` : model.основание;
  return {
    kind,
    ...(kind === 'делегировать' && target ? { forwardTo: target } : {}),
    category,
    summary: changes.length ? `Условия изменились: ${changeWords(changes)}. ${model.суть}` : model.суть,
    draft: kind === 'в_сводку' || kind === 'игнорировать' ? '' : model.черновик_ответа,
    basis,
    context: model.контекст,
    recommendation: kind === 'нужен_руководитель' ? model.рекомендация : '',
    risks: kind === 'нужен_руководитель' ? model.риски : '',
    ifNot: kind === 'нужен_руководитель' ? model.если_не_решить : '',
    authorityOffer: model.предложение_полномочия,
    ask: kind === 'нужен_руководитель',
    send: kind === 'вернуть' || kind === 'делегировать',
  };
}

export function findPerson(name: string, staff: { name: string; email: string }[]): { name: string; email: string } | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const exact = staff.find((row) => row.name.toLowerCase() === wanted);
  if (exact) return exact;
  const words = wanted.split(/\s+/).filter((word) => word.length >= 4);
  const hits = staff.filter((row) => words.some((word) => row.name.toLowerCase().split(/\s+/).some((part) => part.startsWith(word.slice(0, Math.max(4, word.length - 2))))));
  return hits.length === 1 ? hits[0] : null;
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

export async function judgeLetter(input: {
  purpose: string;
  prompt: string;
  messages?: ChatMessage[];
  tools?: ToolSpec[];
  points: string[];
}): Promise<ModelVerdict> {
  const { zod, schema } = verdictContract(input.points);
  const system = mailSystem(input.points);
  let detail = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const retry = `Прошлый ответ не прошёл проверку (${detail}). Заполни все поля по схеме.`;
    const messages: ChatMessage[] | undefined = input.messages
      ? [{ role: 'system', content: system }, ...input.messages.filter((m) => m.role !== 'system'), ...(attempt === 1 ? [] : [{ role: 'user' as const, content: retry }])]
      : undefined;
    const result = await callJson<unknown>({
      purpose: input.purpose,
      system,
      user: attempt === 1 ? input.prompt : `${input.prompt}\n\n${retry}`,
      schemaName: 'k2_verdict',
      schema,
      messages,
      tools: input.tools,
    });
    const parsed = zod.safeParse(result.data);
    if (parsed.success) return parsed.data;
    detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`).join('; ').slice(0, 300);
  }
  throw new Error(`Ответ модели не совпал со схемой вердикта: ${detail}`.slice(0, 200));
}

export function letterPrompt(input: {
  profile: string;
  person: string;
  tasks: string;
  subject: string;
  body: string;
  revisions?: string;
}): string {
  return [
    'Профиль руководителя:',
    input.profile.trim(),
    '',
    'Карточка отправителя:',
    input.person,
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
