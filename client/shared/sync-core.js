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

  /**
   * Детекция линейного дрейфа: корреляция окна у начала и у конца клипа против
   * опорной огибаюшей.
   * Конвенция знака: slope = (τ_начала − τ_конца) / промежуток, чтобы коррекция
   * setClipSpeed(1 + slope) в Task 13 компенсировала дрейф.
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

  /** Гейт уверенности: пик корреляции должен быть выше порога, иначе матч ненадёжен. */
  function confidenceOk(corr, threshold) {
    var t = (typeof threshold === 'number') ? threshold : 0.5;
    return corr >= t;
  }

  /* Итеративный radix-2 FFT (re/im на месте). inverse: знак + деление на n. */
  function fft(re, im, inverse) {
    var n = re.length, i, j, bit, len, k;
    for (i = 1, j = 0; i < n; i++) {
      for (bit = n >> 1; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { var tr = re[i]; re[i] = re[j]; re[j] = tr; var ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (len = 2; len <= n; len <<= 1) {
      var ang = (inverse ? 2 : -2) * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        var cwr = 1, cwi = 0;
        for (k = 0; k < len / 2; k++) {
          var ur = re[i + k], ui = im[i + k];
          var vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
          var vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          var ncwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = ncwr;
        }
      }
    }
    if (inverse) for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  /* Сырая скользящая взаимная корреляция corr[lag]=sum_i s[lag+i]*t[i] через FFT. */
  function rawXCorrFFT(s, t) {
    var need = s.length + t.length, L = 1;
    while (L < need) L <<= 1;
    var sr = new Float64Array(L), si = new Float64Array(L), tr = new Float64Array(L), ti = new Float64Array(L);
    var i;
    for (i = 0; i < s.length; i++) sr[i] = s[i];
    for (i = 0; i < t.length; i++) tr[i] = t[i];
    fft(sr, si, false); fft(tr, ti, false);
    var pr = new Float64Array(L), pi = new Float64Array(L);
    for (i = 0; i < L; i++) { pr[i] = sr[i] * tr[i] + si[i] * ti[i]; pi[i] = si[i] * tr[i] - sr[i] * ti[i]; }
    fft(pr, pi, true);
    return pr;
  }

  /**
   * Глобальный поиск позиции шаблона t внутри сигнала s через FFT + пооконную
   * нормализацию (NCC, аналог matchTemplate). O(N log N).
   * Возвращает {lag, corr∈[-1,1], lagFrac}.
   * lag — ЦЕЛЫЙ индекс в s, где начинается лучшее совпадение t (безопасен как
   * индекс массива); lagFrac — субсэмпловое уточнение пика параболой по трём
   * точкам NCC (как в normXCorr), |lagFrac − lag| ≤ 0.5 — для конверсии в секунды.
   *
   * opt.exclLag (сэмплов): дополнительно вернуть corr2 — высоту ВТОРОГО пика NCC
   * вне окрестности ±exclLag от главного (метрика «остроты» à la Syncaila clarity:
   * у ложного пика similarity почти та же, а доминирование над боковыми — в разы хуже).
   */
  function globalNccPeak(s, t, opt) {
    var M = t.length, N = s.length, i;
    if (M > N || M === 0) return { lag: 0, corr: -1, lagFrac: 0 };
    var raw = rawXCorrFFT(s, t);
    var ps = new Float64Array(N + 1), ps2 = new Float64Array(N + 1);
    for (i = 0; i < N; i++) { ps[i + 1] = ps[i] + s[i]; ps2[i + 1] = ps2[i] + s[i] * s[i]; }
    var meanT = 0; for (i = 0; i < M; i++) meanT += t[i]; meanT /= M;
    var varT = 0; for (i = 0; i < M; i++) varT += (t[i] - meanT) * (t[i] - meanT);
    var stdT = Math.sqrt(varT);
    if (stdT < 1e-9) return { lag: 0, corr: 0, lagFrac: 0 }; /* шаблон-тишина */
    function nccAt(lag) {
      var sumS = ps[lag + M] - ps[lag];
      var sumS2 = ps2[lag + M] - ps2[lag];
      var meanS = sumS / M;
      var varS = sumS2 - M * meanS * meanS;
      var stdS = Math.sqrt(varS > 0 ? varS : 1e-12);
      return (raw[lag] - M * meanS * meanT) / ((stdS * stdT) || 1e-12);
    }
    var best = { lag: 0, corr: -2 };
    for (var lag = 0; lag + M <= N; lag++) {
      var ncc = nccAt(lag);
      if (ncc > best.corr) best = { lag: lag, corr: ncc };
    }
    /* парабола по соседним NCC (только если оба соседа в допустимом диапазоне лагов) */
    var sub = 0;
    if (best.lag > 0 && best.lag + 1 + M <= N) {
      var cm = nccAt(best.lag - 1), cp = nccAt(best.lag + 1);
      var d = cm - 2 * best.corr + cp;
      if (Math.abs(d) > 1e-12) sub = 0.5 * (cm - cp) / d;
      if (sub > 0.5) sub = 0.5; else if (sub < -0.5) sub = -0.5;
    }
    best.lagFrac = best.lag + sub;
    /* второй пик вне ±exclLag от главного (только по запросу — O(N) доп. проход) */
    if (opt && opt.exclLag > 0) {
      var c2 = -2;
      for (var lg = 0; lg + M <= N; lg++) {
        if (lg > best.lag - opt.exclLag && lg < best.lag + opt.exclLag) continue;
        var v2 = nccAt(lg);
        if (v2 > c2) c2 = v2;
      }
      best.corr2 = c2;
    }
    return best;
  }

  global.SyncCore = {
    zeroMean: zeroMean,
    norm: norm,
    normXCorr: normXCorr,
    detectDrift: detectDrift,
    confidenceOk: confidenceOk,
    fft: fft,
    globalNccPeak: globalNccPeak
  };
})(typeof window !== 'undefined' ? window : this);
