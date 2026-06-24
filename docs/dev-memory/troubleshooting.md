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

## Board 解析演进历程：从单一 BRD 到 13 种格式

### 全景时间线

```
2026-04-22  ──────────────────────────────────────────────────── 2026-06-24
    │                                                              │
    ▼                                                              ▼
  [Phase 1]           [Phase 2]           [Phase 3]          [Phase 4]
  BRD 单一格式    →  BRD2 + KiCad     →  9 种 ASCII 解析器  →  生产级二进制解析
  (Test_Link)        (内容嗅探)           (推测性)              (真实格式)
```

### Phase 1：从零开始 — Test_Link `.brd` 解析器（4月22日）

**起点**：只有一个抽象基类 `BoardParser` + 扩展名分发注册表。

```
api/board/parser/
  ├── __init__.py        # 注册表
  ├── base.py            # BoardParser ABC + register() + parser_for()
  └── (空)               # 没有任何具体实现
```

**心路**：Alexis 的维修工作台需要解析 OpenBoardView 的 `.brd` 格式。
OpenBoardView 项目有公开的 Test_Link 格式规格，所以这是唯一有把握的起点。

**逐步实现**（同一个 BRDParser 类，一个 commit 加一个 block）：

```
9725cf7  feat(brd-parser): parse Parts block with layer/SMD bitfield
         ↓ 理解了 .brd 的二进制头：var_data → Format → Parts
d85ff03  feat(brd-parser): parse Pins block, link to parts, compute bbox
         ↓ Parts 有了，接下来是 Pins（每个引脚的坐标和所属 part）
fd5b271  fix(brd-parser): cross-validate pin ownership
         ↓ 发现有些 pin 引用了不存在的 part → 加交叉验证
48d2b26  feat(brd-parser): parse Nails block and backfill empty pin nets
         ↓ Nails（测试点）是 ICT 探针的物理位置，有些 pin 的 net 为空需要反查
4c9770c  docs(brd-parser): document nail side fallback
6307ae1  feat(brd-parser): derive nets from pins with power/ground heuristic
         ↓ .brd 不显式存 net 列表 → 从 pin 的 net 名推导，用 VDD/VCC/AGND 启发式分类
f956b42  fix(brd-parser): broaden power-net regex
         ↓ VDD_/VCC_/qualified rail names 漏了 → 扩展正则
```

**关键教训**：`.brd` Test_Link 格式是**文本格式**，结构清晰（`str_length:` / `var_data:` 前缀），
但 net 信息不完整——需要从 pins 反推。这是第一个"格式不完美但可推导"的模式。

### Phase 2：BRD2 + KiCad + 内容嗅探（4月22日）

**问题**：`.brd` 扩展名不只对应 Test_Link——KiCad-boardview 工具也输出 `.brd`（BRD2 格式）。

```
bea26b7  refactor(brd-parser): rename module to test_link.py
         ↓ 给 BRD2 腾位子，把 brd.py 改名为 test_link.py
6e2d527  feat(brd2-parser): parse BRD2 format with MNT Reform integration test
         ↓ BRD2 是完全不同的二进制格式，用 MNT Reform 开源板验证
270c50f  feat(parser-dispatch): content-sniff .brd to route between Test_Link and BRD2
         ↓ 同一个 .brd 扩展名，两种格式 → 需要内容嗅探
```

**心路**：同一个 `.brd` 扩展名对应两种完全不同的格式。
解决方案是**内容嗅探**（magic bytes）而非让用户手动选格式。

```
87ff699  feat(kicad-parser): parse .kicad_pcb directly via pcbnew
         ↓ KiCad 的 .kicad_pcb 是真正的 PCB 源文件，调用 pcbnew Python API 解析
```

**嗅探优先级**（至今仍有效）：
```
.brd 文件
  ├── starts with OBV signature → ObfuscatedFileError（拒绝）
  ├── has "str_length:" + "var_data:" → Test_Link
  ├── looks like TopGun float → InvalidBoardFile（不支持）
  └── else → try BRD2
```

### Phase 3：推测性解析器爆发（4月25日）

**触发事件**：Alexis 要求支持维修技师常用的 9 种 boardview 格式。

```
87a055a  feat(board): shared ASCII boardview helper for dialect parsers
         ↓ 发现多种格式共享 Test_Link 的 ASCII 变体 → 提取 _ascii_boardview.py
4939325  feat(board): .bv parser (ATE BoardView 1.5)
5c5c9b4  feat(board): .gr parser (BoardView R5.0)
7110a54  feat(board): .cad parser (Generic BoardViewer 2.1.0.8)
b18fed1  feat(board): .cst parser (IBM Lenovo Castw v3.32)
970f04f  feat(board): .f2b parser (Unisoft ProntoPLACE Place5)
6b108d6  feat(board): .bdv parser (HONHAN BoardViewer)
598ce11  feat(board): .tvw parser (Tebo IctView v3/v4)
7a9d53b  feat(board): .fz parser (ASUS PCB Repair Tool)
79d5946  feat(board): .asc parser (ASUS TSICT)
```

**过度乐观的教训**（commit 689ec6a 是转折点）：

> "Honest reassessment after Alexis pointed out that most production
> boardview formats are binary, not ASCII. My earlier 'DONE' labels
> were over-confident."

实际发现：
```
格式    声称状态    实际状态       问题
.bv     DONE      SPECULATIVE   没有公开规格，假设了 Test_Link ASCII 变体
.gr     DONE      SPECULATIVE   同上
.cst    DONE      SPECULATIVE   同上
.f2b    DONE      SPECULATIVE   同上
.fz     PARTIAL   PARTIAL       结构完整，缺真实信号
.tvw    PARTIAL   PARTIAL       同上
.asc    DONE      DONE          公开文档（OBV issue #45）
.bdv    DONE      DONE          公开文档（piernov 2018 gist）
```

**修复措施**：
1. 加 `looks_like_binary(raw, threshold=0.30)` — 首 2KB 超过 30% 非打印 ASCII → 二进制
2. 推测性解析器遇到二进制输入 → `ObfuscatedFileError` + 精确提示
3. 新增 `test_binary_rejection.py` — 参数化测试 6 个推测性解析器

### Phase 4：真实格式攻坚（4月25日深夜）

**触发事件**：Alexis 从 Telegram 群丢来 6 个真实 boardview 文件。

```
8e009d4  feat(board): real-world FZ-zlib + GenCAD 1.4 parsers — 5 real boards parse
```

真实文件揭示了两个完全不同的格式：

**FZ-zlib**（大多数 `.fz` 文件的真实格式）：
```
字节布局：
[4 bytes LE decompressed-size][zlib stream]
  ↓ 解压后
A!schema 行定义列集
S!values 行携带数据
三段：REFDES（零件）、NET_NAME（引脚+网络+位置）、TESTVIA（测试点）
```

**GenCAD 1.4**（`.cad` 文件的真实格式）：
```
$HEADER         → 文件头
$SHAPES         → 封装形状（引脚局部坐标）
$COMPONENTS     → 元件实例（位置、旋转、镜像）
$SIGNALS        → 网络（节点列表）
$DEVICES        → 器件值
$TESTPINS       → 测试点
```

**关键发现**：真实 `.fz` 文件用 zlib 压缩（不需要密钥），而之前的 XOR 加密路径需要 `WRENCH_BOARD_FZ_KEY` 环境变量。内容嗅探：offset 4 处的 zlib magic（`0x78`）→ 走 zlib 路径，否则走 XOR。

**成果**：6 个真实主板（ASUS Prime, ASRock X470, GRANGER, H610M, LPM-2, Quanta）中 5 个成功解析：
```
18,256 parts / 54,347 pins / 9,520 nets / 1,539 nails
```

### Phase 5：系统整合（5月4日）

```
ba0c5f0  feat(board+web+agent): boardview parsers + WebGL viewer + agent integration
```

一次性落地：
- 13 种格式解析器（含 magic detection、validator、分发注册表）
- Three.js WebGL 查看器（InstancedMesh 渲染器）
- Agent BV 工具面（17 个工具）+ 反幻觉校验器
- FZ-xor 和 XZZ DES 密钥从环境变量加载

### Phase 6：TVW v2 精细映射（5月5日）

```
5951da7  feat(board+web): TVW v2 mapper + edge-finger viewer + viewer polish
```

**问题**：TVW v1 的 pin 映射是"尽力而为"——很多 pin 无法匹配到正确的 component。

**解决**：
- `ComponentPin.pad_index // 8 → layer.pins` + TOP/BOMBOT bbox 位置消歧
- 尾部 PACKAGE 表扫描：130 个封装的丝印轮廓
- Component-record 字符串区域建模为 4-Pascal 布局
- 引脚名正则放宽（MPCIE1, BAT1, USB30 等连接器名）

**成果**：R9 270 fixture 上 100% pin 覆盖（1648 parts / 7098 pins）。

### Phase 7：KiCad 10.0 兼容（6月24日）

```
f1f35a4  fix(kicad): 兼容 KiCad 10.0 pcbnew API
```

**问题**：Cadence Allegro 转换的 `.kicad_pcb` 文件无法解析。

**根因**：KiCad 10.0 的 `pcbnew.GetBoardPolygonOutlines()` 新增了必需参数 `aInferOutlineIfNecessary=True`。

**修复**：macOS 上自动发现 KiCad Python 路径 + stdout 重定向到 stderr + 新参数。

### 关键架构模式

**1. 内容嗅探 > 扩展名**
```
文件进入 → 读前 N 字节 → magic bytes / 文本特征 / 结构标记
  ↓ 匹配
  具体解析器
  ↓ 不匹配
  下一个候选
  ↓ 全不匹配
  UnsupportedFormatError
```

**2. 二进制 vs 文本检测**
```python
def looks_like_binary(raw: bytes, threshold: float = 0.30) -> bool:
    head = raw[:2048]
    non_printable = sum(1 for b in head if b < 0x20 and b not in (0x09, 0x0A, 0x0D))
    return non_printable / len(head) > threshold
```

**3. 解析器置信度等级**
```
DONE        — 有公开规格 + 真实文件验证
PARTIAL     — 结构完整，真实信号待补
SPECULATIVE — 仅 Test_Link ASCII 变体，生产文件可能二进制
```

**4. 反幻觉防线**
```
Agent 输出 → sanitize.py 正则扫描 refdes → 对比 session.board.part_by_refdes
  ↓ 未匹配
  ⟨?U999⟩ 替换 + 服务端日志
```

### 经验教训

| 教训 | 来源 |
|------|------|
| 不要假设文件格式是文本——大多数生产 boardview 是二进制 | 689ec6a reality check |
| 同一扩展名可对应多种格式——内容嗅探是必须的 | 270c50f .brd 分发 |
| 公开规格 ≠ 真实文件——必须用真实文件端到端验证 | 8e009d4 真实格式攻坚 |
| 推测性解析器必须 fail loudly，不能静默降级 | 689ec6a 二进制检测 |
| 封装轮廓、丝印、pad shape 等"装饰"信息对维修技师是核心需求 | 5951da7 TVW v2 |
| 外部 API（pcbnew）会 breaking change——版本检测 + 降级路径 | f1f35a4 KiCad 10.0 |

---

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
