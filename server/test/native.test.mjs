import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import { buildApp } from '../src/app.mjs';
function nativeRuntime(app) {
  const root = resolve('miniprogram'),
    cache = new Map(),
    storage = new Map(),
    navigation = [];
  let latestPage;
  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    showToast() {},
    showModal(o) {
      o.success({ confirm: true, content: '测试合集' });
    },
    navigateTo: (o) => navigation.push(o.url),
    redirectTo: (o) => navigation.push(o.url),
    reLaunch: (o) => navigation.push(o.url),
    navigateBack() {},
    enableAlertBeforeUnload() {},
    disableAlertBeforeUnload() {},
    request(o) {
      const url = new URL(o.url);
      app
        .inject({
          method: o.method,
          url: url.pathname + url.search,
          headers: o.header,
          payload: o.data,
        })
        .then((r) => o.success({ statusCode: r.statusCode, data: r.json() }))
        .catch(o.fail);
    },
  };
  function load(file) {
    file = resolve(file);
    if (!file.endsWith('.js')) file += '.js';
    if (file === resolve(root, 'config/index.js'))
      return { mode: 'development', apiBase: 'http://127.0.0.1:3000' };
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const context = vm.createContext({
      module,
      exports: module.exports,
      require: (s) => load(resolve(dirname(file), s)),
      wx,
      Page: (x) => (latestPage = x),
      App() {},
      Component() {},
      getCurrentPages: () => [{ route: 'pages/home/index' }],
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    new vm.Script(readFileSync(file, 'utf8'), { filename: file }).runInContext(context);
    return module.exports;
  }
  function instance(name) {
    load(resolve(root, 'pages', name, 'index.js'));
    const page = {
      ...latestPage,
      data: JSON.parse(JSON.stringify(latestPage.data)),
      setData(patch) {
        for (const [k, v] of Object.entries(patch)) {
          const path = k.replace(/\[(\d+)\]/g, '.$1').split('.');
          let node = this.data;
          for (const part of path.slice(0, -1)) node = node[part];
          node[path.at(-1)] = v;
        }
      },
    };
    return page;
  }
  return { load, instance, wx, navigation, root };
}
test('all native WXML event handlers are implemented', () => {
  const runtime = nativeRuntime(null);
  const app = JSON.parse(readFileSync('miniprogram/app.json', 'utf8'));
  for (const path of app.pages) {
    const name = path.split('/')[1],
      page = runtime.instance(name),
      source = readFileSync('miniprogram/' + path + '.wxml', 'utf8');
    for (const match of source.matchAll(
      /(?:bind|catch)(?:tap|input|change|scroll|touchstart|touchmove|touchend|chooseavatar|getphonenumber)="([A-Za-z_][A-Za-z_0-9]*)"/g,
    ))
      assert.equal(typeof page[match[1]], 'function', name + ' missing ' + match[1]);
    assert.ok(source.includes('<g-shell'), name + ' missing native shell');
  }
});
test('native controllers register, create household, save a real recipe and submit a real order', async (t) => {
  const { app } = await buildApp({
    config: {
      production: false,
      database: {},
      origin: 'http://127.0.0.1:3000',
      mediaKey: 'n'.repeat(32),
      pepper: 'p'.repeat(32),
      mediaDir: '.runtime/test-media',
      wechatSecret: '',
      allowDevAuth: false,
    },
    logger: false,
  });
  t.after(() => app.close());
  const runtime = nativeRuntime(app),
    register = runtime.instance('register');
  register.onLoad({});
  register.setData({
    username: 'native_test',
    password: 'native-test-password',
    confirm: 'native-test-password',
    consent: true,
  });
  await register.submit();
  assert.equal(register.data.error, '');
  const session = runtime.load(resolve(runtime.root, 'lib/session.js'));
  assert.ok(session.token);
  const create = runtime.instance('create');
  create.onLoad({});
  create.setData({ name: '原生联调小家' });
  await create.submit();
  assert.ok(session.family.id);
  const editor = runtime.instance('editDish');
  editor.onLoad({});
  await editor.onShow();
  assert.equal(editor.data.error, '');
  editor.setData({
    name: '原生番茄炒蛋',
    intro: '今晚一起吃',
    featured: true,
    spiceLevel: 3,
    ingredients: [{ name: '番茄', quantity: 2, unit: '个' }],
    steps: [{ text: '洗净番茄，切块炒熟。', imageId: null }],
  });
  const fieldReturn = editor.field({
    type: 'input',
    currentTarget: { dataset: { list: 'ingredients', index: 0, field: 'name' } },
    detail: { value: '中文番茄' },
  });
  assert.equal(
    fieldReturn,
    undefined,
    'native input handlers must not return a Promise or replacement string',
  );
  assert.equal(editor.data.ingredients[0].name, '中文番茄');
  await editor.save();
  assert.equal(editor.data.error, '');
  const menu = runtime.instance('menu');
  menu.onLoad({});
  await menu.onShow();
  assert.equal(menu.data.dishes.length, 1);
  assert.equal(menu.data.dishes[0].featured, true);
  assert.equal(menu.data.dishes[0].spiceLevel, 3);
  await menu.add({ currentTarget: { dataset: { id: menu.data.dishes[0].id } } });
  const checkout = runtime.instance('checkout');
  checkout.onLoad({});
  await checkout.onShow();
  assert.equal(checkout.data.count, 1);
  await checkout.submit();
  assert.equal(checkout.data.error, '');
  assert.equal(session.lastOrder.status, 'accepted');
  const today = runtime.instance('today');
  today.onLoad({});
  await today.onShow();
  assert.equal(today.data.total, 1);
  assert.equal(today.data.sections[2].dishes[0].snapshot.name, '原生番茄炒蛋');
  const api = runtime.load(resolve(runtime.root, 'lib/api.js'));
  const a = await api.request('/inventory', {
    method: 'POST',
    body: { name: '青椒', category: '蔬菜', quantity: 3, unit: '个' },
  });
  const b = await api.request('/inventory', {
    method: 'POST',
    body: { name: '鸡肉', category: '肉类', meatType: '鸡', quantity: 1, unit: '斤' },
  });
  const pantry = runtime.instance('pantry');
  pantry.onLoad({});
  await pantry.onShow();
  await pantry.showImport();
  await pantry.importCategory({ currentTarget: { dataset: { id: '蔬菜' } } });
  await pantry.selectImport({ detail: { value: [a.id] } });
  await pantry.importCategory({ currentTarget: { dataset: { id: '肉类' } } });
  await pantry.selectImport({ detail: { value: [b.id] } });
  assert.equal(pantry.data.importIds.length, 2, 'selection must survive category changes');
  await pantry.allImport();
  assert.equal(
    pantry.data.importIds.length,
    1,
    'unselecting a category preserves other selections',
  );
  assert.equal(pantry.data.importIds[0], a.id);
  const messages = runtime.instance('requests');
  messages.onLoad({});
  await messages.onShow();
  assert.equal(messages.data.noteTab, 'order');
  assert.equal(messages.data.visibleNotes.length, 1);
  await messages.allNotes();
  assert.equal(messages.data.selectedNotes.length, 1);
  await messages.deleteNotes();
  assert.equal(messages.data.notifications.length, 0);
  assert.equal(
    (await api.request('/families/' + session.family.id + '/orders')).length,
    1,
    'inbox deletion must retain orders',
  );
  const previousUpload = api.upload,
    previousImage = api.image;
  let uploaded = [];
  api.upload = async (path, opts) => {
    uploaded.push({ path, opts });
    return { id: 'test-image' };
  };
  api.image = async () => '/tmp/full-image';
  runtime.wx.chooseMedia = (o) =>
    o.success({ tempFiles: [{ tempFilePath: '/tmp/wide-original' }] });
  runtime.wx.showActionSheet = (o) => o.success({ tapIndex: 0 });
  await editor.picture({ currentTarget: { dataset: { kind: 'step', index: 0 } } });
  assert.equal(uploaded[0].path, '/tmp/wide-original');
  assert.equal(uploaded[0].opts.crop, false);
  runtime.wx.showActionSheet = (o) => o.success({ tapIndex: 1 });
  runtime.wx.editImage = (o) => o.success({ tempFilePath: '/tmp/free-crop' });
  await editor.picture({ currentTarget: { dataset: { kind: 'step', index: 0 } } });
  assert.equal(uploaded[1].path, '/tmp/free-crop');
  assert.equal(uploaded[1].opts.crop, false);
  api.upload = previousUpload;
  api.image = previousImage;
  await api.request('/families/' + session.family.id + '/dishes', {
    method: 'POST',
    body: { name: '蒸鸡蛋', collectionId: menu.data.collections[0].id, minutes: 5, servings: 2 },
  });
  const swap = runtime.instance('swap');
  swap.onLoad({ id: today.data.sections[2].dishes[0].sources[0].id });
  await swap.onShow();
  assert.equal(swap.data.error, '');
  swap.search({ type: 'input', detail: { value: '鸡蛋' } });
  assert.equal(swap.data.dishes.length, 1);
  swap.search({ type: 'input', detail: { value: '找不到' } });
  assert.equal(swap.data.dishes.length, 0);
  const sharing = runtime.instance('shareRecipes');
  sharing.onLoad({});
  await sharing.onShow();
  await sharing.select({ detail: { value: [menu.data.dishes[0].id] } });
  sharing.search({ type: 'input', detail: { value: '鸡蛋' } });
  assert.equal(sharing.data.dishes.length, 1);
  await sharing.all();
  assert.equal(
    sharing.data.selected.length,
    2,
    'share search keeps previously selected hidden dishes',
  );
});

test('native multi-select, return position, reversible meat filters and avatar drafts work together', async (t) => {
  const { app } = await buildApp({
    logger: false,
    config: {
      production: false,
      database: {},
      origin: 'http://127.0.0.1:3000',
      mediaKey: 'm'.repeat(32),
      pepper: 'p'.repeat(32),
      mediaDir: '.runtime/test-media',
      wechatSecret: '',
      allowDevAuth: false,
    },
  });
  t.after(() => app.close());
  const rt = nativeRuntime(app),
    register = rt.instance('register');
  register.onLoad({});
  register.setData({
    username: 'native_multi',
    password: 'native-multi-password',
    confirm: 'native-multi-password',
    consent: true,
  });
  await register.submit();
  const session = rt.load(resolve(rt.root, 'lib/session.js')),
    api = rt.load(resolve(rt.root, 'lib/api.js'));
  const home = await api.request('/families', { method: 'POST', body: { name: '记住这里' } });
  session.setFamily({ ...home, role: 'cook' });
  const base = '/families/' + home.id,
    menu = await api.request(base + '/menu'),
    a = menu.collections[0].id;
  const b = (await api.request(base + '/collections', { method: 'POST', body: { name: '肉类' } }))
    .id;
  const chicken = await api.request(base + '/dishes', {
    method: 'POST',
    body: { name: '鸡翅', minutes: 10, servings: 2, collectionId: b, meatType: '鸡' },
  });
  await api.request(base + '/dishes', {
    method: 'POST',
    body: { name: '猪肉', minutes: 10, servings: 2, collectionId: b, meatType: '猪' },
  });
  const manager = rt.instance('manage');
  manager.onLoad({});
  await manager.onShow();
  assert.equal(
    manager.data.category,
    a,
    'manager opens the first actual collection, without virtual all',
  );
  await manager.category({ currentTarget: { dataset: { id: b } } });
  await manager.rememberScroll({ detail: { scrollTop: 165 } });
  await manager.editDish({ currentTarget: { dataset: { id: chicken.id } } });
  const editor = rt.instance('editDish');
  editor.onLoad({ id: chicken.id });
  await editor.onShow();
  await editor.openCollections();
  await editor.collection({ currentTarget: { dataset: { id: a } } });
  assert.equal(editor.data.collectionIds.length, 1, 'picker edits remain temporary');
  editor.searchCollections({ type: 'input', detail: { value: '肉' } });
  assert.equal(editor.data.collectionOptions.length, 1);
  assert.equal(editor.data.draftCollectionIds.length, 2, 'search keeps hidden selections');
  await editor.closeCollections();
  assert.equal(editor.data.collectionIds.length, 1, 'cancel leaves original memberships');
  await editor.openCollections();
  await editor.collection({ currentTarget: { dataset: { id: a } } });
  await editor.confirmCollections();
  assert.equal(editor.data.collectionIds.length, 2);
  await editor.save();
  assert.equal(editor.data.error, '');
  const returned = rt.instance('collections');
  returned.onLoad({});
  await returned.onShow();
  assert.equal(returned.data.category, b);
  assert.equal(returned.data.scrollTop, 165);
  await returned.saveMenu();
  assert.equal(returned.data.error, '');
  assert.equal(returned.data.category, b);
  const ordering = rt.instance('menu');
  ordering.onLoad({});
  await ordering.onShow();
  await ordering.category({ currentTarget: { dataset: { id: b } } });
  assert.equal(ordering.data.dishes.length, 2);
  await ordering.meatCategory({ currentTarget: { dataset: { type: '鸡' } } });
  assert.equal(ordering.data.dishes.length, 1);
  await ordering.meatCategory({ currentTarget: { dataset: { type: '鸡' } } });
  assert.equal(ordering.data.dishes.length, 2);
  assert.equal(ordering.data.meatType, '');
  const snapshot = await api.request(base + '/menu');
  assert.equal(snapshot.dishes.filter((d) => d.id === chicken.id).length, 1);
  await api.request(base + '/inventory', {
    method: 'POST',
    body: { name: '鸡肉', quantity: 1, unit: '斤', category: '肉类', meatType: '鸡' },
  });
  await api.request(base + '/inventory', {
    method: 'POST',
    body: { name: '猪肉', quantity: 1, unit: '斤', category: '肉类', meatType: '猪' },
  });
  const pantry = rt.instance('pantry');
  pantry.onLoad({});
  await pantry.onShow();
  await pantry.categoryTab({ currentTarget: { dataset: { id: '肉类' } } });
  assert.equal(pantry.data.items.length, 2);
  await pantry.meatTab({ currentTarget: { dataset: { type: '鸡' } } });
  assert.equal(pantry.data.items.length, 1);
  await pantry.meatTab({ currentTarget: { dataset: { type: '鸡' } } });
  assert.equal(pantry.data.items.length, 2);
  const profile = rt.instance('profile');
  profile.onLoad({});
  await profile.onShow();
  profile.data.nickname = '还在编辑昵称';
  await profile.preset({ currentTarget: { dataset: { index: 2 } } });
  await profile.onShow();
  assert.equal(profile.data.nickname, '还在编辑昵称');
  assert.equal(profile.data.preset, 2);
  const originalRequest = api.request,
    uploads = [];
  let saved;
  api.request = async (path, opts) =>
    path === '/me'
      ? opts?.method === 'PATCH'
        ? (saved = opts.body)
        : { ...saved }
      : originalRequest(path, opts);
  api.upload = async (path, opts) => {
    uploads.push({ path, opts });
    return { id: 'saved-avatar' };
  };
  api.image = async () => '/tmp/custom-avatar';
  rt.wx.getImageInfo = (o) => o.success({ path: '/tmp/builtin-avatar' });
  await profile.submit();
  assert.equal(profile.data.error, '');
  assert.equal(saved.avatarId, 'saved-avatar');
  assert.equal(saved.nickname, '还在编辑昵称');
  assert.equal(uploads[0].opts.crop, false);
  assert.equal(uploads[0].path, '/assets/avatars/pig-2.png');
  rt.wx.chooseMedia = (o) => {
    profile.onShow();
    o.success({ tempFiles: [{ tempFilePath: '/tmp/custom-original' }] });
  };
  await profile.customAvatar();
  assert.equal(profile.data.preset, -1);
  assert.equal(profile.data.avatar, '/tmp/custom-avatar');
  assert.equal(uploads[1].path, '/tmp/custom-original');
});

test('formal avatar upload copies read-only package assets and removes the temporary file', async () => {
  const rt = nativeRuntime(null),
    api = rt.load(resolve(rt.root, 'lib/api.js')),
    events = [];
  rt.wx.env = { USER_DATA_PATH: 'wxfile://usr' };
  rt.wx.getFileSystemManager = () => ({
    copyFile(o) {
      events.push(['copy', o.srcPath, o.destPath]);
      o.success({});
    },
    unlink(o) {
      events.push(['unlink', o.filePath]);
      o.success({});
    },
  });
  rt.wx.uploadFile = (o) => {
    events.push(['upload', o.filePath]);
    o.success({ statusCode: 200, data: JSON.stringify({ id: 'avatar-uuid' }) });
  };
  const result = await api.upload('/assets/avatars/pig-3.png', { crop: false });
  assert.equal(result.id, 'avatar-uuid');
  assert.deepEqual(
    events.map((e) => e[0]),
    ['copy', 'upload', 'unlink'],
  );
  assert.equal(events[0][1], '/assets/avatars/pig-3.png');
  assert.equal(events[1][1], events[0][2]);
  assert.equal(events[2][1], events[0][2]);
});

test('personal inventory works independently and account updates replace the session', async (t) => {
  const { app } = await buildApp({
    logger: false,
    config: {
      production: false,
      database: {},
      origin: 'http://127.0.0.1:3000',
      mediaKey: 'm'.repeat(32),
      pepper: 'p'.repeat(32),
      mediaDir: '.runtime/test-media',
      wechatSecret: '',
      allowDevAuth: false,
    },
  });
  t.after(() => app.close());
  const rt = nativeRuntime(app),
    register = rt.instance('register');
  register.onLoad({});
  register.setData({
    username: 'personal_native',
    password: 'personal-password-123',
    confirm: 'personal-password-123',
    consent: true,
  });
  await register.submit();
  const session = rt.load(resolve(rt.root, 'lib/session.js')),
    api = rt.load(resolve(rt.root, 'lib/api.js'));
  session.family = null;
  for (const meatType of ['猪', '鸡'])
    await api.request('/inventory', {
      method: 'POST',
      body: { name: meatType + '肉', quantity: 1, unit: '斤', category: '肉类', meatType },
    });
  const personal = rt.instance('personal');
  personal.onLoad({});
  await personal.onShow();
  assert.equal(personal.data.error, '');
  assert.equal(personal.data.totalCount, 2);
  await personal.categoryTab({ currentTarget: { dataset: { id: '肉类' } } });
  await personal.meatTab({ currentTarget: { dataset: { type: '鸡' } } });
  assert.equal(personal.data.items.length, 1);
  await personal.meatTab({ currentTarget: { dataset: { type: '鸡' } } });
  assert.equal(personal.data.items.length, 2);
  const settings = rt.instance('settings');
  settings.onLoad({});
  await settings.onShow();
  assert.equal(settings.data.error, '');
  assert.equal(settings.data.achievements.cooked, 0);
  const security = rt.instance('accountSecurity');
  security.onLoad({});
  await security.onShow();
  const before = session.token;
  security.setData({
    username: 'personal_changed',
    currentPassword: 'personal-password-123',
    newPassword: 'new-personal-password',
    confirm: 'new-personal-password',
  });
  await security.submit();
  assert.equal(security.data.error, '');
  assert.notEqual(session.token, before);
  assert.equal(security.data.currentPassword, '');
  assert.equal((await api.request('/me/security')).username, 'personal_changed');
});
