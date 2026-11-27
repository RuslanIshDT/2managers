// Журнал решений руководителя: письма и протоколы пишутся одним способом.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { leaderActs } from '../db/schema.ts';

export async function writeLeaderAct(
  db: Db,
  input: { leaderId: string; subject: string; action: string; result: string; original: string; approved: string; auto: boolean; refId: string },
) {
  await db.insert(leaderActs).values({
    id: randomUUID(),
    leaderId: input.leaderId,
    subject: input.subject.slice(0, 300),
    at: new Date(),
    action: input.action,
    result: input.result.slice(0, 500),
    originalDraft: input.original.slice(0, 4000),
    approvedText: input.approved.slice(0, 4000),
    auto: input.auto,
    refId: input.refId,
  });
}
