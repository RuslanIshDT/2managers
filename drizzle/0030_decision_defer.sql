ALTER TABLE decisions ADD COLUMN IF NOT EXISTS defer_until text NOT NULL DEFAULT '';
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS awaiting_defer boolean NOT NULL DEFAULT false;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS awaiting_refuse boolean NOT NULL DEFAULT false;
