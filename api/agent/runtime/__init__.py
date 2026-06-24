"""诊断运行时（Managed Agents路径）——子模块。

旧版 ``api.agent.runtime_managed`` module remains as a thin shim
that re-exports the public surface of this package, so existing callers
(``api.main``、脚本、测试）可以继续工作，而无需更改导入路径。"""

from __future__ import annotations
