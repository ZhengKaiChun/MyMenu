import { z } from 'zod';
import { id } from '../../core/security.mjs';
import { member, familyLock, atomic, notify, audit } from '../../core/policy.mjs';
import { demand } from '../../core/errors.mjs';
export function dissolutionRoutes(app, { db, route }) {
  route('GET', '/families/:familyId/dissolution', null, async (r) => {
    await member(db, r.user.id, r.params.familyId);
    let d = (
      await db.query(
        'SELECT * FROM dissolutions WHERE family_id=$1 ORDER BY created_at DESC LIMIT 1',
        [r.params.familyId],
      )
    ).rows[0];
    if (!d) return null;
    return {
      ...d,
      votes: (
        await db.query(
          'SELECT v.*,u.nickname,m.identity FROM votes v JOIN users u ON u.id=v.user_id LEFT JOIN members m ON m.user_id=v.user_id AND m.family_id=$2 WHERE proposal_id=$1',
          [d.id, r.params.familyId],
        )
      ).rows,
    };
  });
  route('POST', '/families/:familyId/dissolution', z.object({}).strict(), async (r) =>
    atomic(
      db,
      r.user.id,
      r.headers['idempotency-key'],
      'dissolution.start',
      r.params,
      async (tx) => {
        await familyLock(tx, r.params.familyId);
        let m = await member(tx, r.user.id, r.params.familyId);
        demand(m.owner_id === r.user.id, 403, 'OWNER_REQUIRED', '只有创建者可以发起');
        const did = id(),
          users = (
            await tx.query('SELECT user_id FROM members WHERE family_id=$1', [m.family_id])
          ).rows.map((m) => m.user_id);
        await tx.query(
          "INSERT INTO dissolutions(id,family_id,initiator,status) VALUES($1,$2,$3,'pending')",
          [did, m.family_id, r.user.id],
        );
        for (const uid of users)
          await tx.query('INSERT INTO votes(proposal_id,user_id,decision) VALUES($1,$2,$3)', [
            did,
            uid,
            uid === r.user.id ? 'agree' : null,
          ]);
        await notify(
          tx,
          m.family_id,
          'dissolution.pending',
          did,
          '小家发起了解散申请，需每位成员亲自确认',
          users.filter((uid) => uid !== r.user.id),
        );
        if (users.length === 1) await complete(tx, m.family_id, did, r.user.id, users);
        return { id: did, status: users.length === 1 ? 'completed' : 'pending' };
      },
    ),
  );
  route(
    'POST',
    '/families/:familyId/dissolution/:id/vote',
    z.object({ decision: z.enum(['agree', 'reject']) }).strict(),
    async (r) =>
      atomic(
        db,
        r.user.id,
        r.headers['idempotency-key'],
        'dissolution.vote:' + r.params.id,
        r.body,
        async (tx) => {
          await familyLock(tx, r.params.familyId);
          await member(tx, r.user.id, r.params.familyId);
          let d = (
            await tx.query(
              "SELECT * FROM dissolutions WHERE id=$1 AND family_id=$2 AND status='pending' FOR UPDATE",
              [r.params.id, r.params.familyId],
            )
          ).rows[0];
          demand(d, 409, 'PROPOSAL_RESOLVED', '解散申请已结束');
          const members = (
              await tx.query('SELECT user_id FROM members WHERE family_id=$1', [r.params.familyId])
            ).rows.map((m) => m.user_id),
            votes = (await tx.query('SELECT * FROM votes WHERE proposal_id=$1', [d.id])).rows;
          demand(
            members.length === votes.length &&
              members.every((uid) => votes.some((v) => v.user_id === uid)),
            409,
            'MEMBERS_CHANGED',
            '成员已变动，请重新发起',
          );
          let updated = await tx.query(
            'UPDATE votes SET decision=$3 WHERE proposal_id=$1 AND user_id=$2 AND decision IS NULL RETURNING user_id',
            [d.id, r.user.id, r.body.decision],
          );
          demand(updated.rows.length, 409, 'ALREADY_VOTED', '你已经确认过了');
          if (r.body.decision === 'reject') {
            await tx.query("UPDATE dissolutions SET status='rejected' WHERE id=$1", [d.id]);
            await notify(
              tx,
              r.params.familyId,
              'dissolution.rejected',
              d.id,
              '有成员不同意解散，小家继续保留',
              members,
            );
            return { status: 'rejected' };
          }
          let remaining = (
            await tx.query(
              'SELECT user_id FROM votes WHERE proposal_id=$1 AND decision IS DISTINCT FROM $2',
              [d.id, 'agree'],
            )
          ).rows;
          if (!remaining.length) {
            await complete(tx, r.params.familyId, d.id, r.user.id, members);
            return { status: 'completed' };
          }
          return { status: 'pending' };
        },
      ),
  );
  route('POST', '/families/:familyId/dissolution/:id/cancel', z.object({}).strict(), async (r) =>
    db.transaction(async (tx) => {
      await familyLock(tx, r.params.familyId);
      await member(tx, r.user.id, r.params.familyId);
      let row = await tx.query(
        "UPDATE dissolutions SET status='cancelled' WHERE id=$1 AND family_id=$2 AND initiator=$3 AND status='pending' RETURNING id",
        [r.params.id, r.params.familyId, r.user.id],
      );
      demand(row.rows.length, 409, 'CANNOT_CANCEL', '只有发起人可以撤回未结束的申请');
      return { ok: true };
    }),
  );
}
async function complete(tx, fid, did, actor, users) {
  await tx.query("UPDATE dissolutions SET status='completed' WHERE id=$1", [did]);
  await tx.query('UPDATE families SET deleted_at=now(),version=version+1 WHERE id=$1', [fid]);
  await tx.query('DELETE FROM cooking_records WHERE family_id=$1', [fid]);
  await tx.query('DELETE FROM achievement_totals WHERE family_id=$1', [fid]);
  await tx.query('UPDATE invitations SET revoked=true WHERE family_id=$1', [fid]);
  await tx.query('UPDATE shares SET revoked=true WHERE source_family_id=$1', [fid]);
  await notify(
    tx,
    fid,
    'dissolution.complete',
    did,
    '全员同意，小家已解散。个人账号与个人食材保留。',
    users,
  );
  await audit(tx, actor, fid, 'family.dissolved', did);
}
