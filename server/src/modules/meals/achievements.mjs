import { z } from 'zod';
import { member, familyLock } from '../../core/policy.mjs';
import { demand } from '../../core/errors.mjs';
import { mealDate, slot } from '../../core/validation.mjs';
export function achievementRoutes(app, { db, route }) {
  route('GET', '/me/achievements', null, async (r) => {
    const rows = (
      await db.query(
        `SELECT f.id,f.name,m.role,
    COALESCE(a.cooked_archived,0)+(SELECT count(*) FROM cooking_records cr WHERE cr.user_id=$1 AND cr.family_id=f.id) AS cooked,
    COALESCE(a.ordered_archived,0)+(SELECT COALESCE(sum(l.quantity),0) FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.user_id=$1 AND o.family_id=f.id AND o.status='accepted') AS ordered
    FROM families f JOIN members m ON m.family_id=f.id AND m.user_id=$1 LEFT JOIN achievement_totals a ON a.family_id=f.id AND a.user_id=$1 WHERE f.deleted_at IS NULL ORDER BY m.joined_at,f.id`,
        [r.user.id],
      )
    ).rows.map((x) => ({ ...x, cooked: Number(x.cooked), ordered: Number(x.ordered) }));
    return {
      cooked: rows.reduce((n, x) => n + x.cooked, 0),
      ordered: rows.reduce((n, x) => n + x.ordered, 0),
      families: rows,
    };
  });
  route('GET', '/families/:familyId/cooking-records', null, async (r) => {
    await member(db, r.user.id, r.params.familyId, 'cook');
    const date = mealDate.parse(r.query.date),
      s = slot.parse(r.query.slot);
    return {
      dishIds: (
        await db.query(
          'SELECT dish_id FROM cooking_records WHERE family_id=$1 AND user_id=$2 AND meal_date=$3 AND slot=$4',
          [r.params.familyId, r.user.id, date, s],
        )
      ).rows.map((x) => x.dish_id),
    };
  });
  route(
    'PUT',
    '/families/:familyId/cooking-records',
    z.object({ date: mealDate, slot, dishIds: z.array(z.uuid()).max(100) }).strict(),
    async (r) =>
      db.transaction(async (tx) => {
        const fid = r.params.familyId,
          b = r.body;
        await familyLock(tx, fid);
        await member(tx, r.user.id, fid, 'cook');
        demand(new Set(b.dishIds).size === b.dishIds.length, 400, 'DUPLICATE_DISH', '菜品重复');
        const valid = (
          await tx.query(
            "SELECT $1::date BETWEEN (now() AT TIME ZONE 'Asia/Shanghai')::date-interval '3 months' AND (now() AT TIME ZONE 'Asia/Shanghai')::date AS ok",
            [b.date],
          )
        ).rows[0].ok;
        demand(valid, 400, 'COOK_DATE', '只能记录今天及最近三个月已过去的餐次');
        const menu = (
          await tx.query(
            "SELECT DISTINCT l.dish_id FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.family_id=$1 AND o.meal_date=$2 AND o.slot=$3 AND o.status='accepted'",
            [fid, b.date, b.slot],
          )
        ).rows.map((x) => x.dish_id);
        demand(
          b.dishIds.every((id) => menu.includes(id)),
          400,
          'COOK_MENU',
          '只能记录该餐次已安排的菜',
        );
        await tx.query(
          'DELETE FROM cooking_records WHERE family_id=$1 AND user_id=$2 AND meal_date=$3 AND slot=$4',
          [fid, r.user.id, b.date, b.slot],
        );
        for (const did of b.dishIds)
          await tx.query(
            'INSERT INTO cooking_records(family_id,user_id,meal_date,slot,dish_id) VALUES($1,$2,$3,$4,$5)',
            [fid, r.user.id, b.date, b.slot, did],
          );
        return { ok: true, count: b.dishIds.length };
      }),
  );
}
export async function archiveAchievements(tx, cutoff) {
  const rows = (
    await tx.query(
      `SELECT family_id FROM orders WHERE meal_date<${cutoff} UNION SELECT family_id FROM cooking_records WHERE meal_date<${cutoff} ORDER BY family_id`,
    )
  ).rows;
  for (const { family_id: fid } of rows) {
    await familyLock(tx, fid);
    if (
      !(await tx.query('SELECT id FROM families WHERE id=$1 AND deleted_at IS NULL', [fid])).rows
        .length
    )
      continue;
    await tx.query(
      `INSERT INTO achievement_totals(user_id,family_id,ordered_archived) SELECT o.user_id,o.family_id,sum(l.quantity) FROM orders o JOIN order_lines l ON l.order_id=o.id WHERE o.family_id=$1 AND o.status='accepted' AND o.user_id IN(SELECT id FROM users WHERE deleted_at IS NULL) AND o.meal_date<${cutoff} GROUP BY o.user_id,o.family_id ON CONFLICT(user_id,family_id) DO UPDATE SET ordered_archived=achievement_totals.ordered_archived+EXCLUDED.ordered_archived`,
      [fid],
    );
    await tx.query(
      `INSERT INTO achievement_totals(user_id,family_id,cooked_archived) SELECT user_id,family_id,count(*) FROM cooking_records WHERE family_id=$1 AND user_id IN(SELECT id FROM users WHERE deleted_at IS NULL) AND meal_date<${cutoff} GROUP BY user_id,family_id ON CONFLICT(user_id,family_id) DO UPDATE SET cooked_archived=achievement_totals.cooked_archived+EXCLUDED.cooked_archived`,
      [fid],
    );
  }
  await tx.query(`DELETE FROM cooking_records WHERE meal_date<${cutoff}`);
}
