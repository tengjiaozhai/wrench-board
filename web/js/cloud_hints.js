// cloud 前门注入的计划提示（free/pro UX）。
//
// 托管模式下，cloud 在代理 HTML 中注入全局 `window.__wbPlanHints`
//（如 {plan:"free", packedOnly:true, hideUploads:true, stockDonorLimit:5}），
// UI 据此调整：未选择已 pack 设备前锁定「开始诊断」、隐藏上传按钮等。
// 自托管无此全局 → 各 helper 均返回「无限制」，UI 完全不变。
//
// 仅 cosmetic — 无信任逻辑；真正屏障在 cloud 服务端 402。
// 手动移除这些 hint 不会解锁任何能力，服务端仍会拒绝。

export function planHints() {
  return (typeof window !== "undefined" && window.__wbPlanHints) || null;
}

// 该 plan 仅能在已 pack（✓）的设备上启动诊断。
export function packedOnly() {
  const h = planHints();
  return !!(h && h.packedOnly);
}

// 该 plan 不能添加 schematic/boardview → 隐藏相关入口。
export function hideUploads() {
  const h = planHints();
  return !!(h && h.hideUploads);
}
