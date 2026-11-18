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
