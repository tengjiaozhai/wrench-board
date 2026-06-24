"""诊断代理的跨会话内存。

每个“现场报告”都记录了技术人员确认的发现 - refdes
实际上是哪里出了问题，客户报告的症状，机制，以及
自由格式的笔记。同一设备上的下一个诊断会话可以读取这些
回来学习之前的维修经验。

两个后端，相同的接口：

- **JSON（始终开启）** 将每个报告写入一个 Markdown 文件
  `内存/{slug}/field_reports/{时间戳}-{refdes}.md`。耐用、易于审计、
  grep-able，并且无需任何 Anthropic 端功能即可工作。
- **Managed Agents mirror（标记门控）** 另外推送相同的内容
  当 `settings.ma_memory_store_enabled=True` 时到设备的内存存储，所以
  MA 运行时可以在 `/mnt/memory/` 文件系统挂载上 grep 它。 JSON
  文件仍然先写入 - MA 是辅助加速器，而不是唯一的加速器
  真相的来源。

拆分意味着跨会话学习通过 JSON 路径是持久的，并且
当标志打开时，通过 MA 内存存储透明地加速。
切换标志时零迁移。
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic

from api.agent.memory_stores import ensure_memory_store, upsert_memory
from api.config import get_settings

logger = logging.getLogger("wrench_board.agent.field_reports")


@dataclass
class FieldReport:
    """一项已确认的发现，作为自我描述的 Markdown 文件写入磁盘。

    `report_id` 是文件名主干（时间戳-refdes slug），所以它很简单
    dedup可排序且无需解析 YAML/JSON 前端内容。
    """

    report_id: str
    device_slug: str
    refdes: str
    symptom: str
    confirmed_cause: str
    mechanism: str | None = None
    notes: str | None = None
    session_id: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_markdown(self) -> str:
        lines = [
            "---",
            f"report_id: {self.report_id}",
            f"device_slug: {self.device_slug}",
            f"refdes: {self.refdes}",
            f"symptom: {json.dumps(self.symptom, ensure_ascii=False)}",
            f"confirmed_cause: {json.dumps(self.confirmed_cause, ensure_ascii=False)}",
        ]
        if self.mechanism:
            lines.append(f"mechanism: {json.dumps(self.mechanism, ensure_ascii=False)}")
        if self.session_id:
            lines.append(f"session_id: {self.session_id}")
        lines.append(f"created_at: {self.created_at}")
        lines.append("---")
        lines.append("")
        lines.append(f"# {self.refdes} — {self.confirmed_cause}")
        lines.append("")
        lines.append(f"**Symptom observed:** {self.symptom}")
        lines.append("")
        lines.append(f"**Confirmed cause:** {self.confirmed_cause}")
        if self.mechanism:
            lines.append("")
            lines.append(f"**Failure mechanism:** {self.mechanism}")
        if self.notes:
            lines.append("")
            lines.append("## Notes")
            lines.append("")
            lines.append(self.notes)
        return "\n".join(lines) + "\n"


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)", re.DOTALL)
_YAML_LINE_RE = re.compile(r"^(\w+):\s*(.*)$")


def _parse_report(path: Path) -> FieldReport | None:
    """将 Markdown 报告解析回 FieldReport。对于格式错误的输入，返回 None。

    头条新闻是事实的主要来源；散文机构是咨询性的
    （这里是人类可读的，不是机器消耗的）。
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    match = _FRONTMATTER_RE.match(raw)
    if not match:
        return None
    meta: dict[str, str] = {}
    for line in match.group(1).splitlines():
        m = _YAML_LINE_RE.match(line.strip())
        if not m:
            continue
        key, value = m.group(1), m.group(2).strip()
        if value.startswith('"') and value.endswith('"'):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                pass
        meta[key] = value
    try:
        return FieldReport(
            report_id=meta["report_id"],
            device_slug=meta["device_slug"],
            refdes=meta["refdes"],
            symptom=meta["symptom"],
            confirmed_cause=meta["confirmed_cause"],
            mechanism=meta.get("mechanism") or None,
            session_id=meta.get("session_id") or None,
            created_at=meta.get("created_at")
            or datetime.now(UTC).isoformat(),
        )
    except KeyError:
        return None


def _slug_fragment(text: str, max_len: int = 32) -> str:
    """`text` 的 URL / 文件名安全片段，修剪为 `max_len`。”"""
    frag = re.sub(r"[^a-zA-Z0-9._-]+", "-", text.strip().lower())
    frag = re.sub(r"-+", "-", frag).strip("-")
    return (frag or "unknown")[:max_len]


def _reports_dir(device_slug: str, memory_root: Path) -> Path:
    return memory_root / device_slug / "field_reports"


async def record_field_report(
    *,
    client: AsyncAnthropic | None,
    device_slug: str,
    refdes: str,
    symptom: str,
    confirmed_cause: str,
    mechanism: str | None = None,
    notes: str | None = None,
    session_id: str | None = None,
    memory_root: Path | None = None,
) -> dict[str, Any]:
    """撰写新的现场报告。 JSON-第一； MA mirror 当旗帜亮起时。

    Returns a status dict — tests and telemetry both key on it. Never raises:
    MA mirror 故障不会导致 JSON 写入失败；审计记录有效。
    """
    settings = get_settings()
    memory_root = memory_root or Path(settings.memory_root)

    created_at = datetime.now(UTC)
    # File名称：紧凑形式的 ISO 时间戳 + refdes slug — 可排序和
    # dedup可以。第二个决议就足够了；如果两个报告同时进行
    # 第二个对于相同的refdes，第二个覆盖（可接受 - 两者
    # 如果确实重复，则携带相同的内容，并且幂等写入
    # 也简化了 MA mirror 路径）。
    stamp = created_at.strftime("%Y%m%dT%H%M%SZ")
    report_id = f"{stamp}-{_slug_fragment(refdes)}"

    report = FieldReport(
        report_id=report_id,
        device_slug=device_slug,
        refdes=refdes,
        symptom=symptom,
        confirmed_cause=confirmed_cause,
        mechanism=mechanism,
        notes=notes,
        session_id=session_id,
        created_at=created_at.isoformat(),
    )
    markdown = report.to_markdown()

    reports_dir = _reports_dir(device_slug, memory_root)
    reports_dir.mkdir(parents=True, exist_ok=True)
    file_path = reports_dir / f"{report_id}.md"
    file_path.write_text(markdown, encoding="utf-8")
    logger.info(
        "[FieldReport] Wrote slug=%s refdes=%s report_id=%s",
        device_slug,
        refdes,
        report_id,
    )

    status: dict[str, Any] = {
        "report_id": report_id,
        "json_path": str(file_path),
        "json_status": "written",
        "ma_mirror_status": "skipped:flag_disabled",
    }

    if not settings.ma_memory_store_enabled:
        return status
    if client is None:
        status["ma_mirror_status"] = "skipped:no_client"
        return status

    status["ma_mirror_status"] = await _mirror_to_managed_agents(
        client=client,
        device_slug=device_slug,
        report_id=report_id,
        markdown=markdown,
    )
    return status


async def _mirror_to_managed_agents(
    *,
    client: AsyncAnthropic,
    device_slug: str,
    report_id: str,
    markdown: str,
) -> str:
    """将一份报告镜像到设备的 MA 内存存储。返回状态字符串。”"""
    store_id = await ensure_memory_store(client, device_slug)
    if store_id is None:
        return "skipped:no_store"

    result = await upsert_memory(
        client,
        store_id=store_id,
        path=f"/field_reports/{report_id}.md",
        content=markdown,
    )
    if result is None:
        logger.warning(
            "[FieldReport] MA mirror failed for slug=%s report_id=%s",
            device_slug,
            report_id,
        )
        return "error:upsert_failed"

    return "mirrored"


def list_field_reports(
    *,
    device_slug: str,
    memory_root: Path | None = None,
    limit: int = 20,
    filter_refdes: str | None = None,
) -> list[dict[str, Any]]:
    """返回的报告按最新的在前排序，在提供时按 refdes 进行过滤。

    纯磁盘读取 — JSON 支持的路径，无需 MA 访问即可工作。
    由 `/pipeline/packs/{slug}/findings` HTTP 端点使用并作为
    测试助手。诊断代理通过 grep on 读取相同的内容
    FUSE 安装 (`/mnt/memory/wrench-board-{slug}/field_reports/`)
    而不是通过包装工具。
    """
    settings = get_settings()
    memory_root = memory_root or Path(settings.memory_root)
    reports_dir = _reports_dir(device_slug, memory_root)
    if not reports_dir.exists():
        return []

    reports: list[FieldReport] = []
    for path in reports_dir.glob("*.md"):
        report = _parse_report(path)
        if report is None:
            logger.warning("[FieldReport] Skipping malformed report: %s", path)
            continue
        if filter_refdes and report.refdes != filter_refdes:
            continue
        reports.append(report)

    reports.sort(key=lambda r: r.created_at, reverse=True)
    reports = reports[: max(limit, 0)]
    return [
        {
            "report_id": r.report_id,
            "device_slug": r.device_slug,
            "refdes": r.refdes,
            "symptom": r.symptom,
            "confirmed_cause": r.confirmed_cause,
            "mechanism": r.mechanism,
            "notes": r.notes,
            "session_id": r.session_id,
            "created_at": r.created_at,
        }
        for r in reports
    ]
