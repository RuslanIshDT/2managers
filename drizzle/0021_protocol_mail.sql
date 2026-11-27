-- Кому уже ушло письмо утверждённого протокола. У протоколов, утверждённых раньше, поля нет: повторно их не рассылаем.
ALTER TABLE protocols ADD COLUMN IF NOT EXISTS mailed jsonb;
