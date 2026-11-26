-- Условия правил и поля карточки, которые пишет модель. Повторный запуск безопасен.
ALTER TABLE rules ADD COLUMN IF NOT EXISTS from_email text NOT NULL DEFAULT '';
ALTER TABLE rules ADD COLUMN IF NOT EXISTS subject_key text NOT NULL DEFAULT '';
ALTER TABLE rules ADD COLUMN IF NOT EXISTS series_key text NOT NULL DEFAULT '';
ALTER TABLE rules ADD COLUMN IF NOT EXISTS effect text NOT NULL DEFAULT '';
ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS risks text NOT NULL DEFAULT '';
ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS if_not text NOT NULL DEFAULT '';
