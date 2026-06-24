"""Repair-session CRUD + `POST /repairs` 编排入口。

【HTTP 与 progress WS 的分工 — 时序图】

  ┌──────────────┐                              ┌──────────────┐
  │   浏览器      │                              │   后端        │
  └──────┬───────┘                              └──────┬───────┘
         │  ① POST /pipeline/repairs  (短连接 HTTP)      │
         │ ─────────────────────────────────────────► │
         │     create_repair() 写 repair、create_task    │
         │ ◄───────────────────────────────────────── │
         │  { repair_id, device_slug, pipeline_started }│
         │                                             │
         │  ② WS /pipeline/progress/{slug}  (长连接)   │
         │ ─────────────────────────────────────────► │
         │     progress_ws: accept → subscribe(slug)   │
         │ ◄── {type:"subscribed"} ─────────────────  │
         │ ◄── {type:"pipeline_started"} ───────────  │
         │ ◄── {type:"phase_started", ...} ─────────  │
         │     ...                                   │
         │  （并行）① 里 create_task 已在跑：          │
         │     emit → events.publish(slug, ev) ──────┘

【哪一行「建立 / 结束」HTTP？】
  - 前端发起（Landing「开始诊断」）：
      web/js/features/global/landing/index.js:471
        const res = await fetch("/pipeline/repairs", { method: "POST", ... });
      fetch 返回且 res.json() 读完（约 :477）后 HTTP 连接即关闭 — **不是长连接**。
  - 后端处理入口：
      api/pipeline/routes/repairs.py:737  @router.post("/repairs")
      api/pipeline/routes/repairs.py:738  async def create_repair(...)
  - 后端 HTTP 响应发出（Branch 1 典型路径）：
      api/pipeline/routes/repairs.py:988  return RepairResponse(...)

【哪一行「建立 / 保持」WS 长会话？】
  - 前端发起：
      web/js/features/global/landing/index.js:661  connectProgress(slug, …)
        ↑ 由 subscribeToProgress 调用；slug 来自 HTTP 响应的 device_slug
      web/js/services/pipelineSocket.js:27
        const ws = new WebSocket(url);   ← 浏览器 WS 握手，连接建立
  - 后端接受并保持：
      api/pipeline/routes/progress.py:58   await websocket.accept()
      api/pipeline/routes/progress.py:64-66
        while True:
            event = await queue.get()
            await websocket.send_text(...)   ← 循环阻塞，保持长连接直到客户端断开
  - 前端主动关闭示例：pipelineSocket.js:50-54 conn.close()；或 pipeline_finished 后跳转

【HTTP 与 WS 如何「关联」】
  无 session_id / ws_url；仅约定：
    HTTP 响应里的 device_slug  ==  WS 路径里的 {slug}
    HTTP 响应里的 pipeline_started == true  → 前端才去 connectProgress

Also re-exports `_run_pipeline_with_events` via the package
`__init__.py` — `tests/pipeline/test_pipeline_events_narration.py`
imports it directly under that name.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from anthropic import AsyncAnthropic
from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from pydantic import ValidationError

import api.pipeline as _pkg  # noqa: PLC0415 — module-attribute lookups for patchability
from api.agent.memory_stores import delete_repair_store
from api.pipeline import events
from api.pipeline.build_state import read_build_state
from api.pipeline.device_registry import get_device_registry_store, resolve_device
from api.pipeline.models import (
    DisambiguationCandidate,
    RepairRequest,
    RepairResponse,
    RepairSummary,
    ResolveDeviceRequest,
    ResolveDeviceResponse,
)
from api.pipeline.orchestrator import _slugify
from api.pipeline.routes._helpers import _validate_repair_id
from api.pipeline.routes.documents import persist_upload
from api.pipeline.routes.packs import _pack_is_complete

logger = logging.getLogger("wrench_board.pipeline.api")

router = APIRouter()


# ---------------------------------------------------------------------------
# Board-delta auto-generation helpers
# ---------------------------------------------------------------------------

def _should_autogenerate_delta(
    *,
    is_new: bool,
    board_number: str | None,
    allow_expand: bool,
    memory_root: Path,
    slug: str,
) -> bool:
    """Pure decision function: should we fire a board-delta auto-generation?

    Returns True only when ALL conditions hold:
    - this is a brand-new repair (``is_new=True``);
    - a board_number was supplied;
    - generation is allowed (``allow_expand=True`` — the front-door plan signal;
      self-host always sends True / omits the field, so it defaults to True);
    - no delta already exists on disk for (slug, board_number) — avoid respend.
    """
    if not is_new:
        return False
    if not board_number:
        return False
    if not allow_expand:
        return False
    # Lazy import keeps the cold-path fast when board_delta is not needed.
    from api.pipeline.board_delta.store import normalize_board_number, read_delta
    norm = normalize_board_number(board_number)
    if not norm:
        return False
    existing = read_delta(memory_root=memory_root, device_slug=slug, board_number=norm)
    return existing is None


async def _autogenerate_delta_task(
    *,
    device_label: str,
    board_number: str,
    slug: str,
    memory_root: Path,
    owner_ref: str | None,
) -> None:
    """Fire-and-forget background coroutine: generate and write a board delta.

    Mirrors the style of ``_run_pipeline_with_events``: best-effort, logs and
    swallows all exceptions so a delta failure never breaks the repair session.
    The AsyncAnthropic client MUST carry ``max_retries`` on the same line
    (governance grep in tests/agent/test_client_config.py).
    """
    from api.pipeline.board_delta.agent import generate_board_delta
    from api.pipeline.board_delta.store import write_delta

    settings = _pkg.get_settings()
    if not settings.anthropic_api_key:
        logger.info(
            "[BoardDelta] auto-gen skipped for slug=%r board=%r: no API key configured",
            slug, board_number,
        )
        return
    try:
        from datetime import UTC
        from datetime import datetime as _dt
        client = AsyncAnthropic(api_key=settings.anthropic_api_key, max_retries=settings.anthropic_max_retries)  # noqa: E501
        logger.info(
            "[BoardDelta] auto-generating delta for slug=%r board_number=%r",
            slug, board_number,
        )
        delta = await generate_board_delta(
            client=client,
            model=settings.anthropic_model_main,
            device_label=device_label,
            board_number=board_number,
        )
        delta.generated_at = _dt.now(UTC).isoformat()
        delta.generated_by_tenant = owner_ref
        write_delta(memory_root=memory_root, device_slug=slug, delta=delta)
        logger.info(
            "[BoardDelta] auto-gen complete for slug=%r board=%r coverage=%s",
            slug, board_number, delta.coverage,
        )
    except Exception:  # noqa: BLE001 — best-effort; never break repair creation
        logger.exception(
            "[BoardDelta] auto-gen failed for slug=%r board=%r", slug, board_number
        )


# ---------------------------------------------------------------------------
# 后台 pipeline 任务注册 + 并发 build 队列
# ---------------------------------------------------------------------------
# _RUNNING：slug → 正在执行的 asyncio.Task。用于：
#   - 同 slug 重复 POST 时复用进行中的 build（不重复烧 token）
#   - POST /repairs/{slug}/cancel 协作式取消
# 进程内状态；多 worker 需共享信号（与 events 总线同理）。
_RUNNING: dict[str, asyncio.Task] = {}


def _register_running(slug: str, task: asyncio.Task) -> None:
    """Track a freshly-spawned pipeline task; auto-deregister when it settles."""
    _RUNNING[slug] = task

    def _done(t: asyncio.Task, s: str = slug) -> None:
        # Only drop our own entry — a newer run on the same slug must survive.
        if _RUNNING.get(s) is t:
            _RUNNING.pop(s, None)

    task.add_done_callback(_done)


def _slug_is_building(slug: str) -> bool:
    """该 slug 是否已有 pipeline 在跑。

    pack 按 slug 共享，第二个 repair 若再 launch 会重复消耗 LLM 且覆盖 _RUNNING。
    此时直接返回 pipeline_started=true，让新 repair「搭车」已有 build 的
    /pipeline/progress/{slug} 事件流（无需再 create_task）。
    """
    task = _RUNNING.get(slug)
    return task is not None and not task.done()


# 当前占用「重 build 槽位」的数量（仅 full pipeline，不含 expand 等轻任务）。
_active_builds = 0

# FIFO 等待队列：并发 build 超过 pipeline_max_concurrent_builds 时，
# 新请求入队而非 503。队列中的 launch 闭包与立即启动的 _launch() 相同，
# 出队时同样走 _register_build → _run_pipeline_with_events → events.publish。
_build_queue: list[dict] = []


def _build_cap() -> int:
    """Max concurrent heavy builds; 0 = unlimited."""
    cap = _pkg.get_settings().pipeline_max_concurrent_builds
    return cap if cap and cap > 0 else 0


def _builds_at_capacity() -> bool:
    cap = _build_cap()
    return cap > 0 and _active_builds >= cap


def _slug_queued(slug: str) -> bool:
    return any(item["slug"] == slug for item in _build_queue)


def _queue_position(slug: str) -> int:
    """1-based position of `slug` in the queue, or 0 if not queued."""
    for i, item in enumerate(_build_queue, start=1):
        if item["slug"] == slug:
            return i
    return 0


def _enqueue_build(slug: str, launch) -> int:
    """Append a pending build (`launch` = zero-arg callable → coroutine).
    Returns its 1-based queue position."""
    _build_queue.append({"slug": slug, "launch": launch})
    return len(_build_queue)


async def _publish_queue_positions() -> None:
    """向仍在排队的每个 slug 的 progress 流推送最新 queue 位置。

    前端 landing timeline 据此显示「排队中 · 第 N 位」；位置随前面 build 完成而递减。
    """
    for i, item in enumerate(_build_queue, start=1):
        await events.publish(item["slug"], {"type": "queued", "position": i, "ahead": i - 1})


def _drain_queue() -> None:
    """某 build 结束后释放槽位，从队头依次启动等待中的 launch()。

    启动方式与 create_repair Branch 1 相同：
      _register_build(slug, asyncio.create_task(item["launch"]()))
    launch 闭包内部仍调用 _run_pipeline_with_events → events.publish。
    """
    launched = False
    while not _builds_at_capacity() and _build_queue:
        item = _build_queue.pop(0)
        _register_build(item["slug"], asyncio.create_task(item["launch"]()))
        launched = True
    if launched and _build_queue:
        # The survivors all shifted up one slot → refresh their positions.
        asyncio.create_task(_publish_queue_positions())


def _register_build(slug: str, task: asyncio.Task) -> None:
    """登记一次「重 build」：计入并发 cap、写入 _RUNNING，结束时出队下一个。

    create_repair 在 Branch 1 的典型调用：
      _register_build(slug, asyncio.create_task(_launch()))
    注意：HTTP return RepairResponse 发生在本函数**之后**；task 已在后台运行，
    与 progress WS 的连接完全靠 slug + pipeline_started 前端约定。
    """
    global _active_builds
    _active_builds += 1

    def _dec(_t: asyncio.Task) -> None:
        global _active_builds
        _active_builds -= 1
        _drain_queue()

    task.add_done_callback(_dec)
    _register_running(slug, task)


def _persist_repair(
    memory_root: Path,
    slug: str,
    device_label: str,
    symptom: str,
    owner_ref: str | None = None,
) -> tuple[str, bool]:
    """Write the repair metadata to memory/{slug}/repairs/{repair_id}.json.

    Returns `(repair_id, is_new)`. When an `open` or `in_progress` repair
    already exists on this `(slug, normalised_symptom)` **AND the same owner_ref**
    we **reuse its id** and return `is_new=False` — the caller short-circuits
    coverage + expand so the technician doesn't burn $0.40 of LLM tokens every
    time they resubmit the same form. Closed repairs do NOT block dedup: starting
    a new ticket on a previously-resolved symptom is intentional.

    `owner_ref` scopes the dedup to one owner: a multi-tenant front-door passes
    the tenant id so two tenants on the same (device, symptom) get SEPARATE
    repairs (no cross-tenant id reuse, no shared conversations). Standalone runs
    pass None → all repairs share one (None) owner, preserving single-tenant
    behaviour. The match is exact (None matches only None), so a tenant request
    never reuses a legacy ownerless repair and vice-versa.

    `status` starts at 'open' on a fresh repair and is updated as the
    session evolves.
    """
    repairs_dir = memory_root / slug / "repairs"
    repairs_dir.mkdir(parents=True, exist_ok=True)

    norm_symptom = symptom.strip().lower()
    if norm_symptom:
        for existing_path in repairs_dir.glob("*.json"):
            try:
                payload = json.loads(existing_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            if payload.get("status") not in ("open", "in_progress"):
                continue
            if (payload.get("symptom") or "").strip().lower() != norm_symptom:
                continue
            # Owner-scoped: never reuse another owner's repair (cross-tenant guard).
            if payload.get("owner_ref") != owner_ref:
                continue
            existing_id = payload.get("repair_id")
            if isinstance(existing_id, str) and existing_id:
                return existing_id, False

    repair_id = uuid.uuid4().hex[:12]
    payload = {
        "repair_id": repair_id,
        "device_slug": slug,
        "device_label": device_label,
        "symptom": symptom,
        "status": "open",
        "created_at": datetime.now(UTC).isoformat(),
    }
    if owner_ref is not None:
        payload["owner_ref"] = owner_ref
    (repairs_dir / f"{repair_id}.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return repair_id, True


@router.get("/repairs", response_model=list[RepairSummary])
async def list_repairs() -> list[RepairSummary]:
    """Return every repair ever created, across every device, newest first.

    Powers the home library: each row is one client intervention the
    technician can open, reopen, or finish. Status drives the visual
    badge ('open' · 'in_progress' · 'closed').
    """
    settings = _pkg.get_settings()
    root = Path(settings.memory_root)
    results: list[RepairSummary] = []
    if not root.exists():
        return results

    for pack_dir in root.iterdir():
        if not pack_dir.is_dir():
            continue
        repairs_dir = pack_dir / "repairs"
        if not repairs_dir.exists():
            continue
        # Build state is per-PACK (per device_slug), shared by every repair on
        # that device — read it once per pack_dir, not once per repair file.
        marker = read_build_state(pack_dir)
        build_state = marker.get("status") if marker else None
        for path in repairs_dir.glob("*.json"):
            try:
                payload = json.loads(path.read_text())
            except json.JSONDecodeError:
                logger.warning("Skipping malformed repair file: %s", path)
                continue
            results.append(
                RepairSummary(
                    repair_id=payload.get("repair_id", path.stem),
                    device_slug=payload.get("device_slug", pack_dir.name),
                    device_label=payload.get("device_label", pack_dir.name),
                    symptom=payload.get("symptom", ""),
                    status=payload.get("status", "open"),
                    created_at=payload.get("created_at", ""),
                    board_number=payload.get("board_number") or None,
                    build_state=build_state,
                )
            )
    results.sort(key=lambda r: r.created_at, reverse=True)
    return results


@router.get("/repairs/{repair_id}", response_model=RepairSummary)
async def get_repair(repair_id: str) -> RepairSummary:
    """Return one repair's metadata — used to resume a session from its id."""
    settings = _pkg.get_settings()
    root = Path(settings.memory_root)
    if not root.exists():
        raise HTTPException(status_code=404, detail=f"No repair {repair_id!r}")
    for pack_dir in root.iterdir():
        if not pack_dir.is_dir():
            continue
        candidate = pack_dir / "repairs" / f"{repair_id}.json"
        if candidate.exists():
            payload = json.loads(candidate.read_text())
            marker = read_build_state(pack_dir)
            return RepairSummary(
                repair_id=payload.get("repair_id", repair_id),
                device_slug=payload.get("device_slug", pack_dir.name),
                device_label=payload.get("device_label", pack_dir.name),
                symptom=payload.get("symptom", ""),
                status=payload.get("status", "open"),
                created_at=payload.get("created_at", ""),
                board_number=payload.get("board_number") or None,
                build_state=marker.get("status") if marker else None,
            )
    raise HTTPException(status_code=404, detail=f"No repair {repair_id!r}")


@router.delete("/repairs/{repair_id}")
async def delete_repair(repair_id: str) -> dict:
    """Delete a repair: its disk artefacts AND any per-repair MA memory store.

    Scope:
      - removes `memory/{slug}/repairs/{repair_id}.json` (the metadata)
      - removes `memory/{slug}/repairs/{repair_id}/` (subdir with chat
        history, findings, managed.json marker, conversations…)
      - calls the Managed Agents API to delete the per-repair memory store
        named `wrench-board-repair-{slug}-{repair_id}` (if a marker is on
        disk). Best-effort: an MA failure logs but doesn't block disk
        cleanup, since a stranded store is recoverable manually whereas a
        half-deleted disk state is not.

    Does NOT touch the device-level pack (`memory/{slug}/*.json`) or the
    shared `device-{slug}` / `global-*` memory stores — that knowledge is
    reused by the next repair on the same device.
    """
    settings = _pkg.get_settings()
    root = Path(settings.memory_root)
    if not root.exists():
        raise HTTPException(status_code=404, detail=f"No repair {repair_id!r}")

    metadata_file: Path | None = None
    device_slug: str | None = None
    for pack_dir in root.iterdir():
        if not pack_dir.is_dir():
            continue
        candidate = pack_dir / "repairs" / f"{repair_id}.json"
        if candidate.exists():
            metadata_file = candidate
            device_slug = pack_dir.name
            break

    if metadata_file is None or device_slug is None:
        raise HTTPException(status_code=404, detail=f"No repair {repair_id!r}")

    # 1. MA cleanup (best-effort). Drives off the on-disk marker so that a
    # repair which never opened a session simply no-ops here.
    store_deleted = False
    try:
        client = AsyncAnthropic(api_key=settings.anthropic_api_key or "missing", max_retries=settings.anthropic_max_retries)  # noqa: E501
        store_deleted = await delete_repair_store(
            client, device_slug=device_slug, repair_id=repair_id
        )
    except Exception as exc:  # noqa: BLE001 — MA cleanup is best-effort; never block disk wipe
        logger.warning(
            "delete_repair: MA cleanup raised for repair=%s: %s — proceeding with disk",
            repair_id,
            exc,
        )

    # 2. Disk cleanup. Remove subdir first (best-effort), then the metadata
    # JSON. Order matters — list_repairs scans the JSONs, so wiping the
    # metadata last is what makes the repair disappear from the library.
    subdir = metadata_file.parent / repair_id
    dir_deleted = False
    if subdir.exists() and subdir.is_dir():
        try:
            shutil.rmtree(subdir)
            dir_deleted = True
        except OSError as exc:
            logger.error(
                "delete_repair: rmtree failed for %s: %s", subdir, exc
            )
            raise HTTPException(
                status_code=500,
                detail=f"Failed to remove repair directory: {exc}",
            ) from exc

    try:
        metadata_file.unlink()
    except OSError as exc:
        logger.error(
            "delete_repair: unlink failed for %s: %s", metadata_file, exc
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to remove repair metadata: {exc}",
        ) from exc

    return {
        "repair_id": repair_id,
        "device_slug": device_slug,
        "store_deleted": store_deleted,
        "dir_deleted": dir_deleted,
    }


@router.get("/repairs/{repair_id}/conversations")
def list_repair_conversations(repair_id: str) -> dict:
    """Return the conversation index for a repair.

    The repair's `device_slug` is inferred from the metadata file one level
    up in `memory/{slug}/repairs/{repair_id}.json` — clients don't pass it.
    """
    from api.agent.chat_history import list_conversations

    settings = _pkg.get_settings()
    memory = Path(settings.memory_root)
    found_slug: str | None = None
    if memory.exists():
        for metadata_file in memory.glob(f"*/repairs/{repair_id}.json"):
            found_slug = metadata_file.parent.parent.name
            break
    if not found_slug:
        raise HTTPException(status_code=404, detail=f"unknown repair_id {repair_id}")
    convs = list_conversations(device_slug=found_slug, repair_id=repair_id)
    return {
        "device_slug": found_slug,
        "repair_id": repair_id,
        "conversations": convs,
    }


@router.delete("/repairs/{repair_id}/conversations/{conv_id}")
def delete_repair_conversation(repair_id: str, conv_id: str) -> dict:
    """Delete a single conversation from a repair.

    Wipes `memory/{slug}/repairs/{repair_id}/conversations/{conv_id}/` and
    drops the matching entry from `conversations/index.json`. The repair
    itself, its metadata file, sibling conversations, and the shared
    repair-level MA memory store are untouched. The per-tier MA sessions
    stored under the conv dir are dropped with it; their upstream Anthropic
    counterparts are left to expire naturally.
    """
    safe_repair_id = _validate_repair_id(repair_id)
    safe_conv_id = _validate_repair_id(conv_id)  # same shape constraints
    from api.agent.chat_history import delete_conversation

    settings = _pkg.get_settings()
    memory = Path(settings.memory_root)
    found_slug: str | None = None
    if memory.exists():
        for metadata_file in memory.glob(f"*/repairs/{safe_repair_id}.json"):
            found_slug = metadata_file.parent.parent.name
            break
    if not found_slug:
        raise HTTPException(status_code=404, detail=f"unknown repair_id {safe_repair_id}")

    try:
        removed = delete_conversation(
            device_slug=found_slug,
            repair_id=safe_repair_id,
            conv_id=safe_conv_id,
        )
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to remove conversation: {exc}",
        ) from exc

    if not removed:
        raise HTTPException(
            status_code=404,
            detail=f"unknown conversation {safe_conv_id} for repair {safe_repair_id}",
        )

    return {
        "repair_id": safe_repair_id,
        "conv_id": safe_conv_id,
        "device_slug": found_slug,
        "removed": True,
    }


@router.get("/repairs/{repair_id}/protocol")
async def get_repair_protocol(
    repair_id: str, device_slug: str, conv: str | None = None,
) -> dict:
    """Return the active protocol artifact for this repair (or {active: false}).

    `conv` is the conversation id to scope the lookup. When omitted, falls
    back to the legacy repair-root protocol pointer (kept for backward
    compatibility with pre-per-conv artefacts).
    """
    from api.tools.protocol import load_active_protocol
    settings = _pkg.get_settings()
    proto = load_active_protocol(
        Path(settings.memory_root), device_slug, repair_id, conv_id=conv,
    )
    if proto is None:
        return {"active": False}
    return {
        "active": True,
        "protocol_id": proto.protocol_id,
        "title": proto.title,
        "rationale": proto.rationale,
        "current_step_id": proto.current_step_id,
        "status": proto.status,
        "steps": [s.model_dump(mode="json") for s in proto.steps],
        "history": [h.model_dump(mode="json") for h in proto.history],
    }


async def _run_pipeline_with_events(
    device_label: str,
    slug: str,
    focus_symptom: str | None = None,
    *,
    confirmed_device_kind: str | None = None,
    user_device_kind: str | None = None,
    expect_schematic: bool = False,
    owner_ref: str | None = None,
    engine_repair_id: str | None = None,
) -> None:
    """后台协程：跑完整 knowledge pipeline，并把进度事件写入 events 总线。

    【与 progress WS 的连接点 — 本函数是 publish 侧的唯一入口】
      orchestrator 在每个阶段边界调用 emit({type, phase, …})：
        emit → _on_event(ev) → events.publish(slug, ev)
      progress_ws 在 subscribe(slug) 后从同一 slug 的 queue 读出并转发。

    【事件类型（orchestrator 发出，前端 handleEvent 消费）】
      pipeline_started     — 构建开始（含 device_label、models）
      phase_started/finished — 大阶段：scout / registry / writers / audit 等
      phase_step           — 阶段内子步骤（Scout 搜索轮、schematic 页、writer 完成…）
      pipeline_paused      — 设备类型需人工确认（needs_kind_confirmation）
      pipeline_finished    — 成功（含 audit verdict、consistency_score）
      pipeline_failed      — 异常或 REJECTED（本函数 except 也会 publish 此类型）

    本函数由 create_repair 的 _launch() 闭包经 asyncio.create_task 启动；
    HTTP 响应不等待本函数结束。
    """
    t0 = time.monotonic()

    # 桥接 orchestrator 与 events 总线：slug 必须与 progress WS 路径参数一致。
    async def _on_event(ev: dict) -> None:
        await events.publish(slug, ev)

    try:
        await _pkg.generate_knowledge_pack(
            device_label,
            # 固定 pack 目录为 repair 的 slug；否则 orchestrator 会重新 slugify label，
            # 在 uploads 已存在的 pack 旁另建目录（graph 丢失）。
            device_slug=slug,
            on_event=_on_event,  # ← orchestrator.emit 的最终落点
            focus_symptom=focus_symptom,
            confirmed_device_kind=confirmed_device_kind,
            user_device_kind=user_device_kind,
            expect_schematic=expect_schematic,
            owner_ref=owner_ref,
            engine_repair_id=engine_repair_id,
        )
    except Exception as exc:  # noqa: BLE001 — fire-and-forget；失败也通知前端
        logger.exception("[API] background pipeline failed for slug=%r", slug)
        # 确保 progress WS 收到终端事件，前端 timeline 可显示失败态。
        await events.publish(
            slug,
            {
                "type": "pipeline_failed",
                "status": "ERROR",
                "error": str(exc),
                "elapsed_s": time.monotonic() - t0,
            },
        )


async def _maybe_check_coverage(
    slug: str,
    symptom: str,
    memory_root: Path,
) -> CoverageCheck:  # noqa: F821 — forward-only type ref
    """Call the Haiku coverage classifier; on any failure, fall back to
    an uncovered verdict so the expand-pack path still fires.

    Lazy-imports `check_symptom_coverage` to avoid a module-load cycle:
    coverage → schemas → api.pipeline (this module)."""
    from api.pipeline.coverage import check_symptom_coverage
    from api.pipeline.schemas import CoverageCheck

    settings = _pkg.get_settings()
    if not settings.anthropic_api_key:
        return CoverageCheck(
            covered=False,
            matched_rule_id=None,
            confidence=0.0,
            reason="no Anthropic API key configured — treating as uncovered",
        )
    client = AsyncAnthropic(api_key=settings.anthropic_api_key, max_retries=settings.anthropic_max_retries)
    try:
        return await check_symptom_coverage(
            client=client,
            model=settings.anthropic_model_fast,
            device_slug=slug,
            symptom=symptom,
            memory_root=memory_root,
        )
    except Exception as exc:  # noqa: BLE001 — failure falls through to expand
        logger.warning(
            "[API] coverage check failed for slug=%r (%s); treating as uncovered",
            slug,
            exc,
        )
        return CoverageCheck(
            covered=False,
            matched_rule_id=None,
            confidence=0.0,
            reason=f"coverage classifier error: {exc}",
        )


@router.post("/resolve-device", response_model=ResolveDeviceResponse)
async def resolve_device_route(
    req: ResolveDeviceRequest,
    x_owner_ref: str | None = Header(default=None, alias="X-Owner-Ref"),
) -> ResolveDeviceResponse:
    """Resolve a free device label to a canonical identity (or the ambiguous
    candidate menu) WITHOUT creating a repair or building. The cloud front-door
    calls this before its quota gate so it adopts the canonical slug and gets
    disambiguation for free. A pinned device_slug is returned verbatim."""
    if req.device_slug:
        return ResolveDeviceResponse(canonical_slug=req.device_slug, ambiguous=False, candidates=[])
    memory_root = Path(_pkg.get_settings().memory_root)
    store = get_device_registry_store(memory_root)
    res = await resolve_device(req.device_label, store, owner_ref=x_owner_ref)
    return ResolveDeviceResponse(
        canonical_slug=res["canonical_slug"],
        ambiguous=bool(res["ambiguous"]),
        candidates=[
            DisambiguationCandidate(
                device_slug=c.get("canonicalKey"),
                family=c.get("family"),
                facets=c.get("facets") or {},
            )
            for c in res.get("candidates", [])
        ],
    )


@router.post("/repairs", response_model=RepairResponse)
async def create_repair(
    device_label: str = Form(...),
    symptom: str = Form(...),
    device_slug: str | None = Form(default=None),
    device_kind: str | None = Form(default=None),
    force_rebuild: bool = Form(default=False),
    owner_ref: str | None = Form(default=None),
    allow_expand: bool = Form(default=True),
    schematic_pending: bool = Form(default=False),
    board_number: str | None = Form(default=None),
    file: UploadFile | None = File(default=None),  # noqa: B008 — FastAPI DI idiom
) -> RepairResponse:
    """注册 repair 会话；按需**后台**启动 knowledge pipeline。

    【pack 与分支 — 详见下方 pack_dir 处大段注释，此处为决策树摘要】

      pack = memory/{slug}/ 下的设备级知识包（registry / graph / rules / dictionary …）
      pack_complete = _pack_is_complete(pack_dir)  # 四核心 JSON + build_state=complete

      persist repair 之后：
        not is_new + pack_complete     → Branch 0  复用工单，pipeline_started=false
        not pack_complete | force_rebuild → Branch 1  后台构建 pack，pipeline_started=true + progress WS
        pack_complete + 症状已覆盖 rule  → Branch 2  直接诊断，pipeline_started=false + matched_rule_id
        pack_complete + 症状未覆盖       → Branch 3  直接诊断，pipeline_started=false，expand 由 agent 按需

    【HTTP 响应 vs progress 流】
      pipeline_started=true  → 前端连 WS /pipeline/progress/{device_slug}
      pipeline_started=false → 直接 goToWorkspace，不订阅 progress WS

    Multipart 支持创建时附带 schematic；file 会先写入 memory/{slug}/uploads/，
    再 fire-and-forget 生成，以便 orchestrator 内联 ingest 电气图。
    """
    try:
        request = RepairRequest(
            device_label=device_label,
            symptom=symptom,
            device_slug=device_slug,
            device_kind=device_kind,
            force_rebuild=force_rebuild,
            owner_ref=owner_ref,
            allow_expand=allow_expand,
        )
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from exc

    settings = _pkg.get_settings()
    memory_root = Path(settings.memory_root)
    # T9a device alias registry: when the slug isn't explicitly pinned, resolve
    # the free label to a canonical device identity so aliases of the same board
    # (board# / Apple model / EMC / marketing) land on ONE pack instead of N.
    # Best-effort: any registry hiccup degrades to the naive slugify (today's
    # behavior), so resolution can never block a repair.
    slug = request.device_slug or _slugify(request.device_label)
    resolution = None
    if not request.device_slug:
        try:
            store = get_device_registry_store(memory_root)
            resolution = await resolve_device(
                request.device_label, store, owner_ref=request.owner_ref
            )
            slug = resolution["canonical_slug"]
        except Exception:  # noqa: BLE001 - registry must never break a repair
            logger.warning("[API] device resolution failed for %r — using slug=%r",
                           request.device_label, slug, exc_info=True)

    # T9a confirm-on-uncertainty: a broad term that fans out to several siblings —
    # don't guess. Return the candidate menu; no repair created, no build started.
    if resolution is not None and resolution.get("ambiguous"):
        return RepairResponse(
            repair_id="",
            device_slug=slug,
            device_label=request.device_label,
            pipeline_started=False,
            pipeline_kind="none",
            needs_disambiguation=True,
            candidates=[
                DisambiguationCandidate(
                    device_slug=c.get("canonicalKey"),
                    family=c.get("family"),
                    facets=c.get("facets") or {},
                )
                for c in resolution.get("candidates", [])
            ],
        )
    pack_dir = memory_root / slug

    # =========================================================================
    # 【pack 是什么】
    #
    #   pack（knowledge pack / 知识包）= 某设备（slug）在磁盘上的共享诊断知识，
    #   目录为 memory/{slug}/，典型文件：
    #     registry.json · knowledge_graph.json · rules.json · dictionary.json
    #     （可选）electrical_graph.json · schematic_graph.json · audit_verdict.json …
    #
    #   pack 由 pipeline 离线构建（Scout→Registry→Writers→Audit），**按设备共享**：
    #   同一 slug 的所有 repair 会话复用同一份 pack；repair 只是「一次工单/对话」。
    #
    #   pack_complete（下方）= _pack_is_complete(pack_dir)：四份核心 JSON 齐全且
    #   build_state 非 failed/building/paused。不完整 = 从未构建、构建中断、或 force 重建。
    #
    # 【分支总览 — create_repair 在 persist repair 之后的决策树】
    #
    #   Branch 0  重复提交同一 open repair + pack 已完整
    #             → pipeline_started=false，直接复用工单，不跑 LLM
    #
    #   Branch 1  pack 不完整（无 pack / 构建失败）或 force_rebuild=true
    #             → 后台跑完整 pipeline，pipeline_started=true，前端订阅 progress WS
    #
    #   Branch 2  pack 已完整 + 症状已被现有 rule 覆盖（coverage ≥ 0.7）
    #             → pipeline_started=false，直接进诊断，返回 matched_rule_id
    #
    #   Branch 3  pack 已完整 + 症状未被 rule 覆盖
    #             → pipeline_started=false，直接进诊断；expand 由 agent 按需提议
    #               （mb_expand_knowledge），不在 create_repair 时自动烧 token
    # =========================================================================

    # Every "new repair" IS a repair session — persist the record
    # whether the pack is fresh or already on disk. Two repairs on the same
    # iPhone X are two separate sessions with two separate contexts; both
    # must be reopenable later from the library.
    repair_id, is_new = _persist_repair(
        memory_root, slug, request.device_label, request.symptom, request.owner_ref
    )
    # Persist board_number on the repair record when supplied. Only on a new
    # repair (is_new=True): a reused ticket keeps the board_number it was
    # created with so older sessions stay consistent. Normalised via
    # normalize_board_number (strips whitespace, canonical separator).
    if board_number and is_new:
        from api.pipeline.board_delta.store import normalize_board_number as _nbn
        repair_path = memory_root / slug / "repairs" / f"{repair_id}.json"
        try:
            payload = json.loads(repair_path.read_text(encoding="utf-8"))
            payload["board_number"] = _nbn(board_number)
            repair_path.write_text(
                json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
            )
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            logger.warning("[API] could not persist board_number on repair=%s: %s", repair_id, exc)

    # Auto-generate board delta when a board_number is supplied on a NEW repair
    # and the plan allows it. Fire-and-forget: the POST returns immediately;
    # the delta lands on disk in the background without blocking the tech.
    if _should_autogenerate_delta(
        is_new=is_new,
        board_number=board_number,
        allow_expand=allow_expand,
        memory_root=memory_root,
        slug=slug,
    ):
        asyncio.create_task(
            _autogenerate_delta_task(
                device_label=request.device_label,
                board_number=board_number,  # type: ignore[arg-type] — guarded by _should_autogenerate_delta
                slug=slug,
                memory_root=memory_root,
                owner_ref=request.owner_ref,
            )
        )

    # 判断该 slug 的知识包是否「可用」— 后续 if/else 全靠此布尔值分叉。
    pack_complete = _pack_is_complete(pack_dir, owner_ref=request.owner_ref)

    # -------------------------------------------------------------------------
    # Branch 0 — 同一 (slug, symptom) 的 open repair 被重复提交
    #
    #   条件：not is_new（_persist_repair 复用了已有工单）
    #
    #   pack 已完整 → 直接 return，不 coverage 检查、不 expand、不 rebuild
    #     前端：pipeline_started=false → 不进 progress WS，直接 goToWorkspace
    #
    #   pack 不完整 → 不 return，落到 Branch 1 重新触发构建（「重试/relancer」）
    #   force_rebuild=true → 同样落到 Branch 1
    # -------------------------------------------------------------------------
    if not is_new:
        if pack_complete and not request.force_rebuild:
            logger.info(
                "[API] /pipeline/repairs · reusing open repair=%s for slug=%r — no LLM run",
                repair_id,
                slug,
            )
            return RepairResponse(
                repair_id=repair_id,
                device_slug=slug,
                device_label=request.device_label,
                pipeline_started=False,  # Branch 0：不构建，不进 progress WS
                pipeline_kind="none",
                coverage_reason="reusing existing open ticket on the same symptom",
            )
        logger.info(
            "[API] /pipeline/repairs · open repair=%s on INCOMPLETE pack for slug=%r — re-firing the build",
            repair_id,
            slug,
        )

    # Stash an attached schematic — either a fresh repair or a retry that is about
    # to re-fire the build (a complete-pack dedup hit returned above). Done BEFORE
    # the generation kickoff so the orchestrator's inline-ingest picks it up; we
    # deliberately do NOT trigger the documents-endpoint auto-pin/background ingest
    # here (it would race the inline-ingest).
    if file is not None and file.filename:
        await persist_upload(pack_dir / "uploads", "schematic_pdf", file)

    # -------------------------------------------------------------------------
    # Branch 1 — **无可用 pack** 或 **强制重建**
    #
    #   条件：not pack_complete  OR  request.force_rebuild
    #
    #   含义：
    #     - 无 pack：memory/{slug}/ 缺少四份核心 JSON，或 build_state=building/failed
    #     - force_rebuild：pack 虽完整，用户明确要求全量重跑 pipeline
    #
    #   行为：
    #     - asyncio.create_task(_launch()) 后台跑 Scout→Registry→Writers→Audit
    #     - 进度经 events.publish → WS /pipeline/progress/{slug}
    #     - 前端：pipeline_started=true → subscribeToProgress(slug)
    #
    #   子情况（仍属 Branch 1，但不重复 create_task）：
    #     - 同 slug 已有 build 在跑 → 搭车已有 progress 流
    #     - 并发 build 超 cap → 入队，先发 type:queued 事件
    # -------------------------------------------------------------------------
    if not pack_complete or request.force_rebuild:
        # 已有同 slug build 在跑 → 不 create_task，新 repair 复用同一 progress 流。
        if _slug_is_building(slug):
            logger.info(
                "[API] /pipeline/repairs · slug=%r already building — repair=%s joins the in-flight pipeline",
                slug,
                repair_id,
            )
            return RepairResponse(
                repair_id=repair_id,
                device_slug=slug,
                device_label=request.device_label,
                pipeline_started=True,  # 前端：订阅 /pipeline/progress/{slug}
                pipeline_kind="full",
            )
        # 已在排队 → 同样 pipeline_started=true，UI 显示 queue_position。
        if _slug_queued(slug):
            pos = _queue_position(slug)
            return RepairResponse(
                repair_id=repair_id,
                device_slug=slug,
                device_label=request.device_label,
                pipeline_started=True,
                pipeline_kind="full",
                queued=True,
                queue_position=pos,
            )
        if request.force_rebuild and pack_complete:
            logger.info(
                "[API] /pipeline/repairs · force_rebuild=True · repair=%s regenerating pack for slug=%r",
                repair_id,
                slug,
            )

        # 捕获 build 参数的闭包；立即启动或入队后由 _drain_queue 启动。
        # 闭包内的 slug 与 HTTP 响应里的 device_slug 相同 — progress WS 的 join key。
        def _launch():
            return _run_pipeline_with_events(
                request.device_label,
                slug,
                focus_symptom=request.symptom,
                user_device_kind=request.device_kind,
                expect_schematic=schematic_pending and file is None,
                owner_ref=request.owner_ref,
                engine_repair_id=repair_id,
            )

        if _builds_at_capacity():
            pos = _enqueue_build(slug, _launch)
            # 排队事件也走 events 总线，progress WS 连上后即可收到 type: queued。
            await events.publish(slug, {"type": "queued", "position": pos, "ahead": pos - 1})
            logger.info(
                "[API] /pipeline/repairs · build queued at position %d (cap=%d) for slug=%r",
                pos,
                _build_cap(),
                slug,
            )
            return RepairResponse(
                repair_id=repair_id,
                device_slug=slug,
                device_label=request.device_label,
                pipeline_started=True,
                pipeline_kind="full",
                queued=True,
                queue_position=pos,
            )

        logger.info(
            "[API] /pipeline/repairs · firing full pipeline for slug=%r · focus_symptom=yes",
            slug,
        )
        # 【关键连接点】先 fire-and-forget 后台 task，再 return HTTP。
        # task 内 emit → publish(slug)；前端拿到 slug 后连 progress WS → subscribe(slug)。
        _register_build(slug, asyncio.create_task(_launch()))
        return RepairResponse(
            repair_id=repair_id,
            device_slug=slug,       # 前端用此 slug 连接 WS /pipeline/progress/{slug}
            device_label=request.device_label,
            pipeline_started=True,  # 前端开关：true → subscribeToProgress / connectProgress
            pipeline_kind="full",
        )

    # -----------------------------------------------------------------------
    # 以下仅当 pack_complete=True 且未走 Branch 1 时到达。
    # 有 pack：不再构建，用 Haiku 检查「当前症状是否已被 rules.json 覆盖」。
    # -----------------------------------------------------------------------
    coverage = await _pkg._maybe_check_coverage(slug, request.symptom, memory_root)

    # -----------------------------------------------------------------------
    # Branch 2 — 有 pack，且症状已被现有 rule 覆盖（confidence ≥ 0.7）
    # -----------------------------------------------------------------------
    # 干什么：什么都不构建，直接打开 repair；agent 可走已知诊断流程。
    # 前端：pipeline_started=false → 不连 progress WS，立刻 goToWorkspace。
    # 响应：matched_rule_id 供 UI 展示「命中规则 XXX」。
    if (
        coverage.covered
        and coverage.confidence >= 0.7
        and coverage.matched_rule_id is not None
    ):
        logger.info(
            "[API] /pipeline/repairs · symptom covered by %s (confidence=%.2f) — no LLM run",
            coverage.matched_rule_id,
            coverage.confidence,
        )
        return RepairResponse(
            repair_id=repair_id,
            device_slug=slug,
            device_label=request.device_label,
            pipeline_started=False,  # Branch 2：pack 已有，症状命中 rule，直接诊断
            pipeline_kind="none",
            matched_rule_id=coverage.matched_rule_id,
            coverage_reason=coverage.reason,
        )

    # -----------------------------------------------------------------------
    # Branch 3 — 有 pack，但症状未被任何 rule 覆盖
    # -----------------------------------------------------------------------
    # 干什么：同样不自动跑 pipeline / expand；直接打开 repair 会话。
    # agent 先用现有 pack（图谱 + 电气图 + 已有 rules）做诊断；
    # 若知识不够，由 agent 在对话中提议 mb_expand_knowledge（需技师确认，且受套餐限制）。
    # 前端：pipeline_started=false → 不连 progress WS，立刻 goToWorkspace。
    # 注意：不再在 create_repair 时自动触发 expand（避免 agent 还没看就烧 $0.40）。
    logger.info(
        "[API] /pipeline/repairs · pack complete for slug=%r; symptom uncovered — "
        "opening repair, agent works the graph (expand is on-demand, plan-gated)",
        slug,
    )
    return RepairResponse(
        repair_id=repair_id,
        device_slug=slug,
        device_label=request.device_label,
        pipeline_started=False,  # Branch 3：pack 已有但症状新，直接诊断，不自动 expand
        pipeline_kind="none",
        coverage_reason=coverage.reason,
    )


@router.post("/repairs/{device_slug}/cancel")
async def cancel_repair(device_slug: str) -> dict:
    """Cooperatively cancel a running pipeline for this device slug.

    The pipeline runs as a background task whose only handle lives in this
    process (`_RUNNING`). We cancel that task and publish a terminal
    `pipeline_failed(CANCELLED)` so every progress subscriber (the cloud relay,
    the browser timeline) stops waiting. Idempotent: cancelling a slug with no
    running pipeline is a no-op, not an error — the cloud must not 500 on a
    stale cancel.

    Unauthenticated like the other HTTP pipeline endpoints — the cloud is the
    gatekeeper (only it can reach the engine once deployed).
    """
    slug = _slugify(device_slug)
    task = _RUNNING.get(slug)
    if task is None or task.done():
        logger.info("[API] /pipeline/repairs/%s/cancel · nothing running", slug)
        return {"cancelled": False, "device_slug": slug, "reason": "no running pipeline"}

    task.cancel()
    await events.publish(
        slug,
        {
            "type": "pipeline_failed",
            "status": "CANCELLED",
            "error": "analysis cancelled",
        },
    )
    logger.info("[API] /pipeline/repairs/%s/cancel · pipeline cancelled", slug)
    return {"cancelled": True, "device_slug": slug}
