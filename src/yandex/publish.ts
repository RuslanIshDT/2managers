// Запись задач и одной встречи протокола. Повтор по тому же ключу не создаёт вторую задачу.
import { eventFile, issueDraft, taskUnique } from '../agents/materials.ts';
import { calendarConfig, ensureStandCalendar, putEvent } from './calendar.ts';
import { assigneeLogin, createIssue, listTrackerUsers, trackerConfig, type IssueResult, type TrackerUser } from './tracker.ts';

export interface AssignmentTally {
  created: number;
  existed: number;
  assigned: number;
  refused: number;
}

// «Назначено» — только задача, у которой Трекер сохранил исполнителя. Отказ по исполнителю задачу создаёт, но в счёт не входит.
export function tallyIssue(result: IssueResult, hadLogin: boolean, tally: AssignmentTally): void {
  if (result === 'exists') tally.existed += 1;
  else tally.created += 1;
  if (result === 'created' && hadLogin) tally.assigned += 1;
  if (result === 'created-unassigned') tally.refused += 1;
}

export function assignmentLine(named: number, assigned: number, refused: number): string {
  if (named === 0) return '';
  const main = ` Назначено исполнителю: ${assigned} из ${named}.`;
  if (refused === 0) return main;
  return `${main} Без поля исполнителя: ${refused} — Трекер пользователя не принял.`;
}

export async function publishApproved(
  leaderId: string,
  rows: { externalId: string; title: string; ownerName: string; ownerEmail?: string; dueOn: string; status: string; source: string; description?: string }[],
  event: { uid: string; ics: string } | null,
): Promise<string> {
  const tally: AssignmentTally = { created: 0, existed: 0, assigned: 0, refused: 0 };
  const named = rows.filter((task) => task.ownerName && task.ownerName !== 'не назван').length;
  if (trackerConfig()) {
    let users: TrackerUser[] = [];
    try {
      users = await listTrackerUsers();
    } catch (err) {
      console.error('Трекер не отдал пользователей', err instanceof Error ? err.message : err);
    }
    for (const task of rows) {
      const draft = issueDraft(task, []);
      const login = assigneeLogin(task.ownerName, users, task.ownerEmail ?? '');
      const result = await createIssue({
        unique: taskUnique(leaderId, task.externalId),
        ...draft,
        description: task.description || draft.description,
        assignee: login || undefined,
      });
      tallyIssue(result, Boolean(login), tally);
    }
  }
  if (event && calendarConfig()) {
    const href = await ensureStandCalendar();
    await putEvent(href, eventFile(event.uid), event.ics);
  }
  const assignment = trackerConfig() ? assignmentLine(named, tally.assigned, tally.refused) : '';
  return `В Трекере новых задач ${tally.created}, уже были ${tally.existed}.${assignment}`;
}
