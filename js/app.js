/*
 * App wiring. There is one flow: a guided session.
 *
 *   warm-up → calibration (relaxed, break, max) → 5 work sets → cool-down
 *
 * The calibration sets the day's training zone; work sets run on the metronome
 * inside it and adapt after each set. This file handles input capture, the
 * session steps, the metronome and note track, live monitoring, reports, rest,
 * the discomfort check and history.
 */
(function () {
  'use strict';

  const A = window.TapAnalysis;
  const Store = window.TapStore;
  const Charts = window.TapCharts;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const ICON = { good: '✓', info: 'i', warn: '!', stop: '■' };

  const CALIB = { relaxedMs: 15000, breakMs: 15000, maxMs: 10000 };
  // Bump on every release, together with the ?v= on the CSS/JS links in index.html (a test checks they match),
  // so phones fetch the new files instead of a cached copy.
  const APP_VERSION = '4';
  const SESSION_VERSION = 2;
  const SKIP_CALIBRATION_DAYS = 7; // a calibration this recent can be reused instead of redone

  Store.load();
  let settings = Store.settings;

  const S = {
    phase: 'idle', // idle | armed | starting | running | break | done
    step: null, // the session step being run: { idx, kind, bpm, lengthSec, label }
    taps: [],
    downs: new Map(), // input id -> { pad, tap }
    padDown: [0, 0],
    monitor: null,
    startT: 0,
    grid: null,
    beats: [], // count-in beats for the note track
    judge: null, // hit ratings, combo and score on metronome steps
    fx: [], // recent hit/miss effects for the note track
    raf: 0,
    audio: null,
    calib: null, // { stage: 'relaxed' | 'max', relaxed: taps[] } during the calibration step
    breakUntil: 0,
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

  function newId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function calibLimitMs() {
    return S.calib && S.calib.stage === 'max' ? CALIB.maxMs : CALIB.relaxedMs;
  }

  function save(patch) {
    Store.saveSettings(patch);
    settings = Store.settings;
    applySettingsToUI();
  }

  // -------------------------------------------------------------- session

  const STEP_NAME = { warmup: 'Warm-up', calibrate: 'Calibration', cooldown: 'Cool-down' };
  const OUTCOME_MARK = { up: '↑', top: '↑', down: '↓', hold: '=', done: '' };

  function newSession() {
    const plan = A.planGuidedSession(settings.calibration);
    return {
      v: SESSION_VERSION,
      day: Store.dayKey(Date.now()),
      steps: plan.steps.map((st) => ({ ...st, status: 'todo', result: null })),
      idx: 0,
      zone: null,
      calTime: null,
      startBpm: null,
      workBpm: null,
      poorStreak: 0,
      topReached: false,
      message: null,
      done: false,
    };
  }

  function isTodays(g) {
    return g && g.v === SESSION_VERSION && g.day === Store.dayKey(Date.now());
  }

  /** Today's unfinished session, if any. */
  function activeSession() {
    const g = settings.guided;
    return isTodays(g) && !g.done ? g : null;
  }

  function finishedToday() {
    const g = settings.guided;
    return isTodays(g) && g.done ? g : null;
  }

  /** The step that pressing Start would run next. */
  function nextStepKind() {
    const sess = activeSession();
    return sess ? sess.steps[sess.idx].kind : 'warmup';
  }

  function stepLabel(sess, i) {
    const st = sess.steps[i];
    if (st.kind !== 'work') return STEP_NAME[st.kind];
    return `Work set ${sess.steps.slice(0, i + 1).filter((x) => x.kind === 'work').length}`;
  }

  function stepBpm(sess, i) {
    const st = sess.steps[i];
    if (st.result && st.result.bpm) return st.result.bpm;
    if (st.kind === 'work') return sess.workBpm;
    if (st.kind === 'cooldown') return sess.zone ? sess.zone.warmup : st.bpm;
    return st.bpm;
  }

  function recentCalibration() {
    const c = settings.calibration;
    return c && Date.now() - c.time < SKIP_CALIBRATION_DAYS * 86400000 ? c : null;
  }

  /** Use a calibration for this session: sets the training zone and the first work-set speed. */
  function applyCalibration(sess, cal) {
    const { zone, startBpm } = A.zoneFromCalibration(cal);
    Object.assign(sess, { zone, calTime: cal.time, startBpm, workBpm: startBpm });
  }

  function skipRemainingWork(sess) {
    for (let i = sess.idx; i < sess.steps.length; i++) if (sess.steps[i].kind === 'work') sess.steps[i].status = 'skipped';
  }

  function finishStep(sess, patch) {
    sess.idx += 1;
    if (sess.idx >= sess.steps.length) sess.done = true;
    save({ guided: sess, ...patch });
  }

  /** After a metronome step (warm-up, work set, cool-down). Returns the message for the report. */
  function advanceAfterSet(reason, res) {
    const run = S.step;
    const sess = activeSession();
    if (!sess || !run || sess.idx !== run.idx) return null;
    if (reason === 'manual') return { level: 'info', text: 'You stopped this set early, so it doesn’t count. Press Start to redo it.' };

    const step = sess.steps[sess.idx];
    const next = A.guidedAfterSet(
      { workBpm: sess.workBpm, poorStreak: sess.poorStreak, zone: sess.zone, topReached: sess.topReached },
      step,
      res,
    );
    step.status = 'done';
    step.result = { bpm: run.bpm, onTimePct: res.onTimePct, grade: res.game && res.game.grade, outcome: next.outcome };
    Object.assign(sess, { workBpm: next.workBpm, poorStreak: next.poorStreak, topReached: next.topReached, message: next.message });
    if (next.endEarly) {
      sess.idx += 1;
      skipRemainingWork(sess);
      sess.idx = sess.steps.findIndex((st) => st.kind === 'cooldown') - 1;
    }
    finishStep(sess);
    const level = next.outcome === 'down' ? 'warn' : next.outcome === 'hold' ? 'info' : 'good';
    return { level, text: next.message };
  }

  /** After the calibration step. */
  function advanceAfterCalibration(record) {
    const sess = activeSession();
    if (!sess || sess.steps[sess.idx].kind !== 'calibrate') return null;
    applyCalibration(sess, settings.calibration);
    const step = sess.steps[sess.idx];
    step.status = 'done';
    step.result = { relaxedBpm: record.relaxedBpm, maxBpm: record.maxBpm };
    sess.message = `Today’s training zone is ${sess.zone.low}–${sess.zone.high} BPM. Work sets start at ${sess.workBpm} BPM.`;
    finishStep(sess);
    return { level: 'good', text: sess.message };
  }

  function skipCalibration() {
    const sess = activeSession();
    const cal = recentCalibration();
    if (!sess || !cal || sess.steps[sess.idx].kind !== 'calibrate' || isActive()) return;
    applyCalibration(sess, cal);
    const step = sess.steps[sess.idx];
    step.status = 'skipped';
    step.result = { reused: true };
    sess.message = `Using your calibration from ${new Date(cal.time).toLocaleDateString()}: zone ${sess.zone.low}–${sess.zone.high} BPM. Work sets start at ${sess.workBpm} BPM.`;
    finishStep(sess);
  }

  function applyFeel(feel) {
    const sess = activeSession() || finishedToday();
    if (!sess) return;
    if (feel === 'pain') {
      for (let i = sess.idx; i < sess.steps.length; i++) if (sess.steps[i].status === 'todo') sess.steps[i].status = 'skipped';
      sess.done = true;
      sess.message = 'Session ended. Rest your hands for today.';
    } else if (feel === 'tight' && sess.zone) {
      const next = A.guidedAfterFeel({ workBpm: sess.workBpm, zone: sess.zone }, feel);
      sess.workBpm = next.workBpm;
      sess.message = next.message;
    }
    save({ guided: sess });
  }

  function renderSession() {
    const el = $('#guided');
    const active = activeSession();
    const finished = !active && finishedToday();
    const sess = active || finished || newSession();
    const title = active ? 'Today’s session' : finished ? 'Session complete' : 'Next session';

    let head = `<div class="guided-head"><h2>${title}</h2>`;
    if (sess.zone) head += `<span class="sub">Training zone ${sess.zone.low}–${sess.zone.high} BPM</span>`;
    let html = head + '</div>';

    html += '<ol class="plan">';
    sess.steps.forEach((st, i) => {
      const current = !finished && i === sess.idx;
      const cls = current ? 'current' : st.status;
      const mark = st.status === 'done' ? '✓' : st.status === 'skipped' ? '–' : current ? '▶' : '○';
      let meta;
      let result = '';
      if (st.kind === 'calibrate') {
        meta = st.result && st.result.reused ? 'reused last calibration' : 'relaxed 15s · break · max 10s';
        if (st.result && st.result.maxBpm) result = ` <span class="p-result">relaxed ${Math.round(st.result.relaxedBpm)} · max ${Math.round(st.result.maxBpm)}</span>`;
      } else if (st.status === 'skipped') {
        meta = 'skipped';
      } else if (st.kind === 'work' && !sess.zone) {
        meta = `set by calibration · ${st.lengthSec}s`;
      } else {
        const approx = st.kind === 'work' && st.status === 'todo' && !current ? '~' : '';
        meta = `${approx}${stepBpm(sess, i)} BPM · ${st.lengthSec}s`;
      }
      if (st.result && st.result.onTimePct != null) {
        result =
          ` <span class="p-result">${st.result.grade ? `${st.result.grade} · ` : ''}${Math.round(st.result.onTimePct * 100)}% on time ` +
          `${OUTCOME_MARK[st.result.outcome] || ''}</span>`;
      }
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
      if (work.length)
        notes.push({
          level: 'good',
          text: `${clean} of ${work.length} work sets clean, ${sess.startBpm} → ${work[work.length - 1].result.bpm} BPM.`,
        });
    }
    if (sess.topReached) notes.push({ level: 'info', text: 'You reached the top of your zone. Next session’s calibration should raise it.' });
    if (!active && !finished) {
      notes.push({
        level: 'info',
        text: settings.calibration
          ? 'Press Start to begin. You’ll warm up, then calibrate to set today’s zone.'
          : 'Your first session: warm up, then a quick calibration finds your relaxed and max speed. Work sets are built from it.',
      });
    }
    for (const n of notes) {
      html += `<div class="alert guided-msg lvl-${n.level}"><span class="icon" aria-hidden="true">${ICON[n.level]}</span><span>${esc(n.text)}</span></div>`;
    }

    const links = [];
    const cal = recentCalibration();
    if (active && sess.steps[sess.idx].kind === 'calibrate' && cal) {
      const days = Math.floor((Date.now() - cal.time) / 86400000);
      const when = days === 0 ? 'from earlier today' : days === 1 ? 'from yesterday' : `from ${days} days ago`;
      links.push(`<button type="button" class="linkish" id="g-skip">Skip and reuse my calibration ${when}</button>`);
    }
    if (active && sess.idx > 0) links.push('<button type="button" class="linkish" id="g-reset">Start this session over</button>');
    if (links.length) html += `<p class="guided-links">${links.join('')}</p>`;

    el.innerHTML = html;
    const skip = $('#g-skip');
    if (skip) skip.addEventListener('click', skipCalibration);
    const reset = $('#g-reset');
    if (reset) reset.addEventListener('click', () => save({ guided: null }));
  }

  // ------------------------------------------------------------- settings

  const settingsEl = $('#settings');

  /** Track vs tap-count display depends on whether the next/current step uses the metronome. */
  function onTempoStep() {
    const kind = isActive() && S.step ? S.step.kind : nextStepKind();
    return kind !== 'calibrate';
  }

  function applySettingsToUI() {
    $$('input[name="style"]').forEach((r) => (r.checked = r.value === settings.style));
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
    syncStepUI();
    renderSession();
  }

  function syncStepUI() {
    const tempo = onTempoStep();
    document.body.classList.toggle('tempo', tempo);
    $('#live-extra-label').textContent = tempo ? 'on time' : 'variation';
    $('#live-taps-label').textContent = tempo ? 'combo' : 'taps';
    if (!isActive()) {
      const sess = activeSession();
      const len = sess && sess.steps[sess.idx].lengthSec;
      $('#live-time').textContent = tempo ? (len || 30).toFixed(1) : (CALIB.relaxedMs / 1000).toFixed(1);
      drawTrack();
    }
  }

  $$('input[name="style"]').forEach((r) => r.addEventListener('change', () => save({ style: r.value })));
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
      setStatus(S.calib.stage === 'relaxed' ? 'Nice and easy. Stay loose.' : 'Go! As fast as you can!');
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

    // Auto-stop protects work sets; an easy warm-up or cool-down (or a calibration) just keeps going.
    if (snap.breakdown && settings.autostop && S.step && S.step.kind === 'work') finish('breakdown');
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

    let sess = activeSession();
    if (!sess) {
      sess = newSession();
      save({ guided: sess });
    }
    const st = sess.steps[sess.idx];
    S.step = { idx: sess.idx, kind: st.kind, bpm: stepBpm(sess, sess.idx), lengthSec: st.lengthSec, label: stepLabel(sess, sess.idx) };

    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    S.earlyStart = Date.now() < S.restUntil;
    S.taps = [];
    S.grid = null;
    S.judge = null;
    S.fx = [];
    S.lastSnap = null;
    S.calib = st.kind === 'calibrate' ? { stage: 'relaxed', relaxed: null } : null;
    resetLive();
    $('#report').hidden = true;
    settingsEl.open = false;
    settingsEl.inert = true;
    document.body.classList.add('running');
    $('#start').hidden = true;
    $('#stop').hidden = false;
    syncStepUI();

    if (S.calib) {
      S.phase = 'armed';
      S.monitor = A.createLiveMonitor();
      $('#live-time').textContent = (CALIB.relaxedMs / 1000).toFixed(1);
      setStatus('Calibration, step 1 of 2: tap at a relaxed pace you could keep up for a minute. 15 seconds, starting on your first tap.');
    } else {
      S.phase = 'starting';
      setStatus(`${S.step.label} · ${S.step.bpm} BPM. Starting…`);
      try {
        await startMetronome({ bpm: S.step.bpm, sub: 4, lengthSec: S.step.lengthSec });
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
        setStatus('Calibration, step 2 of 2: as fast as you can for 10 seconds! Starts on your first tap.');
      } else {
        setStatus(`Break: shake out your hands. Step 2 (all-out speed) unlocks in ${Math.ceil(left / 1000)} s.`);
      }
    }
    if (S.phase === 'running') {
      if (!S.grid) {
        // Calibration: timed from the first tap.
        const lim = calibLimitMs();
        const el = now - S.startT;
        $('#live-time').textContent = (Math.max(0, lim - el) / 1000).toFixed(1);
        if (el >= lim) return finish('time');
        const last = S.taps[S.taps.length - 1];
        if (last && now - last.t > 1500) return finish('idle');
      } else {
        const { t0, period, count } = S.grid;
        const end = t0 + count * period;
        if (now < t0 - period / 2) {
          const beatsLeft = Math.ceil((t0 - now) / (period * S.grid.sub));
          setStatus(`${S.step.label} · ${S.step.bpm} BPM. Count-in… ${beatsLeft}`);
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

  async function startMetronome({ bpm, sub, lengthSec }) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('this browser has no Web Audio support');
    // iPhone: let the metronome play even when the ringer switch is on silent (Safari 17+).
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (e) {
      /* not supported */
    }
    if (!S.audio) S.audio = { ctx: new AC({ latencyHint: 'interactive' }), out: null };
    const ctx = S.audio.ctx;
    if (ctx.state !== 'running') await ctx.resume(); // also wakes a context paused in the background
    if (ctx.state !== 'running') throw new Error('the browser kept audio paused. Tap Start again');
    // Give the output clock a moment so the audio→performance mapping is valid.
    await new Promise((r) => setTimeout(r, 60));
    if (S.phase !== 'starting') return; // stopped before audio was ready

    const out = ctx.createGain();
    out.gain.value = 0.6;
    out.connect(ctx.destination);
    S.audio.out = out;

    const beatMs = 60000 / bpm;
    const periodMs = beatMs / sub;
    const count = Math.max(8, Math.round((lengthSec * 1000) / periodMs));
    const countIn = 4;

    // The page clock (performance.now) is the master timeline: the note track, the count-in and the
    // hit judging all use it. Clicks are scheduled on the audio clock to match, read at the same moment.
    // (The audio system's own output timestamps can be stale after the tab was in the background or
    // the audio device went idle, which put the whole chart in the past.)
    const latencyMs = (ctx.outputLatency || ctx.baseLatency || 0) * 1000;
    const perfNow = performance.now();
    const ctxNow = ctx.currentTime;
    const toCtx = (perf) => ctxNow + (perf - perfNow - latencyMs) / 1000; // so the click is *heard* at `perf`
    const firstBeat = perfNow + Math.max(150, latencyMs + 80);
    const firstNote = firstBeat + countIn * beatMs;

    for (let b = 0; b < countIn; b++) click(toCtx(firstBeat + b * beatMs), 'count');
    for (let i = 0; i < count; i++) {
      const t = toCtx(firstNote + i * periodMs);
      if (i % sub === 0) click(t, i % (sub * 4) === 0 ? 'accent' : 'beat');
      else if (settings.metroTicks) click(t, 'tick');
    }

    // The audio offset setting shifts when taps are expected (headphone/speaker delay the browser can't see).
    const off = settings.metroOffset;
    S.grid = { t0: firstNote + off, period: periodMs, count, targetBpm: bpm, sub };
    S.beats = [];
    for (let b = 0; b < countIn; b++) S.beats.push(firstBeat + b * beatMs + off);
    S.monitor = A.createLiveMonitor({ grid: S.grid });
    S.judge = A.createJudge(S.grid);
  }

  function drawTrack(now) {
    if (!onTempoStep()) return;
    TapHighway.draw($('#highway'), {
      now: now || performance.now(),
      grid: S.grid && (isActive() || S.phase === 'done') ? S.grid : null,
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
    idle: 'Set ended: you stopped tapping.',
    manual: 'Set stopped.',
    breakdown: 'Set stopped automatically because your form broke down.',
    calibrated: 'Calibration complete.',
  };

  function baseRecord(res, reason) {
    return {
      id: newId(),
      time: Date.now(),
      mode: res.mode,
      style: settings.style,
      n: res.n,
      durationMs: Math.round(res.durationMs),
      reason,
      level: res.level,
      issues: res.issues.filter((i) => i.level !== 'good').map((i) => i.title),
      feel: null,
      guided: true,
      guidedStep: S.step ? S.step.kind : null,
    };
  }

  function finish(reason) {
    if (!isActive()) return;
    if (S.calib) return finishCalibration(reason);
    const wasArmed = S.phase === 'armed' || S.phase === 'starting';
    const stopT = performance.now();
    S.phase = 'done';
    endUI();
    if (wasArmed) {
      setStatus('Set cancelled.');
      return syncStepUI();
    }

    let grid = S.grid;
    if (reason !== 'time') {
      // Only score the notes that were actually played before stopping.
      const played = Math.floor((stopT - grid.t0) / grid.period) + 1;
      grid = { ...grid, count: Math.max(1, Math.min(grid.count, played)) };
    }
    const res = A.analyzeMetronome(S.taps, grid, { alternate: settings.style === 'alternate', keyNames: keyNames() });
    if (!res.ok) {
      setStatus(`${REASONS[reason]} ${res.reason} This set doesn’t count. Press Start to redo it.`);
      return syncStepUI();
    }
    res.game = S.judge.summary(grid.count);

    if (reason === 'breakdown') {
      res.issues = res.issues.filter((i) => i.level !== 'good');
      res.issues.unshift({
        level: 'stop',
        title: 'Stopped: form broke down',
        detail: `${S.lastSnap && S.lastSnap.alert ? S.lastSnap.alert.text + ' ' : ''}Rest, then go again a little slower.`,
      });
      res.level = 'stop';
    }
    metronomeRecords(res);
    if (S.earlyStart) {
      res.issues.push({
        level: 'info',
        title: 'Started before resting',
        detail: 'You began this set before the rest timer finished. Leftover fatigue will drag the result down.',
      });
    }

    const record = Object.assign(baseRecord(res, reason), {
      targetBpm: res.targetBpm,
      subdiv: S.grid.sub,
      onTimePct: +res.onTimePct.toFixed(3),
      unstableRate: +res.unstableRate.toFixed(1),
      meanErr: +res.meanErr.toFixed(1),
      grade: res.game.grade,
      score: res.game.score,
      accuracy: +res.game.accuracy.toFixed(3),
      maxCombo: res.game.maxCombo,
      fullCombo: res.game.fullCombo,
    });
    Store.addSet(record);
    res.sessionMsg = advanceAfterSet(reason, res);
    S.step = null;

    const restSec = A.recommendedRestSec(res.durationMs, res.level);
    S.restUntil = Date.now() + restSec * 1000;
    setStatus(REASONS[reason]);
    syncStepUI();
    renderReport(res, record, reason, restSec);
    updateDayBanner();
  }

  /** Personal records on work sets. Only clean play counts, so mashing never sets a record. */
  function metronomeRecords(res) {
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
    S.step = null;
    endUI();
    setStatus(msg);
    syncStepUI();
  }

  function finishCalibration(reason) {
    const stage = S.calib.stage;
    const running = S.phase === 'running';
    if (!running || reason !== 'time') {
      if (reason === 'idle') {
        return cancelCalibration(`Calibration cancelled: you stopped tapping. Keep going for the full ${stage === 'relaxed' ? 15 : 10} seconds.`);
      }
      return cancelCalibration('Calibration cancelled. Press Start to try it again.');
    }
    const taps = S.taps.filter((t) => t.t <= S.startT + calibLimitMs());

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
    const res = A.analyzeCalibration(S.calib.relaxed, taps, { alternate: settings.style === 'alternate', keyNames: keyNames() });
    S.calib = null;
    if (!res.ok) {
      S.step = null;
      setStatus(res.reason);
      return syncStepUI();
    }
    calibrationRecord(res);

    const record = Object.assign(baseRecord(res, reason), {
      relaxedBpm: +res.relaxedBpm.toFixed(1),
      maxBpm: +res.maxBpm.toFixed(1),
      peakBpm: +res.peakBpm.toFixed(1),
      relaxedCv: +res.relaxed.consistency.toFixed(4),
      maxCv: +res.max.consistency.toFixed(4),
      zoneLow: res.zone.low,
      zoneHigh: res.zone.high,
      recommendBpm: res.recommendBpm,
    });
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
    res.sessionMsg = advanceAfterCalibration(record);
    S.step = null;

    const restSec = A.recommendedRestSec(res.max.durationMs, res.level);
    S.restUntil = Date.now() + restSec * 1000;
    setStatus('Calibration complete.');
    syncStepUI();
    renderReport(res, record, 'calibrated', restSec);
    updateDayBanner();
  }

  /** A new best max speed only counts if the calibration's form was clean. */
  function calibrationRecord(res) {
    const clean = (lvl) => lvl === 'good' || lvl === 'info';
    const prev = Store.sets.filter((x) => x.mode === 'calibration' && x.style === settings.style);
    if (!prev.length) return;
    const best = Math.max(0, ...prev.filter((x) => clean(x.level)).map((x) => x.maxBpm));
    if (res.maxBpm <= best) return;
    if (clean(res.level)) res.newBestMax = { bpm: res.maxBpm, prev: best };
    else
      res.issues.push({
        level: 'info',
        title: 'Fastest yet, but not a record',
        detail: 'Records only count when your form is clean. Hit this speed with an even rhythm to claim it.',
      });
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

  function alertBox(a) {
    return `<div class="alert lvl-${a.level}"><span class="icon" aria-hidden="true">${ICON[a.level]}</span><span>${esc(a.text)}</span></div>`;
  }

  function renderReport(res, record, reason, restSec) {
    const el = $('#report');
    const names = keyNames();
    const title = res.mode === 'calibration' ? 'Calibration' : STEP_NAME[record.guidedStep] || 'Work set';
    let html = `<h2>${title}</h2><p class="sub">${esc(REASONS[reason])} Rest about ${fmtClock(restSec)} before the next step.</p>`;

    if (res.mode === 'calibration') {
      html +=
        '<div class="tiles">' +
        tile(Math.round(res.relaxedBpm), 'relaxed BPM') +
        tile(Math.round(res.maxBpm), 'max BPM (average)') +
        tile(Math.round(res.peakBpm), 'max peak (16 taps)') +
        tile(`${Math.round(res.ratio * 100)}%`, 'relaxed as % of max') +
        tile(`${Math.round(res.relaxed.consistency * 100)}% / ${Math.round(res.max.consistency * 100)}%`, 'variation relaxed / max') +
        '</div>';
      if (res.newBestMax)
        html += `<div class="badges"><span class="badge">New best max: ${Math.round(res.newBestMax.bpm)} BPM${res.newBestMax.prev ? ` (was ${Math.round(res.newBestMax.prev)})` : ''}</span></div>`;
      html += `<ul class="zones">
        <li><span class="z-name">Warm-up</span><span class="z-bpm">≤ ${res.zone.warmup} BPM</span><span class="z-note">Easy, loose.</span></li>
        <li><span class="z-name">Training zone</span><span class="z-bpm">${res.zone.low}–${res.zone.high} BPM</span><span class="z-note">Today’s work sets.</span></li>
        <li><span class="z-name">Max</span><span class="z-bpm">${res.zone.high + 1}+ BPM</span><span class="z-note">Only tested during calibration. Don’t practise here.</span></li>
      </ul>`;
      if (res.sessionMsg) html += alertBox(res.sessionMsg);
      html += issueList(res.issues);
      html += '<div class="chart"><h3>Relaxed vs max</h3><p class="sub">Rolling speed over 8 taps in each step. Shaded = your training zone.</p><div id="rep-a"></div></div>';
    } else {
      const offMs = Math.round(res.meanErr) || 0; // avoid showing "-0"
      const sign = offMs > 0 ? '+' : '';
      const g = res.game;
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
      if (res.sessionMsg) html += alertBox(res.sessionMsg);
      html +=
        '<div class="tiles">' +
        tile(res.targetBpm, 'target BPM') +
        tile(`${Math.round(res.onTimePct * 100)}%`, `on time (±${Math.round(res.window)} ms)`) +
        tile(Math.round(res.unstableRate), 'unstable rate') +
        tile(`${sign}${offMs} ms`, 'average offset') +
        tile(`${res.misses} / ${res.extras}`, 'missed / extra') +
        '</div>';
      html += issueList(res.issues);
      if (Math.abs(res.meanErr) > 10 && res.sd < res.period * 0.25) {
        const newOff = settings.metroOffset + Math.round(res.meanErr);
        html += `<p class="sub">Felt on the beat? Your taps averaged ${sign}${offMs} ms. That is probably audio delay.
          <button type="button" class="secondary" id="set-offset">Set audio offset to ${newOff} ms</button></p>`;
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

    const offsetBtn = $('#set-offset');
    if (offsetBtn)
      offsetBtn.addEventListener('click', () => {
        save({ metroOffset: settings.metroOffset + Math.round(res.meanErr) });
        offsetBtn.textContent = `Offset set to ${settings.metroOffset} ms`;
        offsetBtn.disabled = true;
      });

    const FEEL = {
      fine: { level: 'good', text: 'Good. Rest, then carry on.' },
      tight: {
        level: 'warn',
        text: 'Take a longer rest and shake your hands out. The next work set drops 10 BPM so you can stay loose.',
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
        applyFeel(feel);
        updateDayBanner();
      }),
    );
  }

  // ------------------------------------------------- rest & daily checks

  function updateRestButton() {
    const btn = $('#start');
    const left = (S.restUntil - Date.now()) / 1000;
    let label;
    if (painToday()) label = 'Rest for today';
    else if (left > 0) label = `Rest ${fmtClock(left)} (start anyway)`;
    else {
      const sess = activeSession();
      if (!sess) label = finishedToday() ? 'Start another session' : 'Start session';
      else if (sess.steps[sess.idx].kind === 'calibrate') label = 'Start calibration';
      else label = `Start ${stepLabel(sess, sess.idx).toLowerCase()} · ${stepBpm(sess, sess.idx)} BPM`;
    }
    if (btn.textContent !== label) btn.textContent = label;
    btn.classList.toggle('resting', painToday() || left > 0);
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
    const calibs = sets.filter((s) => s.mode === 'calibration');
    const work = sets.filter((s) => s.mode === 'metronome' && (!s.guidedStep || s.guidedStep === 'work'));
    const todayCal = today.filter((s) => s.mode === 'calibration');
    const mins = today.reduce((a, s) => a + (s.durationMs || 0), 0) / 60000;
    $('#today-tiles').innerHTML =
      tile(today.length, 'sets') +
      tile(mins.toFixed(1), 'minutes tapping') +
      tile(todayCal.length ? Math.round(Math.max(...todayCal.map((s) => s.maxBpm))) : '–', 'max speed today (BPM)') +
      tile(today.filter((s) => s.level === 'good' || s.level === 'info').length, 'clean sets') +
      tile(streakDays(), 'day streak');

    const date = (s) => new Date(s.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const intFmt = (v) => (Number.isInteger(v) ? String(v) : '');
    const calTip = (s, i) => `Calibration ${i + 1} · ${date(s)}`;

    Charts.render($('#hist-calib'), {
      series: [
        { name: 'Relaxed', color: '--series-1', type: 'line', points: calibs.map((s, i) => ({ x: i + 1, y: s.relaxedBpm, tip: calTip(s, i) })) },
        { name: 'Max', color: '--series-2', type: 'line', points: calibs.map((s, i) => ({ x: i + 1, y: s.maxBpm, tip: calTip(s, i) })) },
      ],
      xFmt: intFmt,
      yFmt: (v) => `${Math.round(v)}`,
      empty: 'Your first session’s calibration starts this chart.',
    });
    Charts.render($('#hist-cv'), {
      series: [
        { name: 'Relaxed', color: '--series-1', type: 'line', points: calibs.map((s, i) => ({ x: i + 1, y: s.relaxedCv * 100, tip: calTip(s, i) })) },
        { name: 'Max', color: '--series-2', type: 'line', points: calibs.map((s, i) => ({ x: i + 1, y: s.maxCv * 100, tip: calTip(s, i) })) },
      ],
      xFmt: intFmt,
      yFmt: (v) => `${+v.toFixed(1)}%`,
      yMin: 0,
      refLines: calibs.length ? [{ y: 10, label: '10% target' }] : [],
      empty: 'Your first session’s calibration starts this chart.',
    });
    Charts.render($('#hist-metro'), {
      series: [
        {
          name: 'On time',
          color: '--series-1',
          type: 'line',
          markers: true,
          points: work.map((s, i) => ({ x: i + 1, y: s.onTimePct * 100, tip: `Set ${i + 1} · ${s.grade ? s.grade + ' · ' : ''}${s.targetBpm} BPM · ${date(s)}` })),
        },
      ],
      xFmt: intFmt,
      yFmt: (v) => `${Math.round(v)}%`,
      yMin: 0,
      yMax: 100,
      refLines: work.length ? [{ y: 90, label: '90%: speed goes up' }] : [],
      empty: 'Work sets will show here.',
    });

    const FEEL_LABEL = { fine: 'fine', tight: 'tight', pain: 'pain' };
    const KIND = (s) =>
      s.mode === 'calibration'
        ? 'Calibration'
        : s.mode === 'free'
          ? 'Speed test'
          : STEP_NAME[s.guidedStep] || 'Work set';
    const rows = [...sets].reverse().slice(0, 200);
    $('#hist-table').innerHTML =
      '<thead><tr><th>When</th><th>Step</th><th>Result</th><th>Form</th><th>Felt</th></tr></thead><tbody>' +
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
              return (
                `<tr><td>${esc(date(s))}</td><td>${KIND(s)}</td><td>${esc(result)}</td>` +
                `<td>${ICON[s.level] || ''} ${esc(form)}</td><td>${esc(FEEL_LABEL[s.feel] || '–')}</td></tr>`
              );
            })
            .join('')
        : '<tr><td colspan="5">No sets yet.</td></tr>') +
      '</tbody>';
  }

  $('#export').addEventListener('click', () => {
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
      updateDayBanner();
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
      else if (t.dataset.view === 'train') drawTrack();
    }),
  );

  // ------------------------------------------------------------------ go

  $('#app-version').textContent = APP_VERSION;
  applySettingsToUI();
  resetLive();
  updateDayBanner();
  updateRestButton();
})();
