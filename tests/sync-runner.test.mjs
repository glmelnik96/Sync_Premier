import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import { loadSyncRunner } from './load-sync-runner.mjs';

/* Загрузить sync-runner ВМЕСТЕ с зависимостями (SyncCore/SyncGraph/TrackExtractor/AudioEnvelope)
   в одном vm-контексте — чтобы протестировать runSync end-to-end с инъекцией deps. */
function loadRunnerWithDeps() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const ctx = { Array, Object, Math, String, Number, JSON, Error, RegExp, console, undefined,
    Float64Array, Float32Array, Map, Promise, setTimeout, module: { exports: {} }, exports: {} };
  ctx.global = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['sync-core.js', 'sync-graph.js', 'track-extractor.js', 'audio-envelope.js', 'sync-runner.js']) {
    vm.runInContext(readFileSync(resolve(__dirname, '../client/shared/' + f), 'utf8'), ctx);
  }
  return ctx;
}

test('buildAnchorEnvelope раскладывает огибающие клипов по sequence-времени', () => {
  const SR = loadSyncRunner();
  // два клипа опоры: clip1 в seq [0..0.5s], clip2 в seq [1.0..1.5s], dt=0.5s
  const clips = [
    { startSec: 0.0, env: new Float64Array([1, 2]) },
    { startSec: 1.0, env: new Float64Array([3, 4]) }
  ];
  const r = SR.buildAnchorEnvelope(clips, 0.5, 2.0); // dt=0.5, totalSec=2.0 → 4 точки
  // индексы: 0→t0, 1→t0.5, 2→t1.0, 3→t1.5
  assert.equal(Array.from(r.env).join(','), '1,2,3,4');
  assert.ok(Math.abs(r.dtSec - 0.5) < 1e-9);
});

test('runSync восстанавливает известный сдвиг неопорного клипа (margin-индексация)', async () => {
  const ctx = loadRunnerWithDeps();
  const dt = ctx.AudioEnvelope.WINDOW_MS / 1000; // 0.005
  // Опорная огибающая: «голос» по всей длине. Клип = её участок, сдвинутый на +0.6с.
  const N = 4000;
  const anchorEnv = new Float64Array(N);
  // Распознаваемая (непериодическая) огибающая: гауссовы «всплески» речи на детермин. позициях.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const peaks = [];
  for (let p = 0; p < 60; p++) peaks.push({ pos: rnd() * N, amp: 0.3 + rnd() });
  for (let i = 0; i < N; i++) {
    let v = 0;
    for (const pk of peaks) { const d = i - pk.pos; v += pk.amp * Math.exp(-(d * d) / 200); }
    anchorEnv[i] = v;
  }
  const clipLen = 1200;
  const clipStartSec = 5.0;                 // позиция клипа на таймлайне
  const base = Math.round(clipStartSec / dt);
  const shiftSamples = 120;                 // истинный сдвиг = +0.6с (нужно сдвинуть клип)
  const clipEnv = new Float64Array(clipLen);
  for (let k = 0; k < clipLen; k++) clipEnv[k] = anchorEnv[base + k - shiftSamples] || 0;

  const snapshot = {
    fps: 25, sequenceOutSec: N * dt,
    clips: [
      { trackType: 'audio', trackIndex: 0, nodeId: 'anchor0', startSec: 0, endSec: N * dt, inPointSec: 0 },
      { trackType: 'audio', trackIndex: 1, nodeId: 'clip1', name: 'c', startSec: clipStartSec, endSec: clipStartSec + clipLen * dt, inPointSec: 0 }
    ]
  };
  // deps: опорный клип отдаёт всю anchorEnv; неопорный — сдвинутый clipEnv.
  const deps = {
    getClipMediaPath: (id) => Promise.resolve(id + '.mov'),
    extractEnvelope: (path) => Promise.resolve(path === 'anchor0.mov' ? { env: anchorEnv, dtSec: dt } : { env: clipEnv, dtSec: dt })
  };
  const rows = await ctx.SyncRunner.runSync(snapshot, 0, deps, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'sync');
  // shiftSamples=120 → клип отстаёт; ожидаем shiftSec ≈ +0.6с (±1 сэмпл)
  assert.ok(Math.abs(rows[0].shiftSec - shiftSamples * dt) < dt * 1.5,
    `shiftSec=${rows[0].shiftSec}, ожидалось ${shiftSamples * dt}`);
  assert.ok(rows[0].confidence > 0.8, `confidence=${rows[0].confidence}`);
});
