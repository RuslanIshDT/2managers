CREATE TABLE IF NOT EXISTS confirmation_audiences (
  leader_id text PRIMARY KEY,
  profile_text text NOT NULL DEFAULT '',
  org_stamp text NOT NULL DEFAULT '',
  audiences jsonb NOT NULL DEFAULT '[]'::jsonb
);
