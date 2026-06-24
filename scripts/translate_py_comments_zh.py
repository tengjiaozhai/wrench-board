#!/usr/bin/env python3
"""Translate # comments and docstrings in api/**/*.py to Chinese."""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

KEEP_TERMS = [
    "WebSocket", "slug", "repair_id", "device_slug", "FastAPI", "Pydantic",
    "AsyncAnthropic", "Anthropic", "Managed Agents", "httpx", "asyncio",
    "refdes", "boardview", "kicad_pcb", "ElectricalGraph", "SimulationEngine",
    "messages.jsonl", "electrical_graph.json", "tool_choice", "tool_use",
    "tool_result", "is_error", "requires_action", "stream_timeout",
    "mb_", "bv_", "stock_", "cam_capture", "owner_ref", "Opus", "Sonnet", "Haiku",
    "Scout", "Registry", "Writers", "Auditor", "Cartographe", "Clinicien",
    "Lexicographe", "query_graph", "noqa", "BLE001", "PLC0415", "E501", "B008",
    "F821", "pragma", "type: ignore", "self-host", "wrenchboard-cloud",
    "DIAGNOSTIC_MODE", "managed", "direct", "tier", "FIFO", "OTPM", "RAM",
    "TCP", "SSE", "CORS", "Bearer", "Authorization", "KiCad", "pcbnew",
    "force_rebuild", "pipeline_started", "pipeline_finished", "phase_started",
    "X-Owner-Ref", "X-Wb-Can-Expand", "KnowledgeCurator", "forwarder",
    "jsonl", "fan-out", "fire-and-forget", "dedup", "stampede", "backpressure",
    "fail-fast", "websocat", "paywall", "carnet", "Flow A", "Flow B",
    "ctrl", "Ctrl+Shift+R", "DEPLOYMENT.md", ".env", "resolve()", "kebab-case",
    "GenCAD", "Test_Link", "BRD2", "XZZ", "TVW", "Levenshtein",
    "adaptive", "thinking", "xhigh", "capture_request", "server.capture_request",
    "protocol_pending_confirmation", "memory_stores", "uploads/", "board_assets/",
    "RemoteProtocolError", "page_vision", "SYSTEM_PROMPT", "Haiku-class",
    "tool_choice", "max_retries", "cache_read", "cache_write", "max_tokens",
    "submit_tool", "query_handler", "output_schema", "ValidationError",
    "APIConnectionError", "TransportError", "Messages API", "Message Batches API",
    "pdfplumber", "base64", "PNG", "PDF", "Redis", "OTPM", "decompression-bomb",
    "ground-truth", "reviser", "re-audit", "drift", "orphan", "prewarm",
    "InstancedMesh", "Three.js", "WebGL", "ESM", "D3", "pytest", "ruff",
    "T9a", "T13", "Branch", "Phase", "ISO-timestamp", "conv_id",
    "image_ref", "set_board_ref", "expand_blocked", "allow_expand",
    "needs_disambiguation", "matched_rule_id", "coverage_reason",
    "queue_position", "pipeline_kind", "expand", "orchestrator",
    "events.publish", "RepairResponse", "TaxonomyTree", "RepairSummary",
    "SPOF", "FOUC", "ETA", "UUID", "Cmd+K", "Ctrl+J", "Enter", "Escape",
    "OKLCH", "i18n", "BCP-47", "MIT", "CDN", "UI", "API", "HTTP", "HTTPS",
    "WS", "JSON", "POST", "GET", "PUT", "DELETE", "FormData", "FileResponse",
    "JSONResponse", "HTTPException", "StaticFiles", "UploadFile", "File",
    "logger", "logging", "Path", "Settings", "BaseModel", "Field",
    "AsyncIterator", "asynccontextmanager", "lifespan", "uvicorn",
    "claude-opus", "claude-sonnet", "claude-haiku", "messages.create",
    "mb_expand_knowledge", "bv_propose_protocol", "custom_tool_result",
    "custom_tool_use", "agent.message", "stream_error", "reconnect_exhausted",
    "recv", "emit", "mirror", "transcript", "sub-agent", "subagent", "curator",
    "consultant", "watchdog", "unwind", "drain", "metering", "ENGINE_SERVICE_TOKEN",
    "PIPELINE_", "ANTHROPIC_", "CORS_", "MA_", "ENV=", "HOST=",
    "macOS", "iPhone", "Mac", "MNT Reform", "820-02016",
    "smoke", "bootstrap_managed_agent.py", "runtime_managed.py", "runtime_direct.py",
    "brd_viewer.js", "pcb_viewer.js", "pipeline_progress.js", "llm.js",
    "main.js", "router.js", "landing/index.js", "shared/api.js",
    "Boardview", "initBoardview", "Pickr", "DOMPurify", "marked",
    "tailwind", "Opus 4.7", "Opus 4.8", "4.7/4.8", "req_",
    "Lot 2", "Lot 3", "baseline/", "_staged/", "web_only", "coverage_fail",
    "FAIL", "WARN", "PASS", "APPROVED", "REJECTED", "NEEDS_REVISION",
    "consistency_score", "revise_rounds", "mark_building", "mark_complete",
    "mark_paused", "build_state", "parts_index", "knowledge_graph",
    "rules.json", "dictionary.json", "audit_verdict.json", "registry.json",
    "raw_research_dump.md", "schematic_graph.json", "simulator_reliability.json",
    "has_registry", "has_rules", "has_dictionary", "has_boardview",
    "has_schematic_pdf", "has_electrical_graph", "has_knowledge_graph",
    "has_audit_verdict", "has_parts_index", "force_rebuild",
    "device_label", "device_kind", "focus_symptom", "expect_schematic",
    "engine_repair_id", "uploaded_documents", "schematic_ingest",
    "needs_kind_confirmation", "device_kind|scout|registry|writers|audit",
    "elapsed_s", "revise_rounds_used", "on_event", "_on_event", "_wrap_on_event",
    "progress_ws", "create_repair", "create_task", "_run_pipeline_with_events",
    "subscribeToProgress", "goToWorkspace", "openPipelineProgress",
    "handleProgressEvent", "type:queued", "analyse en cours", "prête",
    "CoverageCheck", "board_delta", "AsyncAnthropic", "patchability",
    "cross-tenant", "tenant", "quota", "paywall", "slugify",
    "canonical", "disambiguation", "candidates", "ambiguous",
    "list_repairs", "ensure_conversation", "messages.jsonl",
    "best-effort", "belt-and-suspenders", "byte-for-byte", "cold-path",
    "fire-and-forget", "lazy import", "forward-only",
]


def _protect(text: str) -> tuple[str, list[tuple[str, str]]]:
    reps: list[tuple[str, str]] = []
    out = text
    for i, term in enumerate(KEEP_TERMS):
        if term in out:
            ph = f"⟦K{i}⟧"
            reps.append((ph, term))
            out = out.replace(term, ph)
    return out, reps


def _restore(text: str, reps: list[tuple[str, str]]) -> str:
    for ph, term in reps:
        text = text.replace(ph, term)
    return text


def _translate(text: str) -> str:
    text = text.strip()
    if not text:
        return text
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    if cjk > max(3, len(text) * 0.25):
        return text
    latin = re.findall(r"[A-Za-z]{4,}", text)
    if len(latin) < 1 and cjk == 0:
        return text
    protected, reps = _protect(text)
    try:
        from deep_translator import GoogleTranslator
        out = GoogleTranslator(source="en", target="zh-CN").translate(protected)
        time.sleep(0.05)
    except Exception:
        return text
    return _restore(out, reps)


def _has_english(s: str) -> bool:
    cjk = sum(1 for c in s if "\u4e00" <= c <= "\u9fff")
    if cjk > len(s) * 0.35:
        return False
    return bool(re.search(r"[A-Za-z]{3,}", s))


def translate_comments_only(source: str) -> str:
    lines = source.splitlines(keepends=True)
    out: list[str] = []
    in_doc = False
    doc_quote = ""
    for line in lines:
        stripped = line.lstrip()
        # Handle docstrings
        if not in_doc:
            if stripped.startswith(('"""', "'''")):
                q = '"""' if stripped.startswith('"""') else "'''"
                if stripped.count(q) >= 2 and len(stripped.strip()) > len(q) * 2:
                    # single-line docstring
                    prefix = line[: len(line) - len(stripped)]
                    content = stripped[len(q):-len(q)].strip()
                    if _has_english(content):
                        content = _translate(content)
                    out.append(f"{prefix}{q}{content}{q}\n" if line.endswith("\n") else f"{prefix}{q}{content}{q}")
                    continue
                in_doc = True
                doc_quote = q
                prefix = line[: len(line) - len(stripped)]
                first = stripped[len(q):]
                if first.rstrip().endswith(q) and first.strip() != q:
                    content = first.rstrip()[:-len(q)].strip()
                    if _has_english(content):
                        content = _translate(content)
                    out.append(f"{prefix}{q}{content}{q}\n" if line.endswith("\n") else f"{prefix}{q}{content}{q}")
                    in_doc = False
                    continue
                if _has_english(first.rstrip("\n")):
                    first = _translate(first.rstrip("\n")) + ("\n" if first.endswith("\n") else "")
                out.append(prefix + q + first)
                continue
            if stripped.startswith("#"):
                indent = line[: len(line) - len(stripped)]
                body = stripped[1:]
                noqa = ""
                m = re.search(r"\s+#\s*noqa\b.*$", body)
                if m:
                    noqa = body[m.start():]
                    body = body[: m.start()].rstrip()
                if _has_english(body):
                    body = " " + _translate(body.strip())
                else:
                    body = " " + body if body and not body.startswith(" ") else body
                nl = "\n" if line.endswith("\n") else ""
                out.append(f"{indent}#{body}{noqa}{nl}")
                continue
            out.append(line)
        else:
            if doc_quote in stripped:
                end_idx = stripped.find(doc_quote)
                content = stripped[:end_idx]
                suffix = stripped[end_idx + len(doc_quote):]
                if _has_english(content.rstrip("\n")):
                    content = _translate(content.rstrip("\n"))
                    if line.endswith("\n"):
                        content += "\n"
                prefix = line[: len(line) - len(stripped)]
                out.append(prefix + content + doc_quote + suffix)
                in_doc = False
            else:
                content = line.rstrip("\n")
                if _has_english(content):
                    indent = len(line) - len(line.lstrip())
                    content = " " * indent + _translate(content.strip())
                out.append(content + ("\n" if line.endswith("\n") else ""))
    return "".join(out)


def translate_file(path: Path) -> bool:
    orig = path.read_text(encoding="utf-8")
    new = translate_comments_only(orig)
    if new != orig:
        path.write_text(new, encoding="utf-8")
        return True
    return False


def main() -> int:
    root = ROOT.resolve()
    targets = [root / "api"]
    if len(sys.argv) > 1:
        targets = [Path(a).resolve() for a in sys.argv[1:]]
    modified = 0
    for t in targets:
        files = sorted(t.rglob("*.py")) if t.is_dir() else [t.resolve()]
        for f in files:
            f = f.resolve()
            try:
                if translate_file(f):
                    modified += 1
                    print(f"translated: {f.relative_to(root)}", flush=True)
            except Exception as e:
                print(f"ERROR {f}: {e}", file=sys.stderr)
    print(f"\nModified: {modified} files", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
