//  诊断聊天 — 工具调用释义（Phase D.6 从 llm.js 中提取）。
//  纯粹的表示：将工具名称+其输入对象映射到{icon，phraseHTML}
//  对于转rail阶梯线。无模块状态。由 WS 消息消耗
//  llm.js（tool_use / memory_tool_use 事件）中的调度程序。
//
//  `t` 通过全局 window.t 解析（由i18n.js设置，一个经典的
//  非ESM脚本）在调用时因此字符串在语言环境切换上重新渲染 - 镜像
//  memory_bank.js / graph.js 约定。 escapeHTML 守护着每一个
//  内插的用户/工具值。

import { escapeHtml as escapeHTML } from '../../../shared/dom.js';

const t = (key, params) => (window.t ? window.t(key, params) : key);

//  工具调用步骤的系列图标。 12×12，内联 SVG，描边当前颜色。
const ICON_MB =
  '<svg class="step-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/>' +
  '<circle cx="12" cy="12" r="3"/></svg>';
const ICON_BV =
  '<svg class="step-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/>' +
  '<circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>';
//  MEM = 设备内存存储上的 MA 本机文件系统操作（读/写/
//  edit / grep / glob），通过 agent_toolset_20260401 工具集出现。气缸
//  = 持久存储。与MB不同（知识库通过mb_*查询）。
const ICON_MEM =
  '<svg class="step-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="2.5"/>' +
  '<path d="M4 5v14c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5"/>' +
  '<path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/></svg>';
//  库存=捐赠者库存+零件收获。盒子/板条箱比喻匹配
//  #stock 的 rail 图标，因此聊天步骤可被识别为相同
//  技术人员在workspace部分看到的表面。
const ICON_STOCK =
  '<svg class="step-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="1.5"/>' +
  '<path d="M3 10h18M8 6v4M16 6v4"/></svg>';

//  每个已知工具名称的本地化释义 + 系列图标。每个条目
//  是一个接收工具输入对象并返回的函数
//  {图标，短语HTML}。 phraseHTML 可以嵌入 <span class="refdes"> 或
//  <span class="net"> 用于强调目标的印刷效果；所有用户
//  输入在插值之前通过 escapeHTML 传递。弦来了
//  从 i18n 通过 window.t() ，因此它们在语言环境切换上重新渲染。
export const TOOL_PHRASES = {
  //  --- MB（记忆库——感知/阅读）---
  mb_get_component: (i) => {
    const refdes = escapeHTML(i?.refdes || "?");
    return {
      icon: ICON_MB,
      phraseHTML: t('chat.tool.mb_get_component', { refdes }),
      //  将一系列组件查找合并到一条暗线 (chatLog.js) 中：
      //  目标 chip 是附加到内联列表中的内容。
      group: { key: 'tool:mb_get_component', item: `<span class="refdes">${refdes}</span>` },
    };
  },
  mb_get_rules_for_symptoms: (i) => {
    const syms = Array.isArray(i?.symptoms) ? i.symptoms.join(", ") : (i?.symptoms || "");
    return {
      icon: ICON_MB,
      phraseHTML: t('chat.tool.mb_get_rules_for_symptoms', { symptoms: escapeHTML(syms) }),
    };
  },
  mb_list_findings: (i) => ({
    icon: ICON_MB,
    phraseHTML: i?.device
      ? t('chat.tool.mb_list_findings_for', { device: escapeHTML(i.device) })
      : t('chat.tool.mb_list_findings'),
  }),
  mb_record_finding: () => ({
    icon: ICON_MB,
    phraseHTML: t('chat.tool.mb_record_finding'),
  }),
  mb_expand_knowledge: (i) => {
    const scope = [i?.component, i?.symptom].filter(Boolean).join(" / ");
    return {
      icon: ICON_MB,
      phraseHTML: scope
        ? t('chat.tool.mb_expand_knowledge_scope', { scope: escapeHTML(scope) })
        : t('chat.tool.mb_expand_knowledge'),
    };
  },
  mb_schematic_graph: () => ({
    icon: ICON_MB,
    phraseHTML: t('chat.tool.mb_schematic_graph'),
  }),

  //  --- BV (boardview — 动作) ---
  bv_highlight: (i) => {
    const r = Array.isArray(i?.refdes) ? i.refdes.join(", ") : (i?.refdes || "?");
    return {
      icon: ICON_BV,
      phraseHTML: t('chat.tool.bv_highlight', { refdes: escapeHTML(r) }),
    };
  },
  bv_focus: (i) => ({
    icon: ICON_BV,
    phraseHTML: t('chat.tool.bv_focus', { refdes: escapeHTML(i?.refdes || "?") }),
  }),
  bv_reset_view: () => ({ icon: ICON_BV, phraseHTML: t('chat.tool.bv_reset_view') }),
  bv_highlight_net: (i) => ({
    icon: ICON_BV,
    phraseHTML: t('chat.tool.bv_highlight_net', { net: escapeHTML(i?.net || "?") }),
  }),
  bv_flip: () => ({ icon: ICON_BV, phraseHTML: t('chat.tool.bv_flip') }),
  bv_annotate: (i) => {
    let phraseHTML;
    if (i?.refdes) {
      phraseHTML = t('chat.tool.bv_annotate_near', { refdes: escapeHTML(i.refdes) });
    } else if (Number.isFinite(i?.x) && Number.isFinite(i?.y)) {
      phraseHTML = t('chat.tool.bv_annotate_at', { x: i.x, y: i.y });
    } else {
      phraseHTML = t('chat.tool.bv_annotate_blank');
    }
    return { icon: ICON_BV, phraseHTML };
  },
  bv_filter_by_type: (i) => ({
    icon: ICON_BV,
    phraseHTML: t('chat.tool.bv_filter_by_type', { prefix: escapeHTML(i?.prefix || "?") }),
  }),
  bv_draw_arrow: (i) => ({
    icon: ICON_BV,
    phraseHTML: t('chat.tool.bv_draw_arrow', {
      from: escapeHTML(i?.from_refdes || "?"),
      to: escapeHTML(i?.to_refdes || "?"),
    }),
  }),
  bv_measure: (i) => ({
    icon: ICON_BV,
    phraseHTML: t('chat.tool.bv_measure', {
      a: escapeHTML(i?.refdes_a || "?"),
      b: escapeHTML(i?.refdes_b || "?"),
    }),
  }),
  bv_show_pin: (i) => ({
    icon: ICON_BV,
    phraseHTML: t('chat.tool.bv_show_pin', {
      pin: escapeHTML(String(i?.pin ?? "?")),
      refdes: escapeHTML(i?.refdes || "?"),
    }),
  }),
  bv_dim_unrelated: () => ({ icon: ICON_BV, phraseHTML: t('chat.tool.bv_dim_unrelated') }),
  bv_layer_visibility: (i) => ({
    icon: ICON_BV,
    phraseHTML: t('chat.tool.bv_layer_visibility', { layer: escapeHTML(i?.layer || "?") }),
  }),
  bv_scene: (i) => {
    const parts = [];
    const hl = Array.isArray(i?.highlights) ? i.highlights.length : 0;
    const an = Array.isArray(i?.annotations) ? i.annotations.length : 0;
    const ar = Array.isArray(i?.arrows) ? i.arrows.length : 0;
    if (hl) parts.push(t(hl > 1 ? 'chat.tool.scene_highlight_many' : 'chat.tool.scene_highlight_one', { n: hl }));
    if (an) parts.push(t(an > 1 ? 'chat.tool.scene_annotation_many' : 'chat.tool.scene_annotation_one', { n: an }));
    if (ar) parts.push(t(ar > 1 ? 'chat.tool.scene_arrow_many' : 'chat.tool.scene_arrow_one', { n: ar }));
    if (i?.focus?.refdes) parts.push(t('chat.tool.scene_focus', { refdes: escapeHTML(i.focus.refdes) }));
    if (i?.dim_unrelated) parts.push(t('chat.tool.scene_dim'));
    if (i?.reset) parts.unshift(t('chat.tool.scene_reset'));
    return {
      icon: ICON_BV,
      phraseHTML: parts.length ? t('chat.tool.bv_scene', { parts: parts.join(", ") }) : t('chat.tool.bv_scene_empty'),
    };
  },

  //  --- 库存（捐赠者库存 + 部分收获） ---
  stock_search: (i) => {
    const tp = i?.type || "";
    const v = i?.value_canonical || i?.mpn || "";
    return {
      icon: ICON_STOCK,
      phraseHTML: (tp || v)
        ? t('chat.tool.stock_search', { type: escapeHTML(tp), value: escapeHTML(v) })
        : t('chat.tool.stock_search_minimal'),
    };
  },
  stock_consume: (i) => ({
    icon: ICON_STOCK,
    phraseHTML: t('chat.tool.stock_consume', {
      refdes: escapeHTML(i?.refdes || "?"),
      donor_id: escapeHTML(i?.donor_id || "?"),
    }),
  }),
  stock_mark_donor: (i) => ({
    icon: ICON_STOCK,
    phraseHTML: t('chat.tool.stock_mark_donor', { device_slug: escapeHTML(i?.device_slug || "?") }),
  }),
  stock_unmark_donor: (i) => ({
    icon: ICON_STOCK,
    phraseHTML: t('chat.tool.stock_unmark_donor', { donor_id: escapeHTML(i?.donor_id || "?") }),
  }),
  stock_list_donors: () => ({
    icon: ICON_STOCK,
    phraseHTML: t('chat.tool.stock_list_donors'),
  }),
};

export function toolFallback(name) {
  return {
    icon: "",
    phraseHTML: `<span class="tool-name-raw">${escapeHTML(name)}</span>`,
  };
}

//  去掉 `/mnt/memory/{slug}/` MA-mount 前缀，以便内存路径读取为
//  短相对路径（“outcomes/abc.json”）而不是完整的绝对路径。
function memPath(p) {
  if (!p) return "";
  const m = String(p).match(/^\/mnt\/memory\/[^/]+\/(.+)$/);
  return m ? m[1] : String(p);
}

function memPathChip(p) {
  return `<code class="mem-path">${escapeHTML(memPath(p))}</code>`;
}

//  Glob/grep 模式以原始方式显示（未安装剥离）——与 chip 样式相同。
function patternChip(p) {
  return `<code class="mem-path">${escapeHTML(String(p || ""))}</code>`;
}

//  每个 MA 本机文件系统工具的本地化释义 + ICON_MEM。一样
//  形状契约为 TOOL_PHRASES — 接收工具输入对象并
//  返回 {icon,phraseHTML}。
//  `group.item` 是 SAME 内存操作触发时附加的内联目标 chip
//  再次背靠背（chatLog.js将运行合并为一条暗线）。的
//  key 是每个操作的，因此“read”运行和“glob”运行不会相互合并。
export const MEMORY_TOOL_PHRASES = {
  read: (i) => {
    const chip = memPathChip(i?.file_path || i?.path);
    return { icon: ICON_MEM, phraseHTML: t('chat.memtool.read', { path: chip }), group: { key: 'mem:read', item: chip } };
  },
  write: (i) => {
    const chip = memPathChip(i?.file_path || i?.path);
    return { icon: ICON_MEM, phraseHTML: t('chat.memtool.write', { path: chip }), group: { key: 'mem:write', item: chip } };
  },
  edit: (i) => {
    const chip = memPathChip(i?.file_path || i?.path);
    return { icon: ICON_MEM, phraseHTML: t('chat.memtool.edit', { path: chip }), group: { key: 'mem:edit', item: chip } };
  },
  view: (i) => {
    const chip = memPathChip(i?.file_path || i?.path);
    return { icon: ICON_MEM, phraseHTML: t('chat.memtool.view', { path: chip }), group: { key: 'mem:view', item: chip } };
  },
  grep: (i) => {
    const chip = patternChip(i?.pattern);
    return {
      icon: ICON_MEM,
      phraseHTML: i?.path
        ? t('chat.memtool.grep_in', { pattern: escapeHTML(String(i?.pattern || "")), path: memPathChip(i.path) })
        : t('chat.memtool.grep', { pattern: escapeHTML(String(i?.pattern || "")) }),
      group: { key: 'mem:grep', item: chip },
    };
  },
  glob: (i) => {
    const chip = patternChip(i?.pattern);
    return { icon: ICON_MEM, phraseHTML: t('chat.memtool.glob', { pattern: escapeHTML(String(i?.pattern || "")) }), group: { key: 'mem:glob', item: chip } };
  },
  list: (i) => ({
    icon: ICON_MEM,
    phraseHTML: i?.path
      ? t('chat.memtool.list_at', { path: memPathChip(i.path) })
      : t('chat.memtool.list'),
    group: { key: 'mem:list', item: i?.path ? memPathChip(i.path) : "" },
  }),
  ls: (i) => ({
    icon: ICON_MEM,
    phraseHTML: i?.path
      ? t('chat.memtool.list_at', { path: memPathChip(i.path) })
      : t('chat.memtool.list'),
    group: { key: 'mem:list', item: i?.path ? memPathChip(i.path) : "" },
  }),
};

export function memToolFallback(name) {
  return {
    icon: ICON_MEM,
    phraseHTML: `<span class="tool-name-raw">${escapeHTML(name)}</span>`,
  };
}
