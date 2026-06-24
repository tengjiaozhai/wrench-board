#!/usr/bin/env python3
"""Translate comments in tests/*.py, scripts/*.py, web/styles/*.css, web/index.html to Chinese.

Only comments — never string literals or identifiers.
Preserves technical tokens via placeholders (shared with translate_py_comments_zh.py).
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

from deep_translator import GoogleTranslator

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from translate_py_comments_zh import KEEP_TERMS, _has_english, _protect, _restore  # noqa: E402

_SKIP_SCRIPTS = {
    "translate_py_css_html_comments_zh.py",
    "translate_py_comments_zh.py",
    "translate_js_comments_zh.py",
}


def translate_text_with_retry(text: str, attempts: int = 6) -> str:
    text = text.strip()
    if not text or not _has_english(text):
        return text
    protected, reps = _protect(text)
    delay = 0.2
    for attempt in range(attempts):
        try:
            out = GoogleTranslator(source="auto", target="zh-CN").translate(protected)
            time.sleep(0.12)
            return _restore(out, reps)
        except Exception as e:
            if attempt + 1 == attempts:
                print(f"  [warn] translate failed: {e!r} for {text[:60]!r}", file=sys.stderr)
                return text
            time.sleep(delay)
            delay = min(delay * 1.8, 3.0)
    return text


class CommentTranslator:
    def __init__(self) -> None:
        self.count = 0
        self.cache: dict[str, str] = {}

    def tr(self, text: str) -> str:
        key = text.strip()
        if not _has_english(key):
            return text
        if key in self.cache:
            translated = self.cache[key]
        else:
            translated = translate_text_with_retry(key)
            self.cache[key] = translated
            self.count += 1
        lead = len(text) - len(text.lstrip())
        trail = len(text) - len(text.rstrip())
        return (" " * lead) + translated + (" " * (trail - lead) if trail > lead else "")


def process_python_file(path: Path, ct: CommentTranslator) -> bool:
    src = path.read_text(encoding="utf-8")
    out: list[str] = []
    i = 0
    n = len(src)
    changed = False

    while i < n:
        ch = src[i]

        if ch in "'\"":
            quote = ch
            j = i + 1
            triple = i + 2 < n and src[i + 1] == quote and src[i + 2] == quote
            if triple:
                j = i + 3
                while j + 2 < n and not (src[j] == quote and src[j + 1] == quote and src[j + 2] == quote):
                    if src[j] == "\\":
                        j += 2
                        continue
                    j += 1
                j = min(j + 3, n)
            else:
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

        if ch == "#":
            j = i + 1
            while j < n and src[j] != "\n":
                j += 1
            comment_body = src[i + 1 : j]
            if i == 0 and comment_body.startswith("!"):
                out.append(src[i:j])
            elif _has_english(comment_body):
                noqa = ""
                m = re.search(r"\s+#\s*noqa\b.*$", comment_body)
                if m:
                    noqa = comment_body[m.start() :]
                    comment_body = comment_body[: m.start()].rstrip()
                new_body = ct.tr(comment_body)
                if new_body != comment_body or noqa:
                    if new_body != comment_body:
                        changed = True
                    out.append("#" + new_body + noqa)
                else:
                    out.append(src[i:j])
            else:
                out.append(src[i:j])
            i = j
            continue

        out.append(ch)
        i += 1

    if changed:
        path.write_text("".join(out), encoding="utf-8")
    return changed


def process_css_file(path: Path, ct: CommentTranslator) -> bool:
    src = path.read_text(encoding="utf-8")
    out: list[str] = []
    i = 0
    n = len(src)
    changed = False

    while i < n:
        ch = src[i]

        if ch in "'\"":
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

        if ch == "/" and i + 1 < n and src[i + 1] == "*":
            j = i + 2
            while j + 1 < n and not (src[j] == "*" and src[j + 1] == "/"):
                j += 1
            j = min(j + 2, n)
            inner = src[i + 2 : j - 2]
            if _has_english(inner):
                lead = re.match(r"^\s*", inner).group()
                trail = re.search(r"\s*$", inner).group()
                core = inner.strip()
                if core and _has_english(core):
                    new_core = ct.tr(core)
                    if new_core != core:
                        changed = True
                    out.append(f"/*{lead}{new_core}{trail}*/")
                else:
                    out.append(src[i:j])
            else:
                out.append(src[i:j])
            i = j
            continue

        out.append(ch)
        i += 1

    if changed:
        path.write_text("".join(out), encoding="utf-8")
    return changed


def process_html_file(path: Path, ct: CommentTranslator) -> bool:
    src = path.read_text(encoding="utf-8")
    out: list[str] = []
    i = 0
    n = len(src)
    changed = False

    while i < n:
        if src.startswith("<!--", i):
            j = i + 4
            while j + 2 < n and not src.startswith("-->", j):
                j += 1
            j = min(j + 3, n)
            inner = src[i + 4 : j - 3]
            if _has_english(inner):
                lines = inner.split("\n")
                new_lines = []
                block_changed = False
                for line in lines:
                    if _has_english(line):
                        nl = ct.tr(line)
                        if nl != line:
                            block_changed = True
                        new_lines.append(nl)
                    else:
                        new_lines.append(line)
                if block_changed:
                    changed = True
                    out.append("<!--" + "\n".join(new_lines) + "-->")
                else:
                    out.append(src[i:j])
            else:
                out.append(src[i:j])
            i = j
            continue

        if src.startswith("<script", i) or src.startswith("<style", i):
            tag_end = src.find(">", i)
            if tag_end == -1:
                out.append(src[i])
                i += 1
                continue
            close = "</script>" if src.startswith("<script", i) else "</style>"
            close_idx = src.find(close, tag_end + 1)
            if close_idx == -1:
                out.append(src[i])
                i += 1
                continue
            out.append(src[i : close_idx + len(close)])
            i = close_idx + len(close)
            continue

        out.append(src[i])
        i += 1

    if changed:
        path.write_text("".join(out), encoding="utf-8")
    return changed


def collect_files() -> list[tuple[Path, str]]:
    files: list[tuple[Path, str]] = []
    for p in sorted((ROOT / "tests").rglob("*.py")):
        files.append((p, "py"))
    for p in sorted((ROOT / "scripts").rglob("*.py")):
        if p.name in _SKIP_SCRIPTS:
            continue
        files.append((p, "py"))
    for p in sorted((ROOT / "web/styles").rglob("*.css")):
        files.append((p, "css"))
    idx = ROOT / "web/index.html"
    if idx.exists():
        files.append((idx, "html"))
    return files


def main() -> None:
    ct = CommentTranslator()
    modified: list[str] = []

    for path, kind in collect_files():
        if kind == "py":
            ok = process_python_file(path, ct)
        elif kind == "css":
            ok = process_css_file(path, ct)
        else:
            ok = process_html_file(path, ct)
        rel = str(path.relative_to(ROOT))
        if ok:
            modified.append(rel)
        print(f"{'✓' if ok else '·'} {rel}", flush=True)

    result = {
        "files_modified": len(modified),
        "paths": modified,
        "total_comments_translated": ct.count,
    }
    print("\n" + json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
