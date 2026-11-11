import { z } from 'zod';
import { id } from '../../core/security.mjs';
import { member, familyLock } from '../../core/policy.mjs';
import { demand } from '../../core/errors.mjs';
import { mealDate } from '../../core/validation.mjs';
const item = z
  .object({
    name: z.string().trim().min(1).max(40),
    quantity: z.number().min(0).max(100000),
    unit: z.string().trim().min(1).max(12),
    category: z.string().max(20).default('其他'),
  })
  .strict();
export function inventoryRoutes(app, { db, route }) {
  for (const scope of ['personal', 'family']) {
    const path = scope === 'personal' ? '/inventory' : '/families/:familyId/inventory';
    const column = scope === 'personal' ? 'user_id' : 'family_id';
    route('GET', path, null, async (r) => {
      if (scope === 'family') await member(db, r.user.id, r.params.familyId);
      return (
        await db.query(`SELECT * FROM inventories WHERE ${column}=$1 ORDER BY category,name`, [
          scope === 'personal' ? r.user.id : r.params.familyId,
        ])
      ).rows;
    });
    route('POST', path, item, async (r) =>
      db.transaction(async (tx) => {
        if (scope === 'family') {
          await familyLock(tx, r.params.familyId);
          await member(tx, r.user.id, r.params.familyId);
        }
        const owner = scope === 'personal' ? r.user.id : r.params.familyId;
        const out = await tx.query(
          `INSERT INTO inventories(id,${column},name,quantity,unit,category) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(${column},name,unit) WHERE ${column} IS NOT NULL DO UPDATE SET quantity=EXCLUDED.quantity,category=EXCLUDED.category,version=inventories.version+1 RETURNING id`,
          [id(), owner, r.body.name, r.body.quantity, r.body.unit, r.body.category],
        );
        return out.rows[0];
      }),
    );
    route(
      'PUT',
      path + '/:id',
      item.extend({ version: z.number().int().positive() }).strict(),
      async (r) =>
        db.transaction(async (tx) => {
          if (scope === 'family') {
            await familyLock(tx, r.params.familyId);
            await member(tx, r.user.id, r.params.familyId);
          }
          let out = await tx.query(
            `UPDATE inventories SET name=$3,quantity=$4,unit=$5,category=$6,version=version+1 WHERE id=$1 AND ${column}=$2 AND version=$7 RETURNING id`,
            [
              r.params.id,
              scope === 'personal' ? r.user.id : r.params.familyId,
              r.body.name,
              r.body.quantity,
              r.body.unit,
              r.body.category,
              r.body.version,
            ],
          );
          demand(out.rows.length, 409, 'INVENTORY_VERSION', '食材已变化，请刷新后重新编辑');
          return { ok: true };
        }),
    );
    route('DELETE', path + '/:id', null, async (r) =>
      db.transaction(async (tx) => {
        if (scope === 'family') {
          await familyLock(tx, r.params.familyId);
          await member(tx, r.user.id, r.params.familyId);
        }
        await tx.query(`DELETE FROM inventories WHERE id=$1 AND ${column}=$2`, [
          r.params.id,
          scope === 'personal' ? r.user.id : r.params.familyId,
        ]);
        return { ok: true };
      }),
    );
  }
  route(
    'POST',
    '/families/:familyId/inventory/import',
    z.object({ ids: z.array(z.uuid()).max(200) }).strict(),
    async (r) =>
      db.transaction(async (tx) => {
        await familyLock(tx, r.params.familyId);
        await member(tx, r.user.id, r.params.familyId);
        for (const iid of r.body.ids) {
          let i = (
            await tx.query('SELECT * FROM inventories WHERE id=$1 AND user_id=$2', [iid, r.user.id])
          ).rows[0];
          demand(i, 400, 'INVENTORY_OWNER', '只能导入你自己的个人食材');
          await tx.query(
            'INSERT INTO inventories(id,family_id,name,quantity,unit,category) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(family_id,name,unit) WHERE family_id IS NOT NULL DO NOTHING',
            [id(), r.params.familyId, i.name, i.quantity, i.unit, i.category],
          );
        }
        return { ok: true };
      }),
  );
  route('GET', '/families/:familyId/prep', null, async (r) => {
    await member(db, r.user.id, r.params.familyId, 'cook');
    const date = mealDate.parse(r.query.date),
      rows = (
        await db.query(
          "SELECT l.quantity,l.snapshot FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.family_id=$1 AND o.meal_date=$2 AND o.status='accepted'",
          [r.params.familyId, date],
        )
      ).rows,
      inventory = (
        await db.query('SELECT name,unit FROM inventories WHERE family_id=$1', [r.params.familyId])
      ).rows,
      checks = (
        await db.query('SELECT * FROM prep_checks WHERE family_id=$1 AND meal_date=$2', [
          r.params.familyId,
          date,
        ])
      ).rows;
    let map = new Map();
    for (const l of rows)
      for (const ing of l.snapshot.ingredients) {
        let key = ing.name + '|' + ing.unit;
        if (!map.has(key))
          map.set(key, { name: ing.name, unit: ing.unit, quantity: 0, sources: [] });
        let v = map.get(key);
        v.quantity += ing.quantity * l.quantity;
        if (!v.sources.includes(l.snapshot.name)) v.sources.push(l.snapshot.name);
      }
    return [...map.values()].map((i) => ({
      ...i,
      owned: inventory.some((v) => v.name === i.name && v.unit === i.unit),
      checked:
        checks.find((v) => v.name === i.name && v.unit === i.unit)?.checked ??
        inventory.some((v) => v.name === i.name && v.unit === i.unit),
    }));
  });
  route(
    'PUT',
    '/families/:familyId/prep',
    z
      .object({
        date: mealDate,
        items: z
          .array(
            z
              .object({ name: z.string().max(40), unit: z.string().max(12), checked: z.boolean() })
              .strict(),
          )
          .max(500),
      })
      .strict(),
    async (r) =>
      db.transaction(async (tx) => {
        await familyLock(tx, r.params.familyId);
        await member(tx, r.user.id, r.params.familyId);
        for (const i of r.body.items)
          await tx.query(
            'INSERT INTO prep_checks(family_id,meal_date,name,unit,checked) VALUES($1,$2,$3,$4,$5) ON CONFLICT(family_id,meal_date,name,unit) DO UPDATE SET checked=EXCLUDED.checked',
            [r.params.familyId, r.body.date, i.name, i.unit, i.checked],
          );
        return { ok: true };
      }),
  );
  route('GET', '/families/:familyId/match', null, async (r) => {
    await member(db, r.user.id, r.params.familyId, 'cook');
    let names = String(r.query.ingredients || '')
      .split(/[,+，、]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (!names.length)
      names = (
        await db.query('SELECT name FROM inventories WHERE family_id=$1', [r.params.familyId])
      ).rows.map((x) => x.name);
    let recipes = (
      await db.query(
        'SELECT d.id,d.name,d.cover_id,r.ingredients FROM dishes d JOIN recipes r ON r.dish_id=d.id WHERE d.family_id=$1 AND NOT d.archived',
        [r.params.familyId],
      )
    ).rows;
    return recipes
      .map((d) => ({
        id: d.id,
        name: d.name,
        coverId: d.cover_id,
        matched: d.ingredients.filter((i) => names.includes(i.name)).length,
        missing: d.ingredients.filter((i) => !names.includes(i.name)).map((i) => i.name),
      }))
      .filter((d) => d.matched)
      .sort((a, b) => b.matched - a.matched);
  });
}
