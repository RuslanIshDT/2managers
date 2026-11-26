// Задание аудитора потока. mode=from-json пересобирает отчёт из уже посчитанного JSON
// и модель не вызывает. mode=model — полный прогон, его ставит только явный вызов, не кнопка на стенде.
import { readFile, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import PgBoss from 'pg-boss';
import type { Db } from '../db/client.ts';
import { agentRuns } from '../db/schema.ts';
import { loadSynthetic } from '../data/synthetic.ts';
import type { AuditedItem } from '../agents/flow-audit.ts';
import { summarize, toMarkdown, view } from '../agents/flow-audit-report.ts';

export const FLOW_AUDIT_QUEUE = 'flow-audit';

export interface FlowAuditJob {
  mode: 'from-json' | 'model';
  leaderId?: string;
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
      const { runAudit, buildItems } = await import('../agents/flow-audit.ts');
      const synthetic = await loadSynthetic();
      const items = buildItems(synthetic);
      const audited = await runAudit(synthetic, items);
      const at = new Date().toISOString();
      const summary = summarize(synthetic, audited, at);
      const viewItems = view(audited);
      const { writeFile: write, mkdir } = await import('node:fs/promises');
      await mkdir('reports', { recursive: true });
      await write('reports/flow-audit.json', JSON.stringify({ at, summary, view: viewItems, items: audited }, null, 2));
      await write('reports/flow-audit.md', toMarkdown(summary, viewItems, synthetic, audited));
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
