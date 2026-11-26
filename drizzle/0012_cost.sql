CREATE TABLE IF NOT EXISTS agent_models (
  leader_id text NOT NULL,
  agent text NOT NULL,
  model text NOT NULL,
  PRIMARY KEY (leader_id, agent)
);

CREATE TABLE IF NOT EXISTS operations (
  id text PRIMARY KEY,
  leader_id text NOT NULL DEFAULT '',
  agent text NOT NULL,
  title text NOT NULL,
  model text NOT NULL,
  calls integer NOT NULL,
  tokens_in integer NOT NULL,
  tokens_out integer NOT NULL,
  ms integer NOT NULL,
  cost_usd numeric,
  priced boolean NOT NULL DEFAULT false,
  trace_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL
);

ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS agent text NOT NULL DEFAULT '';
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS operation_id text NOT NULL DEFAULT '';
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS trace_id text NOT NULL DEFAULT '';
