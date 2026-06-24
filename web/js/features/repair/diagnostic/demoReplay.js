//  演示会话重放器 — 将录制的 diagnostic 会话播放到现场
//  没有 WebSocket 也没有 LLM 调用的聊天渲染路径。 onboarding 演示
//  使用它来免费且确定地显示代理“正在行动”。
//
//  以小型 NARRATED BEATS 播放（不是一个自动播放转储）：编排器
//  coaching.js 播放一段帧，在解释气泡上暂停，然后播放
//  “下一步”的下一个切片。记录的服务器→客户端帧被馈送
//  llm.js 的 `handleDiagnosticFrame` — 实时帧所采取的确切路径 — 在
//  限制节奏。捕获工具：scripts/capture_demo_session.py；固定装置在
//  网络/演示/。

import { handleDiagnosticFrame, openPanelForReplay, setDemoOffline } from "../../../llm.js";

//  其实时副作用会破坏被动重播的生命周期/模态框架：
//  session_ready重新对齐tier并可以关闭+重新打开套接字；协议
//  确认框弹出阻塞模式；历史/上下文框架会擦除日志。
//  代理的内容 — 消息、思考、工具调用、boardview.* 视觉效果、
//  协议向导（建议/更新/完成）+步骤，模拟overlays，
//  回合成本——所有重播均保持不变。
const SKIP = new Set([
  "session_ready", "protocol_cleared", "context_loaded", "context_lost",
  "session_resumed", "session_resumed_summary", "history_replay_start",
  "history_replay_end", "memory_store_setup_failed",
  "protocol_pending_confirmation", "protocol_confirmation_timeout",
  //  `highlight` 调用查看器的 selectItem，弹出组件
  //  板上的检查面板（杂乱）。我们保留特工的箭头+
  //  标签（值得展示的能力），但放弃突出显示，并保持干净
  //  刻意缩放每个节拍（coaching.js）。箭头仅在板的一次渲染
  //  相机已准备好 - coaching.js 在董事会击败之前等待（否则
  //  投影产生“translate(NaN,NaN)”)。
  "boardview.highlight",
]);

//  一旦板查看器准备好板+相机（箭头/注释
//  通过它进行项目）。有界投票，因此演示永远不会卡住。
export function waitForBoard(timeoutMs = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (window.Boardview && window.Boardview.hasBoard && window.Boardview.hasBoard()) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });
}

let _cancel = false;
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

//  停止正在运行的节拍（例如，技术人员在播放过程中跳过巡演）。
export function cancelDemoReplay() { _cancel = true; }

//  获取记录的会话并按顺序返回其服务器→客户端帧
//  ({ 毫秒，目录，帧 })。这个数组的索引是 coaching.js 进行切片的依据。
export async function loadRecvFrames(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.frames || []).filter((f) => f.dir === "recv");
  } catch (err) {
    console.warn("[demoReplay] load failed", err);
    return [];
  }
}

//  离线打开聊天（无套接字，无对话获取）并渲染
//  打开用户消息。在第一节拍前调用一次。
export function beginDemoReplay({ userText = null } = {}) {
  _cancel = false;
  setDemoOffline(true);
  openPanelForReplay();
  if (userText) handleDiagnosticFrame({ type: "message", role: "user", text: userText });
}

//  播放一个节拍：一段接收帧，由捕获的增量（上限）控制。
export async function playFrames(slice, { gapCapMs = 700 } = {}) {
  const frames = slice.filter((f) => !SKIP.has(f.frame && f.frame.type));
  let prev = frames.length ? frames[0].ms : 0;
  for (const f of frames) {
    if (_cancel) return;
    const gap = Math.min(Math.max(f.ms - prev, 0), gapCapMs);
    prev = f.ms;
    if (gap) await _sleep(gap);
    if (_cancel) return;
    try { handleDiagnosticFrame(f.frame); }
    catch (err) { console.warn("[demoReplay] frame failed", f.frame && f.frame.type, err); }
  }
}

//  离开离线模式（实时聊天再次表现normally）。
export function endDemoReplay() { setDemoOffline(false); }
