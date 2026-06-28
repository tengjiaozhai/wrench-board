"""Scout third-party model compatibility.

Scout uses Anthropic's native `web_search` tool and `thinking` parameter,
which third-party relays (qwen, mimo) don't support. For third-party models,
Scout should fail fast with a clear error instead of wasting tokens.

Regression: mimo-v2.5 via token-plan-cn relay sent thinking + web_search,
model returned thinking + tool_use (no text), Scout crashed with
"Produced no text output".
"""
from __future__ import annotations

import pytest

from api.pipeline.scout import _scout_once
from api.pipeline.tool_call import _needs_third_party_forced_tool_compat

pytestmark = pytest.mark.asyncio


class _Block:
    def __init__(self, type: str, text: str | None = None):
        self.type = type
        self.text = text


class _Usage:
    input_tokens = 100
    output_tokens = 50
    cache_read_input_tokens = 0
    cache_creation_input_tokens = 0


class _Resp:
    def __init__(self, content, stop_reason="end_turn"):
        self.content = content
        self.usage = _Usage()
        self.stop_reason = stop_reason


class _Messages:
    def __init__(self, responses, calls):
        self._responses = responses
        self._calls = calls

    async def create(self, **kwargs):
        self._calls.append(kwargs)
        return self._responses[len(self._calls) - 1]


class _Client:
    def __init__(self, responses, calls):
        self.messages = _Messages(responses, calls)


async def test_scout_third_party_model_raises_clear_error():
    """Third-party models should fail fast with a clear error about web_search."""
    calls: list[dict] = []
    responses = []  # Should never reach the API call
    client = _Client(responses, calls)

    with pytest.raises(RuntimeError, match="web_search tool is not supported"):
        await _scout_once(
            client=client,
            model="mimo-v2.5",
            device_label="Test Device",
            device_kind=None,
            focus_symptom=None,
            max_continuations=1,
            attempt=0,
        )

    # Should NOT have made any API calls
    assert len(calls) == 0


async def test_scout_qwen_raises_clear_error():
    """Qwen models should also fail fast with a clear error."""
    calls: list[dict] = []
    responses = []
    client = _Client(responses, calls)

    with pytest.raises(RuntimeError, match="web_search tool is not supported"):
        await _scout_once(
            client=client,
            model="qwen-vl-max",
            device_label="Test Device",
            device_kind=None,
            focus_symptom=None,
            max_continuations=1,
            attempt=0,
        )

    assert len(calls) == 0


async def test_scout_includes_thinking_for_native_anthropic():
    """Native Anthropic models should receive thinking parameter."""
    calls: list[dict] = []
    responses = [
        _Resp([_Block("text", "Sample research output with content.")])
    ]
    client = _Client(responses, calls)

    await _scout_once(
        client=client,
        model="claude-opus-4-8",
        device_label="Test Device",
        device_kind=None,
        focus_symptom=None,
        max_continuations=1,
        attempt=0,
    )

    assert len(calls) == 1
    call_kwargs = calls[0]
    # Native Anthropic models should have thinking parameter
    assert "thinking" in call_kwargs
    assert call_kwargs["thinking"]["type"] == "adaptive"


async def test_third_party_detection_consistency():
    """Ensure _needs_third_party_forced_tool_compat covers all tested models."""
    # Third-party models
    assert _needs_third_party_forced_tool_compat("mimo-v2.5") is True
    assert _needs_third_party_forced_tool_compat("qwen-vl-max") is True

    # Native Anthropic models
    assert _needs_third_party_forced_tool_compat("claude-opus-4-8") is False
    assert _needs_third_party_forced_tool_compat("claude-sonnet-4-6") is False
