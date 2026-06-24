// 吉祥物动画状态的单一事实来源。
//
// `mascot.js` 读取此内容以验证状态；画廊
// (`web/mascot_gallery.html`) 读取相同的列表来渲染一张预览卡
// 每个动画。在此处添加状态+其关键帧在`web/styles/mascot.css`中
// 它会自动出现在任何地方——没有重复。
//
// id : `is-<id>` CSS 类中使用的后缀（和 setMascotState arg）
// label : 画廊卡上显示的人名
// kind : "loop" — 永远运行（空闲、thinking、扫描…）
// “oneshot”——播放一次然后休息（成功、错误、庆祝……）；
// 画廊有一个重播按钮
// 简介：一行描述动画的作用

export const MASCOT_STATES = [
  { id: "idle",        label: "Repos",        kind: "loop",    blurb: "Respiration + clignements" },
  { id: "thinking",    label: "Réflexion",    kind: "loop",    blurb: "Corps orange + points « ... »" },
  { id: "typing",      label: "Frappe",       kind: "loop",    blurb: "Tape sur un clavier à deux mains" },
  { id: "working",     label: "Travail",      kind: "loop",    blurb: "La clé tourne comme un ratchet" },
  { id: "scanning",    label: "Scan",         kind: "loop",    blurb: "Loupe qui balaye, tête penchée" },
  { id: "sleeping",    label: "Sommeil",      kind: "loop",    blurb: "Yeux fermés, Zzz qui flottent" },
  { id: "success",     label: "Succès",       kind: "oneshot", blurb: "Clé brandie + grand sourire" },
  { id: "celebrating", label: "Célébration",  kind: "oneshot", blurb: "Saut, confettis, joie++" },
  { id: "error",       label: "Erreur",       kind: "oneshot", blurb: "Flash rouge + clé qui retombe" },
  { id: "danger",      label: "Alerte",       kind: "oneshot", blurb: "Corps écarlate, shake, yeux en croix" },
];

// 源自上面列表的便捷查找。
export const MASCOT_STATE_IDS = MASCOT_STATES.map((s) => s.id);
export const MASCOT_LOOP_IDS = MASCOT_STATES.filter((s) => s.kind === "loop").map((s) => s.id);
export const MASCOT_ONESHOT_IDS = MASCOT_STATES.filter((s) => s.kind === "oneshot").map((s) => s.id);
