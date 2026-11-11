import { member, familyLock } from '../../core/policy.mjs';
import { demand } from '../../core/errors.mjs';
import { mealDate, slot } from '../../core/validation.mjs';
export function achievementRoutes(app, { db, route }) {
  route('GET', '/me/achievements', null, async (r) => {
    const rows = (
      await db.query(
        `SELECT f.id,f.name,m.role,
    COALESCE(a.cooked_archived,0)+(SELECT count(*) FROM cooking_records cr WHERE cr.user_id=$1 AND cr.family_id=f.id AND cr.meal_date<(now() AT TIME ZONE 'Asia/Shanghai')::date) AS cooked,
    COALESCE(a.ordered_archived,0)+(SELECT COALESCE(sum(l.quantity),0) FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.user_id=$1 AND o.family_id=f.id AND o.status='accepted' AND o.meal_date<(now() AT TIME ZONE 'Asia/Shanghai')::date) AS ordered
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
  route('PUT', '/families/:familyId/cooking-records', null, async () => {
    demand(false, 410, 'COOK_FLOW_CHANGED', '请在当日菜单逐道勾选已做完');
  });
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
