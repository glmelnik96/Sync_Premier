import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSyncCore } from './load-sync-core.mjs';

test('SyncCore загружается и экспортирует normXCorr', () => {
  const SC = loadSyncCore();
  assert.equal(typeof SC.normXCorr, 'function');
});

// helper: огибающая-«пик» со сдвигом
function shiftedEnvelope(len, peakAt, shift) {
  const a = new Float64Array(len), b = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    a[i] = Math.exp(-((i - peakAt) ** 2) / 50) + 0.01 * Math.sin(i / 3);
    const s = i - shift;
    b[i] = (s >= 0 && s < len) ? a[s] : 0;
  }
  return { a, b };
}

test('normXCorr восстанавливает целочисленный сдвиг точно', () => {
  const SC = loadSyncCore();
  const { a, b } = shiftedEnvelope(400, 200, 23);
  const r = SC.normXCorr(a, b, 100);
  assert.ok(Math.abs(r.lagSamples - 23) < 0.01, `lag=${r.lagSamples}`);
  assert.ok(r.corr > 0.99, `corr=${r.corr}`);
});

test('normXCorr возвращает субсэмпловый лаг через параболу', () => {
  const SC = loadSyncCore();
  const a = new Float64Array(200), b = new Float64Array(200);
  for (let i = 0; i < 200; i++) { a[i] = Math.exp(-((i - 100) ** 2) / 40); }
  // сдвиг на 10 и линейная интерполяция между сэмплами (имитация дробного сдвига 10.5)
  for (let i = 0; i < 200; i++) {
    const s = i - 10.5;
    const lo = Math.floor(s), frac = s - lo;
    const v0 = (lo >= 0 && lo < 200) ? a[lo] : 0;
    const v1 = (lo + 1 >= 0 && lo + 1 < 200) ? a[lo + 1] : 0;
    b[i] = v0 * (1 - frac) + v1 * frac;
  }
  const r = SC.normXCorr(a, b, 50);
  assert.ok(Math.abs(r.lagSamples - 10.5) < 0.2, `lag=${r.lagSamples}`);
});

test('normXCorr устойчив к аддитивному шуму (точность сохраняется)', () => {
  const SC = loadSyncCore();
  const len = 600, shift = 40;
  const a = new Float64Array(len), b = new Float64Array(len);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < len; i++) a[i] = Math.abs(Math.sin(i / 5)) + 0.5 * Math.abs(Math.sin(i / 13));
  for (let i = 0; i < len; i++) { const s = i - shift; b[i] = (s >= 0 ? a[s] : 0) + rnd() * 0.4; }
  const r = SC.normXCorr(a, b, 100);
  assert.ok(Math.abs(r.lagSamples - shift) <= 1, `lag=${r.lagSamples}`);
});

test('confidenceOk отсекает тишину (нет ложного матча)', () => {
  const SC = loadSyncCore();
  assert.equal(SC.confidenceOk(0.2, 0.5), false);
  assert.equal(SC.confidenceOk(0.7, 0.5), true);
});
