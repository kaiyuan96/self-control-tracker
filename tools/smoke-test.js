'use strict';
/* ============================================================
   冒烟测试：DOM 打桩执行 app.js 完整初始化，捕获运行时错误
   用法：node tools/smoke-test.js
   （防止 bindEvents 中引用未定义函数等运行时错误上线）
   ============================================================ */
function makeEl() {
  return new Proxy(function () {}, {
    get(t, prop) {
      if (prop === 'classList') return { add() {}, remove() {}, contains() { return false; }, toggle() {} };
      if (prop === 'style') return new Proxy({}, { set() { return true; }, get() { return ''; } });
      if (prop === 'dataset') return {};
      if (prop === 'parentElement') return makeEl();
      if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML' || prop === 'placeholder' || prop === 'title' || prop === 'type' || prop === 'src' || prop === 'checked') return '';
      if (prop === 'disabled' || prop === 'hidden') return false;
      if (prop === 'length') return 0;
      if (typeof prop === 'symbol') return undefined;
      return makeEl();
    },
    set() { return true; },
    apply() { return makeEl(); },
    has() { return true; }
  });
}

const els = new Map();
global.document = {
  getElementById: id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
  createElement: () => makeEl(),
  body: makeEl(),
  addEventListener() {},
  querySelector: () => makeEl(),
  querySelectorAll: () => []
};
global.window = {
  addEventListener() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'https://x.pages.dev/', origin: 'https://x.pages.dev' },
  matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} })
};
global.localStorage = global.window.localStorage;
global.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) });
global.confirm = () => true;
global.setTimeout = () => 0;
global.setInterval = () => 0;
global.clearTimeout = () => {};

try {
  require('../app.js');
  console.log('✅ app.js 完整初始化执行成功，无运行时错误');
  console.log('   绑定元素数量:', els.size);
} catch (e) {
  console.log('❌ 初始化抛错:', e.message);
  console.log(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
