"""`.fz` boardview 解析器。

该字段中存在两种类型的 `.fz`，并且该解析器会调度
他们之间：

1. **FZ-zlib**。 4 字节 LE int32 大小的标头，后面直接跟着一个
   zlib 流，解压缩到管道分隔 (`!`) 部分
   格式为 `A!schema` / `S!data` 行。实施于
   ⟦保留6⟧。无需钥匙。

2. **FZ 异或**。相同的 FZ-zlib 容器包装在 16 字节中
   由 44 × uint32 扩展键控的滑动窗口 RC6 形密码
   钥匙。使用`_fz_engine.cipher.decrypt_fz_xor`解密，然后交出
   通过`parse_fz_zlib`返回明文。

调度：查看字节 4-5 — zlib 魔法 (`78 9c` / `78 da` / `78 01`)
直接路由至FZ-zlib；否则字节将经过 XOR
首先解密，结果必须在偏移量 4 处显示 zlib magic
恢复的纯文本（或者文件因格式错误而被拒绝）。

密钥从 `WRENCH_BOARD_FZ_KEY` 加载（参见
⟦保留13⟧）。 FZ-zlib 解析无需密钥即可工作； FZ异或
当密钥未设置时，文件会引发明显的错误。"""

from __future__ import annotations

from api.board.model import Board
from api.board.parser._fz_engine.cipher import (
    FZ_KEY_ENV,
    KEY_WORDS,
    FZKeyNotConfigured,
    decrypt_fz_xor,
)
from api.board.parser._fz_zlib import looks_like_fz_zlib, parse_fz_zlib
from api.board.parser.base import BoardParser, InvalidBoardFile, register

_KEY_WORDS_LEN = 44


@register
class FZParser(BoardParser):
    extensions = (".fz",)

    def __init__(self, key: tuple[int, ...] | None = None):
        if key is not None and len(key) != _KEY_WORDS_LEN:
            key = None
        self.key = key if key is not None else KEY_WORDS

    def parse(self, raw: bytes, *, file_hash: str, board_id: str) -> Board:
        if looks_like_fz_zlib(raw):
            return parse_fz_zlib(raw, file_hash=file_hash, board_id=board_id, source_format="fz")
        try:
            plain = decrypt_fz_xor(raw, self.key)
        except FZKeyNotConfigured as exc:
            raise InvalidBoardFile(str(exc)) from exc
        if not looks_like_fz_zlib(plain):
            raise InvalidBoardFile(
                "fz-xor: decryption did not surface the expected zlib container "
                "(bytes 4-5 are not a zlib magic). Either the file is corrupt "
                "or it uses a different key — set "
                f"{FZ_KEY_ENV} to override."
            )
        return parse_fz_zlib(plain, file_hash=file_hash, board_id=board_id, source_format="fz")
