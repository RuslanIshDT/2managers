// Запись задач и одной встречи протокола. Повтор по тому же ключу не создаёт вторую задачу.
import { eventFile, issueDraft, taskUnique } from '../agents/materials.ts';
import { calendarConfig, ensureStandCalendar, putEvent } from './calendar.ts';
import { assigneeLogin, createIssue, listTrackerUsers, trackerConfig, type TrackerUser } from './tracker.ts';

export async function publishApproved(
  leaderId: string,
  rows: { externalId: string; title: string; ownerName: string; ownerEmail?: string; dueOn: string; status: string; source: string; description?: string }[],
  event: { uid: string; ics: string } | null,
): Promise<string> {
  let created = 0;
  let existed = 0;
  let assigned = 0;
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
      if (result === 'created') created += 1;
      else existed += 1;
      if (login && result === 'created') assigned += 1;
    }
  }
  if (event && calendarConfig()) {
    const href = await ensureStandCalendar();
    await putEvent(href, eventFile(event.uid), event.ics);
  }
  const assignment = trackerConfig() && named ? ` Назначено исполнителю: ${assigned} из ${named}.` : '';
  return `В Трекере новых задач ${created}, уже были ${existed}.${assignment}`;
}
