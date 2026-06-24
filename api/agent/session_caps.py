"""诊断代理的每会话计划功能。

multi-tenant 云前门是资金/计划逻辑的唯一看门人
（公共引擎没有这样的逻辑）。对于依赖于的功能
租户的计划——仅限今天``can_expand`` (may the agent trigger a paid
``⟦PRESERVE0⟧`` pack enrichment?) — the cloud signals its verdict on the
diagnostic ⟦PRESERVE6⟧ handshake via the ``X-Wb-Can-Expand`` header, and the engine reads
it here.

Mirrors ``⟦PRESERVE3⟧`⟦PRESERV E14⟧`⟦PRESERVE4⟧.create_task`` copies the context). The
engine treats the value as opaque policy decided by the cloud.

Default ``True`` so STANDALONE / SELF-⟦PRESERVE5⟧ (no cloud, header absent) keeps full
capability — a ⟦PRESERVE2⟧er can always enrich their own pack, today's behaviour.
The cloud always sends an explicit ``true``/``false``；因此缺少标头
意思是“不在云后面”→不受限制。"""

from __future__ import annotations

from contextvars import ContextVar

_can_expand: ContextVar[bool] = ContextVar("agent_can_expand", default=True)


def set_can_expand(value: bool) -> None:
    """绑定当前诊断会话的扩展能力（调用一次，置顶）。"""
    _can_expand.set(bool(value))


def current_can_expand() -> bool:
    """当当前会话的计划可能触发包丰富时为真。"""
    return _can_expand.get()
