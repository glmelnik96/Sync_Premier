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

  /**
   * Разрешение офсетов источников по попарным измерениям (модель Syncaila).
   * sources: [id...]; pairs: [{a,b,offset,corr}] где отношение time[a]=time[b]+offset.
   * opt: {minCorr=0.4}. Строит максимально-уверенное остовное дерево (best-first) от
   * корня (самый связный узел крупнейшей компоненты).
   * Возвращает {root, offsets:{id→offsetToRoot}, unreachable:[id...]}.
   * Смысл offsetToRoot(S): root_time = S_time + offsetToRoot(S).
   */
  function resolveSourceOffsets(sources, pairs, opt) {
    opt = opt || {};
    var minCorr = (typeof opt.minCorr === 'number') ? opt.minCorr : 0.4;
    var edges = [];
    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i].corr >= minCorr) edges.push(pairs[i]);
    }
    /* суммарная уверенность по узлам → выбор корня */
    var incident = {};
    for (var s = 0; s < sources.length; s++) incident[sources[s]] = 0;
    for (var e = 0; e < edges.length; e++) {
      incident[edges[e].a] = (incident[edges[e].a] || 0) + edges[e].corr;
      incident[edges[e].b] = (incident[edges[e].b] || 0) + edges[e].corr;
    }
    var root = sources.length ? sources[0] : null;
    for (var r2 = 0; r2 < sources.length; r2++) {
      if (incident[sources[r2]] > incident[root]) root = sources[r2];
    }
    /* preferredRoot (напр. самый длинный источник) — если задан и есть в списке. */
    if (opt.preferredRoot != null) {
      for (var pr = 0; pr < sources.length; pr++) if (sources[pr] === opt.preferredRoot) { root = opt.preferredRoot; break; }
    }
    if (root == null) return { root: null, offsets: {}, confidence: {}, unreachable: [] };

    /* best-first: повторно берём ребро с макс corr между разрешённым и неразрешённым. */
    var offsets = {}; offsets[root] = 0;
    var confidence = {}; confidence[root] = 1;     /* bottleneck corr пути к корню */
    var changed = true;
    while (changed) {
      changed = false;
      var bestEdge = null, bestCorr = -1, bestKnown = null;
      for (var k = 0; k < edges.length; k++) {
        var ed = edges[k];
        var aKnown = offsets.hasOwnProperty(ed.a), bKnown = offsets.hasOwnProperty(ed.b);
        if (aKnown === bKnown) continue;            /* оба известны или оба нет */
        if (ed.corr > bestCorr) {
          bestCorr = ed.corr; bestEdge = ed;
          bestKnown = aKnown ? ed.a : ed.b;
        }
      }
      if (bestEdge) {
        /* ob = oa + offset (time[a]=time[b]+offset). */
        var newNode;
        if (bestKnown === bestEdge.a) { offsets[bestEdge.b] = offsets[bestEdge.a] + bestEdge.offset; newNode = bestEdge.b; }
        else { offsets[bestEdge.a] = offsets[bestEdge.b] - bestEdge.offset; newNode = bestEdge.a; }
        confidence[newNode] = Math.min(confidence[bestKnown], bestEdge.corr);
        changed = true;
      }
    }
    var unreachable = [];
    for (var u = 0; u < sources.length; u++) if (!offsets.hasOwnProperty(sources[u])) unreachable.push(sources[u]);
    return { root: root, offsets: offsets, confidence: confidence, unreachable: unreachable };
  }

  /**
   * Разбить источники на компоненты связности (по рёбрам corr≥minCorr) и в каждой
   * посчитать офсеты (max-spanning-tree от самого связного узла). Несвязанные группы
   * (напр. съёмка в разных помещениях без общего звука) остаются раздельными.
   * Возвращает [{sources:[...], root, offsets:{id→off}, confidence:{id→c}}].
   */
  function resolveComponents(sources, pairs, opt) {
    opt = opt || {};
    var minCorr = (typeof opt.minCorr === 'number') ? opt.minCorr : 0.4;
    var strong = [];
    for (var i = 0; i < pairs.length; i++) if (pairs[i].corr >= minCorr) strong.push(pairs[i]);

    /* union-find по сильным рёбрам */
    var parent = {};
    for (var s = 0; s < sources.length; s++) parent[sources[s]] = sources[s];
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function uni(a, b) { parent[find(a)] = find(b); }
    for (var e = 0; e < strong.length; e++) uni(strong[e].a, strong[e].b);

    /* группировка источников по корню union-find */
    var groups = {};
    for (var g = 0; g < sources.length; g++) {
      var rt = find(sources[g]);
      if (!groups[rt]) groups[rt] = [];
      groups[rt].push(sources[g]);
    }

    /* для каждой компоненты — свой подграф рёбер и resolveSourceOffsets */
    var comps = [];
    for (var key in groups) {
      if (!groups.hasOwnProperty(key)) continue;
      var members = groups[key];
      var memberSet = {};
      for (var m = 0; m < members.length; m++) memberSet[members[m]] = 1;
      var subPairs = [];
      for (var p = 0; p < strong.length; p++) if (memberSet[strong[p].a] && memberSet[strong[p].b]) subPairs.push(strong[p]);
      var res = resolveSourceOffsets(members, subPairs, { minCorr: minCorr, preferredRoot: opt.preferredRootOf ? opt.preferredRootOf(members) : null });
      comps.push({ sources: members, root: res.root, offsets: res.offsets, confidence: res.confidence });
    }
    /* крупнейшие компоненты первыми */
    comps.sort(function (x, y) { return y.sources.length - x.sources.length; });
    return comps;
  }

  global.SyncGraph = {
    pickAnchorTrack: pickAnchorTrack,
    resolveClipOffset: resolveClipOffset,
    resolveSourceOffsets: resolveSourceOffsets,
    resolveComponents: resolveComponents
  };
})(typeof window !== 'undefined' ? window : this);
