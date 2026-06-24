// web/js/store.js
// 极简 pub/sub store。在 B–D 阶段取代 window.* 全局变量，作为模块间状态通道。约 40 行，无依赖。
//
// 用法：
//   import { store } from "./store.js";
//   const off = store.subscribe("board", (b) => render(b));
//   store.set("board", parsedBoard);   // 通知订阅者
//   const b = store.get("board");
//   off();                              // 取消订阅
//
// Phase C 键（由 router 经 shared/context.js 写入）：
//   "device"  -> 当前 device slug（string | null）
//   "repair"  -> 当前 repair id（string | null）

const _state = new Map();
const _subs = new Map(); // key -> Set<回调>

export const store = {
  get(key) {
    return _state.get(key);
  },
  set(key, value) {
    _state.set(key, value);
    const subs = _subs.get(key);
    if (subs) for (const cb of subs) {
      try { cb(value); } catch (e) { console.error(`[store] subscriber for "${key}" threw`, e); }
    }
  },
  subscribe(key, cb) {
    let subs = _subs.get(key);
    if (!subs) { subs = new Set(); _subs.set(key, subs); }
    subs.add(cb);
    return () => subs.delete(cb);
  },
};
