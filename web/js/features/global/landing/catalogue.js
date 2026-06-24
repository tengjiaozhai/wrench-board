// 设备目录 modal — 阶梯式选择oser：类型 → 品牌 → Boards → 文件。
// 不知道设备名称的技术人员可以按设备类型进行深入分析，then
// 品牌，第en选择board。搜索框快捷方式直接指向 matching
// boards。将委托启动到 launchFromCatalogue (index.js)，以便所有现有的
// 门控适用。 DOM shell 位于 index.html (#landingCatalogueBackdrop)。

import { loadBoards } from "../../../services/deviceCatalog.js";
import { launchFromCatalogue, DEVICE_KIND_SHORT } from "./index.js";
import { apiGet } from "../../../shared/api.js";
import { escapeHtml } from "../../../shared/dom.js";

// 设备类型的显示顺序（按 this 顺序输入图块 render）。 “其他”下沉
// 到底部。
const KIND_ORDER = [
  "gpu_card", "laptop_logic_board", "phone_logic_board",
  "desktop_motherboard", "sbc_board", "power_charging_board", "other",
];

// 每种设备类型一个内联 SVG 字形（16×16 viewBox，笔划=currentColor，
// 匹配hing工作bench图标转换ention）。显示在类型步骤图块上。
const KIND_ICON = {
  gpu_card: '<rect x="2" y="6" width="20" height="12" rx="1"/><circle cx="9" cy="12" r="3"/><path d="M16 9v6"/>',
  laptop_logic_board: '<rect x="4" y="5" width="16" height="11" rx="1"/><path d="M2 19h20"/>',
  phone_logic_board: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  desktop_motherboard: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/>',
  sbc_board: '<rect x="4" y="4" width="16" height="16" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M4 9h2M4 13h2M18 9h2M18 13h2"/>',
  power_charging_board: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  other: '<rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
};

// Sentinel 适用于没有品牌的 board（taxonomy“未分类”）。被排除在外
// 显示的标签 which 退回到破折号。
const NO_BRAND = "nobrand";

let _devices = [];
let _step = "type"; // 类型 |品牌 | board
let _kind = null;
let _brand = null;
let _search = "";

const t = (k) => (window.t ? window.t(k) : k);
const $ = (id) => document.getElementById(id);
const _kindLabel = (kind) => DEVICE_KIND_SHORT[kind] || DEVICE_KIND_SHORT.other || "OTHER";
const _brandLabel = (brand) => (brand === NO_BRAND ? "—" : brand);

export async function openCatalogue() {
  const backdrop = $("landingCatalogueBackdrop");
  if (!backdrop) return;
  _step = "type";
  _kind = null;
  _brand = null;
  _search = "";
  const searchEl = $("landingCatalogueSearch");
  if (searchEl) searchEl.value = "";
  backdrop.hidden = false;
  try {
    _devices = await loadBoards();
  } catch {
    _devices = [];
  }
  _render();
}

export function closeCatalogue() {
  const backdrop = $("landingCatalogueBackdrop");
  if (backdrop) backdrop.hidden = true;
}

// --- 数据切片 ----------------------------------------------------------

// null 和“未知”sentinel 都位于“其他”(AUTRE) 下。没有
// this，一个“未知”类型的包与任何类型的图块都不匹配，并从fr消失
// 向下钻取（它仍然可以通过搜索找到，但永远不会出现在类型下）。
const _kindOf = (d) => {
  const k = d.device_kind;
  return !k || k === "unknown" ? "other" : k;
};
const _brandOf = (d) => d.subtitle || NO_BRAND;

function _kindsPresent() {
  const present = new Set(_devices.map(_kindOf));
  return KIND_ORDER.filter((k) => present.has(k));
}

function _brandsForKind(kind) {
  const set = new Set(_devices.filter((d) => _kindOf(d) === kind).map(_brandOf));
  return [...set].sort((a, b) => _brandLabel(a).localeCompare(_brandLabel(b)));
}

function _boardsFor(kind, brand) {
  return _devices
    .filter((d) => _kindOf(d) === kind && (brand == null || _brandOf(d) === brand))
    .sort((a, b) => {
      if (a.complete !== b.complete) return a.complete ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
}

function _searchMatches() {
  const q = _search.trim().toLowerCase();
  if (!q) return [];
  return _devices
    .filter((d) => [d.label, d.subtitle, ...(d.aliases || [])].filter(Boolean).join(" ").toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.complete !== b.complete) return a.complete ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
}

// --- rendering ------------------------------------------------------------------------

function _render() {
  // 重置面板可见性——胶片可能是en open。
  const fiche = $("landingCatalogueFiche");
  const list = $("landingCatalogueList");
  if (fiche) { fiche.hidden = true; fiche.innerHTML = ""; }
  if (!list) return;
  list.hidden = false;
  // #landingCatalogueKinds 是旧的过滤器行； breadcrumb 现已上线
  // 在列表顶部，因此请将该容器保留为空。
  const kinds = $("landingCatalogueKinds");
  if (kinds) kinds.innerHTML = "";

  if (_search.trim()) { _renderSearch(list); return; }
  if (_step === "board") { _renderBoards(list); return; }
  if (_step === "brand") { _renderBrands(list); return; }
  _renderTypes(list);
}

function _breadcrumbHtml() {
  const seg = (label, step, current) =>
    `<button type="button" class="landing-catalogue-crumb${current ? " is-current" : ""}" data-crumb="${step}">${escapeHtml(label)}</button>`;
  const sep = '<span class="landing-catalogue-crumb-sep">›</span>';
  const parts = [seg(t("landing.catalogue.crumb_types"), "type", _step === "type")];
  if (_kind) parts.push(sep, seg(_kindLabel(_kind), "brand", _step === "brand"));
  if (_step === "board" && _brand) parts.push(sep, seg(_brandLabel(_brand), "board", true));
  return `<nav class="landing-catalogue-breadcrumb">${parts.join("")}</nav>`;
}

function _tileHtml(attr, value, iconSvg, label, count) {
  return `<button type="button" class="landing-catalogue-tile" ${attr}="${escapeHtml(value)}">`
    + `<span class="landing-catalogue-tile-icon"><svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">${iconSvg}</svg></span>`
    + `<span class="landing-catalogue-tile-label">${escapeHtml(label)}</span>`
    + `<span class="landing-catalogue-tile-count">${count}</span></button>`;
}

function _renderTypes(list) {
  const kinds = _kindsPresent();
  if (!kinds.length) {
    list.innerHTML = `<p class="landing-catalogue-empty">${escapeHtml(t("landing.catalogue.empty"))}</p>`;
    return;
  }
  const tiles = kinds.map((k) => {
    const n = _devices.filter((d) => _kindOf(d) === k).length;
    return _tileHtml("data-tile-kind", k, KIND_ICON[k] || KIND_ICON.other, _kindLabel(k), n);
  });
  list.innerHTML = `<div class="landing-catalogue-tiles">${tiles.join("")}</div>`;
}

function _renderBrands(list) {
  const brands = _brandsForKind(_kind);
  const tiles = brands.map((b) => {
    const n = _boardsFor(_kind, b).length;
    // 重复使用电话/其他字形作为中性品牌标记——品牌没有
    // 他们自己的字形； breadcrumb already 携带类型。
    return _tileHtml("data-tile-brand", b, KIND_ICON[_kind] || KIND_ICON.other, _brandLabel(b), n);
  });
  list.innerHTML = _breadcrumbHtml() + `<div class="landing-catalogue-tiles">${tiles.join("")}</div>`;
}

function _cardHtml(d) {
  const draftBadge = d.complete ? "" : `<span class="landing-catalogue-badge is-draft">${escapeHtml(t("landing.catalogue.draft"))}</span>`;
  const graphBadge = d.has_electrical_graph ? `<span class="landing-catalogue-badge is-on">${escapeHtml(t("landing.catalogue.graph"))}</span>` : "";
  const brand = d.subtitle ? `<div class="landing-catalogue-card-brand">${escapeHtml(d.subtitle)}</div>` : "";
  // Identifier 行 — board 的区分hing 型号 / board 编号（例如
  // “A1706 / A1708”、“A2289 / 820-01987-A”）。 This 表示两个 boards
  // 同一型号的分开；回退到 when 版本为 absent 的外形尺寸。
  const idText = d.version || d.form_factor || "";
  const idLine = idText ? `<div class="landing-catalogue-card-id">${escapeHtml(idText)}</div>` : "";
  return `<button type="button" class="landing-catalogue-card${d.complete ? "" : " is-draft"}" role="listitem" data-slug="${escapeHtml(d.slug)}">`
    + `<div class="landing-catalogue-card-label">${escapeHtml(d.label)}</div>${brand}${idLine}`
    + `<div class="landing-catalogue-badges">${graphBadge}${draftBadge}</div></button>`;
}

function _renderBoards(list) {
  const boards = _boardsFor(_kind, _brand);
  const cards = boards.length
    ? `<div class="landing-catalogue-cards">${boards.map(_cardHtml).join("")}</div>`
    : `<p class="landing-catalogue-empty">${escapeHtml(t("landing.catalogue.empty"))}</p>`;
  list.innerHTML = _breadcrumbHtml() + cards;
}

function _renderSearch(list) {
  const boards = _searchMatches();
  const back = `<nav class="landing-catalogue-breadcrumb"><button type="button" class="landing-catalogue-crumb" data-crumb="clear-search">← ${escapeHtml(t("landing.catalogue.crumb_types"))}</button></nav>`;
  const cards = boards.length
    ? `<div class="landing-catalogue-cards">${boards.map(_cardHtml).join("")}</div>`
    : `<p class="landing-catalogue-empty">${escapeHtml(t("landing.catalogue.empty"))}</p>`;
  list.innerHTML = back + cards;
}

// --- 表（unchanged 合同）--------------------------------------------------------

async function _openFiche(slug) {
  const d = _devices.find((x) => x.slug === slug);
  if (!d) return;
  $("landingCatalogueList").hidden = true;
  const fiche = $("landingCatalogueFiche");
  fiche.hidden = false;
  fiche.innerHTML = `<button type="button" class="landing-catalogue-fiche-back" data-back>← ${escapeHtml(t("landing.catalogue.fiche_back"))}</button>`
    + `<div class="landing-catalogue-card-label">${escapeHtml(d.label)}</div>`
    + (d.subtitle ? `<div class="landing-catalogue-card-brand">${escapeHtml(d.subtitle)}</div>` : "");

  let summary = null;
  try { summary = await apiGet(`/pipeline/packs/${encodeURIComponent(slug)}`); } catch { /* 显示无统计数据的影片 */ }

  const rows = [
    ["fiche_registry", summary?.has_registry],
    ["fiche_graph", summary?.has_knowledge_graph],
    ["fiche_rules", summary?.has_rules],
    ["fiche_dictionary", summary?.has_dictionary],
    ["fiche_boardview", summary?.has_boardview],
    ["fiche_schematic", summary?.has_schematic_pdf],
  ];
  const pastilles = rows.map(([key, on]) =>
    `<div class="landing-catalogue-pastille${on ? " is-on" : ""}"><span>${escapeHtml(t("landing.catalogue." + key))}</span>`
    + `<span class="landing-catalogue-pastille-state">${escapeHtml(on ? t("landing.catalogue.present") : t("landing.catalogue.absent"))}</span></div>`
  ).join("");

  const locked = !d.complete;
  const launchBlock = locked
    ? `<p class="landing-catalogue-fiche-locked">${escapeHtml(t("landing.catalogue.fiche_draft_locked"))}</p>`
    : `<div class="landing-catalogue-fiche-launch">`
      + `<input type="text" id="landingCatalogueSymptom" maxlength="400" placeholder="${escapeHtml(t("landing.catalogue.fiche_symptom_placeholder"))}" />`
      + `<button type="button" id="landingCatalogueLaunch">${escapeHtml(t("landing.catalogue.fiche_launch"))}</button></div>`;

  fiche.innerHTML += `<h4 class="landing-catalogue-group-head">${escapeHtml(t("landing.catalogue.fiche_known"))}</h4>`
    + `<div class="landing-catalogue-pastilles">${pastilles}</div>${launchBlock}`;

  fiche.querySelector("[data-back]")?.addEventListener("click", _render);
  if (!locked) {
    $("landingCatalogueLaunch")?.addEventListener("click", () => {
      const symptom = ($("landingCatalogueSymptom")?.value || "").trim();
      if (symptom.length < 5) { $("landingCatalogueSymptom")?.focus(); return; }
      closeCatalogue();
      launchFromCatalogue({
        slug: d.slug, label: d.device_label || d.label,
        complete: d.complete, device_kind: d.device_kind, symptom,
      });
    });
  }
}

// - - 导航  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -

function _pickKind(kind) {
  _kind = kind;
  const brands = _brandsForKind(kind);
  if (brands.length <= 1) {
    // 自动跳过品牌步骤 when re 只有一个（或没有） — 直接
    // boards。 breadcrumb 仍然显示后退导航的品牌。
    _brand = brands[0] ?? null;
    _step = "board";
  } else {
    _brand = null;
    _step = "brand";
  }
  _render();
}

function _pickBrand(brand) {
  _brand = brand;
  _step = "board";
  _render();
}

function _onCrumb(step) {
  if (step === "clear-search") {
    _search = "";
    const el = $("landingCatalogueSearch");
    if (el) el.value = "";
  } else if (step === "type") {
    _step = "type"; _kind = null; _brand = null;
  } else if (step === "brand") {
    _step = "brand"; _brand = null;
  }
  _render();
}

// 一-time接线。称为 from initLanding (index.js)。
export function initCatalogue() {
  $("landingBrowseBtn")?.addEventListener("click", openCatalogue);
  $("landingCatalogueClose")?.addEventListener("click", closeCatalogue);
  $("landingCatalogueBackdrop")?.addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) closeCatalogue();
  });
  $("landingCatalogueSearch")?.addEventListener("input", (ev) => {
    _search = ev.target.value || "";
    _render();
  });
  $("landingCatalogueList")?.addEventListener("click", (ev) => {
    const crumb = ev.target.closest("[data-crumb]");
    if (crumb) { _onCrumb(crumb.getAttribute("data-crumb")); return; }
    const kindTile = ev.target.closest("[data-tile-kind]");
    if (kindTile) { _pickKind(kindTile.getAttribute("data-tile-kind")); return; }
    const brandTile = ev.target.closest("[data-tile-brand]");
    if (brandTile) { _pickBrand(brandTile.getAttribute("data-tile-brand")); return; }
    const card = ev.target.closest(".landing-catalogue-card");
    if (card) _openFiche(card.getAttribute("data-slug"));
  });
}
