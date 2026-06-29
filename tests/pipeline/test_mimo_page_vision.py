"""模拟 page_vision 场景测试 mimo 模型。

运行方式:
    .venv/bin/python scripts/check_mimo_page_vision.py
"""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def load_env():
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    os.environ[key.strip()] = value.strip()

load_env()

from anthropic import AsyncAnthropic


async def test_page_vision_scenario():
    """模拟 page_vision 场景。"""

    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    base_url = os.getenv("ANTHROPIC_BASE_URL", "")
    model = os.getenv("ANTHROPIC_MODEL_MAIN", "mimo-v2.5")

    print(f"模型: {model}")
    print("=" * 60)

    client = AsyncAnthropic(
        api_key=api_key,
        base_url=base_url if base_url else None,
    )

    # 模拟 page_vision 的工具定义 (简化版)
    submit_page_tool = {
        "name": "submit_schematic_page",
        "description": "Submit the structured analysis of one schematic page.",
        "input_schema": {
            "type": "object",
            "properties": {
                "page": {"type": "integer", "description": "Page number"},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "nodes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "refdes": {"type": "string"},
                            "type": {"type": "string"},
                        },
                        "required": ["refdes", "type"],
                    },
                },
            },
            "required": ["page", "confidence", "nodes"],
        },
    }

    system_prompt = """You are an expert electronics technician and schematic analyst.

You will receive one rendered page of a board-level schematic PDF. Your job is
to emit a single `submit_schematic_page` tool call whose payload matches the
SchematicPageGraph schema precisely.

Hard rules - NEVER violate:
1. Never invent a refdes, net label, pin number, value, or MPN.
2. Populate nodes with components you can see on the page.
3. Use confidence honestly in [0.0, 1.0]."""

    user_content = [
        {"type": "text", "text": "Device: Test Device. Page 1 of 1. Orientation: landscape."},
        {"type": "text", "text": "Analyse this page and call the submit_schematic_page tool."},
    ]

    # 测试 1: tool_choice="auto" + thinking (模拟 page_vision 的配置)
    print("\n测试 1: page_vision 配置 (auto + thinking)")
    print("-" * 40)
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=32768,
            system=system_prompt,
            messages=[{"role": "user", "content": user_content}],
            tools=[submit_page_tool],
            tool_choice={"type": "auto"},
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": "high"},
        )
        print(f"stop_reason: {response.stop_reason}")
        print(f"content blocks: {[b.type for b in response.content]}")
        for b in response.content:
            if b.type == "tool_use":
                print(f"  tool_use: name={b.name}")
                print(f"  input keys: {list(b.input.keys())}")
            elif b.type == "text":
                print(f"  text: {b.text[:200]}...")
            elif b.type == "thinking":
                print(f"  thinking: present")
    except Exception as e:
        print(f"错误: {type(e).__name__}: {e}")

    # 测试 2: tool_choice="auto" (无 thinking)
    print("\n测试 2: auto (无 thinking)")
    print("-" * 40)
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=32768,
            system=system_prompt,
            messages=[{"role": "user", "content": user_content}],
            tools=[submit_page_tool],
            tool_choice={"type": "auto"},
        )
        print(f"stop_reason: {response.stop_reason}")
        print(f"content blocks: {[b.type for b in response.content]}")
        for b in response.content:
            if b.type == "tool_use":
                print(f"  tool_use: name={b.name}")
            elif b.type == "text":
                print(f"  text: {b.text[:200]}...")
    except Exception as e:
        print(f"错误: {type(e).__name__}: {e}")

    # 测试 3: tool_choice="tool" (强制工具)
    print("\n测试 3: 强制工具")
    print("-" * 40)
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=32768,
            system=system_prompt,
            messages=[{"role": "user", "content": user_content}],
            tools=[submit_page_tool],
            tool_choice={"type": "tool", "name": "submit_schematic_page"},
        )
        print(f"stop_reason: {response.stop_reason}")
        print(f"content blocks: {[b.type for b in response.content]}")
        for b in response.content:
            if b.type == "tool_use":
                print(f"  tool_use: name={b.name}")
            elif b.type == "text":
                print(f"  text: {b.text[:200]}...")
    except Exception as e:
        print(f"错误: {type(e).__name__}: {e}")

    # 测试 4: 使用非流式 API (模拟第三方兼容模式)
    print("\n测试 4: 非流式 API (第三方兼容模式)")
    print("-" * 40)
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=8192,
            system=system_prompt,
            messages=[{"role": "user", "content": user_content}],
            tools=[submit_page_tool],
            tool_choice={"type": "tool", "name": "submit_schematic_page"},
        )
        print(f"stop_reason: {response.stop_reason}")
        print(f"content blocks: {[b.type for b in response.content]}")
        for b in response.content:
            if b.type == "tool_use":
                print(f"  tool_use: name={b.name}")
                print(f"  input: {json.dumps(b.input, indent=2)[:500]}")
            elif b.type == "text":
                print(f"  text: {b.text[:200]}...")
    except Exception as e:
        print(f"错误: {type(e).__name__}: {e}")


if __name__ == "__main__":
    asyncio.run(test_page_vision_scenario())
