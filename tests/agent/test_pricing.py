"""Unit tests for the turn-cost estimator."""

from __future__ import annotations

from types import SimpleNamespace

from api.agent.pricing import compute_turn_cost, cost_from_response


def test_haiku_simple_turn_cost():
    # 10k input + Haiku 上的 2k 输出 = $0.01 + $0.01 = $0.02
    cost = compute_turn_cost("claude-haiku-4-5", input_tokens=10_000, output_tokens=2_000)
    assert cost["priced"] is True
    assert abs(cost["cost_usd"] - 0.02) < 1e-6


def test_opus_turn_cost_higher():
    # Opus 4.7/4.8，每 MTok 5 美元/25 美元（post-4.5 tier，不是旧版
    # Opus 4.1 的 15 美元/75 美元）。 10k input + 2k 产出 = $0.05 + $0.05 = $0.10
    cost = compute_turn_cost("claude-opus-4-7", input_tokens=10_000, output_tokens=2_000)
    assert abs(cost["cost_usd"] - 0.10) < 1e-6
    # Opus 4.8 share与tier相同 - 活动的“deep”型号必须定价。
    cost_48 = compute_turn_cost("claude-opus-4-8", input_tokens=10_000, output_tokens=2_000)
    assert cost_48["priced"] is True
    assert abs(cost_48["cost_usd"] - 0.10) < 1e-6


def test_cache_read_cheaper_than_fresh_input():
    """10k cache_read input should cost 10% of fresh input."""
    fresh = compute_turn_cost("claude-sonnet-4-6", input_tokens=10_000)
    cached = compute_turn_cost(
        "claude-sonnet-4-6", cache_read_input_tokens=10_000
    )
    assert abs(cached["cost_usd"] - fresh["cost_usd"] * 0.10) < 1e-6


def test_cache_write_is_more_expensive():
    """Cache write has a 25% premium over fresh input."""
    fresh = compute_turn_cost("claude-sonnet-4-6", input_tokens=10_000)
    written = compute_turn_cost(
        "claude-sonnet-4-6", cache_creation_input_tokens=10_000
    )
    assert abs(written["cost_usd"] - fresh["cost_usd"] * 1.25) < 1e-6


def test_unknown_model_returns_zero_priced_false():
    cost = compute_turn_cost("mystery-model-9", input_tokens=100, output_tokens=100)
    assert cost["priced"] is False
    assert cost["cost_usd"] == 0.0
    # Token 计数re 仍然回显，因此 UI 仍然可以显示“1234 tokens，价格未知”。
    assert cost["input_tokens"] == 100


def test_cost_from_response_shape():
    usage = SimpleNamespace(
        input_tokens=5_000,
        output_tokens=1_000,
        cache_read_input_tokens=12_000,
        cache_creation_input_tokens=0,
    )
    cost = cost_from_response("claude-haiku-4-5", usage)
    # 5k*$1 + 1k*$5 + 12k*$1*0.10 = $0.005 + $0.005 + $0.0012 = $0.0112
    assert abs(cost["cost_usd"] - 0.0112) < 1e-6
    assert cost["cache_read_input_tokens"] == 12_000
