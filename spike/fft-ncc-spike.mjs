#!/usr/bin/env node
/**
 * Де-риск ядра source-based синхронизации: FFT-кросс-корреляция с ПООКОННОЙ
 * нормализацией (NCC, как matchTemplate в OpenCV). Ищет позицию короткого
 * шаблона t внутри длинного сигнала s за O(N log N), confidence в [-1,1].
 *
 * Тест: сегмент A048 (камера) ищется в полном source ZOOM (рекордер).
 * Ожидаем пик на ~218с с ОСМЫСЛЕННЫМ corr (не 0.07 из-за кривой нормализации).
 */
import { execFileSync } from 'node:child_process';

const FF = 'C:/ffmpeg/bin/ffmpeg.exe', SR = 4000, WIN = Math.round(0.02 * SR);

function envOf(path, ss, t) {
  const a = ['-hide_banner', '-v', 'error'];
  if (ss != null) a.push('-ss', String(ss));
  if (t != null) a.push('-t', String(t));
  a.push('-i', path, '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-');
  const b = execFileSync(FF, a, { maxBuffer: 1 << 30 });
  const n = Math.floor(b.length / 2), m = Math.floor(n / WIN), e = new Float64Array(m);
  for (let k = 0; k < m; k++) { let s = 0; for (let j = 0; j < WIN; j++) { const v = b.readInt16LE((k * WIN + j) * 2) / 32768; s += v * v; } e[k] = Math.sqrt(s / WIN); }
  return e;
}

/* Итеративный radix-2 FFT (re/im на месте). inverse: знак экспоненты + деление на n. */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = ncwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/* Сырая скользящая взаимная корреляция corr[lag]=sum_i s[lag+i]*t[i] через FFT. */
function rawXCorr(s, t) {
  const need = s.length + t.length;
  let L = 1; while (L < need) L <<= 1;
  const sr = new Float64Array(L), si = new Float64Array(L);
  const tr = new Float64Array(L), ti = new Float64Array(L);
  for (let i = 0; i < s.length; i++) sr[i] = s[i];
  for (let i = 0; i < t.length; i++) tr[i] = t[i];
  fft(sr, si, false); fft(tr, ti, false);
  // S * conj(T)
  const pr = new Float64Array(L), pi = new Float64Array(L);
  for (let i = 0; i < L; i++) { pr[i] = sr[i] * tr[i] + si[i] * ti[i]; pi[i] = si[i] * tr[i] - sr[i] * ti[i]; }
  fft(pr, pi, true);
  return pr; // pr[lag] ≈ corr at lag, lag in [0, s.length-t.length]
}

/* NCC: нормализуем сырую корреляцию пооконными mean/std сигнала через префикс-суммы. */
function nccPeak(s, t) {
  const M = t.length, N = s.length;
  const raw = rawXCorr(s, t);
  // префикс-суммы s и s^2
  const ps = new Float64Array(N + 1), ps2 = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) { ps[i + 1] = ps[i] + s[i]; ps2[i + 1] = ps2[i] + s[i] * s[i]; }
  let meanT = 0; for (let i = 0; i < M; i++) meanT += t[i]; meanT /= M;
  let varT = 0; for (let i = 0; i < M; i++) varT += (t[i] - meanT) * (t[i] - meanT);
  const stdT = Math.sqrt(varT);
  let best = { lag: 0, corr: -2 };
  for (let lag = 0; lag + M <= N; lag++) {
    const sumS = ps[lag + M] - ps[lag];
    const sumS2 = ps2[lag + M] - ps2[lag];
    const meanS = sumS / M;
    const varS = sumS2 - M * meanS * meanS;
    const stdS = Math.sqrt(varS > 0 ? varS : 1e-12);
    // ncc = (raw - M*meanS*meanT) / (stdS*stdT)
    const ncc = (raw[lag] - M * meanS * meanT) / ((stdS * stdT) || 1e-12);
    if (ncc > best.corr) best = { lag, corr: ncc };
  }
  return best;
}

const dt = WIN / SR;
console.log('Извлечение огибающих @' + SR + 'Гц, окно 20мс…');
const probe = envOf('D:/ClientFirst №4/Proxy/A048_04142200_C019_Proxy.mov', 28, 88); // A048 source[28..116]
const ref = envOf('D:/ClientFirst №4/Voice/ZOOM0002/ZOOM0002_Tr1.wav');            // полный ZOOM
console.log('  probe: ' + probe.length + ' точек (88с), ref: ' + ref.length + ' точек (' + Math.round(ref.length * dt) + 'с)');
const t0 = Date.now();
const r = nccPeak(ref, probe);
const matchSec = r.lag * dt;
console.log('\nFFT-NCC: match @ ' + matchSec.toFixed(1) + 'с  corr=' + r.corr.toFixed(3) + '  (' + ((Date.now() - t0) / 1000).toFixed(2) + 'с)');
console.log('ожидаемо ~218с (28 + офсет 190).');
console.log(Math.abs(matchSec - 218) < 3 && r.corr > 0.25
  ? '→ ЗЕЛЁНЫЙ: позиция верна И confidence осмысленный'
  : '→ проверяем: pos=' + matchSec.toFixed(1) + ' corr=' + r.corr.toFixed(3));
