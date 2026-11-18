/*
 * TapStore — saves settings and set history in localStorage.
 * Everything stays on this device. Every access is wrapped in try/catch so the
 * app still works in private windows or when storage is blocked.
 */
(function (root) {
  'use strict';

  const KEY = 'tapSpeedTrainer.v1';

  const DEFAULT_SETTINGS = {
    mode: 'free',
    style: 'alternate',
    keys: [
      { code: 'KeyZ', label: 'Z' },
      { code: 'KeyX', label: 'X' },
    ],
    freeLength: 't20',
    metroBpm: 150,
    metroSubdiv: 4,
    metroLength: 20,
    metroOffset: 0,
    metroTicks: false,
    autostop: true,
    calibration: null, // latest { time, relaxedBpm, maxBpm, relaxedCv, zoneLow, zoneHigh, recommendBpm }
    guided: null, // current guided session (see app.js)
    guidedCarry: null, // { bpm, calTime } — where the next guided session starts
  };

  let memory = { settings: { ...DEFAULT_SETTINGS }, sets: [] };

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const data = JSON.parse(raw);
        memory = {
          settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
          sets: Array.isArray(data.sets) ? data.sets : [],
        };
      }
    } catch (e) {
      /* storage unavailable — keep in-memory copy */
    }
    return memory;
  }

  function write() {
    try {
      localStorage.setItem(KEY, JSON.stringify(memory));
    } catch (e) {
      /* ignore */
    }
  }

  function dayKey(d) {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }

  root.TapStore = {
    load: read,
    get settings() {
      return memory.settings;
    },
    get sets() {
      return memory.sets;
    },
    saveSettings(patch) {
      memory.settings = { ...memory.settings, ...patch };
      write();
    },
    addSet(set) {
      memory.sets.push(set);
      write();
    },
    updateSet(id, patch) {
      const s = memory.sets.find((x) => x.id === id);
      if (s) Object.assign(s, patch);
      write();
    },
    clearSets() {
      memory.sets = [];
      write();
    },
    exportJSON() {
      return JSON.stringify(memory, null, 2);
    },
    importJSON(text) {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.sets)) throw new Error('Not a Tap Speed Trainer export.');
      const ids = new Set(memory.sets.map((s) => s.id));
      for (const s of data.sets) if (s && s.id && !ids.has(s.id)) memory.sets.push(s);
      memory.sets.sort((a, b) => a.time - b.time);
      write();
      return data.sets.length;
    },
    today() {
      const k = dayKey(Date.now());
      return memory.sets.filter((s) => dayKey(s.time) === k);
    },
    dayKey,
  };
})(typeof self !== 'undefined' ? self : globalThis);
