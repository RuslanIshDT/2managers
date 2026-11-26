// Очищает решения, вердикты, ленту и принятые правила руководителя с Telegram.
// Каталог писем не трогает. Карточку «ждёт» берёт из письма, где скидка выше полномочия.
import { eq, isNotNull } from 'drizzle-orm';
import { pickDiscountAboveLimit } from '../agents/reset-stand.ts';
import { chainKey } from '../agents/k2.ts';
import { createDb, createPool, migrate } from '../db/client.ts';
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
  const now = new Date();
  await db.insert(decisions).values({
    id: letter.id,
    leaderId,
    chainKey: chainKey(letter.fromEmail, letter.subject),
    status: 'ждёт',
    summary: letter.subject,
    draft: '',
    replyTo: letter.fromEmail,
    replyName: letter.fromName,
    subject: letter.subject,
    awaitingEdit: false,
    createdAt: now,
  });
  await db.insert(verdicts).values({
    id: `v-${letter.id}`,
    leaderId,
    messageId: letter.id,
    chainKey: chainKey(letter.fromEmail, letter.subject),
    kind: 'нужен_руководитель',
    category: 'деньги',
    summary: letter.subject,
    draft: '',
    basis: 'Скидка в письме выше полномочия этого человека.',
    context: '',
    recommendation: 'Решение за вами.',
    authorityOffer: '',
    risks: '',
    ifNot: '',
    createdAt: now,
  });
  console.log(`Ждёт решения: ${letter.subject}`);
} else {
  console.log('Письма со скидкой выше полномочия в каталоге нет. Карточка не создана.');
}
console.log(`Удалено правил ${removed.rules}, решений ${removed.decisions}, вердиктов ${removed.verdicts}, писем ленты ${removed.mail}.`);
await pool.end();
