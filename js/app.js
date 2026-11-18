/*
 * App wiring: input capture, set flow (speed test / metronome), live
 * monitoring, post-set report, rest timer, discomfort check and history.
 */
(function () {
  'use strict';

  const A = window.TapAnalysis;
  const Store = window.TapStore;
  const Charts = window.TapCharts;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const ICON = { good: '✓', info: 'i', warn: '!', stop: '■' };

  Store.load();
  let settings = Store.settings;

  const S = {
    phase: 'idle', // idle | armed | starting | running | done
    taps: [],
    downs: new Map(), // input id -> { pad, tap }
    padDown: [0, 0],
    monitor: null,
    startT: 0,
    grid: null,
    beats: [],
    beatIdx: 0,
    raf: 0,
    audio: null,
    restUntil: 0,
    earlyStart: false,
    lastSnap: null,
    listeningSlot: null,
    painConfirmUntil: 0,
    clearConfirmUntil: 0,
  };

  // ------------------------------------------------------------ utilities

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /** Event timestamps are high-resolution and taken when the input happened, not when JS ran. */
  function stamp(e) {
    const now = performance.now();
    const t = e && e.timeStamp;
    return t > 0 && Math.abs(now - t) < 1000 ? t : now;
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  function keyNames() {
    return settings.keys.map((k) => k.label);
  }

  function freeLimit() {
    const v = settings.freeLength;
    return v[0] === 'n' ? { taps: +v.slice(1) } : { ms: +v.slice(1) * 1000 };
  }

  function save(patch) {
    Store.saveSettings(patch);
    settings = Store.settings;
    applySettingsToUI();
  }

  // ------------------------------------------------------------- settings

  const settingsEl = $('#settings');

  function applySettingsToUI() {
    $$('input[name="mode"]').forEach((r) => (r.checked = r.value === settings.mode));
    $$('input[name="style"]').forEach((r) => (r.checked = r.value === settings.style));
    $('#free-length').value = settings.freeLength;
    $('#metro-bpm').value = settings.metroBpm;
    $('#metro-subdiv').value = String(settings.metroSubdiv);
    $('#metro-length').value = String(settings.metroLength);
    $('#metro-offset').value = settings.metroOffset;
    $('#metro-ticks').checked = settings.metroTicks;
    $('#autostop').checked = settings.autostop;
    $$('.keybind').forEach((b) => {
      const slot = +b.dataset.slot;
      b.textContent = S.listeningSlot === slot ? 'press a key…' : settings.keys[slot].label;
      b.classList.toggle('listening', S.listeningSlot === slot);
      b.hidden = slot === 1 && settings.style === 'single';
    });
    $$('.pad').forEach((p) => (p.querySelector('.pad-key').textContent = settings.keys[+p.dataset.pad].label));
    $('#pads').classList.toggle('single', settings.style === 'single');
    document.body.classList.toggle('mode-metronome', settings.mode === 'metronome');
    $('#live-extra-label').textContent = settings.mode === 'metronome' ? 'on time' : 'variation';
  }

  $$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => save({ mode: r.value })));
  $$('input[name="style"]').forEach((r) => r.addEventListener('change', () => save({ style: r.value })));
  $('#free-length').addEventListener('change', (e) => save({ freeLength: e.target.value }));
  $('#metro-bpm').addEventListener('change', (e) => {
    const v = Math.round(+e.target.value);
    save({ metroBpm: Number.isFinite(v) ? Math.min(400, Math.max(40, v)) : settings.metroBpm });
  });
  $$('.stepper button').forEach((b) =>
    b.addEventListener('click', () => save({ metroBpm: Math.min(400, Math.max(40, settings.metroBpm + +b.dataset.step)) })),
  );
  $('#metro-subdiv').addEventListener('change', (e) => save({ metroSubdiv: +e.target.value }));
  $('#metro-length').addEventListener('change', (e) => save({ metroLength: +e.target.value }));
  $('#metro-offset').addEventListener('change', (e) => save({ metroOffset: Math.round(+e.target.value) || 0 }));
  $('#metro-ticks').addEventListener('change', (e) => save({ metroTicks: e.target.checked }));
  $('#autostop').addEventListener('change', (e) => save({ autostop: e.target.checked }));

  $$('.keybind').forEach((b) =>
    b.addEventListener('click', () => {
      S.listeningSlot = S.listeningSlot === +b.dataset.slot ? null : +b.dataset.slot;
      applySettingsToUI();
    }),
  );

  function keyLabel(e) {
    if (e.key === ' ') return 'Space';
    if (e.key && e.key.length === 1) return e.key.toUpperCase();
    return e.key || e.code;
  }

  function bindKey(e) {
    e.preventDefault();
    const slot = S.listeningSlot;
    S.listeningSlot = null;
    if (e.code !== 'Escape') {
      const keys = settings.keys.map((k) => ({ ...k }));
      const other = 1 - slot;
      if (keys[other].code === e.code) keys[other] = keys[slot]; // swap instead of duplicating
      keys[slot] = { code: e.code, label: keyLabel(e) };
      save({ keys });
    } else applySettingsToUI();
  }

  // ---------------------------------------------------------------- input

  function padForCode(code) {
    if (code === settings.keys[0].code) return 0;
    if (settings.style !== 'single' && code === settings.keys[1].code) return 1;
    return null;
  }

  function isFormField(el) {
    return el && el.closest && el.closest('input, select, textarea');
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (S.listeningSlot != null) return bindKey(e);
      if (isFormField(e.target)) return;
      const pad = padForCode(e.code);
      if (pad == null) {
        if (e.code === 'Escape' && isActive()) finish('manual');
        return;
      }
      e.preventDefault();
      if (e.repeat) return;
      press(pad, stamp(e), 'k:' + e.code);
    },
    true,
  );

  window.addEventListener(
    'keyup',
    (e) => {
      if (isFormField(e.target)) return;
      if (padForCode(e.code) != null) e.preventDefault(); // stop Space/Enter from clicking a focused button
      release('k:' + e.code, stamp(e));
    },
    true,
  );

  $$('.pad').forEach((p) => {
    p.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      if (p.setPointerCapture) p.setPointerCapture(e.pointerId);
      press(+p.dataset.pad, stamp(e), 'p:' + e.pointerId);
    });
    const up = (e) => release('p:' + e.pointerId, stamp(e));
    p.addEventListener('pointerup', up);
    p.addEventListener('pointercancel', up);
    p.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  window.addEventListener('blur', () => {
    for (const id of [...S.downs.keys()]) release(id, performance.now());
  });

  function setPadDown(pad, delta) {
    S.padDown[pad] = Math.max(0, S.padDown[pad] + delta);
    $(`.pad[data-pad="${pad}"]`).classList.toggle('down', S.padDown[pad] > 0);
  }

  function isActive() {
    return S.phase === 'armed' || S.phase === 'running' || S.phase === 'starting';
  }

  function press(pad, t, id) {
    if (S.downs.has(id)) return;
    setPadDown(pad, 1);
    const entry = { pad, tap: null };
    S.downs.set(id, entry);

    if (S.phase === 'armed') {
      S.phase = 'running';
      S.startT = t;
      setStatus('Go! Keep it even.');
    }
    if (S.phase !== 'running') {
      if (S.phase === 'idle' || S.phase === 'done') setStatus('Press Start when you’re ready.');
      return;
    }
    if (S.grid && t < S.grid.t0 - S.grid.period / 2) return; // tapping along to the count-in

    const tap = { t, key: pad, dur: null };
    entry.tap = tap;
    S.taps.push(tap);
    const snap = S.monitor.push(tap);
    S.lastSnap = snap;
    updateLive(snap);

    const lim = freeLimit();
    if (!S.grid && lim.taps && S.taps.length >= lim.taps) finish('done');
    else if (snap.breakdown && settings.autostop) finish('breakdown');
  }

  function release(id, t) {
    const entry = S.downs.get(id);
    if (!entry) return;
    S.downs.delete(id);
    setPadDown(entry.pad, -1);
    if (entry.tap && entry.tap.dur == null) entry.tap.dur = Math.max(0, t - entry.tap.t);
  }

  // ------------------------------------------------------------ live view

  function setStatus(text) {
    $('#status-line').textContent = text;
  }

  function showAlert(el, alert) {
    if (!alert) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.className = `${el.id === 'day-banner' ? 'banner' : 'alert'} lvl-${alert.level}`;
    el.innerHTML = `<span class="icon" aria-hidden="true">${ICON[alert.level]}</span><span>${esc(alert.text)}</span>`;
  }

  function resetLive() {
    $('#live-bpm').textContent = '–';
    $('#live-taps').textContent = '0';
    $('#live-time').textContent = settings.mode === 'free' && freeLimit().ms ? (freeLimit().ms / 1000).toFixed(1) : '0.0';
    $('#live-extra').textContent = '–';
    showAlert($('#live-alert'), null);
    $('#err-dot').style.left = '50%';
  }

  function updateLive(snap) {
    $('#live-bpm').textContent = snap.bpm ? Math.round(snap.bpm) : '–';
    $('#live-taps').textContent = S.taps.length;
    if (S.grid) {
      $('#live-extra').textContent = snap.onTime != null ? `${Math.round(snap.onTime * 100)}%` : '–';
      const pos = 50 + Math.max(-50, Math.min(50, (snap.err / S.grid.period) * 100));
      $('#err-dot').style.left = pos + '%';
    } else {
      $('#live-extra').textContent = snap.spread ? `${Math.round(snap.spread * 100)}%` : '–';
    }
    showAlert($('#live-alert'), snap.alert);
  }

  // ------------------------------------------------------------- set flow

  function painToday() {
    return Store.today().some((s) => s.feel === 'pain');
  }

  async function startSet() {
    if (isActive()) return;
    if (painToday() && Date.now() > S.painConfirmUntil) {
      // Two-step confirm instead of a browser dialog.
      S.painConfirmUntil = Date.now() + 6000;
      setStatus('You reported pain earlier today. Training through pain risks injury. Press Start again within 6 seconds to train anyway.');
      return;
    }
    S.painConfirmUntil = 0;

    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    S.earlyStart = Date.now() < S.restUntil;
    S.taps = [];
    S.grid = null;
    S.lastSnap = null;
    resetLive();
    $('#report').hidden = true;
    settingsEl.open = false;
    settingsEl.inert = true;
    $('#start').hidden = true;
    $('#stop').hidden = false;
    $('#err-meter').hidden = settings.mode !== 'metronome';

    if (settings.mode === 'free') {
      S.phase = 'armed';
      S.monitor = A.createLiveMonitor();
      setStatus('Ready. The timer starts on your first tap.');
    } else {
      S.phase = 'starting';
      setStatus('Starting metronome…');
      try {
        await startMetronome();
      } catch (err) {
        setStatus('Couldn’t start audio: ' + err.message);
        S.phase = 'idle';
        endUI();
        return;
      }
      if (S.phase !== 'starting') return; // stopped while audio was starting
      S.phase = 'running';
    }
    cancelAnimationFrame(S.raf);
    S.raf = requestAnimationFrame(tick);
  }

  function tick() {
    const now = performance.now();
    if (S.phase === 'running') {
      if (!S.grid) {
        const lim = freeLimit();
        const el = now - S.startT;
        $('#live-time').textContent = ((lim.ms ? Math.max(0, lim.ms - el) : el) / 1000).toFixed(1);
        if (lim.ms && el >= lim.ms) return finish('time');
        const last = S.taps[S.taps.length - 1];
        if (last && now - last.t > 1500) return finish('idle');
      } else {
        const { t0, period, count } = S.grid;
        const end = t0 + count * period;
        if (now < t0 - period / 2) {
          const beatsLeft = Math.ceil((t0 - now) / (period * S.grid.sub));
          setStatus(`Count-in… ${beatsLeft}`);
        } else if (S.taps.length === 0 && now > t0 + 2000) {
          setStatus('Tap along with the clicks!');
        } else if (now >= t0 - period / 2 && now < t0 + 100) {
          setStatus('Go!');
        }
        $('#live-time').textContent = (Math.max(0, Math.min(end - t0, end - now)) / 1000).toFixed(1);
        while (S.beatIdx < S.beats.length && S.beats[S.beatIdx] < now - 80) S.beatIdx++;
        const b = S.beats[S.beatIdx];
        $('#beat').classList.toggle('on', b != null && now >= b && now < b + 80);
        if (now > end + period + 150) return finish('time');
      }
    }
    S.raf = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ metronome

  function audioToPerfOffset(ctx) {
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.performanceTime > 0 && ts.contextTime > 0) return ts.performanceTime - ts.contextTime * 1000;
    }
    return performance.now() - ctx.currentTime * 1000 + (ctx.outputLatency || ctx.baseLatency || 0) * 1000;
  }

  function click(time, kind) {
    const ctx = S.audio.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = { accent: 1760, count: 1320, beat: 1100, tick: 700 }[kind];
    const vol = kind === 'tick' ? 0.25 : 0.8;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(vol, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    o.connect(g);
    g.connect(S.audio.out);
    o.start(time);
    o.stop(time + 0.05);
  }

  async function startMetronome() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('this browser has no Web Audio support');
    if (!S.audio) S.audio = { ctx: new AC({ latencyHint: 'interactive' }), out: null };
    const ctx = S.audio.ctx;
    if (ctx.state !== 'running') await ctx.resume();
    // Give the output clock a moment so the audio→performance mapping is valid.
    await new Promise((r) => setTimeout(r, 60));
    if (S.phase !== 'starting') return; // stopped before audio was ready

    const out = ctx.createGain();
    out.gain.value = 0.6;
    out.connect(ctx.destination);
    S.audio.out = out;

    const bpm = settings.metroBpm;
    const sub = settings.metroSubdiv;
    const beatS = 60 / bpm;
    const periodS = beatS / sub;
    const count = Math.max(8, Math.round(settings.metroLength / periodS));
    const countIn = 4;
    const startC = ctx.currentTime + 0.15;
    const firstNote = startC + countIn * beatS;

    for (let b = 0; b < countIn; b++) click(startC + b * beatS, 'count');
    for (let i = 0; i < count; i++) {
      const t = firstNote + i * periodS;
      if (i % sub === 0) click(t, i % (sub * 4) === 0 ? 'accent' : 'beat');
      else if (settings.metroTicks) click(t, 'tick');
    }

    const off = audioToPerfOffset(ctx) + settings.metroOffset;
    const toPerf = (c) => c * 1000 + off;
    S.grid = { t0: toPerf(firstNote), period: periodS * 1000, count, targetBpm: bpm, sub };
    S.beats = [];
    for (let b = 0; b < countIn; b++) S.beats.push(toPerf(startC + b * beatS));
    for (let i = 0; i < count; i += sub) S.beats.push(toPerf(firstNote + i * periodS));
    S.beatIdx = 0;
    S.monitor = A.createLiveMonitor({ grid: S.grid });

    const zone = (A.onTimeWindow(S.grid.period) / S.grid.period) * 100;
    $('.meter-zone').style.left = 50 - zone + '%';
    $('.meter-zone').style.right = 50 - zone + '%';
  }

  function stopAudio() {
    if (S.audio && S.audio.out) {
      S.audio.out.disconnect();
      S.audio.out = null;
    }
    $('#beat').classList.remove('on');
  }

  // --------------------------------------------------------------- finish

  function endUI() {
    cancelAnimationFrame(S.raf);
    stopAudio();
    settingsEl.inert = false;
    $('#start').hidden = false;
    $('#stop').hidden = true;
    $('#err-meter').hidden = true;
    showAlert($('#live-alert'), null);
  }

  const REASONS = {
    time: 'Set complete.',
    done: 'Set complete.',
    idle: 'Set ended: you stopped tapping.',
    manual: 'Set stopped.',
    breakdown: 'Set stopped automatically because your form broke down.',
  };

  function finish(reason) {
    if (!isActive()) return;
    const wasArmed = S.phase === 'armed' || S.phase === 'starting';
    const stopT = performance.now();
    S.phase = 'done';
    endUI();
    if (wasArmed) {
      setStatus('Set cancelled.');
      return;
    }

    const alternate = settings.style === 'alternate';
    const opts = { alternate, keyNames: keyNames() };
    let res;
    if (!S.grid) {
      const lim = freeLimit();
      const taps = lim.ms ? S.taps.filter((t) => t.t <= S.startT + lim.ms) : S.taps;
      res = A.analyzeFree(taps, opts);
    } else {
      let grid = S.grid;
      if (reason !== 'time') {
        // Only score the notes that were actually played before stopping.
        const played = Math.floor((stopT - grid.t0) / grid.period) + 1;
        grid = { ...grid, count: Math.max(1, Math.min(grid.count, played)) };
      }
      res = A.analyzeMetronome(S.taps, grid, opts);
    }

    if (!res.ok) {
      setStatus(`${REASONS[reason]} ${res.reason}`);
      return;
    }

    if (reason === 'breakdown') {
      res.issues = res.issues.filter((i) => i.level !== 'good');
      res.issues.unshift({
        level: 'stop',
        title: 'Stopped: form broke down',
        detail: `${S.lastSnap && S.lastSnap.alert ? S.lastSnap.alert.text + ' ' : ''}Rest, then go again a little slower.`,
      });
      res.level = 'stop';
    }
    if (S.earlyStart) {
      res.issues.push({
        level: 'info',
        title: 'Started before resting',
        detail: 'You began this set before the rest timer finished. Leftover fatigue will drag the result down.',
      });
    }

    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      time: Date.now(),
      mode: res.mode,
      style: settings.style,
      n: res.n,
      durationMs: Math.round(res.durationMs),
      reason,
      level: res.level,
      issues: res.issues.filter((i) => i.level !== 'good').map((i) => i.title),
      feel: null,
    };
    if (res.mode === 'free') {
      Object.assign(record, {
        avgBpm: +res.avgBpm.toFixed(1),
        peakBpm: +res.peakBpm.toFixed(1),
        consistency: +res.consistency.toFixed(4),
      });
    } else {
      Object.assign(record, {
        targetBpm: res.targetBpm,
        subdiv: S.grid.sub,
        onTimePct: +res.onTimePct.toFixed(3),
        unstableRate: +res.unstableRate.toFixed(1),
        meanErr: +res.meanErr.toFixed(1),
      });
    }
    Store.addSet(record);

    const restSec = A.recommendedRestSec(res.durationMs, res.level);
    S.restUntil = Date.now() + restSec * 1000;
    setStatus(REASONS[reason]);
    renderReport(res, record, reason, restSec);
    updateDayBanner();
  }

  // --------------------------------------------------------------- report

  function tile(value, label) {
    return `<div class="tile"><div class="value">${value}</div><div class="label">${label}</div></div>`;
  }

  function issueList(issues) {
    return `<ul class="issues">${issues
      .map(
        (i) =>
          `<li class="lvl-${i.level}"><span class="icon" aria-hidden="true">${ICON[i.level]}</span>` +
          `<div><div class="title">${esc(i.title)}</div><div class="detail">${esc(i.detail)}</div></div></li>`,
      )
      .join('')}</ul>`;
  }

  function renderReport(res, record, reason, restSec) {
    const el = $('#report');
    const names = keyNames();
    let html = `<h2>Set report</h2><p class="sub">${esc(REASONS[reason])} Rest about ${fmtClock(restSec)} before the next set.</p>`;

    if (res.mode === 'free') {
      html +=
        '<div class="tiles">' +
        tile(Math.round(res.avgBpm), 'average BPM') +
        tile(Math.round(res.peakBpm), 'peak BPM (16 taps)') +
        tile(res.tapsPerSec.toFixed(1), 'taps / second') +
        tile(`${Math.round(res.consistency * 100)}%`, 'spacing variation') +
        tile(res.n, 'taps') +
        '</div>';
      html += issueList(res.issues);
      html += `<p class="recommend">Controlled practice speed: about <b>${res.recommendBpm} BPM</b> on the metronome.
        <button type="button" class="secondary" id="practise-at">Practise at ${res.recommendBpm}</button></p>`;
      html += '<div class="chart"><h3>Speed through the set</h3><p class="sub">Rolling speed over 4 taps. A steady line is the goal.</p><div id="rep-a"></div></div>';
      html +=
        '<div class="chart"><h3>Gap before each tap</h3><p class="sub">' +
        (res.alternation ? 'If the two colours form separate bands, your fingers are uneven.' : 'A tight band means an even rhythm.') +
        '</p><div id="rep-b"></div></div>';
    } else {
      const sign = res.meanErr > 0 ? '+' : '';
      html +=
        '<div class="tiles">' +
        tile(res.targetBpm, 'target BPM') +
        tile(`${Math.round(res.onTimePct * 100)}%`, `on time (±${Math.round(res.window)} ms)`) +
        tile(Math.round(res.unstableRate), 'unstable rate') +
        tile(`${sign}${res.meanErr.toFixed(0)} ms`, 'average offset') +
        tile(`${res.misses} / ${res.extras}`, 'missed / extra') +
        '</div>';
      html += issueList(res.issues);
      html += `<p class="recommend">${esc(res.advice)}`;
      if (res.recommendBpm !== res.targetBpm)
        html += ` <button type="button" class="secondary" id="practise-at">Set to ${res.recommendBpm} BPM</button>`;
      html += '</p>';
      if (Math.abs(res.meanErr) > 10 && res.sd < res.period * 0.25) {
        const newOff = settings.metroOffset + Math.round(res.meanErr);
        html += `<p class="sub">Felt on the beat? Your taps averaged ${sign}${res.meanErr.toFixed(0)} ms. That is probably audio delay.
          <button type="button" class="secondary" id="calibrate">Set audio offset to ${newOff} ms</button></p>`;
      }
      html +=
        '<div class="chart"><h3>Timing vs the click</h3><p class="sub">Each tap’s offset from its note. Above 0 = late, below = early. Shaded = on time.</p><div id="rep-a"></div></div>';
      html += '<div class="chart"><h3>Speed through the set</h3><p class="sub">Rolling speed over 4 taps vs target.</p><div id="rep-b"></div></div>';
    }

    html += `<div class="feel"><p>How do your hands and wrists feel?</p><div class="actions">
      <button type="button" class="secondary" data-feel="fine">Fine</button>
      <button type="button" class="secondary" data-feel="tight">Tight or tired</button>
      <button type="button" class="secondary" data-feel="pain">Pain or tingling</button>
      </div><div class="feel-msg"></div></div>`;

    el.innerHTML = html;
    el.hidden = false;

    const byKey = (pts) =>
      res.alternation
        ? [
            { name: `${names[0]} taps`, color: '--series-1', type: 'dots', points: pts.filter((p) => p.key === 0) },
            { name: `${names[1]} taps`, color: '--series-2', type: 'dots', points: pts.filter((p) => p.key === 1) },
          ]
        : [{ name: 'Taps', color: '--series-1', type: 'dots', points: pts }];
    const secFmt = (v) => `${+v.toFixed(1)}s`;

    if (res.mode === 'free') {
      Charts.render($('#rep-a'), {
        series: [{ name: 'Speed', color: '--series-1', type: 'line', points: res.series.speed }],
        xFmt: secFmt,
        yFmt: (v) => `${Math.round(v)}`,
        refLines: [{ y: res.avgBpm, label: `avg ${Math.round(res.avgBpm)}` }],
      });
      const iv = res.series.intervals;
      const cap = A.median(iv.map((p) => p.y)) * 3;
      Charts.render($('#rep-b'), {
        series: byKey(iv.filter((p) => p.y <= cap)),
        xFmt: secFmt,
        yFmt: (v) => `${Math.round(v)} ms`,
      });
    } else {
      const w = res.window;
      Charts.render($('#rep-a'), {
        series: byKey(res.series.errors),
        xFmt: secFmt,
        yFmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} ms`,
        band: { y0: -w, y1: w },
        refLines: [{ y: 0 }],
      });
      Charts.render($('#rep-b'), {
        series: [{ name: 'Speed', color: '--series-1', type: 'line', points: res.series.speed }],
        xFmt: secFmt,
        yFmt: (v) => `${Math.round(v)}`,
        refLines: [{ y: res.targetBpm, label: `target ${res.targetBpm}` }],
      });
    }

    const practise = $('#practise-at');
    if (practise)
      practise.addEventListener('click', () => {
        save({ mode: 'metronome', metroBpm: res.recommendBpm });
        practise.textContent = 'Done. Metronome mode set';
        practise.disabled = true;
      });
    const cal = $('#calibrate');
    if (cal)
      cal.addEventListener('click', () => {
        save({ metroOffset: settings.metroOffset + Math.round(res.meanErr) });
        cal.textContent = `Offset set to ${settings.metroOffset} ms`;
        cal.disabled = true;
      });

    const FEEL = {
      fine: { level: 'good', text: 'Good. Rest, then go again.' },
      tight: {
        level: 'warn',
        text: 'Take a longer rest and shake your hands out. Drop 5–10 BPM next set and focus on staying loose.',
      },
      pain: {
        level: 'stop',
        text:
          'Stop for today. Pain, tingling or numbness means your hands need rest, and pushing through is how strain injuries start. ' +
          'If it lingers or keeps coming back, see a doctor or physio.',
      },
    };
    $$('.feel [data-feel]').forEach((b) =>
      b.addEventListener('click', () => {
        const feel = b.dataset.feel;
        Store.updateSet(record.id, { feel });
        $$('.feel [data-feel]').forEach((x) => x.classList.toggle('chosen', x === b));
        const msg = el.querySelector('.feel-msg');
        msg.className = `feel-msg alert lvl-${FEEL[feel].level}`;
        msg.innerHTML = `<span class="icon" aria-hidden="true">${ICON[FEEL[feel].level]}</span><span>${esc(FEEL[feel].text)}</span>`;
        if (feel === 'pain') S.restUntil = Date.now() + 24 * 3600 * 1000;
        else if (feel === 'tight') S.restUntil = Math.max(S.restUntil, Date.now() + 120 * 1000);
        updateDayBanner();
      }),
    );
  }

  // ------------------------------------------------- rest & daily checks

  function updateRestButton() {
    const btn = $('#start');
    const left = (S.restUntil - Date.now()) / 1000;
    if (painToday()) {
      btn.textContent = 'Rest for today';
      btn.classList.add('resting');
    } else if (left > 0) {
      btn.textContent = `Rest ${fmtClock(left)} (start anyway)`;
      btn.classList.add('resting');
    } else {
      btn.textContent = 'Start';
      btn.classList.remove('resting');
    }
  }
  setInterval(updateRestButton, 250);

  function updateDayBanner() {
    const today = Store.today();
    const el = $('#day-banner');
    if (today.some((s) => s.feel === 'pain')) {
      return showAlert(el, {
        level: 'stop',
        text: 'You reported pain today. Rest your hands until tomorrow. If it persists, get it checked out.',
      });
    }
    const last2 = today.slice(-2);
    if (last2.length === 2 && last2.every((s) => s.level === 'warn' || s.level === 'stop')) {
      return showAlert(el, {
        level: 'warn',
        text: 'Quality has dropped two sets in a row. Good time to stop for today, or drop the speed well down.',
      });
    }
    const mins = today.reduce((a, s) => a + (s.durationMs || 0), 0) / 60000;
    if (mins >= 10) {
      return showAlert(el, {
        level: 'info',
        text: `${mins.toFixed(0)} minutes of hard tapping today. More isn’t better past this point. Consider wrapping up.`,
      });
    }
    showAlert(el, null);
  }

  $('#start').addEventListener('click', startSet);
  $('#stop').addEventListener('click', () => finish('manual'));

  // -------------------------------------------------------------- history

  function renderHistory() {
    const sets = Store.sets;
    const today = Store.today();
    const freeToday = today.filter((s) => s.mode === 'free');
    const mins = today.reduce((a, s) => a + (s.durationMs || 0), 0) / 60000;
    $('#today-tiles').innerHTML =
      tile(today.length, 'sets') +
      tile(mins.toFixed(1), 'minutes tapping') +
      tile(freeToday.length ? Math.round(Math.max(...freeToday.map((s) => s.avgBpm))) : '–', 'best speed test (avg BPM)') +
      tile(today.filter((s) => s.level === 'good' || s.level === 'info').length, 'clean sets');

    const date = (s) => new Date(s.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const free = sets.filter((s) => s.mode === 'free');
    const metro = sets.filter((s) => s.mode === 'metronome');
    const intFmt = (v) => (Number.isInteger(v) ? String(v) : '');

    Charts.render($('#hist-speed'), {
      series: [
        { name: 'Average', color: '--series-1', type: 'line', points: free.map((s, i) => ({ x: i + 1, y: s.avgBpm, tip: `Set ${i + 1} · ${date(s)}` })) },
        { name: 'Peak', color: '--series-2', type: 'line', points: free.map((s, i) => ({ x: i + 1, y: s.peakBpm, tip: `Set ${i + 1} · ${date(s)}` })) },
      ],
      xFmt: intFmt,
      yFmt: (v) => `${Math.round(v)}`,
      empty: 'Do a speed test to start tracking.',
    });
    Charts.render($('#hist-cv'), {
      series: [
        { name: 'Variation', color: '--series-1', type: 'line', points: free.map((s, i) => ({ x: i + 1, y: s.consistency * 100, tip: `Set ${i + 1} · ${date(s)}` })) },
      ],
      xFmt: intFmt,
      yFmt: (v) => `${+v.toFixed(1)}%`,
      yMin: 0,
      refLines: free.length ? [{ y: 10, label: '10% target' }] : [],
      empty: 'Do a speed test to start tracking.',
    });
    Charts.render($('#hist-metro'), {
      series: [
        {
          name: 'On time',
          color: '--series-1',
          type: 'line',
          markers: true,
          points: metro.map((s, i) => ({ x: i + 1, y: s.onTimePct * 100, tip: `Set ${i + 1} · ${s.targetBpm} BPM · ${date(s)}` })),
        },
      ],
      xFmt: intFmt,
      yFmt: (v) => `${Math.round(v)}%`,
      yMin: 0,
      yMax: 100,
      refLines: metro.length ? [{ y: 90, label: '90%: ready to go up' }] : [],
      empty: 'Do a metronome set to start tracking.',
    });

    const FEEL_LABEL = { fine: 'fine', tight: 'tight', pain: 'pain' };
    const rows = [...sets].reverse().slice(0, 200);
    $('#hist-table').innerHTML =
      '<thead><tr><th>When</th><th>Mode</th><th>Result</th><th>Form</th><th>Felt</th></tr></thead><tbody>' +
      (rows.length
        ? rows
            .map((s) => {
              const result =
                s.mode === 'free'
                  ? `${Math.round(s.avgBpm)} avg · ${Math.round(s.peakBpm)} peak · ${Math.round(s.consistency * 100)}% var.`
                  : `${s.targetBpm} BPM · ${Math.round(s.onTimePct * 100)}% on time · UR ${Math.round(s.unstableRate)}`;
              const form = s.issues && s.issues.length ? s.issues.join('; ') : 'clean';
              return `<tr><td>${esc(date(s))}</td><td>${s.mode === 'free' ? 'Speed test' : 'Metronome'}</td><td>${esc(result)}</td>` +
                `<td>${ICON[s.level] || ''} ${esc(form)}</td><td>${esc(FEEL_LABEL[s.feel] || '–')}</td></tr>`;
            })
            .join('')
        : '<tr><td colspan="5">No sets yet.</td></tr>') +
      '</tbody>';
  }

  // Where file downloads are blocked (e.g. an embedded page), copy the data instead.
  const copyOnly = document.body.dataset.embedded === 'true';
  if (copyOnly) $('#export').textContent = 'Copy data';
  $('#export').addEventListener('click', () => {
    if (copyOnly) {
      const done = () => ($('#data-msg').textContent = 'Data copied. Paste it into a .json file to keep a backup.');
      const fail = () => ($('#data-msg').textContent = 'Copying was blocked by the browser.');
      try {
        navigator.clipboard.writeText(Store.exportJSON()).then(done, fail);
      } catch (e) {
        fail();
      }
      return;
    }
    const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tap-trainer-${Store.dayKey(Date.now())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const n = Store.importJSON(await file.text());
      $('#data-msg').textContent = `Imported ${n} sets.`;
      renderHistory();
    } catch (err) {
      $('#data-msg').textContent = 'Could not import: ' + err.message;
    }
    e.target.value = '';
  });
  $('#clear').addEventListener('click', () => {
    const btn = $('#clear');
    if (Date.now() > S.clearConfirmUntil) {
      S.clearConfirmUntil = Date.now() + 5000;
      btn.textContent = 'Click again to delete everything';
      setTimeout(() => (btn.textContent = 'Clear history'), 5000);
      return;
    }
    S.clearConfirmUntil = 0;
    btn.textContent = 'Clear history';
    $('#data-msg').textContent = 'History cleared.';
    Store.clearSets();
    renderHistory();
    updateDayBanner();
  });

  // ----------------------------------------------------------------- tabs

  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      if (isActive()) finish('manual');
      $$('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
      $$('.view').forEach((v) => (v.hidden = v.id !== `view-${t.dataset.view}`));
      if (t.dataset.view === 'history') renderHistory();
    }),
  );

  // ------------------------------------------------------------------ go

  applySettingsToUI();
  resetLive();
  updateDayBanner();
  updateRestButton();
})();
