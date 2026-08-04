/**
 * Ф3.2: landmark-фингерпринт (схема Shazam/Wang-2003) для доверенных аудио-пинов.
 *
 * Зачем. У stretch-камеры (кейс 5, P-камера) накамерный микрофон тонет в стационарном
 * шуме: RMS-NCC на зоне 065–077 даёт 0/26 попаданий — истина НЕ является максимумом
 * корреляции. Фингерпринт голосует не энергией, а СОВПАДЕНИЕМ спектральных ориентиров:
 * пары локальных пиков спектрограммы (f1,f2,Δt) хешируются, совпавшие хеши голосуют
 * за офсет запрос↔референс. Истина набирает согласованные голоса даже при SNR≪0.
 *
 * Валидация (стенд кейса 5, эталон Syncaila):
 *  - зона 065–077: 14/26 попаданий ±2с (RMS 0/26), точность верных 0.01–0.04с;
 *  - негативный контроль (чужой бэкбон К4): 0/13 прошли гейт;
 *  - полный прогон P-камеры (321 клип × 18 бэкбонов) с приором из предикта пайплайна:
 *    гейт votes≥9 && conf≥1.75 → 83 клипа запинены, 0 ложных (медиана |err| 0.01с).
 *
 * КРИТИЧНО: окно приора. Глобальный поиск на свадебном материале даёт десятки ложных
 * матчей по ПОВТОРЯЮЩЕЙСЯ МУЗЫКЕ (один трек звучит на сборах и на банкете: 47 ложных
 * пинов с votes до 66 — два референса согласованно голосуют за чужую позицию). Поэтому
 * поиск офсета ограничен окном ±winSec вокруг приора (позиция клипа по текущему
 * предикту warp/rigid-TC): коррекция в секунды — да, переезд на часы — нет.
 *
 * Схема: PCM 8кГц моно → STFT 1024/hop 256 (кадр 32мс, Ханн) → лог-магнитуда →
 * констелляция (сепарабельный скользящий максимум ±10×±10, порог median+12дБ) →
 * пары (fan 15, Δt ≤ 62 кадров) → хеш (f1·512+f2)·64+Δt → джойн запрос↔референс →
 * гистограмма офсетов (слияние окном 5 кадров ≈ 160мс, взвешенное среднее) →
 * пик = офсет; votes2 = второй пик вне ±2с (в окне приора) для confidence.
 *
 * ES5 IIFE; fft передаётся параметром (SyncCore.fft), Node не нужен — чистый DSP.
 */
(function (global) {
  'use strict';

  var SR = 8000;          /* ожидаемый sample rate PCM (AudioEnvelope.extractPcm) */
  var NFFT = 1024;
  var HOP = 256;          /* кадр 32 мс */
  var DT_SEC = HOP / SR;
  var DB_ABOVE = 12;      /* порог пика констелляции: median_db + 12 дБ */
  var FAN = 15;           /* пар на якорь */
  var MAX_DT = 62;        /* макс. Δt пары, кадров (~2с) */
  var NT = 10, NF = 10;   /* окрестность скользящего максимума (время × частота) */
  var MERGE_W = 5;        /* окно слияния гистограммы офсетов, кадров (~160мс) */
  var STOP = 200;         /* хеш чаще STOP раз в референсе → стоп-слово (музыка/гул) */
  var EXCL_SEC = 2;       /* votes2: второй пик вне ±2с от лучшего */

  var HANN = null;
  function hann() {
    if (HANN) return HANN;
    HANN = new Float64Array(NFFT);
    for (var i = 0; i < NFFT; i++) HANN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (NFFT - 1));
    return HANN;
  }

  /* PCM → лог-спектрограмма { T, B, db: Float32Array(T*B) } */
  function spectrogram(pcm, fft) {
    var T = Math.max(0, Math.floor((pcm.length - NFFT) / HOP) + 1);
    var B = NFFT / 2;
    var db = new Float32Array(T * B);
    var re = new Float64Array(NFFT), im = new Float64Array(NFFT);
    var w = hann();
    for (var t = 0; t < T; t++) {
      var off = t * HOP, i, f;
      for (i = 0; i < NFFT; i++) { re[i] = pcm[off + i] * w[i]; im[i] = 0; }
      fft(re, im, false);
      for (f = 0; f < B; f++) {
        var mag = re[f] * re[f] + im[f] * im[f];
        db[t * B + f] = 10 * Math.log10(mag + 1e-12);
      }
    }
    return { T: T, B: B, db: db };
  }

  /* сепарабельный скользящий максимум ±NT×±NF (монотонный deque), O(T·B) */
  function maxFilter(spec) {
    var T = spec.T, B = spec.B, db = spec.db;
    var tmp = new Float32Array(T * B), out = new Float32Array(T * B);
    var idx = new Int32Array(Math.max(T, B));
    var t, f, h, tl, v, lead, row;
    for (t = 0; t < T; t++) { /* по частоте внутри кадра */
      h = 0; tl = 0; row = t * B;
      for (f = 0; f < B + NF; f++) {
        if (f < B) {
          v = db[row + f];
          while (h > tl && db[row + idx[h - 1]] <= v) h--;
          idx[h++] = f;
        }
        lead = f - NF;
        if (lead >= 0) {
          while (idx[tl] < lead - NF) tl++;
          tmp[row + lead] = db[row + idx[tl]];
        }
      }
    }
    for (f = 0; f < B; f++) { /* по времени по столбцам */
      h = 0; tl = 0;
      for (t = 0; t < T + NT; t++) {
        if (t < T) {
          v = tmp[t * B + f];
          while (h > tl && tmp[idx[h - 1] * B + f] <= v) h--;
          idx[h++] = t;
        }
        lead = t - NT;
        if (lead >= 0) {
          while (idx[tl] < lead - NT) tl++;
          out[lead * B + f] = tmp[idx[tl] * B + f];
        }
      }
    }
    return out;
  }

  /* спектрограмма → пики констелляции [{t,f}] (сортированы по t) */
  function constellation(spec) {
    var T = spec.T, B = spec.B, db = spec.db;
    var mx = maxFilter(spec);
    var sample = [], i;
    for (i = 0; i < db.length; i += 97) sample.push(db[i]);
    sample.sort(function (a, b) { return a - b; });
    var thr = sample[sample.length >> 1] + DB_ABOVE;
    var peaks = [];
    for (var t = 0; t < T; t++)
      for (var f = 2; f < B; f++) { /* f<2 — DC/инфраниз */
        var v = db[t * B + f];
        if (v > thr && v === mx[t * B + f]) peaks.push({ t: t, f: f });
      }
    return peaks;
  }

  /* пики → хеши: Map h → массив t якоря (Map доступен в CEP-Chromium, как в sync-core) */
  function hashPeaks(peaks) {
    var m = new Map();
    for (var i = 0; i < peaks.length; i++) {
      var a = peaks[i], fan = 0;
      for (var j = i + 1; j < peaks.length && fan < FAN; j++) {
        var b = peaks[j], dt = b.t - a.t;
        if (dt < 1) continue;
        if (dt > MAX_DT) break;
        var h = (a.f * 512 + b.f) * 64 + dt;
        var arr = m.get(h);
        if (!arr) { arr = []; m.set(h, arr); }
        arr.push(a.t);
        fan++;
      }
    }
    return { hashes: m, size: m.size, frames: peaks.length ? peaks[peaks.length - 1].t + 1 : 0 };
  }

  /** PCM Float32 @8кГц → фингерпринт { hashes, size, frames }. fft = SyncCore.fft. */
  function fingerprint(pcm, fft) {
    return hashPeaks(constellation(spectrogram(pcm, fft)));
  }

  /**
   * Матч запроса против референса в окне приора.
   * opt: { priorSec, winSec } — поиск офсета только в [prior−win, prior+win];
   *      без opt.winSec — глобальный (ТОЛЬКО для стендов: музыка даёт ложные пики).
   * → { offSec|null, votes, votes2 }; offSec — позиция начала запроса в референсе.
   */
  function match(refFp, qryFp, opt) {
    opt = opt || {};
    var lim = (opt.winSec > 0) ? opt.winSec / DT_SEC : Infinity;
    var prior = (opt.priorSec || 0) / DT_SEC;
    var hist = new Map(), total = 0, i, j;
    qryFp.hashes.forEach(function (qts, h) {
      var rts = refFp.hashes.get(h);
      if (!rts || rts.length > STOP) return;
      for (i = 0; i < qts.length; i++)
        for (j = 0; j < rts.length; j++) {
          var off = rts[j] - qts[i];
          if (lim !== Infinity && Math.abs(off - prior) > lim) continue;
          hist.set(off, (hist.get(off) || 0) + 1);
          total++;
        }
    });
    if (!total) return { offSec: null, votes: 0, votes2: 0 };
    var offs = [];
    hist.forEach(function (v, off) { offs.push(off); });
    offs.sort(function (a, b) { return a - b; });
    /* лучший пик: скользящее окно MERGE_W кадров, взвешенное среднее внутри окна */
    var bestV = 0, bestOff = 0, lo = 0, sum = 0, wsum = 0, hi;
    for (hi = 0; hi < offs.length; hi++) {
      sum += hist.get(offs[hi]); wsum += hist.get(offs[hi]) * offs[hi];
      while (offs[hi] - offs[lo] >= MERGE_W) { sum -= hist.get(offs[lo]); wsum -= hist.get(offs[lo]) * offs[lo]; lo++; }
      if (sum > bestV) { bestV = sum; bestOff = wsum / sum; }
    }
    /* второй пик вне ±EXCL_SEC от лучшего (внутри окна приора) */
    var excl = EXCL_SEC / DT_SEC, lo2 = 0, sum2 = 0, best2 = 0;
    for (hi = 0; hi < offs.length; hi++) {
      sum2 += hist.get(offs[hi]);
      while (offs[hi] - offs[lo2] >= MERGE_W) { sum2 -= hist.get(offs[lo2]); lo2++; }
      if (Math.abs(offs[hi] - bestOff) > excl && sum2 > best2) best2 = sum2;
    }
    return { offSec: bestOff * DT_SEC, votes: bestV, votes2: best2 };
  }

  global.AudioFingerprint = {
    SR: SR, DT_SEC: DT_SEC,
    fingerprint: fingerprint, match: match,
    /* внутренности — для тестов */
    _spectrogram: spectrogram, _constellation: constellation, _hashPeaks: hashPeaks
  };
})(typeof window !== 'undefined' ? window : this);
