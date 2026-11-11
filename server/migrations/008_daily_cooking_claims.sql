-- Preserve all legacy records, including ambiguous multi-cook entries.
ALTER TABLE cooking_records RENAME TO cooking_records_legacy;
CREATE TABLE cooking_records(family_id uuid NOT NULL REFERENCES families(id),user_id uuid NOT NULL REFERENCES users(id),meal_date date NOT NULL,slot text NOT NULL CHECK(slot IN('早餐','午餐','晚餐')),dish_id uuid NOT NULL,CONSTRAINT cooking_current_pk PRIMARY KEY(family_id,meal_date,slot,dish_id),FOREIGN KEY(dish_id,family_id) REFERENCES dishes(id,family_id));
INSERT INTO cooking_records SELECT c.family_id,c.user_id,c.meal_date,c.slot,c.dish_id FROM cooking_records_legacy c JOIN (SELECT family_id,meal_date,slot,dish_id FROM cooking_records_legacy GROUP BY family_id,meal_date,slot,dish_id HAVING count(*)=1) x USING(family_id,meal_date,slot,dish_id);
CREATE INDEX cooking_current_date ON cooking_records(meal_date);
CREATE TABLE cooking_reminders(id uuid PRIMARY KEY,family_id uuid NOT NULL REFERENCES families(id),meal_date date NOT NULL,slot text NOT NULL,dish_id uuid NOT NULL,UNIQUE(family_id,meal_date,slot,dish_id),FOREIGN KEY(dish_id,family_id) REFERENCES dishes(id,family_id));
ALTER TABLE notifications ADD COLUMN invalidated_at timestamptz;
