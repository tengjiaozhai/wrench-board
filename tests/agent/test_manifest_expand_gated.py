"""mb_expand_knowledge is plan-gated: present by default (Pro / self-host),
dropped from the manifest when the session's can_expand capability is False
(free tenant, set from the cloud's X-Wb-Can-Expand header)."""

from __future__ import annotations

from api.agent.manifest import build_tools_manifest
from api.agent.session_caps import set_can_expand
from api.session.state import SessionState


def _tool_names(manifest):
    return {t["name"] for t in manifest}


def test_expand_present_by_default(monkeypatch):
    # 默认（self-host/无cloud）→ 不受re限制。
    set_can_expand(True)
    monkeypatch.setattr("api.agent.manifest.current_can_expand", lambda: True)
    names = _tool_names(build_tools_manifest(SessionState()))
    assert "mb_expand_knowledge" in names


def test_expand_absent_when_capability_false(monkeypatch):
    monkeypatch.setattr("api.agent.manifest.current_can_expand", lambda: False)
    names = _tool_names(build_tools_manifest(SessionState()))
    assert "mb_expand_knowledge" not in names
    # 其他 memory-bank 工具保留 - 只有 enrichment 被门控。
    assert "mb_get_rules_for_symptoms" in names
    assert "mb_get_component" in names
