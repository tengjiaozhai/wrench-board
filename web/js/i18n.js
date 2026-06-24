//  i18n 核心 — 普通，无构建步骤。
//
//  从 /i18n/_modules/{module}.{lang}.json 加载每个模块的 JSON 字典
//  并公开一个全局“i18n”API。默认区域设置：英语。法语，简体
//  提供中文和印地语作为备用语言环境。新语言环境 = 删除 a
//  `_modules/{module}.{lang}.json` 与现有的一起，将 lang 添加到
//  支持，并在“dicts”中播种一个空桶。
//
//  公共API：
//      i18n.t(key, params?) → 翻译后的字符串，params 插值 {name}
//      i18n.locale → 当前 'en' | 'fr' | 'zh' | '嗨'
//      i18n.setLocale(lang) → 切换 + 持久化 + 重新应用 DOM
//      i18n.applyDom(root?) → 重新翻译 `[data-i18n]` / `[data-i18n-attr]`
//      i18n.ready → Promise 一旦第一个字典加载就解决了
//      i18n.onReady(fn) → 加载字典后运行 fn
//      i18n.onChange(fn) → 通知语言环境切换（重新渲染钩子）

const SUPPORTED = ['en', 'fr', 'zh', 'hi'];
const DEFAULT_LOCALE = 'en';
const STORAGE_KEY = 'wb.locale';

//  静态模块列表——保持字母顺序。每个条目需要一个文件
//  支持的语言环境：web/i18n/_modules/{name}.{en,fr,zh,hi}.json
const MODULES = [
  'brd',
  'camera',
  'chat',
  'common',
  'graph',
  'home',
  'intro',
  'landing',
  'mascot',
  'memory_bank',
  'onboarding',
  'pipeline',
  'profile',
  'protocol',
  'repair',
  'router',
  'schematic',
  'stock',
];

const dicts = { en: {}, fr: {}, zh: {}, hi: {} };
const changeListeners = new Set();
let currentLocale = pickInitialLocale();
let readyResolve;
const ready = new Promise((res) => { readyResolve = res; });

function pickInitialLocale() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('lang');
  if (fromUrl && SUPPORTED.includes(fromUrl)) return fromUrl;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED.includes(stored)) return stored;
  } catch {}
  //  首次访问，没有明确的选择：匹配浏览器的首选
  //  语言，以便 zh-* / hi-* 访问者自动以他们的语言登陆。
  //  当没有任何匹配项时，会转为英语。
  try {
    const navLangs = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language];
    for (const tag of navLangs) {
      if (!tag) continue;
      const base = tag.toLowerCase().split('-')[0];
      if (SUPPORTED.includes(base)) return base;
    }
  } catch {}
  return DEFAULT_LOCALE;
}

async function loadModule(name, lang) {
  try {
    const res = await fetch(`/i18n/_modules/${name}.${lang}.json`, { cache: 'no-cache' });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

async function loadLocale(lang) {
  const merged = {};
  const results = await Promise.all(MODULES.map((m) => loadModule(m, lang)));
  for (let i = 0; i < MODULES.length; i++) {
    const ns = MODULES[i];
    merged[ns] = results[i] || {};
  }
  dicts[lang] = merged;
}

function lookup(key, lang) {
  const dict = dicts[lang];
  if (!dict) return undefined;
  const parts = key.split('.');
  let node = dict;
  for (const p of parts) {
    if (node && typeof node === 'object' && p in node) node = node[p];
    else return undefined;
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(tpl, params) {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

function t(key, params) {
  let val = lookup(key, currentLocale);
  if (val === undefined && currentLocale !== DEFAULT_LOCALE) {
    val = lookup(key, DEFAULT_LOCALE);
  }
  if (val === undefined) return key; //  丢失键的可见后备
  return interpolate(val, params);
}

function applyDom(root) {
  const scope = root || document;
  //  文字内容
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    const val = t(key);
    if (el.dataset.i18nHtml === '1') el.innerHTML = val;
    else el.textContent = val;
  });
  //  属性： data-i18n-attr="placeholder:chat.input.placeholder,title:chat.input.title"
  scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const spec = el.getAttribute('data-i18n-attr');
    if (!spec) return;
    spec.split(',').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (!attr || !key) return;
      el.setAttribute(attr, t(key));
    });
  });
  //  <html lang="…">
  if (document.documentElement) document.documentElement.setAttribute('lang', currentLocale);
}

async function setLocale(lang) {
  if (!SUPPORTED.includes(lang)) return;
  if (lang === currentLocale && Object.keys(dicts[lang] || {}).length) return;
  currentLocale = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
  if (!Object.keys(dicts[lang] || {}).length) await loadLocale(lang);
  applyDom();
  for (const fn of changeListeners) {
    try { fn(currentLocale); } catch (e) { console.error('[i18n] listener error', e); }
  }
}

function onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); }
function onReady(fn) { ready.then(fn); }

async function init() {
  await loadLocale(currentLocale);
  if (currentLocale !== DEFAULT_LOCALE) await loadLocale(DEFAULT_LOCALE);
  applyDom();
  readyResolve();
}

const api = { t, applyDom, setLocale, onChange, onReady, ready, get locale() { return currentLocale; }, SUPPORTED };
window.i18n = api;
window.t = t; //  全局快捷方式，方便在 JS 文件中使用

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

export default api;
export { t, applyDom, setLocale, onChange, onReady };
