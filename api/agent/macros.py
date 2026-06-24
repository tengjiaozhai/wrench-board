"""宏图像的持久性助手。

宏位于``memory/{`manual`}/repairs/{`。
两个来源：

  - `}/macros/{ts}_{source}.{ext}``。
两个来源：

  - “手册”：通过聊天面板拖放或上传技术（Flow A）
  -``capture``：代理名为``⟦PRESERVE0⟧``，前端通过
    获取用户媒体 (Flow B)

路径布局在前端的重放路径上是mirrored
(``GET /api/macros/{⟦PRESERVE2⟧}/{⟦PRESERVE1⟧}/{文件名}``）。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Literal

Source = Literal["manual", "capture"]

_EXT_FROM_MIME: dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


def persist_macro(
    *,
    memory_root: Path,
    slug: str,
    repair_id: str,
    source: str,
    bytes_: bytes,
    mime: str,
) -> Path:
    """在未知 mime 或无效源上在 ``macros/{ts}_{source}.{ext}`` 下写入 ``bytes_`` 并返回路径。

    如果缺少，则创建宏 directory。消除同一秒的歧义
    与数字后缀的冲突。

    引发:class:`ValueError`。
"""
    if source not in ("manual", "capture"):
        raise ValueError(f"source must be 'manual' or 'capture', got {source!r}")
    ext = _EXT_FROM_MIME.get(mime.lower())
    if ext is None:
        raise ValueError(f"unsupported mime: {mime!r}")
    macros_dir = memory_root / slug / "repairs" / repair_id / "macros"
    macros_dir.mkdir(parents=True, exist_ok=True)
    ts = int(time.time())
    path = macros_dir / f"{ts}_{source}{ext}"
    counter = 1
    while path.exists():
        path = macros_dir / f"{ts}_{source}_{counter}{ext}"
        counter += 1
    path.write_bytes(bytes_)
    return path


def macro_path_for(
    *,
    memory_root: Path,
    slug: str,
    repair_id: str,
    filename: str,
) -> Path:
    """安全地解析存储的宏路径。阻止路径遍历。

    如果文件名包含目录分隔符，则引发 :class:`ValueError`，
    前导点，或在解析后转义宏目录。"""
    if (
        "/" in filename
        or "\\" in filename
        or filename.startswith(".")
        or ".." in filename
    ):
        raise ValueError(f"invalid filename: {filename!r}")
    macros_dir = memory_root / slug / "repairs" / repair_id / "macros"
    candidate = macros_dir / filename
    try:
        resolved = candidate.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise ValueError(f"invalid filename: {filename!r}") from exc
    macros_resolved = macros_dir.resolve(strict=False)
    if not str(resolved).startswith(str(macros_resolved)):
        raise ValueError(f"invalid filename: {filename!r}")
    return candidate


def build_image_ref(
    *,
    path: Path,
    memory_root: Path,
    slug: str,
    repair_id: str,
    source: Source,
) -> dict:
    """在回放时构建“image_ref”字典，该字典落在“messages.jsonl”中。

    前端解析``path``（相对于
    ``内存/{⟦PRESERVE1⟧}/repairs/{⟦PRESERVE0⟧}/``）通过
    ``GET /api/macros/{⟦PRESERVE1⟧}/{⟦PRESERVE0⟧}/{文件名}``路线。
"""
    repair_root = memory_root / slug / "repairs" / repair_id
    relative = path.relative_to(repair_root)
    return {
        "type": "image_ref",
        "path": str(relative),
        "source": source,
    }
