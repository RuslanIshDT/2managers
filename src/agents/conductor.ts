// Дирижёр: код собирает кандидатов, модель оставляет не больше трёх дел. Имена и цели приходят в данных.
import { z } from 'zod';
import { callJson, type JsonSchema } from '../llm.ts';
import { canonicalCategory, categoryChoices, confirmationPoints } from './confirm.ts';

export interface Candidate {
  id: string;
  kind: string;
  title: string;
  detail: string;
  goal: string;
  person?: string;
}

export interface Choice {
  id: string;
  goal: string;
  minutes: number;
  why: string;
}

export interface FocusPlan {
  today: { title: string; goal: string; minutes: number; why: string }[];
  later: string[];
}

const choiceZod = z.object({
  today: z
    .array(
      z.object({
        id: z.string(),
        goal: z.string(),
        minutes: z.number(),
        why: z.string(),
      }),
    )
    .max(8),
});

export const choiceSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['today'],
  properties: {
    today: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'goal', 'minutes', 'why'],
        properties: {
          id: { type: 'string' },
          goal: { type: 'string' },
          minutes: { type: 'integer' },
          why: { type: 'string' },
        },
      },
    },
  },
};

// Объяснение модели проверяет код: без служебных идентификаторов и без чужих имён, иначе — основание из данных.
export function checkedWhy(why: string, source: Candidate, names: string[]): string {
  const text = why.trim();
  const foreign = names.filter((name) => name && name !== source.person && !source.title.includes(name));
  const stems = foreign.flatMap((name) => name.split(/\s+/).filter((part) => part.length >= 4).map((part) => part.slice(0, part.length - 1)));
  const mentions = stems.some((stem) => new RegExp(`(^|[^А-Яа-яЁё])${stem}`).test(text));
  const ids = /\b[a-z_]+:[\w-]+|\b[a-z]\d{2,3}\b/i.test(text);
  if (mentions || ids || !text) return source.detail;
  return text;
}

export function applyChoice(candidates: Candidate[], chosen: Choice[], names: string[] = []): FocusPlan {
  const byId = new Map(candidates.map((row) => [row.id, row]));
  const used = new Set<string>();
  const today: FocusPlan['today'] = [];
  for (const item of chosen) {
    if (today.length >= 3) break;
    const source = byId.get(item.id);
    if (!source || used.has(source.id)) continue;
    if (!item.goal.trim() || !item.why.trim() || !(item.minutes > 0)) continue;
    used.add(source.id);
    today.push({
      title: source.title,
      goal: item.goal.trim(),
      minutes: Math.round(item.minutes),
      why: checkedWhy(item.why, source, names),
    });
  }
  return { today, later: candidates.filter((row) => !used.has(row.id)).map((row) => row.title) };
}

export async function chooseFocus(input: { purpose: string; profile: string; candidates: Candidate[]; names?: string[]; hint?: string }): Promise<FocusPlan> {
  const hint = input.hint?.trim() ? ` Указание руководителя для выбора дел: ${input.hint.trim()}` : '';
  const result = await callJson<unknown>({
    purpose: input.purpose,
    system: [
      'Ты дирижёр фокуса руководителя.',
      'Из кандидатов выбери не больше трёх дел с наибольшим эффектом на час его времени.',
      'У каждого дела назови цель из профиля, оценку минут и одним коротким предложением — почему эффект на час больше, чем у остальных.',
      'Бери только id из списка. Не выдумывай людей и дел.',
      hint,
    ].filter(Boolean).join(' '),
    user: ['Профиль:', input.profile.trim(), '', 'Кандидаты:', JSON.stringify(input.candidates)].join('\n'),
    schemaName: 'focus_choice',
    schema: choiceSchema,
  });
  const parsed = choiceZod.safeParse(result.data);
  if (!parsed.success) throw new Error('Ответ модели не совпал со схемой трёх дел');
  return applyChoice(input.candidates, parsed.data.today, input.names ?? []);
}

// Виды встреч. Время на цели руководителя — встречи видов из GOAL_KINDS (владелец 27.11.2026, T62).
export const SERIES_KINDS = ['решение', 'статус', 'один_на_один', 'внешняя', 'стратегия'] as const;
export const GOAL_KINDS = new Set<string>(['стратегия', 'один_на_один', 'внешняя']);

function seriesContract(points: string[]) {
  const choices = categoryChoices(points) as [string, ...string[]];
  const zod = z.object({
    series: z.array(
      z.object({
        title: z.string(),
        kind: z.enum(SERIES_KINDS),
        category: z.enum(choices),
      }),
    ),
  });
  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['series'],
    properties: {
      series: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'kind', 'category'],
          properties: {
            title: { type: 'string' },
            kind: { type: 'string', enum: [...SERIES_KINDS] },
            category: { type: 'string', enum: choices },
          },
        },
      },
    },
  };
  return { zod, schema, choices };
}

export async function classifySeries(input: {
  purpose: string;
  series: { title: string; attendees: string[] }[];
  profile?: string;
}): Promise<{ title: string; kind: string; category: string }[]> {
  if (input.series.length === 0) return [];
  const points = confirmationPoints(input.profile ?? '');
  const { zod, schema, choices } = seriesContract(points);
  const named = points.length ? points.map((point) => `«${point}»`).join('; ') : 'пунктов нет';
  const result = await callJson<unknown>({
    purpose: input.purpose,
    system: [
      'По названию и участникам определи вид встречи.',
      'решение — на встрече принимается решение.',
      'статус — обмен статусом: планёрка, синк, отчёт, подведение итогов.',
      'один_на_один — личная встреча руководителя с одним подчинённым о его работе, целях и развитии; рабочий синк двух людей по теме — это статус или решение.',
      'внешняя — встреча с клиентом или партнёром компании; встреча с поставщиком — решение или статус.',
      'стратегия — стратегия и цели: руководитель работает над целями из профиля — стратегическая сессия, планирование квартала, блок времени под цель.',
      `Категория — дословно пункт профиля «Никогда без подтверждения руководителя» (${named}) или «иное»: что решается на этой встрече. Допустимые значения: ${choices.join('; ')}.`,
      'Не добавляй встречи, которых нет в списке.',
    ].join(' '),
    user: [input.profile ? `Профиль:\n${input.profile.trim()}` : '', `Встречи: ${JSON.stringify(input.series)}`].filter(Boolean).join('\n\n'),
    schemaName: 'series_kind',
    schema,
  });
  const parsed = zod.safeParse(result.data);
  if (!parsed.success) throw new Error('Ответ модели не совпал со схемой вида встречи');
  const known = new Set(input.series.map((row) => row.title));
  return parsed.data.series
    .filter((row) => known.has(row.title))
    .map((row) => ({ ...row, category: canonicalCategory(row.category, points) }));
}
