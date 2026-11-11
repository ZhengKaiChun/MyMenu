function ids(dish) {
  return dish.collectionIds?.length ? dish.collectionIds : [dish.collectionId].filter(Boolean);
}
function contains(dish, id) {
  return ids(dish).includes(id);
}
function needsMeat(collections, selected) {
  return collections.some(
    (c) => selected.includes(c.id) && ['肉类', '肉禽', '荤菜'].includes(c.name),
  );
}
module.exports = { ids, contains, needsMeat };
