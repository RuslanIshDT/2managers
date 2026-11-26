// Какое письмо каталога после сброса должно ждать решения. Id и имена в функцию не зашиты.
import { textSignals } from './k2.ts';

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
  limit: number;
}

export function pickDiscountAboveLimit(letters: CatalogLetter[], limits: PersonLimit[]): CatalogLetter | null {
  const hits = letters.flatMap((letter) => {
    const person = limits.find(
      (row) =>
        row.email.trim().toLowerCase() === letter.fromEmail.trim().toLowerCase() ||
        row.name.trim().toLowerCase() === letter.fromName.trim().toLowerCase(),
    );
    if (!person) return [];
    const signal = textSignals(`${letter.subject}\n${letter.body}`);
    if (signal.discountPercent === null || signal.discountPercent <= person.limit) return [];
    return [{ letter, percent: signal.discountPercent }];
  });
  hits.sort((a, b) => b.percent - a.percent || b.letter.received.localeCompare(a.letter.received));
  return hits[0]?.letter ?? null;
}
