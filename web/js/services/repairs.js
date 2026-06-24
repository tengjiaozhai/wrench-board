// web/js/services/repairs.js
// repair 的只读数据服务。CREATE repair 的 POST 暂留 feature 模块
//（cloud 契约：urlencoded body — 见 plan invariants）。
import { apiGet } from "../shared/api.js";

export const listRepairs = () => apiGet("/pipeline/repairs");
export const getRepair = (id) => apiGet(`/pipeline/repairs/${encodeURIComponent(id)}`);
