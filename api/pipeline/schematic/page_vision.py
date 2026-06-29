"""Per-page Claude Opus vision call — RenderedPage → SchematicPageGraph.

Forced tool use with the full SchematicPageGraph schema as `input_schema`.
No grounding dump is injected into the prompt: Claude 4.8 vision is strong
enough on clean KiCad-style PDFs to extract refdes, values, topology, and
typed edges directly from the rendered page. pdfplumber only provides the
scan-detection hint passed as context.

Runs one page at a time; the orchestrator parallelises calls with
`asyncio.gather`, relying on Anthropic's automatic prompt caching on the
large `tools` array + the system prompt.
"""

from __future__ import annotations

import base64
import logging

from anthropic import AsyncAnthropic

from api.pipeline.schematic.renderer import RenderedPage
from api.pipeline.schematic.schemas import SchematicPageGraph
from api.pipeline.tool_call import call_with_forced_tool, effort_for_model

logger = logging.getLogger("wrench_board.pipeline.schematic.page_vision")


SUBMIT_PAGE_TOOL_NAME = "submit_schematic_page"

# Token budget: 128k total (Opus 4.8 max output) = up to 24k thinking +
# ~104k visible. Dense Apple pages (hundreds of nets) genuinely exceed the
# old 64k cap → they hit stop_reason=max_tokens and TRUNCATED, silently
# dropping real refdes/nets from the extraction (measured on a 92-page Mac
# build: 14 pages pegged out=64000). On a diagnostic graph, truncation is
# worse than the extra tokens — the cost is data we actually need. (V2:
# also trim the SchematicPageGraph schema to cut redundant verbosity.)
PAGE_MAX_TOKENS = 128000

# Extended thinking: the model reasons before emitting the structured tool
# call. Opus 4.7/4.8 only accept `adaptive` (the deprecated `enabled` type
# returns 400), and the default `display` is "omitted" (silent) — opt back
# into summarized blocks so observers see progress. Shared verbatim by the
# direct path (via tool_call.py) and the batch-vision twin.
PAGE_THINKING_PARAM = {"type": "adaptive", "display": "summarized"}

# ┌─────────────────────────────────────────────────────────────────────┐
# │ 中文参考译文（仅供注释，不参与实际调用）                            │
# ├─────────────────────────────────────────────────────────────────────┤
# │ 你是一名专业的电子技师和原理图分析师。                               │
# │                                                                     │
# │ 你将收到一块板级原理图 PDF 的单页渲染图。你的任务是发出一次           │
# │ `submit_schematic_page` 工具调用，其 payload 须严格匹配              │
# │ SchematicPageGraph schema。                                         │
# │                                                                     │
# │ 硬性规则——绝不违反：                                                │
# │ 1. 绝不捏造 refdes、网络标签、引脚号、数值或 MPN。若从图像无法       │
# │    确定某字段，使用 null 或省略该条目。空值永远优于编造值。            │
# │ 2. 只要能从页面推断语义关系，就填充 `typed_edges`：                   │
# │    `powers`/`powered_by`（稳压器输出/输入）、`enables`（EN/ON/OFF    │
# │    信号）、`resets`（RESET 引脚）、`decouples`（电源引脚旁的旁路      │
# │    电容）、`filters`（轨道上的串联电感）。                            │
# │ 3. 对页面上可见的每个跨页连接器或层次端口，发出一条                   │
# │    `CrossPageRef`，填入其标签（符号旁印刷的文字）。根据箭头方向       │
# │    设置 `direction` 为 `in`、`out`、`bidir`；KiCad 子图引用用         │
# │    `subsheet`。                                                     │
# │ 4. 根据引脚名称和元件上下文分类每个引脚的 `role`。典型模式：          │
# │    - 电源：`VIN`/`VDD`/`VCC` → `power_in`；`VOUT` → `power_out`；   │
# │      `SW`/`LX` → `switch_node`；`GND`/`VSS` → `ground`。            │
# │    - 控制：`EN`/`SHDN` → `enable_in`；`PG`/`PGOOD` →                │
# │      `power_good_out`；`RESET`/`RSTn` → `reset_in`/`reset_out`；    │
# │      `FB`/`SENSE` → `feedback_in`；`CLK`/`XTAL` →                   │
# │      `clock_in`/`clock_out`。                                       │
# │    - 数字总线：`Dn`/`DQn`（数据）、`An`/`BA`/`RAS`/`CAS`/`WE`       │
# │      （地址/控制）、`D+`/`D-`/`TX_P`/`RX_P`（差分对）→ `bus_pin`。   │
# │    - 通用 IO：`GPIOn`/`IO_n` → `signal_inout`；`IRQ`/`INT` →        │
# │      `signal_out`。                                                 │
# │    - 其他：`NC`/`N.C.` → `no_connect`；连接器上无标签引脚 →          │
# │      `terminal`。无匹配时用 `unknown`，绝不捏造 role。               │
# │ 5. 标注为 "NOSTUFF"/"DNP"/"DNI" 的元件设置 `populated=False`         │
# │    （该字段在 PageNode 顶层，不在 `value` 内）。                     │
# │ 6. 捕获设计者标注（品红色/斜体文本）为 `designer_notes`。             │
# │                                                                     │
# │ schema 字段放置要点：                                                │
# │ - `populated`（布尔）仅在 PageNode 顶层。                           │
# │ - `polarity_marker`（布尔）仅在嵌套 `value` 对象内                   │
# │   （即 `node.value.polarity_marker`），不在节点顶层。                │
# │ - `primary`、`package`、`mpn`、`tolerance` 等均在 `value` 内。       │
# │   读到 "LM2677SX-5" 时，同时填入 `value.raw` 和 `value.mpn`。       │
# │ 7. 诚实使用 `confidence`（0.0–1.0）：所有元素清晰可辨时为 1.0，       │
# │    模糊/旋转/密度过高时降低。                                       │
# │ 8. 用 `ambiguities` 标记你*看到*但*无法确认*的内容。                  │
# │                                                                     │
# │ 页面图像是唯一事实来源——看不到的就视为真正未知，输出 null/空而非      │
# │ 编造。                                                              │
# └─────────────────────────────────────────────────────────────────────┘

SYSTEM_PROMPT = """You are an expert electronics technician and schematic analyst.

You will receive one rendered page of a board-level schematic PDF. Your job is
to emit a single `submit_schematic_page` tool call whose payload matches the
SchematicPageGraph schema precisely.

Hard rules — NEVER violate:
1. Never invent a refdes, net label, pin number, value, or MPN. When a field
   cannot be determined from the image, use null or omit the entry. Empty or
   null is always preferable to a fabricated value.
2. Populate `typed_edges` whenever you can infer a semantic relationship from
   the page: `powers` / `powered_by` for regulator outputs / inputs, `enables`
   for EN/ON/OFF signals, `resets` for RESET pins, `decouples` for bypass caps
   placed next to a power pin, `filters` for series inductors on a rail.
3. For every off-page connector or hierarchical port visible on the page,
   emit a `CrossPageRef` with its label (the text printed next to the symbol).
   Set `direction` to `in`, `out`, or `bidir` based on the arrow direction,
   or `subsheet` for KiCad-style sub-sheet references.
4. Classify each pin's `role` from pin name + component context. Canonical
   patterns (commit, then fall back to `unknown` only when none fits):
   - Power: `VIN`/`VDD`/`VCC`/`AVDD`/`VBAT` → `power_in`; `VOUT`/`VBUS_OUT`
     → `power_out`; `SW`/`LX`/`PHASE` → `switch_node`; `GND`/`VSS`/`AGND`/
     `DGND` → `ground`.
   - Control: `EN`/`SHDN`/`ON_OFF` → `enable_in`; `PG`/`PGOOD` →
     `power_good_out`; `RESET`/`RSTn`/`POR` → `reset_in`/`reset_out` by
     direction; `FB`/`SENSE`/`VFB` → `feedback_in`; `CLK`/`XTAL` →
     `clock_in`/`clock_out`.
   - Digital bus: `Dn`/`DQn` (memory data lanes), `An`/`BA`/`RAS`/`CAS`/`WE`
     (memory address/control), `D+`/`D-`/`TX_P`/`TX_N`/`RX_P`/`RX_N` (diff
     pairs) → `bus_pin`.
   - Generic IO: `GPIOn`/`IO_n` → `signal_inout`; `IRQ`/`INT`/`ALERT`/`DREQ`
     (driven by the chip) → `signal_out`; named uni-directional logic →
     `signal_in` or `signal_out` from the page's arrow / functional context.
   - Misc: `NC`/`N.C.`/`No Connect` → `no_connect`; unlabelled pins on a
     connector / header symbol → `terminal`.
   When no canonical pattern fits, use `unknown` — never invent a role to
   look more thorough.
5. Mark components annotated as "NOSTUFF" / "DNP" / "DNI" with `populated=False`
   (this field lives on the PageNode itself, not inside `value`).
6. Capture designer annotations (magenta/italic text attached to a component
   or net) as `designer_notes`, attaching the refdes or net when the visual
   association is unambiguous.

SCHEMA PLACEMENT — common confusions to avoid:
- `populated` (bool) is ONLY on the PageNode (top level of a node).
- `polarity_marker` (bool) is ONLY inside the nested `value` object (i.e.
  `node.value.polarity_marker`), never at the top level of a node. Set
  it when a pin-1 dot or polarity band is visible on the symbol.
- `primary`, `package`, `mpn`, `tolerance`, `voltage_rating`, `temp_coef`,
  `description` all live inside `value`. When you read a chip like
  "LM2677SX-5", put it in BOTH `value.raw` AND `value.mpn`
  (it's the manufacturer part number and we want it searchable).
7. Use `confidence` honestly in [0.0, 1.0]: 1.0 when every visible element is
   clearly legible, lower when parts of the page are blurry, rotated, or dense
   beyond reliable reading.
8. Use `ambiguities` to flag anything you *see* but cannot *resolve* (e.g.
   "component at top-right has an unreadable refdes", "off-page connector
   lacks a legible label").

The page image is the sole source of truth — treat anything you can't see
as genuinely unknown, and emit null/empty rather than fabricate.
"""


def _submit_page_tool() -> dict:
    """构建传给 Anthropic Messages API 的工具声明——告诉模型"你可以调用这个工具"。

    返回的 dict 会作为 `tools` 参数的一项传给 `client.messages.create()`。
    模型分析完图片后，以 `tool_use` 块返回结构化 JSON，代码侧通过
    `call_with_forced_tool` 捕获并用 Pydantic 校验 payload。

    ┌─────────────────────────────────────────────────────────────────┐
    │ 返回值 JSON 结构说明                                            │
    ├─────────────────────────────────────────────────────────────────┤
    │ {                                                               │
    │   "name": "submit_schematic_page",                              │
    │     ↑ 工具名称。模型返回的 tool_use 块中 name 字段必须匹配此值。 │
    │                                                                 │
    │   "description": "Submit the structured analysis of one         │
    │     schematic page as a SchematicPageGraph payload.",            │
    │     ↑ 工具描述，帮助模型理解何时/如何使用。                      │
    │                                                                 │
    │   "input_schema": { ... },                                      │
    │     ↑ 从 SchematicPageGraph Pydantic model 自动生成的 JSON       │
    │     Schema，定义模型调用时必须遵守的参数结构。Anthropic API 用   │
    │     此 schema 校验输出，不合法的 payload 会被拒绝。              │
    │                                                                 │
    │   "cache_control": {"type": "ephemeral"}                        │
    │     ↑ 启用 Anthropic prompt cache。12 页批量调用共享同一份       │
    │     ~5-6k token 的 schema 定义，热命中时 input 成本降 50-90%。   │
    │ }                                                               │
    ├─────────────────────────────────────────────────────────────────┤
    │ input_schema 展开后的顶层字段（SchematicPageGraph）：            │
    │                                                                 │
    │ schema_version  — 固定 "1.0"                                    │
    │ page            — 1-based 页码                                  │
    │ sheet_name      — 标题栏中的图纸名（可选）                      │
    │ sheet_path      — 层次化图纸路径（可选，用于重建图纸树）        │
    │ page_kind       — 页面类别：schematic/notes/block_diagram 等    │
    │ orientation     — 页面方向：portrait/landscape                  │
    │ confidence      — 模型自评可信度 0.0–1.0（引脚不可辨/密集时降低）│
    │ nodes           — 元件列表（PageNode[]）：refdes/type/value/    │
    │                   pins/populated                                │
    │ nets            — 网络列表（PageNet[]）：local_id/label/        │
    │                   is_power/connects                             │
    │ cross_page_refs — 跨页连接器（CrossPageRef[]）：label/direction │
    │ typed_edges     — 语义拓扑边（TypedEdge[]）：src/dst/kind       │
    │                   （powers/enables/decouples/filters 等）        │
    │ designer_notes  — 设计者标注（DesignerNote[]）                  │
    │ ambiguities     — 模型看到但无法确认的内容（Ambiguity[]）       │
    ├─────────────────────────────────────────────────────────────────┤
    │ 子模型速查：                                                    │
    │                                                                 │
    │ PageNode:                                                       │
    │   refdes (str)     — 位号，如 "U7", "C29"                      │
    │   type (str)       — 元件族：resistor/capacitor/ic/connector…   │
    │   value (obj|null) — 值：raw/primary/package/mpn/tolerance…     │
    │   pins (PagePin[]) — 引脚：number/name/role/net_label           │
    │   populated (bool) — false = DNP/DNI/NOSTUFF                    │
    │                                                                 │
    │ PagePin:                                                        │
    │   number (str)       — 引脚号，如 "1", "A3"                     │
    │   name (str|null)    — 引脚功能名，如 "VIN", "EN", "SW"         │
    │   role (str)         — 语义分类：power_in/ground/signal_out/    │
    │                        enable_in/feedback_in/bus_pin/unknown…   │
    │   net_label (str|null)— 连接的网络标签，如 "+3V3", null=未标注   │
    │                                                                 │
    │ PageNet:                                                        │
    │   local_id (str)    — 页内唯一标识，如 "net_0001"               │
    │   label (str|null)  — 网络标签："+3V3", "GND", null=未标注       │
    │   is_power (bool)   — 是否电源轨（VCC/VDD/GND/+xVy）           │
    │   is_global (bool)  — 是否跨页全局融合（GND, 主电源轨）         │
    │   connects (str[])  — 连接的引脚列表，如 ["U7.1", "C29.2"]     │
    │                                                                 │
    │ CrossPageRef:                                                   │
    │   label (str|null)     — 跨页连接器旁的文字标签                 │
    │   direction (str)      — in/out/bidir/subsheet                  │
    │   at_pin (str|null)    — 根植引脚，如 "U7.22"                   │
    │   target_hint (str|null)— 目标位置提示，如 "page 5, zone B3"    │
    │                                                                 │
    │ TypedEdge:                                                      │
    │   src (str)  — 边起点（refdes 或 net label）                    │
    │   dst (str)  — 边终点（refdes 或 net label）                    │
    │   kind (str) — 语义关系：powers/enables/resets/decouples/       │
    │                filters/clocks/produces_signal/consumes_signal…  │
    │                                                                 │
    │ DesignerNote:                                                   │
    │   text (str)                — 标注原文                          │
    │   attached_to_refdes (str|null) — 关联的元件                    │
    │   attached_to_net (str|null)    — 关联的网络                    │
    │                                                                 │
    │ Ambiguity:                                                      │
    │   description (str)   — 无法确认的内容描述                      │
    │   related_refdes (str[]) — 关联元件                            │
    │   related_nets (str[])   — 关联网络                            │
    └─────────────────────────────────────────────────────────────────┘
    """
    return {
        "name": SUBMIT_PAGE_TOOL_NAME,
        "description": (
            "Submit the structured analysis of one schematic page as a "
            "SchematicPageGraph payload."
        ),
        # 从 Pydantic model 自动生成 JSON Schema，Anthropic API 用此校验输出
        "input_schema": SchematicPageGraph.model_json_schema(),
        # 标记为可缓存——12 页批量调用共享同一份 schema 定义，
        # 热命中时 input 成本降 50-90%
        "cache_control": {"type": "ephemeral"},
    }


def build_page_user_content(
    *,
    rendered: RenderedPage,
    total_pages: int,
    device_label: str | None = None,
    grounding: str | None = None,
) -> list[dict]:
    """Build the user-message content blocks for one page's vision call.

    Shared by the direct path (`extract_page`) and the batch twin
    (`batch_vision.build_page_request`) so the two passes extract with the
    byte-identical prompt — any drift here would mean the -50% batch pass
    silently produces different-quality graphs.

    When `grounding` is provided, it is inlined into the user message as a
    truth set. The system prompt tells the model to only emit refdes, net
    labels and values from the grounding — collapsing the fabrication failure
    mode observed on cheaper models running nu.
    """
    # 读取渲染好的 PNG 文件并转为 base64，供 vision API 接收图片
    png_bytes = rendered.png_path.read_bytes()
    b64 = base64.standard_b64encode(png_bytes).decode("ascii")

    # 拼装上下文信息行：设备名 + 页码 + 页面方向
    context_line = (
        f"Device: {device_label or 'unknown'}. "
        f"Page {rendered.page_number} of {total_pages}. "
        f"Orientation: {rendered.orientation}."
    )
    # 扫描件（无文字/矢量）清晰度低，提示模型降低 confidence
    if rendered.is_scanned:
        context_line += (
            " This page looks rasterised (no extractable text or vectors) — "
            "expect lower legibility and set `confidence` accordingly."
        )

    # ── 构建 user message 的 content block 列表 ──
    # block 1: 上下文文本（设备名、页码、方向、扫描件提示）
    user_content: list[dict] = [{"type": "text", "text": context_line}]
    # block 2: grounding 文本真值集（可选，PDF 提取的文字，用于防幻觉）
    if grounding:
        user_content.append({"type": "text", "text": grounding})
    # block 3: 原理图页面图片（base64 编码）
    user_content.append(
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": b64,
            },
        }
    )

    # ── 主分析指令 ──
    # 告诉模型：调用 submit_schematic_page 提交结构化结果；
    # 遵守 system prompt 的硬性规则，空值优于编造；
    # nodes/nets/typed_edges/designer_notes 都应填充，空数组是红旗；
    # 100+ 引脚元件页应有 30-50+ 独立网络标签（含 _0/_1/_2 后缀变体）；
    # 小字电源轨标签是最常遗漏的，要系统性扫描整页；
    # 追踪每根印制导线从引脚到终端标签/跨页连接器/电源符号，
    # 不要从空间邻近关系猜 net 归属；
    # 电源分配页每个拓扑关系都应产生 typed_edges（decouples/filters/powers）；
    # 80+ 元件的电源页通常应有 40-80 条边，<15 条说明拓扑未真正追踪；
    # 反幻觉守卫：边的端点必须已存在于 nodes 或 nets 中，不能捏造。
    #
    # ┌─────────────────────────────────────────────────────────────────┐
    # │ SYSTEM_PROMPT 与 instruction 的关系：                          │
    # │                                                                 │
    # │ SYSTEM_PROMPT = "宪法"（永久规则，所有页面共享，通过 prompt     │
    # │   cache 缓存）：定义角色身份、6 条硬性规则、schema 字段放置     │
    # │   要点、confidence/ambiguities 使用规范。                       │
    # │                                                                 │
    # │ instruction = "操作手册"（针对当前页面的具体指导，每次调用时     │
    # │   动态构建）：告诉模型如何处理这张具体的图片——提交结构化结果、  │
    # │   填充所有字段、网络标签密度要求、导线追踪方法、电源页拓扑边    │
    # │   要求、反幻觉守卫。                                            │
    # │                                                                 │
    # │ 两者分工：SYSTEM_PROMPT 约束"怎么做"（规则），instruction       │
    # │ 约束"做什么"（任务）。Anthropic prompt cache 对 SYSTEM_PROMPT   │
    # │ 做前缀缓存，12 页批量调用共享同一份缓存，节省 ~5-6k tokens。    │
    # └─────────────────────────────────────────────────────────────────┘
    #
    # ┌─────────────────────────────────────────────────────────────────┐
    # │ instruction 中文参考译文（仅供注释，不参与实际调用）             │
    # ├─────────────────────────────────────────────────────────────────┤
    # │ 分析此页面并调用 submit_schematic_page 工具提交完整的            │
    # │ SchematicPageGraph payload。遵守 system prompt 的所有硬性规则。  │
    # │ 空值/空字段永远优于编造。                                       │
    # │                                                                 │
    # │ 一页真实的原理图应填充所有字段：`nodes`、`nets`、                │
    # │ `typed_edges`、`designer_notes`——空数组是红旗，不是目标。        │
    # │                                                                 │
    # │ 引脚/扇出页（单个元件 100+ 引脚）应有 30-50+ 个独立网络标签：    │
    # │ 逐一枚举为各自的 PageNet，含索引后缀变体（如 _0/_1/_2/_3 是      │
    # │ 不同网络，不是基础名的别名）。                                   │
    # │                                                                 │
    # │ 角落或辅助功能块旁的小字电源轨标签是最常遗漏的——要系统性扫描     │
    # │ 整张图，不要只看视觉主导区域。                                   │
    # │                                                                 │
    # │ 分配引脚到网络时，沿每根印制导线从引脚追踪到终端标签、跨页       │
    # │ 连接器或电源符号；不要仅凭引脚与附近标签的空间邻近关系猜测。     │
    # │                                                                 │
    # │ 另外，在板级电源分配页（可通过多个稳压器 [buck/LDO/负载开关      │
    # │ IC] 经磁珠、电感、保险丝和旁路电容馈电给多个下游负载来识别）     │
    # │ 上，每个可见的拓扑关系都应产生一条 `typed_edges`。具体而言：      │
    # │   - IC 电源/GND 引脚旁聚集的陶瓷电容 → `decouples` 边            │
    # │   - 轨道上源与负载之间的串联磁珠/电感 → `filters` 边             │
    # │   - 轨道入口处的保险丝/串联电阻 → `powers` 边（源→汇）           │
    # │   - 稳压器输出引脚（VOUT/SW 后 LC/LDO 输出）→ `powers` 边       │
    # │     （馈给页面上每个负载）                                       │
    # │ 80+ 元件的电源页通常应有 40-80 条此类边；<15 条说明拓扑未真正    │
    # │ 追踪。                                                          │
    # │                                                                 │
    # │ 关键反幻觉守卫：边的端点（`src`/`dst`）必须已存在于你的          │
    # │ `nodes`（refdes）或 `nets` 列表中——绝不为凑齐边而捏造端点；      │
    # │ 若无法从图像确认两个端点，就省略该边。                           │
    # │                                                                 │
    # │ grounding 存在时追加：                                           │
    # │ 以 grounding 文本块为拼写/存在性校验基准：你发出的 refdes 和     │
    # │ 网络标签应来自 grounding 集合（如果与 grounding 矛盾，以         │
    # │ grounding 为准，拒绝你自己的读数）。grounding 在密集页面上不一   │
    # │ 定完整——如果图像清晰显示了列表中缺失的标签，你可以发出它，同时   │
    # │ 在 `ambiguities` 中添加一条注明差异。追踪每根导线到目标标签，    │
    # │ 而非仅凭邻近关系猜测。                                          │
    # └─────────────────────────────────────────────────────────────────┘
    instruction = (
        "Analyse this page and call the submit_schematic_page tool with a "
        "complete SchematicPageGraph payload. Respect all hard rules from the "
        "system prompt. Null / empty over fabrication. A real schematic page "
        "is expected to populate ALL of: `nodes`, `nets`, `typed_edges`, and "
        "`designer_notes` — empty arrays are a red flag, not the goal. On "
        "pinout / fanout pages where a single component carries 100+ pins, "
        "expect 30-50+ distinct net labels: enumerate each as its own "
        "PageNet, including index-suffix replicas (e.g. base names ending "
        "in _0/_1/_2/_3 are distinct nets, not aliases of the bare base). "
        "Small-print supply rails in corners or near auxiliary functional "
        "blocks are the most commonly missed labels — read the whole image "
        "systematically, not just the visually dominant region. To assign "
        "pins to nets, trace each printed wire from the pin along the "
        "visible conductor to its terminal label, off-page connector or "
        "power symbol; do not infer net membership from spatial proximity "
        "of a pin to a nearby label.\n\n"
        "Separately, on a board-level power-distribution page — recognisable "
        "by multiple regulators (buck / LDO / load-switch ICs) feeding "
        "multiple downstream loads through ferrites, inductors, fuses and "
        "decoupling capacitors — every visible topological relationship "
        "should produce a `typed_edges` entry. Concretely, expect: each "
        "ceramic cap clustered next to a power/GND pin pair on an IC → a "
        "`decouples` edge from the cap to the parent IC; each series "
        "ferrite or inductor on a rail between source and load → a "
        "`filters` edge on that rail; each fuse or series resistor at a "
        "rail entry → a `powers` edge from source to sink along the rail; "
        "each regulator output pin (VOUT / SW post-LC / LDO output) → a "
        "`powers` edge to every load it feeds on the page. A power-tree "
        "page with 80+ components typically supports 40-80 such edges; "
        "<15 edges on such a page means the topology was not actually "
        "traced. CRITICAL anti-fabrication guard: an edge endpoint "
        "(`src` / `dst`) MUST already appear either in your `nodes` "
        "(refdes) or `nets` list — never invent an endpoint to satisfy "
        "edge completeness; if you cannot confidently identify both "
        "endpoints from the image, omit the edge."
    )
    # grounding 存在时追加：以 grounding 为拼写/存在性校验基准，
    # refdes 和网络标签应来自 grounding 集合；图像清晰但 grounding
    # 缺失的标签允许发出，但需在 ambiguities 中注明差异；
    # 追踪导线而非仅凭邻近关系猜测。
    if grounding:
        instruction += (
            " Use the grounding block as a spelling / existence check: refdes "
            "and net labels you emit SHOULD come from those sets (reject your "
            "own reading of a refdes or net if it contradicts the grounding). "
            "The grounding isn't necessarily complete on dense pages — if the "
            "image clearly shows a labelled net that's missing from the list, "
            "you may emit it AND add an entry in `ambiguities` noting the "
            "discrepancy. Trace wires from each pin to its destination label "
            "rather than guessing from adjacency alone."
        )
    # block 4（或 5）: 主分析指令文本
    user_content.append({"type": "text", "text": instruction})
    return user_content


def _system_cached() -> list[dict]:
    # Pass the system prompt as a cached content block so the burst of 12
    # page calls reuses the same 1.5k-token preamble via Anthropic's prompt
    # cache. The tool definition carries its own cache marker — together
    # they cover ~5-6k tokens of shared preamble.
    return [
        {
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        }
    ]


def build_page_vision_params(
    *,
    model: str,
    rendered: RenderedPage,
    total_pages: int,
    device_label: str | None = None,
    grounding: str | None = None,
) -> dict:
    """构建单页 vision 调用的完整 Messages-API 参数（批量路径专用）。

    镜像 `call_with_forced_tool` 在 thinking 激活时的首次尝试
    （tool_choice 为 "auto"：API 拒绝 thinking + 强制 tool；system prompt
    要求模型始终发出 tool 调用）。直接路径的重试逻辑（validation 后缀、
    thinking→forced 回退）在批量路径中没有等价物——批量失败的页面会回退
    到直接路径重试。有 parity test 守卫，会 diff 这些参数与直接路径实际
    发送的 kwargs 是否一致。
    """
    return {
        "model": model,
        "max_tokens": PAGE_MAX_TOKENS,
        "system": _system_cached(),
        "messages": [
            {
                "role": "user",
                "content": build_page_user_content(
                    rendered=rendered,
                    total_pages=total_pages,
                    device_label=device_label,
                    grounding=grounding,
                ),
            }
        ],
        "tools": [_submit_page_tool()],
        "tool_choice": {"type": "auto"},
        "thinking": dict(PAGE_THINKING_PARAM),
        "output_config": {"effort": effort_for_model(model)},
    }


def ensure_canonical_page(
    graph: SchematicPageGraph, page_number: int
) -> SchematicPageGraph:
    """Force `graph.page` to the canonical page number.

    The model occasionally fills `page` from its own prompt context; overwrite
    with the canonical value to guarantee downstream identity.
    """
    if graph.page != page_number:
        logger.info(
            "Model emitted page=%d, overriding with canonical page=%d",
            graph.page,
            page_number,
        )
        graph = graph.model_copy(update={"page": page_number})
    return graph


async def extract_page(
    *,
    client: AsyncAnthropic,
    model: str,
    rendered: RenderedPage,
    total_pages: int,
    device_label: str | None = None,
    grounding: str | None = None,
) -> SchematicPageGraph:
    """对单页原理图执行 vision 调用，返回经 Pydantic 校验的 SchematicPageGraph。

    ┌─────────────────────────────────────────────────────────────────┐
    │ 整体流程                                                        │
    ├─────────────────────────────────────────────────────────────────┤
    │ 1. 构建 system prompt（含 prompt cache 标记）                    │
    │ 2. 构建 user message（上下文 + grounding + 图片 + 分析指令）     │
    │ 3. 声明 submit_schematic_page 工具（含 JSON Schema）             │
    │ 4. 调用 call_with_forced_tool：                                 │
    │    - 首次尝试：thinking 开启 → tool_choice="auto"               │
    │    - 若模型未调 tool：关闭 thinking → tool_choice="forced"      │
    │    - 若 payload 校验失败：附加错误信息重试一次                   │
    │ 5. 校验通过后，调用 ensure_canonical_page 强制页码正确           │
    └─────────────────────────────────────────────────────────────────┘

    ┌─────────────────────────────────────────────────────────────────┐
    │ 参数说明                                                        │
    ├─────────────────────────────────────────────────────────────────┤
    │ client        — AsyncAnthropic 客户端实例                       │
    │ model         — 模型 ID（如 "claude-opus-4-8" 或 "mimo-v2.5"） │
    │ rendered      — 当前页的渲染结果（RenderedPage），包含：         │
    │                   .png_path    — PNG 文件路径                    │
    │                   .page_number — 1-based 页码                   │
    │                   .orientation — portrait/landscape              │
    │                   .is_scanned  — 是否扫描件（无文字/矢量）       │
    │ total_pages   — PDF 总页数，用于 "Page X of Y" 上下文           │
    │ device_label  — 设备名称（可选），如 "iPhone 11"                 │
    │ grounding     — PDF 提取的文字真值集（可选），用于防幻觉         │
    ├─────────────────────────────────────────────────────────────────┤
    │ 返回值                                                          │
    ├─────────────────────────────────────────────────────────────────┤
    │ SchematicPageGraph — 经 Pydantic 校验的单页原理图结构化数据，    │
    │ 包含 nodes/nets/cross_page_refs/typed_edges/designer_notes/     │
    │ ambiguities/confidence 等字段。                                  │
    ├─────────────────────────────────────────────────────────────────┤
    │ 错误处理                                                        │
    ├─────────────────────────────────────────────────────────────────┤
    │ - call_with_forced_tool 最多重试 2 次                           │
    │ - 若 2 次均失败，抛出 RuntimeError（含最后一次的错误信息）       │
    │ - 第三方模型（mimo/qwen）会提前抛出 RuntimeError（web_search    │
    │   不支持）——但 page_vision 不走 web_search，所以不受影响         │
    ├─────────────────────────────────────────────────────────────────┤
    │ thinking 行为                                                   │
    ├─────────────────────────────────────────────────────────────────┤
    │ - thinking_budget=24000 → thinking_active=True                  │
    │ - 首次尝试：tool_choice="auto"（API 要求 thinking 不能 + forced）│
    │ - 若模型只返回 thinking 未调 tool：关闭 thinking → 强制 tool    │
    │ - 第三方模型（mimo/qwen）自动跳过 thinking 参数                  │
    ├─────────────────────────────────────────────────────────────────┤
    │ 与批量路径的关系                                                │
    ├─────────────────────────────────────────────────────────────────┤
    │ - 直接路径（本函数）：每页单独调用，支持重试                     │
    │ - 批量路径（batch_vision）：所有页一起提交，失败页回退到直接路径 │
    │ - 两者共享 build_page_user_content + _submit_page_tool +        │
    │   _system_cached，确保 prompt 完全一致（parity test 守卫）       │
    └─────────────────────────────────────────────────────────────────┘
    """
    # 调用 call_with_forced_tool：发送 vision 请求，强制模型调用
    # submit_schematic_page 工具，返回经 Pydantic 校验的 SchematicPageGraph
    graph = await call_with_forced_tool(
        client=client,
        model=model,
        # system prompt（含 cache_control 标记，12 页批量调用共享缓存）
        system=_system_cached(),
        messages=[
            {
                "role": "user",
                # 构建 user message：上下文 + grounding + 图片 + 分析指令
                "content": build_page_user_content(
                    rendered=rendered,
                    total_pages=total_pages,
                    device_label=device_label,
                    grounding=grounding,
                ),
            }
        ],
        # 声明可用工具：submit_schematic_page（含 JSON Schema + cache 标记）
        tools=[_submit_page_tool()],
        # 强制模型调用此工具（thinking 开启时降级为 auto，见 tool_call.py）
        forced_tool_name=SUBMIT_PAGE_TOOL_NAME,
        # Pydantic model，用于校验 tool_use 的 input payload
        output_schema=SchematicPageGraph,
        # 最大输出 token 数（32k，覆盖密集 Apple 原理图的长输出）
        max_tokens=PAGE_MAX_TOKENS,
        # thinking budget：非 None 即开启 adaptive thinking（实际预算由
        # API 的 adaptive 模式自动管理，此值仅作为开关）
        thinking_budget=24000,
        # 日志标签，便于定位是哪一页的调用
        log_label=f"page_vision:page_{rendered.page_number}",
    )
    # 模型偶尔从自身 prompt 上下文填入错误的 page 编号，
    # 强制覆盖为渲染时的 canonical 值，保证下游 merger/编译器身份一致
    return ensure_canonical_page(graph, rendered.page_number)
