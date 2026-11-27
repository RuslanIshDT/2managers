// Запись задач и одной встречи протокола. Повтор по тому же ключу не создаёт вторую задачу.
import { eventFile, issueDraft, taskUnique } from '../agents/materials.ts';
import { calendarConfig, ensureStandCalendar, putEvent } from './calendar.ts';
import { createIssue, trackerConfig } from './tracker.ts';

export async function publishApproved(
  leaderId: string,
  rows: { externalId: string; title: string; ownerName: string; dueOn: string; status: string; source: string; description?: string }[],
  event: { uid: string; ics: string } | null,
): Promise<string> {
  let created = 0;
  let existed = 0;
  if (trackerConfig()) {
    for (const task of rows) {
      const draft = issueDraft(task, []);
      const result = await createIssue({ unique: taskUnique(leaderId, task.externalId), ...draft, description: task.description || draft.description });
      if (result === 'created') created += 1;
      else existed += 1;
    }
  }
  if (event && calendarConfig()) {
    const href = await ensureStandCalendar();
    await putEvent(href, eventFile(event.uid), event.ics);
  }
  return `В Трекере новых задач ${created}, уже были ${existed}.`;
}
