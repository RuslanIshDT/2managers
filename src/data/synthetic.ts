// Загрузка синтетики D2 (data/synthetic). Эталонные поля отделены от рабочих:
// агенту отдаются только рабочие, эталон — только для сравнения.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Person {
  id: string;
  name: string;
  position: string;
  role: string;
  reportsTo: string;
  email: string;
}

export interface Email {
  id: string;
  received: string;
  fromName: string;
  fromEmail: string;
  senderRole: string;
  to: string;
  subject: string;
  body: string;
  repeat: boolean;
}

export interface EmailEtalon {
  id: string;
  category: string;
  expectedAction: string;
  reason: string;
}

export interface Meeting {
  uid: string;
  start: string; // 2026-12-07T10:00
  end: string;
  minutes: number;
  summary: string;
  organizer: string;
  attendees: { name: string; email: string }[];
}

export interface MeetingEtalon {
  uid: string;
  category: string;
}

export interface Task {
  id: string;
  task: string;
  owner: string;
  due: string;
  status: string;
  source: string;
}

export interface Synthetic {
  profile: string;
  people: Person[];
  emails: Email[];
  emailEtalon: Map<string, EmailEtalon>;
  meetings: Meeting[];
  meetingEtalon: Map<string, MeetingEtalon>;
  tasks: Task[];
}

export async function loadSynthetic(dir = 'data/synthetic', options?: { profileOptional?: boolean }): Promise<Synthetic> {
  const read = (f: string) => readFile(join(dir, f), 'utf8');
  const profilePromise = read('leader_profile.md').catch((err: unknown) => {
    if (options?.profileOptional) return '';
    throw err;
  });
  const [profile, orgCsv, inboxCsv, ics, tasksCsv] = await Promise.all([
    profilePromise,
    read('org_structure.csv'),
    read('inbox.csv'),
    read('calendar.ics'),
    read('tasks.csv'),
  ]);

  const inbox = parseCsv(inboxCsv);
  const emailByPerson = new Map<string, string>();
  for (const r of inbox) emailByPerson.set(r.from_name, r.from_email);

  const people: Person[] = parseCsv(orgCsv).map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    role: r.role_for_leader,
    reportsTo: r.reports_to,
    email: emailByPerson.get(r.name) ?? `${r.id}@company.example`,
  }));

  const emails: Email[] = inbox.map((r) => ({
    id: r.id,
    received: r.received,
    fromName: r.from_name,
    fromEmail: r.from_email,
    senderRole: r.sender_role,
    to: r.to,
    subject: r.subject,
    body: r.body,
    repeat: r.repeat === 'да',
  }));
  const emailEtalon = new Map(
    inbox.map((r) => [r.id, { id: r.id, category: r.category, expectedAction: r.expected_action, reason: r.reason }]),
  );

  const { meetings, etalon } = parseIcs(ics);
  const tasks = parseCsv(tasksCsv) as unknown as Task[];

  return { profile, people, emails, emailEtalon, meetings, meetingEtalon: etalon, tasks };
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

function parseIcs(text: string): { meetings: Meeting[]; etalon: Map<string, MeetingEtalon> } {
  const lines = text.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
  const meetings: Meeting[] = [];
  const etalon = new Map<string, MeetingEtalon>();
  let cur: Partial<Meeting> & { attendees?: Meeting['attendees']; category?: string } | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = { attendees: [] };
    else if (line === 'END:VEVENT' && cur) {
      const m = cur as Meeting & { category?: string };
      m.minutes = (Date.parse(m.end) - Date.parse(m.start)) / 60000;
      meetings.push({
        uid: m.uid,
        start: m.start,
        end: m.end,
        minutes: m.minutes,
        summary: m.summary,
        organizer: m.organizer,
        attendees: m.attendees,
      });
      etalon.set(m.uid, { uid: m.uid, category: m.category ?? '' });
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(':');
      const key = line.slice(0, idx);
      const value = line.slice(idx + 1);
      const name = key.split(';')[0];
      if (name === 'UID') cur.uid = value;
      else if (name === 'DTSTART') cur.start = icsDate(value);
      else if (name === 'DTEND') cur.end = icsDate(value);
      else if (name === 'SUMMARY') cur.summary = value;
      else if (name === 'CATEGORIES') cur.category = value;
      else if (name === 'ORGANIZER') cur.organizer = value.replace(/^mailto:/i, '');
      else if (name === 'ATTENDEE') {
        const cn = key.match(/CN=([^;:]+)/)?.[1] ?? '';
        cur.attendees!.push({ name: cn, email: value.replace(/^mailto:/i, '') });
      }
    }
  }
  return { meetings, etalon };
}

function icsDate(v: string): string {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : v;
}
