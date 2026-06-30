import {
  ICON_CHECK,
  ICON_CIRCLE,
  ICON_CHECK_CIRCLE,
  ICON_X_CIRCLE,
  ICON_WARNING,
  ICON_FLAME,
  ICON_BOLT,
  ICON_LOCK,
  ICON_BAN,
  ICON_DIAMOND,
  ICON_DOT_FILLED,
  appendD3Warning,
} from './icons.js';
import { escapeHtml as escHtml } from "./shared/dom.js";
import { getDeviceSlug as ctxDeviceSlug, getRepairId as ctxRepairId } from "./shared/context.js";
import { API_PREFIX } from "./shared/api.js";

//  原理图部分 V5 — 电源诊断仪表板。
//
//  不是 KiCad 复制品 — 该视图可以回答 PDF 无法回答的问题：
//      - 端到端的+3V3从何而来？
//      - 如果U7死了，还有什么会失去力量？
//      - 哪些rail稳定在哪个启动阶段？
//
//  范围：仅约 115 个对电源 diagnostic 起作用的组件
//  MNT 级板 — rails + 其源 IC + 消费 IC + 去耦
//  上限。 300 个纯信号路由无源器件（R*、C*）保留在 PDF 中。
//
//  布局：X = 幂树中的因果深度（从根 rails 开始的 BFS），而不是
//  电压桶或schematic页。根rails（外部供应）坐
//  最左边，下游调节器流向右边。 Y 由力决定
//  软柱簇+强碰撞。
//
//  杀手特色：
//      - 终止开关级联：单击一个节点→突出显示所有终止的节点。
//      - Boot timeline：底部 4 个启动阶段的泳道。
//      - 丰富inspector：rail消费者，赋能链条，解耦边际。

const STATE = {
  slug: null,
  graph: null,
  model: null,
  zoom: null,
  selectedId: null,
  killswitch: false,         //  当 true 时，聚焦模式显示完整级联
  showSignals: false,
  showAllPins: false,
  //  整理全板布局（powertree / grid）：隐藏解耦
  //  电容 / 检测电阻（约 60% 的节点），因此 rails + 功能 IC 读取。
  hidePassives: ((typeof localStorage !== "undefined" && localStorage.getItem("schHidePassives")) ?? "1") !== "0",
  //  “railfocus”（默认，一次一个rail），“powertree”（所有rail堆叠），
  //  “电网”（相位×电压2D）。坚持到 localStorage 所以用户的
  //  选择棒。
  layoutMode: (typeof localStorage !== "undefined" && localStorage.getItem("schLayoutMode")) || "boot",
  //  在rail焦点模式下，rail当前显示在画布中。
  selectedRailId: (typeof localStorage !== "undefined" && localStorage.getItem("schSelectedRail")) || null,
  //  “graph”（默认，派生视图）或“pdf”（原始 schematic 页）。
  //  保留，以便用户的选择在重新输入部分后仍然有效。
  surface: (typeof localStorage !== "undefined" && localStorage.getItem("schSurface")) || "graph",
  //  PDF 查看器状态 — 页面有效负载、上次启动 slug、当前缩放。
  pdfPrimedSlug: null,
  pdfPages: null,        //  服务器响应 {count，pages:[{n,url,width_pt,height_pt,anchors}]}
  pdfZoom: 1.0,          //  应用于每个 .sch-pdf-page 的 CSS 缩放乘数
  pdfCurrentPage: 1,     //  视口中的主导页面（由滚动观察者更新）
};

//  从规范的 rail 标签推断标称电压。
//  “+3V3”→ 3.3，“+5V”→ 5，“+1V8”→ 1.8，“+12V”→ 12。未知标签→ null。
function inferRailNominalV(label) {
  if (typeof label !== "string") return null;
  const m = label.match(/^\+?(\d+)V(\d+)?$/i);
  if (!m) return null;
  const whole = parseInt(m[1], 10);
  if (!m[2]) return whole;
  const frac = parseFloat(`0.${m[2]}`);
  return whole + frac;
}

//  api/agent/measurement_memory.py::auto_classify 的客户端镜像。
//  使阈值与 Python 常量保持同步。
function clientAutoClassify(kind, value, unit, nominal) {
  if (kind === "rail" && (unit === "V" || unit === "mV")) {
    if (nominal == null || nominal === "") return null;
    //  将读数标准化为 V。“标称”是 rail 的 SI 目标
    //  （存储在堆栈中各处的 V 中），因此我们永远不会将其除以
    //  1000 — 请参阅 api/agent/measurement_memory.py 以获取匹配的修复。
    const v = unit === "mV" ? value / 1000 : value;
    const nom = nominal;
    if (v < 0.05) return "dead";
    const ratio = nom !== 0 ? v / nom : 0;
    if (ratio > 1.10) return "shorted";
    if (ratio >= 0.90) return "alive";
    return "anomalous";
  }
  if (kind === "comp" && unit === "°C") {
    return value >= 65 ? "hot" : "alive";
  }
  return null;
}

/*  ---------------------------------------------------------------------------------- *
 * 模拟 *
 * 驱动行为模拟器 UI：从 * 获取模拟时间线
 * POST /pipeline/packs/{slug}/schematic/simulate，公开播放 *
 * 控制，并将 sim-* CSS 类应用于每个阶段的节点/rail。 *
 * 现在的脚手架 - 洗涤器 UI 和状态级传播土地 *
 * 后续提交。                                                    *
 * ----------------------------------------------------------------------  */

export const SimulationController = {
  timeline: null,          //  服务器响应
  killedRefdes: [],        //  用户注入的故障
  observations: {
    state_comps:   new Map(),     //  refdes→“死”| “活着”| “异常”| “热”
    state_rails:   new Map(),     //  rail 标签→“死”| “活着”| “短路”
    metrics_comps: new Map(),     //  refdes → {测量，单位，标称？，注释？，ts}
    metrics_rails: new Map(),     //  rail → {测量，单位，标称？，注释？，ts}
  },
  hypotheses: null,
  playing: false,
  speedMs: 800,            //  1× 时每相毫秒
  cursor: 0,               //  当前阶段索引在 timeline.states 内
  _timer: null,

  async refresh(slug) {
    if (!slug) return;
    try {
      const res = await fetch(
        `/pipeline/packs/${encodeURIComponent(slug)}/schematic/simulate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ killed_refdes: this.killedRefdes }),
        },
      );
      if (!res.ok) {
        console.warn("[simulator] fetch failed", res.status);
        this.timeline = null;
        return;
      }
      this.timeline = await res.json();
      this.cursor = 0;
      this.render();
    } catch (err) {
      console.warn("[simulator] fetch error", err);
      this.timeline = null;
    }
  },

  render() {
    //  重新绘制统一引导播放器（传输标签、活动 pip、活动
    //  卡）和当前光标的图形状态类。玩家
    //  DOM 脚手架本身是由 fullRender 上的 renderBootTimeline() 构建的。
    this._syncPlayer();
    const on = ((typeof localStorage !== "undefined" && localStorage.getItem("simStatesVisible")) ?? "1") !== "0";
    if (on && this.timeline) {
      this._applyStateClasses();
    } else {
      this._clearStateClasses();
    }
  },

  //  光标指向的启动阶段索引 (model.boot[].index)，或者为 null。
  currentPhaseIndex() {
    const state = this.timeline?.states?.[this.cursor];
    return state ? state.phase_index : null;
  },

  //  将玩家从引导阶段指数（点数所携带的内容）中驱使。地图
  //  当 timeline 存在时，进入模拟状态；否则只是
  //  聚焦图形并刷新卡片（无需 sim 数据即可导航）。
  seekToPhase(phaseIndex) {
    if (this.timeline) {
      const idx = this.timeline.states.findIndex(s => s.phase_index === phaseIndex);
      if (idx >= 0) { this.seek(idx); return; }
    }
    if (STATE.model) {
      focusPhaseGraph(STATE.model, phaseIndex);
      renderBootActive(STATE.model, phaseIndex, null);
      this._markActivePip(phaseIndex);
    }
  },

  _markActivePip(phaseIdx) {
    document.querySelectorAll(".sch-player-pip").forEach(p => {
      p.classList.toggle("active", Number(p.dataset.phase) === phaseIdx);
    });
  },

  //  将光标状态反映到播放器镶边中，无需触摸图形焦点
  //  （焦点由seek/seekToPhase 显式驱动，因此播放可能会变暗）。
  _syncPlayer() {
    const phaseIdx = this.currentPhaseIndex();
    this._markActivePip(phaseIdx);
    if (STATE.model && phaseIdx != null) {
      renderBootActive(STATE.model, phaseIdx, this.timeline?.states?.[this.cursor] || null);
    }
    const pp = document.querySelector(".sch-player [data-act=play-pause]");
    if (pp) pp.textContent = this.playing ? "⏸" : "▶";
    const transport = document.querySelector(".sch-player-transport");
    if (transport) transport.classList.toggle("no-sim", !this.timeline);
    const states = document.querySelector(".sch-player [data-act=toggle-states]");
    if (states) {
      const on = ((typeof localStorage !== "undefined" && localStorage.getItem("simStatesVisible")) ?? "1") !== "0";
      states.classList.toggle("on", on);
    }
  },

  //  切换图是否带有每相 sim-* 状态 overlay。
  toggleStates() {
    const on = ((typeof localStorage !== "undefined" && localStorage.getItem("simStatesVisible")) ?? "1") !== "0";
    try { localStorage.setItem("simStatesVisible", on ? "0" : "1"); } catch (_) {}
    this.render();
  },

  _clearStateClasses() {
    //  从 schematic DOM 中删除每个 sim-* 类，以便图表返回
    //  其默认外观（无调光、无级联字形、无死亡
    //  轮廓）。当用户关闭 timeline 开关时调用。
    document.querySelectorAll(
      ".sim-off, .sim-rising, .sim-stable, .sim-dead, .sim-signal-high, .sim-signal-low, .sim-cascade"
    ).forEach((n) => n.classList.remove(
      "sim-off", "sim-rising", "sim-stable", "sim-dead", "sim-signal-high", "sim-signal-low", "sim-cascade",
    ));
  },

  _applyStateClasses() {
    const state = this.timeline?.states?.[this.cursor];
    if (!state) return;
    //  清除当前标记的任何内容的先前课程。
    this._clearStateClasses();

    //  节点 - 我们依赖于已附加的现有图形渲染器
    //  每个可选元素上的“data-refdes”/“data-rail”/“data-signal”。
    //  如果属性尚未连接（任务 13），则对于这些属性来说这是 no-op
    //  课程；洗涤器本身仍然会渲染。
    for (const [refdes, st] of Object.entries(state.components || {})) {
      document.querySelectorAll(`[data-refdes="${CSS.escape(refdes)}"]`).forEach((el) => {
        el.classList.add(`sim-${st}`);
      });
    }
    for (const [label, st] of Object.entries(state.rails || {})) {
      document.querySelectorAll(`[data-rail="${CSS.escape(label)}"]`).forEach((el) => {
        el.classList.add(`sim-${st}`);
      });
    }
    for (const [label, st] of Object.entries(state.signals || {})) {
      document.querySelectorAll(`[data-signal="${CSS.escape(label)}"]`).forEach((el) => {
        el.classList.add(`sim-signal-${st}`);
      });
    }

    //  覆盖：级联死亡节点 - 被杀死的上游rail的下游
    //  源但不是 direct 被用户杀死。时间线范围内，而不是
    //  阶段特定的——一旦级联被计算出来，这些节点就携带
    //  整个播放过程中的标记。
    const tl = this.timeline;
    if (tl) {
      const killedSet = new Set(tl.killed_refdes || []);
      for (const refdes of (tl.cascade_dead_components || [])) {
        if (killedSet.has(refdes)) continue;
        document.querySelectorAll(`[data-refdes="${CSS.escape(refdes)}"]`).forEach((el) => {
          el.classList.add("sim-cascade");
        });
      }
      for (const label of (tl.cascade_dead_rails || [])) {
        document.querySelectorAll(`[data-rail="${CSS.escape(label)}"]`).forEach((el) => {
          el.classList.add("sim-cascade");
        });
      }
    }
  },

  seek(idx) {
    const max = (this.timeline?.states?.length ?? 1) - 1;
    this.cursor = Math.max(0, Math.min(idx, max));
    const phaseIdx = this.currentPhaseIndex();
    if (STATE.model && phaseIdx != null) focusPhaseGraph(STATE.model, phaseIdx);
    this.render();
  },
  play() {
    if (!this.timeline || this.timeline.states.length === 0) return;
    this.playing = true;
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      const max = this.timeline.states.length - 1;
      if (this.cursor >= max) { this.pause(); return; }
      this.seek(this.cursor + 1);
    }, this.speedMs);
    this._syncPlayer();
  },
  pause() {
    this.playing = false;
    clearInterval(this._timer);
    this._timer = null;
    this._syncPlayer();
  },

  //  ---- 观察结果 ----
  setObservation(kind, key, mode, measurement = null) {
    //  种类：“comp” | “rail”
    //  模式：“死亡”| “活着”| “异常”| “热”| “短路” | “未知”
    const stateMap  = kind === "comp" ? this.observations.state_comps  : this.observations.state_rails;
    const metricMap = kind === "comp" ? this.observations.metrics_comps : this.observations.metrics_rails;
    if (mode === "unknown" || mode == null) {
      stateMap.delete(key);
      metricMap.delete(key);
    } else {
      stateMap.set(key, mode);
      if (measurement) {
        metricMap.set(key, {
          ...measurement,
          ts: measurement.ts || new Date().toISOString(),
        });
      }
    }
    this._applyObservationClasses();
  },
  clearObservations() {
    for (const m of Object.values(this.observations)) m.clear();
    this.hypotheses = null;
    this._applyObservationClasses();
    document.querySelectorAll(".sim-hypotheses-panel").forEach(p => p.remove());
  },
  //  获取修复的测量日志并播种本地观察结果
  //  包含每个目标最新事件的地图。反映Python端的
  //  synthesise_observations (latest-per-target wins, state lit only for
  //  valid mode literals). Silent no-op when no repair_id is in the URL.
  async hydrateFromJournal(slug) {
    const repairId = ctxRepairId();
    if (!slug || !repairId) return;
    try {
      const res = await fetch(
        `/pipeline/packs/${encodeURIComponent(slug)}/repairs/${encodeURIComponent(repairId)}/measurements`,
      );
      if (!res.ok) return;
      const payload = await res.json();
      const events = payload.measurements || [];
      //  Keep the latest event per target (events are stored in insertion order).
      const latest = new Map();
      for (const ev of events) latest.set(ev.target, ev);
      this.measurementHistory = events;  //  full journal, used by T19 timeline
      const COMP_MODES = new Set(["dead", "alive", "anomalous", "hot"]);
      const RAIL_MODES = new Set(["dead", "alive", "shorted", "stuck_on"]);
      for (const [target, ev] of latest) {
        const idx = target.indexOf(":");
        if (idx <= 0) continue;
        const kind = target.slice(0, idx);
        const key = target.slice(idx + 1);
        const mode = ev.auto_classified_mode;
        const measurement = (ev.value != null) ? {
          measured: ev.value, unit: ev.unit, nominal: ev.nominal,
          note: ev.note, ts: ev.timestamp,
        } : null;
        if (kind === "comp") {
          if (COMP_MODES.has(mode)) {
            this.observations.state_comps.set(key, mode);
          }
          if (measurement) this.observations.metrics_comps.set(key, measurement);
        } else if (kind === "rail") {
          //  Allow "anomalous" locally for UI; it's stripped / coerced at POST.
          if (RAIL_MODES.has(mode) || mode === "anomalous") {
            this.observations.state_rails.set(key, mode);
          }
          if (measurement) this.observations.metrics_rails.set(key, measurement);
        }
      }
      this._applyObservationClasses();
    } catch (err) {
      console.warn("[hydrateFromJournal] failed", err);
    }
  },
  async loadMeasurementHistory(target) {
    const slug = STATE.slug;
    const repairId = ctxRepairId();
    if (!slug || !repairId) return [];
    try {
      const res = await fetch(
        `/pipeline/packs/${encodeURIComponent(slug)}/repairs/${encodeURIComponent(repairId)}/measurements?target=${encodeURIComponent(target)}`,
      );
      if (!res.ok) return [];
      const payload = await res.json();
      return payload.measurements || [];
    } catch (err) {
      console.warn("[measurements] GET failed", err);
      return [];
    }
  },
  _applyObservationClasses() {
    document
      .querySelectorAll(".obs-dead, .obs-alive, .obs-anomalous, .obs-hot, .obs-shorted")
      .forEach(n => n.classList.remove(
        "obs-dead", "obs-alive", "obs-anomalous", "obs-hot", "obs-shorted",
      ));
    for (const [refdes, mode] of this.observations.state_comps) {
      document.querySelectorAll(`[data-refdes="${CSS.escape(refdes)}"]`).forEach(el => {
        el.classList.add(`obs-${mode}`);
      });
    }
    for (const [rail, mode] of this.observations.state_rails) {
      document.querySelectorAll(`[data-rail="${CSS.escape(rail)}"]`).forEach(el => {
        el.classList.add(`obs-${mode}`);
      });
    }
  },

  //  ---- Reverse-diagnostic: hypothesize + results panel ----
  async hypothesize(slug) {
    const obs = this.observations;
    const totalObs = obs.state_comps.size + obs.state_rails.size
                   + obs.metrics_comps.size + obs.metrics_rails.size;
    if (totalObs === 0) return;
    //  Backend RailMode accepts dead/alive/shorted/stuck_on (Phase 4.5).
    //  Phase 1 scoring doesn't model anomalous rails — we coerce sagging
    //  readings to "dead" so the buck upstream still scores as top
    //  candidate. The raw metric rides along in metrics_rails so the
    //  narrative cites the exact value.
    const RAIL_MODES = new Set(["dead", "alive", "shorted", "stuck_on"]);
    const stateRailsOut = {};
    for (const [k, v] of obs.state_rails) {
      if (RAIL_MODES.has(v)) stateRailsOut[k] = v;
      else if (v === "anomalous") stateRailsOut[k] = "dead";
    }
    //  Backend ObservedMetric forbids extras (ts, note). Strip UI-only fields.
    const stripMetric = (m) => {
      const out = { measured: m.measured, unit: m.unit };
      if (m.nominal != null) out.nominal = m.nominal;
      return out;
    };
    const metricsCompsOut = {};
    for (const [k, v] of obs.metrics_comps) metricsCompsOut[k] = stripMetric(v);
    const metricsRailsOut = {};
    for (const [k, v] of obs.metrics_rails) metricsRailsOut[k] = stripMetric(v);
    const body = {
      state_comps:   Object.fromEntries(obs.state_comps),
      state_rails:   stateRailsOut,
      metrics_comps: metricsCompsOut,
      metrics_rails: metricsRailsOut,
      max_results: 5,
    };
    try {
      const res = await fetch(
        `/pipeline/packs/${encodeURIComponent(slug)}/schematic/hypothesize`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
      if (!res.ok) {
        const detail = await res.text();
        console.error("[hypothesize] HTTP", res.status, detail);
        return;
      }
      const payload = await res.json();
      this.hypotheses = payload.hypotheses || [];
      this._renderHypothesesPanel();
    } catch (err) {
      console.error("[hypothesize] fetch error", err);
    }
  },

  _renderHypothesesPanel() {
    document.querySelectorAll(".sim-hypotheses-panel").forEach(p => p.remove());
    if (!this.hypotheses || this.hypotheses.length === 0) return;
    const panel = document.createElement("div");
    panel.className = "sim-hypotheses-panel";
    panel.innerHTML = `
      <div class="sim-hyp-head">
        <span class="sim-hyp-title">${escHtml(t("schematic.simulator.hypotheses_title", { count: this.hypotheses.length }))}</span>
        <button class="sim-hyp-close" title="${t("schematic.simulator.hyp_close_title")}">×</button>
      </div>
      <div class="sim-hyp-body"></div>
    `;
    panel.querySelector(".sim-hyp-close").addEventListener("click", () => panel.remove());

    const body = panel.querySelector(".sim-hyp-body");
    this.hypotheses.forEach((h, i) => {
      const card = document.createElement("div");
      card.className = "sim-hyp-card";
      const chips = h.kill_refdes.map((r, i) => {
        const m = (h.kill_modes || [])[i] || "dead";
        const modeLabel = t(`schematic.modes.${m}`) || m;
        return `<span class="sim-hyp-chip sim-hyp-chip--${m}">${escHtml(r)} · ${escHtml(modeLabel)}</span>`;
      }).join(" + ");
      const contradictions = (h.diff.contradictions || []).map(c => {
        if (Array.isArray(c) && c.length === 3) {
          const [target, observed, predicted] = c;
          return `<span class="sim-hyp-tag sim-hyp-tag-fp">${escHtml(t("schematic.simulator.hyp_predicted", { target, observed, predicted }))}</span>`;
        }
        return `<span class="sim-hyp-tag sim-hyp-tag-fp">${escHtml(c)}</span>`;
      }).join(" ");
      const missing = (h.diff.under_explained || []).map(c => `<span class="sim-hyp-tag sim-hyp-tag-fn">${escHtml(c)}</span>`).join(" ");
      card.innerHTML = `
        <div class="sim-hyp-card-head">
          <span class="sim-hyp-rank">#${i + 1}</span>
          <span class="sim-hyp-kills">${chips}</span>
          <span class="sim-hyp-score">${escHtml(t("schematic.simulator.hyp_score", { score: h.score.toFixed(1) }))}</span>
        </div>
        <div class="sim-hyp-narr">${escHtml(h.narrative)}</div>
        ${contradictions ? `<div class="sim-hyp-diff"><span class="k">${escHtml(t("schematic.simulator.hyp_contradicts"))}</span> ${contradictions}</div>` : ""}
        ${missing ? `<div class="sim-hyp-diff"><span class="k">${escHtml(t("schematic.simulator.hyp_does_not_cover"))}</span> ${missing}</div>` : ""}
      `;
      card.addEventListener("click", () => {
        //  通过将此kill set注入模拟器来预览级联。
        SimulationController.killedRefdes = [...h.kill_refdes];
        SimulationController.refresh(STATE.slug);
      });
      body.appendChild(card);
    });

    const host = document.querySelector("#schematicSection") || document.body;
    host.appendChild(panel);
  },
};

function getDeviceSlug() {
  return ctxDeviceSlug();
}

function el(id) { return document.getElementById(id); }

/*  ---------------------------------------------------------------------------------- *
 * 获取 *
 * ----------------------------------------------------------------------  */

async function fetchSchematic(slug) {
  try {
    const res = await fetch(API_PREFIX + `/pipeline/packs/${encodeURIComponent(slug)}/schematic`);
    if (res.status === 404) return { missing: true };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { graph: await res.json() };
  } catch (err) {
    return { error: String(err) };
  }
}

/*  ---------------------------------------------------------------------------------- *
 * 模型 — 过滤诊断相关组件，计算因果深度 *
 * ----------------------------------------------------------------------  */

const POWER_PIN_ROLES = new Set([
  "power_in", "power_out", "switch_node", "enable_in", "enable_out",
  "power_good_out", "reset_in", "reset_out", "feedback_in", "ground",
]);

//  当 R/L/铁氧体触摸时，它们始终包含在默认视图中。
//  电源 rail — 它们是重要的上拉/感应/滤波器无源器件
//  功率diagnostics。模块级别，因此 buildModel 可以合成边缘
//  他们稍后在同一功能中。
const ALWAYS_RL_TYPES_GLOBAL = new Set(["resistor", "inductor", "ferrite"]);

//  第 4 阶段 — 观察选择器的感知模式设置。
//  键与后端 ComponentKind 值 +“rail”匹配。
const MODE_SETS = {
  ic:         ["unknown", "alive", "dead", "anomalous", "hot"],
  passive_r:  ["unknown", "alive", "open", "short"],
  passive_c:  ["unknown", "alive", "open", "short"],
  passive_d:  ["unknown", "alive", "open", "short"],
  passive_fb: ["unknown", "alive", "open", "short"],
  passive_q:  ["unknown", "alive", "open", "short", "stuck_on", "stuck_off"],
  rail:       ["unknown", "alive", "dead", "shorted", "stuck_on"],
};

const MODE_GLYPH = {
  unknown:   ICON_CIRCLE,
  alive:     ICON_CHECK_CIRCLE,
  dead:      ICON_X_CIRCLE,
  anomalous: ICON_WARNING,
  hot:       ICON_FLAME,
  shorted:   ICON_BOLT,
  open:      ICON_CIRCLE,
  short:     ICON_BOLT,
  stuck_on:  ICON_LOCK,
  stuck_off: ICON_BAN,
};

//  每个模式的人类可读标签 - 在调用时通过 i18n 解析，因此
//  选择器在区域设置切换上正确重新呈现。
function modeLabel(m) { return t(`schematic.modes.${m}`) || m; }

//  如果某个组件的任何引脚具有已知的电压，则该组件“接触电源 rail”
//  电源角色（电源输入/输出、接地、开关节点、启用输入/输出）或
//  `net_label` 与已编译的 rail 标签匹配。用于决定是否
//  在默认电源树视图中自动包含 R/L/FB。
function touchesPowerRail(comp, rails) {
  for (const p of comp.pins || []) {
    const role = p.role || "";
    if (role === "power_in" || role === "power_out" || role === "ground" ||
        role === "switch_node" || role === "enable_in" || role === "enable_out" ||
        role === "power_good_out" || role === "feedback_in") {
      return true;
    }
    if (p.net_label && rails[p.net_label]) return true;
  }
  return false;
}

function firstPage(comp) {
  return (comp.pages && comp.pages.length) ? comp.pages[0] : 0;
}

function classifyPins(comp, showAll) {
  const pins = comp.pins || [];
  const visible = [];
  let hidden = 0;
  for (const p of pins) {
    const isPower = POWER_PIN_ROLES.has(p.role || "");
    if (showAll || isPower) visible.push(p);
    else hidden += 1;
  }
  return { all: pins, visible, hidden };
}

//  为每个可见引脚分配一侧以进行渲染。来源对齐输入
//  左边，输出在右边。规则镜像 V4 中的布局引脚，但是
//  更简单——V5仅引脚IC（源+消费者），从不去耦电容。
function layoutPins(comp, showAll) {
  const { visible, hidden } = classifyPins(comp, showAll);
  const sides = { left: [], right: [], top: [], bottom: [] };
  const sideFor = (r) => {
    if (r === "power_in" || r === "enable_in" || r === "reset_in" || r === "feedback_in" || r === "clock_in") return "left";
    if (r === "power_out" || r === "switch_node" || r === "power_good_out" || r === "reset_out" || r === "enable_out" || r === "clock_out") return "right";
    if (r === "ground") return "bottom";
    return null;
  };
  const unsorted = [];
  for (const p of visible) {
    const s = sideFor(p.role);
    if (s) sides[s].push(p);
    else unsorted.push(p);
  }
  for (const p of unsorted) {
    const order = ["right", "left", "top", "bottom"].sort((a, b) => sides[a].length - sides[b].length);
    sides[order[0]].push(p);
  }
  return { sides, hidden, all: visible };
}

function buildModel(graph) {
  const rails = graph.power_rails || {};
  const components = graph.components || {};
  //  更喜欢 Opus - 细化的启动顺序（如果存在）——更丰富的阶段
  //  种类、证据、信心、物体形状的触发器_下一个。
  const analyzed = graph.analyzed_boot_sequence;
  const source = graph.boot_sequence_source || "compiler";
  const boot = (source === "analyzer" && analyzed?.phases?.length)
    ? analyzed.phases
    : (graph.boot_sequence || []);

  //  --- 1. 选择与诊断相关的组件子集 ---------------
  const sourceRefs = new Set();
  const consumerRefs = new Set();
  const decouplingRefs = new Set();
  for (const rail of Object.values(rails)) {
    if (rail.source_refdes) sourceRefs.add(rail.source_refdes);
    (rail.consumers || []).forEach(c => consumerRefs.add(c));
    (rail.decoupling || []).forEach(c => decouplingRefs.add(c));
  }

  const nodes = [];
  const nodeById = new Map();

  //  先说铁轨。
  for (const [label, rail] of Object.entries(rails)) {
    const phaseIdx = boot.findIndex(p => (p.rails_stable || []).includes(label));
    const n = {
      id: `rail:${label}`,
      kind: "rail",
      label,
      voltage_nominal: rail.voltage_nominal,
      source_refdes: rail.source_refdes,
      source_type: rail.source_type,
      enable_net: rail.enable_net,
      consumers: rail.consumers || [],
      decoupling: rail.decoupling || [],
      phase: phaseIdx >= 0 ? boot[phaseIdx].index : null,
      width: 100, height: 36, shape: "hex",
    };
    nodes.push(n); nodeById.set(n.id, n);
  }

  //  要包含的组件 - 此视图是电源树，而不是完整的电路板：
  //      - rail引用的节点（作为源、消费者或解耦帽）
  //          — 电力树的支柱
  //      - 引脚接触电源rail的电阻器、电感器、铁氧体
  //          （EN 线上的上拉电阻、检测电阻、滤波电感 — 不可见
  //          否则但对于诊断偏差失败很有用）
  //  仅信号无源（无电源rail引脚）被故意排除；他们
  //  没有启动/电源边缘，只会增加断开噪声。的
  //  “hidePassives”切换可在渲染时整理建模的被动元件。
  const railReferenced = new Set([...sourceRefs, ...consumerRefs, ...decouplingRefs]);
  const all = new Set(railReferenced);
  for (const [refdes, comp] of Object.entries(components)) {
    if (ALWAYS_RL_TYPES_GLOBAL.has(comp.type) && touchesPowerRail(comp, rails)) {
      all.add(refdes);
    }
  }
  for (const refdes of all) {
    const comp = components[refdes];
    if (!comp) {
      //  组件被引用但缺失——我们仍然创建一个存根节点
      //  所以边缘不会孤立，只需标记它即可。
      const n = {
        id: `comp:${refdes}`,
        kind: "component",
        refdes,
        type: "other",
        role: sourceRefs.has(refdes) ? "source" : (decouplingRefs.has(refdes) ? "decoupling" : "consumer"),
        missing: true,
        width: 40, height: 20, shape: "rect",
        pins: { sides: { left: [], right: [], top: [], bottom: [] }, hidden: 0, all: [] },
        phase: null,
      };
      nodes.push(n); nodeById.set(n.id, n);
      continue;
    }
    //  角色：监管者也可能是消费者——来源角色优先。
    const role = sourceRefs.has(refdes)
      ? "source"
      : (decouplingRefs.has(refdes) && !consumerRefs.has(refdes))
        ? "decoupling"
        : "consumer";
    const isPassive = role === "decoupling" || ["capacitor", "resistor", "inductor", "ferrite"].includes(comp.type);
    const size = role === "source" ? 64 : role === "decoupling" ? 14 : (isPassive ? 18 : 48);
    const shape = role === "decoupling" ? "capsule" : (role === "source" ? "rect-big" : (isPassive ? "capsule" : "rect"));
    const pins = layoutPins(comp, STATE.showAllPins);
    const showPins = role !== "decoupling" && comp.type !== "resistor";

    const phaseIdx = boot.findIndex(p => (p.components_entering || []).includes(refdes));
    const n = {
      id: `comp:${refdes}`,
      kind: "component",
      compKind: comp.kind || "ic",   //  第 4 阶段：后端 ComponentKind (ic|passive_r|passive_c|passive_d|passive_fb)
      refdes,
      type: comp.type,
      value: comp.value,
      pages: comp.pages || [],
      populated: comp.populated !== false,
      role,
      pins,
      showPins,
      pinsAll: comp.pins || [],
      phase: phaseIdx >= 0 ? boot[phaseIdx].index : null,
      width: size + (role === "source" ? 10 : 0),
      height: size,
      shape,
    };
    //  根据每侧的引脚数调整 IC 宽度，使其不会重叠。
    if (role === "source" || role === "consumer") {
      const maxSide = Math.max(pins.sides.left.length, pins.sides.right.length);
      n.height = Math.max(n.height, 18 + maxSide * 12);
      const maxTopBot = Math.max(pins.sides.top.length, pins.sides.bottom.length);
      n.width = Math.max(n.width, 34 + maxTopBot * 12);
    }
    nodes.push(n); nodeById.set(n.id, n);
  }

  //  --- 2. 边缘--------------------------------------------------------
  const edges = [];
  for (const [label, rail] of Object.entries(rails)) {
    const railId = `rail:${label}`;
    if (rail.source_refdes && nodeById.has(`comp:${rail.source_refdes}`)) {
      edges.push({
        id: `e:prod:${rail.source_refdes}->${label}`,
        kind: "produces",
        sourceId: `comp:${rail.source_refdes}`,
        targetId: railId,
        netLabel: label,
      });
    }
    for (const c of rail.consumers || []) {
      if (c === rail.source_refdes) continue;
      if (!nodeById.has(`comp:${c}`)) continue;
      edges.push({
        id: `e:pow:${label}->${c}`,
        kind: "powers",
        sourceId: railId,
        targetId: `comp:${c}`,
        netLabel: label,
      });
    }
    for (const d of rail.decoupling || []) {
      if (!nodeById.has(`comp:${d}`)) continue;
      edges.push({
        id: `e:dec:${d}->${label}`,
        kind: "decouples",
        sourceId: `comp:${d}`,
        targetId: railId,
        netLabel: label,
      });
    }
  }

  //  --- 2b.合成 R/L/铁氧体的缺失边缘 --------------
  //  始终包含接触 rail（通过其引脚）的 R/L/FB，但是
  //  未在 `rail.consumers` 中列出，与 Opus 没有明确的边缘 —
  //  如果没有可见的链接，可视化看起来就像组件是浮动的
  //  在与它无关的rail线上。从中创建“权力”边缘
  //  对于每个 rail 接触引脚，rail 到组件，因此用户
  //  实际上看到*为什么*它坐在那里。
  const existingEdgeKeys = new Set(
    edges.map(e => `${e.kind}|${e.sourceId}|${e.targetId}`)
  );
  for (const [refdes, comp] of Object.entries(components)) {
    if (!ALWAYS_RL_TYPES_GLOBAL.has(comp.type)) continue;
    const compId = `comp:${refdes}`;
    if (!nodeById.has(compId)) continue;
    const touchedRails = new Set();
    for (const p of comp.pins || []) {
      if (p.net_label && rails[p.net_label] && p.net_label !== "GND") {
        touchedRails.add(p.net_label);
      }
    }
    for (const railLabel of touchedRails) {
      const railId = `rail:${railLabel}`;
      const key = `powers|${railId}|${compId}`;
      if (existingEdgeKeys.has(key)) continue;
      edges.push({
        id: `e:pow-syn:${railLabel}->${refdes}`,
        kind: "powers",
        sourceId: railId,
        targetId: compId,
        netLabel: railLabel,
      });
      existingEdgeKeys.add(key);
    }
  }

  //  --- 2c.信号边沿（通过“Signaux”切换选择加入）-------------
  //  当 STATE.showSignals 打开时，表面非功率 typed_edges （启用，
  //  时钟、重置、产生信号、消耗信号），因此技术可以
  //  遵循 IC 中的 PG/EN/CLOCK 链。这些边缘杂乱
  //  可视化始终可见——因此需要切换。
  if (STATE.showSignals) {
    const SIGNAL_KINDS = new Set([
      "enables", "clocks", "resets", "produces_signal",
      "consumes_signal", "feedback_in",
    ]);
    for (const e of graph.typed_edges || []) {
      if (!SIGNAL_KINDS.has(e.kind)) continue;
      const srcId = nodeById.has(`comp:${e.src}`)
        ? `comp:${e.src}`
        : nodeById.has(`rail:${e.src}`) ? `rail:${e.src}` : null;
      const dstId = nodeById.has(`comp:${e.dst}`)
        ? `comp:${e.dst}`
        : nodeById.has(`rail:${e.dst}`) ? `rail:${e.dst}` : null;
      if (!srcId || !dstId || srcId === dstId) continue;
      const key = `signal|${srcId}|${dstId}|${e.kind}`;
      if (existingEdgeKeys.has(key)) continue;
      edges.push({
        id: `e:sig:${e.kind}:${e.src}->${e.dst}`,
        kind: "signal",
        subkind: e.kind,
        sourceId: srcId,
        targetId: dstId,
        netLabel: null,
      });
      existingEdgeKeys.add(key);
    }
  }

  //  --- 3.因果深度（BFS） ------------------------------------------
  //  根rails：没有source_refdes或source_refdes不在我们的节点集中。
  const depth = new Map();
  for (const n of nodes) {
    if (n.kind === "rail" && (!n.source_refdes || !nodeById.has(`comp:${n.source_refdes}`))) {
      depth.set(n.id, 0);
    }
  }
  //  迭代直至收敛。
  let changed = true; let safety = 0;
  while (changed && safety < 30) {
    changed = false; safety += 1;
    //  分量：深度 = max(它消耗的深度 rails) + 1
    for (const n of nodes) {
      if (n.kind !== "component") continue;
      const incomingPower = edges.filter(e => e.kind === "powers" && e.targetId === n.id);
      const decoupleTargets = edges.filter(e => e.kind === "decouples" && e.sourceId === n.id);
      let d = depth.get(n.id);
      if (incomingPower.length > 0) {
        const maxD = Math.max(...incomingPower.map(e => depth.get(e.sourceId) ?? -Infinity));
        if (maxD !== -Infinity) {
          const nd = maxD + 1;
          if (d == null || d < nd) { depth.set(n.id, nd); changed = true; }
        }
      } else if (decoupleTargets.length > 0 && n.role === "decoupling") {
        //  去耦帽位于它们去耦的 rail 深度。
        const maxD = Math.max(...decoupleTargets.map(e => depth.get(e.targetId) ?? -Infinity));
        if (maxD !== -Infinity) {
          if (d == null || d < maxD) { depth.set(n.id, maxD); changed = true; }
        }
      }
    }
    //  带源的 Rails：深度 = 深度（源）+ 1
    for (const n of nodes) {
      if (n.kind !== "rail") continue;
      if (!n.source_refdes) continue;
      const sd = depth.get(`comp:${n.source_refdes}`);
      if (sd != null) {
        const nd = sd + 1;
        const d = depth.get(n.id);
        if (d == null || d < nd) { depth.set(n.id, nd); changed = true; }
      }
    }
  }
  //  孤儿 → 深度 0。
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);

  //  --- 4. 每个节点的临界分数（爆炸半径） ------------------
  //  从每个节点向前走“产生”+“权力”，计算
  //  下游级联。标准化，使最大影响 SPOF 为 1.0。
  const blastRadius = new Map();
  const forwardAdj = new Map();
  for (const e of edges) {
    if (e.kind !== "powers" && e.kind !== "produces") continue;
    if (!forwardAdj.has(e.sourceId)) forwardAdj.set(e.sourceId, []);
    forwardAdj.get(e.sourceId).push(e.targetId);
  }
  for (const n of nodes) {
    const dead = new Set();
    const stack = [n.id];
    while (stack.length) {
      const c = stack.pop();
      for (const nxt of forwardAdj.get(c) || []) {
        if (!dead.has(nxt)) { dead.add(nxt); stack.push(nxt); }
      }
    }
    blastRadius.set(n.id, dead.size);
  }
  const maxBlast = Math.max(1, ...blastRadius.values());
  const totalNodes = nodes.length || 1;
  for (const n of nodes) {
    const br = blastRadius.get(n.id) || 0;
    n.blastRadius = br;
    n.impactPct = Math.round(1000 * br / totalNodes) / 10;
    n.criticality = br / maxBlast;     //  0..1 相对
  }
  //  直观地标记前 5 个SPOF。
  const sortedByBlast = [...nodes].sort((a, b) => b.blastRadius - a.blastRadius);
  const spofCutoff = Math.min(5, sortedByBlast.length);
  for (let i = 0; i < spofCutoff; i++) {
    if (sortedByBlast[i].blastRadius >= 2) sortedByBlast[i].isSpof = true;
  }

  //  统计栏的启动阶段计数。
  const totals = {
    phases: (graph.boot_sequence || []).length,
  };

  return { rails, boot, nodes, nodeById, edges, depth,
           bootSource: source, analyzerMeta: analyzed || null,
           maxBlast, totalNodes, totals };
}

/*  ---------------------------------------------------------------------------------- *
 * 布局 — 相位 × 电压网格。每个节点位于（phaseCol，VoltageRow）
 * 每个单元内基于力的细化以避免碰撞。
 * ----------------------------------------------------------------------  */

const COL_W = 320;      //  每相列宽
const ROW_H = 170;      //  每个电压行的高度
const GRID_TOP = 110;   //  第一行中心的 y
const GRID_LEFT = 180;  //  第一列中心的 x

//  电压行，顶部→底部。仅信号节点属于最后一行。
const V_ROWS = [
  { id: "vHi",   label: "≥ 12 V",  min: 12,        max: Infinity },
  { id: "v5_11", label: "5-11 V",  min: 5,         max: 11.999   },
  { id: "v3v3",  label: "3V3",     min: 3,         max: 4.999    },
  { id: "v1v8",  label: "1V8-2V5", min: 1.2001,    max: 2.999    },
  { id: "vCore", label: "≤ 1V2",   min: 0.01,      max: 1.2      },
  { id: "vSig",  label: "Signaux", min: null,      max: null     },
];

function voltageRowFor(v) {
  if (v == null) return "vSig";
  for (const r of V_ROWS) {
    if (r.min == null) continue;
    if (v >= r.min && v <= r.max) return r.id;
  }
  return "vSig";
}

function primaryPowerRailLabel(pinsList, rails) {
  //  优先选择 role=power_in，然后任何接触非 GND rail 的引脚。
  for (const p of pinsList || []) {
    if (p.role === "power_in" && p.net_label && rails[p.net_label]) return p.net_label;
  }
  for (const p of pinsList || []) {
    if (p.net_label && rails[p.net_label] && p.net_label !== "GND") return p.net_label;
  }
  return null;
}

function assignGridCoords(model) {
  //  对于rails：电压行是其电压_标称桶。
  //  对于源（产生 rail X）：X 的电压。
  //  对于消费者：其主输入电压rail。
  //  对于去耦电容：rail 电压去耦。
  //
  //  阶段分配：Opus 仅对*有源*组件（IC、
  //  调节器、连接器）。无源器件（去耦电容、串联电阻）
  //  永远不会“启动”，所以它们有phase==null，否则会落在
  //  预启动列在图表上有一个长的弹出箭头。修复：我们
  //  从它所附加的 rail/IC 继承被动的相位，因此它
  //  位于其逻辑锚点旁边。
  const rails = model.rails || {};
  const railPhase = new Map();
  for (const n of model.nodes) {
    if (n.kind === "rail") railPhase.set(n.label, n.phase);
  }
  const componentPhase = new Map();
  for (const n of model.nodes) {
    if (n.kind === "component") componentPhase.set(n.refdes, n.phase);
  }

  for (const n of model.nodes) {
    if (n.kind === "rail") {
      n.voltageRow = voltageRowFor(n.voltage_nominal);
      continue;
    }
    if (n.role === "source") {
      const prodEdge = (model.edges || []).find(e => e.kind === "produces" && e.sourceId === n.id);
      const prodRail = prodEdge ? rails[prodEdge.netLabel] : null;
      n.voltageRow = voltageRowFor(prodRail?.voltage_nominal);
      //  源 IC 应与其产生的 rail 位于同一相位
      //  （所以生产者 → rail 箭头很短并且在单元格内）。
      if (n.phase == null && prodEdge) {
        const inherited = railPhase.get(prodEdge.netLabel);
        if (inherited != null) n.phase = inherited;
      }
      continue;
    }
    if (n.role === "decoupling") {
      const decEdge = (model.edges || []).find(e => e.kind === "decouples" && e.sourceId === n.id);
      const decRail = decEdge ? rails[decEdge.netLabel] : null;
      n.voltageRow = voltageRowFor(decRail?.voltage_nominal);
      //  无论 rail 存在于何处，解耦帽都会存在 — 稳定
      //  rail是本地供应，它没有自己的“启动阶段”。
      if (decEdge) {
        const inherited = railPhase.get(decEdge.netLabel);
        if (inherited != null) n.phase = inherited;
      }
      continue;
    }
    //  消费者——看看它的主要力量rail
    const pinsList = Array.isArray(n.pinsAll) ? n.pinsAll : [];
    let railLabel = primaryPowerRailLabel(pinsList, rails);
    //  回退：如果组件没有识别的电源引脚，但
    //  列为一个或多个 rail（Opus 派生）的消费者，选择
    //  第一个rail属于rails地图。使节点不参与
    //  孤儿带，即使其引脚角色未指定。
    if (!railLabel) {
      for (const [label, r] of Object.entries(rails)) {
        if ((r.consumers || []).includes(n.refdes)) { railLabel = label; break; }
      }
    }
    n.voltageRow = voltageRowFor(railLabel ? rails[railLabel]?.voltage_nominal : null);
    n.rail_primary = railLabel;  //  由 power-tree 布局锚点使用
    //  没有显式阶段的消费者从其主rail继承。
    if (n.phase == null && railLabel) {
      const inherited = railPhase.get(railLabel);
      if (inherited != null) n.phase = inherited;
    }
  }
}

const GRID_CPC = 4;        //  相×电压单元内每行chips
const GRID_SLOT_W = 70;
const GRID_SLOT_H = 32;
const GRID_CELL_PAD = 24;  //  单元内的净空
const GRID_ROW_GAP = 28;

function computeGridLayout(model) {
  assignGridCoords(model);
  model.layoutMode = "grid";

  const phasesPresent = Array.from(new Set(
    model.nodes.map(n => n.phase).filter(p => p != null)
  )).sort((a, z) => a - z);
  if (model.nodes.some(n => n.phase == null)) phasesPresent.unshift(null);
  const phaseColIndex = new Map();
  phasesPresent.forEach((p, i) => phaseColIndex.set(p, i));
  const colX = (phase) => GRID_LEFT + (phaseColIndex.get(phase) ?? 0) * COL_W;

  //  只有渲染的节点参与（默认情况下隐藏被动节点）。
  const considered = model.nodes.filter(n => !(STATE.hidePassives && isHideablePassive(n)));
  const cellKey = (p, vr) => `${p ?? "null"}|${vr || "vSig"}`;
  const byCell = new Map();
  for (const n of considered) {
    const k = cellKey(n.phase ?? null, n.voltageRow);
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(n);
  }
  for (const arr of byCell.values()) {
    arr.sort((a, z) => (a.kind === z.kind)
      ? (a.refdes || a.label || "").localeCompare(z.refdes || z.label || "", undefined, { numeric: true })
      : (a.kind === "rail" ? -1 : 1));
  }

  //  每个电压行与其最满的单元一样高——没有力模拟，没有蔓延。
  const gridRows = [];
  let yCursor = GRID_TOP;
  for (const vr of V_ROWS) {
    let maxRows = 0;
    for (const p of phasesPresent) {
      const arr = byCell.get(cellKey(p, vr.id));
      if (arr) maxRows = Math.max(maxRows, Math.ceil(arr.length / GRID_CPC));
    }
    if (maxRows === 0) continue;
    const h = maxRows * GRID_SLOT_H + GRID_CELL_PAD;
    gridRows.push({ id: vr.id, label: vr.label, top: yCursor, h });
    yCursor += h + GRID_ROW_GAP;
  }
  const rowTop = new Map(gridRows.map(r => [r.id, r.top]));

  for (const r of gridRows) {
    for (const p of phasesPresent) {
      const arr = byCell.get(cellKey(p, r.id));
      if (!arr || !arr.length) continue;
      const cx = colX(p);
      const top = r.top + GRID_CELL_PAD;
      const innerW = (GRID_CPC - 1) * GRID_SLOT_W;
      arr.forEach((n, i) => {
        const col = i % GRID_CPC, row = Math.floor(i / GRID_CPC);
        n._tx = cx - innerW / 2 + col * GRID_SLOT_W;
        n._ty = top + row * GRID_SLOT_H;
        n.x = n._tx; n.y = n._ty;
        if (n.kind === "rail") { n.width = 80; n.height = 24; }
        else { n.width = 54; n.height = 26; }
        n.showPins = false;
      });
    }
  }
  //  将隐藏的被动元素放置在画布之外。
  for (const n of model.nodes) {
    if (STATE.hidePassives && isHideablePassive(n)) { n.x = -1e5; n.y = -1e5; }
  }

  model.bounds = {
    minX: GRID_LEFT - COL_W / 2 - 40,
    minY: GRID_TOP - 60,
    maxX: GRID_LEFT + (phasesPresent.length - 1) * COL_W + COL_W / 2 + 40,
    maxY: yCursor + 20,
  };
  model.phasesPresent = phasesPresent;
  model.phaseColIndex = phaseColIndex;
  model.colX = colX;
  model._gridRows = gridRows;
}

/*  ---------------------------------------------------------------------------------- *
 * 能量树布局 — 紧凑的 rail 地图。导轨被包装成包装材料
 * 多列网格，按电压带分组（≥12V → ≤1V2 → 信号）。的
 * 旧的“全宽行 + 每个 rail 的消费者”蔓延至约 20k 像素高
 * 350+ rail；这会将整个 rail 设置在可平移的画布上。
 * 组件隐藏在此处 — 单击 rail 可深入查看 rail 焦点。
 * ----------------------------------------------------------------------  */

const PT_RAIL_W = 108;
const PT_RAIL_H = 28;
const PT_GAP_X = 12;
const PT_GAP_Y = 9;
const PT_COLS = 12;          //  宽网格——画布又宽又短
const PT_GRID_X0 = 150;
const PT_TOP = 74;
const PT_BAND_GAP = 36;

function computePowertreeLayout(model) {
  assignGridCoords(model); //  保持电压行的一致性+回退
  model.layoutMode = "powertree";

  const railNodes = model.nodes.filter(n => n.kind === "rail");
  const byBand = new Map();
  for (const r of railNodes) {
    const b = r.voltageRow || "vSig";
    if (!byBand.has(b)) byBand.set(b, []);
    byBand.get(b).push(r);
  }
  for (const arr of byBand.values()) {
    arr.sort((a, z) => {
      const va = a.voltage_nominal ?? -1, vz = z.voltage_nominal ?? -1;
      if (vz !== va) return vz - va;
      return a.label.localeCompare(z.label);
    });
  }

  model._ptBands = [];
  let y = PT_TOP;
  for (const band of V_ROWS) {
    const arr = byBand.get(band.id);
    if (!arr || !arr.length) continue;
    const bandTop = y;
    arr.forEach((r, i) => {
      const col = i % PT_COLS, row = Math.floor(i / PT_COLS);
      r._tx = PT_GRID_X0 + col * (PT_RAIL_W + PT_GAP_X);
      r._ty = y + row * (PT_RAIL_H + PT_GAP_Y);
      r.width = PT_RAIL_W;
      r.height = PT_RAIL_H;
    });
    const rows = Math.ceil(arr.length / PT_COLS);
    const bandH = rows * (PT_RAIL_H + PT_GAP_Y);
    model._ptBands.push({ label: band.label, y: bandTop, h: bandH, count: arr.length });
    y += bandH + PT_BAND_GAP;
  }

  //  网格上的铁轨；其他一切都停在画布外（并且未渲染）。
  for (const n of model.nodes) {
    if (n.kind === "rail" && n._tx != null) { n.x = n._tx; n.y = n._ty; }
    else { n.x = -1e5; n.y = -1e5; }
  }

  model.bounds = {
    minX: 0,
    minY: PT_TOP - 52,
    maxX: PT_GRID_X0 + PT_COLS * (PT_RAIL_W + PT_GAP_X) + 40,
    maxY: y + 20,
  };
  model.railOrder = railNodes.map(r => r.id);
}

function renderPowertreeHeads(model) {
  const g = d3.select("#schBucketHeads");
  g.selectAll("*").remove();
  const bands = model._ptBands || [];
  const maxX = model.bounds.maxX - 20;
  bands.forEach((b, i) => {
    g.append("rect")
      .attr("class", `sch-vrow-band vrow-${i % 4}`)
      .attr("x", 24).attr("y", b.y - 26)
      .attr("width", maxX).attr("height", b.h + 22).attr("rx", 10);
    g.append("text")
      .attr("class", "sch-pt-band-label")
      .attr("x", 36).attr("y", b.y - 10)
      .text(`${b.label} · ${b.count}`);
  });
}

/*  ---------------------------------------------------------------------------------- *
 * RAIL-FOCUS LAYOUT — 准确显示 ONE rail + 其来源 + 上游馈送 +
 * 去耦电容 + direct 消费者。其他一切都被隐藏了。零长
 * 边缘、零重叠、缩放到任意 rail 计数，因为我们从不渲染
 * 一次超过一个 rail 的邻居。
 * ----------------------------------------------------------------------  */

const RF_UPSTREAM_X = 160;
const RF_SOURCE_X = 400;
const RF_RAIL_X = 640;
const RF_CONSUMERS_X = 820;
const RF_CENTER_Y = 260;
const RF_CONSUMER_COL_W = 90;
const RF_CONSUMER_ROW_H = 48;
const RF_CONSUMERS_PER_COL = 9;
const RF_DECOUP_STEP_X = 22;

function computeRailFocusLayout(model, railId) {
  //  开始隐藏，然后逐渐显示 rail 的邻居。
  for (const n of model.nodes) n._visible = false;
  model.layoutMode = "railfocus";
  model._rfRailId = null;
  model._rfUpstreamId = null;
  model._rfConsumerCount = 0;
  model._rfDecouplingCount = 0;

  const rail = railId ? model.nodeById.get(railId) : null;
  if (!rail) {
    model.bounds = { minX: 0, minY: 0, maxX: 1200, maxY: 560 };
    return;
  }

  rail._visible = true;
  rail._tx = RF_RAIL_X; rail._ty = RF_CENTER_Y;
  rail.width = 140; rail.height = 54;
  model._rfRailId = rail.id;

  //  源 IC — 产生此 rail 的调节器。
  let source = null;
  if (rail.source_refdes) {
    source = model.nodeById.get(`comp:${rail.source_refdes}`);
    if (source) {
      source._visible = true;
      source._tx = RF_SOURCE_X;
      source._ty = RF_CENTER_Y;
      source.width = 92;
      source.height = Math.max(72, source.height || 48);
    }
  }

  //  上游 rail — 为源输入引脚供电的 rail。
  let upstream = null;
  if (source) {
    const upE = model.edges.find(e => e.kind === "powers" && e.targetId === source.id);
    if (upE) {
      const cand = model.nodeById.get(upE.sourceId);
      if (cand && cand.id !== rail.id && cand.kind === "rail") {
        upstream = cand;
        upstream._visible = true;
        upstream._tx = RF_UPSTREAM_X;
        upstream._ty = RF_CENTER_Y;
        upstream.width = 110;
        upstream.height = 44;
        model._rfUpstreamId = upstream.id;
      }
    }
  }

  //  消费者 - rail右侧的网格，垂直居中。
  const consumers = model.edges
    .filter(e => e.kind === "powers" && e.sourceId === rail.id)
    .map(e => model.nodeById.get(e.targetId))
    .filter(Boolean);
  consumers.sort((a, z) =>
    (a.refdes || "").localeCompare(z.refdes || "", undefined, { numeric: true })
  );
  const nC = consumers.length;
  consumers.forEach((c, i) => {
    c._visible = true;
    const col = Math.floor(i / RF_CONSUMERS_PER_COL);
    const row = i % RF_CONSUMERS_PER_COL;
    const colCount = Math.min(RF_CONSUMERS_PER_COL, nC - col * RF_CONSUMERS_PER_COL);
    const colHeight = (colCount - 1) * RF_CONSUMER_ROW_H;
    c._tx = RF_CONSUMERS_X + col * RF_CONSUMER_COL_W;
    c._ty = RF_CENTER_Y - colHeight / 2 + row * RF_CONSUMER_ROW_H;
    c.width = 64;
    c.height = 34;
    //  在这种模式下，详细的引脚对消费者来说没有用处——保留
    //  inspector为此。干净的矩形+refdes在这里就足够了。
    c.showPins = false;
  });
  model._rfConsumerCount = nC;

  //  去耦帽 — 小，位于短条上 rail 下方的中心。
  const decouplings = model.edges
    .filter(e => e.kind === "decouples" && e.targetId === rail.id)
    .map(e => model.nodeById.get(e.sourceId))
    .filter(Boolean);
  decouplings.sort((a, z) =>
    (a.refdes || "").localeCompare(z.refdes || "", undefined, { numeric: true })
  );
  const decoupY = RF_CENTER_Y + 70;
  decouplings.forEach((d, i) => {
    d._visible = true;
    d._tx = RF_RAIL_X + (i - (decouplings.length - 1) / 2) * RF_DECOUP_STEP_X;
    d._ty = decoupY;
    d.width = 12;
    d.height = 14;
  });
  model._rfDecouplingCount = decouplings.length;

  //  提交可见节点的位置；将其余部分推离画布，这样
  //  缩放/适合数学看不到它们。
  for (const n of model.nodes) {
    if (n._visible) { n.x = n._tx; n.y = n._ty; }
    else { n.x = -1e5; n.y = -1e5; }
  }

  const visible = model.nodes.filter(n => n._visible);
  if (visible.length === 0) {
    model.bounds = { minX: 0, minY: 0, maxX: 1200, maxY: 560 };
  } else {
    const xs = visible.map(n => n.x);
    const ys = visible.map(n => n.y);
    //  头部（区域带 + 由 renderRailFocusHeads 渲染的标签）跨度为
    //  railY-220（区域标签）到 railY+210（区域带底部）。界限必须
    //  将它们包括在内，或者仅将拟合中心放在节点上并且头部会出血
    //  在表面切换/统计栏/过滤器overlays后面。
    const headTop = RF_CENTER_Y - 220;
    const headBot = RF_CENTER_Y + 220;
    model.bounds = {
      minX: Math.min(...xs) - 140,
      minY: Math.min(Math.min(...ys) - 120, headTop),
      maxX: Math.max(...xs) + 140,
      maxY: Math.max(Math.max(...ys) + 120, headBot),
    };
  }
}

function renderRailFocusHeads(model) {
  const g = d3.select("#schBucketHeads");
  g.selectAll("*").remove();

  if (!model._rfRailId) {
    g.append("text")
      .attr("class", "sch-rf-empty")
      .attr("x", 600).attr("y", 260)
      .text(t("schematic.rail_focus.select_hint"));
    g.append("text")
      .attr("class", "sch-rf-empty-hint")
      .attr("x", 600).attr("y", 288)
      .text(t("schematic.rail_focus.select_sub"));
    return;
  }

  const rail = model.nodeById.get(model._rfRailId);
  const hasUpstream = Boolean(model._rfUpstreamId);
  const hasSource = Boolean(rail.source_refdes);
  const nC = model._rfConsumerCount;
  const railY = rail.y;
  const zoneTop = railY - 210;
  const zoneBot = railY + 210;

  const zones = [];
  if (hasUpstream) zones.push({ x: RF_UPSTREAM_X - 90, w: 180, label: t("schematic.rail_focus.zone_upstream") });
  if (hasSource)   zones.push({ x: RF_SOURCE_X - 90, w: 180, label: t("schematic.rail_focus.zone_source") });
  zones.push({ x: RF_RAIL_X - 80, w: 160, label: t("schematic.rail_focus.zone_rail") });
  if (nC > 0) {
    const nCols = Math.ceil(nC / RF_CONSUMERS_PER_COL);
    zones.push({
      x: RF_CONSUMERS_X - 40,
      w: 80 + nCols * RF_CONSUMER_COL_W,
      label: t("schematic.rail_focus.zone_consumers"),
    });
  }
  for (const z of zones) {
    g.append("rect")
      .attr("class", "sch-rf-zoneband")
      .attr("x", z.x).attr("y", zoneTop)
      .attr("width", z.w).attr("height", zoneBot - zoneTop)
      .attr("rx", 8);
    g.append("text")
      .attr("class", "sch-rf-zonelabel")
      .attr("x", z.x + z.w / 2).attr("y", zoneTop - 8)
      .attr("text-anchor", "middle")
      .text(z.label);
  }

  //  从rail到消费区的水平总线。
  if (nC > 0) {
    g.append("line")
      .attr("class", "sch-rf-busline")
      .attr("x1", rail.x + 70).attr("y1", railY)
      .attr("x2", RF_CONSUMERS_X - 10).attr("y2", railY);
  }

  //  当rail此板上没有生产者时，请注意“外部供应”。
  if (!hasSource) {
    g.append("text")
      .attr("class", "sch-rf-upstream-note")
      .attr("x", RF_SOURCE_X).attr("y", railY + 4)
      .attr("text-anchor", "middle")
      .text(t("schematic.rail_focus.external_supply"));
  }
}

function renderRailBar(model) {
  const listEl = el("schRailBarList");
  const countEl = el("schRailBarCount");
  if (!listEl) return;
  listEl.innerHTML = "";

  const rails = model.nodes.filter(n => n.kind === "rail");
  if (countEl) countEl.textContent = String(rails.length);

  if (rails.length === 0) {
    listEl.innerHTML = `<div class="muted" style="padding:20px 14px;font-size:11px;text-align:center">${escHtml(t("schematic.railbar.no_rails"))}</div>`;
    return;
  }

  //  按电压等级分组，按 V_ROWS 顺序（高电压 → 低电压）。
  const byGroup = new Map();
  for (const r of rails) {
    const gid = voltageRowFor(r.voltage_nominal);
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid).push(r);
  }
  for (const vrow of V_ROWS) {
    const group = byGroup.get(vrow.id);
    if (!group || group.length === 0) continue;
    group.sort((a, z) => {
      const va = a.voltage_nominal ?? -1;
      const vz = z.voltage_nominal ?? -1;
      if (vz !== va) return vz - va;
      return (a.label || "").localeCompare(z.label || "");
    });
    const header = document.createElement("div");
    header.className = "sch-rail-group";
    header.textContent = vrow.label;
    listEl.appendChild(header);
    for (const rail of group) {
      const item = document.createElement("div");
      item.className = "sch-rail-item";
      if (rail.isSpof) item.classList.add("spof");
      if (rail.id === STATE.selectedRailId) item.classList.add("active");
      item.dataset.railId = rail.id;

      const consumerCount = (rail.consumers || []).length;
      const voltageLbl = rail.voltage_nominal != null
        ? `${rail.voltage_nominal} V`
        : "n/a";
      const sourceLbl = rail.source_refdes
        ? `<span class="sch-rail-source">${escHtml(rail.source_refdes)}</span>`
        : `<span class="sch-rail-source external">${escHtml(t("schematic.railbar.external_supply"))}</span>`;
      const phaseBadge = rail.phase != null
        ? `<span class="sch-rail-phase">Φ${rail.phase}</span>`
        : "";
      const spofBadge = rail.isSpof
        ? `<span class="sch-rail-spof">${ICON_WARNING} ${rail.impactPct}%</span>`
        : "";

      item.innerHTML = `
        <div class="sch-rail-name">${escHtml(rail.label)}</div>
        <div class="sch-rail-voltage">${voltageLbl}</div>
        <div class="sch-rail-meta">
          ${sourceLbl}
          <span class="sch-rail-consumers">→ ${consumerCount}</span>
          ${phaseBadge}
          ${spofBadge}
        </div>
      `;
      item.addEventListener("click", () => setSelectedRail(rail.id));
      listEl.appendChild(item);
    }
  }
}

function setSelectedRail(railId) {
  STATE.selectedRailId = railId || null;
  try { localStorage.setItem("schSelectedRail", railId || ""); } catch (_) {}
  if (!STATE.model || STATE.layoutMode !== "railfocus") return;
  computeRailFocusLayout(STATE.model, STATE.selectedRailId);
  renderRailFocusHeads(STATE.model);
  renderNodes(STATE.model);
  renderEdges(STATE.model);
  document.querySelectorAll("#schRailBarList .sch-rail-item").forEach(it => {
    it.classList.toggle("active", it.dataset.railId === STATE.selectedRailId);
  });
  if (STATE.zoom) fitToBounds(STATE.model);
  if (STATE.selectedRailId) {
    const n = STATE.model.nodeById.get(STATE.selectedRailId);
    if (n) { STATE.selectedId = n.id; updateInspector(n); }
  } else {
    clearFocus();
  }
}

//  外部焦点桥 — boardview minimap 在以下情况下调度此事件
//  用户单击迷你图中的rail。如果该模块已经
//  初始化（模型构建），我们切换到rail-焦点就位；否则
//  配对的 localStorage 写入将在下一个 loadSchematic() 中被拾取。
window.addEventListener("schematic:focus-rail", (ev) => {
  const railId = ev.detail?.railId;
  if (!railId) return;
  if (STATE.layoutMode !== "railfocus") {
    STATE.layoutMode = "railfocus";
    try { localStorage.setItem("schLayoutMode", "railfocus"); } catch (_) {}
    if (STATE.graph) fullRender(STATE.graph);
  }
  setSelectedRail(railId);
});

/*  ---------------------------------------------------------------------------------- *
 * KILL-SWITCH — BFS 向前通过产生 + 为边缘供电 *
 * ----------------------------------------------------------------------  */

function computeCascade(model, startId) {
  const dead = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    for (const e of model.edges) {
      if (dead.has(e.targetId)) continue;
      //  当rail死亡时，它的消费者也随之死亡。当一个源死亡时，它产生的 rail 也随之死亡。
      if ((e.kind === "powers" || e.kind === "produces") && e.sourceId === id) {
        dead.add(e.targetId); queue.push(e.targetId);
      }
    }
  }
  return dead;
}

function computeUpstream(model, startId) {
  //  该节点所依赖的节点（为其提供数据的链）。
  const feeds = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    for (const e of model.edges) {
      if (feeds.has(e.sourceId)) continue;
      if ((e.kind === "powers" || e.kind === "produces") && e.targetId === id) {
        feeds.add(e.sourceId); queue.push(e.sourceId);
      }
    }
  }
  return feeds;
}

/*  ---------------------------------------------------------------------------------- *
 * 渲染 *
 * ----------------------------------------------------------------------  */

/*  ---------------------------------------------------------------------------------- *
 * 原理图符号 — 绘制每个组件的标准电子符号 *
 * 类型而不是通用的矩形。每个渲染器都将元素附加到 *
 * 提供`sel`组；元素以 (0,0) 为中心，引脚延伸*
 * 为 ±w/2，以便边缘可以干净地锚定在盒子边缘上。                    *
 * ----------------------------------------------------------------------  */

function drawResistor(sel, w, h) {
  const bw = w * 0.72, bh = h * 0.55;
  sel.append("rect").attr("class", "sch-sym-body sch-sym-resistor")
    .attr("x", -bw / 2).attr("y", -bh / 2).attr("width", bw).attr("height", bh).attr("rx", 1);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", -w / 2).attr("y1", 0).attr("x2", -bw / 2).attr("y2", 0);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", bw / 2).attr("y1", 0).attr("x2", w / 2).attr("y2", 0);
}

function drawCapacitor(sel, w, h) {
  //  两个平行的垂直板，带有向左/向右延伸的销钉。
  const gap = Math.max(2, Math.min(4, w * 0.1));
  const plateH = h * 0.85;
  sel.append("line").attr("class", "sch-sym-body sch-sym-cap")
    .attr("x1", -gap / 2).attr("y1", -plateH / 2).attr("x2", -gap / 2).attr("y2", plateH / 2);
  sel.append("line").attr("class", "sch-sym-body sch-sym-cap")
    .attr("x1", gap / 2).attr("y1", -plateH / 2).attr("x2", gap / 2).attr("y2", plateH / 2);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", -w / 2).attr("y1", 0).attr("x2", -gap / 2).attr("y2", 0);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", gap / 2).attr("y1", 0).attr("x2", w / 2).attr("y2", 0);
}

function drawInductor(sel, w, h) {
  //  三个拱门——经典的线圈符号。
  const arches = 3;
  const aw = (w * 0.8) / arches;
  const startX = -w * 0.4;
  let path = "";
  for (let i = 0; i < arches; i++) {
    const cx = startX + aw * i + aw / 2;
    path += `M${cx - aw / 2} 0 A ${aw / 2} ${aw / 2} 0 0 1 ${cx + aw / 2} 0 `;
  }
  sel.append("path").attr("class", "sch-sym-body sch-sym-inductor").attr("d", path);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", -w / 2).attr("y1", 0).attr("x2", startX).attr("y2", 0);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", startX + aw * arches).attr("y1", 0).attr("x2", w / 2).attr("y2", 0);
}

function drawFerrite(sel, w, h) {
  //  圆角矩形（珠子）——与电阻器的半径不同。
  const bw = w * 0.72, bh = h * 0.65;
  sel.append("rect").attr("class", "sch-sym-body sch-sym-ferrite")
    .attr("x", -bw / 2).attr("y", -bh / 2).attr("width", bw).attr("height", bh).attr("rx", bh / 2);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", -w / 2).attr("y1", 0).attr("x2", -bw / 2).attr("y2", 0);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", bw / 2).attr("y1", 0).attr("x2", w / 2).attr("y2", 0);
}

function drawDiode(sel, w, h) {
  //  向右的三角形+竖线（阴极）。
  const s = Math.min(w * 0.35, h * 0.45);
  sel.append("path").attr("class", "sch-sym-body sch-sym-diode")
    .attr("d", `M${-s} ${-s} L${s} 0 L${-s} ${s} Z`);
  sel.append("line").attr("class", "sch-sym-body sch-sym-diode-bar")
    .attr("x1", s).attr("y1", -s).attr("x2", s).attr("y2", s);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", -w / 2).attr("y1", 0).attr("x2", -s).attr("y2", 0);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", s).attr("y1", 0).attr("x2", w / 2).attr("y2", 0);
}

function drawLED(sel, w, h) {
  //  二极管+两个向外的小箭头表示“发出光”。
  drawDiode(sel, w, h);
  const s = Math.min(w * 0.35, h * 0.45);
  sel.append("path").attr("class", "sch-sym-body sch-sym-led-ray")
    .attr("d", `M${-s * 0.3} ${-s - 1} l2 -3 M${-s * 0.6} ${-s + 1} l1.5 -2.5`);
  sel.append("path").attr("class", "sch-sym-body sch-sym-led-ray")
    .attr("d", `M${s * 0.2} ${-s - 1} l2 -3 M${-s * 0.1} ${-s + 1} l1.5 -2.5`);
}

function drawFuse(sel, w, h) {
  //  带有“F”字形和别针的细长药丸。
  const bw = w * 0.78, bh = h * 0.55;
  sel.append("rect").attr("class", "sch-sym-body sch-sym-fuse")
    .attr("x", -bw / 2).attr("y", -bh / 2).attr("width", bw).attr("height", bh).attr("rx", bh / 2);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", -w / 2).attr("y1", 0).attr("x2", -bw / 2).attr("y2", 0);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", bw / 2).attr("y1", 0).attr("x2", w / 2).attr("y2", 0);
}

function drawTransistor(sel, w, h) {
  //  带基线的圆圈 + 发射极/集电极，NPN 约定。
  const r = Math.min(w, h) * 0.38;
  sel.append("circle").attr("class", "sch-sym-body sch-sym-transistor")
    .attr("cx", 0).attr("cy", 0).attr("r", r);
  //  底线（从左到圆的水平线）
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", -w / 2).attr("y1", 0).attr("x2", -r * 0.4).attr("y2", 0);
  sel.append("line").attr("class", "sch-sym-body")
    .attr("x1", -r * 0.4).attr("y1", -r * 0.6).attr("x2", -r * 0.4).attr("y2", r * 0.6);
  //  带箭头的发射器（右下对角线）
  sel.append("line").attr("class", "sch-sym-body")
    .attr("x1", -r * 0.4).attr("y1", r * 0.3).attr("x2", r * 0.55).attr("y2", r * 0.85);
  //  收集器（右上角对角线）
  sel.append("line").attr("class", "sch-sym-body")
    .attr("x1", -r * 0.4).attr("y1", -r * 0.3).attr("x2", r * 0.55).attr("y2", -r * 0.85);
  //  圆外的针脚
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", r * 0.55).attr("y1", -r * 0.85).attr("x2", w / 2).attr("y2", -h / 2);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", r * 0.55).attr("y1", r * 0.85).attr("x2", w / 2).attr("y2", h / 2);
}

function drawCrystal(sel, w, h) {
  //  具有两条小板线的矩形 — XTAL 符号。
  const bw = w * 0.4, bh = h * 0.65;
  sel.append("rect").attr("class", "sch-sym-body sch-sym-crystal")
    .attr("x", -bw / 2).attr("y", -bh / 2).attr("width", bw).attr("height", bh).attr("rx", 1);
  sel.append("line").attr("class", "sch-sym-body")
    .attr("x1", -bw / 2 - 3).attr("y1", -bh / 2).attr("x2", -bw / 2 - 3).attr("y2", bh / 2);
  sel.append("line").attr("class", "sch-sym-body")
    .attr("x1", bw / 2 + 3).attr("y1", -bh / 2).attr("x2", bw / 2 + 3).attr("y2", bh / 2);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", -w / 2).attr("y1", 0).attr("x2", -bw / 2 - 3).attr("y2", 0);
  sel.append("line").attr("class", "sch-sym-pin")
    .attr("x1", bw / 2 + 3).attr("y1", 0).attr("x2", w / 2).attr("y2", 0);
}

function drawConnector(sel, w, h) {
  //  一侧有齿的梯形表明有一个连接器。
  const s = w * 0.45;
  sel.append("path").attr("class", "sch-sym-body sch-sym-connector")
    .attr("d", `M${-s} ${-h * 0.45} L${s} ${-h * 0.3} L${s} ${h * 0.3} L${-s} ${h * 0.45} Z`);
  //  3 个针脚
  for (let i = -1; i <= 1; i++) {
    sel.append("line").attr("class", "sch-sym-pin")
      .attr("x1", s).attr("y1", i * h * 0.18).attr("x2", w / 2).attr("y2", i * h * 0.18);
  }
}

//  Dispatch — 如果绘制了 schematic 符号，则返回 true（因此调用者
//  知道跳过后备通用形状）。下面的小组件
//  MIN_SYMBOL_SIZE 回退到彩色点，以便可视化保持可读
//  在低变焦时。
const MIN_SYMBOL_SIZE = 14;
function drawSchematicSymbol(sel, node) {
  if (node.kind !== "component") return false;
  const w = node.width || 20, h = node.height || 20;
  if (Math.min(w, h) < MIN_SYMBOL_SIZE) return false;
  switch (node.type) {
    case "resistor":   drawResistor(sel, w, h); return true;
    case "capacitor":  drawCapacitor(sel, w, h); return true;
    case "inductor":   drawInductor(sel, w, h); return true;
    case "ferrite":    drawFerrite(sel, w, h); return true;
    case "diode":      drawDiode(sel, w, h); return true;
    case "led":        drawLED(sel, w, h); return true;
    case "fuse":       drawFuse(sel, w, h); return true;
    case "transistor": drawTransistor(sel, w, h); return true;
    case "crystal":
    case "oscillator": drawCrystal(sel, w, h); return true;
    case "connector":  drawConnector(sel, w, h); return true;
    //  ic / module / other → 保留通用固定矩形（已处理
    //  通过调用者现有的形状开关）。
    default: return false;
  }
}

function hexPoints(r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    pts.push([r * Math.cos(a), r * Math.sin(a) * 0.7].join(","));
  }
  return pts.join(" ");
}

function pinAnchor(node, pin) {
  const sides = node.pins?.sides;
  if (!sides) return [0, 0];
  for (const side of ["left", "right", "top", "bottom"]) {
    const idx = sides[side].indexOf(pin);
    if (idx < 0) continue;
    const count = sides[side].length;
    const w = node.width, h = node.height, pad = 8;
    if (side === "left") return [-w / 2 - 5, -h / 2 + pad + ((h - 2 * pad) / (count + 1)) * (idx + 1)];
    if (side === "right") return [w / 2 + 5, -h / 2 + pad + ((h - 2 * pad) / (count + 1)) * (idx + 1)];
    if (side === "top") return [-w / 2 + pad + ((w - 2 * pad) / (count + 1)) * (idx + 1), -h / 2 - 5];
    if (side === "bottom") return [-w / 2 + pad + ((w - 2 * pad) / (count + 1)) * (idx + 1), h / 2 + 5];
  }
  return [0, 0];
}

function edgeAnchors(e, model) {
  const s = model.nodeById.get(e.sourceId);
  const tn = model.nodeById.get(e.targetId);
  if (!s || !tn) return null;
  let sx = s.x, sy = s.y, tx = tn.x, ty = tn.y;

  const isCleanLayout = model.layoutMode === "powertree" || model.layoutMode === "railfocus" || model.layoutMode === "boot";
  //  在 power-tree / rail-focus 模式下，跳过精细的引脚级锚定（节点
  //  很小，布局已经很干净） - 锚定在面向的盒子边缘
  //  另一个端点，因此线短且明确。
  if (isCleanLayout) {
    if (s.kind === "component") {
      const w = s.width || 40;
      sx = s.x + (tn.x > s.x ? w / 2 : -w / 2);
      sy = s.y;
    }
    if (tn.kind === "component") {
      const w = tn.width || 40;
      tx = tn.x + (s.x > tn.x ? w / 2 : -w / 2);
      ty = tn.y;
    }
    if (s.kind === "rail") sx = s.x + (tn.x > s.x ? 50 : -50);
    if (tn.kind === "rail") tx = tn.x + (s.x > tn.x ? 50 : -50);
    return { x1: sx, y1: sy, x2: tx, y2: ty };
  }

  //  网格模式——暴露 IC 上的引脚级锚点。
  if (e.netLabel && s.kind === "component" && s.showPins) {
    const p = (s.pins.sides.left.concat(s.pins.sides.right, s.pins.sides.top, s.pins.sides.bottom)).find(x => x.net_label === e.netLabel);
    if (p) { const [dx, dy] = pinAnchor(s, p); sx = s.x + dx; sy = s.y + dy; }
  }
  if (e.netLabel && tn.kind === "component" && tn.showPins) {
    const p = (tn.pins.sides.left.concat(tn.pins.sides.right, tn.pins.sides.top, tn.pins.sides.bottom)).find(x => x.net_label === e.netLabel);
    if (p) { const [dx, dy] = pinAnchor(tn, p); tx = tn.x + dx; ty = tn.y + dy; }
  }
  if (s.kind === "rail") sx = s.x + (tn.x > s.x ? 50 : -50);
  if (tn.kind === "rail") tx = tn.x + (s.x > tn.x ? 50 : -50);
  return { x1: sx, y1: sy, x2: tx, y2: ty };
}

function bezierPath(a) {
  const dx = a.x2 - a.x1;
  const mx = Math.min(Math.max(Math.abs(dx) * 0.5, 30), 180);
  const sign = dx >= 0 ? 1 : -1;
  return `M${a.x1},${a.y1}C${a.x1 + sign * mx},${a.y1} ${a.x2 - sign * mx},${a.y2} ${a.x2},${a.y2}`;
}

function renderGridHeads(model) {
  const g = d3.select("#schBucketHeads");
  g.selectAll("*").remove();

  const phases = model.phasesPresent || [];
  const rows = model._gridRows || [];
  if (!phases.length || !rows.length) return;
  const xFirst = model.colX(phases[0]);
  const xLast = model.colX(phases[phases.length - 1]);
  const gridL = xFirst - COL_W / 2 - 40;
  const gridR = xLast + COL_W / 2 + 40;
  const gridT = rows[0].top - 34;
  const gridB = rows[rows.length - 1].top + rows[rows.length - 1].h + 10;

  //  1) 电压行水平带（可变高度=最满的单元）。
  rows.forEach((r, i) => {
    g.append("rect")
      .attr("class", `sch-vrow-band vrow-${i % 4}`)
      .attr("x", gridL + 60).attr("y", r.top - 6)
      .attr("width", gridR - gridL - 60).attr("height", r.h + 4).attr("rx", 10);
  });

  //  2) 相柱垂直带。
  phases.forEach((p) => {
    const cx = model.colX(p);
    g.append("rect")
      .attr("class", `sch-phase-col ${p == null ? "col-none" : ""}`)
      .attr("x", cx - COL_W / 2 + 8).attr("y", gridT + 30)
      .attr("width", COL_W - 16).attr("height", gridB - gridT - 30).attr("rx", 8);
  });

  //  3) 电压行标签位于左边缘。
  rows.forEach((r) => {
    const cy = r.top + r.h / 2;
    const lbl = g.append("g").attr("transform", `translate(${gridL + 30}, ${cy})`);
    lbl.append("rect")
      .attr("class", "sch-vrow-head")
      .attr("x", -44).attr("y", -14).attr("width", 88).attr("height", 28).attr("rx", 6);
    lbl.append("text").attr("class", "sch-vrow-label").attr("y", 4).text(r.label);
  });

  //  4) 相列标题位于顶部。
  phases.forEach((p) => {
    const cx = model.colX(p);
    const head = g.append("g").attr("transform", `translate(${cx}, ${gridT})`);
    head.append("rect")
      .attr("class", "sch-phase-head")
      .attr("x", -80).attr("y", -16).attr("width", 160).attr("height", 32).attr("rx", 8);
    const label = p == null ? t("schematic.boot.phase_pre_boot") : `Φ${p}`;
    head.append("text").attr("class", "sch-phase-label").attr("y", -1).text(label);
    const count = model.nodes.filter(n => (n.phase ?? null) === p && n.x > -1e4).length;
    const nodeLbl = count === 1
      ? t("schematic.boot.phase_count_one", { n: count })
      : t("schematic.boot.phase_count_many", { n: count });
    head.append("text").attr("class", "sch-phase-sub").attr("y", 12).text(nodeLbl);
  });
}

//  无源（去耦电容/检测电阻/铁氧体/二极管）
//  隐藏以整理全板布局。 SPOF 被动因素留下来——它们很重要。
function isHideablePassive(n) {
  return n.kind === "component" && !n.isSpof
    && typeof n.compKind === "string" && n.compKind.startsWith("passive");
}

//  “此节点是否在当前模式下渲染？”的单一事实来源。
//  由 renderNodes、renderEdges 和 updateStats 使用，因此画布和
//  统计栏计数永远不会不一致——特别是两者对 hidePassives 都有反应。
function isNodeRendered(n, model) {
  if (model.layoutMode === "railfocus" || model.layoutMode === "boot") {
    //  `_visible` 从 boot/rail 成员资格设置并忽略 hidePassives；
    //  将切换按钮放在顶部，这样它在两个默认视图中就不会处于惰性状态。
    return n._visible && !(STATE.hidePassives && isHideablePassive(n));
  }
  if (model.layoutMode === "powertree") {
    //  紧凑的 rail 地图 — 仅 rail；组件位于 rail 焦点中。
    return n.kind === "rail" && n.x > -1e4;
  }
  //  全板布局（网格）：在整理时放弃无源 R/C/L/D/FB，以便
  //  该电路板读作 rails + 功能 IC。 SPOF/源被动语态保留。
  if (STATE.hidePassives) return !isHideablePassive(n);
  return true;
}

function renderNodes(model) {
  const g = d3.select("#schLayerNodes");
  g.selectAll("*").remove();
  const nodesData = model.nodes.filter(n => isNodeRendered(n, model));
  const sel = g.selectAll("g.sch-node").data(nodesData, d => d.id).join("g")
    .attr("class", d => `sch-node sch-node-${d.kind} role-${d.role || "rail"} ${d.missing ? "missing" : ""} ${d.populated === false ? "nostuff" : ""} ${d.isSpof ? "spof" : ""} ${d.compKind && d.compKind.startsWith("passive") ? "passive-node" : ""}`)
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .attr("data-refdes", d => d.kind === "component" ? (d.refdes ?? null) : null)
    .attr("data-rail",   d => d.kind === "rail" ? (d.label ?? d.id ?? null) : null)
    .on("click", (ev, d) => {
      ev.stopPropagation();
      STATE.selectedId = d.id;
      updateInspector(d);
      applyFocus(d.id, model);
      //  启动阶段 chip 点击是通过 timeline 发生的，而不是在这里。
    });

  sel.each(function (d) {
    const s = d3.select(this);
    const w = d.width, h = d.height;
    if (d.kind === "rail") {
      s.append("polygon")
        .attr("class", "sch-shape sch-shape-rail")
        .attr("points", `${-w / 2},0 ${-w / 2 + 16},${-h / 2} ${w / 2 - 16},${-h / 2} ${w / 2},0 ${w / 2 - 16},${h / 2} ${-w / 2 + 16},${h / 2}`);
      s.append("text").attr("class", "sch-label sch-label-rail").attr("y", 2).text(d.label);
      if (d.voltage_nominal != null) {
        s.append("text").attr("class", "sch-sub sch-sub-rail").attr("y", h / 2 + 12).text(`${d.voltage_nominal} V`);
      }
      if (d.phase != null) {
        s.append("text").attr("class", "sch-phase-chip").attr("y", -h / 2 - 6).text(`Φ${d.phase}`);
      }
      if (d.isSpof) {
        s.append("text").attr("class", "sch-spof-badge")
          .attr("y", h / 2 + 24).text(`⚠ SPOF · ${d.impactPct}%`);
      }
      //  Cascade-dead 警告字形 — 默认隐藏，通过 .sim-cascade 显示。
      s.append("text")
        .attr("class", "sch-cascade-warn")
        .attr("x", 0)
        .attr("y", -h / 2 - 20)
        .attr("text-anchor", "middle")
        .text("⚠");
      return;
    }
    //  组件 — 首先尝试特定于类型的 schematic 符号；后退
    //  到 IC 和微型无源器件的通用形状轮廓。
    if (drawSchematicSymbol(s, d)) {
      //  绘制schematic符号；跳过通用形状分支。
    } else if (d.shape === "rect-big" || d.shape === "rect") {
      s.append("rect").attr("class", "sch-shape sch-shape-comp")
        .attr("x", -w / 2).attr("y", -h / 2).attr("width", w).attr("height", h).attr("rx", 5);
    } else if (d.shape === "capsule") {
      s.append("rect").attr("class", "sch-shape sch-shape-passive")
        .attr("x", -w / 2).attr("y", -h / 4).attr("width", w).attr("height", h / 2).attr("rx", h / 4);
    } else {
      s.append("circle").attr("class", "sch-shape sch-shape-comp").attr("r", Math.max(w, h) / 2);
    }
    if (d.role !== "decoupling") {
      s.append("text").attr("class", "sch-label sch-label-comp").attr("y", 2).text(d.refdes);
      const val = d.value && (d.value.primary || d.value.raw);
      if (val && d.role === "source") {
        s.append("text").attr("class", "sch-sub sch-sub-comp").attr("y", h / 2 + 11).text(String(val).slice(0, 16));
      } else if (d.role === "consumer" && d.type) {
        s.append("text").attr("class", "sch-sub sch-sub-comp").attr("y", h / 2 + 11).text(d.type);
      }
    } else {
      //  内嵌小容量标签（例如 100nF）。
      const val = d.value && (d.value.primary || d.value.raw);
      if (val) {
        s.append("text").attr("class", "sch-sub sch-sub-passive").attr("y", h / 2 + 9).text(String(val).slice(0, 8));
      }
    }
    if (d.isSpof) {
      s.append("text").attr("class", "sch-spof-badge")
        .attr("y", -h / 2 - 7).text(`⚠ SPOF · ${d.impactPct}%`);
    }
    //  Cascade-dead 警告字形 — 默认隐藏，通过 .sim-cascade 显示。
    s.append("text")
      .attr("class", "sch-cascade-warn")
      .attr("x", 0)
      .attr("y", -h / 2 - 22)
      .attr("text-anchor", "middle")
      .text("⚠");
    //  使用 showPins 为来源和消费者提供图钉点 + 引导线。
    if (d.showPins) {
      for (const side of ["left", "right", "top", "bottom"]) {
        d.pins.sides[side].forEach(p => {
          const [px, py] = pinAnchor(d, p);
          const pg = s.append("g").attr("class", `sch-pin sch-pin-${side} role-${p.role || "unknown"}`);
          const inward = {
            left: [px + 5, py], right: [px - 5, py],
            top: [px, py + 5], bottom: [px, py - 5],
          }[side];
          pg.append("line").attr("class", "sch-pin-lead")
            .attr("x1", inward[0]).attr("y1", inward[1])
            .attr("x2", px).attr("y2", py);
          pg.append("circle").attr("class", "sch-pin-dot").attr("cx", px).attr("cy", py).attr("r", 2.2);
          if (d.role === "source" && (p.name || p.net_label)) {
            const lbl = (p.name || p.net_label || "").slice(0, 8);
            const tx = side === "left" ? px - 3 : side === "right" ? px + 3 : px;
            const ty = side === "top" ? py - 4 : side === "bottom" ? py + 8 : py + 3;
            const anchor = side === "left" ? "end" : side === "right" ? "start" : "middle";
            pg.append("text").attr("x", tx).attr("y", ty).attr("class", "sch-pin-label").attr("text-anchor", anchor).text(lbl);
          }
        });
      }
    }
  });
}

function renderEdges(model) {
  const g = d3.select("#schLayerLinks");
  g.selectAll("*").remove();
  //  所有边缘类型都在两种布局中绘制 - 布局已经使
  //  空间关系，边缘使它们变得明确。在电源树模式下，它们
  //  是从水平总线到附加节点的短截线，因此
  //  它们不会像 2D 中的长贝塞尔边缘那样使画布变得混乱
  //  网格。
  //  数据信号延迟：边缘携带 e.netLabel，但模拟器的信号
  //  状态映射用户可见的信号名称；添加信号级 sim 时挂钩。
  //  在 rail 焦点模式下，我们仅在当前可见节点之间绘制边缘。
  let edgesData;
  if (model.layoutMode === "powertree" || model.layoutMode === "grid") {
    //  通过放置读取紧凑的rail图/相×电压矩阵，而不是
    //  边缘——跨单元贝塞尔曲线就像意大利面条一样，所以什么也不画。
    edgesData = [];
  } else {
    //  仅当两个端点实际渲染时才绘制边缘 - 否则它
    //  悬挂在隐藏/停放的节点上。
    edgesData = model.edges.filter(e => {
      const s = model.nodeById.get(e.sourceId);
      const tn = model.nodeById.get(e.targetId);
      return s && tn && isNodeRendered(s, model) && isNodeRendered(tn, model);
    });
  }
  g.selectAll("path").data(edgesData, d => d.id).join("path")
    .attr("class", d => `sch-link sch-link-${d.kind}`)
    .attr("data-subkind", d => d.subkind || null)
    .attr("d", d => {
      const a = edgeAnchors(d, model);
      return a ? bezierPath(a) : null;
    })
    .attr("marker-end", d => d.kind === "produces" ? "url(#sch-arrow-produces)"
      : d.kind === "powers" ? "url(#sch-arrow-powers)"
      : d.kind === "decouples" ? "url(#sch-arrow-decouples)"
      : null);
}

/*  ---------------------------------------------------------------------------------- *
 * 启动时间线 *
 * ----------------------------------------------------------------------  */

/*  ---------------------------------------------------------------------------------- *
 * BOOT LAYOUT — 跨组件布局的协议 *
 **
 * 删除完整的板图并仅将与启动相关的节点放入 *
 * 从左到右的相位列 (Φ0 → Φn)。每列堆叠该阶段的*
 * 稳定rails + 输入组件；真正的力量/产生优势*
 * 在可见节点之间绘制传播。稀疏且可读 — *
 * 协议就是图片。由引导播放器驱动。                    *
 * ----------------------------------------------------------------------  */

const BOOT_X0 = 160;
const BOOT_Y0 = 130;          //  第一行，列标题带下方
const BOOT_ROW_H = 46;
const BOOT_ROWS_MAX = 8;      //  包裹到超过这么多行的子列中
const BOOT_SUBCOL_W = 92;
const BOOT_COL_GAP = 84;      //  相块之间的间隙
const BOOT_HEAD_Y = 64;

function computeBootLayout(model) {
  for (const n of model.nodes) n._visible = false;
  model.layoutMode = "boot";
  const phases = model.boot || [];
  model._bootCols = [];
  const assigned = new Set();   //  跨阶段的rail稳定属于它的第一个
  let curX = BOOT_X0;
  let maxRows = 0;

  phases.forEach((p) => {
    const ids = [
      ...(p.rails_stable || []).map(r => `rail:${r}`),
      ...(p.components_entering || []).map(r => `comp:${r}`),
    ];
    const colNodes = [];
    for (const id of ids) {
      if (assigned.has(id)) continue;
      const n = model.nodeById.get(id);
      if (!n) continue;
      assigned.add(id);
      colNodes.push(n);
    }
    colNodes.forEach((n, j) => {
      const subcol = Math.floor(j / BOOT_ROWS_MAX);
      const row = j % BOOT_ROWS_MAX;
      n._visible = true;
      n._tx = curX + subcol * BOOT_SUBCOL_W;
      n._ty = BOOT_Y0 + row * BOOT_ROW_H;
      n.width = n.kind === "rail" ? 100 : 56;
      n.height = n.kind === "rail" ? 26 : 30;
      n.showPins = false;
    });
    //  每个阶段块的宽度与其子列数一样宽——布局逐步淘汰
    //  累积起来，因此脂肪阶段永远不会与下一个脂肪阶段重叠。
    const nSub = Math.max(1, Math.ceil(colNodes.length / BOOT_ROWS_MAX));
    const colW = nSub * BOOT_SUBCOL_W;
    model._bootCols.push({ index: p.index, name: p.name, x: curX, w: colW, count: colNodes.length });
    maxRows = Math.max(maxRows, Math.min(colNodes.length, BOOT_ROWS_MAX));
    curX += colW + BOOT_COL_GAP;
  });

  for (const n of model.nodes) {
    if (n._visible) { n.x = n._tx; n.y = n._ty; }
    else { n.x = -1e5; n.y = -1e5; }
  }

  model.bounds = {
    minX: BOOT_X0 - 140,
    minY: BOOT_HEAD_Y - 40,
    maxX: curX + 100,
    maxY: BOOT_Y0 + maxRows * BOOT_ROW_H + 50,
  };
}

function renderBootHeads(model) {
  const g = d3.select("#schBucketHeads");
  g.selectAll("*").remove();
  const cols = model._bootCols || [];
  const bandTop = BOOT_HEAD_Y - 34;
  const bandBot = model.bounds ? model.bounds.maxY - 10 : BOOT_Y0 + 300;
  cols.forEach((c, i) => {
    //  交替相位上有微弱的泳道带，因此眼睛将相位视为列。
    if (i % 2 === 1) {
      g.append("rect")
        .attr("class", "sch-boot-lane")
        .attr("x", c.x - 42).attr("y", bandTop)
        .attr("width", c.w + 4).attr("height", bandBot - bandTop)
        .attr("rx", 8);
    }
    g.append("text")
      .attr("class", "sch-boot-colhead-n")
      .attr("x", c.x - 30).attr("y", BOOT_HEAD_Y)
      .text(`Φ${c.index}`);
    //  将阶段名称截断为下一列标题之前的空格
    //  长名字不会出现在上面。基于度量（字体宽度不同）。
    const full = c.name || t("schematic.boot.phase_default_name", { n: c.index });
    const avail = (i < cols.length - 1) ? (cols[i + 1].x - c.x - 16) : (c.w + 60);
    const nameEl = g.append("text")
      .attr("class", "sch-boot-colhead-name")
      .attr("x", c.x - 30).attr("y", BOOT_HEAD_Y + 16)
      .text(full);
    let txt = full;
    while (txt.length > 6 && nameEl.node().getComputedTextLength() > avail) {
      txt = txt.slice(0, -2);
      nameEl.text(`${txt}…`);
    }
    nameEl.append("title").text(full);
  });
}

/*  ---------------------------------------------------------------------------------- *
 * BOOT PLAYER — 统一序列读取器 *
 **
 * 一个底部杆取代了旧的浮动洗涤器 + 独立引导 *
 * 网格。三个频段：A) 传输，B) 相位跟踪（点），C) 活动 - *
 *相卡。清理一个阶段会自动在其网络上构建图形 *
 * (focusPhaseGraph) 并且，当模拟时间线存在时，播放 *
 * 每相 sim-* 状态。全相网格移到[网格]后面*
 * 按钮作为概览overlay。                                         *
 * ----------------------------------------------------------------------  */

function renderBootTimeline(model) {
  const wrap = el("schBootTimeline");
  if (!wrap) return;
  wrap.innerHTML = "";
  const phases = model.boot || [];
  if (phases.length === 0) {
    wrap.classList.remove("sch-player");
    wrap.innerHTML = `<div class="sch-boot-empty">${escHtml(t("schematic.boot.empty"))}</div>`;
    return;
  }
  wrap.classList.add("sch-player");

  //  全板布局不使用相位轨道/卡 - 折叠
  //  将播放器移动到其传输栏并将画布恢复约 140 像素的高度。
  const collapsed = STATE.layoutMode === "powertree" || STATE.layoutMode === "grid";
  wrap.classList.toggle("collapsed", collapsed);
  document.body.classList.toggle("sch-collapsed-player", collapsed);

  const isAnalyzed = model.bootSource === "analyzer";
  const srcBadge = `
    <span class="sch-boot-src ${isAnalyzed ? 'analyzer' : 'compiler'}">
      ${isAnalyzed ? `${ICON_CHECK} ${escHtml(t("schematic.boot.verified_opus"))}` : `${ICON_DIAMOND} ${escHtml(t("schematic.boot.deduced_topology"))}`}
    </span>
    ${!isAnalyzed ? `<button class="sch-reanalyze" id="schReanalyzeBtn" title="${escHtml(t("schematic.boot.reanalyze_title"))}">↻ ${escHtml(t("schematic.boot.reanalyze"))}</button>` : ''}`;

  //  ---- 频段 A：运输 ----
  const transport = document.createElement("div");
  transport.className = "sch-player-transport";
  transport.innerHTML = `
    <div class="sch-player-ctrls">
      <button data-act="rewind" title="${escHtml(t("schematic.simulator.rewind_title"))}">⏮</button>
      <button data-act="step-back" title="${escHtml(t("schematic.simulator.step_back_title"))}">◀</button>
      <button data-act="play-pause" title="${escHtml(t("schematic.player.play_title"))}">▶</button>
      <button data-act="step-fwd" title="${escHtml(t("schematic.simulator.step_fwd_title"))}">▶▏</button>
    </div>
    <div class="sch-player-now">
      <span class="sch-player-phase mono"></span>
      <span class="sch-player-name"></span>
      <span class="sch-player-conf mono"></span>
    </div>
    <div class="sch-player-trigger" hidden></div>
    <div class="sch-player-tools">
      <label class="sch-player-layoutsel"><span>${escHtml(t("schematic.player.layout_label"))}</span><select data-act="layoutsel">
        <option value="boot">${escHtml(t("schematic.player.layout_protocol"))}</option>
        <option value="railfocus">${escHtml(t("schematic.player.layout_rail"))}</option>
        <option value="powertree">${escHtml(t("schematic.player.layout_tree"))}</option>
        <option value="grid">${escHtml(t("schematic.player.layout_grid"))}</option>
      </select></label>
      <label class="sch-player-netsel"><span>${escHtml(t("schematic.player.net_label"))}</span><select data-act="netsel"></select></label>
      <button data-act="toggle-states" class="sch-player-toggle" title="${escHtml(t("schematic.player.states_title"))}">${escHtml(t("schematic.player.states"))}</button>
      <button data-act="toggle-passives" class="sch-player-toggle" title="${escHtml(t("schematic.player.passives_title"))}">${escHtml(t("schematic.player.passives"))}</button>
      <button data-act="grid" class="sch-player-toggle" title="${escHtml(t("schematic.player.grid_title"))}">▦</button>
      ${srcBadge}
    </div>`;
  wrap.appendChild(transport);

  //  ---- 带 B ：相位轨迹（点） ----
  const track = document.createElement("div");
  track.className = "sch-player-track";
  phases.forEach((p) => {
    const pip = document.createElement("button");
    pip.className = "sch-player-pip";
    pip.dataset.phase = p.index;
    pip.innerHTML = `<span class="sch-player-pip-n mono">Φ${p.index}</span><span class="sch-player-pip-name">${escHtml(p.name || t("schematic.boot.phase_default_name", { n: p.index }))}</span>`;
    pip.addEventListener("click", () => SimulationController.seekToPhase(p.index));
    track.appendChild(pip);
  });
  wrap.appendChild(track);

  //  ---- Band C：活动阶段卡（由renderBootActive填充）----
  const active = document.createElement("div");
  active.className = "sch-player-active";
  active.id = "schPlayerActive";
  wrap.appendChild(active);

  //  ---- 概述overlay脚手架（由openBootGrid按需填充）----
  let overlay = el("schBootGridOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "sch-boot-gridoverlay";
    overlay.id = "schBootGridOverlay";
    overlay.hidden = true;
    (document.querySelector("#schematicSection") || document.body).appendChild(overlay);
  }

  //  传输交互（事件委托，因此源徽章/重新分析
  //  .sch-player-tools 内的按钮不需要自己的接线）。
  transport.addEventListener("click", (ev) => {
    const act = ev.target?.closest("[data-act]")?.dataset?.act;
    if (!act) return;
    if (act === "rewind") SimulationController.seek(0);
    else if (act === "step-back") SimulationController.seek(SimulationController.cursor - 1);
    else if (act === "step-fwd") SimulationController.seek(SimulationController.cursor + 1);
    else if (act === "play-pause") SimulationController.playing ? SimulationController.pause() : SimulationController.play();
    else if (act === "toggle-states") SimulationController.toggleStates();
    else if (act === "toggle-passives") {
      STATE.hidePassives = !STATE.hidePassives;
      try { localStorage.setItem("schHidePassives", STATE.hidePassives ? "1" : "0"); } catch (_) {}
      if (STATE.graph) fullRender(STATE.graph);
    }
    else if (act === "grid") openBootGrid(model);
  });
  //  反映被动切换状态（亮起=显示被动）。
  transport.querySelector("[data-act=toggle-passives]")?.classList.toggle("on", !STATE.hidePassives);
  transport.querySelector("[data-act=netsel]")?.addEventListener("change", (ev) => {
    const railId = ev.target.value;
    if (railId) selectRailFromPlayer(railId);
  });
  const layoutSel = transport.querySelector("[data-act=layoutsel]");
  if (layoutSel) {
    layoutSel.value = STATE.layoutMode;
    layoutSel.addEventListener("change", (ev) => {
      const mode = ev.target.value;
      STATE.layoutMode = mode;
      try { localStorage.setItem("schLayoutMode", mode); } catch (_) {}
      document.body.classList.toggle("sch-mode-railfocus", mode === "railfocus");
      if (STATE.graph) fullRender(STATE.graph);
    });
  }

  //  重新分析按钮会触发 POST /analyze-boot 并在完成后重新加载。
  el("schReanalyzeBtn")?.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = `↻ ${t("schematic.boot.reanalyzing")}`;
    try {
      const res = await fetch(API_PREFIX + `/pipeline/packs/${encodeURIComponent(STATE.slug)}/schematic/analyze-boot`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      //  每 3 秒轮询一次，直到文件出现（最多 60 秒）。
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const check = await fetch(API_PREFIX + `/pipeline/packs/${encodeURIComponent(STATE.slug)}/schematic`);
        const body = await check.json();
        if (body.boot_sequence_source === "analyzer") {
          STATE.graph = body;
          fullRender(body);
          return;
        }
      }
      btn.textContent = `↻ ${t("schematic.boot.reanalyze_timeout")}`;
      btn.disabled = false;
    } catch (err) {
      btn.textContent = t("schematic.boot.reanalyze_failed", { error: err.message });
      btn.disabled = false;
    }
  });

  //  为玩家播种。使用SimulationTimeline，render() 重新绘制光标
  //  新重建图上的阶段 + 其 sim-* 状态；没有一个，只是
  //  在阶段 0 播种卡片（无图形焦点 — 保持完整图形可见
  //  直到用户播放或选择一个阶段）。
  if (SimulationController.timeline) {
    SimulationController.render();
  } else {
    renderBootActive(model, phases[0].index, null);
    SimulationController._markActivePip(null);
  }
}

//  仅图形阶段焦点：调暗除阶段的 rails + comps 和之外的所有内容
//  点亮内部链接。无inspector副作用，因此播放可以擦洗
//  便宜的焦点。镜像 .has-focus 调光模式。
function focusPhaseGraph(model, phaseIdx) {
  const phase = (model.boot || []).find(p => p.index === phaseIdx);
  if (!phase) return;

  //  Railfocus 模式一次显示一个 rail，因此是多个rail“软焦点”
  //  此处无法渲染。让用户到达该阶段最关键的rail
  //  相反，这将“你必须寻找正确的网”变成了“玩家
  //  已经给你穿上了”。然后网络选择器在该阶段内翻转 rails。
  if (STATE.layoutMode === "railfocus") {
    const rails = (phase.rails_stable || [])
      .map(r => model.nodeById.get(`rail:${r}`))
      .filter(Boolean)
      .sort((a, b) => (b.blastRadius || 0) - (a.blastRadius || 0));
    if (rails[0]) setSelectedRail(rails[0].id);
    return;
  }

  const ids = new Set();
  (phase.rails_stable || []).forEach(r => ids.add(`rail:${r}`));
  (phase.components_entering || []).forEach(r => ids.add(`comp:${r}`));

  d3.select("#schGraph").classed("has-focus", true);
  d3.selectAll("#schLayerNodes g.sch-node")
    .classed("focus", d => ids.has(d.id))
    .classed("neighbor", false)
    .classed("downstream", false)
    .classed("upstream", false);
  d3.selectAll("#schLayerLinks path")
    .classed("active-link", d => ids.has(d.sourceId) && ids.has(d.targetId));

  //  构建阶段的节点，使协议可读，而不是一个微小的集群。
  fitToPhaseNodes(model, ids);

  //  保持概览网格（如果打开）同步。
  el("schBootGridOverlay")?.querySelectorAll(".sch-boot-col").forEach(c => {
    c.classList.toggle("active", Number(c.dataset.phase) === phaseIdx);
  });
}

//  填写乐队A的标签+乐队C的卡片作为活动阶段。 simState（当
//  模拟时间线存在）携带每相阻塞原因。
function renderBootActive(model, phaseIdx, simState) {
  const phase = (model.boot || []).find(p => p.index === phaseIdx);
  const host = el("schPlayerActive");
  if (!phase || !host) return;

  //  带A标签。
  const ph = document.querySelector(".sch-player-phase");
  const nm = document.querySelector(".sch-player-name");
  const cf = document.querySelector(".sch-player-conf");
  if (ph) ph.textContent = `Φ${phase.index}`;
  if (nm) nm.textContent = phase.name || t("schematic.boot.phase_default_name", { n: phase.index });
  if (cf) cf.textContent = phase.confidence != null ? phase.confidence.toFixed(2) : "";

  //  带 A 触发摘要（▸ 触发 NET ← 驱动程序 → Φn）或阻塞原因。
  const trg = document.querySelector(".sch-player-trigger");
  if (trg) {
    if (simState?.blocked) {
      trg.innerHTML = `<span class="sch-player-blocked">${escHtml(t("schematic.simulator.blocked", { reason: simState.blocked_reason ?? t("schematic.simulator.blocked_default") }))}</span>`;
      trg.hidden = false;
    } else {
      const next = (phase.triggers_next || [])[0];
      if (next) {
        const label = typeof next === "string" ? next : next.net_label;
        const driver = (typeof next === "object" && next.from_refdes) ? ` <span class="mono">${escHtml(next.from_refdes)}</span>` : "";
        trg.innerHTML = `<span class="sch-player-trigger-arrow">▸</span> ${escHtml(t("schematic.player.triggers"))} <span class="mono chip amber">${escHtml(label)}</span>${driver} <span class="sch-player-trigger-to">→ Φ${phase.index + 1}</span>`;
        trg.hidden = false;
      } else {
        trg.innerHTML = "";
        trg.hidden = true;
      }
    }
  }

  //  频段 A 网络选择器 — rail 在此阶段稳定。
  const sel = document.querySelector(".sch-player [data-act=netsel]");
  if (sel) {
    const rails = phase.rails_stable || [];
    sel.innerHTML = `<option value="">${escHtml(t("schematic.player.net_all"))}</option>`
      + rails.map(r => `<option value="rail:${escHtml(r)}">${escHtml(r)}</option>`).join("");
    //  在rail焦点模式下，反映当前画布上的rail。
    if (STATE.layoutMode === "railfocus" && STATE.selectedRailId
        && rails.includes(STATE.selectedRailId.replace(/^rail:/, ""))) {
      sel.value = STATE.selectedRailId;
    }
  }

  //  带C卡体。
  const rails = phase.rails_stable || [];
  const comps = phase.components_entering || [];
  const cand = [
    ...comps.map(r => model.nodeById.get(`comp:${r}`)),
    ...rails.map(r => model.nodeById.get(`rail:${r}`)),
  ].filter(Boolean).sort((a, b) => (b.blastRadius || 0) - (a.blastRadius || 0));
  const top = cand[0];
  const narration = (phase.evidence && phase.evidence[0]) ? phase.evidence[0] : "";

  //  将 chip 限制为每行一行（其余部分位于细节 inspector 和
  //  网格概述），因此卡片永远不会溢出其带并被剪裁。
  const RMAX = 12, CMAX = 10;
  const railChips = rails.slice(0, RMAX).map(r => `<span class="mono chip emerald clickable" data-rail="${escHtml(r)}">${escHtml(r)}</span>`).join("")
    + (rails.length > RMAX ? `<span class="sch-boot-more">${escHtml(t("schematic.boot.more", { n: rails.length - RMAX }))}</span>` : "");
  const compChips = comps.slice(0, CMAX).map(c => `<span class="mono chip cyan clickable" data-refdes="${escHtml(c)}">${escHtml(c)}</span>`).join("")
    + (comps.length > CMAX ? `<span class="sch-boot-more">${escHtml(t("schematic.boot.more", { n: comps.length - CMAX }))}</span>` : "");

  host.innerHTML = `
    <div class="sch-player-row">
      <span class="sch-player-col-label">${escHtml(t("schematic.player.rails_up"))}</span>
      <div class="sch-player-chips">${railChips || `<span class="muted">${escHtml(t("schematic.inspector.none"))}</span>`}</div>
      <button class="sch-player-details" data-act="details" title="${escHtml(t("schematic.player.details_title"))}">${escHtml(t("schematic.player.details"))}</button>
    </div>
    <div class="sch-player-row">
      <span class="sch-player-col-label">${escHtml(t("schematic.player.comps_in"))}</span>
      <div class="sch-player-chips">${compChips || `<span class="muted">${escHtml(t("schematic.inspector.none"))}</span>`}</div>
      ${top ? `<span class="sch-player-spof-wrap">${escHtml(t("schematic.boot.spof_label"))} <span class="mono chip clickable sch-player-spof" data-refdes="${escHtml(top.refdes || top.label)}">${ICON_WARNING} ${escHtml(top.refdes || top.label)}</span><span class="sch-player-spof-pct">${top.impactPct || 0}%</span></span>` : ""}
    </div>
    ${narration ? `<div class="sch-player-narr">${escHtml(narration)}</div>` : ""}`;

  host.querySelector("[data-act=details]")?.addEventListener("click", () => showPhaseDetails(model, phase.index));
  host.querySelectorAll("[data-rail]").forEach(c => c.addEventListener("click", () => {
    const n = model.nodeById.get(`rail:${c.dataset.rail}`);
    if (n) { STATE.selectedId = n.id; updateInspector(n); applyFocus(n.id, model); }
  }));
  host.querySelectorAll("[data-refdes]").forEach(c => c.addEventListener("click", () => {
    const n = model.nodeById.get(`comp:${c.dataset.refdes}`);
    if (n) { STATE.selectedId = n.id; updateInspector(n); applyFocus(n.id, model); }
  }));
}

//  分离出一个 rail 活性相。在 rail 对焦模式下，这会驱动
//  真正的一-rail布局(setSelectedRail);在全图模式下它会下降
//  回到级联焦点突出显示。
function selectRailFromPlayer(railId) {
  if (STATE.layoutMode === "railfocus") { setSelectedRail(railId); return; }
  const n = STATE.model?.nodeById?.get(railId);
  if (n) { STATE.selectedId = railId; updateInspector(n); applyFocus(railId, STATE.model); }
}

//  概述overlay：全相网格（每相并排），打开
//  从传输[网格]按钮。单击一列即可在那里寻找玩家。
function openBootGrid(model) {
  const overlay = el("schBootGridOverlay");
  if (!overlay) return;
  overlay.innerHTML = `
    <div class="sch-boot-gridoverlay-panel">
      <div class="sch-boot-gridoverlay-head">
        <span>${escHtml(t("schematic.player.grid_overview"))}</span>
        <button class="sch-boot-gridoverlay-close" title="${escHtml(t("schematic.simulator.close_title"))}">×</button>
      </div>
      <div class="sch-boot-grid" id="schBootGridInner"></div>
    </div>`;
  renderBootGrid(model, el("schBootGridInner"));
  overlay.hidden = false;
  overlay.querySelector(".sch-boot-gridoverlay-close").addEventListener("click", () => { overlay.hidden = true; });
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) overlay.hidden = true; });
}

function renderBootGrid(model, grid) {
  if (!grid) return;
  const phases = model.boot || [];
  const boardMaxBlast = model.maxBlast || 1;
  grid.style.gridTemplateColumns = `repeat(${phases.length}, minmax(180px, 1fr))`;
  phases.forEach((p) => {
    const candidates = [
      ...(p.components_entering || []).map(r => model.nodeById.get(`comp:${r}`)),
      ...(p.rails_stable || []).map(r => model.nodeById.get(`rail:${r}`)),
    ].filter(Boolean);
    candidates.sort((a, b) => (b.blastRadius || 0) - (a.blastRadius || 0));
    const top = candidates[0];
    const phaseMaxBlast = top ? top.blastRadius || 0 : 0;
    const phaseMaxPct = top ? top.impactPct || 0 : 0;
    const critLevel = phaseMaxPct >= 25 ? "hi" : phaseMaxPct >= 10 ? "mid" : "lo";
    const critFill = boardMaxBlast > 0 ? Math.min(100, Math.round(100 * phaseMaxBlast / boardMaxBlast)) : 0;

    const col = document.createElement("div");
    col.className = `sch-boot-col crit-${critLevel}`;
    col.dataset.phase = p.index;
    const kindBadge = p.kind ? `<span class="sch-boot-kind kind-${p.kind.replace(/[^a-z]/gi,'')}">${escHtml(p.kind)}</span>` : '';
    const confBadge = p.confidence != null ? `<span class="sch-boot-phase-conf">${p.confidence.toFixed(2)}</span>` : '';
    col.innerHTML = `
      <div class="sch-boot-head">
        <span class="sch-boot-phase">Φ${p.index}</span>
        <span class="sch-boot-name">${escHtml(p.name || t("schematic.boot.phase_default_name", { n: p.index }))}</span>
        ${kindBadge}
        ${confBadge}
      </div>
      ${top ? `<div class="sch-boot-spof crit-${critLevel}">
        <span class="sch-boot-spof-icon">${critLevel === 'hi' ? ICON_WARNING : critLevel === 'mid' ? ICON_DOT_FILLED : "·"}</span>
        <span class="sch-boot-spof-label">${escHtml(t("schematic.boot.spof_label"))}</span>
        <span class="mono sch-boot-spof-ref">${escHtml(top.refdes || top.label)}</span>
        <span class="sch-boot-spof-pct">${phaseMaxPct}%</span>
      </div>` : ''}
      <div class="sch-boot-crit">
        <div class="sch-boot-crit-bar"><div class="sch-boot-crit-fill crit-${critLevel}" style="width:${critFill}%"></div></div>
      </div>
      <div class="sch-boot-line">
        <span class="sch-boot-line-label">${escHtml(t("schematic.boot.rails_label"))}</span>
        ${(p.rails_stable || []).slice(0, 8).map(r => `<span class="mono chip emerald">${escHtml(r)}</span>`).join("")}
        ${(p.rails_stable || []).length > 8 ? `<span class="sch-boot-more">${escHtml(t("schematic.boot.more", { n: p.rails_stable.length - 8 }))}</span>` : ""}
      </div>
      <div class="sch-boot-line">
        <span class="sch-boot-line-label">${escHtml(t("schematic.boot.components_label"))}</span>
        ${(p.components_entering || []).slice(0, 6).map(c => `<span class="mono chip cyan">${escHtml(c)}</span>`).join("")}
        ${(p.components_entering || []).length > 6 ? `<span class="sch-boot-more">${escHtml(t("schematic.boot.more", { n: p.components_entering.length - 6 }))}</span>` : ""}
      </div>`;
    col.addEventListener("click", () => {
      SimulationController.seekToPhase(p.index);
      el("schBootGridOverlay").hidden = true;
    });
    grid.appendChild(col);
  });
}

//  侧面的全相位写入inspector（rails、comps、所有触发器
//  理由、证据列表）——从卡片的“详细信息”按钮打开。
function showPhaseDetails(model, phaseIdx) {
  const phase = (model.boot || []).find(p => p.index === phaseIdx);
  if (!phase) return;
  const insp = el("schInspector");
  insp.classList.add("open");
  el("schInspType").textContent = t("schematic.inspector.type_phase");
  el("schInspType").className = "sch-type-badge phase";
  el("schInspTitle").textContent = `Φ${phase.index}`;
  el("schInspSub").textContent = phase.name || "";
  //  本地别名以避免在下面的触发器映射中隐藏全局“t”。
  const tx = window.t;
  el("schInspBody").innerHTML = `
    <section class="sch-insp-section">
      <h3>${escHtml(tx("schematic.inspector.phase_rails_stable", { count: (phase.rails_stable || []).length }))}</h3>
      <div class="sch-chips">
        ${(phase.rails_stable || []).map(r => `<span class="mono chip emerald">${escHtml(r)}</span>`).join("") || `<span class='muted'>${escHtml(tx("schematic.inspector.none"))}</span>`}
      </div>
    </section>
    <section class="sch-insp-section">
      <h3>${escHtml(tx("schematic.inspector.phase_components_entering", { count: (phase.components_entering || []).length }))}</h3>
      <div class="sch-chips">
        ${(phase.components_entering || []).map(c => `<span class="mono chip cyan">${escHtml(c)}</span>`).join("") || `<span class='muted'>${escHtml(tx("schematic.inspector.none"))}</span>`}
      </div>
    </section>
    ${phase.triggers_next && phase.triggers_next.length ? `
    <section class="sch-insp-section">
      <h3>${escHtml(tx("schematic.inspector.phase_triggers_next"))}</h3>
      ${phase.triggers_next.map(trig => {
        if (typeof trig === "string") {
          return `<div><span class="mono chip amber">${escHtml(trig)}</span></div>`;
        }
        //  分析器形状：{net_label，from_refdes，基本原理}
        const driver = trig.from_refdes ? ` ← <span class="mono">${escHtml(trig.from_refdes)}</span>` : "";
        const rationale = trig.rationale ? `<div class="muted" style="margin-top:4px;font-size:11px">${escHtml(trig.rationale)}</div>` : "";
        return `<div style="margin-bottom:8px"><span class="mono chip amber">${escHtml(trig.net_label)}</span>${driver}${rationale}</div>`;
      }).join("")}
    </section>` : ""}
    ${phase.evidence && phase.evidence.length ? `
    <section class="sch-insp-section">
      <h3>${escHtml(tx("schematic.inspector.phase_evidence"))}</h3>
      <ul class="sch-evidence">
        ${phase.evidence.map(ev => `<li>${escHtml(ev)}</li>`).join("")}
      </ul>
    </section>` : ""}
  `;
}

/*  ---------------------------------------------------------------------------------- *
 * 焦点 + 检查员 *
 * ----------------------------------------------------------------------  */

function applyFocus(nodeId, model) {
  d3.select("#schGraph").classed("has-focus", Boolean(nodeId));
  if (!nodeId) return;
  const node = model.nodeById.get(nodeId);
  //  Kill-switch 模式：突出全下游级联+上游链。
  const dead = computeCascade(model, nodeId);
  const feeds = computeUpstream(model, nodeId);

  d3.selectAll("#schLayerNodes g.sch-node")
    .classed("focus", d => d.id === nodeId)
    .classed("downstream", d => dead.has(d.id) && d.id !== nodeId)
    .classed("upstream", d => feeds.has(d.id) && d.id !== nodeId && !dead.has(d.id))
    .classed("neighbor", false);
  d3.selectAll("#schLayerLinks path")
    .classed("active-link", d =>
      (dead.has(d.sourceId) && dead.has(d.targetId)) ||
      (feeds.has(d.sourceId) && feeds.has(d.targetId))
    );

  //  暗淡阶段亮点。
  el("schBootTimeline")?.querySelectorAll(".sch-boot-col.active").forEach(c => c.classList.remove("active"));
}

function clearFocus() {
  STATE.selectedId = null;
  updateInspector(null);
  d3.select("#schGraph").classed("has-focus", false);
  d3.selectAll("#schLayerNodes g.sch-node").classed("focus", false).classed("downstream", false).classed("upstream", false).classed("neighbor", false);
  d3.selectAll("#schLayerLinks path").classed("active-link", false);
  el("schBootTimeline")?.querySelectorAll(".sch-boot-col.active").forEach(c => c.classList.remove("active"));
}

//  填充 inspector 标题镶边：统计条（标题事实）和
//  快速操作栏（将图表居中、跳转到图板、复制 ID）
//  科技无需滚动身体即可行动。
function populateInspectorChrome(node) {
  const statsEl = el("schInspStats");
  const actsEl = el("schInspActions");
  if (!statsEl || !actsEl) return;
  const tx = window.t;

  const pills = [];
  const pill = (k, v, cls = "") =>
    `<span class="sch-insp-pill ${cls}"><span class="k">${escHtml(k)}</span><span class="v">${escHtml(String(v))}</span></span>`;
  if (node.kind === "rail") {
    if (node.voltage_nominal != null) pills.push(pill(tx("schematic.inspector.stat_voltage"), `${node.voltage_nominal} V`, "emerald"));
  } else if (node.role) {
    pills.push(pill(tx("schematic.inspector.stat_role"), node.role, "cyan"));
  }
  if (node.impactPct != null && node.blastRadius != null) {
    const sev = node.impactPct >= 25 ? "crit-hi" : node.impactPct >= 10 ? "crit-mid" : "";
    pills.push(pill(tx("schematic.inspector.stat_impact"), `${node.impactPct}%`, sev));
  }
  if (node.phase != null) pills.push(pill(tx("schematic.inspector.stat_phase"), `Φ${node.phase}`, "amber"));
  statsEl.innerHTML = pills.join("");

  actsEl.innerHTML = "";
  const addAction = (label, title, fn) => {
    const b = document.createElement("button");
    b.className = "sch-insp-action-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", fn);
    actsEl.appendChild(b);
    return b;
  };
  addAction(tx("schematic.inspector.action_center"), tx("schematic.inspector.action_center_title"), () => {
    if (!STATE.model) return;
    applyFocus(node.id, STATE.model);
    fitToPhaseNodes(STATE.model, new Set([node.id]));
  });
  if (node.kind === "component" && node.refdes && window.Boardview && typeof window.Boardview.focus === "function") {
    addAction(tx("schematic.inspector.action_board"), tx("schematic.inspector.action_board_title"), () => {
      try { window.Boardview.focus(node.refdes); } catch (_) { /*  板可能未加载  */ }
    });
  }
  const copyKey = node.kind === "rail" ? node.label : node.refdes;
  if (copyKey) {
    const copyBtn = addAction(tx("schematic.inspector.action_copy"), tx("schematic.inspector.action_copy_title"), () => {
      navigator.clipboard?.writeText(copyKey).then(() => {
        copyBtn.textContent = tx("schematic.inspector.action_copied");
        setTimeout(() => { copyBtn.textContent = tx("schematic.inspector.action_copy"); }, 1200);
      }).catch(() => {});
    });
  }
}

function updateInspector(node) {
  const insp = el("schInspector");
  if (!node) { insp.classList.remove("open"); return; }
  insp.classList.add("open");

  const typeBadge = el("schInspType");
  const title = el("schInspTitle");
  const sub = el("schInspSub");
  const body = el("schInspBody");

  const critBlock = node.blastRadius != null ? `
      <section class="sch-insp-section sch-criticality ${node.isSpof ? 'spof' : ''}">
        <h3>${node.isSpof ? `${ICON_WARNING} ${escHtml(t("schematic.inspector.spof"))}` : escHtml(t("schematic.inspector.criticality"))}</h3>
        <div class="sch-crit-row">
          <div class="sch-crit-bar">
            <div class="sch-crit-fill" style="width:${(node.criticality * 100).toFixed(0)}%"></div>
          </div>
          <div class="sch-crit-val">
            ${escHtml(t("schematic.inspector.criticality_summary", { count: node.blastRadius, pct: node.impactPct }))
              .replace(escHtml(String(node.blastRadius)), `<strong>${node.blastRadius}</strong>`)
              .replace(escHtml(`${node.impactPct}%`), `<strong>${node.impactPct}%</strong>`)}
          </div>
        </div>
      </section>` : "";

  //  查找功能域 + 一行描述
  //  分类网络overlay（由网络分类器、正则表达式或Opus填充）。
  const classified = ((STATE.graph && STATE.graph.net_classification) || {}).nets || {};
  const netMeta = node.kind === "rail" ? classified[node.label] : null;
  const domainBlock = netMeta ? `
      <section class="sch-insp-section sch-domain">
        <h3>${escHtml(t("schematic.inspector.domain_title", { domain: netMeta.domain || "misc" }))}</h3>
        ${netMeta.description ? `<div class="sch-domain-desc">${escHtml(netMeta.description)}</div>` : ""}
        ${netMeta.voltage_level ? `<div class="sch-domain-meta"><span class="k">${escHtml(t("schematic.inspector.domain_level"))}</span> <span class="mono">${escHtml(netMeta.voltage_level)}</span></div>` : ""}
      </section>` : "";

  if (node.kind === "rail") {
    typeBadge.textContent = t("schematic.inspector.type_rail");
    typeBadge.className = "sch-type-badge rail";
    title.textContent = node.label;
    sub.textContent = (node.voltage_nominal != null ? `${node.voltage_nominal} V` : "n/a") + " · " + (node.source_type || "n/a");

    const cascade = computeCascade(STATE.model, node.id);
    const casDead = Array.from(cascade).filter(id => id !== node.id);

    body.innerHTML = `
      ${critBlock}
      ${domainBlock}
      <section class="sch-insp-section">
        <h3>${escHtml(t("schematic.inspector.supply"))}</h3>
        <div class="sch-meta-grid">
          <dt>${escHtml(t("schematic.inspector.supply_producer"))}</dt><dd>${node.source_refdes ? `<span class="mono chip cyan clickable" data-id="comp:${escHtml(node.source_refdes)}">${escHtml(node.source_refdes)}</span>` : `<span class='muted'>${escHtml(t("schematic.inspector.supply_external"))}</span>`}</dd>
          <dt>${escHtml(t("schematic.inspector.supply_type"))}</dt><dd>${escHtml(node.source_type || "n/a")}</dd>
          <dt>${escHtml(t("schematic.inspector.supply_enable"))}</dt><dd>${node.enable_net ? `<span class="mono">${escHtml(node.enable_net)}</span>` : "n/a"}</dd>
          <dt>${escHtml(t("schematic.inspector.supply_boot"))}</dt><dd>${node.phase ? `<span class="mono chip amber">Φ${node.phase}</span>` : "n/a"}</dd>
        </div>
      </section>
      <section class="sch-insp-section">
        <h3>${escHtml(t("schematic.inspector.consumers", { count: node.consumers.length }))}</h3>
        ${node.consumers.length === 0 ? `<div class='muted'>${escHtml(t("schematic.inspector.consumers_none"))}</div>` : `
          <div class="sch-chips">${node.consumers.map(c => `<span class="mono chip cyan clickable" data-id="comp:${escHtml(c)}">${escHtml(c)}</span>`).join("")}</div>`}
      </section>
      <section class="sch-insp-section">
        <h3>${escHtml(t("schematic.inspector.decoupling", { count: node.decoupling.length }))}</h3>
        ${node.decoupling.length === 0 ? `<div class='muted'>${escHtml(t("schematic.inspector.decoupling_none"))}</div>` : `
          <div class="sch-chips">${node.decoupling.map(c => `<span class="mono chip violet clickable" data-id="comp:${escHtml(c)}">${escHtml(c)}</span>`).join("")}</div>`}
      </section>
      <section class="sch-insp-section">
        <h3>${ICON_BOLT} ${escHtml(t("schematic.inspector.cascade_rail", { count: casDead.length }))}</h3>
        ${casDead.length === 0 ? `<div class='muted'>${escHtml(t("schematic.inspector.cascade_rail_none"))}</div>` : `
          <div class="sch-chips">${casDead.slice(0, 40).map(id => {
            const n = STATE.model.nodeById.get(id);
            const label = n.kind === "rail" ? n.label : n.refdes;
            const cls = n.kind === "rail" ? "emerald" : "cyan";
            return `<span class="mono chip ${cls} clickable" data-id="${escHtml(id)}">${escHtml(label)}</span>`;
          }).join("")}${casDead.length > 40 ? `<span class="muted">+${casDead.length - 40}</span>` : ""}</div>`}
      </section>
    `;
  } else {
    typeBadge.textContent = (node.type || "COMP").toUpperCase();
    typeBadge.className = `sch-type-badge ${node.role || "component"}`;
    title.textContent = node.refdes;
    const v = node.value && (node.value.primary || node.value.raw);
    sub.textContent = `${v || "…"}${node.value?.package ? ` · ${node.value.package}` : ""}`;

    const producesRails = (STATE.model.edges || []).filter(e => e.kind === "produces" && e.sourceId === node.id).map(e => e.netLabel);
    const consumesRails = (STATE.model.edges || []).filter(e => e.kind === "powers" && e.targetId === node.id).map(e => e.netLabel);
    const decouplesRails = (STATE.model.edges || []).filter(e => e.kind === "decouples" && e.sourceId === node.id).map(e => e.netLabel);

    const cascade = computeCascade(STATE.model, node.id);
    const casDead = Array.from(cascade).filter(id => id !== node.id);

    body.innerHTML = `
      ${critBlock}
      <section class="sch-insp-section">
        <h3>${escHtml(t("schematic.inspector.metadata"))}</h3>
        <div class="sch-meta-grid">
          <dt>${escHtml(t("schematic.inspector.meta_role"))}</dt><dd><span class="sch-role-badge role-${node.role}">${escHtml(node.role)}</span></dd>
          <dt>${escHtml(t("schematic.inspector.meta_type"))}</dt><dd>${escHtml(node.type || "n/a")}</dd>
          <dt>${escHtml(t("schematic.inspector.meta_pages"))}</dt><dd>${node.pages && node.pages.length ? escHtml(t("schematic.inspector.meta_pages_value", { pages: node.pages.join(", ") })) : "n/a"}</dd>
          <dt>${escHtml(t("schematic.inspector.meta_populated"))}</dt><dd>${node.populated ? escHtml(t("schematic.inspector.meta_populated_yes")) : `<span class='warn'>${escHtml(t("schematic.inspector.meta_populated_no"))}</span>`}</dd>
          <dt>${escHtml(t("schematic.inspector.meta_mpn"))}</dt><dd>${node.value?.mpn ? `<span class="mono">${escHtml(node.value.mpn)}</span>` : "n/a"}</dd>
          <dt>${escHtml(t("schematic.inspector.meta_boot"))}</dt><dd>${node.phase ? `<span class="mono chip amber">Φ${node.phase}</span>` : "n/a"}</dd>
        </div>
      </section>
      ${producesRails.length ? `
      <section class="sch-insp-section">
        <h3>${escHtml(t("schematic.inspector.produces", { count: producesRails.length }))}</h3>
        <div class="sch-chips">${producesRails.map(r => `<span class="mono chip emerald clickable" data-id="rail:${escHtml(r)}">${escHtml(r)}</span>`).join("")}</div>
      </section>` : ""}
      ${consumesRails.length ? `
      <section class="sch-insp-section">
        <h3>${escHtml(t("schematic.inspector.consumes", { count: consumesRails.length }))}</h3>
        <div class="sch-chips">${consumesRails.map(r => `<span class="mono chip emerald clickable" data-id="rail:${escHtml(r)}">${escHtml(r)}</span>`).join("")}</div>
      </section>` : ""}
      ${decouplesRails.length ? `
      <section class="sch-insp-section">
        <h3>${escHtml(t("schematic.inspector.decouples"))}</h3>
        <div class="sch-chips">${decouplesRails.map(r => `<span class="mono chip violet clickable" data-id="rail:${escHtml(r)}">${escHtml(r)}</span>`).join("")}</div>
      </section>` : ""}
      <section class="sch-insp-section">
        <h3>${ICON_BOLT} ${escHtml(t("schematic.inspector.cascade_comp", { refdes: node.refdes, count: casDead.length }))}</h3>
        ${casDead.length === 0 ? `<div class='muted'>${escHtml(t("schematic.inspector.cascade_comp_none"))}</div>` : `
          <div class="sch-chips">${casDead.slice(0, 40).map(id => {
            const n = STATE.model.nodeById.get(id);
            const label = n.kind === "rail" ? n.label : n.refdes;
            const cls = n.kind === "rail" ? "emerald" : "cyan";
            return `<span class="mono chip ${cls} clickable" data-id="${escHtml(id)}">${escHtml(label)}</span>`;
          }).join("")}${casDead.length > 40 ? `<span class="muted">+${casDead.length - 40}</span>` : ""}</div>`}
      </section>
      ${node.pinsAll && node.pinsAll.length ? `
      <section class="sch-insp-section">
        <h3>${escHtml(t("schematic.inspector.pins", { count: node.pinsAll.length }))}</h3>
        <table class="sch-pin-table">
          <thead><tr><th>${escHtml(t("schematic.inspector.pin_col_number"))}</th><th>${escHtml(t("schematic.inspector.pin_col_name"))}</th><th>${escHtml(t("schematic.inspector.pin_col_role"))}</th><th>${escHtml(t("schematic.inspector.pin_col_net"))}</th></tr></thead>
          <tbody>
          ${node.pinsAll.map(p => `
            <tr>
              <td class="mono">${escHtml(p.number)}</td>
              <td class="mono">${escHtml(p.name || "…")}</td>
              <td class="mono pin-role">${escHtml(p.role || t("schematic.inspector.pin_unknown_role"))}</td>
              <td class="mono">${p.net_label ? `<span class="chip emerald">${escHtml(p.net_label)}</span>` : "n/a"}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </section>` : ""}
    `;
  }

  populateInspectorChrome(node);

  //  --- 观察行（反向-diagnostic 输入，每个节点类型的上下文）---
  const obsKind = node.kind === "component" ? "comp" : node.kind === "rail" ? "rail" : null;
  const obsKey = node.kind === "component" ? node.refdes : node.kind === "rail" ? node.label : null;
  if (obsKind && obsKey) {
    //  第 4 阶段：从 compKind（后端 ComponentKind）派生细粒度的选择器类型
    //  对于组件，或“rail”对于rails。对于第 4 阶段之前的图表，回落到“ic”。
    const pickerKind = obsKind === "rail" ? "rail" : (node.compKind || "ic");
    const modeList = MODE_SETS[pickerKind] || MODE_SETS.ic;
    const modesForKind = modeList.map(m => [m, `${MODE_GLYPH[m] || ""} ${modeLabel(m)}`]);

    const stateMap = obsKind === "rail"
      ? SimulationController.observations.state_rails
      : SimulationController.observations.state_comps;
    const current = stateMap.get(obsKey) || "unknown";

    //  将反向diagnostic工具（状态选择器+指标+历史）分组为
    //  一个清晰的部分，而不是漂浮在底部的裸露的行。
    const diagSec = document.createElement("section");
    diagSec.className = "sch-insp-section sch-insp-diag";
    diagSec.innerHTML = `<h3>${escHtml(t("schematic.inspector.diag_title"))}</h3>`
      + `<p class="sch-insp-hint">${escHtml(t("schematic.inspector.diag_hint"))}</p>`;
    body.appendChild(diagSec);

    const row = document.createElement("div");
    row.className = "sim-obs-row";
    const picker = document.createElement("div");
    picker.className = "sim-mode-picker";
    //  在数据类型上使用 pickerKind，以便 CSS 可以定位被动变体。
    picker.setAttribute("data-kind", pickerKind);
    for (const [mode, label] of modesForKind) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.mode = mode;
      if (mode === current) btn.classList.add("active");
      btn.innerHTML = label;
      btn.addEventListener("click", () => {
        SimulationController.setObservation(obsKind, obsKey, mode);
        updateInspector(node);
      });
      picker.appendChild(btn);
    }
    row.innerHTML = `<span class="sim-obs-label">${escHtml(t("schematic.inspector.observation"))}</span>`;
    row.appendChild(picker);
    diagSec.appendChild(row);

    //  --- 公制输入行 ---
    const unitForKind = obsKind === "rail" ? "V" : "°C";
    const metricMap = obsKind === "rail"
      ? SimulationController.observations.metrics_rails
      : SimulationController.observations.metrics_comps;
    const existingMetric = metricMap.get(obsKey);

    const metricRow = document.createElement("div");
    metricRow.className = "sim-metric-row";
    //  如果技术尚未记录，则从 rail 标签推断名义值。
    const inferredNominal = obsKind === "rail" ? inferRailNominalV(obsKey) : null;
    const nominalForDisplay = existingMetric?.nominal ?? inferredNominal;
    metricRow.innerHTML = `
      <span class="sim-obs-label">${escHtml(t("schematic.inspector.measured"))}</span>
      <input type="number" class="sim-metric-input" step="0.01" value="${existingMetric?.measured ?? ""}">
      <select class="sim-metric-unit">
        ${["V", "mV", "A", "°C", "Ω", "W"].map(u =>
          `<option value="${u}" ${u === (existingMetric?.unit || unitForKind) ? "selected" : ""}>${u}</option>`
        ).join("")}
      </select>
      <span class="sim-metric-nominal">${nominalForDisplay != null ? escHtml(t("schematic.inspector.nominal_with_unit", { value: nominalForDisplay, unit: existingMetric?.unit || unitForKind })) : ""}</span>
      <button type="button" class="sim-metric-record">${escHtml(t("schematic.inspector.record"))}</button>
    `;
    const inputEl = metricRow.querySelector(".sim-metric-input");
    const unitEl = metricRow.querySelector(".sim-metric-unit");
    const recordBtn = metricRow.querySelector(".sim-metric-record");
    const doRecord = async () => {
      const valueRaw = inputEl.value.trim();
      if (valueRaw === "") return;
      const value = parseFloat(valueRaw);
      if (!Number.isFinite(value)) return;
      const unit = unitEl.value;
      const nominal = existingMetric?.nominal ?? inferredNominal;
      //  客户端自动分类镜像（与Python端相同的阈值）。
      const mode = clientAutoClassify(obsKind, value, unit, nominal);
      //  立即更新本地状态。
      SimulationController.setObservation(obsKind, obsKey, mode || "unknown", {
        measured: value, unit, nominal,
      });
      //  如果我们有 repair_id，请发布到期刊。
      const slug = STATE.slug;
      const repairId = ctxRepairId();
      if (slug && repairId) {
        try {
          await fetch(
            `/pipeline/packs/${encodeURIComponent(slug)}/repairs/${encodeURIComponent(repairId)}/measurements`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                target: `${obsKind === "comp" ? "comp" : "rail"}:${obsKey}`,
                value, unit, nominal,
              }),
            },
          );
        } catch (err) {
          console.warn("[measurements] POST failed", err);
        }
      }
      updateInspector(node);
    };
    inputEl.addEventListener("keydown", ev => { if (ev.key === "Enter") doRecord(); });
    inputEl.addEventListener("blur", doRecord);
    recordBtn.addEventListener("click", doRecord);
    diagSec.appendChild(metricRow);

    //  --- 测量历史记录（async 获取，重新打开时替换）---
    const historyBox = document.createElement("div");
    historyBox.className = "sim-measurement-history";
    historyBox.innerHTML = `<div class="sim-mh-title">${escHtml(t("schematic.inspector.history_title", { target: obsKey }))}</div><div class="sim-mh-list"></div>`;
    diagSec.appendChild(historyBox);
    (async () => {
      const target = `${obsKind === "comp" ? "comp" : "rail"}:${obsKey}`;
      const events = await SimulationController.loadMeasurementHistory(target);
      const listEl = historyBox.querySelector(".sim-mh-list");
      if (!events.length) {
        listEl.innerHTML = `<div class="sim-mh-empty">${escHtml(t("schematic.inspector.history_empty"))}</div>`;
        return;
      }
      //  保留最近的 6 个（倒序）。
      const recent = events.slice(-6);
      let prev = null;
      const rows = recent.map(ev => {
        const ts = (ev.timestamp || "").slice(11, 19);  // HH:MM:SS
        const val = ev.value != null ? `${ev.value}${ev.unit || ""}` : "n/a";
        const ratio = (ev.value != null && ev.nominal)
          ? ` (${((ev.value / ev.nominal) * 100).toFixed(0)}%)`
          : "";
        const mode = ev.auto_classified_mode || "…";
        const note = ev.note ? ` · « ${escHtml(ev.note)} »` : "";
        const delta = (prev && ev.value != null && prev.value != null)
          ? ` Δ${(ev.value - prev.value).toFixed(3)}`
          : "";
        prev = ev;
        return `
          <div class="sim-mh-row">
            <span class="sim-mh-ts">${ts}</span>
            <span class="sim-mh-val">${val}${ratio}</span>
            <span class="sim-mh-mode sim-mh-mode--${mode}">${mode}</span>
            <span class="sim-mh-note">${delta}${note}</span>
          </div>`;
      });
      listEl.innerHTML = rows.join("");
    })();
  }

  //  --- 诊断器/重新初始化按钮（反向-diagnostic）---
  //  每当记录至少一个观察结果时显示，无论
  //  当前在inspector中选择了哪个节点。
  const obsCount = Object.values(SimulationController.observations).reduce((sum, m) => sum + m.size, 0);
  if (obsCount > 0) {
    const diagBtn = document.createElement("button");
    diagBtn.className = "sim-inspector-action sim-inspector-action--diag";
    diagBtn.textContent = obsCount === 1
      ? t("schematic.inspector.diagnose_one", { count: obsCount })
      : t("schematic.inspector.diagnose_many", { count: obsCount });
    diagBtn.addEventListener("click", () => SimulationController.hypothesize(STATE.slug));
    body.appendChild(diagBtn);

    const clearBtn = document.createElement("button");
    clearBtn.className = "sim-inspector-action";
    clearBtn.textContent = t("schematic.inspector.reset_observations");
    clearBtn.addEventListener("click", () => {
      SimulationController.clearObservations();
      updateInspector(node);
    });
    body.appendChild(clearBtn);
  }

  //  --- 故障注入动作（行为模拟器集成）---
  //  仅出现在组件节点上。将 refdes 切换为
  //  SimulationController.killedRefdes，重新获取timeline，并查找
  //  洗涤器到电路板停止的阶段，以便技术人员看到
  //  立即级联。
  if (node.kind !== "rail" && node.refdes) {
    const already = SimulationController.killedRefdes.includes(node.refdes);
    const faultSec = document.createElement("section");
    faultSec.className = "sch-insp-section sch-insp-faults";
    faultSec.innerHTML = `<h3>${escHtml(t("schematic.inspector.faults_title"))}</h3>`;
    body.appendChild(faultSec);

    const faultBtn = document.createElement("button");
    faultBtn.className = `sim-inspector-action sim-inspector-action--danger${already ? " active" : ""}`;
    faultBtn.textContent = already
      ? t("schematic.inspector.remove_fault", { refdes: node.refdes })
      : t("schematic.inspector.simulate_fault", { refdes: node.refdes });
    faultBtn.addEventListener("click", async () => {
      if (already) {
        SimulationController.killedRefdes = SimulationController.killedRefdes.filter(r => r !== node.refdes);
      } else {
        SimulationController.killedRefdes.push(node.refdes);
      }
      await SimulationController.refresh(STATE.slug);
      const tl = SimulationController.timeline;
      if (tl && tl.blocked_at_phase != null) {
        const idx = tl.states.findIndex(s => s.phase_index === tl.blocked_at_phase);
        if (idx >= 0) SimulationController.seek(idx);
        SimulationController.pause();
      }
      updateInspector(node);   //  反映布防/撤防状态+复位按钮
    });
    faultSec.appendChild(faultBtn);

    //  重置按钮 — 仅当至少有一个故障处于活动状态时。
    if (SimulationController.killedRefdes.length > 0) {
      const resetBtn = document.createElement("button");
      resetBtn.className = "sim-inspector-action";
      resetBtn.textContent = SimulationController.killedRefdes.length === 1
        ? t("schematic.inspector.reset_simulation_one", { count: SimulationController.killedRefdes.length })
        : t("schematic.inspector.reset_simulation_many", { count: SimulationController.killedRefdes.length });
      resetBtn.addEventListener("click", async () => {
        SimulationController.killedRefdes = [];
        await SimulationController.refresh(STATE.slug);
        SimulationController.seek(0);
        updateInspector(node);
      });
      faultSec.appendChild(resetBtn);
    }
  }

  //  在 inspector 内连接可点击的 chip 以在节点之间导航。
  body.querySelectorAll(".clickable[data-id]").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      const n = STATE.model.nodeById.get(id);
      if (n) { STATE.selectedId = id; updateInspector(n); applyFocus(id, STATE.model); }
    });
  });
}

/*  ---------------------------------------------------------------------------------- *
 * 缩放/平移/适合 *
 * ----------------------------------------------------------------------  */

function initZoom(model) {
  const svg = d3.select("#schGraph");
  const root = d3.select("#schZoomRoot");
  const zoom = d3.zoom().scaleExtent([0.2, 3.5]).on("zoom", (ev) => {
    root.attr("transform", ev.transform);
    el("schZoomLabel").textContent = `× ${ev.transform.k.toFixed(2)}`;
    document.getElementById("schGraph").dataset.zoom =
      ev.transform.k < 0.5 ? "low" : ev.transform.k < 1.2 ? "mid" : "high";
  });
  STATE.zoom = zoom;
  svg.call(zoom);
  fitToBounds(model);
  //  Refit on canvas resize — 当聊天面板打开/关闭时触发（其中
  //  通过 right:420px 缩小 .sch-root)，在窗口调整大小时，以及当 rail 时
  //  sidebar 切换。如果没有这个，缩放变换将保持锚定到
  //  预先调整几何图形的大小，内容会从聊天面板后面移出屏幕。
  if (STATE._resizeObserver) STATE._resizeObserver.disconnect();
  let refitTimer = null;
  STATE._resizeObserver = new ResizeObserver(() => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => {
      if (STATE.model) fitToBounds(STATE.model);
    }, 150);
  });
  STATE._resizeObserver.observe(el("schCanvas"));
}

//  FIT_TOP_INSET 为顶部浮动 overlay 保留间隙
//  位于画布内容上方。画布的 CSS 底部已经排除了
//  boot timeline (148px)，因此用户感知的视觉中心
//  因为 workspace 不是画布中心 - 它位于画布中心下方。我们中心
//  可用区域 [FIT_TOP_INSET, H-PAD] 中的内容，因此 rail/heads
//  着陆在视觉中点而不是原始中心。
const FIT_TOP_INSET = 140;
const FIT_PAD = 30;

function fitToBounds(model) {
  if (!model.bounds) return;
  const canvas = el("schCanvas");
  //  canvas.clientHeight 已经排除了引导 timeline (CSS 底部:148px)。
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const { minX, minY, maxX, maxY } = model.bounds;
  const bw = maxX - minX, bh = maxY - minY;
  const availW = W - FIT_PAD * 2;
  const availH = H - FIT_TOP_INSET - FIT_PAD;
  const scale = Math.min(availW / bw, availH / bh, 1.4);
  const tx = FIT_PAD + (availW - bw * scale) / 2 - minX * scale;
  const ty = FIT_TOP_INSET + (availH - bh * scale) / 2 - minY * scale;
  d3.select("#schGraph").transition().duration(400).call(STATE.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

//  缩放/平移以仅构建一组节点 ID — 由启动播放器使用，以便
//  选择一个相位框架该相位的节点而不是将它们保留为一个微小的
//  集群在全板图内。
function fitToPhaseNodes(model, ids) {
  if (!STATE.zoom) return;
  //  从渲染的 D3 选择中读取位置 - 布局坐标
  //  存在于绑定数据上，不一定存在于 model.nodeById 对象上。
  const pts = [];
  d3.selectAll("#schLayerNodes g.sch-node").each(function (d) {
    if (d && ids.has(d.id) && isFinite(d.x) && isFinite(d.y)) pts.push(d);
  });
  if (pts.length === 0) return;
  const PAD = 64;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  pts.forEach(n => {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  });
  const canvas = el("schCanvas");
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const bw = Math.max(1, (maxX - minX) + PAD * 2);
  const bh = Math.max(1, (maxY - minY) + PAD * 2);
  const availW = W - FIT_PAD * 2;
  const availH = H - FIT_TOP_INSET - FIT_PAD;
  const scale = Math.min(availW / bw, availH / bh, 1.6);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const tx = FIT_PAD + availW / 2 - cx * scale;
  const ty = FIT_TOP_INSET + availH / 2 - cy * scale;
  d3.select("#schGraph").transition().duration(400).call(STATE.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

//  过滤器识别的规范网域。键入其中之一
//  突出显示其主网络属于该域的每个节点。
const KNOWN_DOMAINS = new Set([
  "hdmi", "usb", "pcie", "ethernet", "audio", "display",
  "storage", "debug", "power_seq", "power_rail", "clock",
  "reset", "control", "ground", "misc",
]);

//  每个域的辅助标签前缀模式。当Sonnet将rail标记为
//  power_rail（例如 USB_PWR 功能上是 USB，但结构上是 rail），
//  子串模式恢复它，以便技术人员看到完整的 HDMI / USB /
//  等家庭按域查询时。
const DOMAIN_SUBSTRING = {
  hdmi:     /\b(HDMI|TMDS|DDC|CEC)\b|^(HDMI|TMDS|DDC)_/i,
  usb:      /\bUSB\b|^USB|USB_/i,
  pcie:     /\bPCIE\b|^PCIE/i,
  ethernet: /\b(ETH|RGMII|MII|MDIO|PHY)\b|^(ETH|RGMII|MII|MDIO|PHY)_/i,
  audio:    /\b(I2S|DAC|ADC|SPDIF|AUDIO|MICBIAS|AVDD|DBVDD|DCVDD|SPKVDD)\b|^(I2S|DAC|ADC|SPDIF|AUDIO|MIC)_/i,
  display:  /\b(EDP|DSI|LCD|BACKLIGHT|LVDS|DP_AUX)\b|^(EDP|DSI|LCD|BL_)/i,
  storage:  /\b(SD|EMMC|MMC|SDHC|SDIO)\b|^(SD|EMMC|MMC)_/i,
  debug:    /\b(JTAG|SWD|UART|TDI|TDO|TCK|TMS|SWDIO|SWCLK)\b|^(JTAG|SWD|UART)_/i,
  //  power_seq / power_rail / 时钟 / 复位 / 控制 / 接地 : pas de
  //  前缀族 — 位于 ceux-là 的域类中。
};

function highlightDomain(model, domain) {
  const graph = STATE.graph || {};
  const classified = (graph.net_classification && graph.net_classification.nets) || {};
  const allNets = graph.nets || {};
  const matchingNets = new Set();

  //  1) 主要 — 分类域匹配的网络。
  for (const [label, cn] of Object.entries(classified)) {
    if ((cn.domain || "").toLowerCase() === domain) matchingNets.add(label);
  }

  //  2）次要——功能族子串/前缀匹配，所以像一个网络
  //  USB_PWR（分类为 power_rail）在技术正常时仍然亮起
  //  按“usb”过滤。涵盖最常见的交叉分类。
  const pattern = DOMAIN_SUBSTRING[domain];
  if (pattern) {
    for (const label of Object.keys(allNets)) {
      if (pattern.test(label)) matchingNets.add(label);
    }
    //  还可以选择我们尚未列举的仅限分类的网络。
    for (const label of Object.keys(classified)) {
      if (pattern.test(label)) matchingNets.add(label);
    }
  }

  if (matchingNets.size === 0) {
    el("schFilterStatus").textContent = t("schematic.filter.domain_no_nets", { domain });
    return false;
  }

  //  找到引脚至少接触域中一个网络的每个组件。
  const matchingComponents = new Set();
  for (const n of model.nodes) {
    if (n.kind !== "component") continue;
    const pins = n.pinsAll || [];
    if (pins.some(p => matchingNets.has(p.net_label))) matchingComponents.add(n.id);
    //  还包括标签匹配的 rail。
  }
  for (const n of model.nodes) {
    if (n.kind === "rail" && matchingNets.has(n.label)) matchingComponents.add(n.id);
  }

  if (matchingComponents.size === 0) {
    el("schFilterStatus").textContent = t("schematic.filter.domain_no_matches", { domain });
    return true;
  }

  d3.select("#schGraph").classed("has-focus", true);
  d3.selectAll("#schLayerNodes g.sch-node")
    .classed("focus", false)
    .classed("neighbor", d => matchingComponents.has(d.id))
    .classed("downstream", false)
    .classed("upstream", false);
  d3.selectAll("#schLayerLinks path")
    .classed("active-link", d => matchingComponents.has(d.sourceId) && matchingComponents.has(d.targetId));

  el("schFilterStatus").textContent = t("schematic.filter.domain_components", { domain, count: matchingComponents.size });
  return true;
}

function runFilter(q, model) {
  if (!q) { clearFocus(); el("schFilterStatus").textContent = ""; return; }
  const qu = q.toUpperCase().trim();
  const ql = q.toLowerCase().trim();

  //  1）识别功能域→突出整个集群。
  if (KNOWN_DOMAINS.has(ql)) {
    if (highlightDomain(model, ql)) return;
  }

  //  2) 回退到 refdes / rail 标签匹配。
  //  重要提示：仅过滤高光+缩放。它不会打开
  //  inspector — 否则在瞄准“usb”时输入“u”将会
  //  自动聚焦 USB_PWR 并在用户完成之前弹出其 inspector
  //  输入域关键字。用户必须明确单击该节点才能
  //  打开inspector。
  const hit = model.nodes.find(n => (n.refdes || n.label).toUpperCase() === qu)
    || model.nodes.find(n => (n.refdes || n.label).toUpperCase().startsWith(qu));
  if (!hit) { el("schFilterStatus").textContent = t("schematic.filter.none"); return; }
  el("schFilterStatus").textContent = t("schematic.filter.hit_arrow", { label: hit.refdes || hit.label });
  //  仅视觉突出显示 - 像悬停一样显示节点的邻居
  //  会，但保持inspector关闭。
  d3.select("#schGraph").classed("has-focus", true);
  const neighborIds = new Set([hit.id]);
  for (const e of model.edges) {
    if (e.sourceId === hit.id) neighborIds.add(e.targetId);
    if (e.targetId === hit.id) neighborIds.add(e.sourceId);
  }
  d3.selectAll("#schLayerNodes g.sch-node")
    .classed("focus", d => d.id === hit.id)
    .classed("neighbor", d => neighborIds.has(d.id) && d.id !== hit.id)
    .classed("downstream", false)
    .classed("upstream", false);
  d3.selectAll("#schLayerLinks path")
    .classed("active-link", d => d.sourceId === hit.id || d.targetId === hit.id);
  const canvas = el("schCanvas");
  //  canvas.clientHeight 已经排除了引导 timeline (CSS 底部:148px)。
  //  将焦点节点置于 workspace 中点中心（顶部 overlay 除外）
  //  因此它位于用户期望看到的位置，而不是表面切换的后面。
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const workspaceCY = FIT_TOP_INSET + (H - FIT_TOP_INSET - FIT_PAD) / 2;
  const scale = 1.7;
  const tx = W / 2 - hit.x * scale;
  const ty = workspaceCY - hit.y * scale;
  d3.select("#schGraph").transition().duration(400).call(STATE.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

/*  ---------------------------------------------------------------------------------- *
 * 统计 + 空 *
 * ----------------------------------------------------------------------  */

function updateStats(model, graph) {
  //  仅计算当前模式下画布上的实际内容，通过
  //  渲染器使用相同的谓词 - 因此计数跟踪布局模式
  //  被动切换而不是报告固定模型总数。
  const rendered = model.nodes.filter(n => isNodeRendered(n, model));
  const compCount = rendered.filter(n => n.kind === "component").length;
  const railCount = rendered.filter(n => n.kind === "rail").length;
  const sourceShown = rendered.filter(
    n => n.kind === "component" && n.role === "source"
  ).length;
  const tot = model.totals || {};

  //  视图渲染内容的简单计数。无“显示/总计”比率：
  //  分母（全板，包括仅信号无源器件）在
  //  此视图仅读取为缺失数据。
  el("schStatComps").textContent  = compCount;
  el("schStatRails").textContent  = railCount;
  el("schStatRegs").textContent   = sourceShown;
  el("schStatPhases").textContent = tot.phases ?? (graph.boot_sequence || []).length;
  const q = graph.quality || {};
  el("schStatConf").textContent   = q.confidence_global != null ? q.confidence_global.toFixed(2) : "n/a";
  el("schStatPages").textContent  = q.pages_parsed != null ? `${q.pages_parsed}/${q.total_pages}` : "n/a";

  //  Dégradé 徽章 — 单击可打开详细信息 popover（编译器触发器：
  //  confidence_global < 0.7 或 orphan_cross_page > 5)。
  const deg = el("schStatDegraded");
  deg.classList.toggle("on", Boolean(q.degraded_mode));
  if (q.degraded_mode) {
    deg.classList.add("clickable");
    deg.title = t("schematic.degraded.hint_click");
    wireDegradedPopover(q);
  } else {
    deg.classList.remove("clickable");
    deg.title = "";
    deg.onclick = null;
    el("schDegradedPop")?.classList.remove("open");
  }
}

//  构建 + 连接锚定在统计栏下方的降级模式详细信息 popover。
//  列出每个质量指标；那些真正触发 degraded_mode 的
//  （置信度 < 0.7，孤儿跨页 > 5）标记为琥珀色。
function wireDegradedPopover(q) {
  const host = document.querySelector("#schematicSection") || document.body;
  let pop = el("schDegradedPop");
  if (!pop) {
    pop = document.createElement("div");
    pop.className = "sch-degraded-pop";
    pop.id = "schDegradedPop";
    host.appendChild(pop);
  }
  const tx = window.t;
  const orphTrig = (q.orphan_cross_page_refs ?? 0) > 5;
  const confTrig = q.confidence_global != null && q.confidence_global < 0.7;
  const row = (label, val, trigger) =>
    `<div class="sch-degp-row${trigger ? " trigger" : ""}"><span class="sch-degp-k">${escHtml(label)}</span><span class="sch-degp-v">${escHtml(String(val))}</span></div>`;
  const rows = [
    row(tx("schematic.degraded.metric_orphans"), `${q.orphan_cross_page_refs ?? 0}${orphTrig ? "  (> 5)" : ""}`, orphTrig),
    row(tx("schematic.degraded.metric_unresolved"), q.nets_unresolved ?? 0, false),
    row(tx("schematic.degraded.metric_confidence"), q.confidence_global != null ? q.confidence_global.toFixed(2) : "n/a", confTrig),
    row(tx("schematic.degraded.metric_no_value"), q.components_without_value ?? 0, false),
    row(tx("schematic.degraded.metric_no_mpn"), q.components_without_mpn ?? 0, false),
    row(tx("schematic.degraded.metric_untraced"), q.components_untraced ?? 0, false),
    row(tx("schematic.degraded.metric_pages"), `${q.pages_parsed ?? "?"}/${q.total_pages ?? "?"}`, false),
  ];
  pop.innerHTML = `
    <div class="sch-degp-head">
      <span>${escHtml(tx("schematic.degraded.pop_title"))}</span>
      <button class="sch-degp-close" title="${escHtml(tx("schematic.simulator.close_title"))}">×</button>
    </div>
    <p class="sch-degp-why">${escHtml(tx("schematic.degraded.pop_why"))}</p>
    <div class="sch-degp-rows">${rows.join("")}</div>
    <p class="sch-degp-fix">${escHtml(tx("schematic.degraded.pop_fix"))}</p>`;
  pop.querySelector(".sch-degp-close").addEventListener("click", () => pop.classList.remove("open"));
  deg_onclick(pop);
}

function deg_onclick(pop) {
  const deg = el("schStatDegraded");
  deg.onclick = (ev) => { ev.stopPropagation(); pop.classList.toggle("open"); };
  if (!pop._outsideWired) {
    document.addEventListener("click", (ev) => {
      if (pop.classList.contains("open") && !pop.contains(ev.target) && ev.target !== deg) {
        pop.classList.remove("open");
      }
    });
    pop._outsideWired = true;
  }
}

function showEmptyState(title, detail, hint = null) {
  const w = el("schEmptyState");
  if (!w) return;
  w.classList.remove("hidden");
  el("schEmptyTitle").textContent = title;
  el("schEmptyDetail").textContent = detail;
  const h = el("schEmptyHint");
  if (hint) { h.textContent = hint; h.classList.remove("hidden"); }
  else h.classList.add("hidden");
  el("schCanvas").classList.add("hidden");
  el("schBootTimeline")?.classList.add("hidden");
}

function hideEmptyState() {
  el("schEmptyState")?.classList.add("hidden");
  el("schCanvas").classList.remove("hidden");
  el("schBootTimeline")?.classList.remove("hidden");
}

/*  ---------------------------------------------------------------------------------- *
 * 公开 *
 * ----------------------------------------------------------------------  */

function fullRender(graph) {
  hideEmptyState();
  const model = buildModel(graph);
  STATE.model = model;

  //  CSS 对 body 类做出反应 - 它显示 rail sidebar 并移动
  //  画布 240 像素，处于 rail 焦点模式。
  document.body.classList.toggle("sch-mode-railfocus", STATE.layoutMode === "railfocus");

  //  当包没有分析启动顺序时，启动模式会回退到网格。
  const bootReady = STATE.layoutMode === "boot" && (model.boot || []).length > 0;
  if (bootReady) {
    computeBootLayout(model);
    renderBootHeads(model);
  } else if (STATE.layoutMode === "railfocus") {
    renderRailBar(model);
    //  如果 rail 不再存在于该包中，则删除陈旧的选择。
    let rid = STATE.selectedRailId;
    if (rid && !model.nodeById.has(rid)) {
      rid = null;
      STATE.selectedRailId = null;
      try { localStorage.removeItem("schSelectedRail"); } catch (_) {}
    }
    computeRailFocusLayout(model, rid);
    renderRailFocusHeads(model);
  } else if (STATE.layoutMode === "powertree") {
    computePowertreeLayout(model);
    renderPowertreeHeads(model);
  } else {
    computeGridLayout(model);
    renderGridHeads(model);
  }
  renderNodes(model);
  renderEdges(model);
  renderBootTimeline(model);
  updateStats(model, graph);
  initZoom(model);
  d3.select("#schGraph").on("click", (ev) => {
    if (ev.target.tagName === "svg" || ev.target.id === "schGraph") clearFocus();
  });
}

//  重新渲染本地化内容（启动timeline、inspector、模拟器、rail栏）
//  当用户翻转语言切换器时。带有 `data-i18n` 的静态标记
//  由 `window.i18n.applyDom` 处理；这个钩子涵盖了命令式
//  由该模块中的“t()”调用驱动的渲染器。
let _i18nWired = false;
function wireSchematicI18n() {
  if (_i18nWired) return;
  if (!window.i18n || typeof window.i18n.onChange !== "function") return;
  _i18nWired = true;
  window.i18n.onChange(() => {
    if (!STATE.graph) return;
    fullRender(STATE.graph);
    if (STATE.selectedId) {
      const n = STATE.model?.nodeById?.get(STATE.selectedId);
      if (n) updateInspector(n);
    }
    SimulationController.render();
    if (SimulationController.hypotheses && SimulationController.hypotheses.length) {
      SimulationController._renderHypothesesPanel();
    }
  });
}

export async function loadSchematic() {
  wireSchematicI18n();
  //  重新读取每个部分条目上的持久首选项 - 另一个模块（例如
  //  boardview minimap) 可能翻转了layoutMode / selectedRailId
  //  在两次访问之间，模块级 STATE init 仅运行一次。
  try {
    const storedMode = localStorage.getItem("schLayoutMode");
    if (storedMode) STATE.layoutMode = storedMode;
    STATE.selectedRailId = localStorage.getItem("schSelectedRail") || null;
  } catch (_) { /*  忽略  */ }

  const slug = getDeviceSlug();
  STATE.slug = slug;
  //  首先连接表面开关 - 用户必须始终能够翻转
  //  Graphe / PDF 无论是否编译电气图
  //  （即使没有运行任何管道，PDF 也可能存在于 board_assets/ 中）。
  wireSurfaceToggle();
  if (!slug) {
    showEmptyState(t("schematic.empty.no_repair_title"), t("schematic.empty.no_repair_detail"));
    return;
  }
  const res = await fetchSchematic(slug);
  if (res.missing) {
    showEmptyState(t("schematic.empty.no_schematic_title"), t("schematic.empty.no_schematic_detail", { slug }),
      `curl -X POST http://localhost:8000/pipeline/ingest-schematic \\\n  -H 'content-type: application/json' \\\n  -d '{"device_slug":"${slug}","pdf_path":"board_assets/${slug}.pdf"}'`);
    return;
  }
  if (res.error) { showEmptyState(t("schematic.empty.load_error_title"), res.error); return; }
  STATE.graph = res.graph;
  fullRender(res.graph);
  //  第一次渲染后立即连接缩放/滤镜/rail-搜索控件
  //  — 在任何 await 可用的工作之前 — 因此右下角缩放栏中的按钮
  //  画布出现在屏幕上的那一刻就变得活跃起来，即使模拟器
  //  在马厩或投掷物下面补充水分。
  wireControls();
  //  触发模拟器获取 - 端点为fast（< 10ms 服务器端）；
  //  当图具有 boot_sequence + power_rails 时，我们无条件地执行此操作。
  if (STATE.graph && STATE.graph.boot_sequence?.length && Object.keys(STATE.graph.power_rails || {}).length) {
    SimulationController.refresh(STATE.slug);
  }
  //  从每次修复测量日志中获取观察状态，以便
  //  该技术过去的读数在重新加载后仍然存在。
  try {
    await SimulationController.hydrateFromJournal(slug);
  } catch (err) {
    console.warn("[schematic] hydrateFromJournal failed:", err);
  }
}

function wireControls() {
  //  防止部分重新进入时出现双重接线 — `addEventListener`
  //  否则会在每次 loadSchematic() 调用时堆栈一个新的处理程序，并且
  //  每次点击都会并行触发 N 个转换。
  const wireOnce = (id, handler) => {
    const node = el(id);
    if (!node || node.dataset.schWired === "1") return;
    node.dataset.schWired = "1";
    node.addEventListener("click", handler);
  };
  wireOnce("schBtnFit", () => { if (STATE.model) fitToBounds(STATE.model); });
  wireOnce("schBtnZoomIn", () => {
    if (STATE.zoom) d3.select("#schGraph").transition().duration(180).call(STATE.zoom.scaleBy, 1.3);
  });
  wireOnce("schBtnZoomOut", () => {
    if (STATE.zoom) d3.select("#schGraph").transition().duration(180).call(STATE.zoom.scaleBy, 1 / 1.3);
  });
  const filterIn = el("schFilterInput");
  //  去抖 180ms，因此快速输入的“usb”不会重新运行过滤器 3 次
  //  （这将在用户完成之前运行完整的重新突出显示）。
  let filterDebounceTimer = null;
  filterIn?.addEventListener("input", (ev) => {
    clearTimeout(filterDebounceTimer);
    const value = ev.target.value;
    filterDebounceTimer = setTimeout(() => {
      if (STATE.model) runFilter(value, STATE.model);
    }, 180);
  });
  filterIn?.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      clearTimeout(filterDebounceTimer);
      ev.target.value = "";
      clearFocus();
      el("schFilterStatus").textContent = "";
    }
  });
  //  Rail sidebar 本地搜索 — 过滤客户端上的 rail 名称。
  //  将子字符串标记为青色，缓存 rails 匹配项
  //  pas，puis masque les headers de groupe devenus vides。幂等。
  const railSearchInput = el("schRailSearchInput");
  if (railSearchInput && railSearchInput.dataset.schWired !== "1") {
    railSearchInput.dataset.schWired = "1";
    let railSearchDebounce = null;
    railSearchInput.addEventListener("input", (ev) => {
      clearTimeout(railSearchDebounce);
      const q = ev.target.value.trim().toUpperCase();
      railSearchDebounce = setTimeout(() => runRailSearch(q), 120);
    });
    railSearchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        clearTimeout(railSearchDebounce);
        ev.target.value = "";
        runRailSearch("");
      }
    });
  }
}

/*  Rail sidebar 搜索 — 就地过滤 rail 列表并隐藏任何内容
 * 最终具有零匹配子项的电压组。运行于
 * 已经渲染的 DOM（renderRailBar 写入项目，这会切换
 * 可见性），因此不需要重新渲染。  */
function runRailSearch(query) {
  const list = el("schRailBarList");
  if (!list) return;
  const items = list.querySelectorAll(".sch-rail-item");
  items.forEach(item => {
    const nameEl = item.querySelector(".sch-rail-name");
    if (!nameEl) return;
    const raw = nameEl.dataset.rawLabel ?? nameEl.textContent;
    if (!nameEl.dataset.rawLabel) nameEl.dataset.rawLabel = raw;
    if (!query) {
      nameEl.textContent = raw;
      item.classList.remove("sch-hidden");
      return;
    }
    const idx = raw.toUpperCase().indexOf(query);
    if (idx === -1) {
      nameEl.textContent = raw;
      item.classList.add("sch-hidden");
      return;
    }
    item.classList.remove("sch-hidden");
    nameEl.textContent = "";
    nameEl.appendChild(document.createTextNode(raw.slice(0, idx)));
    const mark = document.createElement("mark");
    mark.textContent = raw.slice(idx, idx + query.length);
    nameEl.appendChild(mark);
    nameEl.appendChild(document.createTextNode(raw.slice(idx + query.length)));
  });
  //  隐藏电压组标题，其以下项目均被隐藏。
  const groups = list.querySelectorAll(".sch-rail-group");
  groups.forEach(g => {
    let any = false;
    let next = g.nextElementSibling;
    while (next && !next.classList.contains("sch-rail-group")) {
      if (next.classList.contains("sch-rail-item") && !next.classList.contains("sch-hidden")) {
        any = true;
        break;
      }
      next = next.nextElementSibling;
    }
    g.classList.toggle("sch-hidden", !any);
  });
}

/*  ---------------------------------------------------------------------------------- *
 * 表面切换接线 — idempotent，在每个 loadSchematic() 上调用 *
 * 因此，即使电气图表为 *，Graphe/PDF 按钮也能工作
 * 失踪。点击监听器被附加一次； dataset 旗帜卫士 *
 * 反对对重复的部分条目重新接线。                         *
 * ----------------------------------------------------------------------  */

function wireSurfaceToggle() {
  applySurface(STATE.surface);
  document.querySelectorAll("[data-sch-surface]").forEach(btn => {
    if (btn.dataset.schSurfaceWired === "1") return;
    btn.dataset.schSurfaceWired = "1";
    btn.addEventListener("click", (ev) => {
      const surface = ev.currentTarget.dataset.schSurface;
      if (!surface || surface === STATE.surface) return;
      STATE.surface = surface;
      try { localStorage.setItem("schSurface", surface); } catch (_) { /*  忽略  */ }
      applySurface(surface);
    });
  });
}

/*  ---------------------------------------------------------------------------------- *
 * 表面切换 — 在派生图形视图和 *
 * 原始schematic PDF。 PDF iframe src 首先延迟启动*
 * 仅当 slug 变化时才使用 and ，因此来回翻转 *
 * 保留本机查看器的滚动位置。                         *
 * ----------------------------------------------------------------------  */

async function applySurface(surface) {
  const root = document.getElementById("schematicSection");
  if (!root) return;
  //  同步按钮开/关状态，因此即使在
  //  表面以编程方式设置（例如，从持久的localStorage）。
  document.querySelectorAll("[data-sch-surface]").forEach(btn => {
    btn.classList.toggle("on", btn.dataset.schSurface === surface);
  });
  root.classList.toggle("surface-pdf", surface === "pdf");
  if (surface !== "pdf") return;
  await primePdfViewer(STATE.slug);
}

/*  ---------------------------------------------------------------------------------- *
 * PDF 查看器 — 锚点感知、深色主题、渲染光栅化页面 PNG *
 * 通过语义搜索overlay。替换本机浏览器 PDF UI *
 *因此设计标记（组件的深色、单色、青色强调）保留*
 * 与工作台的其余部分保持一致。                               *
 * ----------------------------------------------------------------------  */

async function primePdfViewer(slug) {
  const scroll = document.getElementById("schPdfScroll");
  const empty = document.getElementById("schPdfEmpty");
  if (!scroll || !empty) return;
  if (!slug) {
    scroll.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  //  已经为此 slug 做好了准备 — 不理会用户的滚动位置。
  if (STATE.pdfPrimedSlug === slug && STATE.pdfPages) {
    empty.classList.add("hidden");
    return;
  }
  let data;
  try {
    const res = await fetch(API_PREFIX + `/pipeline/packs/${encodeURIComponent(slug)}/schematic/pages`);
    if (!res.ok) {
      scroll.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    data = await res.json();
  } catch (_) {
    scroll.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  STATE.pdfPages = data;
  STATE.pdfPrimedSlug = slug;
  empty.classList.add("hidden");
  renderPdfPages(data);
  wirePdfZoom();
  wirePdfSearch();
}

function renderPdfPages(data) {
  const scroll = document.getElementById("schPdfScroll");
  if (!scroll) return;
  scroll.innerHTML = "";
  //  设置滚动容器的缩放比例，以便所有后代页面都选择它
  //  通过 `calc(var(--sch-pdf-base) * var(--sch-pdf-zoom))` 向上。
  scroll.style.setProperty("--sch-pdf-zoom", String(STATE.pdfZoom));
  const pagePill = document.getElementById("schPdfPagePill");
  if (pagePill) pagePill.textContent = t("schematic.pdf.page_pill", { n: 1, count: data.count });
  const frag = document.createDocumentFragment();
  for (const page of data.pages) {
    const fig = document.createElement("figure");
    fig.className = "sch-pdf-page";
    fig.dataset.page = String(page.n);

    const chip = document.createElement("div");
    chip.className = "sch-pdf-page-chip";
    chip.textContent = t("schematic.pdf.page_chip", { n: page.n, count: data.count });
    fig.appendChild(chip);

    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = t("schematic.pdf.img_alt", { n: page.n });
    img.src = page.url;
    //  图像加载后设置基本宽度：borne à 1400px pour
    //  休息摘要 à DPI=150 sur un écran standard, sinon naturalWidth。
    img.addEventListener("load", () => {
      const base = Math.min(1400, img.naturalWidth || 1400);
      img.style.setProperty("--sch-pdf-base", `${base}px`);
    }, { once: true });
    fig.appendChild(img);

    const overlay = document.createElement("div");
    overlay.className = "sch-pdf-anchors";
    fig.appendChild(overlay);

    //  锚点矩形定位为 PDF 页面大小的 %（来自 pdfplumber
    //  点）。转换为 % 而不是像素可以将 overlay 与
    //  PNG 的固有分辨率 - 缩放通过缩放图像/图形来实现
    //  在一起，并且锚矩形保持对齐。
    //
    //  pdfplumber 返回 refdes 字形的 *ink bbox* — 通常为 1%
    //  页面的。这是看不见的亮点。我们将其扩展 3pt
    //  每条边，因此矩形读起来就像文本周围的光环，而不是
    //  而不是字形本身的紧凑轮廓。
    const pw = page.width_pt || 1;
    const ph = page.height_pt || 1;
    const PAD_PT = 3;
    for (const a of page.anchors || []) {
      const rect = document.createElement("div");
      rect.className = "sch-pdf-anchor";
      rect.dataset.refdes = a.refdes;
      const x0 = Math.max(0, a.x0 - PAD_PT);
      const y0 = Math.max(0, a.top - PAD_PT);
      const x1 = Math.min(pw, a.x1 + PAD_PT);
      const y1 = Math.min(ph, a.bottom + PAD_PT);
      rect.style.left = `${(x0 / pw) * 100}%`;
      rect.style.top = `${(y0 / ph) * 100}%`;
      rect.style.width = `${((x1 - x0) / pw) * 100}%`;
      rect.style.height = `${((y1 - y0) / ph) * 100}%`;
      rect.title = a.refdes;
      overlay.appendChild(rect);
    }
    frag.appendChild(fig);
  }
  scroll.appendChild(frag);

  //  观察哪个页面在视口中占主导地位以保留底部药丸
  //  和 .current chip 样式同步。
  observePdfPages();
}

function observePdfPages() {
  const scroll = document.getElementById("schPdfScroll");
  const pill = document.getElementById("schPdfPagePill");
  if (!scroll || !pill) return;
  const pages = scroll.querySelectorAll(".sch-pdf-page");
  if (!pages.length) return;
  const io = new IntersectionObserver((entries) => {
    //  选择具有最大可见比率的相交条目。
    const best = entries
      .filter(e => e.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!best) return;
    const n = parseInt(best.target.dataset.page, 10);
    STATE.pdfCurrentPage = n;
    pill.textContent = t("schematic.pdf.page_pill", { n, count: STATE.pdfPages?.count || "?" });
    pages.forEach(p => p.classList.toggle("current", p === best.target));
  }, { root: scroll, threshold: [0.2, 0.5, 0.8] });
  pages.forEach(p => io.observe(p));
}

function wirePdfZoom() {
  const applyZoom = () => {
    const label = document.getElementById("schPdfZoomLabel");
    if (label) label.textContent = `${Math.round(STATE.pdfZoom * 100)}%`;
    //  滚动根上有一个 CSS var — 每个 img 都会通过 calc() 获取它。
    //  该图环绕了 img 的新尺寸（宽度：适合内容），因此
    //  弹性间隙保持诚实并且页面不重叠。
    const scroll = document.getElementById("schPdfScroll");
    if (scroll) scroll.style.setProperty("--sch-pdf-zoom", String(STATE.pdfZoom));
  };
  //  Zoom-around-anchor：在更改缩放级别之前，捕获
  //  参考元素的视口相对位置（.hit 搜索
  //  如果有，则为结果，否则为当前查看的页面）。之后
  //  回流我们移动滚动，使相同的元素回到相同的位置
  //  视口中的点 - 没有这个，缩放就会失去任何技术
  //  正在寻找，他们必须重新寻找他们的refdes。
  const bump = (delta) => {
    const newZoom = Math.max(0.4, Math.min(3.0, STATE.pdfZoom + delta));
    if (newZoom === STATE.pdfZoom) return;

    const scroll = document.getElementById("schPdfScroll");
    const ref = scroll && (
      scroll.querySelector(".sch-pdf-anchor.hit") ||
      scroll.querySelector(".sch-pdf-page.current") ||
      scroll.querySelector(".sch-pdf-page")
    );
    if (!scroll || !ref) {
      STATE.pdfZoom = newZoom;
      applyZoom();
      return;
    }

    const scrollRect = scroll.getBoundingClientRect();
    const refRect = ref.getBoundingClientRect();
    const refVpX = refRect.left + refRect.width / 2 - scrollRect.left;
    const refVpY = refRect.top + refRect.height / 2 - scrollRect.top;

    STATE.pdfZoom = newZoom;
    applyZoom();

    //  img宽度通过CSS变量同步改变，但是浏览器
    //  仍然需要一个框架来回流图形+锚点。恢复滚动
    //  在下一个 rAF 上， getBoundingClientRect 报告新布局。
    requestAnimationFrame(() => {
      const newScrollRect = scroll.getBoundingClientRect();
      const newRefRect = ref.getBoundingClientRect();
      const newRefVpX = newRefRect.left + newRefRect.width / 2 - newScrollRect.left;
      const newRefVpY = newRefRect.top + newRefRect.height / 2 - newScrollRect.top;
      scroll.scrollLeft += (newRefVpX - refVpX);
      scroll.scrollTop  += (newRefVpY - refVpY);
    });
  };
  const wireOnce = (id, handler) => {
    const btn = document.getElementById(id);
    if (!btn || btn.dataset.schPdfWired === "1") return;
    btn.dataset.schPdfWired = "1";
    btn.addEventListener("click", handler);
  };
  wireOnce("schPdfZoomIn",  () => bump(+0.15));
  wireOnce("schPdfZoomOut", () => bump(-0.15));
  applyZoom();
}

function wirePdfSearch() {
  const input = document.getElementById("schPdfSearchInput");
  const status = document.getElementById("schPdfSearchStatus");
  if (!input || input.dataset.schPdfWired === "1") return;
  input.dataset.schPdfWired = "1";

  let debounceTimer = null;
  input.addEventListener("input", (ev) => {
    clearTimeout(debounceTimer);
    const query = ev.target.value.trim().toUpperCase();
    debounceTimer = setTimeout(() => runPdfSearch(query), 120);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.target.value = "";
      runPdfSearch("");
    }
  });
}

function runPdfSearch(query) {
  const status = document.getElementById("schPdfSearchStatus");
  const scroll = document.getElementById("schPdfScroll");
  if (!scroll) return;
  //  首先删除所有以前的点击，这样就不会累积新的搜索。
  scroll.querySelectorAll(".sch-pdf-anchor.hit").forEach(el => el.classList.remove("hit"));
  if (!query) {
    if (status) { status.textContent = ""; status.className = "sch-pdf-search-status"; }
    return;
  }
  //  匹配规则：精确refdes OR refdes 以查询开头。保留“U13”
  //  避免匹配“U130”，这在密集的板上会产生噪音。
  const hits = [...scroll.querySelectorAll(".sch-pdf-anchor")]
    .filter(a => a.dataset.refdes === query);
  if (!hits.length) {
    //  回退到前缀匹配，以便技术人员可以探测“U1”以查看每个 U1x。
    const prefix = [...scroll.querySelectorAll(".sch-pdf-anchor")]
      .filter(a => a.dataset.refdes.startsWith(query));
    if (!prefix.length) {
      if (status) { status.textContent = t("schematic.pdf.search_none"); status.className = "sch-pdf-search-status miss"; }
      return;
    }
    prefix.forEach(a => a.classList.add("hit"));
    if (status) { status.textContent = t("schematic.pdf.search_prefix", { count: prefix.length }); status.className = "sch-pdf-search-status hit"; }
    scrollToAnchor(prefix[0]);
    return;
  }
  hits.forEach(a => a.classList.add("hit"));
  if (status) {
    status.textContent = hits.length === 1
      ? t("schematic.pdf.search_match_one", { count: hits.length })
      : t("schematic.pdf.search_match_many", { count: hits.length });
    status.className = "sch-pdf-search-status hit";
  }
  scrollToAnchor(hits[0]);
}

function scrollToAnchor(anchor) {
  const scroll = document.getElementById("schPdfScroll");
  const page = anchor.closest(".sch-pdf-page");
  if (!scroll || !page) return;
  //  更喜欢将页面居中（匹配最接近的锚点页面），而不是
  //  锚本身 — 在 A3 横向 schematics 上，锚滚动将
  //  降落在半空中并失去背景。
  page.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function closeSchematicInspector() { clearFocus(); }

