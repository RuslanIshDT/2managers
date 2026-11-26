// Правка руководителя меняет следующий черновик той же категории. Модель получает список, код дописывает текст, если модель его опустила.
export interface Revision {
  category: string;
  instead: string;
}

export function applyRevision(draft: string, category: string, revisions: Revision[]): string {
  const hit = [...revisions].reverse().find((row) => row.category === category && row.instead.trim());
  if (!hit) return draft;
  const text = hit.instead.trim();
  if (draft.includes(text)) return draft;
  return `${draft.trim()}\n\nПо вашей правке: ${text}`;
}

export function revisionPrompt(revisions: Revision[]): string {
  if (!revisions.length) return '';
  const lines = revisions.slice(-8).map((row) => `- ${row.category}: ${row.instead.trim()}`);
  return ['Правки руководителя. В черновике той же категории учти последнюю формулировку:', ...lines].join('\n');
}
