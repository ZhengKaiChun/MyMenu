import { z } from 'zod';
import { id, token, digest } from '../../core/security.mjs';
import { member, familyLock, atomic, audit } from '../../core/policy.mjs';
import { demand } from '../../core/errors.mjs';
import { recipeSnapshot, setDishCollections } from '../recipes/routes.mjs';
const importBody = z
  .object({
    token: z.string().min(30).max(100),
    familyId: z.uuid().optional(),
    newFamilyName: z.string().trim().min(1).max(40).optional(),
    mode: z.enum(['add', 'overwrite']),
    scope: z.enum(['matching', 'whole']),
    version: z.number().int().positive().optional(),
  })
  .strict()
  .refine((b) => !!b.familyId !== !!b.newFamilyName, '选择目标小家或新建小家');
async function packet(db, raw) {
  const s = (
    await db.query(
      'SELECT s.*,u.nickname,f.name AS family_name FROM shares s JOIN users u ON u.id=s.sender_id JOIN families f ON f.id=s.source_family_id WHERE s.token_hash=$1 AND NOT s.revoked AND s.expires_at>now() AND f.deleted_at IS NULL',
      [digest(raw)],
    )
  ).rows[0];
  demand(s, 410, 'SHARE_EXPIRED', '菜谱分享已失效，请朋友重新寄一封');
  return s;
}
export function shareRoutes(app, { db, route }) {
  route(
    'POST',
    '/families/:familyId/shares',
    z.object({ dishIds: z.array(z.uuid()).min(1).max(100) }).strict(),
    async (r) =>
      db.transaction(async (tx) => {
        await familyLock(tx, r.params.familyId);
        await member(tx, r.user.id, r.params.familyId, 'cook');
        demand(
          new Set(r.body.dishIds).size === r.body.dishIds.length,
          400,
          'DUPLICATE_DISH',
          '分享菜品重复',
        );
        let snapshot = [];
        for (const did of r.body.dishIds) {
          const allowed = (
            await tx.query('SELECT id FROM dishes WHERE id=$1 AND family_id=$2 AND NOT archived', [
              did,
              r.params.familyId,
            ])
          ).rows[0];
          demand(allowed, 400, 'INVALID_DISH', '只能分享本小家的菜谱');
          snapshot.push(await recipeSnapshot(tx, did));
        }
        let raw = token(),
          sid = id();
        await tx.query(
          "INSERT INTO shares(id,token_hash,source_family_id,sender_id,snapshot,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '7 days')",
          [sid, digest(raw), r.params.familyId, r.user.id, JSON.stringify(snapshot)],
        );
        return { id: sid, token: raw, count: snapshot.length };
      }),
  );
  route('GET', '/shares/:token', null, async (r) => {
    let s = await packet(db, r.params.token);
    return {
      id: s.id,
      sender: s.nickname,
      family: s.family_name,
      expiresAt: s.expires_at,
      dishes: s.snapshot,
    };
  });
  route('POST', '/shares/:id/revoke', z.object({}).strict(), async (r) => {
    let s = (
      await db.query('SELECT * FROM shares WHERE id=$1 AND sender_id=$2', [r.params.id, r.user.id])
    ).rows[0];
    demand(s, 404, 'SHARE_NOT_FOUND', '分享不存在');
    await db.query('UPDATE shares SET revoked=true WHERE id=$1', [s.id]);
    return { ok: true };
  });
  route('POST', '/imports/preview', importBody, async (r) => {
    let s = await packet(db, r.body.token),
      m = r.body.familyId ? await member(db, r.user.id, r.body.familyId, 'cook') : null,
      old = m
        ? (
            await db.query('SELECT name FROM dishes WHERE family_id=$1 AND NOT archived', [
              m.family_id,
            ])
          ).rows
        : [],
      matching = s.snapshot.filter((d) => old.some((o) => o.name === d.name)).length;
    return {
      count: s.snapshot.length,
      version: m?.version || 1,
      target: m?.name || r.body.newFamilyName,
      added:
        r.body.mode === 'add' || !m || r.body.scope === 'whole'
          ? s.snapshot.length
          : s.snapshot.length - matching,
      replaced:
        r.body.mode === 'overwrite' && m ? (r.body.scope === 'whole' ? old.length : matching) : 0,
      names: s.snapshot.map((d) => d.name),
    };
  });
  route('POST', '/imports', importBody, async (r) =>
    atomic(db, r.user.id, r.headers['idempotency-key'], 'recipes.import', r.body, async (tx) => {
      let s = await packet(tx, r.body.token),
        fid = r.body.familyId;
      if (fid) {
        await familyLock(tx, fid);
        let m = await member(tx, r.user.id, fid, 'cook');
        demand(m.version === r.body.version, 409, 'MENU_VERSION', '目标小家菜谱已变化，请重新确认');
      } else {
        fid = id();
        await tx.query('INSERT INTO families(id,name,owner_id) VALUES($1,$2,$3)', [
          fid,
          r.body.newFamilyName,
          r.user.id,
        ]);
        await tx.query("INSERT INTO members(family_id,user_id,role) VALUES($1,$2,'cook')", [
          fid,
          r.user.id,
        ]);
      }
      let before = (
          await tx.query('SELECT id,name FROM dishes WHERE family_id=$1 AND NOT archived', [fid])
        ).rows,
        added = 0,
        replaced = 0;
      if (r.body.mode === 'overwrite' && r.body.scope === 'whole') {
        await tx.query(
          'UPDATE dishes SET archived=true,version=version+1 WHERE family_id=$1 AND NOT archived',
          [fid],
        );
        replaced = before.length;
      }
      for (const source of s.snapshot) {
        const targetIds = [];
        for (const categoryName of [
          ...new Set(
            source.categories?.length ? source.categories : [source.category || '分享好菜'],
          ),
        ]) {
          let category = (
            await tx.query('SELECT id FROM collections WHERE family_id=$1 AND name=$2', [
              fid,
              categoryName,
            ])
          ).rows[0];
          if (!category) {
            category = { id: id() };
            await tx.query('INSERT INTO collections(id,family_id,name) VALUES($1,$2,$3)', [
              category.id,
              fid,
              categoryName,
            ]);
          }
          targetIds.push(category.id);
        }
        const category = { id: targetIds[0] };
        let did = id(),
          name = source.name,
          match =
            r.body.mode === 'overwrite' && r.body.scope === 'matching'
              ? before.find((d) => d.name === name)
              : null;
        if (match) {
          did = match.id;
          replaced++;
          await tx.query(
            'UPDATE dishes SET collection_id=$2,intro=$3,cover_id=$4,minutes=$5,servings=$6,featured=$7,spice_level=$8,meat_type=$9,version=version+1 WHERE id=$1',
            [
              did,
              category.id,
              source.intro,
              source.coverId || null,
              source.minutes,
              source.servings,
              source.featured || false,
              source.spiceLevel || 1,
              source.meatType || (source.category === '肉类' ? '其他' : ''),
            ],
          );
        } else {
          if (r.body.mode === 'add') {
            let n = 1;
            while (before.some((d) => d.name === name))
              name = source.name + '（分享' + (n++ === 1 ? '' : n - 1) + '）';
          }
          await tx.query(
            'INSERT INTO dishes(id,family_id,collection_id,name,intro,cover_id,minutes,servings,featured,spice_level,meat_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
            [
              did,
              fid,
              category.id,
              name,
              source.intro,
              source.coverId || null,
              source.minutes,
              source.servings,
              source.featured || false,
              source.spiceLevel || 1,
              source.meatType || (source.category === '肉类' ? '其他' : ''),
            ],
          );
          before.push({ id: did, name });
          added++;
        }
        await setDishCollections(tx, fid, did, targetIds);
        await tx.query(
          'INSERT INTO recipes(dish_id,ingredients,steps) VALUES($1,$2,$3) ON CONFLICT(dish_id) DO UPDATE SET ingredients=EXCLUDED.ingredients,steps=EXCLUDED.steps',
          [did, JSON.stringify(source.ingredients), JSON.stringify(source.steps)],
        );
      }
      await tx.query('UPDATE families SET version=version+1 WHERE id=$1', [fid]);
      let receipt = id();
      await tx.query(
        'INSERT INTO import_receipts(id,user_id,family_id,share_id,mode,scope,added,replaced) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [receipt, r.user.id, fid, s.id, r.body.mode, r.body.scope, added, replaced],
      );
      await audit(tx, r.user.id, fid, 'recipes.import', receipt);
      return { id: receipt, familyId: fid, added, replaced, count: s.snapshot.length };
    }),
  );
}
