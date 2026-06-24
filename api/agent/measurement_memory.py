"""每次修复仅附加技术测量日志。

与 `api/agent/chat_history.py` 相同的 JSONL 模式 — 一个 `{ts, event}`
每行记录在`memory/{⟦PRESERVE3⟧}/repairs/{⟦PRESERVE0⟧}/measurements.jsonl`。

公共表面：
- 测量事件（Pydantic形状）
- append_measurement / load_measurements / compare_measurements
- Synthesise_observations（从最新的每个目标导出观察结果
  在日记中注明）
- auto_classify（纯函数 — 将值 + 标称 + 单位映射到
  ComponentMode / RailMode，如果无法决定则为 None）
- parse_target（“kind:name”字符串的解析器）"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

logger = logging.getLogger("wrench_board.agent.measurement_memory")


Source = Literal["ui", "agent"]
Unit = Literal["V", "A", "W", "°C", "Ω", "mV"]


class MeasurementEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timestamp: str
    target: str
    value: float | None = None   # None = 来自 mb_set_observation 的占位符事件
    unit: Unit
    nominal: float | None = None
    note: str | None = None
    source: Source
    auto_classified_mode: str | None = None


# ---------------------------------------------------------------------------
# 目标语法
# ---------------------------------------------------------------------------

TargetKind = Literal["rail", "comp", "pin"]
_KNOWN_KINDS: frozenset[str] = frozenset({"rail", "comp", "pin"})


def parse_target(target: str) -> tuple[str, str]:
    """将目标字符串拆分为（种类，名称）。

    示例：
      “轨道：+3V3”→（“轨道”，“+3V3”）
      “comp：U7”→（“comp”，“U7”）
      “引脚：U7：3”→（“引脚”，“U7：3”）

    对于未知类型或格式错误的输入引发 ValueError。"""
    if ":" not in target:
        raise ValueError(f"expected '<kind>:<name>', got {target!r}")
    kind, _, name = target.partition(":")
    if kind not in _KNOWN_KINDS:
        raise ValueError(f"unknown target kind {kind!r}; expected one of {sorted(_KNOWN_KINDS)}")
    if not name:
        raise ValueError(f"empty name in target {target!r}")
    return kind, name


# ---------------------------------------------------------------------------
# 自动分类规则
# ---------------------------------------------------------------------------

# 中央，可调。除非另有说明，数值均为标称值的比率。
CLASSIFY_RAIL_ALIVE_LOW = 0.90         # ≥ 标称值的 90%
CLASSIFY_RAIL_ALIVE_HIGH = 1.10        # ≤ 标称值的 110%
CLASSIFY_RAIL_DEAD_THRESHOLD_V = 0.05  # 绝对伏特，<此→死
CLASSIFY_RAIL_ANOMALOUS_LOW = 0.50     # 标称值的 50-90% → 异常
CLASSIFY_IC_HOT_CELSIUS = 65.0         # IC 温度阈值


def auto_classify(
    *, target: str, value: float, unit: str,
    nominal: float | None = None, note: str | None = None,
) -> str | None:
    """将（目标、值、单位、标称？）映射到模式字符串。

    当我们无法决定时返回 None（缺少标称、不支持
    种类等）——调用者将测量结果保存在存储中，但是
    未设置模式。"""
    try:
        kind, name = parse_target(target)
    except ValueError:
        return None

    if kind == "rail" and unit in ("V", "mV"):
        if nominal is None:
            return None
        # 将读数标准化为 V。`nominal` 是导轨的 SI 目标
        # （存储在整个代码库中的 V 中 — 请参阅测试 + schema_g​​raph
        # 推理），所以即使读数也绝不会除以 1000
        # 以 mV 为单位提交。
        v = value / 1000.0 if unit == "mV" else value
        nom = nominal
        # 明确的简短说明占主导地位。
        if note and "short" in note.lower() and abs(v) < CLASSIFY_RAIL_DEAD_THRESHOLD_V:
            return "shorted"
        if v < CLASSIFY_RAIL_DEAD_THRESHOLD_V:
            return "dead"
        ratio = v / nom if nom != 0 else 0.0
        if ratio > CLASSIFY_RAIL_ALIVE_HIGH:
            return "shorted"   # 第 1 相过电压折叠成短路
        if ratio >= CLASSIFY_RAIL_ALIVE_LOW:
            # 阶段 4.5：如果电压为标称电压，但技术说明暗示了电压轨
            # 应关闭（待机/休眠/睡眠），提升为卡住_开启。
            if note:
                note_lower = note.lower()
                STANDBY_TOKENS = ("veille", "standby", "off", "power_off", "sleep",
                                   "éteint", "eteint", "capot fermé", "lid closed")
                if any(tok in note_lower for tok in STANDBY_TOKENS):
                    return "stuck_on"
            return "alive"
        if ratio >= CLASSIFY_RAIL_ANOMALOUS_LOW:
            return "anomalous"
        return "anomalous"   # 任何低于 50% 的非零下垂仍然是异常的

    if kind == "comp" and unit == "°C":
        return "hot" if value >= CLASSIFY_IC_HOT_CELSIUS else "alive"

    # 不支持的组合 - 我们存储测量值但保留
    # 模式为空，供技术人员手动决定。
    return None


# ---------------------------------------------------------------------------
# 日记助手
# ---------------------------------------------------------------------------


def _journal_path(memory_root: Path, device_slug: str, repair_id: str) -> Path:
    return (
        memory_root / device_slug / "repairs" / repair_id / "measurements.jsonl"
    )


def append_measurement(
    *,
    memory_root: Path,
    device_slug: str,
    repair_id: str,
    target: str,
    value: float,
    unit: str,
    nominal: float | None = None,
    note: str | None = None,
    source: str = "agent",
) -> MeasurementEvent:
    """将一个MeasurementEvent附加到日志中，然后返回它。

    自动分类是同步计算并缓存在事件上的，因此
    重播和过滤不需要重新运行规则。"""
    mode = auto_classify(target=target, value=value, unit=unit, nominal=nominal, note=note)
    ev = MeasurementEvent(
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        target=target,
        value=value,
        unit=unit,  # 类型：忽略[arg-type]
        nominal=nominal,
        note=note,
        source=source,  # 类型：忽略[arg-type]
        auto_classified_mode=mode,
    )
    path = _journal_path(memory_root, device_slug, repair_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(ev.model_dump_json() + "\n")
    except OSError as exc:
        logger.warning("append_measurement failed for %s / %s: %s", device_slug, repair_id, exc)
    return ev


def load_measurements(
    *,
    memory_root: Path,
    device_slug: str,
    repair_id: str,
    target: str | None = None,
    since: str | None = None,
) -> list[MeasurementEvent]:
    """返回MeasurementEvents的有序列表，可以选择过滤。"""
    path = _journal_path(memory_root, device_slug, repair_id)
    if not path.exists():
        return []
    events: list[MeasurementEvent] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = MeasurementEvent.model_validate_json(line)
            except ValueError:
                logger.warning("skipping malformed measurement line in %s", path)
                continue
            if target and ev.target != target:
                continue
            if since and ev.timestamp < since:
                continue
            events.append(ev)
    except OSError as exc:
        logger.warning("load_measurements failed for %s / %s: %s", device_slug, repair_id, exc)
    return events


def compare_measurements(
    *,
    memory_root: Path,
    device_slug: str,
    repair_id: str,
    target: str,
    before_ts: str | None = None,
    after_ts: str | None = None,
) -> dict[str, Any] | None:
    """返回目标日志的 {before, after, delta, delta_percent}。

    如果没有明确的时间戳，则使用第一个和最后一个事件
    目标。如果匹配的事件少于 2 个，则返回 None。"""
    events = load_measurements(
        memory_root=memory_root, device_slug=device_slug, repair_id=repair_id,
        target=target,
    )
    if len(events) < 2:
        return None
    if before_ts:
        candidates = [e for e in events if e.timestamp <= before_ts]
        before = candidates[-1] if candidates else events[0]
    else:
        before = events[0]
    if after_ts:
        candidates = [e for e in events if e.timestamp >= after_ts]
        after = candidates[0] if candidates else events[-1]
    else:
        after = events[-1]
    if before.timestamp == after.timestamp:
        return None
    # 跳过数字差异的占位符事件（值=无）。
    if before.value is None or after.value is None:
        return None
    delta = after.value - before.value
    delta_pct = None
    if before.value:
        delta_pct = round((delta / before.value) * 100, 2)
    return {
        "target": target,
        "before": {"timestamp": before.timestamp, "value": before.value, "mode": before.auto_classified_mode, "note": before.note},
        "after": {"timestamp": after.timestamp, "value": after.value, "mode": after.auto_classified_mode, "note": after.note},
        "delta": round(delta, 6),
        "delta_percent": delta_pct,
    }


def synthesise_observations(
    *,
    memory_root: Path,
    device_slug: str,
    repair_id: str,
) -> Any:
    """Walk the journal, keep the latest event per target, materialise
    an `Observations` shape suitable for hypothesize().

    Imports Observations / ObservedMetric lazily to avoid a circular
    dependency with api.pipeline.schematic."""
    from api.pipeline.schematic.hypothesize import Observations, ObservedMetric

    events = load_measurements(
        memory_root=memory_root, device_slug=device_slug, repair_id=repair_id,
    )
    latest: dict[str, MeasurementEvent] = {}
    for ev in events:
        latest[ev.target] = ev

    state_comps: dict[str, str] = {}
    state_rails: dict[str, str] = {}
    metrics_comps: dict[str, ObservedMetric] = {}
    metrics_rails: dict[str, ObservedMetric] = {}

    for target, ev in latest.items():
        try:
            kind, name = parse_target(target)
        except ValueError:
            continue
        if kind == "comp":
            if ev.auto_classified_mode in ("dead", "alive", "anomalous", "hot"):
                state_comps[name] = ev.auto_classified_mode
            if ev.value is not None:
                metrics_comps[name] = ObservedMetric(
                    measured=ev.value,
                    unit=ev.unit,  # 类型：忽略[arg-type]
                    nominal=ev.nominal,
                )
        elif kind == "rail":
            if ev.auto_classified_mode in ("dead", "alive", "shorted", "stuck_on"):
                state_rails[name] = ev.auto_classified_mode
            if ev.value is not None:
                metrics_rails[name] = ObservedMetric(
                    measured=ev.value,
                    unit=ev.unit,  # 类型：忽略[arg-type]
                    nominal=ev.nominal,
                )
        # 引脚级：不存储任何内容 - 引脚测量不映射到 refdes 模式。
    return Observations(
        state_comps=state_comps,
        state_rails=state_rails,
        metrics_comps=metrics_comps,
        metrics_rails=metrics_rails,
    )
