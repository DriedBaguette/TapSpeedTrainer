/*
 * TapCharts — small dependency-free canvas charts with hover tooltips.
 *
 * TapCharts.render(container, {
 *   series: [{ name, color: '--series-1', type: 'line' | 'dots', points: [{ x, y, tip? }] }],
 *   xLabel, yLabel, xFmt, yFmt, refLines: [{ y, label }], band: { y0, y1 },
 *   yMin, yMax, height, empty
 * })
 * Colours are CSS custom property names so light/dark themes swap in one place.
 */
(function (root) {
  'use strict';

  const charts = new Set();

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n >= 5 ? 10 : n >= 2 ? 5 : n >= 1 ? 2 : 1) * mag;
  }

  function ticks(lo, hi, target) {
    if (hi <= lo) hi = lo + 1;
    const step = niceStep(hi - lo, target);
    const lo2 = Math.floor(lo / step) * step;
    const hi2 = Math.ceil(hi / step) * step;
    const out = [];
    // Iteration cap: with odd data (huge values, tiny range) `v += step` can stop changing v.
    for (let v = lo2, n = 0; v <= hi2 + step * 1e-9 && n < 50; v += step, n++) out.push(+v.toFixed(10));
    return { ticks: out, lo: lo2, hi: hi2 };
  }

  function render(el, cfg) {
    let state = el._chart;
    if (!state) {
      el.classList.add('chart');
      el.innerHTML =
        '<div class="chart-legend"></div><div class="chart-plot"><canvas></canvas><div class="chart-tip" hidden></div></div>';
      state = { el, canvas: el.querySelector('canvas'), tip: el.querySelector('.chart-tip'), hover: null };
      el._chart = state;
      const plot = el.querySelector('.chart-plot');
      plot.addEventListener('pointermove', (e) => {
        const r = state.canvas.getBoundingClientRect();
        state.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
        draw(state);
      });
      plot.addEventListener('pointerleave', () => {
        state.hover = null;
        draw(state);
      });
      if (root.ResizeObserver) new ResizeObserver(() => draw(state)).observe(plot);
      charts.add(state);
    }
    state.cfg = cfg;

    const legend = el.querySelector('.chart-legend');
    const visible = cfg.series.filter((s) => s.points.length);
    legend.innerHTML =
      visible.length >= 2
        ? visible
            .map(
              (s) =>
                `<span class="legend-item"><span class="swatch ${s.type === 'dots' ? 'dot' : ''}" style="background:var(${s.color})"></span>${s.name}</span>`,
            )
            .join('')
        : '';
    draw(state);
  }

  function draw(state) {
    const { canvas, cfg, tip } = state;
    if (!cfg) return;
    const plot = canvas.parentElement;
    const W = plot.clientWidth;
    const H = cfg.height || 220;
    if (!W) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1); // 3x phone screens look the same at 2x for far less drawing
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const muted = css('--text-muted');
    const grid = css('--grid');
    const font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.font = font;

    const all = cfg.series.flatMap((s) => s.points);
    if (!all.length) {
      ctx.fillStyle = muted;
      ctx.textAlign = 'center';
      ctx.fillText(cfg.empty || 'No data yet', W / 2, H / 2);
      tip.hidden = true;
      return;
    }

    let xMin = Math.min(...all.map((p) => p.x));
    let xMax = Math.max(...all.map((p) => p.x));
    if (xMax === xMin) {
      xMin -= 1;
      xMax += 1;
    }
    let yLo = cfg.yMin != null ? cfg.yMin : Math.min(...all.map((p) => p.y));
    let yHi = cfg.yMax != null ? cfg.yMax : Math.max(...all.map((p) => p.y));
    for (const r of cfg.refLines || []) {
      yLo = Math.min(yLo, r.y);
      yHi = Math.max(yHi, r.y);
    }
    if (cfg.band) {
      yLo = Math.min(yLo, cfg.band.y0);
      yHi = Math.max(yHi, cfg.band.y1);
    }
    const pad = (yHi - yLo) * 0.08 || 1;
    const yt = ticks(cfg.yMin != null ? yLo : yLo - pad, cfg.yMax != null ? yHi : yHi + pad, 4);
    const xt = ticks(xMin, xMax, Math.max(2, Math.floor(W / 90)));

    const yFmt = cfg.yFmt || ((v) => String(Math.round(v)));
    const xFmt = cfg.xFmt || ((v) => String(+v.toFixed(1)));
    const labelW = Math.max(...yt.ticks.map((v) => ctx.measureText(yFmt(v)).width));
    const L = Math.ceil(labelW) + 12;
    const R = 10;
    const T = 10;
    const B = cfg.xLabel ? 38 : 24;
    const pw = W - L - R;
    const ph = H - T - B;
    const sx = (x) => L + ((x - xMin) / (xMax - xMin)) * pw;
    const sy = (y) => T + ph - ((y - yt.lo) / (yt.hi - yt.lo)) * ph;

    // On-time band
    if (cfg.band) {
      ctx.fillStyle = css('--band');
      const y1 = sy(cfg.band.y1);
      ctx.fillRect(L, y1, pw, sy(cfg.band.y0) - y1);
    }

    // Grid + y labels
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yt.ticks) {
      const y = Math.round(sy(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(L + pw, y);
      ctx.stroke();
      ctx.fillText(yFmt(v), L - 6, y);
    }
    // x labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of xt.ticks) {
      if (v < xMin - 1e-9 || v > xMax + 1e-9) continue;
      ctx.fillText(xFmt(v), sx(v), T + ph + 6);
    }
    if (cfg.xLabel) {
      ctx.fillText(cfg.xLabel, L + pw / 2, T + ph + 22);
    }

    // Reference lines
    for (const r of cfg.refLines || []) {
      const y = Math.round(sy(r.y)) + 0.5;
      ctx.strokeStyle = css('--text-secondary');
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(L + pw, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (r.label) {
        ctx.fillStyle = css('--text-secondary');
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(r.label, L + pw - 2, y - 3);
      }
    }

    // Series
    const surface = css('--surface');
    for (const s of cfg.series) {
      const color = css(s.color);
      if (s.type === 'dots') {
        const r = s.points.length > 150 ? 2.5 : 4;
        for (const p of s.points) {
          ctx.beginPath();
          ctx.arc(sx(p.x), sy(p.y), r, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          if (r >= 4) {
            ctx.strokeStyle = surface;
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        s.points.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
        ctx.stroke();
        if (s.markers || s.points.length <= 40) {
          for (const p of s.points) {
            ctx.beginPath();
            ctx.arc(sx(p.x), sy(p.y), 4, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = surface;
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }
      }
    }

    // Hover
    tip.hidden = true;
    const h = state.hover;
    if (!h || h.x < L - 8 || h.x > L + pw + 8) return;
    let best = null;
    const lineMode = cfg.series.every((s) => s.type !== 'dots');
    for (const s of cfg.series) {
      for (const p of s.points) {
        const dx = sx(p.x) - h.x;
        const dy = sy(p.y) - h.y;
        const d = lineMode ? Math.abs(dx) : Math.hypot(dx, dy);
        if (!best || d < best.d) best = { d, p, s };
      }
    }
    if (!best || (!lineMode && best.d > 24)) return;

    const px = sx(best.p.x);
    ctx.strokeStyle = css('--text-muted');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, T);
    ctx.lineTo(Math.round(px) + 0.5, T + ph);
    ctx.stroke();

    // All series values at that x (line charts), or the single point (dots).
    const rows = lineMode
      ? cfg.series
          .map((s) => ({ s, p: s.points.find((q) => q.x === best.p.x) }))
          .filter((r) => r.p)
      : [{ s: best.s, p: best.p }];
    for (const r of rows) {
      ctx.beginPath();
      ctx.arc(sx(r.p.x), sy(r.p.y), 5, 0, Math.PI * 2);
      ctx.fillStyle = css(r.s.color);
      ctx.fill();
      ctx.strokeStyle = surface;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const head = best.p.tip || (cfg.xLabel ? `${cfg.xLabel}: ${xFmt(best.p.x)}` : xFmt(best.p.x));
    tip.innerHTML =
      `<div class="tip-head">${head}</div>` +
      rows
        .map(
          (r) =>
            `<div class="tip-row"><span class="swatch" style="background:var(${r.s.color})"></span>${r.s.name}<b>${yFmt(r.p.y)}</b></div>`,
        )
        .join('');
    tip.hidden = false;
    const tw = tip.offsetWidth;
    let left = px + 12;
    if (left + tw > W) left = px - tw - 12;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = Math.max(0, Math.min(h.y - 20, H - tip.offsetHeight)) + 'px';
  }

  function redrawAll() {
    for (const s of charts) if (s.el.isConnected) draw(s);
  }

  if (root.matchMedia) {
    root.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redrawAll);
  }

  root.TapCharts = { render, redrawAll };
})(typeof self !== 'undefined' ? self : globalThis);
