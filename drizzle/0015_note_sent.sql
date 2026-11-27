CREATE TABLE IF NOT EXISTS note_sent (
  leader_id text NOT NULL,
  email text NOT NULL,
  sent_at timestamptz NOT NULL,
  PRIMARY KEY (leader_id, email)
);
