-- T56: в одной цепочке может быть несколько решений: письмо с новыми условиями получает свою карточку, прежняя — «заменено».
ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_leader_id_chain_key_key;
CREATE INDEX IF NOT EXISTS decisions_leader_chain ON decisions (leader_id, chain_key);
