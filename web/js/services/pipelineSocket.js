// web/js/services/pipelineSocket.js
// Pipeline 构建进度 WebSocket 传输层 — WS /pipeline/progress/{slug}
//
// 【在完整流程中的位置 — Step 6（前端）】
//   Step 5  landing/index.js subscribeToProgress(slug)
//   Step 6  本文件 connectProgress(slug) → new WebSocket(url)  ← WS 握手在此
//   Step 7  onEvent → landing handleProgressEvent / pipeline_progress handleEvent
//   Step F  后端 progress.py progress_ws accept + while True 转发
//
// 【URL 构造】ws(s)://{host}/pipeline/progress/{encodeURIComponent(slug)}
// slug 来自 POST /pipeline/repairs 响应的 device_slug，无 session_id。
//
// Cloud 兼容：WS 由 wrench-board-cloud 原样中继。

// 打开 progress socket。返回句柄：{ socket, close(code?, reason?) }。
// 句柄自行跟踪过期状态 — 一旦调用 close()（或调用方用更新的连接取代本连接），
// 不再触发 onEvent/onError/onClose。等价于两个调用方曾用的 per-module
// `current !== ws` 守卫，但无需共享单例耦合两个界面。
export function connectProgress(slug, { onEvent, onError, onClose } = {}) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/pipeline/progress/${encodeURIComponent(slug)}`;
  // Step 6：浏览器发起 WebSocket 握手 → 后端 progress.py:71 websocket.accept()
  const ws = new WebSocket(url);
  let stale = false;

  // Step 7：每条服务端 push 的 JSON 帧 → 调用方 onEvent（handleProgressEvent）
  ws.addEventListener("message", (ev) => {
    if (stale) return;
    let data;
    try { data = JSON.parse(ev.data); }
    catch (_) { return; }   // 非 JSON 帧 — 忽略
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
    // 幂等。将句柄标为过期（抑制待处理回调），若底层 socket 仍打开/连接中则关闭。
    close(code = 1000, reason = "") {
      stale = true;
      if (ws.readyState <= 1) {
        try { ws.close(code, reason); } catch (_) { /* 无操作 */ }
      }
    },
  };
}

// 重载恢复辅助：因 device-kind 分歧暂停的构建在页面刷新后不再发出实时
// `pipeline_paused` 事件。从磁盘重读暂停状态，供调用方重新渲染确认面板。
// 需要确认时返回 pending 载荷，否则 null。刻意使用原始 fetch（非 apiGet）—
// 此处 404/non-ok 是「无待处理项」的正常情况，不应抛错。
export async function fetchPendingKind(slug) {
  try {
    const res = await fetch(`/pipeline/packs/${encodeURIComponent(slug)}/pending-kind`);
    if (!res.ok) return null;
    const pending = await res.json();
    return pending && pending.status === "needs_confirmation" ? pending : null;
  } catch (_) {
    return null;   // 无待处理状态 — 正常
  }
}
