// Landing 资料 pill — 驾驶舱右上角工具栏中始终存在的头像按钮。
// 点击后在原位打开资料配置 modal（profile_modal.js）；从不离开当前页。
// 从 GET /profile 渲染身份信息；资料未完成时脉冲提示。
//
// 保留 initProfileMenu/refreshProfileMenu 命名，供 landing/index.js 等既有调用方使用。

import { apiGet } from "../../../shared/api.js";
import { openProfileModal } from "./profile_modal.js";

function _pill() { return document.getElementById("landingProfilePill"); }

// fetch profile 并绘制 pill。返回 envelope，供调用方复用而无需二次请求。
export async function refreshProfileMenu() {
  const root = document.getElementById("landingProfile");
  const avatar = document.getElementById("landingProfileAvatar");
  const nameEl = document.getElementById("landingProfileName");
  if (!root) return null;

  let env = null;
  try {
    env = await apiGet("/profile");
  } catch (err) {
    console.warn("[profile_menu] load profile failed", err);
  }
  const id = env?.profile?.identity || {};
  const incomplete = !id.name;

  if (avatar) {
    avatar.textContent = id.avatar || (id.name ? id.name.slice(0, 2).toUpperCase() : "?");
  }
  if (nameEl) nameEl.textContent = id.name || "";
  root.dataset.incomplete = incomplete ? "1" : "";
  return env;
}

export function initProfileMenu() {
  const pill = _pill();
  if (!pill) return;
  pill.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openProfileModal();
  });
  // modal（或 onboarding 步骤）保存并广播后，重绘 pill。
  document.addEventListener("wb:profile-updated", () => refreshProfileMenu());
}
