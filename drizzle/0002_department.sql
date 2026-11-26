-- Отдел D4. Повторный запуск безопасен.
ALTER TABLE people ADD COLUMN IF NOT EXISTS zone text NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN IF NOT EXISTS goal text NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN IF NOT EXISTS leader_goal text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS kpis (
  leader_id text NOT NULL REFERENCES leaders (id),
  person_id text NOT NULL,
  kpi_id text NOT NULL,
  name text NOT NULL,
  unit text NOT NULL,
  better text NOT NULL,
  week text NOT NULL,
  plan text NOT NULL,
  fact text NOT NULL,
  PRIMARY KEY (leader_id, person_id, kpi_id, week)
);

CREATE TABLE IF NOT EXISTS authorities (
  leader_id text NOT NULL REFERENCES leaders (id),
  person_id text NOT NULL,
  area text NOT NULL,
  limit_value text NOT NULL,
  unit text NOT NULL,
  note text NOT NULL,
  PRIMARY KEY (leader_id, person_id, area)
);
