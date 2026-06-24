"""服务令牌校验 — Bearer 解析 + 恒定时间比较。

供 ws_security（WS 守卫）与 http_security（HTTP 中间件）共用，
避免重复秘密比较逻辑。解析沿用 WS 历史行为（str.partition 按
第一个空格切分），不引入回归。
"""

from __future__ import annotations

import secrets


def extract_bearer(header: str | None) -> str | None:
    """'授权：承载<token>' → <token>，否则无。

    使用 partition(' ') 保持 WS 历史语义：scheme 为第一个空格前，
    呈现为之后。scheme 非 'Bearer' 或呈现为空时返回 None。"""
    scheme, _, presented = (header or "").partition(" ")
    if scheme == "Bearer" and presented:
        return presented
    return None


def token_matches(presented: str | None, expected: str) -> bool:
    """恒定时间比较。presented 为空/None 时返回 False。"""
    return bool(presented) and secrets.compare_digest(presented, expected)
