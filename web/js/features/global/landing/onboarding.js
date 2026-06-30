// 首轮引导 onboarding — 在 landing cockpit 上玩一次，可逃脱
// 步步。阻塞的欢迎modal将其交给mascot，which步行
// 技术人员通过：profile capture→产品概念→第一个diagnostic，
// re将hero区域划分为time。 “跳过”任何rere小牛肉hing
// ends 运行。
//
// 状态模型（参见规范 2026-06-01-onboarding-and-home-ux-design）：
//   - 脚本运行由 `wb_onboarding_seen` localStorage 标志控制，
//     并且仅触发 when profile 不完整或re are 0 repair。
//   - 坚持ent派生的推动（药丸脉冲，空sidebar）生活在其他re和
//     are 不是 this 模块的关注点。
//
// 揭示机制：#landing-overlay 上的 `.ob-running` 会使每个 [data-ob-reveal] 变暗
// 目标; orchestrator 每一步添加 `.is-revealed`。 finish() 滴
// `.ob-running` 因此 cockpit re 转换为 normal （完全可见）状态。

import { mountMascot } from "../../../mascot.js";
import { showBubble, hideBubble } from "../../../mascot_bubble.js";
import { t } from "../../../i18n.js";
import { apiGet, API_PREFIX } from "../../../shared/api.js";
import { hasSeenOnboarding, markOnboardingSeen } from "../../../onboarding_state.js";
import { forceNextDiagCoaching } from "../../repair/diagnostic/coaching.js";
import { openProfileWizard } from "./profile_modal.js";
import { hideUploads } from "../../../cloud_hints.js";

const FLAG = "wb_onboarding_seen";
const EXAMPLE_REPAIR_ID = "example-mnt-reform";

let _ctl = {};      // { 设置吉祥物状态 }
let _env = null;    // 缓存 profile en信封
let _host = null;   // 注入modal/面板host

function _overlay() { return document.getElementById("landing-overlay"); }
function _mascotState(s) { if (typeof _ctl.setMascotState === "function") _ctl.setMascotState(s); }

function _reveal(selector) {
  document.querySelectorAll(selector).forEach((el) => el.classList.add("is-revealed"));
}

function _ensureHost() {
  if (_host && document.body.contains(_host)) return _host;
  _host = document.createElement("div");
  _host.className = "ob-host";
  document.body.appendChild(_host);
  return _host;
}

function _clearHost() {
  if (_host) { _host.remove(); _host = null; }
}

// 同步pre门：使landing的第一个油漆变暗herofr，所以
// 第一次运行永远不会在re上演的re小牛肉之前闪烁完整的cockpit。便宜的
// localStorage 仅检查； async MaybeStartOnboarding() 决定real
// 如果结果不运行则取消大门。
export function preGateOnboarding() {
  if (localStorage.getItem(FLAG)) return;
  _overlay()?.classList.add("ob-running");
}

export async function maybeStartOnboarding(ctl) {
  _ctl = ctl || {};
  // 始终先 load profile + repair：profile 门独立于
  // 游览标志（缺少名称必须在 re 旋转装置上提示 even / 在
  // 游览被跳过），所以我们不能提前-re打开`onboarding_seen`他re。
  let repairsCount = 0;
  try {
    const res = await fetch(API_PREFIX + "/pipeline/repairs");
    if (res.ok) {
      const j = await res.json();
      repairsCount = Array.isArray(j) ? j.length : 0;
    }
  } catch (err) {
    console.warn("[onboarding] repairs count failed", err);
  }
  try {
    _env = await apiGet("/profile");
  } catch (err) {
    console.warn("[onboarding] profile load failed", err);
    _env = null;
  }

  const incomplete = !_env?.profile?.identity?.name;

  // ── 一号门：必填profile（语言优先，名字required）────────────
  // 服务器持久化 + tenant-scoped (PUT /profile/*)，因此一旦设置了名称
  // 它永远不会在 re 连接时提示 re。无法通过re融合游览来逃脱。
  if (incomplete) {
    _overlay()?.classList.add("ob-running");
    _mascotState("scanning");
    document.getElementById("landingProfile")?.classList.add("ob-spotlight");
    openProfileWizard(_env, {
      mandatory: true,
      onComplete: () => {
        document.getElementById("landingProfile")?.classList.remove("ob-spotlight");
        _mascotState("success");
        _maybeOfferTour(repairsCount);
      },
    });
    return;
  }

  // 简介已完成re→ 考虑可选的游览。
  _maybeOfferTour(repairsCount);
}

// ── 门2：可选导览（一次性，服务器支持onboarding_seen）──
function _maybeOfferTour(repairsCount) {
  if (hasSeenOnboarding("onboarding_seen") || repairsCount > 0) {
    // 不可hing 游览 — 撤消 pre 门并保留 cockpit。
    _overlay()?.classList.remove("ob-running");
    return;
  }
  _overlay()?.classList.add("ob-running");
  _mascotState("scanning");
  _stepWelcome();
}

// ── 游览第1步：提供modal（阻塞）—re可熔────────────────────────
// 语言和 profile are already 由 Gate 1 处理，因此 this 通常是re
// “想要快速浏览一下吗？”迅速的; re熔断ends 运行（并将其标记为en）。
function _stepWelcome() {
  const host = _ensureHost();
  host.innerHTML = `
    <div class="ob-backdrop" id="obBackdrop">
      <div class="ob-modal" role="dialog" aria-modal="true" aria-labelledby="obWelcomeTitle">
        <div class="ob-modal-mascot" id="obWelcomeMascot" aria-hidden="true"></div>
        <span class="ob-kicker">${t("onboarding.welcome.kicker")}</span>
        <h2 class="ob-title" id="obWelcomeTitle">${t("onboarding.welcome.title")}</h2>
        <p class="ob-body">${t("onboarding.welcome.body")}</p>
        <div class="ob-actions">
          <button type="button" class="ob-btn ob-btn-ghost" id="obWelcomeSkip">${t("onboarding.welcome.skip")}</button>
          <button type="button" class="ob-btn ob-btn-primary" id="obWelcomeCta">${t("onboarding.welcome.cta")}</button>
        </div>
      </div>
    </div>`;
  mountMascot(host.querySelector("#obWelcomeMascot"), { size: "md", state: "idle" });
  host.querySelector("#obWelcomeSkip").addEventListener("click", finish);
  host.querySelector("#obWelcomeCta").addEventListener("click", () => {
    _clearHost();
    _stepConcept();
  });
}

// ── 第三步：产品概念────────────────────────────────────────────────
// 一张centred卡（不是指针bubble）：这个概念是一个general statement，所以
// bubble锚定red到hero标题en覆盖副标题/表格。
function _stepConcept() {
  hideBubble();
  _mascotState("idle");
  const host = _ensureHost();
  host.innerHTML = `
    <div class="ob-backdrop" id="obBackdrop">
      <div class="ob-modal ob-modal--concept" role="dialog" aria-modal="true">
        <div class="ob-modal-mascot" id="obConceptMascot" aria-hidden="true"></div>
        <p class="ob-body">${t("onboarding.concept.bubble")}</p>
        <div class="ob-actions">
          <button type="button" class="ob-btn ob-btn-ghost" id="obConceptSkip">${t("onboarding.skip")}</button>
          <button type="button" class="ob-btn ob-btn-primary" id="obConceptNext">${t("onboarding.next")}</button>
        </div>
      </div>
    </div>`;
  mountMascot(host.querySelector("#obConceptMascot"), { size: "sm", state: "idle" });
  host.querySelector("#obConceptSkip").addEventListener("click", finish);
  host.querySelector("#obConceptNext").addEventListener("click", () => {
    _clearHost();
    _stepExampleIntro();
  });
}

// ── 步骤3.5：在re用户自己的第一个诊断之前提供一个real示例────────
// Openshipped MNT 改革装置； workspacecoaching巡演演奏re
// （完整选项卡），then 通过 onDone → “现在轮到你了”指针返回 here。
function _stepExampleIntro() {
  hideBubble();
  _mascotState("idle");
  const host = _ensureHost();
  host.innerHTML = `
    <div class="ob-backdrop" id="obBackdrop">
      <div class="ob-modal ob-modal--concept" role="dialog" aria-modal="true">
        <div class="ob-modal-mascot" id="obExampleMascot" aria-hidden="true"></div>
        <p class="ob-body">${t("onboarding.example.bubble")}</p>
        <div class="ob-actions">
          <button type="button" class="ob-btn ob-btn-ghost" id="obExampleSkip">${t("onboarding.skip")}</button>
          <button type="button" class="ob-btn ob-btn-primary" id="obExampleCta">${t("onboarding.example.cta")}</button>
        </div>
      </div>
    </div>`;
  mountMascot(host.querySelector("#obExampleMascot"), { size: "sm", state: "idle" });
  host.querySelector("#obExampleSkip").addEventListener("click", () => { _clearHost(); _afterExample(); });
  host.querySelector("#obExampleCta").addEventListener("click", () => { _clearHost(); _openExample(); });
}

function _openExample() {
  // Ensure workspace 巡演将为一位ready 看过的技术人员播放 even：
  // 一次性绕过持久的“first_diag_seen”标志（服务器真相
  // 现在，我们不能只清除 localStorage 键来强制 replay）。
  forceNextDiagCoaching();
  // 当en workspace 巡演结束时（dashboard.js 将 this 作为 onDone 转发），
  // return to the landing and resume the user's own first-diag pointers.
  window.__wbExampleTourOnDone = () => { window.__wbExampleTourOnDone = null; _returnFromExample(); };
  // 导航到示例 workspace； dashboard.jsfire是 render 上的旅行。
  window.location.hash = `#repair/${EXAMPLE_REPAIR_ID}/diagnostic`;
}

function _returnFromExample() {
  // 回到landingcockpit、enre与用户自己的第一个诊断相一致。
  // hashchange→showLanding render是async，因此轮询设备input
  // （resumed 指针需要的锚点）而不是猜测固定延迟。
  window.location.hash = "#landing";
  let tries = 30; // 100 毫秒时 ~3 秒上限
  const resume = () => {
    if (document.getElementById("landingDevice") || tries-- <= 0) {
      _overlay()?.classList.add("ob-running");
      _afterExample();
      return;
    }
    setTimeout(resume, 100);
  };
  setTimeout(resume, 80);
}

function _afterExample() {
  _reveal('[data-ob-reveal].landing-title, [data-ob-reveal].landing-sub');
  _stepDevice();
}

// ── 第四步：首先diagnostic（设备→symptom→发射）──────────────────
function _stepDevice() {
  _reveal('.landing-input-wrap[data-ob-reveal]');
  showBubble({
    anchor: document.getElementById("landingDevice"),
    placement: "bottom",
    text: t("onboarding.firstdiag.bubble_device"),
    next: _stepSymptom,
    skip: finish,
  });
}

function _stepSymptom() {
  _reveal('#landingSymptom[data-ob-reveal]');
  showBubble({
    anchor: document.getElementById("landingSymptom"),
    placement: "bottom",
    text: t("onboarding.firstdiag.bubble_symptom"),
    next: _stepLaunch,
    skip: finish,
  });
}

function _stepLaunch() {
  _reveal('.landing-actions[data-ob-reveal]');
  showBubble({
    anchor: document.getElementById("landingSubmit"),
    placement: "top",
    text: t("onboarding.firstdiag.bubble_launch"),
    next: _stepKnowledge,
    skip: finish,
  });
}

// ── 步骤5：feature mentions（添加知识+库存）──────────────────────
// 仅短指针；详细解释位于 on-click 信息中
// modal (info_modal.js), re可通过“?”连接任意time可供性。
function _stepKnowledge() {
  // 计划free（托管模式，cloud_hints）：“添加知识”隐藏 —
  // 不要将气泡锚定在不可见元素上，将en链锚定在stock上。
  if (hideUploads()) return _stepStock();
  showBubble({
    anchor: document.getElementById("landingKnowledgeBtn"),
    placement: "top",
    text: t("onboarding.tour.knowledge"),
    next: _stepStock,
    skip: finish,
  });
}

function _stepStock() {
  showBubble({
    anchor: document.getElementById("landingStockLink"),
    placement: "bottom",
    text: t("onboarding.tour.stock"),
    next: finish,
    nextLabel: t("onboarding.done"),
    skip: finish,
  });
}

// ── 结束：落下大门，标记seen ────────────────────────────────────────
export function finish() {
  hideBubble();
  _clearHost();
  document.getElementById("landingProfile")?.classList.remove("ob-spotlight");
  _overlay()?.classList.remove("ob-running");
  markOnboardingSeen("onboarding_seen"); // 服务器（cross-设备）+localStorage缓存
  _mascotState("idle");
}

// ── 手册replay：sidebar「游览」按钮────────────────────────
// 绕过 profile 门和 repairs 计数门 — 该按钮仅
// 在landingcockpit上可见，因此profile是already集。跳跃
// 直接迎接欢迎modal。
export function replayOnboarding(ctl) {
  _ctl = ctl || {};
  _overlay()?.classList.add("ob-running");
  _mascotState("scanning");
  _stepWelcome();
}
