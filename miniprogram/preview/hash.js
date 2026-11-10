// SHA-256 for local preview password fingerprints only. Production uses server-side scrypt.
function hash(text) {
  const bytes = unescape(encodeURIComponent(text))
      .split('')
      .map((c) => c.charCodeAt(0)),
    bitLength = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i < 4 ? (bitLength >>> (i * 8)) & 255 : 0);
  const k = [],
    h = [];
  let n = 2;
  while (k.length < 64) {
    let prime = true;
    for (let d = 2; d * d <= n; d++)
      if (n % d === 0) {
        prime = false;
        break;
      }
    if (prime) {
      if (h.length < 8) h.push(((Math.sqrt(n) % 1) * 4294967296) | 0);
      k.push(((Math.cbrt(n) % 1) * 4294967296) | 0);
    }
    n++;
  }
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = [];
    for (let i = 0; i < 16; i++)
      w[i] =
        (bytes[offset + 4 * i] << 24) |
        (bytes[offset + 4 * i + 1] << 16) |
        (bytes[offset + 4 * i + 2] << 8) |
        bytes[offset + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      w[i] =
        (w[i - 16] +
          (rr(a, 7) ^ rr(a, 18) ^ (a >>> 3)) +
          w[i - 7] +
          (rr(b, 17) ^ rr(b, 19) ^ (b >>> 10))) |
        0;
    }
    let [a, b, c, d, e, f, g, j] = h;
    for (let i = 0; i < 64; i++) {
      const t = (j + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0,
        u = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      j = g;
      g = f;
      f = e;
      e = (d + t) | 0;
      d = c;
      c = b;
      b = a;
      a = (t + u) | 0;
    }
    [a, b, c, d, e, f, g, j].forEach((v, i) => (h[i] = (h[i] + v) | 0));
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
module.exports = hash;
