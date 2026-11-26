// Задание аудитора потока. mode=from-json пересобирает общий пример и модель не вызывает.
// mode=model — прогон за конкретного руководителя, пишет в flow_reports и общий файл не трогает.
import { readFile, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import PgBoss from 'pg-boss';
import type { Db } from '../db/client.ts';
import { agentRuns, flowReports } from '../db/schema.ts';
import { loadSynthetic } from '../data/synthetic.ts';
import { withLlmScope } from '../llm.ts';
import type { AuditedItem } from '../agents/flow-audit.ts';
import { summarize, toMarkdown, view } from '../agents/flow-audit-report.ts';

export const FLOW_AUDIT_QUEUE = 'flow-audit';

export interface FlowAuditJob {
  mode: 'from-json' | 'model';
  leaderId?: string;
}

export interface AuditQuote {
  calls: number;
  costUsd: number;
}

export function quoteOf(summary: { calls?: number; costUsd?: number }): AuditQuote {
  const calls = summary.calls;
  const costUsd = summary.costUsd;
  if (typeof calls !== 'number' || typeof costUsd !== 'number' || calls < 1 || costUsd < 0) {
    throw new Error('В примере аудита нет цены прогона');
  }
  return { calls, costUsd };
}

export function assertAuditConfirm(mode: 'from-json' | 'model', confirm: boolean | undefined): void {
  if (mode === 'model' && confirm !== true) throw new Error('Нужно подтверждение цены');
}

export async function exampleQuote(path = 'reports/flow-audit.json'): Promise<AuditQuote> {
  const prev = JSON.parse(await readFile(path, 'utf8')) as { summary?: { calls?: number; costUsd?: number } };
  return quoteOf(prev.summary ?? {});
}

export async function rebuildFlowAuditFromJson() {
  const prev = JSON.parse(await readFile('reports/flow-audit.json', 'utf8')) as { at: string; items: AuditedItem[] };
  const data = await loadSynthetic();
  const summary = summarize(data, prev.items, prev.at);
  const viewItems = view(prev.items);
  await writeFile('reports/flow-audit.json', JSON.stringify({ at: prev.at, summary, view: viewItems, items: prev.items }, null, 2));
  await writeFile('reports/flow-audit.md', toMarkdown(summary, viewItems, data, prev.items));
  return { at: prev.at, freedHours: summary.freedHours, flowHours: summary.flowHours };
}

export async function startBoss(connectionString: string, db: Db) {
  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  boss.on('error', (err) => {
    console.error('pg-boss', err);
  });
  await boss.start();
  await boss.createQueue(FLOW_AUDIT_QUEUE);
  await boss.work<FlowAuditJob>(FLOW_AUDIT_QUEUE, async (jobs) => {
    for (const job of jobs) await runFlowAuditJob(db, job.id, job.data);
  });
  return boss;
}

async function runFlowAuditJob(db: Db, id: string, data: FlowAuditJob) {
  const started = new Date();
  await db.insert(agentRuns).values({
    id,
    leaderId: data.leaderId ?? null,
    agent: 'flow-audit',
    reason: data.mode,
    startedAt: started,
    status: 'running',
  });
  try {
    if (data.mode === 'model') {
      if (!data.leaderId) throw new Error('Прогон моделью записывается только за руководителем');
      const { runAudit, buildItems } = await import('../agents/flow-audit.ts');
      const synthetic = await loadSynthetic();
      const items = buildItems(synthetic);
      const audited = await withLlmScope(
        { agent: 'k5', leaderId: data.leaderId, operationId: id, title: 'Аудит недели' },
        () => runAudit(synthetic, items),
      );
      const at = new Date().toISOString();
      const summary = summarize(synthetic, audited, at);
      const viewItems = view(audited);
      const report = { at, summary, view: viewItems, items: audited, source: 'leader' as const };
      await db
        .insert(flowReports)
        .values({
          leaderId: data.leaderId,
          report,
          calls: summary.calls,
          costUsd: String(summary.costUsd),
          createdAt: new Date(),
        })
        .onConflictDoUpdate({
          target: flowReports.leaderId,
          set: { report, calls: summary.calls, costUsd: String(summary.costUsd), createdAt: new Date() },
        });
    } else {
      await rebuildFlowAuditFromJson();
    }
    await db.update(agentRuns).set({ status: 'done', finishedAt: new Date() }).where(eq(agentRuns.id, id));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await db.update(agentRuns).set({ status: 'failed', finishedAt: new Date(), detail }).where(eq(agentRuns.id, id));
    throw err;
  }
}
