//  修复仪表板 — #repair/:id/diagnostic vue（Phase D.3：移至此处
//  来自 web/js/home.js，现在已经消失了）。渲染聚焦的会话中心：
//      - renderRepairDashboard() ：标题/数据网格/对话/结果/
//          timeline / pack，由 workspace shell 安装在 diagnostic vue 上。
//      - initHome() ：在 EN/FR 切换上连接仪表板的区域设置重新渲染。
//      - loadTaxonomy() ：仪表板标题使用的品牌>型号>版本索引。

import { leaveSession, repairHash } from '../../../router.js';
import { openPanel, closePanelIfConv } from '../../../llm.js';
import { ICON_CHECK } from '../../../icons.js';
import { getDiagnosticWS } from '../../../services/diagnosticSocket.js';
import { store } from '../../../store.js';
import { getDeviceSlug, getRepairId } from '../../../shared/context.js';
import { escapeHtml, relativeTime as relativeTimeFr } from '../../../shared/dom.js';
import { apiGet } from '../../../shared/api.js';
import { openInfoModal } from '../../../info_modal.js';
import { maybeShowFirstDiagCoaching } from './coaching.js';
import { hideUploads } from '../../../cloud_hints.js';

export async function loadTaxonomy() {
  try {
    return await apiGet("/pipeline/taxonomy");
  } catch (err) {
    console.warn("loadTaxonomy failed", err);
    return {brands: {}, uncategorized: []};
  }
}

function humanizeSlug(slug) {
  return slug.replace(/-/g, " ").replace(/^./, c => c.toUpperCase());
}

//  从标签中剥离 trailing form_factor (“主板”、“逻辑板”)
//  这是在粘贴了 form_factor 的情况下键入的。当我们没有时使用
//  可以依靠的taxonomy.model。
function stripFormFactor(label, formFactor) {
  if (!label || !formFactor) return label;
  const ff = formFactor.trim();
  if (!ff) return label;
  const re = new RegExp("\\s+" + ff.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") + "\\s*$", "i");
  return label.replace(re, "").trim() || label;
}

//  设备名称——板是什么，而不是它的形式。更喜欢
//  清理`taxonomy.model`（由转储中的Registry构建器设置）
//  原始用户输入的“device_label”通常将 form_factor 粘合在一起。
//  默认情况下包含品牌，因此名称独立显示；设置
//  品牌分组 UI 部分内的“includeBrand: false”。
function deviceName(entry, { includeBrand = true } = {}) {
  const brand = entry.brand || "";
  const model = entry.model || "";
  if (brand && model) return includeBrand ? `${brand} ${model}` : model;
  if (model) return model;
  return stripFormFactor(entry.device_label || humanizeSlug(entry.device_slug), entry.form_factor);
}

//  为分类建立索引，以便每次维修都可以解析为{品牌、型号、
//  form_factor, version}，无需对每张卡进行额外的获取。
function indexTaxonomyBySlug(taxonomy) {
  const index = new Map();
  for (const [brand, models] of Object.entries(taxonomy.brands || {})) {
    for (const [modelName, packs] of Object.entries(models)) {
      for (const p of packs) {
        index.set(p.device_slug, { ...p, brand, model: modelName });
      }
    }
  }
  for (const p of (taxonomy.uncategorized || [])) {
    index.set(p.device_slug, { ...p, brand: null, model: null });
  }
  return index;
}

function statusLabel(status) {
  if (status === "closed") return t("home.status.closed");
  if (status === "in_progress") return t("home.status.in_progress");
  return t("home.status.open");
}

function statusBadgeHTML(status) {
  const label = statusLabel(status);
  const cls = status === "closed" ? "ok" : (status === "in_progress" ? "warn" : "");
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

//  Phase D.1：密集的#home 日志网格（renderHome + RepairCardHTML /
//  deviceBlockHTML / BrandBlockHTML) 已删除 — landing overlay 是
//  全局主页并通过其 sidebar 列出所有维修。下面是修复仪表板
//  (renderRepairDashboard) 是 #repair/:id/diagnostic vue 并保留。帮手
//  为仪表板保留： humanizeSlug / stripFormFactor / deviceName /
//  indexTaxonomyBySlug / statusLabel / statusBadgeHTML。

// ───────────────────────────────────────────────────────────────
//  修复仪表板 — #home 的重点“会话中心”状态。
//  当 currentSession() 返回非空时激活。
// ───────────────────────────────────────────────────────────────

export async function renderRepairDashboard(session) {
  const { device: slug, repair: rid } = session;

  //  切换可见性：隐藏列表状态，显示仪表板。
  document.getElementById("homeSections")?.classList.add("hidden");
  document.getElementById("homeEmpty")?.classList.add("hidden");
  document.getElementById("repairDashboard")?.classList.remove("hidden");
  //  在仪表板模式下还隐藏列表的 H1/CTA。
  document.querySelector("#homeSection .home-head")?.classList.add("hidden");

  //  并行获取 - Promise 结果列表，每个结果都可以容忍失败。
  const [repair, convs, pack, findings, taxonomy, sourcesData] = await Promise.all([
    fetchJSON(`/pipeline/repairs/${encodeURIComponent(rid)}`, null),
    fetchJSON(`/pipeline/repairs/${encodeURIComponent(rid)}/conversations`, { conversations: [] }),
    fetchJSON(`/pipeline/packs/${encodeURIComponent(slug)}`, null),
    fetchJSON(`/pipeline/packs/${encodeURIComponent(slug)}/findings`, []),
    loadTaxonomy(),
    fetchJSON(`/pipeline/packs/${encodeURIComponent(slug)}/sources`, null),
  ]);

  const taxIndex = indexTaxonomyBySlug(taxonomy);
  const taxEntry = taxIndex.get(slug) || null;

  renderDashboardHeader(repair, taxEntry, slug, rid);
  renderDashboardData(slug, rid, pack, sourcesData);
  renderCapabilities(pack);
  await renderBoardDeltaCard(slug, repair?.board_number || null);
  renderDashboardConvs(convs.conversations || [], rid);
  renderDashboardFindings(findings, rid);
  renderDashboardTimeline(repair, convs.conversations || [], findings, pack);
  renderDashboardPack(pack, slug, rid);
  wireDashboardHandlers();
  wireUploadHandlers(slug, rid);
  wireFixButton(slug, rid);
  maybeAutoResumeBuildWatch(slug, rid, pack);

  //  永恒的 ”？” → 可重播的“维修工作原理”解释器。
  const infoBtn = document.getElementById("rdInfoHint");
  if (infoBtn) infoBtn.onclick = () => openInfoModal("repair");
  //  仪表板第一次打开时，一次性引导浏览 workspace。
  //  一次性使用 example-handoff 钩子（稍后读取时清除，
  //  不相关的第一诊断渲染永远不会拾取陈旧的返回landing）。
  const exampleOnDone = window.__wbExampleTourOnDone || null;
  window.__wbExampleTourOnDone = null;
  maybeShowFirstDiagCoaching(rid, { onDone: exampleOnDone, slug });
}

//  上传完成后仪表板中段重新渲染 - 与
//  初始安装，但我们不接触对话/发现/timeline
//  因为这些不受 boardview/schematic 上传的影响。
async function refreshDashboardData(slug, rid) {
  const [pack, sourcesData] = await Promise.all([
    fetchJSON(`/pipeline/packs/${encodeURIComponent(slug)}`, null),
    fetchJSON(`/pipeline/packs/${encodeURIComponent(slug)}/sources`, null),
  ]);
  renderDashboardData(slug, rid, pack, sourcesData);
  renderCapabilities(pack);
  //  上传schematic_pdf后，后端踢出视觉
  //  `asyncio.create_task` 中的管道，但不推送 WS 事件
  //  它。在此处恢复轮询观察程序，以便旋转器/预计到达时间/最终结果
  //  一切都发生在无需手动重新加载的情况下。当 (a) 是观察者时无操作
  //  已在运行，(b) 磁盘上没有 PDF，或 (c) electric_graph
  //  已经编译了。
  maybeAutoResumeBuildWatch(slug, rid, pack);
  renderDashboardPack(pack, slug, rid);
}

export function hideRepairDashboard() {
  document.getElementById("repairDashboard")?.classList.add("hidden");
  document.getElementById("homeSections")?.classList.remove("hidden");
  document.querySelector("#homeSection .home-head")?.classList.remove("hidden");
  document.getElementById("dashboardFixBtn")?.classList.add("hidden");
}

async function fetchJSON(url, fallback) {
  try {
    const res = await fetch(url);
    if (!res.ok) return fallback;
    return await res.json();
  } catch (err) {
    console.warn("[dashboard] fetch failed", url, err);
    return fallback;
  }
}

function renderDashboardHeader(repair, taxEntry, slug, rid) {
  const slugEl = document.getElementById("rdSlug");
  const deviceEl = document.getElementById("rdDevice");
  const symptomEl = document.getElementById("rdSymptom");
  const badgesEl = document.getElementById("rdBadges");
  if (!slugEl || !deviceEl || !symptomEl || !badgesEl) return;

  //  示例/演示修复在其记录中带有硬编码的 FR 症状，该症状
  //  无法遵循 UI 区域设置 — 显示本地化区域设置，并标记演示模式
  //  在 <body> 上，因此居中的 topbar DEMO 徽章会显示在每个视图中。
  const isDemo = !!rid && rid.startsWith("example-");
  document.body.classList.toggle("wb-demo-mode", isDemo);

  slugEl.textContent = slug;
  deviceEl.textContent = taxEntry
    ? deviceName(taxEntry, { includeBrand: true })
    : (repair?.device_label || humanizeSlug(slug));
  symptomEl.textContent = isDemo ? t("repair.demo_symptom") : (repair?.symptom || "…");

  const created = repair?.created_at ? relativeTimeFr(repair.created_at) : "…";
  const status = repair?.status || "open";
  const form = taxEntry?.form_factor
    ? `<span class="badge mono">${escapeHtml(taxEntry.form_factor)}</span>`
    : "";
  badgesEl.innerHTML =
    `${statusBadgeHTML(status)}` +
    `<span class="badge mono">${escapeHtml(rid.slice(0, 8))}</span>` +
    form +
    `<span class="rd-created">${escapeHtml(t("home.dashboard.created_at", { when: created }))}</span>`;
}

const ICONS = {
  arrowRight: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  upload:     '<svg viewBox="0 0 24 24"><path d="M12 17V5"/><path d="M5 12l7-7 7 7"/><path d="M5 19h14"/></svg>',
};

//  漂亮的文件大小格式化程序 - KB/MB，带一位小数。用于卡元
//  上传后，技术人员看到“iphone-x.brd·2.4 MB”而不是原始字节。
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "…";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// ───────────────────────────────────────────────────────────────
//  数据感知仪表板 - 每个输入卡 + 每个派生数据卡。
//  每张卡片都归结为以下之一：开/关/构建/加载/错误。
// ───────────────────────────────────────────────────────────────

//  diagnostic 就绪徽章 popover 的点击切换处理程序。
//  每个会话绑定一次 - 在之后重新调用 _wireDiagPopover()
//  第一次是 no-op 感谢`_diagWired`守卫。
let _diagWired = false;
function _wireDiagPopover() {
  if (_diagWired) return;
  const badge = document.getElementById("rdCardBoardviewDiagBadge");
  const popover = document.getElementById("rdCardBoardviewDiagPopover");
  if (!badge || !popover) return;
  const setOpen = (open) => {
    popover.hidden = !open;
    badge.setAttribute("aria-expanded", open ? "true" : "false");
  };
  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(popover.hidden);
  });
  document.addEventListener("click", (e) => {
    if (popover.hidden) return;
    if (!popover.contains(e.target) && e.target !== badge) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popover.hidden) setOpen(false);
  });
  _diagWired = true;
}

function renderDashboardData(slug, rid, pack, sourcesData) {
  //  仪表板内链接导航到修复的 vue（规范哈希路径）。
  const schemVersions = sourcesData?.schematic_pdf?.versions || [];
  const bvVersions = sourcesData?.boardview?.versions || [];

  //  ── 输入 1 — 原理图 PDF ──────────────────────────────────────────
  setCardState("rdCardSchematic", pack?.has_schematic_pdf ? "on" : "off");
  setCardField("rdCardSchematicState", pack?.has_schematic_pdf
    ? (pack.has_electrical_graph
        ? t("home.dashboard.schematic.state_compiled")
        : t("home.dashboard.schematic.state_compiling"))
    : t("home.dashboard.schematic.state_to_import"));
  const schemMetaSuffix = schemVersions.length > 1
    ? t("home.dashboard.schematic.meta_versions_suffix", { n: schemVersions.length })
    : "";
  setCardField("rdCardSchematicMeta", pack?.has_schematic_pdf
    ? ((pack.has_electrical_graph
        ? t("home.dashboard.schematic.meta_compiled")
        : t("home.dashboard.schematic.meta_imported_compiling")) + schemMetaSuffix)
    : t("home.dashboard.schematic.meta_missing"));
  toggleEl("rdCardSchematicLoss", !pack?.has_schematic_pdf);

  const schemActions = document.getElementById("rdCardSchematicActions");
  if (schemActions) {
    schemActions.innerHTML = "";
    if (pack?.has_schematic_pdf) {
      schemActions.appendChild(linkButton(repairHash(rid, "schematic"),
        ICONS.arrowRight + " " + escapeHtml(t("home.dashboard.schematic.open")), "is-primary"));
      //  免费计划（模式管理、cloud_hints）：pas d'import de fichier — le
      //  服务器拒绝上传 (402)，请勿提供不同的服务。
      if (!hideUploads()) {
        schemActions.appendChild(actionButton(
          ICONS.upload + " " + escapeHtml(t("home.dashboard.schematic.import_version")), () => {
            document.getElementById("rdUploadSchematic")?.click();
          }));
      }
    } else if (!hideUploads()) {
      schemActions.appendChild(actionButton(
        ICONS.upload + " " + escapeHtml(t("home.dashboard.schematic.import_pdf")), () => {
          document.getElementById("rdUploadSchematic")?.click();
        }, "is-warn"));
    }
  }
  renderVersionList("rdCardSchematic", "schematic_pdf", schemVersions, slug, rid, {
    graphStatus: pack?.has_schematic_pdf
      ? (pack.has_electrical_graph ? "compiled" : "building")
      : null,
  });

  //  ── 输入 2 — Boardview ──────────────────────────────────────────────
  setCardState("rdCardBoardview", pack?.has_boardview ? "on" : "off");
  setCardField("rdCardBoardviewState", pack?.has_boardview
    ? t("home.dashboard.boardview.state_imported")
    : t("home.dashboard.boardview.state_to_import"));
  setCardField("rdCardBoardviewFmt", pack?.boardview_format
    ? t("home.dashboard.boardview.fmt_format", { format: pack.boardview_format })
    : t("home.dashboard.boardview.fmt_default"));
  const bvMetaSuffix = bvVersions.length > 1
    ? t("home.dashboard.schematic.meta_versions_suffix", { n: bvVersions.length })
    : "";
  setCardField("rdCardBoardviewMeta", pack?.has_boardview
    ? t("home.dashboard.boardview.meta_imported", {
        format: pack.boardview_format || t("home.dashboard.boardview.fmt_detected"),
        suffix: bvMetaSuffix,
      })
    : t("home.dashboard.boardview.meta_missing"));
  toggleEl("rdCardBoardviewLoss", !pack?.has_boardview);

  //  诊断就绪徽章 — 仅在加载 boardview 时可见
  //  船舶制造商标记的网络参考（XZZ v6 后阻力
  //  /电压部分）。通过 /api/board/render 延迟获取，所以我们
  //  不要在没有 boardview 的设备上支付解析成本。点击
  //  打开本地化 FR popover（i18n 驱动体）的徽章。
  const diagWrapEl = document.getElementById("rdCardBoardviewDiagWrap");
  if (diagWrapEl) diagWrapEl.hidden = true;
  if (pack?.has_boardview && diagWrapEl) {
    fetch(`/api/board/render?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : null)
      .then(payload => {
        const refs = payload?.net_diagnostics?.length || 0;
        if (refs > 0) {
          const countEl = document.getElementById("rdCardBoardviewDiagCount");
          if (countEl) countEl.textContent = refs.toString();
          diagWrapEl.hidden = false;
          _wireDiagPopover();
        }
      })
      .catch(() => { /*  fail-quiet — 徽章保持隐藏状态  */ });
  }

  const bvActions = document.getElementById("rdCardBoardviewActions");
  if (bvActions) {
    bvActions.innerHTML = "";
    if (pack?.has_boardview) {
      bvActions.appendChild(linkButton(repairHash(rid, "pcb"),
        ICONS.arrowRight + " " + escapeHtml(t("home.dashboard.boardview.open")), "is-primary"));
      //  免费计划（管理模式、cloud_hints）：导入 — 查看卡示意图。
      if (!hideUploads()) {
        bvActions.appendChild(actionButton(
          ICONS.upload + " " + escapeHtml(t("home.dashboard.boardview.import_version")), () => {
            document.getElementById("rdUploadBoardview")?.click();
          }));
      }
    } else if (!hideUploads()) {
      bvActions.appendChild(actionButton(
        ICONS.upload + " " + escapeHtml(t("home.dashboard.boardview.import_boardview")), () => {
          document.getElementById("rdUploadBoardview")?.click();
        }, "is-warn"));
    }
  }
  renderVersionList("rdCardBoardview", "boardview", bvVersions, slug, rid);

  //  ── DERIVED 1 — 知识图谱（因果包）──────────────────────
  const packComplete = !!(pack && pack.has_registry && pack.has_knowledge_graph
    && pack.has_rules && pack.has_dictionary && pack.has_audit_verdict);
  const packPartial = !!(pack && (pack.has_registry || pack.has_knowledge_graph
    || pack.has_rules || pack.has_dictionary));
  const knowledgeState = packComplete ? "on" : (packPartial ? "building" : "off");
  setCardState("rdCardKnowledge", knowledgeState);
  setCardField("rdCardKnowledgeState",
    packComplete ? t("home.dashboard.knowledge.state_approved")
    : packPartial ? t("home.dashboard.knowledge.state_building")
    : t("home.dashboard.knowledge.state_empty"));
  setCardField("rdCardKnowledgeMeta",
    packComplete ? t("home.dashboard.knowledge.meta_complete")
    : packPartial ? t("home.dashboard.knowledge.meta_building")
    : t("home.dashboard.knowledge.meta_off"));
  const knowledgeActions = document.getElementById("rdCardKnowledgeActions");
  if (knowledgeActions) {
    knowledgeActions.innerHTML = "";
    if (packComplete || packPartial) {
      knowledgeActions.appendChild(linkButton(repairHash(rid, "graph"),
        ICONS.arrowRight + " " + escapeHtml(t("home.dashboard.knowledge.open_graph")),
        packComplete ? "is-primary" : ""));
    }
  }

  //  ── DERIVED 2 — 电气图（由schematic PDF 编译）──────
  const electricalState = pack?.has_electrical_graph
    ? "on"
    : (pack?.has_schematic_pdf ? "building" : "off");
  setCardState("rdCardElectrical", electricalState);
  setCardField("rdCardElectricalState", pack?.has_electrical_graph
    ? t("home.dashboard.electrical.state_compiled")
    : (pack?.has_schematic_pdf
        ? t("home.dashboard.electrical.state_compiling")
        : t("home.dashboard.electrical.state_unavailable")));
  setCardField("rdCardElectricalMeta", pack?.has_electrical_graph
    ? t("home.dashboard.electrical.meta_compiled")
    : (pack?.has_schematic_pdf
        ? t("home.dashboard.electrical.meta_compiling")
        : t("home.dashboard.electrical.meta_off")));
  const electricalActions = document.getElementById("rdCardElectricalActions");
  if (electricalActions) {
    electricalActions.innerHTML = "";
    if (pack?.has_electrical_graph) {
      electricalActions.appendChild(linkButton(repairHash(rid, "schematic"),
        ICONS.arrowRight + " " + escapeHtml(t("home.dashboard.electrical.open")), "is-primary"));
    }
  }

  //  ── DERIVED 3 — 记忆库（规则+发现+字典）────────
  const memoryState = pack?.has_rules ? "on" : (pack?.has_registry ? "building" : "off");
  setCardState("rdCardMemory", memoryState);
  setCardField("rdCardMemoryState", pack?.has_rules
    ? t("home.dashboard.memory.state_active")
    : (pack?.has_registry
        ? t("home.dashboard.memory.state_building")
        : t("home.dashboard.memory.state_empty")));
  setCardField("rdCardMemoryMeta", pack?.has_rules
    ? t("home.dashboard.memory.meta_active")
    : (pack?.has_registry
        ? t("home.dashboard.memory.meta_building")
        : t("home.dashboard.memory.meta_off")));
  const memoryActions = document.getElementById("rdCardMemoryActions");
  if (memoryActions) {
    memoryActions.innerHTML = "";
    if (pack?.has_rules || pack?.has_registry) {
      memoryActions.appendChild(linkButton(`?view=md${repairHash(rid, "graph")}`,
        ICONS.arrowRight + " " + escapeHtml(t("home.dashboard.memory.open")),
        pack?.has_rules ? "is-primary" : ""));
    }
  }
}

//  能力横幅 — 顶部的单个丝带显示人工智能的功能
//  立即访问。读取为任务状态标题。
function renderCapabilities(pack) {
  const cap = document.getElementById("rdCap");
  const title = document.getElementById("rdCapTitle");
  const body = document.getElementById("rdCapBody");
  const score = document.getElementById("rdCapScore");
  const list = document.getElementById("rdCapList");
  if (!cap || !title || !body || !score || !list) return;

  const flags = {
    //  “电图”功能（模拟器+假设）被门控
    //  正在解析的图表，而不是本地 schematic PDF：代理的工具
    //  (mb_schematic_graph / mb_假设) 运行 has_electrical_graph
    //  服务器端（manifest.py：_has_electrical_graph）。在云中的图表
    //  可以从共享缓存中获取（通过 PDF 哈希解析每个所有者）
    //  如果没有该租户重新上传 PDF，则对 has_schematic_pdf 进行门控
    //  错误地显示工具被禁用，而图表实际上是实时的。的
    //  PDF 仍然是一个来源（下面是它自己的数据卡），而不是一种功能。
    schematic: !!pack?.has_electrical_graph,
    boardview: !!pack?.has_boardview,
    graph:     !!(pack && pack.has_knowledge_graph && pack.has_rules),
    memory:    !!pack?.has_rules,
    stock:     !!pack?.has_parts_index,
  };
  const onCount = Object.values(flags).filter(Boolean).length;
  const totalCount = Object.keys(flags).length;
  let level = "minimal";
  let label = t("home.dashboard.cap.minimal_label");
  let blurb = t("home.dashboard.cap.minimal_blurb");
  if (onCount === totalCount) {
    level = "full";
    label = t("home.dashboard.cap.full_label");
    blurb = t("home.dashboard.cap.full_blurb");
  } else if (onCount >= 2) {
    level = "partial";
    label = t("home.dashboard.cap.partial_label");
    blurb = t("home.dashboard.cap.partial_blurb");
  } else if (onCount === 1) {
    level = "minimal";
    label = t("home.dashboard.cap.minimal_partial_label");
    blurb = t("home.dashboard.cap.minimal_partial_blurb");
  } else {
    level = "minimal";
    label = t("home.dashboard.cap.cold_label");
    blurb = t("home.dashboard.cap.cold_blurb");
  }
  cap.dataset.level = level;
  title.textContent = label;
  body.textContent = blurb;
  score.textContent = t("home.dashboard.cap.score", { n: onCount });

  const rows = [
    { key: "schematic", label: t("home.dashboard.cap.row.schematic_label"), on: t("home.dashboard.cap.row.schematic_on"), off: t("home.dashboard.cap.row.off") },
    { key: "boardview", label: t("home.dashboard.cap.row.boardview_label"), on: t("home.dashboard.cap.row.boardview_on"), off: t("home.dashboard.cap.row.off") },
    { key: "graph",     label: t("home.dashboard.cap.row.graph_label"),     on: t("home.dashboard.cap.row.graph_on"),     off: t("home.dashboard.cap.row.off") },
    { key: "memory",    label: t("home.dashboard.cap.row.memory_label"),    on: t("home.dashboard.cap.row.memory_on"),    off: t("home.dashboard.cap.row.off") },
    { key: "stock",     label: t("home.dashboard.cap.row.stock_label"),     on: t("home.dashboard.cap.row.stock_on"),     off: t("home.dashboard.cap.row.off") },
  ];
  list.innerHTML = rows.map(r => {
    const on = flags[r.key];
    return `<li class="rd-cap-pill ${on ? "on" : "off"}">
      <span class="rd-cap-pill-dot"></span>
      <span class="rd-cap-pill-label">${escapeHtml(r.label)}</span>
      <span class="rd-cap-pill-tag">${escapeHtml(on ? r.on : r.off)}</span>
      <button type="button" class="rd-cap-info" data-cap="${r.key}" aria-label="${escapeHtml(t("home.dashboard.cap.info_aria", { name: r.label }))}" title="${escapeHtml(t("home.dashboard.cap.info_title"))}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 12v4"/></svg>
      </button>
    </li>`;
  }).join("");
  wireCapInfoButtons(list);
}

//  ── 能力工具列表popover ────────────────────────────────────────
//  将每个功能映射到其代理工具表面。字符串位于 i18n
//  (home.dashboard.cap.tools.<cap>.<idx>.{name,desc}) 所以它们会翻译。
//  工具清单的真实来源：api/agent/manifest.py。
const CAP_TOOLS = {
  schematic: ["mb_schematic_graph", "mb_hypothesize"],
  boardview: [
    "bv_highlight", "bv_focus", "bv_scene", "bv_propose_protocol",
    "bv_draw_arrow", "bv_annotate", "bv_record_step_result",
  ],
  graph:  ["mb_get_rules_for_symptoms", "mb_get_component", "mb_expand_knowledge"],
  memory: [
    "mb_record_finding", "mb_record_session_log", "mb_record_measurement",
    "mb_observations_from_measurements", "mb_validate_finding",
  ],
  stock: [
    "stock_search", "stock_list_donors", "stock_mark_donor",
    "stock_unmark_donor", "stock_consume",
  ],
};

function wireCapInfoButtons(listEl) {
  listEl.querySelectorAll(".rd-cap-info").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const cap = btn.dataset.cap;
      openCapPopover(cap, btn);
    });
  });
}

let _capPopoverAnchor = null;
function openCapPopover(cap, anchorBtn) {
  const pop = document.getElementById("rdCapPopover");
  const titleEl = document.getElementById("rdCapPopoverTitle");
  const toolsEl = document.getElementById("rdCapPopoverTools");
  if (!pop || !titleEl || !toolsEl) return;
  if (_capPopoverAnchor === anchorBtn && !pop.hidden) {
    closeCapPopover();
    return;
  }
  _capPopoverAnchor = anchorBtn;
  titleEl.textContent = t(`home.dashboard.cap.row.${cap}_label`);
  //  以一行“这个源是什么+它解锁什么”开头，这样
  //  分组读取为依赖项（导入→解锁），而不是分类法。
  const descEl = document.getElementById("rdCapPopoverDesc");
  if (descEl) descEl.textContent = t(`home.dashboard.cap.desc.${cap}`);
  const tools = CAP_TOOLS[cap] || [];
  toolsEl.innerHTML = tools.map(toolName => `
    <li class="rd-cap-popover-tool">
      <code class="rd-cap-popover-tool-name">${escapeHtml(toolName)}</code>
      <span class="rd-cap-popover-tool-desc">${escapeHtml(t(`home.dashboard.cap.tool_desc.${toolName}`))}</span>
    </li>
  `).join("");
  //  位于视口坐标中的锚点按钮下方（固定）。 CSS
  //  `right: XPx` 从视口的右边缘开始测量，所以我们
  //  将 popover 的右边缘与按钮的右边缘对齐，然后
  //  夹到最小的排水沟。用body.llm-打开聊天面板
  //  占据最右边的 420px — 装订线跳到 420+12，所以
  //  popover 永远不会在聊天下方滑动。
  const llmOpen = document.body.classList.contains("llm-open");
  const minRight = llmOpen ? 432 : 12;
  const btnRect = anchorBtn.getBoundingClientRect();
  const top = btnRect.bottom + 6;
  const right = Math.max(minRight, window.innerWidth - btnRect.right);
  pop.style.top = `${top}px`;
  pop.style.right = `${right}px`;
  pop.hidden = false;
  pop.dataset.open = "true";
}

function closeCapPopover() {
  const pop = document.getElementById("rdCapPopover");
  if (!pop) return;
  pop.hidden = true;
  delete pop.dataset.open;
  _capPopoverAnchor = null;
}

//  一次性接线——近距离处理程序不依赖于哪种功能
//  活跃，所以它们连接一次。单击外部或 Escape 关闭；
//  popover 内的 [×] 路由至相同的闭合路径。
document.addEventListener("click", (ev) => {
  const pop = document.getElementById("rdCapPopover");
  if (!pop || pop.hidden) return;
  if (pop.contains(ev.target)) return;
  if (_capPopoverAnchor && _capPopoverAnchor.contains(ev.target)) return;
  closeCapPopover();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeCapPopover();
});
document.getElementById("rdCapPopoverClose")?.addEventListener("click", () => closeCapPopover());

//  在卡片内呈现已上传版本的列表（一旦
//  存在 1 个版本 - 即使是单个版本也值得浮出水面，因此技术
//  可以看到加载了哪个文件，如果错误则删除它）。
//  每行：广播+文件名·时间戳·大小+状态（活动schematic
//  仅）+垃圾箱（悬停）。单击该行可通过以下方式切换活动引脚
//  PUT /来源/{种类};单击垃圾箱以通过删除删除。
//  当 5+ 版本时，内部列表滚动并且标题保持固定。
//  opts.graphStatus 为“已编译 |”建筑 | null`并且只影响
//  schematic 卡的活动行 — boardview 行忽略它。
function renderVersionList(cardId, kind, versions, slug, rid, opts = {}) {
  const card = document.getElementById(cardId);
  if (!card) return;
  let host = card.querySelector(".rd-versions");
  if (!host) {
    host = document.createElement("div");
    host.className = "rd-versions";
    card.appendChild(host);
  }
  if (!versions || versions.length < 1) {
    host.remove();
    return;
  }
  host.innerHTML = `<div class="rd-versions-head">
    <span class="rd-versions-tag">${escapeHtml(t("home.version.tag"))}</span>
    <span class="rd-versions-count">${versions.length}</span>
  </div>
  <div class="rd-versions-list" data-overflow="${versions.length > 5 ? "scroll" : "fit"}"></div>`;
  const listEl = host.querySelector(".rd-versions-list");
  for (const v of versions) {
    const row = document.createElement("div");
    row.className = "rd-version-row" + (v.is_active ? " is-active" : "");
    const dateLabel = formatVersionDate(v.timestamp);
    const switchBtn = document.createElement("button");
    switchBtn.type = "button";
    switchBtn.className = "rd-version-switch";
    switchBtn.disabled = !!v.is_active;
    const showStatus = (
      v.is_active
      && kind === "schematic_pdf"
      && (opts.graphStatus === "compiled" || opts.graphStatus === "building")
    );
    const statusKey = opts.graphStatus === "compiled"
      ? "home.version.status_compiled"
      : "home.version.status_building";
    const statusHtml = showStatus
      ? `<span class="rd-version-status" data-status="${opts.graphStatus}">
           <span class="rd-version-status-dot" aria-hidden="true"></span>
           <span class="rd-version-status-label">${escapeHtml(t(statusKey))}</span>
         </span>`
      : "";
    switchBtn.innerHTML = `
      <span class="rd-version-dot" aria-hidden="true"></span>
      <span class="rd-version-name">${escapeHtml(v.original_name)}</span>
      <span class="rd-version-meta">${escapeHtml(dateLabel)} · ${escapeHtml(fmtBytes(v.size_bytes))}</span>
      ${statusHtml}
    `;
    if (!v.is_active) {
      switchBtn.addEventListener("click", () => switchSource(slug, rid, kind, v));
    }
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "rd-version-delete";
    deleteBtn.title = t("home.version.delete_aria");
    deleteBtn.setAttribute("aria-label", t("home.version.delete_aria"));
    deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteVersion(slug, rid, kind, v);
    });
    row.appendChild(switchBtn);
    row.appendChild(deleteBtn);
    listEl.appendChild(row);
  }
}

//  将类似 ISO 的上传时间戳 `20260424T130000Z` 解析为简短的
//  fr-区域设置标签“24 avr·13:00”。解析失败时回退到原始字符串。
function formatVersionDate(ts) {
  if (!ts) return "…";
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return ts;
  const [, y, mo, d, h, mi] = m;
  const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`);
  if (isNaN(dt)) return ts;
  const localeTag = (window.i18n && window.i18n.locale === "fr") ? "fr-FR" : "en-US";
  return dt.toLocaleString(localeTag, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).replace(",", " ·");
}

//  ──── 构建观察程序（schematic 重新编译微调器 + ETA + 轮询）────────
//  一种全局状态，因为最多可以在一个 schematic 重建上运行
//  一次设备（后端序列化）。前端保持1秒
//  ETA 显示倒计时，以及 /pipeline/packs/{slug} 上较慢的 8 秒轮询
//  检测完成（has_electrical_graph 翻转回 true）。
let _buildState = null;

function startBuildWatch(slug, rid, etaSeconds, pageCount) {
  stopBuildWatch();
  _buildState = {
    slug, rid,
    pageCount,
    remaining: etaSeconds || 0,
    countdownId: null,
    pollId: null,
  };
  renderBuildIndicators(_buildState);
  _buildState.countdownId = setInterval(() => {
    if (!_buildState) return;
    _buildState.remaining = Math.max(0, _buildState.remaining - 1);
    renderBuildIndicators(_buildState);
  }, 1000);
  _buildState.pollId = setInterval(async () => {
    if (!_buildState) return;
    const pack = await fetchJSON(`/pipeline/packs/${encodeURIComponent(slug)}`, null);
    if (pack?.has_electrical_graph) {
      stopBuildWatch();
      showToast("ok",
        t("home.toast.compile_done_title"),
        t("home.toast.compile_done_sub"));
      await refreshDashboardData(slug, rid);
    }
  }, 8000);
}

function stopBuildWatch() {
  if (!_buildState) return;
  if (_buildState.countdownId) clearInterval(_buildState.countdownId);
  if (_buildState.pollId) clearInterval(_buildState.pollId);
  _buildState = null;
  document.querySelectorAll(".rd-build-eta").forEach(el => el.remove());
}

function renderBuildIndicators(state) {
  for (const cardId of ["rdCardSchematic", "rdCardElectrical"]) {
    const card = document.getElementById(cardId);
    if (!card) continue;
    let eta = card.querySelector(".rd-build-eta");
    if (!eta) {
      eta = document.createElement("div");
      eta.className = "rd-build-eta";
      eta.innerHTML =
        '<span class="rd-build-spinner" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
            '<circle cx="12" cy="12" r="9" opacity=".25"/>' +
            '<path d="M21 12a9 9 0 00-9-9"/>' +
          '</svg>' +
        '</span>' +
        '<span class="rd-build-text"></span>';
      card.appendChild(eta);
    }
    const txt = eta.querySelector(".rd-build-text");
    if (state.remaining > 0) {
      txt.textContent = state.pageCount
        ? t("home.dashboard.build.vision_pipeline_pages", {
            n: state.pageCount, remaining: formatRemaining(state.remaining),
          })
        : t("home.dashboard.build.vision_pipeline", {
            remaining: formatRemaining(state.remaining),
          });
    } else if (state.remaining === 0 && state.pageCount) {
      txt.textContent = t("home.dashboard.build.vision_pipeline_finalizing_pages", {
        n: state.pageCount,
      });
    } else {
      txt.textContent = t("home.dashboard.build.vision_pipeline_running");
    }
  }
}

function formatRemaining(sec) {
  if (sec >= 60) {
    const min = Math.ceil(sec / 60);
    return t("home.dashboard.build.remaining_min", { n: min });
  }
  return t("home.dashboard.build.remaining_sec", { n: sec });
}

//  演示 schematic 重新导入的缓存命中动画。被解雇
//  在“has_electrical_graph”为 true 之前处理Upload
//  POST — 典型情况是技术人员在某个时间段内重新上传相同的 PDF
//  演示运行。我们伪造可见的管道侧（旋转器+ ETA
//  原理图 + 电气卡）约 12 秒，然后刷新仪表板数据
//  同步现实。这里故意不涵盖Boardview：
//  重新导入很便宜（没有管道）并且即时翻转也很好。
async function playFakeIngestTimeline(slug, rid) {
  const TOTAL_SEC = 12;
  setCardState("rdCardSchematic", "building");
  setCardState("rdCardElectrical", "building");
  //  重用真实观察者的渲染器，以便可见的镶边
  //  （旋转器 + ETA 文本）与真正的重建相同。
  const fakeState = {
    slug, rid,
    pageCount: null,
    remaining: TOTAL_SEC,
    countdownId: null,
    pollId: null,
  };
  renderBuildIndicators(fakeState);
  fakeState.countdownId = setInterval(() => {
    fakeState.remaining = Math.max(0, fakeState.remaining - 1);
    renderBuildIndicators(fakeState);
  }, 1000);
  await new Promise((r) => setTimeout(r, TOTAL_SEC * 1000));
  clearInterval(fakeState.countdownId);
  document.querySelectorAll(".rd-build-eta").forEach((el) => el.remove());
  await refreshDashboardData(slug, rid);
}

//  自动恢复：如果我们在 schematic PDF 存在时登陆仪表板
//  但电气图丢失了，重建工作正在进行中
//  session — 启动观察者，没有倒计时（只是轮询）。
function maybeAutoResumeBuildWatch(slug, rid, pack) {
  if (_buildState) return; //  已经在观看
  if (!pack?.has_schematic_pdf) return;
  if (pack.has_electrical_graph) return;
  startBuildWatch(slug, rid, 0, null);
}

async function switchSource(slug, rid, kind, version) {
  const label = kind === "schematic_pdf"
    ? t("home.toast.kind_schematic")
    : t("home.toast.kind_boardview");
  showToast("info",
    t("home.toast.switch_in_progress", { kind: label }),
    `${version.original_name} · ${fmtBytes(version.size_bytes)}`);

  //  飞行前用户体验：将相关卡片翻转至建筑物，以便技术人员
  //  甚至在 PUT 响应到达之前就看到发生了一些事情。
  if (kind === "schematic_pdf") {
    setCardState("rdCardSchematic", "building");
    setCardState("rdCardElectrical", "building");
  }

  try {
    const res = await fetch(
      `/pipeline/packs/${encodeURIComponent(slug)}/sources/${kind}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: version.filename }),
      },
    );
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).detail || ""; } catch (_) { /*  努普  */ }
      showToast("warn",
        t("home.toast.switch_failed_title"),
        t("home.toast.switch_failed_sub", {
          status: res.status,
          detail: detail || t("home.toast.switch_failed_retry"),
        }));
      await refreshDashboardData(slug, rid);
      return;
    }
    const body = await res.json();
    if (body.status === "cached") {
      showToast("ok",
        t("home.toast.version_cached_title"),
        t("home.toast.version_cached_sub", { name: version.original_name }));
    } else if (body.status === "rebuilding") {
      const pages = body.page_count ? ` · ${body.page_count} pages` : "";
      const eta = body.eta_seconds ? ` · ~${formatRemaining(body.eta_seconds)}` : "";
      showToast("info",
        t("home.toast.rebuilding_title"),
        t("home.toast.rebuilding_sub", {
          name: version.original_name,
          pages,
          eta,
        }));
      startBuildWatch(slug, rid, body.eta_seconds || 0, body.page_count || null);
    } else {
      showToast("ok",
        t("home.toast.pin_updated_title"),
        t("home.toast.pin_updated_sub", { name: version.original_name }));
    }
    //  删除 PCB 查看器的有效负载缓存，以便下一次 #pcb 访问
    //  重新获取 /api/board/render 并解析新固定的文件
    //  — 如果没有这个，桥的 slug 缓存将服务于陈旧的
    //  版本，因为 slug 本身没有改变。
    if (kind === "boardview"
        && window.Boardview
        && typeof window.Boardview.invalidate === "function") {
      window.Boardview.invalidate(slug);
    }
    await refreshDashboardData(slug, rid);
  } catch (err) {
    console.error("switchSource failed", err);
    showToast("warn",
      t("home.toast.network_title"),
      t("home.toast.network_sub"));
    await refreshDashboardData(slug, rid);
  }
}

async function deleteVersion(slug, rid, kind, version) {
  const confirmMsg = t("home.version.delete_confirm", { name: version.original_name });
  if (!window.confirm(confirmMsg)) return;

  //  飞行前：如果我们删除活动的schematic，后端将
  //  切换到下一个最新的。无论哪种方式，卡片都会翻转到建筑物，直到
  //  缓存决策落地。
  if (version.is_active && kind === "schematic_pdf") {
    setCardState("rdCardSchematic", "building");
    setCardState("rdCardElectrical", "building");
  }

  try {
    const res = await fetch(
      `/pipeline/packs/${encodeURIComponent(slug)}`
      + `/sources/${kind}/versions/${encodeURIComponent(version.filename)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).detail || ""; } catch (_) { /*  努普  */ }
      showToast("warn",
        t("home.toast.delete_failed_title"),
        t("home.toast.delete_failed_sub", {
          status: res.status,
          detail: detail || t("home.toast.delete_failed_retry"),
        }));
      await refreshDashboardData(slug, rid);
      return;
    }
    const body = await res.json();
    if (body.status === "switched_rebuilding") {
      const pages = body.page_count ? ` · ${body.page_count} pages` : "";
      const eta = body.eta_seconds ? ` · ~${formatRemaining(body.eta_seconds)}` : "";
      showToast("info",
        t("home.toast.version_deleted_rebuilding_title"),
        t("home.toast.version_deleted_rebuilding_sub", {
          name: version.original_name,
          pages,
          eta,
        }));
      startBuildWatch(slug, rid, body.eta_seconds || 0, body.page_count || null);
    } else {
      showToast("ok",
        t("home.toast.version_deleted_title"),
        t("home.toast.version_deleted_sub", { name: version.original_name }));
    }
    //  对于 boardview 删除，PCB 查看器缓存保存前一个文件的
    //  Payload — 无效，以便下次访问重新获取 /api/board/render。
    if (kind === "boardview"
        && version.is_active
        && window.Boardview
        && typeof window.Boardview.invalidate === "function") {
      window.Boardview.invalidate(slug);
    }
    await refreshDashboardData(slug, rid);
  } catch (err) {
    console.error("deleteVersion failed", err);
    showToast("warn",
      t("home.toast.network_title"),
      t("home.toast.network_sub"));
    await refreshDashboardData(slug, rid);
  }
}

//  帮手────────────────────────────────────────────────────────
function setCardState(id, state) {
  const el = document.getElementById(id);
  if (el) el.dataset.state = state;
}
function setCardField(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function toggleEl(id, on) {
  const el = document.getElementById(id);
  if (el) el.hidden = !on;
}
function linkButton(href, html, extra = "") {
  const a = document.createElement("a");
  a.className = `rd-data-card-btn ${extra}`.trim();
  a.href = href;
  a.innerHTML = html;
  return a;
}
function actionButton(html, onclick, extra = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `rd-data-card-btn ${extra}`.trim();
  b.innerHTML = html;
  b.addEventListener("click", onclick);
  return b;
}

// ───────────────────────────────────────────────────────────────
//  上传接线 — POST /pipeline/packs/{slug}/documents
//  原理图 = .pdf → kind=schematic_pdf
//  Boardview = 解析器支持的扩展 → kind=boardview
// ───────────────────────────────────────────────────────────────
let _uploadHandlersWired = false;
function wireUploadHandlers(slug, rid) {
  //  免费计划（管理模式、cloud_hints）：aucune voie d'import — ni boutons
  //  (déjà non rendus) ni 拖放。 Le server 拒绝上传 (402) pareil。
  if (hideUploads()) return;
  //  即使在重新安装时，也始终重新绑定每个会话 slug/rid。
  const schemInput = document.getElementById("rdUploadSchematic");
  const bvInput = document.getElementById("rdUploadBoardview");
  if (schemInput) {
    schemInput.value = "";
    schemInput.onchange = (ev) => {
      const file = ev.target.files?.[0];
      if (file) handleUpload(slug, rid, file, "schematic_pdf");
      ev.target.value = "";
    };
  }
  if (bvInput) {
    bvInput.value = "";
    bvInput.onchange = (ev) => {
      const file = ev.target.files?.[0];
      if (file) handleUpload(slug, rid, file, "boardview");
      ev.target.value = "";
    };
  }
  if (_uploadHandlersWired) return;
  _uploadHandlersWired = true;

  //  拖放到关闭状态卡上。通过 .is-dragover 进行视觉提示。
  const wireDrop = (cardId, kind) => {
    const card = document.getElementById(cardId);
    if (!card) return;
    card.addEventListener("dragenter", (ev) => {
      if (card.dataset.state !== "off") return;
      ev.preventDefault();
      card.classList.add("is-dragover");
    });
    card.addEventListener("dragover", (ev) => {
      if (card.dataset.state !== "off") return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
    });
    card.addEventListener("dragleave", () => card.classList.remove("is-dragover"));
    card.addEventListener("drop", (ev) => {
      ev.preventDefault();
      card.classList.remove("is-dragover");
      const file = ev.dataTransfer?.files?.[0];
      if (!file) return;
      const slugNow = getDeviceSlug();
      const ridNow = getRepairId();
      if (!slugNow || !ridNow) return;
      handleUpload(slugNow, ridNow, file, kind);
    });
  };
  wireDrop("rdCardSchematic", "schematic_pdf");
  wireDrop("rdCardBoardview", "boardview");
}

async function handleUpload(slug, rid, file, kind) {
  const cardId = kind === "schematic_pdf" ? "rdCardSchematic" : "rdCardBoardview";
  const card = document.getElementById(cardId);
  if (card) card.dataset.state = "building";

  //  上传之前的快照 `has_electrical_graph` — 用于检测
  //  “假导入”（在设备上重新上传 schematic PDF）
  //  已经有了派生图），因此演示会播放动画
  //  重建而不是立即翻转。 Boardview没有派生
  //  源删除后仍然存在的人工制品，并且重新导入的成本很低
  //  无论如何（它后面没有管道），所以我们跳过它的假路径。
  let preExisting = false;
  if (kind === "schematic_pdf") {
    try {
      const pre = await fetchJSON(`/pipeline/packs/${encodeURIComponent(slug)}`, null);
      if (pre) preExisting = Boolean(pre.has_electrical_graph);
    } catch (_) { /*  落入normal流  */ }
  }

  const kindLabel = kind === "schematic_pdf"
    ? t("home.toast.kind_schematic")
    : t("home.toast.kind_boardview");
  showToast("info",
    t("home.toast.import_in_progress", { kind: kindLabel }),
    `${file.name} · ${fmtBytes(file.size)}`);

  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", file);

  try {
    const res = await fetch(`/pipeline/packs/${encodeURIComponent(slug)}/documents`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).detail || ""; } catch (_) { /*  努普  */ }
      showToast("warn",
        t("home.toast.import_failed"),
        t("home.toast.switch_failed_sub", {
          status: res.status,
          detail: detail || t("home.toast.import_failed_retry"),
        }));
      //  失败时恢复之前的状态。
      await refreshDashboardData(slug, rid);
      return;
    }
    showToast("ok",
      t("home.toast.import_done"),
      `${file.name} · ${fmtBytes(file.size)}`);
    if (preExisting) {
      //  演示缓存命中路径：后端短路（缓存散列 PDF）
      //  我们模拟了大约 12 秒的可见视觉管道活动
      //  刷新之前的原理图+电气卡。
      await playFakeIngestTimeline(slug, rid);
    } else {
      await refreshDashboardData(slug, rid);
    }
  } catch (err) {
    console.error("upload failed", err);
    showToast("warn",
      t("home.toast.network_title"),
      t("home.toast.network_sub"));
    await refreshDashboardData(slug, rid);
  }
}

let _toastTimer = null;
function showToast(tone, title, sub) {
  const toast = document.getElementById("rdToast");
  const titleEl = document.getElementById("rdToastTitle");
  const subEl = document.getElementById("rdToastSub");
  const iconEl = document.getElementById("rdToastIcon");
  if (!toast || !titleEl || !subEl || !iconEl) return;
  toast.dataset.tone = tone;
  titleEl.textContent = title;
  subEl.textContent = sub || "";
  iconEl.innerHTML = tone === "ok"
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>'
    : tone === "warn"
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" opacity=".3"/><path d="M21 12a9 9 0 00-9-9"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></path></svg>';
  toast.classList.remove("hidden");
  if (_toastTimer) clearTimeout(_toastTimer);
  //  “info”保留到下一个 showToast（正在进行上传）；确定/警告自动清除。
  if (tone !== "info") {
    _toastTimer = setTimeout(() => toast.classList.add("hidden"), 3600);
  }
}

// ───────────────────────────────────────────────────────────────
//  Board-delta 卡 — 特定修订版 overlay 表面处理什么
//  代理知道这个确切的板号：签名 IC，值得注意
//  rails，修复陷阱，亲属提示（表弟板）。隐藏时
//  修复时或增量端点 404s/ 返回时没有 board_number
//  覆盖范围“无”。
// ───────────────────────────────────────────────────────────────
async function renderBoardDeltaCard(slug, boardNumber) {
  const card = document.getElementById("rdCardBoardDelta");
  if (!card) return;

  //  这次维修没有板号——隐藏卡和保释金。
  if (!boardNumber) {
    card.classList.add("hidden");
    return;
  }

  let delta;
  try {
    delta = await apiGet(
      `/pipeline/packs/${encodeURIComponent(slug)}/board-delta/${encodeURIComponent(boardNumber)}`,
    );
  } catch (_) {
    //  404 或网络错误 — 隐藏该卡。
    card.classList.add("hidden");
    return;
  }

  //  覆盖率“无”意味着增量作为记录存在但不携带数据。
  if (!delta || delta.coverage === "none") {
    card.classList.add("hidden");
    return;
  }

  //  按（部分、角色）删除重复 IC — 与批准的模型相同的逻辑。
  const seen = new Set();
  const ics = [];
  for (const ic of (delta.signature_ics || [])) {
    const k = `${ic.part}|${ic.role}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ics.push(ic);
  }

  const rails   = (delta.notable_rails    || []).slice(0, 8);
  const pitfalls = delta.repair_pitfalls  || [];
  const cousins  = delta.kinship_hints    || [];
  const sources  = delta.sources          || [];

  const icRows = ics.map(ic =>
    `<div class="rd-delta-row">` +
      `<span class="rd-delta-mono rd-delta-cyan">${escapeHtml(ic.part || "?")}</span>` +
      `<span class="rd-delta-role">${escapeHtml(ic.role)}</span>` +
    `</div>`,
  ).join("");

  const railRows = rails.map(r =>
    `<div class="rd-delta-row">` +
      `<span class="rd-delta-mono rd-delta-emerald">${escapeHtml(r.name)}</span>` +
      `<span class="rd-delta-note">${escapeHtml(r.note)}</span>` +
    `</div>`,
  ).join("");

  const pitRows = pitfalls.map(p =>
    `<div class="rd-delta-pit">` +
      `<div class="rd-delta-pit-title rd-delta-amber">${escapeHtml(p.title)}</div>` +
      `<div class="rd-delta-pit-detail">${escapeHtml(p.detail)}</div>` +
    `</div>`,
  ).join("");

  const cousinRows = cousins.map(k =>
    `<div class="rd-delta-row">` +
      `<span class="rd-delta-mono">${escapeHtml(k.board_number)}</span>` +
      `<span class="rd-delta-note">${escapeHtml(k.relation)}</span>` +
    `</div>`,
  ).join("");

  const covLabel = escapeHtml(delta.coverage || "");
  const boardLabel = escapeHtml(boardNumber);
  const deviceLabel = escapeHtml(delta.device_label || "");

  card.innerHTML =
    `<header class="rd-delta-head">` +
      `<span class="rd-delta-dot" aria-hidden="true"></span>` +
      `<span class="rd-delta-title" data-i18n="home.dashboard.board_delta.title">${escapeHtml(t("home.dashboard.board_delta.title"))}</span>` +
      `<span class="rd-delta-cov">${covLabel}</span>` +
      `<span class="rd-delta-board-num">${boardLabel}</span>` +
    `</header>` +
    `<div class="rd-delta-disclaimer">` +
      escapeHtml(t("home.dashboard.board_delta.disclaimer_pre")) +
      ` <strong>${deviceLabel} · ${boardLabel}</strong>. ` +
      escapeHtml(t("home.dashboard.board_delta.disclaimer_post")) +
    `</div>` +
    (ics.length ? (
      `<div class="rd-delta-sec">` +
        `<div class="rd-delta-sec-head">${escapeHtml(t("home.dashboard.board_delta.sec_ics"))}</div>` +
        icRows +
      `</div>`
    ) : "") +
    (rails.length ? (
      `<div class="rd-delta-sec">` +
        `<div class="rd-delta-sec-head">${escapeHtml(t("home.dashboard.board_delta.sec_rails"))}</div>` +
        railRows +
      `</div>`
    ) : "") +
    (pitfalls.length ? (
      `<div class="rd-delta-sec">` +
        `<div class="rd-delta-sec-head">${escapeHtml(t("home.dashboard.board_delta.sec_pitfalls"))}</div>` +
        pitRows +
      `</div>`
    ) : "") +
    (cousins.length ? (
      `<div class="rd-delta-sec">` +
        `<div class="rd-delta-sec-head">${escapeHtml(t("home.dashboard.board_delta.sec_cousins"))}</div>` +
        cousinRows +
      `</div>`
    ) : "") +
    `<div class="rd-delta-foot">` +
      `${ics.length} ICs · ${rails.length} rails · ${pitfalls.length} ` +
      escapeHtml(t("home.dashboard.board_delta.foot_pitfalls")) +
      ` · ${cousins.length} ` +
      escapeHtml(t("home.dashboard.board_delta.foot_cousins")) +
      ` · ${sources.length} ` +
      escapeHtml(t("home.dashboard.board_delta.foot_sources")) +
    `</div>`;

  card.classList.remove("hidden");
}

async function deleteConversation(rid, convId) {
  let res;
  try {
    res = await fetch(
      `/pipeline/repairs/${encodeURIComponent(rid)}/conversations/${encodeURIComponent(convId)}`,
      { method: "DELETE" },
    );
  } catch (_) {
    showToast("warn", t("home.dashboard.convs.delete_failed"));
    return;
  }
  if (!res.ok) {
    showToast("warn", t("home.dashboard.convs.delete_failed"));
    return;
  }
  closePanelIfConv(convId);
  const fresh = await fetchJSON(
    `/pipeline/repairs/${encodeURIComponent(rid)}/conversations`,
    { conversations: [] },
  );
  renderDashboardConvs(fresh.conversations || [], rid);
}

function renderDashboardConvs(conversations, rid) {
  const body = document.getElementById("rdConvBody");
  const count = document.getElementById("rdConvCount");
  if (!body || !count) return;
  count.textContent = String(conversations.length);
  body.innerHTML = "";
  if (conversations.length === 0) {
    body.innerHTML = `<div class="rd-block-empty">${escapeHtml(t("home.dashboard.convs.empty"))}</div>`;
  } else {
    for (const c of conversations) {
      const row = document.createElement("div");
      row.className = "rd-conv-row";
      row.dataset.convId = c.id;
      const tier = (c.tier || "fast").toLowerCase();
      const fallbackTitle = t("home.dashboard.convs.untitled", { id: c.id.slice(0, 6) });
      const title = escapeHtml((c.title || fallbackTitle).slice(0, 80));
      const ago = c.last_turn_at ? relativeTimeFr(c.last_turn_at) : "…";
      const cost = typeof c.cost_usd === "number" ? `$${c.cost_usd.toFixed(3)}` : "n/a";
      const meta = t("home.dashboard.convs.turns_meta", {
        turns: c.turns || 0,
        cost,
        ago,
      });

      const open = document.createElement("button");
      open.type = "button";
      open.className = "rd-conv-open";
      open.innerHTML =
        `<span class="rd-conv-tier t-${tier}">${tier.toUpperCase()}</span>` +
        `<span class="rd-conv-title">${title}</span>` +
        `<span class="rd-conv-meta">${escapeHtml(meta)}</span>`;
      open.addEventListener("click", () => {
        openPanel(c.id);  //  针对正确转化的单一连接
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "rd-conv-delete";
      del.title = t("home.dashboard.convs.delete_aria");
      del.setAttribute("aria-label", t("home.dashboard.convs.delete_aria"));
      del.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
        'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M3 4h10M6.5 4V2.5h3V4M5 4l.5 9a1 1 0 001 1h3a1 1 0 001-1l.5-9"/>' +
        '<path d="M7 7v5M9 7v5"/></svg>';
      del.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm(t("home.dashboard.convs.delete_confirm"))) return;
        await deleteConversation(rid, c.id);
      });

      row.appendChild(open);
      row.appendChild(del);
      body.appendChild(row);
    }
  }
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "rd-conv-new";
  newBtn.textContent = t("home.dashboard.convs.new");
  newBtn.addEventListener("click", () => {
    openPanel("new");  //  单连接；后端延迟实现第一条消息
  });
  body.appendChild(newBtn);
}

function renderDashboardFindings(findings, currentRid) {
  const body = document.getElementById("rdFindingsBody");
  const count = document.getElementById("rdFindingsCount");
  if (!body || !count) return;
  count.textContent = String(findings.length);
  if (findings.length === 0) {
    body.innerHTML = `<div class="rd-block-empty">${t("home.dashboard.findings.empty_html")}</div>`;
    return;
  }
  body.innerHTML = "";
  const currentShort = currentRid.slice(0, 8);
  for (const f of findings) {
    const row = document.createElement("div");
    row.className = "rd-finding-row";
    const isCurrent = f.session_id && f.session_id.startsWith(currentShort);
    const sessionChip = isCurrent
      ? `<span class="rd-finding-session current">${escapeHtml(t("home.dashboard.findings.session_current"))}</span>`
      : (f.session_id
          ? `<span class="rd-finding-session">${escapeHtml(f.session_id.slice(0, 8))}</span>`
          : `<span class="rd-finding-session">(none)</span>`);
    const notes = f.notes
      ? `<p class="rd-finding-notes">${escapeHtml(f.notes)}</p>`
      : "";
    row.innerHTML =
      `<div class="rd-finding-top">` +
        `<span class="rd-finding-refdes">${escapeHtml(f.refdes)}</span>` +
        `<span class="rd-finding-symptom">${escapeHtml(f.symptom)}</span>` +
        sessionChip +
      `</div>` +
      `<p class="rd-finding-cause">${escapeHtml(f.confirmed_cause || "…")}</p>` +
      notes;
    body.appendChild(row);
  }
}

function renderDashboardTimeline(repair, conversations, findings, pack) {
  const body = document.getElementById("rdTimelineBody");
  if (!body) return;
  const events = [];
  if (repair?.created_at) {
    events.push({ when: repair.created_at, label: t("home.dashboard.timeline.session_opened"), kind: "cyan" });
  }
  for (const c of conversations) {
    if (c.last_turn_at) {
      events.push({
        when: c.last_turn_at,
        label: t("home.dashboard.timeline.activity", {
          tier: (c.tier || "fast").toLowerCase(),
          turns: c.turns || 0,
        }),
        kind: "emerald",
      });
    }
  }
  for (const f of findings) {
    if (f.created_at) {
      events.push({
        when: f.created_at,
        label: t("home.dashboard.timeline.finding_confirmed", {
          refdes: f.refdes || "?",
        }),
        kind: "violet",
      });
    }
  }
  if (pack?.audit_verdict) {
    events.push({
      when: repair?.created_at || new Date().toISOString(),
      label: t("home.dashboard.timeline.pack_audited", { verdict: pack.audit_verdict }),
      kind: pack.audit_verdict === "APPROVED" ? "emerald" : "amber",
    });
  }
  events.sort((a, b) => (b.when || "").localeCompare(a.when || ""));
  const MAX = 8;
  const shown = events.slice(0, MAX);
  body.innerHTML = shown.map(e => (
    `<li class="rd-timeline-item">` +
      `<span class="rd-timeline-node ${e.kind}"></span>` +
      `<span class="rd-timeline-when">${escapeHtml(relativeTimeFr(e.when))}</span>` +
      `<span class="rd-timeline-label">${escapeHtml(e.label)}</span>` +
    `</li>`
  )).join("");
  if (events.length > MAX) {
    const olderLabel = t("home.dashboard.timeline.older", { n: events.length - MAX });
    body.innerHTML += `<li class="rd-timeline-item"><span class="rd-timeline-node"></span><span class="rd-timeline-label">${escapeHtml(olderLabel)}</span></li>`;
  }
  if (events.length === 0) {
    body.innerHTML = `<li class="rd-block-empty">${escapeHtml(t("home.dashboard.timeline.empty"))}</li>`;
  }
}

function renderDashboardPack(pack, slug, rid) {
  const body = document.getElementById("rdPackBody");
  if (!body) return;
  if (!pack) {
    body.innerHTML = `<div class="rd-block-empty">${escapeHtml(t("home.dashboard.pack.empty"))}</div>`;
    return;
  }
  const arts = [
    { key: "has_registry", label: "registry" },
    { key: "has_knowledge_graph", label: "knowledge_graph" },
    { key: "has_rules", label: "rules" },
    { key: "has_dictionary", label: "dictionary" },
    { key: "has_audit_verdict", label: "audit" },
  ];
  const presentCount = arts.filter(a => !!pack[a.key]).length;
  const complete = presentCount === arts.length;
  const statusLabel = complete
    ? t("home.dashboard.pack.status_approved")
    : t("home.dashboard.pack.status_building");
  const statusClass = complete ? "ok" : "warn";
  const rows = arts.map(a => {
    const on = !!pack[a.key];
    return `<li class="rd-pack-row ${on ? "on" : "off"}">` +
      `<span class="rd-pack-tick" aria-hidden="true">${on ? ICON_CHECK : "·"}</span>` +
      `<span class="rd-pack-label">${a.label}</span>` +
    `</li>`;
  }).join("");
  body.innerHTML =
    `<div class="rd-pack-status">` +
      `<span class="rd-pack-status-label ${statusClass}">${statusLabel}</span>` +
      `<span class="rd-pack-count">${presentCount}/${arts.length}</span>` +
    `</div>` +
    `<ul class="rd-pack-rows">${rows}</ul>`;
}

let _dashboardHandlersWired = false;
function wireDashboardHandlers() {
  if (_dashboardHandlersWired) return;
  _dashboardHandlersWired = true;
  document.getElementById("rdLeaveBtn")?.addEventListener("click", () => {
    leaveSession();
  });
}

let _fixBtnResetUnsub = null;
function wireFixButton(slug, rid) {
  const btn = document.getElementById("dashboardFixBtn");
  if (!btn) return;
  //  当验证流程失败时，resetBtn 会清除挂起状态（代理
  //  拒绝、MA 工具丢失、错误事件）。通过商店有线连接到llm.js
  //  下面的“fixButtonReset”键。
  const resetBtn = () => {
    btn.disabled = false;
    btn.innerHTML = ICON_CHECK + " " + escapeHtml(t("home.dashboard.fix_btn"));
    btn.classList.remove("is-validated");
    if (btn._fixTimeoutId) { clearTimeout(btn._fixTimeoutId); btn._fixTimeoutId = null; }
  };
  //  放弃任何先前的订阅，以便仅连接最新的按钮（镜像
  //  前一个窗口全局的单处理程序语义）。
  if (_fixBtnResetUnsub) _fixBtnResetUnsub();
  _fixBtnResetUnsub = store.subscribe("fixButtonReset", resetBtn);
  btn.classList.remove("hidden");
  resetBtn();
  btn.onclick = () => {
    const ws = getDiagnosticWS();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      btn.textContent = t("home.dashboard.fix_btn_open_chat");
      setTimeout(() => {
        btn.innerHTML = ICON_CHECK + " " + escapeHtml(t("home.dashboard.fix_btn"));
      }, 1800);
      return;
    }
    ws.send(JSON.stringify({ type: "validation.start", repair_id: rid }));
    btn.disabled = true;
    btn.textContent = t("home.dashboard.fix_btn_validating");
    //  安全超时：如果代理从不触发simulation.repair_validated
    //  （MA工具缺失、拒绝、错误），25秒后重置，所以按钮
    //  并没有永久卡住。
    btn._fixTimeoutId = setTimeout(() => {
      btn.textContent = t("home.dashboard.fix_btn_failed");
      setTimeout(resetBtn, 2200);
    }, 25000);
  };
}

//  当用户切换时重新渲染强制构建的修复仪表板
//  语言。仅当仪表板实际显示时才会触发 - 否则
//  下一个 renderRepairDashboard 调用自然会选择新的语言环境。
async function refreshHomeOnLocaleChange() {
  const homeSection = document.getElementById("homeSection");
  if (!homeSection || homeSection.classList.contains("hidden")) return;

  const slug = getDeviceSlug();
  const rid = getRepairId();

  //  仅仪表板模式 - 在区域设置切换时重新渲染聚焦的会话视图。
  //  不再有日记网格（landing是全局主页和句柄
  //  它自己的i18n通过数据-i18n）；当没有主动修复时，这里什么都没有
  //  势在必行，所以我们就返回。
  if (slug && rid) {
    try {
      await renderRepairDashboard({ device: slug, repair: rid });
    } catch (err) {
      console.warn("[home] dashboard re-render failed", err);
    }
  }
}

//  连接主页/仪表板区域设置刷新。新的修复模式已被删除
//  D.2（landing形式是单一创建条目，它是一个严格的超集
//  — 设备 + 症状 + device_kind + schematic-创建时）；仅仪表板的
//  EN/FR 切换上的强制重新渲染仍保留在这里。
export function initHome() {
  if (window.i18n && typeof window.i18n.onChange === "function") {
    window.i18n.onChange(() => { refreshHomeOnLocaleChange(); });
  }
}
