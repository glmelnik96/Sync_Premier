import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAudioFingerprint } from './load-audio-fingerprint.mjs';
import { loadSyncCore } from './load-sync-core.mjs';

const AF = loadAudioFingerprint();
const fft = loadSyncCore().fft;
const SR = 8000;

/* детерминированный PRNG (mulberry32) — тесты воспроизводимы */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* синтетика: каждые 200мс — сумма 3 случайных синусоид 300–3000 Гц (богатая констелляция) */
function tonalSignal(durSec, seed) {
  const r = rng(seed);
  const n = Math.round(durSec * SR);
  const out = new Float32Array(n);
  const seg = Math.round(0.2 * SR);
  for (let s = 0; s < n; s += seg) {
    const f1 = 300 + r() * 2700, f2 = 300 + r() * 2700, f3 = 300 + r() * 2700;
    const end = Math.min(n, s + seg);
    for (let i = s; i < end; i++) {
      const t = i / SR;
      out[i] = 0.17 * (Math.sin(2 * Math.PI * f1 * t) + Math.sin(2 * Math.PI * f2 * t) + Math.sin(2 * Math.PI * f3 * t));
    }
  }
  return out;
}

function slice(sig, fromSec, durSec) {
  return sig.slice(Math.round(fromSec * SR), Math.round((fromSec + durSec) * SR));
}

function addNoise(sig, amp, seed) {
  const r = rng(seed);
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) out[i] = sig[i] + amp * (r() * 2 - 1);
  return out;
}

const ref = tonalSignal(60, 42);
const refFp = AF.fingerprint(ref, fft);
const qry = addNoise(slice(ref, 20, 10), 0.5, 7); // сегмент @20с + сильный шум
const qryFp = AF.fingerprint(qry, fft);

test('fingerprint: непустой, кадры соответствуют длительности', () => {
  assert.ok(refFp.size > 100, `хешей ${refFp.size}`);
  assert.ok(qryFp.size > 20, `хешей ${qryFp.size}`);
});

test('match: сегмент в шуме находится на своём офсете (глобально)', () => {
  const m = AF.match(refFp, qryFp, {});
  assert.ok(m.offSec != null);
  assert.ok(Math.abs(m.offSec - 20) < 0.2, `off=${m.offSec}`);
  assert.ok(m.votes >= 9, `votes=${m.votes}`);
  assert.ok(m.votes >= 1.75 * Math.max(1, m.votes2), `votes=${m.votes} votes2=${m.votes2}`);
});

test('match: окно приора вокруг истины — тот же офсет', () => {
  const m = AF.match(refFp, qryFp, { priorSec: 22, winSec: 5 });
  assert.ok(m.offSec != null && Math.abs(m.offSec - 20) < 0.2, `off=${m.offSec}`);
});

test('match: окно приора МИМО истины — истинный офсет не возвращается', () => {
  const m = AF.match(refFp, qryFp, { priorSec: 45, winSec: 5 });
  assert.ok(m.offSec == null || Math.abs(m.offSec - 20) > 1, `off=${m.offSec}`);
});

test('match: чужой сигнал не набирает гейт (votes<9 или conf<1.75)', () => {
  const alien = tonalSignal(10, 999); // другой seed — другой контент
  const m = AF.match(refFp, AF.fingerprint(alien, fft), {});
  const conf = m.votes2 ? m.votes / m.votes2 : (m.votes ? Infinity : 0);
  assert.ok(m.votes < 9 || conf < 1.75, `votes=${m.votes} conf=${conf}`);
});

test('hashPeaks: хеш и якорь по (f1,f2,Δt)', () => {
  const { hashes, size } = AF._hashPeaks([{ t: 3, f: 10 }, { t: 8, f: 20 }]);
  assert.equal(size, 1);
  const h = (10 * 512 + 20) * 64 + 5;
  // массив из vm-контекста — сравниваем содержимое, не референс прототипа
  assert.equal(hashes.get(h).length, 1);
  assert.equal(hashes.get(h)[0], 3);
});
