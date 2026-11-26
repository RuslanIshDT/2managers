// Итоги стоимости из наших операций. Часовой пояс — Москва.
import { MODEL_AGENTS, priceWords } from './models.ts';

export interface OperationRow {
  id: string;
  leaderId: string;
  agent: string;
  title: string;
  model: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  costUsd: number | null;
  priced: boolean;
  traceId: string;
  createdAt: string;
}

export interface CostView {
  today: string;
  week: string;
  month: string;
  byAgent: { agent: string; name: string; operations: number; total: string; average: string }[];
  byModel: { model: string; operations: number; total: string }[];
  recent: { id: string; at: string; agent: string; title: string; model: string; calls: number; price: string; trace: string }[];
}

export function costView(rows: OperationRow[], now: Date, traceBase: string): CostView {
  const day = moscowStart(now, 'day').getTime();
  const week = moscowStart(now, 'week').getTime();
  const month = moscowStart(now, 'month').getTime();
  const mine = rows;
  return {
    today: sumWords(mine.filter((row) => Date.parse(row.createdAt) >= day)),
    week: sumWords(mine.filter((row) => Date.parse(row.createdAt) >= week)),
    month: sumWords(mine.filter((row) => Date.parse(row.createdAt) >= month)),
    byAgent: MODEL_AGENTS.map((agent) => {
      const group = mine.filter((row) => row.agent === agent.id);
      return {
        agent: agent.id,
        name: agent.name,
        operations: group.length,
        total: sumWords(group),
        average: averageWords(group, agent.unit),
      };
    }),
    byModel: byModel(mine),
    recent: [...mine]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map((row) => ({
        id: row.id,
        at: row.createdAt,
        agent: MODEL_AGENTS.find((agent) => agent.id === row.agent)?.name ?? row.agent,
        title: row.title,
        model: row.model,
        calls: row.calls,
        price: row.priced ? priceWords(row.costUsd) : 'нет цены',
        trace: row.traceId && traceBase ? `${traceBase.replace(/\/+$/, '')}/traces/${row.traceId}` : '',
      })),
  };
}

function sumWords(rows: OperationRow[]): string {
  if (!rows.length) return priceWords(0);
  if (rows.some((row) => !row.priced || row.costUsd === null)) return 'нет цены';
  return priceWords(rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0));
}

function averageWords(rows: OperationRow[], unit: string): string {
  const priced = rows.filter((row) => row.priced && row.costUsd !== null);
  if (!priced.length) return `${unit} — нет цены`;
  const avg = priced.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) / priced.length;
  return `${unit} — ${priceWords(avg)}`;
}

function byModel(rows: OperationRow[]): { model: string; operations: number; total: string }[] {
  const groups = new Map<string, OperationRow[]>();
  for (const row of rows) {
    const key = row.model || 'модель не названа';
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([model, group]) => ({ model, operations: group.length, total: sumWords(group) }));
}

export function moscowStart(now: Date, unit: 'day' | 'week' | 'month'): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const startDay = unit === 'month' ? 1 : unit === 'week' ? day - ((weekday + 6) % 7) : day;
  return new Date(Date.UTC(year, month - 1, startDay, -3, 0, 0));
}
