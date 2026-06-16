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

  /** Последовательное выполнение промисов (CEP/Node без зависимостей). */
  function mapSeries(arr, fn) {
    var out = [], i = 0;
    function next() {
      if (i >= arr.length) return Promise.resolve(out);
      return fn(arr[i]).then(function (v) { out.push(v); i++; return next(); });
    }
    return next();
  }

  /**
   * deps: { extractEnvelope(path,opt)→Promise, getClipMediaPath(nodeId)→Promise<path> }
   * SyncCore/SyncGraph/TrackExtractor берутся из global.
   * Возвращает Promise<[{nodeId, name, trackIndex, shiftSec, confidence, slope, status}]>.
   */
  function runSync(snapshot, anchorIndex, deps, opt) {
    opt = opt || {};
    var TE = global.TrackExtractor, SC = global.SyncCore, SG = global.SyncGraph;
    /* dt берём из огибающей (а не хардкодим): зависит от AudioEnvelope.SAMPLE_RATE/WINDOW_MS. */
    var dt = (global.AudioEnvelope ? (global.AudioEnvelope.WINDOW_MS / 1000) : 0.005);
    var totalSec = snapshot.sequenceOutSec || 0;
    var searchWindowSec = opt.searchWindowSec || 5;
    var maxLag = Math.round(searchWindowSec / dt);
    var driftMaxLag = 200; /* дрейф ищем в узком окне у краёв (не в полном поиске) */
    var anchorClips = TE.clipsForTrack(snapshot, 'audio', anchorIndex);

    /* 1. огибающие клипов опоры */
    return mapSeries(anchorClips, function (c) {
      return deps.getClipMediaPath(c.nodeId).then(function (path) {
        return deps.extractEnvelope(path, { startSec: c.inPointSec, durSec: c.endSec - c.startSec })
          .then(function (e) { if (e.dtSec) dt = e.dtSec; return { startSec: c.startSec, env: e.env }; });
      });
    }).then(function (anchorEnvs) {
      var anchor = buildAnchorEnvelope(anchorEnvs, dt, totalSec);
      /* 2. все неопорные аудиоклипы */
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
          /* Срез опоры в текущей позиции клипа; normXCorr ищет сдвиг ±maxLag.
             Ограничение (review #3): диапазон сдвига ограничен длиной перекрытия —
             для типичных сдвигов синхронизации (<1с) достаточно. detectDrift получает
             тот же выровненный по base срез (важно: его окна head/tail предполагают
             выравнивание с клипом по индексу 0). */
          var base = Math.round(c.startSec / dt);
          var seg = anchor.env.subarray(Math.max(0, base), Math.min(anchor.env.length, base + e.env.length));
          var m = SC.normXCorr(seg, e.env, maxLag);
          var drift = SC.detectDrift(seg, e.env, { dtSec: dt, windowSamples: 400, maxLag: driftMaxLag, fps: snapshot.fps });
          var res = SG.resolveClipOffset({ lagSamples: m.lagSamples, corr: m.corr, dtSec: dt,
            slope: drift.slope, hasDrift: drift.hasDrift }, { confidenceThreshold: opt.confidenceThreshold });
          return { nodeId: c.nodeId, name: c.name, trackIndex: c.trackIndex,
            shiftSec: res.shiftSec, confidence: res.confidence, slope: res.slope, status: res.status,
            dtSec: dt, refSeg: seg, clipEnv: e.env };
        });
      });
    });
  }

  /* Уникальные source-файлы аудиоклипов (в порядке появления) + длина покрытия. */
  function uniqueSources(snapshot) {
    var clips = snapshot.clips || [];
    var order = [], seen = {};
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      if (c.trackType !== 'audio' || !c.mediaPath) continue;
      if (!seen[c.mediaPath]) { seen[c.mediaPath] = { path: c.mediaPath, coverageSec: 0 }; order.push(seen[c.mediaPath]); }
      seen[c.mediaPath].coverageSec += (c.endSec - c.startSec);
    }
    return order;
  }

  /* Дополнить сигнал нулями по M с каждой стороны (чтобы шаблон скользил с частичным перекрытием). */
  function padSignal(env, M) {
    var out = new Float64Array(env.length + 2 * M);
    for (var i = 0; i < env.length; i++) out[M + i] = env[i];
    return out;
  }

  /**
   * Source-based глобальная синхронизация (модель Syncaila).
   * deps: { extractEnvelope(path,opt)→Promise<{env,dtSec}> }
   * opt: { minCorr=0.4, coarseWindowMs=20, preferredRoot }
   * Возвращает Promise<[{nodeId,name,trackIndex,shiftSec,confidence,slope,status,targetSec}]>.
   */
  function runSourceSync(snapshot, deps, opt) {
    opt = opt || {};
    var SC = global.SyncCore, SG = global.SyncGraph;
    var minCorr = (typeof opt.minCorr === 'number') ? opt.minCorr : 0.4;
    var coarseMs = opt.coarseWindowMs || 20;
    var srcList = uniqueSources(snapshot);

    /* 1. полная огибающая каждого источника (один раз). */
    return mapSeries(srcList, function (s) {
      return deps.extractEnvelope(s.path, { windowMs: coarseMs }).then(function (e) {
        return { path: s.path, env: e.env, dtSec: e.dtSec, coverageSec: s.coverageSec };
      });
    }).then(function (srcEnvs) {
      var byPath = {};
      for (var i = 0; i < srcEnvs.length; i++) byPath[srcEnvs[i].path] = srcEnvs[i];
      var dt = srcEnvs.length ? srcEnvs[0].dtSec : 0.02;

      /* 2. попарная глобальная корреляция (signal=длиннее, template=короче). */
      var pairs = [];
      for (var x = 0; x < srcEnvs.length; x++) {
        for (var y = x + 1; y < srcEnvs.length; y++) {
          var sa = srcEnvs[x], sb = srcEnvs[y];
          var signalSrc, templSrc;
          if (sa.env.length >= sb.env.length) { signalSrc = sa; templSrc = sb; }
          else { signalSrc = sb; templSrc = sa; }
          var M = templSrc.env.length;
          var padded = padSignal(signalSrc.env, M);
          var res = SC.globalNccPeak(padded, templSrc.env);
          var offsetSec = (res.lag - M) * dt;   /* signal_time = templ_time + offsetSec */
          /* pair {a:signal, b:templ, offset}: time[a]=time[b]+offset */
          pairs.push({ a: signalSrc.path, b: templSrc.path, offset: offsetSec, corr: res.corr });
        }
      }

      /* 3. компоненты связности (комнаты/сессии без общего звука — раздельно).
         Корень компоненты = самый длинный источник в ней. */
      var paths = srcEnvs.map(function (s) { return s.path; });
      var comps = SG.resolveComponents(paths, pairs, { minCorr: minCorr,
        preferredRootOf: function (members) {
          var lng = null;
          for (var mm = 0; mm < members.length; mm++) if (!lng || byPath[members[mm]].env.length > byPath[lng].env.length) lng = members[mm];
          return lng;
        } });
      /* source → {off, conf, compId} */
      var srcInfo = {};
      for (var ci = 0; ci < comps.length; ci++) {
        var cp = comps[ci];
        for (var sp in cp.offsets) if (cp.offsets.hasOwnProperty(sp)) {
          srcInfo[sp] = { off: cp.offsets[sp], conf: cp.confidence[sp] != null ? cp.confidence[sp] : 0, compId: ci };
        }
      }

      var clips = snapshot.clips || [];

      /* 4. base каждой компоненты = медиана (startSec - inPoint - off) по её клипам:
         компонента остаётся около текущего места, выравнивается только внутри себя
         (без ложного межгруппового сдвига через слабый мост). */
      var rawByComp = {};
      var k2;
      for (k2 = 0; k2 < clips.length; k2++) {
        var cl = clips[k2];
        if (cl.trackType !== 'audio' || !cl.mediaPath || !srcInfo[cl.mediaPath]) continue;
        var info = srcInfo[cl.mediaPath];
        var val = cl.startSec - cl.inPointSec - info.off;
        if (!rawByComp[info.compId]) rawByComp[info.compId] = [];
        rawByComp[info.compId].push(val);
      }
      var baseByComp = {};
      for (var cid in rawByComp) {
        if (!rawByComp.hasOwnProperty(cid)) continue;
        var arr = rawByComp[cid].slice().sort(function (a, b) { return a - b; });
        baseByComp[cid] = arr[Math.floor(arr.length / 2)]; /* медиана */
      }

      /* 5. цель каждого аудиоклипа. */
      var rows = [];
      for (var j = 0; j < clips.length; j++) {
        var c2 = clips[j];
        if (c2.trackType !== 'audio' || !c2.mediaPath) continue;
        if (srcInfo[c2.mediaPath]) {
          var inf = srcInfo[c2.mediaPath];
          var base = baseByComp[inf.compId] || 0;
          var target = base + c2.inPointSec + inf.off;
          if (target < 0) target = 0;
          rows.push({ nodeId: c2.nodeId, name: c2.name, trackIndex: c2.trackIndex,
            shiftSec: target - c2.startSec, targetSec: target,
            confidence: inf.conf, component: inf.compId, slope: 0, status: 'sync' });
        } else {
          rows.push({ nodeId: c2.nodeId, name: c2.name, trackIndex: c2.trackIndex,
            shiftSec: 0, targetSec: c2.startSec, confidence: 0, component: -1, slope: 0, status: 'low-confidence' });
        }
      }
      return rows;
    });
  }

  global.SyncRunner = { buildAnchorEnvelope: buildAnchorEnvelope, runSync: runSync, runSourceSync: runSourceSync, uniqueSources: uniqueSources, mapSeries: mapSeries };
})(typeof window !== 'undefined' ? window : this);
