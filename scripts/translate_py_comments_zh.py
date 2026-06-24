#!/usr/bin/env python3
"""Batch-translate # comments and docstrings in api/**/*.py to Chinese."""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SKIP = {
    "api/config.py",
    "api/main.py",
    "api/pipeline/tool_call.py",
    "api/pipeline/models.py",
    "api/pipeline/events.py",
    "api/pipeline/routes/repairs.py",
}

KEEP_PAT = re.compile(
    r"(WebSocket|device_slug|repair_id|slug|FastAPI|Pydantic|AsyncAnthropic|"
    r"refdes|boardview|tool_choice|tool_use|tool_result|is_error|noqa|BLE001|"
    r"self-host|Managed Agents|asyncio|httpx|Opus|Sonnet|Haiku|query_graph|"
    r"mb_|bv_|stock_|owner_ref|messages\.jsonl|electrical_graph\.json|"
    r"pipeline_started|phase_started|HTTP|API|JSON|CORS|Bearer|KiCad|pcbnew|"
    r"max_retries|ValidationError|wrenchboard-cloud|DIAGNOSTIC_MODE|"
    r"capture_request|requires_action|memory_stores|jsonl|forwarder|"
    r"ElectricalGraph|SimulationEngine|Scout|Registry|Writers|Auditor|"
    r"T9a|T13|create_repair|events\.publish|orchestrator|build_state|"
    r"list_repairs|board_delta|cross-tenant|normalize_board_number|"
    r"runtime_direct|runtime_managed|fire-and-forget|fan-out|dedup|"
    r"backpressure|fail-fast|prewarm|RemoteProtocolError|page_vision|"
    r"max_tokens|cache_read|submit_tool|pdfplumber|ground-truth|reviser|"
    r"APPROVED|REJECTED|drift|orphan|baseline/|_staged/|PLC0415|E501|"
    r"B008|F821|type: ignore|override|DEPLOYMENT\.md|\.env|"
    r"claude-opus|claude-sonnet|messages\.create|mb_expand_knowledge|"
    r"bv_propose_protocol|custom_tool_result|stream_timeout|X-Owner-Ref|"
    r"conv_id|allow_expand|force_rebuild|expand_blocked|pipeline_kind|"
    r"matched_rule_id|coverage_reason|needs_disambiguation|FIFO|OTPM|"
    r"Flow A|Flow B|KnowledgeCurator|websocat|paywall|carnet|"
    r"GenCAD|Test_Link|BRD2|XZZ|TVW|adaptive|thinking|xhigh|"
    r"ISO-timestamp|resolve\(\)|kebab-case|Ctrl\+Shift\+R|no-store|"
    r"FileResponse|JSONResponse|HTTPException|uvicorn|Opus 4\.7|4\.7/4\.8)"
)


def needs_en(text: str) -> bool:
    text = text.strip()
    if not text:
        return False
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    if cjk > max(4, len(text) * 0.28):
        return False
    return bool(re.search(r"[A-Za-z]{3,}", text))


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
        protected = []
        reps_list = []
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
        time.sleep(0.12)
    return out


def translate_file_content(source: str) -> str:
    pending: list[str] = []
    ops: list[tuple[str, object]] = []

    # docstrings first
    for m in re.finditer(r'("""|\'\'\')(.*?)\1', source, re.DOTALL):
        body = m.group(2)
        if needs_en(body):
            idx = len(pending)
            pending.append(body)
            ops.append(("doc", m.start(2), m.end(2), idx))

    lines = source.splitlines(keepends=True)
    for li, line in enumerate(lines):
        s = line.lstrip()
        if not s.startswith("#"):
            continue
        body = s[1:]
        noqa = ""
        nm = re.search(r"\s+#\s*noqa\b.*$", body)
        if nm:
            noqa = body[nm.start():]
            body = body[: nm.start()]
        if needs_en(body):
            idx = len(pending)
            pending.append(body.rstrip("\n"))
            ops.append(("line", li, noqa, idx))

    if not pending:
        return source

    translated = translate_batch(pending)
    new_lines = list(lines)

    # apply docstrings end-to-start
    doc_ops = [(s, e, idx) for kind, s, e, idx in ops if kind == "doc"]
    result = source
    for s, e, idx in sorted(doc_ops, key=lambda x: x[0], reverse=True):
        result = result[:s] + translated[idx] + result[e:]

    for kind, *rest in ops:
        if kind != "line":
            continue
        li, noqa, idx = rest  # type: ignore[misc]
        line = new_lines[li]
        s = line.lstrip()
        indent = line[: len(line) - len(s)]
        nl = "\n" if line.endswith("\n") else ""
        new_lines[li] = f"{indent}# {translated[idx].lstrip()}{noqa}{nl}"

    if any(k == "line" for k, *_ in ops):
        # rebuild from lines if we had line ops — doc already in result
        # simpler: only line ops path
        if not doc_ops:
            return "".join(new_lines)
        # mixed: start from result lines
        result_lines = result.splitlines(keepends=True)
        for kind, *rest in ops:
            if kind != "line":
                continue
            li, noqa, idx = rest  # type: ignore[misc]
            line = result_lines[li]
            s = line.lstrip()
            indent = line[: len(line) - len(s)]
            nl = "\n" if line.endswith("\n") else ""
            result_lines[li] = f"{indent}# {translated[idx].lstrip()}{noqa}{nl}"
        return "".join(result_lines)

    return "".join(new_lines) if not doc_ops else result


def translate_file(path: Path) -> bool:
    rel = str(path.resolve().relative_to(ROOT.resolve())).replace("\\", "/")
    if rel in SKIP:
        return False
    orig = path.read_text(encoding="utf-8")
    try:
        new = translate_file_content(orig)
    except Exception as exc:
        print(f"ERROR {rel}: {exc}", file=sys.stderr)
        return False
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
        files = sorted(t.rglob("*.py")) if t.is_dir() else [t]
        for f in files:
            if translate_file(f):
                modified += 1
                print(f"translated: {f.relative_to(root)}", flush=True)
    print(f"\nModified: {modified} files", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
