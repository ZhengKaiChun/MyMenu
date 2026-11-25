import { z } from 'zod';
import { id } from '../../core/security.mjs';
import { demand } from '../../core/errors.mjs';
import { mealDate, slot, ingredient, name } from '../../core/validation.mjs';

const sourceId = z.string().min(1).max(120);
const mediaId = z.uuid().nullable();
const inventory = z
  .object({
    name,
    quantity: z.number().min(0).max(100000),
    unit: z.string().trim().min(1).max(12),
    category: z.enum(['蔬菜', '肉类', '蛋奶', '主食', '调味', '其他']),
    meatType: z.enum(['', '猪', '鸡', '牛', '鱼', '海鲜', '其他']).default(''),
  })
  .strict();
const collection = z.object({ sourceId, name }).strict();
const dish = z
  .object({
    sourceId,
    name,
    intro: z.string().max(200),
    collectionIds: z.array(sourceId).min(1).max(100),
    coverId: mediaId,
    minutes: z.number().int().min(1).max(1440),
    servings: z.number().int().min(1).max(99),
    featured: z.boolean(),
    spiceLevel: z.number().int().min(1).max(3),
    meatType: z.enum(['', '猪', '鸡', '牛', '鱼', '海鲜', '其他']),
    ingredients: z.array(ingredient).max(100),
    steps: z.array(z.object({ text: z.string().max(3000), imageId: mediaId }).strict()).max(80),
  })
  .strict();
const history = z
  .object({
    date: mealDate,
    slot,
    name,
    coverId: mediaId,
    quantity: z.number().int().min(1).max(999),
    sources: z
      .array(
        z
          .object({
            identity: z.string().trim().min(1).max(24),
            quantity: z.number().int().min(1).max(99),
          })
          .strict(),
      )
      .max(30),
    cookerLabel: z.string().trim().min(1).max(24).nullable(),
  })
  .strict();
const family = z
  .object({
    sourceId,
    name,
    collections: z.array(collection).min(1).max(100),
    dishes: z.array(dish).max(250),
    inventory: z.array(inventory).max(250),
    history: z.array(history).max(2000),
  })
  .strict();

function distinct(values) {
  return new Set(values).size === values.length;
}
export function legacyImportRoutes(app, { db, route }) {
  route('GET', '/me/legacy-imports', null, async (r) => ({
    imports: (
      await db.query(
        'SELECT source_id,family_id,created_at FROM legacy_imports WHERE user_id=$1 ORDER BY created_at',
        [r.user.id],
      )
    ).rows,
  }));
  route(
    'POST',
    '/me/legacy-imports',
    family,
    async (r) =>
      db.transaction(async (tx) => {
        const b = r.body;
        demand(
          distinct(b.collections.map((x) => x.sourceId)) &&
            distinct(b.collections.map((x) => x.name)) &&
            distinct(b.dishes.map((x) => x.sourceId)),
          400,
          'LEGACY_DUPLICATE',
          '旧菜谱有重复的合集或菜品',
        );
        const existing = (
          await tx.query('SELECT family_id FROM legacy_imports WHERE user_id=$1 AND source_id=$2', [
            r.user.id,
            b.sourceId,
          ])
        ).rows[0];
        if (existing) return { id: existing.family_id, alreadyImported: true };
        const oldIds = new Set(b.collections.map((x) => x.sourceId));
        demand(
          b.dishes.every(
            (d) =>
              d.collectionIds.length &&
              distinct(d.collectionIds) &&
              d.collectionIds.every((c) => oldIds.has(c)),
          ),
          400,
          'LEGACY_COLLECTION',
          '旧菜品所属合集不完整',
        );
        const mids = [
          ...new Set(
            [
              ...b.dishes.flatMap((d) => [d.coverId, ...d.steps.map((s) => s.imageId)]),
              ...b.history.map((h) => h.coverId),
            ].filter(Boolean),
          ),
        ];
        if (mids.length) {
          const owned = (
            await tx.query('SELECT id FROM media WHERE owner_id=$1 AND id=ANY($2::uuid[])', [
              r.user.id,
              mids,
            ])
          ).rows;
          demand(owned.length === mids.length, 400, 'LEGACY_MEDIA', '有图片尚未上传，请重新导入');
        }
        const fid = id();
        await tx.query('INSERT INTO families(id,name,owner_id) VALUES($1,$2,$3)', [
          fid,
          b.name,
          r.user.id,
        ]);
        await tx.query("INSERT INTO members(family_id,user_id,role) VALUES($1,$2,'cook')", [
          fid,
          r.user.id,
        ]);
        const cmap = new Map();
        for (const [index, c] of b.collections.entries()) {
          const cid = id();
          cmap.set(c.sourceId, cid);
          await tx.query(
            'INSERT INTO collections(id,family_id,name,sort_order) VALUES($1,$2,$3,$4)',
            [cid, fid, c.name, index],
          );
        }
        for (const [index, d] of b.dishes.entries()) {
          const did = id(),
            primary = cmap.get(d.collectionIds[0]);
          await tx.query(
            'INSERT INTO dishes(id,family_id,collection_id,name,intro,cover_id,minutes,servings,sort_order,featured,spice_level,meat_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [
              did,
              fid,
              primary,
              d.name,
              d.intro,
              d.coverId,
              d.minutes,
              d.servings,
              index,
              d.featured,
              d.spiceLevel,
              d.meatType,
            ],
          );
          for (const cid of d.collectionIds)
            await tx.query(
              'INSERT INTO dish_collections(dish_id,collection_id,family_id) VALUES($1,$2,$3)',
              [did, cmap.get(cid), fid],
            );
          await tx.query('INSERT INTO recipes(dish_id,ingredients,steps) VALUES($1,$2,$3)', [
            did,
            JSON.stringify(d.ingredients),
            JSON.stringify(d.steps),
          ]);
        }
        for (const i of b.inventory)
          await tx.query(
            'INSERT INTO inventories(id,family_id,name,quantity,unit,category,meat_type) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(family_id,name,unit) WHERE family_id IS NOT NULL DO UPDATE SET quantity=EXCLUDED.quantity,category=EXCLUDED.category,meat_type=EXCLUDED.meat_type',
            [
              id(),
              fid,
              i.name,
              i.quantity,
              i.unit,
              i.category,
              i.category === '肉类' ? i.meatType || '其他' : '',
            ],
          );
        for (const h of b.history) {
          const valid = (
            await tx.query(
              "SELECT $1::date <= (now() AT TIME ZONE 'Asia/Shanghai')::date+interval '90 days' AND $1::date >= (now() AT TIME ZONE 'Asia/Shanghai')::date-interval '3 months' AS ok",
              [h.date],
            )
          ).rows[0].ok;
          if (!valid) continue;
          await tx.query(
            'INSERT INTO legacy_history(id,family_id,meal_date,slot,dish_name,cover_id,quantity,sources,cooker_label) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              id(),
              fid,
              h.date,
              h.slot,
              h.name,
              h.coverId,
              h.quantity,
              JSON.stringify(h.sources),
              h.cookerLabel,
            ],
          );
        }
        await tx.query('INSERT INTO legacy_imports(user_id,source_id,family_id) VALUES($1,$2,$3)', [
          r.user.id,
          b.sourceId,
          fid,
        ]);
        return {
          id: fid,
          alreadyImported: false,
          dishes: b.dishes.length,
          history: b.history.length,
        };
      }),
    { authLimit: true },
  );
}
