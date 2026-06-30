// web/js/shared/api.js
// 前端统一 fetch 封装。集中 ok 检查、JSON 解析与规范化错误。
// 保持与租户无关：前端今日不发送 tenant 头（租户逻辑在 cloud 仓库）。
// 若将来需要，在此添加拦截器（而非各调用点）。

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// 公共前缀：所有 API 请求自动拼接。nginx 反向代理时设为 "/wrench"。
export const API_PREFIX = "/wrench";

// 统一 fetch 封装。供各模块替代原生 fetch 使用，自动拼接前缀。
export function apiFetch(path, init = {}) {
  return fetch(API_PREFIX + path, init);
}

// UI 调用返回 401 表示会话过期（托管部署）— 引擎本身与 auth 无关、无法重新认证，
// 故触发全局事件供托管层（cloud auth shim）处理（如跳转 /login）。
// 自托管无监听器则为 no-op。导出供仍使用原始 fetch 的少数视图（stock）上报同一信号。
export function notifyUnauthorized() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("wb:unauthorized"));
  }
}

async function _parse(res) {
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch { /* 非 JSON 错误体 */ }
    if (res.status === 401) notifyUnauthorized();
    throw new ApiError(res.status, body?.detail || res.statusText, body);
  }
  return res.json();
}

// GET → 解析后的 JSON。
export function apiGet(path, init = {}) {
  return fetch(API_PREFIX + path, { ...init, method: "GET" }).then(_parse);
}

// POST/PUT/... 带 body。`body` 可为 string、FormData 或 URLSearchParams。
export function apiSend(path, { method = "POST", body, headers } = {}) {
  return fetch(API_PREFIX + path, { method, body, headers }).then(_parse);
}
