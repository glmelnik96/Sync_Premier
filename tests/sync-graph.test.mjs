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

test('resolveSourceOffsets: BFS по графу даёт согласованные офсеты к корню', () => {
  const SG = loadSyncGraph();
  // отношение ребра: time[a] = time[b] + offset
  const sources = ['A', 'B', 'C', 'D'];
  const pairs = [
    { a: 'A', b: 'B', offset: 10, corr: 0.8 }, // time[A]=time[B]+10
    { a: 'B', b: 'C', offset: 5, corr: 0.7 },  // time[B]=time[C]+5
    { a: 'A', b: 'C', offset: 99, corr: 0.2 }  // слабое ребро — игнор
    // D изолирована
  ];
  const r = SG.resolveSourceOffsets(sources, pairs, { minCorr: 0.4 });
  // offsetToRoot: root_time = src_time + off. Проверяем относительные разности.
  const o = r.offsets;
  assert.ok(o.A != null && o.B != null && o.C != null, 'A,B,C должны быть разрешены');
  // ob = oa + 10, oc = ob + 5
  assert.ok(Math.abs((o.B - o.A) - 10) < 1e-9, `oB-oA=${o.B - o.A}`);
  assert.ok(Math.abs((o.C - o.B) - 5) < 1e-9, `oC-oB=${o.C - o.B}`);
  assert.ok(Math.abs(o[r.root]) < 1e-9, 'корень имеет офсет 0');
  assert.ok(r.unreachable.indexOf('D') >= 0, 'D недостижима');
});
