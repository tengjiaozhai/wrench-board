"""直接模式内存调用 - 支持三个包装器工具的纯读取助手。

在托管模式下，诊断代理 grep 三个 FUSE 安装的内存存储：
每个设备的现场报告、全局故障模式原型和全局
协议剧本。直接模式（`runtime_direct`）没有 FUSE 安装，因此无需
这些代理对召回视而不见（参见`field_reports.list_field_reports`
文档字符串：托管读取“通过 FUSE 安装上的 grep ......而不是通过
包装器工具”）。这些函数是包装器，公开为 `mb_recall_*` /
`mb_search_*` 工具，使直接代理达到同等水平。

这三个都是只读且无副作用的。写入（记录结果，
保存协议）已经存在并且由两个运行时共享。

匹配是故意简单的子字符串/关键字 grep — 与
托管代理 grep 已安装的文件，而不是语义搜索。"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from api.agent.field_reports import list_field_reports

logger = logging.getLogger("wrench_board.agent.recall")

# 引擎附带的版本化种子数据（手动管理）。相同来源
# 托管的全球商店是从（参见api/agent/seed_data/README.md）开始的。
_SEED_DIR = Path(__file__).resolve().parent / "seed_data"

# 默认上限，因此较长的设备历史记录不会破坏代理的上下文。
_DEFAULT_FIELD_REPORT_LIMIT = 8


def recall_field_reports(
    *,
    device_slug: str,
    memory_root: Path | None = None,
    query: str | None = None,
    refdes: str | None = None,
    limit: int = _DEFAULT_FIELD_REPORT_LIMIT,
) -> list[dict[str, Any]]:
    """回想一下该设备已确认的现场报告，最新的优先。

    `list_field_reports`（磁盘支持的读取器）的薄包装，添加了
    自由文本 `query` 过滤器（在每个字段中匹配）并限制结果。
    `⟦PRESERVE0⟧` 被下推到底层读取器。这是直接模式
    相当于托管代理 grep 设备 field_reports 存储。"""
    # 首先拉出一个宽大的窗口（refdes按下），然后进行关键字过滤和
    # 此处上限 - 因此 `query` 缩小了最新的第一组而不是读者的范围
    # 在过滤之前自己截断 `limit` 。
    reports = list_field_reports(
        device_slug=device_slug,
        memory_root=memory_root,
        limit=200,
        filter_refdes=refdes,
    )

    q = (query or "").lower().strip()
    if q:
        reports = [
            r for r in reports
            if q in " ".join(str(v) for v in r.values() if v is not None).lower()
        ]

    return reports[: max(limit, 0)]


def search_patterns(query: str, *, seed_dir: Path | None = None) -> list[dict[str, Any]]:
    """按关键字搜索全局故障模式原型（markdown）。

    对于文件名或正文的每个原型返回 `[{name, content}]`
    包含 `query` （不区分大小写的子字符串）——代理的“我如何推理
    关于这种错误”回忆。原型很少而且很短，所以完整的
    每次命中都会返回主体。"""
    base = (seed_dir or _SEED_DIR) / "global_patterns"
    if not base.exists():
        return []
    q = (query or "").lower().strip()
    if not q:
        return []

    hits: list[dict[str, Any]] = []
    for path in sorted(base.glob("*.md")):
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            logger.warning("[Recall] unreadable pattern file: %s", path)
            continue
        if q in path.stem.lower() or q in content.lower():
            hits.append({"name": path.stem, "content": content})
    return hits


def search_playbooks(symptom: str, *, seed_dir: Path | None = None) -> list[dict[str, Any]]:
    """按症状搜索全局协议手册 (JSON)。

    返回每个剧本的完整剧本字典（包括`steps`）
    `applies_when` 重叠 `symptom` （无论哪种方式都不区分大小写的子字符串） —
    因此代理可以在调用之前提升经过验证的步骤序列
    `⟦PRESERVE0⟧`而不是重新发明它。"""
    base = (seed_dir or _SEED_DIR) / "global_playbooks"
    if not base.exists():
        return []
    s = (symptom or "").lower().strip()
    if not s:
        return []

    hits: list[dict[str, Any]] = []
    for path in sorted(base.glob("*.json")):
        try:
            pb = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.warning("[Recall] unreadable/invalid playbook: %s", path)
            continue
        applies = [str(a).lower() for a in pb.get("applies_when", [])]
        if any(s in a or a in s for a in applies):
            hits.append(pb)
    return hits
