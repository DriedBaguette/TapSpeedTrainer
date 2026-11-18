# Tap Speed Trainer

A browser app for building tapping speed (keyboard, mouse or touchscreen) **without training bad habits**.
It watches every set, tells you when your form is breaking down, and keeps you from grinding through
fatigue or pain.

No install, no build step, no account. Open `index.html` in a browser. Your data stays on your device
(browser localStorage), with export and import in the History tab.

## Modes

- **Speed test.** Tap as fast as you can hold for 10/20/30/60 s or 100/200 taps. The timer starts on your first tap.
- **Metronome.** Tap along to a click at a target BPM (1/4, 1/2 or 1/1 notes) with a one-bar count-in.
  Scores how many taps land on time, your unstable rate, and drift. Moves you up 5 BPM only once a set is clean.

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
| Form collapse | Optional **auto-stop** ends the set as soon as speed or rhythm falls apart | live |

It also enforces some training hygiene:

- **Rest timer** after each set (about 2× the set length, longer after a bad set).
- **"How do your hands feel?"** after each set. Reporting pain locks in a rest-for-today warning.
- **Daily warnings** when quality drops two sets in a row or volume gets high.
- **Audio-latency calibration** for the metronome (handy with Bluetooth headphones).

## Project layout

```
index.html          UI shell
css/style.css       styles (light + dark)
js/analysis.js      all the analysis/monitoring logic (pure, no DOM, unit-tested)
js/app.js           input capture, set flow, metronome audio, reports, history
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
