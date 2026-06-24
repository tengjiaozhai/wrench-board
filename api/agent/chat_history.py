"""诊断会话的每次修复聊天历史记录持久性。

每个repair_id都拥有一组*对话*
⟦保留6⟧。每一个
对话拥有自己的`messages.jsonl`（每个对话有一个`{ts, event}`记录）
线，Anthropic消息API形状），并且对于托管代理运行时，其
自己的`ma_session_{tier}.json`会话指针。兄弟姐妹`index.json`列出
对话按时间顺序与轻量级元数据（层级、标题、
前端切换器的匝数、成本）。

旧版修复早于对话并将平面文件存储在
⟦保留11⟧。第一次致电
`ensure_conversation(conv_id=None, …)` 对于此类修复会迁移文件
进入新的对话目录并写入新的`index.json`。

后端带有功能标记（设置中的`chat_history_backend`）：

- **jsonl（默认）** — 仅附加本地文件。今天可以工作，没有任何
  Anthropic 功能门，重启后仍然存在，可 grep / git-diffable
  用于调试。
- ** Managed_agents （未来） ** — 当 MA 会议研究预览落地时，
  每个会话都会映射到一个持久的MA session_id；重播将是
  由 MA 运行时本地处理。该模块成为no-op，因为
  模式 — 后端将查询 MA 的历史记录。

与field_reports模块相同的设计模式：JSON-first，MA作为镜像
当访问着陆时。翻转时零迁移。

为 UI 消耗保留两个信号：

- **messages.jsonl** 带有 Anthropic 形状的踪迹（user.content，
  Assistant.content、tool_use、tool_result 块）。
- **status.json** 跟踪修复的生命周期 - 创建时的 `open`，
  第一次交换时`in_progress`，技术人员发出信号时`closed`
  完成（按钮或代理确认）。由下面的`touch_status`更新。"""

from __future__ import annotations

import json
import logging
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from api.config import get_settings

logger = logging.getLogger("wrench_board.agent.chat_history")


def _repair_dir(memory_root: Path, device_slug: str, repair_id: str) -> Path:
    return memory_root / device_slug / "repairs" / repair_id


def _conv_root(memory_root: Path, device_slug: str, repair_id: str) -> Path:
    return _repair_dir(memory_root, device_slug, repair_id) / "conversations"


def _conv_index_file(memory_root: Path, device_slug: str, repair_id: str) -> Path:
    return _conv_root(memory_root, device_slug, repair_id) / "index.json"


def _conv_dir(
    memory_root: Path, device_slug: str, repair_id: str, conv_id: str
) -> Path:
    return _conv_root(memory_root, device_slug, repair_id) / conv_id


def _history_file(
    memory_root: Path, device_slug: str, repair_id: str, conv_id: str
) -> Path:
    return _conv_dir(memory_root, device_slug, repair_id, conv_id) / "messages.jsonl"


def _legacy_history_file(
    memory_root: Path, device_slug: str, repair_id: str
) -> Path:
    """预对话平面文件路径 - 仅用于迁移。"""
    return _repair_dir(memory_root, device_slug, repair_id) / "messages.jsonl"


def _ma_session_file(
    memory_root: Path,
    device_slug: str,
    repair_id: str,
    conv_id: str,
    tier: str,
) -> Path:
    return (
        _conv_dir(memory_root, device_slug, repair_id, conv_id)
        / f"ma_session_{tier}.json"
    )


def _metadata_file(memory_root: Path, device_slug: str, repair_id: str) -> Path:
    # 预先存在的元数据位于上一级：memory/{slug}/repairs/{id}.json
    return memory_root / device_slug / "repairs" / f"{repair_id}.json"


def _read_index(
    memory_root: Path, device_slug: str, repair_id: str
) -> list[dict[str, Any]]:
    path = _conv_index_file(memory_root, device_slug, repair_id)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        logger.warning(
            "corrupt conversations/index.json at %s; treating as empty", path
        )
        return []


def _write_index(
    memory_root: Path,
    device_slug: str,
    repair_id: str,
    index: list[dict[str, Any]],
) -> None:
    path = _conv_index_file(memory_root, device_slug, repair_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index, indent=2), encoding="utf-8")


def append_event(
    *,
    device_slug: str,
    repair_id: str | None,
    conv_id: str,
    event: dict[str, Any],
    cost: dict[str, Any] | None = None,
    memory_root: Path | None = None,
) -> None:
    """将一个 Anthropic 格式的消息事件附加到对话的 JSONL。

    可选的`cost`将每回合代币成本与助手一起附加
    事件，以便对话的生命周期花费继续存在WS关闭/重新打开。这
    记录形状是 `{ts, event, cost?}` — `cost` 仅出现在
    记录（不在`event`内），因此Anthropic面向`messages`列表保持不变
    当 load_events 读回它时清理它。

    当 `⟦PRESERVE2⟧` 丢失（匿名会话）时，静默无操作，当
    `event` 为假，或者当功能标志设置为非 jsonl 后端时。
    这里的错误决不能导致诊断会话中断——持久性是
    best-effort."""
    if not repair_id or not event:
        return
    settings = get_settings()
    if settings.chat_history_backend != "jsonl":
        return
    memory_root = memory_root or Path(settings.memory_root)
    path = _history_file(memory_root, device_slug, repair_id, conv_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        record: dict[str, Any] = {
            "ts": datetime.now(UTC).isoformat(),
            "event": event,
        }
        if cost is not None:
            record["cost"] = cost
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except OSError as exc:
        logger.warning(
            "[ChatHistory] append_event failed for repair=%s conv=%s: %s",
            repair_id,
            conv_id,
            exc,
        )


def load_events(
    *,
    device_slug: str,
    repair_id: str | None,
    conv_id: str,
    memory_root: Path | None = None,
) -> list[dict[str, Any]]:
    """按写入顺序返回 Anthropic 格式事件的列表。"""
    return [event for event, _cost in load_events_with_costs(
        device_slug=device_slug, repair_id=repair_id, conv_id=conv_id,
        memory_root=memory_root,
    )]


def load_events_with_costs(
    *,
    device_slug: str,
    repair_id: str | None,
    conv_id: str,
    memory_root: Path | None = None,
) -> list[tuple[dict[str, Any], dict[str, Any] | None]]:
    """与 load_events 类似，但也返回每个记录的附加成本。

    由重放路径使用，因此turn_cost芯片+运行总计累加器
    可以在重新打开时进行视觉重建，与技术人员实时看到的内容相匹配。"""
    if not repair_id:
        return []
    settings = get_settings()
    if settings.chat_history_backend != "jsonl":
        return []
    memory_root = memory_root or Path(settings.memory_root)
    path = _history_file(memory_root, device_slug, repair_id, conv_id)
    if not path.exists():
        return []

    records: list[tuple[dict[str, Any], dict[str, Any] | None]] = []
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    logger.warning(
                        "[ChatHistory] skipping malformed line in %s", path
                    )
                    continue
                event = rec.get("event")
                if not isinstance(event, dict):
                    continue
                cost = rec.get("cost") if isinstance(rec.get("cost"), dict) else None
                records.append((event, cost))
    except OSError as exc:
        logger.warning(
            "[ChatHistory] load_events failed for repair=%s conv=%s: %s",
            repair_id,
            conv_id,
            exc,
        )
    return records


def save_ma_session_id(
    *,
    device_slug: str,
    repair_id: str | None,
    conv_id: str,
    session_id: str,
    tier: str,
    memory_root: Path | None = None,
) -> None:
    """保留此对话和层组合的 MA session_id。

    每个层（快速/正常/深度）都有自己的 MA 代理，因此其
    自己的session_id。在转换级别存储单个 ma_session_id
    会混淆层交换机（在正常网络上恢复快速会话）
    代理等）。每个（转换，层）文件使它们保持隔离。

    对任何错误保持沉默 no-op。"""
    if not repair_id or not session_id or not tier or not conv_id:
        return
    settings = get_settings()
    memory_root = memory_root or Path(settings.memory_root)
    path = _ma_session_file(memory_root, device_slug, repair_id, conv_id, tier)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "session_id": session_id,
            "tier": tier,
            "linked_at": datetime.now(UTC).isoformat(),
        }
        path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        logger.warning(
            "[ChatHistory] save_ma_session_id failed for repair=%s conv=%s tier=%s: %s",
            repair_id,
            conv_id,
            tier,
            exc,
        )


def load_ma_session_id(
    *,
    device_slug: str,
    repair_id: str | None,
    conv_id: str,
    tier: str,
    memory_root: Path | None = None,
) -> str | None:
    """返回 (conv, tier) 对的持久 MA session_id，或无。"""
    if not tier or not repair_id or not conv_id:
        return None
    settings = get_settings()
    memory_root = memory_root or Path(settings.memory_root)
    path = _ma_session_file(memory_root, device_slug, repair_id, conv_id, tier)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "[ChatHistory] load_ma_session_id failed for repair=%s conv=%s tier=%s: %s",
            repair_id,
            conv_id,
            tier,
            exc,
        )
        return None
    sid = payload.get("session_id") if isinstance(payload, dict) else None
    return sid if isinstance(sid, str) and sid else None


def load_repair_metadata(
    *,
    device_slug: str,
    repair_id: str | None,
    memory_root: Path | None = None,
) -> dict[str, Any] | None:
    """返回 memory/{slug}/repairs/{repair_id}.json 的 JSON 负载，或 None。"""
    if not repair_id:
        return None
    settings = get_settings()
    memory_root = memory_root or Path(settings.memory_root)
    path = _metadata_file(memory_root, device_slug, repair_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "[ChatHistory] load_repair_metadata failed for repair=%s: %s",
            repair_id,
            exc,
        )
        return None


def build_session_intro(
    *,
    device_slug: str,
    repair_id: str | None,
    memory_root: Path | None = None,
) -> str | None:
    """Compose the hidden bootstrap message the agent sees on session open.

    Carries the device identity and the client's reported symptom so the
    agent can immediately consult its mounts (grep field_reports/, lookup
    matching playbooks) and query mb_get_rules_for_symptoms without asking
    "which device are you on?". Returns None when there's nothing to tell
    (no repair_id given)."""
    if not repair_id:
        return None
    meta = load_repair_metadata(
        device_slug=device_slug, repair_id=repair_id, memory_root=memory_root
    )
    if not meta:
        # 即使修复文件消失了，仍然值得安装设备slug。
        return f"[New diagnostic session · device_slug: {device_slug}]"
    label = meta.get("device_label") or device_slug
    symptom = (meta.get("symptom") or "").strip()
    lines = [
        "[New diagnostic session]",
        f"Device: {label} (slug: {device_slug})",
    ]
    if symptom:
        lines.append(f"Symptom reported by the technician: {symptom}")
    lines.append(
        f"Start by grep'ing /mnt/memory/wrench-board-{device_slug}/field_reports/ "
        "to see past repairs, then mb_get_rules_for_symptoms for the "
        "applicable rules."
    )
    return "\n".join(lines)


CTX_TAG_PREFIX = "[ctx ·"


def build_ctx_tag(
    *,
    device_slug: str,
    repair_id: str | None,
    memory_root: Path | None = None,
) -> str | None:
    """在每个用户回合之前编写一个单行上下文标签。

    较小的模型（尤其是Haiku）无法可靠地扫描整个会话
    当收到新鲜简洁的信息时，他们将“致敬”视为历史
    与上下文无关的问候并忘记设备+所携带的症状
    第 1 回合的 bootstrap 介绍。在每个回合中将两者重申为稳定的前缀
    用户消息将该上下文保持在前台约 25 个令牌/回合，
    这也是第一回合后稳定的缓存命中。

    措辞故意是**被动**——`initial_complaint`，而不是
    `symptom`，带引号的值使标签可见
    自我界定。系统提示指示坐席处理
    该标签作为摄入表元数据，从来不作为新症状
    应该重新触发 `mb_get_rules_for_symptoms` / 的声明
    `⟦PRESERVE0⟧` 在恢复的会话上。

    当没有给出 repair_id 时返回 None （匿名会话不
    有一个已知的初始投诉需要重述）。"""
    if not repair_id:
        return None
    meta = load_repair_metadata(
        device_slug=device_slug, repair_id=repair_id, memory_root=memory_root
    )
    label = (meta or {}).get("device_label") or device_slug
    symptom = ((meta or {}).get("symptom") or "").strip()
    if symptom:
        return f'{CTX_TAG_PREFIX} device={label} ({device_slug}) · initial_complaint="{symptom}"]'
    return f"{CTX_TAG_PREFIX} device={label} ({device_slug})]"


def build_board_refresh_note(board: Any, source: Path | None = None) -> str:
    """会话中出现或更改的boardview的一行状态注释。

    在两个运行时中，板都是在WS打开时拍摄的快照； ⟦保留0⟧
    之后导入的内容由`refresh_board_if_changed()`重新加载，但是
    代理人——在会议开始时被告知“没有董事会”——没有理由打电话给董事会
    `bv_*` 工具并发现它。这条线路会在下一个用户转向时行驶
    缩小这个差距。

    以 CTX_TAG_PREFIX 开头，因此重播路径的 `strip_ctx_tag` 会删除它
    从聊天面板与每回合 ctx 标签完全相同：单独匹配
    前缀；堆叠在 ctx 标签下（它们之间有一个换行符，空白
    行后）这两个形成一个前导块，将其全部删除。"""
    name = source.name if source is not None else getattr(board, "board_id", "?")
    n_parts = len(getattr(board, "parts", []) or [])
    n_nets = len(getattr(board, "nets", []) or [])
    return (
        f'{CTX_TAG_PREFIX} board_status: boardview "{name}" was just loaded '
        f"({n_parts} parts, {n_nets} nets); the bv_* boardview tools are now "
        "operational on it]"
    )


def strip_ctx_tag(text: str) -> str:
    """从 `text` 剥离前导 `[ctx · …]` 线（如果存在）。

    保持聊天面板重播干净——没有这个，每回合的 ctx
    前缀将显示在每条重播的用户消息前面。安全的
    no-op 当没有标签时。"""
    if not text.startswith(CTX_TAG_PREFIX):
        return text
    nl = text.find("\n\n")
    if nl < 0:
        # 仅包含标签的消息，没有内容 — 表面上是空的。
        return ""
    return text[nl + 2 :]


def touch_status(
    *,
    device_slug: str,
    repair_id: str | None,
    status: str,
    memory_root: Path | None = None,
) -> None:
    """更新 memory/{slug}/repairs/{id}.json 中修复的 `status` 字段。

    吞并所有错误——元数据漂移是可以接受的，但会话崩溃是不可以接受的。"""
    if not repair_id or not status:
        return
    settings = get_settings()
    memory_root = memory_root or Path(settings.memory_root)
    path = _metadata_file(memory_root, device_slug, repair_id)
    if not path.exists():
        return
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("status") == status:
            return
        payload["status"] = status
        payload["status_updated_at"] = datetime.now(UTC).isoformat()
        path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "[ChatHistory] touch_status failed for repair=%s: %s", repair_id, exc
        )


# ------------ 对话（每次修复多线程） ------------
# 一次修复在`conversations/{conv_id}/`下保存了N个对话，每个对话都有
# 它自己的 messages.jsonl 和可选的 MA 会话指针。有序索引
# 在 `conversations/index.json` 按时间顺序列出它们和元数据
# 用于 UI 弹出窗口。


def list_conversations(
    *,
    device_slug: str,
    repair_id: str,
    memory_root: Path | None = None,
) -> list[dict[str, Any]]:
    """返回要修复的有序对话列表（最旧的在前）。"""
    root = memory_root or Path(get_settings().memory_root)
    return _read_index(root, device_slug, repair_id)


def _create_index_entry(
    *,
    root: Path,
    device_slug: str,
    repair_id: str,
    conv_id: str,
    tier: str,
) -> bool:
    """将 `conv_id` 的新条目附加到 index.json，关闭之前的条目
    打开一个。幂等 — 当输入一个条目时返回 False（并且不写入任何内容）
    其中 `conv_id` 已在索引中。当有新条目时返回 True
    实际上被创建了。

    由 `create_conversation` 共享（自动生成 id）和
    `materialize_conversation`（保留预先分配的挂起 ID
    由`ensure_conversation(materialize=False)`返回）。"""
    index = _read_index(root, device_slug, repair_id)
    if any(entry.get("id") == conv_id for entry in index):
        return False
    for entry in index:
        if not entry.get("closed"):
            entry["closed"] = True
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    index.append(
        {
            "id": conv_id,
            "started_at": now,
            "tier": tier,
            "model": None,
            "last_turn_at": None,
            "cost_usd": 0.0,
            "turns": 0,
            "title": None,
            "closed": False,
        }
    )
    _conv_dir(root, device_slug, repair_id, conv_id).mkdir(
        parents=True, exist_ok=True
    )
    _write_index(root, device_slug, repair_id, index)
    # 将旧的每次修复 `ma_sessions` 字典一次性迁移到
    # 第一个对话的每层文件。 T1 之前，MA 会话 ID 为
    # 存储在`memory/{⟦PRESERVE0⟧}/repairs/{id}.json::ma_sessions[{tier}]`下；
    # 重构后，它们位于`conversations/{conv}/ma_session_{tier}.json`。
    # 如果没有此跃点，在遗留修复中创建的第一个转换将丢失
    # 真正的代理记忆和技术看到模型从头开始。
    if len(index) == 1:
        _seed_legacy_ma_sessions(
            root=root, device_slug=device_slug, repair_id=repair_id,
            conv_id=conv_id,
        )
    return True


def create_conversation(
    *,
    device_slug: str,
    repair_id: str,
    tier: str,
    memory_root: Path | None = None,
) -> str:
    """创建一个新对话，关闭前一个活动对话，返回其 ID。"""
    root = memory_root or Path(get_settings().memory_root)
    conv_id = secrets.token_hex(4)  # 8 个十六进制字符
    _create_index_entry(
        root=root, device_slug=device_slug, repair_id=repair_id,
        conv_id=conv_id, tier=tier,
    )
    return conv_id


def delete_conversation(
    *,
    device_slug: str,
    repair_id: str,
    conv_id: str,
    memory_root: Path | None = None,
) -> bool:
    """Remove a single conversation from disk: drop its index entry and wipe
    its `conversations/{conv_id}/` directory (messages.jsonl + per-tier MA
    session pointers + any artefacts the runtime persisted there).

    Returns True when something was actually removed (entry or directory),
    False when the conv was already absent. The repair itself, its metadata
    file, and other conversations are untouched.

    The per-tier MA session ids stored under the conv directory are dropped
    along with it; the upstream Anthropic sessions are left to expire on
    their own (the repair-scoped memory store is shared across convs and
    must outlive any single deletion)."""
    import shutil

    root = memory_root or Path(get_settings().memory_root)
    index = _read_index(root, device_slug, repair_id)
    new_index = [entry for entry in index if entry.get("id") != conv_id]
    index_changed = len(new_index) != len(index)
    if index_changed:
        _write_index(root, device_slug, repair_id, new_index)

    conv_dir = _conv_dir(root, device_slug, repair_id, conv_id)
    dir_removed = False
    if conv_dir.exists() and conv_dir.is_dir():
        try:
            shutil.rmtree(conv_dir)
            dir_removed = True
        except OSError as exc:
            logger.error(
                "[ChatHistory] delete_conversation: rmtree failed for %s: %s",
                conv_dir, exc,
            )
            raise

    return index_changed or dir_removed


def get_conversation_tier(
    *,
    device_slug: str,
    repair_id: str,
    conv_id: str,
    memory_root: Path | None = None,
) -> str | None:
    """根据索引返回最初打开转换的层
    入口。运行时使用它来自动对齐 WS 层与转换
    默认着陆（技术方面没有明确的`?tier=`），因此Sonnet
    由于 URL 默认值，线程不会以 Haiku 的方式静默恢复。
    当转换不在索引中（待处理或未知）时，返回 None。"""
    root = memory_root or Path(get_settings().memory_root)
    index = _read_index(root, device_slug, repair_id)
    for entry in index:
        if entry.get("id") == conv_id:
            tier = entry.get("tier")
            return tier if isinstance(tier, str) else None
    return None


def materialize_conversation(
    *,
    device_slug: str,
    repair_id: str,
    conv_id: str,
    tier: str,
    memory_root: Path | None = None,
) -> bool:
    """将先前挂起的 `conv_id` 保留到磁盘（索引条目 + 目录）。

    `ensure_conversation(materialize=False)`的同伴：在WS打开我们
    预分配一个 id 但跳过磁盘写入，这样索引就不会堆积
    通过会话中的 0 轮对话，技术打开但从不发送
    一条消息。当实际内容出现时，此调用会具体化插槽
    即将着陆。幂等 — 如果 `conv_id` 已经存在，则返回 False
    索引，当实际附加新条目时为 True。"""
    root = memory_root or Path(get_settings().memory_root)
    return _create_index_entry(
        root=root, device_slug=device_slug, repair_id=repair_id,
        conv_id=conv_id, tier=tier,
    )


def _seed_legacy_ma_sessions(
    *, root: Path, device_slug: str, repair_id: str, conv_id: str
) -> None:
    """将修复元数据中的 `ma_sessions` 字典复制到每层文件中。

    幂等：如果此转换已存在 `ma_session_{tier}.json`，
    它获胜（永远不要覆盖故意保存的 ID）。吞掉所有错误——
    这是best-effort回填，不是硬性前提条件。"""
    meta_path = _metadata_file(root, device_slug, repair_id)
    if not meta_path.exists():
        return
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    legacy = meta.get("ma_sessions") or {}
    if not isinstance(legacy, dict):
        return
    linked_at = meta.get("ma_session_linked_at") or datetime.now(UTC).isoformat()
    for tier, session_id in legacy.items():
        if not (isinstance(tier, str) and isinstance(session_id, str) and session_id):
            continue
        path = _ma_session_file(root, device_slug, repair_id, conv_id, tier)
        if path.exists():
            continue
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(
                    {"session_id": session_id, "tier": tier, "linked_at": linked_at},
                    indent=2, ensure_ascii=False,
                ) + "\n",
                encoding="utf-8",
            )
            logger.info(
                "[ChatHistory] seeded legacy MA session for repair=%s conv=%s tier=%s",
                repair_id, conv_id, tier,
            )
        except OSError as exc:
            logger.warning(
                "[ChatHistory] _seed_legacy_ma_sessions failed for repair=%s tier=%s: %s",
                repair_id, tier, exc,
            )


def ensure_conversation(
    *,
    device_slug: str,
    repair_id: str,
    conv_id: str | None,
    tier: str,
    memory_root: Path | None = None,
    materialize: bool = True,
) -> tuple[str, bool]:
    """将 conv_id 解析为正确的目标，并在需要时创建/迁移。

    语义：
      - `conv_id is None` → 活动（最新）。如果不存在，则迁移
        来自旧版 messages.jsonl（如果存在），否则创建一个新的。
      - `conv_id == "new"` → 始终创建新的对话。
      - `conv_id` 匹配现有条目 → 不受影响地通过。
      - 未知 `conv_id` → 引发 KeyError。

    返回 `(resolved_id, created)` — 调用此函数时，`created` 为 True
    创建（或预先分配，见下文）一个对话，包括
    遗留迁移。

    `materialize`（默认True）：当False时，创建路径返回一个
    新生成的 id，无需写入索引条目或进行转换
    目录。然后调用者负责调用
    `materialize_conversation` 一旦真正的内容即将登陆——通常
    在第一条用户消息上。这可以避免在以下情况下产生 0 回合条目：
    技术人员打开诊断面板而不发送任何内容。没有
    对解析现有路径的影响（无论如何都不会发生写入）。
    遗留的迁移`messages.jsonl`总是会实现——移动一个
    文件离开磁盘是该路径的全部要点。"""
    root = memory_root or Path(get_settings().memory_root)
    if conv_id == "new":
        if materialize:
            return (
                create_conversation(
                    device_slug=device_slug,
                    repair_id=repair_id,
                    tier=tier,
                    memory_root=root,
                ),
                True,
            )
        return secrets.token_hex(4), True

    index = _read_index(root, device_slug, repair_id)

    if conv_id is None:
        if index:
            # 活跃 = 技术人员最近*接触*的转化。这
            # 天真的“索引最后”选择是错误的：索引顺序是
            # `started_at` 升序，因此 5 分钟前开始了一次转换
            # 获得 0 次转化胜过 10 分钟前开始的转化，但仍然如此
            # 现在正在积累回合。层级切换并重新开放
            # 尤其是这一点——他们创建了一个新的转换，即使
            # 然后技术继续前一个工作。排序方式
            # `last_turn_at`（与 `started_at` 作为决胜局，永远不会-
            # 触摸的条目），因此默认着陆始终着陆在
            # 技术线程实际上有实时活动。
            def _recency_key(entry: dict[str, Any]) -> str:
                return entry.get("last_turn_at") or entry.get("started_at") or ""
            return max(index, key=_recency_key)["id"], False
        # No index yet — migrate legacy if present, else create fresh.
        legacy = _legacy_history_file(root, device_slug, repair_id)
        if legacy.exists():
            return (
                _migrate_legacy(
                    root=root,
                    device_slug=device_slug,
                    repair_id=repair_id,
                    tier=tier,
                ),
                True,
            )
        if materialize:
            return (
                create_conversation(
                    device_slug=device_slug,
                    repair_id=repair_id,
                    tier=tier,
                    memory_root=root,
                ),
                True,
            )
        return secrets.token_hex(4), True

    # 显式 ID — 必须存在。
    if not any(entry["id"] == conv_id for entry in index):
        raise KeyError(
            f"unknown conversation {conv_id!r} for repair {repair_id!r}"
        )
    return conv_id, False


def _migrate_legacy(
    *, root: Path, device_slug: str, repair_id: str, tier: str
) -> str:
    """将 Repair-root messages.jsonl 移至新对话中。"""
    legacy = _legacy_history_file(root, device_slug, repair_id)
    conv_id = secrets.token_hex(4)
    conv_dir = _conv_dir(root, device_slug, repair_id, conv_id)
    conv_dir.mkdir(parents=True, exist_ok=True)
    # 原子移动（在同一文件系统内重命名）。
    target = conv_dir / "messages.jsonl"
    legacy.rename(target)
    # 如果可读，则从第一条用户消息中获取标题。
    title: str | None = None
    turns = 0
    try:
        for line in target.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            event = rec.get("event") or {}
            if event.get("role") == "user" and not title:
                content = event.get("content")
                if isinstance(content, str):
                    title = content
                elif isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            title = block.get("text") or None
                            break
            if event.get("role") == "assistant":
                turns += 1
    except OSError:
        pass
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    index: list[dict[str, Any]] = [
        {
            "id": conv_id,
            "started_at": now,
            "tier": tier,
            "model": None,
            "last_turn_at": now,
            "cost_usd": 0.0,
            "turns": turns,
            "title": (title or "")[:80].replace("\n", " ").strip() or None,
            "closed": False,
        }
    ]
    _write_index(root, device_slug, repair_id, index)
    _seed_legacy_ma_sessions(
        root=root, device_slug=device_slug, repair_id=repair_id, conv_id=conv_id
    )
    return conv_id


def touch_conversation(
    *,
    device_slug: str,
    repair_id: str,
    conv_id: str,
    cost_usd: float | None = None,
    first_message: str | None = None,
    model: str | None = None,
    memory_root: Path | None = None,
) -> None:
    """更新 index.json 中对话的元数据 — 标题、成本、轮次、last_turn_at。"""
    root = memory_root or Path(get_settings().memory_root)
    index = _read_index(root, device_slug, repair_id)
    updated = False
    for entry in index:
        if entry["id"] != conv_id:
            continue
        if first_message and not entry.get("title"):
            entry["title"] = (
                first_message[:80].replace("\n", " ").strip() or None
            )
        if cost_usd is not None:
            entry["cost_usd"] = round(
                (entry.get("cost_usd") or 0.0) + cost_usd, 6
            )
            entry["turns"] = (entry.get("turns") or 0) + 1
            entry["last_turn_at"] = (
                datetime.now(UTC).isoformat().replace("+00:00", "Z")
            )
        if model and not entry.get("model"):
            entry["model"] = model
        updated = True
        break
    if updated:
        _write_index(root, device_slug, repair_id, index)


