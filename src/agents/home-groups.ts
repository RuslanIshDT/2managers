// Раскладка главной. Порог «пять, потом раскрытие» — константа интерфейса, не данные руководителя.

export const DECISION_PREVIEW = 5;

export interface GroupItem {
  kind: string;
  today?: boolean;
}

export interface WorkGroup<T> {
  id: 'today' | 'waiting' | 'offers';
  title: string;
  items: T[];
}

export function workGroups<T extends GroupItem>(items: T[]): WorkGroup<T>[] {
  const today = items
    .filter((item) => item.kind === 'task' || item.kind === 'talk' || item.today)
    .sort((a, b) => (a.kind === 'talk' ? 1 : 0) - (b.kind === 'talk' ? 1 : 0));
  const groups: WorkGroup<T>[] = [
    { id: 'today', title: 'Сегодня', items: today },
    { id: 'waiting', title: 'Ждёт вашего решения', items: items.filter((item) => item.kind === 'decision' && !item.today) },
    {
      id: 'offers',
      title: 'Предложения помощника',
      items: items.filter((item) => item.kind === 'rules' || item.kind === 'right' || item.kind === 'series'),
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

export function splitPreview<T>(items: T[], limit = DECISION_PREVIEW): { head: T[]; more: number } {
  if (items.length <= limit) return { head: items, more: 0 };
  return { head: items.slice(0, limit), more: items.length - limit };
}
