"""会话期间每个 Hypothesize() 调用的每次修复仅附加日志。

JSONL 存储在内存/{slug}/repairs/{repair_id}/diagnosis_log.jsonl，同上
best-effort 语义作为测量内存：记录 IO 错误
并吞下，因此诊断会话永远不会因写入未命中而失败。

被现场校准的语料库构建器用来重建
求解器的排名在修复过程中不断变化。
"""

from __future__ import annotations

import logging
from pathlib import Path

from pydantic import BaseModel, ConfigDict

logger = logging.getLogger("wrench_board.agent.diagnosis_log")


class DiagnosisLogEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timestamp: str
    observations: dict           # 原始 Observations.model_dump()
    hypotheses_top5: list[dict]  # [{kill_refdes，kill_modes，得分，叙述}]
    pruning_stats: dict          # {single_candidates_tested, two_fault_pairs_tested, wall_ms}


def _log_path(memory_root: Path, device_slug: str, repair_id: str) -> Path:
    return memory_root / device_slug / "repairs" / repair_id / "diagnosis_log.jsonl"


def append_diagnosis(
    *,
    memory_root: Path,
    device_slug: str,
    repair_id: str,
    observations: dict,
    hypotheses_top5: list[dict],
    pruning_stats: dict,
) -> DiagnosisLogEntry | None:
    """将一个 DiagnosisLogEntry 追加到修复日志中，返回该条目。

    如果写入失败则返回 None （best-effort — 永远不会引发）。"""
    from datetime import UTC, datetime

    try:
        entry = DiagnosisLogEntry(
            timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            observations=observations,
            hypotheses_top5=hypotheses_top5,
            pruning_stats=pruning_stats,
        )
    except ValueError as exc:
        logger.warning("append_diagnosis: invalid payload: %s", exc)
        return None

    path = _log_path(memory_root, device_slug, repair_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(entry.model_dump_json() + "\n")
    except OSError as exc:
        logger.warning("append_diagnosis: IO error for %s/%s: %s", device_slug, repair_id, exc)
        return None

    return entry


def load_diagnosis_log(
    *,
    memory_root: Path,
    device_slug: str,
    repair_id: str,
) -> list[DiagnosisLogEntry]:
    """返回诊断日志条目的有序列表以进行修复。”"""
    path = _log_path(memory_root, device_slug, repair_id)
    if not path.exists():
        return []
    entries: list[DiagnosisLogEntry] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(DiagnosisLogEntry.model_validate_json(line))
            except ValueError:
                logger.warning("load_diagnosis_log: skipping malformed line in %s", path)
                continue
    except OSError as exc:
        logger.warning("load_diagnosis_log: IO error for %s/%s: %s", device_slug, repair_id, exc)
    return entries
