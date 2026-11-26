// K1, HR-агент: загрузка отдела из файлов. Модель не вызывается.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, count } from 'drizzle-orm';
import { loadSynthetic, parseCsv } from '../data/synthetic.ts';
import type { Db } from '../db/client.ts';
import { agentRuns, authorities, emails, kpis, people } from '../db/schema.ts';

const CUTOFF = '2026-12-07';
const LAG = 0.05;

export interface DepartmentRow {
  personId: string;
  zone: string;
  goal: string;
  leaderGoal: string;
}

export interface KpiPoint {
  personId: string;
  kpiId: string;
  name: string;
  unit: string;
  better: string;
  week: string;
  plan: string;
  fact: string;
}

export interface AuthorityRow {
  personId: string;
  area: string;
  limit: string;
  unit: string;
  note: string;
}

export interface DepartmentFiles {
  department: DepartmentRow[];
  kpis: KpiPoint[];
  authorities: AuthorityRow[];
}

export interface KpiSeries {
  kpiId: string;
  name: string;
  unit: string;
  better: string;
  weeks: { week: string; plan: string; fact: string; status: KpiStatus }[];
  quarter: { plan: string; fact: string; status: KpiStatus } | null;
}

export interface SubordinateCard {
  personId: string;
  name: string;
  zone: string;
  goal: string;
  leaderGoal: string;
  kpis: KpiSeries[];
  authorities: AuthorityRow[];
}

export type KpiStatus = 'норма' | 'отстаёт' | 'нет факта';

export function kpiStatus(better: string, plan: string, fact: string): KpiStatus {
  const p = Number(plan);
  const f = Number(fact);
  if (plan.trim() === '' || fact.trim() === '' || !Number.isFinite(p) || !Number.isFinite(f)) return 'нет факта';
  if (p === 0) return f === 0 ? 'норма' : 'отстаёт';
  const gap = better === 'меньше' ? (f - p) / Math.abs(p) : (p - f) / Math.abs(p);
  return gap > LAG ? 'отстаёт' : 'норма';
}

export async function readDepartment(dir: string): Promise<DepartmentFiles> {
  const read = async (name: string) => stripNotes(await readFile(join(dir, name), 'utf8'));
  const [departmentCsv, kpiCsv, authorityCsv] = await Promise.all([
    read('department.csv'),
    read('kpi.csv'),
    read('authority.csv'),
  ]);
  return {
    department: parseCsv(departmentCsv).map((r) => ({
      personId: r.person_id,
      zone: r.zone,
      goal: r.goal,
      leaderGoal: r.leader_goal,
    })),
    kpis: parseCsv(kpiCsv).map((r) => ({
      personId: r.person_id,
      kpiId: r.kpi_id,
      name: r.name,
      unit: r.unit,
      better: r.better,
      week: r.week,
      plan: r.plan,
      fact: r.fact,
    })),
    authorities: parseCsv(authorityCsv).map((r) => ({
      personId: r.person_id,
      area: r.area,
      limit: r.limit,
      unit: r.unit,
      note: r.note,
    })),
  };
}

export function checkDepartment(
  peopleRows: { id: string; name: string; role: string }[],
  files: DepartmentFiles,
): { errors: string[]; cards: SubordinateCard[] } {
  const errors: string[] = [];
  const byId = new Map(peopleRows.map((p) => [p.id, p]));
  const subs = peopleRows.filter((p) => p.role === 'подчинённый');
  const dept = new Map<string, DepartmentRow>();
  for (const row of files.department) {
    if (!byId.has(row.personId)) errors.push(`department: неизвестный человек ${row.personId}`);
    else if (byId.get(row.personId)?.role !== 'подчинённый') errors.push(`department: ${row.personId} не подчинённый`);
    else if (dept.has(row.personId)) errors.push(`department: повтор ${row.personId}`);
    else dept.set(row.personId, row);
    if (row.leaderGoal !== '' && !['1', '2', '3'].includes(row.leaderGoal)) {
      errors.push(`department: цель профиля «${row.leaderGoal}» у ${row.personId} не 1–3`);
    }
  }

  const kpiByPerson = new Map<string, KpiPoint[]>();
  for (const row of files.kpis) {
    if (!byId.has(row.personId)) errors.push(`kpi: неизвестный человек ${row.personId}`);
    if (row.better !== 'больше' && row.better !== 'меньше') errors.push(`kpi: better «${row.better}» у ${row.personId}`);
    if (row.week !== 'квартал' && !mondayBefore(row.week)) errors.push(`kpi: неделя «${row.week}» у ${row.personId} не понедельник до 7.12`);
    const list = kpiByPerson.get(row.personId) ?? [];
    list.push(row);
    kpiByPerson.set(row.personId, list);
  }

  const authByPerson = new Map<string, AuthorityRow[]>();
  for (const row of files.authorities) {
    if (!byId.has(row.personId)) errors.push(`authority: неизвестный человек ${row.personId}`);
    const list = authByPerson.get(row.personId) ?? [];
    list.push(row);
    authByPerson.set(row.personId, list);
  }

  const cards: SubordinateCard[] = [];
  for (const person of subs) {
    const row = dept.get(person.id);
    if (!row || row.zone.trim() === '') errors.push(`${person.name}: нет зоны`);
    if (!row || row.goal.trim() === '') errors.push(`${person.name}: нет цели`);
    const points = kpiByPerson.get(person.id) ?? [];
    if (points.length === 0) errors.push(`${person.name}: нет KPI`);
    const series = seriesOf(points);
    for (const item of series) {
      if (item.weeks.length < 4) errors.push(`${person.name}: у KPI «${item.name}» меньше 4 недель до 7.12`);
      if (!item.quarter) errors.push(`${person.name}: у KPI «${item.name}» нет строки квартала`);
    }
    const powers = authByPerson.get(person.id) ?? [];
    if (powers.length === 0) errors.push(`${person.name}: нет полномочий`);
    if (row && points.length && powers.length) {
      cards.push({
        personId: person.id,
        name: person.name,
        zone: row.zone,
        goal: row.goal,
        leaderGoal: row.leaderGoal,
        kpis: series,
        authorities: powers,
      });
    }
  }

  return { errors, cards: errors.length ? [] : cards };
}

export async function loadDepartment(db: Db, leaderId: string, dir = 'data/synthetic') {
  const data = await loadSynthetic(dir);
  const files = await readDepartment(dir);
  const checked = checkDepartment(data.people, files);
  const now = new Date();
  if (checked.errors.length === 0) {
    await db.transaction(async (tx) => {
      await tx.update(people).set({ zone: '', goal: '', leaderGoal: '' }).where(eq(people.leaderId, leaderId));
      for (const card of checked.cards) {
        await tx
          .update(people)
          .set({ zone: card.zone, goal: card.goal, leaderGoal: card.leaderGoal })
          .where(and(eq(people.leaderId, leaderId), eq(people.externalId, card.personId)));
      }
      await tx.delete(kpis).where(eq(kpis.leaderId, leaderId));
      await tx.delete(authorities).where(eq(authorities.leaderId, leaderId));
      const kpiRows = files.kpis.filter((row) => checked.cards.some((c) => c.personId === row.personId));
      if (kpiRows.length) {
        await tx.insert(kpis).values(
          kpiRows.map((row) => ({
            leaderId,
            personId: row.personId,
            kpiId: row.kpiId,
            name: row.name,
            unit: row.unit,
            better: row.better,
            week: row.week,
            plan: row.plan,
            fact: row.fact,
          })),
        );
      }
      const authRows = files.authorities.filter((row) => checked.cards.some((c) => c.personId === row.personId));
      if (authRows.length) {
        await tx.insert(authorities).values(
          authRows.map((row) => ({
            leaderId,
            personId: row.personId,
            area: row.area,
            limitValue: row.limit,
            unit: row.unit,
            note: row.note,
          })),
        );
      }
    });
  }
  await db.delete(agentRuns).where(eq(agentRuns.id, `k1:${leaderId}`));
  await db.insert(agentRuns).values({
    id: `k1:${leaderId}`,
    leaderId,
    agent: 'k1',
    reason: 'файлы отдела',
    startedAt: now,
    finishedAt: new Date(),
    status: checked.errors.length ? 'failed' : 'done',
    detail: checked.errors.length ? checked.errors.join('\n') : `подчинённых: ${checked.cards.length}`,
  });
  return { errors: checked.errors, loaded: checked.cards.length };
}

export async function departmentForLeader(db: Db, leaderId: string) {
  const [rows, kpiRows, authRows, mailRows, run] = await Promise.all([
    db.select().from(people).where(eq(people.leaderId, leaderId)),
    db.select().from(kpis).where(eq(kpis.leaderId, leaderId)),
    db.select().from(authorities).where(eq(authorities.leaderId, leaderId)),
    db.select({ email: emails.fromEmail, n: count() }).from(emails).where(eq(emails.leaderId, leaderId)).groupBy(emails.fromEmail),
    db.select().from(agentRuns).where(eq(agentRuns.id, `k1:${leaderId}`)).limit(1),
  ]);
  const mail = new Map(mailRows.map((row) => [row.email.toLowerCase(), Number(row.n)]));
  const subs = rows.filter((row) => row.role === 'подчинённый').sort((a, b) => a.externalId.localeCompare(b.externalId));
  return {
    errors: run[0]?.status === 'failed' ? (run[0].detail ?? '').split('\n').filter(Boolean) : [],
    people: subs.map((person) => {
      const points = kpiRows
        .filter((row) => row.personId === person.externalId)
        .map((row) => ({
          personId: row.personId,
          kpiId: row.kpiId,
          name: row.name,
          unit: row.unit,
          better: row.better,
          week: row.week,
          plan: row.plan,
          fact: row.fact,
        }));
      return {
        id: person.externalId,
        name: person.name,
        position: person.position,
        zone: person.zone,
        goal: person.goal,
        leaderGoal: person.leaderGoal,
        emails: mail.get(person.email.toLowerCase()) ?? 0,
        kpis: seriesOf(points),
        authorities: authRows
          .filter((row) => row.personId === person.externalId)
          .map((row) => ({ area: row.area, limit: row.limitValue, unit: row.unit, note: row.note })),
      };
    }),
  };
}

function seriesOf(points: KpiPoint[]): KpiSeries[] {
  const groups = new Map<string, (KpiPoint & { personId: string })[]>();
  for (const point of points) {
    const list = groups.get(point.kpiId) ?? [];
    list.push(point);
    groups.set(point.kpiId, list);
  }
  return [...groups.entries()].map(([kpiId, rows]) => {
    const head = rows[0];
    const weeks = rows
      .filter((row) => row.week !== 'квартал')
      .map((row) => ({ week: row.week, plan: row.plan, fact: row.fact, status: kpiStatus(row.better, row.plan, row.fact) }));
    const quarterRow = rows.find((row) => row.week === 'квартал');
    return {
      kpiId,
      name: head?.name ?? kpiId,
      unit: head?.unit ?? '',
      better: head?.better ?? '',
      weeks,
      quarter: quarterRow
        ? { plan: quarterRow.plan, fact: quarterRow.fact, status: kpiStatus(quarterRow.better, quarterRow.plan, quarterRow.fact) }
        : null,
    };
  });
}

function mondayBefore(week: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || week >= CUTOFF) return false;
  const [year, month, day] = week.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 1;
}

function stripNotes(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('\n');
}
