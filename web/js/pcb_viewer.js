/**
 * PCBViewerOptimized — 高性能 Three.js PCB 可视化。
 * 使用 InstancedMesh 大幅减少大型 PCB 上的绘制调用
 *（20k-50k+ 对象：30k → 50-100 次绘制调用，60 FPS 常量，~100 MB RAM）。
 *
 * 使用 `api/board/render.py::to_render_payload` 发出的 JSON 有效负载。
 * 在桥接层的“window.PCBViewerOptimized”上导出
 * (`web/js/pcb_viewer_bridge.js`) 实例化。
 
 */

//  网络类别正则表达式 - 扩展后端的严格模式
//  处理供应商风格的 XZZ 命名（PPBUS_G3H、PP1V8_CODEC、
//  GND_AUDIO_CODEC、L83_VCP_FILT_GND、...) 哪个 iPhone/MacBook
//  boardviews 使用频繁。如果没有这个，每一个这样的力量rail和
//  每个后缀的地网都会落入“信号”并呈现
//  均匀灰白色。
//
//  优先级：复位>时钟>电源>地>信号，所以CLK_3V3读取
//  作为时钟（更具体的提示）。
const PCB_NET_CLOCK_RE = /(^|[_\-/.])(CLK|CLOCK|XTAL|X_?IN|X_?OUT|OSC(IN|OUT)?|SCLK|SCK|SYSCLK|[MHP]CLK)([_\-/.0-9]|$)/i;
const PCB_NET_RESET_RE = /(^|[_\-/.])(N_?RESET|N_?RST|RESET_?N|RST_?N|POR|PWR_?(GOOD|OK)|RESET|RST)([_\-/.0-9]|$)/i;
const PCB_NET_POWER_RE = new RegExp([
    '^\\+?\\d+V\\d*(_[A-Z0-9_]+)?$',          //  +3V3、5V0_USB、1V8
    '^VCC[A-Z0-9_]*$',                         //  VCC、VCC_3V3、VCCIO
    '^VDD[A-Z0-9_]*$',                         //  电源电压，电源电压_核心
    '^VBAT[A-Z0-9_]*$',                        //  VBAT、VBAT_RTC
    '^VBUS[A-Z0-9_]*$',                        //  VBUS、VBUS_USB
    '^V_[A-Z0-9_]+$',                          //  V_音频、V_3V3
    '^PP[A-Z0-9][A-Z0-9_]*$',                  //  例如PPBUS_G3H、PP1V8_编解码器
    '^PWR[A-Z0-9_]*$',                         //  PWR_GOOD、PWR_EN（rail侧）
    '^PVDD[A-Z0-9_]*$',                        //  PVDD、PVDD_CPU
].join('|'), 'i');
//  地面：锚定且令牌边界 — 捕获 GND，VSS plus
//  复合名称，例如 GND_AUDIO_CODEC、AVDD_GND、L83_VCP_FILT_GND。
const PCB_NET_GROUND_RE = /(^|[_\-/.])(GND|VSS|AGND|DGND|PGND)([_\-/.]|$)/i;

//  网络类别调色板 - 与“web/brd_viewer.js”保持同步
//  DEFAULT_NET_HEX + NET_COLOR_STORAGE_KEY。两位观众分享了
//  'msa.pcb.netColors' localStorage 条目，因此选择器（调整面板）
//  在 SVG 后备和 WebGL 渲染器中保持一致。我们不能
//  从 brd_viewer.js 导入，因为 pcb_viewer.js 作为经典加载
//  延迟 ES 模块之前的脚本；如果需要第三个文件
//  这张地图，将其提升到一个小的共享“js/pcb_net_palette.js”脚本中
//  在两个查看器之前加载并从“window.PCB_NET_DEFAULTS”读取。
const PCB_DEFAULT_NET_HEX = {
    signal:   '#a9b6cc',
    power:    '#B16628',
    ground:   '#40455C',
    clock:    '#c084fc',
    reset:    '#f58278',
    'no-net': '#e6edf7',
    //  实体类型的伪类别——不是网名驱动的，但仍然
    //  出现在“调整”选择器中，以便技术人员可以重新调整
    //  以同样的方式在视觉上突出测试焊盘和过孔。
    testPad:  '#5a6378',
    via:      '#c084fc',
    //  Board chrome — 轮廓是闭合多边形轮廓（青色由
    //  默认），fill是其后面的基材（默认匹配
    //  bg-deep 因此它实际上保持不可见，直到用户选择
    //  一种颜色）。
    boardOutline: '#67d4f5',
    boardFill:    '#07101f',
};
const PCB_NET_COLOR_STORAGE_KEY = 'msa.pcb.netColors';

function loadPcbNetColors() {
    try {
        const raw = localStorage.getItem(PCB_NET_COLOR_STORAGE_KEY);
        if (!raw) return { ...PCB_DEFAULT_NET_HEX };
        return { ...PCB_DEFAULT_NET_HEX, ...JSON.parse(raw) };
    } catch (_) {
        return { ...PCB_DEFAULT_NET_HEX };
    }
}

function savePcbNetColors(hexMap) {
    try { localStorage.setItem(PCB_NET_COLOR_STORAGE_KEY, JSON.stringify(hexMap)); } catch (_) {}
}

function pcbHexStringToInt(hex) {
    const s = (hex || '').replace('#', '').padEnd(6, '0').slice(0, 6);
    return parseInt(s, 16) | 0;
}

/**
 * 以“alpha”不透明度将前景六角形预混合到背景六角形。
 * InstancedMesh 路径以完全不透明的方式渲染引脚（一个共享
 * 材质），所以我们不能依赖 SVG 的 alpha 混合技巧
 * 渲染器用于使接地引脚变暗。将混合物烘烤至颜色
 * 预先代替。
 
 */
function pcbBlendTowardBg(fg, bg, alpha) {
    const fr = (fg >> 16) & 0xff, fgG = (fg >> 8) & 0xff, fb = fg & 0xff;
    const br = (bg >> 16) & 0xff, bgG = (bg >> 8) & 0xff, bb = bg & 0xff;
    const r = Math.round(fr * alpha + br * (1 - alpha));
    const g = Math.round(fgG * alpha + bgG * (1 - alpha));
    const b = Math.round(fb * alpha + bb * (1 - alpha));
    return (r << 16) | (g << 8) | b;
}

/**
 * 在初始化时将 OKLCH 设计令牌从 `tokens.css` 解析为 RGB 十六进制。
 * 返回可由 THREE.Color 使用的十六进制数字。
 *
 * 为什么 `var(--cyan)` 上的 canvas: getCompulatedStyle().color 可能会返回以下任何一个
 *“rgb（r，g，b）”/“rgba（...）”/“颜色（srgb r g b）”/“oklch（...）”
 * 取决于浏览器支持和色域。一个简单的数字正则表达式
 * 将 OKLCH 字符串 ("oklch(0.82 0.14 210)") 折叠为 (0, 82, 0) =
 * 每个标记为深绿色。将 canvas2d.fillStyle 设置为相同
 * 字符串总是 normal 通过浏览器的颜色管道转换为“#rrggbb”。
 
 */
function readDesignTokens() {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);

    const ctx = document.createElement('canvas').getContext('2d');

    const resolve = (cssVar, fallback) => {
        probe.style.color = '';
        probe.style.color = `var(${cssVar})`;
        const css = getComputedStyle(probe).color;
        if (!css) return fallback;
        try {
            ctx.fillStyle = '#000000';
            ctx.fillStyle = css;          //  在无法解析的输入上抛出 / no-op
            const hex = ctx.fillStyle;    //  规范化为“#rrggbb”
            if (typeof hex === 'string' && hex.startsWith('#') && hex.length === 7) {
                return parseInt(hex.slice(1), 16);
            }
        } catch (_) { /*  失败  */ }
        return fallback;
    };

    const tokens = {
        bgDeep:  resolve('--bg-deep', 0x07101f),
        cyan:    resolve('--cyan',    0x67d4f5),
        amber:   resolve('--amber',   0xe8b85a),
        emerald: resolve('--emerald', 0x6cd49a),
        violet:  resolve('--violet',  0xb89ce8),
        text:    resolve('--text',    0xe6edf7),
        text2:   resolve('--text-2',  0xa9b6cc),
        text3:   resolve('--text-3',  0x6e7d96),
    };
    document.body.removeChild(probe);
    return tokens;
}

//  活动查看器实例 - 在构造时设置净色窗口 API
//  （在此文件底部定义）可以将实时重新着色推送到渲染的
//  板。以前是遗留 SVG brd_viewer.js 的工作；折叠在这里
//  当该文件被淘汰时，pcb_viewer 拥有整个颜色表面
//  （默认+存储+实时重新着色）。
let _activeViewer = null;

class PCBViewerOptimized {
    constructor(canvasId) {
        _activeViewer = this;
        this.canvas = document.getElementById(canvasId);
        this.container = document.getElementById('pcb-canvas-container');
        this.boardData = null;
        this.selectedItem = null;
        this.highlightedItems = [];
        this.layers = { top: true, bottom: true };
        //  默认情况下，过孔和铜迹线处于关闭状态 — GenCAD (.cad) 板
        //  通过点和 30k+ 路由发送数千个路由/缝合
        //  铜片会压碎性能并在画布上弄乱
        //  诊断。板轮廓仍然呈现（createTrace 强制
        //  不管怎样，`isOutline` 段都是可见的）。工具栏切换
        //  根据需要显示它们。
        this.showVias = false;
        this.showTraces = false;
        this.isFlipped = false;
        //  场景旋转度数 (0/90/180/270)。应用于
        //  场景根，因此每个网格都遵循；相机最近更新
        //  在每次之后通过相同的旋转在可见的 bbox 上
        //  切换以使板保持在框架中。
        this.rotationDeg = 0;

        //  双视图模式
        this.isDualView = false;
        this.dualViewGroup = null;

        //  双轮廓 (XZZ) — 当解析器显示顶部 + 底部时
        //  在同一坐标空间中的视图，“dualOutline”保存
        //  两个多边形和分割轴。 `sideMode` 循环
        //  “顶部”/“底部”/“两者”来过滤每个面的可见性。
        this.dualOutline = null;
        this.sideMode = 'both';
        //  单独跟踪轮廓，以便侧面滤镜可以隐藏/
        //  独立显示每张脸的轮廓。
        this._outlineMeshes = [];
        //  跟踪检查标记（XZZ type_03），以便侧过滤器
        //  可以隐藏/显示每个面的填充+边框。
        this._markerMeshes = [];
        //  每个矩形引脚边界线，针对侧面过滤器进行跟踪
        //  （自从 THREE.Line 没有实例以来，它们是为每个引脚构建的）。
        this._pinBorderLines = [];
        //  独立组件填充+丝印主体线段
        //  由 `createComponent` 为运送 body_lines 的 XZZ 部件发出：
        //  他们生活在每个部分“组”之外（所以XZZ-烘焙轮换
        //  不双重旋转），所以侧面过滤器必须跟踪它们
        //  单独而不是依赖集团的知名度。
        this._componentExtras = [];

        //  性能：按需渲染
        this.needsRender = true;
        this.lastHoverCheck = 0;
        this.hoverThrottleMs = 33;
        this.lastMouseMoveTime = 0;
        this.mouseMoveThrottleMs = 16;

        //  ===实例网格系统===
        this._circularPinInstance = null;      //  InstancedMesh 适用于所有圆形引脚
        this._circularPinBorderInstance = null;
        this._rectPinInstances = new Map();    //  地图<sizeKey, {body: InstancedMesh, border: InstancedMesh}>
        this._viasOuterInstance = null;
        this._viasInnerInstance = null;
        this._testPadsInstance = null;
        this._testPadsBorderInstance = null;

        //  用于悬停/选择的实例 ID 到数据映射
        this._pinInstanceData = [];            //  数组[实例ID] = pinData
        this._viaInstanceData = [];
        this._testPadInstanceData = [];

        //  组件组（保留为单独的网格 - 更少的对象）
        this.meshGroups = { components: [], traces: [] };

        //  每个组件 refdes 标签精灵 — 在 createComponent 中填充，
        //  由 _updateComponentLabelVisibility() 切换的可见性基于
        //  当前缩放，这样它们就不会扰乱全板视图。
        this._componentLabels = [];
        //  用于 0 引脚部件的大丝印标签（BADGE / REFORM / 等） —
        //  单独跟踪，这样我们就可以将它们的屏幕像素高度固定在
        //  缩放（否则它们会无限增长）。
        this._silkscreenLabels = [];
        this._labelMinPx = 32;
        this._refdesPixelHeight = 14;
        this._silkscreenMaxPixelHeight = 32;

        //  === O(1) 悬停的空间网格 ===
        this._spatialGrid = {};
        this._gridCellSize = 5;
        this._hoverableItems = []; //  用于悬停检查的平面阵列

        //  === 特工覆盖状态 ===
        //  diagnostic绘制的注释+箭头+测量值
        //  代理的 bv_* 工具调用。与用户的悬停/选择不同
        //  路径，以便聊天驱动的场景能够在手动点击和副操作中幸存下来
        //  反之亦然。作为由 id 键控的地图进行跟踪（注释 id、箭头 id、
        //  测量 id），以便遗留事件流可以解决它们
        //  单独进行增量清除/替换；作为一个整体清除
        //  通过 bv_reset_view 路径。
        this._agentAnnotations = new Map();   //  id → { 精灵, refdes, 标签 }
        this._agentArrows = new Map();        //  id → THREE.Group（填充轴+头部网格+光环）
        this._agentMeasurements = new Map();  //  id → THREE.Group（行+标签）
        //  协议步骤徽章 - 每个步骤上方编号为青色/琥珀色的别针
        //  目标组件，由 bv_propose_protocol 通过桥设置。
        //  由step.id（字符串）→ { sprite, refdes } 键入。清除为
        //  按clearProtocolBadges分组；在每个 setProtocolBadges 上重建
        //  调用（无差异 - 协议更新很少，以至于
        //  完全重绘比增量更新更简单）。
        this._protocolBadges = new Map();     //  步骤Id → { 精灵, refdes }
        //  由 bv_filter_by_type 工具应用的 Refdes-prefix 过滤器。
        //  Null = 无过滤器（一切可见）。设置后，组件 +
        //  其part_refdes不以前缀get开头的引脚
        //  通过 _applyRefdesFilter 变暗/隐藏。
        this._agentFilterPrefix = null;
        //  活跃的昏暗无关状态——当为真时，每个组件/
        //  代理当前未突出显示的引脚会变暗。的
        //  当前选定的项目 + 代理突出显示保持全亮。
        this._agentDimActive = false;

        //  设计标记——场景调色板的单一事实来源。
        //  在 init 时从 tokens.css 解析一次；无实时反应。
        this.tokens = readDesignTokens();

        //  网络类别调色板 — 通过 SVG 渲染器共享
        //  localStorage 因此用户定制可以保留。
        this.netColors = loadPcbNetColors();

        //  场景调色板——源自 chrome 的 tokens.css（背景、
        //  轮廓，突出显示）和来自 PCB_DEFAULT_NET_HEX 的引脚，因此
        //  WebGL 观看者与 brd_viewer.js 保持同步
        //  用户可定制的网络调色板。地面被预先混合
        //  bg-deep 重现 SVG 渲染器的 alpha-0.55 变暗
        //  （否则 GND #6e7d96 距离信号 #a9b6cc 太近
        //  屏幕 — 两者均显示为“中灰色”）。
        const nc = this.netColors;
        const bg = this.tokens.bgDeep;
        this.colors = {
            background:       bg,
            boardOutline:     pcbHexStringToInt(nc.boardOutline || '#67d4f5'),
            boardFill:        pcbHexStringToInt(nc.boardFill    || '#07101f'),
            componentOutline: this.tokens.cyan,
            copper:           this.tokens.text,
            silkscreen:       this.tokens.text,
            pinDefault:       pcbHexStringToInt(nc['no-net']),
            //  显式 NC 引脚（字符串 == 'NC'）被硬编码为黑色，因此
            //  他们退出了活跃的网络家庭。更宽松的后备措施
            //  (null / N/A / UNCONNECTED) 保持用户可定制
            //  上面的“无网”阴影。
            pinNC:            0x000000,
            //  网络类别引脚：从用户自定义读取
            //  调色板（从localStorage加载/回落到
            //  PCB_DEFAULT_NET_HEX）。早期版本硬编码
            //  pinPower / pinGround 实现视觉清晰度，这使得
            //  静默编辑默认值 no-op 直到用户
            //  触摸了拾取器。现在默认流过。
            pinPower:         pcbHexStringToInt(nc.power),
            pinSignal:        pcbHexStringToInt(nc.signal),
            pinGround:        pcbHexStringToInt(nc.ground),
            pinClock:         pcbHexStringToInt(nc.clock),
            pinReset:         pcbHexStringToInt(nc.reset),
            via:              pcbHexStringToInt(nc.via || '#c084fc'),
            //  统一“测试垫”颜色 — 适用于 XZZ type_09
            //  实心焊盘InstancedMesh（罕见），TEST_POINT 引脚（XW /
            //  TPxxx)，以及安装孔过孔。之前的分裂
            //  （橙色testPad + 硬编码金色pinTestPadSignal）制作
            //  选择器一次只更新一个槽位，留下
            //  视觉上占主导地位的黄色探针垫被卡住。
            testPad:          pcbHexStringToInt(nc.testPad || '#d4af37'),
            pinTestPadSignal: pcbHexStringToInt(nc.testPad || '#d4af37'),
            highlight:        this.tokens.cyan,
            hover:            this.tokens.text2,
            netLine:          this.tokens.cyan,
        };

        //  共享几何图形（创建一次）
        this._sharedGeometries = {};
        //  飞线的虚线纹理 — 构建一次，重复使用
        //  每个飞线材料的“地图”。每个平面的 UV 重复
        //  控制沿每个段平铺的破折号周期数。
        this._flyDashTexture = this._createFlyDashTexture();
        this._sharedMaterials = {};

        this.init();
    }

    init() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.colors.background);

        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        const aspect = w / h;
        this.frustumSize = 100;
        this.camera = new THREE.OrthographicCamera(
            -this.frustumSize * aspect / 2, this.frustumSize * aspect / 2,
            this.frustumSize / 2, -this.frustumSize / 2, 0.1, 1000
        );
        this.camera.position.z = 100;

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(w, h, false);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); //  性能上限为 2x

        this.mouse = new THREE.Vector2();
        this.isPanning = false;
        this.lastMousePos = { x: 0, y: 0 };
        this.zoom = 1;

        this._initSharedGeometries();
        this.setupEvents();
        this.animate();
    }

    /**
     * 预先创建实例网格使用的共享几何图形
     
     */
    _initSharedGeometries() {
        //  标准圆形销（最常见）
        //  32 段：任意变焦时平滑的圆垫； InstancedMesh
        //  共享单个几何体，因此每个实例的成本可以忽略不计。
        this._sharedGeometries.circlePin = new THREE.CircleGeometry(1, 32);
        //  每个引脚周围的薄边框环（约焊盘半径的 6%）。
        //  以较深的色调绘制在填充后面，因此每个垫读起来为
        //  一个定义的对象而不是一个扁平的斑点。
        this._sharedGeometries.circlePinRing = new THREE.RingGeometry(0.94, 1.0, 32);

        //  通孔几何形状 — 外环 + 内孔
        this._sharedGeometries.viaOuter = new THREE.RingGeometry(0.6, 1, 32);
        this._sharedGeometries.viaInner = new THREE.CircleGeometry(0.4, 32);

        //  测试垫——实心圆，无边框环
        this._sharedGeometries.testPad = new THREE.CircleGeometry(1, 32);

        //  共享材料。每个实例的颜色通过 setColorAt 设置
        //  InstancedMesh，所以基材的颜色大多是
        //  说明性的。
        this._sharedMaterials.pinFill = new THREE.MeshBasicMaterial({ color: this.colors.pinDefault });
        this._sharedMaterials.via = new THREE.MeshBasicMaterial({ color: this.colors.via, side: THREE.DoubleSide });
        this._sharedMaterials.viaHole = new THREE.MeshBasicMaterial({ color: this.colors.background });
        //  测试垫（ICT 探针目标，主要是 TVW）呈现为离散的
        //  第二层 — 半不透明度，因此密集的 ICT 探测场
        //  显卡底视图不会淹没真正的 SMD 焊盘。
        this._sharedMaterials.testPad = new THREE.MeshBasicMaterial({
            color: this.colors.testPad,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
        });
    }

    /**
     * 将网络名称分类到 brd-color-grid 类别之一，以便
     * 引脚可以相应地着色。镜子：
     * - 从 web/brd_viewer.js 重置/时钟正则表达式（字边界，
     * 优先级复位>时钟>电源>接地>信号所以CLK_3V3
     * 读取为时钟）
     * - 电源/接地正则表达式来自
     * api/board/parser/test_link.py (_POWER_RE, _GROUND_RE) — 的
     * 后端用于设置 Net.is_power 的规范模式 /
     * 网络.is_ground.
     *
     * 没有单词边界，前面的启发式 ('^[+-]?\\d' for
     * 电源）将 XZZ 网络（例如“12_DATA_BUS”）错误分类为电源，并且
     * 以琥珀色显示它们。
     
     */
    _netCategory(name) {
        if (name === 'NC') return 'nc';
        if (!name || name === 'N/A' || name === 'UNCONNECTED') {
            return 'default';
        }
        if (PCB_NET_RESET_RE.test(name)) return 'reset';
        if (PCB_NET_CLOCK_RE.test(name)) return 'clock';
        if (PCB_NET_POWER_RE.test(name)) return 'power';
        if (PCB_NET_GROUND_RE.test(name)) return 'ground';
        return 'signal';
    }

    _pinColorForCategory(cat) {
        switch (cat) {
            case 'power':  return this.colors.pinPower;
            case 'ground': return this.colors.pinGround;
            case 'signal': return this.colors.pinSignal;
            case 'clock':  return this.colors.pinClock;
            case 'reset':  return this.colors.pinReset;
            case 'nc':     return this.colors.pinNC;
            default:       return this.colors.pinDefault;
        }
    }

    /**
     * 解决引脚的显示颜色，考虑到父级
     * 组件类型。测试点（XW 探针焊盘、TEST_PAD_*、TPxxx）
     * 携带非地信号使用专用的金色 —
     * 反映了探针焊盘上的一些电路板标记
     * 有源信号为手工染成金色，而 GND 探针焊盘保持不变
     * 灰色/惰性。常规组件上的引脚落入
     * 净类别颜色。
     
     */
    _resolvePinColor(pin, cat) {
        if (pin.component_type === 'TEST_POINT' && cat !== 'ground') {
            return this.colors.pinTestPadSignal;
        }
        return this._pinColorForCategory(cat);
    }

    /**
     * 重新分配网络落入的每个引脚实例的颜色
     *`类别`。将更改保留到相同的 localStorage 条目
     * SVG 渲染器读取，因此选择器 / WebGL / SVG 路径保持不变
     * 同步。 `category` 也接受 SVG 端名称（'no-net'）。
     
     */
    setNetCategoryColor(category, hex) {
        const hexStr = typeof hex === 'string'
            ? (hex.startsWith('#') ? hex : '#' + hex)
            : '#' + hex.toString(16).padStart(6, '0');
        const hexInt = pcbHexStringToInt(hexStr);

        const storeKey = category === 'default' ? 'no-net' : category;
        const targetCat = category === 'no-net' ? 'default' : category;
        if (storeKey in this.netColors) {
            this.netColors[storeKey] = hexStr;
            savePcbNetColors(this.netColors);
        }

        //  实体类型的伪类别 - 重新着色每个实例
        //  匹配的网格类型，无论网络名称如何。
        if (category === 'testPad') {
            this.colors.testPad = hexInt;
            this._recolorAllTestPads(hexInt);
            this.requestRender();
            return;
        }
        if (category === 'via') {
            this.colors.via = hexInt;
            this._recolorElectricalVias(hexInt);
            this.requestRender();
            return;
        }
        if (category === 'boardOutline') {
            this._recolorBoardOutline(hexInt);
            this.requestRender();
            return;
        }
        if (category === 'boardFill') {
            this._recolorBoardFill(hexInt);
            this.requestRender();
            return;
        }

        const colorKey = 'pin' + (targetCat === 'default' ? 'Default' :
            targetCat[0].toUpperCase() + targetCat.slice(1));
        //  地面上不再有背景混合 — 用户选择的十六进制已被采用
        //  逐字匹配构造函数路径。之前的修订版
        //  预混合地面 55% 至 bg-deep“以保持惰性”，
        //  但这意味着选择器的输出永远不会与
        //  用户点击了。
        const sceneInt = hexInt;
        this.colors[colorKey] = sceneInt;

        const newColor = new THREE.Color(sceneInt);
        //  遍历每个可悬停的引脚/垫 - 仅“_pinInstanceData”
        //  包含圆形引脚，因此单独迭代左矩形 SMD
        //  焊盘（大多数板上的大部分引脚）和测试焊盘被卡住
        //  保持以前的颜色，直到重新加载。迭代 `_hoverableItems`
        //  相反，选择器适用于所有实例类型。
        const dirtyRect = new Set();
        let dirtyCircular = false;
        let dirtyTestPad = false;
        for (const item of this._hoverableItems) {
            const t = item._instanceType;
            if (t !== 'pin' && t !== 'rectPin' && t !== 'testPad') continue;
            const cat = item.is_gnd ? 'ground' : this._netCategory(item.net);
            if (cat !== targetCat) continue;
            item.originalColor = sceneInt;
            if (item._restColor != null) item._restColor = sceneInt;
            if (t === 'pin' && this._circularPinInstance) {
                this._circularPinInstance.setColorAt(item._instanceId, newColor);
                dirtyCircular = true;
            } else if (t === 'rectPin' && item._sizeKey) {
                const rect = this._rectPinInstances.get(item._sizeKey);
                if (rect && rect.body) {
                    rect.body.setColorAt(item._instanceId, newColor);
                    dirtyRect.add(rect.body);
                }
            } else if (t === 'testPad' && this._testPadsInstance) {
                this._testPadsInstance.setColorAt(item._instanceId, newColor);
                dirtyTestPad = true;
            }
        }
        if (dirtyCircular) this._circularPinInstance.instanceColor.needsUpdate = true;
        dirtyRect.forEach((mesh) => { mesh.instanceColor.needsUpdate = true; });
        if (dirtyTestPad) this._testPadsInstance.instanceColor.needsUpdate = true;
        this.requestRender();
    }

    /**
     * 将每个“类似测试板”的实体重新绘制为单一颜色。的
     * 拾取器桶“测试垫”历史上分为三个
     * 内部颜色插槽：
     * - 颜色.testPad → XZZ type_09 实心InstancedMesh
     * - color.pinTestPadSignal → TEST_POINT 引脚（XW、TPxxx）+ 安装孔过孔
     * 用户将它们视为一个家庭（“金色/黄色垫”），因此
     *我们统一了重新着色：每个实体都被涂上了颜色
     * 这两种颜色一次性翻转到所选的六角形。
     
     */
    _recolorAllTestPads(hexInt) {
        const newColor = new THREE.Color(hexInt);
        this.colors.testPad = hexInt;
        this.colors.pinTestPadSignal = hexInt;

        let dirtyTestPad = false;
        let dirtyCircular = false;
        const dirtyRect = new Set();
        let dirtyVia = false;

        for (const item of this._hoverableItems) {
            const t = item._instanceType;
            //  1. XZZ type_09 实心测试垫（自带InstancedMesh）。
            if (t === 'testPad' && this._testPadsInstance) {
                item.originalColor = hexInt;
                if (item._restColor != null) item._restColor = hexInt;
                this._testPadsInstance.setColorAt(item._instanceId, newColor);
                dirtyTestPad = true;
                continue;
            }
            //  2. TEST_POINT 组件内的引脚（视觉上的
            //        占主导地位的“黄色探针垫”）。
            if ((t === 'pin' || t === 'rectPin')
                && item.component_type === 'TEST_POINT'
                && !item.is_gnd) {
                item.originalColor = hexInt;
                if (item._restColor != null) item._restColor = hexInt;
                if (t === 'pin' && this._circularPinInstance) {
                    this._circularPinInstance.setColorAt(item._instanceId, newColor);
                    dirtyCircular = true;
                } else if (t === 'rectPin' && item._sizeKey) {
                    const rect = this._rectPinInstances.get(item._sizeKey);
                    if (rect && rect.body) {
                        rect.body.setColorAt(item._instanceId, newColor);
                        dirtyRect.add(rect.body);
                    }
                }
                continue;
            }
            //  3.安装孔过孔（无网——用同样的金绘制
            //        通过 `_createViasInstanced`，第 1995 行）。
            if (t === 'via' && this._viasOuterInstance) {
                const isMounting = !item.net || item.net === '' || item.net === 'NC';
                if (isMounting) {
                    item.originalColor = hexInt;
                    if (item._restColor != null) item._restColor = hexInt;
                    this._viasOuterInstance.setColorAt(item._instanceId, newColor);
                    dirtyVia = true;
                }
            }
        }

        if (dirtyTestPad && this._testPadsInstance.instanceColor) {
            this._testPadsInstance.instanceColor.needsUpdate = true;
        }
        if (dirtyCircular && this._circularPinInstance.instanceColor) {
            this._circularPinInstance.instanceColor.needsUpdate = true;
        }
        dirtyRect.forEach(m => { if (m.instanceColor) m.instanceColor.needsUpdate = true; });
        if (dirtyVia && this._viasOuterInstance.instanceColor) {
            this._viasOuterInstance.instanceColor.needsUpdate = true;
        }
    }

    /**
     * 仅重新绘制电气过孔 - “net”设置为
     * 有意义的名字。安装孔（无网）保留其金环
     *因为它们是一种独特的可供性，而不是
     * 电网家族。
     
     */
    _recolorElectricalVias(hexInt) {
        if (!this._viasOuterInstance) return;
        const newColor = new THREE.Color(hexInt);
        for (const item of this._hoverableItems) {
            if (item._instanceType !== 'via') continue;
            const isMounting = !item.net || item.net === '' || item.net === 'NC';
            if (isMounting) continue;
            item.originalColor = hexInt;
            if (item._restColor != null) item._restColor = hexInt;
            this._viasOuterInstance.setColorAt(item._instanceId, newColor);
        }
        if (this._viasOuterInstance.instanceColor) {
            this._viasOuterInstance.instanceColor.needsUpdate = true;
        }
    }

    setupEvents() {
        window.addEventListener('resize', () => this.onResize());
        this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mouseup', () => this.onMouseUp());
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('click', (e) => this.onClick(e));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        //  触摸：1 根手指 = 平移，2 根手指 = 捏合缩放（到中点），a
        //  短按 1 根手指 = 选择（转发到点击路径）。被动：
        //  false 这样我们就可以防止默认浏览器的本机平移/捏缩放。
        this.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        this.canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        this.canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
        this.canvas.addEventListener('touchcancel', () => this.onTouchEnd(), { passive: false });
        //  在画布上禁用本机手势（双击缩放、滚动）。
        this.canvas.style.touchAction = 'none';

        const closeBtn = document.getElementById('info-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this.clearSelection());
    }

    onResize() {
        const w = this.container.clientWidth, h = this.container.clientHeight;
        const aspect = w / h;
        this.camera.left = -this.frustumSize * aspect / 2;
        this.camera.right = this.frustumSize * aspect / 2;
        this.camera.top = this.frustumSize / 2;
        this.camera.bottom = -this.frustumSize / 2;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h, false);
        this._updateComponentLabelVisibility();
        this._updateRefdesLabelScale();
        this._updateSilkscreenLabelScale();
        this._updateFlyLineDashes();
        this._updateSideArrowScale();
        this._updateAgentArrowScale();
        this._updateAgentAnnotationScale();
        this.requestRender();
    }

    onWheel(e) {
        e.preventDefault();
        const rect = this.container.getBoundingClientRect();
        //  向光标方向缩放（请参阅 _zoomAtPoint）。
        this._zoomAtPoint(e.clientX - rect.left, e.clientY - rect.top, e.deltaY > 0 ? 1.1 : 0.9);
    }

    //  Zoom-to-point：将锚点的像素位置转换为世界点
    //  在改变视锥体之前，应用变焦，然后移动相机，以便
    //  相同的世界点仍然位于锚点下方。由轮子和轮子共享
    //  两指捏合（锚点=光标/捏合中点），因此缩放到中心
    //  每一步后都不会强制重新平移。
    _zoomAtPoint(offsetX, offsetY, zoomFactor) {
        const worldBefore = this.screenToWorld(offsetX, offsetY);
        this.frustumSize *= zoomFactor;
        //  允许大量缩小（10×板对角线）如此密集
        //  像 MSI V300 这样的主板（46 mm GPU 部分，5k+ 过孔）可以
        //  从舒适的距离平移/探索，而不是
        //  车轮一凹口后撞到墙上。
        const maxSize = this.boardData ? Math.max(this.boardData.board_width, this.boardData.board_height) * 10 : 2000;
        this.frustumSize = Math.max(0.5, Math.min(maxSize, this.frustumSize));
        this.zoom = 100 / this.frustumSize;
        this.onResize();
        const worldAfter = this.screenToWorld(offsetX, offsetY);
        this.camera.position.x += worldBefore.x - worldAfter.x;
        this.camera.position.y += worldBefore.y - worldAfter.y;
        const zoomEl = document.getElementById('zoom-level');
        if (zoomEl) zoomEl.textContent = Math.round(this.zoom * 100);
        this.requestRender();
    }

    //  将相机平移像素增量（通过鼠标拖动 + 触摸平移共享）。
    _panByPixels(dxPx, dyPx) {
        const w = this.container.clientWidth, h = this.container.clientHeight;
        const aspect = w / h;
        this.camera.position.x -= dxPx * (this.frustumSize * aspect) / w;
        this.camera.position.y += dyPx * this.frustumSize / h;
        this.requestRender();
    }

    _touchDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
    _touchMid(t) { return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 }; }

    //  无需实际移动的单指点击即可选择其下方的项目 -
    //  移动设备没有悬停，因此我们更新了点击时的拾取射线+悬停
    //  点，然后通过与鼠标相同的 onClick 堆栈拾取路径。
    _forwardTapAsClick(clientX, clientY) {
        const rect = this.container.getBoundingClientRect();
        const w = this.container.clientWidth, h = this.container.clientHeight;
        this.mouse.x = ((clientX - rect.left) / w) * 2 - 1;
        this.mouse.y = -((clientY - rect.top) / h) * 2 + 1;
        this.checkHover();
        this._pressStart = { x: clientX, y: clientY };
        this.onClick({ clientX, clientY });
    }

    onTouchStart(e) {
        if (e.touches.length === 1) {
            e.preventDefault();
            const t = e.touches[0];
            this._touchMode = 'pan';
            this._lastTouch = { x: t.clientX, y: t.clientY };
            this._touchStart = { x: t.clientX, y: t.clientY };
            this._touchMoved = false;
        } else if (e.touches.length === 2) {
            e.preventDefault();
            this._touchMode = 'pinch';
            this._pinchPrevDist = this._touchDist(e.touches);
            this._pinchPrevMid = this._touchMid(e.touches);
            this._touchMoved = true; //  捏从来都不是轻敲
        }
    }

    onTouchMove(e) {
        if (this._touchMode === 'pan' && e.touches.length === 1) {
            e.preventDefault();
            const t = e.touches[0];
            if (Math.abs(t.clientX - this._touchStart.x) > 6 || Math.abs(t.clientY - this._touchStart.y) > 6) {
                this._touchMoved = true;
            }
            this._panByPixels(t.clientX - this._lastTouch.x, t.clientY - this._lastTouch.y);
            this._lastTouch = { x: t.clientX, y: t.clientY };
        } else if (this._touchMode === 'pinch' && e.touches.length === 2) {
            e.preventDefault();
            const dist = this._touchDist(e.touches);
            const mid = this._touchMid(e.touches);
            const rect = this.container.getBoundingClientRect();
            if (this._pinchPrevDist > 0) {
                //  手指分开→距离↑→因子<1→截锥体缩小→放大。
                this._zoomAtPoint(mid.x - rect.left, mid.y - rect.top, this._pinchPrevDist / dist);
            }
            //  两指拖动也可平移（中点移动）。
            this._panByPixels(mid.x - this._pinchPrevMid.x, mid.y - this._pinchPrevMid.y);
            this._pinchPrevDist = dist;
            this._pinchPrevMid = mid;
        }
    }

    onTouchEnd(e) {
        if (this._touchMode === 'pan' && !this._touchMoved && this._touchStart) {
            this._forwardTapAsClick(this._touchStart.x, this._touchStart.y);
        }
        //  抬起另一根手指后剩下一根手指（捏→平移）：继续平移
        //  从它的位置来看；否则结束手势。
        if (e && e.touches && e.touches.length === 1) {
            this._touchMode = 'pan';
            this._lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            this._touchStart = { ...this._lastTouch };
            this._touchMoved = true; //  多点触控的尾部，而不是新鲜的水龙头
        } else {
            this._touchMode = null;
        }
    }

    onMouseDown(e) {
        //  隐藏按压位置，以便“onClick”可以辨别真伪
        //  单击（“单击空白处以取消选择”）
        //  平移拖动 - 浏览器在两者之后触发“单击”，但我们
        //  只想取消选择前者。
        this._pressStart = { x: e.clientX, y: e.clientY };

        //  右键单击、中键单击或 Shift+左键单击 = 始终平移
        if (e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey)) {
            this.isPanning = true;
            this.lastMousePos = { x: e.clientX, y: e.clientY };
            this.canvas.style.cursor = 'grabbing';
            return;
        }

        //  左键单击：如果在空白处单击则平移（无悬停项目）
        if (e.button === 0 && !this.hoveredItem) {
            this.isPanning = true;
            this.lastMousePos = { x: e.clientX, y: e.clientY };
            this.canvas.style.cursor = 'grabbing';
        }
    }

    onMouseUp() {
        this.isPanning = false;
        this.canvas.style.cursor = 'default';
    }

    onMouseMove(e) {
        const now = performance.now();

        if (!this.isPanning && now - this.lastMouseMoveTime < this.mouseMoveThrottleMs) {
            return;
        }
        this.lastMouseMoveTime = now;

        const containerRect = this.container.getBoundingClientRect();
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;

        const offsetX = e.clientX - containerRect.left;
        const offsetY = e.clientY - containerRect.top;

        this.mouse.x = (offsetX / w) * 2 - 1;
        this.mouse.y = -(offsetY / h) * 2 + 1;

        if (this.isPanning) {
            const aspect = w / h;
            const dx = (e.clientX - this.lastMousePos.x) * (this.frustumSize * aspect) / w;
            const dy = (e.clientY - this.lastMousePos.y) * this.frustumSize / h;
            this.camera.position.x -= dx;
            this.camera.position.y += dy;
            this.lastMousePos = { x: e.clientX, y: e.clientY };
            this.requestRender();
        }

        //  更新光标位置显示
        if (!this.isPanning) {
            this._pendingCursorUpdate = { offsetX, offsetY };
            if (!this._cursorUpdateScheduled) {
                this._cursorUpdateScheduled = true;
                requestAnimationFrame(() => {
                    if (this._pendingCursorUpdate) {
                        const worldPos = this.screenToWorld(this._pendingCursorUpdate.offsetX, this._pendingCursorUpdate.offsetY);
                        document.getElementById('cursor-x').textContent = worldPos.x.toFixed(2);
                        document.getElementById('cursor-y').textContent = worldPos.y.toFixed(2);
                    }
                    this._cursorUpdateScheduled = false;
                });
            }
        }

        //  油门悬停检查
        if (!this.isPanning && now - this.lastHoverCheck >= this.hoverThrottleMs) {
            this.lastHoverCheck = now;
            this.checkHover();
        }
    }

    onClick(e) {
        //  空白处单击 → 取消选择，但仅当光标处于
        //  其实并没有拖。之后浏览器仍然会触发“click”
        //  一个小平底锅，所以我们对 mousedown→mouseup 距离进行门控：
        //  ≤ 4 px = 真实点击，> 4 px = 拖尾（保留视图）。
        const start = this._pressStart;
        const dragged = start && (
            Math.abs(e.clientX - start.x) > 4
            || Math.abs(e.clientY - start.y) > 4
        );
        if (dragged) return;

        //  侧空翻箭头位于板下飞线处
        //  TOP / BOTTOM 模式下的端点。单击其中之一即可切换
        //  观众到另一张脸 - 预先处理它们，以便他们
        //  永远不要陷入下面的循环堆栈逻辑中。
        if (this.hoveredItem && this.hoveredItem._instanceType === 'sideArrow') {
            this.setSideMode(this.hoveredItem._targetSide, { keepView: true });
            return;
        }

        //  堆栈拾取：收集光标位置命中的所有项目，
        //  按 tier（引脚 > 组件）排序，然后按 AABB 大小（较小的
        //  首先）。单击在堆栈中循环 - 重复单击
        //  同一位置移动到前一个项目下的项目。这个
        //  Altium / Cadence / KiCad 如何让您达到坐姿
        //  在垫子下，或 DNP 交替坐在放置的身体下。
        const stack = this._collectClickStack();
        if (stack.length === 0) {
            if (this.selectedItem) this.clearSelection();
            return;
        }
        const cursorKey = `${e.clientX}_${e.clientY}`;
        const sameSpot = this._lastClickKey
            && Math.abs(e.clientX - this._lastClickPx) <= 4
            && Math.abs(e.clientY - this._lastClickPy) <= 4;
        if (sameSpot) {
            this._clickStackIndex = (this._clickStackIndex + 1) % stack.length;
        } else {
            this._clickStackIndex = 0;
        }
        this._lastClickKey = cursorKey;
        this._lastClickPx = e.clientX;
        this._lastClickPy = e.clientY;
        this.selectItem(stack[this._clickStackIndex]);
    }

    /**
     * 返回光标当前所在的每个可悬停项目，并已排序
     * pin-tier-先，然后按 AABB 尺寸。相同的命中测试规则
     * `checkHover`（侧面过滤器、DNP 过滤器、图层过滤器、slop），但是
     * 不是返回单个获胜者，而是返回整个堆栈
     * 这样 `onClick` 就可以循环通过它。
     
     */
    _collectClickStack() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        const aspect = w / h;
        const worldX = this.camera.position.x + this.mouse.x * (this.frustumSize * aspect / 2);
        const worldY = this.camera.position.y + this.mouse.y * (this.frustumSize / 2);
        const local = this._worldToLocal(worldX, worldY);
        const localX = local.x, localY = local.y;
        const nearby = this._getNearbyItems(localX, localY);
        const pixelSize = this.frustumSize / h;
        const pinSlop = 8 * pixelSize;
        const pinThresholdSq = pinSlop * pinSlop;
        const pinHits = [];
        const compHits = [];
        for (const item of nearby) {
            if (item.layer && !this.layers[item.layer]) continue;
            if (item._side && this.sideMode !== 'both' && item._side !== this.sideMode) continue;
            const t = item._instanceType;
            if (!this._showDnp && (item.is_dnp || t === 'dnpComp')) continue;
            const isPinTier = t === 'pin' || t === 'rectPin' || t === 'testPad'
                || t === 'via' || t === 'marker' || t === 'sideArrow';
            const dx = item.x - localX, dy = item.y - localY;
            const halfW = (item.width || 0) / 2, halfH = (item.height || 0) / 2;
            const ex = Math.max(0, Math.abs(dx) - halfW);
            const ey = Math.max(0, Math.abs(dy) - halfH);
            const distSq = ex * ex + ey * ey;
            const size = (item.width || 0.05) * (item.height || 0.05);
            if (isPinTier) {
                if (distSq > pinThresholdSq) continue;
                pinHits.push({ item, distSq, size });
            } else {
                if (distSq > 0) continue;
                compHits.push({ item, distSq, size });
            }
        }
        const sortFn = (a, b) => a.distSq - b.distSq || a.size - b.size;
        pinHits.sort(sortFn);
        compHits.sort(sortFn);
        return [...pinHits, ...compHits].map((h) => h.item);
    }

    screenToWorld(offsetX, offsetY) {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        const aspect = w / h;

        const ndcX = (offsetX / w) * 2 - 1;
        const ndcY = -(offsetY / h) * 2 + 1;

        const worldX = this.camera.position.x + ndcX * (this.frustumSize * aspect / 2);
        const worldY = this.camera.position.y + ndcY * (this.frustumSize / 2);

        return { x: worldX, y: worldY };
    }

    /**
     * 反转 (worldX, worldY) 点上的场景旋转，以便
     *结果与项目坐标（隐藏的
     * 解析时预旋转）。由悬停和缩放光标使用
     * 因此它们在旋转切换后继续工作。
     
     */
    _worldToLocal(wx, wy) {
        const rad = -(this.rotationDeg || 0) * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return {
            x: wx * cos - wy * sin,
            y: wx * sin + wy * cos,
        };
    }

    /**
     * 空间网格悬停检测 - O(1) 查找
     
     */
    checkHover() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        const aspect = w / h;

        const worldX = this.camera.position.x + this.mouse.x * (this.frustumSize * aspect / 2);
        const worldY = this.camera.position.y + this.mouse.y * (this.frustumSize / 2);

        //  项目位于场景局部坐标（它们的原始 XY）中。当
        //  场景旋转/翻转，光标的世界XY需要
        //  在我们可以之前通过相同的变换进行反转
        //  将其与空间网格进行匹配。
        const local = this._worldToLocal(worldX, worldY);
        const localX = local.x;
        const localY = local.y;

        //  从空间网格获取附近的项目
        const nearbyItems = this._getNearbyItems(localX, localY);

        const pixelSize = this.frustumSize / h;
        //  引脚/焊盘/过孔/标记/箭头是小的“交互式”
        //  目标 - 慷慨的坡度（8 px），因此技术不必
        //  低变焦下的像素搜寻。组件很大（毫米级）并且
        //  会从它们上面的任何东西上偷走悬停，所以
        //  它们仅在光标位于 AABB 内部时悬停（slop=0）。
        const pinSlop = 8 * pixelSize;
        const compSlop = 0;
        const pinThresholdSq = pinSlop * pinSlop;

        //  两个tier搜索：引脚优先，组件仅作为后备。
        //  在每个tier内，最小的 AABB 距离获胜。始终固定
        //  当两者可以匹配时击败组件 - 修复了长-
        //  单击位于零件顶部的大头针时出现的常设错误
        //  会选择该部分。
        let bestPin = null;
        let bestPinDistSq = Infinity;
        let bestPinSize = Infinity;
        let bestComp = null;
        let bestCompDistSq = Infinity;
        let bestCompSize = Infinity;

        for (const item of nearbyItems) {
            if (item.layer && !this.layers[item.layer]) continue;
            if (item._side && this.sideMode !== 'both' && item._side !== this.sideMode) continue;

            const t = item._instanceType;
            //  DNP 引脚被烘焙到已放置的引脚网格中，并带有
            //  可悬停项目上携带的“is_dnp”标志 - 当
            //  切换关闭，矩阵为零缩放，因此焊盘是
            //  不可见且非交互式。 DNP 组件的同一门
            //  体（`dnpComp` overlays）。
            if (!this._showDnp && (item.is_dnp || t === 'dnpComp')) continue;

            const isPinTier = t === 'pin' || t === 'rectPin' || t === 'testPad'
                || t === 'via' || t === 'marker' || t === 'sideArrow';

            const dx = item.x - localX;
            const dy = item.y - localY;
            const halfW = (item.width || 0) / 2;
            const halfH = (item.height || 0) / 2;
            const ex = Math.max(0, Math.abs(dx) - halfW);
            const ey = Math.max(0, Math.abs(dy) - halfH);
            const distSq = ex * ex + ey * ey;

            if (isPinTier) {
                if (distSq > pinThresholdSq) continue;
                //  相同 distSq 上的决胜局（很常见 - 两者
                //  候选人在 AABB 内且 distSq=0)：更喜欢
                //  较小的项目。 AABB 越紧越好
                //  视觉匹配；否则小SMD焊盘总是会丢失
                //  到它旁边的更宽的矩形垫。
                const size = (item.width || 0.05) * (item.height || 0.05);
                if (distSq < bestPinDistSq
                    || (distSq === bestPinDistSq && size < bestPinSize)) {
                    bestPinDistSq = distSq;
                    bestPinSize = size;
                    bestPin = item;
                }
            } else {
                //  组件/通用网格 - 仅严格内部 AABB。
                if (distSq > compSlop * compSlop) continue;
                const size = (item.width || 0.05) * (item.height || 0.05);
                if (distSq < bestCompDistSq
                    || (distSq === bestCompDistSq && size < bestCompSize)) {
                    bestCompDistSq = distSq;
                    bestCompSize = size;
                    bestComp = item;
                }
            }
        }

        const nearest = bestPin || bestComp;

        //  更新悬停状态
        if (this.hoveredItem && this.hoveredItem !== nearest) {
            //  重置之前的悬停
            this._setItemHighlight(this.hoveredItem, false);
            this.requestRender();
        }

        if (nearest && nearest !== this.selectedItem) {
            this.hoveredItem = nearest;
            this._setItemHighlight(nearest, true);
            this.canvas.style.cursor = 'pointer';
            this.requestRender();
        } else if (!nearest) {
            this.hoveredItem = null;
            if (!this.isPanning) this.canvas.style.cursor = 'default';
        }
    }

    /**
     * 设置项目的突出显示状态（适用于实例网格）
     * @param {object} item - 项目数据
     * @param {boolean}突出显示 - 是否突出显示或恢复原始颜色
     * @param {number} [customColor] - 可选的自定义突出显示颜色（默认值：悬停时为 0x666666）
     
     */
    /**
     * 将不在“netName”上的每个引脚/矩形引脚/测试焊盘推向
     * deep 背景颜色，因此突出显示的网络是独立的。的
     * 选定的引脚和同网络引脚已重新着色
     * 上面的 `_setItemHighlight` 调用在这里被跳过。一通
     * 在`_hoverableItems`上，然后是单个instanceColor.needsUpdate
     * 每InstancedMesh。
     
     */
    _dimUnrelatedPins(netName) {
        if (!netName || netName === 'NC') return;
        this._dimActive = true;
        const dimFactor = 0.18;  //  原始亮度的 18% — 保持
                                 //  暗示颜色而不做
                                 //  不相关的引脚竞争性地明亮。
        const bg = new THREE.Color(this.tokens.bgDeep || 0x07101f);
        const tmp = new THREE.Color();
        for (const item of this._hoverableItems) {
            const t = item._instanceType;
            if (t !== 'pin' && t !== 'rectPin' && t !== 'testPad') continue;
            if (item.net === netName) continue;
            tmp.setHex(item.originalColor || 0x808080);
            //  lerp(original, bg, 1 - 因子) → 因子=0.18 保持 18%
            //  原始的，混合82%到bg-deep。
            tmp.lerp(bg, 1 - dimFactor);
            //  隐藏暗淡的六角形，这样悬停即可恢复暗淡，而不是
            //  到图钉原来的全亮度颜色。
            item._restColor = tmp.getHex();
            this._writeInstanceColor(item, tmp);
        }
        this._markPinInstanceColorDirty();
    }

    /**
     * 将“netName”上的铜线增强为网络的家族颜色
     * 完全不透明。其他痕迹未受影响——每一个铜
     * 根据定义，迹线属于某个网络，因此使其余部分变暗
     * 会任意淡出用户可能的其他网络路径
     * 还是想一起读。轮廓/丝印层保留
     * 超出范围。
     
     */
    _highlightNetTraces(netName, lineColor) {
        if (!this.meshGroups || !this.meshGroups.traces) return;
        this._tracesNetActive = true;
        const lineColorObj = new THREE.Color(lineColor);
        for (const line of this.meshGroups.traces) {
            const ud = line.userData;
            if (!ud || ud._kind !== 'copper') continue;
            if (!line.material) continue;
            if (ud.net && ud.net === netName) {
                line.material.color.set(lineColorObj);
                line.material.opacity = 1.0;
                line.material.needsUpdate = true;
                //  强制可见 - 网络突出显示覆盖工具栏
                //  showTraces 切换匹配的跟踪，以便用户
                //  即使在以下情况下，也始终会看到所单击网络的路由
                //  全局跟踪层已关闭。 _undimAllTraces 放置
                //  当突出显示清除时，工具栏会返回。
                line.visible = true;
            }
        }
    }

    /**
     * 将六角形推向白色，直到其亮度达到~210/255。
     * 飞线在 Chromium 上渲染为 1 像素虚线段（
     * `linewidth` GL 提示被忽略），所以任何比中灰色更暗的东西
     * 在海军蓝画布上有效地消失。计算
     * 达到目标亮度的精确白色混合比
     * 固定系数上限 — Power #B16628 (lum 117) 需求
     * ~50 % 白色，地面 #40455C (lum 70) 需要 ~75 %，同时明亮
     * 色调（青色 netLine lum 183，桃色重置 lum 156）保持接近
     * 他们的家族颜色。
     
     */
    _brightenForFlyLine(hexInt) {
        const r = (hexInt >> 16) & 0xff;
        const g = (hexInt >> 8) & 0xff;
        const b = hexInt & 0xff;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const target = 210;
        if (lum >= target) return hexInt;
        //  白色亮度为 255。求解：lum + (255 - lum) * t = 目标
        //      → t =（目标 - 流明）/（255 - 流明）
        const t = (target - lum) / (255 - lum);
        const nr = Math.round(r + (255 - r) * t);
        const ng = Math.round(g + (255 - g) * t);
        const nb = Math.round(b + (255 - b) * t);
        return (nr << 16) | (ng << 8) | nb;
    }

    _undimAllTraces() {
        if (!this._tracesNetActive) return;
        this._tracesNetActive = false;
        if (!this.meshGroups || !this.meshGroups.traces) return;
        for (const line of this.meshGroups.traces) {
            const ud = line.userData;
            if (!ud || ud._kind !== 'copper') continue;
            if (!line.material) continue;
            line.material.color.setHex(ud.origColor);
            line.material.opacity = ud.origOpacity;
            line.material.needsUpdate = true;
            //  恢复工具栏 showTraces 门。轮廓/丝网印刷
            //  无论如何，图层都保持可见（createTrace 强制它们
            //  在解析时可见并且上面的循环跳过非铜
            //  _种类）。
            line.visible = this.showTraces;
        }
    }

    _undimAllPins() {
        if (!this._dimActive) return;
        this._dimActive = false;
        const tmp = new THREE.Color();
        for (const item of this._hoverableItems) {
            const t = item._instanceType;
            if (t !== 'pin' && t !== 'rectPin' && t !== 'testPad') continue;
            tmp.setHex(item.originalColor || 0x808080);
            //  放下昏暗的静止覆盖，以便随后的悬停捕捉
            //  再次回到解析时颜色。
            delete item._restColor;
            this._writeInstanceColor(item, tmp);
        }
        this._markPinInstanceColorDirty();
    }

    _writeInstanceColor(item, color) {
        if (item._instanceType === 'pin' && this._circularPinInstance) {
            this._circularPinInstance.setColorAt(item._instanceId, color);
        } else if (item._instanceType === 'rectPin' && item._sizeKey) {
            const rect = this._rectPinInstances.get(item._sizeKey);
            if (rect && rect.body) rect.body.setColorAt(item._instanceId, color);
        } else if (item._instanceType === 'testPad' && this._testPadsInstance) {
            this._testPadsInstance.setColorAt(item._instanceId, color);
        }
    }

    _markPinInstanceColorDirty() {
        if (this._circularPinInstance && this._circularPinInstance.instanceColor) {
            this._circularPinInstance.instanceColor.needsUpdate = true;
        }
        this._rectPinInstances.forEach(({ body }) => {
            if (body && body.instanceColor) body.instanceColor.needsUpdate = true;
        });
        if (this._testPadsInstance && this._testPadsInstance.instanceColor) {
            this._testPadsInstance.instanceColor.needsUpdate = true;
        }
    }

    _setItemHighlight(item, highlighted, customColor = 0x666666) {
        if (!item) return;

        const highlightColor = new THREE.Color(customColor);
        //  静止（未悬停）颜色 — `_restColor` 覆盖
        //  当项目当前处于解析时“originalColor”
        //  非默认状态（突出显示的网络的成员，变暗，因为
        //  选择了不相关的网络，...）。如果没有这个，请将鼠标悬停在
        //  这样的物品会将其恢复为错误的颜色并破坏
        //  视觉故事（变暗的图钉看起来悬停在明亮的位置；相同的网络
        //  引脚在悬停时会失去其净颜色）。
        const restingHex = item._restColor != null
            ? item._restColor
            : item.originalColor;
        const restingColor = new THREE.Color(restingHex);
        const targetColor = highlighted ? highlightColor : restingColor;

        //  圆形销钉
        if (item._instanceType === 'pin' && this._circularPinInstance) {
            this._circularPinInstance.setColorAt(item._instanceId, targetColor);
            this._circularPinInstance.instanceColor.needsUpdate = true;
        }
        //  矩形销钉
        else if (item._instanceType === 'rectPin' && item._sizeKey) {
            const rectInstance = this._rectPinInstances.get(item._sizeKey);
            if (rectInstance && rectInstance.body) {
                rectInstance.body.setColorAt(item._instanceId, targetColor);
                rectInstance.body.instanceColor.needsUpdate = true;
            }
        }
        //  测试垫
        else if (item._instanceType === 'testPad' && this._testPadsInstance) {
            this._testPadsInstance.setColorAt(item._instanceId, targetColor);
            this._testPadsInstance.instanceColor.needsUpdate = true;
        }
        //  组件（常规网格）- 在悬停时传递“null”，以便
        //  每个子材质恢复其自己的 userData.origColor
        //  而不是全部都紧贴父母的单身
        //  RestingHex（用于将组件重新着色填充青色
        //  并将其留在那里）。
        else if (item._mesh) {
            this.setMeshColor(item._mesh, highlighted ? customColor : null);
        }
    }

    /**
     * 遍历网格树并对每个网格/线材质重新着色
     * 包含。当“color”为哨兵“null”时，每个孩子都是
     * 恢复到其单独保存的“userData.origColor” —
     * 需要，因为 KiCad / BRD 上的组件组捆绑了青色
     * 线条轮廓和灰蓝色网格填充：将两者捕捉回
     * 悬停时相同的十六进制用于使填充卡在其中
     * 轮廓青色（“悬停后组件保持点亮”）。
     
     */
    setMeshColor(mesh, color) {
        const applyColor = (obj) => {
            if (obj.material && (obj.material.type === 'MeshBasicMaterial' ||
                                 obj.material.type === 'LineBasicMaterial')) {
                let target;
                if (color === null) {
                    target = (obj.userData && obj.userData.origColor != null)
                        ? obj.userData.origColor
                        : obj.material.color.getHex();
                } else {
                    target = color;
                }
                obj.material.color.setHex(target);
            }
            if (obj.children) {
                obj.children.forEach(child => applyColor(child));
            }
        };
        applyColor(mesh);
    }

    _getGridKey(x, y) {
        const cellX = Math.floor(x / this._gridCellSize);
        const cellY = Math.floor(y / this._gridCellSize);
        return `${cellX},${cellY}`;
    }

    _getNearbyItems(worldX, worldY) {
        const items = [];
        const cellX = Math.floor(worldX / this._gridCellSize);
        const cellY = Math.floor(worldY / this._gridCellSize);

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const key = `${cellX + dx},${cellY + dy}`;
                if (this._spatialGrid[key]) {
                    items.push(...this._spatialGrid[key]);
                }
            }
        }
        return items;
    }

    _buildSpatialGrid() {
        this._spatialGrid = {};

        for (const item of this._hoverableItems) {
            const key = this._getGridKey(item.x, item.y);
            if (!this._spatialGrid[key]) {
                this._spatialGrid[key] = [];
            }
            this._spatialGrid[key].push(item);
        }

        console.log(`[PERF] Spatial grid: ${Object.keys(this._spatialGrid).length} cells for ${this._hoverableItems.length} items`);
    }

    selectItem(item) {
        this.clearSelection();
        this.selectedItem = item;

        //  应用青色高亮颜色进行选择
        this._setItemHighlight(item, true, this.colors.highlight);

        //  显示 inspector 并填充字段。 DOM 存在于
        //  <aside class="brd-inspector">下的index.html。
        const inspector = document.getElementById('component-info');
        if (inspector) inspector.hidden = false;

        const setText = (id, txt) => {
            const el = document.getElementById(id);
            if (el) el.textContent = txt;
        };
        setText('info-id', item.id || '…');
        setText('info-value', item.value || item.net || '…');
        setText('info-type', (item.type || 'Pin').toUpperCase());
        setText('info-layer', (item.layer || 'top').toUpperCase());
        setText('info-pos',
            `X: ${(item.x || 0).toFixed(2)}  Y: ${(item.y || 0).toFixed(2)}`);
        setText('info-size', item.width
            ? `${item.width.toFixed(1)} × ${(item.height || 0).toFixed(1)} mm`
            : '');

        //  组件元数据——仅在选定项目时才有意义
        //  是一个部分（来自源格式的封装名称、引脚
        //  数）。引脚/过孔/测试垫/标记不带
        //  这些使行保持隐藏。 `item.footprint` 和
        //  `item.pin_count` 直接来自渲染有效负载
        //  `components[]` 形状（参见 api/board/render.py）。
        const fpEl = document.getElementById('info-footprint');
        const pcEl = document.getElementById('info-pincount');
        const hasFootprint = !!(item.footprint && typeof item.footprint === 'string');
        if (fpEl) {
            fpEl.hidden = !hasFootprint;
            if (hasFootprint) fpEl.textContent = `Footprint: ${item.footprint}`;
        }
        const hasPinCount = Number.isFinite(item.pin_count) && item.pin_count > 0;
        if (pcEl) {
            pcEl.hidden = !hasPinCount;
            if (hasPinCount) {
                pcEl.textContent = item.pin_count > 1
                    ? `${item.pin_count} pins`
                    : `1 pin`;
            }
        }

        //  净行可见性
        const netLabel = document.getElementById('info-net-label');
        const netRow = document.getElementById('info-net-row');
        const hasNet = item.net && item.net !== 'NC' &&
            item.net !== 'N/A' && item.net !== 'UNCONNECTED';
        if (netLabel) netLabel.hidden = !hasNet;
        if (netRow) netRow.hidden = !hasNet;
        if (hasNet) setText('info-net', item.net);

        //  制造商标记的 diagnostic 对该网络的期望，
        //  当源格式发布一个时（XZZ post-v6 块上
        //  一些转储，请参阅 api/board/parser/_xzz_engine_extras
        //  .py)。当网络未知或时隐藏整个块
        //  没有任何期望。
        const diagLabel = document.getElementById('info-diag-label');
        const diagRow = document.getElementById('info-diag-row');
        const diagR = document.getElementById('info-diag-resistance');
        const diagV = document.getElementById('info-diag-voltage');
        const diag = (hasNet && this._netDiagnostics)
            ? this._netDiagnostics.get(item.net) : null;
        const hasDiagR = diag && (diag.expected_resistance_ohms !== null || diag.expected_open);
        const hasDiagV = diag && diag.expected_voltage_v !== null;
        if (diagLabel) diagLabel.hidden = !(hasDiagR || hasDiagV);
        if (diagRow)   diagRow.hidden   = !(hasDiagR || hasDiagV);
        if (diagR) {
            diagR.hidden = !hasDiagR;
            if (hasDiagR) {
                if (diag.expected_open) {
                    diagR.textContent = 'Résistance : OL (≥1 kΩ ou circuit ouvert)';
                } else {
                    const ohms = diag.expected_resistance_ohms;
                    //  格式：0 → 法庭 / GND ； <1000→“Ω”； ≥1000→“kΩ”。
                    let r;
                    if (ohms === 0)        r = 'court (~0 Ω, GND ou rail)';
                    else if (ohms < 1000)  r = `${ohms.toFixed(0)} Ω`;
                    else                   r = `${(ohms / 1000).toFixed(2)} kΩ`;
                    diagR.textContent = `Résistance : ${r}`;
                }
            }
        }
        if (diagV) {
            diagV.hidden = !hasDiagV;
            if (hasDiagV) diagV.textContent = `Tension : ${diag.expected_voltage_v.toFixed(2)} V`;
        }

        //  DFM 备用 (DNP) 部分。放置的兄弟姐妹带有一个列表
        //  的 refdes 共享其物理座位但未挤满
        //  该板的变体。我们在组件中查找每一项
        //  索引以在已知时显示其足迹/价值。
        const altLabel = document.getElementById('info-alt-label');
        const altRow = document.getElementById('info-alt-row');
        const altList = document.getElementById('info-alt-list');
        const alternates = Array.isArray(item.dnp_alternates) ? item.dnp_alternates : [];
        const hasAlternates = alternates.length > 0;
        if (altLabel) altLabel.hidden = !hasAlternates;
        if (altRow)   altRow.hidden   = !hasAlternates;
        if (altList) {
            altList.innerHTML = '';
            if (hasAlternates) {
                const compIndex = this._compIndex || new Map();
                for (const refdes of alternates) {
                    const alt = compIndex.get(refdes);
                    const li = document.createElement('li');
                    if (alt) {
                        const fp = alt.footprint || alt.id;
                        const v = alt.value || '(non listé au BOM, DNP)';
                        li.innerHTML =
                            `<span class="mono">${refdes}</span> ` +
                            `<span class="muted">${fp}</span><br>` +
                            `<span class="muted">${v}</span>`;
                    } else {
                        li.innerHTML = `<span class="mono">${refdes}</span> <span class="muted">(DNP)</span>`;
                    }
                    altList.appendChild(li);
                }
            }
        }

        this.updateConnectionsPanel(item.net, item.id);

        //  对于引脚选择，点亮同一网络上的所有其他引脚
        //  自动 - 这是用户期望的操作
        //  单击打击垫。组件不会触发网络突出显示（会
        //  为与第一个引脚发生的网络相关的每个引脚着色
        //  开启，这是误导性的）。
        if (item._instanceType === 'pin' || item._instanceType === 'rectPin'
            || item._instanceType === 'dnpPin') {
            if (hasNet) this.highlightNet();
        }

        this.requestRender();
    }

    updateConnectionsPanel(netName, currentId) {
        const label = document.getElementById('info-connections-label');
        const list = document.getElementById('connections-list');
        const countEl = document.getElementById('connections-count');
        if (!list) return;

        list.innerHTML = '';

        if (!netName || netName === 'N/A' || netName === 'NC' ||
            netName === 'UNCONNECTED') {
            if (label) label.hidden = true;
            if (countEl) countEl.hidden = true;
            return;
        }

        const connectedPins = this._hoverableItems.filter(it =>
            it.net === netName && it.id !== currentId
        );
        if (!connectedPins.length) {
            if (label) label.hidden = true;
            if (countEl) countEl.hidden = true;
            return;
        }

        //  按组件分组
        const byComponent = {};
        for (const pin of connectedPins) {
            const c = pin.component || pin.id;
            (byComponent[c] = byComponent[c] || []).push(pin);
        }
        const names = Object.keys(byComponent).sort();
        const maxDisplay = 12;

        if (label) label.hidden = false;
        for (const compName of names.slice(0, maxDisplay)) {
            const pins = byComponent[compName];
            const li = document.createElement('li');
            li.className = 'brd-ins-link';
            const ref = document.createElement('span');
            ref.className = 'brd-ins-link-ref';
            ref.textContent = compName;
            const cnt = document.createElement('span');
            cnt.className = 'brd-ins-link-count';
            cnt.textContent = pins.length > 1 ? `${pins.length} pins` : '1 pin';
            li.appendChild(ref);
            li.appendChild(cnt);
            li.addEventListener('click', () => this.focusOnItem(pins[0]));
            list.appendChild(li);
        }

        if (countEl) {
            if (names.length > maxDisplay) {
                countEl.hidden = false;
                countEl.textContent = `+ ${names.length - maxDisplay} autres composants`;
            } else {
                countEl.hidden = true;
            }
        }
    }

    focusOnItem(item) {
        if (!item) return;

        this.camera.position.x = item.x;
        this.camera.position.y = item.y;
        this.onResize();
        this.selectItem(item);
    }

    clearSelection() {
        if (this.selectedItem) {
            this._setItemHighlight(this.selectedItem, false);
            this.selectedItem = null;
            this.requestRender();
        }
        this.clearNetHighlight();
        const inspector = document.getElementById('component-info');
        if (inspector) inspector.hidden = true;
    }

    highlightNet() {
        if (!this.selectedItem) return;
        const netName = this.selectedItem.net;
        if (!netName || netName === 'NC') return;

        this.clearNetHighlight();

        const selectedX = this.selectedItem.x;
        const selectedY = this.selectedItem.y;

        //  只有 PINS 属于同一网络 - _hoverableItems 也成立
        //  组件，其“net”字段镜像第一个引脚的网络，但是
        //  本身不是该网络上的节点。如果没有这个过滤器，
        //  所选引脚的网络“突出显示”发生的每个组件
        //  在同一网络上有任何引脚，并带有虚假的星形图案线
        //  每个组件质心（看起来像额外的连接
        //  不存在）。
        const sameNetItems = this._hoverableItems.filter(item =>
            (item._instanceType === 'pin' || item._instanceType === 'rectPin' ||
             item._instanceType === 'testPad') &&
            item.net === netName && item !== this.selectedItem
        );

        this.netLines = [];
        this.highlightedItems = [];

        //  飞线根据网络类别进行着色，以使其有意义
        //  那些（电源=琥珀色，地面=变暗，时钟=紫色，重置=桃色）。
        //  对于“默认”（无网络）和“信号”，类别颜色为
        //  灰色/文字——它们会在海军蓝背景下消失，
        //  灰色别针本身——所以回到青色作为代理
        //  overlay颜色。
        const cat = this.selectedItem.is_gnd
            ? 'ground'
            : this._netCategory(netName);
        const lineColor = (cat === 'default' || cat === 'signal')
            ? this.colors.netLine
            : this._pinColorForCategory(cat);

        //  将每个链接的引脚重新着色为迹线颜色，以便家庭
        //  读取为一个单元 - 没有这个，点击的信号引脚
        //  信号网保持灰色并在视觉上消失在其余网络中。
        //  选定的引脚保持青色突出显示（在 selectItem 中设置）
        //  上面）作为点击锚点。
        sameNetItems.forEach(item => {
            //  _restColor：颜色悬停应该恢复到
            //  （净迹线颜色，而不是引脚的解析时原始颜色）。
            item._restColor = lineColor;
            this._setItemHighlight(item, true, lineColor);
            this.highlightedItems.push(item);
        });

        //  将不在该网络上的每个引脚/焊盘调暗至 deep
        //  背景颜色，以便网络家庭阅读清晰，无需
        //  周围的引脚在视觉上相互竞争。跳过 GND /
        //  上面已经有未命名的网络。
        this._dimUnrelatedPins(netName);
        //  对称推铜迹线——带匹配网
        //  在完全不透明的情况下追踪到网络系列颜色，淡化
        //  不相关的网络被删除，因此活动网络的路径脱颖而出。
        //  轮廓（第 28 层）和丝网印刷（第 17 层）保持不变。
        this._highlightNetTraces(netName, lineColor);

        //  仅为正常尺寸的网绘制飞线。 GND / NC /
        //  数千针平面星形图案不可读并且
        //  坦克帧率。上限为 200 — 几乎涵盖所有指定的
        //  iPhone级主板上的功率rail（PP1V25_S2=144，
        //  PPVDD_PCPU_AWAKE=142，PP0V6_S1_VDDQL=170，...）同时仍然
        //  防止GND（X1799 上约 4348 个引脚）。
        const RATNEST_MAX_PINS = 200;
        if (sameNetItems.length + 1 > RATNEST_MAX_PINS) {
            this.requestRender();
            return;
        }

        //  带有添加剂混合的虚线：点画所以痕迹
        //  读作“代理overlay”而不是真正的铜，加上
        //  海军蓝 bg-deep 上的添加剂使青色破折号发光，
        //  即使在 1px 宽度下也保持可见（WebGL 忽略
        //  大多数驱动程序上的 LineBasicMaterial.linewidth）。深度写入=假
        //  因此重叠的线条可以干净地融合在一起。
        //
        //  飞线被渲染为 PlaneGeometry 矩形，带有
        //  平铺破折号纹理（每段一个平面，而不是一个平面
        //  每破折号）。为什么：Chromium 上的 WebGL 将“线宽”限制为
        //  1 个设备像素，在 HiDPI 上也 ≈ 0.5 CSS 像素
        //  注册起来很薄，所以我们使用真实网格厚度代替。
        //  通过纹理 UV 重复进行平铺可将 200 针网络保持在
        //  总共 200 个网格（相比之下，当每个破折号都是自己的时，网格数量为 600+
        //  plane），这让 onResize 可以就地更新它们。
        const material = new THREE.MeshBasicMaterial({
            color: lineColor,
            map: this._flyDashTexture,
            opacity: 1.0,
            transparent: true,
            alphaTest: 0.5,
            depthWrite: false,
            depthTest: false,
            side: THREE.DoubleSide,
        });

        //  每行 z 远远高于引脚实例 (z=2/2.5)，因此
        //  蝇网漂浮在其他一切之上。
        const flyZ = 6;
        //  当观看者被过滤到单个面孔时（顶部/底部）
        //  电路板具有双轮廓，隐藏面的引脚已激活
        //  在并排间隙区域中关闭 - 将飞线指向直线
        //  他们看起来像是断了的（线条飞进了空旷的空间）。项目
        //  将它们放到可见面的框架上并放置端点
        //  在电路板基板后面，因此线路明显“潜入”
        //  董事会，告诉技术人员连接仍在继续
        //  隐藏的一面。在 BOTH 模式下，并排保留原始内容
        //  行为 - 隐藏的图钉就在屏幕上。
        const startPos = this._netEndpointPos(this.selectedItem, flyZ);
        if (!this._netHiddenMarkers) this._netHiddenMarkers = [];
        const thickness = this._flyThicknessWorld();
        const { dashWorld, gapWorld } = this._flyDashWorld();
        sameNetItems.forEach(item => {
            const endPos = this._netEndpointPos(item, flyZ);
            this._createFlyLineDashed(
                startPos, endPos, material, thickness, dashWorld, gapWorld
            );
            //  跨面端点？放置可点击的向下箭头标记
            //  在投影的 XY 处，因此技术人员会看到“此连接
            //  在另一张脸上继续”，并且可以directly翻转到它。
            const isHidden = endPos.z < 0
                && item._side
                && this.sideMode !== 'both'
                && item._side !== this.sideMode;
            if (isHidden) {
                this._addSideFlipArrow(endPos.x, endPos.y, item._side);
            }
        });
        //  如果（很少）选择了，还可以在开始侧放置一个箭头
        //  别针本身最终出现在隐藏的脸上——通常是特工
        //  选择一个可见的图钉，但从 refdes 可以选择“bv_highlight”
        //  也落在隐藏的针上。
        if (startPos.z < 0
            && this.selectedItem._side
            && this.sideMode !== 'both'
            && this.selectedItem._side !== this.sideMode) {
            this._addSideFlipArrow(startPos.x, startPos.y, this.selectedItem._side);
        }

        //  现在将 V 形图案固定到固定的屏幕像素高度
        //  该批次已添加。
        this._updateSideArrowScale();
        this.requestRender();
    }

    /**
     * 无论如何，将侧翻 V 形保持在固定的像素高度
     * 缩放 - 与 refdes 标签相同的方法 - 所以它们保持不变
     * 当用户放大时，易于点击而不会变大。
     
     */
    _updateSideArrowScale() {
        if (!this._netHiddenMarkers || !this._netHiddenMarkers.length) return;
        const h = (this.container && this.container.clientHeight) || 800;
        const pixelSize = this.frustumSize / h;
        const targetPx = 28;
        const worldSize = targetPx * pixelSize;
        for (const sprite of this._netHiddenMarkers) {
            sprite.scale.set(worldSize, worldSize, 1);
            if (sprite.userData) {
                sprite.userData.width = worldSize;
                sprite.userData.height = worldSize;
            }
        }
    }

    /**
     * 在 (x, y) 处绘制一个小的可点击的向下 V 形，标记飞线
     * 物理上位于隐藏面上的端点。点击翻转
     * 观众看到那张脸。在 `_netHiddenMarkers` 中跟踪
     * `clearNetHighlight` 将它们与线条一起删除。
     
     */
    _addSideFlipArrow(x, y, targetSide) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        canvas.width = 64 * dpr;
        canvas.height = 64 * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        //  玻璃背景光盘，以便在繁忙区域读取 V 形图案。
        ctx.fillStyle = 'rgba(15, 22, 35, 0.85)';
        ctx.beginPath();
        ctx.arc(32, 32, 26, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(95, 199, 255, 0.95)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        //  下V字形。
        const chevColor = '#5fc7ff';
        ctx.strokeStyle = chevColor;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(20, 26);
        ctx.lineTo(32, 40);
        ctx.lineTo(44, 26);
        ctx.stroke();

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
        });
        const sprite = new THREE.Sprite(material);
        //  坐在飞线 z 上方，使圆盘在飞线 z 上方不透明
        //  青色虚线；世界尺寸（以毫米为单位）通过缩放重新缩放
        //  `_updateSideArrowScale`（保持约 22 像素高）。
        sprite.position.set(x, y, 7);
        const worldSize = this.frustumSize ? this.frustumSize * 0.04 : 2.5;
        sprite.scale.set(worldSize, worldSize, 1);
        sprite.userData = {
            _instanceType: 'sideArrow',
            _targetSide: targetSide,
            x, y,
            width: worldSize,
            height: worldSize,
            type: 'SIDE_FLIP',
            id: '',
            net: '',
            //  _side null 因此侧面过滤器不会隐藏箭头。
            _side: null,
            _mesh: sprite,
        };
        this._hoverableItems.push(sprite.userData);
        this._netHiddenMarkers.push(sprite);
        this.scene.add(sprite);
        //  空间网格在加载时构建一次；不插入
        //  箭头的代理进入其中，`_getNearbyItems`返回 no
        //  光标周围的候选人和点击永远不会被记录。
        this._addToSpatialGrid(sprite.userData);
    }

    _addToSpatialGrid(item) {
        if (!this._spatialGrid) return;
        const key = this._getGridKey(item.x, item.y);
        if (!this._spatialGrid[key]) this._spatialGrid[key] = [];
        this._spatialGrid[key].push(item);
    }

    /**
     * 给定电流解析引脚/测试焊盘的飞线端点 XYZ
     * 侧面过滤器。当图钉位于隐藏面上时（例如选定的
     * 引脚为 TOP 侧，sideMode='top'，目标引脚为 BOTTOM 侧），
     * 引脚的显示 XY 位于可见区域旁边的空白区域
     * 脸——不是技术期望连接的地方。项目
     * 它到可见面的框架上（减去界面增量
     * 沿双轮廓轴）并将 z 放在板下方，以便
     * 线潜入基质下方，发出信号“这张网仍在继续
     *在另一边”。
     
     */
    _netEndpointPos(item, defaultZ) {
        const visibleZ = defaultZ;
        const hiddenZ = -2;  //  z=0.5 处的板轮廓后面
        if (this.sideMode === 'both' || !item._side) {
            return { x: item.x, y: item.y, z: visibleZ };
        }
        if (item._side === this.sideMode) {
            return { x: item.x, y: item.y, z: visibleZ };
        }
        //  隐藏面上的物品。没有双轮廓布局
        //  （单板格式：.fz / .cad GenCAD / KiCad / BRD），
        //  引脚的显示 X/Y 已经与其物理位置相匹配
        //  板子 — 顶侧和底侧的 XY 相同。下降 Z
        //  位于基材下方，因此飞线“潜入”下方，并且
        //  侧翻 V 字形降落在可见点，让
        //  技术点击可翻转到垫子所在的实际面。
        if (!this.dualOutline) {
            return { x: item.x, y: item.y, z: hiddenZ };
        }
        //  图钉位于隐藏面上。将其显示位置映射到
        //  OpenBoardView 后面的可见面坐标系
        //  翻转约定：对于并排 X 分割
        //  底视图是翻转物理板的结果
        //  围绕其垂直边缘，因此 X 轴在
        //  面（顶部左侧 = 底部右侧，相同的物理引脚）。
        //  对于堆叠 Y 分割，请改为镜像 Y。
        //
        //  镜像公式 `T.x + B.x + B.w - pin.x` 是对称的：
        //  它对于顶部→底部和底部→顶部同样有效，因为
        //  镜子是它自己的反面。 Y（X 下的非分割轴
        //  split）只是通过接口原点增量进行平移 - 并且
        //  该增量根据目标面翻转符号。
        const dual = this.dualOutline;
        const top = dual.bbox_top;
        const bot = dual.bbox_bottom;
        let tx, ty;
        if (dual.axis === 'x') {
            tx = top.x + bot.x + bot.w - item.x;
            const tyOffset = this.sideMode === 'top'
                ? (top.y - bot.y)
                : (bot.y - top.y);
            ty = item.y + tyOffset;
        } else {
            ty = top.y + bot.y + bot.h - item.y;
            const txOffset = this.sideMode === 'top'
                ? (top.x - bot.x)
                : (bot.x - top.x);
            tx = item.x + txOffset;
        }
        return { x: tx, y: ty, z: hiddenZ };
    }

    clearNetHighlight() {
        if (this.highlightedItems && this.highlightedItems.length > 0) {
            //  在恢复颜色之前删除每网静止覆盖
            //  所以`_setItemHighlight(item, false)`会捕捉到originalColor
            //  而不是循环回到刚刚清除的净颜色。
            this.highlightedItems.forEach(item => {
                delete item._restColor;
                this._setItemHighlight(item, false);
            });
            this.highlightedItems = [];
        }
        //  将变暗的引脚恢复到原来的颜色。
        this._undimAllPins();
        //  并将铜迹线恢复到解析时间
        //  颜色+不透明度，以便下一个网络选择开始干净。
        this._undimAllTraces();

        if (this.netLines && this.netLines.length > 0) {
            this.netLines.forEach(line => this.scene.remove(line));
            this.netLines = [];
        }

        if (this._netHiddenMarkers && this._netHiddenMarkers.length > 0) {
            //  放下侧翻箭头+它们的可悬停代理，这样
            //  新鲜的选择不会积累陈旧的 V 形或保留
            //  底层线消失后的点击目标。
            const markerProxies = new Set(
                this._netHiddenMarkers.map((s) => s.userData)
            );
            this._netHiddenMarkers.forEach((s) => this.scene.remove(s));
            this._netHiddenMarkers = [];
            this._hoverableItems = this._hoverableItems.filter(
                (it) => !markerProxies.has(it)
            );
            //  从每个空间网格单元中剥离相同的代理
            //  引用它们的——否则陈旧的条目会保留
            //  V 形消失后匹配 `_getNearbyItems`。
            if (this._spatialGrid) {
                for (const key of Object.keys(this._spatialGrid)) {
                    this._spatialGrid[key] = this._spatialGrid[key].filter(
                        (it) => !markerProxies.has(it)
                    );
                }
            }
        }

        this.requestRender();
    }

    // ========================
    //  电路板装载 - 优化
    // ========================

    loadBoard(data) {
        console.time('[PERF] loadBoard');

        this.boardData = data;
        this.clearScene();

        if (data.error) {
            console.error('Load error:', data.message);
            alert('Error: ' + data.message);
            return;
        }

        this.offsetX = data.board_offset_x || 0;
        this.offsetY = data.board_offset_y || 0;

        //  XZZ式双重布局（顶部+底部视图在同一坐标
        //  空间）。当存在时，后端已经标记了每个
        //  带有“_side”的实体，并且侧面切换默认为“both”。
        this.dualOutline = data.dual_outline || null;
        this.sideMode = 'both';

        //  净 diagnostic 期望（XZZ 某些主板上的 v6 后区块
        //  制造商倾销）。按网络名称索引以进行 O(1) 查找
        //  选择时间。板上的空白地图没有 diagnostic 数据
        //  — 在这种情况下，inspector 会隐藏行。
        this._netDiagnostics = new Map();
        for (const d of (data.net_diagnostics || [])) {
            this._netDiagnostics.set(d.name, d);
        }

        //  1. 创建板轮廓
        this.createBoard(data);

        //  2. 几何边缘手指检测 — 必须在组件之前运行
        //        并且建立了针网格，因此它的突变在“comp.layer”上
        //        （清除边缘连接器的侧面指定）和
        //        每个指针的形状/尺寸落在数据上
        //        建设者阅读。
        if (data.pins && data.components) {
            this._applyEdgeFingerDetection(data.pins, data.components);
        }

        //  3. 创建组件（单个网格 - 通常 < 500）
        console.time('[PERF] components');
        //  构建一次 refdes -> 组件查找，以便信息面板可以
        //  将 `dnp_alternates` refdes 解析回其足迹/
        //  值，而无需在每次选择时重新扫描数组。
        this._compIndex = new Map();
        if (data.components) {
            for (const c of data.components) this._compIndex.set(c.id, c);
            data.components.forEach(c => this.createComponent(c));
        }
        console.timeEnd('[PERF] components');

        //  4.使用InstancedMesh创建引脚（主要优化）
        console.time('[PERF] pins-instanced');
        if (data.pins) {
            this._createPinsInstanced(data.pins);
        }
        console.timeEnd('[PERF] pins-instanced');

        //  4. 使用InstancedMesh创建过孔
        console.time('[PERF] vias-instanced');
        if (data.vias && data.vias.length > 0) {
            this._createViasInstanced(data.vias);
        }
        console.timeEnd('[PERF] vias-instanced');

        //  5. 使用InstancedMesh创建测试垫
        console.time('[PERF] testpads-instanced');
        if (data.test_pads) {
            this._createTestPadsInstanced(data.test_pads);
        }
        console.timeEnd('[PERF] testpads-instanced');

        //  6. 创建痕迹（线）
        if (data.traces) {
            data.traces.forEach(t => this.createTrace(t));
        }

        //  6b.制造商检验标记（XZZ type_03 overlays）。
        //  大多数主板上都是空的——有些主板上有 15 个这样的矩形
        //  OEM 标记为诊断感兴趣区域。
        //  渲染为上面的半透明琥珀色描边矩形
        //  板层，引脚下方，无填充。
        if (data.markers && data.markers.length > 0) {
            this._createInspectionMarkers(data.markers);
        }

        //  6c.机械孔 — GenCAD `.cad` 文件中的 `$MECH HOLE`。
        //  固定孔（4 个 PCB 角螺钉）呈现为钢灰色
        //  以全半径围绕空心中心形成环；中心基准点
        //  渲染为一个小的填充金点。始终可见，不可能
        //  切换 - 它们是电路板结构，而不是信号数据。
        if (data.mech_holes && data.mech_holes.length > 0) {
            this._createMechHoles(data.mech_holes);
        }

        //  7. 为 O(1) 悬停构建空间网格
        console.time('[PERF] spatial-grid');
        this._buildSpatialGrid();
        console.timeEnd('[PERF] spatial-grid');

        //  Center camera
        const centerX = this.offsetX + data.board_width / 2;
        const centerY = this.offsetY + data.board_height / 2;
        this.camera.position.x = centerX;
        this.camera.position.y = centerY;
        this.frustumSize = Math.max(data.board_width, data.board_height) * 1.2;
        this.zoom = 100 / this.frustumSize;
        this.onResize();
        //  Restore the technician's preferred side mode. Falls back to
        //  'both' on first run or when localStorage is unavailable.
        let savedMode = 'both';
        try {
            const v = localStorage.getItem('pcb.sideMode');
            if (v === 'top' || v === 'bottom' || v === 'both') savedMode = v;
        } catch (_) {}
        this.setSideMode(savedMode);

        //  Update stats
        document.getElementById('stats-components').textContent = data.components_count || 0;
        document.getElementById('stats-pins').textContent = data.pins_count || 0;
        document.getElementById('stats-nets').textContent = data.nets_count || 0;
        document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
        document.getElementById('no-file-message').classList.add('hidden');

        //  Handle format-specific UI
        const formatType = (data.format_type || '').toLowerCase();
        const dualBtn = document.getElementById('dual-view');
        const flipBtn = document.getElementById('flip-board');

        if (formatType === 'brd') {
            if (dualBtn) dualBtn.classList.remove('hidden');
            if (flipBtn) flipBtn.classList.remove('hidden');
            if (!this.isDualView) {
                this.isDualView = true;
                if (dualBtn) {
                    dualBtn.classList.remove('bg-dark-600', 'text-gray-400', 'border-dark-500');
                    dualBtn.classList.add('bg-green-500/20', 'text-green-400', 'border-green-500/30');
                }
                this.createDualViewGroup();
                this.centerDualView();
            }
        } else if (formatType === 'pcb' || formatType === 'xzz') {
            if (dualBtn) dualBtn.classList.add('hidden');
            if (flipBtn) flipBtn.classList.add('hidden');
            if (this.isDualView) {
                this.isDualView = false;
                this.removeDualViewGroup();
            }
        } else {
            if (dualBtn) dualBtn.classList.remove('hidden');
            if (flipBtn) flipBtn.classList.remove('hidden');
            if (this.isDualView) {
                this.createDualViewGroup();
                this.centerDualView();
            }
        }

        this.requestRender();
        console.timeEnd('[PERF] loadBoard');

        const totalObjects = (data.pins?.length || 0) + (data.vias?.length || 0) + (data.test_pads?.length || 0);
        console.log(`[PERF] Loaded ${totalObjects} objects with InstancedMesh optimization`);
    }

    /**
     * Detect edge-finger connectors and retune each finger's pad
     * shape / dimensions before pin instancing.
     *
     * An "edge finger" pattern is the dense single-row pad layout used
     * by every PCIe / CrossFire / SLI / MXM / DDR / sodimm-style slot:
     * 15+ pads arranged on a single line with a regular pitch. The
     * pads are physically long rectangles oriented perpendicular to
     * the line so they can mate with a card edge. Some sources only
     * carry the small probe-target square per pad (~22 mils on PCIe),
     * which renders as a row of dots that hides the connector layout
     * — this pass restores the visual connector identity.
     *
     * Detection is purely geometric: we look at every component with
     * ≥ 15 pins, check that one axis is wide and the other is narrow
     * (collinear), and confirm the inter-pin pitch is regular within
     * 30 % stddev / mean. When that holds, each pin's `shape` becomes
     * `'rect'` and its width/height are retuned so the long edge
     * follows the body silkscreen's perpendicular extent (typically
     * ~55 % of `comp.height` for a horizontal slot) and the short
     * edge takes ~55 % of the pitch — proportions that match the
     * physical pad layout of a real edge connector.
     
     */
    _applyEdgeFingerDetection(pins, components) {
        const compIndex = new Map();
        for (const c of (components || [])) compIndex.set(c.id, c);

        const pinsByComp = new Map();
        for (const p of pins) {
            if (!p.component) continue;
            let bucket = pinsByComp.get(p.component);
            if (!bucket) {
                bucket = [];
                pinsByComp.set(p.component, bucket);
            }
            bucket.push(p);
        }

        const MIN_FINGERS = 15;
        const PITCH_REGULARITY_MAX_CV = 0.30;  //  gap stddev / mean cap
        const COLLINEAR_RATIO = 0.05;  //  perpendicular spread must be ≤ 5% of axis spread
        const COLLINEAR_FLOOR_MM = 0.05;  //  floor (probe-target jitter on a perfect line)
        const PITCH_MM_MIN = 0.3;
        const PITCH_MM_MAX = 5.0;
        const PAD_ALONG_FRAC = 0.55;
        const PAD_PERP_FRAC = 0.55;

        let detected = 0;
        for (const [refdes, compPins] of pinsByComp) {
            if (compPins.length < MIN_FINGERS) continue;

            const xs = compPins.map(p => p.x);
            const ys = compPins.map(p => p.y);
            const xMin = Math.min(...xs), xMax = Math.max(...xs);
            const yMin = Math.min(...ys), yMax = Math.max(...ys);
            const spreadX = xMax - xMin;
            const spreadY = yMax - yMin;

            const isHorizontalAxis = spreadX >= spreadY;
            const axisSpread = isHorizontalAxis ? spreadX : spreadY;
            const perpSpread = isHorizontalAxis ? spreadY : spreadX;
            if (axisSpread <= 0) continue;
            if (perpSpread > axisSpread * COLLINEAR_RATIO + COLLINEAR_FLOOR_MM) continue;

            const axisVals = (isHorizontalAxis ? xs : ys).slice().sort((a, b) => a - b);
            const gaps = [];
            for (let i = 1; i < axisVals.length; i++) {
                const g = axisVals[i] - axisVals[i - 1];
                if (g > 1e-6) gaps.push(g);
            }
            if (gaps.length === 0) continue;
            const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            if (meanGap < PITCH_MM_MIN || meanGap > PITCH_MM_MAX) continue;
            const variance = gaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / gaps.length;
            const stddev = Math.sqrt(variance);
            if (stddev / meanGap > PITCH_REGULARITY_MAX_CV) continue;

            //  Estimate the perpendicular pad extent from the
            //  component's silkscreen body when available — fingers run
            //  ~55 % of the body's perpendicular extent on real
            //  连接器。元件间距回落至 4 × 间距
            //  没有 body_lines。
            const comp = compIndex.get(refdes);
            let perpExtent = meanGap * 4.0;
            if (comp && Array.isArray(comp.body_lines) && comp.body_lines.length > 0) {
                let minP = Infinity, maxP = -Infinity;
                for (const seg of comp.body_lines) {
                    const v1 = isHorizontalAxis ? seg.y1 : seg.x1;
                    const v2 = isHorizontalAxis ? seg.y2 : seg.x2;
                    if (v1 < minP) minP = v1;
                    if (v2 < minP) minP = v2;
                    if (v1 > maxP) maxP = v1;
                    if (v2 > maxP) maxP = v2;
                }
                const bodyPerp = maxP - minP;
                if (isFinite(bodyPerp) && bodyPerp > 0) {
                    perpExtent = bodyPerp;
                }
            }

            const padAlong = meanGap * PAD_ALONG_FRAC;
            const padPerp = perpExtent * PAD_PERP_FRAC;

            for (const p of compPins) {
                p.shape = 'rect';
                if (isHorizontalAxis) {
                    p.width = padAlong;
                    p.height = padPerp;
                } else {
                    p.width = padPerp;
                    p.height = padAlong;
                }
                //  边缘连接器在物理上承载手指
                //  PCB 的面，但来源只运送
                //  可进行探针测试的面。标记图钉以便观看者
                //  无论顶部/底部如何，都将其表面化
                //  过滤器 - 相同的逻辑垫，在任一上可见
                //  查看direct离子。将标记存储在引脚上
                //  （而不是改变它的“layer”）保留
                //  现有的层派生簿记（z 位置，
                //  悬停调度、信息面板）未受影响。
                p._edgeFinger = true;
            }
            //  对组件本身进行相同的处理：清除其
            //  侧面指定让主体丝印/bbox/标签
            //  以仅面部模式出现。没有这个，垫
            //  会显示，但载体组件将从中消失
            //  仅顶部视图（或相反情况下仅底部视图），
            //  给连接器一个“没有主体的幽灵焊盘”
            //  外观。
            if (comp) {
                comp._edgeFinger = true;
                comp._side = null;
                comp.layer = null;
            }
            detected += 1;
        }
        if (detected > 0) {
            console.log(`[edge-fingers] retuned pads on ${detected} connector(s)`);
        }
    }

    /**
     * 使用 InstancedMesh 创建所有引脚 - 所有圆形引脚的单一绘制调用
     
     */
    _createPinsInstanced(pins) {
        //  用于放置 AND DFM 备用 (DNP) 引脚的单个管道。
        //  每个引脚在有效负载中都带有一个“is_dnp”标志；的
        //  下面的构建器将每个实例存储在“_dnpFlags”中，因此
        //  `setShowDnp` 通过 `_applySideToInstanced` 翻转矩阵
        //  （与侧面过滤器相同的零刻度机制），并且每个
        //  标准管道（悬停、按网络着色、信息面板、网络
        //  突出显示）自动将 DNP 引脚作为普通引脚处理。
        const circularPins = [];
        const rectPinsBySize = new Map();
        const kindMap = { square: 's', oval: 'o', rect: 'r' };

        pins.forEach((pin, index) => {
            if (pin.shape === 'circle') {
                circularPins.push({ ...pin, _originalIndex: index });
            } else {
                const kind = kindMap[pin.shape] || 'r';
                const sizeKey = `${kind}_${Math.round(pin.width * 1000)}_${Math.round(pin.height * 1000)}`;
                if (!rectPinsBySize.has(sizeKey)) rectPinsBySize.set(sizeKey, []);
                rectPinsBySize.get(sizeKey).push({ ...pin, _originalIndex: index });
            }
        });

        if (circularPins.length > 0) this._createCircularPinsInstanced(circularPins);
        rectPinsBySize.forEach((rectPins, sizeKey) => {
            this._createRectPinsInstanced(rectPins, sizeKey);
        });
    }

    //  _createDnpCircularPinsMesh / _createDnpRectPinsMesh 保留用于
    //  与任何外部调用者向后兼容，但主管道
    //  现在将 DNP 引脚直接烘焙到 `_circularPinInstance` /
    //  带有“_dnpFlags”掩码的“_rectPinInstances”，所以这些助手
    //  标准加载路径中有no-ops。
    _createDnpCircularPinsMesh(pins) {
        const count = pins.length;
        const geometry = this._sharedGeometries.circlePin;
        const material = new THREE.MeshBasicMaterial({
            color: 0x6b7280,
            transparent: true,
            opacity: 0.4,
            depthWrite: false,
        });
        const mesh = new THREE.InstancedMesh(geometry, material, count);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const matrix = new THREE.Matrix4();
        pins.forEach((pin, i) => {
            const r = pin.width / 2;
            matrix.makeScale(r, r, 1);
            const z = pin.layer === 'top' ? 2 : (pin.layer === 'bottom' ? 1 : 1.5);
            matrix.setPosition(pin.x, pin.y, z);
            if (pin.rotation) {
                const rot = new THREE.Matrix4().makeRotationZ(pin.rotation * Math.PI / 180);
                matrix.multiply(rot);
            }
            mesh.setMatrixAt(i, matrix);
            //  注册可悬停，因此单击 DNP 引脚即可打开信息
            //  面板就像放置的图钉一样。悬停代码读取
            //  `_instanceType` 分派到正确的网格；我们用一个
            //  专用的“dnpPin”类型，因此悬停颜色操作不会尝试
            //  重新着色 DNP 网格的实例（我们希望它们保留
            //  统一灰色）。
            this._hoverableItems.push({
                ...pin,
                _instanceType: 'dnpPin',
                _instanceId: i,
                _side: pin._edgeFinger ? null : (pin._side || pin.layer || null),
                originalColor: 0x6b7280,
                type: 'Pin',
            });
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.visible = !!this._showDnp;
        mesh.userData._dnpLayer = true;
        this.scene.add(mesh);
        this._dnpMeshes.push(mesh);
    }

    /**
     * 独立 InstancedMesh 用于 DFM-替代矩形垫。
     * 与放置的矩形引脚构建器相同的形状几何形状（圆形
     * 角部带有绝对帽，以保持大焊盘明显呈方形），
     * 但均匀的静音灰色 + 低不透明度 + 无每针边框线。
     
     */
    _createDnpRectPinsMesh(pins, sizeKey) {
        const count = pins.length;
        const w = pins[0].width;
        const h = pins[0].height;
        const kind = sizeKey ? sizeKey.charAt(0) : 'r';
        let radiusFactor = 0.15;
        let radiusCapMm = 0.12;
        if (kind === 's') { radiusFactor = 0; radiusCapMm = 0; }
        else if (kind === 'o') { radiusFactor = 0.5; radiusCapMm = Infinity; }
        const shape = new THREE.Shape();
        const r = Math.min(Math.min(w, h) * radiusFactor, radiusCapMm);
        this._createRoundedRectShape(shape, w, h, r);
        const geometry = new THREE.ShapeGeometry(shape);

        const material = new THREE.MeshBasicMaterial({
            color: 0x6b7280,
            transparent: true,
            opacity: 0.4,
            depthWrite: false,
        });
        const mesh = new THREE.InstancedMesh(geometry, material, count);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const matrix = new THREE.Matrix4();
        pins.forEach((pin, i) => {
            matrix.identity();
            const z = pin.layer === 'top' ? 2 : (pin.layer === 'bottom' ? 1 : 1.5);
            matrix.setPosition(pin.x, pin.y, z);
            if (pin.rotation) {
                const rot = new THREE.Matrix4().makeRotationZ(pin.rotation * Math.PI / 180);
                matrix.multiply(rot);
            }
            mesh.setMatrixAt(i, matrix);
            this._hoverableItems.push({
                ...pin,
                _instanceType: 'dnpPin',
                _instanceId: i,
                _side: pin._edgeFinger ? null : (pin._side || pin.layer || null),
                originalColor: 0x6b7280,
                type: 'Pin',
            });
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.visible = !!this._showDnp;
        mesh.userData._dnpLayer = true;
        this.scene.add(mesh);
        this._dnpMeshes.push(mesh);
    }

    _createCircularPinsInstanced(pins) {
        const count = pins.length;
        const geometry = this._sharedGeometries.circlePin;
        const material = this._sharedMaterials.pinFill.clone();

        //  创建实例网格
        const instancedMesh = new THREE.InstancedMesh(geometry, material, count);
        instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

        //  启用每个实例的颜色
        instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(count * 3), 3
        );

        //  侧过滤器的每个实例状态：保留矩阵
        //  在构建时设置，因此我们可以在它和零之间交换
        //  当用户切换顶部/底部/两者时的矩阵。 `_dnpFlags`
        //  跟踪 DFM 替代 (DNP) 实例，因此具有相同的零标度
        //  当 DNP 切换关闭时，机制将对其进行门控。
        instancedMesh.userData._matrices = new Array(count);
        instancedMesh.userData._sides = new Array(count);
        instancedMesh.userData._dnpFlags = new Array(count);
        //  每个插槽的父组件 refdes — 驱动 bv_filter_by_type
        //  refdes-前缀过滤器。 `_applySideToInstanced` 与此
        //  旁边 + DNP 门。
        instancedMesh.userData._components = new Array(count);

        const matrix = new THREE.Matrix4();
        const color = new THREE.Color();

        pins.forEach((pin, i) => {
            const radius = pin.width / 2;
            const cat = (pin.is_gnd || pin.net === 'GND') ? 'ground' : this._netCategory(pin.net);
            const pinColor = this._resolvePinColor(pin, cat);

            //  设置位置和比例。 DNP 实例以零缩放启动
            //  直到启用 DNP 切换。
            const isDnp = !!pin.is_dnp;
            if (isDnp && !this._showDnp) {
                matrix.identity();
                matrix.makeScale(0, 0, 0);
            } else {
                matrix.makeScale(radius, radius, 1);
                const zPos = pin.layer === 'top' ? 2 : (pin.layer === 'bottom' ? 1 : 1.5);
                matrix.setPosition(pin.x, pin.y, zPos);
                if (pin.rotation) {
                    const rotMatrix = new THREE.Matrix4().makeRotationZ(pin.rotation * Math.PI / 180);
                    matrix.multiply(rotMatrix);
                }
            }

            instancedMesh.setMatrixAt(i, matrix);

            //  无论如何，将*全尺寸*矩阵存储在`_matrices`中
            //  所以 side+DNP 刷新例程将引脚恢复到其状态
            //  当两个过滤器都允许时的真实位置。
            const fullMatrix = new THREE.Matrix4().makeScale(radius, radius, 1);
            const zPos = pin.layer === 'top' ? 2 : (pin.layer === 'bottom' ? 1 : 1.5);
            fullMatrix.setPosition(pin.x, pin.y, zPos);
            if (pin.rotation) {
                fullMatrix.multiply(new THREE.Matrix4().makeRotationZ(pin.rotation * Math.PI / 180));
            }
            instancedMesh.userData._matrices[i] = fullMatrix;
            instancedMesh.userData._sides[i] = pin._side || null;
            instancedMesh.userData._dnpFlags[i] = isDnp;
            instancedMesh.userData._components[i] = pin.component || null;

            //  设置颜色
            color.setHex(pinColor);
            instancedMesh.setColorAt(i, color);

            //  存储悬停/选择数据
            const itemData = {
                ...pin,
                _instanceType: 'pin',
                _instanceId: i,
                _side: pin._edgeFinger ? null : (pin._side || null),
                originalColor: pinColor,
                type: 'Pin'
            };
            this._pinInstanceData.push(itemData);
            this._hoverableItems.push(itemData);
        });

        instancedMesh.instanceMatrix.needsUpdate = true;
        instancedMesh.instanceColor.needsUpdate = true;

        this._circularPinInstance = instancedMesh;
        this.scene.add(instancedMesh);

        //  每个引脚的细边框环绘制在填充的上方
        //  中灰色与海军蓝背景和大多数背景形成鲜明对比
        //  焊盘颜色 - 因此每个焊盘即使在
        //  密集的连接器/IC。
        const ringGeom = this._sharedGeometries.circlePinRing;
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0x4b5563,  //  tailwind grey-600 — 在填充填充和 bg-deep 上均可读
            transparent: true,
            opacity: 0.95,
            side: THREE.DoubleSide,
            depthTest: false,
        });
        const ringMesh = new THREE.InstancedMesh(ringGeom, ringMat, count);
        ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        ringMesh.userData._matrices = new Array(count);
        ringMesh.userData._sides = new Array(count);
        ringMesh.userData._dnpFlags = new Array(count);
        ringMesh.userData._components = new Array(count);
        pins.forEach((pin, i) => {
            const radius = pin.width / 2;
            const isDnp = !!pin.is_dnp;
            const fullMatrix = new THREE.Matrix4().makeScale(radius, radius, 1);
            const zPos = pin.layer === 'top' ? 2.05 : (pin.layer === 'bottom' ? 1.05 : 1.55);
            fullMatrix.setPosition(pin.x, pin.y, zPos);
            if (pin.rotation) {
                fullMatrix.multiply(new THREE.Matrix4().makeRotationZ(pin.rotation * Math.PI / 180));
            }
            //  初始渲染时间矩阵：零尺度 DNP 响铃直至
            //  开关处于打开状态，否则为满量程。
            const visible = !isDnp || this._showDnp;
            ringMesh.setMatrixAt(i, visible
                ? fullMatrix
                : new THREE.Matrix4().makeScale(0, 0, 0));
            ringMesh.userData._matrices[i] = fullMatrix;
            ringMesh.userData._sides[i] = pin._side || null;
            ringMesh.userData._dnpFlags[i] = isDnp;
            ringMesh.userData._components[i] = pin.component || null;
        });
        ringMesh.instanceMatrix.needsUpdate = true;
        this._circularPinBorderInstance = ringMesh;
        this.scene.add(ringMesh);

        console.log(`[PERF] Created ${count} circular pins + borders with 2 draw calls`);
    }

    _createRectPinsInstanced(pins, sizeKey) {
        const count = pins.length;
        const [kind, widthStr, heightStr] = sizeKey.split('_');
        //  sizeKey 存储桶（以微米为单位）（请参阅 _createPinsInstanced）。
        const w = parseFloat(widthStr) / 1000;
        const h = parseFloat(heightStr) / 1000;

        //  方形 = 尖角（板对板连接器焊盘）。
        //  矩形 = 软 15% 圆角（标准 SMD 焊盘），但是
        //                    上限为较小的绝对值，因此焊盘较大
        //                    （MOSFET 漏极，电解 SMD 焊盘位于 4-6 mm）
        //                    保持明显的矩形而不是阴影成
        //                    磁盘。如果没有盖子，4.5 毫米焊盘的 15% 会给出
        //                    0.7 毫米倒角，读作圆角
        //                    抗锯齿。
        //  椭圆形=全半轴半径（长方形的药丸/胶囊
        //                    测试垫landings)。
        let radiusFactor = 0.15;
        let radiusCapMm = 0.12;     //  约 5 百万 — 倒角在大焊盘上几乎看不见
        if (kind === 's') {
            radiusFactor = 0;
            radiusCapMm = 0;
        } else if (kind === 'o') {
            radiusFactor = 0.5;
            radiusCapMm = Infinity; //  药帽需要全半轴
        }
        const shape = new THREE.Shape();
        const r = Math.min(Math.min(w, h) * radiusFactor, radiusCapMm);
        this._createRoundedRectShape(shape, w, h, r);
        const geometry = new THREE.ShapeGeometry(shape);

        const material = this._sharedMaterials.pinFill.clone();
        const instancedMesh = new THREE.InstancedMesh(geometry, material, count);
        instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

        instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(count * 3), 3
        );
        instancedMesh.userData._matrices = new Array(count);
        instancedMesh.userData._sides = new Array(count);
        instancedMesh.userData._dnpFlags = new Array(count);
        instancedMesh.userData._components = new Array(count);

        const matrix = new THREE.Matrix4();
        const color = new THREE.Color();

        pins.forEach((pin, i) => {
            const cat = (pin.is_gnd || pin.net === 'GND') ? 'ground' : this._netCategory(pin.net);
            const pinColor = this._resolvePinColor(pin, cat);
            const isDnp = !!pin.is_dnp;

            const fullMatrix = new THREE.Matrix4();
            fullMatrix.identity();
            //  边缘手指：抬起到 z=2.3，这样它们就位于两个面的上方
            //  普通焊盘/探头。物理边缘连接器
            //  存在于PCB的两面，其手指是
            //  老虎机的标准视觉提示——将它们保持在顶部。
            const zPos = pin._edgeFinger
                ? 2.3
                : (pin.layer === 'top' ? 2 : (pin.layer === 'bottom' ? 1 : 1.5));
            fullMatrix.setPosition(pin.x, pin.y, zPos);
            if (pin.rotation) {
                fullMatrix.multiply(new THREE.Matrix4().makeRotationZ(pin.rotation * Math.PI / 180));
            }

            const visible = !isDnp || this._showDnp;
            instancedMesh.setMatrixAt(i, visible
                ? fullMatrix
                : new THREE.Matrix4().makeScale(0, 0, 0));
            instancedMesh.userData._matrices[i] = fullMatrix;
            instancedMesh.userData._sides[i] = pin._edgeFinger ? null : (pin._side || null);
            instancedMesh.userData._dnpFlags[i] = isDnp;
            instancedMesh.userData._components[i] = pin.component || null;
            color.setHex(pinColor);
            instancedMesh.setColorAt(i, color);

            const itemData = {
                ...pin,
                _instanceType: 'rectPin',
                _instanceId: i,
                _sizeKey: sizeKey,
                _side: pin._edgeFinger ? null : (pin._side || null),
                originalColor: pinColor,
                type: 'Pin'
            };
            this._hoverableItems.push(itemData);
        });

        instancedMesh.instanceMatrix.needsUpdate = true;
        instancedMesh.instanceColor.needsUpdate = true;

        //  在深色填充的上方绘制每个引脚的细边框
        //  音调，因此每个矩形/方形/椭圆形垫读取为定义的对象
        //  而不是扁平的斑点。从同一条线构建一条闭合线
        //  用于填充的形状 - Three.js 将其视为单独的
        //  缓冲几何体，因此我们以相同的方式实例化它。
        const borderPts = shape.getPoints(48);
        if (borderPts.length) {
            //  关闭循环
            borderPts.push(borderPts[0].clone());
            const borderGeom = new THREE.BufferGeometry().setFromPoints(
                borderPts.map(p => new THREE.Vector3(p.x, p.y, 0))
            );
            const borderMat = new THREE.LineBasicMaterial({
                color: 0x4b5563,  //  灰色对比焊盘填充和背景-deep
                transparent: true,
                opacity: 0.95,
                depthTest: false,
            });
            //  THREE.Line 没有 InstancedMesh 等价物 — 每个引脚克隆
            //  （数量足够小；矩形引脚最多为 O（千））。
            pins.forEach((pin) => {
                const line = new THREE.Line(borderGeom, borderMat);
                const zPos = pin._edgeFinger
                    ? 2.35
                    : (pin.layer === 'top' ? 2.05 : (pin.layer === 'bottom' ? 1.05 : 1.55));
                line.position.set(pin.x, pin.y, zPos);
                if (pin.rotation) line.rotation.z = pin.rotation * Math.PI / 180;
                line.userData._side = pin._edgeFinger ? null : (pin._side || null);
                line.userData._isDnp = !!pin.is_dnp;
                line.userData._component = pin.component || null;
                if (pin.is_dnp) line.visible = !!this._showDnp;
                this.scene.add(line);
                this._pinBorderLines.push(line);
            });
        }

        this._rectPinInstances.set(sizeKey, { body: instancedMesh, geometry });
        this.scene.add(instancedMesh);
    }

    _createRoundedRectShape(shape, w, h, r) {
        const hw = w / 2, hh = h / 2;
        r = Math.min(r, hw, hh);
        shape.moveTo(-hw + r, -hh);
        shape.lineTo(hw - r, -hh);
        shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
        shape.lineTo(hw, hh - r);
        shape.quadraticCurveTo(hw, hh, hw - r, hh);
        shape.lineTo(-hw + r, hh);
        shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
        shape.lineTo(-hw, -hh + r);
        shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
    }

    /**
     * DFM 替代 (DNP) 组件的幻影渲染。预建于
     * 加载时间，但“visible=false”直到工具栏切换翻转
     * `_showDnp`。我们画了三样东西，以便技术人员将其视为真实的
     *（只是未填充）组件：
     * 1.半透明灰色主体填充——与放置的形状相同
     * 兄弟但四分之一不透明度，所以备用的足迹
     * bbox 视觉上很明显。
     * 2. 青色虚线轮廓 — 中“替代/DNP”的约定
     * 每个 PCB CAD 工具。
     * 3. 中心的refdes标签精灵褪色。
     * 没有 pad — 已填充的同级已经拥有物理 pad
     * 在同一个物理座位上；再次渲染它们只会
     * 将圆圈堆叠在放置的焊盘顶部。
     
     */
    _createDnpOutline(comp) {
        if (!this._dnpMeshes) this._dnpMeshes = [];
        const w = comp.width, h = comp.height;
        const hw = w / 2, hh = h / 2;
        const cx = comp.x + hw, cy = comp.y + hh;
        const z = comp.layer === 'top' ? 1.05 : (comp.layer === 'bottom' ? 0.55 : 0.8);

        //  身体填充——半透明的灰蓝色矩形。相同颜色
        //  系列作为常规组件填充（#2a3140）但不透明度
        //  0.22 所以下面放置的同级在视觉上保持不变
        //  主导元素。
        const fillGeom = new THREE.PlaneGeometry(w, h);
        const fillMat = new THREE.MeshBasicMaterial({
            color: 0x2a3140,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
        });
        const fill = new THREE.Mesh(fillGeom, fillMat);
        fill.position.set(cx, cy, z - 0.02);
        fill.visible = !!this._showDnp;
        this.scene.add(fill);
        this._dnpMeshes.push(fill);

        //  虚线轮廓 — 由显式对构建的实线段
        //  （避免每个网格的computeLineDistances()成本；一个共享
        //  LineDashedMaterial 跨越所有 DNP，我们仍然得到
        //  由于手动对几何形状，看起来虚线）。
        const dashLen = Math.max(0.15, Math.min(w, h) * 0.06);
        const gapLen = dashLen * 0.7;
        const points = [];
        const sides = [
            [-hw, -hh, hw, -hh],   //  底部
            [hw, -hh, hw, hh],     //  对
            [hw, hh, -hw, hh],     //  顶部
            [-hw, hh, -hw, -hh],   //  左
        ];
        for (const [x1, y1, x2, y2] of sides) {
            const len = Math.hypot(x2 - x1, y2 - y1);
            const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
            let t = 0;
            while (t < len) {
                const a = t;
                const b = Math.min(t + dashLen, len);
                points.push(new THREE.Vector3(x1 + ux * a, y1 + uy * a, 0));
                points.push(new THREE.Vector3(x1 + ux * b, y1 + uy * b, 0));
                t = b + gapLen;
            }
        }
        const dashGeom = new THREE.BufferGeometry().setFromPoints(points);
        const dashMat = new THREE.LineBasicMaterial({
            color: this.colors.componentOutline || 0x80c0d0,
            transparent: true,
            opacity: 0.85,
        });
        const dashed = new THREE.LineSegments(dashGeom, dashMat);
        dashed.position.set(cx, cy, z);
        dashed.visible = !!this._showDnp;
        dashed.userData = {
            _instanceType: 'dnpOutline',
            _refdes: comp.id,
            _comp: comp,
        };
        this.scene.add(dashed);
        this._dnpMeshes.push(dashed);

        //  Hover-target — 与放置组件的可悬停形状相同
        //  条目（`type：'Component'`），以便信息面板通过管道传输
        //  不变。这里的“x”和“y”是BBOX中心（匹配
        //  第 ~2660 行的放置组件路径)，因此光标-
        //  矩形内距离检查减少为 0。
        this._hoverableItems.push({
            ...comp,
            x: cx,
            y: cy,
            type: 'Component',
            _instanceType: 'dnpComp',
            _side: comp._side || comp.layer || null,
        });

        //  Refdes 标签 — 重用放置的组件标签路径。的
        //  精灵被推入“_componentLabels”并通过显示/隐藏
        //  `_updateComponentLabelVisibility`（缩放+侧边滤镜），所以
        //  我们将其标记为“_dnpLabel”，并在“_showDnp”上标记门可见性
        //  与 DNP 的其余部分一起overlay。
        if (typeof this._addComponentRefdesLabel === 'function') {
            const before = this._componentLabels.length;
            this._addComponentRefdesLabel(comp);
            for (let i = before; i < this._componentLabels.length; i++) {
                const sprite = this._componentLabels[i];
                sprite.userData._dnpLabel = true;
                sprite.visible = !!this._showDnp;
                if (sprite.material) sprite.material.opacity = 0.6;
                this._dnpMeshes.push(sprite);
            }
        }
    }

    /**
     * 切换 DNP overlay 层。纯粹的可见性翻转——无场景
     * 重建，无需重新获取有效负载。
     
     */
    setShowDnp(show) {
        this._showDnp = !!show;
        //  身体填充 + 在 `_dnpMeshes` 中跟踪的虚线轮廓 —
        //  简单的可见性翻转。
        if (this._dnpMeshes) {
            for (const m of this._dnpMeshes) m.visible = this._showDnp;
        }
        //  每个实例的 DNP 焊盘位于标准引脚网格中，具有
        //  `_dnpFlags`。 `_applySideToInstanced` 尊重该标志，所以
        //  在所有相关网格上运行它足以翻转
        //  DNP 焊盘矩阵到/从零刻度。
        this._applySideToInstanced(this._circularPinInstance);
        this._applySideToInstanced(this._circularPinBorderInstance);
        if (this._rectPinInstances) {
            this._rectPinInstances.forEach(({ body }) => {
                this._applySideToInstanced(body);
            });
        }
        //  每个引脚的矩形边框是单独的线 - 翻转它们
        //  侧面滤镜和 refdes 前缀的可见性
        //  过滤，使三个轴（侧面、DNP、refdes）干净地组合。
        if (this._pinBorderLines) {
            const allow = (side) => this.sideMode === 'both'
                || side == null
                || side === this.sideMode;
            const prefix = this._agentFilterPrefix;
            const refdesOk = (id) => !prefix
                || (id && id.toUpperCase().startsWith(prefix));
            for (const m of this._pinBorderLines) {
                if (!m.userData || !m.userData._isDnp) continue;
                m.visible = this._showDnp
                    && allow(m.userData._side)
                    && refdesOk(m.userData._component);
            }
        }
        if (typeof this._updateComponentLabelVisibility === 'function') {
            this._updateComponentLabelVisibility();
        }
        if (typeof this.requestRender === 'function') this.requestRender();
    }

    /**
     * 切换过孔层。 GenCAD 板有数千个通孔
     *（每个 BGA 球 + 路由缝合）这可能会弄乱
     * 在密集区域周围画布。用户在以下情况下将其关闭
     * 在查看布线时诊断焊盘级工作。
     
     */
    setShowVias(show) {
        this._showVias = !!show;
        if (this._viasOuterInstance) this._viasOuterInstance.visible = this._showVias;
        if (this._viasInnerInstance) this._viasInnerInstance.visible = this._showVias;
    }

    _createViasInstanced(vias) {
        const count = vias.length;

        //  外圈
        const outerGeom = this._sharedGeometries.viaOuter;
        const outerMat = this._sharedMaterials.via.clone();
        const outerMesh = new THREE.InstancedMesh(outerGeom, outerMat, count);
        outerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        //  每个实例的颜色，以便安装孔（无网）渲染
        //  金色，而电气通孔保持标准紫色。
        outerMesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(count * 3), 3
        );
        outerMesh.userData._matrices = new Array(count);
        outerMesh.userData._sides = new Array(count);

        //  内孔
        const innerGeom = this._sharedGeometries.viaInner;
        const innerMat = this._sharedMaterials.viaHole.clone();
        const innerMesh = new THREE.InstancedMesh(innerGeom, innerMat, count);
        innerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        innerMesh.userData._matrices = new Array(count);
        innerMesh.userData._sides = new Array(count);

        const matrix = new THREE.Matrix4();
        const innerMatrix = new THREE.Matrix4();
        const tmpColor = new THREE.Color();

        vias.forEach((via, i) => {
            const radius = via.radius || 0.3;

            matrix.makeScale(radius, radius, 1);
            matrix.setPosition(via.x, via.y, 0.8);
            outerMesh.setMatrixAt(i, matrix);
            outerMesh.userData._matrices[i] = matrix.clone();
            outerMesh.userData._sides[i] = via._side || null;

            innerMatrix.makeScale(radius, radius, 1);
            innerMatrix.setPosition(via.x, via.y, 0.81);
            innerMesh.setMatrixAt(i, innerMatrix);
            innerMesh.userData._matrices[i] = innerMatrix.clone();
            innerMesh.userData._sides[i] = via._side || null;

            //  没有网的过孔是机械钻（安装孔，
            //  螺丝孔）——将其外圈涂成与
            //  信号测试焊盘镜像丝印
            //  公约。电气过孔继承其网络的类别
            //  颜色，以便它们在视觉上与 rails / 信号融为一体
            //  它们属于（电源通孔铜橙色，接地通孔深色
            //  灰色、信号过孔浅灰色等）。
            const isMounting = !via.net || via.net === '' || via.net === 'NC';
            let ringHex;
            if (isMounting) {
                ringHex = this.colors.pinTestPadSignal;  //  黄金
            } else {
                const cat = (via.is_gnd || via.net === 'GND')
                    ? 'ground'
                    : this._netCategory(via.net);
                ringHex = this._pinColorForCategory(cat);
            }
            tmpColor.setHex(ringHex);
            outerMesh.setColorAt(i, tmpColor);

            this._viaInstanceData.push({
                ...via,
                _instanceType: 'via',
                _instanceId: i,
                _side: via._side || null,
                originalColor: ringHex,
                type: 'VIA'
            });
        });

        outerMesh.instanceMatrix.needsUpdate = true;
        outerMesh.instanceColor.needsUpdate = true;
        innerMesh.instanceMatrix.needsUpdate = true;

        outerMesh.visible = this.showVias;
        innerMesh.visible = this.showVias;

        this._viasOuterInstance = outerMesh;
        this._viasInnerInstance = innerMesh;
        this.scene.add(outerMesh);
        this.scene.add(innerMesh);

        console.log(`[PERF] Created ${count} vias with 2 draw calls (was ${count * 2})`);
    }

    /**
     * 从 GenCAD `.cad` 文件渲染 `$MECH HOLE` 条目。
     *
     * - 固定孔（角螺钉，ø > 100 mils）：外部钢灰色
     * 环位于黑色钻孔中心顶部。画在略高于
     * 通过 z 平面，因此即使存在，它们也会被视为物理结构
     * 是它们旁边的过孔。
     * - 基准点（中心点，ø ≤ 100 mils）：单个填充金圆盘
     * 镜像丝网印刷上的光学参考点。
     *
     *孔是机械的，而不是电气的——没有网络，没有悬停/选择
     * 此阶段的意图。每块板大约有五个，所以很简单“THREE.Mesh”
     * 就足够了；不需要InstancedMesh。
     
     */
    _createMechHoles(holes) {
        const fixationColor = 0xa1a1aa;  //  slate-400 — 钢垫饰面
        const drillColor = this.colors.background;  //  空心
        const fiducialColor = this.colors.pinTestPadSignal;  //  黄金

        //  惰性-创建一次材质。跨渲染重复使用。
        if (!this._mechHoleMaterials) {
            this._mechHoleMaterials = {
                fixationRing: new THREE.MeshBasicMaterial({
                    color: fixationColor,
                    side: THREE.DoubleSide,
                }),
                fixationDrill: new THREE.MeshBasicMaterial({
                    color: drillColor,
                    side: THREE.DoubleSide,
                }),
                fiducial: new THREE.MeshBasicMaterial({
                    color: fiducialColor,
                    side: THREE.DoubleSide,
                }),
            };
        }
        const M = this._mechHoleMaterials;
        const meshes = [];

        //  Z 平面：板基板上方 (0.5)，引脚下方 (1.0)。
        const Z_RING = 0.85;
        const Z_DRILL = 0.86;

        holes.forEach((h) => {
            const r = (h.diameter || 0.5) / 2;
            if (h.is_fiducial) {
                const geom = new THREE.CircleGeometry(r, 32);
                const mesh = new THREE.Mesh(geom, M.fiducial);
                mesh.position.set(h.x, h.y, Z_RING);
                this.scene.add(mesh);
                meshes.push(mesh);
            } else {
                //  外圈：从r*0.55到r的圆环，所以钻头
                //  孔读取。板背景顶部的内钻
                //  “透视”外观的颜色。
                const ringGeom = new THREE.RingGeometry(r * 0.55, r, 32);
                const drillGeom = new THREE.CircleGeometry(r * 0.55, 32);
                const ringMesh = new THREE.Mesh(ringGeom, M.fixationRing);
                const drillMesh = new THREE.Mesh(drillGeom, M.fixationDrill);
                ringMesh.position.set(h.x, h.y, Z_RING);
                drillMesh.position.set(h.x, h.y, Z_DRILL);
                this.scene.add(ringMesh);
                this.scene.add(drillMesh);
                meshes.push(ringMesh, drillMesh);
            }
        });

        this._mechHoleMeshes = meshes;
        console.log(`[PERF] Created ${holes.length} mechanical holes (${meshes.length} meshes)`);
    }

    _createTestPadsInstanced(testPads) {
        const count = testPads.length;

        const geom = this._sharedGeometries.testPad;
        const mat = this._sharedMaterials.testPad.clone();
        const instancedMesh = new THREE.InstancedMesh(geom, mat, count);
        instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

        //  启用每个实例的颜色以支持突出显示
        instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(count * 3), 3
        );
        instancedMesh.userData._matrices = new Array(count);
        instancedMesh.userData._sides = new Array(count);
        instancedMesh.userData._components = new Array(count);

        const matrix = new THREE.Matrix4();
        const color = new THREE.Color(this.colors.testPad);

        testPads.forEach((tp, i) => {
            const radius = tp.radius || 0.5;
            const zPos = tp.layer === 'top' ? 2.5 : (tp.layer === 'bottom' ? 2 : 2.25);

            matrix.makeScale(radius, radius, 1);
            matrix.setPosition(tp.x, tp.y, zPos);
            instancedMesh.setMatrixAt(i, matrix);
            instancedMesh.userData._matrices[i] = matrix.clone();
            instancedMesh.userData._sides[i] = tp._side || null;
            instancedMesh.userData._components[i] = tp.component || tp.id || null;
            instancedMesh.setColorAt(i, color);

            const itemData = {
                ...tp,
                _instanceType: 'testPad',
                _instanceId: i,
                _side: tp._side || null,
                originalColor: this.colors.testPad,
                type: 'TEST_PAD'
            };
            this._testPadInstanceData.push(itemData);
            this._hoverableItems.push(itemData);
        });

        instancedMesh.instanceMatrix.needsUpdate = true;
        instancedMesh.instanceColor.needsUpdate = true;

        this._testPadsInstance = instancedMesh;
        this.scene.add(instancedMesh);

        console.log(`[PERF] Created ${count} test pads with 1 draw call`);
    }

    /**
     * 将 XZZ type_03 块渲染为未记录组件 overlay。
     * 每一件都是实体板上的真实零件（经验证）
     * 用户反对他们拥有的董事会） - 但文件
     * 仅提供其边界框，而不提供其引脚或网络分配。
     * 一些供应商以相同的方式剥离引脚布局
     * 真实的 refdes （每个组件名称上都可以看到 U1 占位符）。
     *
     * 渲染风格反映了常规的“无头”组件（无头）
     * 丝印 body_lines) — 柔和的灰蓝色填充 + 青色轮廓 —
     * 因此技术人员将其视为组件，而不是探针垫
     * 突出显示。我们保留橙色的“testPad”重音以
     *避免我们最初使用的误导性“diagnostic区域”提示。
     
     */
    _createInspectionMarkers(markers) {
        //  每个标记填充材料，因此突出显示分支
        //  `_setItemHighlight` （它在
        //  网格）不会通过共享渗透到所有其他标记中
        //  材料。
        const outlineMat = new THREE.LineBasicMaterial({
            color: this.colors.componentOutline,
            transparent: true,
            opacity: 0.7,
        });
        const baseFillHex = 0x2a3140;
        const z = 0.7;
        const zOutline = 0.72;
        markers.forEach((m, i) => {
            const xMin = m.x_min, yMin = m.y_min;
            const xMax = m.x_max, yMax = m.y_max;
            const w = xMax - xMin, h = yMax - yMin;
            if (w <= 0 || h <= 0) return;

            const cx = (xMin + xMax) / 2;
            const cy = (yMin + yMax) / 2;

            //  每个网格材质，因此每个实例悬停高亮是
            //  孤立的。
            const fillMat = new THREE.MeshBasicMaterial({
                color: baseFillHex,
                transparent: true,
                opacity: 0.45,
                depthWrite: false,
            });
            const fillGeom = new THREE.PlaneGeometry(w, h);
            const fillMesh = new THREE.Mesh(fillGeom, fillMat);
            fillMesh.position.set(cx, cy, z);
            fillMesh.userData._side = m._side || null;
            fillMesh.userData.origColor = baseFillHex;
            this.scene.add(fillMesh);
            this._markerMeshes.push(fillMesh);

            const pts = [
                new THREE.Vector3(xMin, yMin, zOutline),
                new THREE.Vector3(xMax, yMin, zOutline),
                new THREE.Vector3(xMax, yMax, zOutline),
                new THREE.Vector3(xMin, yMax, zOutline),
                new THREE.Vector3(xMin, yMin, zOutline),
            ];
            const lineGeom = new THREE.BufferGeometry().setFromPoints(pts);
            const lineMesh = new THREE.Line(lineGeom, outlineMat);
            lineMesh.userData._side = m._side || null;
            this.scene.add(lineMesh);
            this._markerMeshes.push(lineMesh);

            //  连接到现有的悬停/选择机制：空间
            //  网格查找使用 `x, y`（中心）、`_setItemHighlight`
            //  补丁`_mesh.material.color`，`selectItem`读取id /
            //  要填充的值/类型/层/宽度/高度/净值
            //  inspector。标记是匿名的（文件发送
            //  bbox 没有引脚），因此 id 被合成为“IC_N”并且
            //  值告诉技术人员数据已被删除。
            const itemData = {
                id: `IC_${i + 1}`,
                x: cx,
                y: cy,
                width: w,
                height: h,
                layer: "top",
                type: "IC (pinout stripped)",
                value: "Pinout indisponible (stripé par le constructeur)",
                net: "",
                _instanceType: "marker",
                _mesh: fillMesh,
                _side: m._side || null,
                originalColor: baseFillHex,
                marker_id: m.marker_id,
            };
            this._hoverableItems.push(itemData);
        });
        console.log(`[PERF] Rendered ${markers.length} stripped-pin parts`);
    }

    createBoard(data) {
        //  获取多边形源。当后端标记双轮廓时
        //  （XZZ并排/堆叠布局），使用显式的每面
        //  多边形，因此每个轮廓网格都带有正确的“_side”标签
        //  侧面切换开关可以独立隐藏/显示它们。
        const tagged = [];
        if (data.dual_outline && data.dual_outline.top && data.dual_outline.bottom) {
            tagged.push({ poly: data.dual_outline.top, side: 'top' });
            tagged.push({ poly: data.dual_outline.bottom, side: 'bottom' });
        } else if (data.outline) {
            let polys = [];
            if (data.outline.polygons) {
                polys = data.outline.polygons;
            } else if (Array.isArray(data.outline) && data.outline.length >= 3) {
                polys = [data.outline];
            }
            polys.forEach(p => tagged.push({ poly: p, side: null }));
        }

        tagged.forEach(({ poly, side }) => {
            if (!poly || poly.length < 3) return;

            const cleanedOutline = [poly[0]];
            for (let i = 1; i < poly.length; i++) {
                const prev = cleanedOutline[cleanedOutline.length - 1];
                const curr = poly[i];
                if (Math.abs(curr.x - prev.x) > 0.01 || Math.abs(curr.y - prev.y) > 0.01) {
                    cleanedOutline.push(curr);
                }
            }

            if (cleanedOutline.length >= 3) {
                const outlinePoints = cleanedOutline.map(p => new THREE.Vector3(p.x, p.y, 0.5));
                outlinePoints.push(new THREE.Vector3(cleanedOutline[0].x, cleanedOutline[0].y, 0.5));

                const outlineGeom = new THREE.BufferGeometry().setFromPoints(outlinePoints);
                const outlineMat = new THREE.LineBasicMaterial({
                    color: this.colors.boardOutline,
                    transparent: true,
                    opacity: 0.95,
                });
                const outline = new THREE.Line(outlineGeom, outlineMat);
                outline.userData._side = side;
                this.scene.add(outline);
                this._outlineMeshes.push(outline);

                //  轮廓后面填充基材。隐藏时
                //  用户选择的填充颜色与画布相匹配
                //  背景——那是“无填充”状态。一个真实的
                //  pick（与bg-deep不同）制作基板
                //  可见。始终创建，以便颜色选择器可以
                //  实时显示/隐藏它，无需重建板。
                try {
                    const fillShape = new THREE.Shape(
                        cleanedOutline.map(p => new THREE.Vector2(p.x, p.y))
                    );
                    const fillGeom = new THREE.ShapeGeometry(fillShape);
                    const fillMat = new THREE.MeshBasicMaterial({
                        color: this.colors.boardFill,
                        transparent: true,
                        opacity: this.colors.boardFill === this.colors.background ? 0 : 0.85,
                        depthWrite: false,
                    });
                    const fillMesh = new THREE.Mesh(fillGeom, fillMat);
                    fillMesh.position.z = 0.4;  //  就在轮廓线下方 0.5 处
                    fillMesh.userData._side = side;
                    this.scene.add(fillMesh);
                    this._outlineMeshes.push(fillMesh);
                } catch (err) {
                    console.warn("[PCBViewer] board fill triangulation skipped", err);
                }
            }
        });
    }

    /**
     * 重新着色板轮廓（线网格）——从
     * 调整选择器。遍历 `_outlineMeshes` 中的每个条目并更新
     * 线几何图形（网格填充由
     * `_recolorBoardFill`）。
     
     */
    _recolorBoardOutline(hexInt) {
        this.colors.boardOutline = hexInt;
        for (const m of this._outlineMeshes) {
            if (m.material && m.material.type === 'LineBasicMaterial') {
                m.material.color.setHex(hexInt);
            }
        }
    }

    /**
     * 重新着色板基板填充。当选取的颜色
     * 匹配画布背景（“无填充”标记），
     * 填充网格通过不透明度隐藏：0。
     
     */
    _recolorBoardFill(hexInt) {
        this.colors.boardFill = hexInt;
        const isInvisible = hexInt === this.colors.background;
        for (const m of this._outlineMeshes) {
            if (m.material && m.material.type === 'MeshBasicMaterial') {
                m.material.color.setHex(hexInt);
                m.material.opacity = isInvisible ? 0 : 0.85;
                m.material.transparent = true;
                m.material.needsUpdate = true;
            }
        }
    }

    createComponent(comp) {
        //  DFM-alternate / DNP — 填充的同级带有 BOM
        //  值并被绘制normally。非填充足迹
        //  获得一个单独的虚线轮廓渲染，该渲染被隐藏
        //  默认并通过“_showDnp”切换。不绘制焊盘
        //  DNP（放置的兄弟已经覆盖了相同的物理
        //  垫），所以 overlay 只是替代的身体足迹。
        if (comp.is_dnp) {
            this._createDnpOutline(comp);
            return;
        }

        const group = new THREE.Group();
        const w = comp.width;
        const h = comp.height;
        const hw = w / 2;
        const hh = h / 2;
        const isTestPoint = comp.type === 'TEST_POINT';

        //  是否回退到AABB轮廓矩形。我们只
        //  当零件没有丝印 body_lines 时绘制 AABB —
        //  否则下面的丝印部分已经追踪到
        //  封装轮廓和 AABB 矩形仅堆叠一秒
        //  它们顶部的轮廓（可见为“双轮廓”
        //  RF107 / RF770 / CF730 / 等）。 XZZ 填充 body_lines
        //  大部分零件； KiCad/BRD 没有。
        const hasBodyLines = Array.isArray(comp.body_lines) && comp.body_lines.length > 0;

        //  身体填充——垫子后面的软灰色矩形，所以每个
        //  组件读取为密集板上的定义对象。
        //  对于 XZZ 带有 body_lines 的部分，我们填充
        //  绝对坐标中的 body_lines bbox（无组旋转，
        //  因为 body_lines 也是绝对的）；对于 KiCad/BRD 零件
        //  （无 body_lines）我们在旋转组内填充 AABB。
        if (!isTestPoint) {
            const fillMat = new THREE.MeshBasicMaterial({
                color: 0x2a3140,            //  暗灰蓝色，在 bg-deep 和面板之间
                transparent: true,
                opacity: 0.55,
                depthWrite: false,
            });
            if (hasBodyLines) {
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                for (const seg of comp.body_lines) {
                    if (seg.x1 < minX) minX = seg.x1;
                    if (seg.x2 < minX) minX = seg.x2;
                    if (seg.x1 > maxX) maxX = seg.x1;
                    if (seg.x2 > maxX) maxX = seg.x2;
                    if (seg.y1 < minY) minY = seg.y1;
                    if (seg.y2 < minY) minY = seg.y2;
                    if (seg.y1 > maxY) maxY = seg.y1;
                    if (seg.y2 > maxY) maxY = seg.y2;
                }
                const fw = maxX - minX, fh = maxY - minY;
                if (fw > 0 && fh > 0) {
                    const fillGeom = new THREE.PlaneGeometry(fw, fh);
                    const fillMesh = new THREE.Mesh(fillGeom, fillMat);
                    fillMesh.position.set((minX + maxX) / 2, (minY + maxY) / 2, 0.6);
                    fillMesh.userData._side = comp._side || null;
                    this.scene.add(fillMesh);
                    this._componentExtras.push(fillMesh);
                }
            } else {
                //  无 body_lines — 填充旋转后的 AABB
                //  组，以便填充随零件旋转。
                const fillGeom = new THREE.PlaneGeometry(w, h);
                const fillMesh = new THREE.Mesh(fillGeom, fillMat);
                fillMesh.position.set(0, 0, 0.01);
                //  隐藏自己的原始颜色，以便通过 null- 悬停
                //  `setMeshColor` 中的哨兵分支恢复填充
                //  回到灰蓝色而不是继承父级
                //  组件的轮廓青色。
                fillMesh.userData.origColor = 0x2a3140;
                group.add(fillMesh);
            }
        }

        if (isTestPoint) {
            //  没有特殊的居中 overlay — 每个引脚实例化
            //  渲染器现在将 TEST_POINT 引脚着色为橙色 directly
            //  （component_type 字段流经引脚有效负载）。
        } else if (!hasBodyLines) {
            //  仅轮廓矩形，无填充，无每种类型的形状
            //  变体。与 SVG 渲染器的参考外观相匹配。
            const points = [
                new THREE.Vector3(-hw, -hh, 0.02),
                new THREE.Vector3( hw, -hh, 0.02),
                new THREE.Vector3( hw,  hh, 0.02),
                new THREE.Vector3(-hw,  hh, 0.02),
                new THREE.Vector3(-hw, -hh, 0.02),
            ];
            const borderGeom = new THREE.BufferGeometry().setFromPoints(points);
            const borderMat = new THREE.LineBasicMaterial({
                color: this.colors.componentOutline,
                transparent: true,
                opacity: 0.85,
            });
            const borderLine = new THREE.Line(borderGeom, borderMat);
            //  存储每个网格的悬停恢复路径。
            borderLine.userData.origColor = this.colors.componentOutline;
            group.add(borderLine);
        }

        const compZ = comp.layer === 'top' ? 1 : (comp.layer === 'bottom' ? 0.5 : 0.75);
        group.position.set(comp.x + w / 2, comp.y + h / 2, compZ);

        //  丝印主体线保持在绝对板坐标中，并且
        //  渲染为单独的场景网格 — XZZ 将旋转烘焙到
        //  段端点，因此将它们添加到旋转组内
        //  会双重旋转它们。 componentOutline 中的颜色（青色）
        //  不是白色丝印标记：否则为 XZZ 组件
        //  （它确实填充了 body_lines）读起来就像一抹白色
        //  青色 AABB 框，使它们看起来呈灰色 — KiCad/MNT
        //  （不填充 body_lines）保持纯青色，并且
        //  并排可见不匹配。
        if (hasBodyLines) {
            const silkPts = [];
            for (const seg of comp.body_lines) {
                silkPts.push(new THREE.Vector3(seg.x1, seg.y1, compZ + 0.04));
                silkPts.push(new THREE.Vector3(seg.x2, seg.y2, compZ + 0.04));
            }
            const silkGeom = new THREE.BufferGeometry().setFromPoints(silkPts);
            const silkMat = new THREE.LineBasicMaterial({
                color: this.colors.componentOutline,
                transparent: true,
                opacity: 0.7,
            });
            const silkMesh = new THREE.LineSegments(silkGeom, silkMat);
            silkMesh.userData._side = comp._side || null;
            this.scene.add(silkMesh);
            this._componentExtras.push(silkMesh);
        }

        if (comp.rotation) {
            group.rotation.z = comp.rotation * Math.PI / 180;
        }

        //  0 针零件的丝网印刷标签精灵（徽标、徽章、
        //  区域标签 — MNT 上的 BADGE / REFORM / CPU / MPCIE
        //  改革、NOTOUCH 区域等）。镜子brd_viewer.js的
        //  “注释”循环。将标签渲染为平面精灵
        //  绝对板坐标中的 bbox 中心（因此丝印文本
        //  不与零件组一起双重旋转）。
        if (!comp.pin_count) {
            this._addSilkscreenLabel(comp);
        } else {
            //  真实组件会获得一个在低缩放时自动隐藏的 refdes 精灵。
            this._addComponentRefdesLabel(comp);
        }

        //  悬停/选择使用“item.x, item.y”作为*中心*（因此
        //  当“checkHover”中的 AABB 距离检查减少到 0
        //  光标位于矩形内）。渲染有效负载的
        //  `comp.x, comp.y` 是 bbox 左下角 — 通过中心
        //  明确地这样悬停会照亮整个组件，而不是
        //  其拐角处只有 20 像素的半径。
        const itemData = {
            ...comp,
            x: comp.x + w / 2,
            y: comp.y + h / 2,
            _mesh: group,
            _side: comp._side || null,
            originalColor: isTestPoint ? this.colors.testPad : this.colors.componentOutline,
        };
        group.userData = itemData;
        this._hoverableItems.push(itemData);

        this.scene.add(group);
        this.meshGroups.components.push(group);
    }

    _addComponentRefdesLabel(comp) {
        const refdes = comp.id;
        if (!refdes) return;

        const w = comp.width;
        const h = comp.height;
        const longSide = Math.max(w, h);
        //  无尺寸限制：XZZ无源器件可为 0.25 mm × 0.15 mm（更小）
        //  小于半毫米），但放大时可读。可见性
        //  完全由屏幕像素阈值驱动
        //  _updateComponentLabelVisibility，因此标签在低缩放时隐藏
        //  一旦该部件覆盖足够的屏幕像素，就会弹出。

        //  更高分辨率的画布 + DPR 感知，在任何缩放下都清晰可见。
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        canvas.width = 256 * dpr;
        canvas.height = 64 * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const hex = '#' + this.colors.silkscreen.toString(16).padStart(6, '0');
        ctx.font = "800 38px 'Inter', system-ui, sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        //  填充下方有微妙的黑色笔划，使文本读起来清晰
        //  反对明亮的垫子/繁忙的区域。 Anthropic-风格：加权
        //  sans，清晰的边缘，通过下面的添加剂混合产生柔和的光泽。
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(7,16,31,0.85)';   //  bg-deep
        ctx.strokeText(refdes, 128, 32);
        ctx.fillStyle = hex;
        ctx.fillText(refdes, 128, 32);

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
        });
        const sprite = new THREE.Sprite(material);

        //  将比例设置为固定屏幕像素高度
        //  _updateRefdesLabelScale，每次缩放更改时都会刷新，以便
        //  无论缩放如何，refdes 标签都保持可读（约 14 像素高）
        //  水平。初始比例只是一个占位符。
        const aspect = canvas.width / canvas.height;  // 4
        sprite.scale.set(1, 1 / aspect, 1);
        sprite.position.set(comp.x + w / 2, comp.y + h / 2, 3);
        sprite.visible = false;  //  _updateComponentLabelVisibility 将翻转

        //  隐藏长边，用于变焦驱动的可见性检查+画布
        //  像素高度缩放器的方面。
        sprite.userData.compLong = longSide;
        sprite.userData.aspect = aspect;
        sprite.userData._refdes = refdes;
        sprite.userData._side = comp._side || null;
        this._componentLabels.push(sprite);
        this.scene.add(sprite);
    }

    /**
     * Refdes 标签以固定的屏幕像素高度（~14 px）渲染，因此
     * 它们在任何缩放下都保持可读。世界单位每次都会重新计算
     * 从当前像素大小开始缩放。
     
     */
    _updateRefdesLabelScale() {
        if (!this._componentLabels.length) return;
        const h = (this.container && this.container.clientHeight) || 800;
        const pixelSize = this.frustumSize / h;
        const targetH = this._refdesPixelHeight * pixelSize;
        for (const sprite of this._componentLabels) {
            const aspect = sprite.userData.aspect || 4;
            sprite.scale.set(targetH * aspect, targetH, 1);
        }
    }

    /**
     * 计算世界单位破折号 + 间隙大小，目标为 ~10 px 破折号和
     * 无论缩放如何，间隙约为 7 像素。由highlightNet 在创建时使用
     * 并在每次缩放更改时通过 _updateFlyLineDashes 执行。
     
     */
    _flyDashWorld() {
        const h = (this.container && this.container.clientHeight) || 800;
        const pixelSize = this.frustumSize / h;
        //  重划线，轻间隙：14 px 开/6 px 关。
        return { dashWorld: 14 * pixelSize, gapWorld: 6 * pixelSize };
    }

    _flyThicknessWorld() {
        const h = (this.container && this.container.clientHeight) || 800;
        const pixelSize = this.frustumSize / h;
        //  ~1.5 CSS 像素厚——很好，但仍然明显高于
        //  THREE.Line 将降落的 1-device-px 楼层。
        return 1.5 * pixelSize;
    }

    /**
     * 构建飞线使用的虚线图案 alpha 纹理。 20 像素
     * 宽画布：14 px 不透明白色，6 px 透明（70 % 占空比）。
     * 纹理设置为水平包裹，以便平面 UV 重复
     * 沿着每个飞线段平铺虚线。
     
     */
    _createFlyDashTexture() {
        const c = document.createElement('canvas');
        c.width = 20; c.height = 4;
        const ctx = c.getContext('2d');
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.fillRect(0, 0, 14, 4);
        //  最后 6 个像素保持透明 → 虚线之间的间隙。
        const tex = new THREE.CanvasTexture(c);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.premultiplyAlpha = true;
        return tex;
    }

    /**
     * 设置 PlaneGeometry 的 X 轴 UV，以便绑定纹理平铺
     * 在整个平面上“重复X”次。 PlaneGeometry 顶点顺序：
     * [bl, br, tl, tr] - 我们保持 Y 不变并拉伸 X。
     
     */
    _setUVRepeatX(geometry, repeatX) {
        const uvs = geometry.attributes.uv;
        if (!uvs) return;
        uvs.setXY(0, 0, 0);
        uvs.setXY(1, repeatX, 0);
        uvs.setXY(2, 0, 1);
        uvs.setXY(3, repeatX, 1);
        uvs.needsUpdate = true;
    }

    /**
     * 在两个端点之间绘制虚线段作为一系列
     * 短 PlaneGeometry 矩形，沿线段定向
     * 以“gapWorld”间隙间隔。每个平面都是“厚度”单位
     *宽。我们不能使用 THREE.Line / LineDashedMaterial 因为
     * Chromium 上的 WebGL 忽略 `linewidth`（限制为 1 px），使得
     * 破折号在 HiDPI 下实际上不可见；平面几何有
     * 正确缩放的真实世界单位宽度。
     *
     *“材料”在一个飞线组的所有飞机之间共享
     * 因此颜色更新路径保持便宜。
     
     */
    /**
     * 单平面飞线：一个 PlaneGeometry 在其间拉伸
     * 开始和结束，带有虚线 alpha 映射材质。紫外重复
     * 沿着线段平铺虚线图案，这样我们就不必这样做
     * 每个破折号生成一个网格。缩放时，仅“scale.y”（厚度）
     * 并且 UV 重复需要刷新 — `_updateFlyLineDashes`
     * 在不重建场景图的情况下完成这两项工作。
     
     */
    _createFlyLineDashed(startPos, endPos, material, thickness, dashWorld, gapWorld) {
        const dx = endPos.x - startPos.x;
        const dy = endPos.y - startPos.y;
        const length2D = Math.sqrt(dx * dx + dy * dy);
        if (length2D < 1e-4) return;
        const angle = Math.atan2(dy, dx);
        const stride = dashWorld + gapWorld;

        //  缩放至（长度，厚度）的单位正方形平面 - 保持
        //  单个共享几何顶点布局，同时让每个
        //  网格独立拉伸。 UV 默认为 [0..1]；我们
        //  仅拉伸 X，以便破折号纹理平铺“repeatX”次。
        const geom = new THREE.PlaneGeometry(1, 1);
        const repeatX = length2D / stride;
        this._setUVRepeatX(geom, repeatX);
        const mesh = new THREE.Mesh(geom, material);
        mesh.position.set(
            (startPos.x + endPos.x) / 2,
            (startPos.y + endPos.y) / 2,
            (startPos.z + endPos.z) / 2,
        );
        mesh.rotation.z = angle;
        mesh.scale.set(length2D, thickness, 1);
        //  存储段长度，以便“_updateFlyLineDashes”可以
        //  在缩放时以新的破折号步幅重新计算 UV 重复
        //  无需重新行走原始端点。
        mesh.userData._flyLength = length2D;
        this.scene.add(mesh);
        this.netLines.push(mesh);
    }

    /**
     * 重新计算每条活动飞线上的 dashSize/gapSize，以便
     * 无论什么情况，虚线迹线都保持一致的 ~10 px 虚线
     * 缩放。如果没有这个，放大会将每个破折号变成一个巨大的平板
     *（世界单位 dashSize 保持固定，但像素大小增加），
     * 缩小使它们成为亚像素并有效地实体。
     
     */
    _updateFlyLineDashes() {
        if (!this.netLines || !this.netLines.length) return;
        //  就地更新：每条飞线现在都是一个平面网格
        //  具有平铺破折号纹理，因此缩放步骤只需要
        //  刷新世界单位厚度 (mesh.scale.y) 和
        //  X 轴 UV 重复（因此破折号保持 ~14 px ON / 6 px OFF
        //  新缩放的屏幕）。无需在场景中添加/删除
        //  图 — fast 即使在 200 条飞线上限。
        const thickness = this._flyThicknessWorld();
        const { dashWorld, gapWorld } = this._flyDashWorld();
        const stride = dashWorld + gapWorld;
        for (const mesh of this.netLines) {
            const len = mesh.userData && mesh.userData._flyLength;
            if (!len) continue;
            mesh.scale.y = thickness;
            this._setUVRepeatX(mesh.geometry, len / stride);
        }
    }


    /**
     * 根据当前缩放翻转refdes-标签可见性：仅标签
     * 一旦其组件的宽度至少为“_labelMinPx”像素，就会显示
     * 屏幕。如果没有这个，缩小会将整个板绘制为
     * 无法阅读的refdes垃圾邮件。
     
     */
    _updateComponentLabelVisibility() {
        if (!this._componentLabels.length) return;
        const h = this.container.clientHeight;
        if (!h) return;
        const pixelSize = this.frustumSize / h;       //  每像素的世界单位
        const minWorld = this._labelMinPx * pixelSize;
        const mode = this.sideMode;
        const prefix = this._agentFilterPrefix;
        const refdesOk = (id) => !prefix
            || (id && id.toUpperCase().startsWith(prefix));
        for (const sprite of this._componentLabels) {
            const side = sprite.userData._side;
            const sideOk = mode === 'both' || side == null || side === mode;
            //  DNP 替代标签还通过“_showDnp”进行门控
            //  所以替代品'refdes仅在用户有时出现
            //  打开 DFM overlay。
            if (sprite.userData._dnpLabel && !this._showDnp) {
                sprite.visible = false;
                continue;
            }
            //  Refdes-prefix 过滤器（由 bv_filter_by_type 设置）隐藏
            //  refdes 与活动前缀不匹配的标签。
            //  用作侧面的第三轴 AND DNP AND refdes
            //  复合门，使所有三个过滤器干净地组合在一起。
            if (!refdesOk(sprite.userData._refdes)) {
                sprite.visible = false;
                continue;
            }
            sprite.visible = sideOk && sprite.userData.compLong >= minWorld;
        }
    }

    _addSilkscreenLabel(comp) {
        const raw = (comp.value || comp.id || '').replace(/^(LABEL_|LOGO_)/, '');
        if (!raw) return;

        const w = comp.width;
        const h = comp.height;
        const longSide = Math.max(w, h);
        const shortSide = Math.min(w, h);
        if (longSide < 1) return;  //  bbox 太小，无法可读地呈现
        const landscape = w >= h;

        //  将文本渲染到高 DPR 画布中。来自令牌的十六进制
        //  （--文本=#e6edf7）。没有背景填充，但有一层薄薄的深色
        //  在字形周围描画，以便在繁忙区域阅读文本。
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        canvas.width = 512 * dpr;
        canvas.height = 128 * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const hex = '#' + this.colors.silkscreen.toString(16).padStart(6, '0');
        ctx.font = "800 64px 'Inter', system-ui, sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(7,16,31,0.85)';
        ctx.strokeText(raw, 256, 64);
        ctx.fillStyle = hex;
        ctx.fillText(raw, 256, 64);

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
        });

        //  平面尺寸约为长边 x 短边比例的 85%。
        //  使用平面（不是精灵），因此我们可以将其旋转 -90°
        //  肖像框 — 与 brd_viewer.js 相同的规则：KiCad 足迹
        //  旋转隐含在 bbox 比例中，因此高 bbox
        //  表示丝网印刷文字是垂直印刷的。
        const aspect = canvas.width / canvas.height;  // 4
        const geom = new THREE.PlaneGeometry(1, 1 / aspect);
        const mesh = new THREE.Mesh(geom, material);
        //  +PI/2 (CCW)，因此文本在文本中向上/从上到下阅读
        //  Three.js Y 向上场景 — brd_viewer.js 的 -PI/2 用于 2D 画布
        //  Y 向下，旋转符号在两个坐标系之间翻转。
        if (!landscape) mesh.rotation.z = Math.PI / 2;
        mesh.position.set(comp.x + w / 2, comp.y + h / 2, 4);

        //  隐藏测量值； _updateSilkscreenLabelScale 选择
        //  (bbox-fit 世界宽度) 和 (cap 世界宽度
        //  每次缩放变化时的屏幕像素上限）。
        mesh.userData.longSide = longSide;
        mesh.userData.aspect = aspect;
        mesh.userData._side = comp._side || null;
        this._silkscreenLabels.push(mesh);
        this.scene.add(mesh);
    }

    /**
     * 丝印标签固定在 bbox 上（因此一个小区域显示
     * 文本较小，文本较大的区域较大），但要限制
     * 像素高度为`_silkscreenMaxPixelHeight`，这样它们就不会爆炸
     * 在大范围内放大时可达漫画大小
     * 标签如 BADGE。
     
     */
    _updateSilkscreenLabelScale() {
        if (!this._silkscreenLabels.length) return;
        const h = (this.container && this.container.clientHeight) || 800;
        const pixelSize = this.frustumSize / h;
        const maxLong = this._silkscreenMaxPixelHeight * pixelSize *
            (this._silkscreenLabels[0].userData.aspect || 4);
        for (const mesh of this._silkscreenLabels) {
            const aspect = mesh.userData.aspect || 4;
            const fitLong = mesh.userData.longSide * 0.85;
            const targetLong = Math.min(fitLong, maxLong);
            mesh.scale.set(targetLong, targetLong / aspect, 1);
        }
    }


    createTrace(trace) {
        if (trace.points.length < 2) return;

        //  XZZ 中的第 28 层是板边缘/轮廓。渲染得更亮
        //  （丝印白色）并且比铜迹稍厚，所以
        //  板轮廓在黑暗的场景背景上弹出。第17层
        //  是丝网印刷——同样的中性白色。铜走线（层
        //  1..16) 继承其网络的类别颜色（电源铜橙色，
        //  地面深灰色、信号浅灰色等），因此每个网络的
        //  布线的读数在视觉上与其引脚一致。痕迹与
        //  无网络（罕见 - 连接器条或机械）回落到
        //  中性铜色调。
        const isOutline = trace.layer === 28;
        const isSilkscreen = trace.layer === 17;
        let color;
        if (isOutline || isSilkscreen) {
            color = this.colors.silkscreen;
        } else if (trace.net) {
            const cat = (trace.is_gnd || trace.net === 'GND')
                ? 'ground'
                : this._netCategory(trace.net);
            color = this._pinColorForCategory(cat);
        } else {
            color = this.colors.copper;
        }
        const opacity = isOutline ? 0.95 : 0.6;
        const zPos = isOutline ? 0.5 : 0.3;

        const points = trace.points.map(p => new THREE.Vector3(p.x, p.y, zPos));
        const geom = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({
            color: color,
            transparent: !isOutline,
            opacity: opacity,
            linewidth: isOutline ? 2 : 1,
        });
        const line = new THREE.Line(geom, mat);
        line.userData = {
            ...trace,
            type: 'TRACE',
            _side: trace._side || null,
            //  隐藏解析时材料值，以便网络突出显示/
            //  取消突出显示路径可以在没有全局的情况下恢复它们
            //  color.copper 查找（已经改变了
            //  如果用户重新调整了调色板）。
            origColor: color,
            origOpacity: opacity,
            _kind: isOutline ? 'outline' : (isSilkscreen ? 'silkscreen' : 'copper'),
        };
        //  即使用户禁用，也始终显示板轮廓
        //  铜迹线overlay。
        line.visible = isOutline ? true : this.showTraces;

        this.scene.add(line);
        this.meshGroups.traces.push(line);
    }

    clearScene() {
        //  删除实例化网格
        if (this._circularPinInstance) {
            this.scene.remove(this._circularPinInstance);
            this._circularPinInstance.dispose();
            this._circularPinInstance = null;
        }
        if (this._circularPinBorderInstance) {
            this.scene.remove(this._circularPinBorderInstance);
            this._circularPinBorderInstance.dispose();
            this._circularPinBorderInstance = null;
        }
        this._rectPinInstances.forEach(({ body, geometry }) => {
            this.scene.remove(body);
            body.dispose();
            geometry.dispose();
        });
        this._rectPinInstances.clear();

        if (this._viasOuterInstance) {
            this.scene.remove(this._viasOuterInstance);
            this._viasOuterInstance.dispose();
            this._viasOuterInstance = null;
        }
        if (this._viasInnerInstance) {
            this.scene.remove(this._viasInnerInstance);
            this._viasInnerInstance.dispose();
            this._viasInnerInstance = null;
        }
        if (this._testPadsInstance) {
            this.scene.remove(this._testPadsInstance);
            this._testPadsInstance.dispose();
            this._testPadsInstance = null;
        }
        if (this._testPadsBorderInstance) {
            this.scene.remove(this._testPadsBorderInstance);
            this._testPadsBorderInstance.dispose();
            this._testPadsBorderInstance = null;
        }
        //  GenCAD `$MECH HOLE` 网格 — 普通的 `THREE.Mesh` （未实例化），
        //  将它们的几何形状设置为透明，这样重新加载就不会泄漏。
        if (this._mechHoleMeshes && this._mechHoleMeshes.length) {
            this._mechHoleMeshes.forEach((m) => {
                this.scene.remove(m);
                if (m.geometry) m.geometry.dispose();
            });
            this._mechHoleMeshes = [];
        }

        //  清除数据数组
        this._outlineMeshes = [];
        this._markerMeshes = [];
        this._pinBorderLines = [];
        this._componentExtras = [];
        this._componentLabels = [];
        this._silkscreenLabels = [];
        this._netHiddenMarkers = [];
        this.dualOutline = null;
        this.sideMode = 'both';
        //  重置场景旋转，以便新板不会继承
        //  前任董事会的方向。
        this.rotationDeg = 0;
        this.scene.rotation.z = 0;
        this._pinInstanceData = [];
        this._viaInstanceData = [];
        this._testPadInstanceData = [];
        this._hoverableItems = [];
        this._spatialGrid = {};

        //  删除组件组
        this.meshGroups.components.forEach(m => this.scene.remove(m));
        this.meshGroups.components = [];
        this.meshGroups.traces.forEach(m => this.scene.remove(m));
        this.meshGroups.traces = [];

        //  删除所有剩余的子项
        while (this.scene.children.length > 0) {
            this.scene.remove(this.scene.children[0]);
        }

        this.selectedItem = null;
        this.hoveredItem = null;
    }

    // ========================
    //  用户界面控制
    // ========================

    toggleLayer(layer) {
        this.layers[layer] = !this.layers[layer];
        const btn = document.getElementById(`layer-${layer}`);

        if (this.layers[layer]) {
            btn.classList.remove('bg-dark-600', 'text-gray-400', 'border-dark-500');
            btn.classList.add(
                layer === 'top' ? 'bg-blue-500/20' : 'bg-red-500/20',
                layer === 'top' ? 'text-blue-400' : 'text-red-400',
                layer === 'top' ? 'border-blue-500/30' : 'border-red-500/30'
            );
        } else {
            btn.classList.remove('bg-blue-500/20', 'bg-red-500/20', 'text-blue-400', 'text-red-400', 'border-blue-500/30', 'border-red-500/30');
            btn.classList.add('bg-dark-600', 'text-gray-400', 'border-dark-500');
        }

        //  更新组件可见性
        this.meshGroups.components.forEach(mesh => {
            const meshLayer = mesh.userData.layer;
            if (meshLayer === layer) {
                mesh.visible = this.layers[layer];
            } else if (meshLayer === 'both') {
                mesh.visible = this.layers.top || this.layers.bottom;
            }
        });

        //  对于实例化网格体，我们需要更新每个实例的可见性
        //  目前，我们依靠按层进行悬停过滤
        this.requestRender();
    }

    toggleVias() {
        this.showVias = !this.showVias;
        const btn = document.getElementById('toggle-vias');

        if (this.showVias) {
            btn.classList.remove('bg-dark-600', 'text-gray-400', 'border-dark-500');
            btn.classList.add('bg-fuchsia-500/20', 'text-fuchsia-400', 'border-fuchsia-500/30');
        } else {
            btn.classList.remove('bg-fuchsia-500/20', 'text-fuchsia-400', 'border-fuchsia-500/30');
            btn.classList.add('bg-dark-600', 'text-gray-400', 'border-dark-500');
        }

        if (this._viasOuterInstance) this._viasOuterInstance.visible = this.showVias;
        if (this._viasInnerInstance) this._viasInnerInstance.visible = this.showVias;
        this.requestRender();
    }

    toggleTraces() {
        //  纯模型切换 - 桥拥有按钮样式和
        //  在当前设计系统下拥有它（`brdToggleTraces`，
        //  `活跃`类）。这里的旧代码引用了遗留问题
        //  `toggle-traces` id 带有 Tailwind 橙色/深色类，没有
        //  不再存在，这导致新的工具栏按钮崩溃。
        this.showTraces = !this.showTraces;
        this.meshGroups.traces.forEach(t => t.visible = this.showTraces);
        this.requestRender();
    }

    flipBoard() {
        //  传统左/右后视镜（BRD 格式镀铬）。独立于
        //  旋转状态 — 乘以 scene.scale.x。
        this.isFlipped = !this.isFlipped;
        this.scene.scale.x = this.isFlipped ? -1 : 1;
        const btn = document.getElementById('flip-board');
        if (btn) btn.classList.toggle('active', this.isFlipped);
        this.requestRender();
    }

    rotateLeft() {
        //  从观看者的 POV 来看逆时针：围绕 Z 轴 +90°，这在视觉上
        //  将板的顶部边缘向屏幕左侧倾斜。
        this.rotationDeg = (this.rotationDeg + 90) % 360;
        this._applyTransform();
    }

    rotateRight() {
        //  CW：-90°（相当于 +270° mod 360）。
        this.rotationDeg = (this.rotationDeg + 270) % 360;
        this._applyTransform();
    }

    /**
     * 将旋转应用于场景根，然后重新调整相机
     * 在侧模式 bbox 上通过相同的旋转，因此可见
     * 内容大致停留在光标下方。
     
     */
    _applyTransform() {
        this.scene.rotation.z = this.rotationDeg * Math.PI / 180;
        this._recentreOnSideMode();
        this.requestRender();
    }

    // ========================
    //  双视图（目前已简化）
    // ========================

    toggleDualView() {
        if (!this.boardData) return;

        this.isDualView = !this.isDualView;
        const btn = document.getElementById('dual-view');

        if (this.isDualView) {
            btn.classList.remove('bg-dark-600', 'text-gray-400', 'border-dark-500');
            btn.classList.add('bg-green-500/20', 'text-green-400', 'border-green-500/30');
            this.createDualViewGroup();
        } else {
            btn.classList.remove('bg-green-500/20', 'text-green-400', 'border-green-500/30');
            btn.classList.add('bg-dark-600', 'text-gray-400', 'border-dark-500');
            this.removeDualViewGroup();
        }

        this.centerDualView();
        this.requestRender();
    }

    createDualViewGroup() {
        //  简化的双视图 - 现在只需添加标签
        //  具有实例化网格的完整双视图将需要更复杂的处理
        if (!this.boardData) return;

        const data = this.boardData;
        const boardWidth = data.board_width;
        const boardHeight = data.board_height;
        const gap = boardWidth * 0.15;
        const offsetX = data.board_offset_x || 0;
        const offsetY = data.board_offset_y || 0;

        //  顶部标签
        const topCanvas = document.createElement('canvas');
        const topCtx = topCanvas.getContext('2d');
        topCanvas.width = 128;
        topCanvas.height = 48;
        topCtx.fillStyle = 'rgba(59, 130, 246, 0.8)';
        topCtx.roundRect(4, 4, 120, 40, 8);
        topCtx.fill();
        topCtx.fillStyle = 'white';
        topCtx.font = 'bold 24px Inter, Arial';
        topCtx.textAlign = 'center';
        topCtx.textBaseline = 'middle';
        topCtx.fillText('TOP', 64, 24);

        const topTexture = new THREE.CanvasTexture(topCanvas);
        const topMat = new THREE.SpriteMaterial({ map: topTexture, transparent: true, depthTest: false });
        this.topLabel = new THREE.Sprite(topMat);
        const labelScale = boardWidth * 0.15;
        this.topLabel.scale.set(labelScale, labelScale * 0.375, 1);
        this.topLabel.position.set(offsetX + boardWidth / 2, offsetY + boardHeight + labelScale * 0.3, 10);
        this.scene.add(this.topLabel);
    }

    removeDualViewGroup() {
        if (this.topLabel) {
            this.scene.remove(this.topLabel);
            this.topLabel = null;
        }
        if (this.bottomLabel) {
            this.scene.remove(this.bottomLabel);
            this.bottomLabel = null;
        }
        if (this.dualViewGroup) {
            this.scene.remove(this.dualViewGroup);
            this.dualViewGroup = null;
        }
    }

    centerDualView() {
        if (!this.boardData) return;

        const data = this.boardData;
        const offsetX = data.board_offset_x || 0;
        const offsetY = data.board_offset_y || 0;

        this.camera.position.x = offsetX + data.board_width / 2;
        this.camera.position.y = offsetY + data.board_height / 2;
        this.frustumSize = Math.max(data.board_width, data.board_height) * 1.2;

        this.zoom = 100 / this.frustumSize;
        this.onResize();
        document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
    }

    // ========================
    //  侧面过滤器（XZZ双轮廓）
    // ========================

    /**
     * 在仅渲染顶面、仅渲染底面之间切换，
     * 或两者兼而有之。仅当板卡发货双轮廓数据时生效
     *（XZZ并排/堆叠布局）；关于单一轮廓格式
     * 每个实体都有 `_side === null` 并且无论如何都保持可见。
     *
     * 相机已重新调整并重新缩放以适合可见的 bbox，因此
     * 技术不会在切换之间丢失屏幕外的棋盘。
     
     */
    setSideMode(mode, opts = {}) {
        if (mode !== 'top' && mode !== 'bottom' && mode !== 'both') return;
        const prevMode = this.sideMode;
        this.sideMode = mode;
        //  坚持重新加载——技术通常会解决
        //  首选面孔并期望随后的每个董事会都会出现
        //  在相同模式下，而不是在加载时重置为“两者”。
        try { localStorage.setItem('pcb.sideMode', mode); } catch (_) {}
        //  将模式反映在工具栏段上，以便来自以下位置的调用
        //  桥外（例如新板负载重置为“两者”）
        //  保持视觉状态与实际过滤器同步。
        const segMap = {
            top: 'brdLayerTop',
            both: 'brdLayerBoth',
            bottom: 'brdLayerBottom',
        };
        Object.entries(segMap).forEach(([m, id]) => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('active', m === mode);
        });
        const allow = (side) => mode === 'both' || side == null || side === mode;

        //  普通网格 - 翻转可见性 directly。 DNP层网格
        //  由“_showDnp”而不是侧面过滤器进行门控；跳过
        //  它们放在这里，这样当板切换时它们就不会重新出现
        //  返回“顶部”或任何侧面模式。
        const dnp = (m) => m && m.userData && m.userData._dnpLayer;
        this._outlineMeshes.forEach((m) => { m.visible = allow(m.userData._side); });
        this._markerMeshes.forEach((m) => { m.visible = allow(m.userData._side); });
        this._pinBorderLines.forEach((m) => {
            if (dnp(m)) return;
            //  当开关关闭时跳过带有 DNP 标记的边界；否则
            //  遵循侧过滤器（以及 refdes 前缀过滤器）
            //  对于任何其他引脚边框，bv_filter_by_type 处于活动状态。
            if (m.userData && m.userData._isDnp && !this._showDnp) {
                m.visible = false;
                return;
            }
            const sideOk = allow(m.userData ? m.userData._side : null);
            const refOk = !this._agentFilterPrefix
                || (m.userData && m.userData._component
                    && m.userData._component.toUpperCase()
                        .startsWith(this._agentFilterPrefix));
            m.visible = sideOk && refOk;
        });
        this._componentExtras.forEach((m) => {
            if (dnp(m)) return;
            m.visible = allow(m.userData._side);
        });
        const prefix = this._agentFilterPrefix;
        const refdesOk = (id) => !prefix
            || (id && id.toUpperCase().startsWith(prefix));
        this.meshGroups.components.forEach((m) => {
            if (dnp(m)) return;
            m.visible = allow(m.userData._side) && refdesOk(m.userData.id);
        });
        this.meshGroups.traces.forEach((m) => {
            const isOutline = m.userData && m.userData.layer === 28;
            //  轮廓线与每个面的多边形相关联并遵循
            //  侧过滤器；铜迹线也遵循迹线切换。
            const sideOk = allow(m.userData ? m.userData._side : null);
            m.visible = sideOk && (isOutline ? true : this.showTraces);
        });
        //  丝印标签（0针部分：BADGE/LOGO/区域标签）
        //  — 能见度仅由侧滤光片驱动；他们有
        //  无缩放阈值。 Refdes 标签 (`_componentLabels`) 获取
        //  由下面的“_updateComponentLabelVisibility()”重新评估。
        this._silkscreenLabels.forEach((s) => {
            s.visible = allow(s.userData ? s.userData._side : null);
        });

        //  InstancedMesh — 零规模不需要的实例。原来的
        //  矩阵在构建时存储在 userData._matrices 中。
        //  DNP 层网格由“_showDnp”而不是侧面进行门控
        //  过滤器；在这里跳过它们。
        this._applySideToInstanced(this._circularPinInstance);
        this._applySideToInstanced(this._circularPinBorderInstance);
        this._rectPinInstances.forEach(({ body }) => {
            if (dnp(body)) return;
            this._applySideToInstanced(body);
        });
        this._applySideToInstanced(this._viasOuterInstance);
        this._applySideToInstanced(this._viasInnerInstance);
        this._applySideToInstanced(this._testPadsInstance);
        this._applySideToInstanced(this._testPadsBorderInstance);

        //  `keepView` 在两个面之间翻转，同时保持缩放
        //  以及屏幕上的位置——由板下潜水使用
        //  V 形点击。两种情况：
        //      1. 双轮廓布局（XZZ并排/堆叠）：
        //            两张脸位于画布的不同 XY 区域，
        //            所以 keepView 调用 `_mirrorCameraAcrossFaces` 来投影
        //            将光标移到新面孔的框架上。
        //      2. 单轮廓布局（.fz / .cad / KiCad / BRD）：两者
        //            面共享相同的 XY 坐标空间 — 翻转
        //            过滤器只是改变哪些引脚可见，相机
        //            保持原状。跳过 `_recentreOnSideMode` 保留
        //            缩放和平移。
        //  当 keepView 关闭时，我们切换到最近的位置，切换到 /
        //  从两者（没有特定的面来中心），或留在
        //  同一张脸。
        const isFlip = opts.keepView
            && prevMode !== 'both'
            && mode !== 'both'
            && prevMode !== mode;
        if (isFlip && this.dualOutline) {
            this._mirrorCameraAcrossFaces(prevMode, mode);
        } else if (isFlip) {
            //  单一大纲——无事可做；相机位置+视锥体
            //  大小已经匹配新面的坐标空间。
        } else {
            this._recentreOnSideMode();
        }
        //  既然组件翻转了，请重新应用缩放驱动的标签可见性。
        if (this._updateComponentLabelVisibility) {
            this._updateComponentLabelVisibility();
        }
        //  如果当前突出显示一张网，请重建其飞线，以便
        //  跨面端点进行板下潜水处理（或
        //  原始并排路径）与新模式匹配。
        if (this.selectedItem && this.selectedItem.net
            && this.selectedItem.net !== 'NC') {
            this.clearNetHighlight();
            this.highlightNet();
        }
        this.requestRender();
    }

    /**
     * 从`fromMode`的显示中翻译当前相机位置
     * 使用相同的翻转框架到`toMode`的显示框架
     * 反映`_netEndpointPos`适用于飞线端点。
     * 视锥体大小未改变 — 缩放级别保持原样
     * 是。镜子是在场景局部坐标中计算的，因此它组成
     *通过主动旋转干净利落地（我们round-trip通过
     * `_worldToLocal` 和前向旋转矩阵）。
     
     */
    _mirrorCameraAcrossFaces(fromMode, toMode) {
        if (!this.dualOutline) return;
        //  相机位置位于世界（旋转后）坐标中。采取
        //  在镜像到脸部之前，它会返回到场景本地。
        const localCam = this._worldToLocal(
            this.camera.position.x, this.camera.position.y
        );
        const dual = this.dualOutline;
        const top = dual.bbox_top;
        const bot = dual.bbox_bottom;
        let lx, ly;
        if (dual.axis === 'x') {
            lx = top.x + bot.x + bot.w - localCam.x;
            const tyOffset = toMode === 'top'
                ? (top.y - bot.y)
                : (bot.y - top.y);
            ly = localCam.y + tyOffset;
        } else {
            ly = top.y + bot.y + bot.h - localCam.y;
            const txOffset = toMode === 'top'
                ? (top.x - bot.x)
                : (bot.x - top.x);
            lx = localCam.x + txOffset;
        }
        //  重新旋转回世界。
        const rad = (this.rotationDeg || 0) * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        this.camera.position.x = lx * cos - ly * sin;
        this.camera.position.y = lx * sin + ly * cos;
        this.onResize();
    }

    _applySideToInstanced(mesh) {
        if (!mesh || !mesh.userData || !mesh.userData._matrices) return;
        const sides = mesh.userData._sides;
        const dnpFlags = mesh.userData._dnpFlags;
        const components = mesh.userData._components;
        const matrices = mesh.userData._matrices;
        const allow = (side) => this.sideMode === 'both'
            || side == null
            || side === this.sideMode;
        const prefix = this._agentFilterPrefix;
        const refdesOk = (id) => !prefix
            || (id && id.toUpperCase().startsWith(prefix));
        const zero = new THREE.Matrix4().makeScale(0, 0, 0);
        for (let i = 0; i < matrices.length; i++) {
            const sideOk = allow(sides[i]);
            const dnpOk = !dnpFlags || !dnpFlags[i] || this._showDnp;
            //  仅当网格记录了父级时，Refdes 过滤器才适用
            //  每个插槽的组件。过孔/安装孔没有母体
            //  并且无论过滤器如何，都保持可见。
            const refOk = !components || refdesOk(components[i]);
            const ok = sideOk && dnpOk && refOk;
            mesh.setMatrixAt(i, ok ? matrices[i] : zero);
        }
        mesh.instanceMatrix.needsUpdate = true;
    }

    _recentreOnSideMode() {
        if (!this.boardData) return;
        const data = this.boardData;
        const dual = this.dualOutline;
        let bbox;
        if (dual && this.sideMode === 'top' && dual.bbox_top) {
            bbox = dual.bbox_top;
        } else if (dual && this.sideMode === 'bottom' && dual.bbox_bottom) {
            bbox = dual.bbox_bottom;
        } else {
            bbox = {
                x: data.board_offset_x || 0,
                y: data.board_offset_y || 0,
                w: data.board_width,
                h: data.board_height,
            };
        }
        //  通过当前场景旋转投影bbox中心
        //  因此相机在旋转后仍保持相同的内容可见
        //  切换。
        const localCx = bbox.x + bbox.w / 2;
        const localCy = bbox.y + bbox.h / 2;
        const rad = (this.rotationDeg || 0) * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        this.camera.position.x = localCx * cos - localCy * sin;
        this.camera.position.y = localCx * sin + localCy * cos;
        //  90°/270°交换可见宽度/高度；翻转不会改变
        //  程度。 Math.max 对于任何旋转都保持不变，因此
        //  无论如何，平截头体都适合。
        this.frustumSize = Math.max(bbox.w, bbox.h) * 1.2;
        this.zoom = 100 / this.frustumSize;
        this.onResize();
        const zoomEl = document.getElementById('zoom-level');
        if (zoomEl) zoomEl.textContent = Math.round(this.zoom * 100);
    }

    // ========================
    //  变焦控制
    // ========================

    zoomIn() {
        this.frustumSize *= 0.75;
        //  匹配滚轮变焦底板 (0.5 mm)，因此 +/- 按钮可以
        //  达到与车轮相同的特写 — 10 毫米太粗
        //  实际检查 0402 引脚对。
        this.frustumSize = Math.max(0.5, this.frustumSize);
        this.zoom = 100 / this.frustumSize;
        this.onResize();
        document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
    }

    zoomOut() {
        this.frustumSize *= 1.25;
        const maxSize = this.boardData ? Math.max(this.boardData.board_width, this.boardData.board_height) * 10 : 2000;
        this.frustumSize = Math.min(maxSize, this.frustumSize);
        this.zoom = 100 / this.frustumSize;
        this.onResize();
        document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
    }

    resetView() {
        if (this.boardData) {
            const ox = this.boardData.board_offset_x || 0;
            const oy = this.boardData.board_offset_y || 0;
            this.camera.position.x = ox + this.boardData.board_width / 2;
            this.camera.position.y = oy + this.boardData.board_height / 2;
            this.frustumSize = Math.max(this.boardData.board_width, this.boardData.board_height) * 1.2;
            this.zoom = 100 / this.frustumSize;
            this.onResize();
            document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
        }
    }

    focusComponent(id) {
        const comp = this.meshGroups.components.find(m => m.userData.id === id);
        if (comp) {
            this.camera.position.x = comp.position.x;
            this.camera.position.y = comp.position.y;
            this.frustumSize = 25;
            this.zoom = 100 / this.frustumSize;
            this.onResize();
            this.selectItem(comp.userData);
            document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
        }
    }

    // ========================
    //  诊断亮点 API
    // ========================

    highlightComponents(componentIds) {
        if (!componentIds || componentIds.length === 0) return;

        this.clearDiagnosticHighlights();
        this.diagnosticHighlightedItems = [];

        let foundCount = 0;
        let firstFound = null;

        componentIds.forEach(compId => {
            const compIdUpper = compId.toUpperCase();

            //  检查组件（常规网格）
            this.meshGroups.components.forEach(mesh => {
                const meshId = (mesh.userData.id || '').toUpperCase();
                if (meshId === compIdUpper || meshId.startsWith(compIdUpper + '.')) {
                    mesh.userData.diagnosticHighlighted = true;
                    this._setItemHighlight(mesh.userData, true, this.colors.highlight);
                    this.diagnosticHighlightedItems.push(mesh.userData);
                    foundCount++;
                    if (!firstFound) firstFound = mesh.userData;
                }
            });

            //  检查可悬停项目（引脚、测试垫）- 支持所有实例类型
            this._hoverableItems.forEach(item => {
                const itemId = (item.id || '').toUpperCase();
                if (itemId === compIdUpper || itemId.startsWith(compIdUpper + '.')) {
                    item.diagnosticHighlighted = true;
                    this._setItemHighlight(item, true, this.colors.highlight);
                    this.diagnosticHighlightedItems.push(item);
                    foundCount++;
                    if (!firstFound) firstFound = item;
                }
            });
        });

        //  以找到的项目为中心
        if (firstFound && foundCount > 0) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

            this.diagnosticHighlightedItems.forEach(item => {
                const x = item.x || (item._mesh ? item._mesh.position.x : 0);
                const y = item.y || (item._mesh ? item._mesh.position.y : 0);
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            });

            const centerX = (minX + maxX) / 2;
            const centerY = (minY + maxY) / 2;
            const viewSize = Math.max(maxX - minX, maxY - minY) + 10;

            this.camera.position.x = centerX;
            this.camera.position.y = centerY;
            this.frustumSize = Math.max(viewSize * 1.5, 30);
            this.zoom = 100 / this.frustumSize;
            this.onResize();
            document.getElementById('zoom-level').textContent = Math.round(this.zoom * 100);
        }

        this.requestRender();
        console.log(`Highlighted ${foundCount} items for: ${componentIds.join(', ')}`);
    }

    highlightComponent(componentId) {
        if (componentId) {
            this.highlightComponents([componentId]);
        }
    }

    clearDiagnosticHighlights() {
        if (this.diagnosticHighlightedItems && this.diagnosticHighlightedItems.length > 0) {
            //  使用统一的高亮方法恢复原始颜色
            this.diagnosticHighlightedItems.forEach(item => {
                item.diagnosticHighlighted = false;
                this._setItemHighlight(item, false);
            });

            this.diagnosticHighlightedItems = [];
            this.requestRender();
        }
    }

    searchAndFocus(query) {
        if (!query) return false;

        const queryUpper = query.toUpperCase();

        //  搜索组件
        for (const mesh of this.meshGroups.components) {
            const id = (mesh.userData.id || '').toUpperCase();
            const net = (mesh.userData.net || '').toUpperCase();
            const value = (mesh.userData.value || '').toUpperCase();

            if (id.includes(queryUpper) || net.includes(queryUpper) || value.includes(queryUpper)) {
                this.highlightComponent(mesh.userData.id);
                return true;
            }
        }

        //  搜索可悬停项目
        for (const item of this._hoverableItems) {
            const id = (item.id || '').toUpperCase();
            const net = (item.net || '').toUpperCase();

            if (id.includes(queryUpper) || net.includes(queryUpper)) {
                this.focusOnItem(item);
                return true;
            }
        }

        return false;
    }

    // ========================
    //  渲染循环
    // ========================

    animate() {
        requestAnimationFrame(() => this.animate());
        if (this.needsRender) {
            this.renderer.render(this.scene, this.camera);
            this.needsRender = false;
        }
    }

    requestRender() {
        this.needsRender = true;
    }

    // ========================================================================
    //  AGENT OVERLAY API — 由 bv_* 工具事件通过 pcb_viewer_bridge 驱动。
    //  此处所有入站距离均以毫米为单位（查看者的世界单位）。
    //  该桥在调用之前会转换基于 mil 的事件有效负载。
    // ========================================================================

    /**
     * 从现有的悬停索引中按 refdes 查找组件或引脚。
     * 返回第一个匹配项，优先选择实际组件而不是
     * pin-as-id（罕见）。由桥梁的 bv_焦点 / bv_高亮 / 使用
     * bv_show_pin 路径。
     
     */
    findItemByRefdes(refdes) {
        if (!refdes || !this._hoverableItems) return null;
        const target = String(refdes).trim();
        //  更喜欢组件自己的组（没有设置_instanceType，
        //  因为 createComponent 将裸露的 comp 对象推送到引脚上。
        let best = null;
        for (const it of this._hoverableItems) {
            if (it.id !== target) continue;
            if (!it._instanceType) return it;  //  它是一个组件
            if (!best) best = it;
        }
        return best;
    }

    /**
     * 在顶面和底面之间切换。如果当前处于“两者”，
     * 选择与大多数相机中心所在的面相反的面
     * 打开（默认在第一次调用时翻转到“顶部”）。镜像
     * 传统 SVG 渲染器的翻转语义 - 单个代理手势
     * 交换可见面。
     
     */
    flipSide() {
        const next = this.sideMode === 'top' ? 'bottom'
                   : this.sideMode === 'bottom' ? 'top'
                   : 'top';  //  “两者”→ 首先落在“顶部”
        if (typeof this.setSideMode === 'function') {
            this.setSideMode(next);
        }
        this.requestRender();
    }

    /**
     * 将一个小标签精灵固定在组件上方，并在下方进行跟踪
     * `id` 因此后续调用/reset_view 可以删除它。取代
     * 任何具有相同 id 的现有注释（后端重用 id
     * 当代理商修改标签时）。
     
     */
    addAnnotation(refdes, label, id) {
        if (!id) id = `ann-${Math.random().toString(36).slice(2, 10)}`;
        //  删除具有相同 id 的先前注释，以便调用者可以
        //  就地编辑，不会将精灵泄漏到场景中。
        this.removeAnnotation(id);
        const item = this.findItemByRefdes(refdes);
        if (!item) return;
        const text = String(label || '').trim();
        if (!text) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        canvas.width = 512 * dpr;
        canvas.height = 96 * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        //  药丸背景 — bg-deep 玻璃，带有青色边缘，与
        //  聊天标注美学。宽度自动适合渲染的文本。
        ctx.font = "600 28px 'Inter', system-ui, sans-serif";
        const metrics = ctx.measureText(text);
        const padX = 14, padY = 8;
        const tw = Math.min(metrics.width, 484) + padX * 2;
        const th = 40;
        const bx = (256 - tw / 2);
        const by = 48 - th / 2;
        ctx.fillStyle = 'rgba(7, 16, 31, 0.92)';  //  bg-deep
        ctx.strokeStyle = '#67d4f5';              //  青色口音
        ctx.lineWidth = 1.5;
        const r = 6;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + tw - r, by);
        ctx.quadraticCurveTo(bx + tw, by, bx + tw, by + r);
        ctx.lineTo(bx + tw, by + th - r);
        ctx.quadraticCurveTo(bx + tw, by + th, bx + tw - r, by + th);
        ctx.lineTo(bx + r, by + th);
        ctx.quadraticCurveTo(bx, by + th, bx, by + th - r);
        ctx.lineTo(bx, by + r);
        ctx.quadraticCurveTo(bx, by, bx + r, by);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#e2e8f0';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 256, 48, 484);

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
        });
        const sprite = new THREE.Sprite(material);
        //  锚定在组件顶部边缘的正上方。 item.x/item.y 是
        //  中心（由 createComponent 设置），因此退出半高以获得
        //  顶部。用于以静态约 1.5 毫米世界高度渲染的标签，因此
        //  每当放大板时，就会折叠成一些不可读的像素
        //  出——你必须放大才能阅读。相反，调整大小+将其放置在
        //  屏幕像素并在每次缩放时重建它
        //  (`_updateAgentAnnotationScale`)，与固定像素方法相同
        //  refdes 标签和箭头。
        sprite.position.x = item.x;
        sprite.position.z = 8;
        sprite.userData = {
            _agentAnnotation: id,
            _side: item._side || null,
            _annAspect: canvas.width / canvas.height,
            _annTopY: item.y + (item.height || 1) / 2,
        };
        this._layoutAgentAnnotation(sprite, this._agentArrowPixelSize());
        this.scene.add(sprite);
        this._agentAnnotations.set(id, { sprite, refdes, label: text });
        this.requestRender();
    }

    /**
     * 当前缩放的一个代理注释的大小+位置。该药丸是
     * 保持在屏幕上的恒定高度（在任何缩放下都可读，就像地图一样）
     * 标签）并固定在其组件顶部边缘的正上方。源画布
     * 为 512×96，药丸带填充约 40/96 的高度，因此精灵
     *（横跨整个画布）缩放至“PILL_PX × 96/40”和锚点
     * 将药丸带的一半向后退，使其底部悬停在身体上方，而不是身体上。
     
     */
    _layoutAgentAnnotation(sprite, pixelSize) {
        const PILL_PX = 26;            //  可见药丸带的屏幕高度
        const CANVAS_RATIO = 96 / 40;  //  完整精灵高度 ÷ 药丸带高度
        const GAP_PX = 6;              //  组件上方的呼吸空间
        const aspect = sprite.userData._annAspect || (512 / 96);
        const worldH = PILL_PX * CANVAS_RATIO * pixelSize;
        sprite.scale.set(worldH * aspect, worldH, 1);
        sprite.position.y = sprite.userData._annTopY + (GAP_PX + PILL_PX / 2) * pixelSize;
    }

    /** 随着缩放的变化，使每个代理注释在屏幕上的尺寸保持恒定。  */
    _updateAgentAnnotationScale() {
        if (!this._agentAnnotations || !this._agentAnnotations.size) return;
        const pixelSize = this._agentArrowPixelSize();
        for (const { sprite } of this._agentAnnotations.values()) {
            this._layoutAgentAnnotation(sprite, pixelSize);
        }
    }

    removeAnnotation(id) {
        const entry = this._agentAnnotations.get(id);
        if (!entry) return;
        this.scene.remove(entry.sprite);
        if (entry.sprite.material) {
            if (entry.sprite.material.map) entry.sprite.material.map.dispose();
            entry.sprite.material.dispose();
        }
        this._agentAnnotations.delete(id);
        this.requestRender();
    }

    clearAgentAnnotations() {
        for (const id of Array.from(this._agentAnnotations.keys())) {
            this.removeAnnotation(id);
        }
    }

    /**
     * 在每个协议步骤上方绘制一个编号的徽章精灵
     * 目标组件。活动步骤（`currentId`）变得饱和
     *青色光晕；待处理/已完成的步骤以柔和的青色呈现；失败/跳过
     * 琥珀色。 `steps` 是一个 { id, target, status } 对象的数组
     *来自`protocol.js`。针对相同refdes的多个步骤是
     * 垂直堆叠（较新的台阶向上爬），因此每个台阶都保持
     * 它自己的可见徽章 - 反映 SVG 渲染器的分组
     *brd_viewer.js：702-764。
     *
     * 每次调用时都重新完整绘制（无差异）。旧徽章被丢弃
     * 在新的集合被放置之前通过clearProtocolBadges()
     * 协议中期修订（状态翻转、current_step_id 更改）落地
     * 干净利落，没有泄漏精灵或纹理。
     
     */
    setProtocolBadges(steps, currentId) {
        this.clearProtocolBadges();
        if (!Array.isArray(steps) || steps.length === 0) return;

        //  按目标 refdes 分组，因此步骤垂直共享零件堆栈。
        const grouped = new Map();   //  refdes → [{ 步骤, 显示索引 }]
        for (let i = 0; i < steps.length; i++) {
            const st = steps[i];
            if (!st || !st.target) continue;
            const arr = grouped.get(st.target) || [];
            arr.push({ step: st, displayIndex: i + 1 });
            grouped.set(st.target, arr);
        }

        const cyan = '#' + (this.tokens.cyan || 0x67d4f5).toString(16).padStart(6, '0');
        const amber = '#' + (this.tokens.amber || 0xe8b85a).toString(16).padStart(6, '0');
        const bgDeep = '#' + (this.tokens.bgDeep || 0x07101f).toString(16).padStart(6, '0');

        for (const [refdes, group] of grouped) {
            const item = this.findItemByRefdes(refdes);
            if (!item) continue;
            const halfH = (item.height || 1) / 2;
            //  第一个徽章位于 bbox 顶部边缘上方约 1.5 毫米；后来
            //  徽章以 2 毫米增量爬升（与 SVG 的 22 像素堆栈匹配）
            //  典型变焦时的间隙）。
            for (let k = 0; k < group.length; k++) {
                const { step: st, displayIndex } = group[k];
                const isActive = st.id === currentId;
                const isDone   = st.status === 'done';
                const isFail   = st.status === 'failed';
                const isSkip   = st.status === 'skipped';
                const fill     = (isFail || isSkip) ? amber : cyan;
                const glyph    = isDone ? '✓'
                              : isFail ? '✗'
                              : isSkip ? '·'
                              : String(displayIndex);

                //  画布纹理图案（与addAnnotation相同）：一个小
                //  方形纹理，使用 DPR 缩放绘制，然后映射到
                //  一个以世界（mm）为单位大小的精灵。
                const dpr = Math.min(window.devicePixelRatio || 1, 2);
                const canvasSize = 64;
                const canvas = document.createElement('canvas');
                canvas.width = canvasSize * dpr;
                canvas.height = canvasSize * dpr;
                const ctx = canvas.getContext('2d');
                ctx.scale(dpr, dpr);

                const cx = canvasSize / 2;
                const cy = canvasSize / 2;

                //  主动步骤：外光环先于实心盘，所以
                //  乍一看，这就是“这是现在要做的事情”。
                if (isActive) {
                    ctx.fillStyle = fill;
                    ctx.globalAlpha = 0.35;
                    ctx.beginPath();
                    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = 1.0;
                }

                ctx.fillStyle = fill;
                if (isDone && !isActive) ctx.globalAlpha = 0.7;
                ctx.beginPath();
                ctx.arc(cx, cy, 14, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1.0;

                ctx.fillStyle = bgDeep;
                ctx.font = "600 18px 'JetBrains Mono', monospace";
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(glyph, cx, cy + 1);

                const texture = new THREE.CanvasTexture(canvas);
                texture.minFilter = THREE.LinearFilter;
                texture.magFilter = THREE.LinearFilter;
                const material = new THREE.SpriteMaterial({
                    map: texture,
                    transparent: true,
                    depthTest: false,
                });
                const sprite = new THREE.Sprite(material);

                //  堆栈偏移：bbox 顶部上方每个插槽 2 毫米。
                const offsetY = halfH + 1.5 + k * 2.0;
                sprite.position.set(item.x, item.y + offsetY, 9);
                //  徽章尺寸以世界 (mm) 为单位。 ~2 毫米宽读取
                //  典型的 diagnostic 变焦，不使 0402s 相形见绌。
                sprite.scale.set(2.2, 2.2, 1);
                sprite.userData = { _protocolStep: st.id, _side: item._side || null };
                this.scene.add(sprite);
                this._protocolBadges.set(st.id, { sprite, refdes });
            }
        }
        this.requestRender();
    }

    /**
     * 丢弃每个协议徽章精灵，处理纹理，并清除
     * 跟踪地图。在重绘之前由 setProtocolBadges 调用，并由
     * protocol.js 当协议结束/中止时。
     
     */
    clearProtocolBadges() {
        for (const [, entry] of this._protocolBadges) {
            this.scene.remove(entry.sprite);
            if (entry.sprite.material) {
                if (entry.sprite.material.map) entry.sprite.material.map.dispose();
                entry.sprite.material.dispose();
            }
        }
        this._protocolBadges.clear();
        this.requestRender();
    }

    /**
     * 通过相机投影refdes的部分bbox顶部中心并
     * 以视口（页面）像素坐标返回结果，以便调用者
     *（例如protocol.js的浮动refdeschip）可以定位CSS
     * WebGL 画布顶部的绝对定位元素。退货
     * 当refdes不在当前棋盘中时为空，当该部分
     * 位于隐藏面上，或者当投影 NDC 位于外部时
     * [-1, 1]（屏幕外）。
     
     */
    refdesScreenPos(refdes) {
        if (!refdes) return null;
        const item = this.findItemByRefdes(refdes);
        if (!item) return null;
        //  隐藏面剔除：当用户被限制到一侧时，
        //  该部分是不可见的，屏幕位置答案将指向
        //  空的空间。 brd_viewer.js 跳过隐藏的徽章渲染
        //  侧面也是如此——这里也有同样的规则。
        if (item._side && this.sideMode !== 'both' && item._side !== this.sideMode) {
            return null;
        }
        //  在 bbox 顶部中心建立一个世界空间点。实时项目
        //  在场景局部坐标中；场景旋转 (this.scene.rotation.z)
        //  通过渲染时 Three.js 的矩阵更新融入到世界中，所以
        //  我们让 `Vector3.project(camera)` 走完整个链。
        const halfH = (item.height || 0) / 2;
        const localX = item.x;
        const localY = item.y + halfH;
        //  手动应用场景旋转，因为场景的矩阵可能不会
        //  在 setSideMode 之后的第一帧上保持最新状态
        //  / 旋转。 updateMatrixWorld() 使投影变得稳健。
        this.scene.updateMatrixWorld();
        const v = new THREE.Vector3(localX, localY, 0);
        v.applyMatrix4(this.scene.matrixWorld);
        v.project(this.camera);
        //  屏幕外防护 — 将 [-1, 1] 之外的 NDC 视为“不可见”
        //  因此调用者可以隐藏 chip 而不是将其固定到画布上
        //  边缘。
        if (v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) return null;
        const rect = this.canvas.getBoundingClientRect();
        const x = rect.left + (v.x * 0.5 + 0.5) * rect.width;
        const y = rect.top  + (v.y * -0.5 + 0.5) * rect.height;
        return { x, y };
    }

    /**
     * 突出显示“netName”上的每个引脚并调暗其余部分。使用
     * 通过选择现有的用户端highlightNet()管道
     * 首先在网络上任意pin，然后触发相同的代码
     * inspector 网络行点击运行的路径。回落到 no-op if
     * 没有引脚与名称匹配。
     
     */
    highlightNetByName(netName) {
        if (!netName) return;
        const target = String(netName).trim();
        if (!target || target === 'NC') return;
        //  找到该网络上的第一个引脚/测试焊盘并通过
        //  现有的选择+突出显示链，因此暗淡+飞线+
        //  跟踪重新着色管道的运行方式与用户单击相同。
        const anchor = (this._hoverableItems || []).find((it) => {
            const t = it._instanceType;
            return (t === 'pin' || t === 'rectPin' || t === 'testPad')
                && it.net === target;
        });
        if (!anchor) return;
        if (typeof this.selectItem === 'function') {
            this.selectItem(anchor);
        }
        if (typeof this.highlightNet === 'function') {
            this.highlightNet();
        }
        this.requestRender();
    }

    /**
     * 将相机移动到特定的引脚位置（mils → 毫米换算
     * 已被调用者应用）并选择父组件
     * 因此 inspector 填充并绘制青色光晕。使用者
     * bv_show_pin 到 direct 特定探测点的技术。
     
     */
    showPinAt(refdes, posMm) {
        if (!refdes) return;
        const item = this.findItemByRefdes(refdes);
        if (!item) return;
        if (typeof this.selectItem === 'function') {
            this.selectItem(item);
        }
        //  提供时位于引脚位置中心，否则位于
        //  组件中心。拉紧变焦，使图钉读数清晰。
        const cx = (posMm && Number.isFinite(posMm.x)) ? posMm.x : item.x;
        const cy = (posMm && Number.isFinite(posMm.y)) ? posMm.y : item.y;
        this.camera.position.x = cx;
        this.camera.position.y = cy;
        const longSide = Math.max(item.width || 4, item.height || 4);
        this.frustumSize = Math.max(longSide * 8, 12);
        this.zoom = 100 / this.frustumSize;
        if (this.onResize) this.onResize();
        this.requestRender();
    }

    /**
     * 绘制一个从一个组件中心到另一个组件中心的 directional 箭头
     * 世界坐标（毫米）。跟踪“id”下的结果组，以便
     * 未来的事件或reset_view可以干净地删除它。呈现
     * 轴作为一条线，头部作为两条短的汇聚线，所以它
     * 在任意变焦的正交相机下保持锐利。
     
     */
    addAgentArrow(fromMm, toMm, id) {
        if (!id) id = `arr-${Math.random().toString(36).slice(2, 10)}`;
        this.removeAgentArrow(id);
        if (!fromMm || !toMm) return;
        if (Math.hypot(toMm.x - fromMm.x, toMm.y - fromMm.y) < 0.01) return;

        //  WebGL `Line` 几乎在每个平台上都会忽略 `linewidth`，因此
        //  旧箭头是一个 1px 发际线轴，尖端有一个开放的 1px“V”——它
        //  勉强读作箭头。将其构建为填充的 2D 网格
        //  （长方轴+实心三角头+柔和光环），脆下
        //  正交相机。所有横轴尺寸均为屏幕像素常数
        //  （参见“_layoutAgentArrow”）：几何体在缩放时重建
        //  `_updateAgentArrowScale` 使箭头保持相同的纤细重量
        //  无论缩放如何，屏幕都会显示 - 只有其长度会跟踪板。
        const group = new THREE.Group();
        const halo = new THREE.Mesh(
            new THREE.ShapeGeometry(new THREE.Shape()),
            new THREE.MeshBasicMaterial({ color: 0x7c3aed, transparent: true, opacity: 0.32, depthTest: false }),
        );
        halo.position.z = 5.9;
        halo.renderOrder = 10;
        const body = new THREE.Mesh(
            new THREE.ShapeGeometry(new THREE.Shape()),
            new THREE.MeshBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.98, depthTest: false }),
        );
        body.position.z = 6;
        body.renderOrder = 11;
        group.add(halo);
        group.add(body);

        group.userData = {
            _agentArrow: id,
            fromMm: { x: fromMm.x, y: fromMm.y },
            toMm: { x: toMm.x, y: toMm.y },
            body,
            halo,
        };
        this._layoutAgentArrow(group, this._agentArrowPixelSize());

        this.scene.add(group);
        this._agentArrows.set(id, group);
        this.requestRender();
    }

    /** 当前缩放时每个屏幕像素的世界单位 (mm/px)。  */
    _agentArrowPixelSize() {
        const h = (this.container && this.container.clientHeight) || 800;
        return this.frustumSize / h;
    }

    /**
     *（重新）为当前缩放构建代理箭头的几何形状。箭头是
     * 在本地框架中创作，沿着 +X 从（插图）源到
     *提示，然后整个组旋转到真实航向并落在
     *来源。横轴尺寸（轴厚度、头部尺寸、插图）在
     * 屏幕像素 × 像素大小，因此它们在任何缩放下都保持视觉恒定；
     * 仅轴长度遵循实际板距。如果两部分
     * 坐得比头部能容纳的更近，箭头会自行隐藏，直到放大。
     
     */
    _layoutAgentArrow(group, pixelSize) {
        const { fromMm, toMm, body, halo } = group.userData;
        const dx = toMm.x - fromMm.x;
        const dy = toMm.y - fromMm.y;
        const len = Math.hypot(dx, dy);
        if (len < 0.01) { group.visible = false; return; }
        const ux = dx / len;
        const uy = dy / len;

        //  目标屏幕权重 (px) → 世界单位。纤细、锐利、平衡。
        const shaftHalf  = 1.1 * pixelSize;   //  ~2.2 px 轴
        const headLen    = 11  * pixelSize;   //  尖端长度
        const headHalf   = 5   * pixelSize;   //  ~10 px 头部底座
        const haloOut     = 1.2 * pixelSize;  //  光环开始
        const tipInset   = 7   * pixelSize;   //  呼吸目标中心
        const startInset = 4   * pixelSize;   //  呼吸源头中心

        const drawLen = len - tipInset - startInset;
        if (drawLen <= headLen * 1.15) { group.visible = false; return; }  //  零件离屏幕太近
        group.visible = true;
        const shaftEnd = drawLen - headLen;

        const buildGeom = (out) => {
            const s = new THREE.Shape();
            s.moveTo(-out,           shaftHalf + out);
            s.lineTo(shaftEnd,       shaftHalf + out);
            s.lineTo(shaftEnd,       headHalf + out);
            s.lineTo(drawLen + out,  0);            //  小费
            s.lineTo(shaftEnd,      -headHalf - out);
            s.lineTo(shaftEnd,      -shaftHalf - out);
            s.lineTo(-out,          -shaftHalf - out);
            s.closePath();
            return new THREE.ShapeGeometry(s);
        };

        body.geometry.dispose();
        body.geometry = buildGeom(0);
        halo.geometry.dispose();
        halo.geometry = buildGeom(haloOut);

        group.position.set(fromMm.x + ux * startInset, fromMm.y + uy * startInset, 0);
        group.rotation.z = Math.atan2(uy, ux);
    }

    /** 随着缩放的变化，使每个代理箭头在屏幕上的重量保持恒定。  */
    _updateAgentArrowScale() {
        if (!this._agentArrows || !this._agentArrows.size) return;
        const pixelSize = this._agentArrowPixelSize();
        for (const group of this._agentArrows.values()) {
            this._layoutAgentArrow(group, pixelSize);
        }
    }

    removeAgentArrow(id) {
        const group = this._agentArrows.get(id);
        if (!group) return;
        group.traverse((obj) => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
        });
        this.scene.remove(group);
        this._agentArrows.delete(id);
        this.requestRender();
    }

    clearAgentArrows() {
        for (const id of Array.from(this._agentArrows.keys())) {
            this.removeAgentArrow(id);
        }
    }

    /**
     * 在两个组件之间绘制一条测量线+距离标签。
     * 存储在“id”下以供以后删除。提供标签文本
     * 由调用者（通常代理已经计算出 mm 并发货）
     * 它在 WS 事件中），所以这个方法只是渲染。
     
     */
    addMeasurement(fromRefdes, toRefdes, label, id) {
        if (!id) id = `mes-${Math.random().toString(36).slice(2, 10)}`;
        this.removeMeasurement(id);
        const a = this.findItemByRefdes(fromRefdes);
        const b = this.findItemByRefdes(toRefdes);
        if (!a || !b) return;

        const color = 0xfbbf24;  //  琥珀色 — 测量/信息
        const mat = new THREE.LineBasicMaterial({
            color, transparent: true, opacity: 0.9, depthTest: false,
        });
        const group = new THREE.Group();
        const lineGeom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(a.x, a.y, 5),
            new THREE.Vector3(b.x, b.y, 5),
        ]);
        group.add(new THREE.Line(lineGeom, mat));

        const text = String(label || '').trim();
        if (text) {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const canvas = document.createElement('canvas');
            canvas.width = 256 * dpr;
            canvas.height = 64 * dpr;
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);
            ctx.font = "600 26px 'JetBrains Mono', monospace";
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const metrics = ctx.measureText(text);
            const tw = Math.min(metrics.width, 232) + 20;
            ctx.fillStyle = 'rgba(7, 16, 31, 0.9)';
            ctx.strokeStyle = '#fbbf24';
            ctx.lineWidth = 1.4;
            const bx = 128 - tw / 2, by = 32 - 16, th = 32, r = 5;
            ctx.beginPath();
            ctx.moveTo(bx + r, by);
            ctx.lineTo(bx + tw - r, by);
            ctx.quadraticCurveTo(bx + tw, by, bx + tw, by + r);
            ctx.lineTo(bx + tw, by + th - r);
            ctx.quadraticCurveTo(bx + tw, by + th, bx + tw - r, by + th);
            ctx.lineTo(bx + r, by + th);
            ctx.quadraticCurveTo(bx, by + th, bx, by + th - r);
            ctx.lineTo(bx, by + r);
            ctx.quadraticCurveTo(bx, by, bx + r, by);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#fde68a';
            ctx.fillText(text, 128, 32, 232);

            const texture = new THREE.CanvasTexture(canvas);
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
                map: texture, transparent: true, depthTest: false,
            }));
            sprite.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 7);
            const aspect = canvas.width / canvas.height;
            const baseH = 1.2;
            sprite.scale.set(baseH * aspect, baseH, 1);
            group.add(sprite);
        }

        group.userData = { _agentMeasurement: id };
        this.scene.add(group);
        this._agentMeasurements.set(id, group);
        this.requestRender();
    }

    removeMeasurement(id) {
        const group = this._agentMeasurements.get(id);
        if (!group) return;
        group.traverse((obj) => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                if (obj.material.map) obj.material.map.dispose();
                obj.material.dispose();
            }
        });
        this.scene.remove(group);
        this._agentMeasurements.delete(id);
        this.requestRender();
    }

    clearAgentMeasurements() {
        for (const id of Array.from(this._agentMeasurements.keys())) {
            this.removeMeasurement(id);
        }
    }

    /**
     * 应用/清除refdes前缀过滤器。设置后，每个组件
     * id不以前缀开头的有其大纲组
     * 隐藏，其 refdes 标签精灵隐藏，其引脚零缩放
     * 在共享的 InstancedMesh 插槽之外（与 DNP 切换相同的习惯用法
     * 使用 — 请参阅“_applySideToInstanced”）。过滤轴由 AND 组成：
     * 引脚可见，当且仅当（侧面 OK）AND（DNP OK）AND（refdes 前缀 OK）。
     * 清除过滤器将从保存的所有三个类别中恢复
     * `_matrices` / 每个精灵缩放感知的可见路径。
     
     */
    setRefdesFilter(prefix) {
        const p = prefix ? String(prefix).trim().toUpperCase() : null;
        this._agentFilterPrefix = p || null;
        this._applyRefdesFilter();
        this.requestRender();
    }

    _applyRefdesFilter() {
        const p = this._agentFilterPrefix;
        const allow = (id) => !p || (id && id.toUpperCase().startsWith(p));
        //  组件组
        if (this.meshGroups && Array.isArray(this.meshGroups.components)) {
            for (const g of this.meshGroups.components) {
                const ud = g.userData || {};
                //  像以前一样尊重侧面过滤器 - 仅覆盖
                //  当侧面滤镜时前缀轴上的可见性
                //  会允许这部分。
                const sideOk = (this.sideMode === 'both' || !ud._side
                    || ud._side === this.sideMode);
                g.visible = sideOk && allow(ud.id);
            }
        }
        //  固定/垫 InstancedMeshes — 现在 `_applySideToInstanced` 并且
        //  在`this._agentFilterPrefix`中针对每个插槽的存储
        //  `_components[i]`，因此每个网格的一次传递会重新计算
        //  复合（侧面 AND DNP AND refdes）可见性。与以下成语相同
        //  setShowDnp 使用。
        this._applySideToInstanced(this._circularPinInstance);
        this._applySideToInstanced(this._circularPinBorderInstance);
        if (this._rectPinInstances) {
            this._rectPinInstances.forEach(({ body }) => {
                this._applySideToInstanced(body);
            });
        }
        this._applySideToInstanced(this._testPadsInstance);
        if (this._testPadsBorderInstance) {
            this._applySideToInstanced(this._testPadsBorderInstance);
        }
        //  每个引脚的矩形边框是单独的线 - 翻转它们
        //  复合门（侧面 + DNP + refdes）的可见性。
        if (Array.isArray(this._pinBorderLines)) {
            const sideAllow = (side) => this.sideMode === 'both'
                || side == null
                || side === this.sideMode;
            for (const m of this._pinBorderLines) {
                const ud = m.userData || {};
                const sideOk = sideAllow(ud._side);
                const dnpOk = !ud._isDnp || this._showDnp;
                const refOk = allow(ud._component);
                m.visible = sideOk && dnpOk && refOk;
            }
        }
        //  Refdes 标签 — 门并排 AND 前缀。变焦感知
        //  下面的更新程序根据屏幕决定最终的可见性
        //  大小，因此只要前缀允许，我们就委托给它
        //  精灵（它已经支持侧面 + DNP + 缩放）。
        if (Array.isArray(this._componentLabels)) {
            for (const sprite of this._componentLabels) {
                const ud = sprite.userData || {};
                if (!allow(ud._refdes)) {
                    sprite.visible = false;
                }
            }
            if (typeof this._updateComponentLabelVisibility === 'function') {
                this._updateComponentLabelVisibility();
            }
        }
    }

    /**
     * 调暗当前未选择或突出显示的每个组件/引脚
     * 由代理人。当前的“selectedItem”和任何正在进行的网络
     * 突出显示保持全亮。镜像旧版 SVG dim_unrelated
     * 通过降低不相关的行为，达到InstancedMesh级别的行为
     * 组件的组不透明度。引脚属于现有的
     * 当网络处于活动状态时`_dimUnlatedPins(netName)`路径；没有
     * net 这是一个仅主体的暗淡，这是 SVG 渲染器的
     * 行为也是如此。
     
     */
    dimUnrelated() {
        this._agentDimActive = true;
        //  组件：降低 id 不是的每个组的不透明度
        //  所选项目且不在当前网络的锚点refdes上。
        const selId = this.selectedItem ? this.selectedItem.id : null;
        const selRefdes = this.selectedItem
            ? (this.selectedItem.component || this.selectedItem.id)
            : null;
        if (this.meshGroups && Array.isArray(this.meshGroups.components)) {
            for (const g of this.meshGroups.components) {
                const ud = g.userData || {};
                const keep = (ud.id === selId) || (ud.id === selRefdes);
                g.traverse((m) => {
                    if (!m.material) return;
                    //  我们第一次接触材料时，拍摄快照
                    //  预调暗状态，因此clearDim可以精确恢复。
                    if (m.material._origOpacity == null) {
                        m.material._origOpacity = m.material.opacity == null ? 1 : m.material.opacity;
                        m.material._origTransparent = !!m.material.transparent;
                    }
                    if (!keep) {
                        m.material.transparent = true;
                        m.material.opacity = 0.18;
                    } else {
                        m.material.transparent = m.material._origTransparent;
                        m.material.opacity = m.material._origOpacity;
                    }
                    m.material.needsUpdate = true;
                });
            }
        }
        this.requestRender();
    }

    clearDim() {
        if (!this._agentDimActive) return;
        this._agentDimActive = false;
        if (this.meshGroups && Array.isArray(this.meshGroups.components)) {
            for (const g of this.meshGroups.components) {
                g.traverse((m) => {
                    if (!m.material) return;
                    if (m.material._origOpacity != null) {
                        m.material.opacity = m.material._origOpacity;
                        m.material.transparent = !!m.material._origTransparent;
                        delete m.material._origOpacity;
                        delete m.material._origTransparent;
                        m.material.needsUpdate = true;
                    }
                });
            }
        }
        this.requestRender();
    }

    /**
     * 切换单个图层的可见性。观众的主要
     * 人脸过滤器是 `setSideMode('top'|'bottom'|'both')`，所以映射
     *（图层，可见）→侧面模式通过处理“显示顶部，隐藏
     * 底部”/“隐藏顶部，显示底部”作为侧翻或其他
     * 回到“两者”。
     
     */
    setLayerVisibility(layer, visible) {
        if (layer !== 'top' && layer !== 'bottom') return;
        const other = layer === 'top' ? 'bottom' : 'top';
        //  维护每层标志，以便两个连续调用（例如隐藏
        //  顶部，然后隐藏底部）折叠到右侧的复合模式。
        if (!this._layerVisible) this._layerVisible = { top: true, bottom: true };
        this._layerVisible[layer] = !!visible;
        const anyVisible = this._layerVisible.top || this._layerVisible.bottom;
        if (!anyVisible) {
            //  两者都隐藏——回退到“两者”，这样用户就不会
            //  盯着空白的画布。这是一个堕落的请求。
            this.setSideMode('both');
            return;
        }
        if (this._layerVisible.top && this._layerVisible.bottom) {
            this.setSideMode('both');
        } else {
            this.setSideMode(this._layerVisible.top ? 'top' : 'bottom');
        }
    }

    /**
     * 一次性重置每个代理驱动的overlay。被称为
     * bv_重置视图路径。留给用户选择，侧面模式，
     * 并且相机位置完好无损 - SVG 渲染器的重置已
     * 范围相同。
     
     */
    resetAgentOverlays() {
        this.clearAgentAnnotations();
        this.clearAgentArrows();
        this.clearAgentMeasurements();
        this.clearProtocolBadges();
        this.clearDim();
        if (this._agentFilterPrefix) {
            this.setRefdesFilter(null);
        }
    }
}

//  导出以供使用 - 桥通过 window.PCBViewerOptimized 进行消耗。
if (typeof window !== 'undefined') {
    window.PCBViewerOptimized = PCBViewerOptimized;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PCBViewerOptimized;
}

//  ---------- 网络类别颜色 API（窗口全局变量） ----------
//
//  Tweaks 颜色选择器 (web/js/main.js) 通过以下方式驱动网络类别颜色
//  这四个全局变量。它们在历史上是由遗留的 SVG 定义的
//  brd_viewer.js；该文件已停用，因此 pcb_viewer — 已经拥有
//  调色板默认值 (PCB_DEFAULT_NET_HEX)、“msa.pcb.netColors”存储以及
//  实时重新着色路径 (setNetCategoryColor) — 现在提供它们 directly。
//  `get*` 是纯数据（在任何板加载之前可用）；二传手推动直播
//  当活动查看器存在并持续存在时，重新着色到活动查看器，因此做出了选择
//  屏幕上没有任何板子仍然可以存活到下一次加载。
if (typeof window !== 'undefined') {
    window.getBoardviewColorDefaults = () => ({ ...PCB_DEFAULT_NET_HEX });
    window.getBoardviewColors = () => loadPcbNetColors();
    window.setBoardviewNetColor = (category, hex) => {
        if (_activeViewer) {
            //  setNetCategoryColor 保留 (savePcbNetColors) 并重新着色。
            _activeViewer.setNetCategoryColor(category, hex);
            return;
        }
        //  屏幕上还没有任何棋盘——只能坚持。镜像设置NetCategoryColor's
        //  'default' -> 'no-net' 存储键重新映射，以便下一个加载匹配。
        const hexStr = typeof hex === 'string'
            ? (hex.startsWith('#') ? hex : '#' + hex)
            : '#' + Number(hex).toString(16).padStart(6, '0');
        const storeKey = category === 'default' ? 'no-net' : category;
        const colors = loadPcbNetColors();
        if (storeKey in colors) {
            colors[storeKey] = hexStr;
            savePcbNetColors(colors);
        }
    };
    window.resetBoardviewColors = () => {
        savePcbNetColors({ ...PCB_DEFAULT_NET_HEX });
        if (_activeViewer) {
            for (const [cat, hex] of Object.entries(PCB_DEFAULT_NET_HEX)) {
                _activeViewer.setNetCategoryColor(cat, hex);
            }
        }
    };
}
