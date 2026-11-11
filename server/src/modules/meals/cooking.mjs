import { z } from 'zod';
import { id } from '../../core/security.mjs';
import { member, familyLock, notify, today } from '../../core/policy.mjs';
import { demand } from '../../core/errors.mjs';
import { mealDate, slot } from '../../core/validation.mjs';
const keyWhere = 'family_id=$1 AND meal_date=$2 AND slot=$3 AND dish_id=$4';
export async function claimCooking(tx, fid, user, b) {
  await member(tx, user, fid, 'cook');
  const valid = (
    await tx.query(
      "SELECT $1::date BETWEEN (now() AT TIME ZONE 'Asia/Shanghai')::date-interval '3 months' AND (now() AT TIME ZONE 'Asia/Shanghai')::date AS ok",
      [b.date],
    )
  ).rows[0].ok;
  demand(valid, 400, 'COOK_DATE', '只能确认今天或最近三个月的已过日期');
  demand(b.done || b.date === today(), 409, 'DAY_CLOSED', '已过日期不能取消认领');
  const keys = [fid, b.date, b.slot, b.dishId];
  const dish = (
    await tx.query(
      "SELECT l.id FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.family_id=$1 AND o.meal_date=$2 AND o.slot=$3 AND l.dish_id=$4 AND o.status='accepted' LIMIT 1",
      keys,
    )
  ).rows[0];
  demand(dish, 404, 'COOK_MENU', '这道菜不在该餐最终菜单中');
  const owner = (await tx.query('SELECT user_id FROM cooking_records WHERE ' + keyWhere, keys))
    .rows[0];
  demand(
    !owner || owner.user_id === user,
    409,
    'COOK_CLAIMED',
    '已有其他饲养员确认，这条提醒已失效',
  );
  if (b.done) {
    await tx.query(
      'INSERT INTO cooking_records(family_id,user_id,meal_date,slot,dish_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [fid, user, b.date, b.slot, b.dishId],
    );
    await tx.query(
      "UPDATE notifications SET invalidated_at=now(),read_at=COALESCE(read_at,now()),delivery_status=CASE WHEN delivery_status IN('pending','failed') THEN 'skipped' ELSE delivery_status END WHERE type='cooking.reminder' AND entity_id IN(SELECT id FROM cooking_reminders WHERE " +
        keyWhere +
        ')',
      keys,
    );
  } else
    await tx.query('DELETE FROM cooking_records WHERE ' + keyWhere + ' AND user_id=$5', [
      ...keys,
      user,
    ]);
  await tx.query(
    "UPDATE order_lines l SET done=$5 FROM orders o WHERE l.order_id=o.id AND o.family_id=$1 AND o.meal_date=$2 AND o.slot=$3 AND l.dish_id=$4 AND o.status='accepted'",
    [...keys, b.done],
  );
  return { ok: true, done: b.done };
}
export async function queueCookingReminders(db, user = null) {
  const rows = (
    await db.query(
      `SELECT DISTINCT o.family_id FROM orders o JOIN order_lines l ON l.order_id=o.id JOIN families f ON f.id=o.family_id WHERE f.deleted_at IS NULL AND o.status='accepted' AND o.meal_date<(now() AT TIME ZONE 'Asia/Shanghai')::date AND o.meal_date>=(now() AT TIME ZONE 'Asia/Shanghai')::date-interval '3 months' AND ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM members m WHERE m.family_id=o.family_id AND m.user_id=$1 AND m.role='cook')) AND NOT EXISTS(SELECT 1 FROM cooking_records c WHERE c.family_id=o.family_id AND c.meal_date=o.meal_date AND c.slot=o.slot AND c.dish_id=l.dish_id) AND NOT EXISTS(SELECT 1 FROM cooking_reminders r WHERE r.family_id=o.family_id AND r.meal_date=o.meal_date AND r.slot=o.slot AND r.dish_id=l.dish_id) ORDER BY o.family_id`,
      [user],
    )
  ).rows;
  for (const { family_id: fid } of rows)
    await db.transaction(async (tx) => {
      await familyLock(tx, fid);
      if (
        !(await tx.query('SELECT id FROM families WHERE id=$1 AND deleted_at IS NULL', [fid])).rows
          .length
      )
        return;
      const dishes = (
        await tx.query(
          `SELECT DISTINCT o.meal_date::text AS date,o.slot,l.dish_id,l.snapshot->>'name' AS name FROM orders o JOIN order_lines l ON l.order_id=o.id WHERE o.family_id=$1 AND o.status='accepted' AND o.meal_date<(now() AT TIME ZONE 'Asia/Shanghai')::date AND o.meal_date>=(now() AT TIME ZONE 'Asia/Shanghai')::date-interval '3 months' AND NOT EXISTS(SELECT 1 FROM cooking_records c WHERE c.family_id=o.family_id AND c.meal_date=o.meal_date AND c.slot=o.slot AND c.dish_id=l.dish_id)`,
          [fid],
        )
      ).rows;
      for (const d of dishes) {
        const rid = id(),
          inserted = await tx.query(
            'INSERT INTO cooking_reminders(id,family_id,meal_date,slot,dish_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
            [rid, fid, d.date, d.slot, d.dish_id],
          );
        if (inserted.rows.length)
          await notify(
            tx,
            fid,
            'cooking.reminder',
            rid,
            d.date + ' · ' + d.slot + '的' + d.name + '，是你做的吗？',
          );
      }
    });
}
export function cookingRoutes(app, { db, route }) {
  route(
    'POST',
    '/families/:familyId/cooking-claims',
    z.object({ date: mealDate, slot, dishId: z.uuid(), done: z.boolean() }).strict(),
    async (r) =>
      db.transaction(async (tx) => {
        await familyLock(tx, r.params.familyId);
        return claimCooking(tx, r.params.familyId, r.user.id, r.body);
      }),
  );
  route('GET', '/families/:familyId/cooking-reminders/:id', null, async (r) => {
    await member(db, r.user.id, r.params.familyId, 'cook');
    const rem = (
      await db.query(
        'SELECT *,meal_date::text AS date FROM cooking_reminders WHERE id=$1 AND family_id=$2',
        [r.params.id, r.params.familyId],
      )
    ).rows[0];
    demand(rem, 410, 'COOK_REMINDER_EXPIRED', '这条提醒已失效');
    const keys = [rem.family_id, rem.date, rem.slot, rem.dish_id];
    const dish = (
      await db.query(
        "SELECT l.snapshot FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.family_id=$1 AND o.meal_date=$2 AND o.slot=$3 AND l.dish_id=$4 AND o.status='accepted' LIMIT 1",
        keys,
      )
    ).rows[0];
    demand(dish, 410, 'COOK_REMINDER_EXPIRED', '菜单已不存在');
    const owner =
      (
        await db.query(
          'SELECT c.user_id AS "userId",u.nickname,COALESCE(m.identity,\'野生小猪\') AS identity FROM cooking_records c JOIN users u ON u.id=c.user_id LEFT JOIN members m ON m.family_id=c.family_id AND m.user_id=c.user_id WHERE c.family_id=$1 AND c.meal_date=$2 AND c.slot=$3 AND c.dish_id=$4',
          keys,
        )
      ).rows[0] || null;
    return {
      id: rem.id,
      date: rem.date,
      slot: rem.slot,
      dishId: rem.dish_id,
      name: dish.snapshot.name,
      coverId: dish.snapshot.coverId,
      cooker: owner,
      claimable: !owner,
    };
  });
}

export async function syncCompletedLines(tx, orderId) {
  await tx.query(
    "UPDATE order_lines l SET done=true FROM orders o WHERE l.order_id=o.id AND o.id=$1 AND o.status='accepted' AND EXISTS(SELECT 1 FROM cooking_records c WHERE c.family_id=o.family_id AND c.meal_date=o.meal_date AND c.slot=o.slot AND c.dish_id=l.dish_id)",
    [orderId],
  );
}
