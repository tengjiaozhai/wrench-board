"""从设备的磁盘知识包中为设备的 Managed-Agents 内存存储播种。

在批准判决后立即从管道编排器调用。这
该设备的诊断对话可以参考规范
知识（注册表、规则、字典、知识图）本地通过
内置内存工具，而不是在每个工具上从磁盘重新水化它
称呼。

`settings.ma_memory_store_enabled` 背后的功能门控。每个错误路径
降级为日志警告：管道绝不能失败，因为内存
播种失败。"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from anthropic import AsyncAnthropic

from api.agent.memory_stores import (
    ensure_memory_store,
    list_memory_paths_to_ids,
    upsert_memory,
)
from api.config import get_settings

logger = logging.getLogger("wrench_board.agent.memory_seed")

MARKER_FILENAME = "managed.json"

_DELTA_MEMORY_PATH = "/knowledge/board_delta.md"


def build_board_delta_block(
    *, memory_root: Path | str, device_slug: str, board_number: str | None
) -> str | None:
    """将棋盘增量渲染为种子上下文块，或者在不存在/为空时渲染为“无”。

    当未提供 board_number 时返回 None（独立/self-host），
    当存储的增量具有coverage='none'时，或者当所有列表为空时。
    返回的文本被注入到代理的内存存储中
    ``_DELTA_MEMORY_PATH`` 用于显示特定于修订版的上下文。"""
    if not board_number:
        return None
    # 延迟导入以避免循环导入： api.pipeline.__init__ 导入
    # Orchestrator，导入此模块。在模块顶部导入 read_delta
    # 在初始化 api.pipeline 之前导入 memory_seed 时会循环。
    from api.pipeline.board_delta.store import read_delta  # 编号：PLC0415

    delta = read_delta(
        memory_root=Path(memory_root),
        device_slug=device_slug,
        board_number=board_number,
    )
    if delta is None or delta.coverage == "none" or delta.is_empty():
        return None
    lines = [
        f"# Known specifics of board revision {delta.board_number} ({delta.device_label})",
        "Contextual knowledge from web sources. NOT validated refdes; confirm against the loaded board.",
    ]
    for ic in delta.signature_ics:
        lines.append(f"- IC: {ic.part or '?'} - {ic.role} ({ic.source_url})")
    for r in delta.notable_rails:
        lines.append(f"- Rail: {r.name} - {r.note}")
    for p in delta.repair_pitfalls:
        lines.append(f"- Pitfall: {p.title} - {p.detail}")
    return "\n".join(lines)


def read_seed_marker(pack_dir: Path) -> dict | None:
    """返回种子标记字典，如果丢失/损坏则返回 None。"""
    path = pack_dir / MARKER_FILENAME
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        logger.warning(
            "[MemorySeed] marker at %s unreadable — treating as missing", path,
        )
        return None


def write_seed_marker(
    *,
    pack_dir: Path,
    store_id: str,
    seeded_files: dict[str, float],
) -> None:
    """写下标记。 `seeded_files` 映射文件名 → mtime-at-seed-time。

    与任何现有的 `managed.json` 合并，因此 `memory_store_id` +
    `⟦PRESERVE0⟧` 由 `ensure_memory_store` 写入的密钥在重新种子后仍然存在
    — 否则后续的 `ensure_memory_store` 调用将重新创建
    存储并孤立第一个。"""
    pack_dir.mkdir(parents=True, exist_ok=True)
    path = pack_dir / MARKER_FILENAME
    existing: dict = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                existing = loaded
        except (json.JSONDecodeError, OSError):
            existing = {}
    existing.update({
        "seeded_at": datetime.now(UTC).isoformat(),
        "store_id": store_id,
        "files": seeded_files,
    })
    path.write_text(json.dumps(existing, indent=2), encoding="utf-8")


# 我们推送到存储中的文件以及它们所在的内存路径。路径方案
# `/knowledge/*` 为管道创建的内存保留； ⟦保留1⟧
# 用于诊断会话的写回（请参阅 record_field_report）。
#
# `⟦PRESERVE0⟧.json` 和 `nets_classified.json` 故意不
# 种子：两者都定期超过 MA 每内存上限（102_400 字节 —
# 真实主板的缩小电气图达到约 390 KiB）。他们是
# 而是通过 `mb_schematic_graph` 工具 (api/tools/schematic.py) 出现
# 它在服务器端读取它们并投影每个查询切片，因此代理
# 永远不需要其内存存储中的原始 blob。在这里重新添加它们会
# 恢复到我们在 2026 年 4 月 28 日看到的 400-on-every-WS-开放噪音。
_SEED_FILES = (
    ("registry.json", "/knowledge/registry.json"),
    ("knowledge_graph.json", "/knowledge/knowledge_graph.json"),
    ("rules.json", "/knowledge/rules.json"),
    ("dictionary.json", "/knowledge/dictionary.json"),
    ("boot_sequence_analyzed.json", "/knowledge/boot_sequence_analyzed.json"),
    ("simulator_reliability.json", "/knowledge/simulator_reliability.json"),
)


def stale_files_for_pack(pack_dir: Path) -> list[str]:
    """返回`_SEED_FILES`中需要重新播种的文件名。

    在以下情况下文件已过时：
      - 它存在于磁盘上并且
      - 标记丢失，或者标记的记录时间为
        该文件比当前磁盘上的 mtime 旧。

    磁盘中不存在的文件将被忽略（没有种子）。"""
    marker = read_seed_marker(pack_dir)
    marker_files = (marker or {}).get("files", {})

    stale: list[str] = []
    for file_name, _memory_path in _SEED_FILES:
        path = pack_dir / file_name
        if not path.exists():
            continue
        disk_mtime = path.stat().st_mtime
        recorded = marker_files.get(file_name)
        if recorded is None or disk_mtime > recorded:
            stale.append(file_name)
    return stale


async def seed_memory_store_from_pack(
    *,
    client: AsyncAnthropic,
    device_slug: str,
    pack_dir: Path,
    only_files: list[str] | None = None,
) -> dict[str, str]:
    """将包的 JSON 工件更新插入设备的内存存储中。

    当提供 `only_files` 时，仅那些文件名（与
    `_SEED_FILES`) 已处理 — 由自动种子路径用于重新推送
    只是自最后一个种子以来漂移的文件。

    返回映射`{memory_path: "seeded"|"skipped"|"error:<reason>"}`。
    全部或部分成功更新插入时，将在以下位置写入一个标记
    `pack_dir/managed.json` 与每个文件的读取次数。从不加注。"""
    settings = get_settings()
    targets = _SEED_FILES
    if only_files is not None:
        wanted = set(only_files)
        targets = tuple(t for t in _SEED_FILES if t[0] in wanted)

    status: dict[str, str] = {memory_path: "pending" for _file, memory_path in targets}

    if not settings.ma_memory_store_enabled:
        for path in status:
            status[path] = "skipped:flag_disabled"
        logger.debug(
            "[MemorySeed] ma_memory_store_enabled=False — no-op for slug=%s",
            device_slug,
        )
        return status

    store_id = await ensure_memory_store(client, device_slug)
    if store_id is None:
        for path in status:
            status[path] = "skipped:no_store"
        return status

    # 预先进行一次往返以了解现有的内存 ID
    # store，所以我们可以直接按id更新而不是往返
    # 通过创建→409→更新每个文件。额外请求成本为 O(1)
    # 但在重新播种时节省了 O(N × 3s SDK 重试)。
    known_ids = await list_memory_paths_to_ids(client, store_id=store_id)
    if known_ids:
        logger.info(
            "[MemorySeed] %d existing memories cached for store=%s — "
            "using direct-update path",
            len(known_ids),
            store_id,
        )

    seeded_mtimes: dict[str, float] = {}
    for file_name, memory_path in targets:
        on_disk = pack_dir / file_name
        if not on_disk.exists():
            status[memory_path] = "skipped:missing_file"
            logger.info(
                "[MemorySeed] Skip %s for slug=%s (no file on disk)",
                memory_path, device_slug,
            )
            continue
        mtime_before = on_disk.stat().st_mtime
        content = on_disk.read_text(encoding="utf-8")
        result = await upsert_memory(
            client,
            store_id=store_id,
            path=memory_path,
            content=content,
            memory_id=known_ids.get(memory_path),
        )
        if result is None:
            status[memory_path] = "error:upsert_failed"
            continue
        status[memory_path] = "seeded"
        seeded_mtimes[file_name] = mtime_before
        logger.info(
            "[MemorySeed] Seeded slug=%s path=%s bytes=%d",
            device_slug, memory_path, len(content),
        )

    # 刷新标记 - 与任何现有条目合并，以便部分
    # 重新种子不会删除我们未触及的文件的 mtimes。
    if seeded_mtimes:
        existing = read_seed_marker(pack_dir)
        merged = dict((existing or {}).get("files") or {})
        merged.update(seeded_mtimes)
        write_seed_marker(
            pack_dir=pack_dir,
            store_id=store_id,
            seeded_files=merged,
        )

    # 仅在完整种子上注入板修订增量（only_files 为 None）。
    # 部分/自动种子 (only_files=[...]) 不得添加此额外密钥：它们
    # 会产生不一致的状态字典形状并触发意外的
    # MA 在每个扩展后同步和自动种子调用上更新插入。
    if only_files is not None:
        return status

    # 在此处导入（而不是在模块顶部）以避免循环导入风险：board_ref
    # 是一个精简的 contextvars 模块，但是 memory_seed 是由
    # 运行时初始化链。
    from api.agent.board_ref import current_board_ref  # 编号：PLC0415

    memory_root = getattr(settings, "memory_root", None)
    delta_block = build_board_delta_block(
        memory_root=memory_root,
        device_slug=device_slug,
        board_number=current_board_ref(),
    ) if memory_root is not None else None
    if delta_block is not None:
        delta_result = await upsert_memory(
            client,
            store_id=store_id,
            path=_DELTA_MEMORY_PATH,
            content=delta_block,
            memory_id=known_ids.get(_DELTA_MEMORY_PATH),
        )
        if delta_result is None:
            logger.warning(
                "[MemorySeed] Failed to upsert board delta for slug=%s board_ref=%s",
                device_slug, current_board_ref(),
            )
        else:
            logger.info(
                "[MemorySeed] Seeded board delta for slug=%s board_ref=%s bytes=%d",
                device_slug, current_board_ref(), len(delta_block),
            )
        status[_DELTA_MEMORY_PATH] = "seeded" if delta_result is not None else "error:upsert_failed"

    return status
