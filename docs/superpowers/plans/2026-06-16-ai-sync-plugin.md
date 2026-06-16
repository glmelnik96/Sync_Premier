# «ИИ: синхронизация» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CEP-плагин для Premiere Pro, синхронизирующий клипы многокамерного материала по общему звуку (кросс-корреляция RMS-огибающих), с по-клипной точностью ±1 кадр, ripple-закрытием пауз, поддержкой разных fps и линейной коррекцией дрейфа.

**Architecture:** Чистое ядро синхронизации (`sync-core`, `track-extractor`, `sync-graph`) тестируется unit-тестами через vm-loader (как в родительском плагине). ffmpeg-извлечение огибающих и тонкий ExtendScript-host изолированы за `bridge-premiere`. UI-панель (CEP) валидируется вживую через `cep-debug.mjs` на порту 8100. Вся математика — в домене времени (секунды → тики), что делает её fps-агностичной.

**Tech Stack:** CEP 12 (CSXS), ExtendScript (host JSX), ES5 IIFE-модули на `window`, Node.js `child_process` + ffmpeg, тесты `node --test` + `vm`, CDP-отладка через WebSocket.

**Спецификация:** `docs/superpowers/specs/2026-06-16-ai-sync-plugin-design.md`
**Спайк (валидация ядра):** `spike/l0-crosscorr.mjs` — алгоритм для Task 2-4 берётся отсюда.

---

## Карта файлов

| Файл | Назначение |
|---|---|
| `package.json` | `npm test` → `node --test tests/*.test.mjs`, `type: module` |
| `client/shared/sync-core.js` | нормализованная кросс-корреляция + парабол. интерполяция + детекция дрейфа. Чистый, без I/O |
| `client/shared/audio-envelope.js` | ffmpeg → моно-PCM → RMS-огибающая @5мс. No-op без Node |
| `client/shared/track-extractor.js` | ремап media-time → sequence-time; сбор клипов дорожки; fps-агностично |
| `client/shared/sync-graph.js` | выбор опоры; по-клипное разрешение офсетов; confidence-гейт; флаг дрейфа |
| `client/shared/sync-proposal.js` | сборка модели превью (дорожка→клип→сдвиг+confidence+статус) |
| `client/shared/sync-waveform.js` | canvas-рендер огибающих до/после |
| `client/shared/bridge-premiere.js` | загрузка host JSX + cold-start retry + evalJson |
| `client/lib/csinterface.js` | копия генерик-библиотеки CEP из родителя |
| `host/premiere-sync.jsx` | тонкий host: snapshot, mediaPath, moveClip, ripple, speed, backup, activate |
| `client/panel/index.html` + `panel.js` + `styles.css` | UI: анализ, таблица, вейвформ, Apply, Revert |
| `CSXS/manifest.xml` + `CSXS/.debug` | манифест расширения + debug-порт 8100 |
| `tools/cep-debug.mjs` | копия CDP-драйвера из родителя (порт через env) |
| `tests/load-*.mjs` + `tests/*.test.mjs` | vm-loader + unit-тесты ядра |

**Константы (используются во всех задачах):**
- `TICKS_PER_SECOND = 254016000000` (тиков на секунду в Premiere)
- Огибающая: окно `WINDOW_MS = 5`, рейт PCM `SAMPLE_RATE = 8000` Гц → `dt = 5мс` на точку

---

## Task 1: Каркас репозитория и тестовая инфраструктура

**Files:**
- Create: `package.json`
- Create: `tests/load-sync-core.mjs`
- Create: `tests/sync-core.test.mjs`

- [ ] **Step 1: Создать `package.json`**

```json
{
  "name": "sync-premier",
  "private": true,
  "type": "module",
  "description": "CEP-плагин синхронизации клипов по звуку для Premiere Pro",
  "scripts": {
    "test": "node --test tests/*.test.mjs"
  },
  "engines": { "node": ">=18" }
}
```

- [ ] **Step 2: Создать vm-loader `tests/load-sync-core.mjs`**

```javascript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../client/shared/sync-core.js');

export function loadSyncCore() {
  const code = readFileSync(SRC, 'utf8');
  const ctx = {
    Array, Object, Math, String, Number, JSON, Error, RegExp,
    Float32Array, Float64Array, Map, console, undefined,
    module: { exports: {} }, exports: {}
  };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.SyncCore || ctx.module.exports;
}
```

- [ ] **Step 3: Создать заглушку теста `tests/sync-core.test.mjs`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSyncCore } from './load-sync-core.mjs';

test('SyncCore загружается и экспортирует normXCorr', () => {
  const SC = loadSyncCore();
  assert.equal(typeof SC.normXCorr, 'function');
});
```

- [ ] **Step 4: Запустить тест — убедиться, что падает (модуля ещё нет)**

Run: `npm test`
Expected: FAIL — `Cannot find module '../client/shared/sync-core.js'`

- [ ] **Step 5: Коммит**

```bash
git add package.json tests/load-sync-core.mjs tests/sync-core.test.mjs
git commit -m "chore: каркас репозитория и тестовая инфраструктура"
```

---

## Task 2: sync-core — нормализованная кросс-корреляция + парабол. интерполяция

**Files:**
- Create: `client/shared/sync-core.js`
- Test: `tests/sync-core.test.mjs`

Алгоритм портируется из `spike/l0-crosscorr.mjs` (функции `normXCorr`, `zeroMean`, `norm`), валидированного на реальном клипе (0.00 кадра ошибки).

- [ ] **Step 1: Написать падающий тест — точное восстановление известного сдвига**

Добавить в `tests/sync-core.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npm test`
Expected: FAIL — `SC.normXCorr is not a function`

- [ ] **Step 3: Реализовать `client/shared/sync-core.js`**

```javascript
/**
 * Ядро синхронизации: нормализованная кросс-корреляция огибающих с
 * параболической интерполяцией пика (субсэмпловая точность) + детекция дрейфа.
 * Чистые функции, без I/O. Портировано из spike/l0-crosscorr.mjs.
 */
(function (global) {
  'use strict';

  function zeroMean(a) {
    var m = 0, i;
    for (i = 0; i < a.length; i++) m += a[i];
    m /= a.length || 1;
    var o = new Float64Array(a.length);
    for (i = 0; i < a.length; i++) o[i] = a[i] - m;
    return o;
  }

  function norm(a) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s);
  }

  /**
   * Нормализованная кросс-корреляция a против b по лагам [-maxLag, +maxLag]
   * (в сэмплах огибающей). Возвращает {lagSamples (с парабол. интерполяцией), corr}.
   * Положительный lag = b отстаёт от a (b[i+lag] совпадает с a[i]).
   */
  function normXCorr(a, b, maxLag) {
    var za = zeroMean(a), zb = zeroMean(b);
    var denom = (norm(za) * norm(zb)) || 1e-12;
    var best = { lag: 0, corr: -Infinity };
    var corrAt = new Map();
    for (var lag = -maxLag; lag <= maxLag; lag++) {
      var s = 0;
      var lo = Math.max(0, -lag), hi = Math.min(za.length, zb.length - lag);
      for (var i = lo; i < hi; i++) s += za[i] * zb[i + lag];
      var c = s / denom;
      corrAt.set(lag, c);
      if (c > best.corr) best = { lag: lag, corr: c };
    }
    var cm = corrAt.get(best.lag - 1), cp = corrAt.get(best.lag + 1);
    var sub = 0;
    if (cm != null && cp != null) {
      var d = (cm - 2 * best.corr + cp);
      if (Math.abs(d) > 1e-12) sub = 0.5 * (cm - cp) / d;
    }
    return { lagSamples: best.lag + sub, corr: best.corr };
  }

  global.SyncCore = {
    zeroMean: zeroMean,
    norm: norm,
    normXCorr: normXCorr
  };
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npm test`
Expected: PASS (3 теста)

- [ ] **Step 5: Коммит**

```bash
git add client/shared/sync-core.js tests/sync-core.test.mjs
git commit -m "feat(sync-core): нормализованная кросс-корреляция с парабол. интерполяцией"
```

---

## Task 3: sync-core — устойчивость к шуму и тишине

**Files:**
- Modify: `client/shared/sync-core.js` (добавить `confidenceOk`)
- Test: `tests/sync-core.test.mjs`

- [ ] **Step 1: Написать падающие тесты**

```javascript
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
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npm test`
Expected: FAIL — `SC.confidenceOk is not a function`

- [ ] **Step 3: Добавить `confidenceOk` в `sync-core.js`**

Внутри IIFE, перед `global.SyncCore`:

```javascript
  /** Гейт уверенности: пик корреляции должен быть выше порога, иначе матч ненадёжен. */
  function confidenceOk(corr, threshold) {
    var t = (typeof threshold === 'number') ? threshold : 0.5;
    return corr >= t;
  }
```

И добавить в экспорт:

```javascript
    confidenceOk: confidenceOk,
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add client/shared/sync-core.js tests/sync-core.test.mjs
git commit -m "feat(sync-core): confidence-гейт против ложных матчей на тишине"
```

---

## Task 4: sync-core — детекция линейного дрейфа (две корреляции)

**Files:**
- Modify: `client/shared/sync-core.js` (добавить `detectDrift`)
- Test: `tests/sync-core.test.mjs`

`detectDrift` берёт два окна огибающей (у начала и у конца), кросс-коррелирует каждое с опорной и считает наклон `slope = (τ₁ − τ₀) / spanSec`.

- [ ] **Step 1: Написать падающий тест**

```javascript
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
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npm test`
Expected: FAIL — `SC.detectDrift is not a function`

- [ ] **Step 3: Добавить `detectDrift` в `sync-core.js`**

```javascript
  /**
   * Детекция линейного дрейфа: корреляция окна у начала и у конца клипа против
   * опорной огибаюшей. Конвенция знака: slope = (τ_начала − τ_конца) / промежуток,
   * чтобы коррекция `setClipSpeed(1 + slope)` в Task 13 ИМЕННО компенсировала дрейф
   * (клип быстрее → τ растёт к концу → slope<0 → ratio<1 → замедление возвращает синхрон).
   * opt: {dtSec, windowSamples, maxLag, driftFrameThreshold=1, fps=25}
   * Возвращает {tau0Sec, tau1Sec, slope, hasDrift, corr0, corr1}.
   */
  function detectDrift(ref, clip, opt) {
    opt = opt || {};
    var dt = opt.dtSec || 0.005;
    var win = opt.windowSamples || 400;
    var maxLag = opt.maxLag || 200;
    var n = clip.length;
    if (n < win * 2) { return { tau0Sec: 0, tau1Sec: 0, slope: 0, hasDrift: false, corr0: 0, corr1: 0 }; }

    var headClip = clip.subarray(0, win);
    var tailClip = clip.subarray(n - win, n);
    var refHead = ref.subarray(0, Math.min(ref.length, win));
    var refTail = ref.subarray(Math.max(0, ref.length - win), ref.length);

    var r0 = normXCorr(refHead, headClip, maxLag);
    var r1 = normXCorr(refTail, tailClip, maxLag);

    var tau0 = r0.lagSamples * dt;
    var tau1 = r1.lagSamples * dt;
    var spanSec = (n - win) * dt;           // расстояние между центрами окон
    var slope = spanSec > 0 ? (tau0 - tau1) / spanSec : 0;

    var fps = opt.fps || 25;
    var thrFrames = (typeof opt.driftFrameThreshold === 'number') ? opt.driftFrameThreshold : 1;
    var totalDriftSec = Math.abs(slope) * (n * dt);
    var hasDrift = totalDriftSec > (thrFrames / fps);

    return { tau0Sec: tau0, tau1Sec: tau1, slope: slope, hasDrift: hasDrift, corr0: r0.corr, corr1: r1.corr };
  }
```

Добавить в экспорт: `detectDrift: detectDrift,`

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add client/shared/sync-core.js tests/sync-core.test.mjs
git commit -m "feat(sync-core): детекция линейного дрейфа двумя корреляциями"
```

---

## Task 5: audio-envelope — ffmpeg → RMS-огибающая

**Files:**
- Create: `client/shared/audio-envelope.js`
- Create: `tests/load-audio-envelope.mjs`
- Create: `tests/audio-envelope.test.mjs`

Адаптация `findFfmpegPath`/`runFfmpeg` из родительского `audio-preprocess.js`. Новая функция `extractEnvelope(path) → Promise<{dtSec, env: Float64Array}>`: ffmpeg извлекает моно-PCM s16le @8кГц, затем RMS по окну 5мс. Чистая функция `pcmToEnvelope(pcm)` тестируется отдельно (без ffmpeg).

- [ ] **Step 1: Loader `tests/load-audio-envelope.mjs`**

```javascript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../client/shared/audio-envelope.js');

export function loadAudioEnvelope() {
  const code = readFileSync(SRC, 'utf8');
  const ctx = {
    Array, Object, Math, String, Number, JSON, Error, RegExp,
    Float32Array, Float64Array, Promise, console, undefined,
    module: { exports: {} }, exports: {}
  };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.AudioEnvelope || ctx.module.exports;
}
```

- [ ] **Step 2: Падающий тест на чистую `pcmToEnvelope`**

`tests/audio-envelope.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAudioEnvelope } from './load-audio-envelope.mjs';

test('pcmToEnvelope: окно 5мс @8кГц → dt=0.005, RMS корректен', () => {
  const AE = loadAudioEnvelope();
  const sr = 8000;
  const win = Math.round(0.005 * sr); // 40 сэмплов
  const pcm = new Float32Array(win * 3);
  for (let i = 0; i < win; i++) pcm[i] = 0;            // тишина
  for (let i = win; i < win * 2; i++) pcm[i] = 0.5;    // постоянный 0.5 → RMS=0.5
  for (let i = win * 2; i < win * 3; i++) pcm[i] = -1; // RMS=1
  const { dtSec, env } = AE.pcmToEnvelope(pcm, sr, 5);
  assert.ok(Math.abs(dtSec - 0.005) < 1e-9);
  assert.equal(env.length, 3);
  assert.ok(Math.abs(env[0] - 0) < 1e-6);
  assert.ok(Math.abs(env[1] - 0.5) < 1e-6);
  assert.ok(Math.abs(env[2] - 1) < 1e-6);
});
```

- [ ] **Step 3: Запустить — убедиться, что падает**

Run: `npm test`
Expected: FAIL — модуль/функция отсутствует

- [ ] **Step 4: Реализовать `client/shared/audio-envelope.js`**

```javascript
/**
 * ffmpeg → моно-PCM → RMS-огибающая @5мс. No-op без Node.js (CEP без <CEFCommandLine>).
 * findFfmpegPath/runFfmpeg адаптированы из родительского audio-preprocess.js.
 */
(function (global) {
  'use strict';

  var SAMPLE_RATE = 8000;
  var WINDOW_MS = 5;

  function hasNode() { return typeof require !== 'undefined'; }

  function findFfmpegPath() {
    if (!hasNode()) return null;
    var fs = require('fs');
    var cands = ['C:\\ffmpeg\\bin\\ffmpeg.exe', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
    for (var i = 0; i < cands.length; i++) { try { if (fs.existsSync(cands[i])) return cands[i]; } catch (e) {} }
    try {
      var execSync = require('child_process').execSync;
      var p = process.platform === 'win32'
        ? String(execSync('where ffmpeg', { timeout: 5000 })).trim().split('\n')[0]
        : String(execSync('which ffmpeg', { timeout: 5000 })).trim();
      if (p && fs.existsSync(p)) return p;
    } catch (e) {}
    return null;
  }

  /** Чистая функция: PCM Float32 → RMS-огибающая. Тестируется без ffmpeg. */
  function pcmToEnvelope(pcm, sampleRate, windowMs) {
    var sr = sampleRate || SAMPLE_RATE;
    var win = Math.max(1, Math.round((windowMs || WINDOW_MS) / 1000 * sr));
    var m = Math.floor(pcm.length / win);
    var env = new Float64Array(m);
    for (var k = 0; k < m; k++) {
      var s = 0;
      for (var j = 0; j < win; j++) { var v = pcm[k * win + j]; s += v * v; }
      env[k] = Math.sqrt(s / win);
    }
    return { dtSec: win / sr, env: env };
  }

  /** Извлечь огибающую из аудиофайла (опц. сегмент [startSec, durSec]). */
  function extractEnvelope(path, opt) {
    opt = opt || {};
    return new Promise(function (resolve, reject) {
      if (!hasNode()) return reject(new Error('Node.js недоступен'));
      var bin = findFfmpegPath();
      if (!bin) return reject(new Error('ffmpeg не найден'));
      var args = ['-hide_banner', '-nostats', '-v', 'error'];
      if (opt.startSec != null) args.push('-ss', String(opt.startSec));
      if (opt.durSec != null) args.push('-t', String(opt.durSec));
      args.push('-i', path, '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-');
      var execFile = require('child_process').execFile;
      execFile(bin, args, { timeout: 300000, maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' },
        function (err, stdout) {
          if (err && !(stdout && stdout.length)) return reject(new Error('ffmpeg: ' + String(err.message || err)));
          var buf = stdout;
          var n = Math.floor(buf.length / 2);
          var pcm = new Float32Array(n);
          for (var i = 0; i < n; i++) pcm[i] = buf.readInt16LE(i * 2) / 32768;
          resolve(pcmToEnvelope(pcm, SAMPLE_RATE, WINDOW_MS));
        });
    });
  }

  global.AudioEnvelope = {
    SAMPLE_RATE: SAMPLE_RATE, WINDOW_MS: WINDOW_MS,
    hasNode: hasNode, findFfmpegPath: findFfmpegPath,
    pcmToEnvelope: pcmToEnvelope, extractEnvelope: extractEnvelope
  };
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 5: Запустить — убедиться, что проходит**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Реальная проверка extractEnvelope на живом медиа (ad-hoc, не CI)**

Run:
```bash
node --input-type=module -e "import('./tests/load-audio-envelope.mjs').then(async m=>{const AE=m.loadAudioEnvelope();const r=await AE.extractEnvelope('D:/ClientFirst №4/Proxy/A048_04142200_C019_Proxy.mov',{durSec:10});console.log('точек:',r.env.length,'dt:',r.dtSec);})"
```
Expected: `точек: ~2000 dt: 0.005`

- [ ] **Step 7: Коммит**

```bash
git add client/shared/audio-envelope.js tests/load-audio-envelope.mjs tests/audio-envelope.test.mjs
git commit -m "feat(audio-envelope): ffmpeg → RMS-огибающая @5мс + чистая pcmToEnvelope"
```

---

## Task 6: track-extractor — ремап media→sequence (fps-агностично)

**Files:**
- Create: `client/shared/track-extractor.js`
- Create: `tests/load-track-extractor.mjs`
- Create: `tests/track-extractor.test.mjs`

Чистая логика над снимком таймлайна. `clipsForTrack(snapshot, trackType, trackIndex)` → список клипов дорожки. `mediaToSequenceSec(clip, mediaSec)` пересчитывает время внутри медиа в время секвенции: `seqSec = clip.startSec + (mediaSec − clip.inPointSec)`. Всё в секундах — fps не участвует.

- [ ] **Step 1: Loader `tests/load-track-extractor.mjs`**

```javascript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../client/shared/track-extractor.js');

export function loadTrackExtractor() {
  const code = readFileSync(SRC, 'utf8');
  const ctx = { Array, Object, Math, String, Number, JSON, Error, console, undefined,
    module: { exports: {} }, exports: {} };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.TrackExtractor || ctx.module.exports;
}
```

- [ ] **Step 2: Падающие тесты**

`tests/track-extractor.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTrackExtractor } from './load-track-extractor.mjs';

const SNAP = {
  clips: [
    { trackType: 'audio', trackIndex: 0, nodeId: 'a', startSec: 0,  endSec: 10, inPointSec: 5,  outPointSec: 15 },
    { trackType: 'audio', trackIndex: 0, nodeId: 'b', startSec: 12, endSec: 20, inPointSec: 0,  outPointSec: 8  },
    { trackType: 'audio', trackIndex: 1, nodeId: 'c', startSec: 3,  endSec: 9,  inPointSec: 2,  outPointSec: 8  }
  ]
};

test('clipsForTrack фильтрует по типу и индексу, сортирует по startSec', () => {
  const TE = loadTrackExtractor();
  const r = TE.clipsForTrack(SNAP, 'audio', 0);
  // r — массив из vm-контекста; assert/strict deepEqual ловит несовпадение прототипа realm.
  // Сравниваем значения realm-безопасно.
  assert.equal(Array.from(r, c => c.nodeId).join(','), 'a,b');
});

test('mediaToSequenceSec: media-время → sequence-время', () => {
  const TE = loadTrackExtractor();
  const clip = SNAP.clips[0]; // start=0, in=5
  // mediaSec=5 (начало in) → seq=0; mediaSec=7 → seq=2
  assert.ok(Math.abs(TE.mediaToSequenceSec(clip, 5) - 0) < 1e-9);
  assert.ok(Math.abs(TE.mediaToSequenceSec(clip, 7) - 2) < 1e-9);
});

test('trackCoverageSec суммирует длительности клипов дорожки', () => {
  const TE = loadTrackExtractor();
  assert.ok(Math.abs(TE.trackCoverageSec(SNAP, 'audio', 0) - 18) < 1e-9); // 10 + 8
});
```

- [ ] **Step 3: Запустить — убедиться, что падает**

Run: `npm test`
Expected: FAIL — модуль отсутствует

- [ ] **Step 4: Реализовать `client/shared/track-extractor.js`**

```javascript
/**
 * Чистая логика над снимком таймлайна. fps-агностично: всё в секундах.
 */
(function (global) {
  'use strict';

  function clipsForTrack(snapshot, trackType, trackIndex) {
    var out = [];
    var clips = (snapshot && snapshot.clips) || [];
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      if (c.trackType === trackType && c.trackIndex === trackIndex) out.push(c);
    }
    out.sort(function (x, y) { return x.startSec - y.startSec; });
    return out;
  }

  /** Время внутри медиа → время секвенции для данного клипа. */
  function mediaToSequenceSec(clip, mediaSec) {
    return clip.startSec + (mediaSec - clip.inPointSec);
  }

  /** Суммарное покрытие дорожки (для выбора опоры). */
  function trackCoverageSec(snapshot, trackType, trackIndex) {
    var clips = clipsForTrack(snapshot, trackType, trackIndex);
    var sum = 0;
    for (var i = 0; i < clips.length; i++) sum += (clips[i].endSec - clips[i].startSec);
    return sum;
  }

  /** Список аудио-дорожек со снимка с их покрытием. */
  function audioTracksWithCoverage(snapshot) {
    var tracks = (snapshot && snapshot.tracks) || [];
    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].type === 'audio') {
        out.push({ index: tracks[i].index, name: tracks[i].name,
          coverageSec: trackCoverageSec(snapshot, 'audio', tracks[i].index) });
      }
    }
    return out;
  }

  global.TrackExtractor = {
    clipsForTrack: clipsForTrack,
    mediaToSequenceSec: mediaToSequenceSec,
    trackCoverageSec: trackCoverageSec,
    audioTracksWithCoverage: audioTracksWithCoverage
  };
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 5: Запустить — убедиться, что проходит**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Коммит**

```bash
git add client/shared/track-extractor.js tests/load-track-extractor.mjs tests/track-extractor.test.mjs
git commit -m "feat(track-extractor): ремап media→sequence и покрытие дорожек"
```

---

## Task 7: sync-graph — выбор опоры + по-клипное разрешение офсетов

**Files:**
- Create: `client/shared/sync-graph.js`
- Create: `tests/load-sync-graph.mjs`
- Create: `tests/sync-graph.test.mjs`

Чистая логика поверх результатов корреляции (корреляцию инжектируем, чтобы тест не требовал ffmpeg). `pickAnchorTrack(tracksWithCoverage)` → индекс дорожки с макс. покрытием. `resolveClipOffset({corr, slope, hasDrift}, opt)` → `{shiftSec, confidence, status}` где status ∈ `'sync' | 'low-confidence' | 'drift'`.

- [ ] **Step 1: Loader `tests/load-sync-graph.mjs`**

```javascript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../client/shared/sync-graph.js');

export function loadSyncGraph() {
  const code = readFileSync(SRC, 'utf8');
  const ctx = { Array, Object, Math, String, Number, JSON, Error, console, undefined,
    module: { exports: {} }, exports: {} };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.SyncGraph || ctx.module.exports;
}
```

- [ ] **Step 2: Падающие тесты**

`tests/sync-graph.test.mjs`:

```javascript
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
```

- [ ] **Step 3: Запустить — убедиться, что падает**

Run: `npm test`
Expected: FAIL — модуль отсутствует

- [ ] **Step 4: Реализовать `client/shared/sync-graph.js`**

```javascript
/**
 * Разрешение синхронизации поверх результатов корреляции (инжектируются).
 * Чистая логика: выбор опоры, статус по-клипно, сдвиг в секундах.
 */
(function (global) {
  'use strict';

  function pickAnchorTrack(tracksWithCoverage) {
    var best = null;
    for (var i = 0; i < tracksWithCoverage.length; i++) {
      var t = tracksWithCoverage[i];
      if (!best || t.coverageSec > best.coverageSec) best = t;
    }
    return best ? best.index : -1;
  }

  /**
   * match: {lagSamples, corr, dtSec, slope, hasDrift}
   * opt: {confidenceThreshold=0.5}
   * → {shiftSec, confidence, slope, status}
   */
  function resolveClipOffset(match, opt) {
    opt = opt || {};
    var thr = (typeof opt.confidenceThreshold === 'number') ? opt.confidenceThreshold : 0.5;
    if (match.corr < thr) {
      return { shiftSec: 0, confidence: match.corr, slope: 0, status: 'low-confidence' };
    }
    var shiftSec = match.lagSamples * match.dtSec;
    if (match.hasDrift) {
      return { shiftSec: shiftSec, confidence: match.corr, slope: match.slope, status: 'drift' };
    }
    return { shiftSec: shiftSec, confidence: match.corr, slope: 0, status: 'sync' };
  }

  global.SyncGraph = {
    pickAnchorTrack: pickAnchorTrack,
    resolveClipOffset: resolveClipOffset
  };
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 5: Запустить — убедиться, что проходит**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Коммит**

```bash
git add client/shared/sync-graph.js tests/load-sync-graph.mjs tests/sync-graph.test.mjs
git commit -m "feat(sync-graph): выбор опоры и по-клипное разрешение офсетов со статусами"
```

---

## Task 8: CEP-оболочка (манифест, debug, csinterface, панель-заглушка)

**Files:**
- Create: `CSXS/manifest.xml`
- Create: `CSXS/.debug`
- Create: `client/lib/csinterface.js` (копия из родителя)
- Create: `tools/cep-debug.mjs` (копия из родителя)
- Create: `client/panel/index.html`
- Create: `client/panel/styles.css`
- Create: `client/panel/panel.js`

- [ ] **Step 1: Скопировать генерик-библиотеки из родителя**

```bash
mkdir -p client/lib tools client/panel
cp "C:/Users/Глеб/Documents/Extensions-LLM-Chat_Pr/client/lib/csinterface.js" client/lib/csinterface.js
cp "C:/Users/Глеб/Documents/Extensions-LLM-Chat_Pr/tools/cep-debug.mjs" tools/cep-debug.mjs
```

- [ ] **Step 2: Создать `CSXS/manifest.xml`**

```xml
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<ExtensionManifest xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ExtensionBundleId="com.gleb.aisync" ExtensionBundleVersion="0.1.0" Version="11.0">
  <ExtensionList>
    <Extension Id="com.gleb.aisync.panel" Version="0.1" />
  </ExtensionList>
  <ExecutionEnvironment>
    <HostList>
      <Host Name="PPRO" Version="[24.0,99.9]" />
    </HostList>
    <LocaleList><Locale Code="All" /></LocaleList>
    <RequiredRuntimeList>
      <RequiredRuntime Name="CSXS" Version="12.0" />
    </RequiredRuntimeList>
  </ExecutionEnvironment>
  <DispatchInfoList>
    <Extension Id="com.gleb.aisync.panel">
      <DispatchInfo>
        <Resources>
          <MainPath>./client/panel/index.html</MainPath>
          <CEFCommandLine>
            <Parameter>--mixed-context</Parameter>
            <Parameter>--enable-nodejs</Parameter>
            <Parameter>--disable-application-cache</Parameter>
          </CEFCommandLine>
        </Resources>
        <Lifecycle><AutoVisible>true</AutoVisible></Lifecycle>
        <UI>
          <Type>Panel</Type>
          <Menu>ИИ: синхронизация</Menu>
          <Geometry><Size><Height>720</Height><Width>480</Width></Size></Geometry>
        </UI>
      </DispatchInfo>
    </Extension>
  </DispatchInfoList>
</ExtensionManifest>
```

- [ ] **Step 3: Создать `CSXS/.debug` (порт 8100)**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="com.gleb.aisync.panel">
    <HostList>
      <Host Name="PPRO" Port="8100" />
    </HostList>
  </Extension>
</ExtensionList>
```

- [ ] **Step 4: Создать `client/panel/index.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div id="app">
    <h1>ИИ: синхронизация</h1>
    <button id="analyze">Анализировать таймлайн</button>
    <div id="status"></div>
    <div id="results"></div>
  </div>
  <script src="../lib/csinterface.js"></script>
  <script src="../shared/sync-core.js"></script>
  <script src="../shared/audio-envelope.js"></script>
  <script src="../shared/track-extractor.js"></script>
  <script src="../shared/sync-graph.js"></script>
  <script src="../shared/bridge-premiere.js"></script>
  <script src="panel.js"></script>
</body>
</html>
```

- [ ] **Step 5: Создать `client/panel/styles.css`**

```css
body { font-family: -apple-system, "Segoe UI", sans-serif; font-size: 13px; background: #1e1e1e; color: #ddd; margin: 0; padding: 12px; }
h1 { font-size: 15px; margin: 0 0 12px; }
button { background: #2d6cdf; color: #fff; border: 0; border-radius: 4px; padding: 8px 14px; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
#status { margin: 10px 0; color: #9ad; min-height: 18px; }
.clip-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #333; }
.status-sync { color: #6c6; } .status-low-confidence { color: #c66; } .status-drift { color: #cc6; }
```

- [ ] **Step 6: Создать `client/panel/panel.js` (заглушка — проверка загрузки модулей)**

```javascript
(function () {
  'use strict';
  var statusEl = document.getElementById('status');
  function setStatus(s) { statusEl.textContent = s; }

  document.getElementById('analyze').addEventListener('click', function () {
    setStatus('Модули: SyncCore=' + (!!window.SyncCore) +
      ' AudioEnvelope=' + (!!window.AudioEnvelope) +
      ' Node=' + (window.AudioEnvelope ? window.AudioEnvelope.hasNode() : false));
  });

  setStatus('Готово к анализу.');
})();
```

- [ ] **Step 7: Установить плагин в CEP (симлинк) и проверить debug-порт**

```bash
ln -s "C:/Users/Глеб/Documents/Sync_Premier" "C:/Users/Глеб/AppData/Roaming/Adobe/CEP/extensions/com.gleb.aisync" 2>/dev/null || cp -r "C:/Users/Глеб/Documents/Sync_Premier" "C:/Users/Глеб/AppData/Roaming/Adobe/CEP/extensions/com.gleb.aisync"
```

Затем в Premiere: Window → Extensions → «ИИ: синхронизация». После открытия панели:

Run: `CEP_DEBUG_PORT=8100 node tools/cep-debug.mjs targets`
Expected: строка с `ИИ: синхронизация` и `ws://localhost:8100/...`

- [ ] **Step 8: Проверить загрузку модулей вживую**

Run: `CEP_DEBUG_PORT=8100 node tools/cep-debug.mjs eval "[!!window.SyncCore, !!window.AudioEnvelope, window.AudioEnvelope.hasNode()]"`
Expected: `[true, true, true]`

- [ ] **Step 9: Коммит**

```bash
git add CSXS client/lib client/panel tools/cep-debug.mjs
git commit -m "feat(cep): оболочка плагина — манифест, debug-порт 8100, панель-заглушка"
```

---

## Task 9: Тонкий host premiere-sync.jsx + bridge + live round-trip

**Files:**
- Create: `host/premiere-sync.jsx`
- Create: `client/shared/bridge-premiere.js`
- Modify: `client/panel/panel.js`

Host извлекается из родительского `premiere.jsx`: берём `_wrap`-декоратор, `getTimelineSnapshot`, `getClipMediaPath`, `backupActiveSequence`, `activateSequenceById` как есть; добавляем `moveClip(nodeId, deltaTicks)`. Bridge адаптируется из родительского `bridge-premiere.js` (cold-start retry + evalJson), путь к JSX → `host/premiere-sync.jsx`, namespace `$._SYNC_`.

- [ ] **Step 1: Создать `host/premiere-sync.jsx`**

Скопировать из `Extensions-LLM-Chat_Pr/host/premiere.jsx` блоки: инициализацию namespace (заменив `$._EXT_PRM_` на `$._SYNC_`), `_wrap`-декоратор, `_fps`/timebase-хелперы, `getTimelineSnapshot`, `getClipMediaPath`, `backupActiveSequence`, `activateSequenceById`. Затем добавить `moveClip`:

```javascript
/** Сдвиг клипа (и связанных A/V) на deltaTicks. Тики — нативная единица Premiere. */
$._SYNC_.moveClip = $._SYNC_._wrap('moveClip', function (paramsJson) {
  var p = JSON.parse(paramsJson);            // {nodeId, deltaTicks}
  var seq = app.project.activeSequence;
  if (!seq) return { ok: false, error: 'нет активной секвенции' };
  var found = $._SYNC_._findClipByNodeId(seq, p.nodeId); // {clip, track}
  if (!found) return { ok: false, error: 'клип не найден: ' + p.nodeId };
  var clip = found.clip;
  var delta = parseFloat(p.deltaTicks);
  var newStart = String(Math.round(parseFloat(clip.start.ticks) + delta));
  var dur = parseFloat(clip.end.ticks) - parseFloat(clip.start.ticks);
  // двигаем через присвоение start/end в тиках (subframe-точно)
  clip.start = newStart;
  clip.end = String(Math.round(parseFloat(newStart) + dur));
  return { ok: true, nodeId: p.nodeId, newStartTicks: newStart };
});
```

(`_findClipByNodeId` — скопировать соответствующий хелпер из родителя; если в родителе он встроен в snapshot — извлечь обход `videoTracks`/`audioTracks` с поиском `trackItem.nodeId === nodeId`.)

- [ ] **Step 2: Создать `client/shared/bridge-premiere.js`**

Скопировать из родителя `bridge-premiere.js` функции `escapeDoubleQuoted`, `extensionRoot`, `isColdStartGlitch`, `ensureHost`, `evalJson` (заменив путь на `/host/premiere-sync.jsx` и команды на `$._SYNC_`), и оставить только нужные обёртки:

```javascript
  global.PremiereBridge = {
    ensureHost: /* как в родителе, но jsxPath = root + '/host/premiere-sync.jsx' */,
    evalJson: /* как в родителе */,
    getTimelineSnapshot: function (cb) { this.evalJson('$._SYNC_.getTimelineSnapshot()', cb); },
    getClipMediaPath: function (nodeId, cb) {
      var s = String(nodeId).replace(/"/g, '\\"');
      this.evalJson('$._SYNC_.getClipMediaPath("' + s + '")', cb);
    },
    moveClip: function (nodeId, deltaTicks, cb) {
      var json = escapeDoubleQuoted(JSON.stringify({ nodeId: nodeId, deltaTicks: deltaTicks }));
      this.evalJson('$._SYNC_.moveClip("' + json + '")', cb);
    },
    backupActiveSequence: function (cb) { this.evalJson('$._SYNC_.backupActiveSequence()', cb); },
    activateSequenceById: function (seqId, cb) {
      var s = String(seqId).replace(/"/g, '\\"');
      this.evalJson('$._SYNC_.activateSequenceById("' + s + '")', cb);
    }
  };
```

- [ ] **Step 3: Обновить `panel.js` — кнопка анализа делает реальный snapshot**

Заменить обработчик `analyze`:

```javascript
  document.getElementById('analyze').addEventListener('click', function () {
    setStatus('Чтение таймлайна…');
    window.PremiereBridge.getTimelineSnapshot(function (err, snap) {
      if (err) { setStatus('Ошибка: ' + err.message); return; }
      var audio = window.TrackExtractor.audioTracksWithCoverage(snap);
      var anchor = window.SyncGraph.pickAnchorTrack(audio);
      setStatus('Секвенция: ' + snap.sequenceName + ' | аудиодорожек: ' + audio.length +
        ' | опора: Audio ' + (anchor + 1));
    });
  });
```

- [ ] **Step 4: Live round-trip — reload панель и проверить snapshot**

Run: `CEP_DEBUG_PORT=8100 node tools/cep-debug.mjs reload`
затем:
Run: `CEP_DEBUG_PORT=8100 node tools/cep-debug.mjs host '$._SYNC_.getTimelineSnapshot()'`
Expected: JSON с `"ok":true` и `sequenceName`

- [ ] **Step 5: Live-проверка moveClip + backup (безопасно, с откатом)**

Run: `CEP_DEBUG_PORT=8100 node tools/cep-debug.mjs host '$._SYNC_.backupActiveSequence()'`
Expected: `{"ok":true, ...}` с id бэкап-секвенции (запишите его).

Затем сдвиг тестового клипа на +1 кадр (40мс = 0.04 × 254016000000 ≈ 10160640000 тиков), взяв реальный nodeId из snapshot:
Run: `CEP_DEBUG_PORT=8100 node tools/cep-debug.mjs host '$._SYNC_.moveClip("{\"nodeId\":\"<NODEID>\",\"deltaTicks\":10160640000}")'`
Expected: `{"ok":true, "newStartTicks": ...}` — и клип визуально сдвинулся в Premiere на 1 кадр.

- [ ] **Step 6: Коммит**

```bash
git add host/premiere-sync.jsx client/shared/bridge-premiere.js client/panel/panel.js
git commit -m "feat(host+bridge): тонкий host (snapshot/mediaPath/moveClip/backup) + live round-trip"
```

---

## Task 10: Полный по-клипный матчинг (связка ядра вживую)

**Files:**
- Create: `client/shared/sync-runner.js`
- Modify: `client/panel/panel.js`

`sync-runner` оркестрирует: snapshot → опора → непрерывная огибающая опоры → для каждого неопорного клипа: getClipMediaPath → extractEnvelope → normXCorr против опоры → resolveClipOffset. Возвращает массив предложений. Это асинхронный клей; юнит-тест покрывает чистую сборку непрерывной огибающей.

- [ ] **Step 1: Loader + падающий тест на `buildAnchorEnvelope`**

`tests/load-sync-runner.mjs` (аналогично прочим loader'ам, экспорт `ctx.SyncRunner`, добавить `Float64Array`, `Map` в контекст).

`tests/sync-runner.test.mjs`:

```javascript
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
  assert.deepEqual(Array.from(r.env), [1, 2, 3, 4]);
  assert.ok(Math.abs(r.dtSec - 0.5) < 1e-9);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npm test`
Expected: FAIL — модуль/функция отсутствует

- [ ] **Step 3: Реализовать `client/shared/sync-runner.js`**

```javascript
/**
 * Оркестрация по-клипной синхронизации. Чистая buildAnchorEnvelope тестируется;
 * runSync — асинхронный клей (snapshot уже получен, медиа читается через переданные deps).
 */
(function (global) {
  'use strict';

  /** Собрать непрерывную огибающую опоры по sequence-времени. */
  function buildAnchorEnvelope(clips, dtSec, totalSec) {
    var n = Math.max(1, Math.round(totalSec / dtSec));
    var env = new Float64Array(n);
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      var base = Math.round(c.startSec / dtSec);
      for (var k = 0; k < c.env.length; k++) {
        var idx = base + k;
        if (idx >= 0 && idx < n) env[idx] = c.env[k];
      }
    }
    return { env: env, dtSec: dtSec };
  }

  /**
   * deps: { extractEnvelope(path,opt)→Promise, getClipMediaPath(nodeId)→Promise<path> }
   * SyncCore/SyncGraph/TrackExtractor берутся из global.
   * Возвращает Promise<[{nodeId, name, trackIndex, shiftSec, confidence, slope, status}]>.
   */
  function runSync(snapshot, anchorIndex, deps, opt) {
    opt = opt || {};
    var TE = global.TrackExtractor, SC = global.SyncCore, SG = global.SyncGraph;
    var dt = 0.005;
    var totalSec = snapshot.sequenceOutSec || 0;
    var anchorClips = TE.clipsForTrack(snapshot, 'audio', anchorIndex);

    // 1. огибающие клипов опоры
    return mapSeries(anchorClips, function (c) {
      return deps.getClipMediaPath(c.nodeId).then(function (path) {
        return deps.extractEnvelope(path, { startSec: c.inPointSec, durSec: c.endSec - c.startSec })
          .then(function (e) { return { startSec: c.startSec, env: e.env }; });
      });
    }).then(function (anchorEnvs) {
      var anchor = buildAnchorEnvelope(anchorEnvs, dt, totalSec);
      // 2. все неопорные аудиоклипы
      var others = [];
      var clips = snapshot.clips || [];
      for (var i = 0; i < clips.length; i++) {
        var c = clips[i];
        if (c.trackType === 'audio' && c.trackIndex !== anchorIndex) others.push(c);
      }
      return mapSeries(others, function (c) {
        return deps.getClipMediaPath(c.nodeId).then(function (path) {
          return deps.extractEnvelope(path, { startSec: c.inPointSec, durSec: c.endSec - c.startSec });
        }).then(function (e) {
          // вырезаем участок опоры под позицией клипа + окно поиска
          var maxLag = Math.round((opt.searchWindowSec || 5) / dt);
          var base = Math.round(c.startSec / dt);
          var seg = anchor.env.subarray(Math.max(0, base), Math.min(anchor.env.length, base + e.env.length));
          var m = SC.normXCorr(seg, e.env, maxLag);
          var drift = SC.detectDrift(seg, e.env, { dtSec: dt, windowSamples: 400, maxLag: maxLag, fps: snapshot.fps });
          var res = SG.resolveClipOffset({ lagSamples: m.lagSamples, corr: m.corr, dtSec: dt,
            slope: drift.slope, hasDrift: drift.hasDrift }, { confidenceThreshold: opt.confidenceThreshold });
          return { nodeId: c.nodeId, name: c.name, trackIndex: c.trackIndex,
            shiftSec: res.shiftSec, confidence: res.confidence, slope: res.slope, status: res.status };
        });
      });
    });
  }

  /** Последовательное выполнение промисов (CEP/Node без зависимостей). */
  function mapSeries(arr, fn) {
    var out = [], i = 0;
    function next() {
      if (i >= arr.length) return Promise.resolve(out);
      return fn(arr[i]).then(function (v) { out.push(v); i++; return next(); });
    }
    return next();
  }

  global.SyncRunner = { buildAnchorEnvelope: buildAnchorEnvelope, runSync: runSync, mapSeries: mapSeries };
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Подключить sync-runner в `index.html` и `panel.js`**

В `index.html` добавить перед `panel.js`:
```html
  <script src="../shared/sync-runner.js"></script>
```

В `panel.js` расширить обработчик `analyze` — после выбора опоры вызвать `runSync` с deps-обёртками над `PremiereBridge.getClipMediaPath` (промисификация) и `AudioEnvelope.extractEnvelope`, и отрисовать строки результата:

```javascript
  function pGetClipMediaPath(nodeId) {
    return new Promise(function (res, rej) {
      window.PremiereBridge.getClipMediaPath(nodeId, function (e, d) { e ? rej(e) : res(d.mediaPath); });
    });
  }
  function renderResults(rows) {
    var html = rows.map(function (r) {
      return '<div class="clip-row status-' + r.status + '"><span>' + r.name + ' (A' + (r.trackIndex + 1) +
        ')</span><span>' + (r.shiftSec * 1000).toFixed(0) + 'мс · ' + r.status + ' · ' + r.confidence.toFixed(2) + '</span></div>';
    }).join('');
    document.getElementById('results').innerHTML = html;
  }
  // внутри getTimelineSnapshot callback, после вычисления anchor:
  window.SyncRunner.runSync(snap, anchor, { getClipMediaPath: pGetClipMediaPath, extractEnvelope: window.AudioEnvelope.extractEnvelope }, {})
    .then(function (rows) { renderResults(rows); setStatus('Готово: ' + rows.length + ' клипов'); })
    .catch(function (e) { setStatus('Ошибка: ' + e.message); });
```

- [ ] **Step 6: Live-проверка полного анализа**

Run: `CEP_DEBUG_PORT=8100 node tools/cep-debug.mjs reload`
В панели нажать «Анализировать таймлайн». Ожидать: список клипов со сдвигами, статусами и confidence. Сверить, что клипы с общим звуком получают `sync` и разумный сдвиг.

- [ ] **Step 7: Коммит**

```bash
git add client/shared/sync-runner.js client/panel/index.html client/panel/panel.js tests/load-sync-runner.mjs tests/sync-runner.test.mjs
git commit -m "feat(sync-runner): по-клипный матчинг опоры вживую + рендер результатов"
```

---

## Task 11: Apply со сдвигом + checkpoint + Revert

**Files:**
- Modify: `client/panel/panel.js`
- Modify: `client/panel/index.html`

Добавить кнопки «Применить» и «Откатить». Apply: backup → последовательный `moveClip` для всех `sync`/`drift` клипов (сдвиг в тиках = `shiftSec × TICKS_PER_SECOND`). Revert: `activateSequenceById` на сохранённый бэкап.

- [ ] **Step 1: Добавить кнопки в `index.html`**

После `<div id="results"></div>`:
```html
    <div id="actions" style="margin-top:12px">
      <button id="apply" disabled>Применить</button>
      <button id="revert" disabled>Откатить</button>
    </div>
```

- [ ] **Step 2: Реализовать Apply/Revert в `panel.js`**

```javascript
  var TICKS_PER_SECOND = 254016000000;
  var lastRows = [], backupSeqId = null;

  // после renderResults(rows): сохранить и включить Apply
  function onAnalyzed(rows) { lastRows = rows; document.getElementById('apply').disabled = rows.length === 0; }

  document.getElementById('apply').addEventListener('click', function () {
    setStatus('Создаю checkpoint…');
    window.PremiereBridge.backupActiveSequence(function (err, b) {
      if (err) { setStatus('Ошибка backup: ' + err.message); return; }
      backupSeqId = b.sequenceID || b.sequenceId || b.id;
      document.getElementById('revert').disabled = !backupSeqId;
      var toMove = lastRows.filter(function (r) { return r.status === 'sync' || r.status === 'drift'; });
      var i = 0;
      (function next() {
        if (i >= toMove.length) { setStatus('Применено: ' + toMove.length + ' клипов'); return; }
        var r = toMove[i++];
        var deltaTicks = Math.round(r.shiftSec * TICKS_PER_SECOND);
        window.PremiereBridge.moveClip(r.nodeId, deltaTicks, function (e) {
          if (e) { setStatus('Ошибка moveClip: ' + e.message); return; }
          setStatus('Сдвинуто ' + i + '/' + toMove.length); next();
        });
      })();
    });
  });

  document.getElementById('revert').addEventListener('click', function () {
    if (!backupSeqId) return;
    window.PremiereBridge.activateSequenceById(backupSeqId, function (e) {
      setStatus(e ? 'Ошибка отката: ' + e.message : 'Откат выполнен (активирован checkpoint)');
    });
  });
```

И вызвать `onAnalyzed(rows)` внутри `.then` после `renderResults(rows)`.

- [ ] **Step 3: Live-проверка Apply → визуальная сверка → Revert**

Reload, Анализировать, Применить. Ожидать: клипы сдвинулись в синхрон; статус «Применено: N». Нажать «Откатить» — активируется бэкап-секвенция, сдвиги исчезли.

- [ ] **Step 4: Коммит**

```bash
git add client/panel/index.html client/panel/panel.js
git commit -m "feat(panel): Apply со сдвигом в тиках + checkpoint + Revert"
```

---

## Task 12: Ripple-закрытие пауз (host + панель)

**Files:**
- Modify: `host/premiere-sync.jsx`
- Modify: `client/shared/bridge-premiere.js`
- Modify: `client/panel/panel.js`

После сдвигов на дорожке остаются дыры/перекрытия. `rippleCloseGaps(trackIndex, trackType)`: пройти клипы дорожки по порядку start, прижать каждый к концу предыдущего (start = prevEnd), сохраняя длительность. Применяется после всех `moveClip` в Apply.

- [ ] **Step 1: Добавить `rippleCloseGaps` в host**

```javascript
/** Уплотнить дорожку: каждый клип прижимается к концу предыдущего (закрытие пауз/перекрытий). */
$._SYNC_.rippleCloseGaps = $._SYNC_._wrap('rippleCloseGaps', function (paramsJson) {
  var p = JSON.parse(paramsJson);            // {trackType, trackIndex}
  var seq = app.project.activeSequence;
  if (!seq) return { ok: false, error: 'нет активной секвенции' };
  var track = (p.trackType === 'audio' ? seq.audioTracks : seq.videoTracks)[p.trackIndex];
  if (!track) return { ok: false, error: 'дорожка не найдена' };
  // собрать клипы и отсортировать по start
  var items = [];
  for (var i = 0; i < track.clips.numItems; i++) items.push(track.clips[i]);
  items.sort(function (a, b) { return parseFloat(a.start.ticks) - parseFloat(b.start.ticks); });
  var cursor = items.length ? parseFloat(items[0].start.ticks) : 0;
  var moved = 0;
  for (var j = 0; j < items.length; j++) {
    var c = items[j];
    var dur = parseFloat(c.end.ticks) - parseFloat(c.start.ticks);
    if (Math.abs(parseFloat(c.start.ticks) - cursor) > 1) { c.start = String(Math.round(cursor)); c.end = String(Math.round(cursor + dur)); moved++; }
    cursor = parseFloat(c.start.ticks) + dur;
  }
  return { ok: true, movedClips: moved };
});
```

- [ ] **Step 2: Обёртка в bridge**

```javascript
    rippleCloseGaps: function (trackType, trackIndex, cb) {
      var json = escapeDoubleQuoted(JSON.stringify({ trackType: trackType, trackIndex: trackIndex }));
      this.evalJson('$._SYNC_.rippleCloseGaps("' + json + '")', cb);
    },
```

- [ ] **Step 3: Вызвать ripple в Apply (после всех moveClip), по затронутым дорожкам**

В `panel.js` в конце цикла `next()` (когда `i >= toMove.length`), перед финальным setStatus, собрать уникальные `trackIndex` затронутых клипов и применить ripple последовательно:

```javascript
        if (i >= toMove.length) {
          var tracks = {}; toMove.forEach(function (r) { tracks[r.trackIndex] = true; });
          var idxs = Object.keys(tracks); var ti = 0;
          (function nextTrack() {
            if (ti >= idxs.length) { setStatus('Применено + ripple: ' + toMove.length + ' клипов'); return; }
            window.PremiereBridge.rippleCloseGaps('audio', parseInt(idxs[ti++], 10), function () { nextTrack(); });
          })();
          return;
        }
```

- [ ] **Step 4: Live-проверка ripple**

Reload, Анализировать, Применить. Ожидать: после сдвигов паузы на затронутых аудиодорожках закрыты, клипы идут встык. Revert восстанавливает исходное.

- [ ] **Step 5: Коммит**

```bash
git add host/premiere-sync.jsx client/shared/bridge-premiere.js client/panel/panel.js
git commit -m "feat(ripple): закрытие пауз на дорожке после сдвигов"
```

---

## Task 13: Коррекция дрейфа (setClipSpeed + ffmpeg-фолбэк)

**Files:**
- Modify: `host/premiere-sync.jsx`
- Modify: `client/shared/bridge-premiere.js`
- Modify: `client/panel/panel.js`

Для клипов со `status === 'drift'` предложить rate-stretch. `setClipSpeed(nodeId, ratio)` в host меняет скорость клипа. Если нативно нестабильно — фолбэк: рендер скорректированного аудио через ffmpeg `atempo` и импорт (риск R5; в этой задаче реализуем нативный путь + детекцию его неуспеха).

- [ ] **Step 1: Добавить `setClipSpeed` в host**

```javascript
/** Растяжка клипа по скорости для коррекции дрейфа. ratio>1 = быстрее (короче). */
$._SYNC_.setClipSpeed = $._SYNC_._wrap('setClipSpeed', function (paramsJson) {
  var p = JSON.parse(paramsJson);            // {nodeId, ratio}
  var seq = app.project.activeSequence;
  var found = $._SYNC_._findClipByNodeId(seq, p.nodeId);
  if (!found) return { ok: false, error: 'клип не найден' };
  var clip = found.clip;
  if (typeof clip.setSpeed !== 'function') return { ok: false, error: 'setSpeed недоступен (нужен ffmpeg-фолбэк)' };
  try {
    clip.setSpeed(parseFloat(p.ratio)); // PP API: дробь скорости (1.0 = норма)
    return { ok: true, nodeId: p.nodeId, ratio: p.ratio };
  } catch (e) {
    return { ok: false, error: 'setSpeed упал: ' + e.toString() };
  }
});
```

- [ ] **Step 2: Обёртка в bridge**

```javascript
    setClipSpeed: function (nodeId, ratio, cb) {
      var json = escapeDoubleQuoted(JSON.stringify({ nodeId: nodeId, ratio: ratio }));
      this.evalJson('$._SYNC_.setClipSpeed("' + json + '")', cb);
    },
```

- [ ] **Step 3: Применять коррекцию дрейфа в Apply**

В `panel.js` для каждого `r.status === 'drift'`: после `moveClip` вызвать `setClipSpeed(r.nodeId, 1 + r.slope, …)`. При ошибке — НЕ падать, а добавить в `setStatus` пометку «дрейф клипа X требует ffmpeg-коррекции (R5)» и продолжить.

```javascript
        if (r.status === 'drift') {
          window.PremiereBridge.setClipSpeed(r.nodeId, 1 + r.slope, function (e2, d2) {
            if (e2 || !d2 || !d2.ok) setStatus('Дрейф ' + r.name + ': нативная коррекция недоступна (R5)');
            next();
          });
          return;
        }
        next();
```

- [ ] **Step 4: Live-проверка на дрейфующем клипе**

Если в проекте есть длинный клип с дрейфом — Анализировать, убедиться что он помечен `drift` со slope; Применить, проверить попытку коррекции. Если `setSpeed` недоступен — статус сообщает о необходимости ffmpeg-фолбэка (это валидный исход данной задачи; полный фолбэк — отдельная фаза по R5).

- [ ] **Step 5: Коммит**

```bash
git add host/premiere-sync.jsx client/shared/bridge-premiere.js client/panel/panel.js
git commit -m "feat(drift): нативная rate-stretch коррекция дрейфа + детекция неуспеха (R5)"
```

---

## Task 14: Превью-вейвформ (canvas до/после)

**Files:**
- Create: `client/shared/sync-waveform.js`
- Create: `tests/load-sync-waveform.mjs`
- Create: `tests/sync-waveform.test.mjs`
- Modify: `client/panel/index.html`, `client/panel/panel.js`

Чистая функция `downsampleEnvelope(env, targetPx)` для канвы тестируется юнитом; `drawPair(canvas, refEnv, clipEnv, shiftSamples)` рисует опору и клип (со сдвигом) — проверяется вживую.

- [ ] **Step 1: Loader + падающий тест на downsample**

`tests/sync-waveform.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: Реализовать `client/shared/sync-waveform.js`**

```javascript
/** Рендер огибающих на canvas. downsampleEnvelope — чистая (max-пулинг по бинам). */
(function (global) {
  'use strict';

  function downsampleEnvelope(env, targetPx) {
    var n = Math.max(1, targetPx);
    var out = new Float64Array(n);
    var per = env.length / n;
    for (var i = 0; i < n; i++) {
      var lo = Math.floor(i * per), hi = Math.floor((i + 1) * per), mx = 0;
      for (var j = lo; j < hi && j < env.length; j++) if (env[j] > mx) mx = env[j];
      out[i] = mx;
    }
    return out;
  }

  function drawPair(canvas, refEnv, clipEnv, shiftSamples) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height, mid = H / 2;
    ctx.clearRect(0, 0, W, H);
    function drawRow(env, yMid, color, offsetPx) {
      var ds = downsampleEnvelope(env, W);
      var mx = 1e-9; for (var i = 0; i < ds.length; i++) if (ds[i] > mx) mx = ds[i];
      ctx.strokeStyle = color; ctx.beginPath();
      for (var x = 0; x < W; x++) {
        var v = ds[x] / mx * (H / 2 - 2);
        var px = x + (offsetPx || 0);
        ctx.moveTo(px, yMid - v); ctx.lineTo(px, yMid + v);
      }
      ctx.stroke();
    }
    drawRow(refEnv, mid / 2, '#6c9', 0);
    var pxPerSample = W / Math.max(refEnv.length, clipEnv.length);
    drawRow(clipEnv, mid + mid / 2, '#c96', Math.round(shiftSamples * pxPerSample));
  }

  global.SyncWaveform = { downsampleEnvelope: downsampleEnvelope, drawPair: drawPair };
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Подключить и рисовать в панели**

В `index.html` добавить `<script src="../shared/sync-waveform.js"></script>` и в строку клипа — `<canvas>` (например при клике на строку рисовать `drawPair` для опорного сегмента и огибающей клипа, сохранённых в `lastRows`). Минимально: одна общая канва `<canvas id="wave" width="456" height="120"></canvas>` под результатами, рисуется для выбранного клипа.

- [ ] **Step 6: Live-проверка вейвформа**

Reload, Анализировать, выбрать клип — увидеть две огибающие (опора зелёная, клип оранжевый со сдвигом). До применения сдвиг виден визуально; пики должны совпасть по X после учёта shift.

- [ ] **Step 7: Коммит**

```bash
git add client/shared/sync-waveform.js client/panel/index.html client/panel/panel.js tests/load-sync-waveform.mjs tests/sync-waveform.test.mjs
git commit -m "feat(waveform): canvas-превью огибающих до/после с max-пулингом"
```

---

## Task 15: README и финальная проверка

**Files:**
- Create: `README.md`

- [ ] **Step 1: Написать `README.md`** — назначение, установка (симлинк в CEP/extensions, включить PlayerDebugMode), требования (ffmpeg в PATH/`C:\ffmpeg\bin`), порт отладки 8100, `npm test`, краткий цикл «Анализ → превью → Применить → Откат».

- [ ] **Step 2: Прогнать весь тест-сьют**

Run: `npm test`
Expected: PASS — все юнит-тесты (sync-core, audio-envelope, track-extractor, sync-graph, sync-runner, sync-waveform).

- [ ] **Step 3: Финальный live-прогон полного цикла** на живом проекте: Анализ → проверка статусов/вейвформа → Применить → визуальная сверка синхрона + ripple → Откат.

- [ ] **Step 4: Коммит и пуш**

```bash
git add README.md
git commit -m "docs: README — установка, требования, цикл работы"
git push -u origin main
```

---

## Самопроверка плана (по спецификации)

- **§4.1 оболочка** → Task 8 (манифест, .debug 8100, csinterface, cep-debug). ✓
- **§4.2 модули** → sync-core (T2-4), audio-envelope (T5), track-extractor (T6), sync-graph (T7), sync-runner (T10), sync-proposal/превью (T14), bridge (T9). ✓
  *Примечание:* `sync-proposal.js` из спецификации реализован как часть `sync-runner` (модель строк) + рендер в панели — отдельный файл не нужен (DRY).
- **§4.3 тонкий host** → T9 (snapshot/mediaPath/moveClip/backup/activate), T12 (ripple), T13 (setClipSpeed). ✓
- **§5 по-клипная модель** → T10 (опора, непрерывная огибающая, по-клипный матчинг, гейт). ✓
- **§5.6 ripple-закрытие пауз** → T12. ✓
- **§5.7 fps-агностичность** → T6 (всё в секундах); **дрейф** → T4 (детекция), T13 (коррекция). ✓
- **§6 порядок сборки** P0(T1-9) → P1(T10) → P2 ripple+дрейф(T12-13) → P3 превью(T14). ✓
- **§7 тесты** → юниты в T2-7,10,14; live через cep-debug в T8-13. ✓ (вкл. реверб/шум/тишина/дрейф-кейсы)
- **§8 риски** → R1 окно поиска (T10 `searchWindowSec`); R3 ripple после сдвигов (T12); R5 детекция неуспеха setClipSpeed (T13). ✓
