"""应用配置 — 从环境变量 / .env 加载。"""

from __future__ import annotations

from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """wrench-board 后端的运行时配置。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    anthropic_api_key: str = Field(
        default="",
        description="Anthropic API key。agent 运行时必填，测试可选。",
    )
    anthropic_model_main: str = Field(
        default="claude-opus-4-8",
        description=(
            "顶层推理模型。Pipeline 角色：Cartographe、Clinicien、"
            "Auditor。诊断 tier `deep`。"
        ),
    )
    anthropic_model_fast: str = Field(
        default="claude-haiku-4-5",
        description="保留给轻量分类 / 格式化任务。",
    )
    anthropic_model_sonnet: str = Field(
        default="claude-sonnet-4-6",
        description=(
            "中档模型。Pipeline 角色：Scout、Registry Builder、"
            "Lexicographe — 结构化抽取，无需重度综合。"
        ),
    )
    anthropic_base_url: str = Field(
        default="",
        description=(
            "自定义 Anthropic API base URL。留空则使用默认（api.anthropic.com）。"
            "用于 API 代理或自定义端点。"
        ),
    )
    diagnostic_mode: Literal["managed", "direct"] = Field(
        default="managed",
        description=(
            "诊断运行时模式。'managed' 使用 Anthropic Managed Agents（默认）；"
            "'direct' 使用普通 Messages API tool-use 循环（无需 bootstrap）。"
        ),
    )

    port: int = Field(default=8000, description="HTTP 服务端口。")
    log_level: str = Field(default="INFO", description="日志级别名称。")

    # --- CORS + WebSocket Origin 白名单 ---------------------------------------
    # 单一白名单，供 api.main 的 HTTP CORS 中间件
    # 与 api.ws_security.enforce_ws_origin 的 WebSocket Origin 检查共用。
    # CORS 中间件完全绕过 WebSocket 握手，因此在 WS handler 边缘
    # 对同一列表重新校验 Origin。
    # 默认覆盖本地工作台（:8000 同源 + Vite 开发端口）。
    # 远程访问可通过 CORS_ALLOW_ORIGINS="url1,url2,..." 覆盖。
    # "*" 在两侧均禁用强制（向后兼容开发模式）；HTTP 侧还会因
    # 通配符 + credentials 组合被浏览器拒绝而降级为宽松且无 credentials。
    cors_allow_origins: str = Field(
        default="http://localhost:8000,http://127.0.0.1:8000,http://localhost:5173,http://127.0.0.1:5173",
        description=(
            "HTTP CORS Origin 与 WebSocket Origin 头的逗号分隔白名单。"
            "使用 * 禁用强制。"
        ),
    )

    # --- Cloud 网关 service token ---------------------------------------------
    # wrenchboard-cloud 中继在 /ws/diagnostic 握手时以
    # `Authorization: Bearer <token>` 发送的共享密钥。设置后，
    # 引擎拒绝未携带该 token 的任意 WS — 部署在 cloud 后时
    # 无法直接命中引擎（websocat 引擎 URL → 绕过 cloud
    # auth + quota → 消耗 Anthropic credits）。空（默认）禁用检查，
    # 保持独立工作台可用：浏览器无法设置 Authorization 头，
    # 故直连引擎开发时 token 未设置。与上方 cors_allow_origins
    # 的默认宽松约定一致。
    engine_service_token: str = Field(
        default="",
        description=(
            "引擎运行在 wrenchboard-cloud 后时，诊断 WebSocket 上要求的"
            "共享密钥，格式为 'Authorization: Bearer <token>'。"
            "空则禁用强制（独立工作台 / 开发）。"
        ),
    )

    # --- Cloud token 用量计量（T13）--------------------------------------------
    # 引擎运行在 wrenchboard-cloud 后时，每次诊断 agent LLM
    # 调用会尽力将原始 token 用量上报到 cloud 计量端点（cloud 按租户
    # 计价并维护账单账本）。URL 与 token 必须同时设置才启用；
    # 任一未设置则上报为硬 no-op，独立工作台 / 自托管不会回传。
    # 与 engine_service_token 的默认宽松约定一致。token 与 cloud
    # 在 /internal/* 路由上校验的 ENGINE_SERVICE_TOKEN 相同（服务端到服务端）。
    cloud_metering_url: str = Field(
        default="",
        description=(
            "wrenchboard-cloud 的 base URL（如 https://app.wrenchboard.io）。"
            "与 cloud_metering_token 同时设置时，诊断 agent token 用量"
            "POST 到 {url}/internal/metering/diagnostic。空则禁用上报。"
        ),
    )
    cloud_metering_token: str = Field(
        default="",
        description=(
            "cloud 计量上报的 Bearer service token。须与 cloud 的"
            "ENGINE_SERVICE_TOKEN 一致。空则禁用上报（自托管）。"
        ),
    )

    # --- Cloud 设备注册表（T9a，「carnet」）----------------------------------
    # 与 cloud_device_registry_token 同时设置时，设备别名注册表
    # 由 cloud 的 Postgres 支撑（托管模式下的真相源），经
    # {url}/internal/device-registry/* 读写。未设置 → 引擎使用本地 JSON
    # 存储（自托管累积自己的 carnet）。与 cloud_metering 共用同一
    # service token（cloud 以 ENGINE_SERVICE_TOKEN 校验）。
    cloud_device_registry_url: str = Field(
        default="",
        description=(
            "wrenchboard-cloud 的 base URL。与 cloud_device_registry_token"
            "同时设置时，设备别名注册表读写 {url}/internal/device-registry/*。"
            "空 → 本地 JSON 存储（自托管）。"
        ),
    )
    cloud_device_registry_token: str = Field(
        default="",
        description=(
            "cloud device-registry API 的 Bearer service token。须与"
            "cloud 的 ENGINE_SERVICE_TOKEN 一致。空 → 本地 JSON 存储。"
        ),
    )

    # --- 上传加固 -------------------------------------------------------------
    # 整板 .kicad_pcb 可超过 100 MB（MNT Reform 约 25 MB，
    # 更大主板会超过 100 MB）。200 MB 留有余量，同时保护
    # /tmp 与 RAM 免受 POST /api/board/parse 恶意超大上传。
    board_upload_max_bytes: int = Field(
        default=200 * 1024 * 1024,
        ge=1,
        description=(
            "POST /api/board/parse 上传的最大接受字节数。"
            "超过此上限的请求在解析前以 413 拒绝。"
        ),
    )
    pipeline_schematic_max_pages: int = Field(
        default=200,
        ge=1,
        description=(
            "原理图 PDF 页数的硬上限。约束 pdfplumber 解码"
            "与逐页 vision 成本；亦是防御纵深，应对仅靠 50 MiB"
            "上传上限不足以抵御的解压炸弹 PDF。iPhone 与笔记本级"
            "原理图很少超过 30–50 页。"
        ),
    )

    pipeline_vision_batch: bool = Field(
        default=False,
        description=(
            "运维标志：逐页原理图 vision 经 Anthropic Message Batches API"
            "而非直接流式调用。同模型、同 prompt、同输出 — token 价格 50% —"
            "换取异步完成（通常 <1h，API 硬上限 24h）。"
            "面向离线目录预构建，非租户可见、有人盯时间线的构建。"
            "batch 内失败的页（错误条目、无效 payload）回退到带完整"
            "重试机制的直接路径，按全价计费。Env: PIPELINE_VISION_BATCH。"
        ),
    )
    pipeline_vision_batch_poll_seconds: float = Field(
        default=30.0,
        ge=0.0,
        le=600.0,
        description=(
            "等待 vision batch 达到 processing_status=ended 时的轮询间隔。"
            "batch 通常在数分钟到一小时内完成；30s 保持日志可读且不过度"
            "轰炸 API。"
        ),
    )
    pipeline_vision_batch_timeout_seconds: float = Field(
        default=86400.0,
        ge=0.0,
        description=(
            "batch 等待的硬截止。默认为 API 自身的 24h 处理上限；"
            "超时时取消远程 batch 且摄取失败（重跑可复用已完成页的"
            "逐页缓存）。"
        ),
    )
    pipeline_vision_batch_max_bytes: int = Field(
        default=180_000_000,
        ge=1_000_000,
        description=(
            "用于将页请求分块到多个 batch 的每 batch payload 预算。"
            "API 单 batch 上限 256 MB；200 dpi 下 92 页密集 Mac 原理图的"
            "base64 PNG 可能超限，故留出 prompt 文本 + JSON 信封开销的余量。"
        ),
    )

    pipeline_max_concurrent_builds: int = Field(
        default=2,
        ge=0,
        description=(
            "并发 schematic→graph pipeline 构建的硬上限 — 每条路径耗 RAM 与"
            "成本均高（数百 MB + LLM token）。满载时新构建派发返回 HTTP 503"
            "（背压）而非继续堆积，避免多设备同时构建 OOM 共享主机。"
            "同一 slug 的第二次请求仍搭车进行中的构建（stampede dedup，"
            "不计两次）。0 = 不限（性能足够的自托管可关闭）。"
            "Env: PIPELINE_MAX_CONCURRENT_BUILDS。"
        ),
    )

    # --- Pipeline V2 设置 -----------------------------------------------------
    memory_root: str = Field(
        default="memory",
        description="各设备 knowledge pack 写入的根目录。",
    )
    pipeline_max_revise_rounds: int = Field(
        default=3,
        ge=0,
        le=4,
        description=(
            "接受带残留问题的 pack 前，audit→revise→re-audit 的最大轮数。"
            "历史：92 页 Mac 在 1 轮时因可修复 drift 失败（1→2）；"
            "随后两部 iPhone 构建（symptom/测试点节点更密）从 0.45→0.66→0.74"
            "收敛，但第 2 轮后仍有一个残留 orphan 节点 → 整个 0.74 pack"
            "被 REJECTED（需再多一轮去掉 orphan）。默认 3 给密集 pack"
            "留余地；reviser 每轮解决大部分项，额外一轮是廉价保险，"
            "避免一个 stray 节点丢掉接近合格的 pack。顽固 pack 可通过"
            "PIPELINE_MAX_REVISE_ROUNDS 提到 4。"
        ),
    )
    pipeline_accept_score: float = Field(
        default=0.70,
        ge=0.0,
        le=1.0,
        description=(
            "Phase 4 接受下限：revise 轮耗尽（或分数回归提前停止）时，"
            "若确定性 drift 为空且 consistency_score >= 此值，则接受最佳快照"
            "（最高分轮的 artefact）并带警告，而非构建失败。0 禁用（旧版硬失败）。"
        ),
    )
    pipeline_graph_query_turns_auditor: int = Field(
        default=8,
        ge=0,
        le=32,
        description=(
            "Auditor 每轮 audit 在提交 verdict 前，经 query_graph 工具"
            "对照已编译原理图校验标识符的最大轮数。0 = 无 graph 查询"
            "（auditor 仍获得确定性 ground-truth 报告）。"
        ),
    )
    pipeline_graph_query_turns_reviser: int = Field(
        default=16,
        ge=0,
        le=32,
        description=(
            "各 writer reviser 对照已编译原理图 grounding 修订时，"
            "query_graph 工具的最大轮数。历史：4 对密集 pack 过低 —"
            "177 页 knowledge_graph（iPhone 12 Pro Max）每轮重复标记同一"
            "虚构，reviser 预算全花在验证 rail/refdes 上，未能提交正确"
            "patch，从未收敛（0.55 时 REJECTED）。提到 16 后 reviser 可"
            "ground 修订并首轮 APPROVED。可超过 auditor 预算：auditor 判"
            "一轮，reviser 改写大文件可能需要多次查找。0 = 无 graph 查询。"
        ),
    )
    pipeline_cache_warmup_seconds: float = Field(
        default=3.0,
        ge=0.0,
        le=10.0,
        description=(
            "派发 writer 1（Cartographe）与 writers 2+3（Clinicien + Lexicographe）"
            "之间的等待秒数，让 Anthropic 在并行读者到达前物化 ephemeral cache。"
            "观测到 cache 物化需 2–3s；1.0s 过激进导致 cache miss 与后续"
            "token 重写。"
        ),
    )
    pipeline_vision_concurrency: int = Field(
        default=12,
        ge=1,
        le=128,
        description=(
            "原理图摄取期间逐页 vision 调用的最大并发。大原理图的瓶颈是"
            "OTPM（tier-4 上 Opus 为 800K/min）— 密集页每页可输出数万"
            "output token，约 12–16 并发可饱和该预算且少打 429。一次性"
            "打满所有页不会更快（OTPM 无论如何封顶吞吐），还会牺牲"
            "共享前缀 cache。页较轻时可提到 16。"
        ),
    )
    pipeline_scout_min_symptoms: int = Field(
        default=3,
        ge=0,
        description="Scout dump 必须包含的最少不同 **Symptom:** 块数。",
    )
    pipeline_scout_min_components: int = Field(
        default=3,
        ge=0,
        description=(
            "Scout dump 中引用的最少不同元件数（所有 symptom 块与"
            "components 段中 canonical 名与 refdes 去重之和）。"
        ),
    )
    pipeline_scout_min_sources: int = Field(
        default=3,
        ge=0,
        description="Scout dump 中引用的最少不同来源 URL 数。",
    )
    pipeline_scout_max_retries: int = Field(
        default=1,
        ge=0,
        le=3,
        description=(
            "首次 dump 低于 pipeline_scout_min_* 阈值时的额外 Scout 尝试次数。"
            "每次重试扩大搜索范围。"
        ),
    )

    # --- Managed Agents memory stores -----------------------------------------
    # 标志开启（默认）时，pipeline 输出预写入各设备 store，诊断 session
    # 写回 findings。在 .env 设为 False 可完全绕过 memory_stores
    #（如离线开发或 workspace 失去访问）。各调用点无论如何都会优雅降级。
    ma_memory_store_enabled: bool = Field(
        default=True,
        description=(
            "Anthropic Managed Agents memory_stores 集成的开关。"
            "设为 False 禁用（离线开发、受限 workspace）。"
        ),
    )
    chat_history_backend: Literal["jsonl", "managed_agents"] = Field(
        default="jsonl",
        description=(
            "诊断聊天记录存放位置。'jsonl' 在 memory/{slug}/repairs/{id}/"
            "messages.jsonl 下每事件一行。'managed_agents' 将回放交给原生 MA session。"
        ),
    )

    # --- Anthropic client 韧性 ------------------------------------------------
    # SDK 默认 max_retries（2）在冒泡前约容忍 6s 退避。真实过载可持续
    # 30s–2min；5 次重试约 62s 指数退避（2+4+8+16+32s）后才传播错误。
    # 需要时可通过 .env 的 ANTHROPIC_MAX_RETRIES 覆盖。
    anthropic_max_retries: int = Field(
        default=5,
        ge=0,
        description=(
            "Anthropic SDK 对瞬时 5xx / 529 过载响应的重试次数。"
            "从 SDK 默认 2 提高，以撑过短过载窗口。"
        ),
    )

    # --- Managed Agents 流 watchdog -------------------------------------------
    # `client.beta.sessions.events.stream(...)` 上的无活动超时。若 Anthropic
    # SSE 停滞且未关闭 TCP（默认 TCP keepalive 约 9 min），async 迭代器
    # 可无限阻塞。watchdog 超时流并发出 `stream_timeout` WS 事件，让前端
    # 显示「session 丢失 — 请重连」而非无限转圈。600 s（10 min）宽裕：
    # Opus + adaptive thinking 在复杂轮次首个事件前可花 1–2 min。
    ma_stream_event_timeout_seconds: float = Field(
        default=600.0,
        gt=0,
        description=(
            "MA SSE 事件流上的单事件无活动超时。"
            "此窗口内无事件则干净关闭流并向前端发送 stream_timeout WS 事件。"
        ),
    )

    # MA SSE 事件流的无损重连预算。流无服务端回放，故掉线（watchdog 超时、
    # 传输重置、或流结束无终端事件）通过重新列出 session 历史再 tail 恢复
    # — 连续最多此数次，之后放弃并 surfaced `stream_error: reconnect_exhausted`。
    # 干净运行不会触及；每送达一个事件计数器归零。
    ma_stream_max_reconnects: int = Field(
        default=4,
        ge=0,
        description=(
            "可恢复掉线后 MA SSE 事件流的最大连续恢复重连次数，"
            "耗尽后放弃 session。"
        ),
    )

    # --- Managed Agents 拆卸 / 异步安全 ---------------------------------------
    # WS 关闭时取消 recv/emit forwarder 对并短暂等待各 task  unwind，
    # 避免拆卸 emitter 与进行中的写入竞态。按 task 预算（相对全局 gather）
    # 防止一个慢 task 饿死另一个；超限时 warning 按 task 名映射 recv vs emit。
    # 仅当某 forwarder  routinely 溢出默认且噪音成为事后分析隐患时覆盖。
    ma_forwarder_unwind_timeout_seconds: float = Field(
        default=2.0,
        gt=0,
        description=(
            "session 拆卸时，已取消的 MA WS forwarder（recv 或 emit）"
            "干净 unwind 所授予的 per-task 预算。"
        ),
    )
    # Mirror task（MA 事件的 jsonl 持久化）与 live stream 并行 best-effort
    # 生成。WS 关闭时 drain pending 集，避免快断开取消 mirror 中途写入。
    # 5 s 覆盖繁忙 transcript flush；负载下 mirror 超时可提高。
    ma_session_drain_timeout_seconds: float = Field(
        default=5.0,
        gt=0,
        description=(
            "session 拆卸时等待 pending MA mirror task（transcript 持久化）"
            "drain 的最长时间。"
        ),
    )

    # --- Managed Agents 子 agent 咨询 -----------------------------------------
    # MA runtime 可按需生成临时子 agent：tier 范围的 consultant（另一 tier
    # 上的一次性 Q&A）与 bootstrap 的 KnowledgeCurator（聚焦 web 研究）。
    # 各跑在独立 MA session，用 wait_for 限定，避免停滞 SSE 永久阻塞父轮次。
    # 默认按父轮 Opus 规模（consultant ≈ 2 min，curator ≈ 3 min 含 web_search 往返）。
    ma_subagent_consultation_timeout_seconds: float = Field(
        default=120.0,
        gt=0,
        description=(
            "单次 MA 子 agent 咨询（tier 范围 Q&A）在放弃 consume 循环前的"
            "最大墙钟时间。"
        ),
    )
    ma_curator_timeout_seconds: float = Field(
        default=180.0,
        gt=0,
        description=(
            "单次 KnowledgeCurator MA 运行（定向 web 研究）在放弃 consume"
            "循环前的最大墙钟时间。"
        ),
    )

    # --- Managed Agents 相机 / 捕获流程 ---------------------------------------
    # Flow B（相机捕获）：agent 经 WS 向前端发 capture_request 并等待
    # macro 帧。技师未选相机或浏览器卡住时超时，返回 is_error
    # custom_tool_result 供 agent 恢复。与 `_dispatch_cam_capture` 超时
    # 错误文案的默认一致。
    ma_camera_capture_timeout_seconds: float = Field(
        default=30.0,
        gt=0,
        description=(
            "后端推送 server.capture_request 后，等待前端返回捕获帧的"
            "最长时间。"
        ),
    )

    # --- Managed Agents 协议确认 ----------------------------------------------
    # `bv_propose_protocol` 在协议落盘并推送到 UI 面板前，须技师显式
    # 接受/拒绝。runtime 发出 `protocol_pending_confirmation`，在 Future 上
    # 等待，并限定等待，避免技师离开或关标签后 MA session 永久卡在
    # `requires_action` — 超时路径发 is_error custom_tool_result 供 agent 恢复。
    ma_protocol_confirmation_timeout_seconds: float = Field(
        default=300.0,
        gt=0,
        description=(
            "等待技师接受或拒绝经 bv_propose_protocol 提议的协议的最长时间。"
        ),
    )

    # --- Managed Agents memory_stores HTTP 回退 -------------------------------
    # 原始 HTTP 回退路径（SDK 未暴露 `client.beta.memory_stores` 时使用）。
    # Anthropic memory_stores REST 端点正常路径响应快；超时用于限定网络
    # 停滞，使诊断 session 可降级为「无 memory」而非阻塞 WS 握手。
    # API 前有慢代理时可覆盖。
    ma_memory_store_http_timeout_seconds: float = Field(
        default=30.0,
        gt=0,
        description=(
            "原始 memory_stores REST 回退（create / get / list / delete）的"
            "per-request HTTP 超时。仅在 SDK 表面不可用时使用。"
        ),
    )


_settings: Settings | None = None


def get_settings() -> Settings:
    """返回进程级缓存的 Settings 实例。"""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
