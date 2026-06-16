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

  /** Гейт уверенности: пик корреляции должен быть выше порога, иначе матч ненадёжен. */
  function confidenceOk(corr, threshold) {
    var t = (typeof threshold === 'number') ? threshold : 0.5;
    return corr >= t;
  }

  global.SyncCore = {
    zeroMean: zeroMean,
    norm: norm,
    normXCorr: normXCorr,
    confidenceOk: confidenceOk
  };
})(typeof window !== 'undefined' ? window : this);
