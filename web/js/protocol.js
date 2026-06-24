//  网页/js/protocol.js
//  diagnostic协议面的中央状态+DOM协调。
//  接收llm.js转发的WS事件，拥有协议对象
//  内存，分派到三个渲染模块（向导/浮动/
//  inline）通过 getProtocol() 读取状态并在更改时重新渲染。

import { escapeHtml as escapeHtmlLocal } from "./shared/dom.js";

const state = {
  proto: null,           //  {protocol_id、title、steps：[…]、current_step_id、…} 或 null
  send: null,            //  (payload) => void — 由 main.js 设置
  hasBoard: false,
};

//  一些代理 (Haiku) 在工具参数 JSON 字符串中双重转义 Unicode，
//  因此标题以“D11 éteinte — isoler”形式出现，而不是
//  `D11 éteinte — 隔离器`。 Pydantic 模式在以下位置解码新协议
//  边界；这个客户端助手涵盖了以下协议
//  在该修复发布之前一直存在，现在在 WS 上重播。
const _UNICODE_ESCAPE_RE = /\\u([0-9a-fA-F]{4})/g;
function decodeEscapes(value) {
  if (typeof value !== "string" || value.indexOf("\\u") < 0) return value;
  return value.replace(_UNICODE_ESCAPE_RE, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}
function cleanStep(s) {
  if (!s || typeof s !== "object") return s;
  return {
    ...s,
    instruction: decodeEscapes(s.instruction),
    rationale: decodeEscapes(s.rationale),
  };
}

const subscribers = new Set();

function notify() { subscribers.forEach((cb) => cb(state.proto)); }

export function init({ send, hasBoard }) {
  state.send = send;
  state.hasBoard = !!hasBoard;
  notify();
}

export function setHasBoard(value) {
  state.hasBoard = !!value;
  notify();
}

export function subscribe(cb) {
  subscribers.add(cb);
  cb(state.proto);
  return () => subscribers.delete(cb);
}

export function getProtocol() { return state.proto; }
export function hasBoard() { return state.hasBoard; }

export function applyEvent(ev) {
  if (!ev || typeof ev !== "object") return;
  switch (ev.type) {
    case "protocol_proposed":
      state.proto = {
        protocol_id: ev.protocol_id,
        title: decodeEscapes(ev.title),
        rationale: decodeEscapes(ev.rationale),
        steps: (ev.steps || []).map(cleanStep),
        current_step_id: ev.current_step_id,
        history: [],
      };
      break;
    case "protocol_updated":
      if (!state.proto || state.proto.protocol_id !== ev.protocol_id) break;
      //  Abandon (or any terminal status) clears the quest panel entirely
      //  — same effect as protocol_completed. Without this, the panel stays
      //  pinned in an empty/zombie state because state.proto is still
      //  truthy and renderQuest only hides on null.
      if (ev.action === "abandoned" || ev.status === "abandoned"
          || ev.status === "completed") {
        state.proto = null;
        break;
      }
      state.proto.steps = ev.steps ? ev.steps.map(cleanStep) : state.proto.steps;
      state.proto.current_step_id = ev.current_step_id;
      if (Array.isArray(ev.history_tail)) {
        state.proto.history = state.proto.history.concat(ev.history_tail);
      }
      break;
    case "protocol_completed":
      state.proto = null;
      break;
    case "protocol_cleared":
      //  Emitted by the runtime at WS-open when the resolved conv has no
      //  active protocol. Without this, switching from a conv with a
      //  running wizard to a fresh conv left the previous wizard pinned
      //  on screen because no `protocol_proposed` arrives to overwrite
      //  state.proto and silence ≠ "no protocol here".
      state.proto = null;
      break;
    case "protocol_pending_confirmation":
      //  Pattern 4 round-trip: the agent called bv_propose_protocol but the
      //  runtime parked the call until the tech accepts or rejects via the
      //  modal. No state.proto change yet — only on accept will the tool
      //  调度和真正的“协议提议”到达。
      showConfirmation(ev);
      return;
    case "protocol_confirmation_timeout":
      //  后端放弃等待——放弃模式，这样技术就不会出现
      //  点击进入虚空。
      hideConfirmation(ev.tool_use_id);
      return;
    default:
      return;
  }
  notify();
}

//  --- Pattern 4 确认模式 --------------------------------------------------------
//  由 web/index.html (#protocolConfirmBackdrop) 中的静态标记支持。
//  在第一次显示时延迟连接，以便页面可以在没有模式面板的情况下启动
//  在 DOM 中（例如测试工具、无头预览）。

let _confirmWired = false;
let _activeConfirmId = null;

function _wireConfirmModal() {
  if (_confirmWired) return;
  const backdrop = document.getElementById("protocolConfirmBackdrop");
  if (!backdrop) return;
  const acceptBtn = document.getElementById("protocolConfirmAccept");
  const rejectBtn = document.getElementById("protocolConfirmReject");
  const rejectField = document.getElementById("protocolConfirmRejectField");
  const reasonInput = document.getElementById("protocolConfirmReason");

  //  第一次单击拒绝者会展开原因文本区域 - 第二次单击会发送。
  //  比单独的“细节”步骤更少摩擦，同时仍然让
  //  技术人员通过点击拒绝者两次来发送一键拒绝。
  let _rejectArmed = false;

  function _resetRejectArm() {
    _rejectArmed = false;
    if (rejectField) rejectField.hidden = true;
    if (rejectBtn) rejectBtn.textContent = "Refuser";
  }

  acceptBtn?.addEventListener("click", () => {
    const tid = _activeConfirmId;
    if (!tid || !state.send) return;
    state.send({
      type: "client.protocol_confirmation",
      tool_use_id: tid,
      decision: "accept",
    });
    hideConfirmation(tid);
  });

  rejectBtn?.addEventListener("click", () => {
    const tid = _activeConfirmId;
    if (!tid || !state.send) return;
    if (!_rejectArmed) {
      _rejectArmed = true;
      if (rejectField) rejectField.hidden = false;
      if (rejectBtn) rejectBtn.textContent = "Confirmer le refus";
      reasonInput?.focus();
      return;
    }
    const reason = (reasonInput?.value || "").trim();
    state.send({
      type: "client.protocol_confirmation",
      tool_use_id: tid,
      decision: "reject",
      reason,
    });
    hideConfirmation(tid);
  });

  //  每次打开时重新设置拒绝按钮，这样之前的拒绝就不会出现
  //  将其扩展的文本区域状态泄漏到下一个提案中。
  backdrop.addEventListener("transitionend", (ev) => {
    if (ev.target === backdrop && !backdrop.classList.contains("open")) {
      _resetRejectArm();
      if (reasonInput) reasonInput.value = "";
    }
  });

  _confirmWired = true;
}

function _renderStep(step, idx) {
  const li = document.createElement("li");
  const num = document.createElement("span");
  num.className = "step-num";
  num.textContent = `${idx + 1}.`;
  li.appendChild(num);

  const instr = document.createElement("span");
  instr.className = "step-instr";

  if (step.type) {
    const t = document.createElement("span");
    t.className = "step-type";
    t.textContent = step.type;
    instr.appendChild(t);
  }
  const target = step.target || step.test_point;
  if (target) {
    const tg = document.createElement("span");
    tg.className = "step-target";
    tg.textContent = target;
    instr.appendChild(tg);
  }
  const text = document.createTextNode(decodeEscapes(step.instruction || ""));
  instr.appendChild(text);
  li.appendChild(instr);
  return li;
}

export function showConfirmation(ev) {
  _wireConfirmModal();
  const backdrop = document.getElementById("protocolConfirmBackdrop");
  if (!backdrop) return;
  _activeConfirmId = ev.tool_use_id;

  const titleEl = document.getElementById("protocolConfirmTitle");
  const rationaleEl = document.getElementById("protocolConfirmRationale");
  const stepsEl = document.getElementById("protocolConfirmSteps");
  const countEl = document.getElementById("protocolConfirmStepCount");

  const t = window.t || ((k) => k);
  if (titleEl) titleEl.textContent = decodeEscapes(ev.title || t("protocol.confirm.badge"));
  if (rationaleEl) rationaleEl.textContent = decodeEscapes(ev.rationale || "…");
  if (countEl) {
    const n = Number(ev.step_count || (ev.steps || []).length || 0);
    countEl.textContent = t("protocol.confirm.step_count", { n });
  }
  if (stepsEl) {
    stepsEl.innerHTML = "";
    (ev.steps || []).forEach((s, i) => stepsEl.appendChild(_renderStep(s, i)));
  }

  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
}

export function hideConfirmation(toolUseId) {
  const backdrop = document.getElementById("protocolConfirmBackdrop");
  if (!backdrop) return;
  //  防止陈旧的暂停/收盘超越新的开盘——仅
  //  关闭与活动 ID 匹配的模态。
  if (toolUseId && _activeConfirmId && toolUseId !== _activeConfirmId) return;
  backdrop.classList.remove("open");
  backdrop.setAttribute("aria-hidden", "true");
  _activeConfirmId = null;
}

export function submitStepResult({ stepId, value, unit, observation }) {
  if (!state.proto || !state.send) return;
  state.send({
    type: "protocol_step_result",
    protocol_id: state.proto.protocol_id,
    step_id: stepId,
    value, unit, observation,
  });
}

export function skipStep({ stepId, reason }) {
  if (!state.proto || !state.send) return;
  state.send({
    type: "protocol_step_result",
    protocol_id: state.proto.protocol_id,
    step_id: stepId,
    skip_reason: reason || "tech: skip",
  });
}

export function abandonProtocol(reason) {
  if (!state.proto || !state.send) return;
  state.send({
    type: "protocol_abandon",
    protocol_id: state.proto.protocol_id,
    reason: (reason && reason.trim()) || "tech_dismiss",
  });
}

//  --- 放弃确认模式 ----------------------------------------------------------
//  镜像 showConfirmation/hideConfirmation 模式（初始提案），
//  但对于飞行中的放弃路径：静态标记位于
//  #protocolAbandonBackdrop 下的 web/index.html，首次显示时采用惰性连接。

let _abandonWired = false;

function _wireAbandonModal() {
  if (_abandonWired) return;
  const backdrop = document.getElementById("protocolAbandonBackdrop");
  if (!backdrop) return;
  const cancelBtn = document.getElementById("protocolAbandonCancel");
  const confirmBtn = document.getElementById("protocolAbandonConfirm");
  const reasonInput = document.getElementById("protocolAbandonReason");

  cancelBtn?.addEventListener("click", () => {
    hideAbandonModal();
  });

  confirmBtn?.addEventListener("click", () => {
    const reason = reasonInput ? reasonInput.value : "";
    abandonProtocol(reason);
    hideAbandonModal();
  });

  //  关闭 Escape 并单击背景（在对话框外部）。
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) hideAbandonModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && backdrop.classList.contains("open")) {
      hideAbandonModal();
    }
  });

  _abandonWired = true;
}

export function showAbandonModal() {
  _wireAbandonModal();
  const backdrop = document.getElementById("protocolAbandonBackdrop");
  if (!backdrop) return;
  //  每次都重置原因字段，这样之前的放弃就不会泄漏。
  const reasonInput = document.getElementById("protocolAbandonReason");
  if (reasonInput) reasonInput.value = "";
  backdrop.classList.add("open");
  backdrop.setAttribute("aria-hidden", "false");
}

export function hideAbandonModal() {
  const backdrop = document.getElementById("protocolAbandonBackdrop");
  if (!backdrop) return;
  backdrop.classList.remove("open");
  backdrop.setAttribute("aria-hidden", "true");
}

//  --- 向导渲染器 + 表单生成器 ------------------------------------------

function numberFromStepId(id) {
  //  s_1→1，ins_xx→“+”
  const m = /^s_(\d+)$/.exec(id);
  return m ? m[1] : "+";
}

function formatResult(step) {
  const r = step.result;
  if (!r) return "";
  if (step.type === "numeric") return `${r.value} ${r.unit || step.unit || ""} (${r.outcome})`;
  if (step.type === "boolean") return `${r.value ? t("protocol.step.result.yes") : t("protocol.step.result.no")} (${r.outcome})`;
  if (step.type === "observation") return r.value || t("protocol.step.result.empty");
  if (step.type === "ack") return t("protocol.step.result.done");
  return JSON.stringify(r);
}

function submitBoolean(step, value) {
  submitStepResult({ stepId: step.id, value });
}

function handleSubmit(step, form) {
  const fd = new FormData(form);
  if (step.type === "numeric") {
    const val = parseFloat(fd.get("value"));
    if (Number.isNaN(val)) return;
    submitStepResult({ stepId: step.id, value: val, unit: fd.get("unit") || step.unit });
  } else if (step.type === "observation") {
    const obs = String(fd.get("observation") || "").trim();
    if (!obs) return;
    submitStepResult({ stepId: step.id, value: obs });
  } else if (step.type === "ack") {
    submitStepResult({ stepId: step.id, value: "done" });
  }
}

export function buildStepForm(step) {
  const form = document.createElement("form");
  form.className = "protocol-step-form";
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    handleSubmit(step, form);
  });

  if (step.type === "numeric") {
    const input = document.createElement("input");
    input.type = "number"; input.step = "any"; input.required = true;
    input.placeholder = step.nominal != null
      ? t("protocol.step.nominal_placeholder", { value: step.nominal })
      : t("protocol.step.value_placeholder");
    input.name = "value";
    form.appendChild(input);
    const unit = document.createElement("select");
    unit.name = "unit";
    for (const u of ["V", "mV", "A", "mA", "Ω", "kΩ"]) {
      const opt = document.createElement("option");
      opt.value = u; opt.textContent = u;
      if (u === step.unit) opt.selected = true;
      unit.appendChild(opt);
    }
    form.appendChild(unit);
  } else if (step.type === "boolean") {
    const yes = document.createElement("button");
    yes.type = "button"; yes.textContent = t("protocol.step.yes");
    yes.addEventListener("click", () => submitBoolean(step, true));
    const no = document.createElement("button");
    no.type = "button"; no.textContent = t("protocol.step.no"); no.classList.add("is-skip");
    no.addEventListener("click", () => submitBoolean(step, false));
    form.appendChild(yes); form.appendChild(no);
  } else if (step.type === "observation") {
    const ta = document.createElement("textarea");
    ta.name = "observation"; ta.rows = 2; ta.required = true;
    ta.placeholder = t("protocol.step.observation_placeholder");
    form.appendChild(ta);
  } else if (step.type === "ack") {
    //  ack：下面只是一个完成按钮；提交触发没有值的提交事件。
  }

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = step.type === "ack" ? t("protocol.step.done") : t("protocol.step.validate");
  form.appendChild(submit);

  const skip = document.createElement("button");
  skip.type = "button"; skip.className = "is-skip"; skip.textContent = t("protocol.step.skip");
  skip.addEventListener("click", () => {
    const reason = window.prompt(t("protocol.step.skip_prompt"), "");
    if (reason !== null) skipStep({ stepId: step.id, reason });
  });
  form.appendChild(skip);

  return form;
}

function renderStepRow(step, isActive) {
  const li = document.createElement("li");
  li.className = `protocol-step is-${step.status}`;
  li.dataset.stepId = step.id;

  const badge = document.createElement("span");
  badge.className = "protocol-step-badge";
  badge.textContent = step.status === "done" ? "✓"
                    : step.status === "skipped" ? "·"
                    : step.status === "failed" ? "✗"
                    : numberFromStepId(step.id);
  li.appendChild(badge);

  const body = document.createElement("div");
  body.className = "protocol-step-body";

  const target = document.createElement("div");
  target.className = "protocol-step-target";
  target.textContent = step.target || step.test_point || t("protocol.step.result.empty");
  body.appendChild(target);

  const instr = document.createElement("p");
  instr.className = "protocol-step-instruction";
  instr.textContent = step.instruction;
  body.appendChild(instr);

  const why = document.createElement("p");
  why.className = "protocol-step-rationale";
  why.textContent = step.rationale;
  body.appendChild(why);

  if (step.result && step.status !== "active") {
    const res = document.createElement("div");
    res.className = "protocol-step-result";
    res.textContent = formatResult(step);
    body.appendChild(res);
  }

  if (isActive) {
    body.appendChild(buildStepForm(step));
  }

  li.appendChild(body);
  return li;
}

function renderQuest(proto) {
  const root = document.getElementById("protocolQuest");
  if (!root) return;
  if (!proto) {
    root.classList.add("hidden");
    document.body.classList.remove("has-protocol-quest");
    return;
  }
  root.classList.remove("hidden");
  document.body.classList.add("has-protocol-quest");
  document.getElementById("protocolTitle").textContent = proto.title;

  const total = proto.steps.length;
  const doneCount = proto.steps.filter((s) =>
    s.status === "done" || s.status === "skipped" || s.status === "failed"
  ).length;
  const counter = document.getElementById("protocolCounter");
  if (counter) counter.textContent = `${doneCount} / ${total}`;

  const list = document.getElementById("protocolStepList");
  list.innerHTML = "";
  for (const step of proto.steps) {
    list.appendChild(renderStepRow(step, step.id === proto.current_step_id));
  }
  const histList = document.getElementById("protocolHistoryList");
  histList.innerHTML = "";
  for (const h of proto.history.slice(-10)) {
    const li = document.createElement("li");
    li.textContent = `${h.action}${h.step_id ? " · " + h.step_id : ""}${h.reason ? " · " + h.reason : ""}`;
    histList.appendChild(li);
  }
}

//  在第一次渲染时绑定一次 chrome 按钮（切换折叠、放弃）。
const bindChrome = () => {
  const toggle = document.getElementById("protocolToggleBtn");
  const root = document.getElementById("protocolQuest");
  if (toggle && root && !toggle.dataset.bound) {
    toggle.addEventListener("click", () => {
      const collapsed = root.classList.toggle("is-collapsed");
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      toggle.setAttribute("title", collapsed
        ? t("protocol.toggle.expand")
        : t("protocol.toggle.collapse"));
    });
    toggle.dataset.bound = "1";
  }
  const btn = document.getElementById("protocolAbandonBtn");
  if (btn && !btn.dataset.bound) {
    btn.addEventListener("click", () => {
      showAbandonModal();
    });
    btn.dataset.bound = "1";
  }
};

subscribe(renderQuest);
subscribe(bindChrome);

//  在语言环境切换上重新渲染 — 在动态构建的行中拾取 i18n 字符串。
if (window.i18n && window.i18n.onChange) {
  window.i18n.onChange(() => notify());
}

let _lastFocusedStepId = null;

function pushBadgesToBoard(proto) {
  if (!window.Boardview || !window.Boardview.setProtocolBadges) return;
  if (!proto) {
    window.Boardview.clearProtocolBadges();
    _lastFocusedStepId = null;
    return;
  }
  const minimal = proto.steps.map((s) => ({
    id: s.id, target: s.target, status: s.status,
  }));
  window.Boardview.setProtocolBadges(minimal, proto.current_step_id);
  //  当活动步骤的目标发生变化时，将相机自动聚焦在该目标上 —
  //  在第一个接受（从 null → step1.id 转换）和每个
  //  后续步骤转换。与之前推送相同的目标 = no-op。
  if (proto.current_step_id !== _lastFocusedStepId) {
    _lastFocusedStepId = proto.current_step_id;
    const active = proto.steps.find((s) => s.id === proto.current_step_id);
    if (active && active.target && window.Boardview.focus) {
      try { window.Boardview.focus(active.target); } catch (_) {}
    }
  }
}
subscribe(pushBadgesToBoard);

//  浮动 refdes 引脚 — 只读 chip 锚定在活动步骤的上方
//  目标组件。只需徽章编号 + refdes 标签 + 箭头指向
//  到任务追踪器（右上角）。表单输入位于跟踪器中。
function renderFloating(proto) {
  const card = document.getElementById("protocolFloatingCard");
  if (!card) return;
  if (!proto || !state.hasBoard) {
    card.classList.add("hidden");
    return;
  }
  const active = proto.steps.find((s) => s.id === proto.current_step_id);
  if (!active || !active.target) {
    card.classList.add("hidden");
    return;
  }
  const screenPos = window.Boardview?.refdesScreenPos?.(active.target);
  if (!screenPos) { card.classList.add("hidden"); return; }

  card.classList.remove("hidden");
  //  将 chip 锚定在 bbox 上方；在零件上水平居中。
  //  chip 与其 inline-flex 内容左对齐，因此我们偏移一半
  //  视觉平衡的估计宽度。
  card.style.left = `${screenPos.x - 40}px`;
  card.style.top  = `${screenPos.y - 32}px`;

  const idx = proto.steps.findIndex((s) => s.id === active.id) + 1;
  card.innerHTML =
    `<span class="protocol-float-badge">${idx}</span>` +
    `<span class="protocol-float-target">${escapeHtmlLocal(active.target)}</span>` +
    `<svg class="protocol-float-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M7 17L17 7M17 7H9M17 7v8"/></svg>`;
}
subscribe(renderFloating);
