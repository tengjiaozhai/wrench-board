"""WebSocket pipeline 进度中继 — `WS /pipeline/progress/{slug}`。

【时序图 — 完整版见 repairs.py 模块 docstring】

  浏览器 fetch POST /repairs (短 HTTP) → return RepairResponse
       → connectProgress(slug) → new WebSocket → 本 handler progress_ws

【哪一行建立 / 保持 WS 长会话？】
  - 建立：progress.py:58  await websocket.accept()
  - 保持：progress.py:64-66
        while True:
            event = await queue.get()
            await websocket.send_text(json.dumps(event))
    该循环在客户端断开前一直运行（WebSocketDisconnect → finally unsubscribe）。

【职责】
  本文件只做「总线 → 浏览器」的透明转发，不包含 pipeline 业务逻辑。
  浏览器在 POST /pipeline/repairs 拿到 device_slug 且 pipeline_started=true 后，
  自行连接本 WS；slug 必须与 HTTP 响应中的一致。

【与 events 总线的关系】
  1. accept 后调用 events.subscribe(slug) — 获得 queue（含 history 回放）
  2. 先发 {type: "subscribed"} 握手 ack
  3. while True: event = await queue.get() → websocket.send_text(json.dumps(event))
  4. 断开时在 finally 里 events.unsubscribe(slug, queue)

【事件来源（publish 侧）】
  repairs._run_pipeline_with_events → orchestrator.generate_knowledge_pack(on_event=…)
  详见 api/pipeline/routes/repairs.py 中 _on_event 与 create_repair 的 Branch 1。

将客户端订阅到 per-slug 事件总线，原样转发每条事件直至断开连接。
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.pipeline import events
from api.pipeline.orchestrator import _slugify
from api.ws_security import enforce_ws_origin, enforce_ws_service_token

logger = logging.getLogger("wrench_board.pipeline.api")

router = APIRouter()


@router.websocket("/progress/{device_slug}")
async def progress_ws(websocket: WebSocket, device_slug: str) -> None:
    """Step F：progress WebSocket 服务端 — 订阅 events 总线并转发给浏览器。

    【在完整流程中的位置】
      Step E  create_repair 已 return RepairResponse（HTTP 已结束）
      Step 6  前端 new WebSocket(/pipeline/progress/{slug}) 连到本 handler
      Step F  本函数 accept → subscribe(slug) → while True 逐条 send_text
      Step D  并行的后台 task 持续 events.publish(slug, ev) → 本 queue 收到

    时序（典型新设备首次构建）：
      T0  POST /pipeline/repairs 返回 {device_slug, pipeline_started: true}
      T1  前端 new WebSocket("/pipeline/progress/{device_slug}")
      T2  本 handler accept → subscribe(slug) → 回放 history（若后台已 emit）
      T3  发送 {type: "subscribed", device_slug}
      T4+ 后台 orchestrator emit → publish → queue.get → send_text 逐条转发
      Tn  pipeline_finished 到达；前端自行 close 或跳转工作区

    安全：enforce_ws_origin / enforce_ws_service_token（自托管通常 no-op）。
    """
    if not await enforce_ws_origin(websocket):
        return
    if not await enforce_ws_service_token(websocket):
        return

    slug = _slugify(device_slug)
    await websocket.accept()
    # 与 create_repair → _run_pipeline_with_events → publish(slug, …) 使用同一 slug。
    queue = events.subscribe(slug)
    try:
        # 握手 ack：客户端可区分「已订阅」与「仍在等第一条 pipeline 事件」。
        await websocket.send_text(json.dumps({"type": "subscribed", "device_slug": slug}))
        while True:
            event = await queue.get()  # 阻塞直到总线有新事件（含 history 回放项）
            await websocket.send_text(json.dumps(event))
    except WebSocketDisconnect:
        logger.info("[API] /pipeline/progress/%s · client disconnected", slug)
    finally:
        events.unsubscribe(slug, queue)
