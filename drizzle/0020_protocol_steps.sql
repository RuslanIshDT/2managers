-- Сценарий 5: поручения протокола структурой, статусы прошлых задач, встречи из протокола, напоминания о сроке.
ALTER TABLE protocols ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE protocols ADD COLUMN IF NOT EXISTS prior jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE protocols ADD COLUMN IF NOT EXISTS agreed jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS task_reminders (
  leader_id text NOT NULL,
  task_key text NOT NULL,
  day text NOT NULL,
  PRIMARY KEY (leader_id, task_key, day)
);
