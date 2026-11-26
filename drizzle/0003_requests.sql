-- Просьбы подчинённых: письма из ящика, вердикты K2, решения руководителя.
CREATE TABLE IF NOT EXISTS mail_in (
  leader_id text NOT NULL REFERENCES leaders (id),
  message_id text NOT NULL,
  synthetic_id text NOT NULL DEFAULT '',
  received text NOT NULL,
  from_name text NOT NULL,
  from_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  chain_key text NOT NULL,
  PRIMARY KEY (leader_id, message_id)
);

CREATE TABLE IF NOT EXISTS verdicts (
  id text PRIMARY KEY,
  leader_id text NOT NULL REFERENCES leaders (id),
  message_id text NOT NULL,
  chain_key text NOT NULL,
  kind text NOT NULL,
  category text NOT NULL,
  summary text NOT NULL,
  draft text NOT NULL,
  basis text NOT NULL,
  context text NOT NULL,
  recommendation text NOT NULL,
  authority_offer text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id text PRIMARY KEY,
  leader_id text NOT NULL REFERENCES leaders (id),
  chain_key text NOT NULL,
  status text NOT NULL,
  summary text NOT NULL,
  draft text NOT NULL,
  reply_to text NOT NULL,
  reply_name text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (leader_id, chain_key)
);
