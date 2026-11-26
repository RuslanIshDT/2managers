ALTER TABLE decisions ADD COLUMN IF NOT EXISTS awaiting_edit boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS revisions (
  id text PRIMARY KEY,
  leader_id text NOT NULL REFERENCES leaders(id),
  category text NOT NULL,
  instead text NOT NULL,
  created_at timestamptz NOT NULL
);
