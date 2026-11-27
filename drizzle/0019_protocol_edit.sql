-- T69: «Поправить» у протокола — ждём текст правки от руководителя.
ALTER TABLE protocols ADD COLUMN IF NOT EXISTS awaiting_edit boolean NOT NULL DEFAULT false;
