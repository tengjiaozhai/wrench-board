// web/js/services/packs.js
// 设备知识 pack 的只读数据服务。将 /pipeline/packs 端点封装为命名函数。
// 调用方不直接 fetch。
import { apiGet } from "../shared/api.js";

export const listPacks = () => apiGet("/pipeline/packs");
export const getPackFull = (slug) => apiGet(`/pipeline/packs/${encodeURIComponent(slug)}/full`);
export const getPackGraph = (slug) => apiGet(`/pipeline/packs/${encodeURIComponent(slug)}/graph`);
