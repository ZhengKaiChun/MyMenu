ALTER TABLE recipes ADD COLUMN option_groups jsonb NOT NULL DEFAULT '[]'::jsonb;
