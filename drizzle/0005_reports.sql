-- Отчёт аудита за руководителем. Повторный запуск безопасен.
CREATE TABLE IF NOT EXISTS flow_reports (
  leader_id text PRIMARY KEY REFERENCES leaders (id),
  report jsonb NOT NULL,
  calls integer NOT NULL,
  cost_usd text NOT NULL,
  created_at timestamptz NOT NULL
);
