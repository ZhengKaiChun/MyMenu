import { claimCooking, syncCompletedLines } from './cooking.mjs';
import { z } from 'zod';
import { id } from '../../core/security.mjs';
import { member, familyLock, atomic, notify, audit, dateAllowed } from '../../core/policy.mjs';
import { demand } from '../../core/errors.mjs';
import { mealDate, slot, note, decision } from '../../core/validation.mjs';
import { recipeSnapshot } from '../recipes/routes.mjs';
export function mealRoutes(app, { db, route }) {
  route(
    'POST',
    '/families/:familyId/orders',
    z
      .object({
        date: mealDate,
        slot,
        note,
        items: z
          .array(z.object({ dishId: z.uuid(), quantity: z.number().int().min(1).max(99) }).strict())
          .min(1)
          .max(50),
      })
      .strict(),
    async (r) =>
      atomic(
        db,
        r.user.id,
        r.headers['idempotency-key'],
        'order.create:' + r.params.familyId,
        r.body,
        async (tx) => {
          await familyLock(tx, r.params.familyId);
          const m = await member(tx, r.user.id, r.params.familyId);
          demand(dateAllowed(r.body.date), 400, 'MEAL_DATE', '请选择今天起90天内的日期');
          demand(
            new Set(r.body.items.map((x) => x.dishId)).size === r.body.items.length,
            400,
            'DUPLICATE_DISH',
            '同道菜请合并份数',
          );
          const oid = id(),
            status = m.role === 'cook' ? 'accepted' : 'pending';
          await tx.query(
            'INSERT INTO orders(id,family_id,user_id,meal_date,slot,status,note) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [oid, m.family_id, r.user.id, r.body.date, r.body.slot, status, r.body.note],
          );
          for (const item of r.body.items) {
            const dish = (
              await tx.query(
                'SELECT id FROM dishes WHERE id=$1 AND family_id=$2 AND NOT archived',
                [item.dishId, m.family_id],
              )
            ).rows[0];
            demand(dish, 400, 'DISH_UNAVAILABLE', '菜篮中有菜品已下架，请重新选菜');
            const snapshot = await recipeSnapshot(tx, dish.id);
            await tx.query(
              'INSERT INTO order_lines(id,order_id,dish_id,quantity,snapshot) VALUES($1,$2,$3,$4,$5)',
              [id(), oid, dish.id, item.quantity, JSON.stringify(snapshot)],
            );
          }
          await syncCompletedLines(tx, oid);
          if (status === 'pending')
            await notify(tx, m.family_id, 'order.pending', oid, '您小猪发来了一条吃饭申请');
          await notify(
            tx,
            m.family_id,
            'order.sent',
            oid,
            status === 'pending' ? '心愿已寄出，等饲养员回音' : '这顿安排啦，已加入全家菜单',
            [r.user.id],
          );
          await audit(tx, r.user.id, m.family_id, 'order.create', oid);
          return { id: oid, status };
        },
      ),
  );
  route('GET', '/families/:familyId/orders', null, async (r) => {
    const m = await member(db, r.user.id, r.params.familyId);
    const rows = (
      await db.query(
        `SELECT o.*,u.nickname,m.identity FROM orders o JOIN users u ON u.id=o.user_id JOIN members m ON m.family_id=o.family_id AND m.user_id=o.user_id WHERE o.family_id=$1 ${m.role === 'eater' ? 'AND o.user_id=$2' : ''} ORDER BY o.created_at DESC LIMIT 100`,
        m.role === 'eater' ? [m.family_id, r.user.id] : [m.family_id],
      )
    ).rows;
    return Promise.all(
      rows.map(async (o) => ({
        ...o,
        items: (
          await db.query(
            'SELECT id,dish_id,quantity,snapshot,done FROM order_lines WHERE order_id=$1',
            [o.id],
          )
        ).rows.map((l) => ({ ...l, snapshot: publicSnapshot(l.snapshot) })),
      })),
    );
  });
  route(
    'POST',
    '/families/:familyId/orders/:id/reply',
    z.object({ decision, reply: note }).strict(),
    async (r) =>
      atomic(
        db,
        r.user.id,
        r.headers['idempotency-key'],
        'order.reply:' + r.params.id,
        r.body,
        async (tx) => {
          await familyLock(tx, r.params.familyId);
          await member(tx, r.user.id, r.params.familyId, 'cook');
          const o = (
            await tx.query(
              'SELECT *,meal_date::text AS date FROM orders WHERE id=$1 AND family_id=$2 FOR UPDATE',
              [r.params.id, r.params.familyId],
            )
          ).rows[0];
          demand(o && o.status === 'pending', 409, 'ORDER_RESOLVED', '这份点菜已处理');
          demand(dateAllowed(o.date), 409, 'DAY_CLOSED', '这一天已经结束，菜单已结算');
          const c = (
            await tx.query(
              "SELECT c.id FROM changes c JOIN order_lines l ON l.id=c.line_id WHERE l.order_id=$1 AND c.status='pending'",
              [o.id],
            )
          ).rows;
          demand(!c.length, 409, 'PENDING_CHANGE', '请先处理这份点菜的换菜申请');
          await tx.query('UPDATE orders SET status=$2,reply=$3,version=version+1 WHERE id=$1', [
            o.id,
            r.body.decision === 'accept' ? 'accepted' : 'rejected',
            r.body.reply,
          ]);
          await syncCompletedLines(tx, o.id);
          await notify(
            tx,
            o.family_id,
            'order.reply',
            o.id,
            r.body.reply || '饲养员回复了你的点菜',
            [o.user_id],
          );
          return { ok: true };
        },
      ),
  );
  route('POST', '/families/:familyId/orders/:id/cancel', z.object({}).strict(), async (r) =>
    db.transaction(async (tx) => {
      await familyLock(tx, r.params.familyId);
      await member(tx, r.user.id, r.params.familyId);
      const out = await tx.query(
        "UPDATE orders SET status='cancelled',version=version+1 WHERE id=$1 AND family_id=$2 AND user_id=$3 AND status='pending' RETURNING id",
        [r.params.id, r.params.familyId, r.user.id],
      );
      demand(out.rows.length, 409, 'ORDER_NOT_PENDING', '只能撤回自己待回复的点菜');
      await tx.query(
        "UPDATE changes SET status='cancelled' WHERE line_id IN(SELECT id FROM order_lines WHERE order_id=$1) AND status='pending'",
        [r.params.id],
      );
      return { ok: true };
    }),
  );
  route('GET', '/families/:familyId/meal-dates', null, async (r) => {
    await member(db, r.user.id, r.params.familyId);
    const from = mealDate.parse(r.query.from),
      to = mealDate.parse(r.query.to);
    demand(
      from <= to && new Date(to) - new Date(from) <= 93 * 86400000,
      400,
      'DATE_RANGE',
      '日期范围不能超过三个月',
    );
    return (
      await db.query(
        "SELECT DISTINCT o.meal_date::text AS date FROM orders o JOIN order_lines l ON l.order_id=o.id WHERE o.family_id=$1 AND o.status='accepted' AND o.meal_date BETWEEN $2 AND $3 AND ($4::boolean=false OR l.done OR o.meal_date < (now() AT TIME ZONE 'Asia/Shanghai')::date) AND ($5::boolean=false OR (o.meal_date < (now() AT TIME ZONE 'Asia/Shanghai')::date AND o.meal_date >= (now() AT TIME ZONE 'Asia/Shanghai')::date-interval '3 months')) ORDER BY date",
        [r.params.familyId, from, to, r.query.done === '1', r.query.history === '1'],
      )
    ).rows.map((x) => ({
      date: String(x.date instanceof Date ? x.date.toISOString() : x.date).slice(0, 10),
    }));
  });
  for (const endpoint of ['meals', 'history']) {
    route('GET', '/families/:familyId/' + endpoint, null, async (r) => {
      await member(db, r.user.id, r.params.familyId);
      const date = mealDate.parse(r.query.date);
      let lines = (
        await db.query(
          "SELECT l.id,l.dish_id,l.quantity,l.done,l.snapshot,o.id AS order_id,o.slot,o.user_id,u.nickname,m.identity,u.avatar_id FROM order_lines l JOIN orders o ON o.id=l.order_id JOIN users u ON u.id=o.user_id LEFT JOIN members m ON m.family_id=o.family_id AND m.user_id=o.user_id WHERE o.family_id=$1 AND o.meal_date=$2 AND o.status='accepted' AND ($3::boolean=false OR (o.meal_date < (now() AT TIME ZONE 'Asia/Shanghai')::date AND o.meal_date >= (now() AT TIME ZONE 'Asia/Shanghai')::date-interval '3 months')) ORDER BY o.created_at",
          [r.params.familyId, date, endpoint === 'history'],
        )
      ).rows;
      let grouped = new Map();
      for (const l of lines) {
        let key = l.slot + ':' + l.dish_id;
        if (!grouped.has(key))
          grouped.set(key, {
            dishId: l.dish_id,
            slot: l.slot,
            snapshot: publicSnapshot(l.snapshot),
            quantity: 0,
            sources: [],
          });
        let g = grouped.get(key);
        g.quantity += l.quantity;
        g.sources.push({
          id: l.id,
          quantity: l.quantity,
          userId: l.user_id,
          nickname: l.nickname,
          identity: l.identity || '野生小猪',
          avatarId: l.avatar_id,
          done: l.done,
        });
      }
      const claims = (
        await db.query(
          'SELECT c.dish_id,c.slot,c.user_id AS "userId",u.nickname,COALESCE(m.identity,\'野生小猪\') AS identity FROM cooking_records c JOIN users u ON u.id=c.user_id LEFT JOIN members m ON m.family_id=c.family_id AND m.user_id=c.user_id WHERE c.family_id=$1 AND c.meal_date=$2',
          [r.params.familyId, date],
        )
      ).rows;
      return {
        date,
        dishes: [...grouped.values()].map((d) => ({
          ...d,
          cooker: claims.find((c) => c.dish_id === d.dishId && c.slot === d.slot) || null,
        })),
      };
    });
  }
  route('POST', '/families/:familyId/lines/:id/done', z.object({}).strict(), async (r) =>
    db.transaction(async (tx) => {
      await familyLock(tx, r.params.familyId);
      await member(tx, r.user.id, r.params.familyId, 'cook');
      const row = (
        await tx.query(
          "SELECT o.meal_date::text AS date,o.slot,l.dish_id FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE l.id=$1 AND o.family_id=$2 AND o.status='accepted'",
          [r.params.id, r.params.familyId],
        )
      ).rows[0];
      demand(row, 404, 'LINE_NOT_FOUND', '找不到这道已安排的菜');
      return claimCooking(tx, r.params.familyId, r.user.id, {
        date: row.date,
        slot: row.slot,
        dishId: row.dish_id,
        done: true,
      });
    }),
  );
  route('GET', '/families/:familyId/my-lines', null, async (r) => {
    await member(db, r.user.id, r.params.familyId);
    return (
      await db.query(
        "SELECT l.id,l.dish_id,l.quantity,l.done,l.snapshot,o.meal_date,o.slot,o.status,o.version FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.family_id=$1 AND o.user_id=$2 AND o.status IN('pending','accepted') AND o.meal_date>=(now() AT TIME ZONE 'Asia/Shanghai')::date AND NOT l.done ORDER BY o.meal_date",
        [r.params.familyId, r.user.id],
      )
    ).rows.map((l) => ({ ...l, snapshot: publicSnapshot(l.snapshot) }));
  });
}
export function publicSnapshot(d) {
  return {
    id: d.id,
    name: d.name,
    intro: d.intro,
    coverId: d.coverId,
    minutes: d.minutes,
    servings: d.servings,
    category: d.category,
    featured: d.featured || false,
    spiceLevel: d.spiceLevel || 1,
  };
}
