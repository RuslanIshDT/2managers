// Какое письмо каталога после сброса должно ждать решения. Id и имена в функцию не зашиты.
import { limitBreaches } from './confirm.ts';

export interface CatalogLetter {
  id: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  body: string;
  received: string;
}

export interface PersonLimit {
  email: string;
  name: string;
  area: string;
  limit: string;
  unit: string;
}

export function pickAboveLimit(letters: CatalogLetter[], limits: PersonLimit[]): CatalogLetter | null {
  const hits = letters.flatMap((letter) => {
    const rows = limits.filter(
      (row) =>
        row.email.trim().toLowerCase() === letter.fromEmail.trim().toLowerCase() ||
        row.name.trim().toLowerCase() === letter.fromName.trim().toLowerCase(),
    );
    const breaches = limitBreaches(`${letter.subject}\n${letter.body}`, rows);
    if (!breaches.length) return [];
    const excess = Math.max(...breaches.map((row) => row.asked / row.limit));
    return [{ letter, excess }];
  });
  hits.sort((a, b) => b.excess - a.excess || b.letter.received.localeCompare(a.letter.received));
  return hits[0]?.letter ?? null;
}
