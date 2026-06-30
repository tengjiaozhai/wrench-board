//  诊断代理面板 — WS 客户端至 /ws/diagnostic/{device_slug}。
//  面板是推送模式：打开时，设置 body.llm-open 并且主要
//  右侧内容区域缩小 420 像素。
//
//  有线协议（匹配 api/agent/runtime_{managed,direct}.py）：
//      发送：{类型：“消息”，文本：“...”}
//                  {类型：“client.capabilities”，camera_available，...} (Files+Vision)
//                  {类型：“client.upload_macro”，base64，mime，文件名}（Flow A）
//                  {类型：“client.capture_response”，request_id，base64，（Flow B）
//                                    mime、设备标签}
//                  {类型：“client.protocol_confirmation”，tool_use_id，（Pattern 4）
//                                    决定：“接受”|“拒绝”，原因是什么？}
//      接收：{类型：“session_ready”，模式，device_slug，会话ID？，内存存储ID？}
//                  {类型：“消息”，角色：“助理”，文本}
//                  {类型：“tool_use”，名称，输入}
//                  {type: "thinking", text}（仅限managed模式）
//                  {类型：“错误”，文本}
//                  {类型：“会话终止”}
//                  {类型：“server.capture_request”，request_id，tool_use_id，原因}
//                  {类型：“server.upload_macro_error”，原因}
//                  {类型：“protocol_pending_confirmation”，tool_use_id，标题，…}
//                  {类型：“协议确认超时”，tool_use_id}
//
//  通过 ⌘/Ctrl+J 并单击 topbar“代理”按钮激活。

import {
  selectedCameraDeviceId,
  selectedCameraLabel,
} from './camera.js';
import {
  closePreview,
  isPreviewOpen,
  openPreview,
} from './camera_preview.js';
import { mountMascot, setMascotState } from './mascot.js';
import { escapeHtml as escapeHTML } from './shared/dom.js';
import { getDeviceSlug, getRepairId } from './shared/context.js';
import { connectDiagnostic } from './services/diagnosticSocket.js';
import { API_PREFIX } from './shared/api.js';
//  相同的？v=quest4查询main.js使用-ESM通过URL键模块，所以一个裸露的
//  './protocol.js' 将创建具有自己状态的第二个实例，但缺少
//  应用 Protocol.init() 接线 main.js。
import * as Protocol from './protocol.js?v=quest4';
//  SimulationController拥有schematic观察UI；我们镜像代理
//  测量事件到它上面。相同 ?v=fitzoom 查询 main.js 使用（单个
//  模块实例）。 schematic.js 不导入 llm.js → 没有循环。
import { SimulationController } from './schematic.js?v=fitzoom';
import { store } from './store.js';
import {
  TOOL_PHRASES,
  MEMORY_TOOL_PHRASES,
  toolFallback,
  memToolFallback,
} from './features/repair/diagnostic/toolPhrases.js';
import {
  fmtUsd,
  updateCostTotal,
  resetCost,
  recordTurnCost,
} from './features/repair/diagnostic/costDisplay.js';
import {
  sendCapabilities,
  handleMacroUpload,
  handleCaptureRequest,
} from './features/repair/diagnostic/filesVision.js';
import {
  logMessage,
  logSys,
  renderContextLost,
  renderResumeSummary,
  appendProtocolSystemEvent,
  renderInlineProtocolCard,
  ensureTurn,
  closeTurn,
  getCurrentTurn,
  ensurePendingNode,
  appendStep,
  addExpandToStep,
  appendTurnMessage,
  appendTurnFoot,
} from './features/repair/diagnostic/chatLog.js';

let ws = null;
//  使用（{slug，repairId}）拨打实时套接字的路由范围。打开面板()
//  与当前路线比较：SPA导航修复A→修复B从不
//  关闭旧插座，以及用于短路的带电插座
//  重新连接 — 使面板（以及每条输入的消息）绑定到修复 A。
let wsScope = null;
let currentTier = "deep";
//  缓存的 <svg.mascot> 在面板片段初始化时安装到 #llmMascot 中。
//  `setPanelMascot()` 是通过 WS 事件对其进行动画处理的单一阻塞点
//  和表单提交——当片段尚未加载时，空安全。
let panelMascot = null;
let _errorRecoveryT = null;
let _typingHoldT = null;
function _clearMascotTimers() {
  if (_errorRecoveryT) { clearTimeout(_errorRecoveryT); _errorRecoveryT = null; }
  if (_typingHoldT) { clearTimeout(_typingHoldT); _typingHoldT = null; }
}
function setPanelMascot(state) {
  if (!panelMascot) return;
  _clearMascotTimers();
  setMascotState(panelMascot, state);
  if (state === "error") {
    _errorRecoveryT = setTimeout(() => {
      setMascotState(panelMascot, "idle");
      _errorRecoveryT = null;
    }, 1800);
  }
}
//  WS 将辅助消息作为一个块（无令牌流）传递，因此
//  否则“打字”将不可见。当以下情况时，将其闪烁为可读窗口：
//  答案落地，然后闲置——除非转弯做更多的工作
//  （tool_use将其翻转为“工作”，取消此保持）。
function flashPanelMascotTyping() {
  if (!panelMascot) return;
  _clearMascotTimers();
  setMascotState(panelMascot, "typing");
  _typingHoldT = setTimeout(() => {
    _typingHoldT = null;
    setMascotState(panelMascot, "idle");
  }, 1800);
}
//  一旦技术人员明确选择了 tier 此页面加载（单击
//  popover，或任何调用 switchTier 的路径）。直到那件事发生之前，
//  session_ready 可以自动将 currentTier 与恢复的 conv 重新对齐
//  首选 tier — 打开 Sonnet/Haiku 转化不应默默地登陆
//  它的 Opus 线程几乎为空，因为 URL 默认为 `deep`。
let userPickedTier = false;
//  多方对话状态。 `currentConvId` 是从 session_ready 捕获的。
//  `conversationsCache` 支持 popover 渲染。 `pendingConvParam` 是
//  ? 下一个 connect() 使用的 conv 值 — “new” 强制进行新的 conv，
//  一个具体的 id 来定位现有的 id，null 让后端解析
//  至活跃转化次数
let currentConvId = null;
let conversationsCache = [];
let pendingConvParam = null;
//  意外套接字丢失后自动重新连接（由上游代理空闲切断，
//  短暂的网络故障、云重新部署）。云中继现在保持活动状态
//  隧道，所以这种情况很少见——但当有人滑过时，我们会恢复同样的情况
//  透明地进行对话，而不是将技术搁置在“错误套接字”上
//  手动重新加载。自动关闭（tier/转换开关、路线变更、面板
//  拆解）重新分配或清空模块“ws”，因此关闭套接字不再是
//  实时的，我们不会重新连接它。上限指数退避；之后
//  最后一次尝试我们发现错误并停止。
let _reconnectT = null;
let _reconnectAttempts = 0;
const _RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
function _clearReconnect() {
  if (_reconnectT) { clearTimeout(_reconnectT); _reconnectT = null; }
  _reconnectAttempts = 0;
}
import { ICON_CHECK } from './icons.js';

function el(id) { return document.getElementById(id); }

function statusTone(tone, label) {
  const s = el("llmStatus");
  s.classList.remove("connecting", "connected", "closed", "error");
  if (tone) s.classList.add(tone);
  el("llmStatusText").textContent = label;
}

function safeJSON(v) {
  try { return JSON.stringify(v ?? {}); } catch { return String(v); }
}

function currentDeviceSlug() {
  return getDeviceSlug();
}

function currentRepairId() {
  return getRepairId();
}

function setSendEnabled(enabled) {
  el("llmSend").disabled = !enabled;
  el("llmStop").disabled = !enabled;
}

//  Inter中断现场代理回合。服务器将其转换为
//  官方 `user.interrupt` 会话事件（参见
//  https://platform.claude.com/docs/en/managed-agents/events-and-streaming）。
//  MA保证代理在执行过程中停止；会话保持活动状态，因此
//  技术人员可以在之后立即继续打字，而无需重新连接。
function interruptAgent() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  logSys(t('chat.session.interrupt_sent'));
  try {
    ws.send(JSON.stringify({ type: "interrupt" }));
  } catch (err) {
    console.warn("interrupt send failed", err);
  }
}

function connect() {
  //  任何新的拨号都会取代排队的重新连接（tier/转换开关、路由
  //  通过这里更改所有漏斗）。
  _clearReconnect();
  const slug = currentDeviceSlug();
  if (!slug) {
    console.warn("[llm] connect() called without ?device= in the URL — aborting.");
    return;
  }
  const repairId = currentRepairId();
  //  附带的示例修复是只读的（云拒绝其代理 WS
  //  保护配额/信用）。甚至不用拨号——显示通知而不是
  //  沉默失败的套接字。纵深防御；安全边界是云。
  if (repairId && String(repairId).startsWith("example-")) {
    statusTone("closed", t('chat.status.idle'));
    logSys(t('chat.demo.read_only'));
    setSendEnabled(false);
    return;
  }
  el("llmDevice").textContent = repairId
    ? t('chat.session.device_label_with_repair', { slug, repair: repairId.slice(0, 8) })
    : t('chat.session.device_label_simple', { slug });
  el("llmDevice").style.display = "";
  const title = el("llmTitle");
  if (title) {
    const human = slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    title.textContent = human;
  }
  //  新的连接=新的成本范围。重播历史不会重新计费，所以我们
  //  在这里重置，让实时回合积累新鲜感。
  resetCost();
  closeTurn();
  currentConvId = null;
  //  清除日志——下一个session_ready/history_replay_start将
  //  重建正确的内容。如果没有这个，切换转换或tier
  //  将重播的历史记录附加到旧 conv 的可见消息下方。
  const log = el("llmLog");
  if (log) {
    log.innerHTML = "";
    log.classList.remove("replay");
  }
  updateCostTotal();
  const conv = pendingConvParam;
  pendingConvParam = null;  //  此连接后消耗
  statusTone("connecting", t('chat.status.connecting', { slug, tier: currentTier }));

  try {
    wsScope = { slug, repairId: repairId || null };
    ws = connectDiagnostic(
      slug,
      { tier: currentTier, repairId, conv },
      {
        onOpen: () => {
          //  干净的打开会清除任何待处理的重新连接：我们又恢复正常了。
          _clearReconnect();
          statusTone("connected", t('chat.status.connected', { slug, tier: currentTier }));
          setSendEnabled(true);
          //  Files+Vision：宣布相机可用性，以便后端门
          //  清单中的cam_capture（runtime_direct）并且可以短路
          //  空捕获（managed运行时）。
          sendCapabilities();
        },
        onClose: (ev) => {
          statusTone("closed", t('chat.status.closed'));
          setSendEnabled(false);
          setPanelMascot("idle");
          //  仅当这仍然是活动套接字时才重新连接（自愿关闭
          //  首先重新分配/清空`ws`) - 其余部分请参见scheduleReconnect
          //  守卫（面板打开+相同路线）。
          if (ev && ev.target === ws) scheduleReconnect();
        },
        onError: () => {
          statusTone("error", t('chat.status.error_socket'));
          setSendEnabled(false);
          setPanelMascot("error");
        },
      },
    );
  } catch (err) {
    statusTone("error", t('chat.status.url_invalid'));
    logSys(t('chat.send.connect_failed', { error: err.message }), true);
    return;
  }

  ws.addEventListener("message", ev => {
    let payload;
    try { payload = JSON.parse(ev.data); }
    catch { payload = { type: "message", role: "assistant", text: ev.data }; }
    handleDiagnosticFrame(payload);
  });
}

//  安排意外断开后的重新连接。保释（不重新连接）时
//  面板已关闭（重新打开拨号盘）或实时路线已继续
//  套接字已被拨号 - 然后重新连接将恢复错误的会话。
//  否则，它会在有上限的退避时间内重拨，恢复相同的对话
//  (pendingConvParam = currentConvId)，并在最后一次延迟后放弃。
function scheduleReconnect() {
  if (_reconnectT) return; //  重试已排队
  const panelOpen = el("llmPanel")?.classList.contains("open");
  const sameRoute = wsScope
    && wsScope.slug === currentDeviceSlug()
    && wsScope.repairId === (currentRepairId() || null);
  if (!panelOpen || !sameRoute) return;
  if (_reconnectAttempts >= _RECONNECT_DELAYS_MS.length) {
    //  尝试次数不足 — 将技术保留在套接字错误上，以便手动重新加载
    //  是明确的下一步。
    statusTone("error", t('chat.status.error_socket'));
    return;
  }
  const delay = _RECONNECT_DELAYS_MS[_reconnectAttempts++];
  statusTone("connecting", t('chat.status.connecting', { slug: currentDeviceSlug(), tier: currentTier }));
  _reconnectT = setTimeout(() => {
    _reconnectT = null;
    //  恢复同一个线程； connect() 消耗pendingConvParam然后重置
    //  currentConvId，所以先在这里捕获它。
    pendingConvParam = currentConvId || null;
    ws = null;
    connect();
  }, delay);
}

//  调度单个 diagnostic-WS 帧 (boardview/协议/模拟路由
//  + 主类型开关）。从实时套接字侦听器中提取，因此
//  onboarding 演示重放器可以通过完全相同的方式提供录制的帧
//  渲染路径。所有帮助器 + 模块都声明它引用（ws、currentTier、
//  currentConvId，pendingConvParam，协议，窗口。Boardview，el，logSys，
//  recordTurnCost, setPanelMascot, …) 是模块范围的，所以它的行为
//  无论是由实时帧还是重播帧驱动，都是相同的。
export function handleDiagnosticFrame(payload) {
    //  Boardview 事件是视觉突变——而不是聊天内容。路由它们
    //  到渲染器（或其挂起的缓冲区，如果渲染器尚未安装）。
    if (typeof payload.type === "string" && payload.type.startsWith("boardview.")) {
      window.Boardview.apply(payload);
      return;
    }

    //  协议事件驱动逐步 diagnostic 向导。将它们路由到
    //  拥有状态+渲染器的协议模块（protocol.js）。当
    //  没有加载板，还在聊天流中渲染内联卡
    //  （模式 C）因此即使没有，技术人员仍然可以看到活动步骤 + 形式
    //  向导列可见。
    if (typeof payload.type === "string" && payload.type.startsWith("protocol_")) {
      Protocol.applyEvent(payload);
      //  无论板如何，聊天流中都会出现最终状态 chips
      //  模式 - 放弃和完成是技术的会话级事件
      //  应该在他们的回滚中看到。理性是人类提供的
      //  放弃模式中的文本区域条目（或“tech_dismiss”默认值）。
      if (payload.type === "protocol_updated") {
        if (payload.action === "abandoned" || payload.status === "abandoned") {
          appendProtocolSystemEvent("abandoned", {
            protocol_id: payload.protocol_id,
            reason: payload.reason || payload.history_tail?.slice(-1)?.[0]?.reason,
          });
        } else if (payload.status === "completed") {
          appendProtocolSystemEvent("completed", {
            protocol_id: payload.protocol_id,
          });
        }
      } else if (payload.type === "protocol_completed") {
        appendProtocolSystemEvent("completed", {
          protocol_id: payload.protocol_id,
        });
      }
      //  等待确认+超时仅驱动模态 - 不渲染
      //  聊天流中的内联卡（该模式是全局拦截器）。
      const isModalOnly = (
        payload.type === "protocol_pending_confirmation" ||
        payload.type === "protocol_confirmation_timeout"
      );
      const noBoard = !window.Boardview?.hasBoard?.();
      if (!isModalOnly && noBoard && payload.type !== "protocol_completed") {
        renderInlineProtocolCard(payload);
      }
      return;
    }

    //  模拟观察事件反映了代理的测量工具
    //  实时显示到schematic UI。相同的单向通道，不同的
    //  控制器（SimulationController位于schematic.js）。
    if (typeof payload.type === "string" && payload.type.startsWith("simulation.")) {
      const SC = SimulationController;
      if (payload.type === "simulation.observation_set" && SC) {
        const parsed = (typeof payload.target === "string" && payload.target.includes(":"))
          ? payload.target.split(":", 2) : [null, null];
        const kind = parsed[0] === "rail" ? "rail" : parsed[0] === "comp" ? "comp" : null;
        const key = parsed[1];
        if (kind && key) SC.setObservation(kind, key, payload.mode, payload.measurement);
      } else if (payload.type === "simulation.observation_clear" && SC) {
        SC.clearObservations();
      } else if (payload.type === "simulation.repair_validated") {
        const btn = document.getElementById("dashboardFixBtn");
        if (btn) {
          //  从仪表板端清除任何待处理的安全超时。
          if (btn._fixTimeoutId) { clearTimeout(btn._fixTimeoutId); btn._fixTimeoutId = null; }
          const n = payload.fixes_count || 1;
          btn.innerHTML = ICON_CHECK + " " + escapeHTML(t(n > 1 ? 'chat.fix.validated_many' : 'chat.fix.validated_one', { n }));
          btn.classList.add("is-validated");
          btn.disabled = true;
        }
      }
      return;
    }

    switch (payload.type) {
      case "session_ready": {
        const model = payload.model || "claude";
        const mode = payload.mode || "managed";
        const repairShort = payload.repair_id ? payload.repair_id.slice(0, 8) : null;
        const sub = el("llmSubline");
        if (sub) {
          sub.textContent = repairShort
            ? t('chat.session.subline_with_repair', { model, mode, repair: repairShort })
            : t('chat.session.subline', { model, mode });
        }
        logSys(repairShort
          ? t('chat.session.ready_with_repair', { mode, model, repair: repairShort })
          : t('chat.session.ready', { mode, model }));
        currentConvId = payload.conv_id || null;
        loadConversations();
        //  当技术尚未完成时，自动将 tier 与恢复的转换对齐
        //  本次会议明确选择了一个，并且会议是在以下时间创建的
        //  不同的tier。如果没有这个，默认为fast/Haiku
        //  恢复了 Sonnet 转换的（几乎为空的）每 tier 线程 —
        //  用户在 31 轮对话中看到“0 条消息”，因为
        //  他们看错了方向。
        const convTier = payload.conv_tier;
        if (
          convTier &&
          convTier !== currentTier &&
          !userPickedTier &&
          ["fast", "normal", "deep"].includes(convTier)
        ) {
          logSys(t('chat.session.tier_auto_align', { tier: convTier }));
          //  镜像 switchTier 逻辑，但跳过“用户选择”标记，因此
          //  未来显式 tier pick 仍然会控制此自动对齐。
          currentTier = convTier;
          const chip = el("llmTierChip");
          if (chip) {
            chip.dataset.tier = convTier;
            const label = chip.querySelector(".tier-label");
            if (label) label.textContent = convTier.toUpperCase();
          }
          document.querySelectorAll(".llm-tier-popover button[data-tier]").forEach(btn => {
            btn.classList.toggle("on", btn.dataset.tier === convTier);
          });
          if (ws && ws.readyState <= 1) {
            try { ws.close(); } catch (_) { /*  忽略  */ }
          }
          ws = null;
          //  重新连接时保持相同的 conv_id，以便我们到达正确的线程。
          pendingConvParam = currentConvId || null;
          connect();
        }
        break;
      }
      case "history_replay_start":
        el("llmLog").classList.add("replay");
        logSys(t('chat.session.replay_count', { n: payload.count }));
        break;
      case "history_replay_end":
        el("llmLog").classList.remove("replay");
        logSys(t('chat.session.replay_done'));
        closeTurn();
        break;
      case "context_loaded":
        logSys(t('chat.session.context_loaded'));
        break;
      case "session_resumed":
        logSys(t('chat.session.session_resumed'));
        break;
      case "session_resumed_summary":
        renderResumeSummary(payload);
        break;
      case "context_lost":
        //  Anthropic Managed Agents 会话已被默默删除/
        //  由 beta 后端压缩，并且我们没有本地 JSONL 备份
        //  总结一下。新创建的会话没有记忆
        //  之前的回合 - 技术现在提出的任何问题都会得到回答，就像
        //  这是谈话的第一轮。如果没有这张卡
        //  聊天面板假装什么都没发生，技术浪费了几分钟
        //  想知道为什么代理忘记了他们讨论的症状。
        renderContextLost(payload);
        break;
      case "message":
        if ((payload.role || "assistant") === "user") {
          closeTurn();
          logMessage("user", payload.text || "", payload.replay === true);
        } else {
          const turn = ensureTurn();
          appendTurnMessage(turn, payload.text || "");
          if (payload.replay !== true) flashPanelMascotTyping();
        }
        break;
      case "tool_use": {
        const turn = ensureTurn();
        const name = payload.name || "?";
        const kind = name.startsWith("bv_") ? "bv" :
                     name.startsWith("stock_") ? "stock" :
                     name.startsWith("mb_") ? "mb" : "mb";
        const renderer = TOOL_PHRASES[name];
        const { icon, phraseHTML, group } = renderer ? renderer(payload.input || {}) : toolFallback(name);
        const step = appendStep(turn, kind, `${icon}${phraseHTML}`, group);
        const payloadJSON = {
          args: payload.input || {},
          ...(payload.result != null ? { result: payload.result } : {}),
        };
        addExpandToStep(step, payloadJSON);
        setPanelMascot("working");
        break;
      }
      case "memory_tool_use": {
        //  MA 本机文件系统操作在 /mnt/memory/{slug}/ 上。这些可以到达
        //  在助理发出消息后（下一个代理推理步骤开始），
        //  因此，在这种情况下，请重新开始——否则新的步骤将
        //  渲染在消息上方的 rail 中。
        let turn = ensureTurn();
        if (turn.querySelector(".turn-message")) {
          closeTurn();
          turn = ensureTurn();
        }
        const name = payload.name || "?";
        const renderer = MEMORY_TOOL_PHRASES[name];
        const { icon, phraseHTML, group } = renderer ? renderer(payload.input || {}) : memToolFallback(name);
        const step = appendStep(turn, "mem", `${icon}${phraseHTML}`, group);
        addExpandToStep(step, { args: payload.input || {} });
        setPanelMascot("working");
        break;
      }
      case "thinking": {
        const turn = ensureTurn();
        appendStep(turn, "thinking", escapeHTML(payload.text || "…"));
        setPanelMascot("thinking");
        break;
      }
      case "turn_cost": {
        recordTurnCost(payload);
        const ct = getCurrentTurn();
        if (ct) appendTurnFoot(ct, payload);
        //  离线演示重播没有实时对话列表可供刷新 - 跳过
        //  网络round-trip（它会在演示修复 ID 上出现 404 泛洪）。
        if (!_demoOffline) {
          clearTimeout(window._llmConvRefreshT);
          window._llmConvRefreshT = setTimeout(() => loadConversations(), 500);
        }
        break;
      }
      case "error":
        logSys(t('chat.error.generic', { text: payload.text }), true);
        //  如果仪表板修复按钮处于待处理状态，请清除其微调器，以便
        //  技术人员可以重试，而不是永远盯着“……Claude valide”。
        //  仪表板订阅此商店密钥（它拥有该按钮）。
        store.set("fixButtonReset", true);
        setPanelMascot("error");
        break;
      case "stream_error":
        //  终端：引擎结束了转弯（Anthropic API 错误 — 例如
        //  支出限制 400 — 或流停止）并且不会流更多。
        //  如果没有这个，“思维”mascot就会永远旋转（症状亚历克斯
        //  击中）。浮出消息，关闭转弯，稳定指示器。
        //  引擎发送“消息”（不是“文本”）；回落到两者之间。
        logSys(t('chat.error.generic', { text: payload.message || payload.text || '' }), true);
        store.set("fixButtonReset", true);
        closeTurn();
        setPanelMascot("error");
        break;
      case "session_terminated":
        logSys(t('chat.session.session_terminated'), true);
        closeTurn();
        setPanelMascot("idle");
        break;
      case "server.capture_request":
        //  Flow B：代理名为cam_capture。从metabar选择的快照
        //  设备并回发 client.capture_response （成功或空）。
        handleCaptureRequest(payload).catch((err) => {
          console.error("capture handler crash", err);
        });
        break;
      case "server.upload_macro_error":
        logSys(t('chat.upload.rejected', { reason: payload.reason || t('chat.error.unknown_reason') }), true);
        break;
      case "turn_complete":
        //  Inter基准测试的最终信号（代理技术转向结束）。用户界面
        //  不渲染它 - 转弯边界已经由
        //  turn_cost脚和下一个用户消息。不要剪掉刚刚开始的
        //  打字快闪短；它自己的计时器闲置。
        if (!_typingHoldT) setPanelMascot("idle");
        break;
      default:
        //  未知的 WS 事件类型 — 通常意味着后端生成了一个新的
        //  发出前端处理程序列表尚未跟上的信号，或者
        //  浏览器正在提供陈旧的缓存 llm.js。不管怎样，生的
        //  聊天日志中的 JSON 对技术人员来说毫无意义（看起来像
        //  垃圾`？ {...}` 生产中的行）。开发控制台的表面
        //  用于调试，以便聊天流保持可读。
        console.warn("[llm] unhandled WS event:", payload?.type, payload);
    }
}

//  ── 演示重播（离线）────────────────────────────────────────────────
//  当onboarding播放录制的会话时，没有实时套接字，也没有
//  真正的修复：帧直接送入handleDiagnosticFrame。这个标志告诉
//  调度程序跳过仅实时副作用（对话列表刷新）。
let _demoOffline = false;
export function setDemoOffline(on) { _demoOffline = !!on; }

//  打开聊天面板 chrome 进行重播 — 无需拨打 WebSocket。清除
//  日志+成本范围，以便记录的结果渲染成一个干净的面板。
export function openPanelForReplay() {
  resetCost();
  closeTurn();
  currentConvId = null;
  const log = el("llmLog");
  if (log) { log.innerHTML = ""; log.classList.remove("replay"); }
  updateCostTotal();
  el("llmPanel").classList.add("open");
  el("llmPanel").setAttribute("aria-hidden", "false");
  document.body.classList.add("llm-open");
  el("llmToggle").classList.add("on");
}

//  `targetConv`（可选）：“新”或现有的转换 ID。设置后，面板
//  在单个 connect() 中打开 directly — 避免
//  双连接竞赛，其中 openPanel() 首先落在活动的 conv 上，并且
//  switchConv() 然后立即重新连接到正确的那个（产生了
//  在惰性实现landing之前有无用的0转槽）。
export function openPanel(targetConv) {
  if (targetConv && targetConv !== currentConvId) {
    pendingConvParam = targetConv;
    if (ws && ws.readyState <= 1) {
      try { ws.close(); } catch (_) { /*  忽略  */ }
    }
    ws = null;
  }
  //  陈旧路线守卫：SPA 导航永远不会拆掉插座，所以活下去
  //  套接字可能仍绑定到先前的修复/设备。重复使用它会
  //  显示并发送到其他维修人员的对话。关闭+重拨。
  if (ws && ws.readyState <= 1 && wsScope
      && (wsScope.slug !== currentDeviceSlug()
          || wsScope.repairId !== (currentRepairId() || null))) {
    try { ws.close(); } catch (_) { /*  忽略  */ }
    ws = null;
  }
  el("llmPanel").classList.add("open");
  el("llmPanel").setAttribute("aria-hidden", "false");
  document.body.classList.add("llm-open");
  el("llmToggle").classList.add("on");
  if (!ws || ws.readyState === WebSocket.CLOSED) connect();
  setTimeout(() => el("llmInput").focus(), 50);
}

function closePanel() {
  el("llmPanel").classList.remove("open");
  el("llmPanel").setAttribute("aria-hidden", "true");
  document.body.classList.remove("llm-open");
  el("llmToggle").classList.remove("on");
}

//  对话时强制关闭聊天面板并拆除实时 WS
//  它指向刚刚从仪表板中删除。防止面板
//  从坐在死的 conv_id 上并尝试发送到 now-404 会话。
export function closePanelIfConv(convId) {
  if (!convId || convId !== currentConvId) return;
  _clearReconnect();
  if (ws && ws.readyState <= 1) {
    try { ws.close(); } catch (_) { /*  忽略  */ }
  }
  ws = null;
  currentConvId = null;
  if (el("llmPanel").classList.contains("open")) closePanel();
}

function togglePanel() {
  if (el("llmPanel").classList.contains("open")) closePanel();
  else openPanel();
}

function switchTier(newTier) {
  if (newTier === currentTier) return;
  //  标记为显式用户选择 — 禁用 conv_tier 自动对齐
  //  session_ready 否则适用于默认 landing。
  userPickedTier = true;
  currentTier = newTier;
  const chip = el("llmTierChip");
  if (chip) {
    chip.dataset.tier = newTier;
    const label = chip.querySelector(".tier-label");
    if (label) label.textContent = newTier.toUpperCase();
  }
  document.querySelectorAll(".llm-tier-popover button[data-tier]").forEach(btn => {
    btn.classList.toggle("on", btn.dataset.tier === newTier);
  });
  logSys(t('chat.session.tier_switch', { tier: newTier }));
  if (ws && ws.readyState <= 1) {
    try { ws.close(); } catch (_) { /*  忽略  */ }
  }
  ws = null;
  pendingConvParam = "new";  //  新tier=新对话
  connect();
}

//  当URL带有?repair=<id>时自动打开面板。调用自
//  主引导程序，以便单击主页上的修复卡可以引导用户
//  direct仅在对话中 — 无需额外点击。
export function openLLMPanelIfRepairParam() {
  const rid = currentRepairId();
  const slug = getDeviceSlug();
  if (rid && slug) {
    //  推迟一帧，这样 DOM 就肯定是有线的（openPanel 接触
    //  llmInput、llmToggle 等）并且状态栏已安装。
    requestAnimationFrame(() => openPanel());
  }
}

//  ============ 对话切换助手 ============

async function loadConversations() {
  const rid = currentRepairId();
  if (!rid) { conversationsCache = []; renderConvItems(); return; }
  try {
    const res = await fetch(API_PREFIX + `/pipeline/repairs/${encodeURIComponent(rid)}/conversations`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    conversationsCache = Array.isArray(data.conversations) ? data.conversations : [];
    renderConvItems();
  } catch (err) {
    console.warn("[llm] loadConversations failed", err);
  }
}

async function deleteConvFromPanel(convId) {
  const rid = currentRepairId();
  if (!rid || !convId) return;
  let res;
  try {
    res = await fetch(
      API_PREFIX + `/pipeline/repairs/${encodeURIComponent(rid)}/conversations/${encodeURIComponent(convId)}`,
      { method: "DELETE" },
    );
  } catch (_) {
    logSys(t('chat.conv.delete_failed'));
    return;
  }
  if (!res.ok) {
    logSys(t('chat.conv.delete_failed'));
    return;
  }
  const wasCurrent = convId === currentConvId;
  conversationsCache = conversationsCache.filter(c => c.id !== convId);

  if (wasCurrent) {
    if (ws && ws.readyState <= 1) {
      try { ws.close(); } catch (_) { /*  忽略  */ }
    }
    ws = null;
    currentConvId = null;
    const fallback = conversationsCache[0]?.id || "new";
    pendingConvParam = fallback;
    if (el("llmPanel").classList.contains("open")) {
      connect();
    }
  }
  await loadConversations();
}

function renderConvItems() {
  const list = el("llmConvList");
  const label = el("llmConvLabel");
  if (!list || !label) return;
  list.innerHTML = "";
  if (conversationsCache.length === 0) {
    label.textContent = t('chat.conv.label_empty');
    return;
  }
  const activeIdx = Math.max(0, conversationsCache.findIndex(c => c.id === currentConvId));
  label.textContent = t('chat.conv.label_count', { idx: activeIdx + 1, total: conversationsCache.length });
  conversationsCache.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "conv-item" + (c.id === currentConvId ? " active" : "");
    row.dataset.convId = c.id;
    const tier = (c.tier || "deep").toLowerCase();
    const fallbackTitle = t('chat.conv.default_title', { idx: idx + 1 });
    const title = escapeHTML((c.title || fallbackTitle).slice(0, 80));
    const cost = Number(c.cost_usd || 0);
    const ago = c.last_turn_at ? humanAgo(c.last_turn_at) : t('chat.conv.ago_unknown');
    const turnsCount = c.turns || 0;
    const turnsLabel = t(turnsCount === 1 ? 'chat.conv.turns_one' : 'chat.conv.turns_many', { n: turnsCount });

    const open = document.createElement("button");
    open.type = "button";
    open.className = "conv-item-open";
    open.innerHTML =
      `<span class="conv-item-head">` +
        `<span class="conv-item-tier t-${tier}">${tier.toUpperCase()}</span>` +
        `<span class="conv-item-title">${title}</span>` +
      `</span>` +
      `<span class="conv-item-meta">` +
        `<span>${escapeHTML(turnsLabel)}</span>` +
        `<span class="conv-item-sep">·</span>` +
        `<span>${fmtUsd(cost)}</span>` +
        `<span class="conv-item-sep">·</span>` +
        `<span>${escapeHTML(ago)}</span>` +
      `</span>`;
    open.addEventListener("click", () => {
      if (c.id === currentConvId) { closeConvPopover(); return; }
      switchConv(c.id);
      closeConvPopover();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "conv-item-delete";
    del.title = t('chat.conv.delete_aria');
    del.setAttribute("aria-label", t('chat.conv.delete_aria'));
    del.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 4h10M6.5 4V2.5h3V4M5 4l.5 9a1 1 0 001 1h3a1 1 0 001-1l.5-9"/>' +
      '<path d="M7 7v5M9 7v5"/></svg>';
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(t('chat.conv.delete_confirm'))) return;
      await deleteConvFromPanel(c.id);
    });

    row.appendChild(open);
    row.appendChild(del);
    list.appendChild(row);
  });
}

function humanAgo(iso) {
  try {
    const then = new Date(iso).getTime();
    const diff = Math.max(0, Date.now() - then) / 1000;
    if (diff < 60) return t('chat.conv.ago_seconds', { n: Math.floor(diff) });
    if (diff < 3600) return t('chat.conv.ago_minutes', { n: Math.floor(diff / 60) });
    if (diff < 86400) return t('chat.conv.ago_hours', { n: Math.floor(diff / 3600) });
    return t('chat.conv.ago_days', { n: Math.floor(diff / 86400) });
  } catch { return t('chat.conv.ago_unknown'); }
}

export function switchConv(convIdOrNew) {
  if (convIdOrNew === currentConvId) return;
  logSys(t('chat.conv.switching', { id: convIdOrNew }));
  if (ws && ws.readyState <= 1) {
    try { ws.close(); } catch (_) {}
  }
  ws = null;
  //  路由 connect() 以在重新打开时定位请求的转换。
  pendingConvParam = convIdOrNew;
  //  选择不同的转换会将tier的选择推迟回转换：其
  //  每个tier线程的活动是技术实际上意味着看到的，即使
  //  如果他们在本次会议早些时候选择了tier。 ” + 新
  //  对话”保持显式 tier 选择完好无损（没有 conv_tier
  //  无论如何都要对齐）。
  if (convIdOrNew !== "new") {
    userPickedTier = false;
  }
  connect();
}

function openConvPopover() {
  const chip = el("llmConvChip");
  const pop = el("llmConvPopover");
  if (!chip || !pop) return;
  loadConversations(); //  打开时刷新
  pop.hidden = false;
  chip.setAttribute("aria-expanded", "true");
}
function closeConvPopover() {
  const chip = el("llmConvChip");
  const pop = el("llmConvPopover");
  if (!chip || !pop) return;
  pop.hidden = true;
  chip.setAttribute("aria-expanded", "false");
}
function toggleConvPopover() {
  const pop = el("llmConvPopover");
  if (!pop) return;
  if (pop.hidden) openConvPopover(); else closeConvPopover();
}

//  ── 演示重播：对话切换器，离线────────────────────────
//  onboarding 显示正在使用的真实对话 UI — chip、
//  popover，“+ 新对话”按钮 — 这样技术人员就能看到实际情况
//  手势，而不是对其的描述。但离线时没有后端可以列出或
//  创建对话（并且 `openConvPopover` 将触发 404 泛洪获取），
//  所以这些助手驱动与实时代码完全相同的 DOM，从
//  来电者提供的化妆品清单。确定性、免费、无需网络。
export function replaySeedConversations(list) {
  conversationsCache = Array.isArray(list) ? list.slice() : [];
  //  currentConvId 驱动活动行标记 +“CONV n/total”chip 标签。
  const active = conversationsCache.find((c) => c.active);
  currentConvId = (active || conversationsCache[0] || {}).id || null;
  renderConvItems();
}
export function replayOpenConvPopover() {
  const chip = el("llmConvChip"), pop = el("llmConvPopover");
  if (!chip || !pop) return;
  renderConvItems();          //  渲染种子缓存 — 无网络获取
  pop.hidden = false;
  chip.setAttribute("aria-expanded", "true");
}
export function replayCloseConvPopover() { closeConvPopover(); }

//  从 web/llm_panel.html 获取聊天面板片段并注入
//  进入#llmRoot。将标记隔离在自己的文件中保持并行
//  处理 web/index.html，避免与聊天面板编辑发生冲突。
async function mountPanelFragment() {
  const root = el("llmRoot");
  if (!root) return false;
  if (root.childElementCount > 0) return true; //  已安装（热重装防护）
  try {
    const res = await fetch("llm_panel.html", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    root.innerHTML = await res.text();
    //  翻译新注入的标记。先等词典
    //  所以最初的绘画语言是正确的； i18n核心掉落
    //  如果缺少任何内容，请返回内联英文文本。
    if (window.i18n) {
      try {
        await window.i18n.ready;
        window.i18n.applyDom(root);
      } catch (e) { /*  保持内联后备  */ }
    }
    return true;
  } catch (err) {
    console.warn("[llm] failed to mount panel fragment:", err);
    return false;
  }
}

export async function initLLMPanel() {
  const mounted = await mountPanelFragment();
  if (!mounted) return;

  panelMascot = mountMascot(el("llmMascot"), { size: "sm", state: "idle" });

  //  在区域设置开关上重新渲染命令位（状态丸，转换chip）。
  //  静态标记由 `data-i18n` + i18n.applyDom 处理；一切
  //  从 JS 发出（状态文本、转换标签、重播日志行）需要一个
  //  显式重绘钩子。
  if (window.i18n && typeof window.i18n.onChange === "function") {
    window.i18n.onChange(() => {
      //  Conv chip（标签+项目）在每次渲染时读取本地化字符串。
      renderConvItems();
      //  状态文本 - 仅刷新当前音调的标签，因此我们不会
      //  用陈旧的“空闲”覆盖活动的“连接”。
      const statusEl = el("llmStatus");
      if (statusEl) {
        const txt = el("llmStatusText");
        if (txt && statusEl.classList.contains("connected")) {
          const slug = currentDeviceSlug();
          if (slug) txt.textContent = t('chat.status.connected', { slug, tier: currentTier });
        } else if (txt && !statusEl.classList.contains("connecting") &&
                   !statusEl.classList.contains("closed") &&
                   !statusEl.classList.contains("error")) {
          txt.textContent = t('chat.status.idle');
        }
      }
    });
  }

  el("llmToggle")?.addEventListener("click", togglePanel);
  el("llmClose")?.addEventListener("click", closePanel);
  el("llmStop")?.addEventListener("click", interruptAgent);

  //  层级 chip → popover → 切换层级。
  const tierChip = el("llmTierChip");
  const tierPopover = el("llmTierPopover");
  function openTierPopover() {
    if (!tierChip || !tierPopover) return;
    tierPopover.hidden = false;
    tierChip.setAttribute("aria-expanded", "true");
  }
  function closeTierPopover() {
    if (!tierChip || !tierPopover) return;
    tierPopover.hidden = true;
    tierChip.setAttribute("aria-expanded", "false");
  }
  function toggleTierPopover() {
    if (!tierPopover) return;
    if (tierPopover.hidden) openTierPopover(); else closeTierPopover();
  }
  tierChip?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTierPopover();
  });
  tierPopover?.querySelectorAll("button[data-tier]").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.tier;
      switchTier(t);
      closeTierPopover();
    });
  });
  document.addEventListener("click", (e) => {
    if (tierPopover && !tierPopover.hidden &&
        !tierPopover.contains(e.target) && e.target !== tierChip &&
        !tierChip?.contains(e.target)) {
      closeTierPopover();
    }
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && tierPopover && !tierPopover.hidden) {
      closeTierPopover();
    }
  });

  //  对话chip + popover。
  const convChip = el("llmConvChip");
  const convPopover = el("llmConvPopover");
  const convNew = el("llmConvNew");
  convChip?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleConvPopover();
  });
  convNew?.addEventListener("click", () => {
    switchConv("new");
    closeConvPopover();
  });
  document.addEventListener("click", (e) => {
    if (convPopover && !convPopover.hidden &&
        !convPopover.contains(e.target) && e.target !== convChip &&
        !convChip?.contains(e.target)) {
      closeConvPopover();
    }
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && convPopover && !convPopover.hidden) {
      closeConvPopover();
    }
  });

  const input = el("llmInput");
  const form = el("llmForm");

  function autoGrow() {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }
  input?.addEventListener("input", autoGrow);

  input?.addEventListener("keydown", (e) => {
    //  输入（不带 Shift）→ 提交。 Shift+Enter → 换行符（默认）。
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form?.requestSubmit();
    }
  });

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = (input?.value || "").trim();
    if (!text) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logSys(t('chat.send.socket_closed'), true);
      return;
    }
    logMessage("user", text);
    ws.send(JSON.stringify({ type: "message", text }));
    //  立即反馈：打开新的转弯并显示待处理指示器
    //  在后端产生第一个事件之前。后续tool_use /
    //  思考/消息事件通过ensureTurn()重用本回合。
    closeTurn();
    const turn = ensureTurn();
    ensurePendingNode(turn);
    setPanelMascot("thinking");
    if (input) {
      input.value = "";
      autoGrow();
    }
  });

  document.addEventListener("keydown", e => {
    //  ⌘J / Ctrl+J 切换
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
      e.preventDefault();
      togglePanel();
      return;
    }
    //  当面板聚焦时退出：如果代理处于活动状态并且已连接，则中断
    //  首先；第二个 Escape 关闭面板。
    if (e.key === "Escape" && document.body.classList.contains("llm-open")) {
      if (document.activeElement && el("llmPanel").contains(document.activeElement)) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          e.preventDefault();
          interruptAgent();
        } else {
          closePanel();
        }
      }
    }
  });

  //  --- Files+Vision：上传按钮+拖放+预览切换 --------
  const uploadBtn = el("llmUploadBtn");
  const uploadInput = el("llmUploadInput");
  const dropzone = el("llmDropzone");
  const panelEl = el("llmPanel");
  const previewBtn = el("cameraPreviewBtn");

  function syncPreviewBtn() {
    if (!previewBtn) return;
    const on = isPreviewOpen();
    previewBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  previewBtn?.addEventListener("click", async () => {
    if (isPreviewOpen()) {
      closePreview();
      syncPreviewBtn();
      return;
    }
    const id = selectedCameraDeviceId();
    if (!id) {
      logSys(t('chat.preview.select_camera_first'), true);
      return;
    }
    const ok = await openPreview(id, selectedCameraLabel());
    if (!ok) {
      logSys(t('chat.preview.open_failed'), true);
    }
    syncPreviewBtn();
  });
  syncPreviewBtn();

  uploadBtn?.addEventListener("click", () => uploadInput?.click());
  uploadInput?.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";  //  允许重新上传同一文件
    handleMacroUpload(file);
  });

  if (panelEl && dropzone) {
    let dragDepth = 0;
    panelEl.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types || !e.dataTransfer.types.includes("Files")) {
        return;
      }
      dragDepth += 1;
      dropzone.hidden = false;
    });
    panelEl.addEventListener("dragleave", () => {
      dragDepth -= 1;
      if (dragDepth <= 0) {
        dragDepth = 0;
        dropzone.hidden = true;
      }
    });
    panelEl.addEventListener("dragover", (e) => e.preventDefault());
    panelEl.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      dropzone.hidden = true;
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleMacroUpload(file);
    });
  }
}
