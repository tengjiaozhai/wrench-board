#!/usr/bin/env python3
"""Translate # comments and docstrings in api/**/*.py to Chinese.

Preserves technical tokens (WebSocket, slug, repair_id, etc.) via placeholders.
Does NOT translate runtime strings (only comments and docstrings).
"""
from __future__ import annotations

import ast
import re
import sys
import tokenize
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API_ROOT = ROOT / "api"

KEEP_TERMS = [
    "WebSocket", "webSocket", "websocket", "WS", "SSE",
    "device_slug", "repair_id", "slug", "pipeline", "FastAPI", "uvicorn",
    "Pydantic", "AsyncAnthropic", "Anthropic", "Managed Agents", "MA",
    "JSON", "HTTP", "HTTPS", "API", "UI", "POST", "GET", "PUT", "DELETE",
    "refdes", "boardview", "kicad_pcb", "BRD2", "Test_Link", "XZZ", "TVW",
    "ElectricalGraph", "SimulationEngine", "Scout", "Registry", "Writers",
    "Auditor", "Cartographe", "Clinicien", "Lexicographe",
    "mb_", "bv_", "stock_", "cam_capture", "owner_ref",
    "Opus", "Sonnet", "Haiku", "claude-opus", "claude-sonnet", "claude-haiku",
    "messages.jsonl", "electrical_graph.json", "registry.json",
    "knowledge_graph.json", "rules.json", "dictionary.json", "audit_verdict.json",
    "parts_index.json", "simulator_reliability.json",
    "asyncio", "async", "await", "httpx", "pdfplumber",
    "CORS", "Origin", "Bearer", "Authorization",
    "KiCad", "pcbnew", "InstancedMesh", "Three.js", "WebGL",
    "FIFO", "OTP", "OTPM", "RAM", "CPU", "TCP", "SSE",
    "Phase", "Branch", "T9a", "T13",
    "self-host", "cloud", "wrenchboard-cloud",
    "DIAGNOSTIC_MODE", "managed", "direct", "tier", "deep", "normal", "fast",
    "force_rebuild", "allow_expand", "expand_blocked",
    "pipeline_started", "pipeline_finished", "pipeline_failed",
    "phase_started", "phase_finished", "phase_step",
    "stream_timeout", "stream_error", "requires_action",
    "is_error", "custom_tool_result", "custom_tool_use",
    "Levenshtein", "kebab-case",
    "GenCAD", "OpenBoardView",
    "OKLCH", "ESM", "D3",
    "pytest", "ruff",
    "noqa", "BLE001", "pragma",
    "type:", "ignore", "override",
    "Env:", "PIPELINE_", "ANTHROPIC_", "CORS_", "ENGINE_", "MA_",
    "macOS", "iPhone", "Mac",
    "ctrl", "Ctrl+Shift+R",
    "FileResponse", "JSONResponse", "HTTPException",
    "Settings", "BaseModel", "Field",
    "logger", "logging",
    "Path", "Pathlib",
    "None", "True", "False",
    "import", "from", "def", "class", "return", "raise", "yield",
    "Optional", "Literal",
    "messages.create", "tool_choice", "tool_use",
    "adaptive", "thinking", "xhigh",
    "query_graph", "mb_expand_knowledge", "bv_propose_protocol",
    "capture_request", "server.capture_request",
    "protocol_pending_confirmation",
    "memory_stores", "memory/{slug}",
    "uploads/", "board_assets/",
    "DEPLOYMENT.md", ".env",
    "503", "413", "400", "401", "402", "404", "500", "529",
    "base64", "PNG", "PDF",
    "Redis",
    "fan-out", "fire-and-forget",
    "dedup", "stampede",
    "ground-truth", "ground truth",
    "reviser", "re-audit",
    "drift", "orphan",
    "decompression-bomb",
    "backpressure",
    "fail-fast",
    "no-store", "max-age",
    "prewarm", "pre-warm",
    "runtime", "handshake",
    "websocat",
    "ISO-timestamp",
    "resolve()", "resolve_device",
    "paywall",
    "carnet",
    "curator", "KnowledgeCurator",
    "sub-agent", "subagent",
    "forwarder", "recv", "emit",
    "mirror", "jsonl",
    "Flow A", "Flow B",
    "image_ref",
    "conv_id", "conversation",
    "X-Owner-Ref", "X-Wb-Can-Expand",
    "set_board_ref",
    "noqa: BLE001",
]

# Manual translations for common patterns (avoid API calls for speed/quality)
MANUAL: dict[str, str] = {}


def _protect_terms(text: str) -> tuple[str, list[tuple[str, str]]]:
    replacements: list[tuple[str, str]] = []
    result = text
    for i, term in enumerate(KEEP_TERMS):
        if term in result:
            placeholder = f"__KEEP{i}__"
            replacements.append((placeholder, term))
            result = result.replace(term, placeholder)
    return result, replacements


def _restore_terms(text: str, replacements: list[tuple[str, str]]) -> str:
    result = text
    for placeholder, term in replacements:
        result = result.replace(placeholder, term)
    return result


def _translate_text(text: str) -> str:
    text = text.strip()
    if not text:
        return text
    if text in MANUAL:
        return MANUAL[text]
    protected, reps = _protect_terms(text)
    try:
        from deep_translator import GoogleTranslator
        translated = GoogleTranslator(source="en", target="zh-CN").translate(protected)
    except Exception:
        return text
    return _restore_terms(translated, reps)


def _translate_docstring_content(content: str) -> str:
    """Translate docstring body, preserving indentation."""
    lines = content.split("\n")
    if not lines:
        return content
    # Detect base indent of content lines
    content_lines = [l for l in lines if l.strip()]
    if not content_lines:
        return content
    min_indent = min(len(l) - len(l.lstrip()) for l in content_lines)
    translated_lines = []
    for line in lines:
        if not line.strip():
            translated_lines.append(line)
            continue
        indent = line[: len(line) - len(line.lstrip())]
        body = line.strip()
        translated_lines.append(indent + _translate_text(body))
    return "\n".join(translated_lines)


def _has_english_comment(text: str) -> bool:
    """Heuristic: line has meaningful English words."""
    if not text.strip():
        return False
    # Skip already-Chinese dominant lines
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    latin_words = re.findall(r"[A-Za-z]{3,}", text)
    if cjk > len(text) * 0.3:
        return False
    return len(latin_words) >= 2 or (len(latin_words) == 1 and len(latin_words[0]) > 4)


def translate_file(path: Path, *, dry_run: bool = False) -> bool:
    source = path.read_text(encoding="utf-8")
    original = source

    # Module docstring via AST
    try:
        tree = ast.parse(source)
    except SyntaxError:
        print(f"SKIP syntax error: {path}", file=sys.stderr)
        return False

    if (
        tree.body
        and isinstance(tree.body[0], ast.Expr)
        and isinstance(tree.body[0].value, ast.Constant)
        and isinstance(tree.body[0].value.value, str)
    ):
        doc = tree.body[0].value.value
        if _has_english_comment(doc):
            new_doc = _translate_docstring_content(doc)
            if new_doc != doc:
                # Replace only the first triple-quoted string
                m = re.match(
                    r'^(\s*(?:"""|\'\'\'))(.*?)(\3)\s*',
                    source,
                    re.DOTALL,
                )
                if m:
                    quote = m.group(1).strip()
                    source = quote + new_doc + quote + source[m.end():]

    # Function/class docstrings
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if (
                node.body
                and isinstance(node.body[0], ast.Expr)
                and isinstance(node.body[0].value, ast.Constant)
                and isinstance(node.body[0].value.value, str)
            ):
                doc = node.body[0].value.value
                if _has_english_comment(doc):
                    new_doc = _translate_docstring_content(doc)
                    if new_doc != doc:
                        # Find and replace this specific docstring
                        pattern = re.escape('"""' + doc + '"""')
                        source, n = re.subn(
                            '"""' + re.escape(doc) + '"""',
                            '"""' + new_doc + '"""',
                            source,
                            count=1,
                        )
                        if n == 0:
                            pattern = re.escape("'''" + doc + "'''")
                            source, _ = re.subn(
                                "'''" + re.escape(doc) + "'''",
                                "'''" + new_doc + "'''",
                                source,
                                count=1,
                            )

    # # comments via tokenize
    lines = source.splitlines(keepends=True)
    new_lines: list[str] = []
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("#"):
            comment_body = stripped[1:].rstrip("\n")
            if _has_english_comment(comment_body):
                # Preserve inline noqa etc
                noqa_m = re.search(r"\s+#\s*noqa\b.*$", comment_body)
                noqa_suffix = ""
                main = comment_body
                if noqa_m:
                    noqa_suffix = comment_body[noqa_m.start():]
                    main = comment_body[: noqa_m.start()].rstrip()
                translated = _translate_text(main)
                indent = line[: len(line) - len(stripped)]
                new_line = f"{indent}# {translated}{noqa_suffix}\n"
                if not line.endswith("\n"):
                    new_line = new_line.rstrip("\n")
                new_lines.append(new_line)
                continue
        new_lines.append(line)
    source = "".join(new_lines)

    if source != original:
        if not dry_run:
            path.write_text(source, encoding="utf-8")
        return True
    return False


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    targets = [API_ROOT]
    if len(sys.argv) > 1 and not sys.argv[1].startswith("-"):
        targets = [Path(p) for p in sys.argv[1:] if not p.startswith("-")]

    modified = 0
    for target in targets:
        files = sorted(target.rglob("*.py")) if target.is_dir() else [target]
        for f in files:
            if f.name == "__pycache__":
                continue
            try:
                if translate_file(f, dry_run=dry_run):
                    modified += 1
                    print(f"{'[dry] ' if dry_run else ''}translated: {f.relative_to(ROOT)}")
            except Exception as exc:
                print(f"ERROR {f}: {exc}", file=sys.stderr)
    print(f"\nModified: {modified} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
