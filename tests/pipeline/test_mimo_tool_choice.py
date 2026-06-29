"""检查 mimo 模型对 tool_choice 的支持情况。

运行方式:
    .venv/bin/python scripts/check_mimo_tool_choice.py

测试项目:
1. tool_choice="auto" + thinking → 模型行为
2. tool_choice="auto" (无 thinking) → 模型行为
3. tool_choice="tool" (强制工具) → 模型行为
4. 纯文本输出 → 模型行为
"""

import asyncio
import json
import os
import sys
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 从 .env 文件加载环境变量
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


async def test_mimo_tool_choice():
    """测试 mimo 模型对不同 tool_choice 配置的响应。"""

    # 从环境变量加载配置
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    base_url = os.getenv("ANTHROPIC_BASE_URL", "")
    model = os.getenv("ANTHROPIC_MODEL_MAIN", "mimo-v2.5")

    if not api_key:
        print("错误: 未设置 ANTHROPIC_API_KEY")
        return

    print(f"模型: {model}")
    print(f"Base URL: {base_url}")
    print("=" * 60)

    client = AsyncAnthropic(
        api_key=api_key,
        base_url=base_url if base_url else None,
    )

    # 定义一个简单的测试工具
    test_tool = {
        "name": "test_submit",
        "description": "Submit a test result",
        "input_schema": {
            "type": "object",
            "properties": {
                "result": {"type": "string", "description": "Test result"},
            },
            "required": ["result"],
        },
    }

    messages = [
        {"role": "user", "content": "Please call the test_submit tool with result='hello'"}
    ]

    # 测试 1: tool_choice="auto" + thinking
    print("\n测试 1: tool_choice='auto' + thinking")
    print("-" * 40)
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=1000,
            system="You must call the test_submit tool.",
            messages=messages,
            tools=[test_tool],
            tool_choice={"type": "auto"},
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": "high"},
        )
        print(f"stop_reason: {response.stop_reason}")
        print(f"content blocks: {[b.type for b in response.content]}")
        for b in response.content:
            if b.type == "tool_use":
                print(f"  tool_use: name={b.name}, input={b.input}")
            elif b.type == "text":
                print(f"  text: {b.text[:100]}...")
            elif b.type == "thinking":
                print(f"  thinking: {str(b)[:100]}...")
    except Exception as e:
        print(f"错误: {e}")

    # 测试 2: tool_choice="auto" (无 thinking)
    print("\n测试 2: tool_choice='auto' (无 thinking)")
    print("-" * 40)
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=1000,
            system="You must call the test_submit tool.",
            messages=messages,
            tools=[test_tool],
            tool_choice={"type": "auto"},
        )
        print(f"stop_reason: {response.stop_reason}")
        print(f"content blocks: {[b.type for b in response.content]}")
        for b in response.content:
            if b.type == "tool_use":
                print(f"  tool_use: name={b.name}, input={b.input}")
            elif b.type == "text":
                print(f"  text: {b.text[:100]}...")
    except Exception as e:
        print(f"错误: {e}")

    # 测试 3: tool_choice="tool" (强制工具)
    print("\n测试 3: tool_choice='tool' (强制工具)")
    print("-" * 40)
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=1000,
            system="You must call the test_submit tool.",
            messages=messages,
            tools=[test_tool],
            tool_choice={"type": "tool", "name": "test_submit"},
        )
        print(f"stop_reason: {response.stop_reason}")
        print(f"content blocks: {[b.type for b in response.content]}")
        for b in response.content:
            if b.type == "tool_use":
                print(f"  tool_use: name={b.name}, input={b.input}")
            elif b.type == "text":
                print(f"  text: {b.text[:100]}...")
    except Exception as e:
        print(f"错误: {e}")

    # 测试 4: 纯文本输出 (无工具)
    print("\n测试 4: 纯文本输出 (无工具)")
    print("-" * 40)
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=1000,
            system="You are a helpful assistant.",
            messages=[{"role": "user", "content": "Say hello in one word."}],
        )
        print(f"stop_reason: {response.stop_reason}")
        print(f"content blocks: {[b.type for b in response.content]}")
        for b in response.content:
            if b.type == "text":
                print(f"  text: {b.text[:100]}...")
    except Exception as e:
        print(f"错误: {e}")

    # 测试 5: tool_choice="auto" + thinking + 复杂 schema
    print("\n测试 5: tool_choice='auto' + thinking + 复杂 schema")
    print("-" * 40)
    complex_tool = {
        "name": "submit_analysis",
        "description": "Submit analysis results",
        "input_schema": {
            "type": "object",
            "properties": {
                "nodes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "type": {"type": "string"},
                            "value": {"type": "string"},
                        },
                        "required": ["id", "type"],
                    },
                },
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["nodes", "confidence"],
        },
    }
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=2000,
            system="Analyze the input and call submit_analysis with results.",
            messages=[{"role": "user", "content": "Analyze: node1 is a resistor with value 10k"}],
            tools=[complex_tool],
            tool_choice={"type": "auto"},
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": "high"},
        )
        print(f"stop_reason: {response.stop_reason}")
        print(f"content blocks: {[b.type for b in response.content]}")
        for b in response.content:
            if b.type == "tool_use":
                print(f"  tool_use: name={b.name}")
                print(f"  input: {json.dumps(b.input, indent=2)[:500]}")
            elif b.type == "text":
                print(f"  text: {b.text[:200]}...")
            elif b.type == "thinking":
                print(f"  thinking: {str(b)[:100]}...")
    except Exception as e:
        print(f"错误: {e}")


if __name__ == "__main__":
    asyncio.run(test_mimo_tool_choice())
