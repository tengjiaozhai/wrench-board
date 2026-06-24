"""每次修复持久性+boardview覆盖状态的重播。

聊天回放（managed运行时）重新emit代理文本+tool_use事件
来自 MA 的事件存储，但它永远不会重新运行 `dispatch_bv` — 所以
视觉副作用（突出显示、焦点、注释、暗淡、图层翻转）
一旦 WS 重新连接，产生的那些工具调用就会消失。
技术人员重新打开面板，即使聊天，面板也是空的
显示“我为你突出显示了 U7”。

修复：将 SessionState 的覆盖字段快照为
每个bv_*之后`内存/{slug}/repairs/{repair_id}/board_state.json`
突变，并在 WS 上重新将快照重放为一系列
brd_viewer 的“boardview.*”事件。最终结果：刷新页面并
该板的显示与特工离开时的完全一样。

状态是按修复而不是按转换进行键控的：设备在整个过程中是相同的
维修对话，技术人员的心理模型是“我所看到的”
在董事会上”——而不是“我目前所在的会议”。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from api.session.state import SessionState

logger = logging.getLogger("wrench_board.agent.board_state")

_FILENAME = "board_state.json"


def _state_path(
    memory_root: Path,
    device_slug: str,
    repair_id: str,
    conv_id: str | None,
) -> Path:
    """Path 用于板覆盖快照。

    当给出`conv_id`时，Conv范围（理想的形状：每个聊天
    线程有自己的画布，因此打开一个新的转换会显示一个干净的
    即使同一维修中的另一个转换有注释
    和箭头）。当没有转换 ID 时回退到修复根位置
    提供 - 保留与写入的快照的向后兼容性
    在每个转换重构之前。
    """
    base = memory_root / device_slug / "repairs" / repair_id
    if conv_id:
        return base / "conversations" / conv_id / _FILENAME
    return base / _FILENAME


def save_board_state(
    *,
    memory_root: Path,
    device_slug: str,
    repair_id: str | None,
    session: SessionState,
    conv_id: str | None = None,
) -> None:
    """将会话的覆盖状态快照到磁盘。尽最大努力——从不
    写入失败时阻止WS路径（警告时记录）。

    匿名会话（无 repair_id）静默跳过 — 无需修复
    没有地方可以确定快照的范围。
    """
    if not repair_id:
        return
    snapshot = session.serialize_view()
    # 廉价的空状态快捷方式——没有必要保留一个空的覆盖层





    # 覆盖一个空文件。还避免了嘈杂的 ENOENT->mkdir->write 周期





    # 每次 WS 进行新维修且代理商尚未致电时





    # 还没有任何 bv_* 。





    if (
        snapshot["layer"] == "top"
        and not snapshot["highlights"]
        and snapshot["net_highlight"] is None
        and not snapshot["annotations"]
        and not snapshot["arrows"]
        and not snapshot["dim_unrelated"]
        and snapshot["filter_prefix"] is None
        and snapshot["layer_visibility"] == {"top": True, "bottom": True}
    ):
        return
    path = _state_path(memory_root, device_slug, repair_id, conv_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        logger.warning(
            "[BoardState] save failed for repair=%s/%s conv=%s: %s",
            device_slug, repair_id, conv_id, exc,
        )


def load_board_state(
    *,
    memory_root: Path,
    device_slug: str,
    repair_id: str | None,
    conv_id: str | None = None,
) -> dict[str, Any] | None:
    """读取此转换之前保存的快照，或无。

    当给出 `conv_id` 时严格按转化（无遗留后备）：
    新的对话必须落在干净的板上，即使是兄弟姐妹
    同一修复上的 conv 有一个填充的覆盖层。如果没有这个，
    “+Nouvelle对话”路径继承注释/箭头
    以最后接触黑板的 CV 为准。

    仅当没有 conv_id 时才参考修复根遗留路径
    完全提供（匿名WS，主要是测试）。
    """
    if not repair_id:
        return None
    path = _state_path(memory_root, device_slug, repair_id, conv_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "[BoardState] load failed for %s: %s", path, exc,
        )
        return None


async def replay_board_state_to_ws(ws: Any, snapshot: dict[str, Any]) -> int:
    """将重建“快照”的boardview事件推送到WS。

    顺序很重要：首先是图层/可见性/过滤器（骨架），然后
    突出显示，然后注释/箭头，最后是暗淡不相关（它
    对刚刚设置的亮点进行操作）。返回事件的计数
    已发送，以便调用者可以记录/决定是否显示任何内容。
    """
    if not isinstance(snapshot, dict):
        return 0
    sent = 0

    # 图层翻转 - 仅当它偏离默认顶部时。





    layer = snapshot.get("layer")
    if layer == "bottom":
        await ws.send_json({
            "type": "boardview.flip",
            "new_side": "bottom",
            "preserve_cursor": False,
        })
        sent += 1

    # 图层可见性 — 仅当一侧隐藏时才推送。





    lv = snapshot.get("layer_visibility") or {}
    for side in ("top", "bottom"):
        visible = lv.get(side, True)
        if visible is False:
            await ws.send_json({
                "type": "boardview.layer_visibility",
                "layer": side,
                "visible": False,
            })
            sent += 1

    # 按类型过滤 — brd 渲染器上的纯文本。





    filter_prefix = snapshot.get("filter_prefix")
    if filter_prefix:
        await ws.send_json({
            "type": "boardview.filter",
            "prefix": filter_prefix,
        })
        sent += 1

    # 组件亮点 - 单个批处理事件，以便渲染器应用





    # 一次性完成它们（additive=False = 替换客户端上现有的）。





    # 颜色从保存的覆盖层中继承，因此警告/琥珀色标签可以保留





    # 重新加载（之前的平口音版本将所有内容重新绘制为青色





    # 并默默地放弃了代理的琥珀色“风险部分”语义）。





    highlights = snapshot.get("highlights") or []
    color = snapshot.get("highlight_color") or "accent"
    if color not in ("accent", "warn", "mute"):
        color = "accent"
    if highlights:
        await ws.send_json({
            "type": "boardview.highlight",
            "refdes": list(highlights),
            "color": color,
            "additive": False,
        })
        sent += 1

    # 焦点 — 重播以最后一个 bv_ 焦点目标为中心的平移/缩放。





    # `boardview.focus`携带bbox+zoom；渲染器将​​平移并并
    # 应用其突出显示脉冲动画。裸露之后重播





    # 高亮显示，这样焦点的单目标高亮显示就不会被破坏





    # 由上面更广泛的集合。





    last_focused = snapshot.get("last_focused")
    last_bbox = snapshot.get("last_focused_bbox")
    last_zoom = snapshot.get("last_focused_zoom") or 1.4
    if last_focused and isinstance(last_bbox, list) and len(last_bbox) == 2:
        await ws.send_json({
            "type": "boardview.focus",
            "refdes": last_focused,
            "bbox": last_bbox,
            "zoom": last_zoom,
            "auto_flipped": False,  # 上面已经发出了图层翻转事件
        })
        sent += 1

    # 网络亮点——只有名字； pin_refs 没有快照（我们





    # 需要解析板重新计算）。渲染器仍然可以标记





    # 即使没有引脚覆盖，网络标签也是如此。





    net = snapshot.get("net_highlight")
    if net:
        await ws.send_json({
            "type": "boardview.highlight_net",
            "net": net,
            "pin_refs": [],
        })
        sent += 1

    # 注释 + 箭头 — 单独重新emit，以便渲染器的





    # 每个 id 存储使用代理最初使用的相同 id 进行重建





    # （如果代理稍后将其删除，则让 bv_* 工具重播排列起来）。





    for ann_id, ann in (snapshot.get("annotations") or {}).items():
        if not isinstance(ann, dict):
            continue
        await ws.send_json({
            "type": "boardview.annotate",
            "id": ann_id,
            "refdes": ann.get("refdes", ""),
            "label": ann.get("label", ""),
        })
        sent += 1

    for arrow_id, arrow in (snapshot.get("arrows") or {}).items():
        if not isinstance(arrow, dict):
            continue
        from_pt = arrow.get("from") or arrow.get("from_")
        to_pt = arrow.get("to")
        if not from_pt or not to_pt:
            continue
        await ws.send_json({
            "type": "boardview.draw_arrow",
            "id": arrow_id,
            "from": list(from_pt),
            "to": list(to_pt),
        })
        sent += 1

    # 昏暗无关——必须在高光之后出现，以便昏暗蒙版知道





    # 什么是“相关的”（渲染器端刚刚设置的突出显示）。





    if snapshot.get("dim_unrelated"):
        await ws.send_json({"type": "boardview.dim_unrelated"})
        sent += 1

    return sent
