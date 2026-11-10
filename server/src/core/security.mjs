import {
  randomBytes,
  createHash,
  scrypt as cb,
  timingSafeEqual,
  createHmac,
  randomUUID,
} from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(cb);
export const id = () => randomUUID();
export const token = () => randomBytes(32).toString('base64url');
export const digest = (v) => createHash('sha256').update(v).digest('hex');
export async function passwordHash(password) {
  const salt = randomBytes(24).toString('hex');
  const hash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return 'scrypt$' + salt + '$' + hash.toString('hex');
}
export async function passwordMatches(password, encoded) {
  if (!encoded) return false;
  const [algorithm, salt, value] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !value) return false;
  const expected = Buffer.from(value, 'hex'),
    actual = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function sign(key, value) {
  return createHmac('sha256', key).update(value).digest('hex');
}
export function equalHex(a, b) {
  if (!/^[0-9a-f]{64}$/.test(a || '') || !/^[0-9a-f]{64}$/.test(b || '')) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
