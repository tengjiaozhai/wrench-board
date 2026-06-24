"""尽力向wrenchboard-cloud (T13) 报告代币使用情况。

诊断代理的每次 LLM 调用代币成本是tenant-私人计费
单元。在每个“span.model_request_end”，实时 forwarder 都会触发
此处的“report_turn_usage”，其中POST是原始令牌计数+模型名称
云的 ``POST /internal/metering/diagnostic`` 端点（云为其定价，
附加到其幂等分类帐，以“event_id”为键）。

独立/self-host完整性：当``cloud_metering_url``/
``cloud_metering_token`` 未设置（默认），这是一个硬性的无操作 —
引擎从来不打电话回家。反映了默认的许可约定
api.config 中的“engine_service_token”/“cors_allow_origins”。

就像:mod:`api.agent.memory_stores`，每次失败（网络，HTTP，格式错误
配置）降级为 WARNING 日志和静默返回 — 缺少使用报告
绝不能干扰实时诊断转向。云端保留每次修复quota
作为其硬卫，因此丢失的报告只会导致账本行的损失。
"""
from __future__ import annotations

import asyncio
import logging

import httpx

from api.config import get_settings

logger = logging.getLogger("wrench_board.agent.cloud_metering")

_METERING_PATH = "/internal/metering/diagnostic"
# 短超时：这是fire-and-forget，绝不能拖延代理轮次。
_HTTP_TIMEOUT = 10.0

# 保留对飞行报告的强烈引用。 asyncio仅持有弱
# 引用裸露的 create_task() 结果，因此如果没有这个结果，任务可以是
# 在完成之前在飞行中进行垃圾收集（CPython 文档警告）。
_BACKGROUND_TASKS: set[asyncio.Task] = set()


def cloud_metering_enabled() -> bool:
    """仅当配置了云目标 URL 和服务令牌时才为 true。”"""
    settings = get_settings()
    return bool(settings.cloud_metering_url and settings.cloud_metering_token)


async def report_turn_usage(
    *,
    owner_ref: str | None,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_input_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
    engine_repair_id: str | None,
    event_id: str,
    kind: str = "agent",
) -> None:
    """POST 一次 LLM 调用对云的令牌使用情况。未配置时无操作。

    缓存代币会根据报告进行定价，因此云会按照自己的 tiers 为其定价
    （读取 0.1 倍，创建 1.25 倍输入）。放弃他们的热门回合——主要是
    cache_read 在提示缓存下 — 作为完整输入（~10 倍过度充电）。

    `kind` 存储云端支出：'agent'（交互式聊天 - 边界为
    每个计划的预算门）与“构建”（一次性管道包构建 -
    slot-gated separately, excluded from the chat budget). The cloud rejects
    还有什么，大声。

    尽力而为：任何失败都会记录在WARNING 并被吞掉。
    """
    settings = get_settings()
    base = settings.cloud_metering_url
    token = settings.cloud_metering_token
    if not base or not token:
        return

    url = base.rstrip("/") + _METERING_PATH
    payload = {
        "owner_ref": owner_ref,
        "model": model,
        "kind": kind,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_input_tokens": cache_read_input_tokens,
        "cache_creation_input_tokens": cache_creation_input_tokens,
        "engine_repair_id": engine_repair_id,
        "event_id": event_id,
    }
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
            resp = await http.post(
                url,
                headers={"Authorization": f"Bearer {token}"},
                json=payload,
            )
    except Exception as exc:  # noqa: BLE001 - best-effort, never disturb the turn
        logger.warning("[CloudMetering] report raised for event=%s: %s", event_id, exc)
        return
    if resp.status_code != 202:
        logger.warning(
            "[CloudMetering] report event=%s returned %d: %s",
            event_id,
            resp.status_code,
            resp.text[:200],
        )


def fire_and_forget_report(
    *,
    owner_ref: str | None,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_input_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
    engine_repair_id: str | None,
    event_id: str,
    kind: str = "agent",
) -> None:
    """安排metering报告，而不阻塞呼叫者（座席轮流）。

    当metering未配置时无操作，因此self-host热路径甚至不会
    产生一个任务。否则会产生一个后台任务并保持强大的
    参考它直到完成。
    """
    if not cloud_metering_enabled():
        return
    task = asyncio.create_task(
        report_turn_usage(
            owner_ref=owner_ref,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_input_tokens=cache_read_input_tokens,
            cache_creation_input_tokens=cache_creation_input_tokens,
            engine_repair_id=engine_repair_id,
            event_id=event_id,
            kind=kind,
        )
    )
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
