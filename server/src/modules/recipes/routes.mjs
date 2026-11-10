import { z } from 'zod';
import { id } from '../../core/security.mjs';
import { member, familyLock, audit } from '../../core/policy.mjs';
import { demand } from '../../core/errors.mjs';
import { recipe, name } from '../../core/validation.mjs';
export const publicDish = (d) => ({
  id: d.id,
  name: d.name,
  intro: d.intro,
  coverId: d.cover_id,
  collectionId: d.collection_id,
  minutes: d.minutes,
  servings: d.servings,
  version: d.version,
  sortOrder: d.sort_order,
});
export async function recipeSnapshot(db, dishId) {
  const r = (
    await db.query(
      'SELECT d.*,r.ingredients,r.steps,c.name AS category FROM dishes d JOIN recipes r ON r.dish_id=d.id JOIN collections c ON c.id=d.collection_id WHERE d.id=$1',
      [dishId],
    )
  ).rows[0];
  return r
    ? { ...publicDish(r), category: r.category, ingredients: r.ingredients, steps: r.steps }
    : null;
}
export function recipeRoutes(app, { db, route }) {
  route('GET', '/families/:familyId/menu', null, async (r) => {
    const m = await member(db, r.user.id, r.params.familyId);
    const collections = (
      await db.query(
        'SELECT id,name,sort_order FROM collections WHERE family_id=$1 ORDER BY sort_order,id',
        [r.params.familyId],
      )
    ).rows;
    let dishes = (
      await db.query(
        'SELECT * FROM dishes WHERE family_id=$1 AND NOT archived ORDER BY sort_order,id',
        [r.params.familyId],
      )
    ).rows.map(publicDish);
    return {
      family: {
        id: m.family_id,
        name: m.name,
        role: m.role,
        identity: m.identity,
        version: m.version,
      },
      collections,
      dishes,
    };
  });
  route('GET', '/families/:familyId/dishes/:dishId/recipe', null, async (r) => {
    await member(db, r.user.id, r.params.familyId, 'cook');
    const d = (
      await db.query('SELECT id FROM dishes WHERE id=$1 AND family_id=$2', [
        r.params.dishId,
        r.params.familyId,
      ])
    ).rows[0];
    demand(d, 404, 'DISH_NOT_FOUND', '菜品不存在');
    return recipeSnapshot(db, d.id);
  });
  route('POST', '/families/:familyId/collections', z.object({ name }).strict(), async (r) =>
    db.transaction(async (tx) => {
      await familyLock(tx, r.params.familyId);
      await member(tx, r.user.id, r.params.familyId, 'cook');
      let cid = id();
      await tx.query(
        'INSERT INTO collections(id,family_id,name,sort_order) SELECT $1,$2,$3,COALESCE(MAX(sort_order),0)+1 FROM collections WHERE family_id=$2',
        [cid, r.params.familyId, r.body.name],
      );
      await tx.query('UPDATE families SET version=version+1 WHERE id=$1', [r.params.familyId]);
      return { id: cid };
    }),
  );
  route('PATCH', '/families/:familyId/collections/:id', z.object({ name }).strict(), async (r) =>
    db.transaction(async (tx) => {
      await familyLock(tx, r.params.familyId);
      await member(tx, r.user.id, r.params.familyId, 'cook');
      let row = await tx.query(
        'UPDATE collections SET name=$3 WHERE id=$1 AND family_id=$2 RETURNING id',
        [r.params.id, r.params.familyId, r.body.name],
      );
      demand(row.rows.length, 404, 'COLLECTION_NOT_FOUND', '合集不存在');
      await tx.query('UPDATE families SET version=version+1 WHERE id=$1', [r.params.familyId]);
      return { ok: true };
    }),
  );
  route('DELETE', '/families/:familyId/collections/:id', null, async (r) =>
    db.transaction(async (tx) => {
      await familyLock(tx, r.params.familyId);
      await member(tx, r.user.id, r.params.familyId, 'cook');
      let count = (
        await tx.query(
          'SELECT count(*)::int AS n FROM dishes WHERE collection_id=$1 AND family_id=$2 AND NOT archived',
          [r.params.id, r.params.familyId],
        )
      ).rows[0].n;
      demand(!count, 409, 'COLLECTION_NOT_EMPTY', '请先将菜品移动到其他合集');
      await tx.query(
        'DELETE FROM collections WHERE id=$1 AND family_id=$2 AND NOT EXISTS(SELECT 1 FROM dishes WHERE collection_id=$1)',
        [r.params.id, r.params.familyId],
      );
      await tx.query('UPDATE families SET version=version+1 WHERE id=$1', [r.params.familyId]);
      return { ok: true };
    }),
  );
  route('POST', '/families/:familyId/dishes', recipe, async (r) =>
    db.transaction(async (tx) => {
      await familyLock(tx, r.params.familyId);
      await member(tx, r.user.id, r.params.familyId, 'cook');
      return saveDish(tx, r.user.id, r.params.familyId, null, r.body);
    }),
  );
  route('PUT', '/families/:familyId/dishes/:dishId', recipe, async (r) =>
    db.transaction(async (tx) => {
      await familyLock(tx, r.params.familyId);
      await member(tx, r.user.id, r.params.familyId, 'cook');
      return saveDish(tx, r.user.id, r.params.familyId, r.params.dishId, r.body);
    }),
  );
  route('DELETE', '/families/:familyId/dishes/:dishId', null, async (r) =>
    db.transaction(async (tx) => {
      await familyLock(tx, r.params.familyId);
      await member(tx, r.user.id, r.params.familyId, 'cook');
      await tx.query(
        'UPDATE dishes SET archived=true,version=version+1 WHERE id=$1 AND family_id=$2',
        [r.params.dishId, r.params.familyId],
      );
      await tx.query('UPDATE families SET version=version+1 WHERE id=$1', [r.params.familyId]);
      await audit(tx, r.user.id, r.params.familyId, 'dish.archive', r.params.dishId);
      return { ok: true };
    }),
  );
  route(
    'POST',
    '/families/:familyId/sort',
    z
      .object({ type: z.enum(['dishes', 'collections']), ids: z.array(z.uuid()).min(1).max(1000) })
      .strict(),
    async (r) =>
      db.transaction(async (tx) => {
        await familyLock(tx, r.params.familyId);
        await member(tx, r.user.id, r.params.familyId, 'cook');
        const table = r.body.type;
        demand(new Set(r.body.ids).size === r.body.ids.length, 400, 'DUPLICATE_IDS', '排序项重复');
        for (let i = 0; i < r.body.ids.length; i++) {
          let out = await tx.query(
            `UPDATE ${table} SET sort_order=$3 WHERE id=$1 AND family_id=$2 RETURNING id`,
            [r.body.ids[i], r.params.familyId, i],
          );
          demand(out.rows.length, 400, 'INVALID_SORT', '排序包含其他小家的项目');
        }
        await tx.query('UPDATE families SET version=version+1 WHERE id=$1', [r.params.familyId]);
        return { ok: true };
      }),
  );
}
async function saveDish(tx, user, family, dishId, b) {
  let c = (
    await tx.query('SELECT id FROM collections WHERE id=$1 AND family_id=$2', [
      b.collectionId,
      family,
    ])
  ).rows[0];
  demand(c, 400, 'INVALID_COLLECTION', '请选择当前小家的合集');
  for (const mediaId of [b.coverId, ...b.steps.map((s) => s.imageId)].filter(Boolean)) {
    let media = (
      await tx.query('SELECT id FROM media WHERE id=$1 AND owner_id=$2', [mediaId, user])
    ).rows[0];
    if (!media) {
      let existing = (
        await tx.query('SELECT id FROM dishes WHERE family_id=$1 AND cover_id=$2', [
          family,
          mediaId,
        ])
      ).rows[0];
      let steps = (
        await tx.query(
          'SELECT r.steps FROM recipes r JOIN dishes d ON d.id=r.dish_id WHERE d.family_id=$1',
          [family],
        )
      ).rows;
      demand(
        existing || steps.some((r) => r.steps.some((s) => s.imageId === mediaId)),
        400,
        'INVALID_MEDIA',
        '图片不属于当前账号或小家',
      );
    }
  }
  let did = dishId || id();
  if (dishId) {
    let changed = await tx.query(
      'UPDATE dishes SET name=$3,intro=$4,cover_id=$5,minutes=$6,servings=$7,collection_id=$8,version=version+1 WHERE id=$1 AND family_id=$2 AND version=$9 AND NOT archived RETURNING id',
      [
        did,
        family,
        b.name,
        b.intro,
        b.coverId || null,
        b.minutes,
        b.servings,
        b.collectionId,
        b.version || 0,
      ],
    );
    demand(changed.rows.length, 409, 'DISH_VERSION', '菜品已经更新，请重新打开编辑');
  } else
    await tx.query(
      'INSERT INTO dishes(id,family_id,collection_id,name,intro,cover_id,minutes,servings) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [did, family, b.collectionId, b.name, b.intro, b.coverId || null, b.minutes, b.servings],
    );
  await tx.query(
    'INSERT INTO recipes(dish_id,ingredients,steps) VALUES($1,$2,$3) ON CONFLICT(dish_id) DO UPDATE SET ingredients=EXCLUDED.ingredients,steps=EXCLUDED.steps',
    [did, JSON.stringify(b.ingredients), JSON.stringify(b.steps)],
  );
  await tx.query('UPDATE families SET version=version+1 WHERE id=$1', [family]);
  await audit(tx, user, family, 'dish.save', did);
  return { id: did };
}
