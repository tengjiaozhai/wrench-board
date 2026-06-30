"""WebSocket pipeline 进度中继 — `⟦PRESERVE5⟧ /pipeline/progress/{⟦PRESERVE4⟧}`。

【时序图 — 完整版见 repairs.py 模块 docstring】

  浏览器获取POST /repairs(短HTTP)→返回RepairResponse
       → connectProgress(slug) → 新 WebSocket → 本处理程序 Progress_ws

【哪一行建立 / 保持 WS 长会话？】
  - 建立：progress.py:58 wait websocket.accept()
  - 保持：progress.py:64-66
        而真实：
            事件 = 等待队列.get()
            等待 websocket.send_text(json.dumps(事件))
    该循环在客户端断开前一直运行（WebSocketDisconnect → finally unsubscribe）。

【职责】
  本文件只做「总线 → 浏览器」的透明转发，不包含 pipeline 业务逻辑。
  浏览器在 POST /pipeline/repairs 拿到device_slug且pipeline_started=true后，
  自行连接本 WS；slug 必须与 HTTP 响应中的一致。

【与 events 总线的关系】
  1.accept 后调用 events.subscribe(slug) — 获得队列（含历史回放）
  2. 先发 {type: "subscribed"} 握手 ack
  3. while True: event = wait queue.get() → websocket.send_text(json.dumps(event))
  4. 断开时在finally里events.unsubscribe(slug,queue)

【事件来源（publish 侧）】
  Repairs._run_pipeline_with_events → Orchestrator.generate_knowledge_pack(on_event=…)
  详见 api/pipeline/routes/repairs.py 中 _on_event 与 create_repair 的 Branch 1。

将客户端订阅到 per-slug 事件总线，原样转发每条事件直至断开连接。"""

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
      步骤E create_repair已返回RepairResponse（HTTP已结束）
      步骤 6 前端 new WebSocket(/pipeline/progress/{slug}) 连到本处理程序
      Step F 本函数accept → subscribe(slug) → while True 逐条send_text
      Step D 后台任务持续 events.publish(slug, ev) → 本队列接收

    时序（典型新设备首次构建）：
      T0 POST /pipeline/repairs 返回 {device_slug, pipeline_started: true}
      T1 前端 new WebSocket("/pipeline/progress/{device_slug}")
      T2 本处理程序接受 → 订阅(slug) → 回放历史（后台若已发出）
      T3  发送 {type: "subscribed", device_slug}
      T4+后台编排器emit→publish→queue.get→send_text逐条转发
      Tn  pipeline_finished 到达；前端自行 close 或跳转工作区

    安全：enforce_ws_origin / enforce_ws_service_token（自托管通常 no-op）。"""
    # 安全守卫 1/2：Origin 白名单检查。防止跨源浏览器攻击。
    if not await enforce_ws_origin(websocket):
        return
    # 安全守卫 2/2：service-token 检查。防止绕过 cloud 中继直接访问。
    if not await enforce_ws_service_token(websocket):
        return

    # 规范化设备标识符（小写、去特殊字符），确保与 pipeline 发布事件时用的 slug 一致
    slug = _slugify(device_slug)
    # 接受 WebSocket 握手，此时安全守卫（Origin + service token）已通过
    await websocket.accept()
    # 订阅该设备的事件总线，返回异步队列；与 create_repair → _run_pipeline_with_events → publish(slug, …) 使用同一 slug
    queue = events.subscribe(slug)
    try:
        # 发送订阅确认消息，客户端收到后可区分「已订阅成功」与「仍在等第一条 pipeline 事件」
        await websocket.send_text(json.dumps({"type": "subscribed", "device_slug": slug}))
        # 无限循环，持续转发事件直到客户端断开
        while True:
            # 从队列取事件（异步阻塞，无事件时挂起不耗 CPU），包含历史回放项和新发布的事件
            event = await queue.get()
            # 将事件序列化为 JSON 并通过 WebSocket 发送给客户端
            await websocket.send_text(json.dumps(event))
    except WebSocketDisconnect:
        # 客户端主动断开（关闭页面、网络中断）时捕获异常，记录 info 级别日志
        logger.info("[API] /pipeline/progress/%s · client disconnected", slug)
    finally:
        # 无论正常退出还是异常断开，都取消订阅，防止队列堆积在事件总线中造成内存泄漏
        events.unsubscribe(slug, queue)
