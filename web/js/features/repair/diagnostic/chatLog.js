//  Diagnostic 聊天 — 聊天日志 DOM 渲染 + 转块状态机 （阶段
//  D.6 提取actionfromllm.js）。拥有胜利 #llmLog: plain 中的每个节点
//  message/system 行、resume/context-lost 卡、协议系统 chip 和
// 内联步骤卡，以及每回合 rail (thinking / 工具步骤 / 消息 /
// cost 脚）。 llm.js中的WS消息调度程序驱动this模块——它操作ens
// 通过 ensureTurn() 进行转弯，将步骤/消息输入其中，然后 closes 它。
//
//  `currentTurn` 是可变状态：DOM 节点
//  重新接收下一个定型的思维 / tool_use /消息事件。 llm.js 没有
//  directly 持有时间更长 — re通过 getCurrentTurn() 将其收回（成本脚）
//  re通过 (re)connect / replay-end / 终止上的 closeTurn() 设置它。
//
// `t` re通过全局 window.t 求解（i18n.js，经典的非ESM脚本）
//  在 CALL 时间，因此字符串在语言环境切换上重新渲染 — 镜像工具桌面
//  window.marked / window.DOMPurify 是全局 CDN 脚本，请阅读
//  裸露。 escapeHTML 每个保护插值。

import { escapeHtml as escapeHTML } from '../../../shared/dom.js';
import { renderAgentMarkup } from './chatMarkup.js';
import { fmtUsd } from './costDisplay.js';
//  相同吗 ?v=quest4 查询 main.js / llm.js 使用 — ESM 通过 URL 按键控制模块，因此
// bare './protocol.js' 会导致re创建第二个缺少 main.js 的实例
//  Protocol.init() 互连。
import * as Protocol from '../../../protocol.js?v=quest4';

const t = (key, params) => (window.t ? window.t(key, params) : key);
const el = (id) => document.getElementById(id);

//  转块状态机。
//  currentTurn 是接收下一个确定的思维 / tool_use / 的 DOM 节点 re
//  消息事件。 user.message 将其关闭（设置为 null）。助理消息
//  当 currentTurn 已经有一个 .turn-message 时到达，打开一个新轮次
// （agentemit连续发送两条消息，无需用户插入）。
let currentTurn = null;

export function logRow(cls, innerHTML) {
  const log = el("llmLog");
  const row = document.createElement("div");
  row.className = cls;
  row.innerHTML = innerHTML;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

export function logMessage(role, text, isReplay = false) {
  const roleLabel = role === "user" ? t('chat.roles.user') : t('chat.roles.agent');
  const cls = `msg ${role}${isReplay ? " replay" : ""}`;
  const replaySuffix = isReplay ? t('chat.roles.replay_suffix') : "";
  logRow(
    cls,
    `<span class="role">${escapeHTML(roleLabel)}${escapeHTML(replaySuffix)}</span>${escapeHTML(text)}`,
  );
}

// 不同的卡 rendered when MA 放弃了之前的会话，并且我们有
//  没有本地 JSONL 备份到摘要自。代理重新创建自
// 划痕;它对先前回合的记忆为零。安珀警报（不同ent
//  from violet“resume-with-summary”卡），方便技术人员知道他们的
// 下一条消息hi是一个空白模型。
export function renderContextLost(payload) {
  const oldId = payload?.old_session_id || "";
  const newId = payload?.new_session_id || "";
  const reason = payload?.reason === "ma_events_empty"
    ? t('chat.context_lost.reason_ma_empty')
    : t('chat.context_lost.reason_generic');
  // `preserved` summ 产生与 MA 无关的endently 在磁盘上幸存的内容。
  // 后面end already 将这些事实推到了fresh agent（简介
  //  阻止resumed=False，合成user.messageresumed=True）。
  // This UI只是告诉技术人员hich文物agent现在有，所以他们
  // 知道什么不应该re解释。
  const preserved = payload?.preserved || {};
  const mCount = Number(preserved.measurements || 0);
  const proto = preserved.protocol;
  const outcome = !!preserved.outcome;
  const preservedItems = [];
  if (mCount > 0) {
    preservedItems.push(t(mCount > 1 ? 'chat.context_lost.preserved_measurements_many' : 'chat.context_lost.preserved_measurements_one', { n: mCount }));
  }
  if (proto) {
    preservedItems.push(t('chat.context_lost.preserved_protocol', {
      title: escapeHTML(proto.title || ""),
      completed: proto.completed || 0,
      total: proto.total || 0,
    }));
  }
  if (outcome) preservedItems.push(t('chat.context_lost.preserved_outcome'));
  const preservedHTML = preservedItems.length
    ? `<p class="preserved"><strong>${escapeHTML(t('chat.context_lost.preserved_label'))}</strong> : ${preservedItems.join(" · ")}.</p>`
    : `<p class="preserved muted">${escapeHTML(t('chat.context_lost.preserved_none'))}</p>`;
  logRow(
    "context-lost",
    `<header>
       <span class="icon-dot"></span>
       <span class="title">${escapeHTML(t('chat.context_lost.title'))}</span>
     </header>
     <div class="body">
       <p>${escapeHTML(reason)}</p>
       <p>${escapeHTML(t('chat.context_lost.context_reinject'))}</p>
       ${preservedHTML}
       <p>${t('chat.context_lost.lost_explainer')}</p>
       ${oldId ? `<p class="meta">old=<code>${escapeHTML(oldId)}</code> · new=<code>${escapeHTML(newId)}</code></p>` : ""}
     </div>`,
  );
}

//  当过渡红色 MA 会话必须重新创建时呈现不同的卡
// Haikusumm出现了freshagent之前的对话。显示
// 新的agent看到的是同一个区块，所以技术人员知道继承了什么。
export function renderResumeSummary(payload) {
  const summary = payload?.summary || "";
  const tokIn = payload?.tokens_in ?? "n/a";
  const tokOut = payload?.tokens_out ?? "n/a";
  let bodyHTML = escapeHTML(summary);
  if (typeof window.marked !== "undefined" && typeof window.DOMPurify !== "undefined") {
    try {
      bodyHTML = window.DOMPurify.sanitize(window.marked.parse(summary));
    } catch (e) { /* 保持逃脱后备 */ }
  }
  logRow(
    "resume-summary",
    `<header>
       <span class="icon-dot"></span>
       <span class="title">${escapeHTML(t('chat.resume.title'))}</span>
       <span class="meta">${escapeHTML(t('chat.resume.meta_summary', { tok_in: tokIn, tok_out: tokOut }))}</span>
     </header>
     <div class="body">${bodyHTML}</div>`,
  );
}

export function logSys(text, isErr = false) {
  logRow(isErr ? "sys err" : "sys", escapeHTML(text));
}

// 应用程序en向聊天日志添加了一个小型终端状态chip（已放弃/已完成）。
// 独特的视觉 from agent/用户消息 — centered、静音、单声道 — 所以
// 技术人员可以向后滚动浏览并查看 when 序列ence 被删除
// 或完成了，为什么。 protocol_id+kind 上的 Idempotent 以避免重复
// when 同一个 event 到达两次（replay 比赛、双emit 等）。
export function appendProtocolSystemEvent(kind, { protocol_id, reason } = {}) {
  const log = el("llmLog");
  if (!log) return;
  const dedupeKey = `${kind}:${protocol_id || "none"}`;
  if (log.querySelector(`.protocol-system-event[data-key="${dedupeKey}"]`)) return;
  const chip = document.createElement("div");
  chip.className = `protocol-system-event is-${kind}`;
  chip.dataset.key = dedupeKey;
  const label = kind === "abandoned"
    ? (window.t?.("protocol.system_event.abandoned") || "Protocol abandoned")
    : (window.t?.("protocol.system_event.completed") || "Protocol completed");
  // 内联SVG匹配项目的图标转换ention（16/12px，
  //  笔划=“当前颜色”，笔画宽度= 1.6) — 无字体图标依赖。
  const icon = kind === "abandoned"
    ? `<svg class="pse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6l-12 12"/></svg>`
    : `<svg class="pse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>`;
  chip.innerHTML = icon + `<span>${escapeHTML(label)}</span>`;
  if (reason && reason !== "tech_dismiss") {
    const r = document.createElement("span");
    r.className = "pse-reason";
    r.textContent = `· ${reason}`;
    chip.appendChild(r);
  }
  log.appendChild(chip);
  log.scrollTop = log.scrollHeight;
}

//  模式 C — 聊天中的内联协议步骤卡没有加载板。
//  仅渲染活动步骤（过去的步骤总结在向导中）。
// 每个活动步骤 ID 一张卡；相同 id no-op 的子后续ent events。
export function renderInlineProtocolCard(_ev) {
  const proto = Protocol.getProtocol?.();
  if (!proto) return;
  const active = proto.steps.find((s) => s.id === proto.current_step_id);
  if (!active) return;
  const log = el("llmLog");
  if (!log) return;
  if (log.querySelector(`.protocol-inline-card[data-step="${active.id}"]`)) return;
  const card = document.createElement("div");
  card.className = "protocol-inline-card";
  card.dataset.step = active.id;
  card.innerHTML =
    `<div class="protocol-step-target">${escapeHTML(active.target || active.test_point || "…")}</div>` +
    `<p class="protocol-step-instruction">${escapeHTML(active.instruction)}</p>` +
    `<p class="protocol-step-rationale">${escapeHTML(active.rationale)}</p>`;
  if (Protocol.buildStepForm) {
    card.appendChild(Protocol.buildStepForm(active));
  }
  log.appendChild(card);
  log.scrollTop = log.scrollHeight;
}

// Create一个fresh转块容器并应用en将其写入日志。
function createTurn() {
  const log = el("llmLog");
  const turn = document.createElement("div");
  turn.className = "turn";
  const rail = document.createElement("div");
  rail.className = "turn-rail";
  turn.appendChild(rail);
  log.appendChild(turn);
  log.scrollTop = log.scrollHeight;
  return turn;
}

export function ensureTurn() {
  if (!currentTurn) currentTurn = createTurn();
  return currentTurn;
}

export function closeTurn() {
  currentTurn = null;
}

// 当前ently re接收事件ents，或null。 llm.js re要附加的广告 thi
// 在一个turn_cost event之后，cost脚到达实时转弯。
export function getCurrentTurn() {
  return currentTurn;
}

export function ensurePendingNode(turn, label) {
  const rail = turn.querySelector(".turn-rail");
  if (!rail || rail.querySelector(".step.pending")) return;
  const finalLabel = label != null ? label : t('chat.pending.thinking');
  const step = document.createElement("div");
  step.className = "step pending";
  step.innerHTML =
    `<span class="node"></span>` +
    `<span class="step-phrase">${escapeHTML(finalLabel)}` +
    `<span class="pending-dots"><span>.</span><span>.</span><span>.</span></span>` +
    `</span>`;
  rail.appendChild(step);
  el("llmLog").scrollTop = el("llmLog").scrollHeight;
}

function clearPendingNode(turn) {
  const p = turn.querySelector(".step.pending");
  if (p) p.remove();
}

//  应用程序end .step进入循环的rail。 kind ∈ {"thinking","mb","bv","mem",...}。
// phraseHTML 是受信任的 HTML（调用者转义用户提供的 fragments
// 它们本身 — 当前en仅工具名称 + refdes which are 已验证）。
//
//  `group` (可选) = { key, item } 可合并：当代理开火时
// 同一个工具连续进行几次time（五次component查找，一系列
// 内存re广告，re重复的球体）我们不堆叠五行——我们折叠每行新的
// 将发生者ence的目标chip放入pre上一步的内联列表中并将其变暗
//  整个运行。单独的调用（没有后续的同键调用）会渲染 normally。退货
// 任一方式的实时步骤节点（现有的 when 合并），因此调用者的
//  addExpandToStep() 将有效负载附加/累积到其上。
export function appendStep(turn, kind, phraseHTML, group = null) {
  clearPendingNode(turn);
  const rail = turn.querySelector(".turn-rail");
  if (group && group.key) {
    const steps = rail.querySelectorAll(".step:not(.pending)");
    const last = steps[steps.length - 1];
    if (last && last.dataset.groupKey === group.key) {
      mergeIntoGroup(last, group);
      ensurePendingNode(turn);
      el("llmLog").scrollTop = el("llmLog").scrollHeight;
      return last;
    }
  }
  const step = document.createElement("div");
  step.className = `step ${kind}`;
  step.innerHTML = `<span class="node"></span><span class="step-phrase">${phraseHTML}</span>`;
  if (group && group.key) {
    step.dataset.groupKey = group.key;
    step.dataset.groupCount = "1";
  }
  rail.appendChild(step);
  ensurePendingNode(turn);
  el("llmLog").scrollTop = el("llmLog").scrollHeight;
  return step;
}

// 将一个 more 同工具发生ence 折叠到现有步骤中。目标chip
// （refdes / 路径 / 模式）它加入一个 comma 分隔的内联列表；没有一个
// （无变量操作）它只是碰撞一个小的 ×N 计数器。 `.grouped` 使运行变暗
// 并让短语换行（参见llm.css），以便完整列表保持re可用。
function mergeIntoGroup(step, group) {
  const count = (Number(step.dataset.groupCount) || 1) + 1;
  step.dataset.groupCount = String(count);
  step.classList.add("grouped");
  const phrase = step.querySelector(".step-phrase");
  if (!phrase) return;
  if (group.item) {
    let items = phrase.querySelector(".step-items");
    if (!items) {
      items = document.createElement("span");
      items.className = "step-items";
      phrase.appendChild(items);
    }
    //  group.item 是由 toolPhrases.js 构建的受信任 HTML（已经已转义）。
    items.insertAdjacentHTML("beforeend", `<span class="step-item-sep">, </span>${group.item}`);
  } else {
    let badge = phrase.querySelector(".step-count");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "step-count";
      phrase.appendChild(badge);
    }
    badge.textContent = ` ×${count}`;
  }
}

export function addExpandToStep(step, payloadObj) {
  // Grouped 步骤累积每个发生者ence 的报酬load 成为hind 一个 V 形：
  // when appendStep() 合并一次 run，它 re 反复转动同一个节点 here re，所以
  // 我们推入step._payloads和re-render而不是堆叠按钮。
  if (!step._payloads) step._payloads = [];
  step._payloads.push(payloadObj);

  let btn = step.querySelector(":scope > .step-expand");
  let pre = step.querySelector(":scope > .step-payload");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "step-expand";
    btn.setAttribute("aria-expanded", "false");
    btn.title = t('chat.step.expand_title');
    btn.innerHTML =
      '<svg class="chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="9 6 15 12 9 18"/></svg>';
    step.appendChild(btn);

    pre = document.createElement("pre");
    pre.className = "step-payload";
    step.appendChild(pre);

    btn.addEventListener("click", () => {
      const expanded = step.classList.toggle("expanded");
      btn.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
  }

  const payloads = step._payloads;
  if (payloads.length === 1) {
    const p = payloads[0];
    const hasResult = p && typeof p === "object" && "result" in p;
    pre.textContent = hasResult
      ? JSON.stringify(p, null, 2)
      : JSON.stringify(p, null, 2) + "\n\n" + t('chat.step.no_result');
  } else {
    // 合并运行：将每次发生ence payloads 转储为 ordered 数组。
    pre.textContent = JSON.stringify(payloads, null, 2);
  }
}

export function appendTurnMessage(turn, text) {
  let msg = turn.querySelector(".turn-message");
  if (msg) {
    // 同一个回合中的第二个助理消息 — open 新回合。
    closeTurn();
    turn = ensureTurn();
    msg = null;
  }
  clearPendingNode(turn);
  msg = document.createElement("div");
  msg.className = "turn-message";
  renderAgentMarkup(msg, text || "");
  turn.appendChild(msg);
  el("llmLog").scrollTop = el("llmLog").scrollHeight;
  return msg;
}

export function appendTurnFoot(turn, payload) {
  // this 转弯的终端信号 — 清除中转ent 指示器。
  clearPendingNode(turn);
  let foot = turn.querySelector(".turn-foot");
  if (!foot) {
    foot = document.createElement("div");
    foot.className = "turn-foot";
    turn.appendChild(foot);
  }
  const priceLabel = payload.priced ? fmtUsd(payload.cost_usd) : "n/a";
  const modelLabel = payload.model ? payload.model.replace("claude-", "") : "?";
  const tokensLabel = `${(payload.input_tokens || 0) + (payload.cache_read_input_tokens || 0) + (payload.cache_creation_input_tokens || 0)}→${payload.output_tokens || 0} tok`;
  foot.innerHTML =
    `<span class="foot-cost">${priceLabel}</span>` +
    `<span class="foot-sep">·</span>` +
    `<span class="foot-tokens">${tokensLabel}</span>` +
    `<span class="foot-sep">·</span>` +
    `<span class="foot-model">${escapeHTML(modelLabel)}</span>`;
}
