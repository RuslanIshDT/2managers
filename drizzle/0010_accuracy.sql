CREATE TABLE IF NOT EXISTS mail_actions (
  leader_id text NOT NULL,
  chain_key text NOT NULL,
  action text NOT NULL,
  forced boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (leader_id, chain_key)
);
