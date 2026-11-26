-- Схема стенда. Повторный запуск безопасен: CREATE IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS leaders (
  id text PRIMARY KEY,
  name text NOT NULL,
  login text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  profile text NOT NULL,
  link_code text NOT NULL,
  telegram_chat_id text
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  leader_id text NOT NULL REFERENCES leaders (id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  leader_id text NOT NULL REFERENCES leaders (id),
  external_id text NOT NULL,
  name text NOT NULL,
  position text NOT NULL,
  role text NOT NULL,
  reports_to text NOT NULL,
  email text NOT NULL,
  PRIMARY KEY (leader_id, external_id)
);

CREATE TABLE IF NOT EXISTS emails (
  leader_id text NOT NULL REFERENCES leaders (id),
  external_id text NOT NULL,
  received text NOT NULL,
  from_name text NOT NULL,
  from_email text NOT NULL,
  sender_role text NOT NULL,
  to_addr text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  PRIMARY KEY (leader_id, external_id)
);

-- Эталон синтетики. Агентам эту таблицу не отдаём.
CREATE TABLE IF NOT EXISTS email_etalon (
  leader_id text NOT NULL REFERENCES leaders (id),
  external_id text NOT NULL,
  category text NOT NULL,
  expected_action text NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY (leader_id, external_id)
);

CREATE TABLE IF NOT EXISTS meetings (
  leader_id text NOT NULL REFERENCES leaders (id),
  uid text NOT NULL,
  starts_at text NOT NULL,
  ends_at text NOT NULL,
  minutes integer NOT NULL,
  summary text NOT NULL,
  organizer text NOT NULL,
  attendees jsonb NOT NULL,
  PRIMARY KEY (leader_id, uid)
);

CREATE TABLE IF NOT EXISTS meeting_etalon (
  leader_id text NOT NULL REFERENCES leaders (id),
  uid text NOT NULL,
  category text NOT NULL,
  PRIMARY KEY (leader_id, uid)
);

CREATE TABLE IF NOT EXISTS tasks (
  leader_id text NOT NULL REFERENCES leaders (id),
  external_id text NOT NULL,
  title text NOT NULL,
  owner_name text NOT NULL,
  due_on text NOT NULL,
  status text NOT NULL,
  source text NOT NULL,
  PRIMARY KEY (leader_id, external_id)
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id bigserial PRIMARY KEY,
  leader_id text,
  at timestamptz NOT NULL,
  purpose text NOT NULL,
  model text NOT NULL,
  ms integer NOT NULL,
  tokens_in integer NOT NULL,
  tokens_out integer NOT NULL,
  cost_usd numeric
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id text PRIMARY KEY,
  leader_id text,
  agent text NOT NULL,
  reason text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL,
  detail text
);

CREATE TABLE IF NOT EXISTS telegram_clicks (
  id bigserial PRIMARY KEY,
  leader_id text,
  update_id bigint,
  chat_id text NOT NULL,
  data text NOT NULL,
  action text,
  received_at timestamptz NOT NULL DEFAULT now()
);
