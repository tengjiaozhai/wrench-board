// 基于哈希的部分路由器+chrome（topbar面包屑，模式丸，metabar）。
// 拥有 en 8 个应用程序部分之间的导航，并且 refreshes chrome when
// 活动部分或当前ent设备changes。

export const SECTIONS = ["home", "pcb", "schematic", "graphe", "stock", "profile"];

// SECTION_META 持有 i18n 键而不是文字字符串 — re 已解决
// 渲染时间位于 updateChrome() 内。在 locale 开关上，refreshChrome() 是
// re - 通过下面的i18n.onChange 钩子调用。
const SECTION_META = {
  home:          {crumbKey: "router.section.home",      mode: {tagKey: "router.mode.journal_tag", subKey: "router.mode.journal_repairs",   color: "cyan"}},
  pcb:           {crumbKey: "router.section.pcb",       mode: {tagKey: "router.mode.tool_tag",    subKey: "router.mode.tool_boardview",    color: "cyan"}},
  schematic:     {crumbKey: "router.section.schematic", mode: {tagKey: "router.mode.tool_tag",    subKey: "router.mode.tool_schematic",    color: "emerald"}},
  graphe:        {crumbKey: "router.section.graphe",    mode: {tagKey: "router.mode.wait_tag",    subKey: "router.mode.wait_no_memory",    color: "amber"}},
  stock:         {crumbKey: "router.section.stock",     mode: {tagKey: "router.mode.tool_tag",    subKey: "router.mode.tool_stock",        color: "emerald"}},
  profile:       {crumbKey: "router.section.profile",   mode: {tagKey: "router.mode.profile_tag", subKey: "router.mode.profile_sub",       color: "cyan"}},
};

// prettifySlug 现在位于shared/dom.js（单一事实来源）。进口用于
// 内部使用（更新Chrome）和re-导出到pre服务公众API
// 被main.js和landing.js消耗。
import { prettifySlug } from "./shared/dom.js";
export { prettifySlug };
import { setContext, getDeviceSlug, getRepairId } from "./shared/context.js";
import { getRepair } from "./services/repairs.js";

// ── Phase C：2级带宽路由语法 ──────────────────────────────────
// 全球航线：#home | #股票| #简介| ＃降落
// 修复路由：#repair/<id>/<vue> with vue ∈ REPAIR_VUES（默认诊断）
// 修复 `graph` vue 映射到内部“graphe”部分 DOM (VUE_TO_SECTION)。
// `?view=md` 保留在 REAL 查询字符串中（在 # 之前re）——正交子状态
// graph vue、读/写，由 currentViewMode()/applyMemoireMode() 实现。
export const REPAIR_VUES = ["diagnostic", "pcb", "schematic", "graph"];
const VUE_TO_SECTION = { diagnostic: "home", pcb: "pcb", schematic: "schematic", graph: "graphe" };
const GLOBAL_ROUTES = ["home", "stock", "profile", "landing"];

/**
 * 将window.location.hash解析为结构化路由：
 * { level: "repair", id, vue } for #repair/<id>/<vue>
 *#home | { 级别：“全球”，名称 } #stock| #简介| #登陆
 * 未知/空 → { level: "global", name: "home" }.耐受尾随
 * "?view=md" 哈希片段分割查询（视图生活真实）
 * 查询字符串，但必须是防御性的）。
 */
export function parseRoute() {
  const raw = (window.location.hash || "").replace(/^#/, "");
  const [path] = raw.split("?");
  const segs = path.split("/").filter(Boolean);
  if (segs[0] === "repair" && segs[1]) {
    let vue = segs[2] || "diagnostic";
    if (!REPAIR_VUES.includes(vue)) vue = "diagnostic";
    return { level: "repair", id: decodeURIComponent(segs[1]), vue };
  }
  const name = GLOBAL_ROUTES.includes(segs[0]) ? segs[0] : "home";
  return { level: "global", name };
}

/** 构建规范的修复路由带宽 (#repair/<id>/<vue>)。 */
export function repairHash(id, vue = "diagnostic") {
  const v = REPAIR_VUES.includes(vue) ? vue : "diagnostic";
  return `#repair/${encodeURIComponent(id)}/${v}`;
}

// repair_id→device_slug，re延迟求解并缓存到页面load。
// 应用内导航种子 this (seedSlugForRepair)，以便它们保持同步；
// 只有感冒 deep-link/reload 才能支付 getRepair round-trip。
const _slugByRepair = new Map();

/** 快速路径：在 slug 存储中分布 en slug 已经已知（主卡
 * 点击、登陆导航、管道重新direct) 所以syncContextFromUrl 重新占用人体工学
 * fetch。对 false id/slug 不执行任何操作（从不服务器错误值）。*/
export function seedSlugForRepair(id, slug) {
  if (id && slug) _slugByRepair.set(id, slug);
}

async function loadPackSummary(slug) {
  if (!slug) return null;
  try {
    const res = await fetch(`/pipeline/packs/${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn("loadPackSummary failed", err);
    return null;
  }
}

// 修复 topbar 的元数据缓存 — 由 repair_id 键控，已填充
// 懒惰地通过ensureRepairMeta在缓存未命中上。让面包屑显示
// human symptom 和 session-pill 显示开始日期而不是
// 原始UUID，未进行更新Chromeasync。
const _repairCache = new Map();
const _repairCacheInFlight = new Map();

async function ensureRepairMeta(repairId) {
  if (!repairId) return null;
  if (_repairCache.has(repairId)) return _repairCache.get(repairId);
  if (_repairCacheInFlight.has(repairId)) return _repairCacheInFlight.get(repairId);
  const p = (async () => {
    try {
      const res = await fetch(`/pipeline/repairs/${encodeURIComponent(repairId)}`);
      if (!res.ok) return null;
      const data = await res.json();
      _repairCache.set(repairId, data);
      return data;
    } catch (_err) {
      return null;
    }
  })();
  _repairCacheInFlight.set(repairId, p);
  try { return await p; } finally { _repairCacheInFlight.delete(repairId); }
}

const _dateFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});
function formatRepairDate(iso) {
  if (!iso) return "…";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "…";
  // fr-FR 格式为“26 avr., 14:32” — 将逗号粘贴到一个主板上阅读。
  return _dateFmt.format(d).replace(/,\s*/g, " ");
}

function truncateForCrumb(text, max = 38) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

function renderCrumbs(items) {
  const el = document.getElementById("crumbs");
  el.innerHTML = "";
  items.forEach((it, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      el.appendChild(sep);
    }
    const text = typeof it === "string" ? it : it.text;
    const title = typeof it === "string" ? null : it.title;
    const span = document.createElement("span");
    if (i === items.length - 1) span.classList.add("active");
    span.textContent = text;
    if (title) span.title = title;
    el.appendChild(span);
  });
}

function isPackComplete(pack) {
  return !!(pack && pack.has_registry && pack.has_knowledge_graph
         && pack.has_rules && pack.has_dictionary && pack.has_audit_verdict);
}

function packMissingFiles(pack) {
  if (!pack) return [];
  const missing = [];
  if (!pack.has_registry)        missing.push("registry");
  if (!pack.has_knowledge_graph) missing.push("graph");
  if (!pack.has_rules)           missing.push("rules");
  if (!pack.has_dictionary)      missing.push("dictionary");
  if (!pack.has_audit_verdict)   missing.push("audit");
  return missing;
}

function updateChrome(section, deviceSlug, pack) {
  const t = (window.t || ((k) => k));
  let meta = SECTION_META[section] || SECTION_META.home;
  // Home 的模式丸re反映会话是否处于活动状态。没有会议，
  // 它re广告journal/repair的默认值。通过会话，它re广告“会话”
  // 表示我们're在dashboard上，而不是列表上。
  const activeSession = currentSession();
  if (section === "home" && activeSession) {
    meta = { ...meta, mode: { ...meta.mode, subKey: "router.mode.journal_session" } };
  }

  // 模式丸 - 每个部分静态，按包状态覆盖 Graphe 上的en。
  let mode = meta.mode;
  if (section === "graphe") {
    if (!deviceSlug) {
      mode = {tagKey: "router.mode.wait_tag", subKey: "router.mode.wait_no_repair", color: "amber"};
    } else if (isPackComplete(pack)) {
      mode = {tagKey: "router.mode.memory_tag", subKey: "router.mode.memory_graph", color: "cyan"};
    } else if (pack) {
      mode = {tagKey: "router.mode.build_tag", subKey: "router.mode.build_in_progress", color: "amber"};
    } else {
      mode = {tagKey: "router.mode.wait_tag", subKey: "router.mode.wait_unbuilt", color: "amber"};
    }
  }
  const pill = document.getElementById("modePill");
  pill.className = `mode-pill ${mode.color}`;
  document.getElementById("modePillText").textContent = `${t(mode.tagKey)} · ${t(mode.subKey)}`;

  // 修复活动会话的元数据 — 驱动 symptom
  // breadcrumb 和会话丸中的开始日期。同步read；
  // a cache miss 在底部启动 async fetch + re-render。
  const sessionMeta = activeSession ? _repairCache.get(activeSession.repair) : null;

  // 会话药丸 — 持续ent across 会话处于活动状态的部分。
  const sessionPill = document.getElementById("sessionPill");
  if (sessionPill) {
    if (activeSession) {
      sessionPill.classList.remove("hidden");
      const devEl = document.getElementById("sessionPillDevice");
      const ridEl = document.getElementById("sessionPillRid");
      if (devEl) devEl.textContent = prettifySlug(activeSession.device);
      if (ridEl) {
        if (sessionMeta && sessionMeta.created_at) {
          ridEl.textContent = formatRepairDate(sessionMeta.created_at);
          ridEl.title = `Repair ${activeSession.repair}`;
        } else {
          ridEl.textContent = activeSession.repair.slice(0, 8);
          ridEl.title = `Repair ${activeSession.repair}`;
        }
      }
    } else {
      sessionPill.classList.add("hidden");
    }
  }

  // Breadcrumbs — 上下文路径：device/symptom/section。
  // 品牌名称 already 位于左侧的 .brand 块中，所以我们
  // 别re重复他re。 symptom来自fr来自repair元数据；在
  // 缓存错过了我们回落到UUID-短且异步刷新。
  const crumbs = [];
  if (activeSession) {
    crumbs.push(prettifySlug(activeSession.device));
    if (sessionMeta && sessionMeta.symptom) {
      crumbs.push({ text: truncateForCrumb(sessionMeta.symptom), title: sessionMeta.symptom });
    } else {
      crumbs.push(activeSession.repair.slice(0, 8));
    }
  } else if (deviceSlug) {
    crumbs.push(prettifySlug(deviceSlug));
  }
  crumbs.push(t(meta.crumbKey));
  renderCrumbs(crumbs);

  // 异步升级 - fetchrepair元未命中，re-render chrome一次
  // 它着陆了。服务器防止递归调用循环。
  if (activeSession && !sessionMeta) {
    ensureRepairMeta(activeSession.repair).then(m => {
      if (m) updateChrome(section, deviceSlug, pack);
    });
  }

  // Metabar——仅限图形。body.no-metabar拉起.canvas/.home/.stub。
  document.body.classList.toggle("no-metabar", section !== "graphe");
  // 特定于部分的类，因此范围样式（boardview颜色配置行
  // 调整面板等）可以显示每个活动部分的 / hide。
  document.body.dataset.section = section;
  if (section !== "graphe") return;

  const deviceEl = document.getElementById("metaDevice");
  const statusEl = document.getElementById("metaStatus");
  if (!deviceSlug) {
    deviceEl.innerHTML = `<span style="color:var(--text-3)">${t("router.metabar.no_repair")}</span>`;
    statusEl.className = "warn info";
    statusEl.innerHTML = `<svg class="icon icon-sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>${t("router.metabar.open_repair_to_view_graph")}`;
    return;
  }

  deviceEl.innerHTML = `<span class="tag">${deviceSlug}</span><span>·</span><span>${prettifySlug(deviceSlug)}</span>`;

  if (!pack) {
    statusEl.className = "warn";
    statusEl.innerHTML = `<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/></svg>${t("router.metabar.no_memory_for_device")}`;
  } else if (isPackComplete(pack)) {
    statusEl.className = "warn ok";
    statusEl.innerHTML = `<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>${t("router.metabar.memory_loaded_approved")}`;
  } else {
    const missing = packMissingFiles(pack);
    statusEl.className = "warn";
    statusEl.innerHTML = `<svg class="icon icon-sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${t("router.metabar.memory_building_missing", { missing: missing.join(", ") })}`;
  }
}

function refreshChrome(section) {
  const slug = getDeviceSlug();

  // 临时同步更新（尚未打包）- prevents FOUC。
  updateChrome(section, slug, null);

  // 对于带有设备的 Graphe，获取包摘要并进行优化。
  if (section === "graphe" && slug) {
    loadPackSummary(slug).then(pack => {
      // 守卫：用户可能在 hile fetch 飞行时导航离开。
      if (currentSection() === section) updateChrome(section, slug, pack);
    });
  }
}

// current 路线的部分 DOM 键。通过VUE_TO_SECTION修复vues地图
// (graph→graphe);全局路由映射到它们自己的部分（landing→home DOM，
// overlay 位于顶部）。 SECTIONS 保留导航使用的部分 DOM 键集
// 守卫 — 与 GLOBAL_ROUTES 不同的 fr。
export function currentSection() {
  const route = parseRoute();
  if (route.level === "repair") return VUE_TO_SECTION[route.vue];
  return route.name === "landing" ? "home" : route.name;
}

// 按路线突出显示活动的 rail 按钮。在 repair 中，活动键是
// 视图；在全球范围内，它是路线名称。按钮带有 data-rail (Phase C)。
function setActiveRail(route) {
  const active = route.level === "repair" ? route.vue : route.name;
  document.querySelectorAll(".rail-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.rail === active);
  });
}

// 在 repair 外部显示 rail 的全局按钮组，在内部显示 repair 组。
// 按钮/分隔符带有 data-rail-level="global|repair"； .hidden 是全局CSS。
function applyRailLevel(route) {
  document.querySelectorAll(".rail [data-rail-level]").forEach(el => {
    el.classList.toggle("hidden", el.dataset.railLevel !== route.level);
  });
}

export function navigate(section) {
  if (!SECTIONS.includes(section)) section = "home";
  const route = parseRoute();
  setActiveRail(route);
  applyRailLevel(route);
  // 隐藏所有已知的部分 DOM，显示目标。
  document.getElementById("homeSection").classList.toggle("hidden", section !== "home");
  // “graphe”部分是合并的Mémoire视图——可见的child
  // (canvas vs memoryBank) 是由视图模式 (graph|md) 驱动en。
  // 离开此部分时，隐藏两个子项，以免泄漏
  // 进入另一条路线。
  const inMemoire = section === "graphe";
  if (!inMemoire) {
    document.getElementById("canvas").classList.add("hidden");
    document.getElementById("memoryBank").classList.add("hidden");
  } else {
    applyMemoireMode(currentViewMode());
  }
  document.getElementById("profileSection").classList.toggle("hidden", section !== "profile");
  document.querySelectorAll("[data-section-stub]").forEach(el => {
    el.classList.toggle("hidden", el.dataset.sectionStub !== section);
  });
  refreshChrome(section);
  if (section === "pcb") {
    // brd_viewer.js 作为延迟模块加载；在首次加载导航时
    // （用户hits /#pcbdirectly）该函数可能尚未定义when
    // navigate() 从启动 IIFE 运行 fr。现在就尝试，然后re再尝试一次en
    // 该模块保证已执行。
    const runPcbInit = () => {
      const root = document.getElementById("brdRoot");
      if (root && typeof window.initBoardview === "function") {
        window.initBoardview(root);
        return true;
      }
      return false;
    };
    if (!runPcbInit()) {
      window.addEventListener("load", runPcbInit, { once: true });
    }
  }
}

// `deps.maybeLoadGraph` 由 main.js 注入（which 拥有 graph-mount
// Guard），因此视图切换处理程序可以触发 idempotent graph reload
// 没有 reaching 通过窗口。* 全局 — 镜像 mountRepairVue
// 注射。
export function wireRouter({ maybeLoadGraph } = {}) {
  // NOTE：hashchange列表ener住在main.js（单一所有者）——它运行
  // 完整的异步序列 migrateLegacyUrl →syncContextFromUrl → 导航 →
  // mountRoute。不要添加第二个导航（）here（它会双重导航
  // pos相当陈旧的斯托re）。
  //
  // 重新渲染endertopbar铬（模式丸，breadcrumbs，metabar状态文本）
  // 当用户切换英语/法语时。 DOM 级别 [data-i18n] 元素是
  // refre由i18n.applyDom 隐藏；强制构建的 chrome 内容
  // from current 部分 + 包状态必须在这里重新绘制。
  if (window.i18n && typeof window.i18n.onChange === "function") {
    window.i18n.onChange(() => refreshChrome(currentSection()));
  }
  // 轨道交通click→路线-aware导航。全局按钮跳转到#<name>； repair
  // vue 按钮跳转到 #repair/<currentId>/<vue> （仅当修复某个活动状态时）。
  document.querySelectorAll(".rail-btn[data-rail]").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.rail;
      if (GLOBAL_ROUTES.includes(target)) {
        window.location.hash = "#" + target;
        return;
      }
      const route = parseRoute();
      const id = route.level === "repair" ? route.id : getRepairId();
      if (id) window.location.hash = repairHash(id, target);
    });
  });
  // 切换按钮：单击设置模式+重新应用。实际的
  // md 模式下第一个 en 尝试的memory-bank数据fetch由以下方式处理
  // main.js（拥有loadMemoryBank）。
  document.querySelectorAll(".view-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.view;
      applyMemoireMode(mode);
      // 在第一个 en 尝试进入 Brut 模式时，使 sure memory bank 为
      // 已填充 — loadMemoryBank 为幂等。
      if (mode === "md") {
        import("./memory_bank.js").then(m => m.loadMemoryBank?.());
      } else {
        // 将hing切换回Visuel：canvas刚刚变得可见
        // 真实尺寸ensions。触发graphload（幂等通过
        // _graphLoadedSlug 守卫在main.js) 所以layoutNodes + fitToScreen
        // 请参考正确的 clientWidth/clientHeight。如果我们不这样做，a
        // 加载尝试而canvas是隐藏的保释，没有
        // 将 slug 标记为已安装，视图将保持为空。
        maybeLoadGraph?.();
      }
    });
  });
}

/**
 * Which memoire 视图处于活动状态，从“view”查询参数派生出 fr。
 * 默认为“graph”whenabsent或无效。
 */
export function currentViewMode() {
  const v = new URLSearchParams(window.location.search).get("view");
  return v === "md" ? "md" : "graph";
}

/**
 * 应用 memoire 视图模式 — 切换 canvas vs 的 DOM 可见性
 * memoryBank，更新切换按钮活动状态，hide/显示
 * graph特定过滤器metabar中的chip，并更新URL的
 * `view` 参数没有 reloading 页面。
 */
export function applyMemoireMode(mode) {
  mode = mode === "md" ? "md" : "graph";
  document.getElementById("canvas").classList.toggle("hidden", mode !== "graph");
  document.getElementById("memoryBank").classList.toggle("hidden", mode !== "md");
  // 特定于图的过滤器 chips + 在 .metabar .filters 中实时搜索。
  const filtersEl = document.querySelector(".metabar .filters");
  if (filtersEl) filtersEl.classList.toggle("hidden", mode !== "graph");
  document.querySelectorAll(".view-toggle-btn").forEach(btn => {
    const on = btn.dataset.view === mode;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  // 保留 URL 中的选择，而不使用 reloading — replaceState 保留
  // hi故事干净（来回切换不应污染后退按钮）。
  const url = new URL(window.location.href);
  if (mode === "md") {
    url.searchParams.set("view", "md");
  } else {
    url.searchParams.delete("view");
  }
  window.history.replaceState({}, "", url.toString());
}

/**
 * 从 current 哈希路由导出 {device, repair} fr并将其写入
 * store (shared/context.js) — 用于视图的单个 read 表面。对于 repair
 * 路线，re解决slugfromrepairid（缓存，否则getRepair）。对于一个
 * 全局路由，清除上下文。返回一个 Promise，一旦
 * store re 改变路线 — await 在 re 在 deep-link 上安装视图之前。
 */
export async function syncContextFromUrl() {
  const route = parseRoute();
  if (route.level !== "repair") {
    setContext({ device: null, repair: null });
    return;
  }
  let slug = _slugByRepair.get(route.id);
  if (!slug) {
    try {
      const meta = await getRepair(route.id);   // RepairSummary { 设备_slug, ... }
      slug = meta?.device_slug || null;
      if (slug) _slugByRepair.set(route.id, slug);
    } catch (err) {
      console.warn("[router] could not resolve repair", route.id, err);
      slug = null;
    }
  }
  setContext({ device: slug, repair: route.id });
}

/**
 * 返回当前ently活动的repair session，派生的from URL查询参数。
 * 会话由 ?device= 和 ?repair= 的同时 presence 定义。
 * 每次调用时重新导出 — 零 hidden 状态。
 */
export function currentSession() {
  const device = getDeviceSlug();
  const repair = getRepairId();
  if (device && repair) return { device, repair };
  return null;
}

/**
 * 退出活动会话：strip ?device= + ?repair=，散列到#home，close
 * 聊天面板，列表下方re-ren。从 dashboard 的退出按钮调用 fr
 * 以及topbar疗程药丸的[×]。
 */
export async function leaveSession() {
  // 首先清除上下文，以便立即执行 currentSession() reads null imm。
  setContext({ device: null, repair: null });
  // 如果 open，则关闭ose 聊天面板。 llmClose 是一个<按钮>；如果面板
  // 尚未安装，可选链接 silently 会跳过。
  document.getElementById("llmClose")?.click();
  // 导航至全局修复列表。设置哈希触发 hashchange →
  // main.js 的列表ener re-同步上下文 + 安装 #home。我们仍然放弃
  // dashboard + 在下面明确显示 landing，以防我们re already
  // #home（没有hashchange触发时，哈希值不变）。
  window.location.hash = "#home";
  navigate("home");
  // 退出会话总是re转向landinghero——技术是
  // 声明“我已经完成了 this repair”，因此开始 screen（当re 他们
  // 可以选择另一个设备或操作en一个新的diagnostic）是正确的下一步。
  const { hideRepairDashboard } = await import("./features/repair/diagnostic/dashboard.js");
  hideRepairDashboard();
  const { showLanding } = await import("./features/global/landing/index.js");
  showLanding();
}

/**
 * 将任何 pre-Phase-C URL 重写到新的语法中（replaceState，无
 * reload）。 头部 ?device=&repair=#section、?tool=stock、bare #memory-bank /
 * #graphe。在已经规范的URL上安全no-op。在真实查询中保留view=md
 * 字符串 (Decision A)。启动时调用 beforeresyncContextFromUrl + 每个 hashchange。
 */
export function migrateLegacyUrl() {
  const url = new URL(window.location.href);
  const params = url.searchParams;
  const device = params.get("device");
  const repair = params.get("repair");
  const tool = params.get("tool");
  let changed = false;

  if (tool === "stock") { params.delete("tool"); url.hash = "#stock"; changed = true; }

  if (repair && device) {
    const oldHash = (url.hash || "").replace(/^#/, "").split("?")[0];
    const sectionToVue = { home: "diagnostic", pcb: "pcb", schematic: "schematic",
                           graphe: "graph", "memory-bank": "graph" };
    const vue = sectionToVue[oldHash] || "diagnostic";
    if (oldHash === "memory-bank") params.set("view", "md");   // 查询字符串 (Decision A)
    seedSlugForRepair(repair, device);                          // 我们知道 slug — 跳过 fetch
    params.delete("device"); params.delete("repair");
    url.hash = repairHash(repair, vue);
    changed = true;
  } else if (device && !repair) {
    // 仅限设备的旧版链接（包浏览）。没有repair适用于新的范围
    // grammar → send 到全局列表；该包可通过操作en操作repair来获得re。
    params.delete("device");
    url.hash = "#home";
    changed = true;
  }

  // 没有 repair are 的 Bare 遗留部分哈希不再是规范路由
  // （pcb/schematic/graphe/memory-bank are Repair-仅限vue）→ 回退到#home。
  const bareHash = (url.hash || "").replace(/^#/, "").split("?")[0].split("/")[0];
  if (bareHash === "memory-bank" || bareHash === "graphe") { url.hash = "#home"; changed = true; }

  if (changed) window.history.replaceState({}, "", url.toString());
}
