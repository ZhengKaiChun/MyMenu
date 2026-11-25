import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import { demand } from '../../core/errors.mjs';
import { sign, equalHex, digest } from '../../core/security.mjs';
export function mediaRoutes(app, { db, config, route }) {
  const root = resolve(config.mediaDir);
  route('POST', '/media', null, async (r) => {
    const part = await r.file({ limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    demand(
      part && ['image/jpeg', 'image/png', 'image/webp'].includes(part.mimetype),
      400,
      'IMAGE_TYPE',
      '仅支持JPEG、PNG或WebP图片',
    );
    let input = await part.toBuffer();
    demand(!part.file.truncated, 413, 'IMAGE_TOO_LARGE', '图片不能超过5MB');
    let total = (
      await db.query('SELECT COALESCE(sum(size),0)::int AS n FROM media WHERE owner_id=$1', [
        r.user.id,
      ])
    ).rows[0].n;
    demand(total < 100 * 1024 * 1024, 413, 'IMAGE_QUOTA', '图片空间不足');
    let output;
    try {
      output = await sharp(input, { limitInputPixels: 20000000 })
        .rotate()
        .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#fffaf0' })
        .jpeg({ quality: 84 })
        .toBuffer();
    } catch {
      demand(false, 400, 'IMAGE_INVALID', '图片无法读取');
    }
    const mid = randomUUID(),
      filename = mid + '.jpg';
    await mkdir(root, { recursive: true });
    await writeFile(join(root, filename), output, { flag: 'wx' });
    await db.query('INSERT INTO media(id,owner_id,filename,mime,size) VALUES($1,$2,$3,$4,$5)', [
      mid,
      r.user.id,
      filename,
      'image/jpeg',
      output.length,
    ]);
    return { id: mid };
  });
  route(
    'POST',
    '/media/:id/url',
    null,
    async (r) => {
      const mid = r.params.id;
      let owned = (
        await db.query('SELECT id FROM media WHERE id=$1 AND owner_id=$2', [mid, r.user.id])
      ).rows.length;
      let allowed = owned;
      if (!allowed && r.body?.shareToken) {
        let shared = (
          await db.query(
            'SELECT snapshot FROM shares WHERE token_hash=$1 AND NOT revoked AND expires_at>now()',
            [digest(r.body.shareToken)],
          )
        ).rows[0];
        allowed = shared?.snapshot.some(
          (d) => d.coverId === mid || d.steps.some((s) => s.imageId === mid),
        );
      }
      if (!allowed) {
        let dishes = (
          await db.query(
            'SELECT d.id,m.role,r.steps FROM dishes d JOIN members m ON m.family_id=d.family_id JOIN families f ON f.id=d.family_id JOIN recipes r ON r.dish_id=d.id WHERE m.user_id=$1 AND f.deleted_at IS NULL AND (d.cover_id=$2 OR m.role=$3)',
            [r.user.id, mid, 'cook'],
          )
        ).rows;
        allowed =
          dishes.some((d) => d.role === 'cook' && d.steps.some((s) => s.imageId === mid)) ||
          (
            await db.query(
              'SELECT d.id FROM dishes d JOIN members m ON m.family_id=d.family_id JOIN families f ON f.id=d.family_id WHERE m.user_id=$1 AND d.cover_id=$2 AND f.deleted_at IS NULL',
              [r.user.id, mid],
            )
          ).rows.length;
      }
      if (!allowed) {
        allowed = (
          await db.query(
            'SELECT 1 FROM legacy_history h JOIN members m ON m.family_id=h.family_id JOIN families f ON f.id=h.family_id WHERE m.user_id=$1 AND h.cover_id=$2 AND f.deleted_at IS NULL LIMIT 1',
            [r.user.id, mid],
          )
        ).rows.length;
      }
      if (!allowed) {
        // A meal keeps the photo it had when ordered, even if the recipe cover changes later.
        allowed = (
          await db.query(
            `SELECT 1 FROM order_lines l
           JOIN orders o ON o.id=l.order_id
           JOIN members m ON m.family_id=o.family_id
           JOIN families f ON f.id=o.family_id
           WHERE m.user_id=$1 AND l.snapshot->>'coverId'=$2 AND f.deleted_at IS NULL
             AND (o.status='accepted' OR o.user_id=$1 OR m.role='cook')
           LIMIT 1`,
            [r.user.id, mid],
          )
        ).rows.length;
      }
      if (!allowed) {
        allowed = (
          await db.query(
            `SELECT 1 FROM changes c
           JOIN order_lines l ON l.id=c.line_id
           JOIN orders o ON o.id=l.order_id
           JOIN members m ON m.family_id=o.family_id
           JOIN families f ON f.id=o.family_id
           WHERE m.user_id=$1 AND f.deleted_at IS NULL
             AND (m.role='cook' OR o.user_id=$1)
             AND (c.old_snapshot->>'coverId'=$2 OR c.new_snapshot->>'coverId'=$2)
           LIMIT 1`,
            [r.user.id, mid],
          )
        ).rows.length;
      }
      demand(allowed, 404, 'MEDIA_NOT_FOUND', '图片不可用');
      const expires = Date.now() + 300000,
        signature = sign(config.mediaKey, mid + ':' + expires);
      return {
        url: config.origin + '/media/' + mid + '?expires=' + expires + '&signature=' + signature,
      };
    },
    { rateLimit: { max: 300, timeWindow: '1 minute', groupId: 'media' } },
  );
  app.get(
    '/media/:id',
    { config: { rateLimit: { max: 300, timeWindow: '1 minute', groupId: 'media' } } },
    async (r, reply) => {
      const mid = r.params.id,
        expires = Number(r.query.expires);
      demand(
        /^[0-9a-f-]{36}$/.test(mid) &&
          Number.isFinite(expires) &&
          expires > Date.now() &&
          expires < Date.now() + 301000 &&
          equalHex(r.query.signature, sign(config.mediaKey, mid + ':' + expires)),
        403,
        'MEDIA_EXPIRED',
        '图片链接已失效',
      );
      const m = (await db.query('SELECT filename,mime FROM media WHERE id=$1', [mid])).rows[0];
      demand(
        m && /^[a-f0-9-]+\.(webp|jpg)$/.test(m.filename),
        404,
        'MEDIA_NOT_FOUND',
        '图片不存在',
      );
      reply.header('Cache-Control', 'private,max-age=240').type('image/jpeg');
      if (m.filename.endsWith('.jpg')) return readFile(join(root, m.filename));
      // Existing WebP uploads are converted once and then served from an atomic JPEG sidecar.
      const cachedPath = join(root, m.filename.replace(/\.webp$/, '.jpg'));
      try {
        return await readFile(cachedPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const original = await readFile(join(root, m.filename));
      const jpeg = await sharp(original, { limitInputPixels: 20000000 })
        .flatten({ background: '#fffaf0' })
        .jpeg({ quality: 84 })
        .toBuffer();
      const temporaryPath = cachedPath + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporaryPath, jpeg, { flag: 'wx' });
        await rename(temporaryPath, cachedPath);
      } finally {
        await unlink(temporaryPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      return jpeg;
    },
  );
}
