"""诊断代理的每个会话板号上下文。

板号（例如“820-02016”）标识 PCB 版本
诊断并确定代理加载哪个板增量包。这是
在诊断会话顶部从``?board=`` query
parameter on the ⟦PRESERVE2⟧ handshake, and read by board-delta-aware tools to
inject the revision-specific delta into the session context.

A ContextVar (not a module global) so concurrent sessions — each a
separate ⟦PRESERVE0⟧ task per ⟦PRESERVE2⟧ connection — stay isolated: ``⟦PRESERVE0⟧.create_task``
copies the context, so child tasks of a session inherit the board_ref set at
its top, while a different session's task carries its own value. The engine
treats board_ref as an opaque string; no trust or gating logic lives here.

Default ``None`` so STANDALONE / SELF-⟦PRESERVE1⟧ (no ``?board=``参数绑定一次）是完全
功能性——Delta 根本没有被注入，保留了今天的行为。"""

from __future__ import annotations

from contextvars import ContextVar

_board_ref: ContextVar[str | None] = ContextVar("agent_board_ref", default=None)


def set_board_ref(value: str | None) -> None:
    """将当前诊断会话绑定到板号（在顶部调用一次）。"""
    _board_ref.set(value or None)


def current_board_ref() -> str | None:
    """当前会话的板号，或无（不提供/独立）。"""
    return _board_ref.get()
