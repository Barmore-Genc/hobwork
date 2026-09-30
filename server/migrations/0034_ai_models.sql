-- The host picks the model for hobs instead of hobs naming one, so the `models`
-- lists are no longer read. NULL uses the level above (a hob's settings the
-- host's, the host's HOBWORK_AI_MODEL, HOBWORK_AI_DECISION_MODEL and
-- HOBWORK_AI_EMBEDDING_MODEL).
-- decision_model '' turns decision models off: check and pick use `model`.
ALTER TABLE ai_settings ADD COLUMN model TEXT;
ALTER TABLE ai_settings ADD COLUMN decision_model TEXT;
ALTER TABLE ai_settings ADD COLUMN embedding_model TEXT;
ALTER TABLE ai_settings ADD COLUMN updated_by_agent_id INTEGER REFERENCES agents (id) ON DELETE SET NULL;

ALTER TABLE project_ai_settings ADD COLUMN model TEXT;
ALTER TABLE project_ai_settings ADD COLUMN decision_model TEXT;
ALTER TABLE project_ai_settings ADD COLUMN embedding_model TEXT;
ALTER TABLE project_ai_settings ADD COLUMN updated_by_agent_id INTEGER REFERENCES agents (id) ON DELETE SET NULL;
