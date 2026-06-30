//  着陆hero — 捕获{设备标签，症状}，踢掉现有的
//  /pipeline/repairs 端点，并渲染实时叙述的 timeline
//  代理学习设备时的管道阶段。当管道完成时
//  （或者包已经在磁盘上）页面重新directs到workspace
//  在？repair={id}&device={slug}。
//
//  这里没有分类器 - 现有管道（Scout → Registry → Mapper？→
//  Writers ×3 → Auditor) 进行设备识别+知识构建
//  一击。讲述人代理 (api/pipeline/phase_narrator.py) 发出一个
//  每个phase_finished之后发生`phase_narration`事件；我们将它们渲染成
//  timeline 行，以便技术人员观察代理学习。

import { mountMascot, setMascotState } from './mascot.js';
import { prettifySlug } from './router.js';
import i18n from './i18n.js';
import { API_PREFIX } from './shared/api.js';

const STATUS_NEUTRAL = "";
const STATUS_LOADING = "loading";
const STATUS_ERROR = "error";

const PHASE_ORDER = ["scout", "registry", "mapper", "writers", "audit"];

let isSubmitting = false;
let progressWs = null;
let pipelineStartedAt = 0;
let _landingMascot = null;

function setLandingMascot(state) {
  if (!_landingMascot) return;
  setMascotState(_landingMascot, state);
}

//  日期格式化程序遵循活动的 i18n 语言环境（由 profile.reply_language 驱动）
//  因为提交 548ed20 删除了 topbar 开关）。懒惰地重新导出，所以我们
//  在会话中获取区域设置更改，无需重新加载页面。
function _landingDateFmt() {
  const locale = (i18n && i18n.locale) || 'en';
  //  将我们的短区域设置代码映射到 BCP-47 区域标签 Intl 期望的。
  const bcp47 = (i18n && i18n.toBcp47) ? i18n.toBcp47(locale) : 'en-US';
  return new Intl.DateTimeFormat(bcp47, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

async function loadAndRenderSidebar() {
  const sidebar = document.getElementById("landingSidebar");
  const list = document.getElementById("landingSidebarList");
  const count = document.getElementById("landingSidebarCount");
  if (!sidebar || !list) return;

  let repairs = [];
  try {
    const res = await fetch(API_PREFIX + "/pipeline/repairs");
    if (res.ok) repairs = await res.json();
  } catch (err) {
    console.warn("[landing] loadRepairs failed", err);
  }
  if (!repairs || repairs.length === 0) {
    sidebar.hidden = true;
    return;
  }

  //  最近的第一个。
  repairs.sort((a, b) => {
    const ta = new Date(a.created_at).getTime() || 0;
    const tb = new Date(b.created_at).getTime() || 0;
    return tb - ta;
  });

  if (count) {
    const key = repairs.length > 1 ? "landing.sidebar.count_many" : "landing.sidebar.count_one";
    count.textContent = window.t ? window.t(key, { n: repairs.length }) : `${repairs.length} repairs`;
  }

  list.innerHTML = "";
  for (const r of repairs) {
    const li = document.createElement("li");
    li.className = "landing-sidebar-item";

    const a = document.createElement("a");
    a.className = "landing-sidebar-link";
    a.href = `?device=${encodeURIComponent(r.device_slug)}&repair=${encodeURIComponent(r.repair_id)}#home`;

    const dev = document.createElement("span");
    dev.className = "landing-sidebar-device";
    dev.textContent = prettifySlug(r.device_slug);

    const sym = document.createElement("span");
    sym.className = "landing-sidebar-symptom";
    sym.textContent = r.symptom || "—";
    if (r.symptom) sym.title = r.symptom;

    const meta = document.createElement("span");
    meta.className = "landing-sidebar-meta";
    const dateStr = r.created_at
      ? _landingDateFmt().format(new Date(r.created_at)).replace(/,\s*/g, " ")
      : "";
    const ridShort = (r.repair_id || "").slice(0, 8);
    meta.textContent = dateStr ? `${dateStr} · ${ridShort}` : ridShort;

    a.appendChild(dev);
    a.appendChild(sym);
    a.appendChild(meta);
    li.appendChild(a);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "landing-sidebar-delete";
    del.setAttribute("aria-label", window.t ? window.t("landing.sidebar.delete_aria") : "Delete this repair");
    del.title = window.t ? window.t("landing.sidebar.delete_title") : "Delete";
    del.textContent = "×";
    del.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onDeleteRepairClick(r.repair_id, li, del);
    });
    li.appendChild(del);

    list.appendChild(li);
  }
  sidebar.hidden = false;
}

async function onDeleteRepairClick(repairId, itemEl, btnEl) {
  const t = window.t || ((k) => k);
  const ok = window.confirm(t("landing.delete.confirm"));
  if (!ok) return;

  btnEl.disabled = true;
  try {
    const res = await fetch(API_PREFIX + `/pipeline/repairs/${encodeURIComponent(repairId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${detail}`);
    }
  } catch (err) {
    console.error("[landing] delete failed", err);
    setStatus(t("landing.status.error_delete", { error: err.message || err }), STATUS_ERROR);
    btnEl.disabled = false;
    return;
  }

  itemEl.remove();
  const list = document.getElementById("landingSidebarList");
  const count = document.getElementById("landingSidebarCount");
  const remaining = list ? list.children.length : 0;
  if (count) {
    if (remaining > 0) {
      const key = remaining > 1 ? "landing.sidebar.count_many" : "landing.sidebar.count_one";
      count.textContent = t(key, { n: remaining });
    } else {
      count.textContent = "";
    }
  }
  if (remaining === 0) {
    const sidebar = document.getElementById("landingSidebar");
    if (sidebar) sidebar.hidden = true;
  }
}

export function showLanding() {
  document.body.classList.add("show-landing");
  const ov = document.getElementById("landing-overlay");
  if (ov) ov.hidden = false;
  //  安装heromascot一次；重新打开重置为空闲状态。侧边栏重新获取
  //  每次重新打开时，新的leaveSession()都会显示最新的修复列表。
  if (!_landingMascot) {
    _landingMascot = mountMascot(document.getElementById("landingMascot"), {
      size: "md", state: "idle",
    });
  } else {
    setLandingMascot("idle");
  }
  loadAndRenderSidebar();
  loadPacksForSuggest();
  setTimeout(() => document.getElementById("landingDevice")?.focus(), 50);
}

export function hideLanding() {
  document.body.classList.remove("show-landing");
  const ov = document.getElementById("landing-overlay");
  if (ov) ov.hidden = true;
  if (progressWs && progressWs.readyState <= 1) {
    try { progressWs.close(); } catch (_) {}
  }
  progressWs = null;
}

function setStatus(msg, kind) {
  const el = document.getElementById("landingStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.remove("error");
  if (kind === STATUS_ERROR) el.classList.add("error");
}

function setSubmitting(on) {
  isSubmitting = on;
  const btn = document.getElementById("landingSubmit");
  if (btn) btn.disabled = on;
  const dev = document.getElementById("landingDevice");
  const sym = document.getElementById("landingSymptom");
  if (dev) dev.disabled = on;
  if (sym) sym.disabled = on;
}

function showTimeline() {
  const tl = document.getElementById("landingTimeline");
  if (tl) tl.hidden = false;
  pipelineStartedAt = Date.now();
  startEtaTicker();
}

function startEtaTicker() {
  const eta = document.getElementById("landingTimelineEta");
  if (!eta) return;
  if (window.__landingEtaTimer) clearInterval(window.__landingEtaTimer);
  const t = window.t || ((k) => k);
  const tick = () => {
    const elapsed = Math.max(0, (Date.now() - pipelineStartedAt) / 1000);
    eta.textContent = t("landing.timeline.elapsed", { n: elapsed.toFixed(0) });
  };
  tick();
  window.__landingEtaTimer = setInterval(tick, 250);
}

function stopEtaTicker() {
  if (window.__landingEtaTimer) {
    clearInterval(window.__landingEtaTimer);
    window.__landingEtaTimer = null;
  }
}

function setPhaseState(phase, state) {
  //  状态 ∈ “运行” | “完成”| “失败”
  const li = document.querySelector(`.landing-phase[data-phase="${phase}"]`);
  if (!li) return;
  li.hidden = false;  //  映射器开始隐藏，直到 phase_started 到达
  li.classList.remove("is-running", "is-done", "is-failed");
  if (state === "running") li.classList.add("is-running");
  if (state === "done") li.classList.add("is-done");
  if (state === "failed") li.classList.add("is-failed");
}

function setPhaseNarration(phase, text) {
  const li = document.querySelector(`.landing-phase[data-phase="${phase}"]`);
  if (!li) return;
  const slot = li.querySelector(".landing-phase-narration");
  if (!slot) return;
  slot.textContent = text;
  li.classList.add("has-narration");
}

function setTimelineTitle(text) {
  const t = document.getElementById("landingTimelineTitle");
  if (t) t.textContent = text;
}

function resetTimeline() {
  PHASE_ORDER.forEach((p) => {
    const li = document.querySelector(`.landing-phase[data-phase="${p}"]`);
    if (!li) return;
    li.classList.remove("is-running", "is-done", "is-failed", "has-narration");
    if (p === "mapper") li.hidden = true;
    const slot = li.querySelector(".landing-phase-narration");
    if (slot) slot.textContent = "";
  });
}

async function onSubmit(ev) {
  ev.preventDefault();
  if (isSubmitting) return;
  const t = window.t || ((k) => k);
  const deviceEl = document.getElementById("landingDevice");
  const symptomEl = document.getElementById("landingSymptom");
  const device = (deviceEl?.value || "").trim();
  const symptom = (symptomEl?.value || "").trim();

  if (device.length < 2) {
    setStatus(t("landing.status.validation_device"), STATUS_ERROR);
    deviceEl?.focus();
    return;
  }
  if (symptom.length < 5) {
    setStatus(t("landing.status.validation_symptom"), STATUS_ERROR);
    symptomEl?.focus();
    return;
  }

  setStatus(t("landing.status.checking"), STATUS_LOADING);
  setSubmitting(true);
  setLandingMascot("thinking");
  resetTimeline();

  try {
    //  如果技术人员从自动完成中选择了已知设备，请发送
    //  规范 slug 因此后端会跳过重新slug化并登陆
    //  正确的包——避开接近但不相同的拼写。
    const payload = { device_label: device, symptom };
    if (_selectedDeviceSlug) payload.device_slug = _selectedDeviceSlug;
    const res = await fetch(API_PREFIX + "/pipeline/repairs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${detail}`);
    }
    const repair = await res.json();
    const rid = repair.repair_id;
    const slug = repair.device_slug;
    if (!rid || !slug) throw new Error(t("landing.status.error_invalid_response"));

    //  三种响应形状，三种用户体验流程。
    //  分支 2 — 已知规则已涵盖症状：没有 LLM 工作，
    //  fast重新direct到workspace。
    if (!repair.pipeline_started) {
      if (repair.matched_rule_id) {
        setStatus(
          t("landing.status.rule_match", { rule_id: repair.matched_rule_id }),
          STATUS_NEUTRAL,
        );
      } else {
        setStatus(
          t("landing.status.device_known", { device: repair.device_label }),
          STATUS_NEUTRAL,
        );
      }
      //  打包到磁盘 → 播放加速的 fake-timeline（~15–17 秒），因此
      //  tech 将 cache hit 视为 fast 管道运行，然后进行导航。
      //  上面的 setStatus 消息保留为导入；设置时间线标题
      //  一旦辅助程序内的 showTimeline() 触发，就会接管。
      playCachedPipelineTimeline(slug, rid, repair.device_label || slug)
        .catch((err) => {
          console.warn("[landing] cached timeline failed, falling back to direct nav", err);
          goToWorkspace(rid, slug);
        });
      return;
    }

    //  分支 3 — 包存在，但症状是新的：后端被踢
    //  真正有针对性的后台扩展。我们玩同样的假-timeline
    //  作为分支 2（包位于磁盘上，代理甚至可以根据现有规则工作
    //  如果扩展尚未完成）。扩展运行无声无息——无害。
    if (repair.pipeline_kind === "expand") {
      setStatus(
        t("landing.status.device_known", { device: repair.device_label }),
        STATUS_NEUTRAL,
      );
      playCachedPipelineTimeline(slug, rid, repair.device_label || slug)
        .catch((err) => {
          console.warn("[landing] cached timeline (expand) failed, falling back", err);
          goToWorkspace(rid, slug, "#home");
        });
      return;
    }

    //  分支 1 — 新设备上的完整管道（约 5-10 分钟）。
    setStatus(t("landing.status.build_new"), STATUS_NEUTRAL);
    showTimeline();
    setTimelineTitle(t("landing.timeline.title_build", { device: repair.device_label }));
    subscribeToProgress(slug, rid);
  } catch (err) {
    console.error("[landing] submit failed", err);
    setStatus(t("landing.status.error_create", { error: err.message || err }), STATUS_ERROR);
    setLandingMascot("error");
    setSubmitting(false);
  }
}

function subscribeToProgress(slug, repairId) {
  if (progressWs && progressWs.readyState <= 1) {
    try { progressWs.close(); } catch (_) {}
  }
  const proto = (location.protocol === "https:") ? "wss:" : "ws:";
  const url = `${proto}//${location.host}${API_PREFIX}/pipeline/progress/${encodeURIComponent(slug)}`;

  progressWs = new WebSocket(url);

  progressWs.addEventListener("message", (ev) => {
    let data;
    try { data = JSON.parse(ev.data); }
    catch { return; }
    handleProgressEvent(data, slug, repairId);
  });

  progressWs.addEventListener("error", (ev) => {
    console.warn("[landing] progress WS error", ev);
    setStatus((window.t || ((k) => k))("landing.status.ws_lost"), STATUS_ERROR);
  });

  progressWs.addEventListener("close", () => {
    stopEtaTicker();
  });
}

function handleProgressEvent(ev, slug, repairId) {
  const t = window.t || ((k) => k);
  switch (ev.type) {
    case "subscribed":
      break;
    case "pipeline_started":
      setStatus(t("landing.status.pipeline_started", { device: ev.device_label || ev.device_slug || slug }), STATUS_LOADING);
      break;
    case "phase_started": {
      const phase = ev.phase;
      if (PHASE_ORDER.includes(phase) || phase === "expand") {
        setPhaseState(phase, "running");
        setLandingMascot("working");
      }
      break;
    }
    case "phase_finished": {
      const phase = ev.phase;
      if (PHASE_ORDER.includes(phase) || phase === "expand") {
        setPhaseState(phase, "done");
      }
      break;
    }
    case "phase_narration": {
      const phase = ev.phase;
      const text = (ev.text || "").trim();
      if (text && PHASE_ORDER.includes(phase)) setPhaseNarration(phase, text);
      break;
    }
    case "pipeline_finished": {
      setTimelineTitle(t("landing.timeline.title_ready", { status: ev.status || "" }));
      setStatus(t("landing.status.ready"), STATUS_NEUTRAL);
      stopEtaTicker();
      setLandingMascot("success");
      //  2500 毫秒 Grace 给出审核阶段旁白（Haiku ~800-1600 毫秒）
      //  在我们离开之前，是时候降落在 WS 总线上并进行渲染了。
      setTimeout(() => goToWorkspace(repairId, slug), 2500);
      break;
    }
    case "pipeline_failed": {
      setTimelineTitle(t("landing.timeline.title_failed"));
      setStatus(t("landing.status.error_pipeline", { error: ev.error || ev.status || t("landing.status.error_unknown") }), STATUS_ERROR);
      const running = document.querySelector(".landing-phase.is-running");
      if (running) {
        running.classList.remove("is-running");
        running.classList.add("is-failed");
      }
      stopEtaTicker();
      setLandingMascot("error");
      setSubmitting(false);
      break;
    }
    default:
      break;
  }
}

function setExpandMode() {
  //  将 5 阶段管道 timeline 折叠为单个“浓缩”
  //  row — 扩展路径运行目标 Scout + Registry 重建 +
  //  Clinicien 并且不遍历Mapper / Writers / Auditor。显示中
  //  5 个永远不会前进的待定点（因为相位事件携带
  //  阶段：“展开”不在 PHASE_ORDER 中）看起来已损坏。
  const t = window.t || ((k) => k);
  const tl = document.getElementById("landingTimeline");
  if (!tl) return;
  tl.classList.add("landing-timeline-expand");
  const phases = tl.querySelectorAll(".landing-phase");
  phases.forEach((el, i) => {
    if (i === 0) {
      //  将第一行重新用作单个“扩展”标记。放下
      //  [data-i18n] 挂钩，因此 applyDom() 不会恢复旧的“scout”标签。
      el.dataset.phase = "expand";
      el.classList.remove("is-done", "is-failed");
      el.classList.add("is-running");
      const label = el.querySelector(".landing-phase-label");
      if (label) {
        label.removeAttribute("data-i18n");
        label.textContent = t("landing.timeline.phase_expand");
      }
      const narr = el.querySelector(".landing-phase-narration");
      if (narr) narr.textContent = "";
    } else {
      //  在展开模式下隐藏其他相行。
      el.hidden = true;
    }
  });
}


function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

//  以每相约 3 秒的速度播放假 5 相管道 timeline，然后
//  mascot成功状态，然后导航到workspace。使用时
//  后端信号 `pipeline_started: false` （包已经在磁盘上）所以
//  技术人员将 cache hit 视为 fast 管道运行，而不是
//  瞬间闪现。总计约 15 秒 + 1.5 秒成功宽限期 = 约 16–17 秒。
async function playCachedPipelineTimeline(slug, repairId, deviceLabel) {
  const t = window.t || ((k) => k);
  showTimeline();
  setTimelineTitle(t("landing.timeline.title_loading", { device: deviceLabel }));
  setLandingMascot("working");

  //  PHASE_ORDER 包括实时管道将其标记为隐藏的“映射器”
  //  直到阶段事件到来。对于 cache hit 我们想要显示所有
  //  阶段已经过去，所以先取消隐藏它。
  const mapperRow = document.querySelector('.landing-phase[data-phase="mapper"]');
  if (mapperRow) mapperRow.hidden = false;

  const PER_PHASE_MS = 3000;
  for (const phase of PHASE_ORDER) {
    setPhaseState(phase, "running");
    await _sleep(PER_PHASE_MS * 0.7);
    setPhaseState(phase, "done");
    await _sleep(PER_PHASE_MS * 0.3);
  }

  setLandingMascot("success");
  setTimelineTitle(t("landing.timeline.title_ready", { status: deviceLabel }));
  await _sleep(1500);
  //  缓存命中：登陆修复仪表板（#home），以便技术人员看到
  //  直接发现+timeline，而不是实时的图表视图
  //  管道路径默认为。
  goToWorkspace(repairId, slug, "#home");
}

function goToWorkspace(repairId, slug, hash = "#graphe") {
  //  将技术放在图形视图上（加载图形+内存库+打开
  //  LLM 聊天面板（通过 openLLMPanelIfRepairParam）而不是
  //  home / Repair_dashboard 仅显示结果 + timeline。
  //  仪表板仍然可以通过左侧 rail #home 按钮访问。
  //
  //  首先剥离 landing overlay，以便仅使用哈希导航（当
  //  查询参数已经位于先前会话的 URL 上）
  //  不会让 overlay 坐在新装载的顶部
  //  图表视图。
  hideLanding();
  //  关闭任何活动的进度 WS，以便它无法触发延迟事件（例如
  //  导航后将 pipeline_finished) 复制到页面上。
  if (progressWs && progressWs.readyState <= 1) {
    try { progressWs.close(); } catch (_) {}
  }
  progressWs = null;

  const target = new URL(location.origin + location.pathname);
  target.searchParams.set("repair", repairId);
  target.searchParams.set("device", slug);
  target.hash = hash;

  //  强制进行真正的导航。同一 URL 的 location.href 是 no-op
  //  并且 location.href 到仅哈希增量不会重新加载页面 -
  //  任何一种情况都会导致 landing 模块的状态不一致
  //  与后管道视图。 location.assign + 重复时重新加载
  //  使用新的查询参数保证 main.js 的干净引导。
  if (target.toString() === location.href) {
    location.reload();
  } else {
    location.assign(target.toString());
  }
}

function onChipClick(ev) {
  const btn = ev.target.closest(".landing-chip");
  if (!btn) return;
  const dev = document.getElementById("landingDevice");
  const sym = document.getElementById("landingSymptom");
  //  芯片不带有规范的 slug；清除此处可防止陈旧
  //  _selectedDeviceSlug 从自动完成泄漏到 chip 提交。
  _selectedDeviceSlug = null;
  if (dev && btn.dataset.device) dev.value = btn.dataset.device;
  if (sym) {
    //  首选 i18n 键（如果存在），以便 chip 的症状与活动状态相匹配
    //  语言环境；回到文字数据症状属性。
    const key = btn.dataset.symptomKey;
    const fallback = btn.dataset.symptom || "";
    if (key && window.t) sym.value = window.t(key);
    else if (fallback) sym.value = fallback;
  }
  sym?.focus();
}

// ============================================================
//  设备自动完成 - 显示设备下已知的设备
//  输入为技术人员类型。源自 /pipeline/taxonomy 所以
//  列表被重复删除为每个（品牌、型号）一个条目 - 否
//  “iPhone X”/“iPhone X 逻辑板”/“iPhone X 工作台”噪音。
//  在“_devicesCache”中缓存会话。键盘导航：↑/↓/Enter/Esc。
//
//  在选择时，我们将所选包的规范 slug 存储在
//  这样 onSubmit 可以显式地将 `device_slug` 传递给后端，
//  保证 cache hit 在正确的包装上，而不是重新slug化
//  标签并冒着错过近似但不相同的拼写的风险。
// ============================================================

let _devicesCache = null;
let _suggestActiveIdx = -1;
let _selectedDeviceSlug = null;

function _escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Flatten a TaxonomyTree into a plain list with one entry per
// (brand, model) — picks the most-complete pack as the canonical
// representative. Uncategorized packs become individual entries.
function _flattenTaxonomy(tree) {
  const out = [];
  const brands = (tree && tree.brands) || {};
  for (const [brand, models] of Object.entries(brands)) {
    for (const [model, packs] of Object.entries(models || {})) {
      if (!Array.isArray(packs) || packs.length === 0) continue;
      // Prefer a complete pack; fall back to the first one.
      const canonical = packs.find((p) => p && p.complete) || packs[0];
      out.push({
        label: model,
        subtitle: brand,
        slug: canonical.device_slug,
        device_label: canonical.device_label || model,
        complete: Boolean(canonical.complete),
      });
    }
  }
  for (const p of (tree && tree.uncategorized) || []) {
    if (!p || !p.device_slug) continue;
    out.push({
      label: p.device_label || prettifySlug(p.device_slug),
      subtitle: null,
      slug: p.device_slug,
      device_label: p.device_label || prettifySlug(p.device_slug),
      complete: Boolean(p.complete),
    });
  }
  // Sort: complete first, then alphabetical by label.
  out.sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

async function loadPacksForSuggest() {
  try {
    const res = await fetch(API_PREFIX + "/pipeline/taxonomy");
    if (res.ok) {
      const tree = await res.json();
      _devicesCache = _flattenTaxonomy(tree);
    } else {
      _devicesCache = [];
    }
  } catch (err) {
    console.warn("[landing] loadPacksForSuggest failed", err);
    _devicesCache = [];
  }
}

function _matchDevices(query) {
  if (!_devicesCache || _devicesCache.length === 0) return [];
  const q = (query || "").trim().toLowerCase();
  if (q.length < 1) return [];
  return _devicesCache
    .filter((d) => {
      const label = (d.label || "").toLowerCase();
      const sub = (d.subtitle || "").toLowerCase();
      const slug = (d.slug || "").toLowerCase();
      return label.includes(q) || sub.includes(q) || slug.includes(q);
    })
    .slice(0, 6);
}

function _renderSuggest(query) {
  const box = document.getElementById("landingSuggest");
  if (!box) return;
  const matches = _matchDevices(query);
  if (matches.length === 0) {
    box.hidden = true;
    box.innerHTML = "";
    _suggestActiveIdx = -1;
    return;
  }
  const tFn = window.t || ((k) => k);
  const draftLabel = tFn("landing.suggest.draft");
  box.innerHTML = matches.map((d, i) => {
    const safeLabel = _escapeHtml(d.label);
    const safeSub = d.subtitle ? _escapeHtml(d.subtitle) : "";
    const safeSlug = _escapeHtml(d.slug);
    const iconClass = d.complete ? "is-complete" : "is-partial";
    const iconText = d.complete ? "✓" : "•";
    const meta = d.complete ? safeSub : (safeSub ? `${safeSub} · ${draftLabel}` : draftLabel);
    // data-label = the short model name (e.g. "iPhone 12") that lands in
    // the input on selection. NOT d.device_label, which is the raw
    // registry label (e.g. "Apple iPhone 12 logic board") and would
    // pollute the input with brand + form-factor noise.
    return `<div class="landing-suggest-item" role="option" `
      + `data-slug="${safeSlug}" data-label="${safeLabel}" data-index="${i}">`
      + `<span class="landing-suggest-icon ${iconClass}" aria-hidden="true">${iconText}</span>`
      + `<span class="landing-suggest-label">${safeLabel}</span>`
      + `<span class="landing-suggest-meta">${meta}</span>`
      + `</div>`;
  }).join("");
  box.hidden = false;
  _suggestActiveIdx = -1;
}

function _setSuggestActive(idx) {
  const items = document.querySelectorAll(".landing-suggest-item");
  if (items.length === 0) return;
  const clamped = Math.max(0, Math.min(idx, items.length - 1));
  items.forEach((el, i) => el.classList.toggle("is-active", i === clamped));
  _suggestActiveIdx = clamped;
  items[clamped].scrollIntoView({ block: "nearest" });
}

function _selectSuggest(label, slug) {
  const dev = document.getElementById("landingDevice");
  const sym = document.getElementById("landingSymptom");
  if (dev) dev.value = label;
  // Pin the canonical slug so onSubmit sends device_slug to the backend
  // (skips re-slugification of the label and guarantees the cache hit
  // on the right pack — defends against near-but-not-identical spellings).
  _selectedDeviceSlug = slug || null;
  _hideSuggest();
  if (sym) sym.focus();
}

function _hideSuggest() {
  const box = document.getElementById("landingSuggest");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
  _suggestActiveIdx = -1;
}

function _initSuggest() {
  const dev = document.getElementById("landingDevice");
  const box = document.getElementById("landingSuggest");
  if (!dev || !box) return;

  dev.addEventListener("input", () => {
    // Free-text editing invalidates the previously-selected slug — the
    // tech may now be heading toward a different (or unknown) device.
    _selectedDeviceSlug = null;
    _renderSuggest(dev.value);
  });

  dev.addEventListener("focus", () => {
    if (dev.value && dev.value.length >= 1) _renderSuggest(dev.value);
  });

  dev.addEventListener("keydown", (ev) => {
    const items = document.querySelectorAll(".landing-suggest-item");
    if (items.length === 0) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      _setSuggestActive(_suggestActiveIdx < 0 ? 0 : _suggestActiveIdx + 1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      _setSuggestActive(_suggestActiveIdx <= 0 ? items.length - 1 : _suggestActiveIdx - 1);
    } else if (ev.key === "Enter" && _suggestActiveIdx >= 0) {
      // Only intercept Enter when the user has explicitly highlighted a
      // suggestion via arrows. Otherwise let the form submit naturally.
      ev.preventDefault();
      const item = items[_suggestActiveIdx];
      if (item) _selectSuggest(item.dataset.label, item.dataset.slug);
    } else if (ev.key === "Escape") {
      _hideSuggest();
    }
  });

  // Hide on blur, but with a small delay so a click on a suggestion
  // (which fires after blur) gets processed first.
  dev.addEventListener("blur", () => setTimeout(_hideSuggest, 150));

  box.addEventListener("mousedown", (ev) => {
    // Use mousedown (not click) so it fires before blur on the input.
    const item = ev.target.closest(".landing-suggest-item");
    if (item && item.dataset.label) {
      ev.preventDefault();
      _selectSuggest(item.dataset.label, item.dataset.slug);
    }
  });
}

export function initLanding() {
  const form = document.getElementById("landingForm");
  if (form) form.addEventListener("submit", onSubmit);
  const chips = document.getElementById("landingChips");
  if (chips) chips.addEventListener("click", onChipClick);
  _initSuggest();
}
