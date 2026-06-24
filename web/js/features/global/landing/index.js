// Landing 首页 — 「开始诊断」完整流程（HTTP + progress WebSocket）
//
// ┌─ 前端（本文件 + pipelineSocket.js）──────────────────────────────────────┐
// │ Step 1  用户点「开始诊断」→ submitDiagnostic() → _launchDiagnostic()      │
// │ Step 2  fetch POST /pipeline/repairs  （HTTP 短连接，~474 行）            │
// │ Step 3  repair = await res.json()    （HTTP 结束，读 RepairResponse）     │
// │ Step 4  若 pipeline_started=false → goToWorkspace，流程结束              │
// │ Step 5  若 pipeline_started=true  → subscribeToProgress(slug) (~547)   │
// │ Step 6  connectProgress → new WebSocket(/pipeline/progress/{slug})       │
// │ Step 7  handleProgressEvent 消费 WS 帧，更新 landing timeline            │
// │ Step 8  pipeline_finished → goToWorkspace(repair_id, slug)               │
// └──────────────────────────────────────────────────────────────────────────┘
//
// ┌─ 后端（repairs.py + events.py + progress.py + orchestrator）─────────────┐
// │ Step A  @router.post create_repair 接收 HTTP                              │
// │ Step B  persist repair → 判断 pack_complete → Branch 0/1/2/3            │
// │ Step C  Branch 1: create_task(_launch) → _run_pipeline_with_events       │
// │ Step D  orchestrator emit → events.publish(slug, ev)                      │
// │ Step E  return RepairResponse（HTTP 响应发出，连接关闭）                    │
// │ Step F  progress_ws: subscribe(slug) → while True 转发 event 给浏览器      │
// └──────────────────────────────────────────────────────────────────────────┘
//
// slug = device_slug，是 HTTP 响应与 progress WS 的唯一 join key。
// 响应体字段详解：api/pipeline/models.py :: RepairResponse
//
// 此处无独立分类器 — 现有 pipeline（Scout → Registry → Mapper? →
// Writers ×3 → Auditor）一次性完成设备识别与知识构建。
// orchestrator 在各阶段内部发出实时 `phase_step` 事件
//（Scout 轮次、原理图页、各 writer 完成、审计轮次）；
// 前端将其渲染到各 timeline 行的实时行 + 可折叠「détail」日志，
// 让技师实时观看 agent 工作。

import { mountMascot, setMascotState } from '../../../mascot.js';
import { prettifySlug, repairHash, seedSlugForRepair } from '../../../router.js';
import i18n from '../../../i18n.js';
import { escapeHtml as _escapeHtml } from '../../../shared/dom.js';
import { initProfileMenu, refreshProfileMenu } from './profile_menu.js';
import { initCatalogue, closeCatalogue } from './catalogue.js';
import { maybeStartOnboarding, preGateOnboarding, replayOnboarding } from './onboarding.js';
import { openInfoModal } from '../../../info_modal.js';
import { packedOnly, hideUploads, planHints } from '../../../cloud_hints.js';

const KNOWLEDGE_INFO_FLAG = 'wb_knowledge_info_seen';
import { connectProgress, fetchPendingKind } from '../../../services/pipelineSocket.js';
import { loadDevices } from '../../../services/deviceCatalog.js';
import {
  PHASE_ORDER,
  LANDING_DYNAMIC_PHASES,
  showTimeline,
  stopEtaTicker,
  ensureLandingPhase,
  setPhaseState,
  setPhaseStep,
  setTimelineTitle,
  resetTimelineRows,
} from './timeline.js';

const STATUS_NEUTRAL = "";
const STATUS_LOADING = "loading";
const STATUS_ERROR = "error";

// 建议芯片上的设备类型简码 — 不做 i18n（紧凑等宽码，各语言相同）。
// 与后端 device_kind 枚举对应。
export const DEVICE_KIND_SHORT = { gpu_card:"GPU", laptop_logic_board:"PORTABLE", phone_logic_board:"TÉLÉPHONE", desktop_motherboard:"BUREAU", sbc_board:"SBC", power_charging_board:"ALIM", other:"AUTRE" };

let isSubmitting = false;
let progressConn = null;
let _landingMascot = null;
// 由预检弹窗的邮件复选框设置（仅 cloud）；repair 创建后读取以启用
//「完成后邮件通知」选项。每次启动时重置。
let _preflightNotifyOptIn = false;
// 当前 progress 订阅在构建完成时是否自动进入工作区。
// 全新提交或显式点击瓦片恢复时为 true；
// 被动加载恢复时为 false（避免打断正在浏览的技师）。
let _autoNavOnFinish = true;
// 构建因设备类型分歧暂停时设为 true
//（pipeline_paused / needs_kind_confirmation）。构建协程故意返回且 WS 关闭 —
// 不得将此关闭视为失败。
let _landingPaused = false;
// 进行中构建的活跃 slug/rid。（重新）订阅时存储，以便 confirmLandingKind
// 在同一 slug 上重新订阅新构建。
let _activeSlug = null;
let _activeRid = null;

function setLandingMascot(state) {
  if (!_landingMascot) return;
  setMascotState(_landingMascot, state);
}

// 日期格式化跟随当前 i18n 区域（由 profile.reply_language 驱动，
// 自 commit 548ed20 移除顶栏切换后）。惰性重算以便会话中途
// 切换语言无需刷新页面。
function _landingDateFmt() {
  const locale = (i18n && i18n.locale) || 'en';
  // 将短区域码映射为 Intl 所需的 BCP-47 区域标签。
  const bcp47 = locale === 'fr' ? 'fr-FR' : 'en-US';
  return new Intl.DateTimeFormat(bcp47, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

// 移动端抽屉（≤999px）：最近维修侧栏从左滑入，
// 由 #landingRepairsToggle 打开。桌面端侧栏为固定列，
// 这些控件无效（toggle/backdrop 经 CSS display:none 隐藏）。
function openRepairsDrawer() {
  document.getElementById("landing-overlay")?.classList.add("sidebar-open");
  const bd = document.getElementById("landingSidebarBackdrop");
  if (bd) bd.hidden = false;
  document.getElementById("landingRepairsToggle")?.setAttribute("aria-expanded", "true");
}
function closeRepairsDrawer() {
  document.getElementById("landing-overlay")?.classList.remove("sidebar-open");
  const bd = document.getElementById("landingSidebarBackdrop");
  if (bd) bd.hidden = true;
  document.getElementById("landingRepairsToggle")?.setAttribute("aria-expanded", "false");
}

async function loadAndRenderSidebar() {
  const sidebar = document.getElementById("landingSidebar");
  const list = document.getElementById("landingSidebarList");
  const count = document.getElementById("landingSidebarCount");
  const toggle = document.getElementById("landingRepairsToggle");
  if (!sidebar || !list) return;

  let repairs = [];
  try {
    const res = await fetch("/pipeline/repairs");
    if (res.ok) repairs = await res.json();
  } catch (err) {
    console.warn("[landing] loadRepairs failed", err);
  }
  if (!repairs || repairs.length === 0) {
    sidebar.hidden = true;
    if (toggle) toggle.hidden = true;   // 无内容可打开 → 隐藏移动端触发器
    closeRepairsDrawer();
    return;
  }

  // 最新的排在最前。
  repairs.sort((a, b) => {
    const ta = new Date(a.created_at).getTime() || 0;
    const tb = new Date(b.created_at).getTime() || 0;
    return tb - ta;
  });

  if (count) {
    const key = repairs.length > 1 ? "landing.sidebar.count_many" : "landing.sidebar.count_one";
    count.textContent = window.t ? window.t(key, { n: repairs.length }) : `${repairs.length} repairs`;
  }

  const tFn = window.t || ((k) => k);
  list.innerHTML = "";
  for (const r of repairs) {
    const li = document.createElement("li");
    li.className = "landing-sidebar-item";

    // 该 repair 对应设备的 pack 构建状态（来自列表接口的 _build_state.json）。
    // 仅非就绪状态显示瓦片徽章 — 'complete'/null 为正常情况，不显示徽章。
    const bs = r.build_state;
    const badged = bs === "building" || bs === "failed" || bs === "paused";
    if (badged) li.classList.add(`is-${bs}`);

    const a = document.createElement("a");
    a.className = "landing-sidebar-link";
    seedSlugForRepair(r.repair_id, r.device_slug);   // 已知 slug — 保持导航同步
    a.href = repairHash(r.repair_id, "diagnostic");
    if (bs === "building") {
      // 构建中的瓦片跳转到实时 timeline（恢复），而非 pack 尚未就绪的工作区。
      // autoNav：显式点击表示「我要观看」，构建完成时自动进入设备。
      a.title = tFn("landing.sidebar.locked_hint");
      a.setAttribute("aria-label", tFn("landing.sidebar.resume_aria"));
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        closeRepairsDrawer();
        resumeBuild(r.device_slug, r.repair_id, { autoNav: true });
      });
    } else {
      a.addEventListener("click", closeRepairsDrawer);  // 导航时关闭移动端抽屉
      if (bs === "failed" || bs === "paused") a.title = tFn(`landing.sidebar.state_${bs}`);
    }

    const dev = document.createElement("span");
    dev.className = "landing-sidebar-device";
    const devName = document.createElement("span");
    devName.className = "landing-sidebar-device-name";
    devName.textContent = prettifySlug(r.device_slug);
    dev.appendChild(devName);
    if (badged) {
      const badge = document.createElement("span");
      badge.className = `landing-sidebar-state mono is-${bs}`;
      badge.textContent = tFn(`landing.sidebar.state_${bs}`);
      dev.appendChild(badge);
    }

    const sym = document.createElement("span");
    sym.className = "landing-sidebar-symptom";
    sym.textContent = r.symptom || "…";
    if (r.symptom) sym.title = r.symptom;

    const meta = document.createElement("span");
    meta.className = "landing-sidebar-meta";
    const dateStr = r.created_at
      ? _landingDateFmt().format(new Date(r.created_at)).replace(/,\s*/g, " ")
      : "";
    const ridShort = (r.repair_id || "").slice(0, 8);
    meta.textContent = dateStr ? `${dateStr} · ${ridShort}` : ridShort;

    a.appendChild(dev);
    a.appendChild(sym);
    a.appendChild(meta);
    li.appendChild(a);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "landing-sidebar-delete";
    del.setAttribute("aria-label", window.t ? window.t("landing.sidebar.delete_aria") : "Delete this repair");
    del.title = window.t ? window.t("landing.sidebar.delete_title") : "Delete";
    del.textContent = "×";
    del.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onDeleteRepairClick(r.repair_id, li, del);
    });
    li.appendChild(del);

    list.appendChild(li);
  }
  sidebar.hidden = false;
  if (toggle) toggle.hidden = false;   // 有维修记录 → 显示移动端触发器

  // 页面（重新）加载时若有进行中的构建 → 被动恢复其实时 timeline，
  // 避免构建中途刷新丢失进度视图。autoNav 关闭以免打断
  // 重新打开 landing 准备开新工单的技师。
  maybeResumeActiveBuild(repairs);
}

// 从失败的 Response 构建可读 Error。优先使用后端结构化错误信息
//（cloud 前门的 {error:{message}} 门控、FastAPI 的 {detail:...}）—
// 状态行里裸 JSON 对技师来说像 bug。非 JSON 正文保留原始
// `HTTP <status> <body>` 行（仍是最有用的展示）。
async function httpError(res) {
  const detail = await res.text().catch(() => "");
  let msg = `HTTP ${res.status} ${detail}`;
  try {
    const parsed = JSON.parse(detail);
    const m = parsed?.error?.message
      || parsed?.detail?.message
      || (typeof parsed?.detail === "string" ? parsed.detail : null);
    if (m) msg = m;
  } catch { /* 非 JSON — 保留原始行 */ }
  return new Error(msg);
}

async function onDeleteRepairClick(repairId, itemEl, btnEl) {
  const t = window.t || ((k) => k);
  const ok = window.confirm(t("landing.delete.confirm"));
  if (!ok) return;

  btnEl.disabled = true;
  try {
    const res = await fetch(`/pipeline/repairs/${encodeURIComponent(repairId)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw await httpError(res);
  } catch (err) {
    console.error("[landing] delete failed", err);
    setStatus(t("landing.status.error_delete", { error: err.message || err }), STATUS_ERROR);
    btnEl.disabled = false;
    return;
  }

  itemEl.remove();
  const list = document.getElementById("landingSidebarList");
  const count = document.getElementById("landingSidebarCount");
  const remaining = list ? list.children.length : 0;
  if (count) {
    if (remaining > 0) {
      const key = remaining > 1 ? "landing.sidebar.count_many" : "landing.sidebar.count_one";
      count.textContent = t(key, { n: remaining });
    } else {
      count.textContent = "";
    }
  }
  if (remaining === 0) {
    const sidebar = document.getElementById("landingSidebar");
    if (sidebar) sidebar.hidden = true;
  }
}

export function showLanding() {
  document.body.classList.add("show-landing");
  const ov = document.getElementById("landing-overlay");
  if (ov) ov.hidden = false;
  // 首次运行时同步调暗 hero，避免分阶段揭示前先闪出完整驾驶舱
  //（廉价标志检查；若 onboarding 不运行则下方会解除）。
  preGateOnboarding();
  // 挂载 hero 吉祥物一次；重新打开时重置为 idle。每次重新打开时
  // 刷新侧栏，以便 leaveSession() 后显示最新维修列表。
  if (!_landingMascot) {
    _landingMascot = mountMascot(document.getElementById("landingMascot"), {
      size: "md", state: "idle",
    });
  } else {
    setLandingMascot("idle");
  }
  loadAndRenderSidebar();
  loadPacksForSuggest();
  _updateFreeLock(); // free 锁初始状态（仅托管模式）
  setTimeout(() => document.getElementById("landingDevice")?.focus(), 50);

  // 资料 pill（始终存在）+ 一次性引导 onboarding。两者都读取 profile；
  // onboarding 额外按维修数量与 localStorage 标志门控，
  // 并驱动 hero 吉祥物的状态切换。
  refreshProfileMenu();
  maybeStartOnboarding({ setMascotState: setLandingMascot });

  // 侧栏导览按钮 — 手动重放 onboarding 导览
  document.getElementById("landingSidebarTour")
    ?.addEventListener("click", () => {
      replayOnboarding({ setMascotState: setLandingMascot });
    });
}

export function hideLanding() {
  document.body.classList.remove("show-landing");
  const ov = document.getElementById("landing-overlay");
  if (ov) ov.hidden = true;
  if (progressConn) { progressConn.close(); progressConn = null; }
}

// 由目录弹窗设备卡「开始诊断」按钮调用。将所选设备固定到
// landing 状态与表单，然后走标准提交流程，使所有现有门控
//（free-lock、全新构建预检、消歧、导航）不变 — 不重复 POST。
export async function launchFromCatalogue({ slug, label, complete, device_kind, symptom }) {
  _selectedDeviceSlug = slug || null;
  _selectedDeviceComplete = Boolean(complete);
  const deviceEl = document.getElementById("landingDevice");
  const symptomEl = document.getElementById("landingSymptom");
  const kindEl = document.getElementById("landingDeviceKind");
  if (deviceEl) deviceEl.value = label || "";
  if (symptomEl) symptomEl.value = symptom || "";
  if (kindEl) kindEl.value = device_kind || "";
  await submitDiagnostic();
}

function setStatus(msg, kind) {
  const el = document.getElementById("landingStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.remove("error");
  if (kind === STATUS_ERROR) el.classList.add("error");
}

function setSubmitting(on) {
  isSubmitting = on;
  const btn = document.getElementById("landingSubmit");
  if (btn) btn.disabled = on;
  const dev = document.getElementById("landingDevice");
  const sym = document.getElementById("landingSymptom");
  if (dev) dev.disabled = on;
  if (sym) sym.disabled = on;
  // 提交结束后 free 锁重新接管按钮状态。
  if (!on) _updateFreeLock();
}

// 开始诊断的 free 锁（cloud_hints.packedOnly — 仅托管模式）：
// 技师未在 picker 中选择 pack 完整（✓ 徽章）的设备前按钮保持禁用，
// 表单下方显示帮助文案 + 升级 CTA。自托管：packedOnly() 为 false，
// 本函数不生效。纯 UI — cloud 端强制提交仍会返回 402 FREE_PACK_ONLY。
function _updateFreeLock() {
  if (!packedOnly()) return;
  const locked = !(_selectedDeviceSlug && _selectedDeviceComplete);
  const btn = document.getElementById("landingSubmit");
  if (btn && !isSubmitting) btn.disabled = locked;
  let hint = document.getElementById("landingFreeHint");
  if (!hint) {
    const form = document.getElementById("landingForm");
    if (!form) return;
    const t = window.t || ((k) => k);
    hint = document.createElement("p");
    hint.id = "landingFreeHint";
    hint.className = "landing-free-hint";
    hint.append(document.createTextNode(`${t("landing.free.locked_hint")} `));
    const a = document.createElement("a");
    a.href = "/app/upgrade";
    a.textContent = t("landing.free.upgrade_cta");
    hint.appendChild(a);
    form.appendChild(hint);
  }
  hint.hidden = !locked;
}

// 全新运行前重置：清除编排暂停状态 + 设备类型面板（本文件负责），
// 再将阶段行 DOM 重置委托给 timeline.js。
function resetTimeline() {
  _landingPaused = false;
  document.getElementById("landingKindPanel")?.remove();
  resetTimelineRows();
}

// 「全新构建」（完整 ~15 分钟 pipeline，cloud 上 1 积分）指技师
// 未选择已完整的已知 pack。自由文本或不完整 pack → 后端跑完整 pipeline。
// 完整 pack 选择 → 缓存命中或廉价后台 expand（无预检门控）。
// 与 free-lock 谓词保持一致。
function _isFreshBuild() {
  return !(_selectedDeviceSlug && _selectedDeviceComplete);
}

async function onSubmit(ev) {
  ev?.preventDefault();
  return submitDiagnostic();
}

async function submitDiagnostic() {
  if (isSubmitting) return;
  const t = window.t || ((k) => k);
  const deviceEl = document.getElementById("landingDevice");
  const symptomEl = document.getElementById("landingSymptom");
  const device = (deviceEl?.value || "").trim();
  const symptom = (symptomEl?.value || "").trim();

  if (device.length < 2) {
    setStatus(t("landing.status.validation_device"), STATUS_ERROR);
    deviceEl?.focus();
    return;
  }
  if (symptom.length < 5) {
    setStatus(t("landing.status.validation_symptom"), STATUS_ERROR);
    symptomEl?.focus();
    return;
  }

  // free 锁安全带：隐式提交（回车）不得绕过禁用按钮。服务端同样会拒绝（402）。
  if (packedOnly() && !(_selectedDeviceSlug && _selectedDeviceComplete)) {
    _updateFreeLock();
    deviceEl?.focus();
    return;
  }

  // 全新构建 → 经预检弹窗门控（积分消耗、~15 分钟构建、
  // 最后机会附原理图、邮件选项）。确认后调用 _launchDiagnostic。
  // 已知完整 pack → 无门控，直接启动（缓存命中 / expand）。
  if (_isFreshBuild()) {
    openPreflightModal(device);
    return;
  }
  await _launchDiagnostic();
}

async function _launchDiagnostic() {
  // ═══ Step 1：Landing「开始诊断」主流程入口 ═══
  // 完整链路见本文件顶部注释；下文按 Step 2–8 标注。
  const t = window.t || ((k) => k);
  const device = (document.getElementById("landingDevice")?.value || "").trim();
  const symptom = (document.getElementById("landingSymptom")?.value || "").trim();

  setStatus(t("landing.status.checking"), STATUS_LOADING);
  setSubmitting(true);
  setLandingMascot("thinking");
  resetTimeline();

  try {
    // 若技师从自动补全选了已知设备，发送 canonical slug，
    // 后端跳过重新 slug 化并命中正确 pack — 避免近似拼写偏差。
    //
    // repair 创建为纯元数据调用（urlencoded，无文件）：原理图走
    // 专用 /packs/{slug}/documents 端点（见 uploadSchematicForSlug）。
    // 这样 cloud 前门可门控创建，原理图不会绕过
    // 加密、租户隔离的上传专用存储。
    const body = new URLSearchParams();
    body.append("device_label", device);
    body.append("symptom", symptom);
    if (_selectedDeviceSlug) body.append("device_slug", _selectedDeviceSlug);
    const kind = document.getElementById("landingDeviceKind")?.value || "";
    if (kind) body.append("device_kind", kind);
    const boardNumber = (document.getElementById("landingBoardNumber")?.value || "").trim();
    if (boardNumber) body.append("board_number", boardNumber);
    // 通知带外原理图：pipeline 在设备类型分类前等待其电气图
    //（上传在创建后下方触发）。
    if (_schematicFile) body.append("schematic_pending", "true");
    // ═══ Step 2：发起 HTTP POST（短连接）═══
    // 后端：repairs.py create_repair @router.post("/repairs") ~780 行
    // 【HTTP 短连接 — 建立并在此请求内结束】POST /pipeline/repairs；
    // res.json() 读完后本 HTTP 连接关闭；构建进度不走此连接。
    const res = await fetch("/pipeline/repairs", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw await httpError(res);
    // ═══ Step 3：解析 RepairResponse JSON（HTTP 在此结束）═══
    // 字段含义：models.py RepairResponse — pipeline_started / device_slug / repair_id …
    const repair = await res.json();

    // T9a 不确定时确认：宽泛标签匹配多块同族板卡。
    // 未创建 repair、未消耗配额 — 在建议下拉显示候选菜单；
    // 选择一项固定 device_slug 后技师重新提交。
    if (repair && repair.needs_disambiguation) {
      setSubmitting(false);
      _renderDisambiguation(repair.candidates || []);
      setStatus(
        "Plusieurs cartes correspondent : choisis-en une, puis relance le diagnostic.",
        STATUS_NEUTRAL,
      );
      return;
    }

    const rid = repair.repair_id;
    const slug = repair.device_slug;
    if (!rid || !slug) throw new Error(t("landing.status.error_invalid_response"));

    // 原理图摄入 — slug 已知后的 canonical 路径。尽力而为：
    // 上传失败不得中止技师刚启动的诊断（pack 仍从网络调研构建；
    // 原理图可稍后从 Memory Bank 仪表盘重新导入）。
    if (_schematicFile) await uploadSchematicForSlug(slug, _schematicFile);

    // ═══ Step 4：按 RepairResponse 分支决定 UX ═══
    // pipeline_started=false → Branch 0/2/3（pack 已有），直接进工作区，不开 progress WS
    // pipeline_started=true  → Branch 1（需构建 pack），继续 Step 5
    if (!repair.pipeline_started) {
      if (repair.matched_rule_id) {
        setStatus(
          t("landing.status.rule_match", { rule_id: repair.matched_rule_id }),
          STATUS_NEUTRAL,
        );
      } else {
        setStatus(
          t("landing.status.device_known", { device: repair.device_label }),
          STATUS_NEUTRAL,
        );
      }
      // 缓存命中 — pack 已在磁盘，无需构建。直接进入诊断工作区
      //（无人工等待）。上方状态消息为引导。（此处曾有 ~15s 假 timeline
      // 动画作演示润色 — 已移除，仅保留真实流程。）
      goToWorkspace(rid, slug, "diagnostic");
      return;
    }

    // Branch 3 — pack 存在但症状为新：后端在后台启动真实定向 expand。
    // pack 在磁盘上故 agent 可立即用现有规则工作；expand 静默完成。
    // 直接进入工作区 — 无人工等待。（此处也曾有 ~15s 假 timeline — 已移除。）
    if (repair.pipeline_kind === "expand") {
      setStatus(
        t("landing.status.device_known", { device: repair.device_label }),
        STATUS_NEUTRAL,
      );
      goToWorkspace(rid, slug, "diagnostic");
      return;
    }

    // ═══ Step 5–8：Branch 1 — 需要构建 pack，开启 progress WebSocket ═══
    setStatus(t("landing.status.build_delay"), STATUS_NEUTRAL);
    showTimeline();
    setTimelineTitle(t("landing.timeline.title_build", { device: repair.device_label }));
    // Step 5→6：subscribeToProgress → connectProgress → new WebSocket
    subscribeToProgress(slug, rid);
    // 预检弹窗中已选「完成后邮件通知」。repair 存在后启用。
    // 仅 cloud（无 plan hints 时复选框隐藏，/notify 为前门路由），自托管不会 POST。
    if (_preflightNotifyOptIn && planHints()) armNotify(rid);
  } catch (err) {
    console.error("[landing] submit failed", err);
    setStatus(t("landing.status.error_create", { error: err.message || err }), STATUS_ERROR);
    setLandingMascot("error");
    setSubmitting(false);
  }
}

// 启用预检弹窗中选的「完成后邮件通知」。POST 到 cloud 前门 /notify 路由，
// 在 pipeline_finished 时给技师发邮件。尽力而为：失败仅记录日志，不阻塞构建。
// 自托管不调用（无 plan hints 时复选框隐藏）。
async function armNotify(repairId) {
  const tt = window.t || ((k) => k);
  try {
    const res = await fetch(`/pipeline/repairs/${encodeURIComponent(repairId)}/notify`, { method: "POST" });
    if (res.ok) setStatus(tt("landing.status.notify_armed"), STATUS_NEUTRAL);
  } catch (err) {
    console.warn("[landing] notify opt-in failed", err);
  }
}

// ============================================================
// 启动前确认弹窗。onSubmit 在全新构建（_isFreshBuild）时打开。
// 明确积分消耗，给技师最后机会附原理图（~15 分钟构建前）。
// 积分行与邮件选项仅 cloud（planHints() 门控）；自托管仍见
// 时长警告 + 原理图提示。确认 → _launchDiagnostic。
// ============================================================

let _preflightLastFocus = null;

// 在弹窗内反映共享的 _schematicFile 状态：「立即附加」提示或「已附加 ✓」文件名。
// 弹窗关闭时也可安全调用（元素只是不可见）。
function renderPreflightSchematic() {
  const hint = document.getElementById("landingPreflightSchematicHint");
  const name = document.getElementById("landingPreflightSchematicName");
  const pick = document.getElementById("landingPreflightSchematicPick");
  const t = window.t || ((k) => k);
  if (name) name.textContent = _schematicFile ? _schematicFile.name : "";
  if (hint) {
    hint.textContent = _schematicFile
      ? t("landing.preflight.schematic_attached")
      : t("landing.preflight.schematic_none");
  }
  if (pick) {
    pick.textContent = _schematicFile
      ? t("landing.preflight.schematic_replace")
      : t("landing.schematic.cta");
  }
}

function openPreflightModal(deviceLabel) {
  const bd = document.getElementById("landingPreflightBackdrop");
  if (!bd) {
    // 无弹窗 DOM（不应发生）— 放行启动而非阻塞。
    _launchDiagnostic();
    return;
  }
  const t = window.t || ((k) => k);
  _preflightLastFocus = document.activeElement;

  const title = document.getElementById("landingPreflightTitle");
  if (title) title.textContent = t("landing.preflight.title", { device: deviceLabel });

  // 仅 cloud 行：积分行与邮件选项。自托管隐藏（无 plan hints）—
  // 引擎不得暴露计费/邮件概念。
  const cloud = !!planHints();
  const credit = document.getElementById("landingPreflightCredit");
  if (credit) credit.hidden = !cloud;
  const notifyRow = document.getElementById("landingPreflightNotifyRow");
  if (notifyRow) notifyRow.hidden = !cloud;
  const notifyCb = document.getElementById("landingPreflightNotify");
  if (notifyCb) notifyCb.checked = false;

  // 原理图区块：不可上传的套餐上隐藏（防御性 — free 锁已在此前阻止全新构建）。
  const schemField = document.getElementById("landingPreflightSchematicField");
  if (schemField) schemField.hidden = hideUploads();
  renderPreflightSchematic();

  bd.classList.add("open");
  bd.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => document.getElementById("landingPreflightConfirm")?.focus());
}

function closePreflightModal() {
  const bd = document.getElementById("landingPreflightBackdrop");
  if (!bd || !bd.classList.contains("open")) return;
  bd.classList.remove("open");
  bd.setAttribute("aria-hidden", "true");
  if (_preflightLastFocus && typeof _preflightLastFocus.focus === "function") {
    _preflightLastFocus.focus();
  }
}

async function confirmPreflight() {
  const cb = document.getElementById("landingPreflightNotify");
  _preflightNotifyOptIn = !!(cb && !cb.hidden && cb.checked);
  closePreflightModal();
  await _launchDiagnostic();
}

function subscribeToProgress(slug, repairId, { autoNav = true } = {}) {
  // ═══ Step 5→6：progress WebSocket 订阅入口 ═══
  // slug 必须等于 Step 3 里 repair.device_slug（与后端 events.publish 同一 key）
  // 实际握手：pipelineSocket.js connectProgress → new WebSocket(url)
  // 后端接住：progress.py progress_ws → websocket.accept → events.subscribe(slug)
  if (progressConn) { progressConn.close(); progressConn = null; }
  // 记住活跃构建，以便技师解决类型分歧后 confirmLandingKind()
  // 在同一 slug 上重新订阅新构建。
  _activeSlug = slug;
  _activeRid = repairId;
  _autoNavOnFinish = autoNav;

  // 【WS 长连接 — 建立】slug 来自上一步 HTTP 响应的 device_slug；
  // 实际握手在 pipelineSocket.js:27 new WebSocket(url)。
  progressConn = connectProgress(slug, {
    onEvent: (data) => handleProgressEvent(data, slug, repairId),
    onError: (ev) => {
      console.warn("[landing] progress WS error", ev);
      setStatus((window.t || ((k) => k))("landing.status.ws_lost"), STATUS_ERROR);
    },
    onClose: () => {
      stopEtaTicker();
      // _landingPaused → 构建协程因设备类型分歧故意返回；
      // 面板已显示，技师将确认。此情况下勿报「连接丢失」。
    },
  });

  // 刷新恢复 — 若先前构建因类型分歧暂停（如技师刷新了页面），
  // 重新渲染确认面板。无 / 非 pending 状态静默：常见情况是「无待确认分歧」。
  fetchPendingKind(slug).then((p) => {
    if (p) {
      handleProgressEvent({
        type: "pipeline_paused",
        reason: "needs_kind_confirmation",
        device_slug: slug,
        user_declared: p.user_declared,
        graph_inferred: p.graph_inferred,
        confidence: p.confidence,
        evidence: p.evidence,
      }, slug, repairId);
    }
  });
}

// 为 pack 仍在构建的 repair 重新挂载实时构建 timeline。
// progress 事件总线在（重新）订阅时重放近期事件环形缓冲，
// timeline 可追上已完成阶段，而非空白等到下一阶段边界。
// 瓦片恢复点击（autoNav true）与被动加载恢复（autoNav false）共用。
function resumeBuild(slug, repairId, { autoNav = true } = {}) {
  // 两路调用（瓦片点击、被动恢复）时 hero 已可见 —
  // 勿在此调用 showLanding()：会重渲染侧栏，在 progressConn 设置前
  // 再次进入 maybeResumeActiveBuild → 递归。
  const t = window.t || ((k) => k);
  resetTimeline();
  showTimeline();
  setTimelineTitle(t("landing.timeline.title_build", { device: prettifySlug(slug) }));
  setStatus(t("landing.status.build_delay"), STATUS_NEUTRAL);
  setLandingMascot("working");
  subscribeToProgress(slug, repairId, { autoNav });
}

// landing（重新）加载时，若有进行中的构建则被动恢复 timeline。
// 守卫：不覆盖已有活跃连接（新提交或恢复中），提交中不自动恢复。
function maybeResumeActiveBuild(repairs) {
  if (progressConn || isSubmitting) return;
  // 最新优先列表（调用方已排序）→ 第一个 building 为最近一条。
  // 构建上限通常意味着最多一条在飞。
  const building = (repairs || []).find((r) => r.build_state === "building");
  if (!building) return;
  resumeBuild(building.device_slug, building.repair_id, { autoNav: false });
}

// 将实时 `phase_step` 子步骤本地化为 timeline 显示的短行
//（"recherche web · tour 2"、"page 3/12" 等）。
// 未知 step 类型返回 ""（前向兼容 — 静默忽略）。
function phaseStepText(ev, t) {
  switch (ev.step) {
    case "search_round":
      return t("landing.timeline.step.search_round", { index: ev.index });
    case "page":
      return t("landing.timeline.step.page", { index: ev.index, total: ev.total });
    case "writer_done": {
      const key = ev.writer === "rules" ? "step.writer_rules"
        : ev.writer === "dict" ? "step.writer_dict"
        : "step.writer_graph";
      return t("landing.timeline." + key, { count: ev.count });
    }
    case "round":
      return ev.index >= 1
        ? t("landing.timeline.step.revision", { index: ev.index })
        : t("landing.timeline.step.audit");
    default:
      return "";
  }
}

function handleProgressEvent(ev, slug, repairId) {
  // ═══ Step 7：消费 progress WS 推送的每一帧 JSON ═══
  // 事件由后端 orchestrator emit → events.publish → progress_ws 转发
  // Step 8：pipeline_finished 分支内 setTimeout → goToWorkspace(repairId, slug)
  const t = window.t || ((k) => k);
  switch (ev.type) {
    case "subscribed":
      break;
    case "queued": {
      // 构建已接受但在并发构建上限后排队等待。
      // 清晰显示位置；队列消化时递减，槽位释放后由 pipeline_started 接管。
      const position = ev.position || 1;
      const ahead = ev.ahead != null ? ev.ahead : Math.max(0, position - 1);
      setTimelineTitle(t("landing.timeline.title_queued", { position }));
      setStatus(t("landing.status.queued", { position, ahead }), STATUS_LOADING);
      setLandingMascot("working");
      break;
    }
    case "pipeline_started": {
      const dev = ev.device_label || ev.device_slug || slug;
      // 若标题仍显示排队状态（"En file d'attente · position N"）则重置 —
      // 构建刚出队并开始。
      setTimelineTitle(t("landing.timeline.title_build", { device: dev }));
      setStatus(t("landing.status.pipeline_started", { device: dev }), STATUS_LOADING);
      break;
    }
    case "phase_started": {
      const phase = ev.phase;
      ensureLandingPhase(phase);
      if (PHASE_ORDER.includes(phase) || phase === "expand" || phase in LANDING_DYNAMIC_PHASES) {
        setPhaseState(phase, "running");
        setLandingMascot("working");
      }
      break;
    }
    case "phase_finished": {
      const phase = ev.phase;
      if (PHASE_ORDER.includes(phase) || phase === "expand" || phase in LANDING_DYNAMIC_PHASES) {
        setPhaseState(phase, "done");
      }
      break;
    }
    case "phase_step": {
      const phase = ev.phase;
      if (!(PHASE_ORDER.includes(phase) || phase === "expand" || phase in LANDING_DYNAMIC_PHASES)) break;
      const text = phaseStepText(ev, t);
      if (text) setPhaseStep(phase, text);
      break;
    }
    case "pipeline_finished": {
      setTimelineTitle(t("landing.timeline.title_ready", { status: ev.status || "" }));
      setStatus(t("landing.status.ready"), STATUS_NEUTRAL);
      stopEtaTicker();
      setLandingMascot("success");
      if (_autoNavOnFinish) {
        // 全新提交 / 显式瓦片恢复：将技师带入已就绪设备。
        // 短暂延迟以便最终审计子步骤先渲染。
        setTimeout(() => goToWorkspace(repairId, slug), 2500);
      } else {
        // 被动加载恢复：勿打断浏览中的技师。仅刷新侧栏使瓦片
        // 从「building」变为可点击进入工作区，并关闭已结束的 progress 连接。
        if (progressConn) { progressConn.close(); progressConn = null; }
        loadAndRenderSidebar();
      }
      break;
    }
    case "pipeline_paused":
      if (ev.reason === "needs_kind_confirmation") {
        _landingPaused = true;
        ensureLandingPhase("device_kind");
        setPhaseState("device_kind", "running");
        renderLandingKindConfirm(ev);
      }
      break;
    case "pipeline_failed": {
      setTimelineTitle(t("landing.timeline.title_failed"));
      setStatus(t("landing.status.error_pipeline", { error: ev.error || ev.status || t("landing.status.error_unknown") }), STATUS_ERROR);
      const running = document.querySelector(".landing-phase.is-running");
      if (running) {
        running.classList.remove("is-running");
        running.classList.add("is-failed");
      }
      stopEtaTicker();
      setLandingMascot("error");
      setSubmitting(false);
      break;
    }
    default:
      break;
  }
}

// ============================================================
// 设备类型暂停面板 — orchestrator 在图推断类型与技师声明不一致时
// 发出 `pipeline_paused`（reason: needs_kind_confirmation）。
// 在 timeline 内注入内联确认面板；确认 POST 所选类型并启动新构建后重新订阅。
// 镜像抽屉 renderKindConfirm / confirmKind（web/js/pipeline_progress.js）。
// ============================================================

// 将 device_kind 代码解析为人类可读标签。空 / "unknown" / 未声明
// → 共享「non déclaré」串；否则 repair.device_kind.options.<k> 标签
//（landing 启动时 i18n 已加载全部模块），未命中则回退原始代码。
function _landingKindLabel(k) {
  const tFn = window.t || ((key) => key);
  if (!k || k === "unknown") return tFn("pipeline.kind.undeclared");
  const key = "repair.device_kind.options." + k;
  const label = tFn(key);
  return label === key ? k : label;
}

function renderLandingKindConfirm(ev) {
  // 幂等 — 丢弃先前暂停/恢复留下的面板。
  document.getElementById("landingKindPanel")?.remove();
  const timeline = document.getElementById("landingTimeline");
  if (!timeline) return;
  const tFn = window.t || ((k) => k);

  const conf = typeof ev.confidence === "number" ? Math.round(ev.confidence * 100) : null;
  const candidates = [];
  if (ev.graph_inferred) candidates.push({ k: ev.graph_inferred, recommended: true });
  if (ev.user_declared && ev.user_declared !== ev.graph_inferred) candidates.push({ k: ev.user_declared });
  // 既未推断也未声明 → 单个 "unknown" 单选，面板仍可确认
  //（POST "unknown"，pipeline 继续）。
  if (candidates.length === 0) candidates.push({ k: "unknown", recommended: true });

  const radios = candidates.map((c, i) => `
    <label class="landing-kind-opt">
      <input type="radio" name="landingKind" value="${_escapeHtml(c.k)}" ${i === 0 ? "checked" : ""}>
      <span>${_escapeHtml(_landingKindLabel(c.k))}${c.recommended ? ` <em>${_escapeHtml(tFn("pipeline.kind.recommended"))}</em>` : ""}</span>
    </label>`).join("");

  const panel = document.createElement("div");
  panel.className = "landing-kind-panel";
  panel.id = "landingKindPanel";
  panel.innerHTML = `
    <div class="landing-kind-row"><span data-i18n="pipeline.kind.declared">${_escapeHtml(tFn("pipeline.kind.declared"))}</span><b class="mono">${_escapeHtml(_landingKindLabel(ev.user_declared))}</b></div>
    <div class="landing-kind-row"><span data-i18n="pipeline.kind.detected">${_escapeHtml(tFn("pipeline.kind.detected"))}</span><b class="mono">${_escapeHtml(_landingKindLabel(ev.graph_inferred))}${conf !== null ? ` ${conf}%` : ""}</b></div>
    ${ev.evidence ? `<div class="landing-kind-evidence">${_escapeHtml(ev.evidence)}</div>` : ""}
    <div class="landing-kind-opts">${radios}</div>
    <button type="button" class="landing-kind-confirm" id="landingKindConfirm" data-i18n="pipeline.kind.confirm">${_escapeHtml(tFn("pipeline.kind.confirm"))}</button>`;

  // 追加在 #landingPhaseList 之后，面板位于 timeline 底部、阶段行下方。
  timeline.appendChild(panel);
  if (window.i18n && window.i18n.applyDom) window.i18n.applyDom(panel);

  document.getElementById("landingKindConfirm").addEventListener("click", () => {
    const chosen = panel.querySelector('input[name="landingKind"]:checked')?.value;
    if (chosen) confirmLandingKind(chosen);
  });
}

async function confirmLandingKind(deviceKind) {
  const t = window.t || ((k) => k);
  let ok = false;
  try {
    const res = await fetch(`/pipeline/packs/${encodeURIComponent(_activeSlug)}/confirm-kind`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_kind: deviceKind }),
    });
    ok = res.ok;
  } catch (_) { ok = false; }
  if (!ok) {
    // 4xx/5xx 或网络失败表示 pipeline 未恢复。显示错误并停止 —
    // 勿重新订阅到死 WS。
    setStatus(t("landing.status.ws_lost"), STATUS_ERROR);
    setLandingMascot("error");
    return;
  }
  document.getElementById("landingKindPanel")?.remove();
  setPhaseState("device_kind", "done");
  _landingPaused = false;
  // confirm-kind 启动的新构建 — 关闭旧 WS 并在同一 slug 上重新订阅以观看重跑。
  if (progressConn) { progressConn.close(); progressConn = null; }
  subscribeToProgress(_activeSlug, _activeRid);
}


function goToWorkspace(repairId, slug, vue = "graph") {
  // 将技师带到请求的 repair 视图 — 默认图视图（加载 graph + memory bank +
  // 经 openLLMPanelIfRepairParam 打开聊天），而非诊断仪表盘。
  // 仪表盘为 "diagnostic" 视图，经左侧栏进入。repairHash 将未知 vue 强制为 diagnostic。
  //
  // 先剥离 landing 遮罩，避免 hash 导航后遮罩仍盖在新视图上。
  hideLanding();
  // 关闭活跃 progress WS，避免导航后迟到事件（如重复 pipeline_finished）打到页面。
  if (progressConn) { progressConn.close(); progressConn = null; }

  seedSlugForRepair(repairId, slug);   // 已知 slug — 保持深层导航同步
  const target = new URL(location.origin + location.pathname);
  target.hash = repairHash(repairId, vue);

  // 强制真实导航。同 URL 的 location.href 为 no-op，仅 hash 变化不刷新 —
  // 任一情况都会使 landing 模块状态与 pipeline 后视图不一致。
  // 重复时 location.assign + reload 保证 main.js 干净启动。
  if (target.toString() === location.href) {
    location.reload();
  } else {
    location.assign(target.toString());
  }
}

// ============================================================
// 设备自动补全 — 技师输入时在设备输入框下展示已知设备。
// 数据来自 /pipeline/taxonomy，按 (brand, model) 去重为一条 —
// 无「iPhone X / iPhone X logic board / iPhone X bench」噪声。
// 会话内缓存在 `_devicesCache`。键盘：↑/↓/Enter/Esc。
//
// 选择时将所选 pack 的 canonical slug 存到表单，
// onSubmit 显式传 `device_slug`，保证命中正确 pack 而非重新 slug 化标签。
// ============================================================

let _devicesCache = null;
let _suggestActiveIdx = -1;
let _selectedDeviceSlug = null;
// picker 所选设备的 pack 完整性（✓ 徽章）。用于 free 锁
//（cloud_hints.packedOnly）：免费套餐仅对完整 pack 启动 — 纯 UI，服务端同样拒绝（402）。
let _selectedDeviceComplete = false;
let _schematicFile = null;

async function loadPacksForSuggest() {
  try {
    _devicesCache = await loadDevices();
  } catch (err) {
    console.warn("[landing] loadPacksForSuggest failed", err);
  }
}

function _matchDevices(query) {
  if (!_devicesCache || _devicesCache.length === 0) return [];
  const q = (query || "").trim().toLowerCase();
  if (q.length < 1) return [];
  return _devicesCache
    .filter((d) => {
      const label = (d.label || "").toLowerCase();
      const sub = (d.subtitle || "").toLowerCase();
      const slug = (d.slug || "").toLowerCase();
      // T9a：同时匹配 carnet 别名（板号 / Apple 型号 / EMC / 代号 / 营销名），
      // 使 "820-2533" 或 "A1286" 能找到 MacBook Pro 15 pack。
      const aliases = (d.aliases || []).join(" ").toLowerCase();
      // 同时匹配建议上显示的 version 行（Apple 型号 / 板号在此，
      // 如 "A1984" 找 iPhone XR）— 未登记 carnet 的 pack 别名为空。
      const version = (d.version || "").toLowerCase();
      return label.includes(q) || sub.includes(q) || slug.includes(q)
        || aliases.includes(q) || version.includes(q);
    })
    .slice(0, 6);
}

// 建议第二行：区分此确切板卡的标识 —
// 型号版本 / Apple 编号、板号（820-xxxx，若已知）、外形。
// 如 "A2172 / A2176 · logic board"。无区分信息时为空。
function _deviceIdLine(d) {
  const parts = [];
  const seen = new Set();
  const push = (v) => {
    const s = (v == null ? "" : String(v)).trim();
    if (!s) return;
    const k = s.toLowerCase();
    if (!seen.has(k)) { seen.add(k); parts.push(s); }
  };
  if (d.version) push(d.version);
  // carnet 别名中的板号，若 version 文本中尚未包含。
  const vtext = (d.version || "").toLowerCase();
  for (const a of (d.aliases || [])) {
    const m = String(a).match(/\b8\d{2}-\d{3,5}\b/);
    if (m && !vtext.includes(m[0].toLowerCase())) push(m[0]);
  }
  if (d.form_factor) push(d.form_factor);
  return parts.join(" · ");
}

function _renderSuggest(query) {
  const box = document.getElementById("landingSuggest");
  if (!box) return;
  const matches = _matchDevices(query);
  if (matches.length === 0) {
    box.hidden = true;
    box.innerHTML = "";
    _suggestActiveIdx = -1;
    return;
  }
  const tFn = window.t || ((k) => k);
  const draftLabel = tFn("landing.suggest.draft");
  box.innerHTML = matches.map((d, i) => {
    const safeLabel = _escapeHtml(d.label);
    const safeSub = d.subtitle ? _escapeHtml(d.subtitle) : "";
    const safeSlug = _escapeHtml(d.slug);
    const iconClass = d.complete ? "is-complete" : "is-partial";
    const iconText = d.complete ? "✓" : "•";
    // 就绪徽章（第一行右侧）：草稿标记（不完整 pack）、
    // 图徽章（已编译电气图时点亮）、设备类型简码（GPU / PORTABLE / …）。
    const draftBadge = d.complete ? "" : `<span class="landing-suggest-badge is-draft">${_escapeHtml(draftLabel)}</span>`;
    const graphBadge = `<span class="landing-suggest-badge${d.has_electrical_graph ? " is-on" : ""}" title="${_escapeHtml(tFn("landing.suggest.graph_title"))}">${_escapeHtml(tFn("landing.suggest.graph_label"))}</span>`;
    const kindBadge = (d.device_kind && d.device_kind !== "unknown")
      ? `<span class="landing-suggest-badge mono">${_escapeHtml(DEVICE_KIND_SHORT[d.device_kind] || d.device_kind)}</span>`
      : "";
    const idLine = _escapeHtml(_deviceIdLine(d));
    const brand = safeSub ? `<span class="landing-suggest-brand">${safeSub}</span>` : "";
    // data-label = 选择后填入输入框的短型号名（如 "iPhone 12"）。
    // 非 d.device_label（原始 registry 标签，如 "Apple iPhone 12 logic board"），
    // 后者会污染输入框的品牌 + 外形噪声。
    return `<div class="landing-suggest-item" role="option" `
      + `data-slug="${safeSlug}" data-label="${safeLabel}" data-index="${i}" `
      + `data-graph="${d.has_electrical_graph ? "1" : ""}" data-complete="${d.complete ? "1" : ""}">`
      + `<span class="landing-suggest-icon ${iconClass}" aria-hidden="true">${iconText}</span>`
      + `<div class="landing-suggest-body">`
      + `<div class="landing-suggest-line1">`
      + `<span class="landing-suggest-label">${safeLabel}</span>${brand}`
      + `<span class="landing-suggest-meta">${draftBadge}${graphBadge}${kindBadge}</span>`
      + `</div>`
      + (idLine ? `<div class="landing-suggest-ids">${idLine}</div>` : "")
      + `</div>`
      + `</div>`;
  }).join("");
  box.hidden = false;
  _suggestActiveIdx = -1;
}

// T9a：用相同 .landing-suggest-item 标记将消歧候选渲染到建议下拉，
// 现有 mousedown 处理器经 _selectSuggest 固定 device_slug，无需额外接线。
function _renderDisambiguation(candidates) {
  const box = document.getElementById("landingSuggest");
  if (!box || !Array.isArray(candidates) || candidates.length === 0) return;
  box.innerHTML = candidates.map((c, i) => {
    const f = c.facets || {};
    const label = (f.marketing && f.marketing[0]) || (f.board && f.board[0]) || c.device_slug;
    const detail = [f.board && f.board[0], c.family].filter(Boolean).join(" · ");
    return `<div class="landing-suggest-item" role="option" `
      + `data-slug="${_escapeHtml(c.device_slug)}" data-label="${_escapeHtml(label)}" data-index="${i}" data-graph="">`
      + `<span class="landing-suggest-icon is-partial" aria-hidden="true">•</span>`
      + `<span class="landing-suggest-label">${_escapeHtml(label)}</span>`
      + `<span class="landing-suggest-meta">${_escapeHtml(detail)}</span>`
      + `</div>`;
  }).join("");
  box.hidden = false;
  _suggestActiveIdx = -1;
}

function _setSuggestActive(idx) {
  const items = document.querySelectorAll(".landing-suggest-item");
  if (items.length === 0) return;
  const clamped = Math.max(0, Math.min(idx, items.length - 1));
  items.forEach((el, i) => el.classList.toggle("is-active", i === clamped));
  _suggestActiveIdx = clamped;
  items[clamped].scrollIntoView({ block: "nearest" });
}

function _selectSuggest(label, slug, hasGraph, isComplete) {
  const dev = document.getElementById("landingDevice");
  const sym = document.getElementById("landingSymptom");
  if (dev) dev.value = label;
  // 固定 canonical slug，onSubmit 向后端发送 device_slug
  //（跳过标签重新 slug 化，保证命中正确 pack — 防御近似拼写）。
  _selectedDeviceSlug = slug || null;
  _selectedDeviceComplete = !!isComplete;
  // 所选设备已有编译电气图时原理图在磁盘 — 无需附 PDF。否则恢复默认「附加」入口。
  const field = document.getElementById("landingSchematicField");
  const pick = document.getElementById("landingSchematicPick");
  const name = document.getElementById("landingSchematicName");
  if (field) {
    if (hasGraph) {
      field.classList.add("is-ingested");
      if (pick) pick.disabled = true;
      if (name) name.textContent = (window.t || ((k) => k))("landing.schematic.already_ingested");
      _schematicFile = null;
      const fi = document.getElementById("landingSchematic"); if (fi) fi.value = "";
    } else {
      field.classList.remove("is-ingested");
      if (pick) pick.disabled = false;
      if (name) name.textContent = "";
    }
  }
  _hideSuggest();
  renderKnowledgeIndicators();
  _updateFreeLock();
  if (sym) sym.focus();
}

function _hideSuggest() {
  const box = document.getElementById("landingSuggest");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
  _suggestActiveIdx = -1;
}

function _initSuggest() {
  const dev = document.getElementById("landingDevice");
  const box = document.getElementById("landingSuggest");
  if (!dev || !box) return;

  dev.addEventListener("input", () => {
    // 自由文本编辑使先前所选 slug 失效 — 技师可能改向其他（或未知）设备。
    // 同时恢复原理图附加入口：标签偏离后基于图的选取不再有效。
    _selectedDeviceSlug = null;
    _selectedDeviceComplete = false;
    resetSchematicField();
    _renderSuggest(dev.value);
    _updateFreeLock();
  });

  dev.addEventListener("focus", () => {
    if (dev.value && dev.value.length >= 1) _renderSuggest(dev.value);
  });

  dev.addEventListener("keydown", (ev) => {
    const items = document.querySelectorAll(".landing-suggest-item");
    if (items.length === 0) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      _setSuggestActive(_suggestActiveIdx < 0 ? 0 : _suggestActiveIdx + 1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      _setSuggestActive(_suggestActiveIdx <= 0 ? items.length - 1 : _suggestActiveIdx - 1);
    } else if (ev.key === "Enter" && _suggestActiveIdx >= 0) {
      // 仅当用户用方向键显式高亮建议时拦截 Enter，否则让表单自然提交。
      ev.preventDefault();
      const item = items[_suggestActiveIdx];
      if (item) _selectSuggest(item.dataset.label, item.dataset.slug, !!item.dataset.graph, !!item.dataset.complete);
    } else if (ev.key === "Escape") {
      _hideSuggest();
    }
  });

  // blur 时隐藏，短延迟以便建议上的点击（blur 后触发）先被处理。
  dev.addEventListener("blur", () => setTimeout(_hideSuggest, 150));

  box.addEventListener("mousedown", (ev) => {
    // 用 mousedown（非 click）以便在输入框 blur 之前触发。
    const item = ev.target.closest(".landing-suggest-item");
    if (item && item.dataset.label) {
      ev.preventDefault();
      _selectSuggest(item.dataset.label, item.dataset.slug, !!item.dataset.graph, !!item.dataset.complete);
    }
  });
}

// 将原理图上传入口恢复为默认「附加」状态
//（无 PDF、CTA 重新启用、未标记已摄入）。自由文本编辑使基于图的选取失效时调用 —
// 类型 <select> 不动，因其为独立的手动选择。
function resetSchematicField() {
  _schematicFile = null;
  const field = document.getElementById("landingSchematicField");
  if (field) field.classList.remove("is-ingested");
  const pick = document.getElementById("landingSchematicPick");
  if (pick) pick.disabled = false;
  const name = document.getElementById("landingSchematicName");
  if (name) name.textContent = "";
  const fi = document.getElementById("landingSchematic");
  if (fi) fi.value = "";
  renderKnowledgeIndicators();
}

// ─── 知识弹窗（可选设备上下文：板类型 + 原理图）───
// 板类型 <select> 与原理图选择器在此弹窗内，landing hero 保持简洁的设备+症状表单。
// 弹窗纯展示 — submit 仍读取实时 <select> 与 `_schematicFile`。
// hero 经触发按钮上的数量徽章与可移除摘要芯片反映已添加内容。
let _knowledgeLastFocus = null;

function openKnowledgeModal() {
  const backdrop = document.getElementById("landingKnowledgeBackdrop");
  if (!backdrop) return;
  _knowledgeLastFocus = document.activeElement;
  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => document.getElementById("landingDeviceKind")?.focus());
}

function closeKnowledgeModal() {
  const backdrop = document.getElementById("landingKnowledgeBackdrop");
  if (!backdrop || !backdrop.classList.contains("open")) return;
  backdrop.classList.remove("open");
  backdrop.setAttribute("aria-hidden", "true");
  if (_knowledgeLastFocus && typeof _knowledgeLastFocus.focus === "function") {
    _knowledgeLastFocus.focus();
  }
}

// 从当前控件状态重渲染 hero 知识指示器（数量徽章 + 摘要芯片）。
// 单一真相源：实时 <select> 与 `_schematicFile` — 无重复镜像状态。
function renderKnowledgeIndicators() {
  const select = document.getElementById("landingDeviceKind");
  const kind = select?.value || "";
  const kindLabel = kind ? (select.options[select.selectedIndex]?.textContent || kind) : "";
  const items = [];
  if (kind) items.push({ type: "kind", label: kindLabel });
  if (_schematicFile) items.push({ type: "schematic", label: _schematicFile.name });

  const badge = document.getElementById("landingKnowledgeBadge");
  if (badge) {
    badge.textContent = String(items.length);
    badge.hidden = items.length === 0;
  }
  const btn = document.getElementById("landingKnowledgeBtn");
  if (btn) btn.classList.toggle("has-knowledge", items.length > 0);

  const chips = document.getElementById("landingKnowledgeChips");
  if (chips) {
    chips.innerHTML = items.map((it) =>
      `<button type="button" class="landing-knowledge-chip" data-knowledge="${it.type}">`
      + `<span>${_escapeHtml(it.label)}</span>`
      + `<svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2" `
      + `fill="none" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`
      + `</button>`
    ).join("");
    chips.hidden = items.length === 0;
  }
}

function onKnowledgeChipClick(ev) {
  const chip = ev.target.closest(".landing-knowledge-chip");
  if (!chip) return;
  if (chip.dataset.knowledge === "kind") {
    const select = document.getElementById("landingDeviceKind");
    if (select) select.value = "";
  } else if (chip.dataset.knowledge === "schematic") {
    resetSchematicField();
  }
  renderKnowledgeIndicators();
}

// 将附加的原理图 PDF 经专用文档端点（kind=schematic_pdf）上传到设备 pack —
// canonical 摄入路径。cloud 前门经加密、租户隔离的上传专用存储路由，
// 原理图不会绕过租户隔离（附在 repair-create 上会）。尽力而为：失败仅记录，不抛入提交流程。
async function uploadSchematicForSlug(slug, file) {
  try {
    const fd = new FormData();
    fd.append("kind", "schematic_pdf");
    fd.append("file", file);
    const res = await fetch(`/pipeline/packs/${encodeURIComponent(slug)}/documents`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[landing] schematic upload failed: HTTP ${res.status} ${detail}`);
    }
  } catch (err) {
    console.warn("[landing] schematic upload error", err);
  }
}

export function initLanding() {
  const form = document.getElementById("landingForm");
  if (form) form.addEventListener("submit", onSubmit);
  // 免费套餐（托管模式）：不可分析新文件 → 完整隐藏「添加知识」入口：
  // 按钮、说明「?」、芯片行。服务端同样拒绝上传（402）。
  if (hideUploads()) {
    for (const id of ["landingKnowledgeBtn", "landingKnowledgeInfo", "landingKnowledgeChips"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
  }
  document.getElementById("landingSchematicPick")?.addEventListener("click", () => {
    document.getElementById("landingSchematic")?.click();
  });
  document.getElementById("landingSchematic")?.addEventListener("change", (e) => {
    _schematicFile = e.target.files?.[0] || null;
    const n = document.getElementById("landingSchematicName");
    if (n) n.textContent = _schematicFile ? _schematicFile.name : "";
    e.target.value = "";
    renderKnowledgeIndicators();
    renderPreflightSchematic();   // 与预检弹窗视图保持同步
  });
  // 预检弹窗：原理图选择与知识弹窗共用同一隐藏 file input（_schematicFile 单一真相源）。
  // 取消/确认门控实际启动；backdrop + Escape 与其他弹窗相同关闭。
  document.getElementById("landingPreflightSchematicPick")?.addEventListener("click", () => {
    document.getElementById("landingSchematic")?.click();
  });
  document.getElementById("landingPreflightCancel")?.addEventListener("click", closePreflightModal);
  document.getElementById("landingPreflightClose")?.addEventListener("click", closePreflightModal);
  document.getElementById("landingPreflightConfirm")?.addEventListener("click", confirmPreflight);
  const pfBackdrop = document.getElementById("landingPreflightBackdrop");
  if (pfBackdrop) {
    pfBackdrop.addEventListener("click", (ev) => {
      if (ev.target === pfBackdrop) closePreflightModal();
    });
  }
  // 知识弹窗：触发、关闭、板类型变更、芯片移除。
  // 首次点击说明「添加知识」用途再打开；之后直接进入。持久「?」可重开说明。
  document.getElementById("landingKnowledgeBtn")?.addEventListener("click", () => {
    let seen = true;
    try { seen = !!localStorage.getItem(KNOWLEDGE_INFO_FLAG); } catch { /* 隐私模式 */ }
    if (!seen) {
      try { localStorage.setItem(KNOWLEDGE_INFO_FLAG, "1"); } catch { /* 忽略 */ }
      openInfoModal("knowledge", { onClose: openKnowledgeModal });
    } else {
      openKnowledgeModal();
    }
  });
  document.getElementById("landingKnowledgeInfo")?.addEventListener("click", () => openInfoModal("knowledge"));
  document.getElementById("landingKnowledgeClose")?.addEventListener("click", closeKnowledgeModal);
  document.getElementById("landingKnowledgeDone")?.addEventListener("click", closeKnowledgeModal);
  const kBackdrop = document.getElementById("landingKnowledgeBackdrop");
  if (kBackdrop) {
    kBackdrop.addEventListener("click", (ev) => {
      if (ev.target === kBackdrop) closeKnowledgeModal();
    });
  }
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { closeKnowledgeModal(); closePreflightModal(); closeRepairsDrawer(); closeCatalogue(); }
  });
  // 移动端最近维修抽屉：从导航切换，经遮罩关闭。
  document.getElementById("landingRepairsToggle")?.addEventListener("click", () => {
    const open = document.getElementById("landing-overlay")?.classList.contains("sidebar-open");
    if (open) closeRepairsDrawer(); else openRepairsDrawer();
  });
  document.getElementById("landingSidebarBackdrop")?.addEventListener("click", closeRepairsDrawer);
  document.getElementById("landingDeviceKind")?.addEventListener("change", renderKnowledgeIndicators);
  const kChips = document.getElementById("landingKnowledgeChips");
  if (kChips) kChips.addEventListener("click", onKnowledgeChipClick);
  _initSuggest();
  renderKnowledgeIndicators();
  initCatalogue();
  initProfileMenu();
}
