const categories = ['蔬菜', '肉类', '蛋奶', '主食', '调味', '其他'];
const meatTypes = ['猪', '鸡', '牛', '鱼', '海鲜', '其他'];
function normalize(i) {
  const legacy = ['肉禽', '海鲜'].includes(i.category);
  return {
    ...i,
    category: legacy ? '肉类' : categories.includes(i.category) ? i.category : '其他',
    meatType:
      i.meatType || i.meat_type || (legacy ? (i.category === '海鲜' ? '海鲜' : '其他') : ''),
  };
}
module.exports = { categories, meatTypes, normalize };
