//  基于哈希的部分路由器+chrome（topbar面包屑，模式丸，metabar）。
//  拥有 8 个应用程序部分之间的导航，并在以下时间刷新 chrome：
//  活动部分或当前设备发生变化。

export const SECTIONS = ["home", "pcb", "schematic", "graphe", "stock", "profile"];

//  SECTION_META 保存 i18n 键而不是文字字符串 — 解析于
//  updateChrome() 内的渲染时间。在语言环境切换上，refreshChrome() 是
//  通过下面的 i18n.onChange 钩子重新调用。
const SECTION_META = {
  home:          {crumbKey: "router.section.home",      mode: {tagKey: "router.mode.journal_tag", subKey: "router.mode.journal_repairs",   color: "cyan"}},
  pcb:           {crumbKey: "router.section.pcb",       mode: {tagKey: "router.mode.tool_tag",    subKey: "router.mode.tool_boardview",    color: "cyan"}},
  schematic:     {crumbKey: "router.section.schematic", mode: {tagKey: "router.mode.tool_tag",    subKey: "router.mode.tool_schematic",    color: "emerald"}},
  graphe:        {crumbKey: "router.section.graphe",    mode: {tagKey: "router.mode.wait_tag",    subKey: "router.mode.wait_no_memory",    color: "amber"}},
  stock:         {crumbKey: "router.section.stock",     mode: {tagKey: "router.mode.tool_tag",    subKey: "router.mode.tool_stock",        color: "emerald"}},
  profile:       {crumbKey: "router.section.profile",   mode: {tagKey: "router.mode.profile_tag", subKey: "router.mode.profile_sub",       color: "cyan"}},
};

//  prettifySlug 现位于 shared/dom.js（单一事实来源）。导入供
//  内部使用（updateChrome）并 re-export 以保留 main.js 与 landing.js 消费的公共 API。
import { prettifySlug } from "./shared/dom.js";
export { prettifySlug };
import { setContext, getDeviceSlug, getRepairId } from "./shared/context.js";
import { getRepair } from "./services/repairs.js";

//  ── Phase C：2级哈希路由语法──────────────────────────────────
//  全局路由：#home | #stock | #profile | #landing
//  repair 路由：#repair/<id>/<vue>，vue ∈ REPAIR_VUES（默认 diagnostic）
//  修复 vue `graph` 映射到内部“graphe”节 DOM (VUE_TO_SECTION)。
//  `?view=md` 保留在 REAL 查询字符串中（# 之前）——正交子状态
//  图 vue 的，由 currentViewMode()/applyMemoireMode() 读取/写入。
export const REPAIR_VUES = ["diagnostic", "pcb", "schematic", "graph"];
const VUE_TO_SECTION = { diagnostic: "home", pcb: "pcb", schematic: "schematic", graph: "graphe" };
const GLOBAL_ROUTES = ["home", "stock", "profile", "landing"];

/**
 * 将window.location.hash解析为结构化路由：
 * { level: "repair", id, vue } for #repair/<id>/<vue>
 * { level: "global", name } for #home | #股票| #个人资料| #landing
 * 未知/空 → { level: "global", name: "home" }.耐受 trailing
 * "?view=md" 散列片段查询，通过拆分它（查看真实的生活）
 * 查询字符串，但要采取防御措施）。
 
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

/** 构建规范的修复路由哈希 (#repair/<id>/<vue>)。  */
export function repairHash(id, vue = "diagnostic") {
  const v = REPAIR_VUES.includes(vue) ? vue : "diagnostic";
  return `#repair/${encodeURIComponent(id)}/${v}`;
}

//  repair_id → device_slug，延迟解析并缓存以供页面加载。
//  应用内导航播种此 (seedSlugForRepair)，以便它们保持同步；
//  只有冷deep-链接/重新加载才能支付 getRepair round-trip。
const _slugByRepair = new Map();

/** 快速路径：当 slug 已知时，播种 slug 缓存（主卡
 *点击，landing导航，管道重新direct）所以syncContextFromUrl解析没有
 * 一次获取。对 falsy id/slug 不执行任何操作（从不缓存错误值）。  */
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

//  修复 topbar 的元数据缓存 — 由 repair_id 键控，已填充
//  在cache miss上懒惰地通过ensureRepairMeta。让面包屑显示
//  人类症状和疗程药丸显示开始日期而不是
//  原始 UUID，不进行 updateChrome async。
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
  //  fr-FR 格式为“26 avr., 14:32” — 删除逗号即可将其视为一个短语。
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
  //  Home 的模式丸反映了会话是否处于活动状态。没有会议，
  //  它读取日志/修复默认值。对于会话，它显示为“Session”
  //  表明我们在仪表板上，而不是列表上。
  const activeSession = currentSession();
  if (section === "home" && activeSession) {
    meta = { ...meta, mode: { ...meta.mode, subKey: "router.mode.journal_session" } };
  }

  //  模式丸 - 每个部分静态，在 Graphe 上被包状态覆盖。
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

  //  修复活动会话的元数据 — 导致症状
  //  面包屑和会话丸中的开始日期。同步读取；
  //  a cache miss 在底部启动 async 获取 + 重新渲染。
  const sessionMeta = activeSession ? _repairCache.get(activeSession.repair) : null;

  //  会话药丸 - 当会话处于活动状态时，跨部分持续存在。
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

  //  面包屑 — 上下文路径：设备/症状/部分。
  //  品牌名称已经存在于左侧的 .brand 块中，因此我们
  //  这里不再重复。症状来自修复元数据；上
  //  cache miss 我们回退到 UUID-short 并刷新 async。
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

  //  异步升级 - 失败时获取修复元，重新渲染一次 chrome
  //  它着陆了。缓存可以防止递归调用循环。
  if (activeSession && !sessionMeta) {
    ensureRepairMeta(activeSession.repair).then(m => {
      if (m) updateChrome(section, deviceSlug, pack);
    });
  }

  //  Metabar——仅限图形。 body.no-metabar 将 .canvas/.home/.stub 拉起。
  document.body.classList.toggle("no-metabar", section !== "graphe");
  //  特定于部分的类，因此范围样式（boardview颜色配置行
  //  调整面板等）可以显示/隐藏每个活动部分。
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

  //  临时同步更新（尚未打包）— 防止 FOUC。
  updateChrome(section, slug, null);

  //  对于带有设备的 Graphe，获取包摘要并进行优化。
  if (section === "graphe" && slug) {
    loadPackSummary(slug).then(pack => {
      //  警卫：在获取过程中，用户可能已离开。
      if (currentSection() === section) updateChrome(section, slug, pack);
    });
  }
}

//  当前路由的部分 DOM 键。通过VUE_TO_SECTION修复vues地图
//  (图→graphe);全局路由映射到它们自己的部分（landing→home DOM，
//  overlay 位于顶部）。 SECTIONS 保留导航使用的部分 DOM 键集
//  守卫——与 GLOBAL_ROUTES 不同。
export function currentSection() {
  const route = parseRoute();
  if (route.level === "repair") return VUE_TO_SECTION[route.vue];
  return route.name === "landing" ? "home" : route.name;
}

//  按路线突出显示活动的 rail 按钮。在修复中，活动密钥是
//  视图；在全球范围内，它是路线名称。按钮携带数据-rail（Phase C）。
function setActiveRail(route) {
  const active = route.level === "repair" ? route.vue : route.name;
  document.querySelectorAll(".rail-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.rail === active);
  });
}

//  在修复外部显示rail的全局按钮组，在修复组内部显示。
//  按钮/分隔符携带 data-rail-level="global|repair"； .hidden 是全局 CSS。
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
  //  隐藏所有已知的部分 DOM，显示目标。
  document.getElementById("homeSection").classList.toggle("hidden", section !== "home");
  //  “graphe”部分是合并的Mémoire视图——可见的子视图
  //  （canvas vs memoryBank）由视图模式（graph|md）驱动。
  //  离开此部分时，隐藏两个子项，以免泄漏
  //  进入另一条路线。
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
    //  brd_viewer.js 作为延迟模块加载；在首次加载导航时
    //  （用户点击 /#pcb directly）该函数可能尚未定义，当
    //  navigate() 从引导 IIFE 运行。现在尝试，然后重试一次
    //  该模块保证已执行。
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

//  `deps.maybeLoadGraph` 由 main.js 注入（它拥有 graph-mount
//  Guard），因此视图切换处理程序可以触发 idempotent 图形重新加载
//  无需通过窗口。* 全局 — 镜像 mountRepairVue
//  注射。
export function wireRouter({ maybeLoadGraph } = {}) {
  //  注意：hashchange监听器位于main.js（单一所有者）——它运行
  //  完整 async 序列 migrateLegacyUrl → syncContextFromUrl → 导航 →
  //  mountRoute。不要在这里添加第二个导航（）（它会双重导航
  //  可能已经过时的商店）。
  //
  //  重新渲染 topbar chrome（模式丸、面包屑、metabar 状态文本）
  //  当用户切换 EN/FR 时。 DOM 级别的 [data-i18n] 元素是
  //  通过i18n.applyDom刷新；强制构建的 chrome 内容
  //  必须在此处重新绘制当前部分+包状态。
  if (window.i18n && typeof window.i18n.onChange === "function") {
    window.i18n.onChange(() => refreshChrome(currentSection()));
  }
  //  铁路点击 → 路线感知导航。全局按钮跳转到#<name>；修理
  //  vue 按钮跳转到 #repair/<currentId>/<vue> （仅当修复处于活动状态时）。
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
  //  切换按钮：单击设置模式+重新应用。实际的
  //  md 模式下第一个条目的存储体数据获取由以下命令处理
  //  main.js（拥有loadMemoryBank）。
  document.querySelectorAll(".view-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.view;
      applyMemoireMode(mode);
      //  首次进入Brut模式时，请确保存储体已
      //  已填充 — loadMemoryBank 为 idempotent。
      if (mode === "md") {
        import("./memory_bank.js").then(m => m.loadMemoryBank?.());
      } else {
        //  切换回 Visuel：画布刚刚变得可见
        //  真实尺寸。触发图形加载（idempotent通过
        //  _graphLoadedSlug 守卫在main.js）所以layoutNodes + fitToScreen
        //  查看正确的客户端宽度/客户端高度。如果我们不这样做，
        //  画布隐藏时尝试加载，无需
        //  将 slug 标记为已安装，视图将保持为空。
        maybeLoadGraph?.();
      }
    });
  });
}

/**
 * 哪个 memoire 视图处于活动状态，源自“view”查询参数。
 * 当不存在或无效时默认为“图表”。
 
 */
export function currentViewMode() {
  const v = new URLSearchParams(window.location.search).get("view");
  return v === "md" ? "md" : "graph";
}

/**
 * 应用 memoire 视图模式 — 切换画布与 DOM 可见性
 *内存库，更新切换按钮活动状态，隐藏/显示
 * metabar 中特定于图的过滤器 chip，并更新 URL
 * `view` 参数无需重新加载页面。
 
 */
export function applyMemoireMode(mode) {
  mode = mode === "md" ? "md" : "graph";
  document.getElementById("canvas").classList.toggle("hidden", mode !== "graph");
  document.getElementById("memoryBank").classList.toggle("hidden", mode !== "md");
  //  特定于图的过滤器 chips + 在 .metabar .filters 中实时搜索。
  const filtersEl = document.querySelector(".metabar .filters");
  if (filtersEl) filtersEl.classList.toggle("hidden", mode !== "graph");
  document.querySelectorAll(".view-toggle-btn").forEach(btn => {
    const on = btn.dataset.view === mode;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  //  保留 URL 中的选择而不重新加载——replaceState 保留
  //  历史记录干净（来回切换不应污染后退按钮）。
  const url = new URL(window.location.href);
  if (mode === "md") {
    url.searchParams.set("view", "md");
  } else {
    url.searchParams.delete("view");
  }
  window.history.replaceState({}, "", url.toString());
}

/**
 * 从当前哈希路由中导出{device,repair}并将其写入
 * store (shared/context.js) — 视图的单一读取表面。维修
 * 路由，从修复 ID 解析slug（缓存，否则 getRepair）。对于一个
 * 全局路由，清除上下文。返回一个 Promise，一旦
 * store 反映了路线 - await 在将视图安装到 deep 链接上之前。
 
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
      const meta = await getRepair(route.id);   //  修复摘要 { device_slug, ... }
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
 * 返回当前活动的修复会话，源自 URL 查询参数。
 * 会话由同时存在的 ?device= 和 ?repair= 定义。
 * 每次调用时重新派生 - 零隐藏状态。
 
 */
export function currentSession() {
  const device = getDeviceSlug();
  const repair = getRepairId();
  if (device && repair) return { device, repair };
  return null;
}

/**
 * 退出活动会话：strip ?device= + ?repair=，散列到#home，关闭
 * 聊天面板，重新渲染列表。从仪表板的退出按钮调用
 *和topbar疗程药丸的[×]。
 
 */
export async function leaveSession() {
  //  首先清除上下文，以便 currentSession() 立即读取 null。
  setContext({ device: null, repair: null });
  //  关闭聊天面板（如果打开）。 llmClose 是一个<按钮>；如果面板
  //  尚未安装，可选链接会默默地跳过。
  document.getElementById("llmClose")?.click();
  //  导航至全局维修列表。设置哈希触发 hashchange →
  //  main.js 的侦听器重新同步上下文 + 安装 #home。我们仍然放弃
  //  仪表板+在下面明确显示landing，以防我们已经在
  //  #home（当哈希值未更改时，不会触发 hashchange）。
  window.location.hash = "#home";
  navigate("home");
  //  退出会话总是返回到 landing hero — 技术是
  //  声明“我已完成此修复”，因此开始屏幕（他们在其中
  //  可以选择另一个设备或打开一个新的diagnostic）是正确的下一步。
  const { hideRepairDashboard } = await import("./features/repair/diagnostic/dashboard.js");
  hideRepairDashboard();
  const { showLanding } = await import("./features/global/landing/index.js");
  showLanding();
}

/**
 * 将任何 Pre-C 阶段 URL 重写为新语法（replaceState，no
 *重新加载）。涵盖 ?device=&repair=#section、?tool=stock、裸#memory-bank /
 *#graphe。在已经规范的 URL 上安全 no-op。在实际查询中保留 view=md
 * 字符串（Decision A）。启动时在syncContextFromUrl之前调用 + 每个hashchange。
 
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
    if (oldHash === "memory-bank") params.set("view", "md");   //  查询字符串 (Decision A)
    seedSlugForRepair(repair, device);                          //  我们知道 slug — 跳过获取
    params.delete("device"); params.delete("repair");
    url.hash = repairHash(repair, vue);
    changed = true;
  } else if (device && !repair) {
    //  仅限设备的旧版链接（包浏览）。无修复范围至新下
    //  语法→发送到全局列表；通过打开修复即可到达该包。
    params.delete("device");
    url.hash = "#home";
    changed = true;
  }

  //  未经修复的裸露遗留部分哈希不再是规范路线
  //  （pcb/schematic/graphe/memory-bank 是仅修复的 vue）→ 回退到#home。
  const bareHash = (url.hash || "").replace(/^#/, "").split("?")[0].split("/")[0];
  if (bareHash === "memory-bank" || bareHash === "graphe") { url.hash = "#home"; changed = true; }

  if (changed) window.history.replaceState({}, "", url.toString());
}
