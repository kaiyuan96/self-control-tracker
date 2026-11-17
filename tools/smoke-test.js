'use strict';
/* ============================================================
   冒烟测试：DOM 打桩执行 app.js 完整初始化，捕获运行时错误
   用法：node tools/smoke-test.js

   关键设计：getElementById 严格模拟浏览器——
   index.html 里不存在的 id 一律返回 null（不再给万能假元素），
   因此"引用已删除/写错 id"这类错误会立即暴露，
   而不是像之前那样被掩盖到线上才崩。
   ============================================================ */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const knownIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const dynamicIds = new Set();      /* 运行时通过 createElement 创建并赋 id 的节点 */
const missingRefs = new Set();     /* 被引用但 HTML 里不存在的 id */
const els = new Map();

function makeEl() {
  return new Proxy(function () {}, {
    get(t, prop) {
      if (prop === 'classList') return { add() {}, remove() {}, contains() { return false; }, toggle() {} };
      if (prop === 'style') return new Proxy({}, { set() { return true; }, get() { return ''; } });
      if (prop === 'dataset') return {};
      if (prop === 'parentElement') return makeEl();
      if (prop === 'nodeType') return 1;
      if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML' || prop === 'placeholder' || prop === 'title' || prop === 'type' || prop === 'src' || prop === 'checked' || prop === 'id') return '';
      if (prop === 'disabled' || prop === 'hidden') return false;
      if (prop === 'length') return 0;
      if (typeof prop === 'symbol') return undefined;
      return makeEl();
    },
    set(t, prop, value) {
      if (prop === 'id' && typeof value === 'string') dynamicIds.add(value);
      return true;
    },
    apply() { return makeEl(); },
    has() { return true; }
  });
}

global.document = {
  getElementById: id => {
    if (!knownIds.has(id) && !dynamicIds.has(id)) {
      missingRefs.add(id);
      return null;                    /* 真实浏览器行为：找不到就是 null */
    }
    if (!els.has(id)) els.set(id, makeEl());
    return els.get(id);
  },
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

let failed = false;
try {
  require('../app.js');
} catch (e) {
  failed = true;
  console.log('❌ 初始化抛错:', e.message);
  console.log(e.stack.split('\n').slice(0, 6).join('\n'));
}

/* 静态检查：app.js 里所有 $('id') 引用都必须存在于 index.html
   （覆盖点击事件等初始化时不执行的代码路径） */
const jsSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const staticRefs = new Set([...jsSrc.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
const DYNAMIC_OK = new Set(['toast']); /* toast 是运行时 createElement 创建的 */
const staticMissing = [...staticRefs].filter(id => !knownIds.has(id) && !DYNAMIC_OK.has(id));

if (staticMissing.length) {
  failed = true;
  console.log('❌ 静态检查：app.js 引用了 index.html 中不存在的元素:');
  staticMissing.forEach(id => console.log('   #' + id));
}

if (missingRefs.size) {
  failed = true;
  console.log('❌ 运行时访问了不存在的元素（浏览器里会返回 null 并导致崩溃）:');
  [...missingRefs].forEach(id => console.log('   #' + id));
}

if (!failed) {
  console.log('✅ app.js 完整初始化执行成功，无运行时错误，无悬空元素引用');
  console.log('   HTML 元素:', knownIds.size, '| 绑定元素:', els.size, '| 静态引用:', staticRefs.size);
}
process.exit(failed ? 1 : 0);
