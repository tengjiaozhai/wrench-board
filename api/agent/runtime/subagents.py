"""Sub-agent 辅助模块：咨询 + 知识策展。

两者均在 tier 对应的 agent 上创建新的 MA session，等待事件流，
退出时归档 session。当技师侧 agent 发出匹配的 custom tool call 时，
由主 session-to-WS forwarder 调用。
"""

from __future__ import annotations

import asyncio
from typing import Any

from anthropic import AsyncAnthropic
from fastapi import WebSocket

from api.agent import runtime_managed as _rm
from api.agent.runtime._aux import (
    TierLiteral,
    _sessions_create_with_retry,
    logger,
)


async def _run_subagent_consultation(
    *,
    client: AsyncAnthropic,            # Anthropic 异步客户端
    tier: TierLiteral,                 # 目标层级（fast/normal/deep）
    query: str,                        # 主 agent 提出的问题
    context: str | None,               # 主 agent 提供的诊断上下文，可为空
    environment_id: str,               # MA 环境 ID
    parent_session_id: str | None,     # 父会话 ID，用于日志追踪
    timeout_s: float | None = None,    # 超时时间（秒），None 时从 settings 读取
) -> dict:
    """在指定 tier 上创建 MA sub-agent，发送 query，返回其文本回复。

    sub-agent 在独立的 MA session 中运行，使用 tier 对应的 agent 配置。
    sub-agent 的工具调用会被拒绝（返回错误），确保咨询过程有界 ——
    prompt 中已明确要求它根据 context 和模型知识直接回答。

    返回字典：
        成功: {"ok": True, "tier": ..., "answer": "..."}
        失败: {"ok": False, "reason": ..., "error": ...}
    """
    if timeout_s is None:
        timeout_s = _rm.get_settings().ma_subagent_consultation_timeout_seconds
    try:
        sub_agent_info = _rm.get_agent(_rm.load_managed_ids(), tier=tier)
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "reason": "unknown-tier",
            "error": f"could not resolve tier={tier}: {exc}",
        }

    parts = []
    if context:
        parts.append(f"=== Context from main agent ===\n{context.strip()}")
    parts.append(f"=== Question ===\n{query.strip()}")
    parts.append(
        "=== Important ===\n"
        "You are running as an isolated consultation sub-agent. You do NOT "
        "have access to the main agent's memory bank, board, or repair "
        "scribe — answer from the context above plus your model knowledge. "
        "Do NOT call any custom tool; respond directly with your analysis."
    )
    prompt = "\n\n".join(parts)

    sub_session = None
    try:
        sub_session = await _sessions_create_with_retry(
            client,
            agent={
                "type": "agent",
                "id": sub_agent_info["id"],
                "version": sub_agent_info["version"],
            },
            environment_id=environment_id,
            title=(
                f"subagent-{tier}-from-{parent_session_id}"
                if parent_session_id
                else f"subagent-{tier}"
            ),
        )
        sub_session_id = sub_session.id
        logger.info(
            "[Subagent] spawned tier=%s session=%s parent=%s",
            tier,
            sub_session_id,
            parent_session_id,
        )

        answer_parts: list[str] = []
        events_cache: dict[str, Any] = {}
        responded: set[str] = set()

        stream_ctx = await client.beta.sessions.events.stream(sub_session_id)
        async with stream_ctx as stream:
            await client.beta.sessions.events.send(
                sub_session_id,
                events=[{
                    "type": "user.message",
                    "content": [{"type": "text", "text": prompt}],
                }],
            )

            async def _consume() -> None:
                async for event in stream:
                    etype = getattr(event, "type", None)
                    if etype == "agent.message":
                        for block in getattr(event, "content", []) or []:
                            if getattr(block, "type", None) == "text":
                                answer_parts.append(block.text)
                    elif etype == "agent.custom_tool_use":
                        events_cache[event.id] = event
                    elif etype == "session.status_idle":
                        stop = getattr(event, "stop_reason", None)
                        sr = getattr(stop, "type", None) if stop else None
                        if sr == "requires_action":
                            event_ids = getattr(stop, "event_ids", []) or []
                            refusals = []
                            for eid in event_ids:
                                if eid in responded:
                                    continue
                                refusals.append({
                                    "type": "user.custom_tool_result",
                                    "custom_tool_use_id": eid,
                                    "content": [{
                                        "type": "text",
                                        "text": (
                                            "Tools are disabled in consultant "
                                            "mode. Answer directly from the "
                                            "context provided."
                                        ),
                                    }],
                                    "is_error": True,
                                })
                                responded.add(eid)
                            if refusals:
                                await client.beta.sessions.events.send(
                                    sub_session_id, events=refusals
                                )
                            continue
                        # end_turn / retries_exhausted 等 —— 终止状态
                        return
                    elif etype == "session.status_terminated":
                        return

            try:
                await asyncio.wait_for(_consume(), timeout=timeout_s)
            except TimeoutError:
                logger.warning(
                    "[Subagent] tier=%s session=%s timed out after %.1fs",
                    tier,
                    sub_session_id,
                    timeout_s,
                )

        answer = "\n".join(p for p in answer_parts if p).strip()
        if not answer:
            return {
                "ok": False,
                "reason": "no-output",
                "error": "sub-agent returned no text",
                "tier": tier,
            }
        return {"ok": True, "tier": tier, "answer": answer}

    except Exception as exc:  # noqa: BLE001
        logger.exception("[Subagent] consultation failed tier=%s", tier)
        return {
            "ok": False,
            "reason": "subagent-failed",
            "error": str(exc),
            "tier": tier,
        }
    finally:
        if sub_session is not None:
            try:
                await client.beta.sessions.archive(sub_session.id)
            except Exception:  # noqa: BLE001
                pass


async def _run_knowledge_curator(
    *,
    client: AsyncAnthropic,
    device_label: str,
    focus_symptoms: list[str],
    focus_refdes: list[str],
    environment_id: str,
    parent_session_id: str | None,
    ws: WebSocket | None = None,
    timeout_s: float | None = None,
) -> str:
    """Spawn the bootstrapped KnowledgeCurator MA agent for a research run.

    Returns the curator's Markdown chunk (same shape as the inline Scout in
    `api.pipeline.expansion._run_targeted_scout`). Surfaces `agent.tool_use`
    events on `ws` if provided so the tech sees the live web_search queries.
    """
    if timeout_s is None:
        timeout_s = _rm.get_settings().ma_curator_timeout_seconds
    try:
        curator_info = _rm.get_agent(_rm.load_managed_ids(), tier="curator")
    except RuntimeError as exc:
        raise RuntimeError(
            "knowledge_curator agent not bootstrapped — re-run "
            "scripts/bootstrap_managed_agent.py"
        ) from exc

    focus_block = "\n".join(f"  - {s}" for s in focus_symptoms)
    refdes_section = ""
    if focus_refdes:
        refdes_lines = "\n".join(f"  - {r}" for r in focus_refdes)
        refdes_section = f"\n\nFocus refdes:\n{refdes_lines}"

    prompt = (
        f"Device: {device_label}\n\n"
        f"Focus symptoms (target THESE only):\n{focus_block}"
        f"{refdes_section}\n\n"
        "Run a focused web research pass and produce the Markdown dump in "
        "your system-prompt format. 4-8 searches max, each scoped to one "
        "symptom + the device. Stop when you have 3-6 symptom blocks with "
        "traceable sources. Avoid topics already common knowledge — surface "
        "new failure-mode information for the focus symptoms only."
    )

    sub_session = None
    try:
        sub_session = await _sessions_create_with_retry(
            client,
            agent={
                "type": "agent",
                "id": curator_info["id"],
                "version": curator_info["version"],
            },
            environment_id=environment_id,
            title=(
                f"curator-from-{parent_session_id}"
                if parent_session_id
                else "curator"
            ),
        )
        sub_session_id = sub_session.id
        logger.info(
            "[Curator] spawned session=%s for device=%r focus=%s",
            sub_session_id,
            device_label,
            focus_symptoms,
        )
        if ws is not None:
            await ws.send_json({
                "type": "subagent_spawned",
                "role": "curator",
                "session_id": sub_session_id,
            })

        chunks: list[str] = []
        stream_ctx = await client.beta.sessions.events.stream(sub_session_id)
        async with stream_ctx as stream:
            await client.beta.sessions.events.send(
                sub_session_id,
                events=[{
                    "type": "user.message",
                    "content": [{"type": "text", "text": prompt}],
                }],
            )

            async def _consume() -> None:
                async for event in stream:
                    etype = getattr(event, "type", None)
                    if etype == "agent.message":
                        for block in getattr(event, "content", []) or []:
                            if getattr(block, "type", None) == "text":
                                chunks.append(block.text)
                    elif etype == "agent.tool_use" and ws is not None:
                        # Server-side tools (web_search, web_fetch).
                        # Mirror to ws so the tech sees the live research.
                        await ws.send_json({
                            "type": "subagent_tool_use",
                            "role": "curator",
                            "name": getattr(event, "name", None),
                            "input": getattr(event, "input", {}) or {},
                        })
                    elif etype == "session.status_idle":
                        stop = getattr(event, "stop_reason", None)
                        sr = getattr(stop, "type", None) if stop else None
                        if sr != "requires_action":
                            return
                    elif etype == "session.status_terminated":
                        return

            try:
                await asyncio.wait_for(_consume(), timeout=timeout_s)
            except TimeoutError:
                logger.warning(
                    "[Curator] session=%s timed out after %.1fs",
                    sub_session_id,
                    timeout_s,
                )

        return "\n".join(c for c in chunks if c).strip()

    finally:
        if sub_session is not None:
            try:
                await client.beta.sessions.archive(sub_session.id)
            except Exception:  # noqa: BLE001
                pass
