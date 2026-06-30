"""WebSocket 层安全守卫。

``api.main`` 的 CORS 中间件仅覆盖 HTTP 请求；WebSocket 握手完全绕过它。
若不显式检查 Origin，任意主机上的网页都可以 ``new WebSocket("ws://workbench:
8000/ws/diagnostic/iphone14")``，悄悄搭便车进入技术员的 session —— 读取
token、注入 `message` 帧、驱动 boardview。

`enforce_ws_origin` 在握手完成*之前*执行 Origin 白名单检查（来源
``settings.cors_allow_origins``）。拒绝时以 RFC 6455 关闭码 1008
（"Policy Violation"）关闭 socket，并返回 ``False`` 让调用方提前退出。
"""

from __future__ import annotations

from fastapi import WebSocket

from api._token_check import extract_bearer, token_matches
from api.config import get_settings


def _allowed_origins() -> list[str]:
    """从 settings 返回允许的 Origin 列表。
    origin: https://example.com
    与 CORS 风格白名单的 CSV 解析约定保持一致，使 HTTP 中间件和 WS 守卫
    共享同一数据源。
    """
    raw = get_settings().cors_allow_origins
    return [o.strip() for o in raw.split(",") if o.strip()]


async def enforce_ws_origin(websocket: WebSocket) -> bool:
    """校验 WebSocket 的 Origin 头部是否在配置的白名单内。

    策略（宽松 —— 在不破坏开发工具的前提下保证安全）：

    1. 白名单为空或包含 ``"*"`` → 放行所有（向后兼容开发模式，与 CORS
       中间件的通配语义一致）。
    2. 请求无 ``Origin`` 头部 → 放行。浏览器在 WS 握手时总是会发送
       Origin（``WebSocket`` 构造器自动设置），因此缺失头部意味着
       非浏览器客户端（curl、websocat、Python ``websockets``、内部测试
       工具）。跨源浏览器攻击 —— 此处的实际威胁模型 —— 仍被拦截，
       因为浏览器总会带上 Origin。
    3. Origin 存在且在白名单中 → 放行。
    4. Origin 存在但不在白名单 → 以 1008 关闭并返回 ``False``。
       调用方必须停止处理（socket 已关闭；继续 send 会抛异常）。

    握手可继续时返回 ``True``；socket 已关闭时返回 ``False``。
    """
    allowed = _allowed_origins()
    if not allowed or "*" in allowed:
        return True

    origin = websocket.headers.get("origin")
    if not origin:
        # 非浏览器客户端 —— 浏览器之外 Origin 是可选的。
        return True

    if origin in allowed:
        return True

    await websocket.close(code=1008, reason="Forbidden origin")
    return False


async def enforce_ws_service_token(websocket: WebSocket) -> bool:
    """要求 WebSocket 握手携带云端网关的 service token。

    上面的 Origin 检查拦截了跨源*浏览器*，但放行所有无 Origin 头部的
    非浏览器客户端 —— 包括 ``websocat``。引擎部署到 wrenchboard-cloud
    后这就成了漏洞：任何获知引擎 URL 的人都能直接开启诊断 session，
    绕过 cloud 的 auth + quota，消耗 Anthropic credits。此检查堵住该漏洞。

    策略（默认宽松，与 ``enforce_ws_origin`` 一致）：

    1. ``settings.engine_service_token`` 为空 → 不强制（独立工作台 / 开发
       模式 —— 浏览器无法设置 Authorization 头部，因此直连引擎的开发
       流程在未配置 token 时正常运行）。
    2. 已配置 token 且请求携带 ``Authorization: Bearer <token>`` 并
       匹配 → 放行。
    3. 已配置 token 但头部缺失、格式错误（无 ``Bearer`` scheme）或
       值不匹配 → 以 1008 关闭并返回 ``False``。调用方必须停止处理
      （socket 已关闭）。

    token 比较使用常量时间算法（``secrets.compare_digest``），拒绝时
    不泄露任何关于前导字节匹配多少的信息。
    """
    expected = get_settings().engine_service_token
    if not expected:
        return True

    if token_matches(extract_bearer(websocket.headers.get("authorization", "")), expected):
        return True

    await websocket.close(code=1008, reason="Forbidden: service token required")
    return False
