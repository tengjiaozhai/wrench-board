// 跨设备入门标志。事实来源 = 技术人员简介
// （服务器端，tenant范围通过云前门下的X-Owner-Ref）。
// localStorage 保留为快速预门缓存，因此着陆英雄永远不会闪烁
// 在上演之前，但它不再具有权威性：导游
// 在一台设备上完成的不得在另一台设备上重播。
//
// Two flags mirror the two one-shot tours:
// onboarding_seen -> 着陆驾驶舱导游（旧版 LS wb_onboarding_seen）
// first_diag_seen -> 首次诊断工作区辅导（旧版 LS wb_first_diag_seen）
//
// 所有HTTP都会经过shared/api.js，因此云前门的获取包装和
// X-Owner-Ref 注入应用——这里绝不是原始获取。

import { apiGet, apiSend } from "./shared/api.js";

const LS_KEY = {
  onboarding_seen: "wb_onboarding_seen",
  first_diag_seen: "wb_first_diag_seen",
};

// 内存缓存，在从 /profile 启动时进行一次水合。直到那时为空，所以
// 同步门回落到 localStorage 预门预水合。
let _state = null;

function _lsGet(flag) {
  try { return !!localStorage.getItem(LS_KEY[flag]); } catch { return false; }
}
function _lsSet(flag) {
  try { localStorage.setItem(LS_KEY[flag], "1"); } catch { /* 私人模式 */ }
}

// 获取一次配置文件，播种缓存，与 localStorage 协调。退货
// /profile 信封（或 null），以便调用者可以重用它（例如语言）。
//
// 迁移规则：本地设置但不存在服务器端的标志（用户
// 在此发货之前已加入）被视为已看到并提升到服务器
// - 我们永远不会仅仅因为服务器尚未记录就清除本地标志
// （服务器否定意味着“从未写入”，而不是“明确未见”）。从
// 继续推广，标志是跨设备的。
export async function hydrateOnboardingState() {
  let env = null;
  try {
    env = await apiGet("/profile");
  } catch {
    _state = null; // 保留仅 localStorage 的后备方案
    return null;
  }
  const srv = env?.profile?.state || {};
  const next = {
    onboarding_seen: !!srv.onboarding_seen,
    first_diag_seen: !!srv.first_diag_seen,
  };
  const promote = {};
  for (const flag of Object.keys(LS_KEY)) {
    if (next[flag]) {
      _lsSet(flag); // 服务器说已看到 → 保持快速预门同步
    } else if (_lsGet(flag)) {
      next[flag] = true;    // 预告片当地旗帜是事实……
      promote[flag] = true; // ...在服务器端推广它，以便它可以跨设备
    }
  }
  _state = next;
  if (Object.keys(promote).length) {
    apiSend("/profile/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(promote),
    }).catch((err) => console.warn("[onboarding] promote local flags failed", err));
  }
  return env;
}

// 一次性门的同步读取。水合的服务器缓存获胜；前
// 水合，回落到 localStorage 预门。
export function hasSeenOnboarding(flag) {
  if (_state) return !!_state[flag];
  return _lsGet(flag);
}

// 将游览标记为所见：内存中 + localStorage 缓存（即时，此会话）以及
// 服务器（事实来源，fire-and-forget — UI 永远不会阻塞）。这
// PUT 仅修补此标志，因此它无法破坏其他游览的状态。
export function markOnboardingSeen(flag) {
  if (!_state) _state = { onboarding_seen: false, first_diag_seen: false };
  _state[flag] = true;
  _lsSet(flag);
  apiSend("/profile/state", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [flag]: true }),
  }).catch((err) => console.warn("[onboarding] persist state failed", err));
}
