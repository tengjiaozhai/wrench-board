//  SVG/D3 brd_viewer.js 调用面之间的桥梁
//  (window.initBoardview, window.Boardview) 和 WebGL 查看器
//  pcb_viewer.js。在 brd_viewer.js 之后加载，因此其覆盖生效。
//
//  本机集成：画布+信息面板+统计数据是静态的
//  放置在 web/index.html 的 data-section-stub="pcb" 部分下。
//  我们只是在第一次导航到 PCB 时实例化 PCBViewerOptimized，
//  然后在每个后续导航/引脚上调用viewer.loadBoard()
//  开关。

import { getDeviceSlug } from "./shared/context.js";
import { API_PREFIX } from "./shared/api.js";

let viewer = null;
let boardPayload = null;
let _refdesMap = null;
let _netSet = null;
//  跟踪当前加载的 slug 以便导航离开和返回
//  (#pcb → #home → #pcb) 不会重新获取有效负载 + 重新触发 XZZ
//  每InstancedMesh解密+重建。
let _loadedSlug = null;

function resolveSlug() {
  return getDeviceSlug()
      || new URLSearchParams(window.location.search).get("board")
      || null;
}

function rebuildIndexes(payload) {
  _refdesMap = new Map();
  for (const c of payload.components || []) _refdesMap.set(c.id, c);
  _netSet = new Set();
  for (const p of payload.pins || []) {
    if (p.net && p.net !== "NC") _netSet.add(p.net);
  }
}

async function fetchPayload(slug) {
  const url = API_PREFIX + `/api/board/render?slug=${encodeURIComponent(slug)}`;
  console.log("[pcb_viewer_bridge] fetching", url);
  const res = await fetch(url, { cache: "no-store" });
  console.log("[pcb_viewer_bridge] render status", res.status);
  if (!res.ok) return null;
  const payload = await res.json();
  console.log(
    "[pcb_viewer_bridge] payload",
    payload.format_type,
    payload.components_count,
    "parts /",
    payload.pins_count,
    "pins"
  );
  return payload;
}

async function ensureViewerAndLoad(slug) {
  const payload = await fetchPayload(slug);
  if (!payload) return false;

  if (typeof THREE === "undefined") {
    console.error("[pcb_viewer_bridge] THREE missing");
    return false;
  }
  if (!window.PCBViewerOptimized) {
    console.error("[pcb_viewer_bridge] PCBViewerOptimized missing");
    return false;
  }

  //  一旦板被加载，空状态包装器就会隐藏自己。
  const empty = document.getElementById("no-file-message");
  if (empty) empty.classList.add("hidden");

  if (!viewer) {
    try {
      console.log("[pcb_viewer_bridge] instantiating viewer");
      viewer = new window.PCBViewerOptimized("pcb-canvas");
    } catch (err) {
      console.error("[pcb_viewer_bridge] viewer constructor failed", err);
      viewer = null;
      return false;
    }
  }

  wireToolbarOnce();

  try {
    viewer.loadBoard(payload);
    console.log("[pcb_viewer_bridge] viewer ready ✓");
  } catch (err) {
    console.error("[pcb_viewer_bridge] loadBoard failed", err);
    return false;
  }

  //  在加载板之后，正交视锥体的大小被调整一次 - 强制 a
  //  调整大小，使画布像素大小与其 CSS 大小相匹配，现在
  //  部分是可见的（如果我们在隐藏时初始化，则 clientWidth 为 0）。
  if (viewer.onResize) viewer.onResize();

  boardPayload = payload;
  _loadedSlug = slug;
  rebuildIndexes(payload);

  //  加载时自动调整：调用reset()，使正交视锥体大小
  //  本身到电路板的实际尺寸，而不是离开
  //  构造函数默认设置的摄像头（可以看到停在一块小板上）
  //  在左下角）。
  try { window.Boardview.reset(); } catch (_) {}

  return true;
}

console.log(
  "[pcb_viewer_bridge] module loaded — THREE:",
  typeof THREE,
  "PCBViewerOptimized:",
  typeof window.PCBViewerOptimized
);

window.initBoardview = async function bridgedInit(_containerEl) {
  //  _containerEl 是旧版 SVG 挂载目标 — 我们忽略它，因为
  //  本机 PCB 部分提供自己的画布/信息面板布局。
  const slug = resolveSlug();
  console.log("[pcb_viewer_bridge] bridgedInit slug=", slug);
  if (!slug) return;
  //  已加载 - 只需将画布大小调整为现在可见
  //  部分和保释。用户在 #home 和 #pcb 之间切换
  //  不应该每次都为新的解密+重建付费。
  if (viewer && boardPayload && _loadedSlug === slug) {
    console.log("[pcb_viewer_bridge] reusing cached viewer for", slug);
    if (viewer.onResize) viewer.onResize();
    if (viewer.requestRender) viewer.requestRender();
    return;
  }
  //  WebGL 现在是唯一的渲染器（SVG brd_viewer.js 后备是
  //  退休）。此处的失败出现在 EnsureViewerAndLoad 自己的错误 UI 中。
  await ensureViewerAndLoad(slug);
};

//  ---------- 窗口。Boardview 覆盖 ----------
//
//  保持 API 表面稳定以进行 protocol.js / llm.js / WS 调度。
//  渲染驱动方法与 WebGL 观看者对话；其余的保持不变
//  我们将在 P6 中填写 no-op 存根。

function _findItem(refdes) {
  if (!viewer || !refdes) return null;
  const items = viewer._hoverableItems || [];
  const target = String(refdes).trim();
  return items.find((it) => it.id === target) || null;
}

//  后端 WS 事件以“boardview.<verb>”为前缀（请参阅
//  api/tools/ws_events.py）。对于任何几何形状，代理商都会运送 mils
//  有效负载（focus.bbox，draw_arrow.from/to，show_pin.pos）-转换
//  到 mm，然后交给 WebGL 查看器，其工作单位为 mm。
const MIL_TO_MM = 0.0254;

function _milPairToMm(pair) {
  if (!pair) return null;
  const x = Array.isArray(pair) ? pair[0] : pair.x;
  const y = Array.isArray(pair) ? pair[1] : pair.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: x * MIL_TO_MM, y: y * MIL_TO_MM };
}

window.Boardview = {
  apply(ev) {
    if (!ev || !viewer) return;
    const t = ev.type;
    try {
      switch (t) {
        //  ---- 遗留/短别名（为任何飞行中的呼叫者保留
        //  仍然击中未加前缀的名称）。
        case "highlight":
        case "bv_highlight":
          this.highlight(ev.refdes);
          return;
        case "focus":
        case "bv_focus":
          this.focus(ev.refdes);
          return;
        case "reset":
        case "bv_reset_view":
          this.reset();
          return;

        //  ---- 规范后端信封 (api/tools/ws_events.py)
        case "boardview.highlight":
          this.highlight(ev.refdes);
          return;
        case "boardview.focus":
          this.focus(ev.refdes);
          return;
        case "boardview.reset_view":
          this.reset();
          return;
        case "boardview.flip":
          this.flip(ev.new_side);
          return;
        case "boardview.annotate":
          this.annotate(ev.refdes, ev.label, ev.id);
          return;
        case "boardview.dim_unrelated":
          this.dim_unrelated();
          return;
        case "boardview.highlight_net":
          this.highlight_net(ev.net);
          return;
        case "boardview.show_pin":
          this.show_pin(ev.refdes, ev.pin, ev.pos);
          return;
        case "boardview.draw_arrow":
          //  后端在 mils 中运送{from: [x,y], to: [x,y], id}。
          this.draw_arrow(ev.from, ev.to, ev.id);
          return;
        case "boardview.filter":
          this.filter(ev.prefix);
          return;
        case "boardview.measure":
          this.measure(ev.from_refdes, ev.to_refdes, ev.distance_mm);
          return;
        case "boardview.layer_visibility":
          this.layer_visibility(ev.layer, ev.visible);
          return;
        case "boardview.board_loaded":
          //  渲染器已经通过 /api/board/render 加载了板子
          //  （参见ensureViewerAndLoad）。 board_loaded WS 事件来自
          //  代理运行时是信息性的——无需执行任何操作。
          return;
        default:
          //  未知信封 — 用于诊断的静默日志。
          console.warn("[Boardview] unknown event type", t);
      }
    } catch (err) {
      console.warn("[Boardview] apply failed", err, ev);
    }
  },
  hasBoard() {
    return !!boardPayload && (boardPayload.components || []).length > 0;
  },
  hasRefdes(refdes) {
    return !!(_refdesMap && _refdesMap.has(String(refdes).trim()));
  },
  hasNet(name) {
    return !!(_netSet && _netSet.has(String(name).trim()));
  },
  highlight(refdes) {
    //  后端将 refdes 作为数组提供（Highlight.refdes 是 list[str]）。
    //  选择第一个有效的匹配项 - 仅 WebGL 查看者的 selectItem
    //  一次跟踪一个选定的项目。多重高光近似
    //  通过代理的bv_场景路径，每个refdes调用一次。
    const list = Array.isArray(refdes) ? refdes : [refdes];
    for (const r of list) {
      const item = _findItem(r);
      if (item && viewer.selectItem) {
        viewer.selectItem(item);
        return;
      }
    }
  },
  focus(refdes) {
    if (!viewer || !_refdesMap) return;
    const c = _refdesMap.get(String(refdes).trim());
    if (!c) return;
    viewer.camera.position.x = c.x + c.width / 2;
    viewer.camera.position.y = c.y + c.height / 2;
    viewer.frustumSize = Math.max(c.width, c.height, 20) * 4;
    viewer.zoom = 100 / viewer.frustumSize;
    if (viewer.onResize) viewer.onResize();
  },
  focusRefdes(refdes) { this.focus(refdes); },
  reset() {
    if (!viewer || !boardPayload) return;
    if (viewer.clearSelection) viewer.clearSelection();
    //  拆下代理 overlays 与相机配合，这样就可以了
    //  bv_reset_view 将画布返回到干净的基线。
    if (typeof viewer.resetAgentOverlays === "function") {
      viewer.resetAgentOverlays();
    }
    //  遵循观看者的变换感知配合：它选择 bbox
    //  匹配当前侧面模式（顶部/两者/底部）和项目
    //  它的中心通过主动旋转，因此 Fit 可以正常工作
    //  用户切换侧面或旋转板后。
    if (typeof viewer._recentreOnSideMode === "function") {
      viewer._recentreOnSideMode();
      if (viewer.requestRender) viewer.requestRender();
      return;
    }
    viewer.camera.position.x =
      (boardPayload.board_offset_x || 0) + (boardPayload.board_width || 0) / 2;
    viewer.camera.position.y =
      (boardPayload.board_offset_y || 0) + (boardPayload.board_height || 0) / 2;
    viewer.frustumSize =
      Math.max(boardPayload.board_width || 100, boardPayload.board_height || 100) *
      1.2;
    viewer.zoom = 100 / viewer.frustumSize;
    if (viewer.onResize) viewer.onResize();
  },
  //  按调整颜色面板的网络类别计数引脚。
  //  如果没有加载板子则返回null；否则是一个由以下键控的对象
  //  类别（'信号'，'电源'，'接地'，'时钟'，'重置'，'无网'）
  //  映射到实例计数。驱动每个旁边的针数药丸
  //  颜色选择器 - 让用户了解每行有多少个引脚
  //  实际上对当前板有影响。
  /**
   * 删除`slug`的缓存有效负载，以便下一个`initBoardview`
   * 调用重新获取 `/api/board/render`。由主页仪表板使用
   * 当技术人员固定不同的 boardview 版本时 —
   * URL slug 保持不变，但磁盘上的底层文件发生了变化，
   * 因此导航缓存（`_loadedSlug`）将提供服务
   * 过时的解析。不传递 arg 或匹配的 slug 即可使其无效。
   
   */
  invalidate(slug) {
    if (!slug || _loadedSlug === slug) {
      _loadedSlug = null;
      boardPayload = null;
      _refdesMap = null;
      _netSet = null;
    }
  },
  getPinCounts() {
    if (!viewer || !viewer._hoverableItems) return null;
    const counts = {
      signal: 0, power: 0, ground: 0, clock: 0, reset: 0, 'no-net': 0,
      testPad: 0, via: 0,
    };
    for (const item of viewer._hoverableItems) {
      const t = item._instanceType;
      if (t === 'testPad') {
        counts.testPad++;
        //  也落入网络类别分桶，因此测试板
        //  计数与每个网络的信号/功率/等存储桶无关。
      } else if (t === 'via') {
        const isMounting = !item.net || item.net === '' || item.net === 'NC';
        if (!isMounting) counts.via++;
        continue;  //  安装孔未在选择器中显示
      } else if (t !== 'pin' && t !== 'rectPin') {
        continue;
      }
      const cat = item.is_gnd ? 'ground' : viewer._netCategory(item.net || '');
      //  _netCategory 返回 'default' （命名为 net 无特殊前缀）→ Bucket 作为信号，
      //  和“nc”（NC 净）→ 桶作为无净。 'default' 和 'nc' 都在这里折叠，所以
      //  每个销钉恰好落在拾取器的一排中。
      const key = cat === 'default' ? 'signal'
                : cat === 'nc' ? 'no-net'
                : cat;
      if (key in counts) counts[key]++;
    }
    return counts;
  },
  //  ---------- 代理驱动 overlays（bv_* 工具事件） ----------
  flip(newSide) {
    if (!viewer) return;
    //  后端翻转事件传送它刚刚翻转到的目标侧。
    //  提供后，通过 setSideMode 进行路由，以便工具栏段
    //  使用正确的活动类进行更新。否则切换。
    if (newSide === "top" || newSide === "bottom") {
      if (typeof viewer.setSideMode === "function") {
        viewer.setSideMode(newSide);
      }
    } else if (typeof viewer.flipSide === "function") {
      viewer.flipSide();
    }
  },
  annotate(refdes, label, id) {
    if (viewer && typeof viewer.addAnnotation === "function") {
      viewer.addAnnotation(refdes, label, id);
    }
  },
  dim_unrelated() {
    if (viewer && typeof viewer.dimUnrelated === "function") {
      viewer.dimUnrelated();
    }
  },
  highlight_net(net) {
    if (viewer && typeof viewer.highlightNetByName === "function") {
      viewer.highlightNetByName(net);
    }
  },
  show_pin(refdes, _pinNumber, posMils) {
    if (!viewer || typeof viewer.showPinAt !== "function") return;
    const pos = _milPairToMm(posMils);
    viewer.showPinAt(refdes, pos);
  },
  draw_arrow(fromMils, toMils, id) {
    if (!viewer || typeof viewer.addAgentArrow !== "function") return;
    const from = _milPairToMm(fromMils);
    const to = _milPairToMm(toMils);
    if (!from || !to) return;
    viewer.addAgentArrow(from, to, id);
  },
  filter(prefix) {
    if (viewer && typeof viewer.setRefdesFilter === "function") {
      viewer.setRefdesFilter(prefix || null);
    }
  },
  measure(fromRefdes, toRefdes, distanceMm) {
    if (!viewer || typeof viewer.addMeasurement !== "function") return;
    const label = Number.isFinite(distanceMm)
      ? `${distanceMm.toFixed(2)} mm`
      : "";
    //  使用确定性 ID，以便在同一对之间重复调用
    //  替换先前的测量而不是堆叠。
    const id = `meas-${fromRefdes}-${toRefdes}`;
    viewer.addMeasurement(fromRefdes, toRefdes, label, id);
  },
  layer_visibility(layer, visible) {
    if (viewer && typeof viewer.setLayerVisibility === "function") {
      viewer.setLayerVisibility(layer, !!visible);
    }
  },
  //  上面的重写 reset() 是典型的面向用户的配合。代理的
  //  bv_reset_view 也会清除 overlays — 扩展 reset() 所以它会撕裂
  //  沿着相机向下注释/箭头/测量/变暗/过滤器
  //  适合。
  resetAgent() {
    if (viewer && typeof viewer.resetAgentOverlays === "function") {
      viewer.resetAgentOverlays();
    }
  },
  //  协议徽章 — 只要协议处于活动状态，就由 protocol.js 驱动
  //  (steps + current_step_id) 变化。代表WebGL观众
  //  基于精灵的渲染器；镜像 brd_viewer.js 的同名 API 所以
  //  protocol.js 与观众无关。
  setProtocolBadges(steps, currentId) {
    if (viewer && typeof viewer.setProtocolBadges === "function") {
      viewer.setProtocolBadges(steps, currentId);
    }
  },
  clearProtocolBadges() {
    if (viewer && typeof viewer.clearProtocolBadges === "function") {
      viewer.clearProtocolBadges();
    }
  },
  //  返回部件 bbox-top 中心的视口（页面）像素坐标，
  //  或当 refdes 未加载/离屏/隐藏面时为 null。
  //  protocol.js 使用它来锚定浮动的 refdes chip + 箭头。
  refdesScreenPos(refdes) {
    if (viewer && typeof viewer.refdesScreenPos === "function") {
      return viewer.refdesScreenPos(refdes);
    }
    return null;
  },
};

//  Net-category color API 注：四个 window.*BoardviewColor* 全局变量是
//  现在由 pcb_viewer.js 定义 direct（它拥有调色板默认值，
//  'msa.pcb.netColors' 存储，以及实时重新着色路径）。调整选择器
//  main.js 与他们交谈不变。不再需要桥接——
//  用于定义它们的旧版 SVG brd_viewer.js 已被淘汰。

//  ---------- 工具栏布线（适合 + 顶部/底部） ----------
//
//  幂等：第一个调用附加侦听器并翻转标志
//  因此后续导航不会双重附加。按钮位于
//  .brd-toolbar 下的index.html。

let _toolbarWired = false;
function wireToolbarOnce() {
  if (_toolbarWired) return;
  _toolbarWired = true;

  const fitBtn = document.getElementById("brdFitBtn");
  if (fitBtn) fitBtn.addEventListener("click", () => {
    try { window.Boardview.reset(); } catch (_) {}
  });

  const rotL = document.getElementById("brdRotL");
  if (rotL) rotL.addEventListener("click", () => {
    if (viewer && typeof viewer.rotateLeft === "function") viewer.rotateLeft();
  });
  const rotR = document.getElementById("brdRotR");
  if (rotR) rotR.addEventListener("click", () => {
    if (viewer && typeof viewer.rotateRight === "function") viewer.rotateRight();
  });

  const topBtn = document.getElementById("brdLayerTop");
  const bothBtn = document.getElementById("brdLayerBoth");
  const bottomBtn = document.getElementById("brdLayerBottom");
  //  三态段：顶部/两个/底部。驱动`viewer.setSideMode`，
  //  在双轮廓板上（XZZ并排/堆叠）过滤器
  //  通过面部实体可见性并重新调整相机。在单
  //  每个实体的大纲板都有 `_side === null` 并且切换是
  //  除了居中之外，实际上是 no-op。
  const setMode = (mode) => {
    if (!viewer) return;
    if (typeof viewer.setSideMode === "function") {
      viewer.setSideMode(mode);
    }
    if (topBtn) topBtn.classList.toggle("active", mode === "top");
    if (bothBtn) bothBtn.classList.toggle("active", mode === "both");
    if (bottomBtn) bottomBtn.classList.toggle("active", mode === "bottom");
  };
  if (topBtn) topBtn.addEventListener("click", () => setMode("top"));
  if (bothBtn) bothBtn.addEventListener("click", () => setMode("both"));
  if (bottomBtn) bottomBtn.addEventListener("click", () => setMode("bottom"));

  //  DFM-备用 (DNP) overlay 切换。该按钮保持活动状态（青色
  //  边框），而虚线轮廓层可见。
  const dnpBtn = document.getElementById("brdToggleDnp");
  if (dnpBtn) dnpBtn.addEventListener("click", () => {
    if (!viewer || typeof viewer.setShowDnp !== "function") return;
    const next = !viewer._showDnp;
    viewer.setShowDnp(next);
    dnpBtn.classList.toggle("active", next);
    dnpBtn.setAttribute("aria-pressed", next ? "true" : "false");
  });

  //  过孔切换。默认关闭 - 同步查看器的“_showVias”标志
  //  与按钮的初始状态（无“active”类）。
  const viasBtn = document.getElementById("brdToggleVias");
  if (viasBtn) {
    if (viewer && typeof viewer.setShowVias === "function") {
      viewer.setShowVias(false);
    }
    viasBtn.addEventListener("click", () => {
      if (!viewer || typeof viewer.setShowVias !== "function") return;
      const next = !viewer._showVias;
      viewer.setShowVias(next);
      viasBtn.classList.toggle("active", next);
      viasBtn.setAttribute("aria-pressed", next ? "true" : "false");
    });
  }

  //  痕迹切换。默认关闭。镜像过孔切换模式 —
  //  调用 `viewer.toggleTraces()` 来翻转 `showTraces` 并显示 /
  //  隐藏`meshGroups.traces`中的每条铜线/弧形网格（轮廓
  //  不管怎样，痕迹仍然可见，请参阅 pcb_viewer.js:3489)。
  const tracesBtn = document.getElementById("brdToggleTraces");
  if (tracesBtn) {
    tracesBtn.addEventListener("click", () => {
      if (!viewer || typeof viewer.toggleTraces !== "function") return;
      viewer.toggleTraces();
      const on = !!viewer.showTraces;
      tracesBtn.classList.toggle("active", on);
      tracesBtn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
}

//  清空模块加载期间排队的所有事件。
const _pending = (window.Boardview && window.Boardview.__pending) || [];
_pending.forEach((ev) => {
  try { window.Boardview.apply(ev); } catch (_) {}
});
