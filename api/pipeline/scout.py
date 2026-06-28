"""Phase 1 — Scout（网络调研）。

使用 Anthropic 原生 web_search 工具进行自主网络搜索，输出一份 Markdown
格式的原始调研报告（raw research dump）。无 JSON，无结构化格式。

Scout 运行一次；若产出的 dump 低于配置的阈值（最少症状数/组件数/来源数），
orchestrator 会以更宽泛的搜索后缀重新调用。`max_retries` 次失败后抛出
`ThinScoutDumpError`，pipeline 停止（不再为破产的 dump 付费运行后续阶段）。

┌─────────────────────────────────────────────────────────────────┐
│ 流程概览                                                        │
├─────────────────────────────────────────────────────────────────┤
│ 1. 构建 user prompt（设备名 + 重试后缀 + 焦点症状 + 设备类别） │
│ 2. 调用 Anthropic API（带 web_search 工具 + thinking 参数）     │
│ 3. 处理 pause_turn（模型调用 web_search 后等待结果 → 继续对话） │
│ 4. 提取 text 内容作为 dump                                      │
│ 5. assess_dump 评估 dump 质量（症状数/组件数/来源数）           │
│ 6. 不达标则重试（最多 max_retries 次）                          │
│ 7. 全部失败 → 抛出 ThinScoutDumpError                          │
├─────────────────────────────────────────────────────────────────┤
│ 第三方模型（mimo/qwen）不支持 web_search 工具，直接抛错         │
└─────────────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from anthropic import AsyncAnthropic

from api.pipeline.prompts import (
    SCOUT_RETRY_SUFFIX,
    SCOUT_SYSTEM,
    SCOUT_USER_TEMPLATE,
    device_kind_constraint,
)
from api.pipeline.tool_call import _needs_third_party_forced_tool_compat

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from api.pipeline.telemetry.token_stats import PhaseTokenStats

logger = logging.getLogger("wrench_board.pipeline.scout")


class ThinScoutDumpError(RuntimeError):
    """Scout dump 质量检查失败后抛出（所有重试均不达标）。"""


@dataclass(frozen=True)
class DumpAssessment:
    """Scout dump 的质量评估结果。"""
    symptoms: int      # 症状块数量（**Symptom:** 标记）
    components: int    # 独立组件数量（**<name>** 标记）
    sources: int       # 唯一 URL 数量
    viable: bool       # 是否达标（三项均 >= 阈值）

    def as_dict(self) -> dict[str, int | bool]:
        return {
            "symptoms": self.symptoms,
            "components": self.components,
            "sources": self.sources,
            "viable": self.viable,
        }


# ── 正则表达式：用于从 dump 中提取实体 ──
_SYMPTOM_RE = re.compile(r"^\s*-\s+\*\*Symptom:\*\*", re.MULTILINE)          # 匹配症状块
_URL_RE = re.compile(r"https?://[^\s)\]\"']+")                                # 匹配 URL
_COMPONENT_LINE_RE = re.compile(r"^\s*-\s+\*\*([^*]+?)\*\*", re.MULTILINE)   # 匹配组件行
_COMPONENTS_SECTION_RE = re.compile(                                          # 匹配组件章节
    r"##\s+Components mentioned.*?(?=\n##\s|\Z)",
    re.DOTALL | re.IGNORECASE,
)


def assess_dump(
    dump: str,
    *,
    min_symptoms: int,
    min_components: int,
    min_sources: int,
) -> DumpAssessment:
    """评估 Scout dump 中的负载实体数量。

    ┌─────────────────────────────────────────────────────────────────┐
    │ 评估指标                                                        │
    ├─────────────────────────────────────────────────────────────────┤
    │ symptoms   — '**Symptom:**' 块的数量                           │
    │ components — '## Components mentioned' 章节中独立组件名的数量   │
    │ sources    — dump 中唯一 URL 的数量（去重 + 去尾标点）          │
    │ viable     — 三项均 >= 对应阈值时为 True                       │
    └─────────────────────────────────────────────────────────────────┘
    """
    # 提取症状块数量
    symptoms = len(_SYMPTOM_RE.findall(dump))

    # 提取组件章节中的独立组件名
    section = _COMPONENTS_SECTION_RE.search(dump)
    if section:
        names = {m.group(1).strip() for m in _COMPONENT_LINE_RE.finditer(section.group(0))}
        components = len(names)
    else:
        components = 0

    # 提取唯一 URL 数量（去尾标点）
    sources = len({url.rstrip(".,;:") for url in _URL_RE.findall(dump)})

    # 判断是否达标
    viable = (
        symptoms >= min_symptoms and components >= min_components and sources >= min_sources
    )
    return DumpAssessment(
        symptoms=symptoms, components=components, sources=sources, viable=viable
    )


async def run_scout(
    *,
    client: AsyncAnthropic,
    model: str,
    device_label: str,
    device_kind: str | None = None,
    focus_symptom: str | None = None,
    max_continuations: int = 3,
    min_symptoms: int = 3,
    min_components: int = 3,
    min_sources: int = 3,
    max_retries: int = 1,
    stats: PhaseTokenStats | None = None,
    on_event: Callable[[dict], Awaitable[None]] | None = None,
) -> str:
    """执行 Phase 1 — 返回原始调研 Markdown dump。

    ┌─────────────────────────────────────────────────────────────────┐
    │ 参数说明                                                        │
    ├─────────────────────────────────────────────────────────────────┤
    │ client            — AsyncAnthropic 客户端                       │
    │ model             — 模型 ID（如 "claude-sonnet-4-6"）           │
    │ device_label      — 设备名称（如 "iPhone 11"）                  │
    │ device_kind       — 设备类别（可选，用于约束搜索范围）          │
    │ focus_symptom     — 焦点症状（可选，分配 3-4 个搜索查询）       │
    │ max_continuations — 最大续写轮次（pause_turn 后继续）           │
    │ min_symptoms      — 最低症状数阈值                              │
    │ min_components    — 最低组件数阈值                              │
    │ min_sources       — 最低来源数阈值                              │
    │ max_retries       — 最大重试次数（dump 不达标时重试）           │
    │ stats             — token 用量统计（可选）                      │
    │ on_event          — 进度事件回调（可选）                        │
    ├─────────────────────────────────────────────────────────────────┤
    │ 返回值                                                          │
    ├─────────────────────────────────────────────────────────────────┤
    │ str — 原始调研 Markdown dump                                    │
    ├─────────────────────────────────────────────────────────────────┤
    │ 错误处理                                                        │
    ├─────────────────────────────────────────────────────────────────┤
    │ - dump 不达标：重试最多 max_retries 次，每次加宽搜索范围        │
    │ - 全部失败：抛出 ThinScoutDumpError                            │
    │ - 第三方模型：直接抛出 RuntimeError（web_search 不支持）        │
    └─────────────────────────────────────────────────────────────────┘
    """
    logger.info(
        "[Scout] Starting research for device=%r · focus_symptom=%s",
        device_label,
        "yes" if focus_symptom else "no",
    )

    last_dump: str | None = None
    last_assessment: DumpAssessment | None = None

    # ── 重试循环 ──
    for attempt in range(max_retries + 1):
        dump = await _scout_once(
            client=client,
            model=model,
            device_label=device_label,
            device_kind=device_kind,
            focus_symptom=focus_symptom,
            max_continuations=max_continuations,
            attempt=attempt,
            stats=stats,
            on_event=on_event,
        )
        last_dump = dump
        # 评估 dump 质量
        last_assessment = assess_dump(
            dump,
            min_symptoms=min_symptoms,
            min_components=min_components,
            min_sources=min_sources,
        )
        logger.info(
            "[Scout] Attempt %d assessment: %s",
            attempt + 1,
            last_assessment.as_dict(),
        )
        # 达标则返回
        if last_assessment.viable:
            return dump

        logger.warning(
            "[Scout] Dump below thresholds (min sym=%d comp=%d src=%d) · "
            "attempt %d/%d",
            min_symptoms,
            min_components,
            min_sources,
            attempt + 1,
            max_retries + 1,
        )

    # 所有重试均不达标
    assert last_dump is not None and last_assessment is not None
    raise ThinScoutDumpError(
        f"Scout dump too thin after {max_retries + 1} attempts: "
        f"{last_assessment.as_dict()} (thresholds: "
        f"symptoms>={min_symptoms}, components>={min_components}, "
        f"sources>={min_sources})"
    )


def _build_focus_symptom_block(symptom: str) -> str:
    """将技师提供的焦点症状渲染为 Scout 指令。

    指示 Scout 将 3-4 个搜索查询专门分配给此症状，确保维修原因在首次
    pack 生成时就被覆盖，而不需要后续的 expand 补充。
    """
    return (
        "# Priority symptom from the technician\n"
        "\n"
        f"> {symptom.strip()}\n"
        "\n"
        "Allocate 3-4 of your web_search queries specifically to this symptom — "
        "combine it with the device name, with suspected refdes or MPN family, "
        "and with rework technique keywords. This symptom is the reason the "
        "tech opened the repair session; make sure your dump covers it as a "
        "named bullet under 'Known failure modes' (with a Resolution tag). "
        "The remaining queries may cover the device more broadly."
    )


def _build_user_prompt(
    *,
    device_label: str,
    attempt: int,
    device_kind: str | None = None,
    focus_symptom: str | None = None,
) -> str:
    """组装 Scout 的 user message。

    ┌─────────────────────────────────────────────────────────────────┐
    │ 组装逻辑                                                        │
    ├─────────────────────────────────────────────────────────────────┤
    │ 1. 基础模板：SCOUT_USER_TEMPLATE.format(device_label=...)       │
    │ 2. 焦点症状（可选）：追加 _build_focus_symptom_block            │
    │ 3. 重试（attempt > 0）：追加 SCOUT_RETRY_SUFFIX（加宽搜索）    │
    │ 4. 设备类别（可选）：追加 device_kind_constraint（权威约束）    │
    └─────────────────────────────────────────────────────────────────┘
    """
    user_prompt = SCOUT_USER_TEMPLATE.format(device_label=device_label)

    if focus_symptom:
        user_prompt = user_prompt + "\n\n" + _build_focus_symptom_block(focus_symptom)

    if attempt > 0:
        user_prompt = user_prompt + SCOUT_RETRY_SUFFIX

    user_prompt = user_prompt + device_kind_constraint(device_kind)

    return user_prompt


async def _scout_once(
    *,
    client: AsyncAnthropic,
    model: str,
    device_label: str,
    device_kind: str | None,
    focus_symptom: str | None,
    max_continuations: int,
    attempt: int,
    stats: PhaseTokenStats | None = None,
    on_event: Callable[[dict], Awaitable[None]] | None = None,
) -> str:
    """执行一次完整的 Scout 运行（含 pause_turn 续写处理）。

    ┌─────────────────────────────────────────────────────────────────┐
    │ 流程                                                            │
    ├─────────────────────────────────────────────────────────────────┤
    │ 1. 第三方模型检测 → web_search 不支持则直接抛错                 │
    │ 2. 构建 user prompt                                             │
    │ 3. 循环调用 API（最多 max_continuations + 1 轮）：              │
    │    - pause_turn → 继续对话（模型调用 web_search 后等待结果）    │
    │    - end_turn → 提取文本结束                                    │
    │    - 其他 → 警告并结束                                          │
    │ 4. 提取 text 内容作为 dump                                      │
    │ 5. 无文本则抛出 RuntimeError                                    │
    └─────────────────────────────────────────────────────────────────┘
    """
    # Scout 依赖 Anthropic 原生 web_search 工具，第三方模型不支持。
    # 快速失败，避免浪费 tokens。
    if _needs_third_party_forced_tool_compat(model):
        raise RuntimeError(
            f"[Scout] web_search tool is not supported by third-party model {model!r}. "
            "Scout requires Anthropic's native web_search_20250305 tool. "
            "Use a native Anthropic model (claude-*) for Scout, or provide a "
            "raw_dump_override to skip the research phase."
        )

    # 构建 user prompt
    user_prompt = _build_user_prompt(
        device_label=device_label,
        attempt=attempt,
        device_kind=device_kind,
        focus_symptom=focus_symptom,
    )

    messages: list[dict] = [{"role": "user", "content": user_prompt}]

    # 声明 web_search 工具（Anthropic 原生，最多调用 12 次）
    web_search_tool = {
        "type": "web_search_20250305",
        "name": "web_search",
        "max_uses": 12,
    }

    total_input = 0
    total_output = 0

    # ── API 调用循环（处理 pause_turn 续写） ──
    for iteration in range(max_continuations + 1):
        logger.info("[Scout] API call iteration=%d (attempt=%d)", iteration + 1, attempt + 1)
        # 发送实时子步骤事件：前端 timeline 显示 "recherche web · tour N"
        if on_event is not None:
            await on_event({
                "type": "phase_step", "phase": "scout", "step": "search_round",
                "index": iteration + 1,
            })
        # effort 旋钮：Opus 用 xhigh，其他用 high
        effort = "xhigh" if str(model).startswith("claude-opus-4-") else "high"
        third_party = _needs_third_party_forced_tool_compat(model)
        create_kwargs: dict = {
            "model": model,
            "max_tokens": 16000,
            "system": SCOUT_SYSTEM,
            "messages": messages,
            "tools": [web_search_tool],
        }
        # 第三方中继不支持 thinking 和 output_config，跳过
        if not third_party:
            create_kwargs["thinking"] = {"type": "adaptive", "display": "summarized"}
            create_kwargs["output_config"] = {"effort": effort}
        response = await client.messages.create(**create_kwargs)

        # 记录 token 用量
        total_input += response.usage.input_tokens
        total_output += response.usage.output_tokens
        if stats is not None:
            stats.record(
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                cache_read=getattr(response.usage, "cache_read_input_tokens", 0) or 0,
                cache_write=getattr(response.usage, "cache_creation_input_tokens", 0) or 0,
                model=getattr(response, "model", None),
            )

        # ── 处理不同的 stop_reason ──
        # pause_turn：模型调用了 web_search，等待搜索结果，继续对话
        if response.stop_reason == "pause_turn":
            logger.info("[Scout] pause_turn — extending conversation to continue")
            messages = [
                {"role": "user", "content": user_prompt},
                {"role": "assistant", "content": response.content},
            ]
            continue

        # end_turn：模型完成调研，提取文本
        if response.stop_reason == "end_turn":
            logger.info(
                "[Scout] Attempt %d research complete · tokens in=%d out=%d",
                attempt + 1,
                total_input,
                total_output,
            )
            break

        # max_tokens 或 refusal：警告并结束
        logger.warning("[Scout] Unexpected stop_reason=%r", response.stop_reason)
        break
    else:
        # 循环自然结束（未 break）：达到最大续写轮次
        logger.warning(
            "[Scout] Hit max_continuations=%d without natural end_turn", max_continuations
        )

    # ── 提取文本内容 ──
    text_parts = [block.text for block in response.content if block.type == "text"]
    dump = "\n\n".join(t for t in text_parts if t.strip())

    # 无文本则抛错
    if not dump:
        raise RuntimeError(
            "[Scout] Produced no text output. Response had "
            f"{len(response.content)} content blocks with types "
            f"{[b.type for b in response.content]}"
        )

    logger.info("[Scout] Web search finished · dump_length=%d chars", len(dump))
    return dump
