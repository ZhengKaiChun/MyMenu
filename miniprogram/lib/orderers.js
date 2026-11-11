module.exports = function (sources) {
  const people = new Map();
  for (const s of sources) {
    const key = s.userId || s.id;
    if (!people.has(key)) people.set(key, { ...s, quantity: 0 });
    people.get(key).quantity += s.quantity;
  }
  return [...people.values()];
};
