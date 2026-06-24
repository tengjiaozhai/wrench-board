// 设备目录只读服务 — 扁平化设备列表的单一缓存源，由 GET /pipeline/taxonomy 提供。
// 供 landing 自动补全（features/global/landing/index.js）与目录弹窗
//（features/global/landing/catalogue.js）使用。纯数据：无 DOM、无渲染。

import { apiGet } from "../shared/api.js";
import { prettifySlug } from "../shared/dom.js";

let _cache = null;

// 将 TaxonomyTree 扁平化为每个 pack 一条 — 型号的每个板卡修订/变体各自作为
// 建议项（如两款 iPhone X 板：Qualcomm vs Intel），由 `version` 区分。与
// flattenBoards（目录）同一集合，仅为自动补全重排：complete 优先，再按 label
// 字母序。曾折叠为每 (brand,model) 一条会隐藏非规范变体 — 目录可见但搜索不到。
export function flattenTaxonomy(tree) {
  const out = flattenBoards(tree);
  out.sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

// 会话内缓存。`force: true` 重新拉取（如新构建完成后）。
export async function loadDevices({ force = false } = {}) {
  if (_cache && !force) return _cache;
  const tree = await apiGet("/pipeline/taxonomy");
  _cache = flattenTaxonomy(tree);
  return _cache;
}

// 每个 pack（板卡修订）一条 — 型号的每个变体（如两款 MacBook Pro 13" 板：
// A1706/A1708 与 M1 A2338）由 `version` 区分。也是 flattenTaxonomy 的基础
//（后者仅重排结果）；单独保留以便目录的板卡步骤按 API 顺序展示 pack。
export function flattenBoards(tree) {
  const out = [];
  const push = (brand, model, p) => out.push({
    label: model || p.device_label || prettifySlug(p.device_slug),
    subtitle: brand || null,
    slug: p.device_slug,
    device_label: p.device_label || model || prettifySlug(p.device_slug),
    version: p.version || null,
    form_factor: p.form_factor || null,
    complete: Boolean(p.complete),
    has_electrical_graph: Boolean(p.has_electrical_graph),
    device_kind: p.device_kind || null,
    aliases: Array.isArray(p.aliases) ? p.aliases : [],
  });
  const brands = (tree && tree.brands) || {};
  for (const [brand, models] of Object.entries(brands)) {
    for (const [model, packs] of Object.entries(models || {})) {
      for (const p of packs || []) push(brand, model, p);
    }
  }
  for (const p of (tree && tree.uncategorized) || []) {
    if (p && p.device_slug) push(null, p.device_label || prettifySlug(p.device_slug), p);
  }
  return out;
}

let _boardsCache = null;

export async function loadBoards({ force = false } = {}) {
  if (_boardsCache && !force) return _boardsCache;
  const tree = await apiGet("/pipeline/taxonomy");
  _boardsCache = flattenBoards(tree);
  return _boardsCache;
}
