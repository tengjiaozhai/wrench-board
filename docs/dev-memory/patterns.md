## 非 Claude 模型适配 pipeline 调用

场景：
- 当 Anthropic 兼容端点（mimo-v2.5 等）替代 Claude 驱动力 pipeline 的 `call_with_forced_tool` 时

规则：
1. **`thinking` 必须显式关闭** — 对非 Claude 模型设置 `thinking={"type":"disabled"}`（不能仅 pop 掉 thinking 键）。否则模型会将整个输出预算用于思考块，永远不会调用工具
2. **system prompt 必须有 CRITICAL 指令** — 追加 `"CRITICAL: You MUST call the X tool now. Do NOT output text-only responses."`。mimo 在没有显式指令调用工具时倾向于输出纯文本
3. **禁用 cache_control** — 非 Claude 代理的 prompt 缓存与 Anthropic 的 `cache_control` 机制交互方式不可靠，可能会返回缓存的错误响应（文本模式而非工具调用）
4. **跳过 grounding** — 如果 grounding 上下文使 prompt 超过 16k input tokens，应跳过它（`use_grounding and is_claude_model`）
5. **批量调用必须容错** — 在并行 LLM 调用中加入 `return_exceptions=True`，以便单个调用失败不会级联取消整个 batch
6. **max_tokens 保持 ≤8192** — 对于非流式调用，保持在此限制以下；对于流式调用，尝试 32k 以容纳完整的 thinking + tool_use

示例：
```python
is_claude = str(model).startswith("claude-")

# 1. 禁用 thinking
if not is_claude:
    stream_kwargs["thinking"] = {"type": "disabled"}

# 2. 强化 system prompt
if not is_claude:
    system_text = system_text + "\n\nCRITICAL: You MUST call the X tool."

# 3. 禁用 cache_control
cache_marker = {"type": "ephemeral"} if is_claude else None

# 4. 跳过 grounding
if use_grounding and is_claude:
    ...

# 5. 容错的 gather
raw_results = await asyncio.gather(*tasks, return_exceptions=True)
```
