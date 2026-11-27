// Яндекс Трекер. Без токена, организации и очереди модуль сообщает «не настроен» и ничего не создаёт.

export interface TrackerConfig {
  token: string;
  org: string;
  queue: string;
}

export interface TrackerIssue {
  key: string;
  summary: string;
  deadline: string;
  unique: string;
}

export function trackerConfig(): TrackerConfig | null {
  const token = process.env.YANDEX_TRACKER_TOKEN?.trim();
  const org = process.env.YANDEX_TRACKER_ORG?.trim();
  const queue = process.env.YANDEX_TRACKER_QUEUE?.trim();
  if (!token || !org || !queue) return null;
  return { token, org, queue };
}

export interface TrackerUser {
  login: string;
  display: string;
  email: string;
}

function sameText(left: string, right: string): boolean {
  const norm = (value: string) => value.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  const a = norm(left);
  return a !== '' && a === norm(right);
}

// Логин Трекера, если пользователь организации совпал с человеком по имени или адресу. Иначе пусто: задача остаётся без поля исполнителя.
export function assigneeLogin(ownerName: string, users: TrackerUser[], email = ''): string {
  if (!ownerName.trim() || ownerName.trim() === 'не назван') return '';
  const byName = users.find((user) => sameText(user.display, ownerName));
  if (byName) return byName.login;
  const byEmail = email.trim() ? users.find((user) => sameText(user.email, email)) : undefined;
  return byEmail?.login ?? '';
}

export async function listTrackerUsers(): Promise<TrackerUser[]> {
  const cfg = trackerConfig();
  if (!cfg) return [];
  const found: TrackerUser[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const response = await call(`/v2/users?perPage=100&page=${page}`, { method: 'GET' });
    if (!response.ok) throw new Error(`Трекер не отдал пользователей (${response.status})`);
    const rows = (await response.json()) as { login?: string; display?: string; email?: string; dismissed?: boolean }[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      if (row.dismissed || !row.login) continue;
      found.push({ login: row.login, display: row.display ?? '', email: row.email ?? '' });
    }
    if (rows.length < 100) break;
  }
  return found;
}

export type IssueResult = 'created' | 'created-unassigned' | 'exists';

// Отказ 422: задача уже есть, Трекер не принял исполнителя, или другая ошибка полей.
export function issueRejection(body: string): 'unique' | 'assignee' | 'other' {
  let errors: Record<string, unknown> | null = null;
  let messages = '';
  try {
    const data = JSON.parse(body) as { errors?: Record<string, unknown>; errorMessages?: unknown };
    if (data.errors && typeof data.errors === 'object') errors = data.errors;
    if (Array.isArray(data.errorMessages)) messages = data.errorMessages.map((item) => String(item)).join(' ');
  } catch {
    messages = body;
  }
  if (errors && Object.keys(errors).some((key) => /assignee|исполнител/i.test(key))) return 'assignee';
  const errorText = errors ? Object.entries(errors).map(([key, value]) => `${key} ${String(value)}`).join(' ') : '';
  const all = `${errorText} ${messages}`.trim();
  if (/unique/i.test(all) || (!errors && /unique/i.test(body))) return 'unique';
  if (/assignee|исполнител/i.test(all)) return 'assignee';
  return 'other';
}

export async function createIssue(draft: {
  unique: string;
  summary: string;
  description: string;
  deadline: string | null;
  assignee?: string;
}): Promise<IssueResult> {
  const cfg = trackerConfig();
  if (!cfg) throw new Error('Трекер не настроен');
  const body: Record<string, string> = {
    queue: cfg.queue,
    summary: draft.summary,
    description: draft.description,
    unique: draft.unique,
  };
  if (draft.deadline) body.deadline = draft.deadline;
  if (draft.assignee) body.assignee = draft.assignee;
  let droppedAssignee = false;
  let response = await call('/v2/issues', { method: 'POST', body: JSON.stringify(body) });
  if (response.status === 422 && draft.assignee) {
    const reason = issueRejection(await response.text());
    if (reason === 'unique') return 'exists';
    if (reason !== 'assignee') throw new Error(`Трекер не принял задачу (${response.status})`);
    delete body.assignee;
    droppedAssignee = true;
    response = await call('/v2/issues', { method: 'POST', body: JSON.stringify(body) });
  }
  if (response.status === 409) return 'exists';
  if (response.status === 422) {
    const text = await response.text();
    if (issueRejection(text) === 'unique') return 'exists';
    throw new Error(`Трекер не принял задачу (${response.status})`);
  }
  if (!response.ok) throw new Error(`Трекер ответил ${response.status}`);
  return droppedAssignee ? 'created-unassigned' : 'created';
}

export async function listOurIssues(): Promise<TrackerIssue[]> {
  const cfg = trackerConfig();
  if (!cfg) return [];
  const found: TrackerIssue[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const response = await call(`/v2/issues/_search?perPage=100&page=${page}`, {
      method: 'POST',
      body: JSON.stringify({ filter: { queue: cfg.queue } }),
    });
    if (!response.ok) throw new Error(`Трекер ответил ${response.status}`);
    const rows = (await response.json()) as { key?: string; summary?: string; deadline?: string; unique?: string }[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      if (typeof row.unique !== 'string' || !row.unique.startsWith('ecompras-')) continue;
      found.push({ key: row.key ?? '', summary: row.summary ?? '', deadline: row.deadline ?? '', unique: row.unique });
    }
    if (rows.length < 100) break;
  }
  return found;
}

export interface QueueIssue {
  key: string;
  summary: string;
  description: string;
  deadline: string;
  unique: string;
  status: string;
  open: boolean;
}

// Все задачи очереди стенда — и выложенные помощником, и поставленные руками. Закрытые и отменённые помечены open = false.
export async function listQueueIssues(): Promise<QueueIssue[]> {
  const cfg = trackerConfig();
  if (!cfg) return [];
  const found: QueueIssue[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const response = await call(`/v2/issues/_search?perPage=100&page=${page}`, {
      method: 'POST',
      body: JSON.stringify({ filter: { queue: cfg.queue } }),
    });
    if (!response.ok) throw new Error(`Трекер ответил ${response.status}`);
    const rows = (await response.json()) as {
      key?: string;
      summary?: string;
      description?: string;
      deadline?: string;
      unique?: string;
      status?: { key?: string; display?: string };
      statusType?: { key?: string };
    }[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const status = row.status?.key ?? '';
      const type = row.statusType?.key ?? '';
      found.push({
        key: row.key ?? '',
        summary: row.summary ?? '',
        description: row.description ?? '',
        deadline: row.deadline ?? '',
        unique: typeof row.unique === 'string' ? row.unique : '',
        status: row.status?.display ?? status,
        open: !['done', 'cancelled'].includes(type) && !['closed', 'resolved', 'cancelled', 'done'].includes(status),
      });
    }
    if (rows.length < 100) break;
  }
  return found;
}

let orgHeader: 'X-Org-ID' | 'X-Cloud-Org-ID' = 'X-Org-ID';

async function call(path: string, init: { method: string; body?: string }): Promise<Response> {
  const first = await send(path, init, orgHeader);
  if (first.ok || first.status === 409 || orgHeader === 'X-Cloud-Org-ID') return first;
  const text = await first.clone().text();
  if (first.status !== 401 && first.status !== 403 && first.status !== 422) return first;
  if (!/org|организац|cloud/i.test(text)) return first;
  orgHeader = 'X-Cloud-Org-ID';
  return send(path, init, orgHeader);
}

async function send(path: string, init: { method: string; body?: string }, header: 'X-Org-ID' | 'X-Cloud-Org-ID'): Promise<Response> {
  const cfg = trackerConfig();
  if (!cfg) throw new Error('Трекер не настроен');
  return fetch(`https://api.tracker.yandex.net${path}`, {
    method: init.method,
    headers: {
      Authorization: `OAuth ${cfg.token}`,
      [header]: cfg.org,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body,
    signal: AbortSignal.timeout(20_000),
  });
}

export async function commentIssue(key: string, text: string): Promise<void> {
  const response = await call(`/v2/issues/${encodeURIComponent(key)}/comments`, { method: 'POST', body: JSON.stringify({ text }) });
  if (!response.ok) throw new Error(`Трекер не принял комментарий (${response.status})`);
}

// Закрыть или отменить задачу. Переход ищется по идентификатору и по статусу, куда он ведёт.
export async function moveIssue(key: string, goal: 'close' | 'cancel'): Promise<boolean> {
  const response = await call(`/v2/issues/${encodeURIComponent(key)}/transitions`, { method: 'GET' });
  if (!response.ok) throw new Error(`Трекер не отдал переходы (${response.status})`);
  const rows = (await response.json()) as { id?: string; to?: { key?: string } }[];
  const wanted = goal === 'close' ? ['close', 'closed', 'resolve', 'resolved', 'done', 'finish'] : ['cancel', 'cancelled', 'canceled'];
  const found = (Array.isArray(rows) ? rows : []).find((row) => wanted.includes(row.id ?? '') || wanted.includes(row.to?.key ?? ''));
  if (!found?.id) return false;
  // Переход «Готово» в этой очереди требует резолюцию. Отмена — нет.
  const payload = goal === 'close' ? JSON.stringify({ resolution: 'fixed' }) : '{}';
  const done = await call(`/v2/issues/${encodeURIComponent(key)}/transitions/${encodeURIComponent(found.id)}/_execute`, {
    method: 'POST',
    body: payload,
  });
  if (!done.ok && done.status !== 409) throw new Error(`Трекер не сменил статус (${done.status})`);
  return true;
}
