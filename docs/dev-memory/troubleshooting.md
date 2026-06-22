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

## 2026-06-18 启动环境问题三连：WebSocket 403、pdftoppm 找不到、schematic ingestion 不触发

现象：
- 前端 WebSocket 连接 `ws://127.0.0.1:9000/pipeline/progress/smt-v551` 返回 403 Forbidden
- Schematic ingestion 报 `PdftoppmNotAvailableError: pdftoppm not found`
- 上传了 schematic PDF 但 `memory/{slug}/` 里没有任何 pipeline JSON 输出

根因 #1 — WebSocket 403：
- `start.sh` 从 shell 环境变量读取 `PORT`（默认 8000），不读 `.env`
- `.env` 设置 `PORT=9000` 但 `start.sh` 用的是 Makefile 的 `PORT ?= 8000`
- `cors_allow_origins` 默认只含 `:8000` 和 `:5173`，浏览器从 `:9000` 发起的 WS 握手 Origin 不在白名单
- 修复：`.env` 添加 `CORS_ALLOW_ORIGINS=...http://localhost:9000,http://127.0.0.1:9000,...`

根因 #2 — pdftoppm 找不到：
- macOS 上 `pdftoppm` 在 `/opt/homebrew/bin/`，非交互式 shell 的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`
- uvicorn 进程继承这个精简 PATH，`subprocess.run(["pdftoppm", ...])` 找不到可执行文件
- 修复：启动时 `PATH="/opt/homebrew/bin:$PATH" DIAGNOSTIC_MODE=direct PORT=9000 make run`

根因 #3 — schematic ingestion 不触发：
- 知识 pipeline（Scout → Registry → Writers → Auditor）在 Scout 阶段失败（`ThinScoutDumpError`），pipeline 终止
- schematic PDF 是单独上传的，`_apply_schematic_pin` 用 `asyncio.create_task()` 调度后台 ingestion
- 如果服务器在 ingestion 完成前重启，后台任务丢失，`active_sources.json` 有 pin 但无衍生文件
- 修复：手动调用 `POST /pipeline/ingest-schematic` 重新触发

根因 #4 — start.sh 不读 .env：
- `DIAGNOSTIC_MODE=direct` 写在 `.env` 里不够，`start.sh` 用 `${DIAGNOSTIC_MODE:-managed}` 从 shell 读取
- 不传 shell 变量 → 默认 `managed` → 调用 MA beta API → 小米 relay 返回 404

经验：
- **启动命令必须显式传递所有环境变量**：`PATH="/opt/homebrew/bin:$PATH" DIAGNOSTIC_MODE=direct PORT=9000 make run`
- `.env` 只被 Python 的 `load_dotenv()` 读取，bash 脚本（`start.sh`）不读它
- 非默认端口必须同步更新 `CORS_ALLOW_ORIGINS`，否则所有 WebSocket 连接都会 403
- 上传 schematic PDF 后，如果知识 pipeline 失败，需要手动触发 `POST /pipeline/ingest-schematic` 才能生成 JSON

## 2026-06-18 mimo-v2.5 schematic vision 成功率约 88%（43/49 页）

现象：
- 49 页 SMT 工站原理图，43 页成功提取 JSON，6 页（3, 5, 6, 8, 9, 19）5 次重试后仍输出纯文本
- 成功页面：首次 attempt 即返回 tool_use（out=150~7284 tokens）
- 失败页面：每次 attempt 都 `out=8192`（烧满输出预算），全部 text-only
- 最终 6 页写 confidence=0 stub，pipeline 继续完成

已应用的缓解措施（均已在代码中）：
- `thinking={"type":"disabled"}`
- CRITICAL system prompt 后缀
- 禁用 cache_control
- 跳过 grounding
- `return_exceptions=True` + 5 次重试 + stub 降级

仍然失败的原因：
- mimo-v2.5 对复杂原理图页面（可能是高密度布线或多 sheet 页面）无法在 8192 output tokens 内同时解释电路并调用工具
- 这些页面的 input 也只有 ~8.5k（无 grounding），说明问题不在 input 长度，而是 mimo 的 tool_use 能力对特定页面类型有盲区

最终结果：
- 合并：871 组件、669 网络、67 电源轨、436 条边
- 编译：3 boot phases、global_confidence=0.59、degraded=True
- `parts_index.json`：871 条可搜索记录
- 总耗时 1467 秒（约 24.5 分钟）
