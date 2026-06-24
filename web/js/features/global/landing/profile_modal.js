// 配置文件配置 - 引导的首次运行 wizard 和始终可用的配置
// modal，共享一组表单部分。
//
// 第ree部分（用户反馈：第一个配置必须指导技术人员
// 通过 everything，包括他们无法像 agent 那样猜出的选项
// “teaching”动词osity）：
//   1. Identity — 姓名、头像、经验ence等级（每个等级都有解释），
//                   特产
//   2. Workshop — 12 个目录工具，分组
//   3. Posture — 动词osity（自动/简洁/normal/teaching，每个
//                   解释）+ UI 语言
//
// openProfileWizard()：分页，每步一节（后退/下一页/跳过，
// progress) — 由onboarding sequence 使用。
// openProfileModal()：一个可滚动的相同部分 modal — opened from
// cockpit 的头像丸用于快速编辑，永远不会离开。一个“满
// profile”链接仍然re让丰富的#profile页面感到痛苦。
//
// 通过 PUT /profile/identity|tools|preferences 和广播持续存在
// `wb:profile-updated` 所以头像药丸re-绘制。

import i18n, { t } from "../../../i18n.js";
import { apiGet, apiSend } from "../../../shared/api.js";
import { escapeHtml } from "../../../shared/dom.js";

// api/profile/catalog.py TOOLS_CATALOG（id + group）的镜像，保留在显示中
// 命令。标签来自 from i18n (onboarding.profile.tool_*)。
const TOOLS = [
  { id: "soldering_iron", group: "soldering" },
  { id: "hot_air", group: "rework" },
  { id: "bga_rework", group: "rework" },
  { id: "preheater", group: "rework" },
  { id: "microscope", group: "inspection" },
  { id: "thermal_camera", group: "inspection" },
  { id: "uv_lamp", group: "inspection" },
  { id: "multimeter", group: "measurement" },
  { id: "oscilloscope", group: "measurement" },
  { id: "bench_psu", group: "power" },
  { id: "reballing_kit", group: "supplies" },
  { id: "stencil_printer", group: "supplies" },
];
const GROUP_ORDER = ["soldering", "rework", "inspection", "measurement", "power", "supplies"];

// 自制 Lucide 风格线条图标（24×24，currentColor 笔画）——每个工具一个，
// 加上用于技术声明red 自定义工具的 generic wrench (_custom)。
const _svg = (inner) =>
  `<svg class="ob-tool-svg" viewBox="0 0 24 24" width="20" height="20" fill="none" ` +
  `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const TOOL_ICONS = {
  soldering_iron: _svg('<path d="M3 21l3.2-3.2"/><path d="M6.2 17.8 15 9"/><path d="M15 9l1.7-1.7a2.1 2.1 0 0 1 3 3L18 12z"/><circle cx="5.5" cy="20.5" r=".7"/>'),
  hot_air: _svg('<path d="M3 7h9a3 3 0 1 0-3-3"/><path d="M3 12h13a3 3 0 1 1-3 3"/><path d="M3 17h7a3 3 0 1 0-3 3"/>'),
  bga_rework: _svg('<rect x="6" y="6" width="12" height="12" rx="1"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>'),
  preheater: _svg('<rect x="3" y="14" width="18" height="5" rx="1"/><path d="M7 11c0-1.6-1.4-2-1.4-3.6S7 4 7 4M12 11c0-1.6-1.4-2-1.4-3.6S12 4 12 4M17 11c0-1.6-1.4-2-1.4-3.6S17 4 17 4"/>'),
  microscope: _svg('<path d="M6 18h8"/><path d="M3 22h18"/><path d="M14 22a7 7 0 1 0 0-14h-1"/><path d="M9 14h2"/><path d="M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z"/><path d="M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"/>'),
  thermal_camera: _svg('<rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3"/><circle cx="7" cy="14.5" r="1.4"/><path d="M7 13V9a1.4 1.4 0 1 1 0 0"/>'),
  uv_lamp: _svg('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M8 13a6 6 0 1 1 8 0c-.7.6-1 1.2-1 2H9c0-.8-.3-1.4-1-2Z"/>'),
  multimeter: _svg('<path d="M3 18a9 9 0 1 1 18 0"/><path d="M12 14a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z"/><path d="M13.3 11.2 18 7"/>'),
  oscilloscope: _svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M5 13h3l2-5 2.8 8 1.8-5 1.4 2H19"/>'),
  bench_psu: _svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 10v4M5 12h4"/><path d="M15 12h4"/>'),
  reballing_kit: _svg('<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="8.5" cy="8.5" r=".9"/><circle cx="12" cy="8.5" r=".9"/><circle cx="15.5" cy="8.5" r=".9"/><circle cx="8.5" cy="12" r=".9"/><circle cx="12" cy="12" r=".9"/><circle cx="15.5" cy="12" r=".9"/><circle cx="8.5" cy="15.5" r=".9"/><circle cx="12" cy="15.5" r=".9"/><circle cx="15.5" cy="15.5" r=".9"/>'),
  stencil_printer: _svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>'),
  _custom: _svg('<path d="M14.6 6.4a4 4 0 0 0-5.4 5.2L3 18l3 3 6.4-6.2a4 4 0 0 0 5.2-5.4l-2.6 2.6-2-2 2.6-2.6Z"/>'),
};
const VERBOSITY = ["auto", "concise", "normal", "teaching"];
const LEVELS = ["", "beginner", "intermediate", "confirmed", "expert"]; // "" = 自动派生

// ── 区段构建器（shared by wizard + modal） ────────────────────────────

// 四语言选择器（live-switching按钮），由欢迎时代shared
// 标记，identity 步骤 (wizard) 和 posture 步骤（快速 modal）。
function langPickerHTML() {
  const lang = i18n.locale;
  return `
        <div class="ob-lang-opts" role="group" aria-label="${escapeHtml(t("onboarding.menu.language"))}">
          <button type="button" class="landing-lang-opt${lang === "en" ? " is-active" : ""}" data-lang="en">${t("onboarding.menu.lang_en")}</button>
          <button type="button" class="landing-lang-opt${lang === "fr" ? " is-active" : ""}" data-lang="fr">${t("onboarding.menu.lang_fr")}</button>
          <button type="button" class="landing-lang-opt${lang === "zh" ? " is-active" : ""}" data-lang="zh">${t("onboarding.menu.lang_zh")}</button>
          <button type="button" class="landing-lang-opt${lang === "hi" ? " is-active" : ""}" data-lang="hi">${t("onboarding.menu.lang_hi")}</button>
        </div>`;
}

// showLanguage：wizard 将选择器首先放在 identity 步骤中（语言
// 是 chosen 之前re 任何hing 其他）；快速 modal 将其保持在 posture 步骤中。
function identityStepHTML(env, showLanguage = false) {
  const id = env?.profile?.identity || {};
  const level = id.level_override || "";
  const langField = showLanguage ? `
      <label class="ob-field">
        <span class="ob-field-label">${t("onboarding.menu.language")}</span>
        ${langPickerHTML()}
      </label>` : "";
  const levelRow = (v) => {
    const labelKey = v === "" ? "onboarding.profile.level_auto" : `onboarding.profile.level_${v}`;
    const descKey = v === "" ? "onboarding.level.desc_auto" : `profile.ribbon.blurbs.${v}`;
    return `
      <label class="ob-radio">
        <input type="radio" name="level" value="${v}" ${level === v ? "checked" : ""}/>
        <span class="ob-radio-main">${t(labelKey)}</span>
        <span class="ob-radio-desc">${t(descKey)}</span>
      </label>`;
  };
  return `
    <section class="ob-step" data-step="0">
      <h4 class="ob-step-title">${t("onboarding.wizard.step_identity")}</h4>
      <p class="ob-step-hint">${t("onboarding.wizard.identity_intro")}</p>
      ${langField}
      <div class="ob-field-row">
        <label class="ob-field" style="flex:1">
          <span class="ob-field-label">${t("onboarding.profile.field_name")}</span>
          <input class="ob-input" name="name" type="text" maxlength="40"
                 value="${escapeHtml(id.name || "")}"
                 placeholder="${escapeHtml(t("onboarding.profile.name_placeholder"))}" autocomplete="off"/>
        </label>
        <label class="ob-field ob-field-avatar">
          <span class="ob-field-label">${t("onboarding.profile.field_avatar")}</span>
          <input class="ob-input" name="avatar" type="text" maxlength="2"
                 value="${escapeHtml(id.avatar || "")}"
                 placeholder="${escapeHtml(t("onboarding.profile.avatar_placeholder"))}"/>
        </label>
      </div>
      <span class="ob-field-error" id="obNameError" hidden>${t("onboarding.profile.name_required")}</span>
      <fieldset class="ob-radios">
        <legend class="ob-field-label">${t("onboarding.profile.field_level")}</legend>
        ${LEVELS.map(levelRow).join("")}
      </fieldset>
      <label class="ob-field">
        <span class="ob-field-label">${t("onboarding.profile.field_specialties")}</span>
        <input class="ob-input" name="specialties" type="text"
               value="${escapeHtml((id.specialties || []).join(", "))}"
               placeholder="${escapeHtml(t("onboarding.profile.specialties_placeholder"))}"/>
      </label>
    </section>`;
}

function customChipHTML(name) {
  return `
    <span class="ob-custom-chip" data-name="${escapeHtml(name)}">
      ${TOOL_ICONS._custom}
      <span class="ob-custom-chip-name">${escapeHtml(name)}</span>
      <button type="button" class="ob-custom-rm" aria-label="${escapeHtml(t("onboarding.workshop.custom_remove"))}">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </span>`;
}

function workshopStepHTML(env) {
  const tools = env?.profile?.tools || {};
  const groups = GROUP_ORDER.map((g) => {
    const rows = TOOLS.filter((tl) => tl.group === g).map((tl) => `
      <label class="ob-tool">
        <input type="checkbox" name="tool_${tl.id}" ${tools[tl.id] ? "checked" : ""}/>
        <span class="ob-tool-ic">${TOOL_ICONS[tl.id] || ""}</span>
        <span class="ob-tool-name">${t(`onboarding.profile.tool_${tl.id}`)}</span>
        <span class="ob-tool-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
      </label>`).join("");
    return `
      <div class="ob-tool-group">
        <span class="ob-group-label">${t(`onboarding.workshop.group_${g}`)}</span>
        <div class="ob-tools-grid">${rows}</div>
      </div>`;
  }).join("");
  const customChips = (env?.profile?.custom_tools || []).map(customChipHTML).join("");
  const customSection = `
      <div class="ob-tool-group ob-custom-group">
        <span class="ob-group-label">${t("onboarding.workshop.group_custom")}</span>
        <div class="ob-custom-chips" id="obCustomChips">${customChips}</div>
        <div class="ob-custom-add">
          <input type="text" class="ob-custom-input" id="obCustomInput" maxlength="40" autocomplete="off"
                 placeholder="${escapeHtml(t("onboarding.workshop.custom_placeholder"))}"/>
          <button type="button" class="ob-btn ob-btn-ghost ob-custom-addbtn" id="obCustomAdd">${t("onboarding.workshop.custom_add")}</button>
        </div>
      </div>`;
  return `
    <section class="ob-step" data-step="1">
      <h4 class="ob-step-title">${t("onboarding.wizard.step_workshop")}</h4>
      <p class="ob-step-hint">${t("onboarding.wizard.workshop_intro")}</p>
      ${groups}
      ${customSection}
    </section>`;
}

// Wire自定义工具添加/re移动UI。每根 Idempotent； wizard 和
// 快速 modal 在注入其表单后调用它。
function wireCustomTools(root) {
  const chips = root.querySelector("#obCustomChips");
  const input = root.querySelector("#obCustomInput");
  const addBtn = root.querySelector("#obCustomAdd");
  if (!chips || !input || !addBtn) return;
  const add = () => {
    const name = input.value.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name) return;
    const dup = [...chips.querySelectorAll(".ob-custom-chip")]
      .some((c) => (c.dataset.name || "").toLowerCase() === name.toLowerCase());
    if (!dup) chips.insertAdjacentHTML("beforeend", customChipHTML(name));
    input.value = "";
    input.focus();
  };
  addBtn.addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  chips.addEventListener("click", (e) => {
    const rm = e.target.closest(".ob-custom-rm");
    if (rm) rm.closest(".ob-custom-chip")?.remove();
  });
}

// `showLanguage`: wizard hides 选择器 here（语言首先是 chosen，在
// identity 步骤）并且仅通过 hidden input 携带 chosen locale；这
// 独立配置modal显示一个实时选择器以供以后编辑。
function postureStepHTML(env, showLanguage = true) {
  const prefs = env?.profile?.preferences || {};
  const verbosity = prefs.verbosity || "auto";
  const lang = i18n.locale;
  const modeRow = (v) => `
    <label class="ob-radio">
      <input type="radio" name="verbosity" value="${v}" ${verbosity === v ? "checked" : ""}/>
      <span class="ob-radio-main">${t(`onboarding.posture.mode_${v}`)}</span>
      <span class="ob-radio-desc">${t(`onboarding.posture.desc_${v}`)}</span>
    </label>`;
  const langBlock = showLanguage ? `
      <div class="ob-field">
        <span class="ob-field-label">${t("onboarding.menu.language")}</span>
        <div class="ob-lang-opts">
          <button type="button" class="landing-lang-opt${lang === "en" ? " is-active" : ""}" data-lang="en">${t("onboarding.menu.lang_en")}</button>
          <button type="button" class="landing-lang-opt${lang === "fr" ? " is-active" : ""}" data-lang="fr">${t("onboarding.menu.lang_fr")}</button>
          <button type="button" class="landing-lang-opt${lang === "zh" ? " is-active" : ""}" data-lang="zh">${t("onboarding.menu.lang_zh")}</button>
          <button type="button" class="landing-lang-opt${lang === "hi" ? " is-active" : ""}" data-lang="hi">${t("onboarding.menu.lang_hi")}</button>
        </div>
      </div>` : "";
  return `
    <section class="ob-step" data-step="2">
      <h4 class="ob-step-title">${t("onboarding.wizard.step_posture")}</h4>
      <p class="ob-step-hint">${t("onboarding.wizard.posture_intro")}</p>
      <fieldset class="ob-radios">
        <legend class="ob-field-label">${t("onboarding.posture.verbosity_label")}</legend>
        ${VERBOSITY.map(modeRow).join("")}
      </fieldset>
      <input type="hidden" name="language" value="${escapeHtml(lang)}"/>
      ${langBlock}
    </section>`;
}

// lang placement —“identity”：wizard 首先显示选择器（语言为
// chosen之前re每个hing）； “posture”：快速modal将其保留在posture中。
function sectionsHTML(env, { lang = "posture" } = {}) {
  return identityStepHTML(env, lang === "identity") + workshopStepHTML(env) + postureStepHTML(env, lang === "posture");
}

// ── 阅读+坚持────────────────────────────────────────────────────────
export function readProfileForm(form, env) {
  const identity = {
    name: form.name.value.trim(),
    avatar: form.avatar.value.trim(),
    years_experience: env?.profile?.identity?.years_experience ?? 0,
    specialties: form.specialties.value.split(",").map((s) => s.trim()).filter(Boolean),
    level_override: form.level.value || null,
  };
  const tools = { ...(env?.profile?.tools || {}) };
  TOOLS.forEach((tl) => { tools[tl.id] = !!form[`tool_${tl.id}`]?.checked; });
  const customTools = [...form.querySelectorAll(".ob-custom-chip")]
    .map((c) => c.dataset.name).filter(Boolean);
  const prefs = {
    verbosity: form.verbosity.value || "auto",
    language: form.language.value || i18n.locale,
  };
  return { identity, tools, prefs, customTools };
}

export async function saveProfileForm(form, env) {
  const { identity, tools, prefs, customTools } = readProfileForm(form, env);
  const newEnv = await apiSend("/profile/identity", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(identity),
  });
  await apiSend("/profile/tools", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(tools),
  });
  await apiSend("/profile/custom-tools", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ custom_tools: customTools }),
  });
  await apiSend("/profile/preferences", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(prefs),
  });
  if (prefs.language && prefs.language !== i18n.locale) await i18n.setLocale(prefs.language);
  document.dispatchEvent(new CustomEvent("wb:profile-updated", { detail: { env: newEnv } }));
  return newEnv;
}

// ── 第一轮wizard（分页）──────────────────────────────────────────
// 强制：第一个连接门 - 跳过按钮re已移动，wizard
// 在名称为 entered 之前不能保留（identity 步骤会阻止前进）。
// 语言在 identity 步骤中首先存在（live-switching re-opens wizard
// 在新的 locale 中，pre服务于 in-progress 编辑）。
export function openProfileWizard(env, { onComplete, onSkip, mandatory = false } = {}) {
  if (document.getElementById("obProfileConfig")) return;
  const host = document.createElement("div");
  host.className = "ob-host";
  host.id = "obProfileConfig";
  host.innerHTML = `
    <div class="ob-backdrop">
      <div class="ob-panel ob-config" role="dialog" aria-modal="true" aria-labelledby="obWizTitle">
        <header class="ob-config-head ob-config-head--wizard">
          <span class="ob-wiz-title" id="obWizTitle">${t("onboarding.wizard.config_title")}</span>
          <span class="ob-progress" id="obWizProgress"></span>
        </header>
        <form class="ob-form ob-config-body" id="obProfileForm">${sectionsHTML(env, { lang: "identity" })}</form>
        <footer class="ob-config-foot">
          ${mandatory ? "" : `<button type="button" class="mascot-bubble-skip" id="obWizSkip">${t("onboarding.skip")}</button>`}
          <div class="ob-foot-right">
            <button type="button" class="ob-btn ob-btn-ghost" id="obWizBack">${t("onboarding.back")}</button>
            <button type="button" class="ob-btn ob-btn-primary" id="obWizNext">${t("onboarding.next")}</button>
          </div>
        </footer>
      </div>
    </div>`;
  document.body.appendChild(host);
  wireCustomTools(host);

  const form = host.querySelector("#obProfileForm");
  const steps = [...host.querySelectorAll(".ob-step")];
  const total = steps.length;
  const back = host.querySelector("#obWizBack");
  const next = host.querySelector("#obWizNext");
  const progress = host.querySelector("#obWizProgress");
  const nameInput = form.querySelector('input[name="name"]');
  const nameError = host.querySelector("#obNameError");
  const close = () => host.remove();
  let step = 0;

  // 实时语言切换（identity 步骤）。对in-progress表单进行快照，持久化
  // 新语言中的 locale、then re-open wizard rendered — 与
  // 快速的modal，所以技术人员永远不会oses他们输入的内容。
  host.querySelectorAll('.ob-step[data-step="0"] .ob-lang-opts .landing-lang-opt').forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.dataset.lang === i18n.locale) return;
      const snap = readProfileForm(form, env);
      const merged = {
        ...env,
        profile: {
          ...(env?.profile || {}),
          identity: snap.identity, tools: snap.tools, custom_tools: snap.customTools,
          preferences: { ...(env?.profile?.preferences || {}), ...snap.prefs, language: btn.dataset.lang },
        },
      };
      await i18n.setLocale(btn.dataset.lang);
      try {
        await apiSend("/profile/preferences", {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ verbosity: snap.prefs.verbosity || "auto", language: btn.dataset.lang }),
        });
      } catch (err) { console.warn("[profile_wizard] persist language failed", err); }
      host.remove();
      openProfileWizard(merged, { onComplete, onSkip, mandatory });
    });
  });

  const render = () => {
    steps.forEach((s, i) => { s.hidden = i !== step; });
    back.style.visibility = step === 0 ? "hidden" : "visible";
    next.textContent = step === total - 1 ? t("onboarding.done") : t("onboarding.next");
    progress.textContent = t("onboarding.wizard.progress", { n: step + 1, total });
    const focusable = steps[step].querySelector("input, select");
    setTimeout(() => focusable?.focus(), 40);
  };

  // 强制门：名称为 required beforere 离开 identity 步骤（并且
  // refore之前re结束hing）。显示内联错误而不是块。
  const nameMissing = () => mandatory && step === 0 && !nameInput.value.trim();
  const flagNameMissing = () => {
    if (nameError) nameError.hidden = false;
    nameInput.classList.add("is-invalid");
    nameInput.focus();
  };
  nameInput?.addEventListener("input", () => {
    if (nameError) nameError.hidden = true;
    nameInput.classList.remove("is-invalid");
  });

  back.addEventListener("click", () => { if (step > 0) { step--; render(); } });
  next.addEventListener("click", async () => {
    if (nameMissing()) { flagNameMissing(); return; }
    if (step < total - 1) { step++; render(); return; }
    next.disabled = true;
    try {
      await saveProfileForm(form, env);
    } catch (err) {
      console.error("[profile_wizard] save failed", err);
      alert(t("onboarding.profile.save_failed", { error: err.message || err }));
      next.disabled = false;
      return;
    }
    close();
    onComplete?.();
  });
  host.querySelector("#obWizSkip")?.addEventListener("click", () => { close(); onSkip?.(); });
  render();
}

// ── 快速设定modal（单卷）────────────────────────────────────
function _renderModal(env) {
  const host = document.createElement("div");
  host.className = "ob-host";
  host.id = "obProfileConfig";
  host.innerHTML = `
    <div class="ob-backdrop">
      <div class="ob-panel ob-config" role="dialog" aria-modal="true" aria-labelledby="obCfgTitle">
        <button type="button" class="ob-modal-close" id="obCfgClose" aria-label="${escapeHtml(t("onboarding.modal.cancel"))}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
        <header class="ob-config-head">
          <h3 class="ob-panel-title" id="obCfgTitle">${t("onboarding.modal.title")}</h3>
          <p class="ob-panel-intro--plain">${t("onboarding.modal.subtitle")}</p>
        </header>
        <form class="ob-form ob-config-body ob-config-body--all" id="obProfileForm">${sectionsHTML(env, { lang: "posture" })}</form>
        <footer class="ob-config-foot">
          <a class="ob-modal-fulllink" href="#profile" id="obCfgFull">${t("onboarding.modal.full_profile")}</a>
          <div class="ob-foot-right">
            <button type="button" class="ob-btn ob-btn-ghost" id="obCfgCancel">${t("onboarding.modal.cancel")}</button>
            <button type="button" class="ob-btn ob-btn-primary" id="obCfgSave">${t("onboarding.modal.save")}</button>
          </div>
        </footer>
      </div>
    </div>`;
  document.body.appendChild(host);
  wireCustomTools(host);

  // 单滚动：每个部分都可见（wizardhides非活动部分）。
  host.querySelectorAll(".ob-step").forEach((s) => { s.hidden = false; });

  const form = host.querySelector("#obProfileForm");
  const close = () => host.remove();

  // 实时语言切换：快照编辑 → 切换 locale → 持久 → re-render
  // 新 locale 中的 modal（保留用户的 in-progress changes）。
  host.querySelectorAll(".ob-lang-opts .landing-lang-opt").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.dataset.lang === i18n.locale) return;
      const { identity, tools, prefs } = readProfileForm(form, env);
      const merged = {
        ...env,
        profile: {
          ...(env?.profile || {}),
          identity, tools,
          preferences: { ...(env?.profile?.preferences || {}), ...prefs, language: btn.dataset.lang },
        },
      };
      await i18n.setLocale(btn.dataset.lang);
      try {
        await apiSend("/profile/preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ verbosity: prefs.verbosity || "auto", language: btn.dataset.lang }),
        });
      } catch (err) {
        console.warn("[profile_modal] persist language failed", err);
      }
      host.remove();
      _renderModal(merged);
    });
  });
  host.querySelector("#obCfgClose").addEventListener("click", close);
  host.querySelector("#obCfgCancel").addEventListener("click", close);
  host.querySelector("#obCfgFull").addEventListener("click", close); // href 导航至#profile
  host.querySelector(".ob-backdrop").addEventListener("click", (e) => {
    if (e.target.classList.contains("ob-backdrop")) close();
  });
  const saveBtn = host.querySelector("#obCfgSave");
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      await saveProfileForm(form, env);
    } catch (err) {
      console.error("[profile_modal] save failed", err);
      alert(t("onboarding.profile.save_failed", { error: err.message || err }));
      saveBtn.disabled = false;
      return;
    }
    close();
  });
  setTimeout(() => host.querySelector('input[name="name"]')?.focus(), 60);
}

export async function openProfileModal() {
  if (document.getElementById("obProfileConfig")) return;
  let env = null;
  try {
    env = await apiGet("/profile");
  } catch (err) {
    console.warn("[profile_modal] load profile failed", err);
  }
  _renderModal(env);
}
