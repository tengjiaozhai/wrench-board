"""诊断代理的交叉对话叙述日志。

field_report (`api/agent/field_reports.py`) 是组件级别：“我确认
U1501 在此设备上出现故障。” *会话日志* 是对话粒度：
“在22/04修复R1的聊天中，我们测试了PP3V0 + PP1V8，排除了U1501，
把它留在可疑的 U1700 上——因为技术人员正在等待零件而暂停。”

现场报告回答“这里有人指责过这个refdes吗？”。会议
日志回答“我们是否已经测试了这条铁路/探索了这个假设”
这个设备过去有维修过吗？ — 正是面向用户的场景“但是
我在其他诊断中告诉过你我们已经这样做了，你忘了！”。

存储镜像`field_reports.py`：JSON-首先到磁盘下
`内存/{⟦PRESERVE3⟧}/conversation_log/{stamp}_{⟦PRESERVE0⟧}_{conv_id}.md`，加上
标记门控镜像到设备的 MA 存储（位于 `/conversation_log/{...}.md`）
因此代理可以 `glob` / `grep` 将其安装在过去所有的 FUSE 上
在同一台设备上进行维修。"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from anthropic import AsyncAnthropic

from api.agent.memory_stores import (
    ensure_memory_store,
    ensure_repair_store,
    upsert_memory,
)
from api.config import get_settings

logger = logging.getLogger("wrench_board.agent.conversation_log")

OUTCOME_VALUES: tuple[str, ...] = ("resolved", "unresolved", "paused", "escalated")
Outcome = Literal["resolved", "unresolved", "paused", "escalated"]


@dataclass
class TestedTarget:
    """技术人员在会话期间执行的一项探测/检查步骤。"""

    target: str          # '导轨：PP3V0'，'补偿：U1501'，'引脚：U7:12'
    result: str          # “正常”、“死机”、“短路”、“开路”、“热”、“吵闹”……


@dataclass
class HypothesisTrace:
    """agent 曾考虑的嫌疑 refdes 及其裁决。"""

    refdes: str
    verdict: Literal["confirmed", "rejected", "inconclusive"]
    evidence: str = ""   # 短短一句话


@dataclass
class SessionLog:
    """一次聊天对话的叙述性摘要，范围为 (repair, conv)。"""

    log_id: str
    device_slug: str
    repair_id: str
    conv_id: str
    symptom: str
    outcome: Outcome
    tested: list[TestedTarget] = field(default_factory=list)
    hypotheses: list[HypothesisTrace] = field(default_factory=list)
    findings: list[str] = field(default_factory=list)   # 字段报告 ID
    next_steps: str | None = None
    lesson: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_markdown(self) -> str:
        lines = [
            "---",
            f"log_id: {self.log_id}",
            f"device_slug: {self.device_slug}",
            f"repair_id: {self.repair_id}",
            f"conv_id: {self.conv_id}",
            f"outcome: {self.outcome}",
            f"symptom: {json.dumps(self.symptom, ensure_ascii=False)}",
            f"created_at: {self.created_at}",
            "---",
            "",
            f"# {self.outcome.upper()} — {self.symptom}",
            "",
            f"**Repair:** `{self.repair_id}` · **Conversation:** `{self.conv_id}`",
            "",
        ]
        if self.tested:
            lines.append("## Symptoms tested")
            lines.append("")
            for t in self.tested:
                lines.append(f"- `{t.target}` → {t.result}")
            lines.append("")
        if self.hypotheses:
            lines.append("## Hypotheses explored")
            lines.append("")
            for h in self.hypotheses:
                evid = f" — {h.evidence}" if h.evidence else ""
                lines.append(f"- `{h.refdes}` · **{h.verdict}**{evid}")
            lines.append("")
        if self.findings:
            lines.append("## Archived findings (field_reports)")
            lines.append("")
            for fid in self.findings:
                lines.append(f"- `{fid}`")
            lines.append("")
        if self.next_steps:
            lines.append("## Next steps")
            lines.append("")
            lines.append(self.next_steps)
            lines.append("")
        if self.lesson:
            lines.append("## Lesson")
            lines.append("")
            lines.append(self.lesson)
            lines.append("")
        return "\n".join(lines).rstrip() + "\n"


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)", re.DOTALL)
_YAML_LINE_RE = re.compile(r"^(\w+):\s*(.*)$")


def _parse_log(path: Path) -> SessionLog | None:
    """尽力解析已保存的日志文件。对于格式错误的输入，返回 None。

    Frontmatter 是事实的来源——正文是人类可读的 Markdown
    我们不尝试在这里重新解析（结构化形式是原始工具
    有效负载，我们不需要往返）。"""
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
        outcome = meta["outcome"]
        if outcome not in OUTCOME_VALUES:
            return None
        return SessionLog(
            log_id=meta["log_id"],
            device_slug=meta["device_slug"],
            repair_id=meta["repair_id"],
            conv_id=meta["conv_id"],
            symptom=meta["symptom"],
            outcome=outcome,  # 类型：忽略[arg-type]
            created_at=meta.get("created_at") or datetime.now(UTC).isoformat(),
        )
    except KeyError:
        return None


def _logs_dir(device_slug: str, memory_root: Path, owner_ref: str | None = None) -> Path:
    """会话日志在磁盘上的位置。会话日志是代理的私有日志
    交叉修复工作记忆，因此当所有者（租户）被设置时，他们生活在
    每个所有者的子目录 - 租户只会全局/列出其自己过去的会话。
    无主（独立/self-host）保持平坦的路径，像以前一样单租户。"""
    base = memory_root / device_slug / "conversation_log"
    return base / "_owners" / _slug(owner_ref, 64) if owner_ref else base


def _slug(text: str, max_len: int = 40) -> str:
    frag = re.sub(r"[^a-zA-Z0-9._-]+", "-", text.strip()).strip("-")
    return (frag or "unknown")[:max_len]


async def record_session_log(
    *,
    client: AsyncAnthropic | None,
    device_slug: str,
    repair_id: str,
    conv_id: str,
    symptom: str,
    outcome: str,
    tested: list[dict[str, str]] | None = None,
    hypotheses: list[dict[str, str]] | None = None,
    findings: list[str] | None = None,
    next_steps: str | None = None,
    lesson: str | None = None,
    memory_root: Path | None = None,
    owner_ref: str | None = None,
) -> dict[str, Any]:
    """追加（每个 conv_id 幂等覆盖）一个会话日志。

    JSON-第一；当标志打开时 MA 镜像。返回状态字典。
    从不引发 — MA 镜像故障使 JSON 记录完好无损。

    `⟦PRESERVE0⟧`（租户，来自云的 X-Owner-Ref）将此范围限定为 PRIVATE
    工作内存：磁盘日志位于每个所有者的子目录和 MA 下
    镜像的目标是每次修复（租户专用）存储而不是
    设备共享的——因此一个租户的会话叙述永远无法被其他人读取
    其他。无所有者=独立/self-host（扁平路径+设备存储，不变）。"""
    if outcome not in OUTCOME_VALUES:
        return {
            "ok": False,
            "error": f"outcome must be one of {OUTCOME_VALUES}, got {outcome!r}",
        }

    settings = get_settings()
    memory_root = memory_root or Path(settings.memory_root)

    created_at = datetime.now(UTC)
    stamp = created_at.strftime("%Y%m%dT%H%M%SZ")
    # log_id = 印章 + 修复 + 转化次数。文件名相同，因此重新调用

    # 相同的（修复，转换）干净地覆盖（基于路径的重复数据删除，无全局）。

    log_id = f"{stamp}_{_slug(repair_id, 24)}_{_slug(conv_id, 24)}"

    log = SessionLog(
        log_id=log_id,
        device_slug=device_slug,
        repair_id=repair_id,
        conv_id=conv_id,
        symptom=symptom,
        outcome=outcome,  # 类型：忽略[arg-type]
        tested=[TestedTarget(**t) for t in (tested or [])],
        hypotheses=[HypothesisTrace(**h) for h in (hypotheses or [])],
        findings=list(findings or []),
        next_steps=next_steps,
        lesson=lesson,
        created_at=created_at.isoformat(),
    )
    markdown = log.to_markdown()

    logs_dir = _logs_dir(device_slug, memory_root, owner_ref)
    logs_dir.mkdir(parents=True, exist_ok=True)
    # 每个转换文件名（不是每个调用）——相同的 conv_id 重写到位。

    conv_filename = f"{_slug(repair_id, 24)}_{_slug(conv_id, 24)}.md"
    file_path = logs_dir / conv_filename
    file_path.write_text(markdown, encoding="utf-8")
    logger.info(
        "[SessionLog] Wrote slug=%s repair=%s conv=%s outcome=%s",
        device_slug, repair_id, conv_id, outcome,
    )

    status: dict[str, Any] = {
        "ok": True,
        "log_id": log_id,
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
        repair_id=repair_id,
        conv_filename=conv_filename,
        markdown=markdown,
        owner_ref=owner_ref,
    )
    return status


async def _mirror_to_managed_agents(
    *,
    client: AsyncAnthropic,
    device_slug: str,
    repair_id: str,
    conv_filename: str,
    markdown: str,
    owner_ref: str | None = None,
) -> str:
    # 租户 (owner_ref) → 每次维修存储，这是租户私有的（

    # 设备存储在租户之间共享，因此镜像私人会话

    # 那里的叙述会让另一个租户的代理人 grep 它）。无主

    # (self-host) 保留设备存储 = 技术自己的交叉修复内存。

    store_id = await (
        ensure_repair_store(client, device_slug=device_slug, repair_id=repair_id)
        if owner_ref
        else ensure_memory_store(client, device_slug)
    )
    if store_id is None:
        return "skipped:no_store"

    result = await upsert_memory(
        client,
        store_id=store_id,
        path=f"/conversation_log/{conv_filename}",
        content=markdown,
    )
    if result is None:
        logger.warning(
            "[SessionLog] MA mirror failed for slug=%s file=%s",
            device_slug, conv_filename,
        )
        return "error:upsert_failed"
    return "mirrored"


def list_session_logs(
    *,
    device_slug: str,
    memory_root: Path | None = None,
    limit: int = 50,
    owner_ref: str | None = None,
) -> list[dict[str, Any]]:
    """返回日志按最新顺序排序。纯磁盘读取，范围仅限于所有者
    （租户仅列出自己过去的会话；无所有者=平坦路径）。"""
    settings = get_settings()
    memory_root = memory_root or Path(settings.memory_root)
    logs_dir = _logs_dir(device_slug, memory_root, owner_ref)
    if not logs_dir.exists():
        return []

    logs: list[SessionLog] = []
    for path in logs_dir.glob("*.md"):
        log = _parse_log(path)
        if log is None:
            logger.warning("[SessionLog] Skipping malformed log: %s", path)
            continue
        logs.append(log)

    logs.sort(key=lambda lg: lg.created_at, reverse=True)
    logs = logs[: max(limit, 0)]
    return [
        {
            "log_id": lg.log_id,
            "device_slug": lg.device_slug,
            "repair_id": lg.repair_id,
            "conv_id": lg.conv_id,
            "symptom": lg.symptom,
            "outcome": lg.outcome,
            "created_at": lg.created_at,
        }
        for lg in logs
    ]
