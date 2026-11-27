-- T57: встречи отпущенных серий, освобождённые в календаре, и чем занято их время.
CREATE TABLE IF NOT EXISTS freed_slots (
  leader_id text NOT NULL,
  meeting_uid text NOT NULL,
  series_key text NOT NULL,
  starts_at text NOT NULL,
  minutes integer NOT NULL,
  use_id text NOT NULL,
  use_title text NOT NULL,
  use_summary text NOT NULL DEFAULT '',
  at timestamptz NOT NULL,
  PRIMARY KEY (leader_id, meeting_uid)
);
