-- Профиль, собранный формой, и поля подключений без паролей. Повторный запуск безопасен.
ALTER TABLE leaders ADD COLUMN IF NOT EXISTS profile_locked boolean NOT NULL DEFAULT false;
ALTER TABLE leaders ADD COLUMN IF NOT EXISTS mail_address text NOT NULL DEFAULT '';
ALTER TABLE leaders ADD COLUMN IF NOT EXISTS tracker_org text NOT NULL DEFAULT '';
ALTER TABLE leaders ADD COLUMN IF NOT EXISTS tracker_queue text NOT NULL DEFAULT '';
