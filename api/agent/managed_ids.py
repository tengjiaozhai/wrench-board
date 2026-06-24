"""读取`scripts/bootstrap_managed_agent.py`生成的引导ID。

预期的磁盘形状是多层格式
（⟦保留1⟧）。引导程序
当检测到前多层文件时，脚本还会将其迁移到位，因此
这里的运行时间可以保持狭窄并拒绝任何尚未完成的内容
还升级了。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, TypedDict

IDS_FILE = Path(__file__).resolve().parent.parent.parent / "managed_ids.json"


class AgentInfo(TypedDict, total=False):
    id: str
    version: int
    model: str
    legacy: bool


class ManagedIds(TypedDict):
    environment_id: str
    agents: dict[str, AgentInfo]  # 键：“快”| “正常” | “深的”


def load_managed_ids() -> ManagedIds:
    """返回持久的代理/环境 ID（按层键控）。

    如果文件丢失或形状无法识别，则引发 `RuntimeError`；
    调用者预计会重新运行 `scripts/bootstrap_managed_agent.py` 以
    实现/迁移它。"""
    if not IDS_FILE.exists():
        raise RuntimeError(
            f"{IDS_FILE.name} not found. Run "
            "`python scripts/bootstrap_managed_agent.py` before starting "
            "the diagnostic agent."
        )
    data: dict[str, Any] = json.loads(IDS_FILE.read_text())

    if "agents" in data:
        return {
            "environment_id": data["environment_id"],
            "agents": data["agents"],
        }

    raise RuntimeError(
        f"{IDS_FILE.name} has an unrecognised shape — re-run "
        "`python scripts/bootstrap_managed_agent.py` to migrate it."
    )


def get_agent(ids: ManagedIds, tier: str) -> AgentInfo:
    """返回 tier 的 agent 信息；缺失时抛出异常。"""
    agents = ids["agents"]
    if tier in agents:
        return agents[tier]
    raise RuntimeError(
        f"No agent bootstrapped for tier {tier!r}. "
        "Run `python scripts/bootstrap_managed_agent.py` to create it."
    )
