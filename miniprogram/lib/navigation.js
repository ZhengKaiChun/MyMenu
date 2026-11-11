// Keep a lightweight route trail while replacing obsolete native pages.
const roots = ['home', 'menu', 'today', 'pantry', 'family', 'login'];
const parents = {
  menu: 'home',
  today: 'menu',
  pantry: 'menu',
  family: 'menu',
  editDish: 'manage',
  manage: 'family',
  collections: 'manage',
  recipe: 'menu',
  dish: 'menu',
  shopping: 'today',
  calendar: 'today',
  match: 'pantry',
  personal: 'home',
  settings: 'home',
  profile: 'settings',
  members: 'family',
  identity: 'family',
  invite: 'family',
  dissolve: 'family',
  requests: 'menu',
  requestDetail: 'requests',
  changes: 'today',
  swap: 'changes',
  changeDetail: 'requests',
  shareRecipes: 'family',
  recipeParcel: 'shareRecipes',
  recipeGift: 'home',
  copyRecipes: 'recipeGift',
  copyDone: 'family',
  checkout: 'menu',
  sent: 'today',
  create: 'home',
  join: 'home',
  invitation: 'join',
  password: 'login',
  register: 'password',
  recover: 'password',
  sms: 'login',
  history: 'today',
  accountSecurity: 'settings',
  achievements: 'settings',
  cookingRecord: 'today',
  cookingReminder: 'requests',
};
let trail = [];
function snapshot(page) {
  const query = { ...(page?.query || page?.options || {}) };
  if (
    page?.data?.date &&
    ['menu', 'today', 'calendar', 'shopping', 'history'].includes((page.route || '').split('/')[1])
  )
    query.date = page.data.date;
  return {
    page: (page?.route || '').split('/')[1] || 'home',
    query,
  };
}
function url(target) {
  const q = Object.entries(target.query || {})
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
  return '/pages/' + target.page + '/index' + (q ? '?' + q : '');
}
function current() {
  return snapshot(getCurrentPages().slice(-1)[0]);
}
function same(a, b) {
  return url(a) === url(b);
}
function open(target) {
  const options = { url: url(target) };
  if (roots.includes(target.page)) wx.reLaunch(options);
  else if (getCurrentPages().length === 1 && roots.includes(current().page)) wx.navigateTo(options);
  else wx.redirectTo(options);
}
function go(page, query = {}, options = {}) {
  const target = { page, query },
    from = current();
  if (same(from, target)) return;
  if (roots.includes(page)) trail = [];
  else {
    const previous = trail.findIndex((x) => same(x, target));
    if (previous >= 0) trail = trail.slice(0, previous);
    else if (!options.replace) trail.push(from);
    trail = trail.slice(-12);
  }
  open(target);
}
function fallback(from) {
  if (from.page === 'sms' && from.query.bind === '1') return { page: 'settings', query: {} };
  if (from.page === 'copyRecipes' && from.query.token)
    return { page: 'recipeGift', query: { token: from.query.token } };
  return {
    page:
      from.page === 'ingredientEdit'
        ? from.query.scope === 'personal'
          ? 'personal'
          : 'pantry'
        : parents[from.page] || 'home',
    query: {},
  };
}
function back() {
  const from = current();
  let target = trail.pop();
  while (target && same(target, from)) target = trail.pop();
  open(target || fallback(from));
}
function exitSection() {
  const from = current();
  if (['home', 'login', 'menu'].includes(from.page)) return;
  let target = [...trail]
    .reverse()
    .find((x) => ['menu', 'today', 'pantry', 'family', 'home'].includes(x.page));
  if (['today', 'pantry', 'family'].includes(from.page)) target = { page: 'menu', query: {} };
  if (!target) {
    let next = from;
    for (let i = 0; i < 8 && !roots.includes(next.page); i++) next = fallback(next);
    target = next.page === 'home' ? { page: 'menu', query: {} } : next;
  }
  trail = [];
  open(target);
}
function isBackSwipe(start, end, width) {
  if (!start || !end || end.time - start.time > 650) return false;
  const dx = end.x - start.x,
    dy = end.y - start.y;
  return (
    Math.abs(dy) < 40 &&
    Math.abs(dx) > 75 &&
    Math.abs(dx) > Math.abs(dy) * 2 &&
    ((start.x <= 24 && dx > 0) || (start.x >= width - 24 && dx < 0))
  );
}
function arrive(page) {
  // A system back gesture returns to the retained section entry.
  if (roots.includes((page.route || '').split('/')[1])) trail = [];
}
function reset() {
  trail = [];
}
module.exports = { go, back, exitSection, isBackSwipe, arrive, reset };
