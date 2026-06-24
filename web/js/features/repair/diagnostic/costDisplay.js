// 诊断ostic 聊天 — 会话 cost 累加器 + 状态栏 readout (Phase D.6
// 外部actionfromllm.js）。拥有每个会话的 cost 状态（re在每个会话上设置）
// re连接；每 agent 推断ence 回合后，后面end emits `turn_cost`）。
// 该模块是这些 ree 计数器的唯一所有者 — llm.js 驱动它
// 通过 resetCost() / recordTurnCost() 和 reads 通过 fmtUsd 格式化值。

// 会话 cost 累加器 — 在每个 (re) 连接上设置re。
let sessionCostUsd = 0;
let sessionTurns = 0;
let lastTurnCostUsd = 0;

export function fmtUsd(amount) {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  if (amount >= 0.0001) return `$${amount.toFixed(4)}`;
  return amount > 0 ? `<$0.0001` : `$0.00`;
}

// 将运行总计 Ren 放入状态栏chip (#llmCostTotal)。希德en
// 直到第一个定价转弯落地；一旦会话或最后一轮“热”
// crosses a spend threshold。
export function updateCostTotal() {
  const el2 = document.getElementById("llmCostTotal");
  if (!el2) return;
  if (sessionTurns === 0) {
    el2.style.display = "none";
    return;
  }
  el2.style.display = "";
  const deltaPart = lastTurnCostUsd > 0 ? ` · +${fmtUsd(lastTurnCostUsd)} last` : "";
  el2.textContent = `${fmtUsd(sessionCostUsd)} · ${sessionTurns} turn${sessionTurns > 1 ? "s" : ""}${deltaPart}`;
  el2.classList.toggle("hot", sessionCostUsd >= 0.50 || lastTurnCostUsd >= 0.10);
}

// 将计数器清零（新连接 = 新 cost 范围）。不会 re 绘画 —
// 调用者在 re 设置所有其他状态后调用 updateCostTotal() 一次，以
// pre服务于原始单re油漆订购。
export function resetCost() {
  sessionCostUsd = 0;
  sessionTurns = 0;
  lastTurnCostUsd = 0;
}

// 将 `turn_cost` event 折叠到运行总计中并re绘制chip。
export function recordTurnCost(payload) {
  lastTurnCostUsd = Number(payload.cost_usd || 0);
  sessionCostUsd += lastTurnCostUsd;
  sessionTurns += 1;
  updateCostTotal();
}
