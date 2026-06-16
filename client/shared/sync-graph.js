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
   * opt: {confidenceThreshold=0.4}
   * → {shiftSec, confidence, slope, status}
   *
   * Порог 0.4 откалиброван на реальном материале (live 2026-06-16, проект ClientFirst,
   * синхронная секвенция Draft_2): истинные кросс-микрофонные совпадения (камера vs
   * ZOOM-рекордер, разные микрофоны одного события) дают corr 0.4–0.85; непересекающиеся
   * клипы и тишина — <0.3. 46/56 синхронных клипов корректно опознаны при пороге 0.4.
   */
  function resolveClipOffset(match, opt) {
    opt = opt || {};
    var thr = (typeof opt.confidenceThreshold === 'number') ? opt.confidenceThreshold : 0.4;
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
