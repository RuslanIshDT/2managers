import { bigint, bigserial, boolean, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

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
    extraEmail: text('extra_email').notNull().default(''),
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

export const mailIn = pgTable(
  'mail_in',
  {
    leaderId: text('leader_id').notNull(),
    messageId: text('message_id').notNull(),
    syntheticId: text('synthetic_id').notNull().default(''),
    received: text('received').notNull(),
    fromName: text('from_name').notNull(),
    fromEmail: text('from_email').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    chainKey: text('chain_key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.messageId] })],
);

export const verdicts = pgTable('verdicts', {
  id: text('id').primaryKey(),
  leaderId: text('leader_id').notNull(),
  messageId: text('message_id').notNull(),
  chainKey: text('chain_key').notNull(),
  kind: text('kind').notNull(),
  category: text('category').notNull(),
  summary: text('summary').notNull(),
  draft: text('draft').notNull(),
  basis: text('basis').notNull(),
  context: text('context').notNull(),
  recommendation: text('recommendation').notNull(),
  authorityOffer: text('authority_offer').notNull(),
  risks: text('risks').notNull().default(''),
  ifNot: text('if_not').notNull().default(''),
  authorityArea: text('authority_area').notNull().default(''),
  authorityValue: text('authority_value').notNull().default(''),
  authorityUnit: text('authority_unit').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const decisions = pgTable('decisions', {
  id: text('id').primaryKey(),
  leaderId: text('leader_id').notNull(),
  chainKey: text('chain_key').notNull(),
  status: text('status').notNull(),
  summary: text('summary').notNull(),
  draft: text('draft').notNull(),
  replyTo: text('reply_to').notNull(),
  replyName: text('reply_name').notNull(),
  subject: text('subject').notNull(),
  awaitingEdit: boolean('awaiting_edit').notNull().default(false),
  originalDraft: text('original_draft').notNull().default(''),
  pendingRule: text('pending_rule').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const revisions = pgTable('revisions', {
  id: text('id').primaryKey(),
  leaderId: text('leader_id').notNull(),
  category: text('category').notNull(),
  area: text('area').notNull().default('письма'),
  instead: text('instead').notNull(),
  understood: text('understood').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const leaderActs = pgTable('leader_acts', {
  id: text('id').primaryKey(),
  leaderId: text('leader_id').notNull(),
  subject: text('subject').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(),
  action: text('action').notNull(),
  result: text('result').notNull(),
  originalDraft: text('original_draft').notNull().default(''),
  approvedText: text('approved_text').notNull().default(''),
  auto: boolean('auto').notNull().default(false),
  refId: text('ref_id').notNull().default(''),
});

export const rules = pgTable('rules', {
  id: text('id').primaryKey(),
  leaderId: text('leader_id').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  personId: text('person_id').notNull().default(''),
  area: text('area').notNull().default(''),
  limitValue: text('limit_value').notNull().default(''),
  cause: text('cause').notNull().default(''),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
  fromEmail: text('from_email').notNull().default(''),
  subjectKey: text('subject_key').notNull().default(''),
  seriesKey: text('series_key').notNull().default(''),
  effect: text('effect').notNull().default(''),
});

export const freedSlots = pgTable(
  'freed_slots',
  {
    leaderId: text('leader_id').notNull(),
    meetingUid: text('meeting_uid').notNull(),
    seriesKey: text('series_key').notNull(),
    startsAt: text('starts_at').notNull(),
    minutes: integer('minutes').notNull(),
    useId: text('use_id').notNull(),
    useTitle: text('use_title').notNull(),
    useSummary: text('use_summary').notNull().default(''),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.meetingUid] })],
);

export const seriesFate = pgTable(
  'series_fate',
  {
    leaderId: text('leader_id').notNull(),
    seriesKey: text('series_key').notNull(),
    action: text('action').notNull(),
    reason: text('reason').notNull().default(''),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.seriesKey] })],
);

export const focusPlans = pgTable('focus_plans', {
  leaderId: text('leader_id').primaryKey(),
  plan: jsonb('plan').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const seriesKind = pgTable(
  'series_kind',
  {
    leaderId: text('leader_id').notNull(),
    seriesKey: text('series_key').notNull(),
    kind: text('kind').notNull(),
    category: text('category').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.seriesKey] })],
);

export const protocols = pgTable('protocols', {
  id: text('id').primaryKey(),
  leaderId: text('leader_id').notNull(),
  source: text('source').notNull(),
  body: text('body').notNull(),
  openItems: jsonb('open_items').notNull(),
  status: text('status').notNull(),
  transcriptAt: timestamp('transcript_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  awaitingEdit: boolean('awaiting_edit').notNull().default(false),
  pendingRule: text('pending_rule').notNull().default(''),
  originalBody: text('original_body').notNull().default(''),
  steps: jsonb('steps').notNull().default([]),
  prior: jsonb('prior').notNull().default([]),
  agreed: jsonb('agreed').notNull().default([]),
  mailed: jsonb('mailed').$type<string[] | null>(),
});

export const taskReminders = pgTable(
  'task_reminders',
  {
    leaderId: text('leader_id').notNull(),
    taskKey: text('task_key').notNull(),
    day: text('day').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.taskKey, t.day] })],
);

export const noteSent = pgTable(
  'note_sent',
  {
    leaderId: text('leader_id').notNull(),
    email: text('email').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.email] })],
);

export const mailActions = pgTable(
  'mail_actions',
  {
    leaderId: text('leader_id').notNull(),
    chainKey: text('chain_key').notNull(),
    action: text('action').notNull(),
    forced: boolean('forced').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.chainKey] })],
);

export const confirmationAudiences = pgTable('confirmation_audiences', {
  leaderId: text('leader_id').primaryKey(),
  profileText: text('profile_text').notNull().default(''),
  orgStamp: text('org_stamp').notNull().default(''),
  audiences: jsonb('audiences').notNull(),
});

export const flowReports = pgTable('flow_reports', {
  leaderId: text('leader_id').primaryKey(),
  report: jsonb('report').notNull(),
  calls: integer('calls').notNull(),
  costUsd: text('cost_usd').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

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
  agent: text('agent').notNull().default(''),
  operationId: text('operation_id').notNull().default(''),
  traceId: text('trace_id').notNull().default(''),
});

export const agentModels = pgTable(
  'agent_models',
  {
    leaderId: text('leader_id').notNull(),
    agent: text('agent').notNull(),
    model: text('model').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leaderId, t.agent] })],
);

export const operations = pgTable('operations', {
  id: text('id').primaryKey(),
  leaderId: text('leader_id').notNull().default(''),
  agent: text('agent').notNull(),
  title: text('title').notNull(),
  model: text('model').notNull(),
  calls: integer('calls').notNull(),
  tokensIn: integer('tokens_in').notNull(),
  tokensOut: integer('tokens_out').notNull(),
  ms: integer('ms').notNull(),
  costUsd: numeric('cost_usd'),
  priced: boolean('priced').notNull().default(false),
  traceId: text('trace_id').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
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
