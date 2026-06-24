"""测量日志端点 — 修复下的 POST + GET。

`api.tools.measurements.mb_*` 上的细线垫片，因此 UI 是直接的
点击共享代理使用的相同持久性+分类器路径
通过工具调用。"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException

from api.config import get_settings
from api.pipeline.models import MeasurementCreate
from api.pipeline.orchestrator import _slugify
from api.pipeline.routes._helpers import _validate_repair_id
from api.tools.measurements import mb_list_measurements as _mb_list_measurements
from api.tools.measurements import mb_record_measurement as _mb_record_measurement

logger = logging.getLogger("wrench_board.pipeline.api")

router = APIRouter()


@router.post(
    "/packs/{device_slug}/repairs/{repair_id}/measurements",
    status_code=201,
)
async def post_measurement(
    device_slug: str,
    repair_id: str,
    body: MeasurementCreate,
) -> dict:
    """将测量事件附加到维修日志并自动分类。

    返回`{recorded, auto_classified_mode, timestamp}`。 400 当
    目标字符串解析失败（预期为 `rail:<name>` 或 `comp:<⟦PRESERVE0⟧>`）。
    这里故意跳过了WS发射——技术的直接用户界面点击
    仅当代理轮询日志时才会观察到。"""
    settings = get_settings()
    safe_repair_id = _validate_repair_id(repair_id)
    result = _mb_record_measurement(
        device_slug=_slugify(device_slug),
        repair_id=safe_repair_id,
        memory_root=Path(settings.memory_root),
        target=body.target,
        value=body.value,
        unit=body.unit,
        nominal=body.nominal,
        note=body.note,
        source="ui",
    )
    if not result.get("recorded"):
        raise HTTPException(status_code=400, detail=result)
    return result


@router.get("/packs/{device_slug}/repairs/{repair_id}/measurements")
async def get_measurements(
    device_slug: str,
    repair_id: str,
    target: str | None = None,
    since: str | None = None,
) -> dict:
    """返回测量日志进行维修，最新的在前。

    可选的 `?target=rail:+3V3` 和 `?since=<ISO-ts>` 查询过滤器。
    始终返回 `{found, measurements}` — `measurements` 为空时
    该期刊没有匹配的条目。"""
    settings = get_settings()
    safe_repair_id = _validate_repair_id(repair_id)
    return _mb_list_measurements(
        device_slug=_slugify(device_slug),
        repair_id=safe_repair_id,
        memory_root=Path(settings.memory_root),
        target=target,
        since=since,
    )
