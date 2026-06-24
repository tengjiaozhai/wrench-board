//  着陆管道 timeline — 技术人员观察的所述相带
//  而知识工厂构建了一个新的设备包（Phase D.8提取
//  来自landing/index.js）。 #landing时间轴上的纯 DOM 渲染 /
//  #landingPhaseList 标记：显示/隐藏、经过时间滚动条、每阶段
//  状态+旁白，动态schematic/设备类型行，以及干净的
//  运行之间的相行重置。
//
//  这里没有编排状态——index.js 拥有 WS 订阅，
//  设备类暂停面板，以及 `_landingPaused`；它从其驱动该模块
//  进度事件处理程序。 `window.t` (i18n.js) 在调用时读取，因此字符串
//  在语言环境切换上重新渲染； _escapeHtml 保护插入的标签键。

import { escapeHtml as _escapeHtml } from '../../../shared/dom.js';

//  固定的 5 阶段工厂管线，按渲染顺序排列。导出是因为
//  index.js 的进度处理程序 + 缓存-timeline 播放器迭代它。
export const PHASE_ORDER = ["scout", "registry", "mapper", "writers", "audit"];

//  仅当编排器发出动态阶段时才注入动态阶段（schematic
//  上传路径）。映射到其 i18n 标签键。不在 PHASE_ORDER 中 — 他们
//  根据 phase_started 事件的需求进行渲染。导出是因为index.js的
//  处理程序测试“LANDING_DYNAMIC_PHASES 中的阶段”。
export const LANDING_DYNAMIC_PHASES = {
  schematic_ingest: "landing.timeline.phase_schematic_ingest",
  device_kind: "landing.timeline.phase_device_kind",
};

//  飞行中运行的挂钟开始，用于显示经过时间。
let pipelineStartedAt = 0;
//  ETA 代码句柄 — 模块本地（是 window.__landingEtaTimer；删除了
//  D.8 中是全局的，因为 landing 是唯一的所有者）。一次一个间隔。
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
  list.insertBefore(li, scout);  //  空侦察→附加（安全）
}

export function setPhaseState(phase, state) {
  //  状态 ∈ “运行” | “完成”| “失败”
  const li = document.querySelector(`.landing-phase[data-phase="${phase}"]`);
  if (!li) return;
  li.hidden = false;  //  映射器开始隐藏，直到 phase_started 到达
  li.classList.remove("is-running", "is-done", "is-failed");
  if (state === "running") li.classList.add("is-running");
  if (state === "done") li.classList.add("is-done");
  if (state === "failed") li.classList.add("is-failed");
}

//  实时子步骤落地：刷新始终可见的紧凑线（最新
//  步骤）并附加到每阶段详细日志（由“详细信息”显示）
//  切换）。两者均由协调器的“phase_step”事件提供。 `文本`是
//  由调用者预先本地化（index.js PhaseStepText）。
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
  //  只有当该阶段有 ≥1 个子步骤时，细节切换才会获得其位置
  //  （注册表/映射器不发出任何信号，因此它们保持隐藏状态）。
  const btn = li.querySelector('[data-role="detail-toggle"]');
  if (btn) btn.hidden = false;
  li.classList.add("has-steps");
}

//  一个委托的点击侦听器处理每个阶段的“详细信息”切换（静态
//  + 动态注入的行）。幂等 — 由 dataset 标志守护，因此
//  重复的 showTimeline() 调用不会堆叠侦听器。
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
    //  保持 data-i18n 同步，以便区域设置开关重新呈现正确的标签。
    const key = open ? "landing.timeline.detail_hide" : "landing.timeline.detail";
    btn.setAttribute("data-i18n", key);
    btn.textContent = (window.t || ((k) => k))(key);
  });
}

export function setTimelineTitle(text) {
  const t = document.getElementById("landingTimelineTitle");
  if (t) t.textContent = text;
}

//  重置阶段 ROWS 以进行新运行：清除固定阶段的状态/叙述
//  （重新隐藏映射器）并删除任何动态注入的行。编排
//  状态（_landingPaused，设备类型面板）保留在index.js中，它调用
//  这来自它自己的resetTimeline() 包装器。
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
  //  删除所有动态注入的相行，以便新的运行开始干净。
  document.querySelectorAll('#landingPhaseList .landing-phase').forEach((li) => {
    if (li.dataset.phase in LANDING_DYNAMIC_PHASES) li.remove();
  });
}
