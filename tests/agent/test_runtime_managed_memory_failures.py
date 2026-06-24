"""Memory store provisioning failures must surface to the WS.

Previously, if `ensure_global_store` or `ensure_memory_store` raised,
the runtime caught nothing — the session opened, the UI showed
`session_ready`, and the agent ran without its memory layer (no scribe
mount, no global patterns/playbooks). The technician had no signal
that cross-session continuity was off.

Now the runtime collects each failure into `memory_setup_failures` and
emits a `memory_store_setup_failed` frame right after `session_ready`.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
async def test_memory_store_setup_failed_emitted_when_ensure_raises(
    monkeypatch, tmp_path,
):
    """A failing ensure_memory_store must produce a WS frame after session_ready."""
    from api.agent import runtime_managed as rm

    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()

    class FakeSettings:
        anthropic_api_key = "sk-test"
        anthropic_max_retries = 5
        memory_root = str(tmp_path)
        ma_memory_store_enabled = True
    monkeypatch.setattr(rm, "get_settings", lambda: FakeSettings())
    monkeypatch.setattr(rm, "load_managed_ids", lambda: {"environment_id": "env_x"})
    monkeypatch.setattr(
        rm, "get_agent",
        lambda ids, tier: {"id": "agent_x", "version": 1, "model": "claude-haiku-4-5"},
    )

    # 使每个 ensure_* 失败的ently 都不同，以验证所有四个re 跟踪。
    async def boom_global(client, *, kind, description):
        raise RuntimeError(f"global {kind} provisioning down")
    async def boom_memory(client, slug):
        raise RuntimeError("device store quota exceeded")

    monkeypatch.setattr(rm, "ensure_global_store", boom_global)
    monkeypatch.setattr(rm, "ensure_memory_store", boom_memory)

    # 让session.create成功（我们需要首先session_ready被emitted
    # 所以轮到内存故障了reframe）。稍后通过做出保释
    # WS re接受加注 — orchestrator 将 tre 作为断开连接
    # 并干净地撕下来。
    fake_session = MagicMock()
    fake_session.id = "sesn_test_001"
    class FakeSessions:
        async def create(self, **_kw):
            return fake_session
        async def retrieve(self, _sid):
            raise Exception("none")
    class FakeBeta:
        sessions = FakeSessions()
    class FakeClient:
        beta = FakeBeta()
    monkeypatch.setattr(rm, "AsyncAnthropic", lambda **_kw: FakeClient())
    # 存根两个转发器协程，以便测试永远不会 opens a stream。
    async def _noop(*_a, **_kw):
        return None
    monkeypatch.setattr(rm, "_forward_ws_to_session", _noop)
    monkeypatch.setattr(rm, "_forward_session_to_ws", _noop)

    try:
        await rm.run_diagnostic_session_managed(ws, "demo", tier="fast")
    except Exception:
        pass

    payloads = [call.args[0] for call in ws.send_json.await_args_list]
    failed_frames = [p for p in payloads if p.get("type") == "memory_store_setup_failed"]
    assert failed_frames, (
        f"expected a memory_store_setup_failed frame, got types "
        f"{[p.get('type') for p in payloads]!r}"
    )
    failures = failed_frames[0]["failures"]
    failed_stores = {entry["store"] for entry in failures}
    # 模式 + 剧本（全局）+ 设备 — repair_store 不是
    # 行使他re，因为没有repair_id通过。
    assert {"patterns", "playbooks", "device"}.issubset(failed_stores), (
        f"expected at least patterns/playbooks/device failures, got {failed_stores!r}"
    )
    # 每个entry必须携带非空错误消息。
    for entry in failures:
        assert entry["error"], f"empty error message in {entry!r}"


@pytest.mark.asyncio
async def test_no_memory_store_setup_failed_when_all_succeed(
    monkeypatch, tmp_path,
):
    """When every ensure_* succeeds, the failure frame must NOT be emitted."""
    from api.agent import runtime_managed as rm

    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()

    class FakeSettings:
        anthropic_api_key = "sk-test"
        anthropic_max_retries = 5
        memory_root = str(tmp_path)
        ma_memory_store_enabled = True
    monkeypatch.setattr(rm, "get_settings", lambda: FakeSettings())
    monkeypatch.setattr(rm, "load_managed_ids", lambda: {"environment_id": "env_x"})
    monkeypatch.setattr(
        rm, "get_agent",
        lambda ids, tier: {"id": "agent_x", "version": 1, "model": "claude-haiku-4-5"},
    )

    async def ok_global(client, *, kind, description):
        return f"memstore_{kind}"
    async def ok_memory(client, slug):
        return "memstore_device_ok"
    monkeypatch.setattr(rm, "ensure_global_store", ok_global)
    monkeypatch.setattr(rm, "ensure_memory_store", ok_memory)

    class FakeSessions:
        async def create(self, **_kw):
            raise Exception("stop here")
        async def retrieve(self, _sid):
            raise Exception("none")
    class FakeBeta:
        sessions = FakeSessions()
    class FakeClient:
        beta = FakeBeta()
    monkeypatch.setattr(rm, "AsyncAnthropic", lambda **_kw: FakeClient())

    try:
        await rm.run_diagnostic_session_managed(ws, "demo", tier="fast")
    except Exception:
        pass

    payloads = [call.args[0] for call in ws.send_json.await_args_list]
    failed_frames = [p for p in payloads if p.get("type") == "memory_store_setup_failed"]
    assert failed_frames == [], (
        f"no failure frame should be emitted on the happy path, got {failed_frames!r}"
    )
