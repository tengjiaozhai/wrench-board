//  板源选择 - 仅后端。 slug 的活动boardview
//  是“active_sources.json”固定的任何内容（每个设备的版本）。否
//  硬编码的固定装置回退：丢失或未知的slug渲染
//  空状态，永远不会默默地交换另一个设备的板。
function resolveBoardSlug() {
  const qs = new URLSearchParams(window.location.search);
  return qs.get('device') || qs.get('board') || null;
}

//  返回此 slug 的后端 boardview URL，如果服务器返回 null
//  磁盘上没有对应的文件。 HEAD 探测，因此我们不支付转账费用
//  只是为了测试是否存在。
async function probeBackendBoardview(slug) {
  if (!slug) return null;
  const url = `/pipeline/packs/${encodeURIComponent(slug)}/boardview`;
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (res.ok) return url;
  } catch (_) { /*  网络错误→空  */ }
  return null;
}

//  没有 slug 或没有后端文件 → null（加载器呈现空状态）。
async function resolveBoardUrl() {
  const slug = resolveBoardSlug();
  if (!slug) return null;
  return await probeBackendBoardview(slug);
}

const PARSE_URL = '/api/board/parse';

const state = {
  board: null,
  partsSorted: null,
  partBodyBboxes: null,
  pinsByNet: null,        //  Map<netName, number[]> 按网络分组的引脚索引
  netCategory: null,      //  地图<netName, 'power' | '地面' | '信号'>
  partByRefdes: null,     //  Map<refdes, Part> — 从 pin.part_refdes 查找
  hoveredPinIdx: null,    //  固定在光标下方（用于点击可供性大纲）
  netColorHex: null,      //  { 信号、电源、接地、时钟、重置、'无网' } → "#rrggbb"
  pinPalette: null,       //  重建源自 netColorHex 的 rgba 调色板
  //  用户源交互状态（鼠标/键盘）——之前持平。
  user: {
    selectedPart: null,     //  当前突出显示的部分（对象或空）
    selectedPinIdx: null,   //  当前突出显示的引脚（board.pins 中的索引）
  },
  //  代理起源状态（来自dispatch_bv的WS事件）。独立于用户。
  agent: {
    highlights: new Set(),   //  Set<refdes> — 这些部分上的青色描边
    focused: null,            //  refdes string 或 null — 主要焦点目标
    dimmed: false,            //  当 true 时，非突出显示的部分呈现褪色
    annotations: new Map(),   //  id → {refdes, 标签}
    arrows: new Map(),        //  id → {从：[x,y]，到：[x,y]} — mils 坐标
    net: null,                //  代理突出显示的网络名称或 null
    filter: null,             //  代理过滤器 refdes 前缀或 null
    highlightPulseAt: null,   //  最新亮点/焦点事件的 Performance.now() ts — 驱动 halo+badge
    protocolSteps: [],         //  来自活动协议的 [{id, target, status}, ...]
    protocolActive: null,      //  当前步骤id
  },
};

const RATNEST_MAX_PINS = 50;  //  跳过为巨大的网绘制飞线（GND有〜500）
const PIN_HIT_TOLERANCE_PX = 4;  //  焊盘矩形周围有额外的边距，以便在低变焦时更轻松地点击
const AGENT_PULSE_DURATION_MS = 3200;  //  光晕在这个窗口上衰减；代理徽章超过 60%

//  ---------- 净色配置 ----------
//  每个类别的默认十六进制；可在运行时通过 window.setBoardviewNetColor 覆盖，
//  坚持localStorage，因此技术人员的调色板可以在重新加载后幸存下来。
//  与 `web/js/pcb_viewer.js` 的 PCB_DEFAULT_NET_HEX 保持同步 +
//  PCB_NET_COLOR_STORAGE_KEY — 两个查看器共享相同的选择器/
//  localStorage 条目。 （无法导入：pcb_viewer.js作为经典加载
//  脚本，该文件是一个 ES 模块。）
const DEFAULT_NET_HEX = {
  signal:   '#a9b6cc',
  power:    '#B16628',
  ground:   '#40455C',
  clock:    '#c084fc',
  reset:    '#f58278',
  'no-net': '#e6edf7',
  //  实体类型的伪类别 - 保留在这里用于存储奇偶校验
  //  与 WebGL 查看器； SVG 渲染器在绘制时不使用它们
  //  时间但读/写相同的localStorage条目，所以我们保留
  //  两张地图形状对齐，以避免在一张地图时丢失用户选择
  //  观看者写入了其他人不知道的值。
  testPad:  '#5a6378',
  via:      '#c084fc',
  boardOutline: '#67d4f5',
  boardFill:    '#07101f',
};
const NET_COLOR_STORAGE_KEY = 'msa.pcb.netColors';

function hexToRgba(hex, alpha) {
  const h = (hex || '').replace('#', '');
  const full = h.length === 3
    ? h.split('').map(c => c + c).join('')
    : h.padEnd(6, '0').slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

function loadNetColors() {
  try {
    const raw = localStorage.getItem(NET_COLOR_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_NET_HEX };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_NET_HEX, ...parsed };
  } catch { return { ...DEFAULT_NET_HEX }; }
}

function saveNetColors(hexMap) {
  try { localStorage.setItem(NET_COLOR_STORAGE_KEY, JSON.stringify(hexMap)); } catch {}
}

//  重建完整的引脚调色板（填充/描边 rgba 元组、描迹颜色、飞线
//  颜色）来自当前的十六进制配置。在 init 和每种颜色上调用
//  变化——便宜（六个类别×一些rgba字符串）。
function rebuildPinPalette() {
  const c = state.netColorHex || DEFAULT_NET_HEX;
  state.pinPalette = {
    PIN_COLORS: {
      signal:   { normal: [hexToRgba(c.signal, 0.90), hexToRgba(c.signal, 1.00)],
                  dim:    [hexToRgba(c.signal, 0.22), hexToRgba(c.signal, 0.35)] },
      power:    { normal: [hexToRgba(c.power,  0.90), hexToRgba(c.power,  1.00)],
                  dim:    [hexToRgba(c.power,  0.28), hexToRgba(c.power,  0.45)] },
      ground:   { normal: [hexToRgba(c.ground, 0.55), hexToRgba(c.ground, 0.70)],
                  dim:    [hexToRgba(c.ground, 0.20), hexToRgba(c.ground, 0.30)] },
      clock:    { normal: [hexToRgba(c.clock,  0.90), hexToRgba(c.clock,  1.00)],
                  dim:    [hexToRgba(c.clock,  0.25), hexToRgba(c.clock,  0.40)] },
      reset:    { normal: [hexToRgba(c.reset,  0.95), hexToRgba(c.reset,  1.00)],
                  dim:    [hexToRgba(c.reset,  0.25), hexToRgba(c.reset,  0.40)] },
      //  no-net：填充透明，因此引脚读取为空心；笔触带有颜色
      'no-net': { normal: ['rgba(0,0,0,0)',  hexToRgba(c['no-net'], 0.65)],
                  dim:    ['rgba(0,0,0,0)',  hexToRgba(c['no-net'], 0.28)] },
    },
    PIN_NET_SEL: {
      signal:   [hexToRgba(c.signal, 0.95), hexToRgba(c.signal, 1.00)],
      power:    [hexToRgba(c.power,  1.00), hexToRgba(c.power,  1.00)],
      ground:   [hexToRgba(c.ground, 0.95), hexToRgba(c.ground, 1.00)],
      clock:    [hexToRgba(c.clock,  1.00), hexToRgba(c.clock,  1.00)],
      reset:    [hexToRgba(c.reset,  1.00), hexToRgba(c.reset,  1.00)],
      'no-net': [hexToRgba(c['no-net'], 0.95), hexToRgba(c['no-net'], 1.00)],
    },
    FLY_LINE_COLOR: {
      signal:   hexToRgba(c.signal, 0.55),
      power:    hexToRgba(c.power,  0.65),
      ground:   hexToRgba(c.ground, 0.50),
      clock:    hexToRgba(c.clock,  0.65),
      reset:    hexToRgba(c.reset,  0.65),
      'no-net': hexToRgba(c['no-net'], 0.40),
    },
  };
}

//  在模块加载时初始化颜色状态，以便调色板在第一次绘制之前准备就绪。
state.netColorHex = loadNetColors();
rebuildPinPalette();

//  ---------- 调整面板的公共 API ----------
window.setBoardviewNetColor = function setBoardviewNetColor(category, hex) {
  if (!(category in DEFAULT_NET_HEX)) return;
  state.netColorHex[category] = hex;
  saveNetColors(state.netColorHex);
  rebuildPinPalette();
  requestRedraw();
};
window.resetBoardviewColors = function resetBoardviewColors() {
  state.netColorHex = { ...DEFAULT_NET_HEX };
  saveNetColors(state.netColorHex);
  rebuildPinPalette();
  requestRedraw();
};
window.getBoardviewColors = function getBoardviewColors() {
  return { ...state.netColorHex };
};
window.getBoardviewColorDefaults = function getBoardviewColorDefaults() {
  return { ...DEFAULT_NET_HEX };
};

//  Whitequark/kicad-boardview（对于 BRD2 / Test_Link）使用 module.GetBoundingBox()
//  其中包括丝印+参考文本+值文本，因此PART bboxes来自
//  这些源大约比实际组件主体大 5 倍。我们土生土长的
//  KiCad 解析器 (source_format='kicad_pcb') 已在以下位置发出仅限焊盘的 bbox
//  板坐标，因此不需要在那里进行校正 - 请参阅needsBodyBboxCorrection。
function computeBodyBbox(part, pinsById) {
  const pins = (part.pin_refs || []).map(i => pinsById[i]).filter(Boolean);
  if (pins.length === 0) {
    return part.bbox;
  }
  let x0 = pins[0].pos.x, x1 = pins[0].pos.x;
  let y0 = pins[0].pos.y, y1 = pins[0].pos.y;
  for (const p of pins) {
    if (p.pos.x < x0) x0 = p.pos.x;
    if (p.pos.x > x1) x1 = p.pos.x;
    if (p.pos.y < y0) y0 = p.pos.y;
    if (p.pos.y > y1) y1 = p.pos.y;
  }
  //  具有固定 15 mils (~0.4 mm) 的焊盘，因此保留 2 焊盘无源器件 (0603/1210)
  //  在与焊盘分离正交的轴上可见，并且单引脚
  //  安装孔呈现为 30x30 mil 点。没有百分比填充——它
  //  使大型连接器（J3、U1 等）膨胀明显超出其实际尺寸。
  const pad = 15;
  return [
    { x: x0 - pad, y: y0 - pad },
    { x: x1 + pad, y: y1 + pad },
  ];
}

//  需要 pin 导出的 bbox 校正的源格式。 KiCad 原生发射
//  仅包含 pads 的 bbox directly； BRD2 / Test_Link 发出膨胀的模块框。
function needsBodyBboxCorrection(board) {
  return board.source_format !== 'kicad_pcb';
}

//  地图部分。refdes -> 主体 bbox（引脚衍生）。每块板计算一次
//  源格式需要更正；否则返回 null。
function computeAllBodyBboxes(board) {
  if (!needsBodyBboxCorrection(board)) return null;
  const pinsById = board.pins || [];
  const out = new Map();
  for (const p of board.parts || []) {
    out.set(p.refdes, computeBodyBbox(p, pinsById));
  }
  return out;
}

//  将每个网络分类为以下之一：复位、时钟、电源、接地、信号。
//  正则表达式模式是通用/跨板的 - 它们匹配 KiCad、OrCAD、Altium、
//  以及 Apple / Samsung / ThinkPad / 微控制器的供应商约定
//  参考设计。优先级：复位>时钟>电源>地>信号，所以
//  像 CLK_3V3 这样的名称会路由到“时钟”（更具体的提示）。
const NET_CLOCK_RE = /(^|[_\-/.])(CLK|CLOCK|XTAL|X_?IN|X_?OUT|OSC(IN|OUT)?|SCLK|SCK|SYSCLK|[MHP]CLK)([_\-/.0-9]|$)/i;
const NET_RESET_RE = /(^|[_\-/.])(N_?RESET|N_?RST|RESET_?N|RST_?N|POR|PWR_?(GOOD|OK)|RESET|RST)([_\-/.0-9]|$)/i;

function computeNetCategory(board) {
  const out = new Map();
  for (const n of board.nets || []) {
    const name = n.name;
    if (NET_RESET_RE.test(name))      out.set(name, 'reset');
    else if (NET_CLOCK_RE.test(name)) out.set(name, 'clock');
    else if (n.is_power)              out.set(name, 'power');
    else if (n.is_ground)             out.set(name, 'ground');
    else                              out.set(name, 'signal');
  }
  return out;
}

//  按网络名称索引引脚，这样我们就可以一键突出显示/跟踪整个网络。
function computePinsByNet(board) {
  const out = new Map();
  const pins = board.pins || [];
  for (let i = 0; i < pins.length; i++) {
    const net = pins[i].net;
    if (!net) continue;
    if (!out.has(net)) out.set(net, []);
    out.get(net).push(i);
  }
  return out;
}

//  按 refdes 索引零件，以便从引脚的零件_refdes 进行 O(1) 查找。
function computePartByRefdes(board) {
  const out = new Map();
  for (const p of board.parts || []) out.set(p.refdes, p);
  return out;
}

//  命中测试：(sx, sy) 是否在任何部件的主体 bbox 内？迭代最小优先
//  以便拾取位于大连接器顶部的小元件。
//  0 引脚注释和错误侧部分被跳过。
function hitTestPart(sx, sy) {
  if (!state.board) return null;
  const parts = state.partsSorted || state.board.parts || [];
  const bb = outlineBbox(state.board);
  const boardW = bb.x1 + bb.x0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!part.pin_refs || part.pin_refs.length === 0) continue;
    if (part.layer !== LAYER_BOTH) {
      if (activeSide === LAYER_TOP    && part.layer !== LAYER_TOP)    continue;
      if (activeSide === LAYER_BOTTOM && part.layer !== LAYER_BOTTOM) continue;
    }
    const bbox = state.partBodyBboxes?.get(part.refdes) || part.bbox;
    if (!bbox || bbox.length < 2) continue;
    const a = milsToScreen(bbox[0].x, bbox[0].y, boardW);
    const b = milsToScreen(bbox[1].x, bbox[1].y, boardW);
    const rx0 = Math.min(a.x, b.x), ry0 = Math.min(a.y, b.y);
    const rx1 = Math.max(a.x, b.x), ry1 = Math.max(a.y, b.y);
    if (sx >= rx0 && sx <= rx1 && sy >= ry0 && sy <= ry1) return part;
  }
  return null;
}

//  命中测试：给定屏幕像素坐标，返回光标下引脚的索引。
//  每个引脚都有一个 pad_size （在 mils 中）和一个 pad_rotation_deg （用于多行
//  像QFP/BGA这样的封装，其中侧排焊盘相对于顶部/底部旋转90°）。
//  为了正确测试遏制，我们将点击点转换为打击垫的点
//  本地框架（绘制时应用的 -rotDeg 的逆）并进行测试
//  那里有一个轴对齐的矩形。
//  小容差（默认 4 像素）可保持非常小的焊盘可点击
//  低变焦。在重叠的命中（密集的簇）中选择最小的垫。
function hitTestPin(sx, sy, tolerancePx = PIN_HIT_TOLERANCE_PX) {
  if (!state.board) return null;
  const pins = state.board.pins || [];
  const bb = outlineBbox(state.board);
  const boardW = bb.x1 + bb.x0;
  let bestIdx = null;
  let bestArea = Infinity;
  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i];
    if (pin.layer !== LAYER_BOTH) {
      if (activeSide === LAYER_TOP    && pin.layer !== LAYER_TOP)    continue;
      if (activeSide === LAYER_BOTTOM && pin.layer !== LAYER_BOTTOM) continue;
    }
    const p = milsToScreen(pin.pos.x, pin.pos.y, boardW);
    const sizeMils = pin.pad_size || [30, 30];
    const halfW = Math.max(sizeMils[0] * vp.zoom / 2, 2) + tolerancePx;
    const halfH = Math.max(sizeMils[1] * vp.zoom / 2, 2) + tolerancePx;

    //  将单击变换到打击垫的本地框架中。抽签已应用
    //  ctx.rotate(-rotRad);要反转，请按 +rotRad 旋转 (dx, dy)。
    const dx = sx - p.x;
    const dy = sy - p.y;
    const rotDeg = pin.pad_rotation_deg || 0;
    let lx = dx, ly = dy;
    if (rotDeg) {
      const r = rotDeg * Math.PI / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      lx = dx * c - dy * s;
      ly = dx * s + dy * c;
    }
    if (lx >= -halfW && lx <= halfW && ly >= -halfH && ly <= halfH) {
      const area = halfW * halfH;
      if (area < bestArea) {
        bestArea = area;
        bestIdx = i;
      }
    }
  }
  return bestIdx;
}

//  按 bbox 面积降序对部件进行排序，直至大封装（SoM 连接器、BGA SoC）
//  首先绘制，并且在它们上面保留密集的小无源簇
//  可见。如果提供则使用 bodyBboxes（BRD2 / Test_Link 源），否则
//  退回到part.bbox（已经仅用于kicad_pcb 源的焊盘）。
function sortPartsByAreaDesc(parts, bodyBboxes) {
  const bboxOf = (p) => (bodyBboxes && bodyBboxes.get(p.refdes)) || p.bbox;
  return [...parts].sort((a, b) => {
    const ab = bboxOf(a);
    const bb = bboxOf(b);
    const aw = ab[1].x - ab[0].x;
    const ah = ab[1].y - ab[0].y;
    const bw = bb[1].x - bb[0].x;
    const bh = bb[1].y - bb[0].y;
    return (bw * bh) - (aw * ah);
  });
}

//  层 IntFlag 值
const LAYER_TOP    = 1;
const LAYER_BOTTOM = 2;
const LAYER_BOTH   = 3;

//  按请求的缩放比例将视口置于 bbox (mils) 的中心。返回错误
//  当画布当前为 0×0（部分隐藏）时，调用者可以排队
//  稍后冲洗的焦点。接受跨界使用的两种 bbox 风格
//  代码库：[[x,y],[x,y]]（WS 焦点事件 - 元组）和 [{x,y},{x,y}]
//  （来自解析板的内存中的partBodyBboxes/part.bbox）。
function _computeFocusPan(bbox, zoom) {
  if (!bbox || !canvas) return false;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (cw === 0 || ch === 0) return false;
  const a = bbox[0], b = bbox[1];
  if (!a || !b) return false;
  const ax = Array.isArray(a) ? a[0] : a.x;
  const ay = Array.isArray(a) ? a[1] : a.y;
  const bx = Array.isArray(b) ? b[0] : b.x;
  const by = Array.isArray(b) ? b[1] : b.y;
  if (!Number.isFinite(ax) || !Number.isFinite(ay) ||
      !Number.isFinite(bx) || !Number.isFinite(by)) return false;
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2;
  vp.zoom = zoom;
  vp.panX = cw / 2 - cx * vp.zoom;
  vp.panY = ch / 2 - cy * vp.zoom;
  return true;
}

//  视口：mils到像素变换
const vp = { panX: 0, panY: 0, zoom: 1 };

//  由于画布被隐藏，焦点请求被推迟（clientWidth === 0）
//  当时 _applyFocus 运行。一旦被ResizeObserver冲走
//  画布获得非零尺寸（即用户导航到#pcb）。
let pendingFocus = null;

//  渲染状态
let canvas = null, ctx = null;
let dirty = false;
let animFrame = null;
let activeSide = LAYER_TOP;   //  LAYER_TOP 或 LAYER_BOTTOM
let cursorMils = null;        //  {x, y} 或 null
let showAnnotations = true;   //  丝网印刷标签/徽标（0 针封装）

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

//  ---板bbox ---
function outlineBbox(board) {
  const pts = board.outline;
  if (!pts || pts.length === 0) return { x0: 0, y0: 0, x1: 1000, y1: 1000 };
  let x0 = pts[0].x, y0 = pts[0].y, x1 = pts[0].x, y1 = pts[0].y;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

//  --- 使视口适合板轮廓框，8% 填充 ---
function fitToBoard() {
  if (!canvas || !state.board) return;
  const bb = outlineBbox(state.board);
  const bw = bb.x1 - bb.x0;
  const bh = bb.y1 - bb.y0;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (bw <= 0 || bh <= 0 || cw <= 0 || ch <= 0) return;
  const pad = 0.08;
  const scaleX = (cw * (1 - pad * 2)) / bw;
  const scaleY = (ch * (1 - pad * 2)) / bh;
  vp.zoom = Math.min(scaleX, scaleY);
  vp.panX = (cw - bw * vp.zoom) / 2 - bb.x0 * vp.zoom;
  vp.panY = (ch - bh * vp.zoom) / 2 - bb.y0 * vp.zoom;
  requestRedraw();
}

//  --- 协调助手 ---
//  milsToScreen：应用平移/缩放，然后镜像（如果在底部）
function milsToScreen(mx, my, boardW) {
  if (activeSide === LAYER_BOTTOM) {
    //  X轴镜：围绕板中心x反射
    mx = boardW - mx;
  }
  return {
    x: mx * vp.zoom + vp.panX,
    y: my * vp.zoom + vp.panY,
  };
}

function screenToMils(sx, sy) {
  const bb = outlineBbox(state.board);
  const boardW = bb.x1 - bb.x0 + bb.x0 * 2; //  mils 坐标中的全宽
  let mx = (sx - vp.panX) / vp.zoom;
  const my = (sy - vp.panY) / vp.zoom;
  if (activeSide === LAYER_BOTTOM) {
    mx = boardW - mx;
  }
  return { x: mx, y: my };
}

//  根据用户 + 代理状态为零件选择 overlay 笔画。
//  优先级：用户选择（紫色）> 代理聚焦（青色强）
//  > 代理突出显示（青色 normal） > 空。
function _partStrokeOverlay(part) {
  if (state.user.selectedPart && state.user.selectedPart.refdes === part.refdes) {
    return { color: cssVar('--violet') || '#c084fc', width: 2.4 };
  }
  if (state.agent.focused === part.refdes) {
    return { color: cssVar('--cyan') || '#38bdf8', width: 2.4 };
  }
  if (state.agent.highlights.has(part.refdes)) {
    return { color: cssVar('--cyan') || '#38bdf8', width: 1.8 };
  }
  return null;
}

//  --- 绘图 ---
function draw() {
  animFrame = null;
  dirty = false;
  if (!canvas || !ctx || !state.board) return;

  const dpr = window.devicePixelRatio || 1;
  const cw  = canvas.clientWidth;
  const ch  = canvas.clientHeight;

  //  如果需要，调整后备存储的大小
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width  = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }

  //  HiDPI 基础变换 — 所有内容均以 CSS 像素绘制，DPR 在此应用一次
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  //  背景
  ctx.fillStyle = cssVar('--bg') || '#0a1120';
  ctx.fillRect(0, 0, cw, ch);

  const board = state.board;
  const bb    = outlineBbox(board);
  //  mils 的板宽度（用于镜像变换）
  const boardW = bb.x1 + bb.x0;  //  镜子：x' = 板W - x

  //  ---- 概要 ----
  const outline = board.outline;
  if (outline && outline.length > 1) {
    ctx.beginPath();
    const p0 = milsToScreen(outline[0].x, outline[0].y, boardW);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < outline.length; i++) {
      const p = milsToScreen(outline[i].x, outline[i].y, boardW);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.strokeStyle = cssVar('--text-3') || '#6e7d96';
    ctx.lineWidth   = 1;
    ctx.stroke();
  }

  //  ---- 零件（跳过 0 引脚封装 — 这些是丝印注释
  //                                下面单独绘制作为标签）----
  const parts = state.partsSorted || board.parts || [];
  ctx.lineWidth = 1;
  for (const part of parts) {
    if (!part.pin_refs || part.pin_refs.length === 0) continue;
    //  图层过滤器：跳过不属于活动侧的部分
    if (part.layer !== LAYER_BOTH) {
      if (activeSide === LAYER_TOP    && part.layer !== LAYER_TOP)    continue;
      if (activeSide === LAYER_BOTTOM && part.layer !== LAYER_BOTTOM) continue;
    }
    //  Prefer the pin-derived body bbox (tighter, matches physical component)
    //  over the BRD2 bbox which is inflated by silkscreen + ref/value text.
    const bbox = state.partBodyBboxes?.get(part.refdes) || part.bbox;
    if (!bbox || bbox.length < 2) continue;

    const a = milsToScreen(bbox[0].x, bbox[0].y, boardW);
    const b = milsToScreen(bbox[1].x, bbox[1].y, boardW);
    const rx = Math.min(a.x, b.x);
    const ry = Math.min(a.y, b.y);
    const rw = Math.abs(b.x - a.x);
    const rh = Math.abs(b.y - a.y);

    //  Agent dim: fade unrelated parts when state.agent.dimmed is set.
    const isUserSelected = state.user.selectedPart && state.user.selectedPart.refdes === part.refdes;
    const isAgentActive  = state.agent.highlights.has(part.refdes) || state.agent.focused === part.refdes;
    const shouldDim = state.agent.dimmed && !isUserSelected && !isAgentActive;

    ctx.save();
    try {
      if (shouldDim) ctx.globalAlpha = 0.18;

      ctx.fillStyle   = 'rgba(56,189,248,0.12)';
      ctx.strokeStyle = 'rgba(56,189,248,0.7)';
      ctx.lineWidth   = 1;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);

      //  Overlay stroke: user selection (violet) > agent focused (cyan strong)
      //  > agent highlighted (cyan normal). Replaces the old isSelected branch.
      const overlay = _partStrokeOverlay(part);
      if (overlay) {
        ctx.strokeStyle = overlay.color;
        ctx.lineWidth   = overlay.width;
        //  For user-selected parts also use a tinted fill to match prior look.
        if (isUserSelected) ctx.fillStyle = 'rgba(56,189,248,0.22)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);
      }
    } finally {
      ctx.restore();
    }
    ctx.lineWidth = 1;
  }

  //  Agent action pulse + persistent marker. Two-phase render:
  //      - 0..AGENT_PULSE_DURATION_MS: beefy pulsing halo (4 rings, sin modulation) +
  //          AGENT badge. Schedules continuous redraws.
  //      - after pulse: discreet single ring + faint fill stays as long as the refdes
  //          is in state.agent.highlights, so the tech still knows what the agent picked.
  if (state.agent.highlights.size > 0) {
    const now = performance.now();
    const pulseElapsed = state.agent.highlightPulseAt ? now - state.agent.highlightPulseAt : Infinity;
    const pulseProgress = pulseElapsed / AGENT_PULSE_DURATION_MS;
    const pulsing = pulseProgress < 1;
    const cyan = cssVar('--cyan') || '#38bdf8';

    let intensity = 0;
    if (pulsing) {
      const envelope = 1 - pulseProgress;
      //  Slower oscillation than the original 0.008 — at 0.005 we get ~2.5 wave
      //  超越 3.2 秒的包络线，而不是感到匆忙。
      const wave = 0.55 + 0.45 * Math.sin(now * 0.005);
      intensity = envelope * wave;
    }
    const labelAlpha = pulsing ? Math.max(0, 1 - pulseElapsed / (AGENT_PULSE_DURATION_MS * 0.6)) : 0;

    for (const refdes of state.agent.highlights) {
      const part = state.partByRefdes?.get(refdes);
      if (!part) continue;
      if (part.layer !== LAYER_BOTH) {
        if (activeSide === LAYER_TOP    && part.layer !== LAYER_TOP)    continue;
        if (activeSide === LAYER_BOTTOM && part.layer !== LAYER_BOTTOM) continue;
      }
      const bbox = state.partBodyBboxes?.get(refdes) || part.bbox;
      if (!bbox || bbox.length < 2) continue;
      const a = milsToScreen(bbox[0].x, bbox[0].y, boardW);
      const b = milsToScreen(bbox[1].x, bbox[1].y, boardW);
      const rx = Math.min(a.x, b.x);
      const ry = Math.min(a.y, b.y);
      const rw = Math.abs(b.x - a.x);
      const rh = Math.abs(b.y - a.y);

      ctx.save();

      //  圆角半径上限为较小边的 1/4，因此元件很小
      //  （被动，0402…）仍然得到明显的圆形轮廓，没有
      //  塌陷成一个圆圈。
      const cr = Math.max(0, Math.min(3, rw / 4, rh / 4));

      if (pulsing) {
        ctx.globalAlpha = intensity * 0.42;
        ctx.fillStyle = cyan;
        ctx.beginPath();
        ctx.roundRect(rx, ry, rw, rh, cr);
        ctx.fill();
        ctx.strokeStyle = cyan;
        ctx.lineWidth = 3;
        const ringSteps = [10, 22, 38, 58];
        const ringAlphas = [0.95, 0.65, 0.40, 0.22];
        for (let i = 0; i < ringSteps.length; i++) {
          const pad = ringSteps[i];
          ctx.globalAlpha = intensity * ringAlphas[i];
          ctx.beginPath();
          ctx.roundRect(rx - pad, ry - pad, rw + 2 * pad, rh + 2 * pad, cr + pad);
          ctx.stroke();
        }
      } else {
        //  持久标记 — 坐在 bbox 上（不充气），带有圆形标记
        //  轮廓，因此它明显地拥抱组件而不是浮动
        //  围绕它。稍微提高填充+描边阿尔法以获得清晰度。
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = cyan;
        ctx.beginPath();
        ctx.roundRect(rx, ry, rw, rh, cr);
        ctx.fill();
        ctx.strokeStyle = cyan;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.roundRect(rx, ry, rw, rh, cr);
        ctx.stroke();
      }

      if (labelAlpha > 0.05) {
        ctx.globalAlpha = labelAlpha;
        ctx.font = "700 12px 'JetBrains Mono', ui-monospace, monospace";
        ctx.textBaseline = 'middle';
        const labelText = '● AGENT';
        const tw = ctx.measureText(labelText).width;
        const padX = 8;
        const bx = rx;
        const by = ry - 22;
        const r = 4;
        const w = tw + padX * 2;
        const h = 18;
        ctx.fillStyle = cyan;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + w - r, by);
        ctx.quadraticCurveTo(bx + w, by, bx + w, by + r);
        ctx.lineTo(bx + w, by + h - r);
        ctx.quadraticCurveTo(bx + w, by + h, bx + w - r, by + h);
        ctx.lineTo(bx + r, by + h);
        ctx.quadraticCurveTo(bx, by + h, bx, by + h - r);
        ctx.lineTo(bx, by + r);
        ctx.quadraticCurveTo(bx, by, bx + r, by);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = labelAlpha;
        ctx.fillStyle = cssVar('--bg-deep') || '#06080d';
        ctx.fillText(labelText, bx + padX, by + h / 2);
      }
      ctx.restore();
    }
    if (pulsing) requestRedraw();
  }

  //  协议步骤徽章 - 每个步骤目标 refdes 上方的编号圆圈。
  //  颜色 = 青色表示待处理/完成/活动，琥珀色表示失败/跳过。活跃
  //  步进脉冲（使用相同的highlightPulseAt时间戳包络）。
  //  针对相同 refdes 的多个步骤垂直堆叠（较新的步骤
  //  位于 bbox 上方更高的位置），因此每个步骤都有自己的可见徽章。
  if (state.agent.protocolSteps && state.agent.protocolSteps.length > 0) {
    const cyan = cssVar('--cyan') || '#38bdf8';
    const amber = cssVar('--amber') || '#f59e0b';
    const bgDeep = cssVar('--bg-deep') || '#06080d';
    const now = performance.now();

    //  按目标refdes对步骤进行分组，以便我们可以堆叠共享相同锚点的徽章。
    const grouped = new Map();   //  refdes → [{步骤, 显示索引}]
    for (let i = 0; i < state.agent.protocolSteps.length; i++) {
      const st = state.agent.protocolSteps[i];
      if (!st.target) continue;
      const arr = grouped.get(st.target) || [];
      arr.push({ step: st, displayIndex: i + 1 });
      grouped.set(st.target, arr);
    }

    for (const [refdes, group] of grouped) {
      const part = state.partByRefdes?.get(refdes);
      if (!part) continue;
      if (part.layer !== LAYER_BOTH) {
        if (activeSide === LAYER_TOP    && part.layer !== LAYER_TOP)    continue;
        if (activeSide === LAYER_BOTTOM && part.layer !== LAYER_BOTTOM) continue;
      }
      const bbox = state.partBodyBboxes?.get(refdes) || part.bbox;
      if (!bbox || bbox.length < 2) continue;
      const a = milsToScreen(bbox[0].x, bbox[0].y, boardW);
      const b = milsToScreen(bbox[1].x, bbox[1].y, boardW);
      const cx = (a.x + b.x) / 2;
      const cyBase = Math.min(a.y, b.y) - 10;

      //  堆栈：第一个徽章最靠近 bbox，后面的徽章向上爬。
      for (let k = 0; k < group.length; k++) {
        const { step: st, displayIndex } = group[k];
        const cy = cyBase - k * 22;

        const isActive = st.id === state.agent.protocolActive;
        const isDone   = st.status === "done";
        const isFail   = st.status === "failed";
        const isSkip   = st.status === "skipped";
        const fill     = (isFail || isSkip) ? amber : cyan;
        const glyph    = isDone ? "✓" : isFail ? "✗" : isSkip ? "·" : displayIndex.toString();

        ctx.save();
        if (isActive) {
          const elapsed = state.agent.highlightPulseAt ? now - state.agent.highlightPulseAt : 0;
          const env = Math.max(0, 1 - elapsed / 3200);
          ctx.globalAlpha = 0.4 + 0.4 * env;
        } else if (isDone) {
          ctx.globalAlpha = 0.7;
        }
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(cx, cy, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = bgDeep;
        ctx.font = "600 11px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(glyph, cx, cy + 0.5);
        ctx.restore();
      }
    }
  }

  //  代理注释：靠近零件 bbox 左上角的小青色标签。
  for (const [, ann] of state.agent.annotations) {
    const part = state.partByRefdes?.get(ann.refdes);
    if (!part) continue;
    const bbox = state.partBodyBboxes?.get(part.refdes) || part.bbox;
    if (!bbox || bbox.length < 2) continue;
    const { x: sx, y: sy } = milsToScreen(bbox[0].x, bbox[0].y, boardW);
    ctx.save();
    ctx.fillStyle = cssVar('--cyan') || '#38bdf8';
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillText(ann.label, sx, sy - 6);
    ctx.restore();
  }

  //  代理箭头：直线+小箭头，mils→屏幕坐标。
  for (const [, arr] of state.agent.arrows) {
    const { x: fx, y: fy } = milsToScreen(arr.from[0], arr.from[1], boardW);
    const { x: tx, y: ty } = milsToScreen(arr.to[0],   arr.to[1],   boardW);
    ctx.save();
    ctx.strokeStyle = cssVar('--violet') || '#c084fc';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(fx, fy); ctx.lineTo(tx, ty); ctx.stroke();
    const ang = Math.atan2(ty - fy, tx - fx);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 8 * Math.cos(ang - 0.4), ty - 8 * Math.sin(ang - 0.4));
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 8 * Math.cos(ang + 0.4), ty - 8 * Math.sin(ang + 0.4));
    ctx.stroke();
    ctx.restore();
  }

  //  ---- 引脚 ----
  //  每个引脚均以其真实焊盘尺寸和形状绘制（从 KiCad 开始）。
  //  矩形是轴对齐的（零件旋转尚未应用于焊盘矩形 -
  //  接受 MVP 范围内旋转包的不精确性）。
  const pins = board.pins || [];
  //  固定调色板，按 {category, state } 键控。
  //      状态：'normal'（无选择）| 'dim'（选择另一个网络）| 'net'（选定的网络）
  //      类别： '信号' | '权力' | '地面'
  //  将类别颜色保持在暗淡状态可以让技术人员仍然看到哪些
  //  在网络探索期间，未跟踪的引脚是电源/接地/信号。
  //  调色板来自state.pinPalette（从用户配置重建+
  //  localStorage — 参见上面的rebuildPinPalette）。用户可以通过调整
  //  无需触摸代码即可调整面板。
  const PIN_COLORS    = state.pinPalette.PIN_COLORS;
  const PIN_NET_SEL   = state.pinPalette.PIN_NET_SEL;
  const FLY_LINE_COLOR = state.pinPalette.FLY_LINE_COLOR;

  //  从 state.user.selectedPinIdx 确定选定的网络（如果有）
  const selectedPin = state.user.selectedPinIdx != null ? pins[state.user.selectedPinIdx] : null;
  const selectedNet = selectedPin && selectedPin.net ? selectedPin.net : null;
  const netPinSet = selectedNet ? new Set(state.pinsByNet?.get(selectedNet) || []) : null;
  let selectedCat = 'signal';
  if (selectedPin) {
    if (!selectedPin.net) selectedCat = 'no-net';
    else selectedCat = state.netCategory?.get(selectedPin.net) || 'signal';
  }

  ctx.lineWidth = 1;
  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i];
    if (pin.layer !== LAYER_BOTH) {
      if (activeSide === LAYER_TOP    && pin.layer !== LAYER_TOP)    continue;
      if (activeSide === LAYER_BOTTOM && pin.layer !== LAYER_BOTTOM) continue;
    }
    const s = milsToScreen(pin.pos.x, pin.pos.y, boardW);

    //  pad_size在mils，通过缩放转换到屏幕。回退到 30x30 mils
    //  (~0.75mm) 用于缺少尺寸的引脚（BRD2 / Test_Link 不携带）。
    const sizeMils = pin.pad_size || [30, 30];
    const sw = sizeMils[0] * vp.zoom;
    const sh = sizeMils[1] * vp.zoom;
    //  夹紧到至少 2 像素，以便在大力缩小时图钉保持可见。
    const w = Math.max(sw, 2);
    const h = Math.max(sh, 2);

    //  该引脚的语义类别（驱动颜色和填充/轮廓样式）
    const pinCat = pin.net
      ? (state.netCategory?.get(pin.net) || 'signal')
      : 'no-net';
    //  无网垫被绘制为空心轮廓，因此它们永远不会融入任何
    //  填充类别（电源/接地/信号/时钟/复位）。
    const isHollow = pinCat === 'no-net' && !(netPinSet && netPinSet.has(i)) && state.user.selectedPinIdx !== i;

    if (netPinSet && netPinSet.has(i)) {
      [ctx.fillStyle, ctx.strokeStyle] = PIN_NET_SEL[selectedCat];
    } else if (state.user.selectedPinIdx === i && !netPinSet) {
      //  单击无网络图钉 - 没有飞线，但仍突出显示图钉本身
      [ctx.fillStyle, ctx.strokeStyle] = PIN_NET_SEL[selectedCat];
    } else {
      const stateKey = netPinSet ? 'dim' : 'normal';
      [ctx.fillStyle, ctx.strokeStyle] = PIN_COLORS[pinCat][stateKey];
    }

    //  应用该引脚自己的焊盘旋转 - 每个焊盘都有自己的方向
    //  与封装的放置旋转无关。在多行封装上
    //  (QFP / BGA) 侧面的焊盘相对于
    //  顶部/底部焊盘，因此对每个引脚使用封装旋转是错误的。
    //  KiCad 报告 X-right/Y-up 数学框架中的 CCW 正角度；画布
    //  在 X 右/Y 下坐标系中为 CW 正值 — 反转符号。
    const rotDeg = pin.pad_rotation_deg || 0;
    const rotRad = -rotDeg * Math.PI / 180;

    const shape = pin.pad_shape || 'circle';
    ctx.save();
    ctx.translate(s.x, s.y);
    if (rotDeg) ctx.rotate(rotRad);

    if (shape === 'rect' || shape === 'roundrect' || shape === 'trapezoid') {
      if (!isHollow) ctx.fillRect(-w / 2, -h / 2, w, h);
      if (isHollow || vp.zoom >= 1.5) ctx.strokeRect(-w / 2, -h / 2, w, h);
    } else if (shape === 'oval') {
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      if (!isHollow) ctx.fill();
      if (isHollow || vp.zoom >= 1.5) ctx.stroke();
    } else {
      //  圆/自定义/后备（旋转不变）
      const r = Math.max(w, h) / 2;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      if (!isHollow) ctx.fill();
      if (isHollow || vp.zoom >= 1.5) ctx.stroke();
    }

    //  悬停功能可供性 — 与 pad 形状相同，但膨胀了 3 px 间隙。
    if (i === state.hoveredPinIdx && i !== state.user.selectedPinIdx) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.95)';   //  --青色
      ctx.lineWidth = 1.5;
      const gap = 3;
      if (shape === 'rect' || shape === 'roundrect' || shape === 'trapezoid') {
        ctx.strokeRect(-w / 2 - gap, -h / 2 - gap, w + gap * 2, h + gap * 2);
      } else if (shape === 'oval') {
        ctx.beginPath();
        ctx.ellipse(0, 0, w / 2 + gap, h / 2 + gap, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const ringR = Math.max(w, h) / 2 + gap;
        ctx.beginPath();
        ctx.arc(0, 0, ringR, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    }

    ctx.restore();
  }

  //  ---- 鼠巢飞线（仅限选定的网，跳过像GND这样的巨大网）----
  if (selectedNet && netPinSet && netPinSet.size <= RATNEST_MAX_PINS && state.user.selectedPinIdx != null) {
    const anchor = pins[state.user.selectedPinIdx];
    const anchorScr = milsToScreen(anchor.pos.x, anchor.pos.y, boardW);
    ctx.strokeStyle = FLY_LINE_COLOR[selectedCat];
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (const pinIdx of netPinSet) {
      if (pinIdx === state.user.selectedPinIdx) continue;
      const other = pins[pinIdx];
      const scr = milsToScreen(other.pos.x, other.pos.y, boardW);
      ctx.moveTo(anchorScr.x, anchorScr.y);
      ctx.lineTo(scr.x, scr.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  //  ---- 丝印注释（0 针脚印：徽标、标签、徽章）----
  //  在足迹中心呈现为文本，尊重旋转。火柴
  //  PCB丝印层上物理印刷的是什么。
  if (showAnnotations) {
    ctx.fillStyle = cssVar('--text-3') || '#6e7d96';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const part of parts) {
      if (part.pin_refs && part.pin_refs.length > 0) continue;  //  仅0针
      if (part.layer !== LAYER_BOTH) {
        if (activeSide === LAYER_TOP    && part.layer !== LAYER_TOP)    continue;
        if (activeSide === LAYER_BOTTOM && part.layer !== LAYER_BOTTOM) continue;
      }
      const bbox = part.bbox;
      if (!bbox || bbox.length < 2) continue;

      const label = (part.value || part.refdes || '').replace(/^LABEL_|^LOGO_/, '');
      if (!label) continue;

      const cxMils = (bbox[0].x + bbox[1].x) / 2;
      const cyMils = (bbox[0].y + bbox[1].y) / 2;
      const wMils = Math.abs(bbox[1].x - bbox[0].x);
      const hMils = Math.abs(bbox[1].y - bbox[0].y);
      const center = milsToScreen(cxMils, cyMils, boardW);

      //  使文本适合 bbox 的长轴（KiCad 足迹旋转
      //  已经隐含在 bbox 比例中 — 肖像 bbox 想要
      //  旋转文本以匹配它们打印的一面）。
      const landscape = wMils >= hMils;
      const longPx  = (landscape ? wMils : hMils) * vp.zoom;
      const shortPx = (landscape ? hMils : wMils) * vp.zoom;
      if (longPx < 14) continue;  //  太小而无法可读

      //  字体大小：适合短轴，受长轴限制/字符数
      let fontSize = Math.min(shortPx * 0.7, (longPx * 1.5) / Math.max(label.length, 1));
      fontSize = Math.max(8, Math.min(fontSize, 48));
      ctx.font = `500 ${fontSize}px 'JetBrains Mono', ui-monospace, monospace`;

      ctx.save();
      ctx.translate(center.x, center.y);
      if (!landscape) ctx.rotate(-Math.PI / 2);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }
}

function requestRedraw() {
  if (dirty) return;
  dirty = true;
  animFrame = requestAnimationFrame(draw);
}

//  --- 工具栏 DOM 助手 ---
function updateZoomReadout(toolbar) {
  const el = toolbar.querySelector('.brd-zoom');
  if (el) el.textContent = vp.zoom.toFixed(2) + '×';
}

function updateCursorBadge(badge) {
  const el = badge.querySelector('.brd-cursor');
  if (!el) return;
  if (cursorMils) {
    el.textContent = t('brd.cursor.xy', { x: cursorMils.x.toFixed(0), y: cursorMils.y.toFixed(0) });
  } else {
    el.textContent = t('brd.cursor.empty');
  }
}

function updateInspector() {
  const el = document.querySelector('.brd-inspector');
  if (!el) return;
  const part = state.user.selectedPart;
  if (!part) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  //  计算该部分的每网络引脚数
  const netCounts = new Map();  //  网络名称 → 计数
  let firstPinByNet = new Map();  //  网络名称 → 第一个引脚索引（用于点击跟踪）
  for (const pinIdx of (part.pin_refs || [])) {
    const pin = state.board.pins[pinIdx];
    if (!pin) continue;
    const net = pin.net;
    if (!net) continue;
    netCounts.set(net, (netCounts.get(net) || 0) + 1);
    if (!firstPinByNet.has(net)) firstPinByNet.set(net, pinIdx);
  }
  const selectedNetName_hoisted = state.user.selectedPinIdx != null
    ? (state.board.pins[state.user.selectedPinIdx]?.net || null)
    : null;
  //  将当前选择的网络提升到列表顶部，以便用户
  //  不必滚动过去 GND / power rails 即可找到它。
  const netsSorted = [...netCounts.entries()].sort((a, b) => {
    if (a[0] === selectedNetName_hoisted) return -1;
    if (b[0] === selectedNetName_hoisted) return 1;
    return b[1] - a[1];
  });

  //  链接部件：与以下部件共享信号/时钟/复位网络的其他封装
  //  这部分。故意跳过电源和接地 — GND 接触
  //  几乎每个部分都会产生无用的“一切都是相互联系的”
  //  列表。其余关系反映真实的信号拓扑。
  const linked = new Map();  //  otherRefdes → 设置<网络名称>
  for (const pinIdx of (part.pin_refs || [])) {
    const pin = state.board.pins[pinIdx];
    if (!pin || !pin.net) continue;
    const cat = state.netCategory?.get(pin.net) || 'signal';
    if (cat === 'power' || cat === 'ground') continue;
    const sibs = state.pinsByNet?.get(pin.net) || [];
    for (const sibIdx of sibs) {
      const sib = state.board.pins[sibIdx];
      if (!sib || sib.part_refdes === part.refdes) continue;
      if (!linked.has(sib.part_refdes)) linked.set(sib.part_refdes, new Set());
      linked.get(sib.part_refdes).add(pin.net);
    }
  }
  const linkedSorted = [...linked.entries()].sort((a, b) => b[1].size - a[1].size);

  //  从 body bbox 计算尺寸
  const bbox = state.partBodyBboxes?.get(part.refdes) || part.bbox;
  const wMils = Math.abs(bbox[1].x - bbox[0].x);
  const hMils = Math.abs(bbox[1].y - bbox[0].y);
  const wMm = (wMils * 0.0254).toFixed(1);
  const hMm = (hMils * 0.0254).toFixed(1);

  const layerLabel = part.layer === LAYER_TOP ? t('brd.inspector.layer_top') : (part.layer === LAYER_BOTTOM ? t('brd.inspector.layer_bottom') : t('brd.inspector.layer_both'));
  const rot = part.rotation_deg != null ? t('brd.inspector.rotation', { deg: `${Math.round(part.rotation_deg)}°` }) : t('brd.inspector.rotation_dash');
  const smdLabel = part.is_smd ? t('brd.inspector.smd') : t('brd.inspector.tht');
  const pinCount = (part.pin_refs || []).length;
  const selectedNetName = state.user.selectedPinIdx != null
    ? (state.board.pins[state.user.selectedPinIdx]?.net || null)
    : null;

  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  const netList = netsSorted.map(([net, count]) => {
    const cat = state.netCategory?.get(net) || 'signal';
    const isSelected = net === selectedNetName;
    return `<li class="brd-ins-net${isSelected ? ' selected' : ''}" data-net="${escapeHtml(net)}" data-pin="${firstPinByNet.get(net)}" data-cat="${cat}">
      <span class="brd-ins-net-name">${escapeHtml(net)}</span>
      <span class="brd-ins-net-count">×${count}</span>
    </li>`;
  }).join('');

  el.hidden = false;
  el.innerHTML = `
    <header class="brd-ins-head">
      <div class="brd-ins-ref">${escapeHtml(part.refdes)}</div>
      <button class="brd-ins-close" title="${t('brd.inspector.close')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6l-12 12"/></svg>
      </button>
    </header>
    <div class="brd-ins-scroll">
      <div class="brd-ins-body">
        <div class="brd-ins-value">${escapeHtml(part.value || t('brd.inspector.value_dash'))}</div>
        <div class="brd-ins-footprint">${escapeHtml(part.footprint || t('brd.inspector.footprint_dash'))}</div>
        <div class="brd-ins-meta">
          <span>${layerLabel}</span>
          <span>${rot}</span>
          <span>${smdLabel}</span>
        </div>
        <div class="brd-ins-size">${pinCount > 1
          ? t('brd.inspector.size', { w: wMm, h: hMm, n: pinCount })
          : t('brd.inspector.size_one', { w: wMm, h: hMm, n: pinCount })}</div>
      </div>
      ${netsSorted.length > 0 ? `
        <div class="brd-ins-section-label">${t('brd.inspector.nets_section', { n: netsSorted.length })}</div>
        <ul class="brd-ins-netlist">${netList}</ul>
      ` : ''}
      ${linkedSorted.length > 0 ? `
        <div class="brd-ins-section-label">${t('brd.inspector.linked_section', { n: linkedSorted.length })}</div>
        <ul class="brd-ins-linklist">${
          linkedSorted.map(([ref, netSet]) => {
            const count = netSet.size;
            const linkLabel = count > 1
              ? t('brd.inspector.link_count', { n: count })
              : t('brd.inspector.link_count_one', { n: count });
            return `<li class="brd-ins-link" data-refdes="${escapeHtml(ref)}">
              <span class="brd-ins-link-ref">${escapeHtml(ref)}</span>
              <span class="brd-ins-link-count">${linkLabel}</span>
            </li>`;
          }).join('')
        }</ul>
      ` : ''}
    </div>
  `;

  // Wire interactions
  el.querySelector('.brd-ins-close')?.addEventListener('click', () => {
    state.user.selectedPart = null;
    state.user.selectedPinIdx = null;
    updateInspector();
    const tb = document.querySelector('.brd-toolbar');
    if (tb) updateNetReadout(tb);
    requestRedraw();
  });
  el.querySelectorAll('.brd-ins-net').forEach(li => {
    li.addEventListener('click', () => {
      const pinIdx = parseInt(li.dataset.pin, 10);
      if (Number.isNaN(pinIdx)) return;
      state.user.selectedPinIdx = pinIdx;
      // Keep the same part selected — user is exploring its nets
      updateInspector();
      const tb = document.querySelector('.brd-toolbar');
      if (tb) updateNetReadout(tb);
      requestRedraw();
    });
  });
  el.querySelectorAll('.brd-ins-link').forEach(li => {
    li.addEventListener('click', () => {
      const refdes = li.dataset.refdes;
      const target = state.partByRefdes?.get(refdes);
      if (!target) return;
      state.user.selectedPart = target;
      state.user.selectedPinIdx = null;
      updateInspector();
      const tb = document.querySelector('.brd-toolbar');
      if (tb) updateNetReadout(tb);
      requestRedraw();
    });
  });
}

function updateNetReadout(toolbar) {
  const el = toolbar.querySelector('.brd-net');
  if (!el) return;
  if (state.user.selectedPinIdx == null || !state.board) {
    el.textContent = '';
    el.style.display = 'none';
    return;
  }
  const pin = state.board.pins[state.user.selectedPinIdx];
  const net = pin && pin.net;
  if (!net) {
    el.textContent = t('brd.net.no_net_pin', { refdes: pin.part_refdes, pin: pin.index });
  } else {
    const count = state.pinsByNet?.get(net)?.length || 1;
    el.textContent = count > 1
      ? t('brd.net.with_count', { net, n: count })
      : t('brd.net.with_count_one', { net, n: count });
  }
  el.style.display = '';
}

// --- interaction handlers ---
function attachInteraction(containerEl, toolbar, badge) {
  let dragging   = false;
  let dragStartX = 0, dragStartY = 0;
  let panStartX  = 0, panStartY  = 0;
  let dragMoved  = false;        // did the cursor move meaningfully since mousedown?

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    // zoom toward cursor position
    const rect   = canvas.getBoundingClientRect();
    const cx     = ev.clientX - rect.left;
    const cy     = ev.clientY - rect.top;
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZ   = Math.max(0.05, Math.min(20, vp.zoom * factor));
    // keep world point under cursor fixed: worldX = (cx - panX) / zoom
    vp.panX = cx - ((cx - vp.panX) / vp.zoom) * newZ;
    vp.panY = cy - ((cy - vp.panY) / vp.zoom) * newZ;
    vp.zoom = newZ;
    updateZoomReadout(toolbar);
    requestRedraw();
  }, { passive: false });

  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    dragging   = true;
    dragMoved  = false;
    dragStartX = ev.clientX;
    dragStartY = ev.clientY;
    panStartX  = vp.panX;
    panStartY  = vp.panY;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (ev) => {
    if (dragging) {
      const dx = ev.clientX - dragStartX;
      const dy = ev.clientY - dragStartY;
      if (!dragMoved && (dx * dx + dy * dy) > 16) dragMoved = true;  // >4px threshold
      vp.panX = panStartX + dx;
      vp.panY = panStartY + dy;
      requestRedraw();
    }
    // cursor readout + pin-hover — only when mouse is over the canvas
    const rect = canvas.getBoundingClientRect();
    const inside = ev.clientX >= rect.left && ev.clientX <= rect.right &&
                   ev.clientY >= rect.top  && ev.clientY <= rect.bottom;
    if (inside) {
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      cursorMils = screenToMils(sx, sy);
      // Skip hit-test while actively dragging — otherwise pinpoint flicker
      if (!dragging) {
        const hover = hitTestPin(sx, sy);
        if (hover !== state.hoveredPinIdx) {
          state.hoveredPinIdx = hover;
          canvas.style.cursor = hover != null ? 'pointer' : 'grab';
          requestRedraw();
        }
      }
    } else {
      cursorMils = null;
      if (state.hoveredPinIdx != null) {
        state.hoveredPinIdx = null;
        requestRedraw();
      }
    }
    updateCursorBadge(badge);
  });

  window.addEventListener('mouseup', (ev) => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = 'grab';
    // A click (no meaningful drag) selects a pin (priority) or a part
    // (fallback) — or clears the selection if nothing is under the cursor.
    if (!dragMoved) {
      const rect = canvas.getBoundingClientRect();
      if (ev.clientX >= rect.left && ev.clientX <= rect.right &&
          ev.clientY >= rect.top  && ev.clientY <= rect.bottom) {
        const sx = ev.clientX - rect.left;
        const sy = ev.clientY - rect.top;
        const pinHit = hitTestPin(sx, sy);
        if (pinHit != null) {
          const pin = state.board.pins[pinHit];
          state.user.selectedPinIdx = pinHit;
          state.user.selectedPart   = state.partByRefdes?.get(pin.part_refdes) || null;
        } else {
          const partHit = hitTestPart(sx, sy);
          state.user.selectedPinIdx = null;
          state.user.selectedPart   = partHit;
        }
        updateNetReadout(toolbar);
        updateInspector();
        requestRedraw();
        // Broadcast the selection so sibling modules (e.g. schematic_minimap)
        // can react without coupling to this file's internals.
        const selRef = state.user.selectedPart?.refdes || null;
        const selPin = state.user.selectedPinIdx != null ? state.board.pins[state.user.selectedPinIdx] : null;
        window.dispatchEvent(new CustomEvent('bv:selection', { detail: {
          refdes: selRef,
          pinIdx: state.user.selectedPinIdx,
          pinNumber: selPin?.number ?? null,
          pinName: selPin?.name ?? null,
          pinNet: selPin?.net ?? null,
        }}));
      }
    }
  });

  //  退出清除选择
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && (state.user.selectedPinIdx != null || state.user.selectedPart != null)) {
      state.user.selectedPinIdx = null;
      state.user.selectedPart   = null;
      updateNetReadout(toolbar);
      updateInspector();
      requestRedraw();
      window.dispatchEvent(new CustomEvent('bv:selection', { detail: {
        refdes: null, pinIdx: null, pinNumber: null, pinName: null, pinNet: null,
      }}));
    }
  });

  canvas.addEventListener('mouseleave', () => {
    cursorMils = null;
    if (state.hoveredPinIdx != null) {
      state.hoveredPinIdx = null;
      canvas.style.cursor = 'grab';
      requestRedraw();
    }
    updateCursorBadge(badge);
  });
}

//  ---加载骨架---
//  在第一次获取 + 解析新的 boardview 上的 round-trip 期间显示。
//  在后续重新安装时跳过（state.board 已缓存）。旋转+闪光
//  在占位栏上，这样画布就不会感觉冻结。
function renderSkeleton(root) {
  root.innerHTML = `
    <div class="brd-loader-card">
      <div class="brd-loader-head">
        <div class="brd-loader-spinner" aria-hidden="true"></div>
        <div class="brd-loader-status">${t('brd.loader.status')}</div>
      </div>
      <ul class="brd-loader-rows">
        <li><span class="brd-loader-label">${t('brd.loader.row.board_id')}</span><span class="brd-loader-bar"></span></li>
        <li><span class="brd-loader-label">${t('brd.loader.row.format')}</span><span class="brd-loader-bar brd-loader-bar-short"></span></li>
        <li><span class="brd-loader-label">${t('brd.loader.row.components')}</span><span class="brd-loader-bar"></span></li>
        <li><span class="brd-loader-label">${t('brd.loader.row.pins')}</span><span class="brd-loader-bar brd-loader-bar-short"></span></li>
        <li><span class="brd-loader-label">${t('brd.loader.row.nets')}</span><span class="brd-loader-bar"></span></li>
      </ul>
    </div>`;
}

function renderError(root, detail) {
  const code = (detail && detail.detail)  || t('brd.error.default_code');
  const msg  = (detail && detail.message) || t('brd.error.default_msg');
  root.innerHTML = `
    <div class="error-card">
      <div class="ec-code">${code}</div>
      <div class="ec-msg">${msg}</div>
    </div>`;
}

//  空状态 — 当前 ?device= slug 不存在 boardview 固定装置。
//  显示出来，而不是默默地退回到错误设备的 PCB。重用
//  .error-card chrome（相同的 dark-bg + 居中文本语法）如此样式
//  与现有的错误路径保持一致；该副本解释了如何
//  上传一张。
function renderEmpty(root, slug) {
  const code = t('brd.empty.code');
  const msg  = slug
    ? t('brd.empty.msg_with_slug', { slug })
    : t('brd.empty.msg_no_slug');
  root.innerHTML = `
    <div class="error-card">
      <div class="ec-code">${code}</div>
      <div class="ec-msg">${msg}</div>
    </div>`;
}

//  --- 主画布设置 ---
function mountCanvas(containerEl, board) {
  containerEl.innerHTML = '';

  const partCount = (board.parts || []).length;
  const pinCount  = (board.pins  || []).length;

  //  Canvas 元素 — 完全填充容器
  canvas = document.createElement('canvas');
  canvas.className = 'brd-canvas';
  canvas.style.cursor = 'grab';
  containerEl.appendChild(canvas);
  ctx = canvas.getContext('2d');

  //  工具栏 — 右上角浮动玻璃
  const toolbar = document.createElement('div');
  toolbar.className = 'brd-toolbar';
  toolbar.innerHTML = `
    <div class="brd-seg">
      <button class="brd-seg-btn active" data-side="top" data-i18n="brd.toolbar.side_top">${t('brd.toolbar.side_top')}</button>
      <button class="brd-seg-btn" data-side="bottom" data-i18n="brd.toolbar.side_bottom">${t('brd.toolbar.side_bottom')}</button>
    </div>
    <button class="brd-btn" id="brd-annot-btn" data-i18n-attr="title:brd.toolbar.annot_title" title="${t('brd.toolbar.annot_title')}" aria-pressed="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 6h12M6 18h12M10 6v12M14 6v12"/>
      </svg>
    </button>
    <button class="brd-btn" id="brd-fit-btn" data-i18n-attr="title:brd.toolbar.fit_title" title="${t('brd.toolbar.fit_title')}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>
      </svg>
    </button>
    <button class="brd-btn" id="brd-mm-btn" data-i18n-attr="title:brd.toolbar.minimap_title" title="${t('brd.toolbar.minimap_title')}" aria-pressed="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="5.5" cy="12" r="2.2"/>
        <circle cx="18.5" cy="6" r="2.2"/>
        <circle cx="18.5" cy="18" r="2.2"/>
        <path d="M7.6 11.1L16.4 6.9M7.6 12.9L16.4 17.1"/>
      </svg>
    </button>
    <span class="brd-net" style="display:none;font-family:var(--mono);font-size:11px;color:var(--emerald);padding:0 8px;border-left:1px solid var(--border);margin-left:4px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
    <span class="brd-zoom" style="font-family:var(--mono);font-size:11px;color:var(--text-2);min-width:42px;text-align:right">1.00×</span>`;
  containerEl.appendChild(toolbar);

  //  徽章 — 左下浮动玻璃
  const badge = document.createElement('div');
  badge.className = 'brd-badge';
  badge.innerHTML = `
    <span class="brd-cursor" style="font-family:var(--mono);font-size:11px;color:var(--text-2)">—</span>
    <span style="font-family:var(--mono);font-size:10.5px;color:var(--text-3)">${t('brd.badge.summary', { parts: partCount, pins: pinCount })}</span>`;
  containerEl.appendChild(badge);

  //  检查器 - 右上角浮动玻璃（工具栏下方）
  const inspector = document.createElement('aside');
  inspector.className = 'brd-inspector';
  inspector.hidden = true;
  containerEl.appendChild(inspector);

  //  图层翻转按钮
  toolbar.querySelectorAll('.brd-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      toolbar.querySelectorAll('.brd-seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeSide = btn.dataset.side === 'bottom' ? LAYER_BOTTOM : LAYER_TOP;
      requestRedraw();
    });
  });

  //  适合按钮
  toolbar.querySelector('#brd-fit-btn').addEventListener('click', fitToBoard);

  //  注释切换
  const annotBtn = toolbar.querySelector('#brd-annot-btn');
  annotBtn.addEventListener('click', () => {
    showAnnotations = !showAnnotations;
    annotBtn.setAttribute('aria-pressed', String(showAnnotations));
    annotBtn.classList.toggle('active', showAnnotations);
    requestRedraw();
  });
  annotBtn.classList.add('active');  //  默认开启

  //  示意图关系 minimap 切换 — 反映 localStorage，因此用户
  //  偏好在重新加载后仍然存在。状态被广播到
  //  schematic_minimap 通过 CustomEvent 模块，因此两个文件保留
  //  解耦（没有共享全局变量或导入）。
  const mmBtn = toolbar.querySelector('#brd-mm-btn');
  let mmEnabled = true;
  try {
    const stored = localStorage.getItem('bvMinimapEnabled');
    if (stored === 'false') mmEnabled = false;
  } catch (_) { /*  忽略  */ }
  mmBtn.setAttribute('aria-pressed', String(mmEnabled));
  mmBtn.classList.toggle('active', mmEnabled);
  mmBtn.addEventListener('click', () => {
    mmEnabled = !mmEnabled;
    try { localStorage.setItem('bvMinimapEnabled', String(mmEnabled)); } catch (_) {}
    mmBtn.setAttribute('aria-pressed', String(mmEnabled));
    mmBtn.classList.toggle('active', mmEnabled);
    window.dispatchEvent(new CustomEvent('bv:minimap-toggle', { detail: { enabled: mmEnabled } }));
  });

  //  ResizeObserver — 在调整窗口大小时保持画布清晰。还可以冲洗任何
  //  画布隐藏时被推迟的焦点请求（例如
  //  聊天-chip 当用户在 #home 时点击 refdes) — 一旦
  //  画布在这里获得了维度，泛数学终于有了实数。
  const ro = new ResizeObserver(() => {
    if (pendingFocus && _computeFocusPan(pendingFocus.bbox, pendingFocus.zoom)) {
      pendingFocus = null;
    }
    requestRedraw();
  });
  ro.observe(containerEl);

  //  Inter动作（平移/缩放/光标）
  attachInteraction(containerEl, toolbar, badge);

  //  初始拟合+渲染
  fitToBoard();
}

export async function initBoardview(containerEl) {
  if (!containerEl) return;

  const slug = resolveBoardSlug();
  const url = await resolveBoardUrl();

  //  没有 slug 或后端对此 slug → 空状态没有任何内容。用户
  //  可以从维修仪表板上传boardview；下一个坐骑
  //  通过后端端点显示新文件。
  if (!url) {
    state.board = null;
    renderEmpty(containerEl, slug);
    return;
  }

  renderSkeleton(containerEl);

  let blob;
  let serverFilename = null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw { detail: 'FETCH_FAILED', message: t('brd.error.fetch_failed_msg', { status: res.status, url }) };
    //  当后端将文件名从 Content-Disposition 中拉出
    //  boardview 端点为其提供服务 — URL 本身
    //  (`/pipeline/packs/{slug}/boardview`) 不带扩展名。
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="([^"]+)"/.exec(cd);
    if (m) serverFilename = m[1];
    blob = await res.blob();
  } catch (err) {
    renderError(containerEl, err.detail ? err : { detail: 'FETCH_FAILED', message: String(err) });
    return;
  }

  // Preserve the original filename — the extension drives parser dispatch
  // in the backend, so .kicad_pcb must not become .brd here or content
  // sniffing routes to the wrong parser.
  const filename = serverFilename || 'upload.brd';
  const form = new FormData();
  form.append('file', blob, filename);

  let board;
  try {
    const res  = await fetch(PARSE_URL, { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) {
      // FastAPI wraps HTTPException body in a top-level `detail` key, so the
      // structured error is at data.detail (shape: {detail, message, ...}).
      renderError(containerEl, data.detail || data);
      return;
    }
    board = data;
  } catch (err) {
    renderError(containerEl, { detail: 'PARSE_FAILED', message: String(err) });
    return;
  }

  state.board = board;
  state.partBodyBboxes = computeAllBodyBboxes(board);
  state.partsSorted = sortPartsByAreaDesc(board.parts || [], state.partBodyBboxes);
  state.pinsByNet = computePinsByNet(board);
  state.netCategory = computeNetCategory(board);
  state.partByRefdes = computePartByRefdes(board);
  state.user.selectedPinIdx = null;
  state.user.selectedPart = null;
  mountCanvas(containerEl, board);
}

window.initBoardview = initBoardview;

// ---------- Public agent API ----------
// Drain anything buffered by the early stub (installed in web/js/main.js
// before brd_viewer loaded), then install the real Boardview object that
// mutates state.agent and schedules a redraw.
{
  const pending = (window.Boardview && window.Boardview.__pending) || [];

  const _applyHighlight = ({ refdes, color = 'accent', additive = false }) => {
    const list = Array.isArray(refdes) ? refdes : [refdes];
    if (!additive) state.agent.highlights.clear();
    for (const r of list) state.agent.highlights.add(r);
    state.agent.highlightPulseAt = performance.now();
    requestRedraw();
  };

  const _applyFocus = ({ refdes, bbox, zoom = 2.5, auto_flipped = false }) => {
    state.agent.focused = refdes;
    state.agent.highlights = new Set([refdes]);
    state.agent.highlightPulseAt = performance.now();
    if (auto_flipped) activeSide = activeSide === LAYER_TOP ? LAYER_BOTTOM : LAYER_TOP;
    // Pan/zoom the viewport to center on bbox. bbox is [[x1,y1],[x2,y2]] in mils.
    if (bbox) {
      if (_computeFocusPan(bbox, zoom)) {
        pendingFocus = null;
      } else {
        // Canvas hidden (e.g. user is on #home / #graphe) — defer the pan
        // until the ResizeObserver sees non-zero dimensions on section show.
        pendingFocus = { bbox, zoom };
      }
    }
    requestRedraw();
  };

  const _applyReset = () => {
    state.agent.highlights.clear();
    state.agent.focused = null;
    state.agent.dimmed = false;
    state.agent.annotations.clear();
    state.agent.arrows.clear();
    state.agent.net = null;
    state.agent.filter = null;
    state.agent.highlightPulseAt = null;
    // Preserve state.user.* and viewport.
    requestRedraw();
  };

  const _applyFlip = () => {
    // Delegate to the side-toggle button if it exists; otherwise toggle activeSide directly.
    const btn = document.querySelector('.brd-seg-btn[data-side="bottom"]');
    if (btn && typeof btn.click === 'function') {
      btn.click();
    } else {
      activeSide = activeSide === LAYER_TOP ? LAYER_BOTTOM : LAYER_TOP;
      requestRedraw();
    }
  };

  const _applyAnnotate = ({ refdes, label, id }) => {
    state.agent.annotations.set(id, { refdes, label });
    requestRedraw();
  };

  const _applyDimUnrelated = () => {
    state.agent.dimmed = true;
    requestRedraw();
  };

  const _applyHighlightNet = ({ net }) => {
    state.agent.net = net;
    // The pin/fly-line render path keys off `state.user.selectedPinIdx`, so
    // emulate "user clicked on the first pin of this net" — same visual as a
    // real pin click: net pads rendered in the selected-net colour, fly-lines
    // drawn from the anchor to every sibling pin (when the net is under the
    // RATNEST_MAX_PINS cap), inspector + toolbar net readout populated.
    const netPinIdxs = state.pinsByNet?.get(net);
    if (netPinIdxs && netPinIdxs.length > 0 && state.board?.pins) {
      const firstIdx = netPinIdxs[0];
      const firstPin = state.board.pins[firstIdx];
      state.user.selectedPinIdx = firstIdx;
      state.user.selectedPart = firstPin
        ? (state.partByRefdes?.get(firstPin.part_refdes) || null)
        : null;
      updateInspector();
      const tb = document.querySelector('.brd-toolbar');
      if (tb) updateNetReadout(tb);
      window.dispatchEvent(new CustomEvent('bv:selection', { detail: {
        refdes:    firstPin?.part_refdes ?? null,
        pinIdx:    firstIdx,
        pinNumber: firstPin?.number ?? null,
        pinName:   firstPin?.name ?? null,
        pinNet:    firstPin?.net ?? null,
      }}));
    }
    requestRedraw();
  };

  const _applyShowPin = ({ refdes }) => {
    // Simple pulse: add refdes to highlights (a real pulse animation is future polish).
    state.agent.highlights.add(refdes);
    requestRedraw();
  };

  const _applyDrawArrow = ({ from, to, id }) => {
    // WS event schema sends tuples as arrays: from=[x,y], to=[x,y] (mils).
    state.agent.arrows.set(id, { from, to });
    requestRedraw();
  };

  const _applyFilter = ({ prefix }) => {
    state.agent.filter = prefix || null;
    requestRedraw();
  };

  const _applyMeasure = () => {
    // No persistent visual state — the tech reads the distance in the agent's text answer.
  };

  const _applyLayerVisibility = () => {
    // Not currently wired to a side-toggle in brd_viewer; future work.
  };

  const _dispatch = {
    'boardview.highlight':        _applyHighlight,
    'boardview.focus':            _applyFocus,
    'boardview.reset_view':       _applyReset,
    'boardview.flip':             _applyFlip,
    'boardview.annotate':         _applyAnnotate,
    'boardview.dim_unrelated':    _applyDimUnrelated,
    'boardview.highlight_net':    _applyHighlightNet,
    'boardview.show_pin':         _applyShowPin,
    'boardview.draw_arrow':       _applyDrawArrow,
    'boardview.filter':           _applyFilter,
    'boardview.measure':          _applyMeasure,
    'boardview.layer_visibility': _applyLayerVisibility,
  };

  window.Boardview = {
    apply(ev) {
      const fn = _dispatch[ev?.type];
      if (!fn) {
        console.warn('[Boardview] unknown event type:', ev?.type);
        return;
      }
      try { fn(ev); }
      catch (err) { console.warn('[Boardview] apply failed:', err, ev); }
    },
    // Convenience methods (debugging, future code).
    highlight:        _applyHighlight,
    focus:            _applyFocus,
    reset:            _applyReset,
    flip:             _applyFlip,
    annotate:         _applyAnnotate,
    dim_unrelated:    _applyDimUnrelated,
    highlight_net:    _applyHighlightNet,
    show_pin:         _applyShowPin,
    draw_arrow:       _applyDrawArrow,
    filter:           _applyFilter,
    measure:          _applyMeasure,
    layer_visibility: _applyLayerVisibility,

    // Protocol badge control — called by protocol.js on every state change.
    setProtocolBadges(steps, currentId) {
      state.agent.protocolSteps = Array.isArray(steps) ? steps : [];
      state.agent.protocolActive = currentId || null;
      requestRedraw();
    },
    clearProtocolBadges() {
      state.agent.protocolSteps = [];
      state.agent.protocolActive = null;
      requestRedraw();
    },
    // Returns the canvas-pixel centre-top position for a given refdes, or
    // null when the part is not found or the board is not loaded.
    refdesScreenPos(refdes) {
      const part = state.partByRefdes?.get(refdes);
      if (!part) return null;
      const bb = outlineBbox(state.board);
      const boardW = bb.x1 + bb.x0;
      const bbox = state.partBodyBboxes?.get(refdes) || part.bbox;
      if (!bbox || bbox.length < 2) return null;
      const a = milsToScreen(bbox[0].x, bbox[0].y, boardW);
      const b = milsToScreen(bbox[1].x, bbox[1].y, boardW);
      return { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) };
    },

    // Lookups used by the chat panel to decide whether a refdes/net in
    // agent text should be rendered as a clickable chip. No-op when no
    // board is loaded. Case-sensitive match — the board parser preserves
    // original casing, and agent text tends to cite the canonical form.
    hasBoard() { return !!state.board && state.partByRefdes != null && state.partByRefdes.size > 0; },
    hasRefdes(refdes) {
      return !!(state.partByRefdes && state.partByRefdes.get(String(refdes).trim()));
    },
    hasNet(name) {
      return !!(state.pinsByNet && state.pinsByNet.has(String(name).trim()));
    },

    // Chip-compatible focus: the existing `focus` ({refdes, bbox, zoom})
    // needs the caller to supply a bbox (backend-only info in the event
    // envelope). The frontend has the bbox locally in `partBodyBboxes`,
    // so this wrapper resolves it from the loaded board and delegates.
    focusRefdes(refdes) {
      const r = String(refdes).trim();
      if (!state.partByRefdes || !state.partByRefdes.get(r)) return;
      const bb = (state.partBodyBboxes && state.partBodyBboxes.get(r))
                 || state.partByRefdes.get(r).bbox;
      // Adaptive zoom so a connector like J10 doesn't end up filling the
      // whole canvas while a 0402 still gets visibly enlarged. Target: the
      // part's long edge occupies ~35 % of the canvas's smallest dimension.
      // Clamped to a sane range — prevents extreme values when a bbox is
      // degenerate (0-pin footprint or single pad).
      const ax = Array.isArray(bb[0]) ? bb[0][0] : bb[0].x;
      const ay = Array.isArray(bb[0]) ? bb[0][1] : bb[0].y;
      const bx = Array.isArray(bb[1]) ? bb[1][0] : bb[1].x;
      const by = Array.isArray(bb[1]) ? bb[1][1] : bb[1].y;
      const wMils = Math.max(Math.abs(bx - ax), 40);
      const hMils = Math.max(Math.abs(by - ay), 40);
      const cw = canvas?.clientWidth  || 800;
      const ch = canvas?.clientHeight || 600;
      const target = 0.35 * Math.min(cw, ch);
      const adaptive = target / Math.max(wMils, hMils);
      const zoom = Math.max(0.4, Math.min(adaptive, 3.0));
      _applyFocus({ refdes: r, bbox: bb, zoom });
    },

    // Chip-compatible net highlight. The existing `highlight_net` already
    // takes {net}; this is a named alias for readability at the call site.
    highlightNet(name) {
      _applyHighlightNet({ net: String(name).trim() });
    },
  };

  // Drain events buffered by the early stub (installed before this module loaded).
  for (const ev of pending) {
    try { window.Boardview.apply(ev); } catch (_) { /* ignore bad events */ }
  }
}

// Re-render dynamic UI strings (toolbar tooltips, badge summary, inspector
// content, net readout, cursor) on locale switch. The static [data-i18n]
// nodes are handled by i18n.applyDom; this handles the JS-built innerHTML.
if (window.i18n && typeof window.i18n.onChange === 'function') {
  window.i18n.onChange(() => {
    if (!state.board) return;
    const containerEl = document.getElementById('brdRoot');
    if (containerEl && canvas) {
      // Re-mount canvas to rebuild toolbar / badge / inspector with the new locale.
      const prevPan = { ...vp };
      const prevSide = activeSide;
      mountCanvas(containerEl, state.board);
      Object.assign(vp, prevPan);
      activeSide = prevSide;
      const tb = document.querySelector('.brd-toolbar');
      if (tb) {
        updateZoomReadout(tb);
        updateNetReadout(tb);
      }
      updateInspector();
      requestRedraw();
    }
  });
}
