ALTER TABLE dishes ADD COLUMN featured boolean NOT NULL DEFAULT false;
ALTER TABLE dishes ADD COLUMN spice_level smallint NOT NULL DEFAULT 1 CHECK(spice_level BETWEEN 1 AND 3);
ALTER TABLE inventories ADD COLUMN meat_type text NOT NULL DEFAULT '';
UPDATE inventories SET meat_type=CASE WHEN category='海鲜' THEN '海鲜' ELSE '其他' END,category='肉类' WHERE category IN('肉禽','海鲜');
UPDATE inventories SET meat_type='其他' WHERE category='肉类' AND meat_type='';
ALTER TABLE inventories ADD CONSTRAINT inventory_meat_type CHECK((category='肉类' AND meat_type IN('猪','鸡','牛','鱼','海鲜','其他')) OR (category<>'肉类' AND meat_type=''));
UPDATE members SET identity='猪大儿' WHERE identity='猪大二';
UPDATE families SET version=version+1 WHERE id IN(SELECT family_id FROM collections WHERE name='招牌');
UPDATE dishes SET featured=true WHERE collection_id IN(SELECT id FROM collections WHERE name='招牌');
UPDATE dishes d SET collection_id=(SELECT c.id FROM collections c WHERE c.family_id=d.family_id AND c.name<>'招牌' ORDER BY c.sort_order,c.id LIMIT 1) WHERE d.collection_id IN(SELECT id FROM collections WHERE name='招牌') AND EXISTS(SELECT 1 FROM collections c WHERE c.family_id=d.family_id AND c.name<>'招牌');
DELETE FROM collections c WHERE name='招牌' AND NOT EXISTS(SELECT 1 FROM dishes d WHERE d.collection_id=c.id);
UPDATE collections SET name='家常菜' WHERE name='招牌';

ALTER TABLE dishes ADD COLUMN meat_type text NOT NULL DEFAULT '' CHECK(meat_type IN('','猪','鸡','牛','鱼','海鲜','其他'));
UPDATE dishes SET meat_type='其他' WHERE collection_id IN(SELECT id FROM collections WHERE name IN('肉类','肉禽','荤菜'));
