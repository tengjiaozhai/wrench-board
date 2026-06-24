// web/js/services/pipelineSocket.js
// Pipeline 构建进度的 WebSocket 传输层（/pipeline/progress/{slug}）。
//
// 【与 HTTP 的关系 — 时序图见 api/pipeline/routes/repairs.py 模块 docstring】
//
//   ① HTTP 短连接（已结束）          ② WS 长连接（本文件）
//   landing/index.js:471 fetch(...)  landing/index.js:661 connectProgress(slug)
//        ↓ 拿到 device_slug               ↓
//   repairs.py:988 return JSON       pipelineSocket.js:27 new WebSocket(url)  ← 建立 WS
//                                         progress.py:64 while True ...        ← 服务端保持
//
// slug 来自 HTTP 响应；HTTP 与 WS 无服务端 session 绑定。
//
// Cloud-safe: the WS is relayed byte-for-byte by wrench-board-cloud, so the URL
// is unchanged — only the client wiring is consolidated.
//
// Usage:
//   const conn = connectProgress(slug, {
//     onEvent: (ev) => handle(ev),
//     onError: () => showError(),
//     onClose: () => { conn = null; maybeFlagClosedEarly(); },
//   });
//   conn.close();           // idempotent; suppresses any further callbacks

// Open a progress socket. Returns a handle: { socket, close(code?, reason?) }.
// The handle tracks its own staleness — once close() is called (or a newer
// connection supersedes this one in the caller), no further onEvent/onError/
// onClose fires for it. This mirrors the per-module `current !== ws` guard the
// two callers used, without a shared singleton coupling the two surfaces.
export function connectProgress(slug, { onEvent, onError, onClose } = {}) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/pipeline/progress/${encodeURIComponent(slug)}`;
  // 【WS 长会话建立】浏览器向 progress.py:progress_ws 发起握手；连接成功后由
  // 服务端 while True (progress.py:64) 持续推送，直到 conn.close() 或页面关闭。
  const ws = new WebSocket(url);
  let stale = false;

  ws.addEventListener("message", (ev) => {
    if (stale) return;
    let data;
    try { data = JSON.parse(ev.data); }
    catch (_) { return; }   // non-JSON frame — ignore
    if (onEvent) onEvent(data);
  });
  ws.addEventListener("error", (ev) => {
    if (stale) return;
    if (onError) onError(ev);
  });
  ws.addEventListener("close", () => {
    if (stale) return;
    if (onClose) onClose();
  });

  return {
    socket: ws,
    // Idempotent. Marks the handle stale (suppresses pending callbacks) and
    // closes the underlying socket if still open/connecting.
    close(code = 1000, reason = "") {
      stale = true;
      if (ws.readyState <= 1) {
        try { ws.close(code, reason); } catch (_) { /* noop */ }
      }
    },
  };
}

// Reload-restore helper: a build parked on a device-kind disagreement no longer
// emits its live `pipeline_paused` event after a page refresh. This re-reads the
// parked state from disk so the caller can re-render its confirmation panel.
// Returns the pending payload when a confirmation is needed, else null. Stays a
// raw fetch (not apiGet) on purpose — a 404/non-ok here is the normal "nothing
// pending" case, not an error to throw.
export async function fetchPendingKind(slug) {
  try {
    const res = await fetch(`/pipeline/packs/${encodeURIComponent(slug)}/pending-kind`);
    if (!res.ok) return null;
    const pending = await res.json();
    return pending && pending.status === "needs_confirmation" ? pending : null;
  } catch (_) {
    return null;   // no pending state — normal
  }
}
