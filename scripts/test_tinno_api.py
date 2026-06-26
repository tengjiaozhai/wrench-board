"""调试 tinno qwen API 的 "Unexpected item type in content" 错误。

逐步测试不同的 content block 格式，找出哪个字段不被支持。
"""
import asyncio
import base64
import os
import sys
from pathlib import Path

# 加载 .env
sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv()

from anthropic import AsyncAnthropic


def get_client() -> AsyncAnthropic:
    """创建 Anthropic 客户端（使用 .env 中的配置）。"""
    from api.config import get_settings
    settings = get_settings()
    kwargs = {"api_key": settings.anthropic_api_key}
    if settings.anthropic_base_url:
        kwargs["base_url"] = settings.anthropic_base_url
    return AsyncAnthropic(**kwargs)


async def test_basic_text():
    """测试 1: 纯文本消息。"""
    print("\n=== Test 1: Basic text message ===")
    client = get_client()
    try:
        response = await client.messages.create(
            model="qwen3.7-max",
            max_tokens=100,
            messages=[{"role": "user", "content": "Hello, say hi"}],
        )
        print(f"OK: {response.content[0].text[:50]}")
        return True
    except Exception as e:
        print(f"FAIL: {e}")
        return False


async def test_with_image():
    """测试 2: 带图片的消息。"""
    print("\n=== Test 2: Message with image ===")
    client = get_client()
    # 创建一个小的测试 PNG (1x1 红色像素)
    png_bytes = bytes([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,  # PNG signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,  # IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,  # 1x1
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,  # 8-bit RGB
        0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,  # IDAT chunk
        0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
        0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
        0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,  # IEND chunk
        0x44, 0xAE, 0x42, 0x60, 0x82,
    ])
    b64 = base64.b64encode(png_bytes).decode("ascii")
    
    try:
        response = await client.messages.create(
            model="qwen3.7-max",
            max_tokens=100,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe this image:"},
                    {"type": "image", "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": b64,
                    }},
                ],
            }],
        )
        print(f"OK: {response.content[0].text[:50]}")
        return True
    except Exception as e:
        print(f"FAIL: {e}")
        return False


async def test_with_tools():
    """测试 3: 带 tools 的消息。"""
    print("\n=== Test 3: Message with tools ===")
    client = get_client()
    try:
        response = await client.messages.create(
            model="qwen3.7-max",
            max_tokens=500,
            messages=[{"role": "user", "content": "What is 2+2? Use the calculator tool."}],
            tools=[{
                "name": "calculator",
                "description": "A simple calculator",
                "input_schema": {
                    "type": "object",
                    "properties": {"expression": {"type": "string"}},
                    "required": ["expression"],
                },
            }],
            tool_choice={"type": "auto"},
        )
        print(f"OK: {[b.type for b in response.content]}")
        return True
    except Exception as e:
        print(f"FAIL: {e}")
        return False


async def test_with_tool_cache_control():
    """测试 4: tool 定义带 cache_control。"""
    print("\n=== Test 4: Tool with cache_control ===")
    client = get_client()
    try:
        response = await client.messages.create(
            model="qwen3.7-max",
            max_tokens=500,
            messages=[{"role": "user", "content": "What is 2+2? Use the calculator tool."}],
            tools=[{
                "name": "calculator",
                "description": "A simple calculator",
                "input_schema": {
                    "type": "object",
                    "properties": {"expression": {"type": "string"}},
                    "required": ["expression"],
                },
                "cache_control": {"type": "ephemeral"},  # 这个可能导致问题
            }],
            tool_choice={"type": "auto"},
        )
        print(f"OK: {[b.type for b in response.content]}")
        return True
    except Exception as e:
        print(f"FAIL: {e}")
        return False


async def test_with_system_cache_control():
    """测试 5: system 带 cache_control。"""
    print("\n=== Test 5: System with cache_control ===")
    client = get_client()
    try:
        response = await client.messages.create(
            model="qwen3.7-max",
            max_tokens=100,
            system=[{
                "type": "text",
                "text": "You are a helpful assistant.",
                "cache_control": {"type": "ephemeral"},  # 这个可能导致问题
            }],
            messages=[{"role": "user", "content": "Hello"}],
        )
        print(f"OK: {response.content[0].text[:50]}")
        return True
    except Exception as e:
        print(f"FAIL: {e}")
        return False


async def test_with_thinking():
    """测试 6: 带 thinking 参数。"""
    print("\n=== Test 6: With thinking parameter ===")
    client = get_client()
    try:
        response = await client.messages.create(
            model="qwen3.7-max",
            max_tokens=1000,
            thinking={"type": "adaptive", "display": "summarized"},
            messages=[{"role": "user", "content": "What is 15 * 23?"}],
        )
        print(f"OK: {[b.type for b in response.content]}")
        return True
    except Exception as e:
        print(f"FAIL: {e}")
        return False


async def test_with_thinking_disabled():
    """测试 7: thinking disabled。"""
    print("\n=== Test 7: With thinking disabled ===")
    client = get_client()
    try:
        response = await client.messages.create(
            model="qwen3.7-max",
            max_tokens=100,
            thinking={"type": "disabled"},
            messages=[{"role": "user", "content": "Hello"}],
        )
        print(f"OK: {response.content[0].text[:50]}")
        return True
    except Exception as e:
        print(f"FAIL: {e}")
        return False


async def test_with_output_config():
    """测试 8: 带 output_config.effort。"""
    print("\n=== Test 8: With output_config.effort ===")
    client = get_client()
    try:
        response = await client.messages.create(
            model="qwen3.7-max",
            max_tokens=100,
            output_config={"effort": "high"},
            messages=[{"role": "user", "content": "Hello"}],
        )
        print(f"OK: {response.content[0].text[:50]}")
        return True
    except Exception as e:
        print(f"FAIL: {e}")
        return False


async def test_full_page_vision_scenario():
    """测试 9: 模拟完整的 page_vision 场景。"""
    print("\n=== Test 9: Full page_vision scenario ===")
    client = get_client()
    
    # 创建一个小的测试 PNG
    png_bytes = bytes([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
        0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
        0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
        0x44, 0xAE, 0x42, 0x60, 0x82,
    ])
    b64 = base64.b64encode(png_bytes).decode("ascii")
    
    try:
        response = await client.messages.create(
            model="qwen3.7-max",
            max_tokens=8192,
            system=[{
                "type": "text",
                "text": "You are a schematic analyzer.",
                "cache_control": {"type": "ephemeral"},
            }],
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": "Device: Test. Page 1 of 1. Orientation: portrait."},
                    {"type": "image", "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": b64,
                    }},
                    {"type": "text", "text": "Analyze this page."},
                ],
            }],
            tools=[{
                "name": "submit_schematic_page",
                "description": "Submit analysis",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "page": {"type": "integer"},
                        "components": {"type": "array", "items": {"type": "object"}},
                    },
                },
                "cache_control": {"type": "ephemeral"},
            }],
            tool_choice={"type": "auto"},
        )
        print(f"OK: {[b.type for b in response.content]}")
        return True
    except Exception as e:
        print(f"FAIL: {e}")
        return False


async def test_image_formats():
    """测试不同的 image 格式支持。"""
    print("\n=== Test: Image format variations ===")
    client = get_client()
    
    png_bytes = bytes([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
        0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
        0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
        0x44, 0xAE, 0x42, 0x60, 0x82,
    ])
    b64 = base64.b64encode(png_bytes).decode("ascii")
    
    # 测试 1: 标准 image block
    print("\n  1. Standard image block (type='image'):")
    try:
        response = await client.messages.create(
            model="qwen3.7-max",
            max_tokens=100,
            thinking={"type": "disabled"},
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": "What is this?"},
                    {"type": "image", "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": b64,
                    }},
                ],
            }],
        )
        print(f"     OK: {response.content[0].text[:30]}")
    except Exception as e:
        print(f"     FAIL: {e}")
    
    # 测试 2: 只用文本，不用图片
    print("\n  2. Text only (no image):")
    try:
        response = await client.messages.create(
            model="qwen3.7-max",
            max_tokens=100,
            thinking={"type": "disabled"},
            messages=[{
                "role": "user",
                "content": [{"type": "text", "text": "Say hello"}],
            }],
        )
        print(f"     OK: {response.content[0].text[:30]}")
    except Exception as e:
        print(f"     FAIL: {e}")
    
    # 测试 3: 检查 API 是否支持 vision 模型
    print("\n  3. Check if vision model is available:")
    print("     (qwen3.7-max may not support vision/image input)")
    print("     Try using a vision-capable model like qwen-vl-max if available")


async def main():
    """运行所有测试。"""
    print("Testing tinno qwen API compatibility...")
    print("=" * 60)
    
    await test_image_formats()
    
    print("\n" + "=" * 60)
    print("CONCLUSION:")
    print("=" * 60)
    print("The 'Unexpected item type in content' error is caused by")
    print("the image content block not being supported by tinno qwen API.")
    print("\nSchematic ingestion requires vision capabilities.")
    print("Options:")
    print("  1. Use a vision-capable model (e.g., qwen-vl-max, claude-sonnet)")
    print("  2. Contact tinno to enable vision support for qwen3.7-max")
    print("  3. Set ANTHROPIC_MODEL_MAIN to a different model for schematic tasks")


if __name__ == "__main__":
    asyncio.run(main())
