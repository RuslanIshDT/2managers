// Единственный модуль вызова модели (S1, L1). Адрес провайдера — LLM_BASE_URL.
// Каждый вызов пишется в журнал: задание, модель, токены, время, цена.
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { APP_MARK, sendTrace } from './langfuse.ts';

export type JsonSchema = Record<string, unknown>;

export interface LlmScope {
  agent: string;
  leaderId: string;
  operationId: string;
  title: string;
}

const scopes = new AsyncLocalStorage<LlmScope>();

export function withLlmScope<T>(scope: LlmScope, run: () => Promise<T>): Promise<T> {
  return scopes.run(scope, run);
}

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

export interface LlmMeta {
  agent: string;
  leaderId: string;
  operationId: string;
  title: string;
  traceId: string;
  priced: boolean;
}

type ModelResolver = (agent: string, leaderId: string) => Promise<string>;
let resolveModel: ModelResolver = async () => llmConfig().model;

export function setModelResolver(fn: ModelResolver) {
  resolveModel = fn;
}

export function costFromUsage(usage: { cost?: unknown } | undefined): number | null {
  const value = usage?.cost;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';

export function providerHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': APP_MARK,
    'X-Title': APP_MARK,
  };
}

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
  const scope = scopes.getStore();
  const model = await chosenModel(scope, cfg.model);
  const started = Date.now();
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: providerHeaders(cfg.apiKey),
    body: JSON.stringify({
      model,
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
  const content = body.choices?.[0]?.message?.content ?? '';
  const result = {
    model: body.model ?? model,
    ms,
    tokensIn: usage.prompt_tokens ?? 0,
    tokensOut: usage.completion_tokens ?? 0,
    costUsd: costFromUsage(usage),
  };
  const traceId = await sendTrace({
    agent: scope?.agent ?? '',
    leaderId: scope?.leaderId ?? '',
    operationId: scope?.operationId ?? call.purpose,
    title: scope?.title ?? call.purpose,
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: result.costUsd,
    ms,
    input: `${call.system}\n\n${call.user}`,
    output: content,
  });
  await log(cfg.logPath, call.purpose, result, {
    agent: scope?.agent ?? '',
    leaderId: scope?.leaderId ?? '',
    operationId: scope?.operationId ?? call.purpose,
    title: scope?.title ?? call.purpose,
    traceId,
    priced: result.costUsd !== null,
  });
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

export type LlmSink = (purpose: string, r: Omit<LlmResult<unknown>, 'data'>, meta?: LlmMeta) => Promise<void>;

let sink: LlmSink | null = null;

export function setLlmSink(fn: LlmSink | null) {
  sink = fn;
}

async function chosenModel(scope: LlmScope | undefined, fallback: string): Promise<string> {
  if (!scope?.agent || !scope.leaderId) return fallback;
  try {
    const model = (await resolveModel(scope.agent, scope.leaderId)).trim();
    return model || fallback;
  } catch {
    return fallback;
  }
}

async function log(path: string, purpose: string, r: Omit<LlmResult<unknown>, 'data'>, meta: LlmMeta) {
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
    agent: meta.agent,
  };
  await appendFile(path, JSON.stringify(line) + '\n');
  if (sink) {
    try {
      await sink(purpose, r, meta);
    } catch (err) {
      console.error('Журнал модели в базе не записался', err);
    }
  }
}
