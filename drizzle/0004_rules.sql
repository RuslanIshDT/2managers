-- Правила K10. Повторный запуск безопасен.
CREATE TABLE IF NOT EXISTS rules (
  id text PRIMARY KEY,
  leader_id text NOT NULL REFERENCES leaders (id),
  kind text NOT NULL,
  title text NOT NULL,
  person_id text NOT NULL DEFAULT '',
  area text NOT NULL DEFAULT '',
  limit_value text NOT NULL DEFAULT '',
  cause text NOT NULL DEFAULT '',
  accepted_at timestamptz NOT NULL
);
