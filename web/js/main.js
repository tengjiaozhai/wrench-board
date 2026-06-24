// Web 应用入口。导入各功能模块（router、home、graph），
// 驱动页面生命周期：分区路由、初始渲染，以及分区无关的
// Tweaks 面板 + boardview 颜色选择器接线。

import { currentSection, navigate, wireRouter, currentSession, leaveSession, syncContextFromUrl, parseRoute, migrateLegacyUrl, repairHash } from './router.js';
import { getDeviceSlug, getRepairId } from './shared/context.js';
import { mountRepairVue } from './features/repair/workspace.js';
import { initHome, hideRepairDashboard } from './features/repair/diagnostic/dashboard.js';
import { loadGraphFromBackend, setEmptyState, initGraphWithData } from './graph.js';
import { initMemoryBank } from './memory_bank.js';
import { initProfileSection } from './profile.js';
import { initStockSection } from './stock.js';
import { initPipelineProgress } from './pipeline_progress.js';
import { initLLMPanel } from './llm.js';
import { initCameraPicker } from './camera.js';
import { updatePreviewDevice } from './camera_preview.js';
import { closeSchematicInspector } from './schematic.js?v=fitzoom';
import { initLanding, showLanding, hideLanding } from './features/global/landing/index.js';
import { hydrateOnboardingState } from './onboarding_state.js';
import { planHints } from './cloud_hints.js';
import { mountMascot } from './mascot.js';
import { sendDiagnostic } from './services/diagnosticSocket.js';
import { sendCapabilities } from './features/repair/diagnostic/filesVision.js';
import * as Protocol from './protocol.js?v=quest4';

// 记录 graph 已为哪个 device slug 挂载。防止重新导航到 #graphe 时
// 再次调用 initGraphWithData() — 该函数会启动 d3 力导向模拟与
// requestAnimationFrame 循环，重新进入时不会自行销毁。
let _graphLoadedSlug = null;

async function maybeLoadGraph() {
  const slug = getDeviceSlug();
  if (!slug) {
    setEmptyState(true);
    return;
  }
  if (slug === _graphLoadedSlug) return;  // 此 slug 已挂载
  // 若画布当前隐藏（如用户落在 Brut 模式），clientWidth 为 0 —
  // layoutNodes + fitToScreen 会算出无意义位置并固化。跳过 init 且
  // 不标记 slug 已加载，待画布可见后下次调用重试。
  const canvasEl = document.getElementById("canvas");
  if (!canvasEl || canvasEl.clientWidth === 0) return;
  const fetched = await loadGraphFromBackend();
  if (fetched && fetched.nodes && fetched.nodes.length > 0) {
    setEmptyState(false);
    initGraphWithData(fetched);
    _graphLoadedSlug = slug;
  } else {
    setEmptyState(true);
  }
}

// 路由驱动的副作用分发 — 为解析后的路由挂载数据/视图。
// 全局路由加载对应分区；repair 路由委托工作区壳
//（features/repair/workspace.js）按 vue 顺序加载。活跃 device/repair
// 上下文已在 store 中（上游 await syncContextFromUrl）。
async function mountRoute(route) {
  if (route.level === "global") {
    if (route.name === "stock") initStockSection();
    else if (route.name === "profile") initProfileSection();
    else if (route.name === "home") {
      // #home 为全局首页 = landing 遮罩（侧栏列出所有 repair）。
      // showLandingNow / hashchange 处理器控制可见性；此处仅隐藏 repair 仪表盘。
      hideRepairDashboard();
    }
    // landing：遮罩由 show/hideLanding 处理；此处无需挂载。
    return;
  }
  await mountRepairVue(route, { maybeLoadGraph });
}

// 早期桩：在 brd_viewer 挂载并替换为真实实现前，将 boardview.* 事件
// 收集到 __pending。否则技师导航到 #pcb 前发送的事件会静默丢失。
if (!window.Boardview) {
  window.Boardview = {
    __pending: [],
    apply(ev) { this.__pending.push(ev); },
  };
}

/* ---------- 初始化 ---------- */
(async function bootstrap() {
  // 任何模块渲染动态字符串前等待 i18n 词典就绪。
  if (window.i18n && window.i18n.ready) await window.i18n.ready;
  // Profile 为用户语言与一次性 onboarding 标志（跨设备）的权威来源。
  // localStorage 仅为绘制提示 / 预门控缓存。在此启动单次 /profile 水合
  // 与下方 init 并行；路由前 await，使同步 onboarding 门控看到服务端真相
  // 而非新设备上的空 localStorage。
  const _profileHydrated = hydrateOnboardingState().then((env) => {
    const pref = env?.profile?.preferences?.language;
    if (pref && pref !== window.i18n.locale && window.i18n.SUPPORTED.includes(pref)) {
      return window.i18n.setLocale(pref);
    }
  }).catch(() => {});
  mountMascot(document.getElementById("brandMascot"), { size: "xs", state: "idle" });
  // 托管版：cloud 前门注入 window.__wbPlanHints。将 wordmark 切换为
  // "WrenchBoardCloud"（body.wb-hosted 下 "Cloud" 后缀 + 云朵揭示）；自托管保持 "WrenchBoard"。纯 UI。
  if (planHints()) document.body.classList.add("wb-hosted");
  wireRouter({ maybeLoadGraph });
  syncContextFromUrl();   // Phase C.1：任何视图挂载前将 store.device/repair 填入 store
  initHome();             // 接线仪表盘区域刷新（D.2 已移除新建 repair 弹窗）
  initMemoryBank();
  initPipelineProgress();
  await initLLMPanel();
  // 注意：聊天面板由 mountRoute 的 diagnostic 分支在
  // `await syncContextFromUrl()` 解析 slug 后自动打开 — 非此处急切打开
  //（深链/刷新 #repair/<id>/diagnostic 时 store 仍为空，C11）。

  // Files+Vision：LLM 面板头部的摄像头选择器。变更时：
  //   - 经 client.capabilities 通知诊断 WS（门控 cam_capture）
  //   - 若预览窗口已打开则切换其流
  initCameraPicker((deviceId, label) => {
    sendCapabilities();
    updatePreviewDevice(deviceId, label);
  });

  // Protocol 模块 — 用延迟 send 初始化，调用时读取实时 WS
  //（套接字由 llm.js 在首次打开面板时惰性建立）。
  // llm.js + chatLog.js 直接导入同一 ./protocol.js?v=quest4 模块，
  // 故此 init() 接线与它们共享（每个 URL 的 ESM 单实例）。
  Protocol.init({
    send: (payload) => sendDiagnostic(payload),
    hasBoard: !!window.Boardview?.hasBoard?.(),
  });

  // Landing — 初始化监听器；路由决定是否显示（见下方）。
  // Stock 现为普通全局目的地（#stock），非 tool 模式。
  initLanding();

  // 将遗留 URL（?device=&repair=#section、?tool=stock、裸
  // #memory-bank/#graphe）就地迁移为新语法，再在挂载任何视图前
  // 将路由的 device/repair 解析进 store。
  migrateLegacyUrl();
  await syncContextFromUrl();
  // 在 showLanding() / mountRoute() 运行其同步一次性门控前
  // 确保服务端 onboarding 标志已加载（landing 导览 + 首次诊断辅导）。
  await _profileHydrated;

  // Landing 即全局首页（Phase D.1）：在 #home 与 #landing 显示（裸加载时
  // parseRoute 返回 global "home"）。 #stock/#profile 隐藏；repair 路由挂载仪表盘。
  // landing 侧栏列出所有 repair，不再有独立日志网格。
  const route = parseRoute();
  const showLandingNow = route.level === "global"
    && (route.name === "home" || route.name === "landing");
  if (showLandingNow) showLanding(); else hideLanding();
  // 预绘制门控（index.html）可能用 `pending-landing` 遮住 chrome；
  // show/hideLanding 已生效后移除，以便 chrome 绘制（别处不再移除）。
  document.body.classList.remove("pending-landing");

  // Landing 右上角「Stock」链接 → 全局 #stock 目的地。
  const __stockLink = document.getElementById("landingStockLink");
  if (__stockLink) {
    __stockLink.addEventListener("click", (ev) => {
      ev.preventDefault();
      window.location.hash = "#stock";
    });
  }

  navigate(currentSection());
  await mountRoute(route);

  // 原理图检查器关闭按钮 — 接线一次，缺失时安全跳过。
  document.getElementById("schInspClose")?.addEventListener("click", closeSchematicInspector);

  // 单一 hashchange 所有者（router.js 不再在 hashchange 上导航）：
  // 重新推导路由、重新同步上下文（可能解析 slug）、重新挂载。
  window.addEventListener("hashchange", async () => {
    migrateLegacyUrl();
    await syncContextFromUrl();
    const r = parseRoute();
    if (r.level === "global" && (r.name === "home" || r.name === "landing")) showLanding(); else hideLanding();
    navigate(currentSection());
    await mountRoute(r);
  });
})();

/* 在顶层接线分区无关的顶栏控件，无论 graph init（及其历史上
   包裹这些处理器的函数）是否运行都可访问。涵盖 Tweaks 面板
   开/关按钮及面板内 boardview 颜色选择器。
   脚本位于 </body> 末尾，立即运行而非等待 DOMContentLoaded（可能已触发）。 */
(function wireTopLevelControls() {
  // ---- Tweaks 面板开/关（先前在 initGraphWithData 内接线，
  // 因此在 #home / #pcb 等分区从未绑定） ----
  const tweaksPanelEl  = document.getElementById("tweaksPanel");
  const tweaksToggleEl = document.getElementById("tweaksToggle");
  const tweaksCloseEl  = document.getElementById("tweaksClose");
  // 从当前已加载板卡刷新各颜色行旁的 pin 数量 pill。面板打开时调用
  //（板卡可能在面板关闭时被替换），每次改色后也调用（纯 UI — 数量
  // 不随颜色变，但足够便宜以保持路径一致）。
  const refreshPinCounts = () => {
    const counts = (window.Boardview && window.Boardview.getPinCounts && window.Boardview.getPinCounts()) || null;
    document.querySelectorAll('[data-cat-count]').forEach(span => {
      const cat = span.dataset.catCount;
      span.textContent = counts && counts[cat] != null ? counts[cat] : '';
    });
  };
  if (tweaksPanelEl && tweaksToggleEl) {
    tweaksToggleEl.addEventListener("click", () => {
      tweaksPanelEl.classList.toggle("show");
      if (tweaksPanelEl.classList.contains("show")) refreshPinCounts();
    });
  }
  if (tweaksPanelEl && tweaksCloseEl) {
    tweaksCloseEl.addEventListener("click", () => tweaksPanelEl.classList.remove("show"));
  }

  // ---- Boardview 颜色选择器 ----
  // `input` 监听器可立即附加 — <input type="color"> 节点已在 DOM。
  // 但同步初始值依赖 `window.getBoardviewColors`（由 body 末尾的
  // 经典脚本 pcb_viewer.js 定义），故在 DOMContentLoaded 后执行初始同步。
  const paintDot = (row, hex) => {
    const dot = row && row.querySelector('.brd-color-dot');
    if (!dot || !hex) return;
    dot.style.background = hex;
    dot.style.boxShadow = `0 0 6px ${hex}`;
  };
  // 按 `data-cat` 索引的每类 Pickr 实例。在 Pickr 库与
  // pcb_viewer.js 的 `getBoardviewColors` 均就绪时惰性构建 —
  // Pickr 以非 defer CDN 脚本加载，通常先于本代码，但仍轮询以防万一。
  const pickrByCategory = {};
  const buildPickrs = () => {
    if (typeof Pickr === 'undefined') return false;
    const current = (window.getBoardviewColors && window.getBoardviewColors()) || {};
    document.querySelectorAll('.brd-color-row .brd-color-dot[data-cat]').forEach(dot => {
      const cat = dot.dataset.cat;
      if (pickrByCategory[cat]) return;
      const initial = current[cat] || '#a9b6cc';
      paintDot(dot.closest('.brd-color-row'), initial);
      const pickr = Pickr.create({
        el: dot,
        theme: 'classic',
        useAsButton: true,         // dot 本身为触发器
        default: initial,
        defaultRepresentation: 'HEX',
        appClass: 'brd-pickr',     // 命名空间供日后调整
        position: 'left-middle',   // 弹出层在面板左侧打开（面板钉在右侧）以保持在屏内
        components: {
          preview: true,
          opacity: false,
          hue: true,
          // `clear` 将该行恢复为解析时默认值。对 `boardFill` 尤其有用 —
          // 默认为 bg-deep，clear ==「无填充」（基材再次不可见）。
          // 用户仅想撤销一行时无需单独「重置颜色」。
          interaction: { hex: true, rgba: false, input: true, save: false, clear: true },
        },
      });
      pickr.on('change', (color) => {
        const hex = color.toHEXA().toString().slice(0, 7);  // 去掉 alpha
        window.setBoardviewNetColor?.(cat, hex);
        paintDot(dot.closest('.brd-color-row'), hex);
      });
      pickr.on('clear', () => {
        const defaults = (window.getBoardviewColorDefaults && window.getBoardviewColorDefaults()) || {};
        const defaultHex = defaults[cat];
        if (!defaultHex) return;
        window.setBoardviewNetColor?.(cat, defaultHex);
        paintDot(dot.closest('.brd-color-row'), defaultHex);
        pickr.setColor(defaultHex, true);
      });
      pickrByCategory[cat] = pickr;
    });
    return true;
  };
  const syncInputs = () => {
    const current = (window.getBoardviewColors && window.getBoardviewColors()) || {};
    document.querySelectorAll('.brd-color-row .brd-color-dot[data-cat]').forEach(dot => {
      const cat = dot.dataset.cat;
      const hex = current[cat];
      if (!hex) return;
      paintDot(dot.closest('.brd-color-row'), hex);
      if (pickrByCategory[cat]) {
        pickrByCategory[cat].setColor(hex, /* 静默 */ true);
      }
    });
    refreshPinCounts();
  };
  document.getElementById("brdColReset")?.addEventListener("click", () => {
    window.resetBoardviewColors?.();
    syncInputs();
  });
  // 在构建选择器并水合初始颜色前等待 Pickr + pcb_viewer.js 的 window.getBoardviewColors。
  let tries = 0;
  const init = () => {
    if (typeof Pickr !== 'undefined' && window.getBoardviewColors) {
      buildPickrs();
      syncInputs();
      return;
    }
    if (++tries < 60) requestAnimationFrame(init);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // 会话 pill — 点击主体进入活跃 repair 的仪表盘，点击 [×] 退出。
  // 二级语法下 #home 为全局列表，故 pill 须在活跃 repair 时指向
  // #repair/<id>/diagnostic（C6）。
  const sessionPill = document.getElementById("sessionPill");
  const sessionPillClose = document.getElementById("sessionPillClose");
  const gotoSessionDashboard = () => {
    const id = getRepairId();
    window.location.hash = id ? repairHash(id, "diagnostic") : "#home";
  };
  if (sessionPill) {
    sessionPill.addEventListener("click", (ev) => {
      if (sessionPillClose && sessionPillClose.contains(ev.target)) return;
      gotoSessionDashboard();
    });
    sessionPill.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        if (sessionPillClose && sessionPillClose.contains(document.activeElement)) return;
        gotoSessionDashboard();
      }
    });
  }
  if (sessionPillClose) {
    sessionPillClose.addEventListener("click", (ev) => {
      ev.stopPropagation();
      leaveSession();
    });
  }
})();
