import { syncCompletedLines } from '../meals/cooking.mjs';
import { z } from 'zod';
import { id } from '../../core/security.mjs';
import { member, familyLock, atomic, notify, dateAllowed, isoDate } from '../../core/policy.mjs';
import { demand } from '../../core/errors.mjs';
import { note, decision } from '../../core/validation.mjs';
import { recipeSnapshot } from '../recipes/routes.mjs';
import { publicSnapshot } from '../meals/routes.mjs';
export function changeRoutes(app, { db, route }) {
  route('GET', '/families/:familyId/changes', null, async (r) => {
    let m = await member(db, r.user.id, r.params.familyId);
    let rows = (
      await db.query(
        `SELECT c.*,u.nickname,o.meal_date,o.slot,l.quantity FROM changes c JOIN order_lines l ON l.id=c.line_id JOIN orders o ON o.id=l.order_id JOIN users u ON u.id=c.user_id WHERE o.family_id=$1 ${m.role === 'eater' ? 'AND c.user_id=$2' : ''} ORDER BY c.created_at DESC LIMIT 100`,
        m.role === 'eater' ? [r.params.familyId, r.user.id] : [r.params.familyId],
      )
    ).rows;
    return rows.map((c) => ({
      ...c,
      old_snapshot: publicSnapshot(c.old_snapshot),
      new_snapshot: publicSnapshot(c.new_snapshot),
    }));
  });
  route(
    'POST',
    '/families/:familyId/changes',
    z.object({ lineId: z.uuid(), replacementId: z.uuid(), reason: note }).strict(),
    async (r) =>
      atomic(db, r.user.id, r.headers['idempotency-key'], 'change.create', r.body, async (tx) => {
        await familyLock(tx, r.params.familyId);
        await member(tx, r.user.id, r.params.familyId);
        let line = (
          await tx.query(
            'SELECT l.*,o.user_id,o.status,o.meal_date,o.version FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE l.id=$1 AND o.family_id=$2 FOR UPDATE',
            [r.body.lineId, r.params.familyId],
          )
        ).rows[0];
        demand(
          line &&
            line.user_id === r.user.id &&
            !line.done &&
            ['pending', 'accepted'].includes(line.status),
          403,
          'CHANGE_OWNER',
          '只能更换自己尚未做好的点菜',
        );
        demand(dateAllowed(isoDate(line.meal_date)), 409, 'MEAL_EXPIRED', '这顿饭已过期，不能更换');
        let replacement = (
          await tx.query('SELECT id FROM dishes WHERE id=$1 AND family_id=$2 AND NOT archived', [
            r.body.replacementId,
            r.params.familyId,
          ])
        ).rows[0];
        demand(
          replacement && replacement.id !== line.dish_id,
          400,
          'INVALID_REPLACEMENT',
          '请选择小家中另一道可点的菜',
        );
        let cid = id(),
          snapshot = await recipeSnapshot(tx, replacement.id);
        await tx.query(
          "INSERT INTO changes(id,line_id,user_id,replacement_id,line_version,status,reason,old_snapshot,new_snapshot) VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8)",
          [
            cid,
            line.id,
            r.user.id,
            replacement.id,
            line.version,
            r.body.reason,
            JSON.stringify(line.snapshot),
            JSON.stringify(snapshot),
          ],
        );
        await notify(
          tx,
          r.params.familyId,
          'change.pending',
          cid,
          '小猪想换一道菜，请查收换菜申请',
        );
        return { id: cid };
      }),
  );
  route(
    'POST',
    '/families/:familyId/changes/:id/reply',
    z.object({ decision, reply: note }).strict(),
    async (r) =>
      atomic(db, r.user.id, r.headers['idempotency-key'], 'change.reply', r.body, async (tx) => {
        await familyLock(tx, r.params.familyId);
        await member(tx, r.user.id, r.params.familyId, 'cook');
        let c = (
          await tx.query(
            'SELECT c.*,l.order_id,l.done,l.dish_id,o.family_id,o.version,o.status AS order_status,o.meal_date FROM changes c JOIN order_lines l ON l.id=c.line_id JOIN orders o ON o.id=l.order_id WHERE c.id=$1 AND o.family_id=$2 FOR UPDATE',
            [r.params.id, r.params.familyId],
          )
        ).rows[0];
        demand(c && c.status === 'pending', 409, 'CHANGE_RESOLVED', '这份换菜已处理');
        let current = (
          await tx.query('SELECT archived FROM dishes WHERE id=$1 AND family_id=$2', [
            c.replacement_id,
            r.params.familyId,
          ])
        ).rows[0];
        if (
          c.done ||
          c.version !== c.line_version ||
          !['pending', 'accepted'].includes(c.order_status) ||
          !current ||
          current.archived ||
          !dateAllowed(isoDate(c.meal_date))
        ) {
          await tx.query("UPDATE changes SET status='obsolete' WHERE id=$1", [c.id]);
          return { status: 'obsolete' };
        }
        let status = r.body.decision === 'accept' ? 'accepted' : 'rejected';
        if (status === 'accepted') {
          await tx.query('UPDATE order_lines SET dish_id=$2,snapshot=$3 WHERE id=$1', [
            c.line_id,
            c.replacement_id,
            JSON.stringify(c.new_snapshot),
          ]);
          await tx.query('UPDATE orders SET version=version+1 WHERE id=$1', [c.order_id]);
          await syncCompletedLines(tx, c.order_id);
        }
        await tx.query('UPDATE changes SET status=$2,reply=$3 WHERE id=$1', [
          c.id,
          status,
          r.body.reply,
        ]);
        await notify(
          tx,
          r.params.familyId,
          'change.reply',
          c.id,
          r.body.reply || '饲养员回复了你的换菜',
          [c.user_id],
        );
        return { status };
      }),
  );
  route('POST', '/families/:familyId/changes/:id/withdraw', z.object({}).strict(), async (r) =>
    db.transaction(async (tx) => {
      await familyLock(tx, r.params.familyId);
      await member(tx, r.user.id, r.params.familyId);
      let result = await tx.query(
        "UPDATE changes SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='pending' AND line_id IN(SELECT l.id FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.family_id=$3) RETURNING id",
        [r.params.id, r.user.id, r.params.familyId],
      );
      demand(result.rows.length, 409, 'CHANGE_NOT_PENDING', '只能撤回自己的待回复申请');
      return { ok: true };
    }),
  );
}
