CREATE TABLE achievement_totals(
 user_id uuid NOT NULL REFERENCES users(id),family_id uuid NOT NULL REFERENCES families(id),
 cooked_archived bigint NOT NULL DEFAULT 0 CHECK(cooked_archived>=0),
 ordered_archived bigint NOT NULL DEFAULT 0 CHECK(ordered_archived>=0),
 PRIMARY KEY(user_id,family_id)
);
CREATE TABLE cooking_records(
 family_id uuid NOT NULL,user_id uuid NOT NULL,meal_date date NOT NULL,
 slot text NOT NULL CHECK(slot IN('早餐','午餐','晚餐')),dish_id uuid NOT NULL,
 PRIMARY KEY(family_id,user_id,meal_date,slot,dish_id),
 FOREIGN KEY(user_id) REFERENCES users(id),
 FOREIGN KEY(family_id) REFERENCES families(id),
 FOREIGN KEY(dish_id,family_id) REFERENCES dishes(id,family_id)
);
CREATE INDEX cooking_records_date ON cooking_records(meal_date);
