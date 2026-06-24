"""Per-device memory store cache for Managed Agents sessions.

Memory stores are gated by the `anthropic-beta: managed-agents-2026-04-01`
header. The first session for a given device slug creates a store via the
API and persists its id in `memory/{slug}/managed.json`. Subsequent
sessions reuse it so the agent retains learnings across repairs without
re-seeding.

Dual path — SDK first, raw HTTP fallback:
  - When `client.beta.memory_stores` is exposed by the SDK, we call it
    directly (typed, nicer errors).
  - Otherwise we POST/GET the REST endpoints. The code auto-promotes to
    the SDK path once the typed surface ships, no migration required.

All failures (missing key, network, API rejection) degrade to a WARNING
log + `None`/empty return — the diagnostic session runs without memory
rather than crashing."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import httpx
from anthropic import AsyncAnthropic

from api.config import get_settings

logger = logging.getLogger("wrench_board.agent.memory_stores")

_BETA_HEADER = "managed-agents-2026-04-01"
_API_BASE = "https://api.anthropic.com/v1"


def _store_description(device_slug: str) -> str:
    return (
        f"Repair history and learned facts for device {device_slug}. "
        "Contains previous diagnostic sessions, confirmed component "
        "failures, and patterns observed across multiple repairs. "
        "Knowledge pack artefacts are pre-seeded under /knowledge/*; "
        "field reports from past repairs land under /field_reports/*."
    )


def _http_headers(api_key: str, *, content_json: bool = False) -> dict[str, str]:
    hdrs = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": _BETA_HEADER,
    }
    if content_json:
        hdrs["content-type"] = "application/json"
    return hdrs


def _http_timeout() -> float:
    """原始内存存储 REST 回退的每个请求超时。

    在调用时（不是模块导入时）从设置中提取，因此进行测试
    即使在该模块启动后，`get_settings`的monkeypatches也会生效
    已由另一个装置导入。"""
    return get_settings().ma_memory_store_http_timeout_seconds


async def _create_store_via_http(
    *, api_key: str, name: str, description: str
) -> str | None:
    try:
        async with httpx.AsyncClient(timeout=_http_timeout()) as http:
            resp = await http.post(
                f"{_API_BASE}/memory_stores",
                headers=_http_headers(api_key, content_json=True),
                json={"name": name, "description": description},
            )
    except Exception as exc:  # 编号：BLE001
        logger.warning("[MemoryStore] HTTP create raised: %s", exc)
        return None
    if resp.status_code != 200:
        logger.warning(
            "[MemoryStore] HTTP create returned %d: %s",
            resp.status_code,
            resp.text[:300],
        )
        return None
    try:
        return resp.json().get("id")
    except ValueError:
        return None


async def _delete_store_via_http(*, api_key: str, store_id: str) -> bool:
    """删除内存存储。 200/204 时返回 True，否则返回 False。

    将 404 视为成功 - 已经消失的商店才是理想的结局
    状态。任何其他错误都会记录警告并返回 False，以便调用者
    仍然可以继续进行磁盘清理。"""
    try:
        async with httpx.AsyncClient(timeout=_http_timeout()) as http:
            resp = await http.delete(
                f"{_API_BASE}/memory_stores/{store_id}",
                headers=_http_headers(api_key),
            )
    except Exception as exc:  # 编号：BLE001
        logger.warning(
            "[MemoryStore] HTTP delete raised for store=%s: %s", store_id, exc
        )
        return False
    if resp.status_code in (200, 204, 404):
        return True
    logger.warning(
        "[MemoryStore] HTTP delete returned %d for store=%s: %s",
        resp.status_code,
        store_id,
        resp.text[:300],
    )
    return False


async def _update_memory_via_http(
    *, api_key: str, store_id: str, memory_id: str, content: str
) -> str | None:
    """POST an update to an existing memory by id. Returns content_sha256 on success.

    Note: the public Managed Agents API docs list this as PATCH, but the
    live endpoint only accepts POST (verified 2026-04-26 — PATCH/PUT both
    return 405 Method Not Allowed). The shape stays
    `{"content": "..."}` either way."""
    try:
        async with httpx.AsyncClient(timeout=_http_timeout()) as http:
            resp = await http.post(
                f"{_API_BASE}/memory_stores/{store_id}/memories/{memory_id}",
                headers=_http_headers(api_key, content_json=True),
                json={"content": content},
            )
    except Exception as exc:  # 编号：BLE001
        logger.warning(
            "[MemoryStore] HTTP update raised for memory_id=%s: %s",
            memory_id,
            exc,
        )
        return None
    if resp.status_code != 200:
        logger.warning(
            "[MemoryStore] HTTP update returned %d for memory_id=%s: %s",
            resp.status_code,
            memory_id,
            resp.text[:300],
        )
        return None
    try:
        return resp.json().get("content_sha256") or "ok"
    except ValueError:
        return "ok"


async def _upsert_memory_via_http(
    *, api_key: str, store_id: str, path: str, content: str
) -> str | None:
    """真正的 upsert：尝试创建，在 409 路径冲突上回退到更新。

    Anthropic 内存 API 通过 `mem_...` id 对内存进行寻址
    突变并在创建时返回 `409 memory_path_conflict_error`
    尝试一条已经有记忆的路径。这个助手提取
    错误正文中的 `conflicting_memory_id` 和补丁
    相反，内存，为调用者提供真正的更新插入语义。"""
    try:
        async with httpx.AsyncClient(timeout=_http_timeout()) as http:
            resp = await http.post(
                f"{_API_BASE}/memory_stores/{store_id}/memories",
                headers=_http_headers(api_key, content_json=True),
                json={"path": path, "content": content},
            )
    except Exception as exc:  # 编号：BLE001
        logger.warning(
            "[MemoryStore] HTTP upsert raised for path=%s: %s", path, exc
        )
        return None
    if resp.status_code == 200:
        try:
            return resp.json().get("content_sha256") or "ok"
        except ValueError:
            return "ok"

    # 409 路径冲突 → 切换到冲突内存 id 上的 PATCH。
    if resp.status_code == 409:
        try:
            body = resp.json()
            err = body.get("error", {}) if isinstance(body, dict) else {}
            if err.get("type") == "memory_path_conflict_error":
                memory_id = err.get("conflicting_memory_id")
                if memory_id:
                    return await _update_memory_via_http(
                        api_key=api_key,
                        store_id=store_id,
                        memory_id=memory_id,
                        content=content,
                    )
        except (ValueError, KeyError):
            pass

    logger.warning(
        "[MemoryStore] HTTP upsert returned %d for path=%s: %s",
        resp.status_code,
        path,
        resp.text[:300],
    )
    return None


async def ensure_memory_store(
    client: AsyncAnthropic, device_slug: str
) -> str | None:
    """返回此设备的 `memstore_...` id，在第一次调用时创建一个。

    该 id 缓存在 `memory/{⟦PRESERVE0⟧}/managed.json` 中，因此后续调用
    同一设备重复使用它（无网络往返，无重复存储）。"""
    settings = get_settings()
    pack_dir = Path(settings.memory_root) / device_slug
    pack_dir.mkdir(parents=True, exist_ok=True)
    meta_path = pack_dir / "managed.json"

    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
        except json.JSONDecodeError:
            meta = {}
        store_id = meta.get("memory_store_id")
        if store_id:
            return store_id

    name = f"wrench-board-{device_slug}"
    description = _store_description(device_slug)
    store_id: str | None = None

    sdk_beta = getattr(client, "beta", None)
    sdk_surface = getattr(sdk_beta, "memory_stores", None) if sdk_beta else None
    if sdk_surface is not None:
        try:
            store = await sdk_surface.create(name=name, description=description)
            store_id = getattr(store, "id", None)
        except Exception as exc:  # 编号：BLE001
            logger.warning(
                "[MemoryStore] SDK create failed for device=%s: %s — "
                "falling back to HTTP",
                device_slug,
                exc,
            )
            store_id = None

    if store_id is None:
        if not settings.anthropic_api_key:
            logger.warning(
                "[MemoryStore] no API key; running device=%s without memory",
                device_slug,
            )
            return None
        store_id = await _create_store_via_http(
            api_key=settings.anthropic_api_key,
            name=name,
            description=description,
        )

    if not store_id:
        return None

    meta_path.write_text(
        json.dumps(
            {"memory_store_id": store_id, "device_slug": device_slug},
            indent=2,
        )
        + "\n"
    )
    logger.info("[MemoryStore] Created id=%s for device=%s", store_id, device_slug)
    return store_id


GLOBAL_REGISTRY_DIR = "_managed"
GLOBAL_REGISTRY_FILE = "global.json"

# 全局单例注册表允许的类型。每个映射到一个
# 每个工作区最多创建一次商店； id 被缓存在本地所以
# 后续会话重用它。看
# 文档/superpowers/plans/2026-04-26-ma-memory-layered-architecture.md
# 用于分层 MA 内存架构（每个会话 4 个存储）。
_GLOBAL_KINDS = {"patterns", "playbooks"}


def _global_registry_path() -> Path:
    settings = get_settings()
    root = Path(settings.memory_root) / GLOBAL_REGISTRY_DIR
    root.mkdir(parents=True, exist_ok=True)
    return root / GLOBAL_REGISTRY_FILE


def _read_global_registry() -> dict:
    path = _global_registry_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        logger.warning("[MemoryStore] global registry at %s unreadable", path)
        return {}


def _write_global_registry(data: dict) -> None:
    path = _global_registry_path()
    path.write_text(
        json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


async def ensure_global_store(
    client: AsyncAnthropic,
    *,
    kind: str,
    description: str,
) -> str | None:
    """Return the singleton memstore id for `kind` ∈ {patterns, playbooks}.

    Created on first call, cached in `memory/_managed/global.json` for
    re-use across all sessions and devices. The store hosts cross-device
    knowledge (failure taxonomy, diagnostic playbook templates) attached
    read-only to every diagnostic session."""
    if kind not in _GLOBAL_KINDS:
        raise ValueError(f"Unknown global store kind: {kind!r}")

    registry = _read_global_registry()
    cached = registry.get(kind, {})
    cached_id = cached.get("memory_store_id")
    if cached_id:
        return cached_id

    name = f"wrench-board-global-{kind}"
    store_id: str | None = None

    sdk_beta = getattr(client, "beta", None)
    sdk_surface = (
        getattr(sdk_beta, "memory_stores", None) if sdk_beta else None
    )
    if sdk_surface is not None:
        try:
            store = await sdk_surface.create(name=name, description=description)
            store_id = getattr(store, "id", None)
        except Exception as exc:  # 编号：BLE001
            logger.warning(
                "[MemoryStore] SDK create failed for global %s: %s — "
                "falling back to HTTP",
                kind,
                exc,
            )

    if store_id is None:
        settings = get_settings()
        if not settings.anthropic_api_key:
            logger.warning(
                "[MemoryStore] no API key; running without global %s store",
                kind,
            )
            return None
        store_id = await _create_store_via_http(
            api_key=settings.anthropic_api_key,
            name=name,
            description=description,
        )

    if not store_id:
        return None

    registry[kind] = {
        "memory_store_id": store_id,
        "name": name,
        "description": description,
    }
    _write_global_registry(registry)
    logger.info(
        "[MemoryStore] Created global %s store id=%s", kind, store_id
    )
    return store_id


def _repair_marker_path(device_slug: str, repair_id: str) -> Path:
    settings = get_settings()
    return (
        Path(settings.memory_root)
        / device_slug
        / "repairs"
        / repair_id
        / "managed.json"
    )


def _repair_store_description(device_slug: str, repair_id: str) -> str:
    return (
        f"Scratch notebook for repair {repair_id} on device {device_slug}. "
        "Read-write scribe layer for the agent's own working notes across "
        "sessions of THIS specific repair: state.md (latest snapshot), "
        "decisions/{ts}.md (validated/refuted hypotheses), "
        "measurements/{rail}.md (time series of probed values), "
        "open_questions.md (unresolved threads to revisit)."
    )


async def ensure_repair_store(
    client: AsyncAnthropic,
    *,
    device_slug: str,
    repair_id: str,
) -> str | None:
    """Return the per-repair RW memstore id, creating one on first session.

    Persisted at `memory/{slug}/repairs/{repair_id}/managed.json`. Backbone
    of the "agent-as-its-own-librarian" pattern that replaces the LLM-driven
    session resume summary."""
    marker = _repair_marker_path(device_slug, repair_id)
    marker.parent.mkdir(parents=True, exist_ok=True)

    if marker.exists():
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
            existing = data.get("memory_store_id")
            if existing:
                return existing
        except (json.JSONDecodeError, OSError):
            logger.warning(
                "[MemoryStore] repair marker %s unreadable", marker
            )

    name = f"wrench-board-repair-{device_slug}-{repair_id}"
    description = _repair_store_description(device_slug, repair_id)
    store_id: str | None = None

    sdk_beta = getattr(client, "beta", None)
    sdk_surface = (
        getattr(sdk_beta, "memory_stores", None) if sdk_beta else None
    )
    if sdk_surface is not None:
        try:
            store = await sdk_surface.create(name=name, description=description)
            store_id = getattr(store, "id", None)
        except Exception as exc:  # 编号：BLE001
            logger.warning(
                "[MemoryStore] SDK create failed for repair=%s: %s — "
                "falling back to HTTP",
                repair_id,
                exc,
            )

    if store_id is None:
        settings = get_settings()
        if not settings.anthropic_api_key:
            logger.warning(
                "[MemoryStore] no API key; running repair=%s/%s without scribe store",
                device_slug,
                repair_id,
            )
            return None
        store_id = await _create_store_via_http(
            api_key=settings.anthropic_api_key,
            name=name,
            description=description,
        )

    if not store_id:
        return None

    marker.write_text(
        json.dumps(
            {
                "memory_store_id": store_id,
                "device_slug": device_slug,
                "repair_id": repair_id,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    logger.info(
        "[MemoryStore] Created repair store id=%s for %s/%s",
        store_id,
        device_slug,
        repair_id,
    )
    return store_id


async def list_memory_paths_to_ids(
    client: AsyncAnthropic,
    *,
    store_id: str,
) -> dict[str, str]:
    """Return `{memory_path: memory_id}` for all memories in `store_id`.

    Used by callers that already know which paths exist and want to skip
    the create→409→update dance that `upsert_memory` would otherwise do
    every time. One round-trip up front saves three (SDK retries × 3 + the
    eventual update) per existing memory on subsequent upserts.

    Returns `{}` on any failure."""
    settings = get_settings()
    if not settings.anthropic_api_key:
        return {}
    out: dict[str, str] = {}
    try:
        async with httpx.AsyncClient(timeout=_http_timeout()) as http:
            # `limit` 服务器上限为 100（已于 2026 年 4 月 26 日实时验证 —
            # `limit=1000` 返回`400 invalid_request_error`）。我们的
            # 知识库包含 ≤10 个叶文件以及现场报告
            # 子树，因此 limit=100 的一页涵盖了实际情况。
            # 如果租户推送超过 100 个条目，我们应该添加光标
            # 此处分页。
            resp = await http.get(
                f"{_API_BASE}/memory_stores/{store_id}/memories",
                headers=_http_headers(settings.anthropic_api_key),
                params={"limit": 100, "view": "basic"},
            )
    except Exception as exc:  # 编号：BLE001
        logger.warning(
            "[MemoryStore] HTTP list raised for store=%s: %s", store_id, exc
        )
        return {}
    if resp.status_code != 200:
        logger.warning(
            "[MemoryStore] HTTP list returned %d for store=%s: %s",
            resp.status_code,
            store_id,
            resp.text[:300],
        )
        return {}
    try:
        body = resp.json()
        items = body.get("data", []) if isinstance(body, dict) else []
        for item in items:
            if not isinstance(item, dict):
                continue
            # 列表端点混合了“内存”（全叶）和
            # “memory_prefix”（类似目录）条目。只有前者
            # 有一个 ID，我们可以获取更新信息。
            if item.get("type") != "memory":
                continue
            mid = item.get("id")
            mpath = item.get("path")
            if isinstance(mid, str) and isinstance(mpath, str):
                out[mpath] = mid
    except (ValueError, KeyError) as exc:
        logger.warning(
            "[MemoryStore] HTTP list body parse failed for store=%s: %s",
            store_id,
            exc,
        )
        return {}
    return out


async def upsert_memory(
    client: AsyncAnthropic,
    *,
    store_id: str,
    path: str,
    content: str,
    memory_id: str | None = None,
) -> str | None:
    """Upsert a memory by path into `store_id`, returning its `content_sha256`.

    `path` is the logical address (e.g. `/knowledge/rules.json`) — the
    server creates on first write and replaces content thereafter. See
    `docs/en/managed-agents/memory` for the contract. Returns `None` on
    failure so callers can track per-memory status without raising.

    When `memory_id` is supplied (typically from `list_memory_paths_to_ids`),
    we skip straight to the update endpoint instead of doing a path-based
    create that the server will reject with 409 + auto-fallback to update.
    Saves ~3s per known memory by avoiding the SDK's naïve retry loop on
    the conflict."""
    settings = get_settings()
    if memory_id and settings.anthropic_api_key:
        # 快速路径 — 一次往返更新，无创建尝试，无 409。
        sha = await _update_memory_via_http(
            api_key=settings.anthropic_api_key,
            store_id=store_id,
            memory_id=memory_id,
            content=content,
        )
        if sha is not None:
            return sha
        # If the direct update failed (memory deleted, store rotated,
        # 等），进入完整的更新插入路径，以便我们可以恢复。

    sdk_beta = getattr(client, "beta", None)
    sdk_stores = getattr(sdk_beta, "memory_stores", None) if sdk_beta else None
    sdk_surface = getattr(sdk_stores, "memories", None) if sdk_stores else None
    if sdk_surface is not None:
        # 更喜欢 `write` （公开测试版名称）。 `create` 出于礼貌而保留
        # 对于较旧的 SDK 版本，可能仍会公开研究预览
        # 拼写。
        call = getattr(sdk_surface, "write", None) or getattr(
            sdk_surface, "create", None
        )
        if call is not None:
            try:
                result = await call(
                    memory_store_id=store_id,
                    path=path,
                    content=content,
                )
                return getattr(result, "content_sha256", None) or "ok"
            except Exception as exc:  # 编号：BLE001
                logger.warning(
                    "[MemoryStore] SDK upsert failed for store=%s path=%s: %s — "
                    "falling back to HTTP",
                    store_id,
                    path,
                    exc,
                )

    if not settings.anthropic_api_key:
        return None
    return await _upsert_memory_via_http(
        api_key=settings.anthropic_api_key,
        store_id=store_id,
        path=path,
        content=content,
    )


async def delete_repair_store(
    client: AsyncAnthropic,
    *,
    device_slug: str,
    repair_id: str,
) -> bool:
    """删除每次修复的 MA 内存存储（如果有）。

    读取 `memory/{⟦PRESERVE2⟧}/repairs/{⟦PRESERVE0⟧}/managed.json` 来查找
    `memory_store_id`，然后通过SDK或HTTP删除商店。返回真
    当商店消失时（现在已删除，或已经不存在/没有标记 -
    没有什么需要清洁的）。错误被吞掉并记录下来，以便磁盘清理可以
    仍然在调用者中继续。"""
    marker = _repair_marker_path(device_slug, repair_id)
    if not marker.exists():
        return True

    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning(
            "[MemoryStore] repair marker %s unreadable on delete: %s — "
            "skipping MA cleanup",
            marker,
            exc,
        )
        return True

    store_id = data.get("memory_store_id")
    if not store_id:
        return True

    sdk_beta = getattr(client, "beta", None)
    sdk_surface = (
        getattr(sdk_beta, "memory_stores", None) if sdk_beta else None
    )
    if sdk_surface is not None:
        try:
            await sdk_surface.delete(store_id)
            return True
        except Exception as exc:  # 编号：BLE001
            logger.warning(
                "[MemoryStore] SDK delete failed for repair=%s store=%s: %s — "
                "falling back to HTTP",
                repair_id,
                store_id,
                exc,
            )

    settings = get_settings()
    if not settings.anthropic_api_key:
        logger.warning(
            "[MemoryStore] no API key; cannot delete MA store %s for repair=%s",
            store_id,
            repair_id,
        )
        return False
    return await _delete_store_via_http(
        api_key=settings.anthropic_api_key, store_id=store_id
    )
