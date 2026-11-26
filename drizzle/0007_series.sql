-- Решение по серии встреч. Календарь не меняется. Повторный запуск безопасен.
CREATE TABLE IF NOT EXISTS series_fate (
  leader_id text NOT NULL REFERENCES leaders (id),
  series_key text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  at timestamptz NOT NULL,
  PRIMARY KEY (leader_id, series_key)
);
