/*
 * TapHighway — the scrolling note track for metronome and guided sets.
 *
 * Notes travel right-to-left and reach the hit line exactly when their click
 * sounds. With two-finger alternation there are two lanes (top = first key,
 * bottom = second key) so you can see which finger is next. Rating is by
 * timing only; the lanes are a guide.
 *
 * TapHighway.draw(canvas, {
 *   now, grid: { t0, period, count, sub }, judge, lanes: 1 | 2,
 *   countIn: [perf times of count-in beats], fx: [{ at, idx, judgment, err }], held: [bool, bool]
 * })
 */
(function (root) {
  'use strict';

  const TEXT = { perfect: 'Perfect', great: 'Great', good: 'Good', miss: 'Miss', extra: 'Extra' };
  const FX_MS = 500;

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  function size(canvas, lanes) {
    const W = canvas.parentElement.clientWidth;
    const H = lanes === 2 ? 128 : 84;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, W, H };
  }

  function draw(canvas, st) {
    const lanes = st.lanes;
    const { ctx, W, H } = size(canvas, lanes);
    if (!W) return;
    const c = {
      lane: css('--surface-2'),
      line: css('--text-muted'),
      text: css('--text-primary'),
      muted: css('--text-muted'),
      surface: css('--surface'),
      accent: css('--accent'),
      s1: css('--series-1'),
      s2: css('--series-2'),
      good: css('--good-ink'),
      warn: css('--warning-ink'),
      bad: css('--critical-ink'),
      info: css('--info-ink'),
    };
    ctx.clearRect(0, 0, W, H);

    const pad = 8;
    const laneH = (H - pad * 2 - (lanes - 1) * 6) / lanes;
    const laneY = (l) => pad + l * (laneH + 6) + laneH / 2;
    const hitX = Math.min(72, W * 0.16);

    // Lane strips
    ctx.fillStyle = c.lane;
    for (let l = 0; l < lanes; l++) {
      roundRect(ctx, 0, laneY(l) - laneH / 2, W, laneH, 10);
      ctx.fill();
    }

    if (!st.grid) return drawTargets();

    const { t0, period, count, sub } = st.grid;
    const now = st.now;
    // Show roughly 10–12 notes ahead, within sensible limits.
    const ahead = Math.max(700, Math.min(1600, period * 12));
    const pxPerMs = (W - hitX - 12) / ahead;
    const xOf = (t) => hitX + (t - now) * pxPerMs;

    // Beat lines and count-in markers
    ctx.lineWidth = 1;
    for (const b of st.countIn || []) {
      const x = xOf(b);
      if (x < hitX - 40 || x > W) continue;
      ctx.strokeStyle = c.line;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, pad);
      ctx.lineTo(Math.round(x) + 0.5, H - pad);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const first = Math.max(0, Math.floor((now - 300 - t0) / period));
    const last = Math.min(count - 1, Math.ceil((now + ahead - t0) / period));
    for (let i = first; i <= last; i++) {
      if (i % sub !== 0) continue;
      const x = xOf(t0 + i * period);
      if (x < hitX) continue;
      ctx.strokeStyle = c.line;
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, pad);
      ctx.lineTo(Math.round(x) + 0.5, H - pad);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    drawTargets();

    // Notes
    for (let i = last; i >= first; i--) {
      const t = t0 + i * period;
      const x = xOf(t);
      const mark = st.judge ? st.judge.mark(i) : null;
      if (mark && mark !== 'miss') continue; // hit notes vanish
      const lane = lanes === 2 ? i % 2 : 0;
      const y = laneY(lane);
      const r = i % sub === 0 ? 9 : 7;
      let alpha = 1;
      if (x < hitX) alpha = Math.max(0, 1 - (hitX - x) / 50);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = mark === 'miss' ? c.muted : lane === 0 ? c.s1 : c.s2;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = c.surface;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Count-in numbers
    const ci = st.countIn || [];
    if (ci.length && now < t0) {
      const left = ci.filter((b) => b > now - 60).length;
      if (left > 0) {
        ctx.fillStyle = c.text;
        ctx.font = '700 28px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(left), W / 2, H / 2);
      }
    }

    // Hit effects: a ring at the target for every hit, and the rating text for the latest one per lane
    // (at fast tempos older texts would pile up on top of each other).
    const latest = {};
    for (const f of st.fx || []) {
      const lane = lanes === 2 && f.idx != null ? f.idx % 2 : 0;
      if (now - f.at >= 0 && (!latest[lane] || f.at >= latest[lane].at)) latest[lane] = f;
    }
    for (const f of st.fx || []) {
      const age = now - f.at;
      if (age < 0 || age > FX_MS) continue;
      const k = age / FX_MS;
      const lane = lanes === 2 && f.idx != null ? f.idx % 2 : 0;
      const y = laneY(lane);
      const color =
        f.judgment === 'perfect' ? c.good : f.judgment === 'great' ? c.info : f.judgment === 'good' ? c.warn : c.bad;
      if (f.judgment !== 'miss' && f.judgment !== 'extra') {
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(hitX, y, 11 + k * 14, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (latest[lane] !== f) {
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.globalAlpha = Math.min(1, 1.6 * (1 - k));
      ctx.fillStyle = color;
      ctx.font = '700 15px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      let label = TEXT[f.judgment];
      if ((f.judgment === 'great' || f.judgment === 'good') && f.err != null) label += f.err < 0 ? ' · early' : ' · late';
      ctx.fillText(label, hitX + 20, y - 4 - k * 8);
      ctx.globalAlpha = 1;
    }

    // Score, top right
    if (st.judge) {
      ctx.fillStyle = c.muted;
      ctx.font = '600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(st.judge.score.toLocaleString(), W - 10, 4);
    }

    function drawTargets() {
      // Hit line and one target ring per lane (filled while that key is held)
      ctx.strokeStyle = c.line;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hitX, pad - 2);
      ctx.lineTo(hitX, H - pad + 2);
      ctx.stroke();
      for (let l = 0; l < lanes; l++) {
        const y = laneY(l);
        const held = st.held && (lanes === 2 ? st.held[l] : st.held[0] || st.held[1]);
        ctx.beginPath();
        ctx.arc(hitX, y, 12, 0, Math.PI * 2);
        ctx.fillStyle = held ? (l === 0 ? c.s1 : c.s2) : c.surface;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = l === 0 ? c.s1 : c.s2;
        ctx.stroke();
      }
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  root.TapHighway = { draw, TEXT };
})(typeof self !== 'undefined' ? self : globalThis);
