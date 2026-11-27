// Профиль из файла каталога. Правила, добавленные в кабинете, лежат отдельно и здесь не трогаются.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { leaders } from '../db/schema.ts';

export function nextProfile(stored: string, file: string): string | null {
  return stored === file ? null : file;
}

export async function reloadProfiles(db: Db, root = 'data'): Promise<string[]> {
  const rows = await db.select({ id: leaders.id, profile: leaders.profile }).from(leaders);
  const changed: string[] = [];
  for (const row of rows) {
    let file = '';
    try {
      file = await readFile(join(root, row.id, 'leader_profile.md'), 'utf8');
    } catch {
      continue;
    }
    if (nextProfile(row.profile, file) === null) continue;
    await db.update(leaders).set({ profile: file }).where(eq(leaders.id, row.id));
    changed.push(row.id);
  }
  return changed;
}
