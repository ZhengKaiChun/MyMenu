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
      /(?:bind|catch)(?:tap|input|change|touchstart|touchmove|touchend|chooseavatar|getphonenumber)="([A-Za-z_][A-Za-z_0-9]*)"/g,
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
});
