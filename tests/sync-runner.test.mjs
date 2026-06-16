import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSyncRunner } from './load-sync-runner.mjs';

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
