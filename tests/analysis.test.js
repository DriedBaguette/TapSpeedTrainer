// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../js/analysis.js');

// Deterministic pseudo-random so tests are stable.
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** Build taps from a list of intervals, alternating keys by default. */
function tapsFrom(intervals, { alternate = true, dur = () => 40 } = {}) {
  const taps = [{ t: 1000, key: 0, dur: dur(0) }];
  intervals.forEach((iv, i) => {
    taps.push({ t: taps[taps.length - 1].t + iv, key: alternate ? (i + 1) % 2 : 0, dur: dur(i + 1) });
  });
  return taps;
}

function steady(n, ms, jitter = 0, seed = 1) {
  const r = rng(seed);
  return Array.from({ length: n }, () => ms + (r() * 2 - 1) * jitter);
}

const opts = { alternate: true, keyNames: ['Z', 'X'] };
const titles = (res) => res.issues.map((i) => i.title).join(' | ');

test('bpm conversion uses 1/4 notes', () => {
  assert.equal(A.bpmFromInterval(75), 200);
  assert.equal(A.bpmFromInterval(100), 150);
});

test('a steady, clean set is rated clean', () => {
  const res = A.analyzeFree(tapsFrom(steady(150, 80, 3)), opts);
  assert.ok(res.ok);
  assert.equal(res.level, 'good', titles(res));
  assert.ok(Math.abs(res.avgBpm - 187.5) < 2);
  assert.ok(res.consistency < 0.05);
  assert.equal(res.issues[0].title, 'Clean set');
});

test('too few taps is rejected', () => {
  assert.equal(A.analyzeFree(tapsFrom(steady(5, 80)), opts).ok, false);
});

test('speed fade is detected', () => {
  const iv = [];
  for (let i = 0; i < 160; i++) iv.push(70 + (i / 160) * 30); // 214 -> 150 BPM
  const res = A.analyzeFree(tapsFrom(iv), opts);
  assert.ok(res.fade > 0.15);
  assert.match(titles(res), /Speed fell off/);
  assert.equal(res.level, 'warn');
  assert.ok(res.recommendBpm < res.steadyBpm);
});

test('galloping (uneven fingers) is detected and names the lagging key', () => {
  // key0 -> key1 is 60 ms, key1 -> key0 is 100 ms: the Z finger lands late.
  const iv = Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? 60 : 100));
  const res = A.analyzeFree(tapsFrom(iv), opts);
  assert.ok(res.alternation.imbalance > 0.3);
  assert.equal(res.alternation.laggingKey, 0);
  assert.match(titles(res), /galloping/);
});

test('doubled keys are detected when alternating', () => {
  const taps = tapsFrom(steady(100, 80, 2));
  for (let i = 10; i < taps.length; i += 10) taps[i].key = taps[i - 1].key;
  const res = A.analyzeFree(taps, opts);
  assert.ok(res.alternation.repeats >= 9);
  assert.match(titles(res), /Alternation is slipping/);
});

test('rising hold time is flagged as tension', () => {
  const res = A.analyzeFree(tapsFrom(steady(120, 80, 2), { dur: (i) => 25 + i * 0.4 }), opts);
  assert.ok(res.press.growth > 1.3);
  assert.match(titles(res), /Pressing harder/);
});

test('mashing (high variance) is flagged', () => {
  const res = A.analyzeFree(tapsFrom(steady(120, 80, 45, 7)), opts);
  assert.match(titles(res), /Uneven rhythm|Rhythm could be steadier/);
});

test('hesitations are counted but excluded from consistency', () => {
  const iv = steady(100, 80, 2);
  iv[50] = 600;
  const res = A.analyzeFree(tapsFrom(iv), opts);
  assert.equal(res.stalls, 1);
  assert.ok(res.consistency < 0.05);
});

test('peak window finds the fastest stretch', () => {
  const iv = [...steady(30, 100), ...steady(20, 60), ...steady(30, 100)];
  assert.equal(Math.round(A.peakWindowBpm(iv, 16)), 250);
});

// ---------------------------------------------------------------- metronome

function metronomeTaps(count, period, errFn) {
  const t0 = 5000;
  const taps = [];
  for (let i = 0; i < count; i++) {
    const e = errFn(i);
    if (e === null) continue;
    taps.push({ t: t0 + i * period + e, key: i % 2, dur: 35 });
  }
  return { taps, grid: { t0, period, count, targetBpm: Math.round(15000 / period) } };
}

test('on-beat metronome set recommends going up', () => {
  const r = rng(3);
  const { taps, grid } = metronomeTaps(120, 100, () => (r() * 2 - 1) * 6);
  const res = A.analyzeMetronome(taps, grid, opts);
  assert.ok(res.onTimePct > 0.95);
  assert.equal(res.recommendBpm, grid.targetBpm + 5);
});

test('dragging behind is detected', () => {
  const { taps, grid } = metronomeTaps(120, 100, (i) => (i < 60 ? 0 : 25));
  const res = A.analyzeMetronome(taps, grid, opts);
  assert.ok(res.drift > 20);
  assert.match(titles(res), /Falling behind/);
});

test('many misses recommends dropping BPM', () => {
  const { taps, grid } = metronomeTaps(120, 80, (i) => (i % 4 === 0 ? null : 0));
  const res = A.analyzeMetronome(taps, grid, opts);
  assert.equal(res.misses, 30);
  assert.equal(res.recommendBpm, grid.targetBpm - 10);
});

test('constant offset is reported as possible latency', () => {
  const { taps, grid } = metronomeTaps(100, 120, () => 40);
  const res = A.analyzeMetronome(taps, grid, opts);
  assert.ok(Math.abs(res.meanErr - 40) < 0.001);
  assert.match(titles(res), /Consistently late/);
});

// ------------------------------------------------------------- live monitor

test('live monitor stays quiet on a steady set', () => {
  const m = A.createLiveMonitor();
  const taps = tapsFrom(steady(200, 80, 3));
  for (const t of taps) assert.equal(m.push(t).breakdown, false);
});

test('live monitor ignores a single hesitation', () => {
  const m = A.createLiveMonitor();
  const iv = steady(120, 80, 3);
  iv[60] = 500;
  for (const t of tapsFrom(iv)) assert.equal(m.push(t).breakdown, false);
});

test('live monitor flags a speed collapse', () => {
  const m = A.createLiveMonitor();
  const iv = [...steady(60, 70, 2), ...steady(60, 110, 2)];
  let broke = false;
  for (const t of tapsFrom(iv)) if (m.push(t).breakdown) broke = true;
  assert.ok(broke);
});

test('live monitor flags losing the beat in metronome mode', () => {
  const grid = { t0: 5000, period: 80 };
  const m = A.createLiveMonitor({ grid });
  let broke = false;
  for (let i = 0; i < 80; i++) {
    const err = i < 30 ? 0 : 35; // drifts half a note off
    if (m.push({ t: grid.t0 + i * grid.period + err, key: i % 2 }).breakdown) broke = true;
  }
  assert.ok(broke);
});

test('rest scales with set length and is longer after a bad set', () => {
  assert.equal(A.recommendedRestSec(10000, 'good'), 30);
  assert.equal(A.recommendedRestSec(30000, 'good'), 60);
  assert.equal(A.recommendedRestSec(30000, 'warn'), 90);
  assert.equal(A.recommendedRestSec(300000, 'good'), 180);
});

test('live BPM stays steady under normal input noise', () => {
  // Steady 180 BPM with ±8 ms of per-tap timing noise (keyboard polling, finger variation).
  const r = rng(7);
  const m = A.createLiveMonitor();
  let t = 0;
  const shown = [];
  for (let i = 0; i < 200; i++) {
    t += 83.33;
    const snap = m.push({ t: t + (r() * 2 - 1) * 8, key: i % 2 });
    if (i > 20) shown.push(snap.bpm);
  }
  assert.ok(Math.min(...shown) > 175 && Math.max(...shown) < 185, `${Math.min(...shown)}–${Math.max(...shown)}`);
});

// ------------------------------------------------------------- calibration

test('calibration sets zones between relaxed and max', () => {
  const relaxed = tapsFrom(steady(90, 120, 3, 2)); // 125 BPM
  const max = tapsFrom(steady(120, 80, 3, 3)); // 187.5 BPM
  const res = A.analyzeCalibration(relaxed, max, opts);
  assert.ok(res.ok);
  assert.ok(Math.abs(res.relaxedBpm - 125) < 2);
  assert.ok(Math.abs(res.maxBpm - 187.5) < 2);
  assert.equal(res.zone.low, 150);
  assert.equal(res.zone.high, 170);
  assert.ok(res.recommendBpm >= 150 && res.recommendBpm <= 170);
  assert.match(titles(res), /Big gap/);
});

test('calibration flags form falling apart at max', () => {
  const relaxed = tapsFrom(steady(90, 110, 3, 4));
  const max = tapsFrom(steady(120, 75, 30, 5));
  const res = A.analyzeCalibration(relaxed, max, opts);
  assert.match(titles(res), /Form falls apart/);
});

test('calibration flags pressing harder at speed', () => {
  const relaxed = tapsFrom(steady(90, 110, 2, 6), { dur: () => 40 });
  const max = tapsFrom(steady(120, 80, 2, 7), { dur: () => 60 });
  const res = A.analyzeCalibration(relaxed, max, opts);
  assert.match(titles(res), /Pressing harder when going fast/);
});

test('calibration notices a relaxed step that was actually faster', () => {
  const res = A.analyzeCalibration(tapsFrom(steady(90, 80, 2, 8)), tapsFrom(steady(90, 100, 2, 9)), opts);
  assert.match(titles(res), /faster than max/);
});

test('calibration rejects a step with too few taps', () => {
  const res = A.analyzeCalibration(tapsFrom(steady(5, 100)), tapsFrom(steady(90, 80)), opts);
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------- guided training

const cal = { time: 1, relaxedBpm: 125, zoneLow: 150, zoneHigh: 170, recommendBpm: 155 };
const fakeSet = (target, next, level = 'good') => ({ targetBpm: target, recommendBpm: next, level });

test('session plan: warm-up, calibration, 5 work sets, cool-down', () => {
  const plan = A.planGuidedSession(cal);
  assert.deepEqual(plan.steps.map((s) => s.kind), ['warmup', 'calibrate', 'work', 'work', 'work', 'work', 'work', 'cooldown']);
  assert.equal(plan.steps[0].bpm, 115); // 90% of last relaxed speed, rounded to 5
});

test('first-ever session warms up at an easy default pace', () => {
  assert.equal(A.planGuidedSession(null).steps[0].bpm, 90);
});

test('calibration sets the zone and starting work speed', () => {
  const { zone, startBpm } = A.zoneFromCalibration(cal);
  assert.deepEqual(zone, { warmup: 115, low: 150, high: 170 });
  assert.equal(startBpm, 155);
});

test('warm-up message points to calibration until the zone is known', () => {
  const before = A.guidedAfterSet({ workBpm: null, poorStreak: 0, zone: null }, { kind: 'warmup' }, null);
  assert.match(before.message, /Next: calibration/);
});

test('guided progression: up on clean, hold on close, down on rough, capped at zone top', () => {
  const zone = { low: 150, high: 170, warmup: 115 };
  const work = { kind: 'work' };
  let st = { workBpm: 160, poorStreak: 0, zone, topReached: false };
  st = A.guidedAfterSet(st, work, fakeSet(160, 165));
  assert.equal(st.outcome, 'up');
  assert.equal(st.workBpm, 165);
  st = A.guidedAfterSet(st, work, fakeSet(165, 165));
  assert.equal(st.outcome, 'hold');
  st = A.guidedAfterSet(st, work, fakeSet(165, 170));
  st = A.guidedAfterSet(st, work, fakeSet(170, 175));
  assert.equal(st.outcome, 'top');
  assert.equal(st.workBpm, 170);
  assert.ok(st.topReached);
  st = A.guidedAfterSet(st, work, fakeSet(170, 160, 'warn'));
  assert.equal(st.outcome, 'down');
  assert.equal(st.workBpm, 160);
});

test('guided session ends work sets after two rough sets in a row', () => {
  const zone = { low: 150, high: 170, warmup: 115 };
  let st = { workBpm: 150, poorStreak: 0, zone, topReached: false };
  st = A.guidedAfterSet(st, { kind: 'work' }, fakeSet(150, 140, 'warn'));
  assert.equal(st.endEarly, false);
  st = A.guidedAfterSet(st, { kind: 'work' }, fakeSet(140, 140, 'stop'));
  assert.equal(st.endEarly, true);
  assert.equal(st.workBpm, 140); // never below zone low - 10
});

test('guided feel check: tight drops 10, pain ends the session', () => {
  const st = { workBpm: 160, poorStreak: 0, zone: { low: 150, high: 170 } };
  assert.equal(A.guidedAfterFeel(st, 'tight').workBpm, 150);
  assert.equal(A.guidedAfterFeel(st, 'pain').endNow, true);
  assert.equal(A.guidedAfterFeel(st, 'fine'), st);
});

// --------------------------------------------------------------- game layer

test('judge rates taps by timing and builds combo', () => {
  const grid = { t0: 1000, period: 100, count: 10 }; // windows: perfect 15, great 30, good 50
  const j = A.createJudge(grid);
  assert.equal(j.hit(1000).judgment, 'perfect');
  assert.equal(j.hit(1110).judgment, 'perfect');
  assert.equal(j.hit(1225).judgment, 'great');
  assert.equal(j.hit(1340).judgment, 'good');
  assert.equal(j.combo, 4);
  assert.equal(j.score > 0, true);
});

test('judge: extra tap on an already-hit note breaks combo; skipped notes become misses', () => {
  const j = A.createJudge({ t0: 0, period: 100, count: 6 });
  j.hit(0);
  j.hit(100);
  assert.equal(j.hit(105).judgment, 'extra');
  assert.equal(j.combo, 0);
  j.hit(200);
  // note 3 never hit
  assert.deepEqual(j.sweep(450), [3]);
  assert.equal(j.mark(3), 'miss');
  j.hit(400);
  j.hit(500);
  const s = j.summary();
  assert.equal(s.miss, 1);
  assert.equal(s.extra, 1);
  assert.equal(s.fullCombo, false);
  assert.equal(s.maxCombo, 2); // 0,100 then extra resets; 200; miss; 400,500
});

test('judge: a late-arriving tap rescues a note just swept as missed', () => {
  const j = A.createJudge({ t0: 0, period: 100, count: 4 });
  j.sweep(95); // note 0's window (+50 ms) has closed, but it's still within the 50 ms grace
  assert.equal(j.mark(0), null);
  j.sweep(120);
  assert.equal(j.mark(0), 'miss');
  assert.equal(j.hit(10).judgment, 'perfect');
  assert.equal(j.mark(0), 'perfect');
});

test('judge ignores taps outside the chart', () => {
  const j = A.createJudge({ t0: 1000, period: 100, count: 4 });
  assert.equal(j.hit(500), null);
  assert.equal(j.hit(1500), null);
});

test('grades: S needs 95% and no misses, then A/B/C/D by accuracy', () => {
  const perfectRun = A.createJudge({ t0: 0, period: 100, count: 20 });
  for (let i = 0; i < 20; i++) perfectRun.hit(i * 100);
  const s = perfectRun.summary();
  assert.equal(s.grade, 'S');
  assert.ok(s.fullCombo);
  assert.equal(A.gradeFor(0.97, 1), 'A');
  assert.equal(A.gradeFor(0.85, 0), 'B');
  assert.equal(A.gradeFor(0.72, 0), 'C');
  assert.equal(A.gradeFor(0.5, 0), 'D');
});

test('summary over a stopped-early set only counts played notes', () => {
  const j = A.createJudge({ t0: 0, period: 100, count: 100 });
  for (let i = 0; i < 10; i++) j.hit(i * 100);
  assert.equal(j.summary(10).accuracy, 1);
});

test('day streak counts consecutive days, surviving until you train today', () => {
  const prev = (k) => {
    const d = new Date(k + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  assert.equal(A.dayStreak(['2026-11-16', '2026-11-17', '2026-11-18'], '2026-11-18', prev), 3);
  assert.equal(A.dayStreak(['2026-11-16', '2026-11-17'], '2026-11-18', prev), 2);
  assert.equal(A.dayStreak(['2026-11-15'], '2026-11-18', prev), 0);
});

test('judge: skipping a note breaks the combo before the next hit counts', () => {
  const j = A.createJudge({ t0: 0, period: 100, count: 30 });
  for (let i = 0; i < 30; i++) if (i % 6 !== 5) j.hit(i * 100); // no sweep in between
  assert.equal(j.summary().maxCombo, 5);
  assert.equal(j.summary().miss, 5);
  assert.equal(j.sweep(3200).length, 5); // the skipped notes are still reported for the track
});

// ------------------------------------------------------------------ release

test('every CSS/JS link in index.html carries the current app version (cache-busting)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  const version = app.match(/const APP_VERSION = '([^']+)'/)[1];
  const links = [...html.matchAll(/(?:href|src)="((?:css|js)\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.length >= 6);
  for (const l of links) assert.ok(l.endsWith(`?v=${version}`), `${l} should end with ?v=${version}`);
});
