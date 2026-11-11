import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  nav = require('../../miniprogram/lib/navigation.js'),
  inbox = require('../../miniprogram/lib/inbox.js');
test('back restores the source route and query without retaining old native pages', (t) => {
  let page = { route: 'pages/today/index', query: { date: '2026-11-12' } },
    calls = [];
  const open = (o) => {
    calls.push(o.url);
    const u = new URL(o.url, 'https://local.test');
    page = { route: u.pathname.slice(1), query: Object.fromEntries(u.searchParams) };
  };
  globalThis.wx = { redirectTo: open, reLaunch: open, navigateTo: open };
  globalThis.getCurrentPages = () => [page];
  t.after(() => {
    nav.reset();
    delete globalThis.wx;
    delete globalThis.getCurrentPages;
  });
  nav.reset();
  nav.go('recipe', { id: 'dish 1' });
  nav.back();
  assert.equal(calls.at(-1), '/pages/today/index?date=2026-11-12');
  nav.go('family');
  nav.go('manage');
  nav.go('editDish', { id: 'd1' });
  nav.back();
  assert.equal(page.route, 'pages/manage/index');
  nav.exitSection();
  assert.equal(page.route, 'pages/family/index');
  nav.exitSection();
  assert.equal(page.route, 'pages/menu/index');
  nav.exitSection();
  assert.equal(page.route, 'pages/menu/index');
  nav.go('settings');
  nav.go('personal');
  nav.go('ingredientEdit', { scope: 'personal' });
  nav.go('personal', {}, { replace: true });
  nav.back();
  assert.equal(page.route, 'pages/settings/index');
  nav.go('recipeParcel', { token: 'a&b' });
  nav.go('copyRecipes', { token: 'a&b' });
  nav.back();
  assert.equal(page.query.token, 'a&b');
});
test('edge gestures distinguish back swipes from carousels, scrolling and slow touches', () => {
  const p = { x: 389, y: 200, time: 100 };
  assert.equal(nav.isBackSwipe(p, { x: 200, y: 208, time: 330 }, 390), true);
  assert.equal(
    nav.isBackSwipe({ x: 3, y: 200, time: 100 }, { x: 130, y: 206, time: 330 }, 390),
    true,
  );
  assert.equal(
    nav.isBackSwipe({ x: 160, y: 200, time: 100 }, { x: 40, y: 206, time: 330 }, 390),
    false,
  );
  assert.equal(nav.isBackSwipe(p, { x: 200, y: 290, time: 330 }, 390), false);
  assert.equal(nav.isBackSwipe(p, { x: 200, y: 208, time: 1100 }, 390), false);
});
test('inbox starts in the first unread category and defaults to orders after reading', () => {
  const notes = [
    { type: 'order.reply', read_at: 'read' },
    { type: 'change.pending', read_at: null },
    { type: 'dissolution.vote', read_at: null },
  ];
  assert.equal(inbox.initial(notes), 'change');
  assert.equal(inbox.summarize(notes)[1].unread, 1);
  assert.equal(inbox.initial(notes.map((n) => ({ ...n, read_at: 'read' }))), 'order');
  assert.equal(inbox.category({ type: 'dissolution.complete' }), 'family');
});

test('native history retains only the section entry and one current detail', (t) => {
  let stack = [{ route: 'pages/family/index', query: {} }];
  const item = (o) => {
    const u = new URL(o.url, 'https://local.test');
    return { route: u.pathname.slice(1), query: Object.fromEntries(u.searchParams) };
  };
  globalThis.getCurrentPages = () => stack;
  globalThis.wx = {
    navigateTo: (o) => stack.push(item(o)),
    redirectTo: (o) => {
      stack[stack.length - 1] = item(o);
    },
    reLaunch: (o) => {
      stack = [item(o)];
    },
  };
  t.after(() => {
    nav.reset();
    delete globalThis.wx;
    delete globalThis.getCurrentPages;
  });
  nav.reset();
  nav.go('manage');
  assert.equal(stack.length, 2);
  nav.go('editDish');
  assert.equal(stack.length, 2);
  assert.equal(stack[0].route, 'pages/family/index');
  stack.pop();
  nav.arrive(stack[0]);
  nav.back();
  assert.equal(stack[0].route, 'pages/menu/index');
  assert.equal(stack.length, 1);
});
