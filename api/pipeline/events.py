"""按 device_slug 分组的进程内异步 pub/sub — pipeline 构建进度的「事件总线」。

【在整个系统中的位置】
  POST /pipeline/repairs 返回 JSON 后，HTTP 连接即关闭；构建进度不走 HTTP 流式
  响应，而是经本模块中转，由 WS /pipeline/progress/{slug} 逐条推给浏览器。

  完整链路：
    create_repair()
      → asyncio.create_task(_run_pipeline_with_events)
          → generate_knowledge_pack(on_event=_on_event)
              → emit({type: "phase_started", ...})
                  → _on_event → publish(slug, ev)   ← 写入本总线
      ← 前端用 RepairResponse.device_slug 打开 progress WS
          → events.subscribe(slug)                  ← 从本总线读取
          → websocket.send_text(json.dumps(event))

  **slug 是唯一的 join key**：HTTP 响应与 progress WS 之间没有 session_id 或
  ws_url 字段，两边约定用同一个 slug 关联。

【设计要点】
  - 进程内（asyncio.Queue）：单 worker 部署足够；多 worker 需换成 Redis 等共享总线。
  - 一对多 fan-out：同一 slug 可有多个 WS 客户端同时订阅（多标签页、landing + drawer）。
  - 环形历史缓冲（_history，最多 64 条）：解决「后台已开始 emit、前端 WS 尚未连上」
    的竞态；subscribe() 会先回放 history，再接收实时事件。页面刷新 mid-build 同理。
  - 终端事件（pipeline_finished / pipeline_failed）后 10s 清空 history，避免下次
    同 slug 重建时回放旧事件。

Used by the orchestrator to broadcast phase transitions, and by the
`/pipeline/progress/{slug}` WebSocket to relay them to the browser.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict, deque
from typing import Any

logger = logging.getLogger("wrench_board.pipeline.events")

# slug → 当前所有 WS 订阅者的 asyncio.Queue 列表（fan-out 投递目标）。
_subscribers: dict[str, list[asyncio.Queue[dict[str, Any]]]] = defaultdict(list)

# slug → 最近 N 条事件的环形缓冲。无订阅者时 publish 也不丢弃 — 晚到的 WS 靠回放补全。
# 64 条足够覆盖一次完整 pipeline（含 phase_step 子步骤）。
_HISTORY_MAX = 64
_history: dict[str, deque[dict[str, Any]]] = defaultdict(lambda: deque(maxlen=_HISTORY_MAX))


def subscribe(slug: str) -> asyncio.Queue[dict[str, Any]]:
    """注册一个新的 progress WS 订阅者（由 progress.py 在 accept 后调用）。

    返回的 queue 已预填该 slug 的历史事件（顺序不变），因此 WS 连上即可立刻
    收到 pipeline_started / 已完成的 phase_started 等，无需等下一个阶段边界。
    progress_ws 在 while 循环里 await queue.get() 阻塞，有事件即转发给浏览器。
    """
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    # 先回放 history，再进入实时流 — 解决 create_task 与 WS 握手之间的竞态。
    for event in _history.get(slug, ()):
        queue.put_nowait(event)
    _subscribers[slug].append(queue)
    return queue


def unsubscribe(slug: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
    """Drop a listener. Safe to call twice — missing queues are ignored."""
    try:
        _subscribers[slug].remove(queue)
    except ValueError:
        pass
    # Drop the slug entry entirely when empty to avoid leaking keys.
    if not _subscribers[slug]:
        _subscribers.pop(slug, None)


_TERMINAL_TYPES = frozenset({"pipeline_finished", "pipeline_failed"})


async def publish(slug: str, event: dict[str, Any]) -> None:
    """向 slug 的所有订阅者广播一条事件，并写入 history。

    调用方：
      - repairs._run_pipeline_with_events 里的 _on_event（orchestrator 各阶段 emit）
      - repairs.create_repair 排队分支（type: queued）
      - packs/documents 等需要 relay schematic 进度的路径

    常见 event.type：pipeline_started · phase_started · phase_finished ·
    phase_step · pipeline_paused · pipeline_finished · pipeline_failed · queued
    """
    _history[slug].append(event)

    listeners = list(_subscribers.get(slug, ()))
    for q in listeners:
        try:
            await q.put(event)
        except Exception:  # pragma: no cover — asyncio.Queue.put shouldn't fail
            logger.warning("events.publish: queue.put failed for slug=%r", slug)

    # 终端事件：保留 10s 供「刚连上 WS 的客户端」读到 verdict，之后清空 history。
    if event.get("type") in _TERMINAL_TYPES:
        asyncio.create_task(_clear_history_after(slug, delay_s=10.0))


async def _clear_history_after(slug: str, *, delay_s: float) -> None:
    """Drop a slug's history after a grace period — runs as a fire-and-forget task."""
    try:
        await asyncio.sleep(delay_s)
    except asyncio.CancelledError:  # pragma: no cover
        return
    _history.pop(slug, None)


def subscribers_count(slug: str) -> int:
    return len(_subscribers.get(slug, ()))


def history_count(slug: str) -> int:
    """Test/debug helper — number of events buffered for this slug."""
    return len(_history.get(slug, ()))


def reset() -> None:
    """Clear all subscribers and history — test-only helper."""
    _subscribers.clear()
    _history.clear()
