import { renderBrainUiApp } from "./app-shell.js";
import { API } from "./api-client.js";
import { bootstrapACUI } from "./acui/bootstrap.js";
import { initChat, friendlyChannelLabel } from "./chat.js";
import { initPanelCollapse } from "./panel-collapse.js";
import { ThoughtStream } from "./thought-stream.js";
import { initVoicePanel } from "./voice-panel.js";
import { initHotspot, toggleHotspot, setHotspotMode, moveVoicePanelToBody, restoreVoicePanel } from "./hotspot.js";
import { initWorldcup, toggleWorldcup, setWorldcupMode } from "./worldcup.js";
import { enrichVisiblePersonCardFromText, initPersonCard, setPersonCardMode, showPersonCardByName } from "./person-card.js";
import { initAIVideoMode } from "./video-panel.js";
import { initDocPanel, setDocPanelMode } from "./doc.js";
import { initZoomTheme, applyTheme, applyUiZoom, stepUiZoom, readCSSVar, refreshThemeColors, getThemeColors } from "./zoom-theme.js";
import { initWechatPopup, showWechatPopup } from "./wechat-popup.js";
import { attachJarvisAudioGraph, attachJarvisFx, isFxEnabledForVoice, setFxEnabledForVoice, getJarvisFxParams, setJarvisFxParams, resetJarvisFxParams, isFxUnlocked, tryUnlockFx } from "./tts-fx.js";
import { initAudioOutputRouting, applyOutputSink, listOutputDevices, getOutputPreference, setOutputPreference } from "./audio-output.js";
import { initSettingsPanel } from "./settings-panel.js";
import { initTTSPipeline, setLastJarvisContent, playTTSReply, beginStreamingTTS, feedStreamingTTS, flushStreamingTTSBuf, finalizeStreamingTTS, endStreamingTTS, stopStreamingTTS, isTTSStreamingEnabled, setTTSStreamingEnabled, ttsCanStream, activeTTSVoiceId, cleanStreamText, toPlainSpeech } from "./tts-pipeline.js";
renderBrainUiApp(document.body);
const PHYSICS_STORAGE_KEY = "jarvis-brain-ui-physics";
const ACTIVATION_WARMUP_KEY = "xiaobailong_activation_warmup_until";
const MAX_CHAT_HISTORY = 60;
const DEFAULT_AGENT_NAME = "MyAI";
const MEMORY_GRAPH_STORAGE_KEY = "xiaobailong-memory-graph-enabled";
const MEMORY_GRAPH_ENABLED = localStorage.getItem(MEMORY_GRAPH_STORAGE_KEY) !== "false";

const themeSwitcher = document.getElementById("theme-switcher");
const resetViewBtn = document.getElementById("reset-view-btn");
const physicsControl = document.getElementById("physics-control");
const physicsToggle = document.getElementById("physics-toggle");
const gravitySlider = document.getElementById("gravity-slider");
const repulsionSlider = document.getElementById("repulsion-slider");
const nodeSizeSlider = document.getElementById("node-size-slider");
const gravityValue = document.getElementById("gravity-value");
const repulsionValue = document.getElementById("repulsion-value");
const nodeSizeValue = document.getElementById("node-size-value");
const brandNameEl = document.getElementById("agent-brand-name");
const graphEl = document.getElementById("graph");
const focusBlockEl = document.getElementById("focus-block");
const focusStackEl = document.getElementById("focus-stack");
const focusDepthEl = document.getElementById("focus-depth");

const IGNORED_VERSION_KEY = "xiaobailong_ignored_update_version";
const SUPPRESS_UPDATES_KEY = "xiaobailong_suppress_update_notifications";

let agentName = DEFAULT_AGENT_NAME;
let chat = null;
// 由 initSettings() 内部赋值，供 chat.js 的斜杠命令打开设置面板
let openSettingsRef = null;

function addMsg(...args) { return chat?.addMsg(...args); }
function openChat(...args) { return chat?.openChat(...args); }
function updateLastJarvisMsg(...args) { return chat?.updateLastJarvisMsg(...args); }
function isTyping() { return chat?.isTyping() || false; }

function defaultInputPlaceholder() {
  return `向 ${agentName} 发消息…`;
}

function setAgentName(nextName) {
  const normalized = String(nextName || "").trim() || DEFAULT_AGENT_NAME;
  agentName = normalized;
  document.title = `${normalized} · MyAI Assistant`;
  if (brandNameEl) brandNameEl.textContent = `${normalized} AI Agent`;
  if (graphEl) graphEl.setAttribute("aria-label", `${normalized} memory graph`);
  const input = document.getElementById("msg-input");
  if (input && !chat?.isComposerLocked?.() && document.activeElement === input) input.placeholder = defaultInputPlaceholder();
  document.querySelectorAll(".msg-jarvis .msg-label").forEach((el) => {
    el.textContent = normalized;
  });
}

async function loadAgentProfile() {
  try {
    const res = await fetch(`${API}/agent-profile`);
    if (!res.ok) return;
    const data = await res.json();
    setAgentName(data.name);
  } catch {}
}

const physicsSettings = {
  gravity: 1,
  repulsion: 1.35,
  nodeSize: 1,
};

requestAnimationFrame(() => {
  themeSwitcher?.classList.add("visible");
  resetViewBtn?.classList.add("visible");
  physicsControl?.classList.add("visible");
});

function readPhysicsSettings() {
  try {
    const raw = localStorage.getItem(PHYSICS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.gravity === "number") physicsSettings.gravity = parsed.gravity;
      if (typeof parsed.repulsion === "number") physicsSettings.repulsion = parsed.repulsion;
      if (typeof parsed.nodeSize === "number") physicsSettings.nodeSize = parsed.nodeSize;
    }
  } catch {}
}

function savePhysicsSettings() {
  try {
    localStorage.setItem(PHYSICS_STORAGE_KEY, JSON.stringify(physicsSettings));
  } catch {}
}

function updatePhysicsReadout() {
  if (!gravitySlider || !repulsionSlider || !nodeSizeSlider) return;
  gravitySlider.value = String(physicsSettings.gravity);
  repulsionSlider.value = String(physicsSettings.repulsion);
  nodeSizeSlider.value = String(physicsSettings.nodeSize);
  if (gravityValue) gravityValue.textContent = `${physicsSettings.gravity.toFixed(2)}x`;
  if (repulsionValue) repulsionValue.textContent = `${physicsSettings.repulsion.toFixed(2)}x`;
  if (nodeSizeValue) nodeSizeValue.textContent = `${physicsSettings.nodeSize.toFixed(2)}x`;
}

function onThemeChange() {
  renderLegend();
  if (MEMORY_GRAPH_ENABLED && nodeSel && !nodeSel.empty()) {
    refreshNodeVisuals();
    linkSel.attr("stroke", getThemeColors().linkStroke);
  }
}

if (physicsToggle) {
  physicsToggle.addEventListener("click", () => {
    const nextOpen = !physicsControl?.classList.contains("open");
    physicsControl?.classList.toggle("open", nextOpen);
    physicsToggle.setAttribute("aria-expanded", String(nextOpen));
  });
}

if (gravitySlider) gravitySlider.addEventListener("input", () => {
  physicsSettings.gravity = Number(gravitySlider.value);
  applyPhysicsSettings();
});

if (repulsionSlider) repulsionSlider.addEventListener("input", () => {
  physicsSettings.repulsion = Number(repulsionSlider.value);
  applyPhysicsSettings();
});

if (nodeSizeSlider) nodeSizeSlider.addEventListener("input", () => {
  physicsSettings.nodeSize = Number(nodeSizeSlider.value);
  applyPhysicsSettings();
});

let W = window.innerWidth;
let H = window.innerHeight;

const svg = d3.select("#graph").attr("width", W).attr("height", H);
const tip = d3.select("#tip");

const defs = svg.append("defs");
defs.html(`
  <filter id="neb-glow" x="-70%" y="-70%" width="240%" height="240%">
    <feGaussianBlur stdDeviation="3.2" result="blur"/>
    <feMerge>
      <feMergeNode in="blur"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  </filter>
`);

const world = svg.append("g");
const gLink = world.append("g").attr("stroke-linecap", "round");
const gNode = world.append("g");

const zoom = d3.zoom()
  .scaleExtent([0.1, 5])
  .filter(event => event.type === "wheel")
  .on("zoom", event => world.attr("transform", event.transform));

svg.call(zoom);
svg.on("wheel.zoom", null);
svg.on("dblclick.zoom", null);

svg.node().addEventListener("wheel", event => {
  event.preventDefault();
  const current = d3.zoomTransform(svg.node());
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
  const nextScale = Math.max(0.1, Math.min(5, current.k * factor));
  const k = nextScale / current.k;
  const px = W / 2, py = H / 2;
  const nextX = px - (px - current.x) * k;
  const nextY = py - (py - current.y) * k;
  svg.call(zoom.transform, d3.zoomIdentity.translate(nextX, nextY).scale(nextScale));
}, { passive: false });

function resetZoom() {
  svg.transition().duration(420).call(
    zoom.transform,
    d3.zoomIdentity
  );
}

const glowSet = new Map();
const usePulseSet = new Map();
let linkData = [];
let nodeData = [];
let linkSel = gLink.selectAll("line");
let nodeSel = gNode.selectAll("circle");

const nodeCountEl = document.getElementById("node-count");
const linkCountEl = document.getElementById("link-count");
const connStateEl = document.getElementById("conn-state");

function updateStats() {
  nodeCountEl.textContent = String(nodeData.length);
  linkCountEl.textContent = String(linkData.length);
}

function setConnectionState(text, live = true) {
  connStateEl.innerHTML = live
    ? `<span class="live-dot"></span>${text}`
    : text;
  connStateEl.classList.toggle("live", live);
}

function isGlowing(nid) {
  const expiry = glowSet.get(nid);
  if (!expiry) return false;
  if (Date.now() > expiry) { glowSet.delete(nid); return false; }
  return true;
}

function highlightNodes(nids, duration = 2400) {
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
  if (!nids || !nids.length) return;
  const now = Date.now();
  const expiry = now + duration;
  nids.forEach(nid => {
    const key = String(nid);
    glowSet.set(key, expiry);
    usePulseSet.set(key, { start: now, end: expiry });
  });
  refreshNodeVisuals();
  sim.alpha(Math.max(sim.alpha(), 2)).restart();
  setTimeout(() => {
    nids.forEach(nid => {
      const key = String(nid);
      glowSet.delete(key);
      usePulseSet.delete(key);
    });
    refreshNodeVisuals();
  }, duration + 80);
}

function nodeUseProgress(nid) {
  const key = String(nid);
  const pulse = usePulseSet.get(key);
  if (!pulse) return 0;
  const now = Date.now();
  if (now >= pulse.end) {
    usePulseSet.delete(key);
    return 0;
  }
  const total = Math.max(1, pulse.end - pulse.start);
  return 1 - ((now - pulse.start) / total);
}

function nodeStrength(d) {
  if (typeof d._strength !== "number") {
    const deg = Math.min(1, (d._deg || 0) / 12);
    d._strength = 0.35 + deg * 0.55;
  }
  return d._strength;
}

function nodeColor(d) {
  if (d._core) return getThemeColors().warm || "#d39872";
  const age = (Date.now() - (d._ts || Date.now())) / 18000;
  const fade = Math.max(0.25, 1 - age);
  const t = 0.18 + nodeStrength(d) * 0.5 * fade;
  const interp = d3.interpolateRgb(getThemeColors().nodeLow || "#3a556e", getThemeColors().nodeHigh || "#cfe3f5");
  let color = interp(Math.min(1, t));
  const base = d3.color(color);
  if (base) color = base.darker(0.55) + "";
  const useBoost = nodeUseProgress(d._nid);
  if (isGlowing(d._nid) || useBoost > 0) {
    const c = d3.color(color);
    if (c) return c.brighter(2 + useBoost * 2) + "";
  }
  return color;
}

function nodeRadius(d) {
  const base = d._core ? 9 : 3.4 + Math.min((d._deg || 0) * 0.9, 5.4);
  const childScale = 1 + Math.min(1.5, (d._childCount || 0) * 0.18);
  const useBoost = nodeUseProgress(d._nid);
  const glowScale = isGlowing(d._nid) ? 1.08 : 1;
  const pulseScale = 1 + (Math.sin((1 - useBoost) * Math.PI * 3) * 0.04 + useBoost * 0.12);
  const scaledBase = base * physicsSettings.nodeSize;
  return Math.min(scaledBase * 2.5, scaledBase * childScale * glowScale * Math.max(1, pulseScale));
}

const sim = MEMORY_GRAPH_ENABLED
  ? d3.forceSimulation()
    .force("link", d3.forceLink().id(d => d._nid))
    .force("charge", d3.forceManyBody())
    .force("center", d3.forceCenter(W / 2, H / 2 - 10))
    .force("x", d3.forceX(W / 2))
    .force("y", d3.forceY(H / 2 - 10))
    .force("radial", d3.forceRadial(180, W / 2, H / 2 - 10))
    .force("collision", d3.forceCollide())
    .alphaDecay(0.028)
    .alphaMin(0.02) // 肉眼已静止后别再空烧 GPU（默认 0.001 要多跑约 2 秒）
    .velocityDecay(0.3)
    .on("tick", tick)
    .on("end", writeGraphDom)
  : null;

function linkDistance(link) {
  const countFactor = Math.min(34, Math.sqrt(Math.max(1, nodeData.length)) * 4.2);
  if (link._kind === "visual_parent") return 82 + countFactor * 0.45;
  if (link._kind === "visual_random") return 108 + countFactor;
  return 76 + countFactor * 0.55;
}

function linkStrength(link) {
  if (link._kind === "visual_parent") return 0.2;
  if (link._kind === "visual_random") return 0.035;
  return 0.16;
}

function chargeStrength(node) {
  const countBoost = Math.min(76, Math.sqrt(Math.max(1, nodeData.length)) * 3.5);
  const baseCharge = -92 - countBoost * 0.4 - (node._deg || 0) * 2.4 - (node._childCount || 0) * 1.2;
  return baseCharge * physicsSettings.repulsion;
}

function radialStrength() {
  const baseSpread = nodeData.length > 36 ? 0.1 : 0.1;
  return baseSpread * physicsSettings.gravity;
}

function centerPullStrength() {
  const basePull = nodeData.length > 36 ? 0.04 : 0.055;
  return basePull * physicsSettings.gravity;
}

function collisionRadius(node) {
  const countPadding = nodeData.length > 36 ? 6 : 4;
  return nodeRadius(node) + countPadding;
}

function updateSimulationForces() {
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
  sim.force("link")
    .distance(linkDistance)
    .strength(linkStrength);

  sim.force("charge")
    .strength(chargeStrength);

  sim.force("x")
    .x(W / 2)
    .strength(centerPullStrength());

  sim.force("y")
    .y(H / 2 - 10)
    .strength(centerPullStrength());

  sim.force("radial")
    .radius(Math.min(Math.max(24, Math.sqrt(Math.max(1, nodeData.length)) * 6), 64))
    .x(W / 2)
    .y(H / 2 - 10)
    .strength(radialStrength());

  sim.force("collision")
    .radius(collisionRadius)
    .strength(0.82)
    .iterations(nodeData.length > 40 ? 2 : 1);
}

function applyPhysicsSettings(restartAlpha = 2) {
  updatePhysicsReadout();
  if (!MEMORY_GRAPH_ENABLED || !sim) {
    savePhysicsSettings();
    return;
  }
  updateSimulationForces();
  refreshNodeVisuals();
  sim.alpha(Math.max(sim.alpha(), restartAlpha)).restart();
  savePhysicsSettings();
}

function refreshNodeVisuals() {
  if (!MEMORY_GRAPH_ENABLED) return;
  if (!nodeSel || nodeSel.empty()) return;
  nodeSel
    .attr("r", nodeRadius)
    .attr("fill", nodeColor)
    .attr("filter", d => (d._core || isGlowing(d._nid) || nodeUseProgress(d._nid) > 0) ? "url(#neb-glow)" : null)
    .style("animation", d => nodeUseProgress(d._nid) > 0 ? "neb-node-use 10s ease-out" : null);
}

function dampTangentialMotion() {
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
  const cx = W / 2;
  const cy = H / 2 - 10;
  const twitching = sim.alpha() > 0.45;

  nodeData.forEach(node => {
    if (!node || node.fx != null || node.fy != null) return;

    const dx = (node.x ?? cx) - cx;
    const dy = (node.y ?? cy) - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return;

    const rx = dx / dist;
    const ry = dy / dist;
    const tx = -ry;
    const ty = rx;
    const vx = node.vx || 0;
    const vy = node.vy || 0;
    const radialVelocity = vx * rx + vy * ry;
    const tangentialVelocity = vx * tx + vy * ty;
    const tangentialDamping = twitching ? 0.14 : 0.24;

    node.vx = radialVelocity * rx + tangentialVelocity * tangentialDamping * tx;
    node.vy = radialVelocity * ry + tangentialVelocity * tangentialDamping * ty;
  });
}

function naturalTwitch(big = Math.random() < 0.3) {
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
  if (nodeData.length < 2) {
    sim.alpha(1).restart();
    return;
  }

  const nodeById = new Map(nodeData.map(node => [String(node._nid), node]));
  const anchorMap = new Map();
  linkData.forEach(link => {
    if (link._kind !== "visual_parent" && link._kind !== "visual_random") return;
    const sourceId = typeof link.source === "object" ? String(link.source._nid) : String(link.source);
    const targetId = typeof link.target === "object" ? String(link.target._nid) : String(link.target);
    if (!anchorMap.has(sourceId) && nodeById.has(targetId)) {
      anchorMap.set(sourceId, nodeById.get(targetId));
    }
  });

  // 小抽动（常态）只动少数节点低热度；大波（偶发）才整片涌动
  const ratio = big ? 0.3 : 0.1;
  const twitchCount = Math.max(big ? 6 : 3, Math.floor(nodeData.length * ratio));
  const candidates = shuffleArray(nodeData.filter(node => !node._core)).slice(0, twitchCount);

  candidates.forEach(node => {
    const anchor = anchorMap.get(String(node._nid)) || nodeData[deterministicIndex(node._nid, nodeData.length)];
    if (!anchor) return;

    const anchorX = anchor.x ?? (W / 2);
    const anchorY = anchor.y ?? (H / 2 - 10);
    const angle = Math.random() * Math.PI * 2;
    const offset = 36 + Math.random() * 52;
    const nextX = anchorX + Math.cos(angle) * offset;
    const nextY = anchorY + Math.sin(angle) * offset;
    const currentX = node.x ?? nextX;
    const currentY = node.y ?? nextY;

    node.x = currentX * 0.7 + nextX * 0.3;
    node.y = currentY * 0.7 + nextY * 0.3;
    node.vx = (node.vx || 0) + (nextX - currentX) * 0.14;
    node.vy = (node.vy || 0) + (nextY - currentY) * 0.14;
  });

  sim.alpha(big ? 0.6 : 0.35).restart();
}

let tickParity = 0;
function tick() {
  if (!MEMORY_GRAPH_ENABLED) return;
  dampTangentialMotion();
  // 非拖拽时 DOM 写入降到 30fps：力计算照跑，重绘减半；拖拽（alphaTarget>0）保持满帧
  tickParity ^= 1;
  if (tickParity && sim.alphaTarget() === 0) return;
  writeGraphDom();
}

function writeGraphDom() {
  if (!MEMORY_GRAPH_ENABLED || !linkSel || !nodeSel) return;

  linkSel
    .attr("x1", d => d.source.x)
    .attr("y1", d => d.source.y)
    .attr("x2", d => d.target.x)
    .attr("y2", d => d.target.y);

  nodeSel
    .attr("cx", d => d.x)
    .attr("cy", d => d.y);
}

function computeDegrees() {
  const nodeById = new Map(nodeData.map(n => [n._nid, n]));
  nodeData.forEach(n => {
    n._deg = 0;
    n._childCount = 0;
  });
  linkData.forEach(l => {
    const s = typeof l.source === "object" ? l.source : nodeById.get(String(l.source));
    const t = typeof l.target === "object" ? l.target : nodeById.get(String(l.target));
    if (s) s._deg = (s._deg || 0) + 1;
    if (t) t._deg = (t._deg || 0) + 1;
  });

  nodeData.forEach(node => {
    const childTargets = semanticChildTargets(node);
    if (childTargets.size) {
      node._childCount = childTargets.size;
      return;
    }

    const selfId = String(node._nid || "");
    node._childCount = nodeData.reduce((count, candidate) => (
      candidate.parent_id != null && String(candidate.parent_id) === selfId ? count + 1 : count
    ), 0);
  });
}

function showTip(event, d) {
  const label = d.title || (d.content || "").slice(0, 120) || d._nid;
  const type = d._core ? "self" : (d.event_type || "memory");
  tip
    .style("display", "block")
    .style("left", `${event.clientX + 14}px`)
    .style("top", `${event.clientY + 12}px`)
    .html(`<span class="tip-type">${type}</span><div>${label}</div>`);
}

function parseEntities(raw) {
  try {
    const p = typeof raw === "string" ? JSON.parse(raw || "[]") : (raw || []);
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}

function parseLinks(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : (raw || []);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function semanticChildTargets(node) {
  const targets = new Set();
  parseLinks(node.links).forEach(link => {
    if (!link || typeof link !== "object") return;
    const relation = String(link.relation || "").toLowerCase();
    const targetId = String(link.target_id || link.targetId || "").trim();
    if (relation === "parent_of" && targetId) targets.add(targetId);
  });
  return targets;
}

function markCore() {
  nodeData.forEach(n => { n._core = false; });
  const core = nodeData.find(n => parseEntities(n.entities).includes("agent:jarvis"))
    || nodeData[0];
  if (core) core._core = true;
}

function renderLegend() {
  const el = document.getElementById("legend");
  if (!el) return;
  const total = nodeData.length;
  const active = nodeData.filter(n => (Date.now() - (n._ts || 0)) < 15000).length;
  const known = Math.max(0, total - active - 1);
  const decayed = nodeData.filter(n => (Date.now() - (n._ts || 0)) > 60000).length;

  const items = [
    { name: "Constraint", count: 1, color: getThemeColors().warm },
    { name: "Memory", count: total, color: getThemeColors().nodeHigh },
    { name: "Knowledge", count: known, color: getThemeColors().cool },
    { name: "Decayed", count: decayed, color: getThemeColors().dim },
  ];

  el.innerHTML = items.map(i =>
    `<div class="legend-item">
      <span class="legend-dot" style="background:${i.color}"></span>
      <span class="legend-name">${i.name}</span>
      <span class="legend-count">${i.count}</span>
    </div>`
  ).join("");
}

function renderGraph(restartAlpha = 2) {
  if (!MEMORY_GRAPH_ENABLED || !sim) {
    updateStats();
    renderLegend();
    return;
  }
  computeDegrees();
  markCore();
  updateStats();
  renderLegend();

  linkSel = linkSel.data(linkData, d => d._lid);
  linkSel.exit().remove();
  linkSel = linkSel.enter().append("line")
    .attr("stroke", getThemeColors().linkStroke || "rgba(143,182,216,0.18)")
    .attr("stroke-width", 0.6)
    .merge(linkSel);

  nodeSel = nodeSel.data(nodeData, d => d._nid);
  nodeSel.exit().transition().duration(280).attr("r", 0).remove();

  const enter = nodeSel.enter().append("circle")
    .attr("r", 0)
    .attr("fill", nodeColor)
    .style("cursor", "pointer")
    .call(d3.drag()
      .on("start", (event, d) => {
        if (!event.active) sim.alphaTarget(2).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x; d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      }))
    .on("mouseover", showTip)
    .on("mousemove", event => {
      tip.style("left", `${event.clientX + 14}px`)
         .style("top", `${event.clientY + 12}px`);
    })
    .on("mouseout", () => tip.style("display", "none"))
    .on("click", (event, d) => {
      d._ts = Date.now();
      d._strength = Math.min(1, (d._strength || 0.5) + 0.25);
      highlightNodes([d._nid], 900);
    });

  enter.transition().duration(360).attr("r", nodeRadius);
  nodeSel = enter.merge(nodeSel);

  sim.nodes(nodeData);
  sim.force("link").links(linkData);
  updateSimulationForces();
  sim.alpha(0.5).restart();
  refreshNodeVisuals();
}

function deterministicIndex(seed, mod) {
  let hash = 2166136261;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % mod;
}

function shuffleArray(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createVisualOrder(nodes) {
  const coreNode = nodes.find(n => n._core || parseEntities(n.entities).includes("agent:jarvis")) || null;
  const rest = shuffleArray(nodes.filter(n => !coreNode || n._nid !== coreNode._nid));
  return coreNode ? [coreNode, ...rest] : rest;
}

function chooseVisualParent(child, candidates, childCounts) {
  if (!candidates.length) return null;
  const weighted = [];
  candidates.forEach(candidate => {
    const currentChildren = childCounts.get(candidate._nid) || 0;
    const maxChildren = maxVisualChildren(candidate);
    const recencyBias = Math.max(0, 400000 - Math.abs((child._ts || 0) - (candidate._ts || 0))) / 100000;
    const coreBias = candidate._core ? 1.4 : 0;
    const strengthBias = (candidate._strength || 0.4) * 0.8;
    const remainingCapacity = Math.max(0, maxChildren - currentChildren);
    const capacityBias = currentChildren === 0 ? 1.2 : 0.35 + remainingCapacity * 0.25;
    const entryCount = 1 + Math.max(0, Math.round((recencyBias + coreBias + strengthBias + capacityBias) * 2));
    for (let w = 0; w < entryCount; w++) {
      weighted.push(candidate);
    }
  });
  if (!weighted.length) return candidates[Math.floor(Math.random() * candidates.length)] || null;
  return weighted[Math.floor(Math.random() * weighted.length)] || null;
}

function getCurrentVisualChildCounts(nodes) {
  const counts = new Map(nodes.map(n => [n._nid, 0]));
  linkData.forEach(link => {
    if (link._kind !== "visual_parent") return;
    const parentId = typeof link.target === "object" ? String(link.target._nid) : String(link.target);
    counts.set(parentId, (counts.get(parentId) || 0) + 1);
  });
  return counts;
}

function maxVisualChildren(node) {
  if (!node) return 2;
  if (node._core) return 4;
  const degree = node._deg || 0;
  const strength = node._strength || 0;
  return (degree >= 4 || strength >= 0.72) ? 4 : 2;
}

function addSupplementalVisualLinks(linkSet, childCounts) {
  const ordered = createVisualOrder(nodeData);
  const extraLinks = Math.min(18, Math.max(2, Math.floor(nodeData.length / 5)));
  let added = 0;

  for (let i = 1; i < ordered.length && added < extraLinks; i++) {
    const source = ordered[i];
    const candidates = shuffleArray(
      ordered.slice(0, i).filter(node => {
        if (node._nid === source._nid) return false;
        return (childCounts.get(node._nid) || 0) < maxVisualChildren(node);
      })
    );

    const target = candidates[0];
    if (!target) continue;

    const lid = `visual-extra:${source._nid}=>${target._nid}`;
    const rev = `visual-extra:${target._nid}=>${source._nid}`;
    const base = `visual:${source._nid}=>${target._nid}`;
    const baseRev = `visual:${target._nid}=>${source._nid}`;
    if (linkSet.has(lid) || linkSet.has(rev) || linkSet.has(base) || linkSet.has(baseRev)) continue;

    linkSet.add(lid);
    linkData.push({ source: source._nid, target: target._nid, _lid: lid, _kind: "visual_random" });
    childCounts.set(target._nid, (childCounts.get(target._nid) || 0) + 1);
    added += 1;
  }
}

function addRandomVisualLinks(linkSet) {
  if (nodeData.length < 2) return;

  const ordered = createVisualOrder(nodeData);
  const childCounts = new Map(ordered.map(n => [n._nid, 0]));

  for (let i = 1; i < ordered.length; i++) {
    const child = ordered[i];
    const candidates = ordered
      .slice(0, i)
      .filter(node => (childCounts.get(node._nid) || 0) < maxVisualChildren(node));

    const parent = chooseVisualParent(child, candidates, childCounts);
    if (!parent || parent._nid === child._nid) continue;

    const lid = `visual:${child._nid}=>${parent._nid}`;
    const rev = `visual:${parent._nid}=>${child._nid}`;
    if (linkSet.has(lid) || linkSet.has(rev)) continue;

    linkSet.add(lid);
    linkData.push({ source: child._nid, target: parent._nid, _lid: lid, _kind: "visual_parent" });
    childCounts.set(parent._nid, (childCounts.get(parent._nid) || 0) + 1);
  }

  addSupplementalVisualLinks(linkSet, childCounts);
}

function findAnchorNode(memory, nodeMap) {
  const nodes = Array.from(nodeMap.values());
  const childCounts = getCurrentVisualChildCounts(nodes);
  const candidates = createVisualOrder(nodes)
    .filter(node => (childCounts.get(node._nid) || 0) < maxVisualChildren(node));
  return chooseVisualParent(memory, candidates, childCounts)
    || nodeData.find(n => n._core)
    || nodeData[0]
    || null;
}

async function loadMemories() {
  if (!MEMORY_GRAPH_ENABLED) return;
  try {
    const rows = await fetch(`${API}/memories?limit=120`).then(r => r.json());
    if (!Array.isArray(rows)) return;

    const prevPositions = new Map(nodeData.map(n => [n._nid, {
      x: n.x, y: n.y, vx: n.vx, vy: n.vy, fx: n.fx, fy: n.fy,
    }]));

    nodeData = rows.map(row => {
      const nid = row.mem_id || String(row.id);
      const prev = prevPositions.get(nid);
      return {
        ...row,
        _nid: nid,
        _ts: prev ? Date.now() : Date.now() - Math.random() * 8000,
        x: prev ? prev.x : W / 2 + (Math.random() - 0.5) * 180,
        y: prev ? prev.y : H / 2 + (Math.random() - 0.5) * 180,
        vx: prev ? prev.vx : 0,
        vy: prev ? prev.vy : 0,
        fx: prev ? prev.fx : null,
        fy: prev ? prev.fy : null,
      };
    });

    const linkSet = new Set();
    linkData = [];
    addRandomVisualLinks(linkSet);

    renderGraph(1.1);
  } catch (error) {
    console.warn("[graph] load failed:", error.message);
    setConnectionState("未连接", false);
  }
}

function addNewNodes(memories) {
  if (!MEMORY_GRAPH_ENABLED) return;
  const nodeMap = new Map(nodeData.map(n => [n._nid, n]));
  const newNids = [];
  memories.forEach(memory => {
    const nid = memory.mem_id || memory.id;
    if (!nid || nodeMap.has(String(nid))) return;
    const anchor = findAnchorNode(memory, nodeMap);
    const anchorX = anchor?.x ?? W / 2;
    const anchorY = anchor?.y ?? (H / 2 - 10);
    const node = {
      ...memory,
      _nid: String(nid),
      mem_id: String(nid),
      event_type: memory.event_type || memory.type || "fact",
      _ts: Date.now(),
      _strength: 0.85,
      x: anchorX + (Math.random() - 0.5) * 72,
      y: anchorY + (Math.random() - 0.5) * 72,
      vx: 0, vy: 0,
    };
    nodeData.push(node);
    nodeMap.set(node._nid, node);
    newNids.push(node._nid);
  });
  if (!newNids.length) return;

  const linkSet = new Set();
  linkData = [];
  addRandomVisualLinks(linkSet);
  renderGraph(2);
  highlightNodes(newNids, 10000);
}

if (MEMORY_GRAPH_ENABLED) {
  // 随机 5–9 秒一次抽动，比固定节拍更像活物；窗口不可见时休眠省 GPU
  const scheduleTwitch = () => {
    setTimeout(() => {
      if (!document.hidden) naturalTwitch();
      scheduleTwitch();
    }, 5000 + Math.random() * 4000);
  };
  scheduleTwitch();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) naturalTwitch(true); // 回到前台来一发大波当欢迎
  });
  setInterval(() => { nodeData.forEach(n => { if (n._strength) n._strength *= 0.97; }); }, 2500);
}

function parseUserMessageInput(raw) {
  const text = String(raw || "");
  const match = text.match(/^\[([^\]]+)\]\s+(\S+)\s+\[([^\]]+)\]\s+([\s\S]*)$/);
  if (!match) return { content: text.trim(), time: null };
  return { fromId: match[1], timestamp: match[2], channel: match[3], content: match[4].trim(), time: formatMsgTime(match[2]) };
}

function formatMsgTime(stamp) {
  if (!stamp) return null;
  const m = String(stamp).match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}:${m[3]}`;
  const m2 = String(stamp).match(/(\d{2}):(\d{2}):(\d{2})/);
  if (m2) return `${m2[1]}:${m2[2]}:${m2[3]}`;
  return null;
}

const L1 = new ThoughtStream("si-l1", "cool", {
  readCSSVar,
  thinkingLabel: "思考中…",
  thinkingDoneLabel: "思考完成",
  toolDetailLength: 140,
});
const L2 = new ThoughtStream("si-l2", "warm", {
  readCSSVar,
  thinkingLabel: "思考中",
  thinkingDoneLabel: "思考完成",
  toolDetailLength: 220,
});

// L1 = processing flow triggered by user messages; L2 = processing flow triggered by TICK.
// stream_*/tool_call events emitted by the backend carry no path tag;
// routing to the correct panel is determined by the most recent message_received / tick event.
let currentPath = "l2";
function currentStream() { return currentPath === "l1" ? L1 : L2; }

function isBusyErrorMessage(message = "") {
  return /(429|rate limit|too many requests|busy|overload|temporarily unavailable|server busy|resource exhausted)/i.test(String(message || ""));
}

function formatRetryDelay(ms) {
  if (!ms || ms < 1000) return `${ms || 0}ms`;
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
}

let tokenAccum = 0;
let tokenWindow = Date.now();
const tokRateEl = document.getElementById("tok-rate");

// 记忆系统观测（Memory-Optimization v0.1 Phase 0）：每 60s 拉一次近 1 小时的 audit stats。
// 显示"N 次（平均 K 条）"——次数代表系统活跃度，平均条数代表召回/抽取的健康度。
// 0 命中数会让数字变橙提醒（命中率低 = 可能有召回漏）；纯网络/服务失败保持 — 不告警。
const memRecallEl = document.getElementById("mem-recall-rate");
const memExtractEl = document.getElementById("mem-extract-rate");

// ── AI 当前正在做什么：派生展示 ────────────────────────────────
// 北极星（[[feedback-ai-be-itself]]）：通信问题靠界面侧派生可视化解决，不逼 AI 学人开口。
// 工作方式：纯被动接收 tool_call 事件流，按工具名归类统计最近 60s 活动，自动推导当前活动标签。
// AI 完全不需要为此多做任何动作；它只管干活，UI 自己把"在干什么"翻译给用户看。
const AI_ACTIVITY_WINDOW_MS = 60_000;
const AI_ACTIVITY_IDLE_AFTER_MS = 15_000;
const AI_TOOL_GROUPS = {
  "扫描文件": new Set(["read_file", "list_dir"]),
  "改动文件": new Set(["write_file", "make_dir", "delete_file"]),
  "执行命令": new Set(["exec_command", "kill_process", "list_processes"]),
  "上网": new Set(["fetch_url", "web_search", "browser_read"]),
  "调取记忆": new Set(["search_memory", "recall_memory", "probe_memory", "upsert_memory", "merge_memories", "downgrade_memory"]),
  "推送界面": new Set(["ui_show", "ui_update", "ui_hide", "ui_patch", "ui_register", "focus_banner"]),
  "处理多媒体": new Set(["speak", "generate_lyrics", "generate_music", "generate_image", "music", "media_mode"]),
  "回复用户": new Set(["send_message", "express"]),
};
const aiActivityLog = [];
let aiActivityFirstTs = 0;
let aiActivityTimer = null;
const aiActivityEl = document.getElementById("ai-activity");
const aiActivityLabelEl = document.getElementById("ai-activity-label");
const aiActivityDetailEl = document.getElementById("ai-activity-detail");

function classifyTool(name) {
  for (const [label, set] of Object.entries(AI_TOOL_GROUPS)) {
    if (set.has(name)) return label;
  }
  return "处理事务";
}

function recordAiActivity(name) {
  if (!name) return;
  const now = Date.now();
  if (aiActivityLog.length === 0) aiActivityFirstTs = now;
  aiActivityLog.push({ name, ts: now, group: classifyTool(name) });
  refreshAiActivity();
}

function refreshAiActivity() {
  if (!aiActivityEl) return;
  const now = Date.now();
  while (aiActivityLog.length && now - aiActivityLog[0].ts > AI_ACTIVITY_WINDOW_MS) {
    aiActivityLog.shift();
  }
  if (aiActivityLog.length === 0) {
    aiActivityEl.dataset.state = "idle";
    aiActivityLabelEl.textContent = "空闲";
    aiActivityDetailEl.textContent = "";
    aiActivityFirstTs = 0;
    return;
  }
  const lastTs = aiActivityLog[aiActivityLog.length - 1].ts;
  if (now - lastTs > AI_ACTIVITY_IDLE_AFTER_MS) {
    aiActivityEl.dataset.state = "idle";
    aiActivityLabelEl.textContent = "刚完成";
    const ago = Math.round((now - lastTs) / 1000);
    aiActivityDetailEl.textContent = `${ago}s 前停止`;
    return;
  }
  const counts = {};
  for (const e of aiActivityLog) counts[e.group] = (counts[e.group] || 0) + 1;
  let domGroup = "处理事务";
  let domCount = 0;
  for (const [g, c] of Object.entries(counts)) {
    if (c > domCount) { domCount = c; domGroup = g; }
  }
  aiActivityEl.dataset.state = "busy";
  aiActivityLabelEl.textContent = `正在${domGroup}`;
  const elapsed = Math.round((now - (aiActivityFirstTs || lastTs)) / 1000);
  aiActivityDetailEl.textContent = `· ${aiActivityLog.length} 次工具 · ${elapsed}s`;
}

if (aiActivityEl) {
  aiActivityEl.dataset.state = "idle";
  aiActivityTimer = setInterval(refreshAiActivity, 1000);
}

async function refreshMemoryAuditStats() {
  if (!memRecallEl || !memExtractEl) return;
  try {
    const res = await fetch("/audit/stats?hours=1", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const r = data?.recall || {};
    const e = data?.extract || {};
    const rTotal = Number(r.total || 0);
    const rAvg = Number(r.avg_chosen || 0);
    const rZero = Number(r.zero_match_count || 0);
    const eTotal = Number(e.total || 0);
    const eAvg = Number(e.avg_extracted || 0);
    const eSkip = Number(e.skipped_count || 0);
    memRecallEl.textContent = rTotal ? `${rTotal}·${rAvg.toFixed(1)}` : "0";
    memExtractEl.textContent = eTotal ? `${eTotal}·${eAvg.toFixed(1)}` : "0";
    memRecallEl.style.color = (rTotal > 0 && rZero / rTotal > 0.2) ? "var(--warn, #e8a23a)" : "";
    memExtractEl.style.color = (eTotal > 0 && eSkip / eTotal > 0.5) ? "var(--warn, #e8a23a)" : "";
  } catch {
    // 静默：dev/build 早期 audit 表可能还没数据，保持 — 即可
  }
}
refreshMemoryAuditStats();
setInterval(refreshMemoryAuditStats, 60_000);

function bumpTokens(text) {
  tokenAccum += (text || "").length / 3.4;
  const now = Date.now();
  if (now - tokenWindow > 700) {
    const rate = tokenAccum / ((now - tokenWindow) / 1000);
    tokRateEl.textContent = rate.toFixed(1);
    tokenAccum = 0;
    tokenWindow = now;
    setTimeout(() => { if (tokRateEl.textContent !== "—" && tokenAccum === 0) tokRateEl.textContent = "—"; }, 4000);
  }
}

// ── 专注帧观察面板 (focus stack) ────────────────────────────────
// 设计文档 7.5：用户必须看得见 Agent 此刻在专注什么。
// 纯事件驱动：focus_frame → 全量重渲染；focus_compressed → 在栈顶尾部追加 conclusion 并淡入。

function escapeFocusText(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncateConclusion(text, max = 60) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trim() + "…";
}

function renderFocusFrame(frame, { isTop }) {
  const conclusions = Array.isArray(frame?.conclusions) ? frame.conclusions : [];

  // 主行显示策略（progressive disclosure）：
  //   1. 有 conclusion → 显示最新一条（这是子帧 pop 时压缩出的 1-2 句话结论）
  //   2. 无 conclusion 但有 topic → 显示 topic（v0 是 ngram，几百 ms 后被 LLM refine 成人类可读短语）
  //   3. 都没 → 返回空主行（上层 renderFocusStack 会进一步过滤）
  // 早期 conclusion 作为弱化辅助行（栈顶帧才显示，避免视觉过载）
  const latest = conclusions.length > 0 ? conclusions[conclusions.length - 1] : "";
  const earlier = conclusions.length > 1 ? conclusions.slice(0, -1) : [];
  const topicSummary = Array.isArray(frame?.topic) && frame.topic.length > 0
    ? frame.topic.slice(0, 3).join(" · ")
    : "";

  let mainHTML = "";
  if (latest) {
    mainHTML = `<div class="focus-frame-main">${escapeFocusText(truncateConclusion(latest, isTop ? 120 : 80))}</div>`;
  } else if (topicSummary) {
    mainHTML = `<div class="focus-frame-main focus-frame-main-fallback">${escapeFocusText(truncateConclusion(topicSummary, isTop ? 60 : 40))}</div>`;
  }

  const earlierHTML = earlier.map((c) =>
    `<div class="focus-frame-conclusion focus-frame-conclusion-earlier">${escapeFocusText(truncateConclusion(c, isTop ? 100 : 60))}</div>`
  ).join("");

  // 该帧既无 conclusion 也无 topic（极短暂的"刚 push 还没赋 topic"状态），不渲染外层壳
  if (!mainHTML && !earlierHTML) return "";

  return (
    `<div class="focus-frame${isTop ? " top" : ""}">` +
      mainHTML +
      earlierHTML +
    `</div>`
  );
}

function renderFocusStack(stack) {
  if (!focusStackEl || !focusBlockEl) return;
  const list = Array.isArray(stack) ? stack : [];
  if (focusDepthEl) focusDepthEl.textContent = String(list.length);

  if (list.length === 0) {
    focusBlockEl.dataset.state = "empty";
    focusStackEl.innerHTML = `<div class="focus-empty">无专注</div>`;
    return;
  }

  focusBlockEl.dataset.state = "active";
  // 渲染策略：只渲染"有 conclusion 的帧 + 栈顶帧"。
  // 非栈顶 + 无 conclusion 的帧静默隐藏——这种帧是"已 push 但还没 pop"的活帧，
  // conclusion 永远空着，渲染出来只是占位文字（"…"），堆叠多了视觉很噪。
  // depth 数字仍然显示真实栈深度，让用户知道还有未压缩的帧挂着。
  // 栈底 → 栈顶；视觉上栈顶在最下（最近一次最强），跟终端 / 思考流方向一致。
  const html = list.map((frame, i) => {
    const isTop = i === list.length - 1;
    const hasConclusion = Array.isArray(frame?.conclusions) && frame.conclusions.length > 0;
    if (!isTop && !hasConclusion) return "";
    return renderFocusFrame(frame, { isTop });
  }).filter(Boolean).join("");
  focusStackEl.innerHTML = html;
}

function flashFocusCompressed() {
  if (!focusBlockEl) return;
  // 让栈顶帧的主行（最新 conclusion）走淡入动画；同时整块做一次柔和高光。
  focusBlockEl.classList.remove("focus-compress-pulse");
  // 强制 reflow 让动画重启
  void focusBlockEl.offsetWidth;
  focusBlockEl.classList.add("focus-compress-pulse");

  const topFrame = focusStackEl?.querySelector(".focus-frame.top");
  const mainEl = topFrame?.querySelector(".focus-frame-main");
  if (mainEl) {
    mainEl.classList.remove("just-added");
    void mainEl.offsetWidth;
    mainEl.classList.add("just-added");
  }
}

function connectSSE() {
  setConnectionState("连接中", true);
  const es = new EventSource(`${API}/events`);

  es.onopen = () => setConnectionState("已连接", true);

  es.onmessage = event => {
    try { handle(JSON.parse(event.data)); } catch (_) {}
  };

  es.onerror = () => {
    setConnectionState("重连中", false);
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

function extractNids(memList) {
  return (memList || [])
    .map(m => m.mem_id || (m.id != null ? String(m.id) : null))
    .filter(Boolean);
}

function handle({ type, data = {} }) {
  switch (type) {
    case "message_received": {
      currentPath = "l1";
      // 兜底：上一轮若被打断、message/response 均未到达，实时气泡会成孤儿、流式会话可能还挂着麦克风
      // ——定稿气泡、收尾流式会话（恢复麦克风）、复位状态，再开新一轮。
      if (sttsActive) endStreamingTTS();
      if (chat.hasLiveJarvisMsg()) chat.finalizeLiveJarvisMsg(null);
      liveReplyActive = false;
      liveRawText = "";
      liveTurnSpeak = false;
      L1.beginRound();
      const parsed = parseUserMessageInput(data.input);
      L1.newLine("user message received", {
        content: parsed.content,
        time: parsed.time || undefined,
      });
      // Immediately show a "thinking" indicator so the gap between message_received
      // and the first stream_start (injector + LLM TTFT, often 3–30s) doesn't look frozen.
      L1.startThinkingSession();
      break;
    }
    case "tick":
      currentPath = "l2";
      L2.beginRound();
      L2.newLine("heartbeat tick");
      L2.startThinkingSession();
      break;
    case "stream_start":
      currentStream().startThinkingSession();
      // 正文流（plainReply）：把 token 实时打进聊天气泡。一轮可能有多段正文（正文→工具→正文），
      // 只在尚未开始时建气泡，后续段累积进同一个。speak 轮（语音）额外开启逐句流式合成。
      if (data.mode === "text" && data.plainReply) {
        if (data.speak) liveTurnSpeak = true;
        if (!liveReplyActive) {
          liveReplyActive = true;
          liveRawText = "";
          chat.beginLiveJarvisMsg({ alert: true });
          if (liveTurnSpeak && isTTSStreamingEnabled()) beginStreamingTTS();
        }
      }
      break;
    case "stream_chunk":
      // 思考流：只驱动 token 速率指示器，不进聊天（保持 dashboard 纯净）
      currentStream().clearStatus();
      bumpTokens(data.text);
      // 正文流：累积 + 实时重渲染气泡（剥离协议标记 / 藏半截标记）；语音轮喂给逐句合成队列
      if (data.mode === "text" && liveReplyActive) {
        liveRawText += data.text;
        chat.updateLiveJarvisMsg(cleanStreamText(liveRawText));
        if (sttsActive) feedStreamingTTS(liveRawText);
      }
      break;
    case "stream_end":
      currentStream().stopThinking();
      // 正文段结束：把残句先送去合成，降低尾句延迟（不结束会话，可能还有后续正文段）
      if (data.mode === "text" && sttsActive) flushStreamingTTSBuf();
      break;
    case "tool_preparing": {
      // 思考动画已停，但工具尚未真正执行 —— 给一个占位状态避免 UI 死寂
      const stream = currentStream();
      const label = data.name ? stream.toolLabel(data.name) : "";
      stream.setStatus(label ? `准备调用 ${label}…` : "准备工具调用…", "busy");
      break;
    }
    case "tool_executing": {
      const stream = currentStream();
      const label = data.name ? stream.toolLabel(data.name) : "工具";
      stream.setTimedStatus(`正在执行 ${label}…`, "busy", {
        staleAfterMs: 45000,
        staleText: `执行 ${label} 时间偏长，仍在等结果…`,
      });
      break;
    }
    case "tool_call":
      currentStream().tool(data.name, data.args, data.result, data.ok);
      recordAiActivity(data.name);
      break;
    case "response":
      // Round complete — stop all animations
      currentStream().end();
      // 兜底：本轮结束时（response 必在 message 之后发）若流式合成会话仍开着——极少见，模型只调了工具
      // 没产出可投递正文、message 未到达——标记正文已尽让队列放完即恢复麦克风，避免麦克风一直挂起。
      // 正常情况 message 已 finalize 过，此处幂等无副作用，不会打断仍在播放的尾句。
      if (sttsActive) finalizeStreamingTTS();
      if (chat.hasLiveJarvisMsg()) chat.finalizeLiveJarvisMsg(null);
      liveReplyActive = false; liveRawText = ""; liveTurnSpeak = false;
      break;
    case "processing_preempted":
      currentStream().end();
      break;
    case "llm_retry": {
      currentStream().startThinkingSession();
      const nextAttempt = Number(data.nextAttempt || 2);
      const delayText = formatRetryDelay(Number(data.delayMs || 0));
      currentStream().setStatus("LLM 繁忙，第 " + nextAttempt + " 次重试将于 " + delayText + " 后开始", "busy");
      break;
    }
    case "message_requeued": {
      currentStream().startThinkingSession();
      const retryCount = Number(data.retryCount || 1);
      currentStream().setStatus("LLM 繁忙，已入队重试 " + retryCount + "/3", "busy");
      break;
    }
    case "message_dropped":
      currentStream().startThinkingSession();
      currentStream().setStatus("LLM 繁忙，重试次数已达上限", "failed");
      break;
    case "error":
      if (isBusyErrorMessage(data.error)) {
        currentStream().startThinkingSession();
        currentStream().setStatus("LLM 繁忙，请稍后重试", "busy");
      } else {
        currentStream().stopThinking();
        currentStream().setStatus(data.error || "处理失败", "failed");
      }
      break;
    case "protocol_violation":
      currentStream().end();
      break;
    case "injector_result": {
      const nids = [...extractNids(data.matchedMemories), ...extractNids(data.recallMemories)];
      if (nids.length) highlightNodes(nids, 10000);
      break;
    }
    case "focus_frame": {
      renderFocusStack(data.focusStack);
      break;
    }
    case "focus_compressed": {
      // 后端 emit 顺序：先 focus_frame（栈已 pop 完）→ 异步压缩完再 focus_compressed。
      // 触发时栈顶帧的 conclusions 数组在后端已被追加，但前端 DOM 里还是旧的。
      // 新布局：把新 conclusion 写入「主行」(.focus-frame-main)；
      // 若主行原本是 fallback（暂无沉淀结论），就把它升级为正常主行。
      // 若主行已有旧 conclusion，把旧值降级追加到「早期 conclusion」列表里，再覆盖主行。
      // 下一次 focus_frame 事件会带最新 conclusions 全量覆盖，所以即使错位也很快收敛。
      const topFrame = focusStackEl?.querySelector(".focus-frame.top");
      if (topFrame && data.conclusion) {
        const mainEl = topFrame.querySelector(".focus-frame-main");
        const newText = truncateConclusion(data.conclusion, 120);
        if (mainEl) {
          const wasFallback = mainEl.classList.contains("focus-frame-main-fallback");
          if (!wasFallback && mainEl.textContent) {
            const earlier = document.createElement("div");
            earlier.className = "focus-frame-conclusion focus-frame-conclusion-earlier";
            earlier.textContent = mainEl.textContent;
            topFrame.appendChild(earlier);
          }
          mainEl.classList.remove("focus-frame-main-fallback");
          mainEl.innerHTML = "";
          mainEl.textContent = newText;
        }
      }
      flashFocusCompressed();
      break;
    }
    case "memories_written":
      if (Array.isArray(data.memories) && data.memories.length) {
        addNewNodes(data.memories);
      }
      break;
    case "message":
      if (data.from === "consciousness") {
        setLastJarvisContent(data.content);
        const viaLabel = friendlyChannelLabel(data.channel);
        const content = viaLabel ? `_→ ${viaLabel}_  \n${data.content}` : data.content;
        // 若本轮正文已流式进了实时气泡：用权威全文定稿同一个气泡，避免新建重复气泡
        if (chat.hasLiveJarvisMsg()) {
          chat.finalizeLiveJarvisMsg(content);
        } else {
          addMsg("jarvis", content);
        }
        // 语音轮的 TTS 收尾：逐句会话进行中 → flush 尾句并收尾；若未走逐句（流式合成关闭）→ 整段播一次
        if (liveTurnSpeak) {
          if (sttsActive) finalizeStreamingTTS();
          else playTTSReply(toPlainSpeech(data.content));
        }
        liveReplyActive = false;
        liveRawText = "";
        liveTurnSpeak = false;
        enrichVisiblePersonCardFromText(data.content, { source: 'assistant_message' });
        openChat(true);
      }
      break;
    case "message_in": {
      // 外部渠道判定：channel 非空且非本地，或 from_id 仍带外部前缀（兼容连接器直接 emit 的事件）
      const ch = String(data.channel || "").toUpperCase();
      const isExternal =
        (ch && ch !== "TUI" && ch !== "API" && ch !== "SYSTEM" && ch !== "REMINDER" && ch !== "APP_SIGNAL" && ch !== "VOICE" && ch !== "语音识别")
        || (data.from_id && /^(wechat|discord|feishu|wecom):/i.test(data.from_id));
      if (isExternal) {
        const label = friendlyChannelLabel(data.channel) || data.from_id || "External";
        addMsg("external", data.content, { label, alert: false });
        openChat(true);
      }
      break;
    }
    case "agent_name_updated":
      setAgentName(data.name);
      break;
    case "media_mode":
      window.dispatchEvent(new CustomEvent("xiaobailong:media", { detail: data }));
      break;
    case "aivideo_mode":
      window.dispatchEvent(new CustomEvent("xiaobailong:aivideo", { detail: data }));
      break;
    case "hotspot_mode":
      setHotspotMode(!!data.active || data.action === "show" || data.action === "open", { source: "agent_event" });
      break;
    case "worldcup_mode":
      setWorldcupMode(!!data.active || data.action === "show" || data.action === "open", { source: "agent_event" });
      break;
    case "doc_panel_mode":
      setDocPanelMode(!!data.active || data.action === "open", { topicId: data.topic || null, source: "agent_event" });
      break;
    case "person_card_mode":
      setPersonCardMode(!!data.active || data.action === "show" || data.action === "open" || data.action === "update", { source: "agent_event", card: data.card || null });
      break;
    case "social_status":
      window.dispatchEvent(new CustomEvent("xiaobailong:social_status", { detail: data }));
      break;
    case "show_wechat_popup":
      showWechatPopup();
      break;
    case "audio_created":
      if (data.autoPlay && data.path) {
        const audioUrl = `${API}/${data.path}`;
        const audioEl = new Audio(audioUrl);
        applyOutputSink(audioEl).catch(() => {}); // 与 TTS 同路由，避开虚拟/已拔出设备
        audioEl.play().catch(() => {});
      }
      break;
    case "tts_reply":
      if (data.text) playTTSReply(data.text);
      break;
    case "key_configured":
      chat.deleteLastUserMsg();
      if (data.service === 'tts' && data.ttsText) playTTSReply(data.ttsText);
      break;
    case "startup_self_check_started":
      playJarvisStartupSound();
      setTimeout(() => playTTSReply("系统启动中，正在运行自检"), 1500);
      break;
    default:
      break;
  }
}

// ── Jarvis-style startup self-check sound ────────────────────────────────────
function playJarvisStartupSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime;

    // Layer 1: low-frequency mechanical hum (sawtooth, simulates power-on)
    const drone = ctx.createOscillator();
    const droneGain = ctx.createGain();
    const droneFilter = ctx.createBiquadFilter();
    drone.type = "sawtooth";
    drone.frequency.setValueAtTime(50, t);
    drone.frequency.linearRampToValueAtTime(90, t + 0.5);
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 350;
    droneFilter.Q.value = 3;
    droneGain.gain.setValueAtTime(0, t);
    droneGain.gain.linearRampToValueAtTime(0.09, t + 0.06);
    droneGain.gain.linearRampToValueAtTime(0.06, t + 0.4);
    droneGain.gain.linearRampToValueAtTime(0, t + 0.65);
    drone.connect(droneFilter);
    droneFilter.connect(droneGain);
    droneGain.connect(ctx.destination);
    drone.start(t);
    drone.stop(t + 0.7);

    // Layer 2: system-online frequency sweep (sine, low to high)
    const sweep = ctx.createOscillator();
    const sweepGain = ctx.createGain();
    sweep.type = "sine";
    sweep.frequency.setValueAtTime(280, t + 0.12);
    sweep.frequency.exponentialRampToValueAtTime(2800, t + 1.0);
    sweepGain.gain.setValueAtTime(0, t + 0.12);
    sweepGain.gain.linearRampToValueAtTime(0.13, t + 0.22);
    sweepGain.gain.exponentialRampToValueAtTime(0.001, t + 1.05);
    sweep.connect(sweepGain);
    sweepGain.connect(ctx.destination);
    sweep.start(t + 0.12);
    sweep.stop(t + 1.1);

    // Layer 3: three confirmation beeps (square wave, self-check passed)
    [[880, 1.15], [1100, 1.28], [1320, 1.41]].forEach(([freq, bt]) => {
      const beep = ctx.createOscillator();
      const beepGain = ctx.createGain();
      const beepFilter = ctx.createBiquadFilter();
      beep.type = "square";
      beep.frequency.value = freq;
      beepFilter.type = "bandpass";
      beepFilter.frequency.value = freq;
      beepFilter.Q.value = 8;
      beepGain.gain.setValueAtTime(0.14, t + bt);
      beepGain.gain.exponentialRampToValueAtTime(0.001, t + bt + 0.075);
      beep.connect(beepFilter);
      beepFilter.connect(beepGain);
      beepGain.connect(ctx.destination);
      beep.start(t + bt);
      beep.stop(t + bt + 0.09);
    });

    setTimeout(() => ctx.close().catch(() => {}), 2500);
  } catch (_) {
    // silently ignore if browser does not support AudioContext
  }
}


// 本轮流式回复状态：是否正在把正文打进实时气泡 / 累积的原始正文 / 本轮是否语音播报
let liveReplyActive = false;
let liveRawText = '';
let liveTurnSpeak = false;

// 流式语音合成：边下边播，首包到达即出声（后端 /tts/stream 本就分块返回，
// 这里用 MediaSource 消费，省去"等整段下载完再播"的延迟）。默认开启，可在设置关闭。
// isTTSStreamingEnabled, setTTSStreamingEnabled, ttsCanStream 已从 tts-pipeline.js 导入

// Estimate spoken char count from audio progress, snapping to a sentence boundary
function calcRemainingText(text, currentTime, duration) {
  if (!text || !duration || duration <= 0) return { remaining: '', spokenUpTo: 0 };
  const progress = Math.min(1, currentTime / duration);
  const spokenChars = Math.floor(text.length * progress);
  const BOUNDARIES = /[。！？，.!?,\n]/g;
  let bestPos = spokenChars;
  let match;
  BOUNDARIES.lastIndex = Math.max(0, spokenChars - 10);
  while ((match = BOUNDARIES.exec(text)) !== null) {
    if (match.index >= spokenChars) {
      bestPos = match.index + 1;
      break;
    }
  }
  return { remaining: text.slice(bestPos).trim(), spokenUpTo: bestPos };
}

// Estimate cut position in original markdown based on spoken ratio in TTS plain text
function findMarkdownCutPos(markdown, ttsFullLen, ttsSpokenUpTo) {
  if (!markdown || ttsFullLen <= 0) return 0;
  const ratio = ttsSpokenUpTo / ttsFullLen;
  const approxPos = Math.floor(markdown.length * ratio);
  const BOUNDARIES = /[。！？\n.!?]/g;
  let bestPos = approxPos;
  BOUNDARIES.lastIndex = Math.max(0, approxPos - 15);
  let match;
  while ((match = BOUNDARIES.exec(markdown)) !== null) {
    if (match.index >= approxPos) { bestPos = match.index + 1; break; }
  }
  return bestPos;
}

// Apply interruption marker to chat UI; delay DB write so false triggers can be undone
function applyTTSInterruption(spokenUpTo) {
  const originalContent = lastJarvisContent || ttsCurrentText;
  if (!originalContent) return;
  ttsInterruptedOriginalContent = originalContent;
  ttsInterruptionApplied = true;

  const cutPos = findMarkdownCutPos(originalContent, ttsCurrentText.length, spokenUpTo);
  const spokenMarkdown = originalContent.slice(0, cutPos).trimEnd();
  const displayText = spokenMarkdown ? spokenMarkdown + ' ✋' : '✋';
  const dbContent = spokenMarkdown || '✋';

  updateLastJarvisMsg(displayText);

  if (ttsInterruptionDbTimer) clearTimeout(ttsInterruptionDbTimer);
  ttsInterruptionDbTimer = setTimeout(() => {
    ttsInterruptionDbTimer = null;
    fetch(`${API}/tts/interrupted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spokenContent: dbContent }),
    }).catch(() => {});
  }, 4000);
}

// Called by voice-panel interruption detection: stop current TTS and record cut point
window.stopTTS = () => {
  if (ttsStreamingMode && sttsActive) { stopStreamingTTS(); return; }
  if (!ttsAudioEl) return;
  const { remaining, spokenUpTo } = calcRemainingText(
    ttsCurrentText,
    ttsAudioEl.currentTime,
    ttsAudioEl.duration,
  );
  // When duration is not yet loaded (NaN): spokenUpTo=0, remaining='', falls back to full text
  ttsInterruptedRemaining = remaining || ttsCurrentText;
  applyTTSInterruption(spokenUpTo);
  clearTTSAudioGraph();
  ttsAudioEl.pause();
  try { URL.revokeObjectURL(ttsAudioEl.src); } catch {}
  if (ttsStreamReader) { try { ttsStreamReader.cancel(); } catch {} ttsStreamReader = null; }
  ttsAudioEl = null;
};

// Called by voice-panel on impact noise: duck TTS volume without stopping
window.duckTTS = () => {
  if (ttsAudioEl) ttsAudioEl.volume = 0.15;
};

// Called by voice-panel after confirming noise: restore original volume
window.unduckTTS = () => {
  if (ttsAudioEl) ttsAudioEl.volume = 1.0;
};

// Called by voice-panel on false-positive noise: resume TTS from interruption point and restore chat
window.resumeTTSIfNoSpeech = () => {
  const text = ttsInterruptedRemaining;
  ttsInterruptedRemaining = '';
  if (!text) return;
  // Cancel the pending DB write and restore chat UI
  if (ttsInterruptionDbTimer) { clearTimeout(ttsInterruptionDbTimer); ttsInterruptionDbTimer = null; }
  if (ttsInterruptionApplied && ttsInterruptedOriginalContent) {
    updateLastJarvisMsg(ttsInterruptedOriginalContent);
  }
  ttsInterruptionApplied = false;
  ttsInterruptedOriginalContent = '';
  playTTSReply(text);
};

function activateTTSAudioGraph(graph) {
  if (ttsAudioGraph && ttsAudioGraph !== graph) {
    try { ttsAudioGraph.teardown?.(); } catch {}
  }
  ttsAudioGraph = graph || null;
  window.xiaobailongVoice?.setTTSAnalyser?.(ttsAudioGraph?.analyser || null);
}

function clearTTSAudioGraph(graph) {
  if (arguments.length > 0) {
    if (!graph) return;
    if (graph !== ttsAudioGraph) {
      try { graph.teardown?.(); } catch {}
      return;
    }
  }
  if (ttsAudioGraph) {
    try { ttsAudioGraph.teardown?.(); } catch {}
    ttsAudioGraph = null;
  }
  window.xiaobailongVoice?.setTTSAnalyser?.(null);
}

// 接管一个 <audio> 元素开始播放：叠加音色音效、挂起 ASR、注册结束/出错清理。
// revokeUrl 为该元素 src 的 objectURL（播放结束/出错时回收）。多条播放路径共用。
// opts.manageMic：是否由本函数挂起/恢复麦克风（单段播放=true；逐句队列由队列在首尾统一管，传 false）。
// opts.onComplete：播放正常/出错收尾时的回调（队列用它推进下一段）；不传则走默认收尾（恢复麦克风）。
function startTTSAudio(audioEl, revokeUrl, opts = {}) {
  const { manageMic = true, onComplete = null } = opts;
  ttsAudioEl = audioEl;
  audioEl.volume = 1.0; // ensure full volume (avoid residual duck state from previous play)
  const audioGraph = attachJarvisAudioGraph(audioEl, activeTTSVoiceId);
  activateTTSAudioGraph(audioGraph);
  // Suspend cloud ASR but keep the mic hardware open for interruption detection
  if (manageMic) window.xiaobailongVoice?.suspendForTTS?.();
  // 结束/出错收尾。注意：被新一轮播放替换掉的旧元素，其 onerror 可能在 pause/revoke 后迟到触发；
  // 此时全局已指向新元素，必须用 ttsAudioEl===audioEl 守卫，否则会误杀新播放的流读取器和状态。
  const finish = () => {
    clearTTSAudioGraph(audioGraph);
    if (revokeUrl) { try { URL.revokeObjectURL(revokeUrl); } catch {} } // 释放本元素 URL（无论是否当前）
    if (ttsAudioEl !== audioEl) return; // 已不是当前播放对象：仅回收 URL，不动全局
    if (ttsStreamReader) { try { ttsStreamReader.cancel(); } catch {} ttsStreamReader = null; }
    ttsAudioEl = null;
    if (onComplete) { onComplete(); return; } // 队列段：交回队列推进，麦克风/收尾由队列统一管
    ttsCurrentText = '';
    if (manageMic) window.xiaobailongVoice?.resumeAfterMedia();
  };
  audioEl.onended = finish;
  audioEl.onerror = finish;
  // 把这段语音显式路由到真实输出设备（规避被系统默认占用的虚拟/已拔出声卡）。
  // setSinkId 是异步的，但对流式 TTS，首个音频样本要等网络首包到达才流出，
  // 这点路由耗时（毫秒级）远在出声之前完成 → 不必 await，也不会让首音漏到默认设备。
  applyOutputSink(audioEl).catch(() => {});
  audioEl.play().catch(() => {
    clearTTSAudioGraph(audioGraph);
    if (ttsAudioEl !== audioEl) return;
    if (onComplete) { ttsAudioEl = null; onComplete(); return; }
    if (manageMic) window.xiaobailongVoice?.resumeAfterMedia();
  });
}

// 流式播放：把 /tts/stream 的分块响应喂进 MediaSource，首包到达即出声。
function playTTSViaMediaSource(resp, opts = {}) {
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  const audioEl = new Audio(url);
  const isCurrentAudio = () => ttsAudioEl === audioEl;
  startTTSAudio(audioEl, url, opts); // play() 会在缓冲到首包后自动开始
  mediaSource.addEventListener('sourceopen', () => {
    if (!isCurrentAudio()) { try { mediaSource.endOfStream(); } catch {} return; }
    let sb;
    try { sb = mediaSource.addSourceBuffer('audio/mpeg'); }
    catch { try { mediaSource.endOfStream(); } catch {} return; }
    const reader = resp.body.getReader();
    if (!isCurrentAudio()) { try { reader.cancel(); } catch {} return; }
    ttsStreamReader = reader;
    const queue = [];
    let finished = false;
    // appendBuffer 是异步的，更新中不能再次 append；用队列在 updateend 时串行送入
    const flush = () => {
      if (sb.updating) return;
      if (queue.length) { try { sb.appendBuffer(queue.shift()); } catch {} return; }
      if (finished && mediaSource.readyState === 'open') { try { mediaSource.endOfStream(); } catch {} }
    };
    sb.addEventListener('updateend', flush);
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (!isCurrentAudio()) {
            if (ttsStreamReader === reader) ttsStreamReader = null;
            try { reader.cancel(); } catch {}
            break;
          }
          if (done) {
            if (ttsStreamReader === reader) ttsStreamReader = null;
            finished = true; flush(); break;
          }
          if (value && value.byteLength) { queue.push(value); flush(); }
        }
      } catch {
        if (ttsStreamReader === reader) ttsStreamReader = null;
        finished = true; flush();
      } // 被取消/网络中断：收尾，已播部分照常结束
    })();
  }, { once: true });
}

// ── 流式回复文本工具 ───────────────────────────────────────────────────────────
// cleanStreamText, toPlainSpeech, beginStreamingTTS, feedStreamingTTS, etc.
// 已移至 tts-pipeline.js 并通过 import 导入

resetViewBtn?.addEventListener("click", resetZoom);

document.querySelectorAll(".panel, .console, .theme-switcher, .reset-view").forEach(el => {
  el.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
});

physicsControl?.addEventListener("wheel", event => event.stopPropagation(), { passive: true });

window.addEventListener("resize", () => {
  W = window.innerWidth;
  H = window.innerHeight;
  svg.attr("width", W).attr("height", H);
  if (!MEMORY_GRAPH_ENABLED || !sim) return;
  sim.force("center", d3.forceCenter(W / 2, H / 2 - 10))
     .force("x", d3.forceX(W / 2))
     .force("y", d3.forceY(H / 2 - 10))
     .force("radial", d3.forceRadial(180, W / 2, H / 2 - 10));
  updateSimulationForces();
  sim.alpha(5).restart();
});

let _lastVisualRefresh = 0;
d3.timer(() => {
  if (!MEMORY_GRAPH_ENABLED) return true;
  if (glowSet.size === 0 && usePulseSet.size === 0) return;
  const now = Date.now();
  if (now - _lastVisualRefresh < 48) return;
  _lastVisualRefresh = now;
  refreshNodeVisuals();
});

const PERSON_CARD_NON_PERSON_SUBJECT_RE = /(?:项目|功能|系统|工具|代码|文件|文档|文章|报告|方案|计划|任务|流程|架构|设计|页面|网站|应用|app|接口|api|正则|问题|bug|卡片|面板|按钮|图片|视频|音乐|游戏|天气|热点|热搜)/i;
const PERSON_CARD_GENERIC_SUBJECT_RE = /^(?:这个人|那个人|这人|那人|这位|那位|某个人|某位|有人|谁|哪位|什么人|人物|人物卡|人物卡片)$/;

function cleanPersonCardCandidate(value = "") {
  return String(value || "")
    .trim()
    .replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, "")
    .replace(/[，,。.!！：:；;、]+$/g, "")
    .replace(/\s*(?:是谁|是誰|是什么人|是什麼人|是个什么人|是個什麼人|是干嘛的|是幹嘛的)$/g, "")
    .replace(/(?:的)?(?:生平|资料|資料|背景|简介|簡介|履历|履歷|故事|百科|个人资料|個人資料)$/g, "")
    .trim();
}

function looksLikePersonCardName(value = "") {
  const name = cleanPersonCardCandidate(value);
  if (!name || name.length > 32) return false;
  if (PERSON_CARD_NON_PERSON_SUBJECT_RE.test(name)) return false;
  if (PERSON_CARD_GENERIC_SUBJECT_RE.test(name)) return false;
  if (/[?？]/.test(name)) return false;
  if (/(?:帮我|给我|请|麻烦|写|做|生成|打开|关闭|修|改|看下|看看|一下)/.test(name)) return false;

  const compact = name.replace(/\s+/g, "");
  if (/^[\u4e00-\u9fa5·]{2,8}$/.test(compact)) return true;

  const latinName = name.replace(/[·]/g, " ").replace(/\s+/g, " ").trim();
  const latinTokens = latinName.split(" ").filter(Boolean);
  if (latinTokens.length >= 2 && latinTokens.length <= 4) {
    return latinTokens.every(token => /^[A-Za-z][A-Za-z.'-]{1,24}$/.test(token));
  }
  return false;
}

function extractPersonCardQuery(text = "") {
  const value = String(text || "").trim();
  if (!value || /热点|热搜/.test(value)) return "";

  const patterns = [
    /^谁是\s*(.+?)[？?]?$/,
    /^(.+?)\s*(?:是谁|是誰|是什么人|是什麼人|是干嘛的|简介|介绍|资料|履历)[？?]?$/,
    /^(?:介绍一下|介绍下|查一下|了解一下|认识一下)\s*(.+?)[？?]?$/,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    const name = cleanPersonCardCandidate(match?.[1]);
    if (looksLikePersonCardName(name)) return name;
  }
  return "";
}

setAgentName(DEFAULT_AGENT_NAME);
initZoomTheme({ onThemeChange });
readPhysicsSettings();
updatePhysicsReadout();
refreshThemeColors();
chat = initChat({
  apiBase: API,
  maxHistory: MAX_CHAT_HISTORY,
  activationWarmupKey: ACTIVATION_WARMUP_KEY,
  getAgentName: () => agentName,
  defaultInputPlaceholder,
  openSettings: (tab) => openSettingsRef?.(tab),
  onUserMessage: (text) => {
    if (document.body.classList.contains('hotspot-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      toggleHotspot();
      return;
    }
    if (document.body.classList.contains('worldcup-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      toggleWorldcup();
      return;
    }
    if (document.body.classList.contains('person-card-mode') && /关闭|退出|关掉|隐藏/.test(text)) {
      setPersonCardMode(false, { source: 'chat_input' });
      return;
    }
    if (/热点|热搜/.test(text) && !document.body.classList.contains('hotspot-mode')) {
      toggleHotspot();
    }
    if (/世界杯/.test(text) && !document.body.classList.contains('worldcup-mode')) {
      toggleWorldcup();
    }
    const personQuery = extractPersonCardQuery(text);
    if (personQuery) {
      showPersonCardByName(personQuery, { source: 'chat_input' });
    }
  },
});
chat.applyActivationWarmupLock();
if (MEMORY_GRAPH_ENABLED) {
  if (graphEl) graphEl.style.display = "block";
  loadMemories();
  setInterval(() => {
    loadMemories();
  }, 5 * 60 * 1000);
}
connectSSE();
loadAgentProfile();
initPersonCard();
initDocPanel().catch((err) => console.warn('[DocPanel] init failed:', err));
chat.restoreChatHistory();
chat.unlockAudioOnFirstGesture();

bootstrapACUI();
initPanelCollapse();
initWechatPopup();
initHotspot().catch((err) => console.warn('[Hotspot] init failed:', err));
initWorldcup().catch((err) => console.warn('[Worldcup] init failed:', err));
initTTSPipeline({ api: API, updateLastJarvisMsg });
initAudioOutputRouting({ getCurrentAudioEl: () => document.getElementById('tts-audio') });
initTTSSettings();
openSettingsRef = initSettingsPanel(API)?.openSettings;
initVoicePanel({
  btnId:      "voice-btn",
  panelId:    "voice-panel",
  canvasId:   "voice-canvas",
  statusId:   "voice-status",
  transcriptId: "voice-transcript",
  getChatInput:  () => document.getElementById("msg-input"),
  getSendBtn:    () => document.getElementById("send-btn"),
  getSendMessage: (options) => chat?.send?.(options),
  getLang:       () => localStorage.getItem("xiaobailong-voice-lang") || "zh-CN",
  getAutoSend:   () => localStorage.getItem("xiaobailong-voice-auto-send") !== "false",
  getAutoMic:    () => localStorage.getItem("xiaobailong-voice-auto-mic") === "true",
});

function initTTSSettings() {
  const providerSel = document.getElementById("tts-provider-select");
  const voiceSel    = document.getElementById("tts-voice-select");
  const testBtn     = document.getElementById("tts-test-btn");
  const testStatus  = document.getElementById("tts-test-status");
  const fxToggle    = document.getElementById("tts-fx-toggle");
  if (!providerSel) return;

  // 流式合成开关（默认开）：纯播放行为，存在 localStorage
  const streamingToggle = document.getElementById("tts-streaming-toggle");
  if (streamingToggle) {
    streamingToggle.checked = isTTSStreamingEnabled();
    streamingToggle.addEventListener("change", () => setTTSStreamingEnabled(streamingToggle.checked));
  }

  let allVoices = {};

  // ── 机器人音效：开关 + 滑块面板 ──
  const fxSlidersBox = document.getElementById("tts-fx-sliders");
  // 滑块对应的参数键，及数值显示精度
  const FX_SLIDERS = [
    { key: "wet",              digits: 2 },
    { key: "reverbSeconds",    digits: 1 },
    { key: "driveMix",         digits: 2 },
    { key: "metallic",         digits: 2 },
    { key: "ring",             digits: 2 },
    { key: "chorus",           digits: 2 },
    { key: "metallicFeedback", digits: 2 },
    { key: "metallicDelayMs",  digits: 1 },
    { key: "ringHz",           digits: 0 },
  ];

  function loadFxSliders() {
    const p = getJarvisFxParams();
    for (const s of FX_SLIDERS) {
      const el = document.getElementById(`tts-fx-${s.key}`);
      const val = document.getElementById(`tts-fx-${s.key}-val`);
      const v = Number(p[s.key] ?? 0);
      if (el) el.value = v;
      if (val) val.textContent = v.toFixed(s.digits);
    }
  }

  for (const s of FX_SLIDERS) {
    const el = document.getElementById(`tts-fx-${s.key}`);
    const val = document.getElementById(`tts-fx-${s.key}-val`);
    if (!el) continue;
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      setJarvisFxParams({ [s.key]: v });
      if (val) val.textContent = v.toFixed(s.digits);
    });
  }

  const fxReset = document.getElementById("tts-fx-reset");
  if (fxReset) {
    fxReset.addEventListener("click", () => { resetJarvisFxParams(); loadFxSliders(); });
  }

  // 语速滑块（豆包 speech_rate，-50~100，0=正常）：显示更新；存档走保存/试听
  const fmtRate = (r) => (r === 0 ? "正常" : (r > 0 ? "+" + r : String(r)));
  const doubaoRateEl = document.getElementById("tts-doubao-rate");
  const doubaoRateVal = document.getElementById("tts-doubao-rate-val");
  if (doubaoRateEl) {
    doubaoRateEl.addEventListener("input", () => {
      if (doubaoRateVal) doubaoRateVal.textContent = fmtRate(parseInt(doubaoRateEl.value, 10) || 0);
    });
  }

  // 付费解锁
  const fxLockBox = document.getElementById("tts-fx-lock");
  const fxPwInput = document.getElementById("tts-fx-pw");
  const fxUnlockBtn = document.getElementById("tts-fx-unlock");
  const fxUnlockMsg = document.getElementById("tts-fx-unlock-msg");

  // 机器人音效开关跟随当前选中的音色；未解锁则禁用开关+显示付费提示；解锁且开启时展开滑块
  function syncFxToggle() {
    const unlocked = isFxUnlocked();
    const on = unlocked && isFxEnabledForVoice(voiceSel?.value);
    if (fxToggle) { fxToggle.checked = on; fxToggle.disabled = !unlocked; }
    if (fxSlidersBox) fxSlidersBox.style.display = on ? "flex" : "none";
    if (fxLockBox) fxLockBox.style.display = unlocked ? "none" : "flex";
  }
  if (fxToggle) {
    fxToggle.addEventListener("change", () => {
      if (!isFxUnlocked()) { fxToggle.checked = false; syncFxToggle(); return; }
      setFxEnabledForVoice(voiceSel?.value, fxToggle.checked);
      if (fxSlidersBox) fxSlidersBox.style.display = fxToggle.checked ? "flex" : "none";
    });
  }
  if (fxUnlockBtn) {
    fxUnlockBtn.addEventListener("click", () => {
      const res = tryUnlockFx(fxPwInput?.value?.trim() || "");
      if (fxUnlockMsg) {
        fxUnlockMsg.textContent = res.ok ? "已解锁 ✓ 现在可以开启机器人音效了" : res.reason;
        fxUnlockMsg.style.color = res.ok ? "#3ba55d" : "#e05050";
      }
      if (res.ok) syncFxToggle();
    });
  }
  if (voiceSel) {
    voiceSel.addEventListener("change", syncFxToggle);
  }
  loadFxSliders();
  syncFxToggle();

  const credSections = {
    doubao:     document.getElementById("tts-creds-doubao"),
    minimax:    document.getElementById("tts-creds-minimax"),
    openai:     document.getElementById("tts-creds-openai"),
    elevenlabs: document.getElementById("tts-creds-elevenlabs"),
    volcano:    document.getElementById("tts-creds-volcano"),
  };

  function showCredSection(provider) {
    Object.entries(credSections).forEach(([k, el]) => {
      if (el) el.style.display = k === provider ? "" : "none";
    });
  }

  function updateVoiceOptions(provider, savedId) {
    if (!voiceSel) return;
    const voices = allVoices[provider] || [];
    voiceSel.innerHTML = voices.map(v =>
      `<option value="${v.id}">${v.label}</option>`
    ).join('');
    if (savedId && voices.some(v => v.id === savedId)) {
      voiceSel.value = savedId;
    }
    syncFxToggle();
  }

openSettingsRef = initSettingsPanel(API)?.openSettings;

  }

  (() => {
  const videoBtn      = document.getElementById("video-btn");
  const videoExitBtn  = document.getElementById("video-exit-btn");
  const imageExitBtn  = document.getElementById("image-exit-btn");
  const videoFeed     = document.getElementById("video-feed");
  let videoStream     = null;
  let videoActive     = false;
  let videoKind       = "empty";

  function stopCamera() {
    videoStream?.getTracks().forEach(t => t.stop());
    videoStream = null;
  }

  function setPanelVisible(visible) {
    videoActive = Boolean(visible);
    document.body.classList.toggle("video-mode", videoActive);
    videoBtn?.classList.toggle("active", videoActive);
    if (videoActive) moveVoicePanelToBody();
    else restoreVoicePanel();
    window.dispatchEvent(new CustomEvent("xiaobailong:video-mode", {
      detail: { active: videoActive, kind: videoKind },
    }));
  }

  function pauseCurrentVideo() {
    if (videoKind === "youtube") {
      postFrameCommand("pauseVideo");
      playResumeAt = null;
    } else if (videoKind === "bilibili") {
      // bilibili iframe 跨域读不到 currentTime，用 wall-clock 估算累计进度
      if (playResumeAt) {
        const elapsed = (Date.now() - playResumeAt) / 1000;
        currentVideoStart = (Number(currentVideoStart) || 0) + elapsed;
      }
      playResumeAt = null;
      reloadFrameAutoplay(false);
    } else if (videoKind === "file") {
      try { videoFeed?.pause?.(); } catch {}
      playResumeAt = null;
    }
  }

  function resumeCurrentVideo() {
    if (videoKind === "youtube") {
      postFrameCommand("playVideo");
      playResumeAt = Date.now();
    } else if (videoKind === "bilibili") {
      reloadFrameAutoplay(true);
      playResumeAt = Date.now();
    } else if (videoKind === "file") {
      videoFeed?.play?.().catch(() => {});
      playResumeAt = Date.now();
    }
  }

  function resetVideoSurface() {
    stopCamera();
    if (videoFeed) {
      try { videoFeed.pause(); } catch {}
      videoFeed.removeAttribute("src");
      videoFeed.srcObject = null;
      videoFeed.hidden = true;
      videoFeed.load?.();
    }
    if (videoFrame) {
      videoFrame.src = "about:blank";
      videoFrame.hidden = true;
    }
    if (videoBackdrop) videoBackdrop.style.backgroundImage = "";
    videoSurface?.classList.remove("has-media");
    videoKind = "empty";
    currentVideoSource = "";
    currentVideoStart = null;
    playResumeAt = null;
  }

  function toggleVideoPanelVisibility() {
    if (videoActive) {
      pauseCurrentVideo();
      setPanelVisible(false);
    } else {
      if (musicActive) closeMusicPanel();
      setPanelVisible(true);
      if (videoKind !== "empty") resumeCurrentVideo();
    }
  }

  function closeAndDestroyVideo() {
    setPanelVisible(false);
    resetVideoSurface();
  }

  function setVideoModeActive(active) {
    if (!active) {
      closeAndDestroyVideo();
    } else {
      setPanelVisible(true);
    }
  }

  function setBackdrop(kind, url) {
    if (!videoBackdrop) return;
    if (kind === "youtube") {
      const id = extractYoutubeId(url);
      if (id) {
        videoBackdrop.style.backgroundImage =
          `url(https://img.youtube.com/vi/${id}/maxresdefault.jpg)`;
        return;
      }
    }
    // Bilibili / file / camera: solid color fallback (CSS already sets #000 background)
    videoBackdrop.style.backgroundImage = "";
  }

  async function showCamera({ title = "Camera", autoplay = true } = {}) {
    setPanelVisible(true);
    resetVideoSurface();
    if (videoTitle) videoTitle.textContent = title;
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (videoFeed) {
        videoFeed.hidden = false;
        videoFeed.muted = true;
        videoFeed.srcObject = videoStream;
        if (autoplay) videoFeed.play?.().catch(() => {});
      }
      videoSurface?.classList.add("has-media");
      videoKind = "camera";
    } catch (e) {
      console.warn("Camera access failed:", e);
    }
  }

  async function showVideo({
    url = "", title = "Video", autoplay = true,
    muted = false, volume = null, currentTime = null, camera = false,
  } = {}) {
    if (camera) { showCamera({ title, autoplay }); return; }

    const source = normalizeUrl(url);
    if (musicActive) closeMusicPanel();
    setPanelVisible(true);
    resetVideoSurface();
    currentVideoSource = source;
    currentVideoStart = Number.isFinite(Number(currentTime)) ? Math.max(0, Number(currentTime)) : null;
    if (videoTitle) videoTitle.textContent = title || "Video";

    const embedUrl = iframeUrlFor(source, { autoplay, start: currentTime });
    if (embedUrl && videoFrame) {
      videoFrame.hidden = false;
      videoFrame.src = embedUrl;
      videoSurface?.classList.add("has-media");
      videoKind = embedUrl.includes("youtube.com") ? "youtube" : "bilibili";
      if (autoplay) playResumeAt = Date.now();

      setBackdrop(videoKind, source);
      saveMediaHistory({
        url: source,
        title,
        kind: videoKind,
        videoId: videoKind === "youtube" ? extractYoutubeId(source) : extractBilibiliId(source),
        platform: videoKind,
      });

      if (videoKind === "youtube") {
        validateYoutubeUrl(source).then(ok => {
          if (ok === false) console.warn("[Media] YouTube video may not play (region block / private / deleted):", source);
        });
      }
      return;
    }

    if (videoFeed && source) {
      videoFeed.hidden = false;
      videoFeed.src = source;
      videoFeed.muted = Boolean(muted);
      if (Number.isFinite(Number(volume))) videoFeed.volume = Math.max(0, Math.min(1, Number(volume)));
      if (Number.isFinite(Number(currentTime))) videoFeed.currentTime = Math.max(0, Number(currentTime));
      videoSurface?.classList.add("has-media");
      videoKind = "file";
      saveMediaHistory({ url: source, title, kind: "file" });
      if (autoplay) {
        videoFeed.play?.().catch(() => {});
        playResumeAt = Date.now();
      }
    }
  }

  function postFrameCommand(command, args = []) {
    if (!videoFrame?.contentWindow || videoFrame.hidden) return;
    if (videoKind === "youtube") {
      videoFrame.contentWindow.postMessage(JSON.stringify({
        event: "command",
        func: command,
        args,
      }), "*");
    }
  }

  function reloadFrameAutoplay(autoplay) {
    if (!videoFrame || videoFrame.hidden || !currentVideoSource) return;
    const nextUrl = iframeUrlFor(currentVideoSource, {
      autoplay,
      start: currentVideoStart,
    });
    if (nextUrl) videoFrame.src = nextUrl;
  }

  function controlVideo({ action, volume, currentTime, autoplay } = {}) {
    const op = action || (autoplay ? "play" : null);
    if (op === "hide" || op === "close") { closeAndDestroyVideo(); return; }
    if (op === "play") resumeCurrentVideo();
    if (op === "pause") pauseCurrentVideo();
    if (Number.isFinite(Number(volume))) {
      const v = Math.max(0, Math.min(1, Number(volume)));
      if (videoFeed) { videoFeed.volume = v; videoFeed.muted = v === 0; }
      postFrameCommand("setVolume", [Math.round(v * 100)]);
    }
    if (Number.isFinite(Number(currentTime))) {
      const t = Math.max(0, Number(currentTime));
      currentVideoStart = t;
      if (videoFeed) videoFeed.currentTime = t;
      postFrameCommand("seekTo", [t, true]);
      // seek 后重置 elapsed 基线，下次 pause 时累计才正确
      if (playResumeAt) playResumeAt = Date.now();
    }
  }

  function setImageModeActive(active) {
    imageActive = Boolean(active);
    document.body.classList.toggle("image-mode", imageActive);
    if (!imageActive && imageDisplay) {
      imageDisplay.removeAttribute("src");
      imageDisplay.alt = "";
      imageSurface?.classList.remove("has-media");
    }
  }

  function showImage({ url = "", title = "Image", alt = "" } = {}) {
    const source = normalizeUrl(url);
    setImageModeActive(true);
    if (imageTitle) imageTitle.textContent = title || "Image";
    if (imageDisplay && source) {
      imageDisplay.src = source;
      imageDisplay.alt = alt || title || "";
      imageSurface?.classList.add("has-media");
    }
  }

  function handleMediaCommand(payload = {}) {
    const mode   = payload.mode || payload.kind;
    const action = payload.action || "show";
    if (mode === "image") {
      if (action === "hide" || action === "close") setImageModeActive(false);
      else showImage(payload);
      return { ok: true, mode: "image", action };
    }
    if (mode === "camera") {
      if (action === "hide" || action === "close") closeAndDestroyVideo();
      else showCamera(payload);
      return { ok: true, mode: "camera", action };
    }
    if (mode === "video") {
      if (action === "show" || payload.url || payload.camera) showVideo(payload);
      else controlVideo(payload);
      return { ok: true, mode: "video", action };
    }
    if (mode === "music") {
      if (action === "show" || payload.src || payload.playlist) showMusic(payload);
      else controlMusic(payload);
      return { ok: true, mode: "music", action };
    }
    return { ok: false, error: "unknown media mode" };
  }

  // ── Music mode ────────────────────────────────────────────────────────────
  const musicBtn       = document.getElementById("music-btn");
  const musicExitBtn   = document.getElementById("music-exit-btn");
  const musicAudio     = document.getElementById("music-audio");
  const musicPlayBtn   = document.getElementById("music-play");
  const musicPrevBtn   = document.getElementById("music-prev");
  const musicNextBtn   = document.getElementById("music-next");
  const musicSeek      = document.getElementById("music-seek");
  const musicVolInput  = document.getElementById("music-vol");
  const musicTimeCur   = document.getElementById("music-time-cur");
  const musicTimeTotal = document.getElementById("music-time-total");
  const musicMetaTitle  = document.getElementById("music-meta-title");
  const musicMetaArtist = document.getElementById("music-meta-artist");
  const musicCoverEl    = document.getElementById("music-cover");
  const musicCoverTitle = document.getElementById("music-cover-title");
  const musicCoverArtist = document.getElementById("music-cover-artist");
  const musicLyricsScroll = document.getElementById("music-lyrics-scroll");
  const musicNoLyrics     = document.getElementById("music-no-lyrics");

  let musicActive  = false;
  let musicPlaying = false;
  let musicWasPlayingBeforeHide = false;
  let lrcLines     = [];
  let playlist     = [];
  let playlistIdx  = 0;
  let isSeeking    = false;

  function parseLrc(text) {
    const lines = [];
    const re = /\[(\d+):(\d{1,2}(?:\.\d+)?)\](.*)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const t = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
      const txt = m[3].trim();
      if (txt) lines.push({ time: t, text: txt });
    }
    return lines.sort((a, b) => a.time - b.time);
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return "0:00";
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  }

  function setMusicPanelVisible(visible) {
    musicActive = Boolean(visible);
    document.body.classList.toggle("music-mode", musicActive);
    musicBtn?.classList.toggle("active", musicActive);
    window.dispatchEvent(new CustomEvent("xiaobailong:music-mode", {
      detail: { active: musicActive },
    }));
  }

  function setMusicPlaying(playing) {
    musicPlaying = Boolean(playing);
    document.body.classList.toggle("music-playing", musicPlaying);
    if (musicPlayBtn) musicPlayBtn.textContent = musicPlaying ? "⏸" : "▶";
    if (musicPlaying) {
      musicAudio?.play?.().catch(() => {});
    } else {
      musicAudio?.pause?.();
    }
  }

  function loadLrc(lrcText) {
    lrcLines = lrcText ? parseLrc(lrcText) : [];
    if (musicLyricsScroll) {
      musicLyricsScroll.innerHTML = lrcLines
        .map((l, i) => `<div class="lrc-line" data-idx="${i}">${l.text}</div>`)
        .join("");
    }
    if (musicNoLyrics) musicNoLyrics.hidden = lrcLines.length > 0;
  }

  function syncLyrics(currentTime) {
    if (!lrcLines.length || !musicLyricsScroll) return;
    let active = -1;
    for (let i = 0; i < lrcLines.length; i++) {
      if (lrcLines[i].time <= currentTime + 0.3) active = i;
      else break;
    }
    if (active < 0) return;
    const lines = musicLyricsScroll.querySelectorAll(".lrc-line");
    lines.forEach((el, i) => el.classList.toggle("active", i === active));
    const activeLine = lines[active];
    if (activeLine) {
      const pane = document.getElementById("music-lyrics-pane");
      if (pane) pane.scrollTo({ top: activeLine.offsetTop - pane.clientHeight / 2 + activeLine.clientHeight / 2, behavior: "smooth" });
    }
  }

  function loadTrack(index, autoplay = true) {
    const track = playlist[index];
    if (!track || !musicAudio) return;

    musicAudio.src = localPathToUrl(track.src || "");
    musicAudio.volume = parseFloat(musicVolInput?.value ?? "0.8");

    const title  = track.title  || "未知曲目";
    const artist = track.artist || "";
    if (musicMetaTitle)  musicMetaTitle.textContent  = title;
    if (musicMetaArtist) musicMetaArtist.textContent = artist;
    if (musicCoverTitle)  musicCoverTitle.textContent  = title.slice(0, 14);
    if (musicCoverArtist) musicCoverArtist.textContent = artist;
    if (musicTimeCur)   musicTimeCur.textContent   = "0:00";
    if (musicTimeTotal) musicTimeTotal.textContent = "0:00";
    if (musicSeek)      { musicSeek.value = "0"; musicSeek.max = "100"; }

    if (track.cover && musicCoverEl) {
      musicCoverEl.style.backgroundImage = `url(${track.cover})`;
      musicCoverEl.style.background = "";
    } else if (musicCoverEl) {
      musicCoverEl.style.backgroundImage = "";
      let hash = 0;
      for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff;
      const hue = Math.abs(hash) % 360;
      musicCoverEl.style.background = `hsl(${hue}, 45%, 32%)`;
    }

    loadLrc(track.lrc || "");
    if (autoplay) setMusicPlaying(true);
  }

  function showMusic({
    src = "", title = "", artist = "", lrc = "", cover = "",
    autoplay = true, playlist: pl = null,
  } = {}) {
    if (videoActive) closeAndDestroyVideo();
    setMusicPanelVisible(true);
    if (pl && pl.length) {
      playlist = pl;
    } else {
      playlist = [{ src, title, artist, lrc, cover }];
    }
    playlistIdx = 0;
    loadTrack(0, autoplay);
  }

  function closeMusicPanel() {
    setMusicPlaying(false);
    setMusicPanelVisible(false);
    if (musicAudio) musicAudio.src = "";
    lrcLines = [];
    if (musicLyricsScroll) musicLyricsScroll.innerHTML = "";
    if (musicNoLyrics) musicNoLyrics.hidden = false;
  }

  function controlMusic({ action, volume, currentTime } = {}) {
    if (action === "hide" || action === "close") { closeMusicPanel(); return; }
    if (action === "play")  setMusicPlaying(true);
    if (action === "pause") setMusicPlaying(false);
    if (Number.isFinite(Number(volume))) {
      const v = Math.max(0, Math.min(1, Number(volume)));
      if (musicAudio) musicAudio.volume = v;
      if (musicVolInput) musicVolInput.value = String(v);
    }
    if (Number.isFinite(Number(currentTime)) && musicAudio) {
      musicAudio.currentTime = Math.max(0, Number(currentTime));
    }
  }

  function toggleMusicPanelVisibility() {
    if (musicActive) {
      musicWasPlayingBeforeHide = musicPlaying;
      setMusicPlaying(false);
      setMusicPanelVisible(false);
    } else if (musicAudio?.src) {
      if (videoActive) closeAndDestroyVideo();
      setMusicPanelVisible(true);
      if (musicWasPlayingBeforeHide) setMusicPlaying(true);
    }
  }

  if (musicAudio) {
    musicAudio.addEventListener("loadedmetadata", () => {
      if (musicTimeTotal) musicTimeTotal.textContent = fmtTime(musicAudio.duration);
      if (musicSeek) musicSeek.max = String(musicAudio.duration || 100);
    });
    musicAudio.addEventListener("timeupdate", () => {
      if (isSeeking) return;
      const t = musicAudio.currentTime;
      if (musicTimeCur) musicTimeCur.textContent = fmtTime(t);
      if (musicSeek && musicAudio.duration) musicSeek.value = String(t);
      syncLyrics(t);
    });
    musicAudio.addEventListener("ended", () => {
      setMusicPlaying(false);
      if (playlistIdx < playlist.length - 1) {
        playlistIdx++;
        loadTrack(playlistIdx, true);
      }
    });
  }

  musicPlayBtn?.addEventListener("click", () => setMusicPlaying(!musicPlaying));
  musicPrevBtn?.addEventListener("click", () => {
    if (playlistIdx > 0) { playlistIdx--; loadTrack(playlistIdx, musicPlaying); }
    else if (musicAudio) musicAudio.currentTime = 0;
  });
  musicNextBtn?.addEventListener("click", () => {
    if (playlistIdx < playlist.length - 1) { playlistIdx++; loadTrack(playlistIdx, musicPlaying); }
  });
  musicVolInput?.addEventListener("input", () => {
    if (musicAudio) musicAudio.volume = parseFloat(musicVolInput.value);
  });
  musicSeek?.addEventListener("mousedown", () => { isSeeking = true; });
  musicSeek?.addEventListener("input", () => {
    if (musicTimeCur) musicTimeCur.textContent = fmtTime(parseFloat(musicSeek.value));
  });
  musicSeek?.addEventListener("change", () => {
    if (musicAudio) musicAudio.currentTime = parseFloat(musicSeek.value);
    isSeeking = false;
  });
  musicExitBtn?.addEventListener("click", closeMusicPanel);
  musicBtn?.addEventListener("click", toggleMusicPanelVisibility);

  window.addEventListener("keydown", (e) => {
    if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA" || e.target?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      toggleMusicPanelVisibility();
    }
  });

  window.xiaobailongMedia = { handle: handleMediaCommand, showVideo, controlVideo, showImage, showCamera, showMusic, controlMusic };
  window.addEventListener("xiaobailong:media", (event) => handleMediaCommand(event.detail || {}));

  // Push-to-talk：按住空格说话；Agent 正在说话时按下空格直接打断
  (() => {
    let pttHeld = false;
    const isSpace = (e) => e.code === "Space" || e.key === " " || e.key === "Spacebar";
    const isTypingTarget = (t) =>
      !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    window.addEventListener("keydown", (e) => {
      if (!isSpace(e)) return;
      if (isTypingTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      if (e.repeat) return;
      if (pttHeld) return;
      pttHeld = true;
      // 不论是否在播，stopTTS 内部已做 no-op 守卫
      try { window.stopTTS?.(); } catch {}
      window.xiaobailongVoice?.pttStart?.();
    }, { capture: true });

    window.addEventListener("keyup", (e) => {
      if (!isSpace(e)) return;
      if (!pttHeld) return;
      pttHeld = false;
      e.preventDefault();
      window.xiaobailongVoice?.pttEnd?.();
    }, { capture: true });

    // 切到后台/失焦（如点开 DevTools、切窗口）时如果还按着，强制释放 PTT，避免 mic 永远不关。
    // 关键：用 send:false —— 失焦不是"主动松手发送"，不能把没说完的半句误发出去。
    window.addEventListener("blur", () => {
      if (!pttHeld) return;
      pttHeld = false;
      window.xiaobailongVoice?.pttEnd?.({ send: false });
    });
  })();

  videoBtn?.addEventListener("click", toggleVideoPanelVisibility);
  videoExitBtn?.addEventListener("click", closeAndDestroyVideo);
  imageExitBtn?.addEventListener("click", () => setImageModeActive(false));

  window.addEventListener("keydown", (e) => {
    if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA" || e.target?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "v" || e.key === "V") {
      e.preventDefault();
      toggleVideoPanelVisibility();
    }
    // H key: toggle hotspot mode
    if (e.key === "h" || e.key === "H") {
      e.preventDefault();
      toggleHotspot();
    }
  });
})();


initAIVideoMode();
