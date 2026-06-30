//  知识图画布：数据加载器、空状态切换和 D3
//  force simulation 渲染节点/链接/过滤器/tweaks/inspector
//  在#canvas 里面。依赖于 d3 作为全局可用（通过加载
//  index.html 中的 CDN <script>）。

import { escapeHtml as escHtml } from "./shared/dom.js";
import { getPackGraph } from "./services/packs.js";
import { getDeviceSlug } from "./shared/context.js";

/*  ===========================================================
   图数据 — 在运行时从 GET /pipeline/packs/{slug}/graph 加载。
   开始为空，直到 loadGraphFromBackend() 解析；用户界面显示
   空状态卡邀请用户在没有包时运行管道
   当前slug存在。形状符合 Pydantic v2 合约：
   节点（组件 | 症状 | 网络 | 动作）+ 类型化边（原因 | 动作）
   权力|连接到 |解决）。
   ===========================================================  */
let DATA = { nodes: [], edges: [] };

export async function loadGraphFromBackend() {
  const slug = getDeviceSlug();
  if (!slug) return null;
  try {
    return await getPackGraph(slug);
  } catch (err) {
    //  ApiError 携带 .status 表示非 ok 响应；保存
    //  状态感知警告，否则会进入通用错误日志。
    if (err && typeof err.status === "number") {
      console.warn(`loadGraphFromBackend: ${err.status} for slug=${slug}`);
    } else {
      console.error("loadGraphFromBackend: fetch failed", err);
    }
    return null;
  }
}

export function setEmptyState(visible) {
  const el = document.getElementById("emptyState");
  if (!el) return;
  el.classList.toggle("hidden", !visible);
}

setEmptyState(true);  //  同步出卡； fetch 可能会取代它

const TYPE_COLORS = { component:"oklch(0.82 0.14 210)", symptom:"oklch(0.82 0.16 75)", net:"oklch(0.78 0.15 155)", action:"oklch(0.78 0.14 295)" };
const TYPE_FILL   = { component:"oklch(0.82 0.14 210 / 0.22)", symptom:"oklch(0.82 0.16 75 / 0.22)", net:"oklch(0.78 0.15 155 / 0.22)", action:"oklch(0.78 0.14 295 / 0.22)" };
const TYPE_GLOW   = { component:"glow-cyan", symptom:"glow-amber", net:"glow-emerald", action:"glow-violet" };
//  本地化标签 - 通过 window.t() 解析，以便它们在区域设置更改时进行交换。
function typeLabel(kind) {
  const t = window.t || ((k) => k);
  return t(`graph.type_label.${kind}`);
}
function relLabel(rel) {
  const t = window.t || ((k) => k);
  return t(`graph.rel_label.${rel}`);
}
//  严格的L→Rdiagnostic叙事阅读问题-优先：
//  症状→网络→成分→行动。下面的forceX布局使用了这个
//  为了保持节点向其列移动而不是自由移动。
const COL_ORDER = ["symptom","net","component","action"];

export function initGraphWithData(data) {
  DATA = data;

  const svg = d3.select("#graph");
const gRoot = d3.select("#graphRoot");
const canvasEl = document.getElementById("canvas");
const W = () => canvasEl.clientWidth;
const H = () => canvasEl.clientHeight;

//  在图例面板中填充每种类型的计数（紧凑单声道 chips — 否
//  “nœuds”后缀；图例副本已经清楚地表达了含义）。
["sym","cmp","net","act"].forEach((k)=>{
  const map={sym:"symptom",cmp:"component",net:"net",act:"action"};
  const el = document.getElementById("cnt-"+k);
  if (el) el.textContent = DATA.nodes.filter(n=>n.type===map[k]).length;
});
//  #counts / #avgConf 曾经居住在现已移除的 statusbar — 守卫所以
//  图形加载器不会抛出没有这些元素的页面。
document.getElementById("counts")?.replaceChildren(document.createTextNode(
  (window.t || ((k) => k))("graph.stats.summary", { n: DATA.nodes.length, e: DATA.edges.length })
));
const avgConfEl = document.getElementById("avgConf");
if (avgConfEl && DATA.nodes.length > 0) {
  avgConfEl.textContent = (DATA.nodes.reduce((a,n)=>a+n.confidence,0)/DATA.nodes.length).toFixed(2);
}

function nodeSize(n){ return 18 + n.confidence*8; }

//  度+邻居
const neighbors={};
DATA.edges.forEach(e=>{
  (neighbors[e.source] ||= new Set()).add(e.target);
  (neighbors[e.target] ||= new Set()).add(e.source);
});

/*  ---------- 气泡图布局 ----------
   每个子系统都是一个由force simulation排列的圆形“气泡”。
   节点通过 d3.pack() 打包在气泡内，并按置信度调整大小。
   没有列，没有行——只有区域。默认情况下，边缘是隐藏的（参见 CSS）
   并仅通过现有的 .active-link 类在悬停/焦点时显示。  */

//  当后端未发送子系统（较旧的有效负载/空图）时的回退。
const _gT = window.t || ((k) => k);
const SUBSYSTEMS = (Array.isArray(DATA.subsystems) && DATA.subsystems.length > 0)
  ? DATA.subsystems
  : [{ key: "unknown", label: _gT("graph.subsystem.fallback_label"), count: DATA.nodes.length }];

//  填充每个节点在其气泡内占用的空间（d3.pack 填充）。
const PACK_PADDING = 4;
//  扁平包装重量——每个节点在其气泡内都拥有相同的插槽。
//  置信度是通过渲染时的笔画/不透明度（而不是大小）进行编码的。
function nodeWeight() { return 1; }
//  渲染节点上的硬半径限制 — 阻止 1 节点子系统
//  膨胀成 60 像素的圆盘，因为 pack 填满了整个气泡。
const NODE_R_MIN = 8;
const NODE_R_MAX = 18;

//  计算每个子系统气泡所需的半径。正比于
//  其节点数的平方根 - 非线性地填充画布，因此 1
//  庞大的子系统并不会让其他子系统相形见绌。
const bubbles = SUBSYSTEMS.map(s => {
  const nodes = DATA.nodes.filter(n => n.subsystem === s.key);
  if (nodes.length === 0) return null;
  //  k 调整气泡相对于画布的“比例”——如果画布感觉太稀疏/拥挤，则进行调整。
  const k = 12;
  const radius = Math.max(36, Math.sqrt(nodes.length) * k);
  return { key: s.key, label: s.label, nodes, radius };
}).filter(Boolean);

//  通过 d3.hierarchy + d3.pack 将节点打包到每个气泡内，两个级别
//  deep 因此节点在每个子系统内按类型聚集（症状 /net/
//  组件/动作各自形成自己的子簇而不是混合）。
//  中间的“类型组”对象带有一个“children”键； d3.pack
//  将它们视为容器，其大小等于其子级的总和。
for (const b of bubbles) {
  const byType = new Map(COL_ORDER.map(t => [t, []]));
  for (const n of b.nodes) {
    if (byType.has(n.type)) byType.get(n.type).push(n);
  }
  const children = [...byType.entries()]
    .filter(([, arr]) => arr.length > 0)
    .map(([type, arr]) => ({ __type: type, children: arr }));
  //  sum() 回调：内部节点（有子节点）贡献 0，离开
  //  （实际图节点，没有子节点）贡献它们的权重。 d3 添加
  //  孩子们的价值观得到每组的总数。
  const root = d3.hierarchy({ children })
    .sum(d => (d.children ? 0 : nodeWeight(d)));
  const pack = d3.pack().size([b.radius * 2, b.radius * 2]).padding(PACK_PADDING);
  pack(root);
  b.leaves = root.leaves().map(leaf => ({
    node: leaf.data,
    relX: leaf.x - b.radius,
    relY: leaf.y - b.radius,
    r:    leaf.r,
  }));
}

//  通过微小的 force simulation 在画布上排列气泡 —forceCenter
//  保持簇居中，forceCollide 防止重叠。
const W_fn = W, H_fn = H;   //  别名以保持 sim 声明的紧密性
const bubbleSim = d3.forceSimulation(bubbles)
  .force("center", d3.forceCenter(W_fn() / 2, H_fn() / 2))
  .force("collide", d3.forceCollide(d => d.radius + 12).iterations(4))
  .force("x", d3.forceX(W_fn() / 2).strength(0.04))
  .force("y", d3.forceY(H_fn() / 2).strength(0.04))
  .stop();
//  种子气泡位于圆上，因此 sim 稳定收敛。
{
  const n = bubbles.length;
  const cx = W_fn() / 2, cy = H_fn() / 2;
  const seedR = Math.min(W_fn(), H_fn()) * 0.28;
  bubbles.forEach((b, i) => {
    const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
    b.x = cx + Math.cos(a) * seedR;
    b.y = cy + Math.sin(a) * seedR;
  });
}
for (let i = 0; i < 200; i++) bubbleSim.tick();

//  通过预先计算的包偏移量将最终位置应用于每个节点。
for (const b of bubbles) {
  for (const leaf of b.leaves) {
    const n = leaf.node;
    n._tx = b.x + leaf.relX;
    n._ty = b.y + leaf.relY;
    n._r  = leaf.r;  //  实际包计算半径
  }
}
//  同步 D3 节点力 sim。
DATA.nodes.forEach(n => { n.x = n._tx; n.y = n._ty; });

/*  ---------- 气泡背景 ----------  */
const bandLayer = d3.select("#layerBands");
bandLayer.selectAll("*").remove();
for (const b of bubbles) {
  bandLayer.append("circle")
    .attr("class", "bubble-bg")
    .attr("cx", b.x).attr("cy", b.y).attr("r", b.radius);
  bandLayer.append("text")
    .attr("class", "band-label")
    .attr("x", b.x).attr("y", b.y - b.radius - 10)
    .attr("text-anchor", "middle")
    .text(b.label);
}

/*  ---------- FORCE SIM — 温和，主要是位置性 ----------  */
const sim = d3.forceSimulation(DATA.nodes)
  .force("link", d3.forceLink(DATA.edges).id(d => d.id).distance(120).strength(0.01))
  .force("x", d3.forceX(d => d._tx).strength(0.9))
  .force("y", d3.forceY(d => d._ty).strength(0.9))
  .alphaDecay(0.1)
  .velocityDecay(0.6);

/*  ---------- 链接 ----------  */
const linkSel = d3.select("#layerLinks").selectAll("path")
  .data(DATA.edges)
  .join("path")
  .attr("class", d => `link ${d.relation}`)
  .attr("stroke-width", d => 0.8 + (d.weight || 0.5) * 1.8)
  .attr("marker-end", d => {
    if (d.relation==="causes")       return "url(#arrow-causes)";
    if (d.relation==="powers")       return "url(#arrow-powers)";
    if (d.relation==="connected_to") return "url(#arrow-connected)";
    if (d.relation==="resolves")     return "url(#arrow-resolves)";
    return "url(#arrow-connected)";
  });

const linkLabelSel = d3.select("#layerLinkLabels").selectAll("text")
  .data(DATA.edges)
  .join("text")
  .attr("class","link-label")
  .text(d => d.label);

/*  ---------- 节点 ----------  */
const nodeSel = d3.select("#layerNodes").selectAll("g.node")
  .data(DATA.nodes, d=>d.id)
  .join("g")
  .attr("class", d => `node type-${d.type}`)
  .call(d3.drag()
    .on("start",(e,d)=>{ if(!e.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
    .on("drag", (e,d)=>{ d.fx=e.x; d.fy=e.y; })
    .on("end",  (e,d)=>{ if(!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; }));

nodeSel.each(function(d){
  const g = d3.select(this);
  //  限制渲染半径以防止稀疏气泡节点膨胀。
  const rawR = d._r || nodeSize(d);
  const r = Math.min(NODE_R_MAX, Math.max(NODE_R_MIN, rawR));
  const opacity = 0.6 + d.confidence * 0.4;

  g.append("circle").attr("class","conf-ring").attr("r", r+2).attr("fill","none")
    .attr("stroke", TYPE_COLORS[d.type]).attr("stroke-opacity", d.confidence*0.3)
    .attr("stroke-width", 1 + d.confidence*1.2).attr("filter", `url(#${TYPE_GLOW[d.type]})`);

  //  每个节点一个圆圈——完全由填充+描边编码的类型。
  g.append("circle").attr("class","node-shape").attr("r", r)
    .attr("fill", TYPE_FILL[d.type]).attr("stroke", TYPE_COLORS[d.type])
    .attr("stroke-opacity", opacity).attr("stroke-width", 1.3);

  //  默认情况下，气泡视图中的标签处于关闭状态； CSS 使它们淡入
  //  通过 .node-label 规则悬停/聚焦（参见 graph.css 气泡块）。
  //  位于节点上方 - 光标工具提示位于节点的下方+右侧
  //  光标，因此将标签放在另一侧可以使其可见。
  const shortLabel = d.label.length > 22 ? d.label.slice(0, 20) + "…" : d.label;
  g.append("text").attr("class","node-label").attr("dy", -(r + 6)).text(shortLabel);

  if (d.type === "action" && d.meta && d.meta.count > 1) {
    g.append("text")
      .attr("class", "collapse-badge")
      .attr("x", r + 3).attr("y", -r + 1)
      .text("×" + d.meta.count);
  }
});

/*  ---------- 路径：贝塞尔曲线 ----------  */
function linkPath(d){
  const sx = d.source.x, sy = d.source.y, tx = d.target.x, ty = d.target.y;
  //  每个关系的曲线贝塞尔曲线。包分散意味着正交路由
  //  没有实际意义——一条温和的曲线可以清除源/目标磁盘就足够了。
  const dx = tx - sx, dy = ty - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const curve = Math.min(80, dist * 0.35);
  //  控制点的垂直偏移。
  const nx = -dy / (dist || 1), ny = dx / (dist || 1);
  const cx = (sx + tx) / 2 + nx * curve;
  const cy = (sy + ty) / 2 + ny * curve;
  return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
}

sim.on("tick", () => {
  linkSel.attr("d", linkPath);
  nodeSel.attr("transform", d => `translate(${d.x},${d.y})`);
  linkLabelSel
    .attr("x", d => (d.source.x + d.target.x)/2)
    .attr("y", d => (d.source.y + d.target.y)/2 - 6);
});

/*  ---------- 缩放 ----------  */
const zoom = d3.zoom().scaleExtent([0.3,3])
  .on("zoom", (e) => {
    gRoot.attr("transform", e.transform);
    const zp = document.getElementById("zoomPct");
    if (zp) zp.textContent = Math.round(e.transform.k*100)+"%";
    const zr = document.getElementById("zoomReadout");
    if (zr) zr.textContent = `zoom ${e.transform.k.toFixed(2)}×`;
  });
svg.call(zoom).on("dblclick.zoom", null);
document.getElementById("zoomIn").onclick  = () => svg.transition().duration(200).call(zoom.scaleBy, 1.3);
document.getElementById("zoomOut").onclick = () => svg.transition().duration(200).call(zoom.scaleBy, 1/1.3);
document.getElementById("zoomFit").onclick = fitToScreen;

function fitToScreen(){
  if (DATA.nodes.length === 0) return;  //  当图表为空时没有任何内容可以容纳
  const xs=DATA.nodes.map(n=>n.x), ys=DATA.nodes.map(n=>n.y);
  const minX=Math.min(...xs), maxX=Math.max(...xs);
  const minY=Math.min(...ys), maxY=Math.max(...ys);
  const pad=80, w=(maxX-minX)+pad*2, h=(maxY-minY)+pad*2;
  const k = Math.min(W()/w, H()/h, 1.3);
  const tx = W()/2 - k*(minX + (maxX-minX)/2);
  const ty = H()/2 - k*(minY + (maxY-minY)/2);
  svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity.translate(tx,ty).scale(k));
}

/*  ---------- 悬停/选择 ----------  */
const tooltip = document.getElementById("tooltip");
let selected = null;

nodeSel
  .on("mouseenter", (e,d) => {
    gRoot.classed("has-focus", true);
    const nb = neighbors[d.id] || new Set();
    nodeSel.classed("focus", n => n.id === d.id).classed("neighbor", n => nb.has(n.id));
    linkSel.classed("active-link", e => e.source.id === d.id || e.target.id === d.id);
    linkLabelSel.classed("active-label", e => e.source.id === d.id || e.target.id === d.id);

    tooltip.classList.add("show");
    document.getElementById("ttType").textContent = typeLabel(d.type);
    document.getElementById("ttLabel").textContent = d.label;
    document.getElementById("ttDesc").textContent  = (d.description||"").length>130 ? d.description.slice(0,130)+"…" : d.description;
    document.getElementById("ttId").textContent    = d.id;
    document.getElementById("ttConf").textContent  = (window.t || ((k) => k))("graph.tooltip.conf_pct", { pct: (d.confidence*100).toFixed(0) });
  })
  .on("mousemove", (e) => {
    tooltip.style.left = (e.clientX+14)+"px";
    tooltip.style.top  = (e.clientY+14)+"px";
  })
  .on("mouseleave", () => {
    gRoot.classed("has-focus", selected!==null);
    if (selected){ const nb = neighbors[selected.id] || new Set();
      nodeSel.classed("focus", n => n.id === selected.id).classed("neighbor", n => nb.has(n.id));
      linkSel.classed("active-link", e => e.source.id === selected.id || e.target.id === selected.id);
      linkLabelSel.classed("active-label", e => e.source.id === selected.id || e.target.id === selected.id);
    } else {
      nodeSel.classed("focus", false).classed("neighbor", false);
      linkSel.classed("active-link", false);
      linkLabelSel.classed("active-label", false);
    }
    tooltip.classList.remove("show");
  })
  .on("click", (e,d) => { e.stopPropagation(); selectNode(d); });

canvasEl.addEventListener("click", e => {
  if (e.target===canvasEl || e.target.tagName==="svg" || e.target.classList.contains("grid-bg")) closeInspector();
});

/*  ---------- 检查员 ----------  */
const inspector = document.getElementById("inspector");

function selectNode(d){
  selected = d;
  nodeSel.classed("selected", n => n.id === d.id);
  gRoot.classed("has-focus", true);
  const nb = neighbors[d.id] || new Set();
  nodeSel.classed("focus", n => n.id === d.id).classed("neighbor", n => nb.has(n.id));
  linkSel.classed("active-link", e => e.source.id === d.id || e.target.id === d.id);
  linkLabelSel.classed("active-label", e => e.source.id === d.id || e.target.id === d.id);

  const t = window.t || ((k) => k);
  const badge = document.getElementById("inspBadge");
  badge.className = "type-badge " + d.type;
  document.getElementById("inspBadgeText").textContent = typeLabel(d.type);
  document.getElementById("inspTitle").textContent = d.label;
  document.getElementById("inspId").textContent = t("graph.inspector.id_label", { id: d.id });
  const pct = Math.round(d.confidence*100);
  document.getElementById("confFill").style.width = pct + "%";
  document.getElementById("confValue").textContent = d.confidence.toFixed(2);
  let note = t("graph.inspector.conf_high");
  if (d.confidence<0.6) note = t("graph.inspector.conf_low");
  else if (d.confidence<0.8) note = t("graph.inspector.conf_medium");
  document.getElementById("confNote").textContent = note;
  document.getElementById("inspDesc").textContent = d.description || "…";

  const mg = document.getElementById("metaGrid"); mg.innerHTML="";
  const entries = Object.entries(d.meta || {});
  document.getElementById("metaSection").style.display = entries.length ? "" : "none";
  entries.forEach(([k,v]) => {
    const dt=document.createElement("dt"); dt.textContent=k;
    const dd=document.createElement("dd"); dd.textContent=v;
    mg.appendChild(dt); mg.appendChild(dd);
  });

  //  当此节点是折叠操作时，显示合并规则的列表。
  if (d.type === "action" && d.meta && Array.isArray(d.meta.rule_ids)) {
    const dt = document.createElement("dt"); dt.textContent = t("graph.inspector.rules_field");
    const dd = document.createElement("dd");
    dd.textContent = d.meta.rule_ids.join(", ");
    mg.appendChild(dt); mg.appendChild(dd);
    document.getElementById("metaSection").style.display = "";
  }

  const related = DATA.edges.filter(e => e.source.id===d.id || e.target.id===d.id);
  document.getElementById("edgeCount").textContent = `· ${related.length}`;
  const el = document.getElementById("edgeList"); el.innerHTML="";
  related.forEach(e => {
    const outgoing = e.source.id===d.id;
    const other = outgoing ? e.target : e.source;
    const row = document.createElement("div"); row.className="edge-item";
    const arrow = outgoing ? t("graph.inspector.edge_outgoing") : t("graph.inspector.edge_incoming");
    const sub = t("graph.inspector.edge_weight", { label: escHtml(e.label), weight: (e.weight||1).toFixed(2) });
    row.innerHTML = `
      <span class="rel ${escHtml(e.relation)}">${escHtml(relLabel(e.relation) || e.relation)}</span>
      <span class="arrow">${arrow}</span>
      <div class="edge-target">
        <div>${escHtml(other.label)}</div>
        <div class="edge-sub">${sub}</div>
      </div>`;
    row.onclick = () => selectNode(other);
    el.appendChild(row);
  });
  inspector.classList.add("open");
}
function closeInspector(){
  selected=null;
  nodeSel.classed("selected",false).classed("focus",false).classed("neighbor",false);
  gRoot.classed("has-focus",false);
  linkSel.classed("active-link",false);
  linkLabelSel.classed("active-label",false);
  inspector.classList.remove("open");
}
document.getElementById("inspectorClose").onclick = closeInspector;

/*  ---------- “权力”边缘上的粒子 ----------  */
let particleSpeed = 1;
const powersEdges = DATA.edges.filter(e => e.relation==="powers");
const particles = [];
const pLayer = d3.select("#layerParticles");
powersEdges.forEach((e,i) => {
  for (let k=0;k<2;k++) particles.push({ edge:e, t:(i*0.2 + k*0.5)%1, speed:0.004 + Math.random()*0.002 });
});
const particleSel = pLayer.selectAll("circle").data(particles).join("circle")
  .attr("class","particle").attr("r",2.2).attr("fill","var(--emerald)")
  .attr("filter","drop-shadow(0 0 3px var(--emerald))");

function pointAlong(edge, t){
  //  通过源/目标之间的线性插值对 S 曲线进行采样，对于 vis 来说足够接近
  return { x: edge.source.x + (edge.target.x - edge.source.x)*t,
           y: edge.source.y + (edge.target.y - edge.source.y)*t };
}
function animateParticles(){
  particles.forEach(p => { p.t += p.speed*particleSpeed; if (p.t>1) p.t=0; });
  particleSel.attr("cx", p => pointAlong(p.edge, p.t).x)
             .attr("cy", p => pointAlong(p.edge, p.t).y)
             .attr("opacity", p => selected ? ((p.edge.source.id===selected.id||p.edge.target.id===selected.id)?0.95:0.08) : 0.75);
  requestAnimationFrame(animateParticles);
}
requestAnimationFrame(animateParticles);

/*  ---------- 过滤器 (chips) ----------  */
const activeKinds = new Set(["symptom","component","net","action"]);
const activeRels = new Set(["causes","powers","connected_to","resolves"]);
let minConf = 0;

function applyFilters(){
  nodeSel.style("display", n => activeKinds.has(n.type) && n.confidence>=minConf ? null : "none");
  const edgeVisible = e =>
    activeKinds.has(e.source.type) && activeKinds.has(e.target.type) &&
    activeRels.has(e.relation) &&
    e.source.confidence>=minConf && e.target.confidence>=minConf;
  linkSel.style("display", e => edgeVisible(e) ? null : "none");
  linkLabelSel.style("display", e => edgeVisible(e) ? null : "none");
  particleSel.style("display", p => activeRels.has("powers") && edgeVisible(p.edge) ? null : "none");
}

document.querySelectorAll(".filter-chip").forEach(chip => {
  chip.onclick = () => {
    const k = chip.dataset.filter;
    if (activeKinds.has(k)) { activeKinds.delete(k); chip.classList.add("off"); }
    else { activeKinds.add(k); chip.classList.remove("off"); }
    applyFilters();
  };
});
document.querySelectorAll(".seg-rel").forEach(btn => {
  btn.onclick = () => {
    const r = btn.dataset.rel;
    if (activeRels.has(r)) { activeRels.delete(r); btn.classList.remove("on"); btn.style.opacity = "0.4"; }
    else { activeRels.add(r); btn.classList.add("on"); btn.style.opacity = "1"; }
    applyFilters();
    postEdit();
  };
});

/*  ---------- 搜索 ----------  */
const searchInput = document.getElementById("searchInput");
searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { nodeSel.style("opacity", null); return; }
  nodeSel.style("opacity", n => (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) ? 1 : 0.15);
});
document.addEventListener("keydown", e => {
  if ((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==="k"){ e.preventDefault(); searchInput.focus(); searchInput.select(); }
  if (e.key==="Escape") closeInspector();
});

/*  ---------- 调整 ----------  */
const TWEAK_DEFAULTS = {
  "labelMode": "hover",
  "minConfidence": 0,
  "particleSpeed": 1
};

let labelMode = TWEAK_DEFAULTS.labelMode;
const tweaksPanel = document.getElementById("tweaksPanel");
document.getElementById("tweaksToggle").onclick = () => tweaksPanel.classList.toggle("show");
document.getElementById("tweaksClose").onclick  = () => tweaksPanel.classList.remove("show");

document.getElementById("tConf").addEventListener("input", e => {
  minConf = parseFloat(e.target.value);
  document.getElementById("tConfVal").textContent = minConf.toFixed(2);
  applyFilters();
});
document.getElementById("tParticle").addEventListener("input", e => {
  particleSpeed = parseFloat(e.target.value);
  document.getElementById("tParticleVal").textContent = particleSpeed.toFixed(1) + "×";
});
document.querySelectorAll("#tLabels button").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("#tLabels button").forEach(x=>x.classList.remove("on"));
    b.classList.add("on");
    labelMode = b.dataset.val;
    if (labelMode==="all") linkLabelSel.style("opacity", 1);
    else if (labelMode==="none") linkLabelSel.style("opacity", 0);
    else linkLabelSel.style("opacity", null);
  };
});
//  默认：悬停模式
linkLabelSel.style("opacity", null);

/*  ---------- 调整大小 ----------  */
//  气泡位置是绝对的（通过 bubbleSim + pack 预先计算）。
//  在调整大小时，只需轻推 sim，以便节点重新锁定其 _tx/_ty 目标。
window.addEventListener("resize", () => {
  sim.alpha(0.3).restart();
});
