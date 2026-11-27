// Очищает решения, вердикты, ленту и принятые правила руководителя с Telegram.
// Каталог писем не трогает. Карточку «ждёт» берёт из письма, где скидка выше полномочия, и разбирает его моделью.
import { eq, isNotNull } from 'drizzle-orm';
import { pickDiscountAboveLimit } from '../agents/reset-stand.ts';
import { chainKey } from '../agents/k2.ts';
import { pullInbox } from '../agents/intake.ts';
import { createDb, createPool, migrate } from '../db/client.ts';
import { installLlmRecording } from '../db/llm-record.ts';
import { authorities, decisions, emails, leaders, mailIn, people, rules, verdicts } from '../db/schema.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL не задан');

if (!process.argv.includes('--yes')) {
  console.log(
    'Сброс не выполнен. Повторите с --yes: удалятся решения, вердикты, лента и принятые правила руководителя с привязанным Telegram. В «Ждёт решения» останется письмо каталога со скидкой выше полномочия.',
  );
  process.exit(0);
}

const pool = createPool(connectionString);
await migrate(pool);
const db = createDb(pool);
installLlmRecording(db);
const linked = await db.select({ id: leaders.id }).from(leaders).where(isNotNull(leaders.telegramChatId));
if (linked.length !== 1) {
  console.error(`Нужен один руководитель с Telegram, найдено ${linked.length}`);
  await pool.end();
  process.exit(1);
}
const leaderId = linked[0]?.id;
if (!leaderId) {
  await pool.end();
  process.exit(1);
}

const [catalog, staff, rights] = await Promise.all([
  db.select().from(emails).where(eq(emails.leaderId, leaderId)),
  db.select().from(people).where(eq(people.leaderId, leaderId)),
  db.select().from(authorities).where(eq(authorities.leaderId, leaderId)),
]);
const limits = staff.flatMap((person) => {
  const row = rights.find((right) => right.personId === person.externalId && right.area.toLowerCase().includes('скидк'));
  if (!row) return [];
  const limit = Number(row.limitValue.replace(',', '.'));
  if (!Number.isFinite(limit)) return [];
  return [{ email: person.email, name: person.name, limit }];
});
const letter = pickDiscountAboveLimit(
  catalog.map((row) => ({
    id: row.externalId,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    subject: row.subject,
    body: row.body,
    received: row.received,
  })),
  limits,
);

const removed = {
  rules: (await db.delete(rules).where(eq(rules.leaderId, leaderId)).returning({ id: rules.id })).length,
  decisions: (await db.delete(decisions).where(eq(decisions.leaderId, leaderId)).returning({ id: decisions.id })).length,
  verdicts: (await db.delete(verdicts).where(eq(verdicts.leaderId, leaderId)).returning({ id: verdicts.id })).length,
  mail: (await db.delete(mailIn).where(eq(mailIn.leaderId, leaderId)).returning({ id: mailIn.messageId })).length,
};

if (letter) {
  // Карточка — настоящий разбор агента полномочий тем же путём, что письмо из ящика: контекст, рекомендация,
  // риски и «если не решить» пишет модель. Берётся первое письмо цепочки, чтобы ожидание считалось с него.
  // В Telegram при сбросе ничего не уходит.
  const key = chainKey(letter.fromEmail, letter.subject);
  const first = catalog
    .filter((row) => chainKey(row.fromEmail, row.subject) === key && row.body === letter.body)
    .sort((a, b) => a.received.localeCompare(b.received))[0];
  const source = first ? { id: first.externalId, fromEmail: first.fromEmail, fromName: first.fromName, subject: first.subject, body: first.body, received: first.received } : letter;
  const result = await pullInbox(
    db,
    leaderId,
    [{ ...source, messageId: `<${source.id}.synthetic@ecompras.local>`, marked: true }],
    1,
    { notify: false },
  );
  const [made] = await db.select().from(verdicts).where(eq(verdicts.id, `v-${source.id}`)).limit(1);
  console.log(`Ждёт решения: ${letter.subject}. Разбор: ${result.lines.join('; ') || 'нет'}`);
  if (!made?.risks || !made?.ifNot) console.log('Внимание: модель не заполнила риски или «если не решить».');
} else {
  console.log('Письма со скидкой выше полномочия в каталоге нет. Карточка не создана.');
}
console.log(`Удалено правил ${removed.rules}, решений ${removed.decisions}, вердиктов ${removed.verdicts}, писем ленты ${removed.mail}.`);
await pool.end();
