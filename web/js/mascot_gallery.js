// 吉祥物动画画廊 — 从每个州渲染一张实时卡片
// 共享注册表。从index.html 中提取真正的吉祥物SVG 模板，以便
// there is no markup duplication, then reuses mountMascot/setMascotState.

import { MASCOT_STATES } from "./mascot_states.js";
import { mountMascot } from "./mascot.js";

const grid = document.getElementById("mgGrid");
const countEl = document.getElementById("mgCount");

let speed = 1; // 动画播放速率倍增器

// --- 重播图标（内联 SVG，与应用程序的图标语言匹配）---
const REPLAY_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2v3h-3"/></svg>';

/** 将 <template id="tpl-mascot"> 从 index.html 拉入此文档一次。 */
async function ensureTemplate() {
  if (document.getElementById("tpl-mascot")) return true;
  try {
    const html = await fetch("./index.html").then((r) => r.text());
    const doc = new DOMParser().parseFromString(html, "text/html");
    const tpl = doc.getElementById("tpl-mascot");
    if (!tpl) throw new Error("tpl-mascot not found in index.html");
    document.body.appendChild(document.importNode(tpl, true));
    return true;
  } catch (err) {
    console.error("[gallery] could not load mascot template:", err);
    grid.innerHTML =
      '<p style="color:var(--text-3);grid-column:1/-1">' +
      "Impossible de charger le template de la mascotte. " +
      "Ouvre cette page via <code>http://localhost:8000/mascot_gallery.html</code> " +
      "(servie par <code>make run</code>), pas en <code>file://</code>.</p>";
    return false;
  }
}

/** 将当前速度倍增器应用于每个正在运行的 CSS 动画。 */
function applySpeed() {
  if (typeof document.getAnimations !== "function") return;
  for (const anim of document.getAnimations()) anim.playbackRate = speed;
}

/**（重新）安装一张卡牌舞台吉祥物的状态。重新启动动画。 */
function mountCard(stage, state) {
  mountMascot(stage, { size: "md", state });
}

function buildGrid() {
  countEl.textContent = `${MASCOT_STATES.length} états`;
  const frag = document.createDocumentFragment();

  for (const s of MASCOT_STATES) {
    const card = document.createElement("div");
    card.className = "mg-card";

    const stage = document.createElement("div");
    stage.className = "mg-stage";

    const kind = document.createElement("span");
    kind.className = `mg-kind kind-${s.kind}`;
    kind.textContent = s.kind === "loop" ? "boucle" : "one-shot";
    stage.appendChild(kind);

    const meta = document.createElement("div");
    meta.className = "mg-meta";

    const text = document.createElement("div");
    text.className = "mg-meta-text";
    text.innerHTML =
      `<p class="mg-name">${s.label} <span class="mg-id">${s.id}</span></p>` +
      `<p class="mg-blurb">${s.blurb}</p>`;
    meta.appendChild(text);

    if (s.kind === "oneshot") {
      const btn = document.createElement("button");
      btn.className = "mg-replay";
      btn.type = "button";
      btn.innerHTML = `${REPLAY_SVG}<span>rejouer</span>`;
      btn.addEventListener("click", () => {
        mountCard(stage, s.id);
        requestAnimationFrame(applySpeed);
      });
      meta.appendChild(btn);
    }

    card.appendChild(stage);
    card.appendChild(meta);
    frag.appendChild(card);

    // 在fragment中的stage之后挂载；实际动画开始一次
    // 附加到文档中，因此我们在网格安装后应用速度。
    mountCard(stage, s.id);
  }

  grid.appendChild(frag);
  requestAnimationFrame(applySpeed);
}

function wireControls() {
  // 尺寸
  const sizeBar = document.getElementById("mgSize");
  sizeBar.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-size]");
    if (!b) return;
    sizeBar.querySelectorAll("button").forEach((x) => x.classList.remove("is-active"));
    b.classList.add("is-active");
    grid.style.setProperty("--mg-size", `${b.dataset.size}px`);
  });
  grid.style.setProperty("--mg-size", "160px");

  // 速度
  const speedEl = document.getElementById("mgSpeed");
  const speedVal = document.getElementById("mgSpeedVal");
  speedEl.addEventListener("input", () => {
    speed = parseFloat(speedEl.value);
    speedVal.textContent = `${speed.toFixed(2).replace(/0$/, "")}×`;
    applySpeed();
  });

  // 明/暗阶段
  const lightBtn = document.getElementById("mgLight");
  const lightLabel = document.getElementById("mgLightLabel");
  lightBtn.addEventListener("click", () => {
    const isLight = grid.classList.toggle("is-light");
    lightLabel.textContent = isLight ? "Fond sombre" : "Fond clair";
  });

  // 重放所有内容（重新安装所有卡→重新启动每个动画）
  document.getElementById("mgReplayAll").addEventListener("click", () => {
    grid.querySelectorAll(".mg-stage").forEach((stage, i) => {
      mountCard(stage, MASCOT_STATES[i].id);
    });
    requestAnimationFrame(applySpeed);
  });
}

(async function init() {
  if (!(await ensureTemplate())) return;
  buildGrid();
  wireControls();
})();
