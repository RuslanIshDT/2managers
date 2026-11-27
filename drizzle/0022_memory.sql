ALTER TABLE revisions ADD COLUMN IF NOT EXISTS area text NOT NULL DEFAULT 'письма';
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS original_draft text NOT NULL DEFAULT '';
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS pending_rule text NOT NULL DEFAULT '';
ALTER TABLE protocols ADD COLUMN IF NOT EXISTS pending_rule text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS leader_acts (
  id text PRIMARY KEY,
  leader_id text NOT NULL REFERENCES leaders(id),
  subject text NOT NULL,
  at timestamptz NOT NULL,
  action text NOT NULL,
  result text NOT NULL,
  original_draft text NOT NULL DEFAULT '',
  approved_text text NOT NULL DEFAULT '',
  auto boolean NOT NULL DEFAULT false,
  ref_id text NOT NULL DEFAULT ''
);
