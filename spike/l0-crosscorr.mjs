#!/usr/bin/env node
/**
 * L0-СПАЙК (гейт перед разработкой) — проверка: достижима ли кадровая точность
 * кросс-корреляцией аудио-огибающих ДО написания плагина (см. SYNC-PLUGIN-HANDOFF.md §9).
 *
 * Что делает:
 *   1. Извлекает моно-PCM (через ffmpeg) из реального медиафайла проекта.
 *   2. Строит огибающую (RMS по окнам windowMs) — как будет делать продуктовый track-extractor.
 *   3. СИНТЕТИЧЕСКИЙ тест: сдвигает огибающую на известный τ + добавляет шум/усиление
 *      (имитация «другого микрофона») → восстанавливает τ нормализованной кросс-корреляцией
 *      с параболической интерполяцией → сравнивает с известным сдвигом.
 *   4. РЕАЛЬНЫЙ тест (если задан 2-й файл): корреляция огибающих двух разных камер,
 *      печатает найденный офсет и confidence пика.
 *
 * Критерий успеха (§9): ошибка ≤ 1 кадр на чистом звуке; деградация предсказуема на шуме.
 *
 * Запуск:
 *   node spike/l0-crosscorr.mjs "<mediaPathA>" ["<mediaPathB>"]
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const FPS = 25;                 // целевой проект 25fps → 1 кадр = 40 мс
const FRAME_MS = 1000 / FPS;
const WINDOW_MS = 5;            // разрешение огибающей (хендоф: 5–10 мс)
const SAMPLE_RATE = 8000;      // моно-PCM рейт для огибающей (8 кГц достаточно для RMS-конверта)
const SEGMENT_SEC = 90;        // анализируем первые N секунд (производительность спайка)

function findFfmpeg() {
  const cands = ['C:\\ffmpeg\\bin\\ffmpeg.exe', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', 'ffmpeg'];
  for (const c of cands) { try { if (c === 'ffmpeg' || existsSync(c)) return c; } catch {} }
  return 'ffmpeg';
}
const FFMPEG = findFfmpeg();

/** Извлечь моно-PCM (Float32) из первых SEGMENT_SEC секунд аудио. */
function extractPcm(path) {
  const args = [
    '-hide_banner', '-nostats', '-v', 'error',
    '-t', String(SEGMENT_SEC),
    '-i', path,
    '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-f', 's16le', '-'
  ];
  const buf = execFileSync(FFMPEG, args, { maxBuffer: 512 * 1024 * 1024 });
  const n = Math.floor(buf.length / 2);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(i * 2) / 32768;
  return pcm;
}

/** RMS-огибающая: окно WINDOW_MS, шаг WINDOW_MS. Возвращает {dtSec, env:Float64Array}. */
function envelope(pcm) {
  const win = Math.max(1, Math.round((WINDOW_MS / 1000) * SAMPLE_RATE));
  const m = Math.floor(pcm.length / win);
  const env = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    let s = 0;
    for (let j = 0; j < win; j++) { const v = pcm[k * win + j]; s += v * v; }
    env[k] = Math.sqrt(s / win);
  }
  return { dtSec: win / SAMPLE_RATE, env };
}

/** Нормализованная кросс-корреляция a vs b по лагам [-maxLag, +maxLag] (в сэмплах огибающей). */
function normXCorr(a, b, maxLag) {
  // zero-mean
  const za = zeroMean(a), zb = zeroMean(b);
  const na = norm(za), nb = norm(zb);
  const denom = (na * nb) || 1e-12;
  let best = { lag: 0, corr: -Infinity };
  const corrAt = new Map();
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    const lo = Math.max(0, -lag), hi = Math.min(za.length, zb.length - lag);
    for (let i = lo; i < hi; i++) s += za[i] * zb[i + lag];
    const c = s / denom;
    corrAt.set(lag, c);
    if (c > best.corr) best = { lag, corr: c };
  }
  // параболическая интерполяция вокруг пика → субсэмпловый лаг
  const cm = corrAt.get(best.lag - 1), cp = corrAt.get(best.lag + 1);
  let sub = 0;
  if (cm != null && cp != null) {
    const denomP = (cm - 2 * best.corr + cp);
    if (Math.abs(denomP) > 1e-12) sub = 0.5 * (cm - cp) / denomP;
  }
  return { lagSamples: best.lag + sub, corr: best.corr };
}

function zeroMean(a) {
  let m = 0; for (let i = 0; i < a.length; i++) m += a[i]; m /= a.length || 1;
  const o = new Float64Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] - m; return o;
}
function norm(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s); }

/** Сдвиг огибающей на shiftSamples (целое) + гауссов шум (noiseRatio от RMS сигнала) + усиление gain. */
function makeShifted(env, shiftSamples, noiseRatio, gain) {
  const rms = norm(env) / Math.sqrt(env.length || 1);
  const out = new Float64Array(env.length);
  for (let i = 0; i < env.length; i++) {
    const src = i - shiftSamples;
    let v = (src >= 0 && src < env.length) ? env[src] : 0;
    v *= gain;
    if (noiseRatio > 0) v += gaussian() * rms * noiseRatio;
    out[i] = v;
  }
  return out;
}
let _g2 = null;
function gaussian() {
  if (_g2 != null) { const v = _g2; _g2 = null; return v; }
  let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random();
  const mag = Math.sqrt(-2 * Math.log(u)); _g2 = mag * Math.sin(2 * Math.PI * v);
  return mag * Math.cos(2 * Math.PI * v);
}

/** Имитация «другого микрофона»: сдвиг + эхо/реверберация + опц. highpass на уровне PCM. */
function degradePcm(pcm, shiftSamples, ac) {
  const out = new Float32Array(pcm.length);
  // сдвиг
  for (let i = 0; i < pcm.length; i++) { const s = i - shiftSamples; out[i] = (s >= 0) ? pcm[s] : 0; }
  // эхо/реверберация (одно или несколько отражений)
  const D = Math.round((ac.echoMs / 1000) * SAMPLE_RATE);
  const taps = ac.multi ? [{ d: D, g: ac.echoGain }, { d: 2 * D, g: ac.echoGain * 0.5 }, { d: 3 * D, g: ac.echoGain * 0.25 }]
                        : [{ d: D, g: ac.echoGain }];
  const wet = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) {
    let v = out[i];
    for (const t of taps) { if (i - t.d >= 0) v += out[i - t.d] * t.g; }
    wet[i] = v;
  }
  // highpass (one-pole) для имитации тонкого тембра петлички
  if (ac.hp > 0) {
    let prevX = 0, prevY = 0;
    for (let i = 0; i < wet.length; i++) {
      const x = wet[i];
      const y = ac.hp * (prevY + x - prevX);
      prevX = x; prevY = y; wet[i] = y;
    }
  }
  return wet;
}

function fmt(ms) { return (ms >= 0 ? '+' : '') + ms.toFixed(1) + 'мс (' + (ms / FRAME_MS).toFixed(2) + ' кадр)'; }

function main() {
  const [pathA, pathB] = process.argv.slice(2);
  if (!pathA) { console.error('Использование: node spike/l0-crosscorr.mjs "<A>" ["<B>"]'); process.exit(2); }

  console.log('ffmpeg:', FFMPEG);
  console.log('Параметры: fps=' + FPS + ' (1 кадр=' + FRAME_MS + 'мс), окно огибающей=' + WINDOW_MS + 'мс, сегмент=' + SEGMENT_SEC + 'с\n');

  console.log('Извлечение PCM из A:', pathA);
  const pcmA = extractPcm(pathA);
  const { dtSec, env } = envelope(pcmA);
  console.log('  PCM сэмплов:', pcmA.length, '| точек огибающей:', env.length, '| dt=' + (dtSec * 1000).toFixed(1) + 'мс\n');

  // ── СИНТЕТИЧЕСКИЙ ТЕСТ: известный сдвиг + деградации ──────────────────────
  console.log('=== СИНТЕТИЧЕСКИЙ ТЕСТ (известный τ, восстановление кросс-корреляцией) ===');
  const knownShiftsSamples = [7, 23, 50, 113];   // в сэмплах огибающей
  const noiseLevels = [
    { label: 'чистый',       noise: 0.0,  gain: 1.0 },
    { label: 'лёгкий шум',   noise: 0.15, gain: 0.8 },
    { label: 'сильный шум',  noise: 0.5,  gain: 1.3 },
    { label: 'экстрим шум',  noise: 1.0,  gain: 0.6 }
  ];
  const maxLag = 200;
  let worstCleanFrameErr = 0;
  for (const lvl of noiseLevels) {
    console.log('\n[' + lvl.label + ']  noise=' + lvl.noise + ' gain=' + lvl.gain);
    for (const sh of knownShiftsSamples) {
      const knownMs = sh * dtSec * 1000;
      const b = makeShifted(env, sh, lvl.noise, lvl.gain);
      const { lagSamples, corr } = normXCorr(env, b, maxLag);
      const foundMs = lagSamples * dtSec * 1000;
      const errMs = foundMs - knownMs;
      const errFrames = Math.abs(errMs) / FRAME_MS;
      if (lvl.noise === 0) worstCleanFrameErr = Math.max(worstCleanFrameErr, errFrames);
      const flag = errFrames <= 1 ? 'OK ' : 'XX ';
      console.log('  ' + flag + 'τ_изв=' + fmt(knownMs).padEnd(22) +
        ' τ_найд=' + fmt(foundMs).padEnd(22) +
        ' ошибка=' + errMs.toFixed(1).padStart(6) + 'мс (' + errFrames.toFixed(2) + ' кадр) corr=' + corr.toFixed(3));
    }
  }

  // ── АКУСТИЧЕСКИЙ ТЕСТ: «другой микрофон» (реверб + EQ) меняет ФОРМУ огибающей ──
  // Самый честный прокси к реальности: тот же звук, но искажённый эхом/реверберацией
  // и полосовой фильтрацией (камерный мик vs петличка). Сдвиг известен → есть ground truth.
  console.log('\n=== АКУСТИЧЕСКИЙ ТЕСТ («другой микрофон»: эхо/реверб + EQ, форма огибающей искажена) ===');
  const acoustic = [
    { label: 'эхо 60мс x0.4',          echoMs: 60,  echoGain: 0.4, hp: 0.0 },
    { label: 'реверб (3 отражения)',   echoMs: 45,  echoGain: 0.5, hp: 0.0, multi: true },
    { label: 'эхо+highpass (петличка)',echoMs: 60,  echoGain: 0.4, hp: 0.97 }
  ];
  for (const ac of acoustic) {
    const knownSamplesPcm = 7000; // сдвиг в PCM-сэмплах (8кГц) = 875мс
    const knownMs = (knownSamplesPcm / SAMPLE_RATE) * 1000;
    const degraded = degradePcm(pcmA, knownSamplesPcm, ac);
    const envB = envelope(degraded).env;
    const L = Math.min(env.length, envB.length);
    const { lagSamples, corr } = normXCorr(env.subarray(0, L), envB.subarray(0, L), 400);
    const foundMs = lagSamples * dtSec * 1000;
    const errMs = foundMs - knownMs;
    const errFrames = Math.abs(errMs) / FRAME_MS;
    const flag = errFrames <= 1 ? 'OK ' : 'XX ';
    console.log('  ' + flag + '[' + ac.label.padEnd(26) + '] τ_изв=' + fmt(knownMs) +
      ' τ_найд=' + fmt(foundMs) + ' ошибка=' + errMs.toFixed(1) + 'мс (' + errFrames.toFixed(2) + ' кадр) corr=' + corr.toFixed(3));
  }

  // ── РЕАЛЬНЫЙ ТЕСТ: две разные камеры ─────────────────────────────────────
  if (pathB) {
    console.log('\n=== РЕАЛЬНЫЙ ТЕСТ (две разные камеры — есть ли резкий пик?) ===');
    console.log('Извлечение PCM из B:', pathB);
    const pcmB = extractPcm(pathB);
    const envB = envelope(pcmB).env;
    const L = Math.min(env.length, envB.length);
    const { lagSamples, corr } = normXCorr(env.subarray(0, L), envB.subarray(0, L), Math.floor(L / 2));
    console.log('  Найденный офсет B относительно A: ' + fmt(lagSamples * dtSec * 1000) + '  | confidence(corr)=' + corr.toFixed(3));
    console.log('  (corr>~0.5 → дорожки делят звук; низкий → нет общего сигнала на этом сегменте)');
  }

  console.log('\n=== ВЕРДИКТ ===');
  console.log('Худшая ошибка на ЧИСТОМ звуке: ' + worstCleanFrameErr.toFixed(2) + ' кадр' +
    (worstCleanFrameErr <= 1 ? '  → ЗЕЛЁНЫЙ: RMS-огибающей ' + WINDOW_MS + 'мс + парабол. интерполяция хватает для ±1 кадра'
                             : '  → КРАСНЫЙ: нужен PCM/спектр или меньшее окно'));
}

main();
