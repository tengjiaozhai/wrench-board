//  关系-schematicminimap。
//
//  1 跳 schematic 表面的 boardview 上的玻璃 overlay
//  单击的选择的邻域 — 物理 PCB 之间的桥梁
//  (boardview) 和逻辑幂树 (schematic)。
//
//  基于用户在 brd_viewer 中单击的内容的两种模式：
//      - 组件模式 — 中心显示 IC，按角色分组的引脚，rails
//          每边都消耗/生产/解耦。问题的答案是：
//          “这部分的电气作用是什么？”
//      - NET 模式（针点击）— 中心显示网络，每隔一个针显示网络
//          围绕其排列的同一网络：源 IC（如果电源rail）、消费者
//          IC、去耦电容。问题回答：“这上面还有什么？
//          信号？”
//
//  数据源：`/pipeline/packs/{slug}/schematic` — 编译后的
//  ElectricalGraph，第一次获取后在模块内缓存。

import { ICON_WARNING } from './icons.js';
import { getDeviceSlug, getRepairId } from './shared/context.js';
import { repairHash } from './router.js';

let schematicCache = null;       //  { slug，数据 }
let fetchInFlight = null;        //  {slug，承诺}
let wiredUI = false;
let enabled = (() => {
  try { return localStorage.getItem("bvMinimapEnabled") !== "false"; }
  catch (_) { return true; }
})();
let lastSelection = null;

const SVG_NS = "http://www.w3.org/2000/svg";

//  每个角色显示元数据 - 短大写缩写（保持稳定
//  跨语言环境，因为它们映射到标准 schematic 约定：VIN、
//  VOUT、EN、RST、FB、CLK、SIG、GND），图标是简单的 ASCII 字形，因此
//  文本在单列中保持对齐。
const ROLE_META = {
  power_in:        { label: "VIN",  glyph: "◄" },
  power_out:       { label: "VOUT", glyph: "►" },
  switch_node:     { label: "SW",   glyph: "~" },
  ground:          { label: "GND",  glyph: "⏚" },
  enable_in:       { label: "EN",   glyph: "◄" },
  enable_out:      { label: "EN↑",  glyph: "►" },
  reset_in:        { label: "RST",  glyph: "◄" },
  reset_out:       { label: "RST↑", glyph: "►" },
  power_good_out:  { label: "PG",   glyph: "►" },
  feedback_in:     { label: "FB",   glyph: "◄" },
  clock_in:        { label: "CLK",  glyph: "◄" },
  clock_out:       { label: "CLK↑", glyph: "►" },
  signal_in:       { label: "SIG",  glyph: "◄" },
  signal_out:      { label: "SIG↑", glyph: "►" },
};
const POWER_ROLES = new Set([
  "power_in", "power_out", "switch_node",
  "enable_in", "enable_out",
  "reset_in", "reset_out",
  "power_good_out", "feedback_in",
  "clock_in", "clock_out",
]);

//  一些 DOM 快捷方式。
function el(id) { return document.getElementById(id); }
function mkSvg(tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}
function mkEl(tag, attrs, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  if (text != null) node.textContent = text;
  return node;
}

function getSlug() {
  const qs = new URLSearchParams(window.location.search);
  return getDeviceSlug() || qs.get("board") || null;
}

async function loadSchematic(slug) {
  if (!slug) return null;
  if (schematicCache && schematicCache.slug === slug) return schematicCache.data;
  if (fetchInFlight && fetchInFlight.slug === slug) return fetchInFlight.promise;
  const promise = fetch(`/pipeline/packs/${encodeURIComponent(slug)}/schematic`)
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (data) schematicCache = { slug, data };
      fetchInFlight = null;
      return data;
    })
    .catch(() => { fetchInFlight = null; return null; });
  fetchInFlight = { slug, promise };
  return promise;
}

/*  ---------------------------------------------------------------------------------- *
 * 关系提取 *
 * ----------------------------------------------------------------------  */

//  根据网络与电源域的关系对网络进行分类。 `rail` 当它
//  当标签与接地图案匹配时，列在 power_rails 中，`gnd`，否则
//  `信号`。还可以解析电压标称值（如果可用），以便 UI 可以
//  徽章chips 带有“3.3V”等。
function classifyNet(data, netLabel) {
  if (!netLabel) return { kind: "signal" };
  if (netLabel === "GND" || /^(AGND|DGND|PGND|GROUND)$/i.test(netLabel)) {
    return { kind: "gnd", label: netLabel };
  }
  const rail = (data.power_rails || {})[netLabel];
  if (rail) {
    return {
      kind: "rail",
      label: netLabel,
      voltage: rail.voltage_nominal,
      source: rail.source_refdes,
      consumers: rail.consumers || [],
      decoupling: rail.decoupling || [],
    };
  }
  return { kind: "signal", label: netLabel };
}

function relationsForComponent(data, refdes) {
  const comp = (data.components || {})[refdes];
  if (!comp) return null;
  const rails = data.power_rails || {};
  const nets = data.nets || {};
  const pins = Array.isArray(comp.pins) ? comp.pins : [];

  //  按角色对图钉进行分组（折叠）——我们想要显示像这样的行
  //  “VIN (3) → +5V · 12 个其他引脚”而不是列出每个引脚
  //  接地引脚。
  const byRole = new Map();
  for (const pin of pins) {
    const r = pin.role || "signal_in";
    if (!byRole.has(r)) byRole.set(r, []);
    byRole.get(r).push(pin);
  }

  //  该组件参与的 Rails — 由 rails 索引驱动，更多
  //  比扫描 typed_edges 更可靠，因为 Opus 有时无法
  //  边缘分类但仍然正确填充 source_refdes / 消费者。
  const consumed = [];
  const produced = [];
  const decoupled = [];
  for (const [label, rail] of Object.entries(rails)) {
    if (rail.source_refdes === refdes) {
      produced.push({ label, rail });
    }
    if (Array.isArray(rail.consumers) && rail.consumers.includes(refdes)
        && rail.source_refdes !== refdes) {
      consumed.push({ label, rail });
    }
    if (Array.isArray(rail.decoupling) && rail.decoupling.includes(refdes)) {
      decoupled.push({ label, rail });
    }
  }

  return {
    mode: "component",
    refdes,
    type: comp.type,
    mpn: comp.value?.mpn || comp.value?.primary,
    populated: comp.populated !== false,
    pinsByRole: byRole,
    netIndex: nets,
    data, //  方便下游查找
    consumed, produced, decoupled,
  };
}

function relationsForNet(data, netLabel, clickedPinRef) {
  if (!netLabel) return null;
  const net = (data.nets || {})[netLabel];
  const classification = classifyNet(data, netLabel);
  //  nets[].connects 是“refdes.pin”字符串的平面列表。我们扩展它
  //  分成具有角色的结构化对象，以便渲染可以对消费者进行分组
  //  与生产者的解耦。
  const members = [];
  const raw = net?.connects || [];
  for (const token of raw) {
    const [refdes, pinNum] = token.split(".");
    if (!refdes) continue;
    const comp = (data.components || {})[refdes];
    let role = "signal_in";
    let pinName = null;
    if (comp && Array.isArray(comp.pins)) {
      const hit = comp.pins.find(p => String(p.number) === String(pinNum));
      if (hit) { role = hit.role || role; pinName = hit.name; }
    }
    members.push({
      refdes, pinNum, pinName, role,
      type: comp?.type || null,
      self: (clickedPinRef && clickedPinRef.refdes === refdes
             && String(clickedPinRef.pinNumber) === String(pinNum)),
    });
  }

  return {
    mode: "net",
    netLabel,
    classification,
    members,
    data,
    clickedPinRef,
  };
}

/*  ---------------------------------------------------------------------------------- *
 * 用户界面接线 *
 * ----------------------------------------------------------------------  */

function ensureUI() {
  if (wiredUI) return;
  el("bvMinimapClose")?.addEventListener("click", hideMinimap);
  wiredUI = true;
}

function hideMinimap() {
  const mm = el("bvMinimap");
  if (mm) { mm.classList.add("hidden"); mm.setAttribute("aria-hidden", "true"); }
}
function showMinimap() {
  const mm = el("bvMinimap");
  if (mm) { mm.classList.remove("hidden"); mm.setAttribute("aria-hidden", "false"); }
}

function clearSvg() {
  const ng = el("bvMinimapNodes");
  const lg = el("bvMinimapLinks");
  if (ng) while (ng.firstChild) ng.removeChild(ng.firstChild);
  if (lg) while (lg.firstChild) lg.removeChild(lg.firstChild);
}
function clearBody() {
  const b = el("bvMinimapBody");
  if (b) b.innerHTML = "";
}

function setHeader(kind, ref, sub) {
  //  kind 是“COMP”/“NET”之一——翻译为显示标签。
  const kindLabel = kind === "NET" ? t('brd.minimap.kind.net') : t('brd.minimap.kind.comp');
  el("bvMinimapKind").textContent = kindLabel;
  el("bvMinimapRef").textContent = ref || "…";
  el("bvMinimapSub").textContent = sub || "";
  const mm = el("bvMinimap");
  if (mm) mm.dataset.kind = kind === "NET" ? "net" : "component";
}

function renderEmpty(kind, ref, msg) {
  setHeader(kind, ref, "");
  clearSvg(); clearBody();
  const svg = el("bvMinimapSvg"); if (svg) svg.style.display = "none";
  const body = el("bvMinimapBody"); if (body) body.classList.add("hidden");
  const empty = el("bvMinimapEmpty");
  if (empty) { empty.style.display = "block"; empty.textContent = msg; }
}

function prepareRender() {
  clearSvg(); clearBody();
  const svg = el("bvMinimapSvg"); if (svg) svg.style.display = "block";
  const body = el("bvMinimapBody"); if (body) body.classList.remove("hidden");
  const empty = el("bvMinimapEmpty"); if (empty) empty.style.display = "none";
}

/*  ---------------------------------------------------------------------------------- *
 * 渲染 — 组件模式 *
 * ----------------------------------------------------------------------  */

//  svg 图中 rails 的小六边形。返回一个<g>。
function hexRail(cx, cy, entry, opts = {}) {
  const { scale = 1, isDecouple = false, onClick = null, tooltip = null } = opts;
  const w = 62 * scale, h = 22 * scale;
  const pts = [
    [cx - w/2, cy], [cx - w/2 + 6, cy - h/2], [cx + w/2 - 6, cy - h/2],
    [cx + w/2, cy], [cx + w/2 - 6, cy + h/2], [cx - w/2 + 6, cy + h/2],
  ].map(p => p.join(",")).join(" ");
  const g = mkSvg("g", {
    class: `bv-mm-node kind-${isDecouple ? "decouples" : "rail"} ${onClick ? "clickable" : ""}`,
  });
  if (tooltip) g.appendChild(mkSvg("title", {}, tooltip));
  g.appendChild(mkSvg("polygon", {
    class: `bv-mm-rail-shape${isDecouple ? " decouples" : ""}`, points: pts,
  }));
  const lbl = entry.label.length > 11 ? entry.label.slice(0, 10) + "…" : entry.label;
  g.appendChild(mkSvg("text", { class: "bv-mm-rail-label", x: cx, y: cy - 2 }, lbl));
  const volt = entry.rail?.voltage_nominal ?? entry.voltage;
  if (volt != null && scale >= 1) {
    g.appendChild(mkSvg("text", { class: "bv-mm-rail-sub", x: cx, y: cy + 9 }, `${volt} V`));
  }
  if (onClick) g.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
  return g;
}

function bezier(x1, y1, x2, y2) {
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

//  用于导航到 schematic rail 的共享函数 - 聚焦于给定的 rail。
function openRailInSchematic(railLabel) {
  const railId = `rail:${railLabel}`;
  try {
    localStorage.setItem("schLayoutMode", "railfocus");
    localStorage.setItem("schSelectedRail", railId);
  } catch (_) {}
  window.dispatchEvent(new CustomEvent("schematic:focus-rail", {
    detail: { railId, railLabel },
  }));
  //  跳转到主动修复的schematicvue（规范哈希路由）。
  const id = getRepairId();
  if (id) {
    const target = repairHash(id, "schematic");
    if (window.location.hash !== target) window.location.hash = target;
  }
}

function renderComponent(relations) {
  const { refdes, type, mpn, populated, pinsByRole, consumed, produced, decoupled, data } = relations;
  setHeader("COMP", refdes, [mpn, type].filter(Boolean).join(" · ") + (populated ? "" : " · NOSTUFF"));
  prepareRender();

  //  --- SVG 图：紧凑 IC + rail 侧翼 ---
  const nodesG = el("bvMinimapNodes");
  const linksG = el("bvMinimapLinks");
  const cx = 180, cy = 90;

  //  中心集成电路
  const center = mkSvg("g", { class: "bv-mm-node kind-center" });
  center.appendChild(mkSvg("rect", {
    class: "bv-mm-center-shape",
    x: cx - 34, y: cy - 17, width: 68, height: 34, rx: 5,
  }));
  center.appendChild(mkSvg("text", { class: "bv-mm-center-label", x: cx, y: cy - 2 }, refdes));
  center.appendChild(mkSvg("text", { class: "bv-mm-center-sub", x: cx, y: cy + 10 }, type || "comp"));
  nodesG.appendChild(center);

  //  消耗的铁轨 — 左
  const placeCol = (entries, colX, kind) => {
    const N = entries.length;
    const step = N <= 1 ? 0 : Math.min(36, 130 / (N - 1));
    entries.slice(0, 5).forEach((entry, i) => {
      const ry = cy + (i - (Math.min(N, 5) - 1) / 2) * step;
      const tip = entry.rail?.voltage_nominal != null
        ? t('brd.minimap.tooltip.open_rail_with_voltage', { label: entry.label, volt: entry.rail.voltage_nominal })
        : t('brd.minimap.tooltip.open_rail', { label: entry.label });
      nodesG.appendChild(hexRail(colX, ry, entry, {
        onClick: () => openRailInSchematic(entry.label),
        tooltip: tip,
      }));
      const [x1, y1, x2, y2] = kind === "powers"
        ? [colX + 31, ry, cx - 34, cy]
        : [cx + 34, cy, colX - 31, ry];
      linksG.appendChild(mkSvg("path", {
        class: `bv-mm-link bv-mm-link-${kind}`,
        d: bezier(x1, y1, x2, y2),
        "marker-end": `url(#bv-mm-arrow-${kind})`,
      }));
    });
    if (N > 5) {
      const last_y = cy + ((Math.min(N, 5) - 1) / 2 + 1) * step;
      nodesG.appendChild(mkSvg("text", {
        class: "bv-mm-more", x: colX, y: last_y, "text-anchor": "middle",
      }, `+${N - 5}`));
    }
  };
  placeCol(consumed, 55, "powers");
  placeCol(produced, 305, "produces");

  //  解耦——下面的行
  if (decoupled.length) {
    const yDec = cy + 62;
    const spanW = Math.min(240, decoupled.length * 44);
    const step = decoupled.length === 1 ? 0 : spanW / (decoupled.length - 1);
    decoupled.slice(0, 6).forEach((entry, i) => {
      const x = cx + (i - (Math.min(decoupled.length, 6) - 1) / 2) * step;
      nodesG.appendChild(hexRail(x, yDec, entry, {
        scale: 0.8, isDecouple: true,
        onClick: () => openRailInSchematic(entry.label),
        tooltip: t('brd.minimap.tooltip.decouple_cap', { label: entry.label }),
      }));
      linksG.appendChild(mkSvg("path", {
        class: "bv-mm-link bv-mm-link-decouples",
        d: `M${cx},${cy + 17} L${x},${yDec - 10}`,
        "marker-end": "url(#bv-mm-arrow-decouples)",
      }));
    });
  }

  //  当该部分根本没有权力关系时，居中后备文本 —
  //  避免周围没有任何东西的悬挂 IC 盒。
  if (consumed.length + produced.length + decoupled.length === 0) {
    nodesG.appendChild(mkSvg("text", {
      class: "bv-mm-nodata", x: 180, y: cy + 52,
    }, t('brd.minimap.rail.no_power_role')));
  }

  //  --- 正文：按角色分类 + rail 消费者数量 ---
  const body = el("bvMinimapBody");

  //  如果此组件或其生成的任何 rail 是 SPOF，则SPOF 徽章。
  //  从 power_rails 拉取 — 原始图表上没有爆炸半径，但
  //  生产的 rail 与许多消费者的存在是一个代理。
  const producedRailWithMost = produced
    .map(e => (e.rail.consumers || []).length)
    .reduce((a, b) => Math.max(a, b), 0);

  if (producedRailWithMost >= 3) {
    const spofRow = mkEl("div", { class: "bv-mm-row" });
    const spofText = producedRailWithMost > 1
      ? t('brd.minimap.spof', { n: producedRailWithMost })
      : t('brd.minimap.spof_one', { n: producedRailWithMost });
    spofRow.appendChild(mkEl("span", {
      class: "bv-mm-spof",
      html: `${ICON_WARNING} ${spofText}`,
    }));
    body.appendChild(spofRow);
  }

  //  引脚部分 — 每个角色一行，列出引脚编号及其网络。
  const pinSection = mkEl("div", { class: "bv-mm-section" });
  pinSection.appendChild(mkEl("div", { class: "bv-mm-section-head" }, t('brd.minimap.section.pins', { n: pinCount(pinsByRole) })));
  const renderedRoles = [];
  //  按重要性对角色进行排序，以实现以权力为中心的诊断。
  const roleOrder = [
    "power_in", "power_out", "switch_node", "enable_in", "enable_out",
    "power_good_out", "reset_in", "reset_out", "feedback_in",
    "clock_in", "clock_out", "signal_in", "signal_out", "ground",
  ];
  for (const role of roleOrder) {
    const pins = pinsByRole.get(role);
    if (!pins || !pins.length) continue;
    renderedRoles.push(role);
    pinSection.appendChild(renderPinRoleRow(role, pins, data, refdes));
  }
  //  任何不符合规范顺序的角色（未来的扩展）——在最后渲染。
  for (const [role, pins] of pinsByRole) {
    if (renderedRoles.includes(role)) continue;
    pinSection.appendChild(renderPinRoleRow(role, pins, data, refdes));
  }
  body.appendChild(pinSection);

  //  铁路详细信息 - 对于每个消耗/生产的 rail，列出 IC 对等方
  //  （“其他大消费者对此rail”）所以技术知道还有什么
  //  共享信号。从同行列表中排除上限（他们住在
  //  上面的专用解耦部分）。
  if (consumed.length) body.appendChild(renderRailContextSection(t('brd.minimap.section.powered_by'), consumed, refdes, data));
  if (produced.length) body.appendChild(renderRailContextSection(t('brd.minimap.section.powers'), produced, refdes, data));
  if (decoupled.length) {
    const s = mkEl("div", { class: "bv-mm-section" });
    s.appendChild(mkEl("div", { class: "bv-mm-section-head" }, t('brd.minimap.section.decouples', { n: decoupled.length })));
    const row = mkEl("div", { class: "bv-mm-row" });
    decoupled.slice(0, 8).forEach(e => {
      const chip = mkEl("span", { class: "bv-mm-chip rail" }, e.label);
      chip.addEventListener("click", () => openRailInSchematic(e.label));
      row.appendChild(chip);
    });
    if (decoupled.length > 8) row.appendChild(mkEl("span", { class: "bv-mm-more" }, `+${decoupled.length - 8}`));
    s.appendChild(row);
    body.appendChild(s);
  }
}

function pinCount(byRole) {
  let n = 0; for (const v of byRole.values()) n += v.length; return n;
}

//  渲染单个引脚角色行，例如：◄ VIN 3 → +5V（网络上的 16 个 autres）
function renderPinRoleRow(role, pins, data, selfRefdes) {
  const meta = ROLE_META[role] || { label: role.toUpperCase(), glyph: "·" };
  const row = mkEl("div", { class: "bv-mm-row" });
  row.appendChild(mkEl("span", { class: "bv-mm-pinlabel" }, `${meta.glyph} ${meta.label}`));
  //  对于地面，折叠成“GND·4 针”以避免膨胀。
  if (role === "ground") {
    const pinNums = pins.map(p => p.number).join(", ");
    const countLbl = pins.length > 1
      ? t('brd.minimap.pin.ground_count', { n: pins.length })
      : t('brd.minimap.pin.ground_count_one', { n: pins.length });
    row.appendChild(mkEl("span", { class: "bv-mm-pinnum" }, countLbl));
    row.appendChild(mkEl("span", { class: "bv-mm-muted" }, t('brd.minimap.pin.ground_list', { pins: pinNums })));
    return row;
  }
  //  按网络标签对引脚进行分组，以便相同的网络出现一次：“2, 4 → +1V8”
  const byNet = new Map();
  for (const p of pins) {
    const nl = p.net_label || t('brd.minimap.pin.no_net');
    if (!byNet.has(nl)) byNet.set(nl, []);
    byNet.get(nl).push(p.number);
  }
  const entries = [...byNet.entries()];
  entries.forEach(([netLabel, pinNums], i) => {
    if (i > 0) row.appendChild(mkEl("span", { class: "bv-mm-muted" }, "·"));
    row.appendChild(mkEl("span", { class: "bv-mm-pinnum" }, pinNums.join(",")));
    row.appendChild(mkEl("span", { class: "bv-mm-arrow" }, "→"));
    const cls = classifyNet(data, netLabel);
    const chip = mkEl("span", {
      class: `bv-mm-chip ${cls.kind === "rail" ? "rail" : cls.kind === "gnd" ? "gnd" : "signal"}`,
    }, netLabel);
    if (cls.kind === "rail") {
      chip.addEventListener("click", () => openRailInSchematic(netLabel));
    } else {
      chip.addEventListener("click", () => showNetFromLabel(netLabel));
    }
    row.appendChild(chip);
    //  该网络上的对等计数 - 总引脚数减去属于该网络的引脚数
    //  我们当前正在查看的组件。
    const netConnects = data.nets?.[netLabel]?.connects || [];
    const selfCount = netConnects.filter(tok => tok.startsWith(selfRefdes + ".")).length;
    const peerCount = Math.max(0, netConnects.length - selfCount);
    if (peerCount > 0) {
      row.appendChild(mkEl("span", { class: "bv-mm-muted" }, t('brd.minimap.section.more_others', { n: peerCount })));
    }
  });
  return row;
}

function renderRailContextSection(title, railEntries, selfRef, data) {
  const section = mkEl("div", { class: "bv-mm-section" });
  //  后缀“(N)”与语言无关——与本地化标题组成。
  section.appendChild(mkEl("div", { class: "bv-mm-section-head" }, `${title} (${railEntries.length})`));
  railEntries.forEach(entry => {
    const row = mkEl("div", { class: "bv-mm-row" });
    const chip = mkEl("span", { class: "bv-mm-chip rail" }, entry.label);
    chip.addEventListener("click", () => openRailInSchematic(entry.label));
    row.appendChild(chip);
    //  rail 上的 IC 对等点数量（不包括上限）——还有什么会流失
    //  这个rail？
    const peers = (entry.rail.consumers || []).filter(r => r !== selfRef);
    const source = entry.rail.source_refdes;
    if (source && source !== selfRef) {
      const srcChip = mkEl("span", { class: "bv-mm-chip comp producer" }, t('brd.minimap.rail.source', { refdes: source }));
      row.appendChild(srcChip);
    }
    const shownPeers = peers.slice(0, 5);
    shownPeers.forEach(r => {
      const comp = (data.components || {})[r];
      const cchip = mkEl("span", { class: "bv-mm-chip comp" }, r);
      if (comp?.type) {
        cchip.title = comp.value?.mpn
          ? t('brd.minimap.tooltip.comp_type_mpn', { refdes: r, type: comp.type, mpn: comp.value.mpn })
          : t('brd.minimap.tooltip.comp_type', { refdes: r, type: comp.type });
      }
      row.appendChild(cchip);
    });
    if (peers.length > 5) row.appendChild(mkEl("span", { class: "bv-mm-more" }, t('brd.minimap.section.more', { n: peers.length - 5 })));
    if (peers.length === 0 && !source) {
      row.appendChild(mkEl("span", { class: "bv-mm-muted" }, t('brd.minimap.rail.no_peers')));
    }
    section.appendChild(row);
  });
  return section;
}

/*  ---------------------------------------------------------------------------------- *
 * 渲染 — 网络模式（针点击）*
 * ----------------------------------------------------------------------  */

function renderNet(relations) {
  const { netLabel, classification, members, clickedPinRef, data } = relations;
  const subBits = [];
  if (classification.kind === "rail" && classification.voltage != null) subBits.push(t('brd.minimap.subhead.voltage', { volt: classification.voltage }));
  if (classification.kind === "rail") subBits.push(t('brd.minimap.subhead.rail'));
  else if (classification.kind === "gnd") subBits.push(t('brd.minimap.subhead.ground'));
  else subBits.push(t('brd.minimap.subhead.signal'));
  subBits.push(members.length > 1
    ? t('brd.minimap.subhead.pins_count', { n: members.length })
    : t('brd.minimap.subhead.pin_count', { n: members.length }));
  setHeader("NET", netLabel, subBits.join(" · "));
  prepareRender();

  //  --- SVG：净六边形居中，成员 chips 径向排列 ---
  const nodesG = el("bvMinimapNodes");
  const linksG = el("bvMinimapLinks");
  const cx = 180, cy = 95;

  const netEntry = { label: netLabel, rail: classification.kind === "rail" ? { voltage_nominal: classification.voltage } : null };
  const netNode = hexRail(cx, cy, netEntry, {
    scale: 1.15,
    isDecouple: classification.kind === "gnd",
    onClick: classification.kind === "rail" ? () => openRailInSchematic(netLabel) : null,
    tooltip: classification.kind === "rail" ? t('brd.minimap.tooltip.open_rail_focus') : null,
  });
  nodesG.appendChild(netNode);

  //  六角形周围的成员——按角色重要性排序。
  const rolePriority = {
    power_out: 0, switch_node: 0,        //  生产者第一
    power_in: 1,
    enable_in: 2, enable_out: 2, power_good_out: 2, reset_in: 2, reset_out: 2,
    feedback_in: 3,
    clock_in: 4, clock_out: 4,
    signal_in: 5, signal_out: 5,
    ground: 9,
  };
  const sorted = [...members].sort((a, b) => {
    const pa = rolePriority[a.role] ?? 6, pb = rolePriority[b.role] ?? 6;
    if (pa !== pb) return pa - pb;
    return a.refdes.localeCompare(b.refdes, undefined, { numeric: true });
  });

  //  在六角形下方的半圆中最多放置 8 个chip。
  const visible = sorted.slice(0, 8);
  const R = 62;
  const arcStart = Math.PI * 0.15, arcEnd = Math.PI * 0.85;
  visible.forEach((m, i) => {
    const t = visible.length === 1 ? 0.5 : i / (visible.length - 1);
    const theta = arcStart + (arcEnd - arcStart) * t;
    const mx = cx - Math.cos(theta) * R * 1.8;
    const my = cy + Math.sin(theta) * R;
    const clamped = Math.max(28, Math.min(332, mx));
    //  一个小矩形chip
    const isProd = (m.role === "power_out" || m.role === "switch_node");
    const chipClass = m.self
      ? "bv-mm-rail-shape"  //  重复使用 rail 形状打造彩环外观
      : "bv-mm-rail-shape";
    const g = mkSvg("g", {
      class: `bv-mm-node ${m.self ? "kind-self" : isProd ? "kind-producer" : "kind-comp"} clickable`,
    });
    g.appendChild(mkSvg("title", {}, m.type
      ? t('brd.minimap.tooltip.pin_role_type_full', { refdes: m.refdes, pin: m.pinNum, role: m.pinName || m.role, type: m.type })
      : t('brd.minimap.tooltip.pin_role_type', { refdes: m.refdes, pin: m.pinNum, role: m.pinName || m.role })));
    const w = 44, h = 18;
    g.appendChild(mkSvg("rect", {
      x: clamped - w/2, y: my - h/2, width: w, height: h, rx: 3,
      fill: m.self ? "rgba(245,158,11,.16)"
            : isProd ? "rgba(245,158,11,.12)"
            : "rgba(56,189,248,.12)",
      stroke: m.self ? "oklch(0.82 0.16 75)"
            : isProd ? "oklch(0.78 0.16 75)"
            : "oklch(0.78 0.14 210)",
      "stroke-width": m.self ? "1.8" : "1.2",
    }));
    g.appendChild(mkSvg("text", {
      class: "bv-mm-rail-label", x: clamped, y: my - 1,
      fill: m.self ? "oklch(0.92 0.14 75)" : isProd ? "oklch(0.88 0.15 75)" : "oklch(0.88 0.13 210)",
    }, `${m.refdes}.${m.pinNum}`));
    g.appendChild(mkSvg("text", {
      class: "bv-mm-rail-sub", x: clamped, y: my + 8,
      fill: "var(--text-3)",
    }, m.pinName || (ROLE_META[m.role]?.label ?? "")));
    //  从净六角到此chip的飞线
    linksG.appendChild(mkSvg("path", {
      class: `bv-mm-link bv-mm-link-${isProd ? "produces" : "powers"}`,
      d: `M${cx},${cy} L${clamped},${my}`,
    }));
    nodesG.appendChild(g);
  });
  if (members.length > visible.length) {
    nodesG.appendChild(mkSvg("text", {
      class: "bv-mm-more", x: 180, y: 178, "text-anchor": "middle",
    }, t('brd.minimap.rail.more_pins_on_net', { n: members.length - visible.length, net: netLabel })));
  }

  //  --- 正文：按角色分组列表 ---
  const body = el("bvMinimapBody");

  //  SPOF / rail 上下文横幅
  if (classification.kind === "rail") {
    const ctx = mkEl("div", { class: "bv-mm-row" });
    ctx.appendChild(mkEl("span", { class: "bv-mm-pinlabel" }, t('brd.minimap.rail.label')));
    const chip = mkEl("span", { class: "bv-mm-chip rail" }, t('brd.minimap.rail.open_in_schematic'));
    chip.addEventListener("click", () => openRailInSchematic(netLabel));
    ctx.appendChild(chip);
    if (classification.source) {
      const src = mkEl("span", { class: "bv-mm-chip comp producer" }, t('brd.minimap.rail.source', { refdes: classification.source }));
      ctx.appendChild(src);
    }
    body.appendChild(ctx);
  }

  //  按角色分组的引脚
  const byRole = new Map();
  for (const m of members) {
    if (!byRole.has(m.role)) byRole.set(m.role, []);
    byRole.get(m.role).push(m);
  }
  const roleOrder = [
    "power_out", "switch_node", "power_in", "enable_in", "enable_out",
    "power_good_out", "reset_in", "reset_out", "feedback_in",
    "clock_in", "clock_out", "signal_in", "signal_out", "ground",
  ];
  for (const role of roleOrder) {
    const arr = byRole.get(role);
    if (!arr || !arr.length) continue;
    body.appendChild(renderNetRoleRow(role, arr, data));
  }
  for (const [role, arr] of byRole) {
    if (roleOrder.includes(role)) continue;
    body.appendChild(renderNetRoleRow(role, arr, data));
  }
}

function renderNetRoleRow(role, members, data) {
  const meta = ROLE_META[role] || { label: role.toUpperCase(), glyph: "·" };
  const section = mkEl("div", { class: "bv-mm-section" });
  section.appendChild(mkEl("div", { class: "bv-mm-section-head" },
    `${meta.glyph} ${meta.label} (${members.length})`));
  const row = mkEl("div", { class: "bv-mm-row" });
  //  按 refdes 合并，以便显示同一网络上具有多个引脚的 IC
  //  一次：“U14·引脚3,5”
  const byRef = new Map();
  for (const m of members) {
    if (!byRef.has(m.refdes)) byRef.set(m.refdes, { refdes: m.refdes, type: m.type, pins: [], self: false });
    byRef.get(m.refdes).pins.push(m.pinNum);
    if (m.self) byRef.get(m.refdes).self = true;
  }
  const entries = [...byRef.values()].slice(0, 14);
  entries.forEach(e => {
    const type = e.type || "";
    const isCap = type === "capacitor";
    const cls = e.self ? "self" : (role === "power_out" || role === "switch_node") ? "producer" : "";
    const pinList = e.pins.join(", ");
    let chipTitle;
    if (e.pins.length > 1) {
      chipTitle = type
        ? t('brd.minimap.tooltip.pins_of_ref', { refdes: e.refdes, type, pins: pinList })
        : t('brd.minimap.tooltip.pins_of_ref_no_type', { refdes: e.refdes, pins: pinList });
    } else {
      chipTitle = type
        ? t('brd.minimap.tooltip.pin_of_ref', { refdes: e.refdes, type, pins: pinList })
        : t('brd.minimap.tooltip.pin_of_ref_no_type', { refdes: e.refdes, pins: pinList });
    }
    const chip = mkEl("span", {
      class: `bv-mm-chip ${isCap ? "cap" : "comp"} ${cls}`,
      title: chipTitle,
    }, e.pins.length === 1 ? `${e.refdes}.${e.pins[0]}` : `${e.refdes}·${e.pins.length}`);
    row.appendChild(chip);
  });
  if (byRef.size > entries.length) {
    row.appendChild(mkEl("span", { class: "bv-mm-more" }, t('brd.minimap.section.more', { n: byRef.size - entries.length })));
  }
  section.appendChild(row);
  return section;
}

//  将 minimap 切换到仅给出网络标签的以网络为中心的视图（未单击
//  引脚上下文）。单击组件模式主体内的 chip 时使用。
function showNetFromLabel(netLabel) {
  const data = schematicCache?.data;
  if (!data) return;
  const relations = relationsForNet(data, netLabel, null);
  if (!relations) return;
  renderNet(relations);
}

/*  ---------------------------------------------------------------------------------- *
 * 派遣 *
 * ----------------------------------------------------------------------  */

async function handleSelection(detail) {
  ensureUI();
  const refdes = detail?.refdes;
  if (refdes) lastSelection = detail;
  if (!enabled) { hideMinimap(); return; }
  if (!refdes) { hideMinimap(); return; }
  showMinimap();

  const slug = getSlug();
  if (!slug) { renderEmpty("COMP", refdes, t('brd.minimap.no_device')); return; }
  //  加载时的骨架。
  setHeader("COMP", refdes, t('brd.minimap.loading_short'));
  clearSvg(); clearBody();
  const svg = el("bvMinimapSvg"); if (svg) svg.style.display = "none";
  const empty = el("bvMinimapEmpty"); if (empty) { empty.style.display = "block"; empty.textContent = t('brd.minimap.loading'); }

  const data = await loadSchematic(slug);
  if (!data) { renderEmpty("COMP", refdes, t('brd.minimap.no_schematic')); return; }

  //  引脚单击路径 — 用户单击组件的特定引脚。
  //  显示该引脚及其所有其他成员的 NET。
  if (detail.pinNet) {
    const relations = relationsForNet(data, detail.pinNet, {
      refdes, pinNumber: detail.pinNumber,
    });
    if (relations && relations.members.length) {
      renderNet(relations);
      return;
    }
    //  如果网络未知，则进入组件模式。
  }

  const relations = relationsForComponent(data, refdes);
  if (!relations) { renderEmpty("COMP", refdes, t('brd.minimap.unknown_in_schematic', { refdes })); return; }
  renderComponent(relations);
}

window.addEventListener("bv:selection", (ev) => {
  handleSelection(ev.detail || {});
});

window.addEventListener("bv:minimap-toggle", (ev) => {
  enabled = Boolean(ev.detail?.enabled);
  if (!enabled) { hideMinimap(); return; }
  if (lastSelection?.refdes) handleSelection(lastSelection);
});

//  重新渲染语言环境切换上的 minimap 内容，以便动态标签
//  （章节标题、工具提示、角色行）选择新词典。
if (window.i18n && typeof window.i18n.onChange === "function") {
  window.i18n.onChange(() => {
    if (enabled && lastSelection?.refdes) handleSelection(lastSelection);
  });
}
