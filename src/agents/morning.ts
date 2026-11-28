// Правило утра хранится структурой, которую собрала модель. Код по ней строит план и не разбирает формулировку.
import { z } from 'zod';
import { callJson, withLlmScope, type JsonSchema } from '../llm.ts';

export const MORNING_BLOCKS = [
  { id: 'waiting', title: 'ждут решения' },
  { id: 'own', title: 'ваши задачи' },
  { id: 'meetings', title: 'встречи' },
  { id: 'plan', title: 'три дела' },
  { id: 'overdue', title: 'просрочено' },
  { id: 'questions', title: 'вопросы протокола' },
  { id: 'share', title: 'время на цели' },
  { id: 'returned', title: 'помощник ответил' },
] as const;

export type MorningBlockId = (typeof MORNING_BLOCKS)[number]['id'];

export const DEFAULT_MORNING_ORDER: MorningBlockId[] = MORNING_BLOCKS.map((block) => block.id);

export interface MorningShape {
  order: MorningBlockId[];
  hide: MorningBlockId[];
  limit: { block: MorningBlockId; max: number }[];
  focus: string;
}

export const MORNING_UNUSABLE = 'к утру не применить';

const titles = MORNING_BLOCKS.map((block) => block.title) as [string, ...string[]];

const answerZod = z.object({
  порядок: z.array(z.enum(titles)).max(8),
  скрыть: z.array(z.enum(titles)).max(8),
  не_больше: z.array(z.object({ блок: z.enum(titles), строк: z.number().int().min(1).max(20) })).max(8),
  указание: z.string().max(400),
  не_применить: z.string().max(200),
});

const answerSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['порядок', 'скрыть', 'не_больше', 'указание', 'не_применить'],
  properties: {
    порядок: { type: 'array', items: { type: 'string', enum: titles } },
    скрыть: { type: 'array', items: { type: 'string', enum: titles } },
    не_больше: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['блок', 'строк'],
        properties: { блок: { type: 'string', enum: titles }, строк: { type: 'integer' } },
      },
    },
    указание: { type: 'string' },
    не_применить: { type: 'string' },
  },
};

function blockId(title: string): MorningBlockId | null {
  return MORNING_BLOCKS.find((block) => block.title === title)?.id ?? null;
}

function blockTitle(id: MorningBlockId): string {
  return MORNING_BLOCKS.find((block) => block.id === id)?.title ?? id;
}

export function shapeFromAnswer(data: unknown): { shape: MorningShape | null; note: string } {
  const parsed = answerZod.safeParse(data);
  if (!parsed.success) return { shape: null, note: MORNING_UNUSABLE };
  if (parsed.data.не_применить.trim()) return { shape: null, note: MORNING_UNUSABLE };
  const order = parsed.data.порядок.map(blockId).filter((id): id is MorningBlockId => id !== null);
  const hide = parsed.data.скрыть.map(blockId).filter((id): id is MorningBlockId => id !== null);
  const limit = parsed.data.не_больше.flatMap((row) => {
    const block = blockId(row.блок);
    return block ? [{ block, max: row.строк }] : [];
  });
  const shape: MorningShape = { order, hide, limit, focus: parsed.data.указание.trim() };
  if (!order.length && !hide.length && !limit.length && !shape.focus) return { shape: null, note: MORNING_UNUSABLE };
  return { shape, note: shapeWords(shape) };
}

export function shapeWords(shape: MorningShape): string {
  const parts: string[] = [];
  if (shape.order.length) parts.push(`Порядок: ${shape.order.map(blockTitle).join(', затем ')}`);
  if (shape.hide.length) parts.push(`Не показывать: ${shape.hide.map(blockTitle).join(', ')}`);
  for (const row of shape.limit) parts.push(`В блоке «${blockTitle(row.block)}» не больше ${row.max} строк`);
  if (shape.focus) parts.push(`Для выбора трёх дел: ${shape.focus}`);
  return parts.join('. ') || 'Обычный порядок утра';
}

export function parseMorningStored(raw: string): MorningShape | null {
  if (!raw.trim()) return null;
  try {
    const value = JSON.parse(raw) as Partial<MorningShape> & { error?: string };
    if (value.error || !value || typeof value !== 'object') return null;
    const order = Array.isArray(value.order) ? value.order.filter((id): id is MorningBlockId => DEFAULT_MORNING_ORDER.includes(id as MorningBlockId)) : [];
    const hide = Array.isArray(value.hide) ? value.hide.filter((id): id is MorningBlockId => DEFAULT_MORNING_ORDER.includes(id as MorningBlockId)) : [];
    const limit = Array.isArray(value.limit)
      ? value.limit.flatMap((row) => {
          if (!row || typeof row !== 'object') return [];
          const block = (row as { block?: string }).block;
          const max = (row as { max?: number }).max;
          if (!DEFAULT_MORNING_ORDER.includes(block as MorningBlockId) || typeof max !== 'number') return [];
          return [{ block: block as MorningBlockId, max }];
        })
      : [];
    const focus = typeof value.focus === 'string' ? value.focus : '';
    if (!order.length && !hide.length && !limit.length && !focus) return null;
    return { order, hide, limit, focus };
  } catch {
    return null;
  }
}

export function storeMorning(result: { shape: MorningShape | null; note: string }): string {
  if (!result.shape) return JSON.stringify({ error: result.note });
  return JSON.stringify(result.shape);
}

export interface MorningRuleInput {
  id: string;
  at: string;
  text: string;
  shape: MorningShape;
}

// Все разобранные правила по времени создания. Порядок строк в базе не важен.
// Более позднее перекрывает противоречие раннему; у раннего остаётся пометка.
export function combineMorning(rules: MorningRuleInput[]): { shape: MorningShape | null; notes: Record<string, string> } {
  const sorted = [...rules].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const shape: MorningShape = { order: [], hide: [], limit: [], focus: '' };
  let orderOwner = '';
  const hideOwner = new Map<MorningBlockId, string>();
  const limitOwner = new Map<MorningBlockId, string>();
  let focusOwner = '';
  const lost = new Map<string, string>();
  const mark = (id: string, later: string) => {
    if (id && id !== later) lost.set(id, later);
  };
  for (const rule of sorted) {
    if (rule.shape.order.length) {
      mark(orderOwner, rule.text);
      orderOwner = rule.id;
      shape.order = [...rule.shape.order];
      for (const block of rule.shape.order) {
        const hider = hideOwner.get(block);
        if (!hider) continue;
        mark(hider, rule.text);
        hideOwner.delete(block);
        shape.hide = shape.hide.filter((id) => id !== block);
      }
    }
    for (const block of rule.shape.hide) {
      if (shape.order.includes(block)) {
        mark(orderOwner, rule.text);
        shape.order = shape.order.filter((id) => id !== block);
      }
      if (!shape.hide.includes(block)) shape.hide.push(block);
      hideOwner.set(block, rule.id);
    }
    for (const row of rule.shape.limit) {
      mark(limitOwner.get(row.block) ?? '', rule.text);
      limitOwner.set(row.block, rule.id);
      shape.limit = [...shape.limit.filter((item) => item.block !== row.block), row];
    }
    if (rule.shape.focus) {
      mark(focusOwner, rule.text);
      focusOwner = rule.id;
      shape.focus = rule.shape.focus;
    }
  }
  if (!sorted.length) return { shape: null, notes: {} };
  const notes: Record<string, string> = {};
  for (const [id, text] of lost) notes[id] = `Перекрыто правилом «${text}»`;
  return { shape, notes };
}

export function applyMorning(shape: MorningShape | null | undefined): MorningBlockId[] {
  const order = shape?.order.length ? shape.order : DEFAULT_MORNING_ORDER;
  const rest = DEFAULT_MORNING_ORDER.filter((id) => !order.includes(id));
  const hide = new Set(shape?.hide ?? []);
  return [...order, ...rest].filter((id) => !hide.has(id));
}

export function morningLimit(shape: MorningShape | null | undefined, block: MorningBlockId): number | null {
  const row = shape?.limit.find((item) => item.block === block);
  return row ? row.max : null;
}

export async function interpretMorning(leaderId: string, text: string): Promise<{ shape: MorningShape | null; note: string }> {
  try {
    const result = await withLlmScope(
      { agent: 'morning', leaderId, operationId: `morning:${leaderId}:${Date.now()}`, title: 'Правило утра' },
      () => callJson<unknown>({
      purpose: `morning-rule:${leaderId}`,
      system: [
        'Ты разбираешь одно правило утреннего плана руководителя в структуру.',
        'порядок — блоки, которые надо поставить в начало, в нужном порядке. Остальные блоки останутся после них в обычном порядке. Пустой список — порядок не менять.',
        'скрыть — блоки, которые не показывать.',
        'не_больше — если в блоке нужно не больше N строк, не считая заголовка.',
        'указание — короткая фраза для выбора трёх дел, если правило про это. Иначе пусто.',
        `Если правило нельзя выразить этими полями, заполни не_применить короткой причиной и оставь остальные поля пустыми. Иначе не_применить — пустая строка.`,
        `Блоки: ${titles.join(', ')}.`,
      ].join(' '),
      user: text.trim(),
      schemaName: 'morning_rule',
      schema: answerSchema,
    }));
    return shapeFromAnswer(result.data);
  } catch {
    return { shape: null, note: MORNING_UNUSABLE };
  }
}
