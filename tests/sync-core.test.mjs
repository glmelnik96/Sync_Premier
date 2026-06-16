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

test('detectDrift восстанавливает наклон растянутой копии', () => {
  const SC = loadSyncCore();
  const len = 4000;
  const ref = new Float64Array(len);
  for (let i = 0; i < len; i++) ref[i] = Math.abs(Math.sin(i / 7)) + Math.abs(Math.sin(i / 17));
  // clip = ref, растянутый на 0.5% (накапливает сдвиг к концу) + базовый офсет 0
  const stretch = 1.005;
  const clip = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const s = i / stretch;
    const lo = Math.floor(s), frac = s - lo;
    const v0 = (lo >= 0 && lo < len) ? ref[lo] : 0;
    const v1 = (lo + 1 < len) ? ref[lo + 1] : 0;
    clip[i] = v0 * (1 - frac) + v1 * frac;
  }
  const dtSec = 0.005;        // 5 мс на сэмпл огибающей
  const r = SC.detectDrift(ref, clip, { dtSec: dtSec, windowSamples: 400, maxLag: 200 });
  // ожидаемый slope ≈ -(stretch-1) = -0.005 (clip идёт быстрее → конец «убегает» назад)
  assert.ok(Math.abs(r.slope - (-(stretch - 1))) < 0.002, `slope=${r.slope}`);
  assert.ok(r.hasDrift, 'дрейф должен быть отмечен');
});

test('detectDrift: короткий ровный клип → slope≈0, hasDrift=false', () => {
  const SC = loadSyncCore();
  const len = 2000;
  const a = new Float64Array(len);
  for (let i = 0; i < len; i++) a[i] = Math.abs(Math.sin(i / 9));
  const r = SC.detectDrift(a, a, { dtSec: 0.005, windowSamples: 400, maxLag: 200, driftFrameThreshold: 1, fps: 25 });
  assert.ok(Math.abs(r.slope) < 1e-4, `slope=${r.slope}`);
  assert.equal(r.hasDrift, false);
});

test('globalNccPeak находит позицию шаблона в длинном сигнале (FFT-NCC)', () => {
  const SC = loadSyncCore();
  // signal длиной 8000, распознаваемая «речь» из гауссовых всплесков
  const N = 8000;
  const signal = new Float64Array(N);
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const peaks = [];
  for (let p = 0; p < 120; p++) peaks.push({ pos: rnd() * N, amp: 0.3 + rnd() });
  for (let i = 0; i < N; i++) { let v = 0; for (const pk of peaks) { const d = i - pk.pos; v += pk.amp * Math.exp(-(d * d) / 150); } signal[i] = v; }
  // template = участок сигнала со known-позиции 3000, длиной 1500, + шум и усиление (другой «микрофон»)
  const truePos = 3000, M = 1500;
  const template = new Float64Array(M);
  for (let k = 0; k < M; k++) template[k] = signal[truePos + k] * 0.7 + (rnd() - 0.5) * 0.15;
  const r = SC.globalNccPeak(signal, template);
  assert.ok(Math.abs(r.lag - truePos) <= 1, `lag=${r.lag}, ожидалось ${truePos}`);
  assert.ok(r.corr > 0.7, `corr=${r.corr}`);
});

test('globalNccPeak: тишина-шаблон → низкий corr (нет ложного матча)', () => {
  const SC = loadSyncCore();
  const N = 4096;
  const signal = new Float64Array(N);
  for (let i = 0; i < N; i++) signal[i] = Math.abs(Math.sin(i / 7)) + Math.abs(Math.sin(i / 23));
  const template = new Float64Array(800); // нули = тишина
  const r = SC.globalNccPeak(signal, template);
  assert.ok(r.corr < 0.3, `corr=${r.corr}`);
});
