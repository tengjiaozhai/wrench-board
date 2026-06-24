// 扳手板吉祥物 — 将 <template id="tpl-mascot"> 克隆到目标中，
// 应用大小 + 状态类，返回已安装的 <svg>。配对
// `web/styles/mascot.css` （空闲呼吸，眨眼，加上每个状态
// 动画）和“web/js/mascot_states.js”（状态注册表）。

import { MASCOT_STATE_IDS } from "./mascot_states.js";

const VALID_SIZES = new Set(["xs", "sm", "md", "lg"]);
const VALID_STATES = new Set(MASCOT_STATE_IDS);

function getTemplate() {
  const tpl = document.getElementById("tpl-mascot");
  if (!tpl || !(tpl instanceof HTMLTemplateElement)) {
    console.warn("[mascot] <template id=\"tpl-mascot\"> not found in document");
    return null;
  }
  return tpl;
}

/**
 * 将吉祥物 SVG 克隆到“target”中，替换其中的任何内容。
 * @param {Element} 目标挂载点（div/span/等）
 * @param {{大小？：字符串，状态？：字符串}} [选项]
 * 尺寸：xs (32px) | sm (80 像素) | MD (160 像素) | LG (320px)，默认“sm”
 * 状态：空闲 | thinking |工作|成功|错误，默认“空闲”
 * @returns {SVGSVGElement|null} 已挂载的 SVG，如果挂载失败则为 null。
 */
export function mountMascot(target, opts = {}) {
  if (!target) return null;
  const tpl = getTemplate();
  if (!tpl) return null;

  const size = VALID_SIZES.has(opts.size) ? opts.size : "sm";
  const state = VALID_STATES.has(opts.state) ? opts.state : "idle";

  const clone = tpl.content.firstElementChild.cloneNode(true);
  clone.classList.add("mascot", `mascot-${size}`, `is-${state}`);
  // 可访问性——模板没有提供角色/标签，因此我们在这里设置一个。
  // 通过下面的 onChange 挂钩重新应用区域设置更改。
  clone.setAttribute("role", "img");
  clone.setAttribute("aria-label", t("mascot.aria.label"));
  target.replaceChildren(clone);
  return clone;
}

if (window.i18n && window.i18n.onChange) {
  window.i18n.onChange(() => {
    document.querySelectorAll("svg.mascot[role='img']").forEach((svg) => {
      svg.setAttribute("aria-label", t("mascot.aria.label"));
    });
  });
}

/**
 * 切换已安装吉祥物（或任何元素marked.mascot）上的状态类。
 * 在添加新类之前删除任何现有的 is-* 类。传递 null/未定义
 *状态清除所有状态类（返回到空闲默认值）。
 */
export function setMascotState(svg, state) {
  if (!svg) return;
  for (const cls of [...svg.classList]) {
    if (cls.startsWith("is-")) svg.classList.remove(cls);
  }
  if (state && VALID_STATES.has(state)) {
    svg.classList.add(`is-${state}`);
  }
}
