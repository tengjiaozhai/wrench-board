"""Phase 3 — 3 个 Writer 并行运行，共享带缓存控制的前缀。

3 个 writer（Cartographe / Clinicien / Lexicographe）共享：
- 相同的 `tools` 数组（3 个 submit_* 工具全部声明）
- 相同的 `system` 提示词（`WRITER_SYSTEM`）
- 相同的 user message 前缀（raw dump + registry），带 `cache_control: ephemeral` 断点

区别仅在于：
- user message 后缀（每个 writer 各自的任务指令）
- `tool_choice` — 各自强制指向其专属的 submit_* 工具

先启动 writer 1，然后 `asyncio.sleep(CACHE_WARMUP_SECONDS)` 再派发 writer 2 和 3，
让 Anthropic 有时间基于 writer 1 的请求物化缓存条目，供后续 writer 命中。
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

from anthropic import AsyncAnthropic

from api.config import get_settings
from api.pipeline.patch import (
    PatchApplyError,
    apply_dictionary_patch,
    apply_kg_patch,
    apply_rules_patch,
)
from api.pipeline.prompts import (
    CARTOGRAPHE_TASK,
    CLINICIEN_TASK,
    LEXICOGRAPHE_TASK,
    WRITER_SHARED_USER_PREFIX_TEMPLATE,
    WRITER_SYSTEM,
)
from api.pipeline.schemas import (
    Dictionary,
    DictionaryPatch,
    KnowledgeGraph,
    KnowledgeGraphPatch,
    Registry,
    RulesPatch,
    RulesSet,
)
from api.pipeline.tool_call import (
    _needs_third_party_forced_tool_compat,
    call_with_forced_tool,
    call_with_query_tools,
)

if TYPE_CHECKING:
    from api.pipeline.graph_truth import GraphTruth
    from api.pipeline.telemetry.token_stats import PhaseTokenStats

logger = logging.getLogger("wrench_board.pipeline.writers")


# 工具名称 - 必须与下方的 forced tool_choice 调用一致。
SUBMIT_KG_TOOL_NAME = "submit_knowledge_graph"
SUBMIT_RULES_TOOL_NAME = "submit_rules"
SUBMIT_DICT_TOOL_NAME = "submit_dictionary"


def _submit_kg_tool() -> dict:
    """Cartographe 工具定义 - 类型化知识图谱。"""
    return {
        "name": SUBMIT_KG_TOOL_NAME,
        "description": "Cartographe output - typed knowledge graph.",
        "input_schema": KnowledgeGraph.model_json_schema(),
    }


def _submit_rules_tool() -> dict:
    """Clinicien 工具定义 - 诊断规则。"""
    return {
        "name": SUBMIT_RULES_TOOL_NAME,
        "description": "Clinicien output - diagnostic rules.",
        "input_schema": RulesSet.model_json_schema(),
    }


def _submit_dict_tool() -> dict:
    """Lexicographe 工具定义 - 组件手册。"""
    return {
        "name": SUBMIT_DICT_TOOL_NAME,
        "description": "Lexicographe output - component sheets.",
        "input_schema": Dictionary.model_json_schema(),
    }


def _all_writer_tools() -> list[dict]:
    """每个 writer 都接收完整的 3 个工具，以便 tools 层缓存共享。"""
    return [_submit_kg_tool(), _submit_rules_tool(), _submit_dict_tool()]


# Reviser 补丁工具 - 修订路径强制使用其中一个（按 file_name），
# 而非完整的 submit_* 工具，让 reviser 发出一个外科手术式的增量，
# 由 `api.pipeline.patch` 应用器应用到当前产物上。
SUBMIT_KG_PATCH_TOOL_NAME = "submit_knowledge_graph_patch"
SUBMIT_RULES_PATCH_TOOL_NAME = "submit_rules_patch"
SUBMIT_DICT_PATCH_TOOL_NAME = "submit_dictionary_patch"


def _submit_kg_patch_tool() -> dict:
    return {
        "name": SUBMIT_KG_PATCH_TOOL_NAME,
        "description": "Surgical delta over the knowledge graph — only the nodes/edges you change.",
        "input_schema": KnowledgeGraphPatch.model_json_schema(),
    }


def _submit_rules_patch_tool() -> dict:
    return {
        "name": SUBMIT_RULES_PATCH_TOOL_NAME,
        "description": "Surgical delta over the rules — only the rules you change.",
        "input_schema": RulesPatch.model_json_schema(),
    }


def _submit_dict_patch_tool() -> dict:
    return {
        "name": SUBMIT_DICT_PATCH_TOOL_NAME,
        "description": "Surgical delta over the dictionary — only the entries you change.",
        "input_schema": DictionaryPatch.model_json_schema(),
    }


def _build_shared_user_messages(
    *,
    device_label: str,
    raw_dump: str,
    registry: Registry,
    task_suffix: str,
    enable_cache: bool = True,
) -> list[dict]:
    """构建每个 writer 的 message 列表。第一个 content block 带有
    `cache_control: ephemeral` 标记，使前缀在 3 个 writer 之间缓存。
    """
    shared_prefix = WRITER_SHARED_USER_PREFIX_TEMPLATE.format(
        device_label=device_label,
        raw_dump=raw_dump,
        registry_json=registry.model_dump_json(indent=2),
    )
    first_block: dict = {
        "type": "text",
        "text": shared_prefix,
    }
    if enable_cache:
        first_block["cache_control"] = {"type": "ephemeral"}

    return [
        {
            "role": "user",
            "content": [
                first_block,
                {
                    "type": "text",
                    "text": task_suffix,
                },
            ],
        }
    ]


async def _run_single_writer(
    *,
    client: AsyncAnthropic,
    model: str,
    device_label: str,
    raw_dump: str,
    registry: Registry,
    task_suffix: str,
    forced_tool_name: str,
    output_schema,
    log_label: str,
    stats: PhaseTokenStats | None = None,
):
    messages = _build_shared_user_messages(
        device_label=device_label,
        raw_dump=raw_dump,
        registry=registry,
        task_suffix=task_suffix,
        enable_cache=not _needs_third_party_forced_tool_compat(model),
    )
    return await call_with_forced_tool(
        client=client,
        model=model,
        system=WRITER_SYSTEM,
        messages=messages,
        tools=_all_writer_tools(),
        forced_tool_name=forced_tool_name,
        output_schema=output_schema,
        max_attempts=5,
        log_label=log_label,
        stats=stats,
    )


async def run_writers_parallel(
    *,
    client: AsyncAnthropic,
    cartographe_model: str,
    clinicien_model: str,
    lexicographe_model: str,
    device_label: str,
    raw_dump: str,
    registry: Registry,
    cache_warmup_seconds: float | None = None,
    writer_stats: dict[str, PhaseTokenStats] | None = None,
    on_event: Callable[[dict], Awaitable[None]] | None = None,
) -> tuple[KnowledgeGraph, RulesSet, Dictionary]:
    """交错启动 3 个 writer，带缓存预热延迟。

    Writer 1（Cartographe）先发 — 它写入缓存。短暂等待后，
    并发启动 writer 2（Clinicien）和 3（Lexicographe）。

    Prompt 缓存是按 model 作用域的，所以 Cartographe + Clinicien（同 model）共享
    一个缓存条目，而 Lexicographe — 通常是更便宜的 model — 写入自己的缓存。
    这种拆分每次运行多花一次 cache_creation，但在每个组件提取 token 上节省更多。

    `cache_warmup_seconds` 为 None 时回退到 `Settings.pipeline_cache_warmup_seconds`
    — 该设置是经验调优的预热窗口（3.0s，见 `api/config.py`）的唯一权威来源；
    该参数仅用于测试时将其降为 0 而无需 monkeypatch settings。
    """
    if cache_warmup_seconds is None:
        cache_warmup_seconds = get_settings().pipeline_cache_warmup_seconds
    logger.info(
        "[Writers] Starting parallel writers "
        "(cart=%s clin=%s lex=%s · cache_warmup=%.1fs) for device=%r",
        cartographe_model,
        clinicien_model,
        lexicographe_model,
        cache_warmup_seconds,
        device_label,
    )

    async def _emit_done(coro, writer: str, count_fn):
        """等待一个 writer 完成，然后在完成时发出 `phase_step` 实时事件。

        包装每个 writer（而非在 gather 后统一发出），使得落地行
        "graphe ✓ … règles ✓ … dico ✓" 按各自完成节奏逐个点亮，
        而非同时出现。
        """
        result = await coro
        if on_event is not None:
            await on_event({
                "type": "phase_step", "phase": "writers", "step": "writer_done",
                "writer": writer, "count": count_fn(result),
            })
        return result

    kg_task = asyncio.create_task(
        _emit_done(
            _run_single_writer(
                client=client,
                model=cartographe_model,
                device_label=device_label,
                raw_dump=raw_dump,
                registry=registry,
                task_suffix=CARTOGRAPHE_TASK,
                forced_tool_name=SUBMIT_KG_TOOL_NAME,
                output_schema=KnowledgeGraph,
                log_label="Cartographe",
                stats=writer_stats.get("cartographe") if writer_stats else None,
            ),
            "graph",
            lambda kg: len(kg.nodes),
        ),
        name="writer-cartographe",
    )

    logger.info(
        "[Writers] Cartographe dispatched · waiting %.1fs for cache warm-up", cache_warmup_seconds
    )
    await asyncio.sleep(cache_warmup_seconds)

    rules_task = asyncio.create_task(
        _emit_done(
            _run_single_writer(
                client=client,
                model=clinicien_model,
                device_label=device_label,
                raw_dump=raw_dump,
                registry=registry,
                task_suffix=CLINICIEN_TASK,
                forced_tool_name=SUBMIT_RULES_TOOL_NAME,
                output_schema=RulesSet,
                log_label="Clinicien",
                stats=writer_stats.get("clinicien") if writer_stats else None,
            ),
            "rules",
            lambda rules: len(rules.rules),
        ),
        name="writer-clinicien",
    )
    dict_task = asyncio.create_task(
        _emit_done(
            _run_single_writer(
                client=client,
                model=lexicographe_model,
                device_label=device_label,
                raw_dump=raw_dump,
                registry=registry,
                task_suffix=LEXICOGRAPHE_TASK,
                forced_tool_name=SUBMIT_DICT_TOOL_NAME,
                output_schema=Dictionary,
                log_label="Lexicographe",
                stats=writer_stats.get("lexicographe") if writer_stats else None,
            ),
            "dict",
            lambda d: len(d.entries),
        ),
        name="writer-lexicographe",
    )

    logger.info("[Writers] Clinicien + Lexicographe dispatched in parallel")
    kg, rules, dictionary = await asyncio.gather(kg_task, rules_task, dict_task)

    logger.info(
        "[Writers] All 3 writers complete · kg.nodes=%d rules=%d dict.entries=%d",
        len(kg.nodes),
        len(rules.rules),
        len(dictionary.entries),
    )
    return kg, rules, dictionary


# Reviser 映射表。每个条目对应一个 writer 角色的外科手术式补丁接口：
# 补丁工具名称、reviser 发出的补丁 schema、以及将该补丁转换为新产物的
# 确定性应用函数。以规范 file_name（knowledge_graph / rules / dictionary）为键。
# reviser 发出增量 — 而非整个产物 — 因此未标记的记录原样保留（无附带回归面）。
_REVISE_MAPPING = {
    "knowledge_graph": (
        SUBMIT_KG_PATCH_TOOL_NAME, KnowledgeGraphPatch, apply_kg_patch, "Cartographe-Revise"
    ),
    "rules": (
        SUBMIT_RULES_PATCH_TOOL_NAME, RulesPatch, apply_rules_patch, "Clinicien-Revise"
    ),
    "dictionary": (
        SUBMIT_DICT_PATCH_TOOL_NAME, DictionaryPatch, apply_dictionary_patch, "Lexicographe-Revise"
    ),
}


def _submit_patch_tool_for(file_name: str) -> dict:
    """按 file_name 返回单个 writer 角色的补丁提交工具对象。"""
    return {
        "knowledge_graph": _submit_kg_patch_tool,
        "rules": _submit_rules_patch_tool,
        "dictionary": _submit_dict_patch_tool,
    }[file_name]()


def _build_siblings_block(
    *,
    file_name: str,
    current_kg: KnowledgeGraph,
    current_rules: RulesSet,
    current_dictionary: Dictionary,
) -> str:
    """将 NOT `file_name` 的**两个**文件渲染为 `## <name> (current)` JSON 区块
    — reviser 必须对齐的最新跨文件上下文。

    RC1（收敛 bug）：当 reviser 只看到**自己**的上一次输出时，
    revise-round-1 会让 kg/rules/dictionary 各自与**过时的**另外两个版本
    重新对齐，导致一个已不存在的状态坍塌。将当前兄弟文件（只读）交给
    reviser 是修复方案 — 它基于现实而非记忆对齐跨文件引用。reviser 自己的
    文件被排除（它是 `previous_output_json` 中的 BASELINE，不是兄弟）。"""
    artefacts = {
        "knowledge_graph": current_kg,
        "rules": current_rules,
        "dictionary": current_dictionary,
    }
    sections: list[str] = []
    for name, artefact in artefacts.items():
        if name == file_name:
            continue  # reviser 编辑的是这个 — 它是 baseline，不是兄弟
        sections.append(
            f"## {name} (current)\n```json\n{artefact.model_dump_json(indent=2)}\n```"
        )
    return "\n\n".join(sections)


async def run_single_writer_revision(
    *,
    client: AsyncAnthropic,
    cartographe_model: str,
    clinicien_model: str,
    lexicographe_model: str,
    device_label: str,
    raw_dump: str,
    registry: Registry,
    file_name: str,
    revision_brief: str,
    previous_output_json: str,
    current_kg: KnowledgeGraph,
    current_rules: RulesSet,
    current_dictionary: Dictionary,
    ground_truth_report: str | None = None,
    graph_truth: GraphTruth | None = None,
    max_query_turns: int = 4,
    stats: PhaseTokenStats | None = None,
) -> KnowledgeGraph | RulesSet | Dictionary:
    """使用 Auditor 的修订简报重新运行一个 writer。

    必须使用与原始输出相同的 model，使修订后的产物保持连贯性（同一品味，同一形状）。

    reviser 发出**外科手术式补丁**（类型化增量），而非整个产物：
    它强制使用角色的 `submit_*_patch` 工具，`apply_fn` 将该增量应用到当前产物。
    reviser 未命名的记录原样保留 — 这消除了完整重新发出的附带回归面。

    reviser 以**只读**方式看到当前两个兄弟文件的版本
    （`current_kg`/`current_rules`/`current_dictionary` 减去它自己的），
    使其基于现实而非记忆对齐跨文件引用 — RC1 修复（见 `_build_siblings_block`）。
    当提供 `graph_truth` 时，它还获得 mention 作用域的 ground-truth 报告
    和 `query_graph` 工具，用于在写入前验证存在性/电压/来源。

    格式良好但不可应用的补丁（`PatchApplyError`）降级为 no-op：
    返回当前产物不变，让重新审计重新标记。没有任何东西会损坏 —
    先前静默的回归变成了可见的 no-op。
    """
    # 在此处导入以避免循环导入（如果 orchestrator 将来导入本模块）。
    from api.pipeline.graph_truth import QUERY_GRAPH_TOOL, handle_query_graph
    from api.pipeline.prompts import REVISER_OPS_HELP, REVISER_USER_TEMPLATE

    model_for = {
        "knowledge_graph": cartographe_model,
        "rules": clinicien_model,
        "dictionary": lexicographe_model,
    }
    current_for = {
        "knowledge_graph": current_kg,
        "rules": current_rules,
        "dictionary": current_dictionary,
    }
    if file_name not in _REVISE_MAPPING:
        raise ValueError(f"Unknown file_name for revision: {file_name!r}")

    tool_name, patch_schema, apply_fn, log_label = _REVISE_MAPPING[file_name]
    model = model_for[file_name]
    current_artefact = current_for[file_name]

    # 只读兄弟上下文（最新的另外两个文件）+ 可选的确定性 ground-truth。
    # 两者都挂在修订 SUFFIX 上 — 共享的缓存前缀 message 结构保持**完全相同**，
    # 使 writer 缓存仍可命中。
    siblings_block = _build_siblings_block(
        file_name=file_name,
        current_kg=current_kg,
        current_rules=current_rules,
        current_dictionary=current_dictionary,
    )
    ground_truth_block = (
        "\n# Schematic ground truth (deterministic — verify via query_graph "
        "before doubting)\n" + ground_truth_report + "\n"
        if ground_truth_report
        else ""
    )

    # 保持共享缓存前缀完全相同，使缓存仍可命中。
    shared_prefix = WRITER_SHARED_USER_PREFIX_TEMPLATE.format(
        device_label=device_label,
        raw_dump=raw_dump,
        registry_json=registry.model_dump_json(indent=2),
    )
    revision_suffix = REVISER_USER_TEMPLATE.format(
        revision_brief=revision_brief,
        previous_output_json=previous_output_json,
        tool_name=tool_name,
        ops_help=REVISER_OPS_HELP[file_name],
        ground_truth_block=ground_truth_block,
        siblings_block=siblings_block,
    )
    first_block: dict = {
        "type": "text",
        "text": shared_prefix,
    }
    if not _needs_third_party_forced_tool_compat(model):
        first_block["cache_control"] = {"type": "ephemeral"}

    messages = [
        {
            "role": "user",
            "content": [
                first_block,
                {
                    "type": "text",
                    "text": revision_suffix,
                },
            ],
        }
    ]

    logger.info("[Revise] Patching file=%r (graph=%s)", file_name, graph_truth is not None)

    # 按 graph 存在性分派 — 与 auditor 一致。无 graph → 单次 forced-tool 调用
    # （tools = 仅该角色的补丁工具，使 reviser 不会意外发出兄弟的形状）。
    # 有 graph → 有上限的 agentic 循环，reviser 可在提交前针对真实原理图
    # 验证标识符。无论哪种情况，model 都返回 PATCH，而非产物。
    # 无法产出有效补丁的 reviser **绝不能**让整个构建崩溃：保留当前产物
    # （no-op），让重新审计重新标记，与下方不可应用补丁的处理一致。
    # 5 次尝试预算给 model 恢复空间（错误路由的 query 已被上游循环的
    # 重路由吸收，因此这些尝试只计数真正的 submit 失败）。
    try:
        if graph_truth is None:
            patch = await call_with_forced_tool(
                client=client,
                model=model,
                system=WRITER_SYSTEM,
                messages=messages,
                tools=[_submit_patch_tool_for(file_name)],
                forced_tool_name=tool_name,
                output_schema=patch_schema,
                max_attempts=5,
                log_label=log_label,
                stats=stats,
            )
        else:
            patch = await call_with_query_tools(
                client=client,
                model=model,
                system=WRITER_SYSTEM,
                messages=messages,
                query_tool=QUERY_GRAPH_TOOL,
                # 闭包将确定性 handler 绑定到此 pack 的 graph —
                # 循环只给我们原始 tool input，而非 graph 本身。
                query_handler=lambda i: handle_query_graph(graph_truth, i),
                submit_tool=_submit_patch_tool_for(file_name),
                submit_tool_name=tool_name,
                output_schema=patch_schema,
                max_query_turns=max_query_turns,
                max_attempts=5,
                log_label=log_label,
                stats=stats,
            )
    except RuntimeError as exc:
        logger.warning(
            "[Revise] file=%r reviser produced no valid patch (%s) — keeping "
            "current artefact (no-op)",
            file_name,
            exc,
        )
        return current_artefact

    # 确定性地应用增量。格式良好但不可应用的补丁（`PatchApplyError`）
    # 降级为 no-op：保留当前产物，记录日志，让重新审计重新标记。
    # 这将先前静默的重新发出回归转化为可见、安全的 no-op。
    try:
        return apply_fn(current_artefact, patch)
    except PatchApplyError as exc:
        logger.warning(
            "[Revise] file=%r patch inapplicable (%s) — keeping current artefact (no-op)",
            file_name,
            exc,
        )
        return current_artefact
