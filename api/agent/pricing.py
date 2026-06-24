"""诊断会话的每轮令牌成本估算。

定价按型号系列进行跟踪。缓存语义适用：cache_read
输入费用为基本输入速率的 10%，cache_creation 为 125%。

数字是best-effort的估计值——它们提供了“每条消息的成本/
技术人员在聊天面板中看到“总体对话”表面。如果Anthropic
改变价格，在这里撞桌子。偏离一两分就可以了——
目标是让关于代币花费的技术原因得以实现，而不是调和
发票。"""

from __future__ import annotations

from typing import Any

# 以美元计算的每百万代币汇率，源自
# https://platform.claude.com/docs/en/about-claude/pricing（2026 年 4 月）。
# Opus 从 Opus 4.5 的旧版 $15/$75 等级下降； 4.7/4.8 保持 5 美元/25 美元。
MODEL_PRICING: dict[str, dict[str, float]] = {
    "claude-haiku-4-5":  {"input": 1.00, "output": 5.00},
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00},
    "claude-opus-4-7":   {"input": 5.00, "output": 25.00},
    "claude-opus-4-8":   {"input": 5.00, "output": 25.00},
}

# 应用于基本输入速率的缓存层乘数。
CACHE_READ_MULTIPLIER  = 0.10
CACHE_WRITE_MULTIPLIER = 1.25


def compute_turn_cost(
    model: str,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
) -> dict[str, Any]:
    """返回一回合的美元成本明细。

    `input_tokens` 是可计费的非缓存输入； ⟦保留2⟧
    和 `cache_creation_input_tokens` 按其自己的乘数定价
    并且不应在`input_tokens`中重复计算。 This matches the
    Anthropic 使用形状。"""
    rates = MODEL_PRICING.get(model)
    if rates is None:
        return {
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_input_tokens": cache_read_input_tokens,
            "cache_creation_input_tokens": cache_creation_input_tokens,
            "cost_usd": 0.0,
            "priced": False,
        }
    base_in  = rates["input"]
    base_out = rates["output"]
    cost = 0.0
    cost += (input_tokens  / 1_000_000.0) * base_in
    cost += (output_tokens / 1_000_000.0) * base_out
    cost += (cache_read_input_tokens     / 1_000_000.0) * base_in * CACHE_READ_MULTIPLIER
    cost += (cache_creation_input_tokens / 1_000_000.0) * base_in * CACHE_WRITE_MULTIPLIER
    return {
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_input_tokens": cache_read_input_tokens,
        "cache_creation_input_tokens": cache_creation_input_tokens,
        "cost_usd": round(cost, 6),
        "priced": True,
    }


def cost_from_response(model: str, usage: Any) -> dict[str, Any]:
    """从人为的 `Message.usage` 对象计算成本。"""
    return compute_turn_cost(
        model,
        input_tokens=getattr(usage, "input_tokens", 0) or 0,
        output_tokens=getattr(usage, "output_tokens", 0) or 0,
        cache_read_input_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
        cache_creation_input_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
    )
