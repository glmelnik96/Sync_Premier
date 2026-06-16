import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSyncWaveform } from './load-sync-waveform.mjs';

test('downsampleEnvelope сжимает до targetPx, сохраняя пики (max в бине)', () => {
  const SW = loadSyncWaveform();
  const env = new Float64Array([0, 1, 0, 0, 5, 0, 0, 0]); // 8 → 2 бина
  const r = SW.downsampleEnvelope(env, 2);
  assert.equal(r.length, 2);
  assert.equal(r[0], 1); // max первой половины
  assert.equal(r[1], 5); // max второй половины
});
