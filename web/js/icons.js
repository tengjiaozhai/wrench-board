// 内联 SVG 图标字符串 — 在各类渲染文本场景（按钮、行内徽章、模式选择器、SPOF 标记）
// 中替代 Unicode emoji。消费者赋给 innerHTML（非 textContent）以便解析 markup。
// 默认尺寸 `.icon-sm`（12×12，stroke 1.6）来自 layout.css；需要更大 16×16 时
// 通过 `.icon` 覆盖 class。颜色继承自父元素（`stroke="currentColor"`）。
//
// 手绘极简几何 — 未从任何图标库复制。

const BASE = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

// ------ 线形字形（用作按钮/芯片内的小行内前缀）------

export const ICON_CHECK =
  `<svg class="icon icon-sm" ${BASE}><polyline points="20 6 9 17 4 12"/></svg>`;

export const ICON_DIAMOND =
  `<svg class="icon icon-sm" ${BASE}><path d="M12 2L22 12 12 22 2 12z"/></svg>`;

export const ICON_DOT_FILLED =
  `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>`;

// ------ 状态字形（用于 schematic 观测选择器）------

export const ICON_CIRCLE =
  `<svg class="icon icon-sm" ${BASE}><circle cx="12" cy="12" r="9"/></svg>`;

export const ICON_CHECK_CIRCLE =
  `<svg class="icon icon-sm" ${BASE}><circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/></svg>`;

export const ICON_X_CIRCLE =
  `<svg class="icon icon-sm" ${BASE}><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`;

export const ICON_WARNING =
  `<svg class="icon icon-sm" ${BASE}><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 17h.01"/></svg>`;

export const ICON_FLAME =
  `<svg class="icon icon-sm" ${BASE}><path d="M12 3c-1 3-3 4-3 7a3 3 0 0 0 3 3 3 3 0 0 0 3-3c0-1-.5-2-1-3 3 1 5 3 5 6a6 6 0 0 1-12 0c0-4 3-6 5-10z"/></svg>`;

export const ICON_BOLT =
  `<svg class="icon icon-sm" ${BASE}><polygon points="13 2 4 14 11 14 11 22 20 10 13 10 13 2"/></svg>`;

export const ICON_LOCK =
  `<svg class="icon icon-sm" ${BASE}><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

export const ICON_BAN =
  `<svg class="icon icon-sm" ${BASE}><circle cx="12" cy="12" r="9"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

// ------ D3 辅助 — 在 SVG <g> 内追加警告字形（path）------
// 用于图标直接画在 board 画布上、无法插入 HTML SVG 字符串的场景
//（已在现有 <svg> 子树内）。传入 d3 selection；返回 selection 以便链式调用。
export function appendD3Warning(sel, { size = 10, className = "" } = {}) {
  const s = size;
  const g = sel.append("g")
    .attr("class", `sch-icon-warning ${className}`.trim())
    .attr("fill", "none")
    .attr("stroke", "currentColor")
    .attr("stroke-width", 1.4)
    .attr("stroke-linecap", "round")
    .attr("stroke-linejoin", "round");
  // 三角形
  g.append("path").attr("d", `M0 ${-s} L${s} ${s * 0.8} L${-s} ${s * 0.8} Z`);
  // 感叹号竖线 + 圆点
  g.append("path").attr("d", `M0 ${-s * 0.3} L0 ${s * 0.25}`);
  g.append("path").attr("d", `M0 ${s * 0.55} L0 ${s * 0.6}`);
  return g;
}
