import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

/* Загрузить sync-runner со всеми зависимостями в одном vm-контексте. */
function loadCtx() {
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

/* Распознаваемый «мастер-сигнал» (непериодические всплески). */
function master(N, seed0) {
  const a = new Float64Array(N);
  let seed = seed0 || 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const peaks = [];
  for (let p = 0; p < N / 25; p++) peaks.push({ pos: rnd() * N, amp: 0.3 + rnd() });
  for (let i = 0; i < N; i++) { let v = 0; for (const pk of peaks) { const d = i - pk.pos; v += pk.amp * Math.exp(-(d * d) / 120); } a[i] = v; }
  return a;
}

test('runSourceSync: разбросанные клипы разных источников выравниваются к общим часам', async () => {
  const ctx = loadCtx();
  const dt = 0.02;
  const M = master(3000, 42);
  // источники = окна мастера. camA t0 = master 500; camB t0 = master 1200.
  const sources = {
    'ref.wav': M.subarray(0, 3000),
    'camA.mov': M.subarray(500, 1500),   // off(camA→ref) = 500 сэмплов = 10с
    'camB.mov': M.subarray(1200, 2200)   // off(camB→ref) = 1200 сэмплов = 24с
  };
  // клипы: разбросаны/непоследовательны
  const snapshot = {
    fps: 25, sequenceOutSec: 3000 * dt,
    clips: [
      { trackType: 'audio', trackIndex: 0, nodeId: 'r1', name: 'ref', mediaPath: 'ref.wav', startSec: 0,   endSec: 60, inPointSec: 0 },
      { trackType: 'audio', trackIndex: 1, nodeId: 'a1', name: 'camA', mediaPath: 'camA.mov', startSec: 555, endSec: 575, inPointSec: 2 },
      { trackType: 'audio', trackIndex: 2, nodeId: 'b1', name: 'camB', mediaPath: 'camB.mov', startSec: 800, endSec: 820, inPointSec: 0 }
    ]
  };
  const deps = {
    extractEnvelope: (path) => Promise.resolve({ env: sources[path], dtSec: dt })
  };
  const r = await ctx.SyncRunner.runSourceSync(snapshot, deps, { minCorr: 0.4 });
  const byNode = {}; r.forEach((x) => { byNode[x.nodeId] = x; });

  // Относительное выравнивание (устойчиво к выбору base компоненты):
  // K(src) = target - inPoint = base + off(src). Разности K = разности офсетов.
  const Kref = byNode.r1.targetSec - 0;   // ref in=0
  const KcamA = byNode.a1.targetSec - 2;  // camA in=2
  const KcamB = byNode.b1.targetSec - 0;  // camB in=0
  assert.ok(Math.abs((KcamA - Kref) - 10) < dt * 2, `off camA=${KcamA - Kref}, ожидалось 10`);
  assert.ok(Math.abs((KcamB - Kref) - 24) < dt * 2, `off camB=${KcamB - Kref}, ожидалось 24`);
  assert.equal(byNode.a1.status, 'sync');
  assert.equal(byNode.b1.status, 'sync');
  // все три источника — одна компонента
  assert.equal(byNode.r1.component, byNode.a1.component);
  assert.equal(byNode.a1.component, byNode.b1.component);
});

test('runClipSync: сильно-связанные источники в комнатах синхронизируются; одиночка → unsynced', async () => {
  const ctx = loadCtx();
  const dt = 0.02;
  // две независимые комнаты, в каждой две камеры слышат один и тот же звук (сильная связь)
  const r1 = master(4000, 11);
  const r2 = master(4000, 777);
  const lone = master(2000, 50021); // источник без связей ни с кем
  const sources = {
    'cam1a.wav': r1, 'cam1b.wav': r1,
    'cam2a.wav': r2, 'cam2b.wav': r2,
    'lone.wav': lone
  };
  const snapshot = {
    fps: 25, sequenceOutSec: 4000 * dt,
    clips: [
      { trackType: 'audio', trackIndex: 0, nodeId: 'c1a', name: 'c1a', mediaPath: 'cam1a.wav', startSec: 0, endSec: 80, inPointSec: 0 },
      { trackType: 'audio', trackIndex: 1, nodeId: 'c1b', name: 'c1b', mediaPath: 'cam1b.wav', startSec: 300, endSec: 380, inPointSec: 0 },
      { trackType: 'audio', trackIndex: 2, nodeId: 'c2a', name: 'c2a', mediaPath: 'cam2a.wav', startSec: 500, endSec: 580, inPointSec: 0 },
      { trackType: 'audio', trackIndex: 3, nodeId: 'c2b', name: 'c2b', mediaPath: 'cam2b.wav', startSec: 800, endSec: 880, inPointSec: 0 },
      { trackType: 'audio', trackIndex: 4, nodeId: 'lone', name: 'lone', mediaPath: 'lone.wav', startSec: 200, endSec: 240, inPointSec: 0 }
    ]
  };
  const deps = { extractEnvelope: (path, o) => {
    const full = sources[path];
    if (o && o.startSec != null) {
      const lo = Math.round(o.startSec / dt), hi = Math.round((o.startSec + o.durSec) / dt);
      return Promise.resolve({ env: full.subarray(lo, Math.min(hi, full.length)), dtSec: dt });
    }
    return Promise.resolve({ env: full, dtSec: dt });
  } };
  const rows = await ctx.SyncRunner.runClipSync(snapshot, deps, { refGate: 0.45, clipGate: 0.4 });
  const byNode = {}; rows.forEach((x) => { byNode[x.nodeId] = x; });
  // обе комнаты синхронизированы
  assert.equal(byNode.c1a.status, 'sync'); assert.equal(byNode.c1b.status, 'sync');
  assert.equal(byNode.c2a.status, 'sync'); assert.equal(byNode.c2b.status, 'sync');
  // источники одной комнаты — общий компонент; разных комнат — разные
  assert.equal(byNode.c1a.component, byNode.c1b.component);
  assert.equal(byNode.c2a.component, byNode.c2b.component);
  assert.notEqual(byNode.c1a.component, byNode.c2a.component);
  // одиночный источник без связей → unsynced (уйдёт в конец + красный label)
  assert.equal(byNode.lone.status, 'unsynced');
});
