// Трассировка вызова. Сбой Langfuse не мешает разбору: функция возвращает пустую строку.
export const APP_MARK = 'ecompras';
export interface TraceInput {
  agent: string;
  leaderId: string;
  operationId: string;
  title: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  ms: number;
  input: string;
  output: string;
}

export function langfuseConfig() {
  const host = process.env.LANGFUSE_HOST?.replace(/\/+$/, '') ?? '';
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? '';
  const secretKey = process.env.LANGFUSE_SECRET_KEY ?? '';
  const project = process.env.LANGFUSE_PROJECT_URL?.replace(/\/+$/, '') ?? '';
  if (!host || !publicKey || !secretKey) return null;
  return { host, publicKey, secretKey, project };
}

// existingTrace — следующий шаг той же операции: поколение дописывается в её след.
export async function sendTrace(input: TraceInput, post: typeof fetch = fetch, existingTrace = ''): Promise<string> {
  const cfg = langfuseConfig();
  if (!cfg) return '';
  const traceId = existingTrace || crypto.randomUUID();
  const now = new Date();
  const started = new Date(now.getTime() - input.ms).toISOString();
  const body = {
    batch: [
      {
        id: crypto.randomUUID(),
        type: 'trace-create',
        timestamp: now.toISOString(),
        body: {
          id: traceId,
          name: input.title.slice(0, 200),
          userId: input.leaderId,
          environment: APP_MARK,
          tags: [APP_MARK],
          metadata: { agent: input.agent, operation: input.operationId },
        },
      },
      {
        id: crypto.randomUUID(),
        type: 'generation-create',
        timestamp: now.toISOString(),
        body: {
          id: crypto.randomUUID(),
          traceId,
          name: input.agent,
          model: input.model,
          startTime: started,
          endTime: now.toISOString(),
          environment: APP_MARK,
          input: input.input.slice(0, 100_000),
          output: input.output.slice(0, 100_000),
          usage: {
            input: input.tokensIn,
            output: input.tokensOut,
            total: input.tokensIn + input.tokensOut,
            unit: 'TOKENS',
            totalCost: input.costUsd,
          },
          ...(input.costUsd === null ? {} : { costDetails: { total: input.costUsd } }),
          metadata: { agent: input.agent, operation: input.operationId },
        },
      },
    ],
  };
  try {
    const res = await post(`${cfg.host}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return '';
    return traceId;
  } catch {
    return '';
  }
}
