// web/js/shared/dom.js
// 共享 DOM/字符串工具。各 feature 模块中重复实现的单一来源
//（约 10 种 escapeHtml 变体、prettifySlug ×2、relative-time）。

export function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// router.js::prettifySlug 函数体的逐字拷贝（导出版本，canonical）。
export function prettifySlug(slug) {
  if (!slug) return "";
  return slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// home.js::relativeTimeFr（web/js/home.js）函数体的逐字拷贝。
// 重命名为 relativeTime（法语行为不变）。依赖全局 window.t / window.i18n
//（由 i18n.js 接线），与 home.js 相同。
export function relativeTime(isoString) {
  if (!isoString) return "…";
  const then = new Date(isoString);
  if (isNaN(then)) return isoString;
  const diffMs = Date.now() - then.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t("home.time.now");
  if (mins < 60) return t("home.time.minutes_ago", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("home.time.hours_ago", { n: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t("home.time.yesterday");
  if (days < 7) return t("home.time.days_ago", { n: days });
  const localeTag = (window.i18n && window.i18n.locale === "fr") ? "fr-FR" : "en-US";
  return then.toLocaleDateString(localeTag, { day: "numeric", month: "short", year: "numeric" });
}
