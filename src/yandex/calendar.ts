// Яндекс Календарь по CalDAV. Пароль — отдельный пароль приложения, не пароль почты.
import { Buffer } from 'node:buffer';
import { readEvents } from '../agents/materials.ts';

export interface CalendarConfig {
  user: string;
  password: string;
}

export function calendarConfig(): CalendarConfig | null {
  const user = process.env.YANDEX_MAIL_USER?.trim();
  const password = process.env.YANDEX_CALENDAR_PASSWORD?.trim();
  if (!user || !password) return null;
  return { user, password };
}

export async function ensureStandCalendar(): Promise<string> {
  const cfg = calendarConfig();
  if (!cfg) throw new Error('Календарь не настроен');
  const home = `/calendars/${encodeURIComponent(cfg.user)}/`;
  let stands = (await propfind(home)).filter((row) => row.name === 'Стенд' && row.href.replace(/\/$/, '') !== home.replace(/\/$/, ''));
  if (stands.length === 0) {
    const response = await caldav('MKCALENDAR', `${home}ecompras/`, calendarBody());
    if (response.status !== 201 && response.status !== 200 && response.status !== 405) {
      throw new Error(`Календарь не создан (${response.status})`);
    }
    stands = (await propfind(home)).filter((row) => row.name === 'Стенд');
  }
  const chosen = stands[0];
  if (!chosen) throw new Error('Календарь «Стенд» не появился');
  for (const extra of stands.slice(1)) {
    const events = await listStandEvents(extra.href.endsWith('/') ? extra.href : `${extra.href}/`);
    if (events.length === 0) await caldav('DELETE', extra.href.endsWith('/') ? extra.href : `${extra.href}/`);
  }
  return chosen.href.endsWith('/') ? chosen.href : `${chosen.href}/`;
}

export async function putEvent(calendarHref: string, file: string, ics: string): Promise<void> {
  const href = `${calendarHref.replace(/\/$/, '')}/${file}`;
  const response = await caldav('PUT', href, ics, 'text/calendar; charset=utf-8');
  if (response.status !== 201 && response.status !== 204 && response.status !== 200) {
    throw new Error(`Встреча не записана (${response.status})`);
  }
}

// Яндекс хранит событие под своим адресом (по UID), а не под именем файла из PUT, поэтому удаляем по UID.
export async function eventHrefs(calendarHref: string): Promise<Map<string, string>> {
  const response = await caldav('REPORT', calendarHref, reportBody(), 'application/xml');
  if (!response.ok) throw new Error(`Календарь ответил ${response.status}`);
  return hrefsByUid(await response.text());
}

export function hrefsByUid(xml: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const part of xml.split(/<[^>]*response[ >]/i).slice(1)) {
    const href = /<[^>]*href[^>]*>([^<]+)/i.exec(part)?.[1]?.trim() ?? '';
    const uid = /^UID:(.*)$/m.exec(part.replace(/\r?\n[ \t]/g, ''))?.[1]?.trim() ?? '';
    if (href && uid) found.set(uid.replace(/\\([,;\\])/g, '$1'), href);
  }
  return found;
}

export async function deleteByUid(hrefs: Map<string, string>, uid: string): Promise<boolean> {
  const href = hrefs.get(uid);
  if (!href) return false;
  const response = await caldav('DELETE', href);
  if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
    throw new Error(`Встреча не удалена (${response.status})`);
  }
  hrefs.delete(uid);
  return true;
}

export async function listStandEvents(calendarHref: string): Promise<{ uid: string; summary: string; start: string }[]> {
  const response = await caldav('REPORT', calendarHref, reportBody(), 'application/xml');
  if (!response.ok) throw new Error(`Календарь ответил ${response.status}`);
  return readEvents(await response.text());
}

async function propfind(href: string): Promise<{ href: string; name: string }[]> {
  const response = await caldav('PROPFIND', href, propfindBody());
  if (!response.ok && response.status !== 207) throw new Error(`Календарь ответил ${response.status}`);
  const xml = await response.text();
  const parts = xml.split(/<[^>]*response[ >]/i).slice(1);
  return parts
    .map((part) => ({
      href: decodeURIComponent(/<[^>]*href[^>]*>([^<]+)/i.exec(part)?.[1] ?? ''),
      name: (/<[^>]*displayname[^>]*>([^<]*)</i.exec(part)?.[1] ?? '').trim(),
    }))
    .filter((row) => row.href);
}

async function caldav(method: string, href: string, body = '', contentType = 'application/xml'): Promise<Response> {
  const cfg = calendarConfig();
  if (!cfg) throw new Error('Календарь не настроен');
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`,
    Depth: '1',
  };
  if (body) headers['Content-Type'] = contentType;
  return fetch(`https://caldav.yandex.ru${href}`, {
    method,
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(30_000),
  });
}

function propfindBody(): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`;
}

function calendarBody(): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set><d:prop><d:displayname>Стенд</d:displayname></d:prop></d:set>
</c:mkcalendar>`;
}

function reportBody(): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter>
</c:calendar-query>`;
}
