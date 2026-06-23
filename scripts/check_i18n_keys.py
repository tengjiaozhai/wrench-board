"""Validate three-way key alignment across en / fr / zh i18n dictionaries.

Checks:
  1. Every module has all three locale files.
  2. Flattened key paths are identical across locales (set equality).
  3. {placeholder} tokens match across locales for the same key.

Usage:
    python scripts/check_i18n_keys.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

MODULES_DIR = Path(__file__).resolve().parent.parent / "web" / "i18n" / "_modules"
LOCALES = ["en", "fr", "zh"]
PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z0-9_]+)\}")


def flatten(obj: dict, prefix: str = "") -> dict[str, str]:
    """Flatten nested dict into dotted key paths → string values."""
    out: dict[str, str] = {}
    for k, v in obj.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = str(v)
    return out


def check_module(module: str) -> list[str]:
    errors: list[str] = []
    files = {loc: MODULES_DIR / f"{module}.{loc}.json" for loc in LOCALES}

    missing = [loc for loc, p in files.items() if not p.exists()]
    if missing:
        return [f"{module}: missing locale files: {', '.join(missing)}"]

    dicts: dict[str, dict[str, str]] = {}
    for loc, path in files.items():
        with open(path, encoding="utf-8") as f:
            dicts[loc] = flatten(json.load(f))

    ref_keys = set(dicts["en"].keys())
    for loc in LOCALES[1:]:
        loc_keys = set(dicts[loc].keys())
        extra = loc_keys - ref_keys
        missing_keys = ref_keys - loc_keys
        if extra:
            errors.append(
                f"{module}.{loc}: extra keys not in en: {sorted(extra)}"
            )
        if missing_keys:
            errors.append(
                f"{module}.{loc}: keys missing vs en: {sorted(missing_keys)}"
            )

    for loc in LOCALES[1:]:
        for key in ref_keys & set(dicts[loc].keys()):
            en_placeholders = set(PLACEHOLDER_RE.findall(dicts["en"][key]))
            loc_placeholders = set(PLACEHOLDER_RE.findall(dicts[loc][key]))
            if en_placeholders != loc_placeholders:
                errors.append(
                    f"{module}.{loc}[{key}]: placeholders mismatch "
                    f"en={sorted(en_placeholders)} "
                    f"{loc}={sorted(loc_placeholders)}"
                )

    return errors


def main() -> int:
    modules = sorted(
        {p.stem.split(".")[0] for p in MODULES_DIR.glob("*.en.json")}
    )
    all_errors: list[str] = []
    for mod in modules:
        all_errors.extend(check_module(mod))

    if all_errors:
        print(f"FAILED — {len(all_errors)} error(s):")
        for e in all_errors:
            print(f"  ✗ {e}")
        return 1
    print(f"OK — {len(modules)} modules, {LOCALES} all aligned.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
