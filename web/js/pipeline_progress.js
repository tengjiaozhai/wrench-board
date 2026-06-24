//  网页/js/pipeline_progress.js
//  管道进度drawer — 首页「新建修复」弹窗的另一条WS消费路径。
//
// 【完整流程中的位置】
//      与 landing/index.js 消耗 pipelineSocket.js connectProgress（第6步）
//      openPipelineProgress(repairResponse) — home.js 新建修复后调用
//      pipeline_started=false → 跳过drawer，直接跳转图
//      pipeline_started=true → subscribeProgress() → handlerEvent 更新 stepper
//
//  入口点：openPipelineProgress({repair_id, device_slug, device_label,
//  pipeline_started}）。当 pipeline_started=false 时，包已经存在
//  在磁盘上完成，因此我们立即跳过 drawer 和 redirect。

import { escapeHtml as escHtml } from "./shared/dom.js";
import { connectProgress, fetchPendingKind } from "./services/pipelineSocket.js";
import { repairHash, seedSlugForRepair } from "./router.js";

const PHASES = [
  {key: "scout",    labelKey: "pipeline.phase.scout.label",    subKey: "pipeline.phase.scout.sub"},
  {key: "registry", labelKey: "pipeline.phase.registry.label", subKey: "pipeline.phase.registry.sub"},
  {key: "writers",  labelKey: "pipeline.phase.writers.label",  subKey: "pipeline.phase.writers.sub"},
  {key: "audit",    labelKey: "pipeline.phase.audit.label",    subKey: "pipeline.phase.audit.sub"},
];

function _phaseLabel(key)  { return t(PHASES.find(p => p.key === key)?.labelKey || ""); }
function _phaseSub(key)    { return t(PHASES.find(p => p.key === key)?.subKey || ""); }

//  编排器仅在摄取 schematic 时发出动态阶段。
//  它们呈现为额外的 .pp-step 行，第一次添加在 Scout 之前
//  他们的 phase_started 到达了——所以 schematic 少的构建使 4 保持静态
//  步骤。按阶段名称键入以匹配 phase_started/phase_finished 有效负载。
const DYNAMIC_PHASES = {
  schematic_ingest: { label: "pipeline.phase.schematic_ingest.label", sub: "pipeline.phase.schematic_ingest.sub" },
  device_kind:      { label: "pipeline.phase.device_kind.label",      sub: "pipeline.phase.device_kind.sub" },
};

function ensureDynamicStep(phaseKey) {
  const meta = DYNAMIC_PHASES[phaseKey];
  if (!meta) return;
  const body = el("ppBody");
  if (!body || body.querySelector(`.pp-step[data-step="${phaseKey}"]`)) return;
  const step = document.createElement("div");
  step.className = "pp-step";
  step.dataset.step = phaseKey;
  step.innerHTML = `
    <div class="pp-step-mark" aria-hidden="true"></div>
    <div class="pp-step-lbl" data-i18n="${meta.label}">${escHtml(t(meta.label))}</div>
    <div class="pp-step-sub" data-i18n="${meta.sub}" data-role="sub">${escHtml(t(meta.sub))}</div>
    <div class="pp-step-time" data-role="time">${escHtml(t("pipeline.step.time_placeholder"))}</div>`;
  //  在第一个静态步骤（侦察）之前添加，以便进行摄取/分类
  //  首先阅读：模式 → 类型 → Scout → Registry → Writers → 审核。
  const firstStatic = body.querySelector('.pp-step[data-step="scout"]');
  body.insertBefore(step, firstStatic);
  if (window.i18n && window.i18n.applyDom) window.i18n.applyDom(step);
}

const STATE = {
  conn: null,
  slug: null,
  repairId: null,
  deviceLabel: null,
  done: false,
  failed: false,
  paused: false,
  redirectTimer: null,
};

function el(id) { return document.getElementById(id); }

function fmtElapsed(sec) {
  if (typeof sec !== "number" || !isFinite(sec)) return "…";
  if (sec < 1) return `${(sec * 1000).toFixed(0)} ms`;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function buildDrawer() {
  if (el("pipelineProgressDrawer")) return;
  const drawer = document.createElement("aside");
  drawer.className = "pp-drawer";
  drawer.id = "pipelineProgressDrawer";
  drawer.setAttribute("role", "status");
  drawer.setAttribute("aria-live", "polite");
  drawer.innerHTML = `
    <header class="pp-head">
      <span class="pp-dot" aria-hidden="true"></span>
      <div class="pp-title">
        <span class="lbl" data-i18n="pipeline.drawer.header_label">Building memory</span>
        <span class="name" id="ppDeviceLabel">…</span>
      </div>
      <button class="pp-close" id="ppClose"
              data-i18n-attr="aria-label:pipeline.drawer.close_aria"
              aria-label="Close progress panel" type="button">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </header>
    <div class="pp-body" id="ppBody">
      ${PHASES.map((p, i) => `
        <div class="pp-step" data-step="${p.key}" data-idx="${i}">
          <div class="pp-step-mark" aria-hidden="true"></div>
          <div class="pp-step-lbl" data-i18n="${p.labelKey}">${escHtml(_phaseLabel(p.key))}</div>
          <div class="pp-step-sub" data-i18n="${p.subKey}" data-role="sub">${escHtml(_phaseSub(p.key))}</div>
          <div class="pp-step-time" data-role="time">${escHtml(t("pipeline.step.time_placeholder"))}</div>
        </div>`).join("")}
    </div>
    <footer class="pp-foot">
      <div class="pp-status" id="ppStatus" data-i18n="pipeline.status.waiting">Waiting for first events…</div>
      <button class="pp-cta hidden" id="ppCta" type="button"></button>
    </footer>
  `;
  document.body.appendChild(drawer);
  if (window.i18n && window.i18n.applyDom) window.i18n.applyDom(drawer);

  el("ppClose").addEventListener("click", closeDrawer);
}

function openDrawer(deviceLabel) {
  buildDrawer();
  el("ppDeviceLabel").textContent = deviceLabel || t("pipeline.drawer.device_placeholder");
  setStatusKey("pipeline.status.connecting");
  el("ppCta").classList.add("hidden");
  el("ppCta").textContent = "";
  //  重置步骤状态。首先删除先前运行注入的动态步骤，以便
  //  新鲜的开放开始干净——当他们的phase_started到达时他们会重新注入
  //  再次 - 然后重置静态步骤。
  document.querySelectorAll("#pipelineProgressDrawer .pp-step").forEach(s => {
    if (s.dataset.step in DYNAMIC_PHASES) { s.remove(); return; }
    s.classList.remove("running", "done", "error");
    s.querySelector('[data-role="time"]').textContent = t("pipeline.step.time_placeholder");
    const sub = s.querySelector(".pp-step-sub");
    if (sub) {
      const phase = PHASES.find(p => p.key === s.dataset.step);
      if (phase) {
        sub.setAttribute("data-i18n", phase.subKey);
        sub.textContent = _phaseSub(s.dataset.step);
      }
    }
  });
  //  删除任何残留的错误面板
  document.getElementById("ppErrorDetail")?.remove();
  //  删除任何过时的设备类型确认面板（ppBody 中的普通 div，
  //  不是动态 .pp-step，因此它可以在上面的循环中幸存下来）。
  document.getElementById("ppKindPanel")?.remove();
  requestAnimationFrame(() => {
    el("pipelineProgressDrawer").classList.add("open");
  });
}

function closeDrawer() {
  const drawer = el("pipelineProgressDrawer");
  if (!drawer) return;
  drawer.classList.remove("open");
  if (STATE.conn) {
    STATE.conn.close(1000, "user-closed");
    STATE.conn = null;
  }
  if (STATE.redirectTimer) {
    clearTimeout(STATE.redirectTimer);
    STATE.redirectTimer = null;
  }
}

function setStepState(phaseKey, klass) {
  const step = document.querySelector(`#pipelineProgressDrawer .pp-step[data-step="${phaseKey}"]`);
  if (!step) return;
  step.classList.remove("running", "done", "error");
  if (klass) step.classList.add(klass);
}

function setStepTime(phaseKey, text) {
  const step = document.querySelector(`#pipelineProgressDrawer .pp-step[data-step="${phaseKey}"]`);
  if (!step) return;
  const cell = step.querySelector('[data-role="time"]');
  if (cell) cell.textContent = text;
}

function setStepCounts(phaseKey, counts) {
  if (!counts || typeof counts !== "object") return;
  const step = document.querySelector(`#pipelineProgressDrawer .pp-step[data-step="${phaseKey}"]`);
  if (!step) return;
  const sub = step.querySelector(".pp-step-sub");
  if (!sub) return;
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
  sub.textContent = parts.join(" · ");
}

//  setStatus 接受预先解析的 HTML 文本（对于插入 <b> 的路径）；
//  setStatusKey 接受 i18n 键 + 参数并在区域设置切换上重新解析。
function setStatus(text, klass) {
  const s = el("ppStatus");
  if (!s) return;
  s.removeAttribute("data-i18n");
  delete s.dataset.i18nKey;
  delete s.dataset.i18nParams;
  s.dataset.i18nHtml = "1";
  s.innerHTML = text;
  s.className = "pp-status" + (klass ? " " + klass : "");
}

function setStatusKey(key, params, klass) {
  const s = el("ppStatus");
  if (!s) return;
  s.dataset.i18nKey = key;
  s.dataset.i18nParams = params ? JSON.stringify(params) : "";
  s.dataset.i18nHtml = "1";
  s.removeAttribute("data-i18n");
  s.innerHTML = t(key, params);
  s.className = "pp-status" + (klass ? " " + klass : "");
}

function _refreshStatusOnLocaleChange() {
  const s = el("ppStatus");
  if (!s || !s.dataset.i18nKey) return;
  let params;
  try { params = s.dataset.i18nParams ? JSON.parse(s.dataset.i18nParams) : undefined; }
  catch (_) { params = undefined; }
  s.innerHTML = t(s.dataset.i18nKey, params);
}

if (window.i18n && window.i18n.onChange) {
  window.i18n.onChange(() => {
    _refreshStatusOnLocaleChange();
    //  重新翻译其文本遵循已知标记的动态步骤时间/子单元格。
    document.querySelectorAll("#pipelineProgressDrawer .pp-step").forEach(s => {
      const time = s.querySelector('[data-role="time"]');
      if (!time) return;
      //  静态占位符 → 重新本地化。随后是“正在运行...”/“失败”单元格，
      //  但当下一个事件发生时，运行状态会发生翻转，如此短暂
      //  定位漂移是可以容忍的。
      if (s.classList.contains("running")) time.textContent = t("pipeline.step.in_progress");
      else if (s.classList.contains("error")) time.textContent = t("pipeline.step.failed");
    });
  });
}

function showCta(label, iconPath, primary, onClick) {
  const btn = el("ppCta");
  if (!btn) return;
  btn.classList.remove("hidden");
  btn.classList.toggle("primary", !!primary);
  btn.innerHTML = `${iconPath ? `<svg class="icon icon-sm" viewBox="0 0 24 24">${iconPath}</svg>` : ""}${escHtml(label)}`;
  btn.onclick = onClick;
}

function showErrorDetail(msg) {
  if (!msg) return;
  document.getElementById("ppErrorDetail")?.remove();
  const div = document.createElement("div");
  div.className = "pp-error-detail";
  div.id = "ppErrorDetail";
  div.textContent = msg;
  el("ppBody").appendChild(div);
}

function handleEvent(ev) {
  //  Step 7（drawer路径）：消费进度WS事件，驱动右下角4步stepper
  switch (ev.type) {
    case "subscribed":
      //  Ack——管道可能已经启动。等待pipeline_started
      //  或第一个 phase_started 翻转 UI。
      break;

    case "queued": {
      //  构建并发时注意构建并发：位置可见，
      //  décroît à mesure que la file se vide ； pipeline_started prendra le relais。
      const position = ev.position || 1;
      const ahead = ev.ahead != null ? ev.ahead : Math.max(0, position - 1);
      setStatusKey("pipeline.status.queued", { position, ahead });
      break;
    }

    case "pipeline_started":
      setStatusKey("pipeline.status.started");
      break;

    case "phase_started":
      ensureDynamicStep(ev.phase);
      setStepState(ev.phase, "running");
      setStepTime(ev.phase, t("pipeline.step.in_progress"));
      setStatusKey("pipeline.status.phase_running", { phase: escHtml(ev.phase || "") });
      break;

    case "phase_finished":
      setStepState(ev.phase, "done");
      setStepTime(ev.phase, fmtElapsed(ev.elapsed_s));
      if (ev.counts) setStepCounts(ev.phase, ev.counts);
      break;

    case "pipeline_finished": {
      STATE.done = true;
      const score = typeof ev.consistency_score === "number"
        ? ev.consistency_score.toFixed(2) : "n/a";
      const status = ev.status || "APPROVED";
      setStatusKey("pipeline.status.ready", { status: escHtml(status), score }, "ok");
      showCta(
        t("pipeline.cta.view_memory_bank"),
        '<path d="M5 12h14M13 6l6 6-6 6"/>',
        true,
        () => redirectToMemoryBank(),
      );
      //  2 秒后自动重新direct，除非用户先单击“关闭”。
      STATE.redirectTimer = setTimeout(redirectToMemoryBank, 2000);
      break;
    }

    case "pipeline_failed": {
      STATE.failed = true;
      //  将当前运行的步骤绘制为错误。
      const running = document.querySelector("#pipelineProgressDrawer .pp-step.running");
      if (running) {
        running.classList.remove("running");
        running.classList.add("error");
        running.querySelector('[data-role="time"]').textContent = t("pipeline.step.failed");
      }
      const status = ev.status || "ERROR";
      setStatusKey("pipeline.status.failed", { status: escHtml(status) }, "err");
      if (ev.error) showErrorDetail(ev.error);
      showCta(t("pipeline.cta.close"), "", false, closeDrawer);
      break;
    }

    case "pipeline_paused":
      if (ev.reason === "needs_kind_confirmation") {
        STATE.paused = true;
        ensureDynamicStep("device_kind");
        setStepState("device_kind", "running");
        renderKindConfirm(ev);
      }
      break;

    default:
      //  未知事件类型——默默忽略；向前兼容。
      break;
  }
}

function redirectToMemoryBank() {
  if (!STATE.slug) return;
  if (STATE.redirectTimer) {
    clearTimeout(STATE.redirectTimer);
    STATE.redirectTimer = null;
  }
  closeDrawer();
  //  以 markdown（内存库）模式登陆修复的 graph vue。查看=md 生活
  //  在真实的查询字符串中（Decision A）。回落到全球名单——永远不会
  //  默默地 no-op — 如果没有捕获修复范围。
  if (STATE.repairId) {
    seedSlugForRepair(STATE.repairId, STATE.slug);
    window.location.href = `?view=md${repairHash(STATE.repairId, "graph")}`;
  } else {
    window.location.hash = "#home";
  }
}

function subscribeProgress() {
  //  Step 6：与 landing subscribeToProgress 相同 — connectProgress(STATE.slug)
  STATE.conn = connectProgress(STATE.slug, {
    onEvent: handleEvent,
    onError: () => setStatusKey("pipeline.status.lost_connection", null, "err"),
    onClose: () => {
      STATE.conn = null;
      //  暂停是有意停止（构建协程返回）——而不是
      //  失败。如果管道在之前没有到达终止事件
      //  关闭，标记它。
      if (!STATE.done && !STATE.failed && !STATE.paused) {
        setStatusKey("pipeline.status.closed_early", null, "err");
        showCta(t("pipeline.cta.close"), "", false, closeDrawer);
      }
    },
  });
}

/*  ---------- 暂停/设备类型确认 ----------  */

function _kindLabel(k) {
  if (!k) return t("pipeline.kind.undeclared");
  if (k === "unknown") return t("pipeline.kind.undeclared");
  const label = t("repair.device_kind.options." + k);
  //  t() 在未命中时返回原始密钥 → 回退到 slug 本身。
  return label === ("repair.device_kind.options." + k) ? k : label;
}

function renderKindConfirm(ev) {
  document.getElementById("ppKindPanel")?.remove();
  const step = document.querySelector('#pipelineProgressDrawer .pp-step[data-step="device_kind"]');
  if (step) step.classList.add("paused");
  const conf = typeof ev.confidence === "number" ? Math.round(ev.confidence * 100) : null;
  const candidates = [];
  if (ev.graph_inferred) candidates.push({ k: ev.graph_inferred, recommended: true });
  if (ev.user_declared && ev.user_declared !== ev.graph_inferred) candidates.push({ k: ev.user_declared });
  //  没有推断或声明的类型 → 退回到单个“未知”无线电，因此
  //  小组仍然有一个可行的选择（确认帖子“未知”，管道继续）。
  if (candidates.length === 0) candidates.push({ k: "unknown", recommended: true });
  const radios = candidates.map((c, i) => `
    <label class="pp-kind-opt">
      <input type="radio" name="ppKind" value="${escHtml(c.k)}" ${i === 0 ? "checked" : ""}>
      <span>${escHtml(_kindLabel(c.k))}${c.recommended ? ` <em>${escHtml(t("pipeline.kind.recommended"))}</em>` : ""}</span>
    </label>`).join("");
  const panel = document.createElement("div");
  panel.className = "pp-kind-panel";
  panel.id = "ppKindPanel";
  panel.innerHTML = `
    <div class="pp-kind-row"><span data-i18n="pipeline.kind.declared">Déclaré</span><b class="mono">${escHtml(_kindLabel(ev.user_declared))}</b></div>
    <div class="pp-kind-row"><span data-i18n="pipeline.kind.detected">Détecté</span><b class="mono">${escHtml(_kindLabel(ev.graph_inferred))}${conf !== null ? ` ${conf}%` : ""}</b></div>
    ${ev.evidence ? `<div class="pp-kind-evidence">${escHtml(ev.evidence)}</div>` : ""}
    <div class="pp-kind-opts">${radios}</div>
    <button type="button" class="pp-cta primary" id="ppKindConfirm" data-i18n="pipeline.kind.confirm">Confirmer et reprendre</button>`;
  el("ppBody").appendChild(panel);
  if (window.i18n && window.i18n.applyDom) window.i18n.applyDom(panel);
  document.getElementById("ppKindConfirm").addEventListener("click", () => {
    const chosen = panel.querySelector('input[name="ppKind"]:checked')?.value;
    if (chosen) confirmKind(chosen);
  });
}

async function confirmKind(deviceKind) {
  let ok = false;
  try {
    const res = await fetch(`/pipeline/packs/${encodeURIComponent(STATE.slug)}/confirm-kind`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_kind: deviceKind }),
    });
    ok = res.ok;
  } catch (_) { ok = false; }
  if (!ok) {
    //  4xx/5xx（或网络故障）意味着管道没有恢复 - 表面
    //  它并停止，而不是重新订阅到令人困惑的“提前关闭”。
    setStatusKey("pipeline.status.lost_connection", null, "err");
    showCta(t("pipeline.cta.close"), "", false, closeDrawer);
    return;
  }
  document.getElementById("ppKindPanel")?.remove();
  const step = document.querySelector('#pipelineProgressDrawer .pp-step[data-step="device_kind"]');
  if (step) { step.classList.remove("paused"); setStepState("device_kind", "done"); }
  setStepTime("device_kind", t("pipeline.kind.confirmed"));
  //  由confirm-kind开始的全新构建——观看在相同的slug上重新运行。
  STATE.paused = false; STATE.done = false; STATE.failed = false;
  if (STATE.conn) { STATE.conn.close(1000, "resubscribe"); STATE.conn = null; }
  subscribeProgress();
}

/*  ---------- 公共API ----------  */

export function openPipelineProgress(repairResponse) {
  if (!repairResponse || !repairResponse.device_slug) return;

  //  磁盘上的打包已完成 — 跳过 drawer 并打开修复的图表
  //  视图。与点击主页卡一致：用户登陆丰富的视觉效果
  //  包的表示，而不是只读数据转储。
  if (repairResponse.pipeline_started === false) {
    if (repairResponse.repair_id) {
      seedSlugForRepair(repairResponse.repair_id, repairResponse.device_slug);
      window.location.href = repairHash(repairResponse.repair_id, "graph");
    } else {
      window.location.hash = "#home";
    }
    return;
  }

  STATE.slug = repairResponse.device_slug;
  STATE.repairId = repairResponse.repair_id || null;
  STATE.deviceLabel = repairResponse.device_label || repairResponse.device_slug;
  STATE.done = false;
  STATE.failed = false;
  STATE.redirectTimer = null;

  openDrawer(STATE.deviceLabel);

  STATE.paused = false;
  subscribeProgress();

  //  如果先前的构建因某种分歧而被搁置（例如重新加载后），
  //  实时 pipeline_paused 事件消失了——从磁盘重建面板。
  fetchPendingKind(STATE.slug).then(pending => {
    if (pending) {
      handleEvent({
        type: "pipeline_paused", reason: "needs_kind_confirmation",
        device_slug: STATE.slug, user_declared: pending.user_declared,
        graph_inferred: pending.graph_inferred, confidence: pending.confidence,
        evidence: pending.evidence,
      });
    }
  });
}

export function initPipelineProgress() {
  //  面向未来的钩子 - 目前 drawer 在首次显示时是惰性构建的，
  //  所以在引导时没有什么可以连接的。与另一方保持对称
  //  init* 模块，因此 main.js 保持一致。
}
