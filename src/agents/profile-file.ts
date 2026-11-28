// Профиль из файла каталога. Правила, добавленные в кабинете, лежат отдельно и здесь не трогаются.
// Раздел целей берётся из goals.csv источника; остальной текст — из leader_profile.md.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { leaders } from '../db/schema.ts';
import { parseCsv } from '../data/synthetic.ts';

export interface GoalFileRow {
  n: string;
  goal: string;
}

export function nextProfile(stored: string, file: string): string | null {
  return stored === file ? null : file;
}

export function profileToStore(stored: string, file: string, locked: boolean): string | null {
  if (locked) return null;
  return nextProfile(stored, file);
}

export function parseGoals(csv: string): GoalFileRow[] {
  const body = csv
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('\n');
  return parseCsv(body)
    .map((row) => ({ n: (row.n ?? '').trim(), goal: (row.goal ?? '').trim() }))
    .filter((row) => row.n !== '' && row.goal !== '');
}

export function goalsMarkdown(goals: GoalFileRow[]): string {
  return ['## Цели на квартал', ...goals.map((row) => `${row.n}. ${row.goal}`)].join('\n');
}

export function applyGoals(profile: string, goals: GoalFileRow[]): string {
  if (goals.length === 0) return profile;
  const section = goalsMarkdown(goals);
  const match = profile.match(/^## Цели[^\n]*\n(?:(?!^## ).*\n?)*/m);
  if (!match || match.index === undefined) {
    const at = profile.search(/^## /m);
    if (at === -1) return `${profile.replace(/\s*$/, '')}\n\n${section}\n`;
    return `${profile.slice(0, at).replace(/\s*$/, '')}\n\n${section}\n\n${profile.slice(at)}`;
  }
  const before = profile.slice(0, match.index).replace(/\s*$/, '');
  const after = profile.slice(match.index + match[0].length).replace(/^\n*/, '');
  return `${before}\n\n${section}\n\n${after}`;
}

export async function catalogProfile(dir: string): Promise<string | null> {
  let file = '';
  try {
    file = await readFile(join(dir, 'leader_profile.md'), 'utf8');
  } catch {
    return null;
  }
  try {
    const goals = parseGoals(await readFile(join(dir, 'goals.csv'), 'utf8'));
    if (goals.length) file = applyGoals(file, goals);
  } catch {
    // файла целей нет — раздел целей остаётся как в тексте профиля
  }
  return file;
}

export async function refreshGoalSection(db: Db, leaderId: string, dir: string): Promise<boolean> {
  let goals: GoalFileRow[] = [];
  try {
    goals = parseGoals(await readFile(join(dir, 'goals.csv'), 'utf8'));
  } catch {
    return false;
  }
  if (goals.length === 0) return false;
  const [row] = await db.select({ profile: leaders.profile }).from(leaders).where(eq(leaders.id, leaderId));
  if (!row) return false;
  const next = applyGoals(row.profile, goals);
  if (next === row.profile) return false;
  await db.update(leaders).set({ profile: next }).where(eq(leaders.id, leaderId));
  return true;
}

export async function reloadProfiles(db: Db, root = 'data'): Promise<string[]> {
  const rows = await db.select({ id: leaders.id, profile: leaders.profile, profileLocked: leaders.profileLocked }).from(leaders);
  const changed: string[] = [];
  for (const row of rows) {
    const file = await catalogProfile(join(root, row.id));
    if (file === null || profileToStore(row.profile, file, row.profileLocked) === null) continue;
    await db.update(leaders).set({ profile: file }).where(eq(leaders.id, row.id));
    changed.push(row.id);
  }
  return changed;
}
