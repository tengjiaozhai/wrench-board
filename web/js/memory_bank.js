//  记忆库部分——一个知识包的单页阅读器。
//
//  获取/pipeline/packs（列表）以填充包选择器，然后
//  /pipeline/packs/{slug}/full 用于渲染注册表、知识图谱、
//  规则、字典和审计结论。缺失字段呈现为“—”
//  （硬性规则#5：绝不捏造）。

import { escapeHtml as escHtml, prettifySlug } from "./shared/dom.js";
import { listPacks, getPackFull } from "./services/packs.js";
import { getDeviceSlug } from "./shared/context.js";

const STATE = {
  packs: [],        //  PackSummary[] 来自 /pipeline/packs
  currentSlug: null,
  pack: null,       //  currentSlug 的完整负载，或加载时为 null
  loading: false,
};

function el(id) { return document.getElementById(id); }

//  当 i18n 未启动时，本地快捷键总是回退到该键。
function tr(key, params) {
  return (window.t ? window.t(key, params) : key);
}

function fmt(value, fallback = "…") {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  return value;
}

/*  ---------- 获取助手 ----------  */

async function fetchPacks() {
  try {
    return await listPacks();
  } catch (err) {
    console.warn("memory-bank: /pipeline/packs failed", err);
    return [];
  }
}

async function fetchFullPack(slug) {
  try {
    return await getPackFull(slug);
  } catch (err) {
    console.warn("memory-bank: /full fetch failed", err);
    return null;
  }
}

/*  ---------- 头部渲染 ----------  */

function renderPackPicker() {
  const sel = el("mbPackSelect");
  sel.innerHTML = "";
  if (STATE.packs.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = tr("memory_bank.picker.empty_option");
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const p of STATE.packs) {
    const opt = document.createElement("option");
    opt.value = p.device_slug;
    opt.textContent = p.device_slug;
    if (p.device_slug === STATE.currentSlug) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderVerdict() {
  const row = el("mbVerdictRow");
  const pack = STATE.pack;
  if (!pack) {
    row.innerHTML = "";
    return;
  }
  const v = pack.audit_verdict;
  let verdictHtml;
  if (!v) {
    verdictHtml = `
      <span class="mb-verdict none" title="${escHtml(tr("memory_bank.verdict.none_title"))}">
        <span class="dot"></span>${escHtml(tr("memory_bank.verdict.none_label"))}
      </span>
      <span class="mb-score">${escHtml(tr("memory_bank.verdict.consistency"))} <b>n/a</b></span>`;
  } else {
    const cls = v.overall_status === "APPROVED"       ? "approved"
              : v.overall_status === "NEEDS_REVISION" ? "needs-revision"
              : v.overall_status === "REJECTED"       ? "rejected"
              : "none";
    const labelKey = v.overall_status === "APPROVED"       ? "memory_bank.verdict.approved_label"
                   : v.overall_status === "NEEDS_REVISION" ? "memory_bank.verdict.needs_revision_label"
                   : v.overall_status === "REJECTED"       ? "memory_bank.verdict.rejected_label"
                   :                                         "memory_bank.verdict.unknown_label";
    const label = tr(labelKey);
    const score = (typeof v.consistency_score === "number")
      ? v.consistency_score.toFixed(2) : "n/a";
    verdictHtml = `
      <span class="mb-verdict ${cls}"><span class="dot"></span>${escHtml(label)}</span>
      <span class="mb-score">${escHtml(tr("memory_bank.verdict.consistency"))} <b>${score}</b></span>`;
  }

  //  从包装内容中计数。
  const reg = pack.registry || {};
  const kg = pack.knowledge_graph || {};
  const rules = pack.rules || {};
  const dict = pack.dictionary || {};
  const counts = `
    <span class="mb-counts">
      <span class="count"><b>${(reg.components || []).length}</b> ${escHtml(tr("memory_bank.counts.components"))}</span>
      <span class="count"><b>${(reg.signals || []).length}</b> ${escHtml(tr("memory_bank.counts.signals"))}</span>
      <span class="count"><b>${(kg.nodes || []).length}</b> ${escHtml(tr("memory_bank.counts.nodes"))}</span>
      <span class="count"><b>${(kg.edges || []).length}</b> ${escHtml(tr("memory_bank.counts.edges"))}</span>
      <span class="count"><b>${(rules.rules || []).length}</b> ${escHtml(tr("memory_bank.counts.rules"))}</span>
      <span class="count"><b>${(dict.entries || []).length}</b> ${escHtml(tr("memory_bank.counts.sheets"))}</span>
    </span>`;
  row.innerHTML = verdictHtml + counts;
}

function renderDeviceLabel() {
  const h1 = el("mbDeviceLabel");
  if (!STATE.pack) {
    h1.textContent = tr("memory_bank.title");
    return;
  }
  //  更喜欢分类中干净的“{brand} {model}”；将 form_factor 附加为
  //  一个小的下属chip，因此标题显示“我们正在修复的内容”，而无需
  //  在名称中重复板类型。
  const tax = (STATE.pack.registry || {}).taxonomy || {};
  const nameParts = [tax.brand, tax.model].filter(Boolean);
  const deviceName = nameParts.length > 0
    ? nameParts.join(" ")
    : (STATE.pack.device_label || STATE.currentSlug);
  const form = tax.form_factor ? ` <span style="font-family:var(--mono);font-size:10.5px;color:var(--text-3);letter-spacing:.3px;text-transform:uppercase;margin-left:8px;padding:1px 7px;border:1px solid var(--border-soft);border-radius:10px">${escHtml(tax.form_factor)}</span>` : "";
  h1.innerHTML = tr("memory_bank.title_with_device", { device: escHtml(deviceName), form });
}

/*  ---------- 块渲染 ----------  */

function renderRegistry(registry) {
  const body = el("mbBlockRegistry");
  if (!registry) {
    body.innerHTML = `<div class="mb-missing">${escHtml(tr("memory_bank.registry.missing"))}</div>`;
    return;
  }
  const comps = registry.components || [];
  const sigs  = registry.signals    || [];
  body.innerHTML = `
    <h3 style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-3);font-family:var(--mono);font-weight:500">${escHtml(tr("memory_bank.registry.components_heading", { n: comps.length }))}</h3>
    ${comps.length === 0 ? `<div class="mb-missing">${escHtml(tr("memory_bank.registry.no_components"))}</div>` : `
      <table class="mb-table" data-kind="registry-components">
        <thead><tr><th>${escHtml(tr("memory_bank.registry.th_refdes"))}</th><th>${escHtml(tr("memory_bank.registry.th_type"))}</th><th>${escHtml(tr("memory_bank.registry.th_aliases"))}</th><th>${escHtml(tr("memory_bank.registry.th_description"))}</th></tr></thead>
        <tbody>
          ${comps.map(c => `
            <tr data-search="${escHtml([c.canonical_name, c.logical_alias, ...(c.aliases || []), c.description, c.kind].filter(Boolean).join(" ").toLowerCase())}">
              <td class="mono">${escHtml(c.canonical_name)}${c.logical_alias ? `<div style="font-size:10.5px;color:var(--text-3);font-family:inherit;font-style:italic">${escHtml(c.logical_alias)}</div>` : ""}</td>
              <td><span class="mb-kind ${escHtml(c.kind || "unknown")}">${escHtml(c.kind || "unknown")}</span></td>
              <td>${(c.aliases || []).map(a => `<span class="mb-alias">${escHtml(a)}</span>`).join("") || '<span class="muted">(none)</span>'}</td>
              <td>${escHtml(c.description) || '<span class="muted">(none)</span>'}</td>
            </tr>`).join("")}
        </tbody>
      </table>`}
    <h3 style="margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-3);font-family:var(--mono);font-weight:500">${escHtml(tr("memory_bank.registry.signals_heading", { n: sigs.length }))}</h3>
    ${sigs.length === 0 ? `<div class="mb-missing">${escHtml(tr("memory_bank.registry.no_signals"))}</div>` : `
      <table class="mb-table" data-kind="registry-signals">
        <thead><tr><th>${escHtml(tr("memory_bank.registry.th_canonical"))}</th><th>${escHtml(tr("memory_bank.registry.th_type"))}</th><th>${escHtml(tr("memory_bank.registry.th_aliases"))}</th><th>${escHtml(tr("memory_bank.registry.th_nominal_voltage"))}</th></tr></thead>
        <tbody>
          ${sigs.map(s => `
            <tr data-search="${escHtml([s.canonical_name, ...(s.aliases || []), s.kind].filter(Boolean).join(" ").toLowerCase())}">
              <td class="mono">${escHtml(s.canonical_name)}</td>
              <td><span class="mb-kind ${escHtml(s.kind || "unknown")}">${escHtml(s.kind || "unknown")}</span></td>
              <td>${(s.aliases || []).map(a => `<span class="mb-alias">${escHtml(a)}</span>`).join("") || '<span class="muted">(none)</span>'}</td>
              <td class="mono">${s.nominal_voltage !== null && s.nominal_voltage !== undefined ? `<span class="mb-volt">${s.nominal_voltage} V</span>` : '<span class="muted">n/a</span>'}</td>
            </tr>`).join("")}
        </tbody>
      </table>`}
  `;
  el("mbBlockRegistryCount").innerHTML = tr("memory_bank.counts.registry_count", { c: comps.length, s: sigs.length });
}

function renderKnowledgeGraph(kg) {
  const body = el("mbBlockGraph");
  if (!kg) {
    body.innerHTML = `<div class="mb-missing">${escHtml(tr("memory_bank.graph.missing"))}</div>`;
    return;
  }
  const nodes = kg.nodes || [];
  const edges = kg.edges || [];
  const byKind = {symptom: 0, component: 0, net: 0};
  for (const n of nodes) { if (n.kind in byKind) byKind[n.kind]++; }

  body.innerHTML = `
    <div class="mb-graph-stats">
      <div class="mb-stat sym"><span class="label">${escHtml(tr("memory_bank.graph.stat_symptoms"))}</span><span class="value">${byKind.symptom}</span></div>
      <div class="mb-stat cmp"><span class="label">${escHtml(tr("memory_bank.graph.stat_components"))}</span><span class="value">${byKind.component}</span></div>
      <div class="mb-stat net"><span class="label">${escHtml(tr("memory_bank.graph.stat_nets"))}</span><span class="value">${byKind.net}</span></div>
      <div class="mb-stat edge"><span class="label">${escHtml(tr("memory_bank.graph.stat_edges"))}</span><span class="value">${edges.length}</span></div>
    </div>
    ${edges.length === 0 ? `<div class="mb-missing">${escHtml(tr("memory_bank.graph.no_edges"))}</div>` : `
      <div class="mb-edges">
        ${edges.map(e => `
          <div class="mb-edge-row" data-search="${escHtml([e.source_id, e.target_id, e.relation].filter(Boolean).join(" ").toLowerCase())}">
            <div class="src" title="${escHtml(e.source_id)}">${escHtml(e.source_id)}</div>
            <div class="rel ${escHtml(e.relation)}">${escHtml(e.relation)}</div>
            <div class="dst" title="${escHtml(e.target_id)}">${escHtml(e.target_id)}</div>
          </div>`).join("")}
      </div>`}
  `;
  el("mbBlockGraphCount").innerHTML = tr("memory_bank.counts.graph_count", { n: nodes.length, e: edges.length });
}

function renderRules(rules) {
  const body = el("mbBlockRules");
  if (!rules) {
    body.innerHTML = `<div class="mb-missing">${escHtml(tr("memory_bank.rules.missing"))}</div>`;
    return;
  }
  const items = rules.rules || [];
  if (items.length === 0) {
    body.innerHTML = `<div class="mb-missing">${escHtml(tr("memory_bank.rules.none"))}</div>`;
    el("mbBlockRulesCount").innerHTML = tr("memory_bank.counts.rules_count_zero");
    return;
  }
  body.innerHTML = items.map((r, i) => {
    const searchText = [
      r.id,
      ...(r.symptoms || []),
      ...(r.likely_causes || []).flatMap(c => [c.refdes, c.mechanism]),
      ...(r.diagnostic_steps || []).flatMap(s => [s.action, s.expected]),
    ].filter(Boolean).join(" ").toLowerCase();
    const headSym = (r.symptoms && r.symptoms.length > 0)
      ? `<b>${escHtml(r.symptoms[0])}</b>${r.symptoms.length > 1 ? ` <span style="color:var(--text-3)">+${r.symptoms.length - 1}</span>` : ""}`
      : `<span style="color:var(--text-3)">${escHtml(tr("memory_bank.rules.no_symptom"))}</span>`;
    const conf = typeof r.confidence === "number" ? r.confidence.toFixed(2) : "n/a";
    return `
      <div class="mb-rule" data-rule-idx="${i}" data-search="${escHtml(searchText)}">
        <div class="mb-rule-head">
          <span class="caret"></span>
          <span class="mb-rule-id">${escHtml(r.id || `rule-${i}`)}</span>
          <span class="mb-rule-sym">${headSym}</span>
          <span class="mb-rule-conf">${escHtml(tr("memory_bank.rules.conf_label", { value: conf }))}</span>
        </div>
        <div class="mb-rule-body">
          <div class="mb-rule-section">
            <h4>${escHtml(tr("memory_bank.rules.h_symptoms"))}</h4>
            <div class="mb-rule-symptoms">
              ${(r.symptoms || []).map(s => `<span class="sym">${escHtml(s)}</span>`).join("") || '<span class="muted">(none)</span>'}
            </div>
          </div>
          <div class="mb-rule-section">
            <h4>${escHtml(tr("memory_bank.rules.h_likely_causes"))}</h4>
            ${(r.likely_causes || []).length === 0 ? '<span class="muted">(none)</span>' :
              (r.likely_causes || []).map(c => {
                const p = typeof c.probability === "number" ? c.probability : 0;
                return `
                  <div class="mb-cause">
                    <span class="refdes">${escHtml(c.refdes)}</span>
                    <span class="mech">${escHtml(c.mechanism) || "…"}</span>
                    <div class="prob-bar"><div class="prob-fill" style="width:${(p * 100).toFixed(0)}%"></div></div>
                    <span class="prob-val">${p.toFixed(2)}</span>
                  </div>`;
              }).join("")}
          </div>
          <div class="mb-rule-section">
            <h4>${escHtml(tr("memory_bank.rules.h_diagnostic_steps"))}</h4>
            ${(r.diagnostic_steps || []).length === 0 ? '<span class="muted">(none)</span>' :
              (r.diagnostic_steps || []).map(s => `
                <div class="mb-step">
                  <span class="act">${escHtml(s.action)}</span>
                  ${s.expected ? `<span class="exp">${escHtml(tr("memory_bank.rules.expected", { value: s.expected }))}</span>` : ""}
                </div>`).join("")}
          </div>
          ${(r.sources || []).length > 0 ? `
            <div class="mb-rule-section">
              <h4>${escHtml(tr("memory_bank.rules.h_sources"))}</h4>
              <div class="mb-rule-sources">
                ${(r.sources || []).map(s => `<span class="src">${escHtml(s)}</span>`).join("")}
              </div>
            </div>` : ""}
        </div>
      </div>`;
  }).join("");

  //  手风琴线。
  body.querySelectorAll(".mb-rule-head").forEach(h => {
    h.addEventListener("click", () => {
      h.parentElement.classList.toggle("open");
    });
  });
  el("mbBlockRulesCount").innerHTML = tr("memory_bank.counts.rules_count", { n: items.length });
}

function renderDictionary(dict) {
  const body = el("mbBlockDictionary");
  if (!dict) {
    body.innerHTML = `<div class="mb-missing">${escHtml(tr("memory_bank.dictionary.missing"))}</div>`;
    return;
  }
  const entries = dict.entries || [];
  if (entries.length === 0) {
    body.innerHTML = `<div class="mb-missing">${escHtml(tr("memory_bank.dictionary.none"))}</div>`;
    el("mbBlockDictionaryCount").innerHTML = tr("memory_bank.counts.sheets_count_zero");
    return;
  }
  body.innerHTML = `
    <table class="mb-table" data-kind="dictionary">
      <thead><tr><th>${escHtml(tr("memory_bank.dictionary.th_refdes"))}</th><th>${escHtml(tr("memory_bank.dictionary.th_role"))}</th><th>${escHtml(tr("memory_bank.dictionary.th_package"))}</th><th>${escHtml(tr("memory_bank.dictionary.th_failure_modes"))}</th><th>${escHtml(tr("memory_bank.dictionary.th_notes"))}</th></tr></thead>
      <tbody>
        ${entries.map(e => {
          const modes = e.typical_failure_modes || [];
          const searchText = [e.canonical_name, e.role, e.package, e.notes, ...modes]
            .filter(Boolean).join(" ").toLowerCase();
          return `
            <tr data-search="${escHtml(searchText)}">
              <td class="mono">${escHtml(e.canonical_name)}</td>
              <td>${escHtml(e.role) || '<span class="muted">(none)</span>'}</td>
              <td class="mono">${escHtml(e.package) || '<span class="muted">(none)</span>'}</td>
              <td>${modes.length === 0 ? '<span class="muted">(none)</span>' :
                modes.map(m => `<span class="mb-alias" style="color:var(--amber);background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.3)">${escHtml(m)}</span>`).join("")}</td>
              <td>${escHtml(e.notes) || '<span class="muted">(none)</span>'}</td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>`;
  el("mbBlockDictionaryCount").innerHTML = tr("memory_bank.counts.sheets_count", { n: entries.length });
}

function renderAudit(verdict) {
  const block = el("mbBlockAuditWrapper");
  const body  = el("mbBlockAudit");
  if (!verdict) {
    block.style.display = "";
    body.innerHTML = `<div class="mb-missing">${escHtml(tr("memory_bank.audit.missing"))}</div>`;
    el("mbBlockAuditCount").innerHTML = `<b>n/a</b>`;
    return;
  }
  block.style.display = "";
  const status = verdict.overall_status || "UNKNOWN";
  const score  = typeof verdict.consistency_score === "number" ? verdict.consistency_score.toFixed(2) : "n/a";
  const files  = verdict.files_to_rewrite || [];
  const drift  = verdict.drift_report || [];
  const brief  = verdict.revision_brief || "";

  const headline = status === "APPROVED"
    ? tr("memory_bank.audit.headline_approved")
    : status === "NEEDS_REVISION"
      ? tr("memory_bank.audit.headline_needs_revision")
      : status === "REJECTED"
        ? tr("memory_bank.audit.headline_rejected")
        : tr("memory_bank.audit.headline_unknown");

  body.innerHTML = `
    <div class="mb-audit-summary">
      <div class="headline">${escHtml(headline)}</div>
      <div class="mb-score" style="margin-left:auto">${escHtml(tr("memory_bank.verdict.consistency"))} <b>${score}</b></div>
    </div>
    ${brief ? `<div class="mb-audit-brief">${escHtml(brief)}</div>` : ""}
    ${files.length > 0 ? `
      <div class="mb-drift">
        <h4>${escHtml(tr("memory_bank.audit.files_to_rewrite"))}</h4>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${files.map(f => `<span class="mb-alias" style="color:var(--amber);background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.3)">${escHtml(f)}</span>`).join("")}
        </div>
      </div>` : ""}
    ${drift.length > 0 ? `
      <div class="mb-drift">
        <h4>${escHtml(tr("memory_bank.audit.drift_heading", { n: drift.length }))}</h4>
        ${drift.map(d => `
          <div class="mb-drift-item">
            <span class="file">${escHtml(d.file)}</span>
            <span class="reason">${escHtml(d.reason)}</span>
            ${(d.mentions || []).length > 0 ? `
              <div class="mentions">${(d.mentions || []).map(m => `<code>${escHtml(m)}</code>`).join("")}</div>
            ` : ""}
          </div>`).join("")}
      </div>` : ""}
  `;
  el("mbBlockAuditCount").innerHTML = `<b>${status}</b>`;
}

/*  ----------主渲染----------  */

function renderPack() {
  renderDeviceLabel();
  renderVerdict();
  const p = STATE.pack;
  if (!p) return;
  renderRegistry(p.registry);
  renderKnowledgeGraph(p.knowledge_graph);
  renderRules(p.rules);
  renderDictionary(p.dictionary);
  renderAudit(p.audit_verdict);
  applySearchFilter(el("mbSearch").value || "");
}

function showEmptyState(message) {
  el("mbBody").style.display = "none";
  const empty = el("mbEmpty");
  empty.classList.remove("hidden");
  empty.querySelector("p").textContent = message || tr("memory_bank.empty.body_default");
}

function hideEmptyState() {
  el("mbBody").style.display = "";
  el("mbEmpty").classList.add("hidden");
}

/*  ---------- 搜索 ----------  */

function applySearchFilter(query) {
  const q = query.trim().toLowerCase();
  const root = el("memoryBank");

  //  表行。
  root.querySelectorAll("tr[data-search]").forEach(tr => {
    tr.classList.toggle("hidden", q !== "" && !tr.dataset.search.includes(q));
  });

  //  边缘行（网格，“显示：内容”，因此我们切换隐藏标志）。
  root.querySelectorAll(".mb-edge-row[data-search]").forEach(row => {
    row.classList.toggle("hidden", q !== "" && !row.dataset.search.includes(q));
  });

  //  规则手风琴。
  root.querySelectorAll(".mb-rule[data-search]").forEach(rule => {
    rule.classList.toggle("hidden", q !== "" && !rule.dataset.search.includes(q));
  });
}

/*  ---------- 公共API ----------  */

export async function loadMemoryBank() {
  if (STATE.loading) return;
  STATE.loading = true;
  try {
    STATE.packs = await fetchPacks();
    //  首选活动设备（如果存在），否则第一个可用包，否则为空状态。
    const deviceParam = getDeviceSlug();
    if (deviceParam && STATE.packs.some(p => p.device_slug === deviceParam)) {
      STATE.currentSlug = deviceParam;
    } else if (STATE.packs.length > 0) {
      STATE.currentSlug = STATE.packs[0].device_slug;
    } else {
      STATE.currentSlug = null;
    }
    renderPackPicker();

    if (!STATE.currentSlug) {
      showEmptyState();
      renderDeviceLabel();
      return;
    }
    hideEmptyState();
    STATE.pack = await fetchFullPack(STATE.currentSlug);
    if (!STATE.pack) {
      showEmptyState(tr("memory_bank.empty.load_failed", { slug: STATE.currentSlug }));
      return;
    }
    renderPack();
  } finally {
    STATE.loading = false;
  }
}

export function initMemoryBank() {
  //  重新渲染强制构建的表格单元格（标题、计数、缺失
  //  横幅）当区域设置切换时。 DOM 级别的 [data-i18n] 挂钩
  //  index.html通过i18n.applyDom刷新；这个钩子处理剩下的事情。
  if (window.i18n && typeof window.i18n.onChange === "function") {
    window.i18n.onChange(() => {
      if (STATE.pack) renderPack();
    });
  }
  const sel = el("mbPackSelect");
  if (sel) {
    sel.addEventListener("change", async () => {
      const slug = sel.value;
      if (!slug) return;
      STATE.currentSlug = slug;
      STATE.pack = await fetchFullPack(slug);
      if (!STATE.pack) {
        showEmptyState(tr("memory_bank.empty.load_failed", { slug }));
        return;
      }
      hideEmptyState();
      renderPack();
    });
  }
  const search = el("mbSearch");
  if (search) {
    search.addEventListener("input", () => applySearchFilter(search.value));
    search.addEventListener("keydown", ev => {
      if (ev.key === "Escape" && search.value !== "") {
        ev.preventDefault();
        ev.stopPropagation();
        search.value = "";
        applySearchFilter("");
      }
    });
  }
}
