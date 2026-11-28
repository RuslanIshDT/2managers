// Каталог моделей и выбор на агента. Имена моделей приходят из ответа провайдера.
import { llmConfig, providerHeaders } from '../llm.ts';
export const MODEL_AGENTS = [
  { id: 'k2', name: 'Разбор почты (внутр.)', unit: 'разбор одного письма' },
  { id: 'mail_ext', name: 'Разбор почты (внеш.)', unit: 'разбор одного письма' },
  { id: 'k5', name: 'Аудит потока', unit: 'аудит недели' },
  { id: 'k4', name: 'Три дела', unit: 'утреннее сообщение' },
  { id: 'morning', name: 'Правило утра', unit: 'разбор правила' },
  { id: 'one-on-one', name: 'К встрече один на один', unit: 'сводка к встрече' },
  { id: 'audience', name: 'Кому относится пункт', unit: 'разбор пунктов' },
  { id: 'draft-check', name: 'Сверка черновика', unit: 'сверка черновика' },
  { id: 'k15', name: 'Тип встреч', unit: 'разбор серий' },
  { id: 'accuracy', name: 'Точность писем', unit: 'разбор одного письма' },
  { id: 'protocol', name: 'Протокол встречи', unit: 'протокол' },
] as const;

export type AgentId = (typeof MODEL_AGENTS)[number]['id'];

export function isAgentId(value: string): value is AgentId {
  return MODEL_AGENTS.some((agent) => agent.id === value);
}

export interface CatalogModel {
  id: string;
  name: string;
  promptPerMillion: number | null;
  completionPerMillion: number | null;
}

export function modelsWithSchema(rows: unknown): CatalogModel[] {
  if (!Array.isArray(rows)) return [];
  const out: CatalogModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as {
      id?: unknown;
      name?: unknown;
      supported_parameters?: unknown;
      pricing?: { prompt?: unknown; completion?: unknown };
      input_price_per_1m?: unknown;
      output_price_per_1m?: unknown;
    };
    if (typeof item.id !== 'string' || !item.id) continue;
    const params = Array.isArray(item.supported_parameters) ? item.supported_parameters.filter((param) => typeof param === 'string') : [];
    if (!params.includes('structured_outputs')) continue;
    const listed = listedPerMillion(item.input_price_per_1m, item.output_price_per_1m);
    out.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name ? item.name : item.id,
      promptPerMillion: listed.prompt ?? perMillion(item.pricing?.prompt),
      completionPerMillion: listed.completion ?? perMillion(item.pricing?.completion),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return out;
}

function listedPerMillion(input: unknown, output: unknown): { prompt: number | null; completion: number | null } {
  const prompt = money(input);
  const completion = money(output);
  if (prompt === null && completion === null) return { prompt: null, completion: null };
  return { prompt, completion };
}

function money(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function perMillion(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1_000_000 * 1_000_000) / 1_000_000;
}

let cached: { at: number; models: CatalogModel[]; error: string } | null = null;

export async function catalog(): Promise<{ models: CatalogModel[]; error: string }> {
  const freshFor = cached?.error ? 30_000 : 10 * 60_000;
  if (cached && Date.now() - cached.at < freshFor) return { models: cached.models, error: cached.error };
  let models: CatalogModel[] = [];
  let error = '';
  try {
    const cfg = llmConfig();
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: providerHeaders(cfg.apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) error = `Каталог ответил ${res.status}`;
    else {
      const body = (await res.json()) as { data?: unknown };
      const rows = Array.isArray(body) ? body : body.data;
      models = modelsWithSchema(rows);
      if (!models.length) error = 'В каталоге нет моделей, которые отвечают по схеме';
    }
  } catch {
    error = 'Каталог моделей недоступен';
  }
  cached = { at: Date.now(), models, error };
  return { models, error };
}

export function priceWords(value: number | null): string {
  if (value === null) return 'нет цены';
  if (value === 0) return '$0';
  const digits = value < 0.01 ? 4 : value < 10 ? 3 : 2;
  const text = value.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return `$${text}`;
}
