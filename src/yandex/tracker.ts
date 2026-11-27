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

export async function createIssue(draft: { unique: string; summary: string; description: string; deadline: string | null }): Promise<'created' | 'exists'> {
  const cfg = trackerConfig();
  if (!cfg) throw new Error('Трекер не настроен');
  const body: Record<string, string> = {
    queue: cfg.queue,
    summary: draft.summary,
    description: draft.description,
    unique: draft.unique,
  };
  if (draft.deadline) body.deadline = draft.deadline;
  const response = await call('/v2/issues', { method: 'POST', body: JSON.stringify(body) });
  if (response.status === 409) return 'exists';
  if (response.status === 422) {
    const text = await response.text();
    if (/unique/i.test(text)) return 'exists';
    throw new Error(`Трекер не принял задачу (${response.status})`);
  }
  if (!response.ok) throw new Error(`Трекер ответил ${response.status}`);
  return 'created';
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

async function call(path: string, init: { method: string; body: string }): Promise<Response> {
  const first = await send(path, init, orgHeader);
  if (first.ok || first.status === 409 || orgHeader === 'X-Cloud-Org-ID') return first;
  const text = await first.clone().text();
  if (first.status !== 401 && first.status !== 403 && first.status !== 422) return first;
  if (!/org|организац|cloud/i.test(text)) return first;
  orgHeader = 'X-Cloud-Org-ID';
  return send(path, init, orgHeader);
}

async function send(path: string, init: { method: string; body: string }, header: 'X-Org-ID' | 'X-Cloud-Org-ID'): Promise<Response> {
  const cfg = trackerConfig();
  if (!cfg) throw new Error('Трекер не настроен');
  return fetch(`https://api.tracker.yandex.net${path}`, {
    method: init.method,
    headers: {
      Authorization: `OAuth ${cfg.token}`,
      [header]: cfg.org,
      'Content-Type': 'application/json',
    },
    body: init.body,
    signal: AbortSignal.timeout(20_000),
  });
}
