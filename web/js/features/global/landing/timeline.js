// 着陆 pipeline timeline — 技术人员监视的 narrated 相带
// while knowledge factory 构建fresh 设备包 (Phase D.8 extraction
// fromlanding/index.js）。 Pure DOM ren在#landing时间轴上排序 /
// #landingPhaseList 标记：show/hide，已过的time 股票代码，每阶段
// 状态+旁白，动态schematic/设备类型行，以及干净的
// reen 运行之间的阶段行集。
//
// 无编排状态 here — index.js 拥有 WS 订阅，
// 设备类暂停面板，以及 `_landingPaused`；它驱动 this 模块 from
// progress-event 处理程序。 `window.t` (i18n.js) 是 read 在调用 time 所以字符串
// re-render位于locale开关上； _escapeHtml 保护插入的标签键。

import { escapeHtml as _escapeHtml } from '../../../shared/dom.js';

// 固定 5 相工厂pipeline，按en顺序排列。导出是因为
// index.js 的 progress 处理程序 + 缓存-timeline 播放器迭代它。
export const PHASE_ORDER = ["scout", "registry", "mapper", "writers", "audit"];

// 动态相仅注入 when orchestrator emit（schematic
// 向上load路径）。 Map跳转到他们的i18n标签键。不在 PHASE_ORDER 中 — 他们
// are rendered 按需from phase_started events。导出是因为index.js的
// 处理程序测试“LANDING_DYNAMIC_PHASES 中的阶段”。
export const LANDING_DYNAMIC_PHASES = {
  schematic_ingest: "landing.timeline.phase_schematic_ingest",
  device_kind: "landing.timeline.phase_device_kind",
};

// 飞行中运行的挂钟开始，显示已过去的time 股票代码。
let pipelineStartedAt = 0;
// ETA 股票代码句柄 — 模块本地（原为 window.__landingEtaTimer；删除了
// D.8 中是全局的，因为 landing 是唯一的所有者）。 time 处有一个间隔。
let _etaTimer = null;

export function showTimeline() {
  const tl = document.getElementById("landingTimeline");
  if (tl) tl.hidden = false;
  initTimelineToggles();
  pipelineStartedAt = Date.now();
  startEtaTicker();
}

function startEtaTicker() {
  const eta = document.getElementById("landingTimelineEta");
  if (!eta) return;
  if (_etaTimer) clearInterval(_etaTimer);
  const t = window.t || ((k) => k);
  const tick = () => {
    const elapsed = Math.max(0, (Date.now() - pipelineStartedAt) / 1000);
    eta.textContent = t("landing.timeline.elapsed", { n: elapsed.toFixed(0) });
  };
  tick();
  _etaTimer = setInterval(tick, 250);
}

export function stopEtaTicker() {
  if (_etaTimer) {
    clearInterval(_etaTimer);
    _etaTimer = null;
  }
}

export function ensureLandingPhase(phaseKey) {
  const labelKey = LANDING_DYNAMIC_PHASES[phaseKey];
  if (!labelKey) return;
  const list = document.getElementById("landingPhaseList");
  if (!list || list.querySelector(`.landing-phase[data-phase="${phaseKey}"]`)) return;
  const tFn = window.t || ((k) => k);
  const li = document.createElement("li");
  li.className = "landing-phase";
  li.dataset.phase = phaseKey;
  li.innerHTML =
    `<span class="landing-phase-dot"></span>` +
    `<div class="landing-phase-head">` +
      `<span class="landing-phase-label" data-i18n="${labelKey}">${_escapeHtml(tFn(labelKey))}</span>` +
      `<span class="landing-phase-live" data-role="live"></span>` +
      `<button type="button" class="landing-phase-detail" data-role="detail-toggle" data-i18n="landing.timeline.detail" aria-expanded="false" hidden>${_escapeHtml(tFn("landing.timeline.detail"))}</button>` +
    `</div>` +
    `<ul class="landing-phase-log" data-role="log" hidden></ul>`;
  const scout = list.querySelector('.landing-phase[data-phase="scout"]');
  list.insertBefore(li, scout);  // null 侦察 → 应用ended（安全）
}

export function setPhaseState(phase, state) {
  // 状态 ∈ “运行” | “完成”| “失败的”
  const li = document.querySelector(`.landing-phase[data-phase="${phase}"]`);
  if (!li) return;
  li.hidden = false;  // 映射器启动 hidden 直到 phase_started 到达
  li.classList.remove("is-running", "is-done", "is-failed");
  if (state === "running") li.classList.add("is-running");
  if (state === "done") li.classList.add("is-done");
  if (state === "failed") li.classList.add("is-failed");
}

// 实时子步骤落地：refresh 始终可见的紧凑线（最新
// 步骤）和 append 到每阶段详细日志（revealed 由“详细信息”
// 切换）。两者均由 orchestrator 的 `phase_step` events 提供。 `文本`是
// pre-由调用者本地化（index.js PhaseStepText）。
export function setPhaseStep(phase, text) {
  const li = document.querySelector(`.landing-phase[data-phase="${phase}"]`);
  if (!li) return;
  const live = li.querySelector('[data-role="live"]');
  if (live) live.textContent = text;
  const log = li.querySelector('[data-role="log"]');
  if (log) {
    const item = document.createElement("li");
    item.textContent = text;
    log.appendChild(item);
  }
  // 只有当该阶段有 ≥1 个子步骤时，细节切换才会获得其位置
  // （registry/映射器emit没有，所以他们的保持hidden）。
  const btn = li.querySelector('[data-role="detail-toggle"]');
  if (btn) btn.hidden = false;
  li.classList.add("has-steps");
}

// 一个委托的click列表ener处理每个阶段的“详细信息”切换（静态
// + 动态注入的行）。 Idempotent — 由 dataset 标志守护，因此
// re重复的 showTimeline() 调用不会堆叠列表eners。
export function initTimelineToggles() {
  const list = document.getElementById("landingPhaseList");
  if (!list || list.dataset.toggleWired) return;
  list.dataset.toggleWired = "1";
  list.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-role="detail-toggle"]');
    if (!btn) return;
    const li = btn.closest(".landing-phase");
    const log = li && li.querySelector('[data-role="log"]');
    if (!log) return;
    const open = li.classList.toggle("is-open");
    log.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    // 保持 data-i18n 同步，以便 locale 开关 re-ren 获得正确的标签。
    const key = open ? "landing.timeline.detail_hide" : "landing.timeline.detail";
    btn.setAttribute("data-i18n", key);
    btn.textContent = (window.t || ((k) => k))(key);
  });
}

export function setTimelineTitle(text) {
  const t = document.getElementById("landingTimelineTitle");
  if (t) t.textContent = text;
}

// Error 500 (Server Error)!!1500.That’s an error.There was an error. Please try again later.That’s all we know.
// (re-hiding mapper) and drop any dynamically-injected rows. Orchestration
// 状态（_landingPaused，设备类型面板）保留在index.js中，which调用
// this fr来自它自己的resetTimeline() 包装器。
export function resetTimelineRows() {
  PHASE_ORDER.forEach((p) => {
    const li = document.querySelector(`.landing-phase[data-phase="${p}"]`);
    if (!li) return;
    li.classList.remove("is-running", "is-done", "is-failed", "has-steps", "is-open");
    if (p === "mapper") li.hidden = true;
    const live = li.querySelector('[data-role="live"]');
    if (live) live.textContent = "";
    const log = li.querySelector('[data-role="log"]');
    if (log) { log.innerHTML = ""; log.hidden = true; }
    const btn = li.querySelector('[data-role="detail-toggle"]');
    if (btn) {
      btn.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("data-i18n", "landing.timeline.detail");
      btn.textContent = (window.t || ((k) => k))("landing.timeline.detail");
    }
  });
  // 删除所有动态注入的相行，以便 fresh 运行开始干净。
  document.querySelectorAll('#landingPhaseList .landing-phase').forEach((li) => {
    if (li.dataset.phase in LANDING_DYNAMIC_PHASES) li.remove();
  });
}
