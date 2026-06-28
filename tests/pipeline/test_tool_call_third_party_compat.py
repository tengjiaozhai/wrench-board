"""_needs_third_party_forced_tool_compat: covers qwen, mimo, and native Anthropic
models. Regression: mimo-v2.5 via token-plan-cn relay was not detected, causing
thinking + auto tool_choice to be sent to a non-Anthropic endpoint that doesn't
support extended thinking — the model returned garbage and the page vision call
failed after 2 attempts."""
from __future__ import annotations

import pytest

from api.pipeline.tool_call import _needs_third_party_forced_tool_compat


@pytest.mark.parametrize(
    "model",
    [
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
        "claude-3-5-sonnet-20241022",
    ],
)
def test_native_anthropic_models_return_false(model: str) -> None:
    assert _needs_third_party_forced_tool_compat(model) is False


@pytest.mark.parametrize(
    "model",
    [
        "qwen-vl-max",
        "qwen2.5-72b-instruct",
        "Qwen-VL-Max",
        "openai/qwen-vl-max",
    ],
)
def test_qwen_models_return_true(model: str) -> None:
    assert _needs_third_party_forced_tool_compat(model) is True


@pytest.mark.parametrize(
    "model",
    [
        "mimo-v2.5",
        "mimo-v2",
        "Mimo-V2.5",
        "MIMO-V3",
        "tinnoapi/mimo-v2.5",
    ],
)
def test_mimo_models_return_true(model: str) -> None:
    assert _needs_third_party_forced_tool_compat(model) is True


def test_empty_string_returns_false() -> None:
    assert _needs_third_party_forced_tool_compat("") is False


def test_unrelated_model_name_returns_false() -> None:
    assert _needs_third_party_forced_tool_compat("gpt-4o") is False
    assert _needs_third_party_forced_tool_compat("gemini-2.0-flash") is False
