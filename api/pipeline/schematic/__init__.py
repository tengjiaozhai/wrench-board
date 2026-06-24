"""摄取管道示意图 — PDF 示意图 → ElectricalGraph。

每页 Claude 视觉从每个渲染的页面中提取一个 `SchematicPageGraph`。
确定性合并通过网络标签和跨页面引用缝合页面，
导出电源轨和启动顺序，并写入最终的`ElectricalGraph`
to `memory/{⟦PRESERVE1⟧}/⟦PRESERVE0⟧.json`."""
