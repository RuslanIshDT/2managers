import { mailRevisions } from './memory.ts';

// Правило уходит в запрос модели. В текст для получателя служебная фраза не дописывается.

export interface Revision {
  category: string;
  area?: string;
  instead: string;
}

export function applyRevision(draft: string, _category: string, _revisions: Revision[]): string {
  return draft.replace(/\n*По вашей правке:[\s\S]*$/u, '').trim();
}

export function revisionPrompt(revisions: Revision[]): string {
  const rows = mailRevisions(revisions);
  if (!rows.length) return '';
  const lines = rows.slice(-8).map((row) => `- ${row.area ? `${row.area}, ` : ''}${row.category}: ${row.instead.trim()}`);
  return ['Правила и правки руководителя. Учти в черновике и не цитируй формулировку:', ...lines].join('\n');
}
