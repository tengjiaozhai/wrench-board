"""用于跟踪从托管生成的 fire-and-forget 镜像任务的帮助程序
诊断会议。

从``runtime_managed.py`` so the dispatch surface
(``tool_dispatch.py``中取出）并且运行时可以引用它而无需形成
一个导入周期。行为与原始内联定义相比没有变化。"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

from api.config import get_settings

logger = logging.getLogger("wrench_board.agent.managed")


class SessionMirrors:
    """跟踪 fire-and-forget 镜像任务并在会话关闭时等待它们。

    由托管运行时用来确保``mb_validate_finding``'s
    ⟦PRESERVE0⟧ MA-store mirror, the ``⟦PRESERVE1⟧`` round-trip, and the
    auto-seed re-upload are not orphaned by a fast ⟦PRESERVE2⟧ disconnect. The
    drain timeout is read from ``settings.ma_session_drain_timeout_seconds``。"""

    def __init__(self) -> None:
        self._pending: set[asyncio.Task] = set()

    def spawn(self, coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)
        return task

    async def wait_drain(self, timeout: float | None = None) -> None:
        if not self._pending:
            return
        if timeout is None:
            timeout = get_settings().ma_session_drain_timeout_seconds
        try:
            await asyncio.wait_for(
                asyncio.gather(*self._pending, return_exceptions=True),
                timeout=timeout,
            )
        except TimeoutError:
            logger.warning(
                "[Diag-MA] %d mirror tasks still pending after %.1fs — cancelling",
                len(self._pending),
                timeout,
            )
            for task in list(self._pending):
                task.cancel()
