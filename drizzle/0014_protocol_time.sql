ALTER TABLE protocols ADD COLUMN IF NOT EXISTS transcript_at timestamptz;
ALTER TABLE protocols ADD COLUMN IF NOT EXISTS sent_at timestamptz;
