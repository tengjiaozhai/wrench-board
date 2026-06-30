"""Pipeline 编排器 - 完整的 Phase 1 -> 2 -> 3 -> 4 链(含修订循环).

+-----------------------------------------------------------------+
| Pipeline 阶段                                                    |
+-----------------------------------------------------------------+
| Phase 1.5 - 设备类别分类 + 确认门控                              |
| Phase 1   - Scout(网络调研)                                    |
| Phase 2   - Registry Builder(注册表构建)                       |
| Phase 2.5 - Mapper(功能->位号映射)                              |
| Phase 2.6 - 从电气图丰富注册表                                   |
| Phase 2.7 - 删除网络注册表虚构                                   |
| Phase 3   - Writers(并行生成 knowledge_graph/rules/dictionary) |
| Phase 4   - Auditor(审计)                                      |
| 修订循环   - NEEDS_REVISION 时重跑 Writers,最多 N 轮           |
+-----------------------------------------------------------------+
| 持久化产物(写入 memory/{device_slug}/)                         |
+-----------------------------------------------------------------+
| raw_research_dump.md   - Scout 原始调研报告                      |
| registry.json          - 注册表(词汇表 + 设备分类)             |
| knowledge_graph.json   - 知识图谱                                |
| rules.json             - 诊断规则                                |
| dictionary.json        - 术语字典                                |
| audit_verdict.json     - 审计结论                                |
| token_stats.json       - token 用量统计                          |
| pack_quality.json      - 包质量报告                              |
+-----------------------------------------------------------------+
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic

from api.agent.memory_seed import seed_memory_store_from_pack
from api.config import get_settings
from api.pipeline import build_state, device_kind
from api.pipeline.auditor import run_auditor
from api.pipeline.build_metering import report_build_phases
from api.pipeline.device_kind import KindResolution
from api.pipeline.device_registry import get_device_registry_store, register_from_registry
from api.pipeline.drift import compute_drift
from api.pipeline.graph_truth import (
    GraphTruth,
    build_ground_truth_report,
    enrich_registry_from_graph,
    extract_mentions,
)
from api.pipeline.mapper import run_mapper
from api.pipeline.pack_lint import LintFinding, lint_pack
from api.pipeline.qa import graph_coverage
from api.pipeline.reconcile import (
    find_registry_fictions,
    load_seen_refdes,
    prune_contradicted_edges,
    prune_orphan_nodes,
)
from api.pipeline.registry import run_registry_builder
from api.pipeline.schemas import (
    AuditVerdict,
    Dictionary,
    KnowledgeGraph,
    PipelineResult,
    RefdesMappings,
    Registry,
    RulesSet,
)
from api.pipeline.schematic.schemas import ElectricalGraph
from api.pipeline.scout import run_scout
from api.pipeline.telemetry.token_stats import PhaseTokenStats, write_token_stats
from api.pipeline.tool_call import _needs_third_party_forced_tool_compat
from api.pipeline.writers import run_single_writer_revision, run_writers_parallel

logger = logging.getLogger("wrench_board.pipeline.orchestrator")


# -- 原理图等待配置 --
# 当调用者通过 /packs/{slug}/documents 端点(非 repair-create body)信号
# 原理图正在带外摄取时,pipeline 等待 electrical_graph.json 落盘的最长时间.
# 超时后降级为盲运行(pack 仍构建,graph 后续到达).
_SCHEMATIC_WAIT_TIMEOUT_S = 300.0  # 最长等待 5 分钟
_SCHEMATIC_WAIT_POLL_S = 2.0  # 每 2 秒轮询一次

# -- 上传文件类型 --
# orchestrator 识别的上传类型.文件名格式:`{ISO-timestamp}-{kind}-{original-filename}`.
# 不匹配此模式的文件归入 `other`,不注入 prompt.
_UPLOAD_KINDS = {"schematic_pdf", "boardview", "datasheet", "notes", "other"}
_UPLOAD_NAME_RE = re.compile(r"^(?P<ts>[^-]+(?:-[^-]+)*?)-(?P<kind>[a-z_]+)-(?P<filename>.+)$")


@dataclass(frozen=True)
class UploadedDocuments:
    """技师上传文件分组(memory/{slug}/uploads/).

    schematic 和 boardview 槽位按时间戳取最新;datasheets,notes 和 other 累积.
    """

    schematic_pdf: Path | None = None
    boardview: Path | None = None
    datasheets: list[Path] = field(default_factory=list)
    notes: list[Path] = field(default_factory=list)
    other: list[Path] = field(default_factory=list)

    def is_empty(self) -> bool:
        return (
            self.schematic_pdf is None
            and self.boardview is None
            and not self.datasheets
            and not self.notes
            and not self.other
        )


def scan_uploads(uploads_dir: Path) -> UploadedDocuments:
    """扫描 uploads 目录并按类型分组文件.

    空目录或不存在的目录返回空的 UploadedDocuments.
    不匹配 `{ts}-{kind}-{name}` 模式的文件归入 `other`,
    确保技师手动放置的文件不会被静默丢失.
    """
    if not uploads_dir.exists() or not uploads_dir.is_dir():
        return UploadedDocuments()

    schematic_pdf: Path | None = None
    schematic_pdf_ts: str | None = None
    boardview: Path | None = None
    boardview_ts: str | None = None
    datasheets: list[Path] = []
    notes: list[Path] = []
    other: list[Path] = []

    for path in sorted(uploads_dir.iterdir()):
        if not path.is_file():
            continue
        match = _UPLOAD_NAME_RE.match(path.name)
        if match is None or match.group("kind") not in _UPLOAD_KINDS:
            other.append(path)
            continue
        kind = match.group("kind")
        ts = match.group("ts")
        # schematic 和 boardview 按时间戳取最新
        if kind == "schematic_pdf":
            if schematic_pdf_ts is None or ts > schematic_pdf_ts:
                schematic_pdf = path
                schematic_pdf_ts = ts
        elif kind == "boardview":
            if boardview_ts is None or ts > boardview_ts:
                boardview = path
                boardview_ts = ts
        elif kind == "datasheet":
            datasheets.append(path)
        elif kind == "notes":
            notes.append(path)
        else:  # "other"
            other.append(path)

    return UploadedDocuments(
        schematic_pdf=schematic_pdf,
        boardview=boardview,
        datasheets=datasheets,
        notes=notes,
        other=other,
    )


def _stage_if_private(
    memory_root: Path,
    pack_dir: Path,
    slug: str,
    owner_ref: str | None,
    coverage_verdict: str | None = None,
) -> bool:
    """构建完成后决定 SHARED vs 每租户 PRIVATE.

    +-----------------------------------------------------------------+
    | PRIVATE 条件(迁移到 `_staged/{owner_ref}/`)                   |
    +-----------------------------------------------------------------+
    | 1. web-only(无 electrical_graph.json = 无原理图)              |
    | 2. graph↔boardview QA 门控返回 FAIL(不完整的源 PDF)          |
    +-----------------------------------------------------------------+
    | SHARED 条件                                                     |
    +-----------------------------------------------------------------+
    | - 原理图构建且 PASS/WARN                                       |
    | - self-host(owner_ref 为 None)                               |
    +-----------------------------------------------------------------+
    | 返回值                                                          |
    +-----------------------------------------------------------------+
    | True  - pack 已私有化(调用方跳过共享 MA 设备存储 seed)       |
    | False - pack 保持共享                                          |
    +-----------------------------------------------------------------+
    """
    if owner_ref is None:
        return False  # self-host: always shared, byte-identical legacy behaviour
    web_only = not (pack_dir / "electrical_graph.json").exists()
    coverage_failed = coverage_verdict == "FAIL"
    if not (web_only or coverage_failed):
        return False
    from api.pipeline.pack_migrate import stage_web_only_pack

    stage_web_only_pack(memory_root, slug, owner_ref=owner_ref)
    logger.info(
        "[Pipeline] managed build for slug=%r staged PRIVATE to owner=%s "
        "(reason=%s, commons untouched)",
        slug,
        owner_ref,
        "web_only" if web_only else "coverage_fail",
    )
    return True


def _load_existing_electrical_graph(pack_dir: Path) -> ElectricalGraph | None:
    """加载已存在的 electrical_graph.json (如果存在且可解析). 否则返回 None."""
    path = pack_dir / "electrical_graph.json"
    if not path.exists():
        return None
    try:
        return ElectricalGraph.model_validate_json(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 损坏的产物不能中断 pipeline
        logger.exception(
            "[Pipeline] electrical_graph.json at %s is malformed; "
            "continuing without graph for Scout/Registry",
            path,
        )
        return None


def _canonical_raw_dump_path(pack_dir: Path) -> Path:
    """返回新写入的 Phase 1 raw dump 的权威路径."""
    return pack_dir / "raw_research_dump.md"


def _generate_third_party_stub_dump(device_label: str, focus_symptom: str | None) -> str:
    """为不支持 web_search 的第三方模型生成最小 stub dump.

    此 stub 通过 assess_dump() 阈值检查(3 症状,3 组件,3 来源),
    使 pipeline 可以在无实际网络调研的情况下继续.
    """
    focus_block = ""
    if focus_symptom:
        focus_block = (
            "\n- **Symptom:** " + focus_symptom + "\n"
            "  - **Likely cause:** Unknown - third-party model cannot perform web research\n"
            "  - **Resolution:** ambiguous\n"
        )

    return (
        "# Research dump - " + device_label + "\n\n"
        "> Auto-generated stub for third-party model. Web research not available.\n\n"
        "## Device overview\n\n"
        + device_label
        + " - no web research available (third-party model).\n\n"
        "## Known failure modes\n" + focus_block + "- **Symptom:** Device not functioning\n"
        "  - **Likely cause:** Unknown - requires manual investigation\n"
        "  - **Resolution:** ambiguous\n\n"
        "- **Symptom:** Intermittent failures\n"
        "  - **Likely cause:** Unknown - requires manual investigation\n"
        "  - **Resolution:** ambiguous\n\n"
        "## Components mentioned by the community\n\n"
        "- **U1** - aliases: Unknown. Role: Unknown.\n"
        "  Typical failure: Unknown.\n"
        "- **C1** - aliases: Unknown. Role: Unknown.\n"
        "  Typical failure: Unknown.\n"
        "- **R1** - aliases: Unknown. Role: Unknown.\n"
        "  Typical failure: Unknown.\n\n"
        "## Signals / power rails / nets mentioned\n\n"
        "- **VCC** - aliases: Power supply. Nominal voltage: Unknown.\n"
        "- **GND** - aliases: Ground. Nominal voltage: 0V.\n\n"
        "## Sources\n\n"
        "- local://stub-generated - Auto-generated stub for third-party model\n"
        "- local://device-label - " + device_label + "\n"
        "- local://no-web-research - Web research not available\n"
    )


def _load_existing_raw_dump(pack_dir: Path) -> str | None:
    """从 audit/ 或遗留根路径加载已存在的非空 raw dump."""
    for path in (
        pack_dir / "audit" / "raw_research_dump.md",
        pack_dir / "raw_research_dump.md",
    ):
        if not path.is_file():
            continue
        try:
            raw_dump = path.read_text(encoding="utf-8")
        except OSError:
            logger.warning(
                "[Pipeline] Could not read existing raw dump at %s - ignoring",
                path,
                exc_info=True,
            )
            continue
        if raw_dump.strip():
            return raw_dump
        logger.warning("[Pipeline] Ignoring blank raw dump at %s", path)
    return None


# 事件回调类型别名
OnEvent = Callable[[dict[str, Any]], Awaitable[None]]


async def _noop_on_event(_event: dict[str, Any]) -> None:
    """默认的 on_event 回调 - 吞掉事件."""


def _slugify(label: str) -> str:
    """将设备标签转换为安全的目录 slug."""
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", label.strip().lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "unknown-device"


def _get_client() -> AsyncAnthropic:
    """创建 Anthropic 客户端实例(从 settings 读取配置).

    超时配置:
    - connect: 10 秒 (连接超时)
    - read: 20 分钟 (读取超时,第三方中继可能较慢)
    - write: 10 分钟 (写入超时)
    - pool: 10 分钟 (连接池超时)
    """
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and set your key."
        )
    from anthropic import Timeout

    timeout = Timeout(
        connect=10.0,
        read=1200.0,  # 20 分钟
        write=600.0,
        pool=600.0,
    )
    return AsyncAnthropic(
        api_key=settings.anthropic_api_key,
        max_retries=settings.anthropic_max_retries,
        base_url=settings.anthropic_base_url or None,
        timeout=timeout,
    )


async def generate_knowledge_pack(
    # ──────────────────────────────────────────────────────────────────
    # 必填参数
    # ──────────────────────────────────────────────────────────────────
    device_label: str,                      # 设备名称,如 "iPhone 11",用于日志和上下文

    # ──────────────────────────────────────────────────────────────────
    # 可选参数 - 路径与客户端
    # ──────────────────────────────────────────────────────────────────
    *,
    device_slug: str | None = None,         # 固定的 pack 目录 slug (如 "iphone-11").
                                            # 不传则从 device_label 自动 slugify.
                                            # 传入时与 uploads 目录保持一致,避免在
                                            # 已有 pack 旁另建目录.

    client: AsyncAnthropic | None = None,   # Anthropic 客户端实例.
                                            # 不传则从 settings 创建新实例.

    memory_root: Path | None = None,        # 知识包存储根目录.
                                            # 默认: settings.memory_root (通常是 memory/)

    # ──────────────────────────────────────────────────────────────────
    # 可选参数 - Pipeline 行为控制
    # ──────────────────────────────────────────────────────────────────
    max_revise_rounds: int | None = None,   # Writers 修订循环最大轮数.
                                            # 默认: settings.pipeline_max_revise_rounds.
                                            # NEEDS_REVISION 时重跑 Writers,超过此数仍
                                            # 未通过则降级为 APPROVED_WITH_WARNINGS.

    on_event: OnEvent | None = None,        # 进度事件回调函数.
                                            # 每个阶段边界 emit({type, phase, ...}).
                                            # 典型链路: emit -> events.publish -> progress_ws.
                                            # 抛错会被吞掉,不会拖垮 pipeline.

    uploaded_documents_dir: Path | None = None,  # 技师上传文档目录.
                                                  # 默认: memory/{slug}/uploads/.
                                                  # 测试时可指向其他目录.

    # ──────────────────────────────────────────────────────────────────
    # 可选参数 - 输入数据
    # ──────────────────────────────────────────────────────────────────
    focus_symptom: str | None = None,       # 焦点症状 (如 "不开机").
                                            # Scout 会分配 3-4 个搜索查询专门
                                            # 覆盖此症状,确保首次 pack 就包含
                                            # 维修原因相关的知识.

    raw_dump_override: str | None = None,   # 跳过 Scout,直接使用此文本作为
                                            # Phase 1 的原始调研报告.
                                            # 用于外部已提供调研数据的场景.

    user_device_kind: str | None = None,    # 技师声明的设备类别
                                            # (如 "laptop_logic_board").
                                            # 用于 Phase 1.5 设备分类的用户侧输入.

    confirmed_device_kind: str | None = None,  # 已确认的设备类别.
                                                # 跳过分类推理,直接使用此值.
                                                # 用于设备类型确认后的重新构建.

    expect_schematic: bool = False,         # 是否期望原理图正在带外摄取.
                                            # True 时 pipeline 会等待
                                            # electrical_graph.json 落盘
                                            # (最长 _SCHEMATIC_WAIT_TIMEOUT_S 秒).

    # ──────────────────────────────────────────────────────────────────
    # 可选参数 - 多租户与计量
    # ──────────────────────────────────────────────────────────────────
    owner_ref: str | None = None,           # 租户标识.
                                            # None = self-host (共享存储).
                                            # 非空 = 托管环境 (按租户隔离).
                                            # 影响: build_metering 用量报告.

    engine_repair_id: str | None = None,    # 维修会话 ID.
                                            # 用于 build_metering 关联维修与构建.
                                            # None = 无关联维修 (直接调用).
) -> PipelineResult:
    """运行完整的 pipeline(单设备).

    +-----------------------------------------------------------------+
    | 返回值                                                          |
    +-----------------------------------------------------------------+
    | PipelineResult - 包含 on-disk 路径和最终审计结论               |
    +-----------------------------------------------------------------+
    | 错误处理                                                        |
    +-----------------------------------------------------------------+
    | - REJECTED 结论 -> 抛出 RuntimeError                            |
    | - 终端失败 -> 抛出 RuntimeError                                  |
    +-----------------------------------------------------------------+
    | 进度事件(当 on_event 提供时)                                  |
    +-----------------------------------------------------------------+
    | pipeline_started      -> {device_slug, device_label, model}     |
    | phase_started/finished -> {phase, elapsed_s?}                    |
    | pipeline_paused       -> {reason, device_slug, ...}             |
    | pipeline_finished     -> {status, revise_rounds_used, ...}      |
    | pipeline_failed       -> {status, error}                        |
    +-----------------------------------------------------------------+
    | progress 链路                                                    |
    +-----------------------------------------------------------------+
    | create_repair -> on_event -> _wrap_on_event -> emit()             |
    | -> repairs._on_event -> events.publish(slug, ev)                 |
    | -> progress_ws 转发给浏览器                                     |
    | emit 内 listener 抛错被吞掉,避免 UI 拖垮 pipeline            |
    +-----------------------------------------------------------------+
    """
    settings = get_settings()
    client = client or _get_client()
    memory_root = memory_root or Path(settings.memory_root)
    max_revise_rounds = (
        max_revise_rounds if max_revise_rounds is not None else settings.pipeline_max_revise_rounds
    )
    # emit = 安全的 on_event 包装;repairs 侧 _on_event 最终写入 events 总线.
    emit = _wrap_on_event(on_event)

    # -- 每阶段模型分配 --
    # Opus 处理综合 + 判断(graph,rules,audit);
    # Sonnet 处理提取(web research,registry,per-component sheets)- 更便宜且足够.
    model_main = settings.anthropic_model_main  # Opus
    model_sonnet = settings.anthropic_model_sonnet  # Sonnet
    models_by_role = {
        "scout": model_sonnet,
        "registry": model_sonnet,
        "mapper": model_sonnet,
        "cartographe": model_main,
        "clinicien": model_main,
        "lexicographe": model_sonnet,
        "auditor": model_main,
    }
    # 固定的 slug(create_repair 的 `device_slug` 或云端的 canonical slug)
    # 决定 pack 目录 - 此处重新 slugify 会在上传文档旁构建新 pack.
    slug = device_slug or _slugify(device_label)

    pack_dir = memory_root / slug
    pack_dir.mkdir(parents=True, exist_ok=True)
    # 真实性契约:pack 写入是增量的,记录构建正在进行 -
    # 任何未到达 mark_complete/mark_paused 的退出都会将 pack 标记为不完整.
    build_state.mark_building(pack_dir)

    # -- 技师上传的文档 --
    # 默认搜索位置是设备的 per-pack uploads 目录;
    # 调用方(测试)可以指向其他目录.空/缺失目录使所有可选输入为 None.
    uploads_dir = uploaded_documents_dir or (pack_dir / "uploads")
    uploads = scan_uploads(uploads_dir)
    if not uploads.is_empty():
        logger.info(
            "[Pipeline] Found uploads in %s · schematic=%s boardview=%s datasheets=%d notes=%d other=%d",
            uploads_dir,
            uploads.schematic_pdf.name if uploads.schematic_pdf else "-",
            uploads.boardview.name if uploads.boardview else "-",
            len(uploads.datasheets),
            len(uploads.notes),
            len(uploads.other),
        )

    # 如果已上传原理图 PDF 且电气图尚未落盘，在 Scout 之前行内摄取原理图。
    # 失败时记录日志并继续 — pipeline 仍在无图状态下运行。
    if uploads.schematic_pdf is not None and not (pack_dir / "electrical_graph.json").exists():
        try:
            from api.pipeline.schematic.orchestrator import ingest_schematic

            t_ing = time.monotonic()  # 记录原理图摄取开始时间,用于计算耗时
            """
            特点：

            返回单调递增的时钟值（只增不减）
            不受系统时间调整影响（如 NTP 校时、手动改时间）
            精度通常为微秒级
            返回值单位是秒（float）
            """
            # Step 1: 通知前端：原理图导入阶段开始（内联摄取路径）
            await emit({"type": "phase_started", "phase": "schematic_ingest"})
            await ingest_schematic(
                device_slug=slug,
                pdf_path=uploads.schematic_pdf,
                client=client,
                memory_root=memory_root,
                device_label=device_label,
                on_event=emit,
            )
            logger.info(
                "[Pipeline] Schematic ingestion complete · pack=%s · elapsed=%.1fs",
                pack_dir,
                time.monotonic() - t_ing,
            )
            # Step 2: 通知前端：原理图导入阶段完成，包含耗时信息
            await emit(
                {
                    "type": "phase_finished",
                    "phase": "schematic_ingest",
                    "elapsed_s": time.monotonic() - t_ing,
                }
            )
        except Exception:  # noqa: BLE001 - falling back is fine, we just lose enrichment
            logger.exception(
                "[Pipeline] Inline schematic ingestion failed - continuing without graph"
            )

    # 技师上传的原理图不会落入 uploads/ 目录,而是通过专用的
    # /packs/{slug}/documents 端点(加密,租户隔离)带外摄取,
    # 完成后写入 electrical_graph.json.
    #
    # 当调用者信号表示原理图即将到来时(expect_schematic=True),
    # 在 Phase 1.5 之前等待该 graph,使设备类别分类 + Mapper 基于
    # 真实拓扑运行,而非盲猜.
    #
    # 轮询方式:通过 LOADING(不是 stat)判断文件是否就绪.
    # 原因:摄取过程会多次重写文件(compile -> boot -> passives),
    # 且不使用原子重命名,因此一个存在但写入一半的文件会解析为 None,
    # 我们继续等待即可.
    #
    # 第一个可解析的 graph 对 Phase 1.5 来说已经足够
    # (它只读取 rail 名称和组件族),且保留在内存中,
    # 后续的丰富化重写不会与下游加载产生竞争.
    graph: ElectricalGraph | None = None
    if (
        expect_schematic
        and uploads.schematic_pdf is None
        and not (pack_dir / "electrical_graph.json").exists()
    ):
        # Step 3: 通知前端：等待原理图导入（带外摄取路径）
        await emit({"type": "phase_started", "phase": "schematic_ingest"})
        t_wait = time.monotonic()
        deadline = t_wait + _SCHEMATIC_WAIT_TIMEOUT_S
        while time.monotonic() < deadline:
            await asyncio.sleep(_SCHEMATIC_WAIT_POLL_S)
            graph = _load_existing_electrical_graph(pack_dir)
            if graph is not None:
                break
        elapsed = time.monotonic() - t_wait
        if graph is not None:
            logger.info(
                "[Pipeline] Schematic graph arrived after %.1fs (pack=%s)",
                elapsed,
                pack_dir,
            )
            # Step 4: 通知前端：原理图已到达，等待结束
            await emit(
                {
                    "type": "phase_finished",
                    "phase": "schematic_ingest",
                    "elapsed_s": elapsed,
                }
            )
        else:
            logger.warning(
                "[Pipeline] Expected schematic graph never arrived within %.0fs "
                "- continuing without graph (pack=%s)",
                _SCHEMATIC_WAIT_TIMEOUT_S,
                pack_dir,
            )
            # Step 5: 通知前端：原理图等待超时，pipeline 继续无图运行
            await emit(
                {
                    "type": "phase_finished",
                    "phase": "schematic_ingest",
                    "elapsed_s": elapsed,
                    "timed_out": True,
                }
            )

    # 行内摄取路径（uploads/ 中的原理图）或已在磁盘上的 graph：在此加载。
    # 仅在上面的等待门控已产生 graph 时跳过。
    if graph is None:
        graph = _load_existing_electrical_graph(pack_dir)

    # 对编译后 graph 的确定性存在性基准事实。仅在此构建一次（graph 现已最终确定），
    # 并在 Phase 2.6（注册表丰富）、compute_drift（注册表 ∪ graph 域）、审计器（报告
    # + query_graph 工具）和修订器（graph 驱动的修复）中传递。无 graph 时为 None →
    # 每个下游消费者保持其 legacy web-only 路径。
    # 构造是防御性的：索引 graph 绝不能中止构建，因此一个意外/半构建的 graph 对象
    # 降级为 graph_truth=None（web-only 路径）而非崩溃 — 与上述加载器相同的纪律。
    graph_truth: GraphTruth | None = None
    if graph is not None:
        try:
            graph_truth = GraphTruth(graph)
        except Exception:  # noqa: BLE001 - a bad graph must not abort the build
            logger.exception(
                "[Pipeline] GraphTruth construction failed - continuing without "
                "graph ground-truth (pack=%s)",
                pack_dir,
            )

    logger.info("=" * 72)
    logger.info(
        "Pipeline start · device=%r · models=%s · pack=%s · graph=%s",
        device_label,
        models_by_role,
        pack_dir,
        "yes" if graph is not None else "no",
    )
    logger.info("=" * 72)

    # Step 6: 通知前端：pipeline 开始构建，前端 timeline/drawer 切换到「构建中」状态。
    # 若 WS 尚未连上,events._history 会缓冲,subscribe 时回放.
    await emit(
        {
            "type": "pipeline_started",
            "device_slug": slug,
            "device_label": device_label,
            "models": models_by_role,
            "uploads": {
                "schematic_pdf": uploads.schematic_pdf.name if uploads.schematic_pdf else None,
                "boardview": uploads.boardview.name if uploads.boardview else None,
                "datasheets": [p.name for p in uploads.datasheets],
            },
        }
    )

    phase_stats: list[PhaseTokenStats] = []

    try:
        # -------- Phase 1.5 - Device-kind classification + confirmation gate -----
        # 在任何 Scout 投入之前解析设备类别，使得 graph/declaration 不一致时
        # 暂停 pipeline，而不是在错误的设备族上消耗研究调用。两种入口模式：
        #   • 技术员确认不一致后的重新运行（`confirmed_device_kind` 已设置）—
        #     信任它，清除待定文件；
        #   • 全新运行 — 从 graph（当存在时）分类并与技术员声明的类别协调。
        #     低置信度结论或 user↔graph 不匹配以 NEEDS_KIND_CONFIRMATION 短路。
        # 解析后的类别传入 Scout + Registry 作为约束，并盖戳到 registry 分类上。
        # 详见 device_kind.py。
        if confirmed_device_kind is not None:
            resolved_kind: str | None = confirmed_device_kind
            device_kind.clear_pending_kind(pack_dir)
            resolution = KindResolution(
                resolved_kind=confirmed_device_kind,
                status="confirmed",
                user_declared=user_device_kind,
                graph_inferred=None,
                confidence=None,
                evidence="user-confirmed",
            )
            device_kind.write_kind_provenance(pack_dir, resolution, resolved_by="user")
            logger.info(
                "[Pipeline] Phase 1.5 · re-run with confirmed device_kind=%r",
                confirmed_device_kind,
            )
        else:
            verdict_kind = None
            if graph is not None:
                t_kind = time.monotonic()
                # Step 7: 通知前端：设备类别分类阶段开始（Phase 1.5）
                await emit({"type": "phase_started", "phase": "device_kind"})
                kind_stats = PhaseTokenStats(phase="device_kind")
                try:
                    verdict_kind = await device_kind.classify_device_kind(
                        client=client,
                        model=models_by_role["registry"],
                        device_label=device_label,
                        graph=graph,
                        stats=kind_stats,
                    )
                except Exception:  # noqa: BLE001 - fall back to user-declared kind
                    logger.exception(
                        "[Pipeline] Phase 1.5 classification failed - falling back to declared kind"
                    )
                    verdict_kind = None
                finally:
                    kind_stats.duration_s = time.monotonic() - t_kind
                    phase_stats.append(kind_stats)
                # Step 8: 通知前端：设备类别分类阶段完成
                await emit(
                    {
                        "type": "phase_finished",
                        "phase": "device_kind",
                        "elapsed_s": time.monotonic() - t_kind,
                    }
                )

            resolution = device_kind.reconcile_kind(
                user_declared=user_device_kind, verdict=verdict_kind
            )
            if resolution.status == "needs_confirmation":
                device_kind.write_pending_kind(pack_dir, resolution)
                logger.info(
                    "[Pipeline] Phase 1.5 · device-kind needs confirmation · "
                    "user=%r graph=%r conf=%s - pausing before Scout",
                    resolution.user_declared,
                    resolution.graph_inferred,
                    resolution.confidence,
                )
                # Step 9: 通知前端：设备类别需要人工确认，pipeline 暂停
                await emit(
                    {
                        "type": "pipeline_paused",
                        "reason": "needs_kind_confirmation",
                        "device_slug": slug,
                        "user_declared": resolution.user_declared,
                        "graph_inferred": resolution.graph_inferred,
                        "confidence": resolution.confidence,
                        "evidence": resolution.evidence,
                    }
                )
                # 合法提前退出，不失败 — 不要让 finally 钩子将停放的构建记录为失败。
                # 在确认的重新运行完成之前，pack 仍计为不完整。
                build_state.mark_paused(pack_dir, reason="needs_kind_confirmation")
                return PipelineResult(
                    device_slug=slug,
                    disk_path=str(pack_dir),
                    status="NEEDS_KIND_CONFIRMATION",
                    verdict=None,
                )
            resolved_kind = resolution.resolved_kind
            device_kind.write_kind_provenance(
                pack_dir,
                resolution,
                resolved_by="graph" if verdict_kind is not None else "user",
            )

        logger.info("[Pipeline] Phase 1.5 · resolved device_kind=%r", resolved_kind)

        # -------- Phase 1 - Scout ------------------------------------------------
        # Scout 盲跑：其 prompt 中不含 graph / board / datasheets。
        # 2026-04-24 的丰富化因 URL 逐条审计发现 23/23 条伪造的 refdes 归因
        # 而被回滚（当 Scout 拿到 graph 做上下文时）。功能→refdes 桥接现为
        # Phase 2.5（Mapper）— 一个带确定性后验证的 forced-tool agent。
        # 详见 docs/superpowers/specs/2026-04-25-refdes-mapper-agent.md。
        t0 = time.monotonic()
        # Step 10: 通知前端：Scout 网络调研阶段开始（Phase 1）
        await emit({"type": "phase_started", "phase": "scout"})
        scout_stats = PhaseTokenStats(phase="scout")
        raw_dump_source = "claude_scout"
        if raw_dump_override is not None:
            raw_dump = raw_dump_override
            raw_dump_source = "external_raw_dump"
            scout_stats.duration_s = time.monotonic() - t0
            phase_stats.append(scout_stats)
            _canonical_raw_dump_path(pack_dir).write_text(raw_dump, encoding="utf-8")
            logger.info("[Pipeline] Phase 1 skipped · using raw_dump_override")
            # Step 11: 通知前端：Scout 跳过，使用外部提供的原始调研数据
            await emit(
                {
                    "type": "phase_finished",
                    "phase": "scout",
                    "elapsed_s": scout_stats.duration_s,
                    "skipped": True,
                    "source": raw_dump_source,
                }
            )
        else:
            existing_raw_dump = _load_existing_raw_dump(pack_dir)
            if existing_raw_dump is not None:
                raw_dump = existing_raw_dump
                raw_dump_source = "existing_raw_dump"
                scout_stats.duration_s = time.monotonic() - t0
                phase_stats.append(scout_stats)
                logger.info("[Pipeline] Phase 1 skipped · using existing raw_research_dump.md")
                # Step 12: 通知前端：Scout 跳过，使用已存在的调研报告
                await emit(
                    {
                        "type": "phase_finished",
                        "phase": "scout",
                        "elapsed_s": scout_stats.duration_s,
                        "skipped": True,
                        "source": raw_dump_source,
                    }
                )
            else:
                scout_model = models_by_role["scout"]
                if _needs_third_party_forced_tool_compat(scout_model):
                    # 第三方模型不支持 web_search — 生成 stub dump
                    raw_dump = _generate_third_party_stub_dump(device_label, focus_symptom)
                    raw_dump_source = "third_party_stub"
                    scout_stats.duration_s = time.monotonic() - t0
                    phase_stats.append(scout_stats)
                    _canonical_raw_dump_path(pack_dir).write_text(raw_dump, encoding="utf-8")
                    logger.warning(
                        "[Pipeline] Scout model %r is third-party - using stub dump", scout_model
                    )
                    # Step 13: 通知前端：Scout 跳过，第三方模型不支持 web_search，使用 stub 数据
                    await emit(
                        {
                            "type": "phase_finished",
                            "phase": "scout",
                            "elapsed_s": scout_stats.duration_s,
                            "skipped": True,
                            "source": raw_dump_source,
                        }
                    )
                else:
                    raw_dump = await run_scout(
                        client=client,
                        model=scout_model,
                        device_label=device_label,
                        focus_symptom=focus_symptom,
                        min_symptoms=settings.pipeline_scout_min_symptoms,
                        min_components=settings.pipeline_scout_min_components,
                        min_sources=settings.pipeline_scout_min_sources,
                        max_retries=settings.pipeline_scout_max_retries,
                        device_kind=resolved_kind,
                        stats=scout_stats,
                        on_event=emit,
                    )
                    scout_stats.duration_s = time.monotonic() - t0
                    phase_stats.append(scout_stats)
                    _canonical_raw_dump_path(pack_dir).write_text(raw_dump, encoding="utf-8")
                    logger.info("[Pipeline] Phase 1 complete · raw_research_dump.md written")
                    # Step 14: 通知前端：Scout 网络调研完成，原始调研报告已写入
                    await emit(
                        {
                            "type": "phase_finished",
                            "phase": "scout",
                            "elapsed_s": scout_stats.duration_s,
                        }
                    )

        # -------- Phase 2 - Registry --------------------------------------------
        t0 = time.monotonic()
        # Step 15: 通知前端：Registry 注册表构建阶段开始（Phase 2）
        await emit({"type": "phase_started", "phase": "registry"})
        registry_stats = PhaseTokenStats(phase="registry")
        # Registry 也在无 graph 时运行 — 它专注于规范化词汇提取。
        # 功能→refdes 桥接下移到 Phase 2.5。为向后兼容已落盘的 pack，
        # RegistryComponent 上的 legacy `refdes_candidates` 字段保留在 schema 中。
        registry = await run_registry_builder(
            client=client,
            model=models_by_role["registry"],
            device_label=device_label,
            raw_dump=raw_dump,
            device_kind=resolved_kind,
            stats=registry_stats,
        )
        registry_stats.duration_s = time.monotonic() - t0
        phase_stats.append(registry_stats)
        # 将解析后的设备类别盖戳到规范化分类上，使得下游消费者（UI、agent prompt）
        # 从 registry.json 读取它。
        if resolved_kind is not None:
            registry.taxonomy.device_kind = resolved_kind
        # -------- Phase 2.6 - 从 graph 确定性丰富注册表 ------------
        # 在持久化之前关闭"注册表引用了未定义的 rail"的缺口：一个组件描述
        # 命名了真实 rail（PP1V2_S2），但网页派生的信号从未列出它，导致 drift 检查
        # 没有规范条目 → 审计器称该 rail 为伪造。这是一个廉价、确定性、无 LLM 的步骤
        #（被引用但缺失的 rail 永远不会被编造），因此它不发出事件 — 仅记录添加的信号日志。
        if graph_truth is not None:
            added_signals = enrich_registry_from_graph(registry, graph_truth)
            if added_signals:
                logger.info(
                    "[Pipeline] Phase 2.6 · registry enriched from graph · +%d signals: %s",
                    len(added_signals),
                    added_signals,
                )
            # -------- Phase 2.7 - 删除网络注册表虚构 ------------------
            # 当原理图是权威时，注册表命名的组件但 graph AND 原始 vision/OCR
            # 都未证实其存在，即为网络虚构（例如 MacBook 上 3V3 rail 实际上
            # 由 R6999 供电，但注册表引用了 U6903）。留下的话，Cartographe
            # 信任它并连接一个幽灵 `powers` 边，审计器随后拒绝。三重否定
            #（graph ∪ vision）使清除对 vision 召回缺口安全：
            # 一个真实但未追踪的部件仍出现在页面 vision 中并被保留。
            seen = load_seen_refdes(pack_dir)
            fictions = set(find_registry_fictions(registry, graph_truth, seen))
            if fictions:
                registry.components = [
                    c for c in registry.components if c.canonical_name not in fictions
                ]
                logger.info(
                    "[Pipeline] Phase 2.7 · dropped %d registry fiction(s) "
                    "(unattested by graph+vision): %s",
                    len(fictions),
                    sorted(fictions),
                )
        (pack_dir / "registry.json").write_text(
            registry.model_dump_json(indent=2), encoding="utf-8"
        )
        logger.info("[Pipeline] Phase 2 complete · registry.json written")
        # T9a: 用 Scout/Registry 发现的方面（board#/model/EMC/marketing + family）
        # 丰富设备别名注册表（"carnet"），使得后续针对其中任何一个的输入都解析到
        # 此 pack — 跨方面去重桥。尽力而为；绝不干扰构建。
        with contextlib.suppress(Exception):
            _carnet = get_device_registry_store(pack_dir.parent)
            await register_from_registry(_carnet, pack_dir.name, registry.model_dump())
        # Step 16: 通知前端：Registry 注册表构建完成，包含组件数、信号数和设备分类信息
        await emit(
            {
                "type": "phase_finished",
                "phase": "registry",
                "elapsed_s": registry_stats.duration_s,
                "counts": {
                    "components": len(registry.components),
                    "signals": len(registry.signals),
                },
                "taxonomy": registry.taxonomy.model_dump(),
            }
        )

        # -------- Phase 2.5 - Refdes Mapper（仅当 graph 加载时）---------
        # 详见 docs/superpowers/specs/2026-04-25-refdes-mapper-agent.md。
        # 通过 forced-tool + 服务端验证将注册表规范化名称映射到 graph refdes。
        # 失败是静默的：mapper 错误降级到空映射文件，bench-gen 回退到其 rail 重叠
        # 启发式方法。无 graph 加载时完全跳过。
        mappings: RefdesMappings | None = None
        if graph is not None:
            t_map = time.monotonic()
            # Step 17: 通知前端：Mapper 功能->位号映射阶段开始（Phase 2.5）
            await emit({"type": "phase_started", "phase": "mapper"})
            mapper_stats = PhaseTokenStats(phase="mapper")
            try:
                mappings = await run_mapper(
                    client=client,
                    model=models_by_role["mapper"],
                    device_label=device_label,
                    device_slug=slug,
                    raw_dump=raw_dump,
                    registry=registry,
                    graph=graph,
                    stats=mapper_stats,
                )
                mapper_stats.duration_s = time.monotonic() - t_map
                phase_stats.append(mapper_stats)
                (pack_dir / "refdes_attributions.json").write_text(
                    mappings.model_dump_json(indent=2),
                    encoding="utf-8",
                )
                logger.info(
                    "[Pipeline] Phase 2.5 complete · refdes_attributions.json written · n=%d",
                    len(mappings.attributions),
                )
                # Step 18: 通知前端：Mapper 完成，包含映射数量
                await emit(
                    {
                        "type": "phase_finished",
                        "phase": "mapper",
                        "elapsed_s": time.monotonic() - t_map,
                        "counts": {"attributions": len(mappings.attributions)},
                    }
                )
            except Exception:  # noqa: BLE001 - non-fatal: bench-gen has a heuristic fallback
                logger.exception(
                    "[Pipeline] Phase 2.5 mapper failed - continuing without attributions"
                )
                # 持久化一个空 attributions 文件，使得下游消费者观察到
                #"graph 存在但 mapper 未产生任何结果"而非"graph 不存在"。
                empty = RefdesMappings(device_slug=slug, attributions=[])
                (pack_dir / "refdes_attributions.json").write_text(
                    empty.model_dump_json(indent=2),
                    encoding="utf-8",
                )

        # -------- Phase 3 - Writers (parallel) ----------------------------------
        t0 = time.monotonic()
        # Step 19: 通知前端：Writers 并行写入阶段开始（Phase 3），三个 writer 同时运行
        await emit({"type": "phase_started", "phase": "writers"})
        w_stats = {
            "cartographe": PhaseTokenStats(phase="writer_cartographe"),
            "clinicien": PhaseTokenStats(phase="writer_clinicien"),
            "lexicographe": PhaseTokenStats(phase="writer_lexicographe"),
        }
        kg, rules, dictionary = await run_writers_parallel(
            client=client,
            cartographe_model=models_by_role["cartographe"],
            clinicien_model=models_by_role["clinicien"],
            lexicographe_model=models_by_role["lexicographe"],
            device_label=device_label,
            raw_dump=raw_dump,
            registry=registry,
            cache_warmup_seconds=settings.pipeline_cache_warmup_seconds,
            writer_stats=w_stats,
            on_event=emit,
        )
        writers_elapsed = time.monotonic() - t0
        for ws in w_stats.values():
            ws.duration_s = writers_elapsed
            phase_stats.append(ws)
        _write_writer_outputs(pack_dir, kg, rules, dictionary)
        logger.info("[Pipeline] Phase 3 complete · 3 writer files written")
        # Step 20: 通知前端：Writers 完成，包含知识图谱节点/边数、规则数、术语条目数
        await emit(
            {
                "type": "phase_finished",
                "phase": "writers",
                "elapsed_s": writers_elapsed,
                "counts": {
                    "nodes": len(kg.nodes),
                    "edges": len(kg.edges),
                    "rules": len(rules.rules),
                    "entries": len(dictionary.entries),
                },
            }
        )

        # -------- Phase 4 - Audit + 自愈循环 ------------------------------------
        # 收敛策略（Task 10）。朴素循环在 APPROVED 或 max-rounds 时修订，
        # 然后硬失败 — 因审计器的精确简报而损失约 $100 的构建，更糟糕的是，
        # 有时会交付比更早轮次评分更低的改写（macbook-air-m1 的 0.78 → 0.42
        # 崩溃）。三条规则解决此问题：
        #   • 回归时提前停止 — 在实践中分数下降的轨迹从未恢复，且每轮额外消耗
        #     真实的 Opus $。一旦分数回归，我们就停止修订。
        #   • 最佳快照 — 我们跟踪最高评分轮的完整
        #     (kg, rules, dictionary, verdict)，绝不交付比已有产物更差的结果。
        #   • 接受底线 — 当我们在没有 APPROVED 的情况下停止时，最佳快照
        #     只有在满足 `pipeline_accept_score` AND 具有空的确定性 drift
        #     （硬门控 — 具有真实 refdes drift 的高 LLM 分数不可交付）时
        #     才以 WITH WARNINGS 接受。floor=0 禁用此功能并恢复旧式的硬失败。
        t0 = time.monotonic()
        # Step 21: 通知前端：Audit 审计阶段开始（Phase 4），包含修订循环
        await emit({"type": "phase_started", "phase": "audit"})
        rounds_used = 0
        verdict: AuditVerdict
        # prev_score: 前一轮的一致性，用于检测回归。
        # best: 迄今最高分的 (score, kg, rules, dictionary, verdict)。
        # accepted_with_warnings: 当底线路径拯救了接近失败时设置。
        prev_score: float | None = None
        best: tuple[float, KnowledgeGraph, RulesSet, Dictionary, AuditVerdict] | None = None
        accepted_with_warnings = False

        while True:
            # Step 22: 通知前端：审计轮次子步骤（round 0 = 初始审计，round N>=1 = 修订）
            await emit(
                {"type": "phase_step", "phase": "audit", "step": "round", "index": rounds_used}
            )
            # 为此轮产物构建提及限定的 ground-truth 报告（当 graph 存在时）—
            # 审计器读取它而非原始 graph（防伪造纪律），并作为修订器修复的依据。
            # 无 graph 时为 None → 两者都保持 web-only 路径。
            report = (
                build_ground_truth_report(
                    graph_truth, extract_mentions(registry, kg, rules, dictionary)
                )
                if graph_truth is not None
                else None
            )
            code_drift = compute_drift(
                registry=registry,
                knowledge_graph=kg,
                rules=rules,
                dictionary=dictionary,
                graph_truth=graph_truth,
            )
            logger.info(
                "[Pipeline] Pre-computed drift · items=%d · files=%s",
                len(code_drift),
                sorted({item.file for item in code_drift}),
            )
            auditor_phase_name = "auditor" if rounds_used == 0 else f"auditor_rev_{rounds_used}"
            auditor_stats = PhaseTokenStats(phase=auditor_phase_name)
            previous_brief = verdict.revision_brief if rounds_used > 0 else ""  # noqa: F821 - verdict is bound on the prior loop iteration; rounds_used==0 short-circuits
            call_t0 = time.monotonic()
            verdict = await run_auditor(
                client=client,
                model=models_by_role["auditor"],
                device_label=device_label,
                registry=registry,
                knowledge_graph=kg,
                rules=rules,
                dictionary=dictionary,
                precomputed_drift=code_drift,
                revision_brief=previous_brief,
                graph_truth=graph_truth,
                ground_truth_report=report,
                max_query_turns=settings.pipeline_graph_query_turns_auditor,
                stats=auditor_stats,
            )
            auditor_stats.duration_s = time.monotonic() - call_t0
            phase_stats.append(auditor_stats)
            (pack_dir / "audit_verdict.json").write_text(
                verdict.model_dump_json(indent=2), encoding="utf-8"
            )

            # 快照迄今所见的最佳轮次，在任何终端决定之前，使得下面的底线路径可以
            # 回退到它（APPROVED 自然就是它自己的最佳）。严格 > 在平局时保留最早轮次 — 花费更少。
            if best is None or verdict.consistency_score > best[0]:
                best = (verdict.consistency_score, kg, rules, dictionary, verdict)

            if verdict.overall_status == "APPROVED":
                logger.info("[Pipeline] Phase 4 APPROVED on round=%d", rounds_used)
                break

            if verdict.overall_status == "REJECTED":
                logger.error("[Pipeline] Auditor REJECTED the pack - aborting")
                # Step 23: 通知前端：审计被拒绝，pipeline 失败终止
                await emit(
                    {
                        "type": "pipeline_failed",
                        "status": "REJECTED",
                        "error": verdict.revision_brief or "auditor rejected the pack",
                    }
                )
                raise RuntimeError(
                    f"Pipeline failed: auditor rejected the pack. brief={verdict.revision_brief!r}"
                )

            # NEEDS_REVISION。分数回归（相对于前一轮下降）是停止信号 —
            # 在实际构建中从未恢复，且每轮都是真实的 Opus 花费。
            # 我们在此停止的方式与在轮数耗尽时相同：回退到最佳快照（floor 或硬失败）。
            regression = prev_score is not None and verdict.consistency_score < prev_score
            prev_score = verdict.consistency_score

            if rounds_used >= max_revise_rounds or regression:
                score, b_kg, b_rules, b_dict, b_verdict = best
                # EDGE BACKSTOP。修订循环将每一条与 graph 矛盾的供电边视为 drift
                # 并有机会重新归因；任何在门控前仍然存在的必须被确定性修剪，否则它
                # 会被解读为残留 drift 并将一个原本可交付的 pack 沉入 REJECTED
                #（macbook U7800→PP1V8_S0 类）。与注册表虚构清除相同的纪律 —
                # 删除假边，绝不编造正确的边。
                if graph_truth is not None:
                    b_kg, pruned_edges = prune_contradicted_edges(b_kg, graph_truth)
                    if pruned_edges:
                        logger.warning(
                            "[Pipeline] Edge backstop pruned %d graph-contradicted "
                            "edge(s) from the best snapshot: %s",
                            len(pruned_edges),
                            [f"{c.src}->{c.rail}" for c in pruned_edges],
                        )
                # ORPHAN BACKSTOP。修订循环无法修复孤立节点 — 它们需要拓扑变更
                #（添加边或删除节点），而非文本编辑。此确定性 backstop 删除它们，
                # 使得 LLM 不能重新连线 graph 的缺陷不会阻塞原本可交付的 pack。
                # 无条件运行（无需 graph_truth）。
                b_kg, pruned_orphans = prune_orphan_nodes(b_kg)
                if pruned_orphans:
                    logger.warning(
                        "[Pipeline] Orphan backstop pruned %d orphan node(s) "
                        "from the best snapshot: %s",
                        len(pruned_orphans),
                        pruned_orphans,
                    )
                # ACCEPTANCE FLOOR。最佳快照仅在满足以下条件时以 WITH WARNINGS 可交付：
                # (a) floor 已启用（>0），(b) 它超过 floor，且 (c) 它具有零确定性 drift —
                # 对我们要交付的相同产物进行 registry∪graph 集合差分的 drift 检查。
                # drift 检查是硬门控：高 LLM 分数旁有真实的未定义 refdes 正是我们绝不能
                # 自动发布的腐败状态。在最佳快照（而非最后一轮）上重新运行它使门控保持诚实。
                floor = settings.pipeline_accept_score
                acceptable = (
                    floor > 0
                    and score >= floor
                    and not compute_drift(
                        registry=registry,
                        knowledge_graph=b_kg,
                        rules=b_rules,
                        dictionary=b_dict,
                        graph_truth=graph_truth,
                    )
                )
                if acceptable:
                    # 采用最佳快照并持久化它 — 我们可能已经重写了它变得更差，
                    # 因此将最佳版本写回磁盘，使落盘 pack 匹配我们交付的结论。
                    kg, rules, dictionary = b_kg, b_rules, b_dict
                    # Le verdict PERSISTÉ doit dire ce qui a été décidé : un
                    # audit_verdict.json en NEEDS_REVISION sur un pack shippé
                    # mentirait à tout consommateur disque (pack-admin, UI
                    # qualité). Le brief résiduel reste lisible dans le même
                    # fichier ET dans pack_quality.audit_warnings.
                    # NOTE Literal : "APPROVED_WITH_WARNINGS" n'est PAS dans le
                    # Literal d'AuditVerdict - c'est voulu (le schéma du tool
                    # submit_audit_verdict est généré depuis ce modèle ; élargir
                    # le Literal autoriserait l'auditor LLM à l'émettre).
                    # model_copy(update=) ne revalide pas, et le seul lecteur du
                    # fichier (routes/packs.py) lit du JSON brut sans Pydantic.
                    verdict = b_verdict.model_copy(
                        update={"overall_status": "APPROVED_WITH_WARNINGS"}
                    )
                    _write_writer_outputs(pack_dir, kg, rules, dictionary)
                    (pack_dir / "audit_verdict.json").write_text(
                        verdict.model_dump_json(indent=2), encoding="utf-8"
                    )
                    accepted_with_warnings = True
                    logger.warning(
                        "[Pipeline] Phase 4 accepted WITH WARNINGS · best score=%.2f "
                        "(floor=%.2f) · reason=%s - remaining brief persisted to pack_quality",
                        score,
                        floor,
                        "regression" if regression else "rounds exhausted",
                    )
                    break

                # 不可接受 → 旧式硬失败。用说明原因（分数 vs floor / drift）的简报
                # 将结论盖戳为 REJECTED，持久化它，发出 pipeline_failed，并抛出。
                logger.error(
                    "[Pipeline] Phase 4 unrecoverable · best score=%.2f (floor=%.2f) · "
                    "reason=%s - rejecting.",
                    score,
                    floor,
                    "regression" if regression else "rounds exhausted",
                )
                verdict = b_verdict.model_copy(
                    update={
                        "overall_status": "REJECTED",
                        "revision_brief": (
                            f"Unrecoverable after {rounds_used} revise round(s) "
                            f"({'score regression' if regression else 'rounds exhausted'}); "
                            f"best score {score:.2f} below floor {floor:.2f} or with residual "
                            f"deterministic drift. Last brief: {b_verdict.revision_brief!r}"
                        ),
                    }
                )
                (pack_dir / "audit_verdict.json").write_text(
                    verdict.model_dump_json(indent=2), encoding="utf-8"
                )
                # Step 24: 通知前端：修订循环耗尽或分数回归后仍无法恢复，pipeline 失败
                await emit(
                    {
                        "type": "pipeline_failed",
                        "status": "REJECTED",
                        "error": verdict.revision_brief,
                    }
                )
                raise RuntimeError(
                    f"Pipeline failed: unrecoverable after {rounds_used} revise round(s). "
                    f"brief={verdict.revision_brief!r}"
                )

            rounds_used += 1
            logger.info(
                "[Pipeline] Revise round=%d · files=%s · brief=%r",
                rounds_used,
                verdict.files_to_rewrite,
                verdict.revision_brief[:200],
            )
            kg, rules, dictionary = await _apply_revisions(
                client=client,
                cartographe_model=models_by_role["cartographe"],
                clinicien_model=models_by_role["clinicien"],
                lexicographe_model=models_by_role["lexicographe"],
                device_label=device_label,
                raw_dump=raw_dump,
                registry=registry,
                verdict=verdict,
                current_kg=kg,
                current_rules=rules,
                current_dictionary=dictionary,
                ground_truth_report=report,
                graph_truth=graph_truth,
                max_query_turns=settings.pipeline_graph_query_turns_reviser,
                stats_sink=phase_stats,
                round_index=rounds_used,
            )
            _write_writer_outputs(pack_dir, kg, rules, dictionary)

        # 循环后边 backstop — 覆盖 APPROVED 路径（floor 路径已在门控前修剪了其快照）。
        # 如果审计器批准了一个仍然携带与 graph 矛盾边的 pack，现在删除它，使得交付的
        # kg 永不与原理图矛盾。幂等 → 当 floor 分支已清理快照时为空操作。
        if graph_truth is not None:
            kg, post_pruned = prune_contradicted_edges(kg, graph_truth)
            if post_pruned:
                logger.warning(
                    "[Pipeline] Edge backstop pruned %d graph-contradicted edge(s) "
                    "post-acceptance: %s",
                    len(post_pruned),
                    [f"{c.src}->{c.rail}" for c in post_pruned],
                )
                _write_writer_outputs(pack_dir, kg, rules, dictionary)

        # Step 25: 通知前端：Audit 审计阶段完成，包含最终状态、一致性分数和修订轮数
        await emit(
            {
                "type": "phase_finished",
                "phase": "audit",
                "elapsed_s": time.monotonic() - t0,
                # APPROVED_WITH_WARNINGS 向 UI 表明这是 floor-rescue 状态，非失败终止
                "status": "APPROVED_WITH_WARNINGS"
                if accepted_with_warnings
                else verdict.overall_status,
                "consistency_score": verdict.consistency_score,
                "revise_rounds_used": rounds_used,
            }
        )

        # -------- Pack lint - 确定性预持久化质量信号 ----------
        # 对最终 rules + registry + graph rails 的廉价正则检查。
        # 发现仅为 SIGNAL：记录到日志并持久化到 `pack_quality.json`，但绝不中止
        # pipeline（在 `reject` 严重级别上阻止自动发布已推迟到子项目 B）。
        graph_rails = set(graph.power_rails.keys()) if graph is not None else None
        lint_findings = lint_pack(
            registry=registry,
            rules_text=rules.model_dump_json(),
            graph_rails=graph_rails,
        )
        if lint_findings:
            logger.warning(
                "[Pipeline] pack_lint: %d finding(s): %s",
                len(lint_findings),
                [f"{f.code}/{f.severity}" for f in lint_findings],
            )
        # 当 pack 在低于 APPROVED 的情况下被接受时，将残留的审计状态
        #（分数 + 未解决的简报 + 确定性 drift）附加到 pack_quality。
        # 这是我们所知道的已交付 gap 的可审计跟踪 — 质量 UI 可以重新服务，
        # 使技术员看到警告。干净的 APPROVED 运行传递 None，该键不存在。
        _write_pack_quality(
            pack_dir,
            lint_findings,
            audit_warnings={
                "consistency_score": verdict.consistency_score,
                "revision_brief": verdict.revision_brief,
                "drift_report": [d.model_dump() for d in verdict.drift_report],
            }
            if accepted_with_warnings
            else None,
        )
        logger.info("[Pipeline] pack_quality.json written")

        # 每个 pack 文件都在磁盘上并通过审计 — 在 pipeline_finished 事件发出前
        # 翻转标记，使得响应该事件的订阅者（cloud 的结果跟踪、重试 POST）永远
        # 不会读到陈旧的 'building' 状态。
        build_state.mark_complete(pack_dir)

        # -------- Done ----------------------------------------------------------
        logger.info("Pipeline end · pack=%s · rounds=%d", pack_dir, rounds_used)
        logger.info("=" * 72)

        # Lot 3 - graph↔boardview QA 门控。当构建产生了 graph 并且提供了 boardview 时，
        # 写入 coverage_report.json + 获取 PASS/WARN/FAIL 结论。尽力而为（绝不崩溃构建）。
        coverage_verdict = graph_coverage.run_coverage_gate(pack_dir, uploads.boardview)

        # Lot 2 + Lot 3 - web-only 托管构建（无 graph）或覆盖 FAILED 的 schematic 构建
        # 被迁移到请求租户的 PRIVATE 暂存层，而非共享公共层。在 mark_complete 之后完成
        #（pipeline 已完成读取根目录）且在 seed 之前（seed 挂载 SHARED 设备存储 —
        # 绝不能镜像私有 pack）。Self-host / 通过 PASS/WARN 的 schematic 构建保持共享。
        staged_private = _stage_if_private(memory_root, pack_dir, slug, owner_ref, coverage_verdict)

        # 将设备的 Managed-Agents 存储与刚批准的 pack 做 seed，使得诊断会话通过
        # /mnt/memory/ 文件系统挂载读取规范知识，而非每次工具调用都重新加载 JSON。
        # 当 ma_memory_store_enabled 为 False 时为空操作。对于私有 web-only pack SKIPPED —
        # 设备存储是跨租户的；拥有租户的 agent 通过 load_effective_pack 实时读取其暂存 pack。
        if staged_private:
            seed_status = "skipped_web_only_private"
        else:
            seed_status = await seed_memory_store_from_pack(
                client=client, device_slug=slug, pack_dir=pack_dir
            )
        logger.info("[Pipeline] Memory-store seed status=%s", seed_status)

        # 在 accept-with-warnings 路径上采用的结论是 best 快照（NEEDS_REVISION）—
        # 而构建的最终状态必须说明被采纳的决定，而非审计器对该轮的想法。
        # cloud 只读事件 TYPE，但引擎 UI（和任何未来的订阅者）读 `status`：
        # 一个完成的构建上的 NEEDS_REVISION 会是假象。
        final_status = (
            "APPROVED_WITH_WARNINGS" if accepted_with_warnings else verdict.overall_status
        )
        # Step 26: 通知前端：pipeline 完成，包含最终状态、修订轮数、一致性分数和 memory store seed 状态
        await emit(
            {
                "type": "pipeline_finished",
                "device_slug": slug,
                "status": final_status,
                "revise_rounds_used": rounds_used,
                "consistency_score": verdict.consistency_score,
                "memory_store_seed": seed_status,
            }
        )

        tokens_used_total = sum(s.input_tokens + s.output_tokens for s in phase_stats)
        cache_read_tokens_total = sum(s.cache_read_input_tokens for s in phase_stats)
        cache_write_tokens_total = sum(s.cache_creation_input_tokens for s in phase_stats)
        return PipelineResult(
            device_slug=slug,
            disk_path=str(pack_dir),
            verdict=verdict,
            revise_rounds_used=rounds_used,
            tokens_used_total=tokens_used_total,
            cache_read_tokens_total=cache_read_tokens_total,
            cache_write_tokens_total=cache_write_tokens_total,
        )
    except RuntimeError:
        raise
    except Exception as exc:  # pragma: no cover - defensive wrapper
        logger.exception("[Pipeline] Unexpected failure")
        # Step 27: 通知前端：pipeline 遇到未预期的异常，构建失败
        await emit({"type": "pipeline_failed", "status": "ERROR", "error": str(exc)})
        raise
    finally:
        # 任何未到达 mark_complete/mark_paused 的退出（REJECTED 结论、未预期异常、
        # 任务取消）都将标记保留在 'building' 状态 — 将其记录为失败，使得部分 pack
        # 不再计为完整。捕获 ALL 退出，包括 CancelledError，不触及上述 except 结构。
        _in_flight_exc = sys.exc_info()[1]
        build_state.finalize_failed_if_building(
            pack_dir, error=str(_in_flight_exc) if _in_flight_exc else "pipeline did not complete"
        )
        # 始终持久化遥测 — 即使在失败时也如此，使得前期阶段的 token
        # 不丢失且失败可以在事后诊断。
        try:
            if phase_stats:
                write_token_stats(pack_dir / "token_stats.json", phase_stats)
                logger.info(
                    "[Pipeline] token_stats.json written · phases=%d",
                    len(phase_stats),
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[Pipeline] Failed to write token_stats.json: %s", exc)
        # T13 build metering: 将构建的每阶段花费报告给 cloud 账本（kind='build'）。
        # 内存中统计 — 绝不从磁盘重新读取，因此重新运行不会重复报告先前运行的文件。
        # cloud 目标未配置时硬空操作（self-host）；否则尽力而为。
        try:
            if phase_stats:
                report_build_phases(
                    owner_ref=owner_ref,
                    engine_repair_id=engine_repair_id,
                    stats=phase_stats,
                )
        except Exception as exc:  # noqa: BLE001 - metering must never mask the build outcome
            logger.warning("[Pipeline] build metering report failed: %s", exc)


def _wrap_on_event(on_event: OnEvent | None) -> OnEvent:
    """将外部 on_event 包装为 emit:None -> 空操作;异常 -> 记录日志并吞掉.

    保证 progress 投递失败不会中断 knowledge pipeline 主流程.
    repairs._run_pipeline_with_events 传入的 _on_event 经此包装后,
    在 generate_knowledge_pack 内以 emit({type: ...}) 形式在各阶段调用.
    """
    if on_event is None:
        return _noop_on_event

    async def safe(event: dict[str, Any]) -> None:
        try:
            await on_event(event)
        except Exception:  # noqa: BLE001 - listener failures must not abort pipeline
            logger.warning("[Pipeline] on_event listener raised; swallowing", exc_info=True)

    return safe


def _write_writer_outputs(
    pack_dir: Path,
    kg: KnowledgeGraph,
    rules: RulesSet,
    dictionary: Dictionary,
) -> None:
    (pack_dir / "knowledge_graph.json").write_text(kg.model_dump_json(indent=2), encoding="utf-8")
    (pack_dir / "rules.json").write_text(rules.model_dump_json(indent=2), encoding="utf-8")
    (pack_dir / "dictionary.json").write_text(
        dictionary.model_dump_json(indent=2), encoding="utf-8"
    )


def _write_pack_quality(
    pack_dir: Path,
    findings: list[LintFinding],
    audit_warnings: dict | None = None,
) -> None:
    """持久化确定性 lint 发现作为 pack 质量信号。

    干净的 pack 写入空的 `lint_findings` 列表 — 产物始终存在，
    使得下游消费者可以区分"已 lint，干净"与"从未 lint"。

    当提供 `audit_warnings` 时，记录 pack 在低于 APPROVED 的情况下被接受
    （floor-rescue 路径）：接受时的 consistency 分数、未解决的修订简报和 drift 报告。
    它是残留问题的可审计跟踪 — 质量 UI 可重新服务，使警告随 pack 传递。
    在干净的 APPROVED 构建上省略（键不存在）。"""
    payload = {"lint_findings": [asdict(f) for f in findings]}
    if audit_warnings is not None:
        payload["audit_warnings"] = audit_warnings
    (pack_dir / "pack_quality.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )


async def _apply_revisions(
    *,
    client: AsyncAnthropic,
    cartographe_model: str,
    clinicien_model: str,
    lexicographe_model: str,
    device_label: str,
    raw_dump: str,
    registry: Registry,
    verdict: AuditVerdict,
    current_kg: KnowledgeGraph,
    current_rules: RulesSet,
    current_dictionary: Dictionary,
    ground_truth_report: str | None = None,
    graph_truth: GraphTruth | None = None,
    max_query_turns: int = 4,
    stats_sink: list[PhaseTokenStats] | None = None,
    round_index: int = 0,
) -> tuple[KnowledgeGraph, RulesSet, Dictionary]:
    """重新运行审计器标记的每个 writer 并返回更新后的元组。

    收敛 bug 的 RC1 — 两个耦合修复在此处：

    1. 固定修订顺序 `(knowledge_graph, rules, dictionary)`，而非审计器的
       `files_to_rewrite` 顺序。在真实的 macbook-air-m1 构建上，按审计器顺序修订
       使得 rules/dictionary 针对一个本身即将变更的 kg 重新对齐 — 顺序依赖、
       非确定性收敛。

    2. 向前传递新修订的产物：kg 修订后，rules 修订器接收新的 kg 作为 `current_kg`
       （以此类推）。修订器针对实际存在的后修订状态对齐跨文件引用，使得三个文件
       在修订后*实际*存在的状态上重新对齐 — 而非每个修订器过去看到的陈旧快照
      （这导致了一致性从 0.78 崩溃到 0.42）。下面的 `kg`/`rules`/`dictionary`
       是循环本地的、始终当前的 trio；我们在每次调用上将它们作为 `current_*`
       兄弟参数传递。"""
    kg, rules, dictionary = current_kg, current_rules, current_dictionary

    common_kwargs = {
        "client": client,
        "cartographe_model": cartographe_model,
        "clinicien_model": clinicien_model,
        "lexicographe_model": lexicographe_model,
        "device_label": device_label,
        "raw_dump": raw_dump,
        "registry": registry,
        "revision_brief": verdict.revision_brief,
        "ground_truth_report": ground_truth_report,
        "graph_truth": graph_truth,
        "max_query_turns": max_query_turns,
    }

    requested = set(verdict.files_to_rewrite)
    # 对审计器要求的任何不在已知三者中的名称发出警告，
    # 保留旧的跳过行为（我们只是不再迭代其顺序）。
    for unknown in requested - {"knowledge_graph", "rules", "dictionary"}:
        logger.warning("[Pipeline] Skipping unknown file_name in revise: %r", unknown)

    def _reviser_stats(file_name: str) -> PhaseTokenStats | None:
        """每个修订器调用一个 PhaseTokenStats，收集到调用方的 sink 中。
        没有它，修订器的 query_graph 轮次（每个文件最多 max_query_turns 次 Opus 调用）
        将缺失于 token_stats.json 和可计费总额中 — 随 graph 工具的增长，
        此缺口不再可忽略。"""
        if stats_sink is None:
            return None
        st = PhaseTokenStats(phase=f"reviser_{file_name}_round_{round_index}")
        stats_sink.append(st)
        return st

    # 固定顺序 — 审计器的顺序不再重要；我们始终先修订 graph，
    # 使得下游修订器看到修正后的 kg 作为其兄弟。
    for file_name in ("knowledge_graph", "rules", "dictionary"):
        if file_name not in requested:
            continue
        if file_name == "knowledge_graph":
            kg = await run_single_writer_revision(
                file_name=file_name,
                previous_output_json=kg.model_dump_json(indent=2),
                current_kg=kg,
                current_rules=rules,
                current_dictionary=dictionary,
                stats=_reviser_stats(file_name),
                **common_kwargs,
            )
        elif file_name == "rules":
            rules = await run_single_writer_revision(
                file_name=file_name,
                previous_output_json=rules.model_dump_json(indent=2),
                current_kg=kg,  # 刚修订的 kg，非原始版本
                current_rules=rules,
                current_dictionary=dictionary,
                stats=_reviser_stats(file_name),
                **common_kwargs,
            )
        elif file_name == "dictionary":
            dictionary = await run_single_writer_revision(
                file_name=file_name,
                previous_output_json=dictionary.model_dump_json(indent=2),
                current_kg=kg,  # 刚修订的 kg + rules 向前传递
                current_rules=rules,
                current_dictionary=dictionary,
                stats=_reviser_stats(file_name),
                **common_kwargs,
            )

    return kg, rules, dictionary
