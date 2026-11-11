-- A dish is a single recipe even when displayed in multiple collections.
CREATE UNIQUE INDEX dishes_id_family ON dishes(id,family_id);
CREATE UNIQUE INDEX collections_id_family ON collections(id,family_id);
CREATE TABLE dish_collections(
  dish_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  family_id uuid NOT NULL,
  PRIMARY KEY(dish_id,collection_id),
  FOREIGN KEY(dish_id,family_id) REFERENCES dishes(id,family_id) ON DELETE CASCADE,
  FOREIGN KEY(collection_id,family_id) REFERENCES collections(id,family_id) ON DELETE CASCADE
);
CREATE INDEX dish_collections_family ON dish_collections(family_id,collection_id);
INSERT INTO dish_collections(dish_id,collection_id,family_id) SELECT id,collection_id,family_id FROM dishes;
