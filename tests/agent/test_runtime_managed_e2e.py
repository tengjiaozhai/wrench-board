"""End-to-end tests for the Managed Agents stream loop in `_forward_session_to_ws`.

These tests focus on edge cases that previously slipped through:

* Stream iterator raising a non-`TimeoutError` (e.g. SSL reset, connection
  drop, mid-stream APIStatusError) used to bubble silently — the WS client
  saw no signal, the technician saw a frozen UI. Now the loop catches it,
  logs, emits `stream_error` on the WS, and breaks cleanly.
* Stream iterator stalling beyond `ma_stream_event_timeout_seconds` — should
  emit `stream_timeout` and break. Already worked; locked in here so a
  refactor can't regress it.
* Managed Agents re-emitting `session.status_idle` with the same `event_ids`
  after we've already responded — the dedupe set must skip the second pass
  (responding twice is a 400 from MA that tears down the stream).
* `processed_at` round-trip telemetry on `user.custom_tool_result` echoes —
  must log the agent's consumption delay without raising on missing fields.

The test mocks the SDK's `AsyncStream` and the WS so the suite stays
fast (sub-second) and offline.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest


class _FakeStream:
    """Async-iterable + async-context-manager mimicking AsyncAnthropic's stream.

    `events` is the queue to yield; `raise_after` (optional) is an exception
    to raise on the next `__anext__()` once the queue is drained, simulating
    a transport-level failure mid-stream.
    """

    def __init__(self, events, *, raise_after: Exception | None = None):
        self._events = list(events)
        self._raise_after = raise_after

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._events:
            return self._events.pop(0)
        if self._raise_after is not None:
            exc, self._raise_after = self._raise_after, None
            raise exc
        raise StopAsyncIteration


class _FakeEventsList:
    """Async-iterable stand-in for `events.list(session_id)`.

    The lossless-reconnect catch-up calls `events.list` and iterates the
    result. By default it yields nothing (no gap to fill); pass `events`
    to simulate server-side history present during a reconnect catch-up.
    `stream` may itself be passed a list so each (re)connect of the live
    tail yields a controlled batch.
    """

    def __init__(self, events=()):
        self._events = list(events)

    def __aiter__(self):
        async def _gen():
            for ev in self._events:
                yield ev
        return _gen()


def _make_client(
    stream: _FakeStream, *, list_factory=None,
) -> MagicMock:
    """Build a fake AsyncAnthropic exposing only what the loop touches.

    `stream` may be a single _FakeStream (returned on every connect) or a
    list of streams (one per consecutive connect, last repeated). `list_
    factory` is a zero-arg callable returning a fresh _FakeEventsList for
    each catch-up call; defaults to an empty history.
    """
    client = MagicMock()
    client.beta = MagicMock()
    client.beta.sessions = MagicMock()
    client.beta.sessions.events = MagicMock()

    if isinstance(stream, list):
        streams = list(stream)

        async def _stream(_sid):
            return streams.pop(0) if len(streams) > 1 else streams[0]

        client.beta.sessions.events.stream = _stream
    else:
        client.beta.sessions.events.stream = AsyncMock(return_value=stream)

    client.beta.sessions.events.send = AsyncMock()
    if list_factory is None:
        client.beta.sessions.events.list = lambda _sid: _FakeEventsList()
    else:
        client.beta.sessions.events.list = lambda _sid: list_factory()
    return client


def _make_ws() -> MagicMock:
    ws = MagicMock()
    ws.send_json = AsyncMock()
    ws.accept = AsyncMock()
    ws.close = AsyncMock()
    return ws


def _stale_settings(
    monkeypatch, rm, *, timeout: float = 600.0, max_reconnects: int = 4,
) -> None:
    """Patch get_settings so the watchdog window is controllable in tests."""
    class _Settings:
        ma_stream_event_timeout_seconds = timeout
        ma_stream_max_reconnects = max_reconnects
        ma_session_drain_timeout_seconds = 5.0
        ma_forwarder_unwind_timeout_seconds = 2.0
        ma_subagent_consultation_timeout_seconds = 120.0
        ma_curator_timeout_seconds = 180.0
        ma_camera_capture_timeout_seconds = 30.0
        ma_memory_store_http_timeout_seconds = 30.0
        memory_root = "/tmp"
        ma_memory_store_enabled = False
    monkeypatch.setattr(rm, "get_settings", lambda: _Settings())


@pytest.mark.asyncio
async def test_persistent_transport_failure_exhausts_reconnects(
    monkeypatch, tmp_path,
):
    """A stream that keeps failing must reconnect up to the budget, then
    surface `stream_error: reconnect_exhausted` and stop.

    Prior contract emitted `stream_error` immediately and gave up on the
    first transport failure. The lossless-reconnect contract instead treats
    a transport drop as recoverable (the session may still be live with a
    pending action), re-lists history + re-tails up to `ma_stream_max_
    reconnects` consecutive times. Only when that budget is spent does it
    give up — and it tells the WS *why* (reconnect_exhausted), not the raw
    transport error.
    """
    from api.agent import runtime_managed as rm
    from api.session.state import SessionState

    # 预算小，所以测试保持fast；空洞的追赶hi故事。
    _stale_settings(monkeypatch, rm, max_reconnects=2)

    boom = ConnectionError("simulated TLS reset")
    # 每个(re)连接re都会变成一个stream，imm立即引发，所以没有event
    # 曾经交付过red，并且re连接预算从未设定过re。
    stream = _FakeStream(events=[], raise_after=boom)
    client = _make_client(stream)
    ws = _make_ws()
    session_state = SessionState.from_device("nonexistent-slug")

    await rm._forward_session_to_ws(
        ws=ws,
        client=client,
        session_id="sesn_test",
        device_slug="demo",
        memory_root=tmp_path,
        events_by_id={},
        session_state=session_state,
        agent_model="claude-haiku-4-5",
        tier="fast",
        environment_id="env_test",
        repair_id=None,
        conv_id=None,
    )

    payloads = [call.args[0] for call in ws.send_json.await_args_list]
    error_frames = [p for p in payloads if p.get("type") == "stream_error"]
    assert error_frames, (
        f"expected a stream_error frame after reconnects exhaust, got "
        f"{payloads!r}"
    )
    err = error_frames[0]
    assert err["error"] == "reconnect_exhausted"
    assert err["session_id"] == "sesn_test"


@pytest.mark.asyncio
async def test_persistent_inactive_stream_exhausts_reconnects(
    monkeypatch, tmp_path,
):
    """A perpetually-stalled SSE iterator must trip the watchdog, reconnect
    up to the budget, then surface `stream_error: reconnect_exhausted`.

    The watchdog timeout is now a recoverable-drop trigger (transparent
    reconnect) rather than an immediate `stream_timeout` give-up — a brief
    Anthropic SSE stall self-heals without the technician seeing anything.
    Only a persistent stall (budget exhausted) surfaces an error.
    """
    from api.agent import runtime_managed as rm
    from api.session.state import SessionState

    # 0.02 s 看门狗 + 微小的 re 连接预算 → fast。
    _stale_settings(monkeypatch, rm, timeout=0.02, max_reconnects=2)

    class _NeverEmits:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): return False
        def __aiter__(self): return self
        async def __anext__(self):
            await asyncio.sleep(10)  # 比看门狗长
            raise StopAsyncIteration

    client = _make_client(_NeverEmits())
    ws = _make_ws()
    session_state = SessionState.from_device("nonexistent-slug")

    await rm._forward_session_to_ws(
        ws=ws, client=client, session_id="sesn_test",
        device_slug="demo", memory_root=tmp_path,
        events_by_id={}, session_state=session_state,
        agent_model="claude-haiku-4-5", tier="fast",
        environment_id="env_test", repair_id=None, conv_id=None,
    )

    payloads = [call.args[0] for call in ws.send_json.await_args_list]
    error_frames = [p for p in payloads if p.get("type") == "stream_error"]
    assert error_frames, (
        f"expected stream_error after watchdog reconnects exhaust, got "
        f"{payloads!r}"
    )
    assert error_frames[0]["error"] == "reconnect_exhausted"


@pytest.mark.asyncio
async def test_reconnect_recovers_pending_tool_from_catchup_history(
    monkeypatch, tmp_path,
):
    """The deadlock fix: a `requires_action` whose tool_use only exists in
    the catch-up history (emitted during a stream gap) must still be
    dispatched after reconnect — not left hanging forever.

    First connect: the live stream drops mid-turn (raises) BEFORE delivering
    the tool_use or the requires_action. Those two events are present in the
    server-side history. On reconnect, the catch-up `events.list` yields
    them; the runtime caches the tool_use and dispatches the requires_action,
    sending the `user.custom_tool_result` that unblocks the session.
    """
    from api.agent import runtime_managed as rm
    from api.session.state import SessionState

    _stale_settings(monkeypatch, rm, max_reconnects=2)

    dispatch_calls: list[tuple[str, dict]] = []

    async def fake_dispatch(name, payload, *_a, **_kw):
        dispatch_calls.append((name, payload))
        return {"ok": True, "echo": payload}

    monkeypatch.setattr(rm, "_dispatch_tool", fake_dispatch)

    tool_use = SimpleNamespace(
        type="agent.custom_tool_use",
        id="sevt_gap_001",
        name="bv_highlight_component",
        input={"refdes": "U7"},
    )
    requires_action = SimpleNamespace(
        type="session.status_idle",
        stop_reason=SimpleNamespace(
            type="requires_action", event_ids=["sevt_gap_001"],
        ),
    )
    terminated = SimpleNamespace(type="session.status_terminated")

    # 连接 #1：立即删除 imm（TLS reset） — tool_use + requires_action
    # 我们在间隙期间进行了reemit比赛，但从未re到达直播re上午。
    first_stream = _FakeStream(
        events=[], raise_after=ConnectionError("drop mid-turn"),
    )
    # 连接#2：活尾安静；通过追赶通行证，工作快乐ens。
    # 第二个活动尾部 ent 上的终止 event 干净地结束了循环。
    second_stream = _FakeStream(events=[terminated])

    # 追赶hi故事（在reconnect上提供）带有差距events。
    def _list_factory():
        return _FakeEventsList([tool_use, requires_action])

    client = _make_client(
        [first_stream, second_stream], list_factory=_list_factory,
    )
    ws = _make_ws()
    session_state = SessionState.from_device("nonexistent-slug")

    await rm._forward_session_to_ws(
        ws=ws, client=client, session_id="sesn_test",
        device_slug="demo", memory_root=tmp_path,
        events_by_id={}, session_state=session_state,
        agent_model="claude-haiku-4-5", tier="fast",
        environment_id="env_test", repair_id=None, conv_id=None,
    )

    # 间隙工具在 reconnect 之后被调度一次。
    assert dispatch_calls == [("bv_highlight_component", {"refdes": "U7"})], (
        f"pending tool from catch-up history must be dispatched once, got "
        f"{dispatch_calls!r}"
    )
    # 正好一个 user.custom_tool_result reached MA — 解锁会话。
    sent = client.beta.sessions.events.send.await_args_list
    tool_results = [
        ev for call in sent
        for ev in call.kwargs.get("events", [])
        if ev.get("type") == "user.custom_tool_result"
    ]
    assert len(tool_results) == 1
    assert tool_results[0]["custom_tool_use_id"] == "sevt_gap_001"


@pytest.mark.asyncio
async def test_reconnect_catchup_does_not_redispatch_answered_tool(
    monkeypatch, tmp_path,
):
    """A tool already answered before a drop must NOT be re-dispatched when
    the same tool_use + requires_action reappear in the reconnect catch-up.

    `responded_tool_ids` persists across reconnects, so the catch-up replay
    of an already-answered requires_action is a no-op — no duplicate
    `user.custom_tool_result` (which MA would reject with HTTP 400).
    """
    from api.agent import runtime_managed as rm
    from api.session.state import SessionState

    _stale_settings(monkeypatch, rm, max_reconnects=2)

    dispatch_calls: list[tuple[str, dict]] = []

    async def fake_dispatch(name, payload, *_a, **_kw):
        dispatch_calls.append((name, payload))
        return {"ok": True}

    monkeypatch.setattr(rm, "_dispatch_tool", fake_dispatch)

    tool_use = SimpleNamespace(
        type="agent.custom_tool_use",
        id="sevt_dup_001",
        name="bv_focus_component",
        input={"refdes": "C12"},
    )
    requires_action = SimpleNamespace(
        type="session.status_idle",
        stop_reason=SimpleNamespace(
            type="requires_action", event_ids=["sevt_dup_001"],
        ),
    )
    terminated = SimpleNamespace(type="session.status_terminated")

    # 连接 #1：实时交付 tool_use + requires_action（我们回答），
    # 然后在任何终端 event 之前删除re。
    first_stream = _FakeStream(
        events=[tool_use, requires_action],
        raise_after=ConnectionError("drop after answering"),
    )
    # 连接＃2：安静的尾巴，干净地终止。
    second_stream = _FakeStream(events=[terminated])

    # 追赶hi故事re-提供相同的ready-answered events。
    def _list_factory():
        return _FakeEventsList([tool_use, requires_action])

    client = _make_client(
        [first_stream, second_stream], list_factory=_list_factory,
    )
    ws = _make_ws()
    session_state = SessionState.from_device("nonexistent-slug")

    await rm._forward_session_to_ws(
        ws=ws, client=client, session_id="sesn_test",
        device_slug="demo", memory_root=tmp_path,
        events_by_id={}, session_state=session_state,
        agent_model="claude-haiku-4-5", tier="fast",
        environment_id="env_test", repair_id=None, conv_id=None,
    )

    # 仅发送一次（实时），不会在追赶时再次发送。
    assert len(dispatch_calls) == 1, (
        f"answered tool must not re-dispatch on catch-up, got {dispatch_calls!r}"
    )
    sent = client.beta.sessions.events.send.await_args_list
    tool_results = [
        ev for call in sent
        for ev in call.kwargs.get("events", [])
        if ev.get("type") == "user.custom_tool_result"
    ]
    assert len(tool_results) == 1, (
        f"exactly one tool_result across the drop+reconnect, got {tool_results!r}"
    )


@pytest.mark.asyncio
async def test_requires_action_dedup_skips_second_dispatch(
    monkeypatch, tmp_path,
):
    """Re-emitted requires_action with same event_ids must NOT re-dispatch.

    MA occasionally re-emits `session.status_idle` with stop_reason=
    requires_action carrying event_ids we've already responded to. Sending
    a second user.custom_tool_result for the same id returns HTTP 400 and
    tears down the stream. The dedupe set short-circuits the second pass.
    """
    from api.agent import runtime_managed as rm
    from api.session.state import SessionState

    _stale_settings(monkeypatch, rm)

    # 存根调度程序，以便我们可以计算调用次数，而无需接触hing
    # full bv_* / mb_* tool surface.
    dispatch_calls: list[tuple[str, dict]] = []

    async def fake_dispatch(name, payload, *_a, **_kw):
        dispatch_calls.append((name, payload))
        return {"ok": True, "echo": payload}

    monkeypatch.setattr(rm, "_dispatch_tool", fake_dispatch)

    # 构建一个sequence：一个custom_tool_use，thenstatus_idlerequires_action，
    # then 具有相同 event_ids 的第二个 status_idle（re-emit）。
    tool_use = SimpleNamespace(
        type="agent.custom_tool_use",
        id="sevt_tool_001",
        name="bv_highlight_component",
        input={"refdes": "U7"},
    )
    requires_action_1 = SimpleNamespace(
        type="session.status_idle",
        stop_reason=SimpleNamespace(
            type="requires_action",
            event_ids=["sevt_tool_001"],
        ),
    )
    requires_action_2 = SimpleNamespace(
        type="session.status_idle",
        stop_reason=SimpleNamespace(
            type="requires_action",
            event_ids=["sevt_tool_001"],  # 相同的 id — 必须被跳过
        ),
    )
    end_turn = SimpleNamespace(
        type="session.status_idle",
        stop_reason=SimpleNamespace(type="end_turn", event_ids=[]),
    )

    stream = _FakeStream(events=[
        tool_use, requires_action_1, requires_action_2, end_turn,
    ])
    client = _make_client(stream)
    ws = _make_ws()
    session_state = SessionState.from_device("nonexistent-slug")

    await rm._forward_session_to_ws(
        ws=ws, client=client, session_id="sesn_test",
        device_slug="demo", memory_root=tmp_path,
        events_by_id={}, session_state=session_state,
        agent_model="claude-haiku-4-5", tier="fast",
        environment_id="env_test", repair_id=None, conv_id=None,
    )

    assert len(dispatch_calls) == 1, (
        f"dispatcher must run exactly once for a deduped tool use, got "
        f"{len(dispatch_calls)} calls: {dispatch_calls!r}"
    )
    # 恰好有一个 user.custom_tool_result 必须hit wire。
    sent_events = client.beta.sessions.events.send.await_args_list
    tool_results = [
        ev for call in sent_events
        for ev in call.kwargs.get("events", [])
        if ev.get("type") == "user.custom_tool_result"
    ]
    assert len(tool_results) == 1, (
        f"exactly one user.custom_tool_result expected, got {tool_results!r}"
    )
    assert tool_results[0]["custom_tool_use_id"] == "sevt_tool_001"


@pytest.mark.asyncio
async def test_processed_at_logs_consumption_delay(
    monkeypatch, tmp_path, caplog,
):
    """tool_result echo with processed_at populated must log the round-trip."""
    import logging

    from api.agent import runtime_managed as rm
    from api.session.state import SessionState

    _stale_settings(monkeypatch, rm)
    caplog.set_level(logging.INFO, logger=rm.logger.name)

    async def fake_dispatch(name, payload, *_a, **_kw):
        return {"ok": True}
    monkeypatch.setattr(rm, "_dispatch_tool", fake_dispatch)

    tool_use = SimpleNamespace(
        type="agent.custom_tool_use",
        id="sevt_pat_42",
        name="bv_focus_component",
        input={"refdes": "C12"},
    )
    requires_action = SimpleNamespace(
        type="session.status_idle",
        stop_reason=SimpleNamespace(
            type="requires_action", event_ids=["sevt_pat_42"],
        ),
    )
    # 回显 user.custom_tool_result，并填充processed_at —
    # this 是 MA 在 agent 之后的第二遍中 send 的值
    # 消耗了我们的re响应。
    echo = SimpleNamespace(
        type="user.custom_tool_result",
        custom_tool_use_id="sevt_pat_42",
        processed_at="2026-04-26T12:00:00Z",
    )
    end_turn = SimpleNamespace(
        type="session.status_idle",
        stop_reason=SimpleNamespace(type="end_turn", event_ids=[]),
    )

    stream = _FakeStream(events=[tool_use, requires_action, echo, end_turn])
    client = _make_client(stream)
    ws = _make_ws()
    session_state = SessionState.from_device("nonexistent-slug")

    await rm._forward_session_to_ws(
        ws=ws, client=client, session_id="sesn_test",
        device_slug="demo", memory_root=tmp_path,
        events_by_id={}, session_state=session_state,
        agent_model="claude-haiku-4-5", tier="fast",
        environment_id="env_test", repair_id=None, conv_id=None,
    )

    # Expect an INFO log carrying the eid + a delay= value.
    relevant = [
        r for r in caplog.records
        if "tool_result consumed" in r.getMessage()
        and "sevt_pat_42" in r.getMessage()
    ]
    assert relevant, (
        f"expected a tool_result consumption log, got "
        f"{[r.getMessage() for r in caplog.records]!r}"
    )


@pytest.mark.asyncio
async def test_processed_at_null_echo_is_ignored(
    monkeypatch, tmp_path, caplog,
):
    """The first echo (queued, processed_at=None) must NOT log a delay.

    MA echoes our user-sent events twice: once with processed_at=null
    (queued), once with a timestamp (processed). Logging on the queued
    pass would emit a misleading delay measurement before the agent
    has even seen the response.
    """
    import logging

    from api.agent import runtime_managed as rm
    from api.session.state import SessionState

    _stale_settings(monkeypatch, rm)
    caplog.set_level(logging.INFO, logger=rm.logger.name)

    queued_echo = SimpleNamespace(
        type="user.custom_tool_result",
        custom_tool_use_id="sevt_unknown_99",
        processed_at=None,
    )
    end_turn = SimpleNamespace(
        type="session.status_idle",
        stop_reason=SimpleNamespace(type="end_turn", event_ids=[]),
    )

    stream = _FakeStream(events=[queued_echo, end_turn])
    client = _make_client(stream)
    ws = _make_ws()
    session_state = SessionState.from_device("nonexistent-slug")

    await rm._forward_session_to_ws(
        ws=ws, client=client, session_id="sesn_test",
        device_slug="demo", memory_root=tmp_path,
        events_by_id={}, session_state=session_state,
        agent_model="claude-haiku-4-5", tier="fast",
        environment_id="env_test", repair_id=None, conv_id=None,
    )

    delay_logs = [
        r for r in caplog.records
        if "tool_result consumed" in r.getMessage()
    ]
    assert delay_logs == [], (
        f"queued (processed_at=None) echo must not produce a delay log, "
        f"got {[r.getMessage() for r in delay_logs]!r}"
    )


@pytest.mark.asyncio
async def test_full_turn_flow_message_tool_result_complete(
    monkeypatch, tmp_path,
):
    """End-to-end: agent.message → custom_tool_use → requires_action →
    dispatch → user.custom_tool_result → agent.message → end_turn.

    Replays the most common turn shape (tool-using assistant) through the
    full stream loop and asserts:

    * Both `agent.message` chunks reach the WS as `message` frames in
      order, sanitized.
    * The dispatcher runs once with the right name + payload.
    * `user.custom_tool_result` is sent back to MA with the dispatcher's
      result serialized as JSON, keyed by the original tool_use eid.
    * The closing `end_turn` lands as a `turn_complete` WS frame.

    This is the "happy path" the previous suite never covered — every
    other test exercised an edge (error, timeout, dedupe). A regression
    in any of the four steps above would have shipped silently before.
    """
    import json

    from api.agent import runtime_managed as rm
    from api.session.state import SessionState

    _stale_settings(monkeypatch, rm)

    # Capture 调度程序调用，以便我们可以对其 input 进行断言。
    dispatch_calls: list[tuple[str, dict]] = []

    async def fake_dispatch(name, payload, *_a, **_kw):
        dispatch_calls.append((name, payload))
        # runtime 从 result 中剥离 `event` / `events` 键 fr
        # before 序列化为 user.custom_tool_result，因此包含
        # 用于验证条带行为end-to-end。
        return {
            "ok": True,
            "highlighted": payload.get("refdes"),
            "event": {"type": "bv_highlight", "refdes": payload.get("refdes")},
        }

    monkeypatch.setattr(rm, "_dispatch_tool", fake_dispatch)

    # 整转序列ence，以便 MA emit 它。
    intro_message = SimpleNamespace(
        type="agent.message",
        content=[
            SimpleNamespace(type="text", text="Je vais surligner U7 pour vérifier."),
        ],
    )
    tool_use = SimpleNamespace(
        type="agent.custom_tool_use",
        id="sevt_full_001",
        name="bv_highlight_component",
        input={"refdes": "U7"},
    )
    requires_action = SimpleNamespace(
        type="session.status_idle",
        stop_reason=SimpleNamespace(
            type="requires_action", event_ids=["sevt_full_001"],
        ),
    )
    closing_message = SimpleNamespace(
        type="agent.message",
        content=[
            SimpleNamespace(type="text", text="U7 est surligné. Que mesures-tu ?"),
        ],
    )
    end_turn = SimpleNamespace(
        type="session.status_idle",
        stop_reason=SimpleNamespace(type="end_turn", event_ids=[]),
    )

    stream = _FakeStream(events=[
        intro_message, tool_use, requires_action, closing_message, end_turn,
    ])
    client = _make_client(stream)
    ws = _make_ws()
    session_state = SessionState.from_device("nonexistent-slug")

    await rm._forward_session_to_ws(
        ws=ws, client=client, session_id="sesn_test",
        device_slug="demo", memory_root=tmp_path,
        events_by_id={}, session_state=session_state,
        agent_model="claude-haiku-4-5", tier="fast",
        environment_id="env_test", repair_id=None, conv_id=None,
    )

    # ---- 断言----------------------------------------------------

    # 1. 两个agent.消息文本re都将WS按顺序设置为“消息”frames。
    payloads = [call.args[0] for call in ws.send_json.await_args_list]
    message_frames = [p for p in payloads if p.get("type") == "message"]
    assert len(message_frames) == 2, (
        f"expected 2 message frames (intro + closing), got {len(message_frames)}: "
        f"{message_frames!r}"
    )
    assert message_frames[0]["role"] == "assistant"
    assert "U7" in message_frames[0]["text"]
    assert "mesures" in message_frames[1]["text"]

    # 2. tool_use frame 已发布到WS，以便UI 聊天可以显示它。
    tool_use_frames = [p for p in payloads if p.get("type") == "tool_use"]
    assert len(tool_use_frames) == 1
    assert tool_use_frames[0]["name"] == "bv_highlight_component"
    assert tool_use_frames[0]["input"] == {"refdes": "U7"}

    # 3. 调度程序以正确的 input 运行了一次。
    assert dispatch_calls == [("bv_highlight_component", {"refdes": "U7"})], (
        f"dispatcher invocation mismatch: {dispatch_calls!r}"
    )

    # 4. user.custom_tool_result 被 pos 发送回 MA，eid + JSON
    #    主体，并且`event`密钥被从agent面向的支付load中剥离了fr。
    sent_events = client.beta.sessions.events.send.await_args_list
    tool_results = [
        ev for call in sent_events
        for ev in call.kwargs.get("events", [])
        if ev.get("type") == "user.custom_tool_result"
    ]
    assert len(tool_results) == 1
    tr = tool_results[0]
    assert tr["custom_tool_use_id"] == "sevt_full_001"
    body = json.loads(tr["content"][0]["text"])
    assert body == {"ok": True, "highlighted": "U7"}, (
        f"event/events keys must be stripped from agent-facing tool_result, "
        f"got {body!r}"
    )

    # 5.turn_complete WSframe 在end_turn emitted。
    turn_complete_frames = [p for p in payloads if p.get("type") == "turn_complete"]
    assert len(turn_complete_frames) == 1, (
        f"expected exactly one turn_complete frame, got {len(turn_complete_frames)}"
    )
    assert turn_complete_frames[0]["stop_reason"] == "end_turn"
