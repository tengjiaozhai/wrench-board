"""诊断 agent 的每会话板号上下文。

板号（如「820-02016」）标识 PCB 修订版，决定 agent 加载哪个
board delta 包。在诊断 WS 握手时从 `?board=` 查询参数绑定一次，
供 board-delta 感知工具将修订版特定增量注入会话上下文。

使用 ContextVar（非模块全局）以隔离并发会话 — 每个 WebSocket 连接
的 asyncio Task 各自独立：`asyncio.create_task` 复制上下文，子任务
继承顶部设置的 board_ref，不同会话互不影响。引擎将 board_ref 视为
不透明字符串；此处无信任或门控逻辑。

默认 `None`：STANDALONE / SELF-HOST（未绑定 `?board=`）时 delta 不注入，
保持现有行为。
"""

from __future__ import annotations

from contextvars import ContextVar

_board_ref: ContextVar[str | None] = ContextVar("agent_board_ref", default=None)


def set_board_ref(value: str | None) -> None:
    """将当前诊断会话绑定到板号（在会话顶部调用一次）。"""
    _board_ref.set(value or None)


def current_board_ref() -> str | None:
    """当前会话的板号；未提供/独立模式时为 None。"""
    return _board_ref.get()
