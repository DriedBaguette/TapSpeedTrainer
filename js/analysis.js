/*
 * TapAnalysis — pure analysis functions for tap-speed training.
 *
 * No DOM access here, so everything can be unit-tested with Node
 * (see tests/analysis.test.js).
 *
 * A "tap" is { t: number (ms, high-res), key: 0 | 1, dur: number | null }
 *   t   – when the key/pad went down
 *   key – which key/pad (0 = first/left, 1 = second/right)
 *   dur – how long it was held (ms), filled in on release; null if unknown
 *
 * Speeds are reported as BPM in 1/4 notes (the rhythm-game convention):
 *   BPM = 15000 / interval_ms   (4 taps per beat)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TapAnalysis = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ---------------------------------------------------------------- helpers

  function bpmFromInterval(ms) {
    return ms > 0 ? 15000 / ms : 0;
  }

  function mean(a) {
    if (!a.length) return NaN;
    let s = 0;
    for (const v of a) s += v;
    return s / a.length;
  }

  function stdev(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    let s = 0;
    for (const v of a) s += (v - m) * (v - m);
    return Math.sqrt(s / (a.length - 1));
  }

  function median(a) {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  /** Coefficient of variation: spread relative to the average (0.05 = 5%). */
  function cv(a) {
    const m = mean(a);
    return m > 0 ? stdev(a) / m : 0;
  }

  /** Split an array into n nearly-equal consecutive chunks. */
  function chunks(arr, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(arr.slice(Math.floor((i * arr.length) / n), Math.floor(((i + 1) * arr.length) / n)));
    }
    return out;
  }

  function intervals(taps) {
    const out = [];
    for (let i = 1; i < taps.length; i++) out.push(taps[i].t - taps[i - 1].t);
    return out;
  }

  /** Drop the single largest value — keeps one hesitation from dominating a short window. */
  function trimMax(a) {
    if (a.length < 4) return a.slice();
    const s = [...a].sort((x, y) => x - y);
    s.pop();
    return s;
  }

  function round5(x) {
    return Math.round(x / 5) * 5;
  }

  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  function pct(x) {
    return Math.round(x * 100);
  }

  /** Fastest average speed sustained over any `w` consecutive intervals. */
  function peakWindowBpm(iv, w) {
    if (!iv.length) return 0;
    w = Math.max(1, Math.min(w, iv.length));
    let sum = 0;
    for (let i = 0; i < w; i++) sum += iv[i];
    let best = sum;
    for (let i = w; i < iv.length; i++) {
      sum += iv[i] - iv[i - w];
      if (sum < best) best = sum;
    }
    return bpmFromInterval(best / w);
  }

  const LEVEL_RANK = { good: 0, info: 1, warn: 2, stop: 3 };

  function worstLevel(issues) {
    let worst = 'good';
    for (const i of issues) if (LEVEL_RANK[i.level] > LEVEL_RANK[worst]) worst = i.level;
    return worst;
  }

  // ------------------------------------------------------- shared checks

  /**
   * Two-finger alternation: are both fingers equally fast, and do they
   * actually alternate?
   */
  function analyzeAlternation(taps, stallLimit) {
    const counts = [0, 0];
    for (const t of taps) counts[t.key]++;
    let repeats = 0;
    const lr = []; // key 0 -> key 1
    const rl = []; // key 1 -> key 0
    for (let i = 1; i < taps.length; i++) {
      const iv = taps[i].t - taps[i - 1].t;
      if (taps[i].key === taps[i - 1].key) {
        repeats++;
        continue;
      }
      if (iv > stallLimit) continue;
      (taps[i - 1].key === 0 ? lr : rl).push(iv);
    }
    const mLR = mean(lr);
    const mRL = mean(rl);
    const usable = lr.length >= 4 && rl.length >= 4;
    const imbalance = usable ? Math.abs(mLR - mRL) / ((mLR + mRL) / 2) : 0;
    // If key0 -> key1 takes longer, the key-1 finger is the one landing late.
    const laggingKey = usable ? (mLR > mRL ? 1 : 0) : null;
    return {
      counts,
      repeats,
      repeatRate: taps.length > 1 ? repeats / (taps.length - 1) : 0,
      meanLR: usable ? mLR : null,
      meanRL: usable ? mRL : null,
      imbalance,
      laggingKey,
    };
  }

  /** How long keys are held — a rising hold time is a classic sign of tensing up. */
  function analyzePress(taps, meanInterval) {
    const durs = taps.map((t) => t.dur).filter((d) => d != null && d > 0);
    if (durs.length < 12) return null;
    const q = chunks(durs, 4);
    const first = mean(q[0]);
    const last = mean(q[3]);
    const avg = mean(durs);
    return {
      meanDur: avg,
      firstQuarterDur: first,
      lastQuarterDur: last,
      growth: first > 0 ? last / first : 1,
      duty: meanInterval > 0 ? avg / meanInterval : 0,
    };
  }

  function alternationIssues(alt, keyNames, issues) {
    const names = keyNames || ['key 1', 'key 2'];
    if (alt.repeatRate > 0.04) {
      issues.push({
        level: 'warn',
        title: 'Alternation is slipping',
        detail:
          `${alt.repeats} times you hit the same key twice in a row (${pct(alt.repeatRate)}% of taps). ` +
          'That usually means a finger is missing presses or you are mashing. Slow down until every tap alternates cleanly.',
      });
    } else if (alt.repeats > 0) {
      issues.push({
        level: 'info',
        title: `${alt.repeats} doubled tap${alt.repeats === 1 ? '' : 's'}`,
        detail: 'A few same-key repeats. Not a problem yet, but keep an eye on it.',
      });
    }
    if (alt.laggingKey != null) {
      const lag = names[alt.laggingKey];
      const msg =
        `“${lag}” lands ${Math.abs(alt.meanLR - alt.meanRL).toFixed(1)} ms later than its partner on average ` +
        `(${pct(alt.imbalance)}% uneven).`;
      if (alt.imbalance > 0.12) {
        issues.push({
          level: 'warn',
          title: 'Uneven fingers (galloping)',
          detail:
            msg +
            ' Your taps are pairing up instead of being evenly spaced. Practise with the metronome at a speed where both fingers land on the clicks.',
        });
      } else if (alt.imbalance > 0.06) {
        issues.push({ level: 'info', title: 'Slightly uneven fingers', detail: msg });
      }
    }
  }

  function pressIssues(press, issues) {
    if (!press) return;
    if (press.growth > 1.3) {
      issues.push({
        level: 'warn',
        title: 'Pressing harder as you go',
        detail:
          `Hold time grew from ${press.firstQuarterDur.toFixed(0)} ms to ${press.lastQuarterDur.toFixed(0)} ms (+${pct(press.growth - 1)}%). ` +
          'Longer holds usually mean your hand is tensing up. Use lighter presses and loosen your wrist and forearm.',
      });
    }
    if (press.duty > 0.75) {
      issues.push({
        level: 'info',
        title: 'Keys held down most of the time',
        detail:
          `Each key is down for ${pct(press.duty)}% of the gap between taps. Lift fully and press lighter. ` +
          'Bottoming out hard costs speed and builds tension.',
      });
    }
  }

  // ---------------------------------------------------------- free tapping

  /**
   * Analyse a speed-test set (tap as fast as you can hold).
   * opts: { alternate: boolean, keyNames: [string, string] }
   */
  function analyzeFree(taps, opts = {}) {
    const n = taps.length;
    if (n < 10) return { ok: false, reason: 'Need at least 10 taps to analyse a set.' };

    const iv = intervals(taps);
    const med = median(iv);
    const stallLimit = Math.max(2.5 * med, med + 80);
    const clean = iv.filter((v) => v <= stallLimit);
    const stalls = iv.length - clean.length;
    const durationMs = taps[n - 1].t - taps[0].t;

    const avgBpm = bpmFromInterval(durationMs / (n - 1));
    const steadyBpm = bpmFromInterval(mean(clean));
    const peakBpm = peakWindowBpm(iv, 16);
    const consistency = cv(clean);

    let quarterBpm = null;
    let fade = 0;
    let lateCvRatio = 1;
    let peakQuarter = 0;
    if (clean.length >= 16) {
      quarterBpm = chunks(clean, 4).map((c) => bpmFromInterval(mean(c)));
      const early = Math.max(quarterBpm[0], quarterBpm[1]);
      peakQuarter = quarterBpm.indexOf(Math.max(...quarterBpm));
      fade = (early - quarterBpm[3]) / early;
      const halves = chunks(clean, 2);
      const c1 = cv(halves[0]);
      lateCvRatio = c1 > 0 ? cv(halves[1]) / c1 : 1;
    }

    const alt = opts.alternate ? analyzeAlternation(taps, stallLimit) : null;
    const press = analyzePress(taps, mean(clean));

    const issues = [];

    // Rhythm consistency
    if (consistency > 0.2) {
      issues.push({
        level: 'warn',
        title: 'Uneven rhythm',
        detail:
          `Tap spacing varies by ${pct(consistency)}% on average. That is mashing, not controlled tapping. ` +
          'Drop the speed until your taps are evenly spaced. Even speed is what carries over to real play.',
      });
    } else if (consistency > 0.12) {
      issues.push({
        level: 'info',
        title: 'Rhythm could be steadier',
        detail: `Tap spacing varies by ${pct(consistency)}%. Under ~10% is a good target.`,
      });
    }

    // Speed fade
    if (quarterBpm && fade > 0.15) {
      issues.push({
        level: 'warn',
        title: `Speed fell off ${pct(fade)}%`,
        detail:
          `You went from ${Math.round(Math.max(quarterBpm[0], quarterBpm[1]))} to ${Math.round(quarterBpm[3])} BPM by the end. ` +
          (peakQuarter === 0
            ? 'You started faster than you can sustain. Begin about 5% slower and hold it.'
            : 'Fading like this usually means tension or fatigue. Shorten the set or lower the speed.'),
      });
    } else if (quarterBpm && fade > 0.08) {
      issues.push({
        level: 'info',
        title: `Slight fade (${pct(fade)}%)`,
        detail: 'Speed dropped a little toward the end. Fine for a max test; for training, pick a pace you can hold.',
      });
    }

    // Form breaking down late
    if (quarterBpm && lateCvRatio > 1.6 && cv(chunks(clean, 2)[1]) > 0.12) {
      issues.push({
        level: 'warn',
        title: 'Form broke down late in the set',
        detail:
          `Your rhythm was ${lateCvRatio.toFixed(1)}× messier in the second half. ` +
          'Practising past this point trains sloppy motion. End sets before your rhythm falls apart.',
      });
    }

    if (alt) alternationIssues(alt, opts.keyNames, issues);
    pressIssues(press, issues);

    if (stalls > 0) {
      issues.push({
        level: 'info',
        title: `${stalls} hesitation${stalls === 1 ? '' : 's'}`,
        detail: 'Short pauses where the rhythm stopped. Often a sign of the hand locking up.',
      });
    }

    const level = worstLevel(issues);
    if (level === 'good') {
      issues.unshift({
        level: 'good',
        title: 'Clean set',
        detail: 'Even rhythm, held speed, balanced fingers. This is the kind of rep worth repeating.',
      });
    }

    // Suggest a controlled practice speed: below what you can do sloppily.
    const sloppy = LEVEL_RANK[level] >= LEVEL_RANK.warn;
    const recommendBpm = round5(steadyBpm * (sloppy ? 0.85 : 0.93));

    const t0 = taps[0].t;
    const speedSeries = [];
    for (let i = 4; i < n; i++) {
      speedSeries.push({ x: (taps[i].t - t0) / 1000, y: bpmFromInterval((taps[i].t - taps[i - 4].t) / 4) });
    }
    const intervalSeries = [];
    for (let i = 1; i < n; i++) {
      intervalSeries.push({ x: (taps[i].t - t0) / 1000, y: taps[i].t - taps[i - 1].t, key: taps[i].key });
    }

    return {
      ok: true,
      mode: 'free',
      n,
      durationMs,
      avgBpm,
      steadyBpm,
      peakBpm,
      tapsPerSec: avgBpm / 15,
      consistency,
      stalls,
      quarterBpm,
      fade,
      lateCvRatio,
      alternation: alt,
      press,
      issues,
      level,
      recommendBpm,
      series: { speed: speedSeries, intervals: intervalSeries },
    };
  }

  // ------------------------------------------------------------- metronome

  /** How close to the click counts as "on time" for a given note spacing. */
  function onTimeWindow(period) {
    return clamp(period * 0.3, 15, 60);
  }

  /**
   * Analyse a metronome set.
   * grid: { t0: ms of first note, period: ms between notes, count: number of notes, targetBpm }
   * opts: { alternate, keyNames }
   */
  function analyzeMetronome(taps, grid, opts = {}) {
    const { t0, period, count } = grid;
    if (taps.length < 8) return { ok: false, reason: 'Need at least 8 taps on the beat to analyse a set.' };

    const matched = new Array(count).fill(null);
    let extras = 0;
    for (let i = 0; i < taps.length; i++) {
      const idx = Math.round((taps[i].t - t0) / period);
      if (idx < 0 || idx >= count) {
        extras++;
        continue;
      }
      const err = taps[i].t - (t0 + idx * period);
      if (matched[idx] === null) matched[idx] = { err, key: taps[i].key };
      else {
        extras++;
        if (Math.abs(err) < Math.abs(matched[idx].err)) matched[idx] = { err, key: taps[i].key };
      }
    }

    const win = onTimeWindow(period);
    const errs = [];
    const errSeries = [];
    let onTime = 0;
    for (let i = 0; i < count; i++) {
      const m = matched[i];
      if (!m) continue;
      errs.push(m.err);
      errSeries.push({ x: (i * period) / 1000, y: m.err, key: m.key });
      if (Math.abs(m.err) <= win) onTime++;
    }
    const misses = count - errs.length;
    const meanErr = mean(errs);
    const sd = stdev(errs);
    const onTimePct = onTime / count;
    const halves = chunks(errs, 2);
    const drift = errs.length >= 8 ? mean(halves[1]) - mean(halves[0]) : 0;

    const iv = intervals(taps);
    const med = median(iv);
    const stallLimit = Math.max(2.5 * med, med + 80);
    const alt = opts.alternate ? analyzeAlternation(taps, stallLimit) : null;
    const press = analyzePress(taps, period);

    const issues = [];
    const missRate = (misses + extras) / count;

    if (missRate > 0.1) {
      issues.push({
        level: 'warn',
        title: 'Can’t hold this BPM yet',
        detail:
          `${misses} missed and ${extras} extra taps (${pct(missRate)}% of notes). ` +
          'Too fast right now. Drop 10 BPM and build clean reps there.',
      });
    }
    if (drift > Math.max(12, period * 0.15)) {
      issues.push({
        level: 'warn',
        title: 'Falling behind as the set went on',
        detail:
          `You were ${drift.toFixed(0)} ms later in the second half than the first. ` +
          'Your hands couldn’t keep this speed up. That is fatigue or tension. Shorter sets or a lower BPM.',
      });
    } else if (drift < -Math.max(12, period * 0.15)) {
      issues.push({
        level: 'info',
        title: 'Rushing ahead later in the set',
        detail: `You drifted ${Math.abs(drift).toFixed(0)} ms early. Listen to the click instead of speeding up.`,
      });
    }
    if (Math.abs(meanErr) > Math.max(15, period * 0.2)) {
      issues.push({
        level: 'info',
        title: meanErr < 0 ? `Consistently early (${meanErr.toFixed(0)} ms)` : `Consistently late (+${meanErr.toFixed(0)} ms)`,
        detail:
          'If it felt on the beat to you, this is probably audio latency (common with Bluetooth headphones). ' +
          'Use the button below to calibrate it out.',
      });
    }
    const spread = sd / period;
    if (spread > 0.2) {
      issues.push({
        level: 'warn',
        title: 'Timing is scattered',
        detail:
          `Your taps scatter ±${sd.toFixed(0)} ms around the click (unstable rate ${(sd * 10).toFixed(0)}). ` +
          'Lower the BPM until your taps line up with the click.',
      });
    }

    if (alt) alternationIssues(alt, opts.keyNames, issues);
    pressIssues(press, issues);

    // Progressive overload: only move up once this speed is clean.
    let next = grid.targetBpm;
    let advice;
    const level0 = worstLevel(issues);
    if (onTimePct >= 0.9 && spread <= 0.12 && level0 !== 'warn') {
      next = grid.targetBpm + 5;
      advice = `Clean at ${grid.targetBpm}. Try ${next} BPM next set.`;
    } else if (onTimePct < 0.7 || missRate > 0.1) {
      next = Math.max(60, grid.targetBpm - 10);
      advice = `Too fast for clean reps. Drop to ${next} BPM.`;
    } else {
      advice = `Stay at ${grid.targetBpm} BPM until ≥90% of taps are on time.`;
    }

    if (level0 === 'good') {
      issues.unshift({ level: 'good', title: 'Locked in', detail: `${pct(onTimePct)}% of taps landed on the click.` });
    }

    const t00 = taps[0].t;
    const speedSeries = [];
    for (let i = 4; i < taps.length; i++) {
      speedSeries.push({ x: (taps[i].t - t0) / 1000, y: bpmFromInterval((taps[i].t - taps[i - 4].t) / 4) });
    }

    return {
      ok: true,
      mode: 'metronome',
      n: taps.length,
      durationMs: taps[taps.length - 1].t - t00,
      targetBpm: grid.targetBpm,
      period,
      window: win,
      onTimePct,
      misses,
      extras,
      meanErr,
      sd,
      unstableRate: sd * 10,
      drift,
      alternation: alt,
      press,
      issues,
      level: worstLevel(issues),
      recommendBpm: next,
      advice,
      series: { errors: errSeries, speed: speedSeries },
    };
  }

  // ------------------------------------------------------- live monitoring

  /**
   * Watches a set as it happens and flags when form breaks down, so you can
   * stop before you rehearse bad technique.
   * opts: { grid?: { t0, period } } — pass a grid in metronome mode.
   */
  function createLiveMonitor(opts = {}) {
    const W = 16;
    const taps = [];
    const errs = [];
    let peak = 0;
    let minSpread = Infinity;
    let badStreak = 0;

    return {
      push(tap) {
        taps.push(tap);
        const n = taps.length;
        const snap = { n, bpm: 0, spread: 0, peak, err: null, onTime: null, alert: null, breakdown: false };
        if (n >= 5) snap.bpm = bpmFromInterval((tap.t - taps[n - 5].t) / 4);

        if (opts.grid) {
          const { t0, period } = opts.grid;
          const idx = Math.round((tap.t - t0) / period);
          const err = tap.t - (t0 + idx * period);
          snap.err = err;
          errs.push(err);
          const recent = errs.slice(-W);
          const win = onTimeWindow(period);
          snap.onTime = recent.filter((e) => Math.abs(e) <= win).length / recent.length;
          const bad = recent.length >= W && snap.onTime < 0.5;
          badStreak = bad ? badStreak + 1 : 0;
          if (recent.length >= W && snap.onTime < 0.65) {
            snap.alert = { level: 'warn', text: 'Losing the beat. Relax and lock back onto the click.' };
          }
          if (badStreak >= 8) {
            snap.breakdown = true;
            snap.alert = { level: 'stop', text: 'You’ve lost the beat. This BPM is too fast right now.' };
          }
          return snap;
        }

        if (n > W) {
          const win = [];
          for (let i = n - W; i < n; i++) win.push(taps[i].t - taps[i - 1].t);
          const trimmed = trimMax(win);
          const b = bpmFromInterval(mean(trimmed));
          const spread = cv(trimmed);
          snap.spread = spread;
          peak = Math.max(peak, b);
          snap.peak = peak;
          if (n >= W + 8) minSpread = Math.min(minSpread, spread);

          if (n >= 32) {
            const slow = b < 0.82 * peak;
            const messy = spread > Math.max(0.22, 2.2 * minSpread);
            badStreak = slow || messy ? badStreak + 1 : 0;
            if (badStreak >= 4) {
              snap.alert = slow
                ? { level: 'warn', text: `Speed down ${pct(1 - b / peak)}% from your peak. Tension is creeping in.` }
                : { level: 'warn', text: 'Rhythm is getting messy. Loosen up.' };
            }
            if (badStreak >= 12) {
              snap.breakdown = true;
              snap.alert = {
                level: 'stop',
                text: slow
                  ? 'Speed has collapsed. Stopping here so you don’t practise tense tapping.'
                  : 'Rhythm has fallen apart. Stopping here so you don’t practise mashing.',
              };
            }
          }
        }
        return snap;
      },
    };
  }

  // ------------------------------------------------------------ rest logic

  /** Rest after a set: roughly 2× the work, at least 30 s, at most 3 min. */
  function recommendedRestSec(setDurationMs, level) {
    const base = clamp((setDurationMs / 1000) * 2, 30, 180);
    return Math.round(level === 'warn' || level === 'stop' ? Math.min(180, base * 1.5) : base);
  }

  return {
    bpmFromInterval,
    mean,
    stdev,
    median,
    cv,
    intervals,
    peakWindowBpm,
    analyzeAlternation,
    analyzePress,
    analyzeFree,
    analyzeMetronome,
    createLiveMonitor,
    recommendedRestSec,
    onTimeWindow,
    worstLevel,
  };
});
