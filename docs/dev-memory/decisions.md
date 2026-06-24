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

## 上游同步回灌：硬拷贝 + 适配层

决策：
- 从 Junkz3/wrench-board 同步代码时，直接拷贝文件（git checkout）而非手动移植
- 多租户代码（owner_ref/cloud_metering）完整保留，Cloud 字段默认空 = 本机无操作

原因：
- 硬拷贝保证与上游逐字节一致，减少误移植风险
- 适配层集中在一处（`owner_ref.py` 的 default=None），不影响核心业务逻辑

影响：
- `runtime_direct.py`、`manifest.py`、`tools.py` 等大量文件直接替换
- 本地特有功能（`phase_narrator.py`）保留不动

## KiCad Python 发现不依赖系统 python3

决策：
- KiCad .kicad_pcb 解析器通过 `_find_kicad_python()` 在已知路径查找 KiCad.app 内置 Python
- 不依赖 `shutil.which("python3")`（conda Python 无 pcbnew）

原因：
- macOS 上 `python3` 解析到 conda 环境，没有 pcbnew
- KiCad.app 内置 Python 3.9 有完整 pcbnew 模块
- 显式路径搜索比修改 PATH 更可控

影响：
- `api/board/parser/kicad.py` 新增 `_find_kicad_python()`
- `api/main.py` 预热逻辑改用该方法

## KiCad 提取脚本：wx 输出必须重定向

决策：
- `_kicad_extract.py` 在 wxApp 初始化时，将 stdout 暂时重定向到 stderr
- wx 调试信息（"Adding duplicate image handler" 等）不污染 JSON 输出

原因：
- wxPython 初始化时会向 stdout 写入多条调试信息
- 这些信息被 subprocess 捕获后混入 JSON，导致 JSON 解析失败

影响：
- `_kicad_extract.py` 在 `import wx` 前做 `sys.stdout = sys.stderr`，初始化后恢复
