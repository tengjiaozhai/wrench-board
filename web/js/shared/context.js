// web/js/shared/context.js
// 「当前在哪个 device / repair」的单一来源，各视图只读。
// 由 store.js 支撑。router 为唯一写入方（经 setContext）；视图为只读消费者。
// 取代 graph/schematic/memory_bank/llm/pcb_bridge/brd_viewer/home 中分散的
// URLSearchParams(...).get("device") / .get("repair") 读取。
// Phase C：C.1 中 router 将查询串镜像到 store；C.3 数据源切换为 hash 路由
//（#repair/:id/<vue>）而不改变此读契约。
import { store } from "../store.js";

/** 活跃 device slug，不在任何 repair 内时为 null。 */
export function getDeviceSlug() {
  return store.get("device") || null;
}

/** 活跃 repair id，不在任何 repair 内时为 null。 */
export function getRepairId() {
  return store.get("repair") || null;
}

/**
 * 设置活跃上下文。router 解析路由后调用。
 * 传入 falsy 值则清除对应键。通知 "device"/"repair" 的订阅者。
 */
export function setContext({ device, repair }) {
  store.set("device", device || null);
  store.set("repair", repair || null);
}
