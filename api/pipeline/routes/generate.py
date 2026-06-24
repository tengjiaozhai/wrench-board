"""同步全管道端点 - `POST /pipeline/generate`。

当 Scout → Registry → Writers → Auditor 运行时，会阻塞约 30–120 秒。
后台任务变体存在于`repairs.py`（WS中继版本
由 `POST /repairs` 触发）。"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from api.pipeline.models import GenerateRequest
from api.pipeline.orchestrator import generate_knowledge_pack
from api.pipeline.schemas import PipelineResult

logger = logging.getLogger("wrench_board.pipeline.api")

router = APIRouter()


@router.post("/generate", response_model=PipelineResult)
async def generate(request: GenerateRequest) -> PipelineResult:
    """同步运行完整管道并在完成时返回结果。

    预计此调用会阻塞约 30–120 秒，具体取决于 Scout web_search 使用情况
    以及Auditor是否触发修改轮次。"""
    logger.info("[API] /pipeline/generate · device=%r", request.device_label)
    try:
        return await generate_knowledge_pack(request.device_label)
    except RuntimeError as exc:
        logger.exception("[API] Pipeline failed for device=%r", request.device_label)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
