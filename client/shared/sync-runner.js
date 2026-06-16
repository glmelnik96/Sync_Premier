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

  /**
   * Per-clip синхронизация (для roaming-камер и разделения комнат).
   * Каждый клип матчится против набора РЕФЕРЕНСОВ (непрерывных источников-«часов»);
   * привязывается к лучшему. Источник, снимавший в двух комнатах, разъезжается
   * поклипно. Референсы выбираются итеративно: самый длинный, затем те, что НЕ
   * совпали с уже выбранными (→ по референсу на несвязанную комнату).
   * deps: { extractEnvelope(path,opt)→Promise<{env,dtSec}> }
   * opt: { refGate=0.45, clipGate=0.4, coarseWindowMs=20 }
   */
  function runClipSync(snapshot, deps, opt) {
    opt = opt || {};
    var SC = global.SyncCore, SG = global.SyncGraph;
    var refGate = (typeof opt.refGate === 'number') ? opt.refGate : 0.45;
    var clipGate = (typeof opt.clipGate === 'number') ? opt.clipGate : 0.4;
    var coarseMs = opt.coarseWindowMs || 20;

    function pad(env, M) { var o = new Float64Array(env.length + 2 * M); for (var i = 0; i < env.length; i++) o[M + i] = env[i]; return o; }
    /* позиция шаблона t в сигнале s (полный поиск с краевым перекрытием) → {posSec, corr} */
    function locate(sFull, tEnv, dt) {
      var M = tEnv.length;
      var r = SC.globalNccPeak(pad(sFull, M), tEnv);
      return { posSec: (r.lag - M) * dt, corr: r.corr };
    }
    /* ключ многоканального рекордера: ZOOM0002_Tr1.wav / ZOOM0002_Tr2.wav → "REC:ZOOM0002".
       Дорожки одного рекордера синхронны по определению (офсет 0) → одна референс-единица. */
    function recorderKey(path) {
      var name = String(path).split('/').pop().replace(/\.[^.]+$/, '');
      var stem = name.replace(/_Tr\d+$/i, '').replace(/_(L|R)$/i, '');
      return stem !== name ? 'REC:' + stem : path;
    }

    var srcList = uniqueSources(snapshot);
    /* 1. полные огибающие источников */
    return mapSeries(srcList, function (s) {
      return deps.extractEnvelope(s.path, { windowMs: coarseMs }).then(function (e) {
        return { path: s.path, env: e.env, dtSec: e.dtSec, coverageSec: s.coverageSec };
      });
    }).then(function (srcEnvs) {
      var dt = srcEnvs.length ? srcEnvs[0].dtSec : 0.02;

      /* 2. собрать референс-ЕДИНИЦЫ: дорожки одного рекордера → одна единица (несколько env). */
      var unitMap = {};
      for (var u0 = 0; u0 < srcEnvs.length; u0++) {
        var key0 = recorderKey(srcEnvs[u0].path);
        if (!unitMap[key0]) unitMap[key0] = { key: key0, tracks: [], maxLen: 0 };
        unitMap[key0].tracks.push(srcEnvs[u0]);
        if (srcEnvs[u0].env.length > unitMap[key0].maxLen) unitMap[key0].maxLen = srcEnvs[u0].env.length;
      }
      var units = []; for (var uk in unitMap) if (unitMap.hasOwnProperty(uk)) units.push(unitMap[uk]);
      /* позиция клипа в единице = лучший матч по её дорожкам */
      function locateUnit(unit, clipEnv) {
        var best = { posSec: 0, corr: -2 };
        for (var t = 0; t < unit.tracks.length; t++) { var lr = locate(unit.tracks[t].env, clipEnv, dt); if (lr.corr > best.corr) best = lr; }
        return best;
      }
      function unitCorr(uA, uB) { /* лучшая корреляция между дорожками двух единиц */
        var best = -2;
        for (var ta = 0; ta < uA.tracks.length; ta++) for (var tb = 0; tb < uB.tracks.length; tb++) {
          var big = uA.tracks[ta].env.length >= uB.tracks[tb].env.length ? uA.tracks[ta].env : uB.tracks[tb].env;
          var sml = uA.tracks[ta].env.length >= uB.tracks[tb].env.length ? uB.tracks[tb].env : uA.tracks[ta].env;
          var lr = locate(big, sml, dt); if (lr.corr > best) best = lr.corr;
        }
        return best;
      }

      /* 3. выбор референс-единиц: длиннейшие, не совпавшие с уже выбранными */
      var byLen = units.slice().sort(function (a, b) { return b.maxLen - a.maxLen; });
      var refs = [];
      for (var k = 0; k < byLen.length; k++) {
        var cand = byLen[k], matched0 = false;
        for (var r2 = 0; r2 < refs.length; r2++) if (unitCorr(refs[r2], cand) >= refGate) { matched0 = true; break; }
        if (!matched0) refs.push(cand);
      }

      /* 4. связать референс-единицы попарно → часовые компоненты (комнаты) */
      var refKeys = refs.map(function (r) { return r.key; });
      var refByKey = {}; for (var rk = 0; rk < refs.length; rk++) refByKey[refs[rk].key] = refs[rk];
      var refPairs = [];
      for (var x = 0; x < refs.length; x++) for (var y = x + 1; y < refs.length; y++) {
        /* офсет между единицами по их репрезентативным (длиннейшим) дорожкам */
        var ra = refs[x], rb = refs[y];
        var sigU = ra.maxLen >= rb.maxLen ? ra : rb, temU = ra.maxLen >= rb.maxLen ? rb : ra;
        var sigT = sigU.tracks[0], temT = temU.tracks[0];
        for (var ti = 0; ti < sigU.tracks.length; ti++) if (sigU.tracks[ti].env.length > sigT.env.length) sigT = sigU.tracks[ti];
        var lr2 = locate(sigT.env, temU.tracks[0].env, dt);
        refPairs.push({ a: sigU.key, b: temU.key, offset: lr2.posSec, corr: unitCorr(ra, rb) });
      }
      var refComps = SG.resolveComponents(refKeys, refPairs, { minCorr: refGate });
      var refInfo = {}; /* refKey → {clockId, off} */
      for (var rc = 0; rc < refComps.length; rc++) for (var rp in refComps[rc].offsets) if (refComps[rc].offsets.hasOwnProperty(rp)) {
        refInfo[rp] = { clockId: rc, off: refComps[rc].offsets[rp] };
      }

      /* 5. каждый клип → лучшая референс-единица → позиция в часах его комнаты */
      var clips = (snapshot.clips || []).filter(function (c) { return c.trackType === 'audio' && c.mediaPath; });
      return mapSeries(clips, function (c) {
        return deps.extractEnvelope(c.mediaPath, { startSec: c.inPointSec, durSec: c.endSec - c.startSec, windowMs: coarseMs })
          .then(function (e) {
            var best = null;
            for (var ri = 0; ri < refs.length; ri++) {
              var lr = locateUnit(refs[ri], e.env);
              if (!best || lr.corr > best.corr) best = { refPath: refs[ri].key, posSec: lr.posSec, corr: lr.corr };
            }
            return { clip: c, best: best };
          });
      }).then(function (matched) {
        /* 5. clockPos каждого валидного клипа (позиция начала в часах его референса). */
        for (var m0 = 0; m0 < matched.length; m0++) {
          var mm0 = matched[m0];
          mm0.valid = mm0.best && mm0.best.corr >= clipGate && refInfo[mm0.best.refPath];
          if (mm0.valid) { mm0.clockId = refInfo[mm0.best.refPath].clockId; mm0.clockPos = mm0.best.posSec + refInfo[mm0.best.refPath].off; }
        }

        /* 5a. СЛИЯНИЕ ЧАСОВ: разные референсы одной комнаты (напр. два лава одного
           рекордера) не коррелируют между собой → разные clockId. Но общий источник
           с клипами в обоих часах задаёт их относительный сдвиг → объединяем. */
        var clockSet = {};
        var srcClock = {}; /* source → {clockId → медиана(clockPos - inPoint)} */
        for (var m1 = 0; m1 < matched.length; m1++) {
          var mm1 = matched[m1]; if (!mm1.valid) continue;
          clockSet[mm1.clockId] = 1;
          var sp = mm1.clip.mediaPath;
          if (!srcClock[sp]) srcClock[sp] = {};
          if (!srcClock[sp][mm1.clockId]) srcClock[sp][mm1.clockId] = [];
          srcClock[sp][mm1.clockId].push(mm1.clockPos - mm1.clip.inPointSec);
        }
        function med(a) { var b = a.slice().sort(function (p, q) { return p - q; }); return b[Math.floor(b.length / 2)]; }
        /* собрать оценки clock-to-clock офсета по всем общим источникам */
        var pairEstimates = {}; /* "a|b" → [offsets] */
        for (var sp2 in srcClock) if (srcClock.hasOwnProperty(sp2)) {
          var cids = []; for (var cc in srcClock[sp2]) if (srcClock[sp2].hasOwnProperty(cc)) cids.push(cc);
          for (var a1 = 0; a1 < cids.length; a1++) for (var b1 = a1 + 1; b1 < cids.length; b1++) {
            var ka = cids[a1], kb = cids[b1], key = ka + '|' + kb;
            if (!pairEstimates[key]) pairEstimates[key] = [];
            /* time[c_a] = time[c_b] + (O(s,a) - O(s,b)) */
            pairEstimates[key].push(med(srcClock[sp2][ka]) - med(srcClock[sp2][kb]));
          }
        }
        /* ребро слияния только при КОРРОБОРАЦИИ: ≥2 источника согласны (в пределах 0.5с).
           Это отличает один рекордер с двумя лавами (много камер подтверждают) от
           roaming-источника, ложно связывающего РАЗНЫЕ комнаты (одна оценка). */
        var clockPairs = [];
        for (var key2 in pairEstimates) if (pairEstimates.hasOwnProperty(key2)) {
          var ests = pairEstimates[key2], mid = med(ests), agree = 0;
          for (var ei = 0; ei < ests.length; ei++) if (Math.abs(ests[ei] - mid) < 0.5) agree++;
          if (agree >= 2) { var parts = key2.split('|'); clockPairs.push({ a: parts[0], b: parts[1], offset: mid, corr: agree }); }
        }
        var clockIds = []; for (var ck in clockSet) if (clockSet.hasOwnProperty(ck)) clockIds.push(ck);
        var superComps = SG.resolveComponents(clockIds, clockPairs, { minCorr: 2 });
        var clockToSuper = {}; /* clockId → {superId, off} */
        for (var sc = 0; sc < superComps.length; sc++) for (var co in superComps[sc].offsets) if (superComps[sc].offsets.hasOwnProperty(co)) {
          clockToSuper[co] = { superId: sc, off: superComps[sc].offsets[co] };
        }

        /* 6. позиция в супер-часах + base (медиана startSec - superPos) на супер-часы. */
        var rawBySuper = {};
        for (var m2 = 0; m2 < matched.length; m2++) {
          var mm2 = matched[m2]; if (!mm2.valid) continue;
          var sup = clockToSuper[mm2.clockId];
          mm2.superId = sup.superId; mm2.superPos = mm2.clockPos + sup.off;
          if (!rawBySuper[sup.superId]) rawBySuper[sup.superId] = [];
          rawBySuper[sup.superId].push(mm2.clip.startSec - mm2.superPos);
        }
        var baseBySuper = {};
        for (var su in rawBySuper) if (rawBySuper.hasOwnProperty(su)) baseBySuper[su] = med(rawBySuper[su]);

        var rows = [];
        for (var n = 0; n < matched.length; n++) {
          var x2 = matched[n], c2 = x2.clip;
          if (x2.valid) {
            var base = baseBySuper[x2.superId] || 0;
            var target = base + x2.superPos;
            if (target < 0) target = 0;
            rows.push({ nodeId: c2.nodeId, name: c2.name, trackIndex: c2.trackIndex,
              shiftSec: target - c2.startSec, targetSec: target, confidence: x2.best.corr,
              component: x2.superId, slope: 0, status: 'sync' });
          } else {
            rows.push({ nodeId: c2.nodeId, name: c2.name, trackIndex: c2.trackIndex,
              shiftSec: 0, targetSec: c2.startSec, confidence: x2.best ? x2.best.corr : 0,
              component: -1, slope: 0, status: 'low-confidence' });
          }
        }
        return rows;
      });
    });
  }

  global.SyncRunner = { buildAnchorEnvelope: buildAnchorEnvelope, runSync: runSync, runSourceSync: runSourceSync, runClipSync: runClipSync, uniqueSources: uniqueSources, mapSeries: mapSeries };
})(typeof window !== 'undefined' ? window : this);
