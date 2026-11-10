// Local preview fixtures. Never sent to the production API.
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
function seed() {
  const users = [
    { id: 'preview-cook', username: 'preview_cook', nickname: '桃桃', avatarId: null },
    { id: 'preview-eater', username: 'preview_eater', nickname: '阿拱', avatarId: null },
  ];
  const family = { id: 'preview-home', name: '两只小猪的家', owner_id: users[0].id, version: 1 };
  const collections = ['拿手好菜', '清爽蔬菜', '暖胃汤羹'].map((name, i) => ({
    id: 'preview-collection-' + i,
    family_id: family.id,
    name,
    sort_order: i,
  }));
  const specs = [
    [
      '番茄炒蛋',
      '酸酸甜甜，家的味道',
      15,
      0,
      [
        ['番茄', 2, '个'],
        ['鸡蛋', 3, '个'],
        ['食用油', 15, 'ml'],
        ['盐', 2, 'g'],
      ],
      [
        '番茄洗净切块，鸡蛋打散，加少许盐搅匀。',
        '热锅放油，倒入蛋液炒至刚凝固，盛出备用。',
        '炒软番茄，加入鸡蛋翻匀，调味后出锅。',
      ],
    ],
    [
      '蜜汁鸡翅',
      '甜蜜挂汁，忍不住再来一只',
      30,
      0,
      [
        ['鸡翅', 8, '只'],
        ['蜂蜜', 15, 'g'],
        ['生抽', 15, 'ml'],
      ],
      [
        '鸡翅洗净划刀，加入生抽腌制15分钟。',
        '小火煎至两面金黄，加少量水焖熟。',
        '加入蜂蜜，收汁后撒上芝麻。',
      ],
    ],
    [
      '蒜香西兰花',
      '清清爽爽，刚好配一桌',
      10,
      1,
      [
        ['西兰花', 1, '颗'],
        ['大蒜', 3, '瓣'],
        ['盐', 2, 'g'],
      ],
      [
        '西兰花切小朵，盐水浸泡后洗净。',
        '沸水中焯烫1分钟后捞出。',
        '爆香蒜片，倒入西兰花炒匀，加盐调味。',
      ],
    ],
    [
      '番茄蛋汤',
      '一碗热乎乎的小幸福',
      10,
      2,
      [
        ['番茄', 1, '个'],
        ['鸡蛋', 1, '个'],
        ['盐', 1, 'g'],
      ],
      ['番茄切块炒软，加水煮开。', '缓缓淋入蛋液，凝固后轻轻推散。', '加入盐，撒葱花即可。'],
    ],
  ];
  const dishes = specs.map((s, i) => ({
    id: 'preview-dish-' + i,
    family_id: family.id,
    name: s[0],
    intro: s[1],
    minutes: s[2],
    servings: 2,
    collectionId: collections[s[3]].id,
    coverId: 'preview-food-' + i,
    ingredients: s[4].map((x) => ({ name: x[0], quantity: x[1], unit: x[2] })),
    steps: s[5].map((text, j) => ({ text, imageId: j === 0 ? 'preview-food-' + i : null })),
    version: 1,
    sortOrder: i,
    archived: false,
  }));
  const members = [
    { family_id: family.id, user_id: users[0].id, role: 'cook', identity: '猪妈妈' },
    { family_id: family.id, user_id: users[1].id, role: 'eater', identity: '猪爸爸' },
  ];
  const orders = [
    {
      id: 'preview-order-1',
      family_id: family.id,
      user_id: users[1].id,
      meal_date: today(),
      slot: '晚餐',
      status: 'pending',
      note: '今天想吃甜甜的鸡翅，少放一点盐～',
      reply: '',
      version: 1,
      created_at: new Date().toISOString(),
      items: [0, 1].map((i) => ({
        id: 'preview-pending-line-' + i,
        dish_id: dishes[i].id,
        quantity: 1,
        snapshot: JSON.parse(JSON.stringify(dishes[i])),
        done: false,
      })),
    },
    {
      id: 'preview-order-2',
      family_id: family.id,
      user_id: users[0].id,
      meal_date: today(),
      slot: '晚餐',
      status: 'accepted',
      note: '',
      reply: '',
      version: 1,
      created_at: new Date().toISOString(),
      items: [0, 2].map((i) => ({
        id: 'preview-line-' + i,
        dish_id: dishes[i].id,
        quantity: 1,
        snapshot: JSON.parse(JSON.stringify(dishes[i])),
        done: false,
      })),
    },
    {
      id: 'preview-order-3',
      family_id: family.id,
      user_id: users[1].id,
      meal_date: today(),
      slot: '午餐',
      status: 'accepted',
      note: '',
      reply: '',
      version: 1,
      created_at: new Date().toISOString(),
      items: [
        {
          id: 'preview-line-3',
          dish_id: dishes[3].id,
          quantity: 1,
          snapshot: JSON.parse(JSON.stringify(dishes[3])),
          done: false,
        },
      ],
    },
  ];
  const inventories = [
    ['番茄', 3, '个', '蔬菜'],
    ['鸡蛋', 6, '个', '蛋奶'],
    ['西兰花', 1, '颗', '蔬菜'],
  ].map((x, i) => ({
    id: 'preview-inventory-' + i,
    family_id: family.id,
    name: x[0],
    quantity: x[1],
    unit: x[2],
    category: x[3],
    version: 1,
  }));
  for (const user of users)
    for (const [i, x] of [
      ['番茄', 3, '个', '蔬菜'],
      ['鸡蛋', 6, '个', '蛋奶'],
      ['牛奶', 1, '盒', '蛋奶'],
    ].entries())
      inventories.push({
        id: user.id + '-inventory-' + i,
        user_id: user.id,
        name: x[0],
        quantity: x[1],
        unit: x[2],
        category: x[3],
        version: 1,
      });
  return {
    schema: 1,
    users,
    families: [family],
    members,
    collections,
    dishes,
    orders,
    inventories,
    sessions: {},
    invitations: [],
    shares: [],
    changes: [],
    proposals: [],
    notifications: [],
    checks: {},
    media: {},
    receipts: [],
    operations: {},
  };
}
module.exports = { seed, today };
