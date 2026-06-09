## 2026-06-05 mimo-v2.5 不能直接替代 Claude 4.7：pipeline 卡 26/49 页、每页全 5 次重试失败

现象：
- wrbench-board 从 Claude 4.7 切换到 mimo-v2.5（token-plan 代理，mimo-v2.5 是唯一可用模型）后，schematic 子 pipeline 只能生成 26/49 个 page JSON，随后进度卡住
- 日志显示同一组页面（4, 6, 9, 14, 16）反复进入 5 次重试循环，每次都是 `Expected a tool_use block named 'submit_schematic_page', got blocks: ['thinking']`（或 `['text']`）
- 进度卡死在 26 个文件不动（无论跑多久）

调查过程：
- 定位到 `orchestrator.py:172` 的 `asyncio.gather` 没有 `return_exceptions=True`，任何一页抛出 RuntimeError 就会取消全部未完成的协程
- 单独用 CLI 测 mimo 的 tool_use 行为，发现 `max_tokens=2048` 时直接返回 tool_use（635 tokens），但 `max_tokens=8192` 时 mimo 把所有预算烧在 thinking 块上输出 end_turn
- 进一步发现 `max_tokens=32768 + streaming` 能在 2787 tokens 内完成 thinking + tool_use，但 16384 + streaming 仍然 end_turn
- 测试 `thinking={"type": "disabled"}` 让 mimo 跳过思考，直接 20-token tool_use（对简单 schema）和 6054-token tool_use（对真实 SchematicPageGraph schema）
- 最终发现 grounding 上下文（每页约 8k tokens 的 refdes/nets 真值集）导致 input 从 ~8.5k 膨胀到 ~17k，mimo 即使 thinking=disabled 也把 8192 output 烧在文本解释上

根本原因（3 层根因，由表及里）：
1. **gather 缺少 return_exceptions=True** — 单页失败炸掉整个 batch，未调度的页面永远不跑
2. **mimo 的 thinking 模式烧光 8192 token 输出** — 没有 thinking=disabled 时，mimo 用全部输出预算进行思考，不调用工具
3. **grounding 上下文使 prompt 过长** — ~17k input + 8192 output 预算 = mimo 无法同时解释真值集并调用工具，退化为文本模式输出

修复方案（共修改 4 个文件、4 个独立修改）：

| 文件 | 修改 | 修复的根因 |
|---|---|---|
| `api/pipeline/schematic/orchestrator.py:175` | `return_exceptions=True` + 对异常页面写 confidence=0 stub | 根因 #1 |
| `api/pipeline/tool_call.py:124` | 对非 Claude 模型设置 `thinking={"type":"disabled"}`（而非 pop） | 根因 #2 |
| `api/pipeline/schematic/page_vision.py:216` | 对非 Claude 模型追加 CRITICAL 后缀 + 禁用 cache_control | 根因 #2（强化） |
| `api/pipeline/schematic/orchestrator.py:112` | `use_grounding and is_claude_model` — 非 Claude 模型跳过 grounding | 根因 #3 |

经验教训：
- mimo-v2.5 不是 Claude 的替身——其 thinking 模式、输出 token 分配策略和上下文窗口行为都不同。每次切换模型都需要对 `tool_choice`、`thinking`、`max_tokens`、grounding 和 system prompt 进行单独测试
- `asyncio.gather` 用于批量 LLM 调用时必须设置 `return_exceptions=True`，否则一个异常的页面会导致整个 pipeline 崩溃（且原因不明显——看不到剩余页面的错误）
- mimo 的 proxy 级缓存（cache_read 值异常高，达到 12672~17728）可能与 Claude 的 cache_control 机制冲突：禁用了 `cache_control` 后缓存命中几乎消失
- mimo 输出质量下降是已知且可接受的（confidence 从 Opus 的 0.9+ 降至 0.65），但结构化输出的完整性即使降低质量也难以保证——某些页面（31, 33, 34）输出 0 个节点，可能是非电路页面
- 每次 API 调用约 47-83 秒（含图片），49 页并发 Semaphore(5) 需要约 16 分钟完成全量处理
