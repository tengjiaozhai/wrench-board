#!/usr/bin/env python3
"""Translate // and /* */ comments in web/js/*.js (+ brd_viewer.js) to Chinese.

Skips web/js/features/global/landing/index.js.
Preserves technical tokens (WebSocket, slug, repair_id, etc.) via placeholders.
"""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

from deep_translator import GoogleTranslator

ROOT = Path(__file__).resolve().parents[1]
SKIP = {ROOT / "web/js/features/global/landing/index.js"}

# Terms to keep as-is (case-sensitive placeholders restored after translation)
KEEP_TERMS = [
    "WebSocket", "webSocket", "websocket",
    "device_slug", "repair_id", "slug", "pipeline", "fetch", "POST", "GET", "PUT", "DELETE",
    "FormData", "URLSearchParams", "localStorage", "sessionStorage",
    "innerHTML", "textContent", "requestAnimationFrame", "DOMContentLoaded",
    "ResizeObserver", "getUserMedia", "enumerateDevices", "FileReader",
    "Managed Agents", "FastAPI", "ESM", "D3", "Three.js", "WebGL", "SVG",
    "JSON", "HTTP", "HTTPS", "WS", "API", "UI", "CDN", "MIT",
    "i18n", "BCP-47", "OKLCH", "HEX", "RGBA", "RGB",
    "repairHash", "parseRoute", "syncContextFromUrl", "mountRoute",
    "pipeline_started", "device_label", "force_rebuild",
    "mb_", "bv_", "stock_", "cam_capture",
    "Phase C", "Phase D", "Phase B",
    "brd_viewer.js", "pcb_viewer.js", "pipelineSocket.js", "llm.js",
    "main.js", "router.js", "home.js", "graph.js", "schematic.js",
    "features/repair/workspace.js", "shared/context.js", "shared/api.js",
    "shared/dom.js", "protocol.js", "chatLog.js", "filesVision.js",
    "diagnosticSocket.js", "pipeline_progress.js", "memory_bank.js",
    "Boardview", "initBoardview", "getBoardviewColors", "setBoardviewNetColor",
    "Pickr", "InstancedMesh", "Test_Link", "kicad_pcb", "BRD2",
    "refdes", "net_diagnostics", "electrical_graph", "schematic_pdf",
    "parts_index", "knowledge_graph", "audit_verdict", "raw_research_dump",
    "has_registry", "has_rules", "has_dictionary", "has_boardview",
    "has_schematic_pdf", "has_electrical_graph", "has_knowledge_graph",
    "has_audit_verdict", "has_parts_index",
    "client.capabilities", "client.upload_macro", "client.capture_response",
    "client.protocol_confirmation", "session_ready", "tool_use",
    "protocol_pending_confirmation", "protocol_confirmation_timeout",
    "server.capture_request", "server.upload_macro_error", "session_terminated",
    "validation.start", "simulation.repair_validated",
    "phase_started", "phase_finished", "phase_step", "phase_narration",
    "pipeline_finished", "pipeline_failed", "pipeline_paused",
    "needs_kind_confirmation", "packedOnly", "planHints", "hideUploads",
    "wb-hosted", "wb:profile-updated", "wb:unauthorized", "wb_onboarding_seen",
    "wb_first_diag_seen", "__wbPlanHints", "__diagnosticWS", "__pending",
    "data-i18n", "data-cat", "data-section", "data-rail", "data-view",
    "aria-expanded", "aria-pressed", "aria-hidden", "aria-label",
    "console.log", "console.warn", "console.error",
    "Intl", "DateTimeFormat", "Promise", "async", "await", "Map", "Set",
    "null", "true", "false", "undefined", "typeof", "instanceof",
    "location.hash", "location.href", "location.assign", "location.reload",
    "history.replaceState", "hashchange", "stopPropagation", "stopImmediatePropagation",
    "preventDefault", "requestSubmit", "classList", "dataset", "getElementById",
    "querySelector", "querySelectorAll", "addEventListener", "removeEventListener",
    "encodeURIComponent", "decodeURIComponent", "JSON.stringify", "JSON.parse",
    "readyState", "OPEN", "CLOSED", "CONNECTING",
    "tailwind", "DOMPurify", "marked", "pdfplumber",
    "Opus", "Sonnet", "Haiku", "Anthropic",
    "Managed", "direct", "tier", "deep", "normal", "fast",
    "diagnostic", "schematic", "graphe", "pcb", "stock", "profile", "landing",
    "memory-bank", "memoryBank", "canvas", "tweaksPanel", "llm-open", "llm-open",
    "show-landing", "pending-landing", "no-metabar", "has-focus",
    "SimulationEngine", "SimulationController", "ElectricalGraph",
    "Scout", "Registry", "Writers", "Auditor", "Cartographe", "Clinicien",
    "Lexicographe", "expand", "orchestrator", "events.publish",
    "RepairResponse", "TaxonomyTree", "RepairSummary",
    "X-Owner-Ref", "XZZ", "SPOF", "FOUC", "ETA", "UUID",
    "Cmd+K", "Ctrl+J", "Enter", "Escape", "Tab", "ArrowDown", "ArrowUp",
    "mousedown", "keydown", "hashchange", "devicechange", "blur", "focus",
    "click", "input", "change", "submit", "load",
    "self-host", "cloud", "front-door", "402", "401", "200", "404", "500",
    "gitignored", "managed_ids.json", "pytest", "uvicorn", "FastAPI",
    "Pydantic", "Levenshtein", "refdes-shaped",
    "Decision A", "C.1", "C.3", "C.6", "C11", "D.1", "D.2",
    "T9a", "Files+Vision", "Flow A", "Flow B", "Pattern 4",
    "Quest", "quest", "wizard", "floating", "tracker", "popover", "chip",
    "Brut", "Visuel", "Mémoire", "memoire",
    "KiCad", "OrCAD", "Altium", "Apple", "Samsung", "ThinkPad",
    "GND", "QFP", "BGA", "SoM", "SoC", "SMPS", "RF",
    "mils", "px", "mm", "KB", "MB", "GB",
    "bg-deep", "bg-2", "panel-2", "text-3", "border-soft", "border-hover",
    "currentColor", "viewBox", "stroke-width", "stroke-linecap", "stroke-linejoin",
    "forceX", "force simulation", "d3", "force simulation",
    "commit", "bootstrap", "IIFE", "no-op", "fail-open", "fail-quiet",
    "best-effort", "fire-and-forget", "round-trip", "deep-link",
    "cold-link", "cache hit", "cache miss", "idempotent",
    "slugification", "re-slugification", "disambiguation",
    "donor", "harvest", "inventory", "parts_index",
    "onboarding", "coaching", "demo", "replay", "narrated",
    "topbar", "metabar", "statusbar", "rail", "railbar", "workspace",
    "inspector", "tweaks", "tooltip", "modal", "backdrop", "toast",
    "sidebar", "hero", "cockpit", "overlay", "drawer", "stepper",
    "timeline", "narrator", "mascot", "bubble", "gallery",
    "taxonomy", "registry", "dictionary", "rules", "findings",
    "conversations", "dashboard", "journal", "repair",
    "boardview", "board", "schematic", "graph", "profile", "stock",
    "agent", "runtime", "manifest", "sanitize", "validator",
    "highlight", "focus", "annotate", "protocol", "measurement",
    "hypothesize", "simulate", "expand_knowledge",
    "Linux", "macOS", "Windows", "Chrome", "Firefox", "Safari",
    "npm", "Makefile", "pytest", "ruff",
    "LICENSE", "CLAUDE.md", "README.md", "ARCHITECTURE.md",
    "index.html", "tokens.css", "layout.css", "onboarding.css",
    "pipeline_progress.css", "memory_bank.css", "graph.css", "llm.css",
    "brd.css", "modal.css", "stub.css", "home.css", "pipeline_progress",
    "landing.css", "profile.css", "stock.css", "schematic.css",
    "googleapis.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "d3js.org",
    "fonts.googleapis.com", "cdn.tailwindcss.com",
    "wrench-board", "WrenchBoard", "WrenchBoardCloud",
    "microsolder-evolve", "evolve:", "feat:", "fix:", "refactor:", "chore:", "docs:", "test:",
    "make install", "make run", "make test", "make test-all", "make lint", "make format", "make clean",
    ".venv", ".env", ".env.example", "ANTHROPIC_API_KEY", "DIAGNOSTIC_MODE",
    "managed", "direct", "deep", "normal", "fast",
    "claude-opus-4-7", "claude-haiku-4-5", "claude-sonnet",
    "agent-native", "knowledge factory", "diagnostic conversation",
    "memory bank", "Memory Bank", "knowledge pack", "knowledge graph",
    "field report", "field reports", "repair session", "repair sessions",
    "donor board", "donor boards", "salvage", "safety filter",
    "boot sequence", "simulator", "hypothesize", "bench-generator",
    "simulator_reliability.json", "parts_index.json", "active_sources.json",
    "board_assets", "memory/", "api/", "web/", "tests/", "scripts/",
    "benchmark/", "docs/", "boardview", "board view", "PCB", "PCB viewer",
    "schematic viewer", "schematic canvas", "schematic inspector",
    "graph view", "graph payload", "force layout", "column band",
    "symptom", "component", "net", "action", "amber", "cyan", "emerald", "violet",
    "OKLCH", "Inter", "JetBrains Mono", "JetBrains",
    "French", "English", "Chinese", "Hindi", "Simplified Chinese",
    "en", "fr", "zh", "hi", "en-US", "fr-FR", "zh-CN",
    "landing/index.js", "landing.js", "onboarding.js", "timeline.js",
    "profile_modal.js", "profile_menu.js", "catalogue.js",
    "workspace.js", "dashboard.js", "chatLog.js", "chatMarkup.js",
    "coaching.js", "costDisplay.js", "demoReplay.js", "filesVision.js", "toolPhrases.js",
    "camera.js", "camera_preview.js", "cloud_hints.js", "icons.js", "info_modal.js",
    "i18n.js", "landing.js", "llm.js", "main.js", "mascot.js", "mascot_bubble.js",
    "mascot_gallery.js", "mascot_states.js", "memory_bank.js", "onboarding_state.js",
    "pcb_viewer.js", "pcb_viewer_bridge.js", "pipeline_progress.js", "profile.js",
    "protocol.js", "router.js", "schematic.js", "schematic_minimap.js", "stock.js", "store.js",
    "brd_viewer.js", "graph.js", "home.js",
    "pipelineSocket.js", "diagnosticSocket.js", "deviceCatalog.js", "packs.js", "repairs.js",
    "context.js", "api.js", "dom.js",
    "progress_ws", "create_repair", "create_task", "_run_pipeline_with_events",
    "subscribe", "publish", "emit", "orchestrator", "repairs.py", "events.py", "progress.py",
    "models.py", "schemas.py", "tool_call.py", "runtime_managed.py", "runtime_direct.py",
    "dispatch_bv.py", "ws_events.py", "sanitize.py", "chat_history.py", "memory_seed.py",
    "reliability.py", "expansion.py", "field_reports.py", "manifest.py", "tools.py",
    "parser_for", "part_by_refdes", "net_by_name", "SessionState", "Board", "Layer",
    "LAYER_TOP", "LAYER_BOTTOM", "InstancedMesh", "InstancedBufferAttribute",
    "OrthographicCamera", "WebGLRenderer", "Scene", "Group", "Mesh", "Line", "Sprite",
    "Raycaster", "Vector2", "Vector3", "Box3", "Color", "CanvasTexture",
    "minimap", "fitzoom", "quest4", "fitzoom", "quest4",
    "v=fitzoom", "v=quest4", "?v=fitzoom", "?v=quest4",
    "silent", "noop", "no-op", "TODO", "FIXME", "NOTE", "HACK", "XXX",
    "eslint", "prettier", "ruff", "pytest", "asyncio", "gather", "create_task",
    "BackgroundTasks", "WebSocketDisconnect", "APIRouter", "HTTPException",
    "BaseModel", "Field", "validator", "model_post_init", "PrivateAttr",
    "Optional", "Union", "List", "Dict", "Set", "Tuple", "Any", "Literal",
    "TypeVar", "Generic", "Protocol", "TypedDict", "NamedTuple", "Enum", "IntEnum", "IntFlag",
    "dataclass", "field", "staticmethod", "classmethod", "property", "abstractmethod",
    "contextmanager", "lru_cache", "cached_property", "functools", "itertools",
    "collections", "pathlib", "typing", "enum", "json", "os", "sys", "re", "math",
    "logging", "asyncio", "threading", "multiprocessing", "subprocess", "shutil",
    "tempfile", "uuid", "hashlib", "base64", "urllib", "http", "socket", "ssl",
    "email", "datetime", "time", "calendar", "zoneinfo", "locale",
]

# Sort longest first for placeholder matching
KEEP_TERMS = sorted(set(KEEP_TERMS), key=len, reverse=True)

PLACEHOLDER_RE = re.compile(r"⟦(\d+)⟧")
CJK_RE = re.compile(r"[\u4e00-\u9fff]")

translator = GoogleTranslator(source="auto", target="zh-CN")


def protect_terms(text: str) -> tuple[str, list[str]]:
    terms: list[str] = []
    out = text
    for term in KEEP_TERMS:
        if term in out:
            idx = len(terms)
            terms.append(term)
            out = out.replace(term, f"⟦{idx}⟧")
    return out, terms


def restore_terms(text: str, terms: list[str]) -> str:
    def repl(m: re.Match[str]) -> str:
        i = int(m.group(1))
        return terms[i] if 0 <= i < len(terms) else m.group(0)
    return PLACEHOLDER_RE.sub(repl, text)


def needs_translation(text: str) -> bool:
    t = text.strip()
    if not t:
        return False
    # Already mostly Chinese
    cjk = len(CJK_RE.findall(t))
    latin = len(re.findall(r"[A-Za-z]{3,}", t))
    if cjk >= 2 and latin <= 4:
        return False
    # French/English signal
    if re.search(r"[A-Za-zÀ-ÿ]{4,}", t):
        return True
    return False


def translate_text(text: str) -> str:
    protected, terms = protect_terms(text)
    try:
        zh = translator.translate(protected)
    except Exception as e:
        print(f"  [warn] translate failed: {e!r} for {text[:60]!r}", file=sys.stderr)
        return text
    time.sleep(0.05)  # gentle rate limit
    return restore_terms(zh, terms)


class CommentTranslator:
    def __init__(self) -> None:
        self.count = 0
        self.cache: dict[str, str] = {}

    def tr(self, text: str) -> str:
        key = text.strip()
        if not needs_translation(key):
            return text
        if key in self.cache:
            translated = self.cache[key]
        else:
            translated = translate_text(key)
            self.cache[key] = translated
            self.count += 1
        # preserve leading/trailing whitespace of original line content
        lead = len(text) - len(text.lstrip())
        trail = len(text) - len(text.rstrip())
        return (" " * lead) + translated + (" " * (trail - lead) if trail > lead else "")


def process_file(path: Path, ct: CommentTranslator) -> bool:
    if path in SKIP:
        return False
    src = path.read_text(encoding="utf-8")
    out: list[str] = []
    i = 0
    n = len(src)
    changed = False

    while i < n:
        ch = src[i]
        # string literals — skip
        if ch in "'\"`":
            quote = ch
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == quote:
                    j += 1
                    break
                j += 1
            out.append(src[i:j])
            i = j
            continue

        # line comment
        if ch == "/" and i + 1 < n and src[i + 1] == "/":
            j = i + 2
            while j < n and src[j] != "\n":
                j += 1
            comment_body = src[i + 2 : j]
            if needs_translation(comment_body):
                new_body = ct.tr(comment_body)
                if new_body != comment_body:
                    changed = True
                out.append("//" + new_body)
            else:
                out.append(src[i:j])
            i = j
            continue

        # block comment
        if ch == "/" and i + 1 < n and src[i + 1] == "*":
            j = i + 2
            while j + 1 < n and not (src[j] == "*" and src[j + 1] == "/"):
                j += 1
            j = min(j + 2, n)
            inner = src[i + 2 : j - 2]
            # multiline block: translate line by line inside
            lines = inner.split("\n")
            new_lines = []
            block_changed = False
            for line in lines:
                # strip leading " * " prefix for block comments
                m = re.match(r"^(\s*\*?\s?)(.*)$", line)
                if m:
                    prefix, body = m.group(1), m.group(2)
                    if needs_translation(body):
                        nb = ct.tr(body)
                        if nb != body:
                            block_changed = True
                        new_lines.append(prefix + nb)
                    else:
                        new_lines.append(line)
                else:
                    new_lines.append(line)
            if block_changed:
                changed = True
                out.append("/*" + "\n".join(new_lines) + "*/")
            else:
                out.append(src[i:j])
            i = j
            continue

        out.append(ch)
        i += 1

    if changed:
        path.write_text("".join(out), encoding="utf-8")
    return changed


def main() -> None:
    files: list[Path] = []
    js_root = ROOT / "web/js"
    for p in sorted(js_root.rglob("*.js")):
        if p not in SKIP:
            files.append(p)
    brd = ROOT / "web/brd_viewer.js"
    if brd.exists():
        files.append(brd)

    ct = CommentTranslator()
    modified: list[str] = []
    per_file: dict[str, int] = {}

    for path in files:
        before = ct.count
        if process_file(path, ct):
            modified.append(str(path.relative_to(ROOT)))
            per_file[str(path.relative_to(ROOT))] = ct.count - before
        print(f"{'✓' if path.relative_to(ROOT) in modified else '·'} {path.relative_to(ROOT)}", flush=True)

    result = {
        "files_modified": modified,
        "total_comments_translated": ct.count,
        "per_file": per_file,
    }
    print("\n" + __import__("json").dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
