function today() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
function shift(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function month(date, n) {
  const d = new Date(date + 'T12:00:00Z'),
    day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, end));
  return d.toISOString().slice(0, 10);
}
function bounds(value = today()) {
  return { min: month(value, -3), max: shift(value, -1) };
}
module.exports = { today, shift, month, bounds };
