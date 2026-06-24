"""由runtime_direct 和runtime_management 共享的助手。

读取 memory/{slug}/simulator_reliability.json 并格式化单行
适合注入系统提示符。当
文件丢失（对于尚未测试包的设备来说是正常的）
或损坏（已记录）。"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger("wrench_board.agent.reliability")


def _memory_root() -> Path:
    """隔离以便测试可以修补它。"""
    return Path("memory")


def load_reliability_line(device_slug: str) -> str | None:
    """返回模拟器可靠性的单行摘要
    设备，或者未知时无。"""
    path = _memory_root() / device_slug / "simulator_reliability.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning(
            "[reliability] failed to load %s: %s — ignoring",
            path,
            exc,
        )
        return None
    try:
        return (
            f"Simulator reliability for {data['device_slug']}: "
            f"score={data['score']:.2f} "
            f"(self_mrr={data['self_mrr']:.2f}, "
            f"cascade_recall={data['cascade_recall']:.2f}, "
            f"n={data['n_scenarios']} scenarios, "
            f"as of {data['source_run_date']}). "
            "Treat top-ranked hypotheses with proportional caution."
        )
    except (KeyError, TypeError, ValueError) as exc:
        logger.warning(
            "[reliability] malformed %s: %s — ignoring",
            path,
            exc,
        )
        return None
