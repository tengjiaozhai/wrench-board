// web/js/services/diagnosticSocket.js
// 诊断 agent WebSocket（/ws/diagnostic/{slug}）的单一传输层。
// 自 llm.js 抽出（Phase D.4 / B.3）。llm.js 保留消息分发器作为 onMessage 消费者；
// 仅 socket  plumbing（ws/wss URL 构建、new WebSocket、open/close/error 接线）
// 与活跃 socket 引用在此。活跃引用取代原 window.__diagnosticWS 全局变量，
// 使其他界面（main.js 的 Protocol.send、仪表盘「标记已修复」按钮）无需导入
// llm.js 即可在活跃会话上 post。
//
// Cloud 兼容：WS 由托管 front-door 原样中继，URL 不变 — 同源、根相对、调用时构建。

import { API_PREFIX } from "../shared/api.js";

let current = null;   // 当前诊断 socket，或 null

// 构建诊断 WS URL。tier / repairId / conv 为可选查询参数，与抽出前 llm.js 的查询契约一致。
function buildURL(slug, { tier, repairId, conv } = {}) {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams();
  if (tier) params.set("tier", tier);
  if (repairId) params.set("repair", repairId);
  if (conv) params.set("conv", conv);
  const q = params.toString() ? `?${params.toString()}` : "";
  return `${scheme}://${window.location.host}${API_PREFIX}/ws/diagnostic/${encodeURIComponent(slug)}${q}`;
}

// 打开诊断 socket 并设为活跃连接。open/close/error 状态监听器由传入回调接线；
// 调用方自行在返回的 socket 上挂「message」监听器（分发器仍在 llm.js）。
// URL 无效时抛错 — 调用方用 try/catch 包裹，与抽出前 `new WebSocket(url)` 相同。
export function connectDiagnostic(slug, opts = {}, { onOpen, onClose, onError } = {}) {
  const ws = new WebSocket(buildURL(slug, opts));
  current = ws;
  if (onOpen) ws.addEventListener("open", onOpen);
  if (onClose) ws.addEventListener("close", onClose);
  if (onError) ws.addEventListener("error", onError);
  return ws;
}

// 当前诊断 socket（或 null）。供不拥有生命周期、但需在当前会话读/写的界面使用。
export function getDiagnosticWS() {
  return current;
}

// 在活跃 socket 上发送 JSON 载荷。无打开 socket 时 no-op 返回 false，调用方无需
// 自行检查 readyState（避免 CLOSING/CLOSED 时 send() 抛 InvalidStateError）。
export function sendDiagnostic(payload) {
  if (!current || current.readyState !== WebSocket.OPEN) return false;
  try {
    current.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn("[diagnosticSocket] send failed", err);
    return false;
  }
}
