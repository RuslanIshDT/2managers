// Модель агента из настроек и запись каждого вызова в llm_calls и operations. Общая для сервера и скриптов.
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { agentModels, llmCalls } from './schema.ts';
import { setLlmSink, setModelResolver } from '../llm.ts';

export function installLlmRecording(db: Db) {
  setModelResolver(async (agent, leaderId) => {
    const rows = await db
      .select({ model: agentModels.model })
      .from(agentModels)
      .where(and(eq(agentModels.leaderId, leaderId), eq(agentModels.agent, agent)))
      .limit(1);
    return rows[0]?.model ?? '';
  });

  setLlmSink(async (purpose, result, meta) => {
    await db.insert(llmCalls).values({
      at: new Date(),
      purpose,
      model: result.model,
      ms: result.ms,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd === null ? null : String(result.costUsd),
      leaderId: meta?.leaderId || null,
      agent: meta?.agent ?? '',
      operationId: meta?.operationId ?? '',
      traceId: meta?.traceId ?? '',
    });
    if (!meta?.operationId) return;
    const priced = meta.priced;
    const cost = result.costUsd === null ? null : String(result.costUsd);
    await db.execute(sql`
      INSERT INTO operations (id, leader_id, agent, title, model, calls, tokens_in, tokens_out, ms, cost_usd, priced, trace_id, created_at)
      VALUES (${meta.operationId}, ${meta.leaderId}, ${meta.agent}, ${meta.title}, ${result.model}, 1, ${result.tokensIn}, ${result.tokensOut}, ${result.ms}, ${cost}, ${priced}, ${meta.traceId}, now())
      ON CONFLICT (id) DO UPDATE SET
        calls = operations.calls + 1,
        tokens_in = operations.tokens_in + EXCLUDED.tokens_in,
        tokens_out = operations.tokens_out + EXCLUDED.tokens_out,
        ms = operations.ms + EXCLUDED.ms,
        model = CASE WHEN operations.model = EXCLUDED.model THEN operations.model ELSE operations.model || ', ' || EXCLUDED.model END,
        priced = operations.priced AND EXCLUDED.priced,
        cost_usd = CASE WHEN operations.priced AND EXCLUDED.priced THEN COALESCE(operations.cost_usd, 0) + COALESCE(EXCLUDED.cost_usd, 0) ELSE NULL END,
        trace_id = CASE WHEN EXCLUDED.trace_id <> '' THEN EXCLUDED.trace_id ELSE operations.trace_id END
    `);
  });
}
