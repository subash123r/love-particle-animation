(() => {
  "use strict";

  // ---------- Elements ----------
  const canvas = document.getElementById("particleCanvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const topText = document.getElementById("topText");
  const bottomText = document.getElementById("bottomText");
  const restartBtn = document.getElementById("restartBtn");

  // ---------- Settings ----------
  const IMAGE_SRC = "./love.jpg";
  const TOP_MESSAGE = "Love You 3000";
  const BOTTOM_MESSAGE = "Sorry Brownie";
  const FONT_FAMILY = '"Dancing Script","Brush Script MT",cursive';

  // Seconds
  const SWEEP = 3.4;                       // image draws itself top -> bottom
  const TOP_ANIM = { start: 2.6, dur: 2.8 };
  const BOTTOM_ANIM = { start: 4.4, dur: 2.8 };
  const DONE_AT = 8;

  const EDGE_RELATIVE = 0.17;              // fraction of strongest edge kept
  const EDGE_MIN = 28;
  const MOUSE_RADIUS = 85;

  const DOT_COLORS = ["#ffd9e6", "#ffc2da", "#f5a3c4", "#e58fb0", "#fff0f5"];
  const SHADE_COLORS = ["#e1a5b9", "#c98ba0", "#b9748d"];

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  topText.textContent = TOP_MESSAGE;
  bottomText.textContent = BOTTOM_MESSAGE;

  // ---------- State ----------
  let W = 0, H = 0, dpr = 1;
  let time = 0, lastTs = 0, rafId = 0, loadToken = 0, resizeTimer = 0;
  let particles = [];
  let dust = [];
  let hearts = [];
  let beat = 0;
  let cachedImg = null;
  let layout = {};
  const pointer = { x: -9999, y: -9999, active: false };

  const bg = document.createElement("canvas");
  const sprite = makeGlowSprite();

  // ---------- Helpers ----------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const easeInOutSine = x => -(Math.cos(Math.PI * x) - 1) / 2;

  function makeGlowSprite() {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,190,215,1)");
    grad.addColorStop(0.35, "rgba(240,140,180,0.45)");
    grad.addColorStop(1, "rgba(220,110,160,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    return c;
  }

  // ---------- Canvas + layout ----------
  function resizeCanvas() {
    W = window.innerWidth;
    H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Pre-render the background once.
    bg.width = canvas.width;
    bg.height = canvas.height;
    const b = bg.getContext("2d");
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = b.createRadialGradient(W / 2, H * 0.5, 0, W / 2, H * 0.5, Math.max(W, H) * 0.75);
    g.addColorStop(0, "#1b1228");
    g.addColorStop(0.55, "#0e0b19");
    g.addColorStop(1, "#06060d");
    b.fillStyle = g;
    b.fillRect(0, 0, W, H);

    const topSize = clamp(Math.min(W * 0.095, H * 0.105), 34, 86);
    const bottomSize = topSize * 0.8;
    const topY = Math.max(H * 0.105, topSize * 0.95);
    const bottomY = H - Math.max(H * 0.1, bottomSize * 1.2);
    const imgTop = topY + topSize * 0.95;
    const imgBottom = bottomY - bottomSize * 0.95;
    layout = {
      topSize, bottomSize, topY, bottomY,
      availW: W * 0.82,
      availH: Math.max(80, imgBottom - imgTop),
      centerY: (imgTop + imgBottom) / 2
    };

    hearts = Array.from({ length: clamp(Math.round(W / 110), 6, 14) }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      s: 4 + Math.random() * 7,
      v: 14 + Math.random() * 20,
      p: Math.random() * 6.28
    }));

    const n = clamp(Math.round((W * H) / 22000), 18, 55);
    dust = Array.from({ length: n }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      s: 0.5 + Math.random() * 1.2,
      v: 6 + Math.random() * 14,
      a: 0.1 + Math.random() * 0.25,
      p: Math.random() * 6.28
    }));
  }

  // ---------- Image -> clean thin outline points ----------
  function sampleGrid(cands, gap, existing = []) {
    const map = new Map();
    const key = (cx, cy) => cx * 100003 + cy;
    const minD2 = (gap * 0.78) ** 2;
    const put = c => {
      const k = key(Math.floor(c.x / gap), Math.floor(c.y / gap));
      const arr = map.get(k);
      if (arr) arr.push(c); else map.set(k, [c]);
    };
    existing.forEach(put);

    const out = [];
    for (const c of cands) {
      const cx = Math.floor(c.x / gap), cy = Math.floor(c.y / gap);
      let ok = true;
      for (let dx = -1; dx <= 1 && ok; dx++) {
        for (let dy = -1; dy <= 1 && ok; dy++) {
          const arr = map.get(key(cx + dx, cy + dy));
          if (!arr) continue;
          for (const q of arr) {
            const ex = q.x - c.x, ey = q.y - c.y;
            if (ex * ex + ey * ey < minD2) { ok = false; break; }
          }
        }
      }
      if (ok) { put(c); out.push(c); }
    }
    return out;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function limitPoints(cands) {
    const max = clamp(Math.round((W * H) / 750), 900, 2300);
    let gap = 2.5;
    let pts = sampleGrid(cands, gap);
    while (pts.length > max && gap < 14) {
      gap *= 1.12;
      pts = sampleGrid(cands, gap);
    }
    return { pts, gap };
  }

  function edgePoints(img) {
    const scale = Math.min(layout.availW / img.width, layout.availH / img.height);
    const iw = Math.max(8, Math.floor(img.width * scale));
    const ih = Math.max(8, Math.floor(img.height * scale));

    const tmp = document.createElement("canvas");
    tmp.width = iw; tmp.height = ih;
    const t = tmp.getContext("2d", { willReadFrequently: true });
    t.fillStyle = "#fff";
    t.fillRect(0, 0, iw, ih);
    t.drawImage(img, 0, 0, iw, ih);
    const d = t.getImageData(0, 0, iw, ih).data;

    const gray = new Float32Array(iw * ih);
    for (let i = 0; i < d.length; i += 4) {
      gray[i >> 2] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }

    const blur = new Float32Array(gray.length);
    for (let y = 1; y < ih - 1; y++) {
      for (let x = 1; x < iw - 1; x++) {
        const i = y * iw + x;
        blur[i] = (gray[i - iw - 1] + gray[i - iw] + gray[i - iw + 1] +
                   gray[i - 1] + gray[i] + gray[i + 1] +
                   gray[i + iw - 1] + gray[i + iw] + gray[i + iw + 1]) / 9;
      }
    }

    const mag = new Float32Array(iw * ih);
    const gxA = new Float32Array(iw * ih);
    const gyA = new Float32Array(iw * ih);
    let maxMag = 0;
    for (let y = 1; y < ih - 1; y++) {
      for (let x = 1; x < iw - 1; x++) {
        const i = y * iw + x;
        const gx = -blur[i - iw - 1] + blur[i - iw + 1] - 2 * blur[i - 1] + 2 * blur[i + 1] - blur[i + iw - 1] + blur[i + iw + 1];
        const gy = -blur[i - iw - 1] - 2 * blur[i - iw] - blur[i - iw + 1] + blur[i + iw - 1] + 2 * blur[i + iw] + blur[i + iw + 1];
        const m = Math.hypot(gx, gy);
        mag[i] = m; gxA[i] = gx; gyA[i] = gy;
        if (m > maxMag) maxMag = m;
      }
    }

    const thr = Math.max(EDGE_MIN, maxMag * EDGE_RELATIVE);
    const offX = (W - iw) / 2;
    const offY = layout.centerY - ih / 2;
    const cands = [];

    // Non-maximum suppression -> 1px-thin edges (this is what makes it look clean)
    for (let y = 1; y < ih - 1; y++) {
      for (let x = 1; x < iw - 1; x++) {
        const i = y * iw + x;
        const m = mag[i];
        if (m < thr) continue;
        const ax = Math.abs(gxA[i]), ay = Math.abs(gyA[i]);
        let a, b;
        if (ay <= 0.4142 * ax) { a = i - 1; b = i + 1; }
        else if (ay >= 2.4142 * ax) { a = i - iw; b = i + iw; }
        else if (gxA[i] * gyA[i] > 0) { a = i - iw - 1; b = i + iw + 1; }
        else { a = i - iw + 1; b = i + iw - 1; }
        if (m > mag[a] && m >= mag[b]) cands.push({ x: x + offX, y: y + offY, m });
      }
    }

    if (cands.length < 30) return heartPoints();
    cands.sort((p, q) => q.m - p.m);
    const base = limitPoints(cands);

    // Shading layer: sparse, smaller dots where the photo is "inked",
    // so faces and shapes get depth instead of only an outline.
    let sum = 0, cnt = 0;
    for (let x = 1; x < iw - 1; x += 3) { sum += gray[iw + x] + gray[(ih - 2) * iw + x]; cnt += 2; }
    for (let y = 1; y < ih - 1; y += 3) { sum += gray[y * iw + 1] + gray[y * iw + iw - 2]; cnt += 2; }
    const brightBg = sum / cnt > 120;

    const stip = [];
    for (let y = 2; y < ih - 2; y++) {
      for (let x = 2; x < iw - 2; x++) {
        const i = y * iw + x;
        const tone = brightBg ? 1 - blur[i] / 255 : blur[i] / 255;
        const t = clamp((tone - 0.3) / 0.7, 0, 1);
        if (t > 0 && Math.random() < t * 0.3) {
          stip.push({ x: x + offX, y: y + offY, m: 0, stip: true });
        }
      }
    }
    shuffle(stip);

    const stipMax = Math.round(base.pts.length * 0.85);
    let g2 = base.gap * 1.7;
    let st = sampleGrid(stip, g2, base.pts);
    while (st.length > stipMax && g2 < 24) {
      g2 *= 1.1;
      st = sampleGrid(stip, g2, base.pts);
    }
    return { pts: base.pts.concat(st), gap: base.gap };
  }

  function heartPoints() {
    const s = Math.min(layout.availW / 36, layout.availH / 34);
    const cx = W / 2, cy = layout.centerY - 2 * s;
    const cands = [];
    for (const k of [1, 0.68]) {
      for (let t = 0; t < Math.PI * 2; t += 0.004) {
        const x = 16 * Math.pow(Math.sin(t), 3);
        const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        cands.push({ x: cx + x * s * k, y: cy + y * s * k, m: 1 });
      }
    }
    return limitPoints(cands);
  }

  // ---------- Build particles ----------
  function start(result, instant) {
    const { pts, gap } = result;
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const span = Math.max(1, maxY - minY);

    particles = pts.map(p => {
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.max(W, H) * (0.35 + Math.random() * 0.4);
      return {
        tx: p.x, ty: p.y,
        x: instant ? p.x : W / 2 + Math.cos(ang) * rad,
        y: instant ? p.y : H / 2 + Math.sin(ang) * rad,
        vx: 0, vy: 0,
        k: 30 + Math.random() * 22,
        delay: ((p.y - minY) / span) * SWEEP * 0.75 + Math.random() * 0.45 + (p.stip ? 0.9 : 0),
        a: instant ? 1 : 0,
        r: p.stip ? 0.75 + Math.random() * 0.5 : 1.15 + Math.random() * 0.9,
        w: p.stip ? 0.6 : 1,
        c: p.stip
          ? SHADE_COLORS[(Math.random() * SHADE_COLORS.length) | 0]
          : DOT_COLORS[(Math.random() * DOT_COLORS.length) | 0],
        ph: Math.random() * 6.283
      };
    });

    time = instant ? DONE_AT : 0;
    lastTs = 0;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(frame);
  }

  function loadTargets(instant = false) {
    const token = ++loadToken;
    const go = img => {
      if (token !== loadToken) return;
      start(img ? edgePoints(img) : heartPoints(), instant || reduceMotion);
    };
    if (cachedImg) return go(cachedImg);

    const img = new Image();
    img.onload = () => { cachedImg = img; go(img); };
    img.onerror = () => { console.warn("love.jpg not found. Showing a heart."); go(null); };
    img.src = IMAGE_SRC;
  }

  // ---------- Update + draw ----------
  function updateParticles(dt) {
    const damp = Math.exp(-11 * dt);
    beat = time > 6 ? Math.pow(Math.max(0, Math.sin(time * 2.6)), 10) : 0;
    const sc = 1 + 0.01 * beat;
    const cx = W / 2, cy = layout.centerY;
    for (const p of particles) {
      if (time < p.delay) continue;
      const age = time - p.delay;
      p.a = Math.min(1, age / 0.7);

      const ox = Math.sin(time * 1.1 + p.ty * 0.025) * 1.1;
      const oy = Math.cos(time * 0.9 + p.tx * 0.025) * 1.1;

      p.vx += (cx + (p.tx - cx) * sc + ox - p.x) * p.k * dt;
      p.vy += (cy + (p.ty - cy) * sc + oy - p.y) * p.k * dt;

      if (pointer.active) {
        const dx = p.x - pointer.x, dy = p.y - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d < MOUSE_RADIUS && d > 0.01) {
          const f = (1 - d / MOUSE_RADIUS) ** 2 * 520 * dt;
          p.vx += (dx / d) * f;
          p.vy += (dy / d) * f;
        }
      }

      p.vx *= damp; p.vy *= damp;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

    }
  }

  function drawHeart(x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.9);
    ctx.bezierCurveTo(x - s * 1.4, y - s * 0.1, x - s * 0.7, y - s * 1.1, x, y - s * 0.35);
    ctx.bezierCurveTo(x + s * 0.7, y - s * 1.1, x + s * 1.4, y - s * 0.1, x, y + s * 0.9);
    ctx.fill();
  }

  function drawHearts(dt) {
    const fade = clamp((time - 4.5) / 2, 0, 1);
    if (fade <= 0) return;
    ctx.fillStyle = "#ff9fc0";
    for (const h of hearts) {
      h.y -= h.v * dt;
      if (h.y < -20) { h.y = H + 20; h.x = Math.random() * W; }
      ctx.globalAlpha = fade * 0.26 * (0.7 + 0.3 * Math.sin(time * 1.2 + h.p));
      drawHeart(h.x + Math.sin(time * 0.7 + h.p) * 14, h.y, h.s);
    }
    ctx.globalAlpha = 1;
  }

  function drawDust(dt) {
    ctx.fillStyle = "#ffc2da";
    for (const d of dust) {
      d.y -= d.v * dt;
      if (d.y < -4) { d.y = H + 4; d.x = Math.random() * W; }
      ctx.globalAlpha = d.a * (0.6 + 0.4 * Math.sin(time * 0.8 + d.p));
      ctx.beginPath();
      ctx.arc(d.x + Math.sin(time * 0.4 + d.p) * 6, d.y, d.s, 0, 6.283);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawParticles() {
    // Light band that sweeps across the finished picture
    const span = W + H * 0.5 + 500;
    const pos = time > 6.5 ? ((time - 6.5) * 240) % (span + 500) - 250 : -9999;
    const BAND = 80;

    ctx.globalCompositeOperation = "lighter";
    for (const p of particles) {
      if (p.a <= 0.01) continue;
      const d = Math.abs(p.x + p.y * 0.5 - pos);
      p.sh = d < BAND ? 1 - d / BAND : 0;
      const tw = 0.75 + 0.25 * Math.sin(time * 1.8 + p.ph);
      const size = 14 * (1 + p.sh * 0.5 + beat * 0.2);
      ctx.globalAlpha = Math.min(1, p.a * 0.38 * tw * p.w * (1 + beat * 0.6 + p.sh * 1.4));
      ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
    }
    ctx.globalCompositeOperation = "source-over";

    for (const p of particles) {
      if (p.a <= 0.01) continue;
      const tw = 0.85 + 0.15 * Math.sin(time * 2.2 + p.ph);
      ctx.globalAlpha = p.a * tw * (p.w < 1 ? 0.8 : 1);
      ctx.fillStyle = p.sh > 0.4 ? "#ffffff" : p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1 + p.sh * 0.5 + beat * 0.15), 0, 6.283);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- Liquid text ----------
  function wavePath(L, R, level, amp, phase, bottom) {
    ctx.beginPath();
    for (let x = L; x <= R + 5; x += 5) {
      const y = level +
        Math.sin(x * 0.03 + time * 2.8 + phase) * amp +
        Math.sin(x * 0.065 - time * 1.9 + phase * 1.7) * amp * 0.45;
      if (x === L) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(R + 5, bottom);
    ctx.lineTo(L, bottom);
    ctx.closePath();
  }

  function drawLiquidText(msg, cx, cy, size, anim) {
    const p = clamp((time - anim.start) / anim.dur, 0, 1);
    const e = easeInOutSine(p);

    ctx.save();
    ctx.font = `600 ${size}px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const w = ctx.measureText(msg).width;
    const L = cx - w / 2 - size * 0.25;
    const R = cx + w / 2 + size * 0.25;
    const yTop = cy - size * 0.8;
    const yBot = cy + size * 0.8;

    // Empty "glass" outline, fades as the liquid fills it
    ctx.globalAlpha = clamp(time / 1.2, 0, 1) * 0.3 * (1 - e * 0.7);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "#e1a5b9";
    ctx.strokeText(msg, cx, cy);
    ctx.globalAlpha = 1;

    if (p > 0) {
      const amp = size * 0.1 * (1 - e) + size * 0.008;
      const level = yBot + amp * 2 - (yBot - yTop + amp * 4) * e;
      const bottom = yBot + size;

      // Back wave (deeper tone, offset phase)
      ctx.save();
      wavePath(L, R, level + amp * 0.9, amp * 1.15, 1.3, bottom);
      ctx.clip();
      ctx.fillStyle = "#b65b7f";
      ctx.globalAlpha = 0.85;
      ctx.fillText(msg, cx, cy);
      ctx.restore();

      // Front wave with flowing gradient and glow
      ctx.save();
      wavePath(L, R, level, amp, 0, bottom);
      ctx.clip();
      const x0 = cx - w * 0.6 + Math.sin(time * 0.7) * w * 0.35;
      const g = ctx.createLinearGradient(x0, yTop, x0 + w * 1.2, yBot);
      g.addColorStop(0, "#ffd9e6");
      g.addColorStop(0.4, "#ee9ab9");
      g.addColorStop(0.7, "#ffe8f0");
      g.addColorStop(1, "#f4a9c4");
      ctx.fillStyle = g;
      ctx.shadowColor = "rgba(255,150,190,0.85)";
      ctx.shadowBlur = 14 + 8 * Math.sin(time * 1.6) * e;
      ctx.fillText(msg, cx, cy);
      ctx.restore();
    }
    ctx.restore();
  }

  // ---------- Main loop ----------
  function frame(ts) {
    rafId = requestAnimationFrame(frame);
    const dt = lastTs ? Math.min(0.033, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    time += dt;

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(bg, 0, 0, W, H);

    drawDust(dt);
    drawHearts(dt);
    updateParticles(dt);
    drawParticles();

    drawLiquidText(TOP_MESSAGE, W / 2, layout.topY, layout.topSize, TOP_ANIM);
    drawLiquidText(BOTTOM_MESSAGE, W / 2, layout.bottomY, layout.bottomSize, BOTTOM_ANIM);
  }

  // ---------- Events ----------
  const setPointer = (x, y) => { pointer.x = x; pointer.y = y; pointer.active = true; };
  window.addEventListener("pointermove", e => setPointer(e.clientX, e.clientY));
  window.addEventListener("pointerdown", e => setPointer(e.clientX, e.clientY));
  window.addEventListener("pointerleave", () => { pointer.active = false; });
  window.addEventListener("pointerup", e => { if (e.pointerType !== "mouse") pointer.active = false; });

  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const finished = time >= DONE_AT;
      resizeCanvas();
      loadTargets(finished);
    }, 250);
  });

  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(rafId);
    if (!document.hidden && particles.length) { lastTs = 0; rafId = requestAnimationFrame(frame); }
  });

  restartBtn.addEventListener("click", () => loadTargets(false));

  // ---------- Init (wait for the script font so text sizing is right) ----------
  resizeCanvas();
  const fontReady = document.fonts && document.fonts.load
    ? Promise.race([
        document.fonts.load(`600 40px ${FONT_FAMILY}`),
        new Promise(r => setTimeout(r, 1500))
      ]).catch(() => {})
    : Promise.resolve();
  fontReady.then(() => loadTargets(false));
})();