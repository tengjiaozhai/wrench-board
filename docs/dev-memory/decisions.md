## mimo-v2.5 适配方式：通过模型名检测（is_claude）而非全局 flag

决策：
- 所有 mimo 兼容性逻辑通过 `is_claude = str(model).startswith("claude-")` 内联检测，不引入额外的环境变量或配置开关

原因：
- 避免引入配置漂移（两个开关控制同一行为会增加出错面）
- 未来若更换回 Claude，所有兼容性路径自动关闭，无需另一次手动配置修改
- 保持代码变更最小化：仅修改实际需要调整的路径

影响：
- `tool_call.py`、`page_vision.py`、`orchestrator.py` 中的四个修改都使用 `is_claude` 作为条件
- 如果未来出现第二个非 Claude 模型（如 mistral 等），只需修改模型名前缀检测

约束：
- 不在 `.env` 中为 mimo 添加专用开关
- 不引入两层 fallback（如 "if not claude then try disabling thinking then try enabling thinking"）

## 批量 LLM 调用必须容错

决策：
- Pipeline 中所有 `asyncio.gather` 调用并发 LLM 调用时必须设置 `return_exceptions=True`

原因：
- 第三方 API 的不稳定性可能随时发生（rate limit、connection error、工具调用失败）
- 一个页面失败不应导致其他 48 个页面的工作白做
- 返回异常后可以写 stub（`confidence=0`）继续合并流程

影响：
- `orchestrator.py` 的 vision 阶段已修改
- 未来新增的批量 LLM 调用（如 classification、boot analysis）也应遵循此规则

约束：
- 不要对非 LLM 调用的 `gather`（如文件 I/O）自动添加此标记
