"""Board-Delta 生成端点。

POST /pipeline/packs/{slug}/board-delta — 生成并存储每个修订版本的增量
GET /pipeline/packs/{slug}/board-delta/{board} — 检索存储的增量"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from anthropic import AsyncAnthropic
from fastapi import APIRouter, Form, Header, HTTPException

from api.config import get_settings
from api.pipeline.board_delta.agent import generate_board_delta
from api.pipeline.board_delta.store import normalize_board_number, read_delta, write_delta
from api.pipeline.build_metering import report_delta_usage

router = APIRouter()


@router.post("/packs/{slug}/board-delta")
async def create_board_delta(
    slug: str,
    device_label: str = Form(...),
    board_number: str = Form(...),
    x_owner_ref: str | None = Header(default=None, alias="X-Owner-Ref"),
):
    """为给定的设备版本生成并保留板增量。

    呼叫 Claude 代理，将结果写在下面
    ``memory/{⟦PRESERVE2⟧}/board_deltas/{board}.json``, and fires one
    ``kind='delta'``计量事件（no-op在self-host上）。"""
    settings = get_settings()
    client = AsyncAnthropic(api_key=settings.anthropic_api_key, max_retries=settings.anthropic_max_retries)
    delta = await generate_board_delta(
        client=client,
        model=settings.anthropic_model_main,
        device_label=device_label,
        board_number=board_number,
    )
    delta.generated_by_tenant = x_owner_ref
    delta.generated_at = datetime.now(timezone.utc).isoformat()
    write_delta(memory_root=Path(settings.memory_root), device_slug=slug, delta=delta)
    report_delta_usage(
        owner_ref=x_owner_ref,
        model=settings.anthropic_model_main,
        input_tokens=0,
        output_tokens=0,
        event_id=f"{slug}:delta:{normalize_board_number(board_number)}",
        kind="delta",
    )
    return delta.model_dump()


@router.get("/packs/{slug}/board-delta/{board}")
async def get_board_delta(slug: str, board: str):
    """返回存储的 board-delta，如果尚未生成，则返回 404。"""
    settings = get_settings()
    delta = read_delta(
        memory_root=Path(settings.memory_root),
        device_slug=slug,
        board_number=board,
    )
    if delta is None:
        raise HTTPException(status_code=404, detail=f"No board delta for {board!r}")
    return delta.model_dump()
