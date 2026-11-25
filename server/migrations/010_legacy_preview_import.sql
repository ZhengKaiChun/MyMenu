-- A former device-only preview is imported into a new family. Its meal history
-- stays read-only and never contributes to production orders or achievements.
CREATE UNIQUE INDEX identities_provider_user ON identities(provider,user_id);
CREATE TABLE legacy_imports (
  user_id uuid NOT NULL REFERENCES users(id),
  source_id text NOT NULL,
  family_id uuid REFERENCES families(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,source_id)
);
CREATE TABLE legacy_history (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id),
  meal_date date NOT NULL,
  slot text NOT NULL CHECK(slot IN('早餐','午餐','晚餐')),
  dish_name text NOT NULL,
  cover_id uuid,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 999),
  sources jsonb NOT NULL DEFAULT '[]',
  cooker_label text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legacy_history_family_date ON legacy_history(family_id,meal_date);
