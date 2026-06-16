import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSyncGraph } from './load-sync-graph.mjs';

test('pickAnchorTrack выбирает дорожку с макс. покрытием', () => {
  const SG = loadSyncGraph();
  const r = SG.pickAnchorTrack([
    { index: 0, coverageSec: 100 }, { index: 1, coverageSec: 250 }, { index: 2, coverageSec: 50 }
  ]);
  assert.equal(r, 1);
});

test('resolveClipOffset: высокий corr, нет дрейфа → status sync', () => {
  const SG = loadSyncGraph();
  const r = SG.resolveClipOffset({ lagSamples: 20, corr: 0.9, dtSec: 0.005, slope: 0, hasDrift: false }, { confidenceThreshold: 0.5 });
  assert.ok(Math.abs(r.shiftSec - 0.1) < 1e-9); // 20 * 0.005
  assert.equal(r.status, 'sync');
});

test('resolveClipOffset: низкий corr → low-confidence, сдвиг не предлагается', () => {
  const SG = loadSyncGraph();
  const r = SG.resolveClipOffset({ lagSamples: 20, corr: 0.2, dtSec: 0.005, slope: 0, hasDrift: false }, { confidenceThreshold: 0.5 });
  assert.equal(r.status, 'low-confidence');
  assert.equal(r.shiftSec, 0);
});

test('resolveClipOffset: дрейф → status drift со slope', () => {
  const SG = loadSyncGraph();
  const r = SG.resolveClipOffset({ lagSamples: 5, corr: 0.8, dtSec: 0.005, slope: -0.004, hasDrift: true }, { confidenceThreshold: 0.5 });
  assert.equal(r.status, 'drift');
  assert.ok(Math.abs(r.slope - (-0.004)) < 1e-9);
});
