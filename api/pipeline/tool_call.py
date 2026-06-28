"""共享辅助 — 运行带强制 tool 的 Anthropic 请求并经 Pydantic 校验。

若模型返回的 tool 输出无法通过 schema 校验，则用 follow-up system 后缀
 surfaced 校验错误后重试一次。针对 beta 路径中更常见的
「200 OK 但 tool 形状畸形」失败模式。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Callable
from typing import TYPE_CHECKING, TypeVar

import httpx
from anthropic import APIConnectionError, AsyncAnthropic
from pydantic import BaseModel, ValidationError

if TYPE_CHECKING:
    from api.pipeline.telemetry.token_stats import PhaseTokenStats

# 类型变量：T 是 BaseModel 的子类，用于泛型返回值类型标注
T = TypeVar("T", bound=BaseModel)

logger = logging.getLogger("wrench_board.pipeline.tool_call")

# ── 传输层重试配置 ──
# 瞬时 TRANSPORT 失败（对端中途关闭流、连接拒绝/重置）。
# SDK 的 max_retries 仅重发 INITIAL 请求 — 迭代流时断开
# 会冒出原始 httpx 错误（2026-06-10 线上观测：一次 RemoteProtocolError
# 杀死整次 92 页摄取）。这些有独立的小额就地重试预算：属基础设施噪音，
# 非模型质量失败，故不消耗 validation 尝试，且永不改动 prompt
#（改动也会 bust prompt cache）。
_TRANSPORT_ERRORS = (httpx.TransportError, APIConnectionError)
_TRANSPORT_TRIES = 3        # 最多重试 3 次
_TRANSPORT_BACKOFF_S = (2.0, 5.0)  # 退避策略：第 1 次等 2 秒，第 2 次等 5 秒

# ── 第三方模型关键字 ──
# 模型名包含这些关键字时，启用第三方兼容模式（跳过 thinking、剥离 cache_control 等）
_THIRD_PARTY_MODEL_KEYWORDS = ("qwen", "mimo")


def _needs_third_party_forced_tool_compat(model: str) -> bool:
    """判断模型是否需要第三方兼容降级（跳过 thinking、剥离 cache_control 等）。"""
    lower = str(model).lower()
    return any(kw in lower for kw in _THIRD_PARTY_MODEL_KEYWORDS)


def _append_critical_tool_instruction(
    system: str | list[dict],
    instruction: str,
) -> str | list[dict]:
    """在 system prompt 末尾追加强制 tool 调用指令，不扰动调用方结构。"""
    suffix = f"\n\nCRITICAL: {instruction}"
    if isinstance(system, list):
        return list(system) + [{"type": "text", "text": suffix.lstrip()}]
    return system + suffix


async def _create_with_transport_retry(
    *,
    client: AsyncAnthropic,
    stream_kwargs: dict,
    log_label: str,
):
    """发起一次 Messages API 流式请求，带就地 transport 重试预算。

    抽离以便包内每次 API 调用（单次 forced-tool 辅助与 agentic query 循环）
    获得相同重试语义且无重复。行为与被替换循环字节级一致：

      - 仅重试 `_TRANSPORT_ERRORS`（对端中途关闭 / 连接拒绝重置）—
        基础设施噪音，非模型质量失败，故不消耗 validation 尝试、
        不改动 prompt（改动会 bust 上游 prompt cache）。
      - 最多 `_TRANSPORT_TRIES` 次，退避 `_TRANSPORT_BACKOFF_S`；
        最后一次失败原样重抛底层 transport 错误。
      - 非瞬时错误（如 400）是确定性的 — 首次即传播（重试仅浪费时间）。

    返回最终组装的消息。
    """
    for transport_try in range(1, _TRANSPORT_TRIES + 1):
        try:
            async with client.messages.stream(**stream_kwargs) as stream:
                return await stream.get_final_message()
        except _TRANSPORT_ERRORS as exc:
            if transport_try >= _TRANSPORT_TRIES:
                logger.error(
                    "[%s] transport error persisted after %d tries: %s",
                    log_label, _TRANSPORT_TRIES, exc,
                )
                raise
            delay = _TRANSPORT_BACKOFF_S[min(transport_try - 1, len(_TRANSPORT_BACKOFF_S) - 1)]
            logger.warning(
                "[%s] transient transport error (%s: %s) — retrying in %.0fs (%d/%d)",
                log_label, type(exc).__name__, exc, delay, transport_try, _TRANSPORT_TRIES - 1,
            )
            await asyncio.sleep(delay)


async def _create_nonstream_with_transport_retry(
    *,
    client: AsyncAnthropic,
    request_kwargs: dict,
    log_label: str,
):
    """创建一次非流式 Messages 响应，带相同的 transport 重试预算。"""
    for transport_try in range(1, _TRANSPORT_TRIES + 1):
        try:
            return await client.messages.create(**request_kwargs)
        except _TRANSPORT_ERRORS as exc:
            if transport_try >= _TRANSPORT_TRIES:
                logger.error(
                    "[%s] transport error persisted after %d tries: %s",
                    log_label, _TRANSPORT_TRIES, exc,
                )
                raise
            delay = _TRANSPORT_BACKOFF_S[min(transport_try - 1, len(_TRANSPORT_BACKOFF_S) - 1)]
            logger.warning(
                "[%s] transient transport error (%s: %s) — retrying in %.0fs (%d/%d)",
                log_label, type(exc).__name__, exc, delay, transport_try, _TRANSPORT_TRIES - 1,
            )
            await asyncio.sleep(delay)


def effort_for_model(model: str) -> str:
    """与 adaptive thinking 配对的 effort 旋钮，各调用方共享。

    按 Anthropic 4.7/4.8 指南，`xhigh` 为 Opus tier 甜点；Sonnet/Haiku
    上 xhigh 会 400 则回退 `high`。集中定义以免 direct 路径（下）与
    batch-vision 孪生漂移。
    """
    return "xhigh" if str(model).startswith("claude-opus-4-") else "high"


async def call_with_forced_tool(
    *,
    client: AsyncAnthropic,
    model: str,
    system: str | list[dict],
    messages: list[dict],
    tools: list[dict],
    forced_tool_name: str,
    output_schema: type[T],
    max_attempts: int = 2,
    max_tokens: int = 16000,
    log_label: str = "tool_call",
    stats: PhaseTokenStats | None = None,
    thinking_budget: int | None = None,
) -> T:
    """以 `tool_choice` 强制为 `forced_tool_name` 调用 Messages API 并校验。

    校验失败时用 system 后缀告知模型错在哪并重试。`max_attempts` 次后抛错。

    ┌─────────────────────────────────────────────────────────────────┐
    │ 核心流程                                                        │
    ├─────────────────────────────────────────────────────────────────┤
    │ 1. 首次尝试：thinking 开启 → tool_choice="auto"                │
    │ 2. 若模型未调 tool：关闭 thinking → tool_choice="forced"       │
    │ 3. 若 payload 校验失败：附加错误信息重试                        │
    │ 4. 2 次均失败 → 抛出 RuntimeError                              │
    ├─────────────────────────────────────────────────────────────────┤
    │ 第三方模型（mimo/qwen）特殊处理：                               │
    │ - 跳过 thinking 参数（中继不支持）                              │
    │ - 剥离 cache_control（中继不支持）                              │
    │ - 使用非流式请求（中继兼容性更好）                              │
    │ - max_tokens 限制为 8192（中继限制）                            │
    ├─────────────────────────────────────────────────────────────────┤
    │ thinking 行为                                                   │
    ├─────────────────────────────────────────────────────────────────┤
    │ - thinking_budget 非 None → thinking_active=True               │
    │ - API 限制：thinking 不能 + forced tool（会 400）              │
    │ - 所以 thinking 开启时用 tool_choice="auto"                    │
    │ - 模型可能只返回 thinking 未调 tool → 关闭 thinking 重试       │
    └─────────────────────────────────────────────────────────────────┘
    """
    # last_error：记录最后一次错误信息，用于重试时告知模型
    last_error: str | None = None
    effective_system: str | list[dict] = system
    # 第三方模型兼容检测
    third_party_compat = _needs_third_party_forced_tool_compat(model)
    # thinking 强制 tool_choice="auto"（API 拒绝 thinking + forced tool），
    # 模型可能只返回 thinking、无 tool call。该 miss 时重试去掉 thinking
    # → forced tool_choice → tool 有保证（且不再在已超页的页上烧 thinking 预算）。
    thinking_active = thinking_budget is not None

    # ── 重试循环 ──
    for attempt in range(1, max_attempts + 1):
        # 第二次尝试：附加上次错误信息到 system prompt，告诉模型错在哪
        if attempt > 1 and last_error:
            retry_suffix = (
                "\n\n---\nPREVIOUS ATTEMPT FAILED VALIDATION:\n"
                + last_error
                + f"\n\nRetry — emit a valid {forced_tool_name} payload."
            )
            # 后缀追加而不扰动上游 cache 条目（Anthropic cache 按前缀键 —
            #  prepend 或改首块会在每次重试 bust cache）。
            if isinstance(system, list):
                effective_system = list(system) + [
                    {"type": "text", "text": retry_suffix.lstrip()}
                ]
            else:
                effective_system = system + retry_suffix

        # 构建 system prompt
        request_system = effective_system
        if third_party_compat:
            # 第三方模型：追加强制 tool 调用指令
            request_system = _append_critical_tool_instruction(
                request_system,
                f"You MUST call the {forced_tool_name} tool now. Do NOT output text-only responses.",
            )
            # 第三方中继（tinno/qwen）不支持 Anthropic prompt cache 的
            # `cache_control` 字段，会报 "Unexpected item type in content"。
            # 剥离所有 content block 上的 cache_control。
            if isinstance(request_system, list):
                request_system = [
                    {k: v for k, v in block.items() if k != "cache_control"}
                    for block in request_system
                ]

        # 带 thinking 的 tool_choice 规则（Opus 4.7/4.8）：
        #   - 默认：`{"type": "tool", "name": forced_tool_name}` — 完全
        #     强制，确定性结构化输出。
        #   - 设 `thinking_budget` 时：仅 `{"type": "auto"}` 可用。
        #     Anthropic API 拒绝 thinking + (`tool` | `any`)，报错
        #     "Thinking may not be enabled when tool_choice forces tool use"
        #     （2026-04-26 线上验证 req_011CaRamyfazF6nwgzTJSQMu）。`auto` 下
        #     模型决定是否调 tool；system prompt 明确要求总是发出 tool（见
        #     page_vision SYSTEM_PROMPT）。若模型返回文本，parser 经 system
        #     后缀重试。
        #   - Opus 4.7/4.8 亦拒绝 `thinking.type="enabled"` — 仅接受
        #     `"adaptive"`。整数 `thinking_budget` 参数为源码兼容保留，
        #     adaptive 下不用其值；配对 adaptive 与
        #     `output_config.effort="high"` 以引导更深推理。
        #
        # max_tokens >= ~16k 须流式（否则 SDK 以「可能超 10 分钟」拒绝非流）。
        if thinking_active:
            tool_choice_param: dict = {"type": "auto"}
        else:
            tool_choice_param = {"type": "tool", "name": forced_tool_name}

        # 构建 API 请求参数
        stream_kwargs: dict = dict(
            model=model,
            max_tokens=max_tokens,
            system=request_system,
            messages=messages,
            tools=tools,
            tool_choice=tool_choice_param,
        )
        if third_party_compat:
            # 第三方中继：限制 max_tokens、剥离 tools 中的 cache_control
            stream_kwargs["max_tokens"] = min(max_tokens, 8192)
            # 第三方中继（如 tinno qwen）不支持 thinking 参数，完全省略
            # 而不是发送 {"type": "disabled"}（会触发 "Unexpected item type" 错误）
            # 同时剥离 tools 定义中的 cache_control 字段
            stream_kwargs["tools"] = [
                {k: v for k, v in tool.items() if k != "cache_control"}
                for tool in tools
            ]
        elif thinking_active:
            # 原生 Anthropic 模型：启用 adaptive thinking + effort 旋钮
            # Opus 4.7/4.8 默认 `thinking.display` 为 "omitted"（静默），
            # summarized 块到不了观察者。显式 opt-in。
            stream_kwargs["thinking"] = {"type": "adaptive", "display": "summarized"}
            stream_kwargs.setdefault("output_config", {})["effort"] = (
                effort_for_model(model)
            )

        # 发起 API 请求（流式或非流式）
        if third_party_compat:
            response = await _create_nonstream_with_transport_retry(
                client=client, request_kwargs=stream_kwargs, log_label=log_label,
            )
        else:
            response = await _create_with_transport_retry(
                client=client, stream_kwargs=stream_kwargs, log_label=log_label,
            )

        # 从响应中提取目标 tool_use 块
        tool_use = next(
            (b for b in response.content if b.type == "tool_use" and b.name == forced_tool_name),
            None,
        )

        # 记录 token 用量
        cache_read = getattr(response.usage, "cache_read_input_tokens", 0) or 0
        cache_write = getattr(response.usage, "cache_creation_input_tokens", 0) or 0
        logger.info(
            "[%s] attempt=%d usage in=%d out=%d cache_read=%d cache_write=%d",
            log_label,
            attempt,
            response.usage.input_tokens,
            response.usage.output_tokens,
            cache_read,
            cache_write,
        )
        if stats is not None:
            stats.record(
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                cache_read=cache_read,
                cache_write=cache_write,
                model=getattr(response, "model", None),
            )
        if cache_read > 0:
            logger.info("[Cache] Hit for %s (read=%d tokens)", log_label, cache_read)

        # ── 处理无 tool_use 的情况 ──
        if tool_use is None:
            got = [b.type for b in response.content]
            # 尝试从文本内容中恢复 JSON（某些模型忽略 tool_choice 返回纯文本）
            fallback = _try_extract_json_from_text(response.content, output_schema)
            if fallback is not None:
                logger.warning(
                    "[%s] no tool_use block — recovered from text content on attempt=%d",
                    log_label,
                    attempt,
                )
                return fallback
            last_error = f"Expected a tool_use block named '{forced_tool_name}', got blocks: {got}"
            logger.warning("[%s] %s", log_label, last_error)
            if thinking_active:
                # 模型思考了但未调 tool。去掉 thinking 使下次尝试强制 tool
                #（确定性）而非再赌一次仅 thinking 的超跑。
                thinking_active = False
                logger.warning("[%s] disabling thinking → forced tool_choice on retry", log_label)
            continue

        # ── 校验 tool_use payload ──
        try:
            validated = output_schema.model_validate(tool_use.input)
            return validated
        except ValidationError as exc:
            # 防御性 unwrap：无 thinking 的 forced tool_choice 下，Opus
            # 偶尔把嵌套结构字符串化 — 如发
            # `{"rules": "<整份 RulesSet 的 JSON>"}` 而非类型化 list。
            # 在烧掉另一次重试前先尝试恢复。
            recovered = _try_unwrap(tool_use.input, output_schema)
            if recovered is not None:
                logger.warning(
                    "[%s] recovered from stringified payload on attempt=%d",
                    log_label,
                    attempt,
                )
                return recovered

            last_error = (
                f"Validation failed for {forced_tool_name} payload:\n{exc}\n"
                "Payload received: "
                + json.dumps(tool_use.input, ensure_ascii=False, indent=2)[:2000]
            )
            logger.warning(
                "[%s] attempt=%d validation failed: %s",
                log_label,
                attempt,
                str(exc).replace("\n", " ")[:500],
            )

    # 所有尝试均失败
    raise RuntimeError(
        f"[{log_label}] Failed to produce a valid {forced_tool_name} output after "
        f"{max_attempts} attempts. Last error:\n{last_error}"
    )


def _record_usage(response, stats: PhaseTokenStats | None, log_label: str, turn_desc: str) -> None:
    """记录本 turn 用量并累加到 `stats`（两辅助函数共享）。

    从主体抽出，使 agentic 循环像 `call_with_forced_tool` 一样累加
    每一 turn — input/output + cache read/write 计数器。
    """
    cache_read = getattr(response.usage, "cache_read_input_tokens", 0) or 0
    cache_write = getattr(response.usage, "cache_creation_input_tokens", 0) or 0
    logger.info(
        "[%s] %s usage in=%d out=%d cache_read=%d cache_write=%d",
        log_label, turn_desc,
        response.usage.input_tokens, response.usage.output_tokens,
        cache_read, cache_write,
    )
    if stats is not None:
        stats.record(
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            cache_read=cache_read,
            cache_write=cache_write,
            model=getattr(response, "model", None),
        )
    if cache_read > 0:
        logger.info("[Cache] Hit for %s (read=%d tokens)", log_label, cache_read)


def _answer_query_blocks(
    query_uses: list,
    query_handler: Callable[[dict], dict],
    log_label: str,
) -> list[dict]:
    """对每个 query tool_use 块运行确定性 `query_handler`，
    返回各自 id 对应的 `tool_result` 内容块。

    submit 伴随 query 路径与仅 query 路径共享，使两种方式以相同方式
    回答每个并行 query 块（API 要求每个 tool_use 一个 tool_result，
    Opus 会并行发 query_graph）。handler 约定永不 raise；防御性守卫
    仍返回 is_error stub，而非留下 orphan 块（orphan 会使下次请求 400，
    stub 保持协议合法）。
    """
    results: list[dict] = []
    for b in query_uses:
        try:
            payload = query_handler(b.input)
            results.append({
                "type": "tool_result",
                "tool_use_id": b.id,
                "content": json.dumps(payload, ensure_ascii=False),
            })
        except Exception as exc:  # handler 约定 no-raise；双保险
            logger.warning("[%s] query_handler raised: %s", log_label, exc)
            results.append({
                "type": "tool_result",
                "tool_use_id": b.id,
                "is_error": True,
                "content": f"query failed: {exc}",
            })
    return results


def _looks_like_query(payload: object, query_tool: dict) -> bool:
    """当发往 SUBMIT tool 的 payload 实为 query_graph 调用时为 True
    （其键均属于 query tool 的 input schema）。Opus 在 tool_choice='any' 下
    有时把校验路由进 submit tool（如 {op:'who_powers', net:'X'}）；
    识别后循环按 query 回答，而非烧 submit 尝试并搞垮构建。"""
    if not isinstance(payload, dict) or not payload:
        return False
    qprops = set(query_tool.get("input_schema", {}).get("properties", {}))
    return bool(qprops) and set(payload).issubset(qprops)


# 软 query 上限命中后强制 submit，但密集 pack 上的 reviser 常把最后一次
# graph 校验路由进 submit tool（query 形 payload）。再多几 turn 回答该
# 伪装 query 而非失败 — 查找是确定性且免费，剥夺它曾使 reviser no-op。
# grace 有限，故只会误路由的模型仍会终止（然后 payload 走正常
# submit 校验 / protocol-miss 路径，由 `max_attempts` 限定）。
_POST_CAP_QUERY_REROUTE_GRACE = 3


async def call_with_query_tools(
    *,
    client: AsyncAnthropic,
    model: str,
    system: str | list[dict],
    messages: list[dict],
    query_tool: dict,
    query_handler: Callable[[dict], dict],
    submit_tool: dict,
    submit_tool_name: str,
    output_schema: type[T],
    max_query_turns: int = 6,
    max_attempts: int = 2,
    max_tokens: int = 16000,
    log_label: str = "tool_call",
    stats: PhaseTokenStats | None = None,
) -> T:
    """Agentic 变体：允许模型多次调用确定性 query tool 对照电气图
    校验标识符，再调用 submit tool。

    每次 API 提供 `[query_tool, submit_tool]`。query 预算内
    `tool_choice={"type":"any"}` 让模型选 query 或 submit：

      - **query** → 运行 `query_handler(block.input)`（确定性、不 raise），
        将 JSON 编码结果作为 `tool_result` 喂回并循环。handler 调用计入
        `max_query_turns`。
      - **submit** → 用与 `call_with_forced_tool` 相同的 `_try_unwrap`
        容忍度校验 `block.input`。合法 → 返回。非法 → 以 `is_error`
        tool_result 喂回校验错误并重试，submit 校验最多 `max_attempts`
        次后抛错。

    `max_query_turns` 次 query 答完后，以
    `tool_choice={"type":"tool","name":submit_tool_name}` 重发，下一 turn
    强制 submit（不再 graph 查找 — 预算已花）。

    **Protocol-miss 策略：** 需要 submit 的 turn 未产生可用 submit
    （上限已到却返回 query 块或根本没有 tool 块）视为校验失败 — 消耗
    `max_attempts` 之一并以 forced submit 重请求。单一计数器限定整个
    不收敛尾部（校验失败与 protocol miss），循环不会对顽固模型无限转。

    单次调用的 transport 抖动走共享就地重试
    （`_create_with_transport_retry`）— 不消耗 attempt 或 query turn。
    """
    convo: list[dict] = list(messages)  # 本地副本 — agent 工作时增长
    third_party_compat = _needs_third_party_forced_tool_compat(model)
    queries_used = 0
    submit_attempts = 0
    post_cap_reroutes = 0  # 上限后回答的伪装 query（有界 grace）
    last_error: str | None = None
    tools = [query_tool, submit_tool]

    # max_tokens >= ~16k 须流式（SDK 在 10 分钟界上拒绝非流），同 call_with_forced_tool。
    while True:
        # query 预算门控 tool_choice：预算内可 query 或 submit（"any"）；
        # 花完后强制 submit 以保证终止。
        cap_reached = queries_used >= max_query_turns
        if cap_reached:
            tool_choice_param: dict = {"type": "tool", "name": submit_tool_name}
        else:
            tool_choice_param = {"type": "any"}

        stream_kwargs: dict = dict(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=convo,
            tools=tools,
            tool_choice=tool_choice_param,
        )
        if third_party_compat:
            stream_kwargs["system"] = _append_critical_tool_instruction(
                system,
                f"You MUST call either the {query_tool['name']} tool or the {submit_tool_name} tool. "
                f"When ready to finalize, call the {submit_tool_name} tool. Do NOT output text-only responses.",
            )
            stream_kwargs["max_tokens"] = min(max_tokens, 8192)
            stream_kwargs["thinking"] = {"type": "disabled"}
            response = await _create_nonstream_with_transport_retry(
                client=client, request_kwargs=stream_kwargs, log_label=log_label,
            )
        else:
            response = await _create_with_transport_retry(
                client=client, stream_kwargs=stream_kwargs, log_label=log_label,
            )
        _record_usage(
            response, stats, log_label,
            turn_desc=f"queries={queries_used} attempts={submit_attempts}",
        )

        # Anthropic API 要求上一 assistant turn 的每个 tool_use 都有 tool_result
        # — orphan 一个则下次请求 400。Opus 在 tool_choice="any" 下常并行
        # 多个 tool call（两个 query_graph，或 query + submit），须收集全部
        # 并按 id 各自回答 — 绝不能 `next()` 只取一个。
        all_tool_uses = [b for b in response.content if b.type == "tool_use"]
        submit_use = next(
            (b for b in all_tool_uses if b.name == submit_tool_name), None,
        )
        query_uses = [b for b in all_tool_uses if b.name == query_tool["name"]]

        # --- 存在且 VALID 的 submit：对话结束，无需再答 -----------------------
        # 合法 submit 无论是否伴随 query 块都终止 — 直接返回对象，
        # 不再发请求，并行 query 块不会被 orphan（没有「下一次」拒绝它们）。
        if submit_use is not None:
            # 误路由的 query：tool_choice="any" 下模型有时用 query_graph
            # payload 调 SUBMIT tool（键全属 query tool）。那是校验而非失败
            # submit — 经 query handler 回答并继续，烧 query turn 而非 submit
            # attempt。预算内自由；上限后再允许多 `_POST_CAP_QUERY_REROUTE_GRACE`
            # turn，因密集 pack 的 reviser 常需最后一次查找才能 emit 正确 patch
            # — 在那里失败曾饿死 reviser 成 no-op。grace 有界，只会误路由的
            # 模型仍会终止。
            reroute_ok = _looks_like_query(submit_use.input, query_tool) and (
                not cap_reached or post_cap_reroutes < _POST_CAP_QUERY_REROUTE_GRACE
            )
            if reroute_ok:
                tool_results = _answer_query_blocks(query_uses, query_handler, log_label)
                rerouted = _answer_query_blocks([submit_use], query_handler, log_label)
                tool_results.extend(rerouted)
                queries_used += len(query_uses) + 1
                if cap_reached:
                    post_cap_reroutes += 1
                logger.warning(
                    "[%s] re-routed a query payload mis-sent to %s (op/keys=%s)%s",
                    log_label, submit_tool_name, sorted(submit_use.input),
                    " [post-cap grace]" if cap_reached else "",
                )
                convo.append({"role": "assistant", "content": response.content})
                convo.append({"role": "user", "content": tool_results})
                continue
            submit_attempts += 1
            try:
                return output_schema.model_validate(submit_use.input)
            except ValidationError as exc:
                # 与 forced-tool 辅助相同的防御 unwrap：Opus 有时字符串化
                # 嵌套结构 — 烧重试前先恢复。
                recovered = _try_unwrap(submit_use.input, output_schema)
                if recovered is not None:
                    logger.warning(
                        "[%s] recovered from stringified submit payload (attempt=%d)",
                        log_label, submit_attempts,
                    )
                    return recovered

                last_error = (
                    f"Validation failed for {submit_tool_name} payload:\n{exc}\n"
                    "Payload received: "
                    + json.dumps(submit_use.input, ensure_ascii=False, indent=2)[:2000]
                )
                logger.warning(
                    "[%s] attempt=%d submit validation failed: %s",
                    log_label, submit_attempts, str(exc).replace("\n", " ")[:500],
                )
                if submit_attempts >= max_attempts:
                    break
                # 为本 turn 每个 tool_use 构建 tool_result：失败 submit 的 is_error
                # 加上每个伴随 query 块的正常 handler 结果。只答 submit 会 orphan
                # query 块并使重试 400。每个已答 query 也计入上限（确实跑了）。
                tool_results = _answer_query_blocks(
                    query_uses, query_handler, log_label,
                )
                queries_used += len(query_uses)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": submit_use.id,
                    "is_error": True,
                    "content": last_error,
                })
                convo.append({"role": "assistant", "content": response.content})
                convo.append({"role": "user", "content": tool_results})
                continue

        # --- 仅 query 路径：预算允许时回答全部 query 块 -----------------------
        # `not cap_reached` 在本 turn 前按预算门控；即使本批跨过上限也答全
        # （本 turn 每个块必须答），上限再门控下一请求的 tool_choice。
        if query_uses and not cap_reached:
            tool_results = _answer_query_blocks(query_uses, query_handler, log_label)
            queries_used += len(query_uses)
            convo.append({"role": "assistant", "content": response.content})
            convo.append({"role": "user", "content": tool_results})
            continue

        # --- protocol miss：需要 submit 却无可用 submit ----------------------
        # 上限已到（submit 被强制）却模型仍 query，或根本没有可用 tool 块。
        # 计为校验失败（共享 `submit_attempts` 预算 — 这使整个不收敛尾部有界）
        # 并以 forced submit 重请求。
        submit_attempts += 1
        got = [b.type for b in response.content]
        last_error = (
            f"Expected a '{submit_tool_name}' tool_use, got blocks: {got} "
            f"(query budget {'exhausted' if cap_reached else 'available'})."
        )
        logger.warning("[%s] protocol miss (attempt=%d): %s", log_label, submit_attempts, last_error)
        if submit_attempts >= max_attempts:
            break
        # 强制关闭预算，使重请求确定性强制 submit。
        queries_used = max_query_turns
        # 关键：在纯文本 nudge 前，为本响应每个 orphan tool_use 发 stub is_error
        # tool_result。旧代码追加 assistant 内容（可能含 tool_use）后跟裸 TEXT
        # user 消息 → 那些块全 orphan → 400。tool_use turn 后只能跟 user turn，
        # 其首块须覆盖全部 tool_result；文本 nudge 同 turn 携带。
        stub_results = [
            {
                "type": "tool_result",
                "tool_use_id": b.id,
                "is_error": True,
                "content": (
                    f"Ignored: the query budget is exhausted — you must call "
                    f"{submit_tool_name} now, not {b.name}."
                    if b.name == query_tool["name"]
                    else f"Ignored unexpected tool '{b.name}'. Call {submit_tool_name} now."
                ),
            }
            for b in all_tool_uses
        ]
        nudge_content = stub_results + [{
            "type": "text",
            "text": f"You must now call the {submit_tool_name} tool to finish.",
        }]
        convo.append({"role": "assistant", "content": response.content})
        convo.append({"role": "user", "content": nudge_content})

    raise RuntimeError(
        f"[{log_label}] Failed to produce a valid {submit_tool_name} output after "
        f"{submit_attempts} attempts. Last error:\n{last_error}"
    )


def _try_extract_json_from_text(content_blocks: list, output_schema: type[T]) -> T | None:
    """Extract JSON from text blocks when a model ignores tool_use and emits raw JSON.

    Some models (e.g. mimo-v2.5 via newapi proxy) don't honour
    ``tool_choice={"type":"tool"}`` — they return a single text block containing
    the full JSON payload instead of a tool_use block. This fallback scans each
    text block, attempts ``json.loads``, and validates against the schema.

    Tries the full text first, then searches for fenced or bare JSON substrings.
    Returns the validated model or ``None``.
    """
    text_parts = [b.text for b in content_blocks if getattr(b, "type", None) == "text" and getattr(b, "text", None)]
    if not text_parts:
        return None
    full_text = "\n".join(text_parts).strip()
    candidates: list[str] = []
    candidates.append(full_text)
    for m in re.finditer(r"```(?:json)?\s*\n?([\s\S]*?)```", full_text):
        candidates.append(m.group(1).strip())
    for m in re.finditer(r"\{[\s\S]*\}", full_text):
        candidates.append(m.group(0).strip())
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(parsed, dict):
            continue
        try:
            return output_schema.model_validate(parsed)
        except ValidationError:
            continue
    return None


def _try_unwrap(payload: object, output_schema: type[T]) -> T | None:
    """从三种观测到的 tool input 畸形中恢复。

    Case A — 某字段含 JSON 字符串（模型双重编码嵌套 list/dict）。
             `_deep_unwrap_strings` 遍历整 payload，对像 JSON 的字符串
             任意深度 json.loads。处理 Haiku 类多层字符串化级联。
    Case B — 整目标塌进单字段，如
             `{"rules": "<{schema_version, rules} 的 JSON>"}`。深度 unwrap 后
             尝试用各顶层值校验目标 schema。
    Case C — qwen 模型字段名不规范（pin→number、缺失 page、value 结构错误）。
             `_normalize_qwen_fields` 标准化这些字段。

    返回校验后的模型；无法恢复合法 payload 时返回 None。
    """
    if not isinstance(payload, dict):
        return None

    unwrapped = _deep_unwrap_strings(payload)

    # 获取顶层 page 作为 hint，用于填充缺失的 page 字段
    page_hint = unwrapped.get("page") if isinstance(unwrapped, dict) else None

    # 标准化 qwen 字段
    normalized = _normalize_qwen_fields(unwrapped, page_hint)

    if normalized != payload:
        try:
            return output_schema.model_validate(normalized)
        except ValidationError as exc:
            logger.debug(
                "normalize+unwrap revalidation failed: %s",
                str(exc).replace("\n", " ")[:300],
            )

    if isinstance(normalized, dict):
        for value in normalized.values():
            if isinstance(value, dict):
                try:
                    return output_schema.model_validate(value)
                except ValidationError:
                    continue

    return None


def _deep_unwrap_strings(obj: object) -> object:
    """递归解析内容像 JSON 的字符串为真实值。

    遍历 dict 与 list；对每个 strip 后以 '[' 或 '{' 开头的 str 尝试
    json.loads，并对解析结果继续递归 — 部分 Haiku 失败为双重字符串化
    （dict 列表中某 dict 的子字段本身又是字符串化 list）。非 JSON 字符串
    与非容器值原样返回。
    """
    if isinstance(obj, str):
        stripped = obj.strip()
        if stripped and stripped[0] in "[{":
            try:
                return _deep_unwrap_strings(json.loads(stripped))
            except (json.JSONDecodeError, ValueError):
                pass
        return obj
    if isinstance(obj, list):
        return [_deep_unwrap_strings(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _deep_unwrap_strings(v) for k, v in obj.items()}
    return obj


def _normalize_qwen_fields(obj: object, page_hint: int | None = None) -> object:
    """标准化 qwen 模型的不规范字段名和缺失字段。

    qwen3-vl-plus 等模型有时不遵循 tool schema：
    - `pin` 应为 `number`（PagePin）
    - `nodes[].page` 缺失 → 从顶层 page 填充
    - `nets[].page` 缺失 → 从顶层 page 填充
    - `value.{nominal, unit}` 应为 `value.raw`（ComponentValue）
    """
    if isinstance(obj, list):
        return [_normalize_qwen_fields(x, page_hint) for x in obj]
    if not isinstance(obj, dict):
        return obj

    result = {}
    for k, v in obj.items():
        # 字段名映射：pin → number
        if k == "pin":
            result["number"] = _normalize_qwen_fields(v, page_hint)
        else:
            result[k] = _normalize_qwen_fields(v, page_hint)

    # 自动填充缺失的 page 字段
    if "page" not in result and page_hint is not None:
        # 对 nodes、nets、cross_page_refs 中的元素填充 page
        if "refdes" in result or "local_id" in result or "direction" in result:
            result["page"] = page_hint

    # ComponentValue 结构转换：{nominal, unit} → raw
    if "value" in result and isinstance(result["value"], dict):
        val = result["value"]
        if "raw" not in val and ("nominal" in val or "unit" in val):
            parts = []
            if "nominal" in val:
                parts.append(str(val["nominal"]))
            if "unit" in val:
                parts.append(str(val["unit"]))
            val["raw"] = " ".join(parts) if parts else ""

    return result
