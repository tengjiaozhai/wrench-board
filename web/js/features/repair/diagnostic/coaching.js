//  第一-diagnostic辅导 — 修复workspace一次性导览，
//  第一次播放diagnostic仪表板打开（由
//  profile 的 `state.first_diag_seen` 标志 — 服务器端，因此，它是跨设备的 —
//  通过onboarding_state.js，其中localStorage作为fast预门）。与静态卡不同，这个走在
// real 表面按工作流程顺序，带有 anchored mascot bubbles，实际上
// 导航 rail 视图 (PCB / schematic / graph)，以便技术人员看到每个视图
// 上下文中的页面change — closing“被遗弃在repair screen”间隙。
//
//  声调：小圆盘reet mascot 伴奏bubbles（与
//  landingonboarding），但密集的专业工作台在其他方面未出行。每一个
// 步骤是可以逃避的（“跳过游览”）并且整个 thing 播放一次。
//
//  持久的、可重玩的答案是“？”仪表板的供应性
//  header → openInfoModal("repair") (在dashboard.js中连接);该模块拥有
// 仅在首次运行时编写脚本。样式 re 使用 .mascot-bubble + .ob-*
//  网页/样式/onboarding.css; mascot主机是.ob-coach-mascot。

import { t } from "../../../i18n.js";
import { mountMascot, setMascotState } from "../../../mascot.js";
import { showBubble, hideBubble } from "../../../mascot_bubble.js";
import { repairHash } from "../../../router.js";
import { hasSeenOnboarding, markOnboardingSeen } from "../../../onboarding_state.js";

//  在发货的演示设备上，观看的是“实时”的：它的亮点是真实组件
// 在 board 和 pre 上 - 用 concrete quest离子填充聊天，因此值为
// 显示而不是描述。在 slug 上进行门控 — real 设备获得简单信息
// 旅游。 U14是MNT改革的备用-3V3re调节器（railLPC_VCC），第一个
// 当您探测 when 时，board 无法开机。
const DEMO_SLUG = "mnt-reform-motherboard";
const DEMO_HIGHLIGHT_REFDES = "U14";

let _running = false;   //  重新尝试保护（renderRepairDashboardre-在导航上运行）
let _forceNext = false; // 一键绕过：尽管有 seen 标志，replay 仍进行一次游览
let _aborted = false;   // 设置 when 技术 hits“跳过游览”
let _wasDemo = false;   // true while demo（示例）巡演正在播放
let _onDone = null;     // 可选的完成挂钩（示例设备切换）
let _mascot = null;     //  安装⟦0已⟧ <svg>
let _mascotHost = null; //  固定位置宿主元素

function _mountMascot() {
  _mascotHost = document.createElement("div");
  _mascotHost.className = "ob-coach-mascot";
  _mascotHost.setAttribute("aria-hidden", "true");
  document.body.appendChild(_mascotHost);
  _mascot = mountMascot(_mascotHost, { size: "sm", state: "idle" });
}

// 将 workspace 切换到 repair vue，并在re实际位于 screen 上时进行求解。
//  导航是async（main.js拥有hashchange→syncContextFromUrl→导航），
// 所以我们轮询 rail 的活动状态 — re 可靠的“navigate() 完成”信号
// — then 等待 frame，目标部分已绘制。解决re无忧无虑
// 截止日期很短，因此旅行团永远不会错过错过的信号。
function _navTo(rid, vue) {
  window.location.hash = repairHash(rid, vue);
  return new Promise((resolve) => {
    const sel = `.rail-btn[data-rail="${vue}"][data-rail-level="repair"]`;
    const tick = (tries) => {
      const btn = document.querySelector(sel);
      if (btn && btn.classList.contains("active")) {
        requestAnimationFrame(() => resolve());
        return;
      }
      if (tries <= 0) { resolve(); return; }
      setTimeout(() => tick(tries - 1), 60);
    };
    tick(25); // ~1.5 秒上限
  });
}

// 显示 bubble 和 re 解决en 的技术进步。 “跳过游览”套装
// _aborted 和 re 也解决了——调用者检查标志并撕掉。
function _step({ anchor, text, placement = "bottom", mascot = "idle", last = false, doneLabel = null, spotlight = false }) {
  if (_mascot) setMascotState(_mascot, mascot);
  return new Promise((resolve) => {
    showBubble({
      anchor: typeof anchor === "string" ? document.querySelector(anchor) : anchor,
      placement,
      text,
      spotlight,
      nextLabel: last ? (doneLabel || t("onboarding.coach.done")) : t("onboarding.next"),
      skipLabel: t("onboarding.coach.skip"),
      next: () => resolve(),
      skip: () => { _aborted = true; resolve(); },
    });
  });
}

// 武装一次workspace巡演的replay，忽略持续存在的“seen”
//  下一个仪表板渲染的标志。由 landing onboarding 的“参见
// 例如“交接，因此 demo 巡演为一位ready 看到的技术人员播放 even。
export function forceNextDiagCoaching() {
  _forceNext = true;
}

export async function maybeShowFirstDiagCoaching(rid, { onDone = null, slug = null } = {}) {
  if (_running) return;
  if (_forceNext) {
    _forceNext = false; // 消耗一次性旁路
  } else if (hasSeenOnboarding("first_diag_seen")) {
    return; //  已游览（服务器真相；localStorage后备预水合作用）
  }

  const isDemo = slug === DEMO_SLUG; //  现场巡演（精彩集锦+预聊天）
  _wasDemo = isDemo;
  _onDone = onDone; // 由示例设备切换中的 dashboard.js fr 转发
  _running = true;
  _aborted = false;
  _mountMascot();

  const cancelled = () => _aborted || !document.body.contains(_mascotHost);

  //  ── 第一阶段：diagnostic仪表板（当前视图）────────────────────
  await _step({ anchor: ".rd-head", text: t("onboarding.coach.session"), placement: "bottom", mascot: "success", spotlight: true });
  if (cancelled()) return finishFirstDiagCoaching();
  await _step({ anchor: "#rdCap", text: t("onboarding.coach.cap"), placement: "bottom", mascot: "scanning", spotlight: true });
  if (cancelled()) return finishFirstDiagCoaching();
  await _step({ anchor: "#rdCards", text: t("onboarding.coach.cards"), placement: "top", mascot: "idle", spotlight: true });
  if (cancelled()) return finishFirstDiagCoaching();

  // ── 第二阶段：遍历rail视图（页面实际上是change）──────────────
  // Anchored 到每个 rail 按钮（最左侧），因此箭头将“this 按钮→
  // this 页面”。跳过批发 when re 没有 repair id 进行导航。
  if (rid) {
    const railSel = (vue) => `.rail-btn[data-rail="${vue}"][data-rail-level="repair"]`;
    //  schematic 和 graph expos 都不是程序化 mmatic select API — 两者都不是
    // are D3 带有鼠标处理程序 — 因此 demo 通过 dispatching a real 驱动它们
    // 节点 element 上的click（请参阅视图的 .on("click") 处理程序）。
    const synthClick = (elOrSel) => {
      const el = typeof elOrSel === "string" ? document.querySelector(elOrSel) : elOrSel;
      if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return !!el;
    };
    const waitForEl = (sel, ms = 4000) => new Promise((res) => {
      const t0 = Date.now();
      const tick = () => {
        const e = document.querySelector(sel);
        if (e) return res(e);
        if (Date.now() - t0 > ms) return res(null);
        setTimeout(tick, 80);
      };
      tick();
    });

    //  ── PCB — 点亮真实元件，使气泡指向某个具体的东西。
    await _navTo(rid, "pcb");
    if (cancelled()) return finishFirstDiagCoaching();
    if (isDemo) {
      try { window.Boardview?.apply?.({ type: "boardview.highlight", refdes: DEMO_HIGHLIGHT_REFDES }); } catch { /* 尽最大努力 */ }
    }
    await _step({ anchor: railSel("pcb"), text: t(isDemo ? "onboarding.coach.demo_pcb" : "onboarding.coach.pcb"), placement: "right", mascot: "idle" });
    if (cancelled()) return finishFirstDiagCoaching();

    //  ── 原理图 — 在 demo 中，点击 LPC_VCC rail（后备 U14）上，所以
    // 技术人员看到schematic隔离了rail及其级联，而不仅仅是听说过。
    await _navTo(rid, "schematic");
    if (cancelled()) return finishFirstDiagCoaching();
    if (isDemo) {
      await waitForEl("#schLayerNodes g.sch-node");
      synthClick('g.sch-node[data-rail="LPC_VCC"]') || synthClick('g.sch-node[data-refdes="U14"]');
    }
    await _step({ anchor: railSel("schematic"), text: t(isDemo ? "onboarding.coach.demo_schematic" : "onboarding.coach.schematic"), placement: "right", mascot: "idle" });
    if (cancelled()) return finishFirstDiagCoaching();

    // ── Graph（内存）——在demo、click节点上所以右侧细节面板
    // opens（“如何reasons”面板），then 翻转到“原始”选项卡以显示
    // 底层内存，thenrestore视觉。
    await _navTo(rid, "graph");
    if (cancelled()) return finishFirstDiagCoaching();
    if (isDemo) {
      await waitForEl("#layerNodes g.node");
      synthClick(
        document.querySelector("#layerNodes g.node.type-symptom") ||
        document.querySelector("#layerNodes g.node.type-action") ||
        document.querySelector("#layerNodes g.node"),
      );
      await _step({ anchor: railSel("graph"), text: t("onboarding.coach.demo_graph"), placement: "right", mascot: "scanning" });
      if (cancelled()) return finishFirstDiagCoaching();
      const rawBtn = document.querySelector('.view-toggle-btn[data-view="md"]');
      if (rawBtn) {
        synthClick(rawBtn);                                               // 翻转到原始
        await _step({ anchor: railSel("graph"), text: t("onboarding.coach.demo_graph_raw"), placement: "right", mascot: "idle" });
        synthClick('.view-toggle-btn[data-view="graph"]');               // re斯托re视觉
      }
      //  #inspector 是一个全局 <aside> （#canvas 的同级） — left .open 它会
      // 坚持所有其他观点。在re离开graph之前Close它。
      synthClick("#inspectorClose");
      if (cancelled()) return finishFirstDiagCoaching();
    } else {
      await _step({ anchor: railSel("graph"), text: t("onboarding.coach.graph"), placement: "right", mascot: "scanning" });
      if (cancelled()) return finishFirstDiagCoaching();
    }

    //  返回关闭步骤的diagnostic仪表板。
    await _navTo(rid, "diagnostic");
    if (cancelled()) return finishFirstDiagCoaching();
  }

  //  ── 第三阶段：如何实际诊断──────────────────────────────────────
  // 在 demo、open 聊天和 pre 上填充一个 concrete question，以便技术人员可以
  //  发送并查看这个真实上的代理原因，分析板 — 值
  // 显示出来，而不仅仅是描述。 （Sending是他们的选择；旅行永远不会sends。）
  if (isDemo) {
    // 坐在 PCB 视图上，以便 agent 的 board 注释 are 可见，then
    //  重播两个真实录制的Opus(deep)个小节拍片段，
    // 每个人都在解释器bubble上暂停，并以“下一步”前进。 Free — 没有直播
    // LLM 电话。 CONV 1 = 在 board 上绘制的器件上电序列ence；
    //  CONV 2（在真正的“新对话”之后）=“死板”
    //  diagnostic 运行测量协议结果供应量为
    //  注释很健康。固定装置按区域设置（fr/en）；回落到fr。
    await _navTo(rid, "pcb");
    if (cancelled()) return finishFirstDiagCoaching();
    await _step({ anchor: "#llmToggle", text: t("onboarding.coach.demo_chat"), placement: "left", mascot: "idle", doneLabel: t("onboarding.coach.demo_play") });
    if (cancelled()) return finishFirstDiagCoaching();
    hideBubble();
    const { loadRecvFrames, beginDemoReplay, playFrames, endDemoReplay, waitForBoard } = await import("./demoReplay.js");
    // 对话切换器直接在驱动en离线（无返回end）
    // real 聊天面板 DOM，因此技术人员看到的是实际的手势re，而不是标题。
    const { handleDiagnosticFrame, replaySeedConversations, replayOpenConvPopover, replayCloseConvPopover } = await import("../../../llm.js");
    const loc = (window.i18n && window.i18n.locale) || "fr";
    const grab = async (name) => {
      let f = await loadRecvFrames(`/demos/${name}.${loc}.json`);
      if (!f.length && loc !== "fr") f = await loadRecvFrames(`/demos/${name}.fr.json`);
      return f;
    };
    const conv1 = await grab("hero-conv1");
    const conv2 = await grab("hero-conv2");
    if (conv1.length && conv2.length) {
      await waitForBoard(); // 箭头+注释通过board相机投射；等一下

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cue = (sel, on) => { const e = document.querySelector(sel); if (e) e.classList.toggle("wb-demo-cue", on); };
      const clearCues = () => { cue("#llmConvChip", false); cue("#llmConvNew", false); };
      const bail = () => { clearCues(); try { replayCloseConvPopover(); } catch { /* 不操作en */ } endDemoReplay(); finishFirstDiagCoaching(); };
      // Cosmetic 对话行离线切换器 renders（镜像
      //  实时`conversations`支付负载形状：id/title/tier/turns/cost/last saw）。
      const convRow = { id: "demo-conv-1", title: t("onboarding.coach.demo_conv1_title"), tier: "deep", turns: 1, cost_usd: 0.86, last_turn_at: new Date(Date.now() - 90_000).toISOString() };

      //  ── CONV 1：上电序列，板上电位差 ──
      beginDemoReplay({ userText: t("onboarding.coach.demo_q1") });
      await playFrames(conv1.slice(0, 28), { gapCapMs: 550 });   //  重新广告schematic图+组件
      if (cancelled()) return bail();
      await _step({ anchor: _mascotHost, text: t("onboarding.coach.demo_c1_explore"), placement: "top", mascot: "scanning" });
      if (cancelled()) return bail();
      await playFrames(conv1.slice(28, 55), { gapCapMs: 320 });  // 绘制级联（highlights、注释、箭头）
      if (cancelled()) return bail();
      await _step({ anchor: _mascotHost, text: t("onboarding.coach.demo_c1_board"), placement: "top", mascot: "working" });
      if (cancelled()) return bail();
      await playFrames(conv1.slice(55, 58), { gapCapMs: 400 });  // 分阶段解释
      if (cancelled()) return bail();
      await _step({ anchor: _mascotHost, text: t("onboarding.coach.demo_c1_done"), placement: "top", mascot: "success" });
      if (cancelled()) return bail();

      // ── 插曲：现场real“新对话”手势reUI（线下）──
      //  解释者气泡（z-index 1600）位于对话上方popover
      // （z-index 40），所以它必须在 re popover opens 之前被驳回 - 否则它
      // hi正是我们re所展示的姿态re。先解释一下(popoverclosed),
      // en 演奏手势re silent — 一旦en，这是不言而喻的en。
      replaySeedConversations([{ ...convRow, active: true }]); // chip 现在 re 广告转化次数 1/1
      await _step({ anchor: "#llmConvChip", text: t("onboarding.coach.demo_switch"), placement: "left", mascot: "idle" });
      if (cancelled()) return bail();
      hideBubble();
      cue("#llmConvChip", true); await sleep(550);
      if (cancelled()) return bail();
      replayOpenConvPopover();                               //  real popover 打开 — 种子列表显示
      cue("#llmConvChip", false); await sleep(850);
      if (cancelled()) return bail();
      cue("#llmConvNew", true); await sleep(800);            // 重点关注“+新对话”控件
      if (cancelled()) return bail();
      replaySeedConversations([
        { id: "demo-conv-2", title: t("onboarding.coach.demo_new_conv_title"), tier: "deep", turns: 0, cost_usd: 0, last_turn_at: new Date().toISOString(), active: true },
        convRow,
      ]);
      await sleep(900); cue("#llmConvNew", false);           // 保留refr网格列表re广告
      replayCloseConvPopover(); await sleep(400);
      if (cancelled()) return bail();

      // fresh 对话必须从 CLEAN 开始。 replay 跳过列表
      //  protocol_cleared 和 beginDemoReplay 主要聊天日志，因此 CONV 1 的
      //  板overlays + 协议向导否则会渗入 CONV 2。
      //  Reset() 清除板overlay；一个directprotocol_clearednulls
      //  state.proto（也no-opsanytrailingprotocol_updated - 没有僵尸向导）。
      try { window.Boardview?.reset?.(); } catch { /*  板尚未准备好  */ }
      handleDiagnosticFrame({ type: "protocol_cleared" });
      await sleep(450);                                      // 让board在re新的quest离子之前明显为空

      //  ── CONV 2：“死板”diagnostic — 协议，测量，缩放──
      // 切成小节拍（每个节拍一条或两条消息），以便技术人员可以
      // 实际上遵循它——否则agent是一个很长的独白。每个节拍
      // 在re播放下一个块之前暂停在bubble。
      beginDemoReplay({ userText: t("onboarding.coach.demo_q2") });
      await playFrames(conv2.slice(0, 29), { gapCapMs: 550 });   // 探索res，验证refdes，列出re推理
      if (cancelled()) return bail();
      await _step({ anchor: _mascotHost, text: t("onboarding.coach.demo_c2_diag"), placement: "top", mascot: "working" });
      if (cancelled()) return bail();
      await playFrames(conv2.slice(29, 53), { gapCapMs: 450 });  // 绘制链条+道具os是6步protocol
      if (cancelled()) return bail();
      await _step({ anchor: _mascotHost, text: t("onboarding.coach.demo_c2_protocol"), placement: "top", mascot: "working" });
      if (cancelled()) return bail();
      await playFrames(conv2.slice(53, 66), { gapCapMs: 500 });  // 冷测试：F1连续性+VIN→GND短
      if (cancelled()) return bail();
      await _step({ anchor: _mascotHost, text: t("onboarding.coach.demo_c2_cold"), placement: "top", mascot: "scanning" });
      if (cancelled()) return bail();
      await playFrames(conv2.slice(66, 75), { gapCapMs: 500 });  //  电源红色：24 V 输入
      if (cancelled()) return bail();
      await _step({ anchor: _mascotHost, text: t("onboarding.coach.demo_c2_power"), placement: "top", mascot: "scanning" });
      if (cancelled()) return bail();
      await playFrames(conv2.slice(75, 95), { gapCapMs: 450 });  // VIN 健康 → 将嫌疑人转向 U14
      if (cancelled()) return bail();
      await _step({ anchor: _mascotHost, text: t("onboarding.coach.demo_c2_u14"), placement: "top", mascot: "working" });
      if (cancelled()) return bail();
      await playFrames(conv2.slice(95, 120), { gapCapMs: 450 }); //  LPC_VCC = 3.3V → 扭曲
      if (cancelled()) return bail();
      await _step({ anchor: _mascotHost, text: t("onboarding.coach.demo_c2_verdict"), placement: "top", mascot: "success", last: true, doneLabel: t("onboarding.coach.demo_done") });
      clearCues();
      endDemoReplay();
    }
  } else {
    await _step({ anchor: "#llmToggle", text: t("onboarding.coach.chat"), placement: "bottom", mascot: "working", last: true });
  }
  finishFirstDiagCoaching();
}

// 确实hi如果首轮巡回赛正在进行或仍然欠款（标志未设置）。来电者
// 在游览过程中使用 this 阻止竞争表面——尤其是聊天
// 面板自动操作en，所以早期的bubble（标题/功能/卡片）aren't
// 海湾red。巡演的 closing 步骤将聊天切换处的技术指向 open
// 它自己。
export function firstDiagTourPending() {
  if (_running || _forceNext) return true;
  return !hasSeenOnboarding("first_diag_seen");
}

export function finishFirstDiagCoaching() {
  hideBubble();
  // 安全net：如果技术人员在游览中途跳过，则会出现由demo 操作的详细面板en
  //  合成点击量（图#inspector是全局旁白；schematic#schInspector）
  // 否则将保留 open acros 的视图。 Close 两者。
  try {
    document.getElementById("inspector")?.classList.remove("open");
    document.getElementById("schInspector")?.classList.remove("open");
  } catch { /* 尽最大努力 */ }
  if (_mascotHost) { _mascotHost.remove(); _mascotHost = null; _mascot = null; }
  markOnboardingSeen("first_diag_seen"); //  服务器（跨设备）+localStorage服务器
  _running = false;
  // Fire 最后是完成钩子，在拆解 + 标志之后，因此切换调用者
  //  （landingonboarding，通过window.__wbExampleTourOnDone）重新干净利落。
  const cb = _onDone; _onDone = null;
  const wasDemo = _wasDemo; _wasDemo = false;
  if (typeof cb === "function") {
    cb();
  } else if (wasDemo) {
    // “好吧，轮到我了”/跳过 / direct-open 没有 landing 切换的示例：
    // 留下re仅限广告的示例workspace，而不是将技术搁置在其上。
    try { window.location.hash = "#landing"; } catch { /* 尽最大努力 */ }
  }
}
