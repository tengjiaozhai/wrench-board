"""Wiring tests: confirm runtime_managed actually uses the F1/F2/F8 patterns.

The async_safety tests prove the patterns themselves work. These tests
prove the runtime is wired to those patterns at the exact lines an
incident would hit. They're inspection-style: source-grep + AST checks
to catch a future refactor that silently goes back to bare
asyncio.create_task.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

RUNTIME_PATH = Path(__file__).parent.parent.parent / "api" / "agent" / "runtime_managed.py"
# 在 runtime 分解osition 之后，wire 流模式将变为 acros
# ``api.agent.runtime`` 子包文件。接线测试仍在寻找
# 相同的源标记（`def _emit`、`cam_capture` 分支、
# post-取消块）；为了让他们诚实，fixture concatenates 每个
# runtime 文件，因此 future re 因素会丢弃其中一种模式 from
# 其中任何一个仍然违背了这一断言。
RUNTIME_DIR = Path(__file__).parent.parent.parent / "api" / "agent" / "runtime"
# `_SessionMirrors` 被从 ``runtime_managed.py`` 中提升到自己的
# 模块 when 调度re因子落地（参见``tool_dispatch.py​​``），所以
# 下面的 AST 合约测试必须检查该模块directly。这
# runtime 仍然 re - 通过其旧名称导出符号
# ``from api.agent._session_mirrors 将 SessionMirrors 导入为
# _SessionMirrors`` 因此现有的导入继续工作。
SESSION_MIRRORS_PATH = (
    Path(__file__).parent.parent.parent / "api" / "agent" / "_session_mirrors.py"
)


@pytest.fixture(scope="module")
def runtime_source() -> str:
    parts = [RUNTIME_PATH.read_text()]
    for child in sorted(RUNTIME_DIR.glob("*.py")):
        parts.append(child.read_text())
    return "\n".join(parts)


@pytest.fixture(scope="module")
def runtime_tree(runtime_source: str) -> ast.Module:
    return ast.parse(runtime_source)


@pytest.fixture(scope="module")
def session_mirrors_tree() -> ast.Module:
    return ast.parse(SESSION_MIRRORS_PATH.read_text())


# ---------------------------------------------------------------------------
# F1：_emit 不得在 ws.send_json 上调用 asyncio.create_task
# ---------------------------------------------------------------------------


def test_emit_uses_session_mirrors_not_bare_create_task(runtime_source: str):
    """The closure named `_emit` defined for measurement/validation
    callbacks must route through `session_mirrors.spawn(...)`, not bare
    `asyncio.create_task(ws.send_json(...))`. Bare create_task is the F1
    bug — orphaned task, frame can be dropped on session close.
    """
    # 在源中找到 _emit closure。
    marker = "def _emit(event: dict) -> None:"
    idx = runtime_source.find(marker)
    assert idx != -1, "_emit closure must exist (measurement/validation hook)"

    # 阅读 def 后面的几行来检查主体。
    body = runtime_source[idx:idx + 600]
    assert "session_mirrors.spawn(" in body, (
        "F1 regression: _emit must call session_mirrors.spawn(...) so the "
        "ws.send_json task is tracked. Found body:\n" + body
    )
    # Defensive：bareasyncio.create_task位于ws.send_json内_emit
    # 会re-引入孤儿任务错误。
    body_first_4_lines = "\n".join(body.splitlines()[:5])
    assert "asyncio.create_task(ws.send_json" not in body_first_4_lines, (
        "F1 regression: _emit must NOT call asyncio.create_task(ws.send_json, "
        "the F1 fix routes through session_mirrors.spawn instead"
    )


# ---------------------------------------------------------------------------
# F2：cam_capture必须使用session_mirrors.spawn +添加release回调
# ---------------------------------------------------------------------------


def test_cam_capture_dispatch_tracked_with_release_callback(runtime_source: str):
    """The cam_capture branch must:
      1. Spawn the dispatch via `session_mirrors.spawn(...)`, not bare
         `asyncio.create_task(...)`.
      2. Wire a `add_done_callback(...)` that DISCARDS the eid from
         `responded_tool_ids` on cancel / exception.
    Both pieces are required: spawn alone tracks lifecycle but doesn't
    fix the permablock; the callback alone has nothing to attach to.
    """
    branch_marker = 'if name == "cam_capture":'
    idx = runtime_source.find(branch_marker)
    assert idx != -1, "cam_capture dispatch branch must exist"

    # 分支主体：read 直到下一个“继续”（分支的end）。
    branch_body = runtime_source[idx:idx + 3000]
    end = branch_body.find("continue")
    assert end != -1, "cam_capture branch must end with `continue`"
    branch_body = branch_body[:end]

    assert "session_mirrors.spawn(" in branch_body, (
        "F2 regression: cam_capture must dispatch through session_mirrors."
        "spawn(...) so close-mid-capture drains the task. Found:\n"
        + branch_body
    )
    assert "asyncio.create_task(_dispatch_cam_capture" not in branch_body, (
        "F2 regression: bare asyncio.create_task on _dispatch_cam_capture "
        "re-introduces the orphan-task bug"
    )
    assert "add_done_callback" in branch_body, (
        "F2 regression: cam_capture must wire a done callback to release "
        "the responded_tool_ids dedup on crash"
    )
    assert "responded_tool_ids.discard" in branch_body, (
        "F2 regression: the done callback must DISCARD the eid on failure "
        "(not just log) — otherwise MA permablocks waiting for the tool result"
    )


# ---------------------------------------------------------------------------
# F8：post-取消gather必须pre放弃最终清理
# ---------------------------------------------------------------------------


def test_post_cancel_per_task_unwind_present_before_finally(
    runtime_source: str,
):
    """After `for task in pending: task.cancel()`, the runtime must
    bound EACH cancelled task with its own `asyncio.wait({task}, ...)`
    so cancellation is observed BEFORE `finally` tears down shared state
    (set_ws_emitter(None), session_mirrors.wait_drain). Without the
    bounded wait, a recv_task interrupted mid-await of ws.receive_text()
    can race with the emitter teardown.

    Why per-task rather than a single global gather: a slow forwarder
    must not consume the entire timeout window and starve its sibling.
    Each forwarder gets its own budget, and any task that ignores its
    cancel is logged BY NAME so the operator can route the post-mortem
    to the right forwarder (see F1 follow-up audit).
    """
    cancel_marker = "for task in pending:\n            task.cancel()"
    idx = runtime_source.find(cancel_marker)
    assert idx != -1, (
        "expected the standard `for task in pending: task.cancel()` block "
        "in the asyncio.wait orchestration"
    )

    # 检查循环体以确认每个任务等待的有限时间
    # 取消之后，警告包含任务名称。
    after_cancel = runtime_source[idx:idx + 1200]
    assert "asyncio.wait({task}" in after_cancel, (
        "F1 follow-up regression: missing per-task `asyncio.wait({task}, "
        "timeout=...)` after the cancel. The previous global gather has "
        "been replaced by a per-task bounded wait so a slow task can't "
        "starve its sibling out of the timeout window."
    )
    assert "timeout=" in after_cancel, (
        "F1 follow-up regression: the per-task wait must carry an explicit "
        "timeout so a misbehaving cancel handler can't hang teardown forever"
    )
    assert "task.get_name()" in after_cancel, (
        "F1 follow-up regression: when a forwarder ignores its cancel the "
        "WARNING must name the offending task so the operator can route "
        "the post-mortem to recv vs emit"
    )
    assert "did not unwind" in after_cancel, (
        "F1 follow-up regression: the WARNING text must keep the 'did not "
        "unwind' phrase so existing log-grep alerts still fire on a stuck "
        "teardown"
    )


def test_session_mirrors_class_contract_unchanged(
    session_mirrors_tree: ast.Module,
):
    """The `SessionMirrors` class must keep its three public surfaces
    (spawn, wait_drain, _pending) — the F1 + F2 fixes both depend on the
    spawn() tracking semantics. Any future refactor that drops `_pending`
    or renames `spawn` would silently break the regression coverage.

    The class lives in :mod:`api.agent._session_mirrors` since the
    dispatch refactor; ``runtime_managed`` re-exports it as
    ``_SessionMirrors`` so legacy importers keep working.
    """
    cls = next(
        (n for n in ast.walk(session_mirrors_tree)
         if isinstance(n, ast.ClassDef) and n.name == "SessionMirrors"),
        None,
    )
    assert cls is not None, "SessionMirrors class must exist"

    methods = {n.name for n in cls.body if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)}
    assert "spawn" in methods, "SessionMirrors must expose spawn()"
    assert "wait_drain" in methods, "SessionMirrors must expose wait_drain()"

    # 生成必须是同步的（re转动任务），而不是async——否则调用站点
    # 没有 await 的 `mirrors.spawn(...)` 将会是 silently no-op。
    spawn = next(n for n in cls.body
                 if isinstance(n, ast.FunctionDef) and n.name == "spawn")
    assert spawn.__class__.__name__ == "FunctionDef", (
        "spawn must be sync (def spawn) so call sites work without await"
    )

    # 导入器别名 from runtime_managed 仍必须使用旧名称ose。
    from api.agent._session_mirrors import SessionMirrors
    from api.agent.runtime_managed import _SessionMirrors as _Reexport

    assert _Reexport is SessionMirrors, (
        "runtime_managed must re-export SessionMirrors as _SessionMirrors so "
        "tests + scripts importing the legacy name keep working"
    )
