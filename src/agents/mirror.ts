// Записки подчинённым и сгорающие серии. Тексты собираются из их писем и отчёта аудита.
export interface NoteInput {
  name: string;
  email: string;
  subjects: string[];
  lagging: boolean;
  ownRules: string[];
}

export interface Note {
  name: string;
  email: string;
  text: string;
  quiet: boolean;
}

export function weeklyNotes(people: NoteInput[]): Note[] {
  return people.map((person) => {
    const quiet = person.lagging && person.subjects.length === 0;
    const lines = [`${person.name}, записка за неделю.`];
    if (person.subjects.length === 0) {
      lines.push('Вы не писали руководителю.');
    } else {
      const subjects = [...new Set(person.subjects)].slice(0, 6);
      lines.push(`Вы написали руководителю ${person.subjects.length} раз: ${subjects.join('; ')}.`);
    }
    if (person.ownRules.length) {
      lines.push(`По принятым правилам вы решаете сами: ${person.ownRules.slice(0, 4).join('; ')}.`);
    }
    if (quiet) lines.push('KPI при этом отстаёт. Если нужна помощь — приходите с вариантом решения, сроком и тем, что нужно от руководителя.');
    else lines.push('Что не закрыто вашими полномочиями, приносите с вариантом решения, сроком и тем, что нужно от руководителя.');
    return { name: person.name, email: person.email, text: lines.join('\n'), quiet };
  });
}

export function noteToSend(notes: Note[]): Note | null {
  return notes.find((note) => note.quiet) ?? notes.find((note) => note.text.includes('раз:')) ?? notes[0] ?? null;
}

export function pendingNotes(notes: Note[], sentEmails: string[]): Note[] {
  const sent = new Set(sentEmails.map((email) => email.trim().toLowerCase()));
  return notes.filter((note) => note.email.trim() !== '' && !sent.has(note.email.trim().toLowerCase()));
}

export interface SeriesView {
  title: string;
  verdict: string;
  change: string;
  hours: number;
}

export function burningSeries(items: { kind?: string; title?: string; verdict?: string; change?: string; hours?: number; freedHours?: number }[]): SeriesView[] {
  return items
    .filter((item) => item.kind === 'встречи' && item.verdict && item.verdict !== 'должно' && item.title)
    .map((item) => ({
      title: item.title as string,
      verdict: item.verdict as string,
      change: item.change ?? '',
      hours: typeof item.freedHours === 'number' ? item.freedHours : typeof item.hours === 'number' ? item.hours : 0,
    }));
}
