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
    judge: null, // hit ratings, combo and score for metronome/guided sets
    fx: [], // recent hit/miss effects for the note track
    raf: 0,
    audio: null,
    restUntil: 0,
    earlyStart: false,
    lastSnap: null,
    listeningSlot: null,
    painConfirmUntil: 0,
    clearConfirmUntil: 0,
    guidedStep: null, // { idx, kind, bpm, lengthSec, label } while a guided set runs
    calib: null, // { stage: 'relaxed' | 'max', relaxed: taps[] }
    breakUntil: 0,
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

  const CALIB = { relaxedMs: 15000, breakMs: 15000, maxMs: 10000 };

  function freeLimit() {
    if (settings.mode === 'calibrate') return { ms: S.calib && S.calib.stage === 'max' ? CALIB.maxMs : CALIB.relaxedMs };
    const v = settings.freeLength;
    return v[0] === 'n' ? { taps: +v.slice(1) } : { ms: +v.slice(1) * 1000 };
  }

  /** Guided sessions run on the metronome too. */
  function usesMetronome() {
    return settings.mode === 'metronome' || settings.mode === 'guided';
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
    for (const m of ['free', 'metronome', 'calibrate', 'guided']) document.body.classList.toggle(`mode-${m}`, settings.mode === m);
    $('#live-extra-label').textContent = usesMetronome() ? 'on time' : 'variation';
    $('#live-taps-label').textContent = usesMetronome() ? 'combo' : 'taps';
    if (!isActive()) drawTrack();
    if (!isActive()) $('#live-time').textContent = !usesMetronome() && freeLimit().ms ? (freeLimit().ms / 1000).toFixed(1) : '0.0';
    renderGuided();
    const c = settings.calibration;
    $('#calib-summary').textContent = c
      ? `Last calibration (${new Date(c.time).toLocaleDateString()}): relaxed ${Math.round(c.relaxedBpm)}, max ${Math.round(c.maxBpm)}, training zone ${c.zoneLow}–${c.zoneHigh} BPM.`
      : 'You haven’t calibrated yet.';
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
    if (!isActive() || !S.grid) drawTrack();
  }

  function isActive() {
    return S.phase === 'armed' || S.phase === 'running' || S.phase === 'starting' || S.phase === 'break';
  }

  function press(pad, t, id) {
    if (S.downs.has(id)) return;
    setPadDown(pad, 1);
    const entry = { pad, tap: null };
    S.downs.set(id, entry);

    if (S.phase === 'armed') {
      S.phase = 'running';
      S.startT = t;
      setStatus(
        !S.calib ? 'Go! Keep it even.' : S.calib.stage === 'relaxed' ? 'Nice and easy. Stay loose.' : 'Go! As fast as you can!',
      );
    }
    if (S.phase !== 'running') {
      if (S.phase === 'idle' || S.phase === 'done') setStatus('Press Start when you’re ready.');
      return;
    }
    if (S.grid && t < S.grid.t0 - S.grid.period / 2) return; // tapping along to the count-in

    const tap = { t, key: pad, dur: null };
    entry.tap = tap;
    S.taps.push(tap);
    if (S.judge) {
      const r = S.judge.hit(t);
      if (r) S.fx.push({ at: t, idx: r.idx, judgment: r.judgment, err: r.err });
    }
    const snap = S.monitor.push(tap);
    S.lastSnap = snap;
    updateLive(snap);

    const lim = freeLimit();
    if (!S.grid && lim.taps && S.taps.length >= lim.taps) finish('done');
    // Auto-stop protects hard sets; an easy warm-up or cool-down just keeps going.
    else if (snap.breakdown && settings.autostop && !S.calib && !(S.guidedStep && S.guidedStep.kind !== 'work')) finish('breakdown');
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
    $('#live-time').textContent = !usesMetronome() && freeLimit().ms ? (freeLimit().ms / 1000).toFixed(1) : '0.0';
    $('#live-extra').textContent = '–';
    showAlert($('#live-alert'), null);
  }

  function updateLive(snap) {
    // Redraw the big number at most ~6 times a second so it's readable.
    const now = performance.now();
    if (!snap.bpm || now - (S.bpmShownAt || 0) > 160) {
      $('#live-bpm').textContent = snap.bpm ? Math.round(snap.bpm) : '–';
      S.bpmShownAt = now;
    }
    $('#live-taps').textContent = S.judge ? S.judge.combo : S.taps.length;
    if (S.grid) {
      $('#live-extra').textContent = snap.onTime != null ? `${Math.round(snap.onTime * 100)}%` : '–';
    } else {
      $('#live-extra').textContent = snap.spread ? `${Math.round(snap.spread * 100)}%` : '–';
    }
    showAlert($('#live-alert'), snap.alert);
  }

  // ------------------------------------------------------- guided session

  const STEP_NAME = { warmup: 'Warm-up', cooldown: 'Cool-down' };
  const OUTCOME_MARK = { up: '↑', top: '↑', down: '↓', hold: '=', done: '' };

  function stepLabel(sess, i) {
    const st = sess.steps[i];
    if (st.kind !== 'work') return STEP_NAME[st.kind];
    return `Work set ${sess.steps.slice(0, i + 1).filter((x) => x.kind === 'work').length}`;
  }

  function stepBpm(sess, i) {
    const st = sess.steps[i];
    if (st.result) return st.result.bpm;
    return st.kind === 'work' ? sess.workBpm : st.bpm;
  }

  /** Today's unfinished session for the current calibration, if there is one. */
  function guidedSession() {
    const g = settings.guided;
    const cal = settings.calibration;
    return g && cal && !g.done && g.day === Store.dayKey(Date.now()) && g.calTime === cal.time ? g : null;
  }

  function finishedGuidedToday() {
    const g = settings.guided;
    const cal = settings.calibration;
    return g && cal && g.done && g.day === Store.dayKey(Date.now()) && g.calTime === cal.time ? g : null;
  }

  function newGuidedSession() {
    const cal = settings.calibration;
    const plan = A.planGuidedSession(cal, { carry: settings.guidedCarry });
    return {
      day: Store.dayKey(Date.now()),
      calTime: cal.time,
      zone: plan.zone,
      steps: plan.steps.map((st) => ({ ...st, status: 'todo', result: null })),
      idx: 0,
      startBpm: plan.startBpm,
      workBpm: plan.startBpm,
      poorStreak: 0,
      topReached: false,
      message: null,
      done: false,
    };
  }

  function skipRemainingWork(sess) {
    for (let i = sess.idx; i < sess.steps.length; i++) if (sess.steps[i].kind === 'work') sess.steps[i].status = 'skipped';
  }

  /** Move the session on after a guided set. Returns the message to show in the report. */
  function advanceGuided(reason, res) {
    const gs = S.guidedStep;
    S.guidedStep = null;
    const sess = guidedSession();
    if (!sess || sess.idx !== gs.idx) return null;
    if (reason === 'manual') return { level: 'info', text: 'You stopped this set early, so it doesn’t count. Press Start to redo it.' };

    const step = sess.steps[sess.idx];
    const next = A.guidedAfterSet(
      { workBpm: sess.workBpm, poorStreak: sess.poorStreak, zone: sess.zone, topReached: sess.topReached },
      step,
      res,
    );
    step.status = 'done';
    step.result = { bpm: gs.bpm, onTimePct: res.onTimePct, outcome: next.outcome };
    Object.assign(sess, { workBpm: next.workBpm, poorStreak: next.poorStreak, topReached: next.topReached, message: next.message });
    sess.idx += 1;
    if (next.endEarly) {
      skipRemainingWork(sess);
      sess.idx = sess.steps.findIndex((st) => st.kind === 'cooldown');
    }
    if (sess.idx >= sess.steps.length) sess.done = true;

    const patch = { guided: sess };
    if (step.kind === 'work') patch.guidedCarry = { bpm: sess.workBpm, calTime: sess.calTime };
    save(patch);
    const level = next.outcome === 'down' ? 'warn' : next.outcome === 'hold' ? 'info' : 'good';
    return { level, text: next.message };
  }

  function applyGuidedFeel(feel) {
    const sess = guidedSession() || finishedGuidedToday();
    if (!sess) return;
    const next = A.guidedAfterFeel({ workBpm: sess.workBpm, zone: sess.zone }, feel);
    if (next.endNow) {
      skipRemainingWork(sess);
      for (let i = sess.idx; i < sess.steps.length; i++) if (sess.steps[i].status === 'todo') sess.steps[i].status = 'skipped';
      sess.done = true;
    }
    if (next !== undefined && next.message) sess.message = next.message;
    sess.workBpm = next.workBpm;
    save({ guided: sess, guidedCarry: { bpm: sess.workBpm, calTime: sess.calTime } });
  }

  function renderGuided() {
    const el = $('#guided');
    if (settings.mode !== 'guided') return;
    const cal = settings.calibration;
    if (!cal) {
      el.innerHTML =
        '<h2>Guided training</h2><p class="sub">Guided sessions are built from your calibration: your relaxed speed, your max, and the training zone between them. ' +
        'Calibrate first. It takes under a minute.</p><div class="actions"><button type="button" class="primary" id="go-calibrate">Calibrate now</button></div>';
      $('#go-calibrate').addEventListener('click', () => save({ mode: 'calibrate' }));
      return;
    }

    const active = guidedSession();
    const finished = !active && finishedGuidedToday();
    const sess = active || finished || newGuidedSession();
    const title = active ? 'Today’s session' : finished ? 'Session complete' : 'Next session';
    const ageDays = Math.floor((Date.now() - cal.time) / 86400000);

    let html =
      `<div class="guided-head"><h2>${title}</h2><span class="sub">Training zone ${sess.zone.low}–${sess.zone.high} BPM · ` +
      '<button type="button" class="linkish" id="g-recal">Recalibrate</button></span></div>';

    html += '<ol class="plan">';
    sess.steps.forEach((st, i) => {
      const current = !finished && i === sess.idx;
      const cls = current ? 'current' : st.status;
      const mark = st.status === 'done' ? '✓' : st.status === 'skipped' ? '–' : current ? '▶' : '○';
      let meta = st.status === 'skipped' ? 'skipped' : `${stepBpm(sess, i)} BPM · ${st.lengthSec}s`;
      if (st.kind === 'work' && st.status === 'todo' && !current) meta = `~${sess.workBpm} BPM · ${st.lengthSec}s`;
      const result = st.result
        ? ` <span class="p-result">${Math.round(st.result.onTimePct * 100)}% on time ${OUTCOME_MARK[st.result.outcome] || ''}</span>`
        : '';
      html +=
        `<li class="${cls}"><span class="p-mark" aria-hidden="true">${mark}</span>` +
        `<span class="p-name">${stepLabel(sess, i)}${result}</span><span class="p-meta">${meta}</span></li>`;
    });
    html += '</ol>';

    const notes = [];
    if (sess.message && (active || finished)) notes.push({ level: 'info', text: sess.message });
    if (finished) {
      const work = sess.steps.filter((st) => st.kind === 'work' && st.result);
      const clean = work.filter((st) => st.result.outcome === 'up' || st.result.outcome === 'top').length;
      notes.push({
        level: 'good',
        text:
          `${clean} of ${work.length} work sets clean, ${sess.startBpm} → ${work.length ? work[work.length - 1].result.bpm : sess.startBpm} BPM. ` +
          `Next session starts at ${sess.workBpm} BPM.`,
      });
    }
    if (sess.topReached) notes.push({ level: 'info', text: 'You reached the top of your zone. Recalibrate to raise it.' });
    if (ageDays >= 14) notes.push({ level: 'info', text: `Your calibration is ${ageDays} days old. Recalibrate so the zone matches your current speed.` });
    if (!active && !finished) notes.push({ level: 'info', text: 'Press Start below to begin. Each work set adjusts to how the last one went.' });
    for (const n of notes) {
      html += `<div class="alert guided-msg lvl-${n.level}"><span class="icon" aria-hidden="true">${ICON[n.level]}</span><span>${esc(n.text)}</span></div>`;
    }
    if (active && sess.idx > 0) html += '<p class="sub" style="margin-top:10px"><button type="button" class="linkish" id="g-reset">Start this session over</button></p>';

    el.innerHTML = html;
    $('#g-recal').addEventListener('click', () => save({ mode: 'calibrate' }));
    const reset = $('#g-reset');
    if (reset) reset.addEventListener('click', () => save({ guided: null }));
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

    S.guidedStep = null;
    if (settings.mode === 'guided') {
      if (!settings.calibration) return setStatus('Calibrate first. Guided sessions are built from your calibration.');
      let sess = guidedSession();
      if (!sess) {
        sess = newGuidedSession();
        save({ guided: sess });
      }
      const step = sess.steps[sess.idx];
      S.guidedStep = { idx: sess.idx, kind: step.kind, bpm: stepBpm(sess, sess.idx), lengthSec: step.lengthSec, label: stepLabel(sess, sess.idx) };
    }

    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    S.earlyStart = Date.now() < S.restUntil;
    S.taps = [];
    S.grid = null;
    S.lastSnap = null;
    S.calib = settings.mode === 'calibrate' ? { stage: 'relaxed', relaxed: null } : null;
    resetLive();
    $('#report').hidden = true;
    settingsEl.open = false;
    settingsEl.inert = true;
    document.body.classList.add('running');
    $('#start').hidden = true;
    $('#stop').hidden = false;
    S.judge = null;
    S.fx = [];

    if (settings.mode === 'calibrate') {
      S.phase = 'armed';
      S.monitor = A.createLiveMonitor();
      setStatus('Step 1 of 2: tap at a relaxed pace you could keep up for a minute. 15 seconds, starting on your first tap.');
    } else if (settings.mode === 'free') {
      S.phase = 'armed';
      S.monitor = A.createLiveMonitor();
      setStatus('Ready. The timer starts on your first tap.');
    } else {
      S.phase = 'starting';
      setStatus('Starting metronome…');
      try {
        await startMetronome(
          S.guidedStep ? { bpm: S.guidedStep.bpm, sub: 4, lengthSec: S.guidedStep.lengthSec } : undefined,
        );
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
    if (S.phase === 'break') {
      const left = S.breakUntil - now;
      $('#live-time').textContent = (Math.max(0, left) / 1000).toFixed(1);
      if (left <= 0) {
        S.phase = 'armed';
        S.taps = [];
        S.monitor = A.createLiveMonitor();
        resetLive();
        setStatus('Step 2 of 2: as fast as you can for 10 seconds! Starts on your first tap.');
      } else {
        setStatus(`Break: shake out your hands. Step 2 (all-out speed) unlocks in ${Math.ceil(left / 1000)} s.`);
      }
    }
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
          setStatus(`${S.guidedStep ? `${S.guidedStep.label} · ${S.guidedStep.bpm} BPM. ` : ''}Count-in… ${beatsLeft}`);
        } else if (S.taps.length === 0 && now > t0 + 2000) {
          setStatus('Tap along with the clicks!');
        } else if (now >= t0 - period / 2 && now < t0 + 100) {
          setStatus('Go!');
        }
        $('#live-time').textContent = (Math.max(0, Math.min(end - t0, end - now)) / 1000).toFixed(1);
        const missed = S.judge.sweep(now);
        if (missed.length) {
          for (const idx of missed) S.fx.push({ at: now, idx, judgment: 'miss' });
          $('#live-taps').textContent = S.judge.combo;
        }
        if (S.fx.length > 40) S.fx = S.fx.filter((f) => now - f.at < 600);
        drawTrack(now);
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

  async function startMetronome(params) {
    const { bpm, sub, lengthSec } = params || { bpm: settings.metroBpm, sub: settings.metroSubdiv, lengthSec: settings.metroLength };
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

    const beatS = 60 / bpm;
    const periodS = beatS / sub;
    const count = Math.max(8, Math.round(lengthSec / periodS));
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
    S.beats = []; // count-in beats, drawn on the note track
    for (let b = 0; b < countIn; b++) S.beats.push(toPerf(startC + b * beatS));
    S.monitor = A.createLiveMonitor({ grid: S.grid });
    S.judge = A.createJudge(S.grid);
  }

  function drawTrack(now) {
    if (!usesMetronome()) return;
    TapHighway.draw($('#highway'), {
      now: now || performance.now(),
      grid: isActive() || S.phase === 'done' ? S.grid : null,
      judge: S.judge,
      lanes: settings.style === 'alternate' ? 2 : 1,
      countIn: S.beats,
      fx: S.fx,
      held: [S.padDown[0] > 0, S.padDown[1] > 0],
    });
  }
  window.addEventListener('resize', () => {
    if (!isActive()) drawTrack();
  });

  function stopAudio() {
    if (S.audio && S.audio.out) {
      S.audio.out.disconnect();
      S.audio.out = null;
    }
  }

  // --------------------------------------------------------------- finish

  function endUI() {
    cancelAnimationFrame(S.raf);
    stopAudio();
    settingsEl.inert = false;
    document.body.classList.remove('running');
    $('#start').hidden = false;
    $('#stop').hidden = true;
    showAlert($('#live-alert'), null);
  }

  const REASONS = {
    time: 'Set complete.',
    done: 'Set complete.',
    idle: 'Set ended: you stopped tapping.',
    manual: 'Set stopped.',
    breakdown: 'Set stopped automatically because your form broke down.',
    calibrated: 'Calibration complete.',
  };

  function finish(reason) {
    if (!isActive()) return;
    if (S.calib) return finishCalibration(reason);
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
      if (res.ok && S.judge) res.game = S.judge.summary(grid.count);
    }

    if (!res.ok) {
      if (S.guidedStep) {
        S.guidedStep = null;
        return setStatus(`${REASONS[reason]} ${res.reason} This set doesn’t count. Press Start to redo it.`);
      }
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
    const cal = settings.calibration;
    if (cal && !S.guidedStep && res.mode === 'metronome' && res.targetBpm > cal.zoneHigh) {
      res.issues.push({
        level: 'info',
        title: 'Above your training zone',
        detail:
          `Your calibrated zone is ${cal.zoneLow}–${cal.zoneHigh} BPM. Above it, form usually breaks down, ` +
          'so keep sets here short and occasional, or recalibrate if you’ve got faster.',
      });
    }
    addRecords(res);
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
      if (S.guidedStep) Object.assign(record, { guided: true, guidedStep: S.guidedStep.kind });
      if (res.game) {
        Object.assign(record, {
          grade: res.game.grade,
          score: res.game.score,
          accuracy: +res.game.accuracy.toFixed(3),
          maxCombo: res.game.maxCombo,
          fullCombo: res.game.fullCombo,
        });
      }
    }
    Store.addSet(record);
    if (S.guidedStep) res.guidedMsg = advanceGuided(reason, res);

    const restSec = A.recommendedRestSec(res.durationMs, res.level);
    S.restUntil = Date.now() + restSec * 1000;
    setStatus(REASONS[reason]);
    renderReport(res, record, reason, restSec);
    updateDayBanner();
  }

  /** Personal records. Only clean play counts, so mashing never sets a record. */
  function addRecords(res) {
    const clean = (lvl) => lvl === 'good' || lvl === 'info';
    if (res.mode === 'free') {
      const prev = Store.sets.filter((x) => x.mode === 'free' && x.style === settings.style);
      const best = Math.max(0, ...prev.filter((x) => clean(x.level)).map((x) => x.avgBpm));
      if (!prev.length || res.avgBpm <= best) return;
      if (clean(res.level)) res.newBest = { bpm: res.avgBpm, prev: best };
      else
        res.issues.push({
          level: 'info',
          title: 'Fastest yet, but not a record',
          detail: 'Records only count when your form is clean. Hit this speed with an even rhythm to claim it.',
        });
      return;
    }
    if (!res.game) return;
    const prev = Store.sets.filter((x) => x.mode === 'metronome' && x.grade && x.subdiv === S.grid.sub);
    if (!prev.length) return;
    const sameBpm = prev.filter((x) => x.targetBpm === res.targetBpm);
    if (sameBpm.length && res.game.accuracy > Math.max(...sameBpm.map((x) => x.accuracy))) res.game.newBestAcc = true;
    const passed = (g) => g === 'S' || g === 'A';
    const top = Math.max(0, ...prev.filter((x) => passed(x.grade)).map((x) => x.targetBpm));
    if (passed(res.game.grade) && res.targetBpm > top) res.game.newTopBpm = true;
  }

  function cancelCalibration(msg) {
    S.phase = 'done';
    S.calib = null;
    endUI();
    setStatus(msg);
  }

  function finishCalibration(reason) {
    const stage = S.calib.stage;
    const running = S.phase === 'running';
    if (!running || reason !== 'time') {
      if (reason === 'idle') {
        return cancelCalibration(`Calibration cancelled: you stopped tapping. Keep going for the full ${stage === 'relaxed' ? 15 : 10} seconds.`);
      }
      return cancelCalibration('Calibration cancelled.');
    }
    const taps = S.taps.filter((t) => t.t <= S.startT + freeLimit().ms);

    if (stage === 'relaxed') {
      if (taps.length < 10) return cancelCalibration('Calibration cancelled: not enough taps in step 1.');
      S.calib.relaxed = taps;
      S.calib.stage = 'max';
      S.phase = 'break';
      S.breakUntil = performance.now() + CALIB.breakMs;
      showAlert($('#live-alert'), null);
      S.raf = requestAnimationFrame(tick);
      return;
    }

    S.phase = 'done';
    endUI();
    const opts = { alternate: settings.style === 'alternate', keyNames: keyNames() };
    const res = A.analyzeCalibration(S.calib.relaxed, taps, opts);
    S.calib = null;
    if (!res.ok) return setStatus(res.reason);

    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      time: Date.now(),
      mode: 'calibration',
      style: settings.style,
      n: res.n,
      durationMs: Math.round(res.durationMs),
      reason,
      level: res.level,
      issues: res.issues.filter((i) => i.level !== 'good').map((i) => i.title),
      feel: null,
      relaxedBpm: +res.relaxedBpm.toFixed(1),
      maxBpm: +res.maxBpm.toFixed(1),
      peakBpm: +res.peakBpm.toFixed(1),
      relaxedCv: +res.relaxed.consistency.toFixed(4),
      maxCv: +res.max.consistency.toFixed(4),
      zoneLow: res.zone.low,
      zoneHigh: res.zone.high,
      recommendBpm: res.recommendBpm,
    };
    Store.addSet(record);
    save({
      calibration: {
        time: record.time,
        relaxedBpm: record.relaxedBpm,
        maxBpm: record.maxBpm,
        relaxedCv: record.relaxedCv,
        zoneLow: record.zoneLow,
        zoneHigh: record.zoneHigh,
        recommendBpm: record.recommendBpm,
      },
    });

    const restSec = A.recommendedRestSec(res.max.durationMs, res.level);
    S.restUntil = Date.now() + restSec * 1000;
    setStatus('Calibration complete.');
    renderReport(res, record, 'calibrated', restSec);
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
    let html = `<h2>${res.mode === 'calibration' ? 'Calibration' : 'Set report'}</h2><p class="sub">${esc(REASONS[reason])} Rest about ${fmtClock(restSec)} before the next set.</p>`;
    const cal = settings.calibration;

    if (res.mode === 'calibration') {
      html +=
        '<div class="tiles">' +
        tile(Math.round(res.relaxedBpm), 'relaxed BPM') +
        tile(Math.round(res.maxBpm), 'max BPM (average)') +
        tile(Math.round(res.peakBpm), 'max peak (16 taps)') +
        tile(`${Math.round(res.ratio * 100)}%`, 'relaxed as % of max') +
        tile(`${Math.round(res.relaxed.consistency * 100)}% / ${Math.round(res.max.consistency * 100)}%`, 'variation relaxed / max') +
        '</div>';
      html += `<ul class="zones">
        <li><span class="z-name">Warm-up</span><span class="z-bpm">≤ ${res.zone.warmup} BPM</span><span class="z-note">Easy, loose, any time.</span></li>
        <li><span class="z-name">Training zone</span><span class="z-bpm">${res.zone.low}–${res.zone.high} BPM</span><span class="z-note">Metronome work. Move up only when sets come back clean.</span></li>
        <li><span class="z-name">Max</span><span class="z-bpm">${res.zone.high + 1}+ BPM</span><span class="z-note">Test it now and then. Don’t practise here.</span></li>
      </ul>`;
      html += issueList(res.issues);
      html += `<p class="recommend">Start metronome work at <b>${res.recommendBpm} BPM</b>.
        <button type="button" class="primary" id="go-guided">Start guided training</button>
        <button type="button" class="secondary" id="practise-at">Just set the metronome</button></p>`;
      html += '<div class="chart"><h3>Relaxed vs max</h3><p class="sub">Rolling speed over 8 taps in each step. Shaded = your training zone.</p><div id="rep-a"></div></div>';
    } else if (res.mode === 'free') {
      html +=
        '<div class="tiles">' +
        tile(Math.round(res.avgBpm), 'average BPM') +
        tile(Math.round(res.peakBpm), 'peak BPM (16 taps)') +
        tile(res.tapsPerSec.toFixed(1), 'taps / second') +
        tile(`${Math.round(res.consistency * 100)}%`, 'spacing variation') +
        (cal ? tile(`${Math.round((res.avgBpm / cal.maxBpm) * 100)}%`, 'of calibrated max') : tile(res.n, 'taps')) +
        '</div>';
      if (res.newBest)
        html += `<div class="badges"><span class="badge">New personal best: ${Math.round(res.newBest.bpm)} BPM average${res.newBest.prev ? ` (was ${Math.round(res.newBest.prev)})` : ''}</span></div>`;
      html += issueList(res.issues);
      html += `<p class="recommend">Controlled practice speed: about <b>${res.recommendBpm} BPM</b> on the metronome.
        <button type="button" class="secondary" id="practise-at">Practise at ${res.recommendBpm}</button></p>`;
      html += '<div class="chart"><h3>Speed through the set</h3><p class="sub">Rolling speed over 8 taps. A steady line is the goal.</p><div id="rep-a"></div></div>';
      html +=
        '<div class="chart"><h3>Gap before each tap</h3><p class="sub">' +
        (res.alternation ? 'If the two colours form separate bands, your fingers are uneven.' : 'A tight band means an even rhythm.') +
        '</p><div id="rep-b"></div></div>';
    } else {
      const sign = res.meanErr > 0 ? '+' : '';
      const g = res.game;
      if (g) {
        const badges = [];
        if (g.fullCombo) badges.push('Full combo');
        if (g.newTopBpm) badges.push(`New highest BPM cleared: ${res.targetBpm}`);
        if (g.newBestAcc) badges.push(`Best accuracy yet at ${res.targetBpm} BPM`);
        html +=
          `<div class="game-row"><div class="grade grade-${g.grade}" aria-label="Grade ${g.grade}">${g.grade}</div><div class="game-stats">` +
          `<div class="score">${g.score.toLocaleString()} pts</div>` +
          `<div class="line">${Math.round(g.accuracy * 100)}% accuracy · max combo ${g.maxCombo}</div>` +
          `<div class="line">Perfect ${g.perfect} · Great ${g.great} · Good ${g.good} · Miss ${g.miss}${g.extra ? ` · Extra ${g.extra}` : ''}</div>` +
          (badges.length ? `<div class="badges">${badges.map((b) => `<span class="badge">${esc(b)}</span>`).join('')}</div>` : '') +
          '</div></div>';
      }
      html +=
        '<div class="tiles">' +
        tile(res.targetBpm, 'target BPM') +
        tile(`${Math.round(res.onTimePct * 100)}%`, `on time (±${Math.round(res.window)} ms)`) +
        tile(Math.round(res.unstableRate), 'unstable rate') +
        tile(`${sign}${res.meanErr.toFixed(0)} ms`, 'average offset') +
        tile(`${res.misses} / ${res.extras}`, 'missed / extra') +
        '</div>';
      html += issueList(res.issues);
      if (res.guidedMsg) {
        html += `<div class="alert lvl-${res.guidedMsg.level}"><span class="icon" aria-hidden="true">${ICON[res.guidedMsg.level]}</span><span>${esc(res.guidedMsg.text)}</span></div>`;
      } else {
        html += `<p class="recommend">${esc(res.advice)}`;
        if (res.recommendBpm !== res.targetBpm)
          html += ` <button type="button" class="secondary" id="practise-at">Set to ${res.recommendBpm} BPM</button>`;
        html += '</p>';
      }
      if (Math.abs(res.meanErr) > 10 && res.sd < res.period * 0.25) {
        const newOff = settings.metroOffset + Math.round(res.meanErr);
        html += `<p class="sub">Felt on the beat? Your taps averaged ${sign}${res.meanErr.toFixed(0)} ms. That is probably audio delay.
          <button type="button" class="secondary" id="calibrate">Set audio offset to ${newOff} ms</button></p>`;
      }
      html +=
        '<div class="chart"><h3>Timing vs the click</h3><p class="sub">Each tap’s offset from its note. Above 0 = late, below = early. Shaded = on time.</p><div id="rep-a"></div></div>';
      html += '<div class="chart"><h3>Speed through the set</h3><p class="sub">Rolling speed over 8 taps vs target.</p><div id="rep-b"></div></div>';
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

    if (res.mode === 'calibration') {
      Charts.render($('#rep-a'), {
        series: [
          { name: 'Relaxed', color: '--series-1', type: 'line', points: res.relaxed.series.speed },
          { name: 'Max', color: '--series-2', type: 'line', points: res.max.series.speed },
        ],
        xFmt: secFmt,
        yFmt: (v) => `${Math.round(v)}`,
        band: { y0: res.zone.low, y1: res.zone.high },
      });
    } else if (res.mode === 'free') {
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
    const goGuided = $('#go-guided');
    if (goGuided)
      goGuided.addEventListener('click', () => {
        save({ mode: 'guided' });
        $('#report').hidden = true;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    const offsetBtn = $('#calibrate');
    if (offsetBtn)
      offsetBtn.addEventListener('click', () => {
        save({ metroOffset: settings.metroOffset + Math.round(res.meanErr) });
        offsetBtn.textContent = `Offset set to ${settings.metroOffset} ms`;
        offsetBtn.disabled = true;
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
        if (record.guided) applyGuidedFeel(feel);
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
      let label = 'Start';
      if (settings.mode === 'guided' && settings.calibration) {
        const sess = guidedSession();
        label = sess ? `Start ${stepLabel(sess, sess.idx).toLowerCase()} · ${stepBpm(sess, sess.idx)} BPM` : 'Start guided session';
      }
      if (btn.textContent !== label) btn.textContent = label;
      btn.classList.remove('resting');
    }
  }
  setInterval(updateRestButton, 250);

  function updateDayBanner() {
    updateStreak();
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

  // --------------------------------------------------------------- streak

  function streakDays() {
    const prevDay = (k) => {
      const d = new Date(k + 'T12:00:00');
      d.setDate(d.getDate() - 1);
      return Store.dayKey(d);
    };
    return A.dayStreak(Store.sets.map((x) => Store.dayKey(x.time)), Store.dayKey(Date.now()), prevDay);
  }

  function updateStreak() {
    const n = streakDays();
    const el = $('#streak');
    el.hidden = n < 2;
    el.textContent = `${n}-day streak`;
  }

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
      tile(today.filter((s) => s.level === 'good' || s.level === 'info').length, 'clean sets') +
      tile(streakDays(), 'day streak');

    const date = (s) => new Date(s.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const free = sets.filter((s) => s.mode === 'free');
    const calibs = sets.filter((s) => s.mode === 'calibration');
    const metro = sets.filter((s) => s.mode === 'metronome');
    const intFmt = (v) => (Number.isInteger(v) ? String(v) : '');

    Charts.render($('#hist-calib'), {
      series: [
        { name: 'Relaxed', color: '--series-1', type: 'line', points: calibs.map((s, i) => ({ x: i + 1, y: s.relaxedBpm, tip: `Calibration ${i + 1} · ${date(s)}` })) },
        { name: 'Max', color: '--series-2', type: 'line', points: calibs.map((s, i) => ({ x: i + 1, y: s.maxBpm, tip: `Calibration ${i + 1} · ${date(s)}` })) },
      ],
      xFmt: intFmt,
      yFmt: (v) => `${Math.round(v)}`,
      empty: 'Run a calibration to start tracking.',
    });
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
                  : s.mode === 'calibration'
                    ? `relaxed ${Math.round(s.relaxedBpm)} · max ${Math.round(s.maxBpm)} · zone ${s.zoneLow}–${s.zoneHigh}`
                    : `${s.grade ? `${s.grade} · ` : ''}${s.targetBpm} BPM · ${Math.round(s.onTimePct * 100)}% on time · UR ${Math.round(s.unstableRate)}`;
              const form = s.issues && s.issues.length ? s.issues.join('; ') : 'clean';
              return `<tr><td>${esc(date(s))}</td><td>${s.guided ? 'Guided' : { free: 'Speed test', metronome: 'Metronome', calibration: 'Calibration' }[s.mode] || s.mode}</td><td>${esc(result)}</td>` +
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
