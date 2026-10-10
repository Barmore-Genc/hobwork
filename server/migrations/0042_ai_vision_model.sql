-- The model for requests that ask for the vision role (`model: 'vision'`).
-- NULL uses the level above, like the other models.
ALTER TABLE ai_settings ADD COLUMN vision_model TEXT;
ALTER TABLE project_ai_settings ADD COLUMN vision_model TEXT;
