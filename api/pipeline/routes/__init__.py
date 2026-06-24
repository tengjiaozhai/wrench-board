"""管道FastAPI子路由器——按关注点分割。

包`__init__.py`将它们聚合到一个安装的`router`中
在`/pipeline`下。每个模块声明自己的`⟦PRESERVE1⟧Router()`（无前缀）
并且由父级进行 `include_router()` 编辑 — 端点路径未更改
相对于预分割的整体结构。"""
