/**
 * ═══════════════════════════════════════════════════════
 *  JARVIS 全息球体 + 数据流光点
 *  参考：科幻驾驶舱 AI 全息控制台
 * ═══════════════════════════════════════════════════════
 */
(function () {
  'use strict';

  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // ── 配置 ────────────────────────────────────────────
  const CONFIG = {
    // 球体
    sphereRadius: 120,
    nodeCount: 60,
    nodeColor: 'rgba(0, 210, 255, 0.8)',
    nodeGlow: '#00d0ff',
    linkColor: 'rgba(0, 210, 255, 0.18)',
    linkMaxDist: 0.6, // 球体半径的比例

    // 数据流光点
    streamCount: 20,
    streamColor: '#ffffff',
    streamGlow: '#00d0ff',
    streamSpeed: 0.003,
    streamSize: 2,

    // 背景粒子
    bgParticleCount: 40,
    bgParticleColor: 'rgba(0, 210, 255, 0.15)',
    bgSpeed: 0.15,
  };

  // ── 状态 ────────────────────────────────────────────
  let W, H, dpr;
  let centerX, centerY;
  let sphereNodes = [];
  let sphereLinks = [];
  let streamPoints = [];
  let bgParticles = [];
  let animFrame;

  // ── 工具函数 ────────────────────────────────────────
  function rand(min, max) { return Math.random() * (max - min) + min; }

  // ── 初始化球体节点 ──────────────────────────────────
  function initSphere() {
    sphereNodes = [];
    const R = CONFIG.sphereRadius;
    for (let i = 0; i < CONFIG.nodeCount; i++) {
      const phi = Math.acos(-1 + (2 * i) / CONFIG.nodeCount);
      const theta = Math.sqrt(CONFIG.nodeCount * Math.PI) * phi;
      const x = centerX + R * Math.sin(phi) * Math.cos(theta);
      const y = centerY + R * Math.sin(phi) * Math.sin(theta);
      sphereNodes.push({
        x, y,
        baseX: x,
        baseY: y,
        size: Math.random() * 1.2 + 0.8
      });
    }

    // 球体内部连线
    sphereLinks = [];
    for (let i = 0; i < sphereNodes.length; i++) {
      for (let j = i + 1; j < sphereNodes.length; j++) {
        const dist = Math.hypot(sphereNodes[i].x - sphereNodes[j].x, sphereNodes[i].y - sphereNodes[j].y);
        if (dist < R * CONFIG.linkMaxDist) {
          sphereLinks.push({ from: i, to: j });
        }
      }
    }
  }

  // ── 数据流光点 ──────────────────────────────────────
  let streamPoints = [];

  function initStreams() {
    streamPoints = [];
    // 从球体中心向四周辐射的数据流线
    const angles = [];
    const streamCount = CONFIG.streamCount;
    for (let i = 0; i < streamCount; i++) {
      angles.push((Math.PI * 2 * i) / streamCount);
    }

    angles.forEach((angle, idx) => {
      const endX = centerX + Math.cos(angle) * (Math.max(W, H) * 0.6);
      const endY = centerY + Math.sin(angle) * (Math.max(W, H) * 0.6);
      streamPoints.push({
        startX: centerX,
        startY: centerY,
        endX: endX,
        endY: endY,
        progress: Math.random(),
        speed: CONFIG.streamSpeed + Math.random() * 0.002,
      });
    });
  }

  // ── 背景漂浮粒子 ────────────────────────────────────
  let bgParticles = [];

  function initBgParticles() {
    bgParticles = [];
    for (let i = 0; i < CONFIG.bgParticleCount; i++) {
      bgParticles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * CONFIG.bgSpeed,
        vy: (Math.random() - 0.5) * CONFIG.bgSpeed,
        size: Math.random() * 1.5 + 0.5,
      });
    }
  }

  // ── 尺寸调整 ────────────────────────────────────────
  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    centerX = W / 2;
    centerY = H / 2;

    initSphere();
    initStreams();
    initBgParticles();
  }

  // ── 渲染球体 ────────────────────────────────────────
  function renderSphere(time) {
    const R = CONFIG.sphereRadius;

    // 球体外层弱光晕
    ctx.globalAlpha = 0.12;
    const radialGrad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, R);
    radialGrad.addColorStop(0, 'rgba(0, 210, 255, 0.25)');
    radialGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = radialGrad;
    ctx.beginPath();
    ctx.arc(centerX, centerY, R, 0, Math.PI * 2);
    ctx.fill();

    // 绘制内部连线
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = CONFIG.linkColor;
    ctx.lineWidth = 1;
    sphereLinks.forEach(link => {
      const n1 = sphereNodes[link.from];
      const n2 = sphereNodes[link.to];
      ctx.beginPath();
      ctx.moveTo(n1.x, n1.y);
      ctx.lineTo(n2.x, n2.y);
      ctx.stroke();
    });

    // 绘制节点 + 浮动
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = CONFIG.nodeGlow;
    ctx.shadowBlur = 6;
    sphereNodes.forEach(node => {
      node.x += (node.baseX - node.x) * 0.02;
      node.y += (node.baseY - node.y) * 0.02;
      node.x += Math.sin(time * 0.0007 + node.x * 0.01) * 0.2;
      node.y += Math.cos(time * 0.0007 + node.y * 0.01) * 0.2;

      ctx.beginPath();
      ctx.arc(node.x, node.y, node.size, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.shadowBlur = 0;
  }

  // ── 渲染数据流光点 ──────────────────────────────────
  function renderStreams() {
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = 'rgba(0, 210, 255, 0.12)';
    ctx.lineWidth = 1;

    // 绘制连线
    streamPoints.forEach(point => {
      ctx.beginPath();
      ctx.moveTo(point.startX, point.startY);
      ctx.lineTo(point.endX, point.endY);
      ctx.stroke();
    });

    // 绘制流动光点
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = CONFIG.streamColor;
    ctx.shadowColor = CONFIG.streamGlow;
    ctx.shadowBlur = 5;
    streamPoints.forEach(point => {
      const currX = point.startX + (point.endX - point.startX) * point.progress;
      const currY = point.startY + (point.endY - point.startY) * point.progress;

      ctx.beginPath();
      ctx.arc(currX, currY, CONFIG.streamSize, 0, Math.PI * 2);
      ctx.fill();

      point.progress += point.speed;
      if (point.progress > 1) point.progress = 0;
    });
    ctx.shadowBlur = 0;
  }

  // ── 渲染背景粒子 ────────────────────────────────────
  function renderBgParticles() {
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = CONFIG.bgParticleColor;
    bgParticles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = W;
      if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H;
      if (p.y > H) p.y = 0;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // ── 主循环 ──────────────────────────────────────────
  let animFrame;
  let lastTime = 0;

  function loop(timestamp) {
    const dt = Math.min((timestamp - lastTime) / 16, 3);
    lastTime = timestamp;

    ctx.clearRect(0, 0, W, H);

    renderBgParticles();
    renderStreams();
    renderSphere(timestamp);

    animFrame = requestAnimationFrame(loop);
  }

  // ── 事件绑定 ────────────────────────────────────────
  window.addEventListener('resize', resize);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(animFrame);
    } else {
      lastTime = performance.now();
      animFrame = requestAnimationFrame(loop);
    }
  });

  // ── 启动 ────────────────────────────────────────────
  resize();
  animFrame = requestAnimationFrame(loop);
})();
