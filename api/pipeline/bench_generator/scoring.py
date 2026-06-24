"""`evaluator.compute_score` 周围有薄包装纸。

评估者接受`list[dict]`场景。我们接受的场景是
输入`ProposedScenario`；这个模块只是转换和委托。"""

from __future__ import annotations

from api.pipeline.bench_generator.schemas import ProposedScenario
from api.pipeline.schematic.evaluator import Scorecard, compute_score
from api.pipeline.schematic.schemas import ElectricalGraph


def score_accepted(
    graph: ElectricalGraph,
    scenarios: list[ProposedScenario],
) -> Scorecard:
    """以原生字典形式将接受的场景提供给评估器。"""
    dicts: list[dict] = []
    for s in scenarios:
        entry = {
            "id": s.id,
            "device_slug": s.device_slug,
            "cause": s.cause.model_dump(exclude_none=True),
            "expected_dead_rails": s.expected_dead_rails,
            "expected_dead_components": s.expected_dead_components,
        }
        dicts.append(entry)
    return compute_score(graph, dicts)
