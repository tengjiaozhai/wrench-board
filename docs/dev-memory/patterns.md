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

## 手写 `raw_research_dump.md` 绕过 Scout

场景：
- 设备是工业/冷门（公开维修资料 ≈ 0），Scout 即便能跑 web_search 也会过不了 `assess_dump` 阈值
- LLM 代理（mimo 等）不支持 Anthropic server tool（`web_search_20250305`）+ `thinking=adaptive` + `output_config.effort=xhigh`，Scout 必败

机制（已存在于 `api/pipeline/orchestrator.py:316-320`）：
```python
scout_dump_path = pack_dir / "raw_research_dump.md"
if scout_dump_path.exists():
    raw_dump = scout_dump_path.read_text(encoding="utf-8")
    # ... bypass Phase 1, run Phase 2-4 directly
```

手写 dump 落盘到 `memory/{slug}/raw_research_dump.md` → orchestrator 跳过 Scout → Phase 2 (Registry) + Phase 3 (Writers ×3) + Phase 4 (Auditor) + Phase 2.5 (Mapper) 直接跑。

### Dump 模板（来自 `api/pipeline/prompts.py:12-206` 的 SCOUT_SYSTEM）

必备 5 小节，按顺序：
- `## Device overview` — <200 词，板的物理身份
- `## Known failure modes` — 每条 `- **Symptom:**` bullet，**必须**以 `**Resolution:** <tag>` 结尾，tag ∈ `{hardware_fix_verified, hardware_ruled_out, ambiguous}`。冷门/工业设备无社区数据，全部用 `ambiguous`
- `## Components mentioned by the community` — `- **<refdes>**` 行带 `aliases:` / `Role:` / `Typical failure:`
- `## Signals / power rails / nets mentioned` — `- **<rail>**` 行带 `aliases:` / `Nominal voltage:` / `Measurable at:`
- `## Sources` — `https://...` 或 `local://...` URL 列表

### 阈值（`api/pipeline/scout.py:97-99` 默认 3/3/3）

`assess_dump` 要求 ≥3 symptoms + ≥3 distinct components + ≥3 unique sources。手写时建议 **5 / 8 / 6** 留余量。

### Refdes / rail 纪律（关键）

**每个出现在 dump 里的 refdes 和 rail 名字必须在 `electrical_graph.json` 里实际存在**。

- Components dict 的 key（refdes 形如 `U1400F`/`C1100`/`J5704`）
- `power_rails` dict 的 key（rail 形如 `VUSB_PMU`/`AVDD18_SOC`）

**不要凭直觉发明**。MediaTek USB PHY 有 `AVDD12/18/33_USB` 听起来合理，但这块板的 schematic 没有 — 实际只有 `VUSB_PMU` 和 `VBUS_USB_IN`。发明会被 Phase 2-4 LLM 当事实采纳，污染整个 pack。

### 结构门（执行前必跑）

```python
import re, json
from pathlib import Path
dump = Path('memory/{slug}/raw_research_dump.md').read_text()
eg = json.loads(Path('memory/{slug}/electrical_graph.json').read_text())

# 1. 5 小节齐
for s in ['## Device overview', '## Known failure modes', '## Components mentioned by the community',
          '## Signals / power rails / nets mentioned', '## Sources']:
    assert s in dump, f'missing: {s}'

# 2. Symptom + Resolution 配对
symptoms = re.findall(r'\*\*Symptom:\*\*', dump)
resolutions = re.findall(r'\*\*Resolution:\*\*\s*(\w+)', dump)
assert len(symptoms) >= 3
assert len(resolutions) == len(symptoms)
assert all(r in {'hardware_fix_verified', 'hardware_ruled_out', 'ambiguous'} for r in resolutions)

# 3. Refdes 全部存在于 components
refdes_re = re.compile(r'\b([A-Z]{1,3}\d{1,4}[A-Z]?)\b')
referenced = set(refdes_re.findall(dump))
assert not (referenced - set(eg['components'].keys())), f'fabricated refdes: {referenced - set(eg["components"].keys())}'

# 3b. Rail 全部存在于 power_rails（不要漏！scout.py 的结构门不查这条）
# Two passes because symptom body fields (**Rail / test point:**, **Rework hint:**, **Likely cause:**)
# ALSO carry rail names — scanning only `## Signals` misses them.
FIELD_LABELS = {
    'Likely cause', 'Components mentioned', 'Rail', 'test point',
    'Repair type', 'Rework hint', 'Resolution', 'Symptom', 'Source',
    'References', 'Notes', 'Aliases', 'Role', 'Typical failure',
    'Nominal voltage', 'Measurable at', 'Description',
    'Symptoms', 'Causes', 'Mitigations', 'Steps',
}
sig = re.search(r'## Signals[^\n]*\n(.*?)(?=\n## |\Z)', dump, re.DOTALL)
failure_modes = re.search(r'## Known failure modes\n(.*?)(?=\n## |\Z)', dump, re.DOTALL)
rails = set()
for section in (sig, failure_modes):
    if not section:
        continue
    for m in re.finditer(r'\*\*([^*\n]+?)\*\*', section.group(1)):
        for part in re.split(r'\s*/\s*', m.group(1)):
            part = part.strip()
            # Filter: field labels (contain : or / or whitespace) + known single-word labels
            if not part or ':' in part or '/' in part or ' ' in part or part in FIELD_LABELS:
                continue
            if re.fullmatch(r'[A-Z]{1,3}\d{1,4}[A-Z]?', part):
                continue
            rails.add(part)
# Differential-pair signals (USB_DP/USB_DM, CLK, etc.) are not in power_rails by design.
signal_allowlist = {'USB_DP', 'USB_DM', 'CLK', 'DPLUS', 'DMINUS'}
rail_fab = (rails - set(eg['power_rails'].keys())) - signal_allowlist
assert not rail_fab, f'fabricated rails: {sorted(rail_fab)}'

# 4. 阈值
sources = len({u.rstrip('.,;:') for u in re.findall(r'https?://\S+', dump) + re.findall(r'local://\S+', dump)})
assert sources >= 3
```

### Slug 陷阱

`_slugify(label)`（`api/pipeline/orchestrator.py:154`）会把非 ASCII 全部替换成 `-`，然后去重和 strip。

- `SMT工站V551不良品` → `smt-v551` ✓
- `SMT工站V551不良品 不能DOWNLOAD的分析` → `smt-v551-download` ✗ （同主题两个 slug，dump 会落到错地方）

`/pipeline/generate` 用传入的 `device_label` 现算 slug。落 dump 时要和上次 `/pipeline/repairs` 用的 device_label 保持一致，否则 orchestrator 的 bypass 找不到文件。

### Git 策略

`memory/*` 默认被 `.gitignore` 排除（pipeline 输出都 regenerable）。但**手写 dump 是人类知识输入**，应当追踪。加例外：

```
memory/*
!memory/.gitkeep
!memory/*/
!memory/*/raw_research_dump.md
```

注意 `!memory/*/`（目录例外）必须放在文件例外之前 — 否则 gitignore 把整个目录禁了，里面文件就 unreachable。

### 触发 pipeline

```bash
curl -X POST http://127.0.0.1:9000/pipeline/generate \
  -H "Content-Type: application/json" \
  -d '{"device_label": "SMT工站V551不良品", "focus_symptom": "不能DOWNLOAD"}'
```

期望：HTTP 200，60-180s wall clock，verdict `APPROVED`。`audit_verdict.json` consistency_score ≥ 0.9。

### 何时用此 vs 修 Scout

- **手写 dump**：工业/专有/无社区痕迹的设备（每次 ~30min 人力）
- **修 Scout**：消费电子有 portfolio，且 web search 反复因冷门失败（~1-2 天工程，做 ResearchSource port 重构）
