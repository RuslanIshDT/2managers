// Единственный модуль вызова модели (S1, N2). Модель — настройка LLM_MODEL.
// Каждый вызов пишется в журнал: задание, модель, токены, время, цена.
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type JsonSchema = Record<string, unknown>;

export interface LlmCall {
  purpose: string;
  system: string;
  user: string;
  schemaName: string;
  schema: JsonSchema;
}

export interface LlmResult<T> {
  data: T;
  model: string;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';

export function llmConfig() {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('LLM_BASE_URL и LLM_API_KEY не заданы (.env)');
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model: process.env.LLM_MODEL || DEFAULT_MODEL,
    logPath: process.env.LLM_LOG || '_not_in_git/llm-calls.jsonl',
  };
}

export async function callJson<T>(call: LlmCall, attempt = 1): Promise<LlmResult<T>> {
  const cfg = llmConfig();
  const started = Date.now();
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: 'system', content: call.system },
        { role: 'user', content: call.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: call.schemaName, strict: true, schema: call.schema },
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Date.now() - started;
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return callJson<T>(call, attempt + 1);
    }
    throw new Error(`Модель ответила ${res.status}: ${text}`);
  }
  const body = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const usage = body.usage ?? {};
  const result = {
    model: body.model ?? cfg.model,
    ms,
    tokensIn: usage.prompt_tokens ?? 0,
    tokensOut: usage.completion_tokens ?? 0,
    costUsd: typeof usage.cost === 'number' ? usage.cost : null,
  };
  await log(cfg.logPath, call.purpose, result);

  const content = body.choices?.[0]?.message?.content ?? '';
  try {
    return { ...result, data: JSON.parse(stripFence(content)) as T };
  } catch {
    if (attempt < 3) return callJson<T>(call, attempt + 1);
    throw new Error(`Ответ модели — не JSON: ${content.slice(0, 200)}`);
  }
}

function stripFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}

async function log(path: string, purpose: string, r: Omit<LlmResult<unknown>, 'data'>) {
  await mkdir(dirname(path), { recursive: true });
  const line = {
    at: new Date().toISOString(),
    purpose,
    model: r.model,
    kind: 'json',
    ms: r.ms,
    in: r.tokensIn,
    out: r.tokensOut,
    cost_usd: r.costUsd,
  };
  await appendFile(path, JSON.stringify(line) + '\n');
}
