"""为 bv_* 工具系列调度路由器。

将公共名称（在清单中向 Claude 公开）映射到现有的
api/tools/boardview.py 中的处理程序。每个处理程序返回一个可能的字典
包含{ok、摘要、事件、原因、建议}。
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from api.session.state import SessionState
from api.tools import boardview as bv

logger = logging.getLogger("wrench_board.agent.dispatch_bv")


BV_DISPATCH: dict[str, Callable[..., dict[str, Any]]] = {
    "bv_highlight":        bv.highlight_component,
    "bv_focus":            bv.focus_component,
    "bv_reset_view":       bv.reset_view,
    "bv_flip":             bv.flip_board,
    "bv_annotate":         bv.annotate,
    "bv_dim_unrelated":    bv.dim_unrelated,
    "bv_highlight_net":    bv.highlight_net,
    "bv_show_pin":         bv.show_pin,
    "bv_draw_arrow":       bv.draw_arrow,
    "bv_measure":          bv.measure_distance,
    "bv_filter_by_type":   bv.filter_by_type,
    "bv_layer_visibility": bv.layer_visibility,
    "bv_scene":            bv.compose_scene,
}


def dispatch_bv(session: SessionState, name: str, payload: dict[str, Any]) -> dict[str, Any]:
    """将 bv_* 工具调用路由到其处理程序。捕获任何异常。

    如果名称不在 BV_DISPATCH 中，则返回 {ok: false, Reason: "unknown-tool"}。
    返回 {ok: false, Reason: "handler-exception", error: str(exc)} 如果
    handler raises (e.g. malformed payload).
    """
    handler = BV_DISPATCH.get(name)
    if handler is None:
        return {"ok": False, "reason": "unknown-tool"}
    try:
        return handler(session, **payload)
    except Exception as exc:  # noqa: BLE001 — intentional catch-all at dispatch boundary
        logger.exception("bv_* handler %s raised", name)
        return {"ok": False, "reason": "handler-exception", "error": str(exc)}
