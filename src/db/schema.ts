import { bigint, bigserial, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const leaders = pgTable('leaders', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  login: text('login').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  profile: text('profile').notNull(),
  linkCode: text('link_code').notNull(),
  telegramChatId: text('telegram_chat_id'),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  leaderId: text('leader_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const people = pgTable(
  'people',
  {
    leaderId: text('leader_id').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    position: text('position').notNull(),
    role: text('role').notNull(),
    reportsTo: text('reports_to').notNull(),
    email: text('email').notNull(),
    zone: text('zone').notNull().default(''),
    goal: text('goal').notNull().default(''),
    leaderGoal: text('leader_goal').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.externalId] })],
);

export const emails = pgTable(
  'emails',
  {
    leaderId: text('leader_id').notNull(),
    externalId: text('external_id').notNull(),
    received: text('received').notNull(),
    fromName: text('from_name').notNull(),
    fromEmail: text('from_email').notNull(),
    senderRole: text('sender_role').notNull(),
    toAddr: text('to_addr').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.externalId] })],
);

export const emailEtalon = pgTable(
  'email_etalon',
  {
    leaderId: text('leader_id').notNull(),
    externalId: text('external_id').notNull(),
    category: text('category').notNull(),
    expectedAction: text('expected_action').notNull(),
    reason: text('reason').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.externalId] })],
);

export const meetings = pgTable(
  'meetings',
  {
    leaderId: text('leader_id').notNull(),
    uid: text('uid').notNull(),
    startsAt: text('starts_at').notNull(),
    endsAt: text('ends_at').notNull(),
    minutes: integer('minutes').notNull(),
    summary: text('summary').notNull(),
    organizer: text('organizer').notNull(),
    attendees: jsonb('attendees').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.uid] })],
);

export const meetingEtalon = pgTable(
  'meeting_etalon',
  {
    leaderId: text('leader_id').notNull(),
    uid: text('uid').notNull(),
    category: text('category').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.uid] })],
);

export const tasks = pgTable(
  'tasks',
  {
    leaderId: text('leader_id').notNull(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    ownerName: text('owner_name').notNull(),
    dueOn: text('due_on').notNull(),
    status: text('status').notNull(),
    source: text('source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.externalId] })],
);

export const kpis = pgTable(
  'kpis',
  {
    leaderId: text('leader_id').notNull(),
    personId: text('person_id').notNull(),
    kpiId: text('kpi_id').notNull(),
    name: text('name').notNull(),
    unit: text('unit').notNull(),
    better: text('better').notNull(),
    week: text('week').notNull(),
    plan: text('plan').notNull(),
    fact: text('fact').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.personId, t.kpiId, t.week] })],
);

export const authorities = pgTable(
  'authorities',
  {
    leaderId: text('leader_id').notNull(),
    personId: text('person_id').notNull(),
    area: text('area').notNull(),
    limitValue: text('limit_value').notNull(),
    unit: text('unit').notNull(),
    note: text('note').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.personId, t.area] })],
);

export const llmCalls = pgTable('llm_calls', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  leaderId: text('leader_id'),
  at: timestamp('at', { withTimezone: true }).notNull(),
  purpose: text('purpose').notNull(),
  model: text('model').notNull(),
  ms: integer('ms').notNull(),
  tokensIn: integer('tokens_in').notNull(),
  tokensOut: integer('tokens_out').notNull(),
  costUsd: numeric('cost_usd'),
});

export const agentRuns = pgTable('agent_runs', {
  id: text('id').primaryKey(),
  leaderId: text('leader_id'),
  agent: text('agent').notNull(),
  reason: text('reason').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status').notNull(),
  detail: text('detail'),
});

export const telegramClicks = pgTable('telegram_clicks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  leaderId: text('leader_id'),
  updateId: bigint('update_id', { mode: 'number' }),
  chatId: text('chat_id').notNull(),
  data: text('data').notNull(),
  action: text('action'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
});
