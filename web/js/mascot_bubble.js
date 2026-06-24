// 吉祥物语音气泡 - 锚定到目标元素的单个玻璃工具提示，
// 由入职orchestrator使用，让吉祥物“说话”并指向
// 着陆区。无框架，一次一个气泡（单例）。
//
// 视觉样式（玻璃表面、箭头、控件）位于
// “.mascot-bubble”下的“web/styles/onboarding.css”。该模块仅拥有
// DOM 创建、定位（使用视口边缘自动翻转）和
// Next/Skip 控制接线 — 与 Pickr 选择器相同的弹出式翻转精神。
//
// API:
// showBubble({ 锚点、文本、下一个、跳过、nextLabel、skipLabel、放置 })
// 隐藏气泡()
//
// 锚：元素| DOM矩形| {x,y} — 箭头所指的位置
// text ：字符串（已本地化）显示为正文
// next : () => void — 设置后，呈现主“下一步”按钮
// Skip : () => void — 设置后，呈现一个安静的“Skip”链接
// 位置：“顶部”| “底部”| “左”| “右”（首选；自动翻转）

import { t } from "./i18n.js";

const MARGIN = 12; // 气泡与锚点/视口边缘之间的间隙

let _bubble = null;
let _spotlight = null;  // 昏暗的一切，但这个覆盖（通过聚光灯选择加入：true）
let _reposition = null; // 绑定监听器，这样我们就可以在隐藏时将其删除

// 聚光灯 = 锚点上方的透明框，带有巨大的暗框阴影，所以
// 它周围的一切都变暗了，锚定区域显示为“亮起”。相同的 div 是
// 跨气泡重复使用，因此光孔从一个区域移动到另一个区域（CSS 过渡）。
function _applySpotRect(rect) {
  const pad = 8;
  const s = _spotlight.style;
  s.left = `${Math.round(rect.left - pad)}px`;
  s.top = `${Math.round(rect.top - pad)}px`;
  s.width = `${Math.round(rect.width + pad * 2)}px`;
  s.height = `${Math.round(rect.height + pad * 2)}px`;
}

function _placeSpotlight(rect) {
  if (!_spotlight) {
    _spotlight = document.createElement("div");
    _spotlight.className = "mascot-spotlight";
    _spotlight.setAttribute("aria-hidden", "true");
    document.body.appendChild(_spotlight);
    _applySpotRect(rect);                 // 淡入前的位置（不从 0,0 滑动）
    const sp = _spotlight;
    requestAnimationFrame(() => { if (_spotlight === sp) sp.classList.add("is-shown"); });
  } else {
    _applySpotRect(rect);                 // 变形到新区域
  }
}

function _removeSpotlight() {
  if (!_spotlight) return;
  const sp = _spotlight;
  _spotlight = null;
  sp.classList.remove("is-shown");
  setTimeout(() => sp.remove(), 240);     // 淡出后
}

function _rectOf(anchor) {
  if (!anchor) return null;
  if (anchor instanceof Element) return anchor.getBoundingClientRect();
  if (typeof anchor.left === "number") return anchor; // 已经是类似 DOMRect 的了
  if (typeof anchor.x === "number") {
    return { left: anchor.x, top: anchor.y, right: anchor.x, bottom: anchor.y, width: 0, height: 0 };
  }
  return null;
}

// 从首选位置开始，选择一个合适的位置。返回
// 选择的一方；调用者读回它以定位箭头。
function _choosePlacement(preferred, rect, bw, bh) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fits = {
    bottom: rect.bottom + MARGIN + bh <= vh,
    top: rect.top - MARGIN - bh >= 0,
    right: rect.right + MARGIN + bw <= vw,
    left: rect.left - MARGIN - bw >= 0,
  };
  const order = [preferred, "bottom", "top", "right", "left"];
  for (const side of order) {
    if (fits[side]) return side;
  }
  return preferred || "bottom";
}

function _position(rect, placement) {
  const el = _bubble;
  const bw = el.offsetWidth;
  const bh = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const side = _choosePlacement(placement, rect, bw, bh);

  let left;
  let top;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  if (side === "bottom" || side === "top") {
    left = cx - bw / 2;
    top = side === "bottom" ? rect.bottom + MARGIN : rect.top - MARGIN - bh;
  } else {
    top = cy - bh / 2;
    left = side === "right" ? rect.right + MARGIN : rect.left - MARGIN - bw;
  }

  // 夹入视口，保持箭头对准锚点中心。
  left = Math.max(MARGIN, Math.min(left, vw - bw - MARGIN));
  top = Math.max(MARGIN, Math.min(top, vh - bh - MARGIN));

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.dataset.placement = side;

  // 箭头沿着气泡边缘偏移，指向锚中心。
  const arrow = el.querySelector(".mascot-bubble-arrow");
  if (arrow) {
    if (side === "bottom" || side === "top") {
      const ax = Math.max(14, Math.min(cx - left, bw - 14));
      arrow.style.left = `${Math.round(ax)}px`;
      arrow.style.top = "";
    } else {
      const ay = Math.max(14, Math.min(cy - top, bh - 14));
      arrow.style.top = `${Math.round(ay)}px`;
      arrow.style.left = "";
    }
  }
}

function _teardownBubble() {
  if (_reposition) {
    window.removeEventListener("resize", _reposition);
    window.removeEventListener("scroll", _reposition, true);
    _reposition = null;
  }
  if (_bubble) {
    _bubble.remove();
    _bubble = null;
  }
}

export function hideBubble() {
  _teardownBubble();
  _removeSpotlight();
}

export function showBubble({ anchor, text, next, skip, nextLabel, skipLabel, placement = "bottom", spotlight = false }) {
  // 放弃以前的泡沫，但保持聚光灯，这样它就可以演变成新的
  // 区域（或者如果该气泡不需要，则将其从下面移除）。
  _teardownBubble();

  const rect = _rectOf(anchor) || {
    left: window.innerWidth / 2, top: window.innerHeight / 2,
    right: window.innerWidth / 2, bottom: window.innerHeight / 2, width: 0, height: 0,
  };

  const el = document.createElement("div");
  el.className = "mascot-bubble";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-live", "polite");

  const body = document.createElement("p");
  body.className = "mascot-bubble-body";
  body.textContent = text || "";
  el.appendChild(body);

  if (next || skip) {
    const actions = document.createElement("div");
    actions.className = "mascot-bubble-actions";

    if (skip) {
      const s = document.createElement("button");
      s.type = "button";
      s.className = "mascot-bubble-skip";
      s.textContent = skipLabel || t("onboarding.skip");
      s.addEventListener("click", () => skip());
      actions.appendChild(s);
    }
    if (next) {
      const n = document.createElement("button");
      n.type = "button";
      n.className = "mascot-bubble-next";
      n.textContent = nextLabel || t("onboarding.next");
      n.addEventListener("click", () => next());
      actions.appendChild(n);
    }
    el.appendChild(actions);
  }

  const arrow = document.createElement("span");
  arrow.className = "mascot-bubble-arrow";
  arrow.setAttribute("aria-hidden", "true");
  el.appendChild(arrow);

  document.body.appendChild(el);
  _bubble = el;

  _position(rect, placement);

  // 聚光灯仅在真实元素区域（不是居中、
  // 无锚气泡）。来自前一个区域的变形；如果不需要则删除。
  const wantSpot = spotlight && anchor instanceof Element;
  if (wantSpot) _placeSpotlight(rect);
  else _removeSpotlight();

  // 将气泡（和聚光灯）粘在其（可能移动的）锚点上。
  _reposition = () => {
    const r = _rectOf(anchor);
    if (r) {
      _position(r, placement);
      if (wantSpot) _placeSpotlight(r);
    }
  };
  window.addEventListener("resize", _reposition);
  window.addEventListener("scroll", _reposition, true);

  return el;
}
