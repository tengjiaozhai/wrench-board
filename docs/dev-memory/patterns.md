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

## 服务器启动：必须显式传递环境变量

场景：
- 在 macOS 上启动 wrench-board 开发服务器

规则：
1. **`.env` 只被 Python 读取** — `start.sh` 是 bash 脚本，用 `${VAR:-default}` 从 shell 环境读取，不调用 `load_dotenv()`
2. **三个变量必须作为 shell 前缀传递** — `PATH`、`DIAGNOSTIC_MODE`、`PORT`
3. **非默认端口必须更新 CORS** — `cors_allow_origins` 默认只有 `:8000` 和 `:5173`
4. **pdftoppm 在 `/opt/homebrew/bin/`** — 非交互式 shell 的 PATH 不含此目录

启动命令模板：
```bash
PATH="/opt/homebrew/bin:$PATH" DIAGNOSTIC_MODE=direct PORT=9000 make run
```

检查清单：
- [ ] `.env` 中 `PORT=9000`（或目标端口）
- [ ] `.env` 中 `CORS_ALLOW_ORIGINS` 包含目标端口
- [ ] shell 前缀包含 `PATH="/opt/homebrew/bin:$PATH"`
- [ ] shell 前缀包含 `DIAGNOSTIC_MODE=direct`（小米 relay 不支持 MA beta）

## 手动触发 schematic ingestion

场景：
- 知识 pipeline 失败（Scout 搜不到设备信息），但已有上传的 schematic PDF
- 服务器重启导致 `_apply_schematic_pin` 的后台 ingestion 任务丢失
- `active_sources.json` 有 pin 但 `schematic_pages/`、`electrical_graph.json` 等不存在

触发方式：
```bash
curl -s -X POST http://127.0.0.1:9000/pipeline/ingest-schematic \
  -H "Content-Type: application/json" \
  -d '{"device_slug":"SLUG","pdf_path":"memory/SLUG/uploads/FILENAME.pdf","device_label":"LABEL"}'
```

验证：
- 返回 `{"started": true, ...}`
- 服务器日志出现 `rendering ... → memory/SLUG/schematic_pages (dpi=200)`
- 等待 `schematic ingestion finished`（49 页约 24 分钟）
- 检查 `memory/SLUG/` 下生成 `schematic_pages/`、`schematic_graph.json`、`electrical_graph.json` 等
