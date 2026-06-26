"""Pipeline HTTP/WS 层的 Pydantic DTO — 请求/响应形状。"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from api.pipeline.schemas import _DeviceKind
from api.pipeline.schematic.simulator import Failure, RailOverride

# --- 生成 -------------------------------------------------------------------


class GenerateRequest(BaseModel):
    device_label: str = Field(
        min_length=2,
        max_length=200,
        description="人类可读设备标识（如「MNT Reform motherboard」）。",
    )


# --- 仿真 -------------------------------------------------------------------


class SimulateRequest(BaseModel):
    killed_refdes: list[str] = Field(default_factory=list)
    failures: list[Failure] = Field(default_factory=list)
    rail_overrides: list[RailOverride] = Field(default_factory=list)


# --- 原理图摄取 -------------------------------------------------------------


class IngestSchematicRequest(BaseModel):
    device_slug: str = Field(
        min_length=1,
        max_length=120,
        description="设备 canonical slug — 无路径分隔符，小写 kebab-case。",
    )
    pdf_path: str = Field(
        min_length=1,
        description=(
            "原理图 PDF 的文件系统路径。可为绝对路径或相对服务器工作目录。"
            "必须存在且后缀为 .pdf。"
        ),
    )
    device_label: str | None = Field(
        default=None,
        description="可选的人类可读标签，传入 vision prompt。",
    )


class IngestSchematicResponse(BaseModel):
    device_slug: str
    pdf_path: str
    started: bool


# --- Pack 发现 --------------------------------------------------------------


class PackSummary(BaseModel):
    device_slug: str
    disk_path: str
    has_raw_dump: bool
    has_registry: bool
    has_knowledge_graph: bool
    has_rules: bool
    has_dictionary: bool
    has_audit_verdict: bool
    # 技师可能已提供的输入。驱动数据感知的 repair 仪表盘（卡片根据这些标志
    # 在「已导入」与「待导入」之间显式切换）。
    has_boardview: bool
    boardview_format: str | None
    has_schematic_pdf: bool
    has_electrical_graph: bool
    # 原理图摄取结束时构建 — 标记 `stock_search` 能否将该设备元件与 donor 库存匹配。
    has_parts_index: bool
    # 构建状态标记（api/pipeline/build_state.py）："building" | "complete" |
    # "failed" | "paused"，或 None 表示无标记的旧版 pack（仅凭文件存在判断完整性）。
    # 使托管前端/UI 可显示 per-repair「analyse en cours / prête」徽章，无需重新推导完整性。
    build_state: str | None = None


# --- 分类树 -----------------------------------------------------------------


class TaxonomyPackEntry(BaseModel):
    device_slug: str
    device_label: str
    version: str | None
    form_factor: str | None
    complete: bool
    # 新建 repair 搜索的就绪信号：graph 已就绪（原理图已摄取）及解析出的 device class。
    # 让技师看到已有设备无需再上传原理图。
    has_electrical_graph: bool = False
    # 存在 parts index = 该设备元件可搜索/可收割。
    # Stock「添加 donor」选择器用此信号标记设备「就绪」vs「等待 graph」
    # （pack 可存在但尚无 parts_index）。
    has_parts_index: bool = False
    device_kind: str | None = None
    # T9a：该设备 carnet 中的全部别名（board# / Apple model / EMC /
    # codename / marketing），使新建 repair 自动补全可匹配任一别名，而非仅 label。
    # 设备尚无 registry fiche 时为空。
    aliases: list[str] = Field(default_factory=list)


class TaxonomyTree(BaseModel):
    """按 brand > model > version 分组的 pack，并为缺少 brand 或 model 的
    registry 提供 fallback 桶（硬规则 #4 = null 而非臆造）。
    """

    brands: dict[str, dict[str, list[TaxonomyPackEntry]]] = Field(default_factory=dict)
    uncategorized: list[TaxonomyPackEntry] = Field(default_factory=list)


# --- Repair 工单 ------------------------------------------------------------


class RepairRequest(BaseModel):
    device_label: str = Field(
        min_length=2,
        max_length=200,
        description="人类可读设备标识（如「MNT Reform motherboard」）。",
    )
    device_slug: str | None = Field(
        default=None,
        description=(
            "磁盘上已有 pack 的 canonical slug。提供时后端直接使用，"
            "而非对 device_label 做 slugify — 避免 Registry Builder 重写 label 后、"
            "pack 目录已按初始 slug 命名时的漂移。"
        ),
    )
    symptom: str = Field(
        min_length=5,
        max_length=2000,
        description="客户观察到的现象的自由文本描述。",
    )
    raw_dump: str | None = Field(
        default=None,
        description=(
            "可选的第三方 Scout Markdown dump。提供时作为 Phase 1 的权威输入，"
            "直接跳过 Claude Scout。必须是非空白字符串。"
        ),
    )
    device_kind: _DeviceKind | None = Field(
        default=None,
        description="技师声明的设备类别（先验）。由 graph 分类器校验/覆盖。"
        "为 device_kind 枚举值之一或 null。",
    )
    force_rebuild: bool = Field(
        default=False,
        description=(
            "为 true 时，即使磁盘上 pack 已完整也运行 pipeline。"
            "各阶段写出时会覆盖已有文件。慎用 — 重建消耗 token。"
        ),
    )
    owner_ref: str | None = Field(
        default=None,
        description=(
            "多租户前端（wrench-board-cloud 传入 tenant id）提供的 opaque owner 引用。"
            "设置时 repair 复用去重限定在同一 owner_ref，"
            "使两个 owner 诊断同一 (device, symptom) 时得到独立 repair — "
            "私有对话/测量互不碰撞。引擎将其视为 opaque 标签，非安全边界（前端是守门人）；"
            "自托管未设置时所有 repair 共享同一 owner。"
        ),
    )
    allow_expand: bool = Field(
        default=True,
        description=(
            "多租户前端的 capability 标志：为 False 时，complete pack + 未覆盖 symptom "
            "的请求不得触发 targeted expand 轮（属 LLM 开销）— 引擎返回 expand_blocked=True、"
            "删除刚持久化的 ticket，前端映射到 paywall。"
            "套餐策略在前端；引擎仅遵守该标志（同 owner_ref，非安全边界）。"
            "默认 True = 自托管行为不变。"
        ),
    )


class DisambiguationCandidate(BaseModel):
    """自由文本设备 label 歧义时（T9a）的一个候选板：术语展开到同族多个兄弟板，
    技师须择一。"""

    device_slug: str
    family: str | None = None
    facets: dict[str, list[str]] = Field(default_factory=dict)


class ResolveDeviceRequest(BaseModel):
    """将自由设备 label 解析为 canonical 身份，不创建 repair、不启动构建（T9a）。
    cloud 在 quota 门控前调用，以便采用 canonical slug 并免费展示歧义。"""

    device_label: str = Field(min_length=1, max_length=200)
    device_slug: str | None = Field(
        default=None, description="已 pin 时原样返回 — 不做解析。"
    )


class ResolveDeviceResponse(BaseModel):
    canonical_slug: str
    ambiguous: bool = False
    candidates: list[DisambiguationCandidate] = Field(default_factory=list)


class RepairResponse(BaseModel):
    """`POST /pipeline/repairs` 的 HTTP JSON 响应体（Pydantic 模型，非函数）。

    create_repair（repairs.py）在各分支 return RepairResponse(...) 后立即结束 HTTP 连接；
    本模型**不**推送构建进度、**不**建立 WebSocket — 只告诉前端下一步做什么。

    【前端消费入口】
      web/js/features/global/landing/index.js  _launchDiagnostic() → res.json()
      web/js/pipeline_progress.js              openPipelineProgress(repairResponse)

    【与 progress WS 的关系】
      pipeline_started=true  → 前端用 device_slug 连 WS /pipeline/progress/{slug}
      pipeline_started=false → 直接 goToWorkspace(repair_id, slug)，不订阅 progress WS
      device_slug 是 HTTP 响应与 progress WS 之间的唯一 join key（无 ws_url / session_id）

    【create_repair 常见返回组合 — 见 repairs.py Branch 0–3】
      Branch 1 新构建/排队/搭车：pipeline_started=true, pipeline_kind="full"
      Branch 2 症状已覆盖：     pipeline_started=false, matched_rule_id=...
      Branch 3 症状未覆盖：     pipeline_started=false, coverage_reason=...
      Branch 0 复用工单：       pipeline_started=false, pipeline_kind="none"
      设备歧义：               needs_disambiguation=true, repair_id="", candidates=[...]
    """

    # ── 核心标识（几乎每次 return 都会填）────────────────────────────────────
    repair_id: str  # 工单级 UUID；memory/{slug}/repairs/{repair_id}.json
    device_slug: str  # 设备 canonical ID（slug）；pack 目录 + progress/diagnostic WS 路径参数
    device_label: str  # 用户输入的显示名，UI 展示用

    # ── 构建决策：前端是否订阅 progress WebSocket ─────────────────────────────
    pipeline_started: bool = Field(
        description=(
            "True = 后台正在/即将构建 pack，前端应 subscribeToProgress(device_slug)。"
            "False = pack 已可用或无需构建，直接进诊断工作区。"
        ),
    )
    pipeline_kind: Literal["full", "expand", "none"] = Field(
        default="none",
        description=(
            "后端决定的 LLM 工作类型："
            "'full' = 完整 pipeline（Scout→Registry→Writers→Audit）；"
            "'none' = create_repair 未启动构建（Branch 0/2/3）；"
            "'expand' = 历史字段，当前 create_repair 基本不再自动触发 expand。"
        ),
    )

    # ── 症状覆盖（Branch 2：pack 完整且 rules.json 已覆盖当前 symptom）────────
    matched_rule_id: str | None = Field(
        default=None,
        description=(
            "coverage 分类器命中的 rule id；前端可展示「已知诊断流程」。"
            "仅 Branch 2 且 confidence≥0.7 时有值。"
        ),
    )
    coverage_reason: str | None = Field(
        default=None,
        description="覆盖度分类器的一句解释（已覆盖 / 未覆盖 / 复用工单原因等）。",
    )

    # ── 构建排队（Branch 1 子路径 ②③：并发 build 达 cap）────────────────────
    queued: bool = Field(
        default=False,
        description=(
            "True = build 已接受但在 FIFO 队列等槽位，尚未 create_task。"
            "前端仍 pipeline_started=true，显示排队 UI，收 type:queued 事件。"
        ),
    )
    queue_position: int | None = Field(
        default=None,
        description=(
            "queued=true 时在全局 build 队列中的 1-based 位置（1=下一个跑）。"
            "queued=false 时为 null。"
        ),
    )

    # ── Cloud 套餐门控（自托管通常 false）────────────────────────────────────
    expand_blocked: bool = Field(
        default=False,
        description=(
            "pack 完整、症状未覆盖、但 allow_expand=false 时：不 expand，"
            "repair 可能未保留（repair_id 空），前端映射到 paywall。"
        ),
    )

    # ── 设备歧义（T9a：未创建 repair，未启动 pipeline）──────────────────────
    needs_disambiguation: bool = Field(
        default=False,
        description=(
            "设备名模糊匹配多块板；repair_id 通常为空，用户从 candidates 选一个"
            "后带 device_slug 重新提交。"
        ),
    )
    candidates: list[DisambiguationCandidate] = Field(
        default_factory=list,
        description="needs_disambiguation=true 时的候选设备列表。",
    )


class RepairSummary(BaseModel):
    repair_id: str
    device_slug: str
    device_label: str
    symptom: str
    status: str
    created_at: str
    board_number: str | None = Field(
        default=None,
        description="创建 repair 时提供的板修订号（如 820-02016）。",
    )
    build_state: str | None = Field(
        default=None,
        description=(
            "该 repair 所属设备的知识 pack 构建状态，镜像自 pack 的 `_build_state.json` 标记："
            "'building' | 'complete' | 'failed' | 'paused'。"
            "无标记时为 None（旧版/自托管构建前无标记）— 视为就绪。"
            "驱动首页库 tile 徽章与 landing 加载时的 live-timeline 恢复。"
        ),
    )


# --- Pack 扩展 --------------------------------------------------------------


class ExpandRequest(BaseModel):
    focus_symptoms: list[str] = Field(
        min_length=1,
        description="技师要追查的症状短语 — 任意语言、任意大小写。",
    )
    focus_refdes: list[str] = Field(
        default_factory=list,
        description="可选：专门探测的 refdes（如音频 codec 的 U3101）。",
    )


# --- 文档上传 ---------------------------------------------------------------


class DocumentUploadResponse(BaseModel):
    device_slug: str
    kind: str
    stored_path: str
    filename: str
    size_bytes: int


# --- 源文件 -----------------------------------------------------------------


class SourceVersion(BaseModel):
    filename: str
    timestamp: str
    original_name: str
    size_bytes: int
    is_active: bool


class SourceKindEntry(BaseModel):
    kind: str
    active: str | None
    versions: list[SourceVersion]


class SourcesResponse(BaseModel):
    device_slug: str
    schematic_pdf: SourceKindEntry
    boardview: SourceKindEntry


class SwitchSourceRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)


class SwitchSourceResponse(BaseModel):
    device_slug: str
    kind: str
    active: str
    status: Literal["pinned", "cached", "rebuilding"]
    detail: str
    # 仅 status="rebuilding" 时填充 — 启发式 ETA，使 UI 可显示倒计时而无需轮询 progress 事件。
    eta_seconds: int | None = None
    page_count: int | None = None


class DeleteSourceResponse(BaseModel):
    device_slug: str
    kind: str
    deleted_filename: str
    # 删除后的 pin — 该 kind 无剩余版本时为 None。
    new_active: str | None
    # `deleted` = 删除非活跃版本，pin 不变。
    # `switched_cached` = 删除活跃版本，从缓存恢复新 pin。
    # `switched_rebuilding` = 删除活跃版本，新 pin 排队重新摄取。
    # `cleared` = 删除活跃版本且无剩余版本。
    status: Literal["deleted", "switched_cached", "switched_rebuilding", "cleared"]
    detail: str
    eta_seconds: int | None = None
    page_count: int | None = None


# --- 反向诊断 ---------------------------------------------------------------


class HypothesizeRequest(BaseModel):
    state_comps: dict[str, str] = Field(default_factory=dict)
    state_rails: dict[str, str] = Field(default_factory=dict)
    metrics_comps: dict[str, dict] = Field(default_factory=dict)
    metrics_rails: dict[str, dict] = Field(default_factory=dict)
    max_results: int = Field(default=5, ge=1, le=20)
    repair_id: str | None = None


# --- 测量记录 ---------------------------------------------------------------


class MeasurementCreate(BaseModel):
    target: str
    value: float
    unit: str
    nominal: float | None = None
    note: str | None = None
