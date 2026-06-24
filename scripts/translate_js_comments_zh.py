#!/usr/bin/env python3
"""Translate // and /* */ comments in web/**/*.js to Chinese."""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Reuse term protection from the Python translator
sys.path.insert(0, str(ROOT / "scripts"))
from translate_py_comments_zh import KEEP_TERMS, _protect, _restore, _has_english  # noqa: E402


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


def translate_js(source: str) -> str:
    out: list[str] = []
    i = 0
    n = len(source)
    while i < n:
        # Block comment
        if source[i : i + 2] == "/*":
            end = source.find("*/", i + 2)
            if end == -1:
                out.append(source[i:])
                break
            block = source[i : end + 2]
            inner = block[2:-2]
            if _has_english(inner):
                # Preserve leading/trailing whitespace inside block
                lead = re.match(r"^\s*", inner).group()
                trail = re.search(r"\s*$", inner).group()
                core = inner.strip()
                if core and _has_english(core):
                    core = _translate(core)
                block = f"/*{lead}{core}{trail}*/"
            out.append(block)
            i = end + 2
            continue
        # Line comment
        if source[i : i + 2] == "//":
            end = source.find("\n", i)
            if end == -1:
                line = source[i:]
                body = line[2:]
                if _has_english(body):
                    body = " " + _translate(body.strip()) if body.strip() else body
                out.append("//" + body)
                break
            line = source[i:end]
            body = line[2:]
            if _has_english(body):
                body = " " + _translate(body.strip()) if body.strip() else body
            out.append("//" + body)
            i = end
            continue
        # String literal — skip
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
            out.append(source[i:j])
            i = j
            continue
        out.append(ch)
        i += 1
    return "".join(out)


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
        targets = [(ROOT / a).resolve() if not Path(a).is_absolute() else Path(a) for a in sys.argv[1:]]
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
