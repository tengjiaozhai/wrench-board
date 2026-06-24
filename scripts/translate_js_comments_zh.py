#!/usr/bin/env python3
"""Translate // and /* */ comments in web/**/*.js to Chinese."""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

KEEP_PAT = re.compile(
    r"(WebSocket|device_slug|repair_id|slug|FastAPI|ESM|D3|Three\.js|WebGL|"
    r"boardview|tool_use|session_ready|client\.capabilities|cam_capture|"
    r"pipeline_started|phase_started|phase_finished|phase_step|phase_narration|"
    r"pipeline_finished|managed|direct|tier|deep|normal|fast|"
    r"mb_|bv_|stock_|repairHash|parseRoute|syncContextFromUrl|mountRoute|"
    r"initBoardview|Boardview|getBoardviewColors|requestAnimationFrame|"
    r"localStorage|sessionStorage|hashchange|deep-link|FOUC|UUID|"
    r"Files\+Vision|Flow A|Flow B|Pattern 4|Phase C|Phase D|Decision A|"
    r"brd_viewer\.js|pcb_viewer\.js|llm\.js|main\.js|router\.js|"
    r"features/repair/workspace\.js|protocol\.js|chatLog\.js|"
    r"ElectricalGraph|SimulationEngine|SimulationController|"
    r"Scout|Registry|Writers|Auditor|Cartographe|Clinicien|Lexicographe|"
    r"KiCad|Test_Link|BRD2|XZZ|refdes|InstancedMesh|Pickr|"
    r"Managed Agents|Anthropic|Opus|Sonnet|Haiku|"
    r"WrenchBoard|WrenchBoardCloud|__wbPlanHints|wb-hosted|"
    r"graphe|diagnostic|schematic|landing|onboarding|mascot|"
    r"Cmd\+K|Ctrl\+J|i18n|BCP-47|OKLCH|JetBrains|Inter|"
    r"forceX|force simulation|DOMContentLoaded|ResizeObserver|"
    r"getUserMedia|enumerateDevices|FileReader|innerHTML|textContent|"
    r"querySelector|querySelectorAll|addEventListener|classList|dataset|"
    r"history\.replaceState|encodeURIComponent|JSON\.stringify|JSON\.parse|"
    r"Intl|DateTimeFormat|Promise|async|await|"
    r"no-op|fail-open|fail-quiet|best-effort|fire-and-forget|round-trip|"
    r"idempotent|cache hit|cache miss|deep-link|cold-link|"
    r"SPOF|GND|QFP|BGA|SMPS|RF|mils|"
    r"Brut|Visuel|Mémoire|memoire|"
    r"topbar|metabar|statusbar|rail|railbar|workspace|inspector|tweaks|"
    r"sidebar|hero|overlay|drawer|stepper|timeline|popover|chip|"
    r"minimap|fitzoom|quest4|v=fitzoom|v=quest4)"
)


def needs_en(text: str) -> bool:
    text = text.strip()
    if not text:
        return False
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    if cjk > max(4, len(text) * 0.28):
        return False
    return bool(re.search(r"[A-Za-zÀ-ÿ]{3,}", text))


def protect(text: str) -> tuple[str, dict[str, str]]:
    reps: dict[str, str] = {}
    i = 0

    def repl(m: re.Match[str]) -> str:
        nonlocal i
        k = f"⟦{i}⟧"
        reps[k] = m.group(0)
        i += 1
        return k

    return KEEP_PAT.sub(repl, text), reps


def restore(text: str, reps: dict[str, str]) -> str:
    for k, v in reps.items():
        text = text.replace(k, v)
    return text


def translate_batch(texts: list[str]) -> list[str]:
    if not texts:
        return []
    out = list(texts)
    bs = 12
    from deep_translator import GoogleTranslator

    tr = GoogleTranslator(source="en", target="zh-CN")
    for i in range(0, len(texts), bs):
        chunk = texts[i : i + bs]
        protected: list[str] = []
        reps_list: list[dict[str, str]] = []
        for t in chunk:
            p, r = protect(t)
            protected.append(p)
            reps_list.append(r)
        joined = "\n⟦§⟧\n".join(protected)
        try:
            res = tr.translate(joined)
            parts = res.split("⟦§⟧")
            if len(parts) != len(chunk):
                parts = [tr.translate(p) for p in protected]
        except Exception:
            parts = chunk
        for j, (piece, reps) in enumerate(zip(parts, reps_list, strict=False)):
            out[i + j] = restore(piece.strip(), reps)
        time.sleep(0.1)
    return out


def collect_comments(source: str) -> tuple[list[str], list[tuple[str, int, int, str]]]:
    """Return (unique texts to translate, ops: kind, start, end, key)."""
    texts: list[str] = []
    index: dict[str, int] = {}
    ops: list[tuple[str, int, int, str]] = []

    def key_for(t: str) -> str:
        if t not in index:
            index[t] = len(texts)
            texts.append(t)
        return str(index[t])

    i, n = 0, len(source)
    while i < n:
        if source[i : i + 2] == "/*":
            end = source.find("*/", i + 2)
            if end == -1:
                break
            inner = source[i + 2 : end]
            if needs_en(inner):
                lead = re.match(r"^\s*", inner).group()
                trail = re.search(r"\s*$", inner).group()
                core = inner.strip()
                if core and needs_en(core):
                    k = key_for(core)
                    ops.append(("block", i + 2 + len(lead), end - len(trail), k, lead, trail))
            i = end + 2
            continue
        if source[i : i + 2] == "//":
            end = source.find("\n", i)
            if end == -1:
                end = n
            body = source[i + 2 : end]
            stripped = body.strip()
            if stripped and needs_en(stripped):
                lead = body[: len(body) - len(body.lstrip())]
                trail = body[len(body.rstrip()) :]
                k = key_for(stripped)
                ops.append(("line", i + 2 + len(lead), end - len(trail), k, lead, trail))
            i = end
            continue
        ch = source[i]
        if ch in ('"', "'", "`"):
            quote = ch
            j = i + 1
            while j < n:
                if source[j] == "\\":
                    j += 2
                    continue
                if source[j] == quote:
                    j += 1
                    break
                j += 1
            i = j
            continue
        i += 1
    return texts, ops


def apply_comments(source: str, translated: dict[str, str], ops: list) -> str:
    parts: list[str] = []
    last = 0
    for op in sorted(ops, key=lambda x: x[1]):
        kind, start, end, k, lead, trail = op
        parts.append(source[last:start])
        zh = translated[k]
        if kind == "block":
            parts.append(f"{lead}{zh}{trail}")
        else:
            parts.append(f"{lead}{zh}{trail}")
        last = end
    parts.append(source[last:])
    return "".join(parts)


def translate_js(source: str) -> str:
    texts, ops = collect_comments(source)
    if not texts:
        return source
    translated_list = translate_batch(texts)
    translated = {str(i): t for i, t in enumerate(translated_list)}
    return apply_comments(source, translated, ops)


def translate_file(path: Path) -> bool:
    orig = path.read_text(encoding="utf-8")
    new = translate_js(orig)
    if new != orig:
        path.write_text(new, encoding="utf-8")
        return True
    return False


def main() -> int:
    targets = [ROOT / "web"]
    if len(sys.argv) > 1:
        targets = [
            (ROOT / a).resolve() if not Path(a).is_absolute() else Path(a)
            for a in sys.argv[1:]
        ]
    modified = 0
    for t in targets:
        files = sorted(t.rglob("*.js")) if t.is_dir() else [t]
        for f in files:
            f = f.resolve()
            try:
                if translate_file(f):
                    modified += 1
                    print(f"translated: {f.relative_to(ROOT)}", flush=True)
            except Exception as e:
                print(f"ERROR {f}: {e}", file=sys.stderr)
    print(f"\nModified: {modified} files", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
