"""服务令牌验证 — 解析 Bearer + 比较常数时间。

来源独特的 ws_security (guard WS) et http_security (中间件
HTTP）不要重复秘密比较逻辑。乐解析
重现守卫历史行为执行WS（str.partition sur
le Premier espace) pour ne rien régresser."""

from __future__ import annotations

import secrets


def extract_bearer(header: str | None) -> str | None:
    """'授权：持有者 <令牌>' → <令牌>，sinon 无。

    利用partition(' ')来保护WS历史：scheme=avant le 1er
    espace，呈现=après。返回 None si le plan n'est pas 'Bearer'ou
    这就是我们所见的。"""
    scheme, _, presented = (header or "").partition(" ")
    if scheme == "Bearer" and presented:
        return presented
    return None


def token_matches(presented: str | None, expected: str) -> bool:
    """比较恒定时间。虚假 si 呈现 est vide/无。"""
    return bool(presented) and secrets.compare_digest(presented, expected)
