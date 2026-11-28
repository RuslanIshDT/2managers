// Пункт профиля может относиться к адресату, а не к теме письма.
// Кто из оргструктуры подпадает под пункт, называет модель. Код список должностей не хранит.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { confirmationAudiences, leaders, people } from '../db/schema.ts';
import { callJson, withLlmScope, type JsonSchema } from '../llm.ts';
import { confirmationPoints } from './confirm.ts';

export interface OrgMember {
  id: string;
  name: string;
  email: string;
  position: string;
  role: string;
  reportsTo: string;
}

export interface AudiencePerson {
  name: string;
  email: string;
}

export interface PointAudience {
  point: string;
  people: AudiencePerson[];
}

export function orgStamp(members: OrgMember[]): string {
  const body = members
    .map((member) => [member.id, member.name, member.email, member.position, member.role, member.reportsTo].join('\u001f'))
    .sort()
    .join('\n');
  return `${AUDIENCE_ASK}\n${body}`;
}

export function orgText(members: OrgMember[]): string {
  const nameById = new Map(members.map((member) => [member.id, member.name]));
  return members
    .map((member) => {
      const boss = member.reportsTo && member.reportsTo !== '—' ? (nameById.get(member.reportsTo) ?? member.reportsTo) : '—';
      return `${member.name} — ${member.position}, роль: ${member.role}, подчиняется: ${boss}`;
    })
    .join('\n');
}

export function audiencesFromAnswer(data: unknown, points: string[], members: OrgMember[]): PointAudience[] {
  const parsed = z
    .object({
      пункты: z.array(z.object({ пункт: z.string(), люди: z.array(z.string()) })),
    })
    .safeParse(data);
  const rows = parsed.success ? parsed.data.пункты : [];
  return points.map((point) => {
    const row = rows.find((item) => item.пункт.trim().toLowerCase() === point.trim().toLowerCase());
    const people: AudiencePerson[] = [];
    for (const name of row?.люди ?? []) {
      const hits = members.filter((member) => member.name.trim().toLowerCase() === name.trim().toLowerCase());
      for (const hit of hits) {
        if (!people.some((person) => person.email.toLowerCase() === hit.email.toLowerCase())) {
          people.push({ name: hit.name, email: hit.email });
        }
      }
    }
    return { point, people };
  });
}

export function audiencesOf(value: unknown): PointAudience[] {
  if (!Array.isArray(value)) return [];
  const out: PointAudience[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const point = (row as { point?: unknown }).point;
    const people = (row as { people?: unknown }).people;
    if (typeof point !== 'string' || !point) continue;
    const list: AudiencePerson[] = [];
    if (Array.isArray(people)) {
      for (const person of people) {
        if (!person || typeof person !== 'object') continue;
        const name = (person as { name?: unknown }).name;
        const email = (person as { email?: unknown }).email;
        if (typeof name === 'string' && typeof email === 'string' && name && email) list.push({ name, email });
      }
    }
    out.push({ point, people: list });
  }
  return out;
}

export function audienceEmails(audiences: PointAudience[]): Set<string> {
  return new Set(audiences.flatMap((row) => row.people.map((person) => person.email.toLowerCase())));
}

export function personInAudience(
  audiences: PointAudience[],
  person: { name: string; email: string } | null,
): { point: string; name: string } | null {
  if (!person) return null;
  const email = person.email.trim().toLowerCase();
  const name = person.name.trim().toLowerCase();
  for (const row of audiences) {
    const hit = row.people.find((item) => (email && item.email.toLowerCase() === email) || (!email && name && item.name.toLowerCase() === name));
    if (hit) return { point: row.point, name: hit.name };
  }
  return null;
}

// Ответ уходит отправителю, пересылка — названному человеку. И то и другое такому адресату ждёт руководителя.
export function addresseeHold(
  audiences: PointAudience[],
  action: string,
  sender: { name: string; email: string },
  target: { name: string; email: string } | null,
): { point: string; name: string } | null {
  if (action === 'ответить') return personInAudience(audiences, sender);
  if (action === 'передать') return personInAudience(audiences, target);
  return null;
}

const AUDIENCE_ASK = '2';

const SYSTEM = [
  'Тебе даны пункты раздела профиля «Никогда без подтверждения руководителя» и оргструктура этого руководителя.',
  'Пункт про адресата: из его текста видно, каким людям по должности, роли или подчинению адресовано письмо. Верни каждого человека оргструктуры, чья должность, роль или подчинение подходят под этот текст. Список тогда не пустой.',
  'Пункт про содержание: он говорит, о чём письмо, и не задаёт адресата. Для него список людей пустой, про_адресата — нет.',
  'Имена пиши дословно из оргструктуры. Людей вне списка не добавляй. Каждый пункт верни один раз.',
].join(' ');

export async function askAudiences(points: string[], members: OrgMember[]): Promise<unknown> {
  const pointEnum = points as [string, ...string[]];
  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['пункты'],
    properties: {
      пункты: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['пункт', 'про_адресата', 'люди'],
          properties: {
            пункт: { type: 'string', enum: pointEnum },
            про_адресата: { type: 'boolean' },
            люди: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };
  const parsed = z.object({
    пункты: z.array(z.object({ пункт: z.enum(pointEnum), про_адресата: z.boolean(), люди: z.array(z.string()) })),
  });
  const result = await callJson<unknown>({
    purpose: 'audience',
    system: SYSTEM,
    user: [`Пункты:\n${points.map((point) => `- ${point}`).join('\n')}`, '', 'Оргструктура:', orgText(members)].join('\n'),
    schemaName: 'confirmation_audience',
    schema,
  });
  const safe = parsed.safeParse(result.data);
  if (!safe.success) throw new Error('Ответ модели не совпал со схемой адресатов');
  for (const row of safe.data.пункты) {
    if (row.про_адресата && row.люди.length === 0) throw new Error('Пункт про адресата без людей');
  }
  return safe.data;
}

export async function loadAudiences(db: Db, leaderId: string): Promise<PointAudience[]> {
  const [row] = await db.select().from(confirmationAudiences).where(eq(confirmationAudiences.leaderId, leaderId)).limit(1);
  return audiencesOf(row?.audiences);
}

export async function refreshAudiences(db: Db, leaderId: string): Promise<'same' | 'updated' | 'failed'> {
  const [leader] = await db.select({ profile: leaders.profile }).from(leaders).where(eq(leaders.id, leaderId)).limit(1);
  if (!leader) return 'failed';
  const persons = await db.select().from(people).where(eq(people.leaderId, leaderId));
  const members: OrgMember[] = persons.map((person) => ({
    id: person.externalId,
    name: person.name,
    email: person.email,
    position: person.position,
    role: person.role,
    reportsTo: person.reportsTo,
  }));
  const points = confirmationPoints(leader.profile);
  const stamp = orgStamp(members);
  const [stored] = await db.select().from(confirmationAudiences).where(eq(confirmationAudiences.leaderId, leaderId)).limit(1);
  if (stored && stored.profileText === leader.profile && stored.orgStamp === stamp) return 'same';
  let audiences = points.map((point) => ({ point, people: [] as AudiencePerson[] }));
  if (points.length && members.length) {
    try {
      const data = await withLlmScope(
        { agent: 'audience', leaderId, operationId: `audience:${leaderId}:${AUDIENCE_ASK}`, title: 'Кому относятся пункты профиля' },
        () => askAudiences(points, members),
      );
      audiences = audiencesFromAnswer(data, points, members);
    } catch (err) {
      console.error('Пункты профиля не разобраны', leaderId, err instanceof Error ? err.message : err);
      return 'failed';
    }
  }
  const row = { leaderId, profileText: leader.profile, orgStamp: stamp, audiences };
  if (stored) await db.update(confirmationAudiences).set(row).where(eq(confirmationAudiences.leaderId, leaderId));
  else await db.insert(confirmationAudiences).values(row);
  return 'updated';
}
