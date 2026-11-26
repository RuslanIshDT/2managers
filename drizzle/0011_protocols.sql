CREATE TABLE IF NOT EXISTS protocols (
  id text PRIMARY KEY,
  leader_id text NOT NULL,
  source text NOT NULL,
  body text NOT NULL,
  open_items jsonb NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL
);
