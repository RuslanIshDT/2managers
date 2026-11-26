CREATE TABLE IF NOT EXISTS focus_plans (
  leader_id text PRIMARY KEY REFERENCES leaders(id),
  plan jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS series_kind (
  leader_id text NOT NULL,
  series_key text NOT NULL,
  kind text NOT NULL,
  PRIMARY KEY (leader_id, series_key)
);
