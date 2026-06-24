"""FZ容器密码引擎。

XOR 风格的 `.fz` boardview 包装 FZ-zlib 有效负载（4 字节 LE
大小 + zlib 流）在 16 字节滑动窗口字节密码中
固定的 44 × uint32 密钥。解密后，有效负载与
普通的 FZ-zlib 变体已经由 `_fz_zlib.py` 处理。"""
