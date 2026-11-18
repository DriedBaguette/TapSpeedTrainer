# Tap Speed Trainer

A browser app for building tapping speed (keyboard, mouse or touchscreen) **without training bad habits**.
It watches every set, tells you when your form is breaking down, and keeps you from grinding through
fatigue or pain.

No install, no build step, no account. Open `index.html` in a browser. Your data stays on your device
(browser localStorage), with export and import in the History tab.

## How it works

Every session follows the same guided flow. Press Start and it walks you through each step:

1. **Warm-up**: 30 s at an easy pace on the metronome.
2. **Calibration**: 15 s at a relaxed pace, a 15 s break, then 10 s all-out. This sets today's
   **training zone** (about 80–90% of max, never below your relaxed pace) and the first work-set speed.
   It also compares the two steps to show where your form breaks down at speed. If you calibrated in the
   last 7 days you can reuse that instead. Your first session always calibrates.
3. **Five work sets**: 20 s each on the metronome inside your zone. Clean set → next one +5 BPM (capped at
   the top of the zone); close → same speed; rough → −10 BPM. Two rough sets in a row skip to the cool-down.
4. **Cool-down**: 30 s easy.

Between steps there's a rest timer and a "how do your hands feel?" check: "Tight" drops the next work set
10 BPM, "Pain" ends the session. A session in progress survives closing the page.

### Game layer (metronome steps)

- **Note track**: notes scroll toward a hit line and arrive exactly on the click. With two-finger alternation
  there are two lanes (top = first key, bottom = second) so you can see which finger is next.
- **Hit ratings**: Perfect / Great / Good / Miss on every note, with an early/late hint.
- **Combo and score**: the score multiplier grows with your combo (up to 2×).
- **Grade** at the end of each set (S needs 95% accuracy with no misses, then A/B/C/D), plus a **Full combo** badge.
- **Records only count clean play**: best accuracy at a BPM, highest BPM cleared with an A or better, and a
  new best max speed only if that calibration's form was clean.
- **Day streak** in the header and History.

Speeds are BPM in 1/4 notes (rhythm-game convention): `BPM = taps per second × 15`.

## What it monitors

| Check | What it means | Where |
|---|---|---|
| Speed fade | You finish much slower than you started: tension, fatigue, or starting too fast | live + report |
| Rhythm evenness | Variation in tap spacing; high variation = mashing | live + report |
| Galloping | One finger lands late, so taps pair up. Names the lagging key | report |
| Doubled taps | Same key twice while alternating | report |
| Pressing harder | Key hold time growing through the set = tightening up | report |
| Losing the beat | Taps drifting off the click (metronome) | live + report |
| Form collapse | Optional **auto-stop** ends a work set as soon as speed or rhythm falls apart | live |

It also enforces some training hygiene:

- **Rest timer** after each set (about 2× the set length, longer after a bad set).
- **"How do your hands feel?"** after each set. Reporting pain locks in a rest-for-today warning.
- **Session control**: two rough work sets in a row end the work for the day; a warning when daily volume gets high.
- **Audio-offset setting** for the metronome (handy with Bluetooth headphones); a work-set report offers to set it for you.

## Project layout

```
index.html          UI shell
css/style.css       styles (light + dark)
js/analysis.js      all the analysis/monitoring logic (pure, no DOM, unit-tested)
js/app.js           input capture, session flow, metronome audio, reports, history
js/highway.js       the scrolling note track
js/charts.js        tiny canvas chart helper with hover tooltips
js/storage.js       localStorage persistence
tests/              node tests for analysis.js
```

## Running tests

```
node --test tests/*.test.js
```

## Hosting it

It's a static site, so GitHub Pages works: Settings → Pages → deploy from branch, root folder.
That gives you a URL you can open on your phone too.
