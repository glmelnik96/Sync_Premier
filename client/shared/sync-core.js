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

  global.SyncCore = {
    zeroMean: zeroMean,
    norm: norm,
    normXCorr: normXCorr,
    detectDrift: detectDrift,
    confidenceOk: confidenceOk
  };
})(typeof window !== 'undefined' ? window : this);
