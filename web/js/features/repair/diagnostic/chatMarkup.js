//  Diagnosticostic 聊天 — 代理降价渲染 + 可点击 refdes/net chips
//  （Phase D.6 来自llm.js的外部动作）。获取agent的原始文本，渲染它
//  通过标记 + DOMPurify （或 en CDN 不存在的纯文本后备），
//  then 运算结果放在板验证的 refdes / net token 转换为
// 驱动boardview的click可用chip。无模块状态。
//
//  永久连接：re广告窗。Boardview（经典的非ESM渲染器）
// 桥 — 请参阅 CLAUDE.md“Permanent 全局变量”）来验证 tokens 并采取行动
//  chip点击秒。标记/DOMPurify是全局CDN脚本，引用裸。

import { escapeHtml as escapeHTML } from '../../../shared/dom.js';
import { repairHash, parseRoute } from '../../../router.js';
import { getRepairId } from '../../../shared/context.js';

// 正则表达式形状。保留 loose — 语义过滤器是 Boardview 查找。
const RE_REFDES = /\b[A-Z]{1,3}\d{1,4}\b/g;
//  Nets：iPhone / Mac / Pi schematics 中使用的命名转换entions 的mm。
// purpose 上的比赛过多； Boardview.hasNet 是真理之门。
const RE_NET = /\b(?:PP_[A-Z0-9_]+|[PN]P_[A-Z0-9_]+|L\d{1,3}|VCC(?:_[A-Z0-9_]+)?|VDD(?:_[A-Z0-9_]+)?|AVDD(?:_[A-Z0-9_]+)?|DVDD(?:_[A-Z0-9_]+)?|GND(?:_[A-Z0-9_]+)?|[A-Z][A-Z0-9_]{3,})\b/g;
const RE_UNKNOWN_REFDES = /⟨\?([A-Z]{1,3}\d{1,4})⟩/g;

// 解析 markdown → sanitize → 遍历文本节点 → re放置经过验证的 tokens
//  与可点击chips。如果标记/DOMPurify 不在页面上，则后退
//  为纯文本（防御：网络卡顿加载CDN）。
export function renderAgentMarkup(container, text) {
  let html;
  if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
    const raw = marked.parse(text, { breaks: true, gfm: true });
    html = DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: ["p", "br", "strong", "em", "ul", "ol", "li", "code"],
      ALLOWED_ATTR: [],
    });
  } else {
    html = escapeHTML(text).replaceAll("\n", "<br>");
  }
  container.innerHTML = html;
  decorateChipsIn(container);
}

// 遍历 `root` 和 replace 验证的 refdes / net 下的所有文本节点
//  代币与可点击 chips，加上未知-refdes ⟨?U999⟩ 与琥珀
// 跨度。 <code> 内的文本被跳过（agent 的逐字 intent）。
function decorateChipsIn(root) {
  const hasBoard = !!(window.Boardview && window.Boardview.hasBoard && window.Boardview.hasBoard());
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      if (n.parentElement && n.parentElement.closest("code, .refdes-unknown, .chip-refdes, .chip-net"))
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  for (const textNode of targets) decorateOneTextNode(textNode, hasBoard);
}

function decorateOneTextNode(textNode, hasBoard) {
  const original = textNode.nodeValue;
  const matches = [];
  for (const m of original.matchAll(RE_UNKNOWN_REFDES)) {
    matches.push({ kind: "unknown", start: m.index, end: m.index + m[0].length, raw: m[0], inner: m[1] });
  }
  for (const m of original.matchAll(RE_REFDES)) {
    if (hasBoard && window.Boardview.hasRefdes(m[0])) {
      matches.push({ kind: "refdes", start: m.index, end: m.index + m[0].length, raw: m[0] });
    }
  }
  for (const m of original.matchAll(RE_NET)) {
    if (hasBoard && window.Boardview.hasNet(m[0])) {
      matches.push({ kind: "net", start: m.index, end: m.index + m[0].length, raw: m[0] });
    }
  }
  if (matches.length === 0) return;
  // 解决重叠问题：最早开始的优先，最长胜利打破en的平局。
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const cleaned = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue;
    cleaned.push(m);
    cursor = m.end;
  }
  const frag = document.createDocumentFragment();
  let i = 0;
  for (const m of cleaned) {
    if (m.start > i) frag.appendChild(document.createTextNode(original.slice(i, m.start)));
    frag.appendChild(makeChipNode(m));
    i = m.end;
  }
  if (i < original.length) frag.appendChild(document.createTextNode(original.slice(i)));
  textNode.parentNode.replaceChild(frag, textNode);
}

// Chip-click目标：如果我们're不是readyre，则将主视图切换到#pcb，
// then 运行boardview action。面板为推送模式，因此 board 显示
// 在左侧，聊天在右侧保持可见（420 px 条）。瓦en
// 我们必须导航，等待两个动画frames，这样该部分就变成了
//  可见且 brd_viewer 的 ResizeObserver 看到非零画布暗淡场景 —
// 否则 focus 平移将针对 0×0 canvas 和 end 进行计算
//  屏幕（ResizeObserver但是现在会自行刷新任何待处理的焦点，
//  nav-then-apply 看到排序还可以让焦点动作不真实的 DOM）。
function gotoBoardviewThen(fn) {
  const route = parseRoute();
  if (route.level === "repair" && route.vue === "pcb") {
    fn();
    return;
  }
  // 导航到活动 repair 的 pcb vue（规范哈希路由）。
  const id = route.level === "repair" ? route.id : getRepairId();
  if (id) window.location.hash = repairHash(id, "pcb");
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

function makeChipNode(match) {
  if (match.kind === "refdes") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-refdes";
    btn.dataset.refdes = match.raw;
    btn.textContent = match.raw;
    btn.addEventListener("click", () => {
      gotoBoardviewThen(() => window.Boardview?.focusRefdes?.(match.raw));
    });
    return btn;
  }
  if (match.kind === "net") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-net";
    btn.dataset.net = match.raw;
    btn.textContent = match.raw;
    btn.addEventListener("click", () => {
      gotoBoardviewThen(() => window.Boardview?.highlightNet?.(match.raw));
    });
    return btn;
  }
  const span = document.createElement("span");
  span.className = "refdes-unknown";
  span.textContent = match.raw;
  return span;
}
