// Разбор письма: модель выбирает действие и пункт подтверждения из профиля этого руководителя.
// Код отправляет к руководителю письмо пункта и просьбу выше числового предела полномочия.
import { z } from 'zod';
import { callJson, type ChatMessage, type JsonSchema, type ToolSpec } from '../llm.ts';
import { addresseeHold, personInAudience, unbuiltHold, type PointAudience } from './audience.ts';
import { breachBasis, canonicalCategory, categoryChoices, normalizeUnit, unitInText, type LimitBreach, OTHER } from './confirm.ts';
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
  область?: string;
  число?: number;
  единица?: string;
  другие_просьбы?: 'да' | 'нет';
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
export function rightRuling(rule: { area: string; limitValue: string; title: string }): Ruled {
  const limit = Number(String(rule.limitValue).replace(/\s/g, '').replace(',', '.'));
  const unit = normalizeUnit(rule.limitValue) || unitInText(rule.title);
  const mark = unit === '%' ? '%' : unit ? ` ${unit}` : '';
  const limitText = Number.isFinite(limit) ? `${limit}${mark}` : rule.limitValue;
  return {
    kind: 'вернуть',
    category: OTHER,
    summary: `В пределах принятого права: ${rule.area}`,
    draft: `Это ваше право: ${rule.area} до ${limitText}. Решите сами и напишите адресату.`,
    basis: `Правило: ${rule.title}`,
    context: '',
    recommendation: '',
    risks: '',
    ifNot: '',
    authorityOffer: '',
    ask: false,
    send: true,
  };
}

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

function verdictContract(points: string[], areas: string[]) {
  const choices = categoryChoices(points) as [string, ...string[]];
  const areaChoices = [...new Set([...areas.map((area) => area.trim()).filter(Boolean), 'нет'])] as [string, ...string[]];
  const units = ['%', 'ч', '₽', ''] as [string, ...string[]];
  const zod = z.object({
    действие: z.enum(ACTIONS),
    область: z.enum(areaChoices),
    число: z.number(),
    единица: z.enum(units),
    другие_просьбы: z.enum(['да', 'нет']),
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
      'область',
      'число',
      'единица',
      'другие_просьбы',
    ],
    properties: {
      действие: { type: 'string', enum: [...ACTIONS] },
      область: { type: 'string', enum: areaChoices },
      число: { type: 'number' },
      единица: { type: 'string', enum: units },
      другие_просьбы: { type: 'string', enum: ['да', 'нет'] },
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
Черновик ответа пишется от имени ИИ-помощника руководителя и содержит только факты из письма и данных, которые ты получил. Чего в этих данных нет — пропуск [допишите: название недостающего факта]: назови, чего не хватает, сам факт не пиши. Для в_сводку и без_ответа черновик пустой.
Для «руководителю» заполни контекст (что известно из данных), рекомендацию (один вариант и основание), риски и если_не_решить; черновик — ответ, который уйдёт после согласия руководителя.
предложение_полномочия — если такие письма можно больше не носить руководителю: какое право дать и кому. Иначе пусто.
суть — одна фраза, о чём письмо. основание — одна фраза: какое правило, полномочие, данные или прошлое решение привели к действию.
${list}
Если отправитель просит число в одной из своих областей с пределом, в область впиши эту область, в число — запрошенное число, в единица — %, ч или ₽, даже если число больше предела в карточке. «8 тыс.» — это 8000, «0,25 млн» — 250000, «р.» и «руб.» — рубли. Если такого числа нет, область «нет», число 0, единица пустая. Код сравнивает с правом только эти поля, текст основания не читает.
другие_просьбы — «нет», если в письме одна просьба. «да» — если просьб две или больше. Пункт профиля и предел в карточке второй просьбой не являются: считай только то, о чём просит отправитель.
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
  listBuilt = true,
  others: { name: string; email: string; role: string }[] = [],
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
  const hold =
    unbuiltHold(listBuilt, action, sender, target, others) ??
    addresseeHold(audiences, action, sender, target) ??
    (action === 'руководителю' ? personInAudience(audiences, sender) : null);
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

const BRACKETS = /\[[^\]\n]+\]/gu;

export function draftGaps(text: string): string[] {
  return text.match(BRACKETS) ?? [];
}

export function draftGap(text: string): string {
  return draftGaps(text)[0] ?? '';
}

export function textOutsideBrackets(text: string): string {
  return text.replace(BRACKETS, ' ');
}

export interface DraftCheck {
  checked: boolean;
  draft: string;
  unconfirmed: string[];
  note: string;
}

function claimPieces(claim: string): string[] {
  const words = claim
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4);
  const pieces = [claim.trim().toLowerCase().replace(/ё/g, 'е')];
  for (let size = words.length; size >= 2; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) pieces.push(words.slice(start, start + size).join(' '));
  }
  return [...new Set(pieces.filter((piece) => piece.length >= 8))].sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Заменённый факт в пропуске не повторяется: из скобок убирается сам текст и его куски.
export function gapsWithoutClaims(draft: string, claims: string[]): string {
  const pieces = claims.flatMap(claimPieces);
  if (!pieces.length) return draft;
  return draft.replace(/\[[^\]\n]+\]/gu, (gap) => {
    const inner = gap.slice(1, -1);
    let text = inner.toLowerCase().replace(/ё/g, 'е');
    let hit = false;
    for (const piece of pieces) {
      if (!text.includes(piece)) continue;
      hit = true;
      text = text.replace(new RegExp(escapeRegExp(piece), 'giu'), ' ');
    }
    if (!hit) return gap;
    text = text
      .replace(/\s+/g, ' ')
      .replace(/(?:^|[\s,;:])(?:и|или|на|по|с|со|в|во|к|о|об|от|до|для|что|это|а)(?=[\s,;:]|$)/giu, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s,;:.\-—]+|[\s,;:.\-—]+$/g, '')
      .trim();
    const named = text.replace(/^допишите:?\s*/iu, '').trim();
    return named.length >= 3 ? `[допишите: ${named}]` : '[допишите: недостающий факт]';
  });
}

export function applyCheckResult(draft: string, data: { claims: string[]; draft: string } | null): DraftCheck {
  if (!data) return { checked: false, draft, unconfirmed: [], note: 'Черновик не сверен' };
  const next = gapsWithoutClaims(data.draft.trim() || draft, data.claims);
  const outside = textOutsideBrackets(next).toLowerCase();
  const left = data.claims.map((claim) => claim.trim()).filter((claim) => claim && outside.includes(claim.toLowerCase()));
  return { checked: true, draft: next, unconfirmed: left, note: left.length ? `Не подтверждено данными: ${left.join('; ')}` : '' };
}

export function holdsDraft(check: DraftCheck): boolean {
  return !check.checked || check.unconfirmed.length > 0 || draftGaps(check.draft).length > 0;
}

export function keepForLeader<T extends { ask: boolean; send: boolean; kind: string }>(ruled: T, check: DraftCheck): T {
  if (!holdsDraft(check)) return ruled;
  return { ...ruled, ask: true, send: false, kind: 'нужен_руководитель' };
}

export function approvalBlock(draft: string, note = ''): string {
  if (note.toLowerCase().includes('не сверен')) return 'Черновик не сверен. Допишите его и утвердите снова.';
  if (note.startsWith('Не подтверждено данными:')) return `${note}. Допишите и утвердите снова.`;
  const gap = draftGap(draft);
  if (!gap) return '';
  return `В черновике пропуск ${gap}. Допишите его и утвердите снова.`;
}

const checkSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['неподтверждённые', 'черновик'],
  properties: {
    неподтверждённые: { type: 'array', items: { type: 'string' } },
    черновик: { type: 'string' },
  },
};

export function letterForCheck(
  letter: { fromName: string; subject: string; body: string },
  person: { position: string; role: string } | null,
): string {
  const position = person?.position.trim() || 'должность не указана';
  const role = person?.role.trim() || 'в оргструктуре нет';
  return `От: ${letter.fromName}, ${position}, ${role}\nТема: ${letter.subject}\n${letter.body}`;
}

export async function askDraftCheck(letter: string, facts: string, draft: string): Promise<{ claims: string[]; draft: string }> {
  const parsed = z.object({
    неподтверждённые: z.array(z.string()),
    черновик: z.string(),
  });
  const result = await callJson<unknown>({
    purpose: 'draft-check',
    system: [
      'Тебе даны письмо (первая строка — отправитель: имя, должность, роль), данные разбора и черновик ответа.',
      'Раздели фразы черновика на предложение и факты.',
      'Предложение — то, что руководитель утверждает этой кнопкой: его решение, оценка и вывод, поручение, просьба и срок. Его не проверяй и не меняй, даже если данные не подтверждают, что оценка верна или что решение уже принято.',
      'Факт — только сообщение о том, что уже было или уже есть: прошедшее событие, его итог, уже достигнутая договорённость, цифра, дата, уже существующий статус, кто что уже сделал.',
      'Замени пропуском только факт, которого нет ни в письме, ни у отправителя, ни в данных. Пропуск: [допишите: какого факта не хватает]. В нём назови, чего не хватает, и не повторяй слова заменённого факта.',
      'Цифры, даты, имена и статусы, которые уже есть в письме, у отправителя или в данных, оставь. Новых фактов не добавляй. Остальной текст, включая всё предложение, оставь дословно.',
      'Если таких фактов нет — верни черновик без единой правки и пустой список.',
    ].join(' '),
    user: `Письмо:\n${letter}\n\nДанные разбора:\n${facts || 'дополнительных данных нет'}\n\nЧерновик:\n${draft}`,
    schemaName: 'draft_check',
    schema: checkSchema,
  });
  const safe = parsed.safeParse(result.data);
  if (!safe.success) throw new Error('Ответ сверки не совпал со схемой');
  return { claims: safe.data.неподтверждённые, draft: safe.data.черновик };
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
  note?: string;
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
    ...(input.note ? ['<b>Сверка</b>', escapeHtml(input.note), ''] : []),
    ...(draftGap(input.draft) ? ['<b>Пропуск</b>', 'В черновике пропуск. Допишите его перед утверждением.', ''] : []),
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
  areas?: string[];
}): Promise<ModelVerdict> {
  const { zod, schema } = verdictContract(input.points, input.areas ?? []);
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
