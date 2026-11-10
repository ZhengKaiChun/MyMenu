import { z } from 'zod';
import { id, token, digest } from '../../core/security.mjs';
import { member, familyLock, atomic, audit } from '../../core/policy.mjs';
import { demand } from '../../core/errors.mjs';
import { name, role, identity } from '../../core/validation.mjs';
export function familyRoutes(app, { db, route }) {
  route(
    'GET',
    '/families',
    null,
    async (r) =>
      (
        await db.query(
          'SELECT f.id,f.name,f.owner_id,f.version,m.role,m.identity FROM families f JOIN members m ON m.family_id=f.id WHERE m.user_id=$1 AND f.deleted_at IS NULL ORDER BY f.created_at',
          [r.user.id],
        )
      ).rows,
  );
  route('POST', '/families', z.object({ name }).strict(), async (r) =>
    atomic(db, r.user.id, r.headers['idempotency-key'], 'family.create', r.body, async (tx) => {
      const fid = id();
      await tx.query('INSERT INTO families(id,name,owner_id) VALUES($1,$2,$3)', [
        fid,
        r.body.name,
        r.user.id,
      ]);
      await tx.query("INSERT INTO members(family_id,user_id,role) VALUES($1,$2,'cook')", [
        fid,
        r.user.id,
      ]);
      await tx.query('INSERT INTO collections(id,family_id,name) VALUES($1,$2,$3)', [
        id(),
        fid,
        '拿手好菜',
      ]);
      await audit(tx, r.user.id, fid, 'family.created', fid);
      return { id: fid, name: r.body.name, role: 'cook', identity: '野生小猪' };
    }),
  );
  route('GET', '/families/:familyId/members', null, async (r) => {
    await member(db, r.user.id, r.params.familyId);
    return (
      await db.query(
        'SELECT m.user_id,m.role,m.identity,u.nickname,u.avatar_id FROM members m JOIN users u ON u.id=m.user_id WHERE m.family_id=$1 ORDER BY m.joined_at',
        [r.params.familyId],
      )
    ).rows;
  });
  route('PATCH', '/families/:familyId/identity', z.object({ identity }).strict(), async (r) => {
    await member(db, r.user.id, r.params.familyId);
    await db.query('UPDATE members SET identity=$3 WHERE family_id=$1 AND user_id=$2', [
      r.params.familyId,
      r.user.id,
      r.body.identity,
    ]);
    return { ok: true };
  });
  route(
    'PATCH',
    '/families/:familyId',
    z.object({ name, version: z.number().int().positive() }).strict(),
    async (r) =>
      db.transaction(async (tx) => {
        await familyLock(tx, r.params.familyId);
        let m = await member(tx, r.user.id, r.params.familyId, 'cook');
        demand(m.owner_id === r.user.id, 403, 'OWNER_REQUIRED', '只有创建者可以修改小家名称');
        let changed = await tx.query(
          'UPDATE families SET name=$2,version=version+1 WHERE id=$1 AND version=$3 RETURNING id',
          [r.params.familyId, r.body.name, r.body.version],
        );
        demand(changed.rows.length, 409, 'VERSION_CONFLICT', '小家已有更新，请刷新后重试');
        return { ok: true };
      }),
  );
  route('POST', '/families/:familyId/invitations', z.object({ role }).strict(), async (r) =>
    db.transaction(async (tx) => {
      await familyLock(tx, r.params.familyId);
      let m = await member(tx, r.user.id, r.params.familyId, 'cook');
      demand(
        r.body.role === 'eater' || m.owner_id === r.user.id,
        403,
        'OWNER_REQUIRED',
        '邀请共同饲养员需创建者操作',
      );
      const raw = token();
      await tx.query(
        "INSERT INTO invitations(token_hash,family_id,role,creator_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days')",
        [digest(raw), r.params.familyId, r.body.role, r.user.id],
      );
      return {
        token: raw,
        role: r.body.role,
        title: r.body.role === 'cook' ? '邀请你一起打扫猪圈' : '邀请你加入他的猪圈',
      };
    }),
  );
  route('GET', '/invitations/:token', null, async (r) => {
    const i = (
      await db.query(
        'SELECT i.role,i.expires_at,f.name FROM invitations i JOIN families f ON f.id=i.family_id WHERE token_hash=$1 AND NOT revoked AND expires_at>now() AND f.deleted_at IS NULL',
        [digest(r.params.token)],
      )
    ).rows[0];
    demand(i, 404, 'INVITATION_EXPIRED', '邀请失效了，请让小猪重新寄一封');
    return i;
  });
  route('POST', '/invitations/:token/accept', z.object({}).strict(), async (r) =>
    atomic(
      db,
      r.user.id,
      r.headers['idempotency-key'],
      'invitation.accept',
      r.params,
      async (tx) => {
        const reference = (
          await tx.query('SELECT family_id FROM invitations WHERE token_hash=$1', [
            digest(r.params.token),
          ])
        ).rows[0];
        demand(reference, 410, 'INVITATION_EXPIRED', '邀请已失效');
        await familyLock(tx, reference.family_id);
        let i = (
          await tx.query('SELECT * FROM invitations WHERE token_hash=$1 FOR UPDATE', [
            digest(r.params.token),
          ])
        ).rows[0];
        demand(
          i && !i.revoked && new Date(i.expires_at) > new Date(),
          410,
          'INVITATION_EXPIRED',
          '邀请已失效',
        );
        let family = (await tx.query('SELECT deleted_at FROM families WHERE id=$1', [i.family_id]))
          .rows[0];
        demand(family && !family.deleted_at, 410, 'FAMILY_CLOSED', '这个小家已解散');
        let existing = (
          await tx.query('SELECT role FROM members WHERE family_id=$1 AND user_id=$2', [
            i.family_id,
            r.user.id,
          ])
        ).rows[0];
        if (existing) return { familyId: i.family_id, role: existing.role };
        demand(!i.consumed_by, 409, 'INVITATION_USED', '这封邀请已经被使用');
        await tx.query('INSERT INTO members(family_id,user_id,role) VALUES($1,$2,$3)', [
          i.family_id,
          r.user.id,
          i.role,
        ]);
        await tx.query('UPDATE invitations SET consumed_by=$2 WHERE token_hash=$1', [
          digest(r.params.token),
          r.user.id,
        ]);
        await tx.query(
          "UPDATE dissolutions SET status='invalidated' WHERE family_id=$1 AND status='pending'",
          [i.family_id],
        );
        return { familyId: i.family_id, role: i.role };
      },
    ),
  );
  route(
    'POST',
    '/families/:familyId/members/:userId/role',
    z.object({ role }).strict(),
    async (r) =>
      db.transaction(async (tx) => {
        await familyLock(tx, r.params.familyId);
        let m = await member(tx, r.user.id, r.params.familyId, 'cook');
        demand(
          m.owner_id === r.user.id && r.params.userId !== m.owner_id,
          403,
          'OWNER_REQUIRED',
          '创建者不能取消自己的管理身份',
        );
        let updated = await tx.query(
          'UPDATE members SET role=$3 WHERE family_id=$1 AND user_id=$2 RETURNING user_id',
          [r.params.familyId, r.params.userId, r.body.role],
        );
        demand(updated.rows.length, 404, 'MEMBER_NOT_FOUND', '成员不存在');
        await audit(tx, r.user.id, r.params.familyId, 'member.role', r.params.userId);
        return { ok: true };
      }),
  );
  route(
    'POST',
    '/families/:familyId/transfer',
    z.object({ userId: z.uuid() }).strict(),
    async (r) =>
      db.transaction(async (tx) => {
        await familyLock(tx, r.params.familyId);
        let m = await member(tx, r.user.id, r.params.familyId);
        demand(m.owner_id === r.user.id, 403, 'OWNER_REQUIRED', '只有创建者可转让');
        await member(tx, r.body.userId, r.params.familyId);
        await tx.query('UPDATE families SET owner_id=$2,version=version+1 WHERE id=$1', [
          r.params.familyId,
          r.body.userId,
        ]);
        await tx.query("UPDATE members SET role='cook' WHERE family_id=$1 AND user_id=$2", [
          r.params.familyId,
          r.body.userId,
        ]);
        await tx.query(
          "UPDATE dissolutions SET status='invalidated' WHERE family_id=$1 AND status='pending'",
          [r.params.familyId],
        );
        return { ok: true };
      }),
  );
  route('POST', '/families/:familyId/leave', z.object({}).strict(), async (r) =>
    db.transaction(async (tx) => {
      await familyLock(tx, r.params.familyId);
      let m = await member(tx, r.user.id, r.params.familyId);
      demand(m.owner_id !== r.user.id, 409, 'TRANSFER_FIRST', '创建者请先转让身份');
      await tx.query('DELETE FROM members WHERE family_id=$1 AND user_id=$2', [
        r.params.familyId,
        r.user.id,
      ]);
      await tx.query(
        "UPDATE dissolutions SET status='invalidated' WHERE family_id=$1 AND status='pending'",
        [r.params.familyId],
      );
      return { ok: true };
    }),
  );
  route(
    'GET',
    '/notifications',
    null,
    async (r) =>
      (
        await db.query(
          'SELECT n.* FROM notifications n LEFT JOIN families f ON f.id=n.family_id WHERE n.user_id=$1 AND (n.family_id IS NULL OR f.deleted_at IS NULL OR n.type=$2) ORDER BY n.created_at DESC LIMIT 100',
          [r.user.id, 'dissolution.complete'],
        )
      ).rows,
  );
  route('POST', '/notifications/:id/read', z.object({}).strict(), async (r) => {
    await db.query('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2', [
      r.params.id,
      r.user.id,
    ]);
    return { ok: true };
  });
}
