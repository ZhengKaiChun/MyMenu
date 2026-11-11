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
  collectionIds: d.collection_ids?.length ? d.collection_ids : [d.collection_id],
  minutes: d.minutes,
  servings: d.servings,
  version: d.version,
  sortOrder: d.sort_order,
  featured: d.featured,
  meatType: d.meat_type,
  spiceLevel: d.spice_level,
});
export async function recipeSnapshot(db, dishId) {
  const r = (
    await db.query(
      `SELECT d.*,r.ingredients,r.steps,c.name AS category,
       ARRAY(SELECT dc.collection_id FROM dish_collections dc JOIN collections cc ON cc.id=dc.collection_id WHERE dc.dish_id=d.id ORDER BY cc.sort_order,cc.id) AS collection_ids,
       ARRAY(SELECT cc.name FROM dish_collections dc JOIN collections cc ON cc.id=dc.collection_id WHERE dc.dish_id=d.id ORDER BY cc.sort_order,cc.id) AS categories
       FROM dishes d JOIN recipes r ON r.dish_id=d.id JOIN collections c ON c.id=d.collection_id WHERE d.id=$1`,
      [dishId],
    )
  ).rows[0];
  return r
    ? {
        ...publicDish(r),
        category: r.category,
        categories: r.categories,
        ingredients: r.ingredients,
        steps: r.steps,
      }
    : null;
}
export function recipeRoutes(app, { db, route }) {
  const localId = z.string().min(1).max(120);
  route(
    'PUT',
    '/families/:familyId/menu-layout',
    z
      .object({
        version: z.number().int().positive(),
        collections: z
          .array(z.object({ id: localId, name }).strict())
          .min(1)
          .max(100),
        dishes: z
          .array(
            z
              .object({
                id: localId,
                collectionId: localId,
                collectionIds: z.array(localId).min(1).max(100).optional(),
              })
              .strict(),
          )
          .max(1000),
        deletedDishIds: z.array(z.uuid()).max(1000),
        recipes: z
          .array(
            z
              .object({
                id: localId,
                body: recipe.omit({ collectionId: true, collectionIds: true }).extend({
                  collectionId: localId,
                  collectionIds: z.array(localId).min(1).max(100).optional(),
                }),
              })
              .strict(),
          )
          .max(1000),
      })
      .strict(),
    async (r) =>
      db.transaction(async (tx) => {
        await familyLock(tx, r.params.familyId);
        const m = await member(tx, r.user.id, r.params.familyId, 'cook');
        demand(
          m.version === r.body.version,
          409,
          'MENU_VERSION',
          '菜单已被其他成员修改，请重新载入',
        );
        const b = r.body,
          fid = r.params.familyId;
        demand(
          new Set(b.collections.map((c) => c.id)).size === b.collections.length &&
            new Set(b.collections.map((c) => c.name)).size === b.collections.length &&
            new Set(b.dishes.map((d) => d.id)).size === b.dishes.length &&
            new Set(b.recipes.map((d) => d.id)).size === b.recipes.length,
          400,
          'DUPLICATE',
          '合集或菜品重复',
        );
        const oldC = (await tx.query('SELECT id FROM collections WHERE family_id=$1', [fid])).rows;
        const oldD = (
          await tx.query('SELECT id FROM dishes WHERE family_id=$1 AND NOT archived', [fid])
        ).rows;
        demand(
          oldD.every((d) => b.dishes.some((x) => x.id === d.id) || b.deletedDishIds.includes(d.id)),
          409,
          'MENU_INCOMPLETE',
          '菜单草稿缺少菜品',
        );
        const cmap = {},
          dmap = {};
        for (const c of oldC)
          await tx.query('UPDATE collections SET name=$2 WHERE id=$1', [c.id, '__draft_' + c.id]);
        for (const [sort, c] of b.collections.entries()) {
          const existing = oldC.some((x) => x.id === c.id);
          demand(
            existing || c.id.startsWith('draft-'),
            400,
            'COLLECTION_OWNER',
            '合集不属于当前小家',
          );
          const cid = existing ? c.id : id();
          cmap[c.id] = cid;
          if (existing)
            await tx.query('UPDATE collections SET name=$2,sort_order=$3 WHERE id=$1', [
              cid,
              c.name,
              sort,
            ]);
          else
            await tx.query(
              'INSERT INTO collections(id,family_id,name,sort_order) VALUES($1,$2,$3,$4)',
              [cid, fid, c.name, sort],
            );
        }
        for (const did of b.deletedDishIds) {
          demand(
            oldD.some((x) => x.id === did),
            400,
            'DISH_OWNER',
            '菜品不属于当前小家',
          );
          await tx.query('UPDATE dishes SET archived=true,version=version+1 WHERE id=$1', [did]);
        }
        for (const entry of b.recipes) {
          demand(
            b.dishes.some((d) => d.id === entry.id),
            400,
            'RECIPE_TARGET',
            '做法不在草稿菜单内',
          );
          const cid = cmap[entry.body.collectionId];
          demand(cid, 400, 'COLLECTION_REQUIRED', '请选择保留的合集');
          const existing = oldD.some((x) => x.id === entry.id);
          demand(
            existing || entry.id.startsWith('draft-'),
            400,
            'DISH_OWNER',
            '菜品不属于当前小家',
          );
          const saved = await saveDish(tx, r.user.id, fid, existing ? entry.id : null, {
            ...entry.body,
            collectionId: cid,
            collectionIds: (entry.body.collectionIds || [entry.body.collectionId]).map(
              (id) => cmap[id],
            ),
          });
          dmap[entry.id] = saved.id;
        }
        for (const [sort, d] of b.dishes.entries()) {
          const did = dmap[d.id] || d.id,
            cid = cmap[d.collectionId];
          demand(
            cid && (!d.collectionIds || d.collectionIds.includes(d.collectionId)),
            400,
            'COLLECTION_REQUIRED',
            '请先移动被删除合集中的菜品',
          );
          const out = await tx.query(
            'UPDATE dishes SET collection_id=$3,sort_order=$4,version=version+1 WHERE id=$1 AND family_id=$2 AND NOT archived RETURNING id',
            [did, fid, cid, sort],
          );
          demand(out.rows.length, 400, 'DISH_OWNER', '菜品不属于当前小家');
          await setDishCollections(
            tx,
            fid,
            did,
            (d.collectionIds || [d.collectionId]).map((id) => cmap[id]),
          );
        }
        const fallback = cmap[b.collections[0].id];
        for (const c of oldC)
          if (!Object.values(cmap).includes(c.id)) {
            await tx.query('UPDATE dishes SET collection_id=$2 WHERE collection_id=$1', [
              c.id,
              fallback,
            ]);
            await tx.query('DELETE FROM collections WHERE id=$1', [c.id]);
          }
        await tx.query('UPDATE families SET version=version+1 WHERE id=$1', [fid]);
        await audit(tx, r.user.id, fid, 'menu.save', fid);
        return { ok: true, collectionMap: cmap };
      }),
  );
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
        `SELECT d.*,ARRAY(SELECT dc.collection_id FROM dish_collections dc JOIN collections c ON c.id=dc.collection_id WHERE dc.dish_id=d.id ORDER BY c.sort_order,c.id) AS collection_ids FROM dishes d WHERE d.family_id=$1 AND NOT d.archived ORDER BY d.sort_order,d.id`,
        [r.params.familyId],
      )
    ).rows.map(publicDish);
    return {
      family: {
        id: m.family_id,
        name: m.name,
        role: m.role,
        identity: m.identity,
        memberCount: (
          await db.query('SELECT count(*)::int AS total FROM members WHERE family_id=$1', [
            m.family_id,
          ])
        ).rows[0].total,
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
          'SELECT count(*)::int AS n FROM dishes d JOIN dish_collections dc ON dc.dish_id=d.id WHERE dc.collection_id=$1 AND d.family_id=$2 AND NOT d.archived',
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
  const collectionIds = b.collectionIds || [b.collectionId];
  demand(collectionIds.includes(b.collectionId), 400, 'INVALID_COLLECTION', '主合集须在已选合集中');
  const categories = await validateCollections(tx, family, collectionIds);
  const meat = categories.some((c) => ['肉类', '肉禽', '荤菜'].includes(c.name));
  demand(!meat || !!b.meatType, 400, 'MEAT_TYPE', '请选择菜品的肉类小分类');
  const meatType = meat ? b.meatType : '';
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
      'UPDATE dishes SET name=$3,intro=$4,cover_id=$5,minutes=$6,servings=$7,collection_id=$8,featured=$10,spice_level=$11,meat_type=$12,version=version+1 WHERE id=$1 AND family_id=$2 AND version=$9 AND NOT archived RETURNING id',
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
        b.featured,
        b.spiceLevel,
        meatType,
      ],
    );
    demand(changed.rows.length, 409, 'DISH_VERSION', '菜品已经更新，请重新打开编辑');
  } else
    await tx.query(
      'INSERT INTO dishes(id,family_id,collection_id,name,intro,cover_id,minutes,servings,featured,spice_level,meat_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        did,
        family,
        b.collectionId,
        b.name,
        b.intro,
        b.coverId || null,
        b.minutes,
        b.servings,
        b.featured,
        b.spiceLevel,
        meatType,
      ],
    );
  await setDishCollections(tx, family, did, collectionIds);
  await tx.query(
    'INSERT INTO recipes(dish_id,ingredients,steps) VALUES($1,$2,$3) ON CONFLICT(dish_id) DO UPDATE SET ingredients=EXCLUDED.ingredients,steps=EXCLUDED.steps',
    [did, JSON.stringify(b.ingredients), JSON.stringify(b.steps)],
  );
  await tx.query('UPDATE families SET version=version+1 WHERE id=$1', [family]);
  await audit(tx, user, family, 'dish.save', did);
  return { id: did };
}

async function validateCollections(tx, family, ids) {
  demand(
    ids.length &&
      ids.every((id) => z.uuid().safeParse(id).success) &&
      new Set(ids).size === ids.length,
    400,
    'INVALID_COLLECTION',
    '请选择不重复的合集',
  );
  const rows = (
    await tx.query('SELECT id,name FROM collections WHERE family_id=$1 AND id=ANY($2::uuid[])', [
      family,
      ids,
    ])
  ).rows;
  demand(rows.length === ids.length, 400, 'INVALID_COLLECTION', '只能选择当前小家的合集');
  return rows;
}
export async function setDishCollections(tx, family, dish, ids) {
  const rows = await validateCollections(tx, family, ids);
  await tx.query('DELETE FROM dish_collections WHERE dish_id=$1', [dish]);
  for (const cid of ids)
    await tx.query(
      'INSERT INTO dish_collections(dish_id,collection_id,family_id) VALUES($1,$2,$3)',
      [dish, cid, family],
    );
  if (rows.some((c) => ['肉类', '肉禽', '荤菜'].includes(c.name)))
    await tx.query("UPDATE dishes SET meat_type='其他' WHERE id=$1 AND meat_type=''", [dish]);
}
