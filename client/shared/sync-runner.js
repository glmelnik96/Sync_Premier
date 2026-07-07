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
    /* блочное прореживание огибающей в D раз (среднее) — для грубого матча на больших проектах */
    function downsample(env, D) {
      if (D <= 1) return env;
      var n = Math.floor(env.length / D); if (n < 1) n = 1;
      var o = new Float64Array(n);
      for (var i = 0; i < n; i++) { var s = 0; for (var k = 0; k < D; k++) s += env[i * D + k]; o[i] = s / D; }
      return o;
    }
    /* позиция шаблона t в сигнале s (полный поиск с краевым перекрытием) → {posSec, corr} */
    function locate(sFull, tEnv, dt) {
      var M = tEnv.length;
      var r = SC.globalNccPeak(pad(sFull, M), tEnv);
      return { posSec: (r.lag - M) * dt, corr: r.corr };
    }
    /* ключ многоканального рекордера: ZOOM0002_Tr1.wav / ZOOM0002_Tr2.wav → "REC:ZOOM0002".
       Дорожки одного рекордера синхронны по определению (офсет 0) → одна референс-единица. */
    function recorderKey(path) {
      var parts = String(path).split(/[/\\]/);            /* и '/', и Windows '\' */
      var name = parts[parts.length - 1].replace(/\.[^.]+$/, '');
      /* _Tr1/_Tr2 — отдельные микрофоны; _TrLR — стерео-микс ТОГО ЖЕ рекордера (кейс 3:
         ZOOM0007_TrLR + _Tr1 — один физический ZOOM, офсет 0). Без _TrLR в ключе _Tr1
         оставался отдельным «устройством» и, не скоррелировавшись сам, падал в unsynced
         (33252f мимо), хотя стерео-микс того же рекордера синкался идеально. */
      var stem = name.replace(/_Tr(\d+|LR)$/i, '').replace(/_(L|R)$/i, '');
      return stem !== name ? 'REC:' + stem : path;
    }
    /* ключ УСТРОЙСТВА (камера/рекордер) = первый токен имени файла: A065_0718…_C071 → "A065",
       1100_0506…_C004 → "1100", Track 1_005 → "Track 1", ZOOM0002_Tr1 → "ZOOM0002". Нужен,
       чтобы аудио-якорь клипа искался к ДРУГОМУ физическому устройству (а не к самому себе /
       соседнему сегменту той же камеры — это давало вырожденные совпадения). */
    function deviceKey(path) {
      var parts = String(path).split(/[/\\]/);
      var name = parts[parts.length - 1].replace(/\.[^.]+$/, '');
      var us = name.indexOf('_');
      return us > 0 ? name.slice(0, us) : name;
    }

    var srcList = uniqueSources(snapshot);
    /* 1. полные огибающие источников */
    return mapSeries(srcList, function (s) {
      return deps.extractEnvelope(s.path, { windowMs: coarseMs }).then(function (e) {
        return { path: s.path, env: e.env, dtSec: e.dtSec, coverageSec: s.coverageSec };
      });
    }).then(function (srcEnvs) {
      var dt = srcEnvs.length ? srcEnvs[0].dtSec : 0.02;

      /* ПРОИЗВОДИТЕЛЬНОСТЬ на БОЛЬШИХ проектах: при многих источниках корреляция против
         ОЧЕНЬ длинных огибающих (рекордер на 90+ мин = 270k+ сэмплов) — это FFT длины 512k на
         КАЖДУЮ пару клип×референс → нереально (кейс 5: таймаут 10 мин). Прорежаем ВСЕ огибающие
         в DS раз (блочное среднее) так, чтобы самая длинная влезла в ~TARGET сэмплов. Тогда и
         попарный граф, и поклиповый матч идут на грубой шкале (dt×DS), позиции — с точностью
         ~dt×DS. Для типовых проектов (≤ порога) DS=1 → поведение НЕ меняется. */
      var DS = 1, dtFull = dt;
      if (srcEnvs.length > (opt.maxFullMatch || 160)) {
        var maxLen = 0; for (var ml = 0; ml < srcEnvs.length; ml++) if (srcEnvs[ml].env.length > maxLen) maxLen = srcEnvs[ml].env.length;
        var TARGET = opt.coarseTarget || 40000;
        DS = Math.max(1, Math.ceil(maxLen / TARGET));
        if (DS > 1) {
          for (var ds = 0; ds < srcEnvs.length; ds++) { srcEnvs[ds].envFull = srcEnvs[ds].env; srcEnvs[ds].env = downsample(srcEnvs[ds].env, DS); }
          dt = dt * DS;
        }
      }

      /* ---- COARSE-TO-FINE (только при DS>1) ----
         Прореженные огибающие речи ЛОЖНО похожи: у заведомо несвязанных источников
         грубая NCC даёт 0.8+ (ловит общую макро-динамику речи), поэтому (а) грубая
         corr непригодна как гейт честности связи, (б) позиция квантована DS·dt
         (несколько кадров рассинхрона). Каждый значимый грубый матч перепроверяется
         на ПОЛНОМ разрешении: до 3 проб (окна макс. энергии в третях шаблона)
         по PROBE_SEC ищутся узкооконным NCC вокруг ожидаемого места; corr и позиция =
         медианы по пробам. Ложный грубый пик на полном разрешении рассыпается
         (corr→~0) → честный сигнал для красной маркировки; истинный — уточняет
         позицию до dtFull. */
      var PROBE_SEC = 5;
      var probeNp = Math.max(50, Math.round(PROBE_SEC / dtFull));
      var fineLag = 3 * DS + 5; /* грубая ошибка ±2-3 coarse-сэмпла + запас */
      function medNum(a) { var b = a.slice().sort(function (p, q) { return p - q; }); return b[Math.floor(b.length / 2)]; }
      function bestEnergyWindow(env, lo, hi, Np) {
        var sum = 0, i;
        for (i = lo; i < lo + Np; i++) sum += env[i];
        var bst = sum, bi = lo;
        for (i = lo + 1; i + Np <= hi; i++) { sum += env[i + Np - 1] - env[i - 1]; if (sum > bst) { bst = sum; bi = i; } }
        return bi;
      }
      /* топ-энергетические окна в K долях шаблона (кэш на самом массиве — шаблон
         юнита участвует в сотнях пар, пересканировать каждый раз дорого) */
      var PROBES_K = 5;
      function probesOf(env) {
        if (env.__probes) return env.__probes;
        var out = [];
        if (env.length <= probeNp) out = [0];
        else {
          var part = Math.floor(env.length / PROBES_K);
          if (part >= probeNp) { for (var z = 0; z < PROBES_K; z++) out.push(bestEnergyWindow(env, z * part, (z + 1) * part, probeNp)); }
          else out = [bestEnergyWindow(env, 0, env.length, probeNp)];
        }
        env.__probes = out;
        return out;
      }
      /* NCC окна шаблона tmpl[p0..p0+Np) против сигнала на позициях [sLo..sHi-Np];
         среднее/дисперсия сигнала — скользящими суммами (O(1) на позицию). */
      function probeNcc(sig, sLo, sHi, tmpl, p0, Np) {
        var i, tm = 0, tv = 0;
        for (i = 0; i < Np; i++) tm += tmpl[p0 + i];
        tm /= Np;
        for (i = 0; i < Np; i++) { var d0 = tmpl[p0 + i] - tm; tv += d0 * d0; }
        var tstd = Math.sqrt(tv);
        if (tstd < 1e-9) return null; /* проба-тишина */
        var sumS = 0, sumS2 = 0;
        for (i = sLo; i < sLo + Np; i++) { sumS += sig[i]; sumS2 += sig[i] * sig[i]; }
        var bst = null;
        for (var pos = sLo; pos + Np <= sHi; pos++) {
          if (pos > sLo) { var po = sig[pos - 1], pn = sig[pos + Np - 1]; sumS += pn - po; sumS2 += pn * pn - po * po; }
          var meanS = sumS / Np, varS = sumS2 - Np * meanS * meanS;
          if (varS < 1e-12) continue;
          var cc = 0;
          for (i = 0; i < Np; i++) cc += sig[pos + i] * tmpl[p0 + i];
          var ncc = (cc - Np * meanS * tm) / (Math.sqrt(varS) * tstd);
          if (!bst || ncc > bst.corr) bst = { pos: pos, corr: ncc };
        }
        return bst;
      }
      /* → {posSec, corr} на полном разрешении, либо null (нет пригодных проб). */
      function refineFine(sigFull, tmplFull, coarsePosSec) {
        var exp0 = Math.round(coarsePosSec / dtFull);
        var tLo = Math.max(0, -exp0), tHi = Math.min(tmplFull.length, sigFull.length - exp0);
        var Np = probeNp;
        if (tHi - tLo < Np) {
          Np = tHi - tLo;
          if (Np < Math.round(1 / dtFull)) return null; /* перекрытие < 1с — судить не о чем */
        }
        var cand = probesOf(tmplFull), probes = [];
        for (var pc = 0; pc < cand.length; pc++) if (cand[pc] >= tLo && cand[pc] + Np <= tHi) probes.push(cand[pc]);
        if (!probes.length) probes = [bestEnergyWindow(tmplFull, tLo, tHi, Np)];
        var lags = [], corrs = [];
        for (var pf = 0; pf < probes.length; pf++) {
          var p0 = probes[pf];
          var sLo = exp0 + p0 - fineLag, sHi = exp0 + p0 + Np + fineLag;
          if (sLo < 0) sLo = 0;
          if (sHi > sigFull.length) sHi = sigFull.length;
          if (sHi - sLo < Np) continue;
          var r = probeNcc(sigFull, sLo, sHi, tmplFull, p0, Np);
          if (!r) continue;
          lags.push(r.pos - (exp0 + p0));
          corrs.push(r.corr);
        }
        if (!corrs.length) return null;
        /* Консенсус лагов: истинный матч даёт одинаковый лаг на всех пробах.
           На музыке пробы дают высокие corr на РАЗНЫХ ложных смещениях —
           медиана corr обманчива. Оставляем только пробы, согласные с медианным
           лагом (±3 сэмпла full-res); при одной пробе консенсус не проверить —
           штрафуем corr. */
        var mLag = medNum(lags);
        var agLags = [], agCorrs = [];
        for (var ag = 0; ag < lags.length; ag++) {
          if (Math.abs(lags[ag] - mLag) <= 3) { agLags.push(lags[ag]); agCorrs.push(corrs[ag]); }
        }
        if (corrs.length >= 2 && agLags.length < 2) return { posSec: (exp0 + mLag) * dtFull, corr: 0 };
        var cr = medNum(agCorrs);
        if (corrs.length === 1) cr *= 0.85; /* одна проба — консенсус непроверяем */
        else cr *= agLags.length / corrs.length; /* доля согласных проб */
        return { posSec: (exp0 + medNum(agLags)) * dtFull, corr: cr };
      }

      /* 2. собрать референс-ЕДИНИЦЫ: дорожки одного рекордера → одна единица (несколько env). */
      var unitMap = {};
      for (var u0 = 0; u0 < srcEnvs.length; u0++) {
        var key0 = recorderKey(srcEnvs[u0].path);
        if (!unitMap[key0]) unitMap[key0] = { key: key0, tracks: [], maxLen: 0, dev: deviceKey(srcEnvs[u0].path), repPath: srcEnvs[u0].path };
        unitMap[key0].tracks.push(srcEnvs[u0]);
        if (srcEnvs[u0].env.length > unitMap[key0].maxLen) unitMap[key0].maxLen = srcEnvs[u0].env.length;
      }
      var units = []; for (var uk in unitMap) if (unitMap.hasOwnProperty(uk)) units.push(unitMap[uk]);
      /* позиция клипа в единице = лучший матч по её дорожкам */
      function locateUnit(unit, clipEnv) {
        var best = { posSec: 0, corr: -2, track: null };
        for (var t = 0; t < unit.tracks.length; t++) { var lr = locate(unit.tracks[t].env, clipEnv, dt); if (lr.corr > best.corr) best = { posSec: lr.posSec, corr: lr.corr, track: unit.tracks[t] }; }
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

      /* представительная (длиннейшая) дорожка единицы */
      function repTrack(u) { var t = u.tracks[0]; for (var i = 1; i < u.tracks.length; i++) if (u.tracks[i].env.length > t.env.length) t = u.tracks[i]; return t; }

      /* 3. КАЖДАЯ единица — узел графа. Попарные corr+offset между ВСЕМИ единицами.
         Раньше выбиралась подвыборка «референсов» (длиннейшие), и камеры со слабой
         корреляцией к рекордеру (0.45–0.51) поглощались им и НЕ становились опорными —
         поэтому позиции камер считались по слабому матчу к рекордеру, а не по сильному
         (0.8+) матчу камера-камера, и расходились. Теперь связи строит max-spanning-tree
         по ВСЕМ узлам: сильные рёбра камера-камера образуют костяк, рекордер цепляется
         своим лучшим ребром, не искажая взаимное положение камер. */
      var unitPairs = [];
      for (var x = 0; x < units.length; x++) for (var y = x + 1; y < units.length; y++) {
        var ra = units[x], rb = units[y];
        var bigU = ra.maxLen >= rb.maxLen ? ra : rb, smlU = ra.maxLen >= rb.maxLen ? rb : ra;
        var lr2 = locate(repTrack(bigU).env, repTrack(smlU).env, dt); /* posSec = старт smlU внутри bigU */
        var pOff = lr2.posSec, pCorr = unitCorr(ra, rb);
        /* coarse-to-fine ребра: честная corr (ложные грубые 0.8+ рассыпаются) +
           точный офсет (иначе взаимное положение юнитов квантовано DS·dt) */
        if (DS > 1 && pCorr >= refGate) {
          var frP = refineFine(repTrack(bigU).envFull, repTrack(smlU).envFull, lr2.posSec);
          if (frP) { pOff = frP.posSec; pCorr = frP.corr; }
          else pCorr = 0; /* перепроверить нечем (тишина/нет перекрытия) → связи нет */
        }
        unitPairs.push({ a: bigU.key, b: smlU.key, offset: pOff, corr: pCorr }); /* time[big]=time[sml]+offset */
      }
      /* 3b. КОМНАТЫ через НАДЁЖНЫЕ связи (модель «А слышит Б, Б слышит рекордер»):
         • СИЛЬНОЕ ребро (corr≥strongGate) объединяет напрямую и ТРАНЗИТИВНО — чёткое
           «слышит»; цепочка сильных рёбер связывает A-B-C, даже если A не слышит C.
         • СЛАБОЕ ребро в одиночку (weakGate..strongGate) НЕ объединяет: может быть
           случайным совпадением (ложный пик ~0.5, как roaming-камера к чужой комнате).
           Объединяет только КОРРОБОРАЦИЯ — ≥2 слабых ребра между группами с СОГЛАСОВАННЫМ
           сдвигом (так лав-рекордер, слышимый несколькими камерами, цепляется к ним).
         Единицы без надёжной связи остаются одиночками → их клипы уйдут в конец + label. */
      function medOf(a) { var b = a.slice().sort(function (p, q) { return p - q; }); return b[Math.floor(b.length / 2)]; }
      var strongGate = 0.7, weakGate = refGate, mergeTol = 3.0;
      var edgesByCorr = unitPairs.filter(function (e) { return e.corr >= weakGate; }).sort(function (a, b) { return b.corr - a.corr; });
      var parent = {}, off = {}; /* root_time = node_time + offToRoot(node) */
      for (var ui = 0; ui < units.length; ui++) { parent[units[ui].key] = units[ui].key; off[units[ui].key] = 0; }
      function find(k) { while (parent[k] !== k) k = parent[k]; return k; }
      function offToRoot(k) { var s = 0; while (parent[k] !== k) { s += off[k]; k = parent[k]; } return s; }
      function uniteRoots(rA, rB, d) { parent[rB] = rA; off[rB] = d; } /* rootA_time = rootB_time + d */
      /* сильные рёбра → прямое транзитивное объединение, НО с верификацией консенсусом:
         на музыке (банкет) сегменты рекордера дают ЛОЖНЫЕ corr 0.9+ (повторяющийся припев) —
         одно такое ребро утаскивало Track 1_008 на 1500с. Истинное объединение подтверждается
         ДРУГИМИ рёбрами между теми же группами (согласованный сдвиг); если несогласных рёбер
         БОЛЬШЕ, чем согласных, — ребро ложное, пропускаем. Пары с единственным ребром
         (кейсы 1–3) объединяются как раньше: возражений нет. */
      function edgeConsensus(rA, rB, dd) { /* {support, contra} среди всех рёбер weakGate+ между группами rA и rB */
        var support = 0, contra = 0;
        for (var ce = 0; ce < edgesByCorr.length; ce++) {
          var eC = edgesByCorr[ce];
          var cA = find(eC.a), cB = find(eC.b);
          var dC;
          if (cA === rA && cB === rB) dC = eC.offset + offToRoot(eC.a) - offToRoot(eC.b);
          else if (cA === rB && cB === rA) dC = -(eC.offset + offToRoot(eC.a) - offToRoot(eC.b));
          else continue;
          if (Math.abs(dC - dd) < mergeTol) support++; else contra++;
        }
        return { support: support, contra: contra };
      }
      for (var se = 0; se < edgesByCorr.length; se++) {
        var ed = edgesByCorr[se]; if (ed.corr < strongGate) continue;
        var raR = find(ed.a), rbR = find(ed.b); if (raR === rbR) continue;
        var dU = ed.offset + offToRoot(ed.a) - offToRoot(ed.b); /* rootA = rootB + d */
        var cons = edgeConsensus(raR, rbR, dU);
        if (cons.contra > cons.support) continue; /* большинство рёбер даёт ДРУГОЙ сдвиг → ложный пик */
        uniteRoots(raR, rbR, dU);
      }
      /* слабые рёбра → объединение только при корроборации ≥2 согласованных оценок сдвига */
      var changedRooms = true;
      while (changedRooms) {
        changedRooms = false;
        var byPair = {};
        for (var we = 0; we < edgesByCorr.length; we++) {
          var e2 = edgesByCorr[we]; var rA = find(e2.a), rB = find(e2.b); if (rA === rB) continue;
          var dd = e2.offset + offToRoot(e2.a) - offToRoot(e2.b); /* rootA(e2.a) = rootB(e2.b) + dd */
          var keyP = rA + '\u0001' + rB, flip = false, alt = rB + '\u0001' + rA;
          if (byPair[alt]) { keyP = alt; flip = true; } else if (!byPair[keyP]) byPair[keyP] = { a: rA, b: rB, ds: [] };
          byPair[keyP].ds.push(flip ? -dd : dd);
        }
        for (var pk in byPair) { if (!byPair.hasOwnProperty(pk)) continue;
          var pr = byPair[pk]; if (pr.ds.length < 2) continue;
          var mD = medOf(pr.ds), agree = 0;
          for (var di = 0; di < pr.ds.length; di++) if (Math.abs(pr.ds[di] - mD) < mergeTol) agree++;
          if (agree >= 2) { var rrA = find(pr.a), rrB = find(pr.b); if (rrA !== rrB) { uniteRoots(rrA, rrB, mD); changedRooms = true; break; } }
        }
      }
      /* комнаты по корням union-find; connected=true если в комнате >1 единицы */
      var roomMembers = {};
      for (var uu = 0; uu < units.length; uu++) { var rt = find(units[uu].key); if (!roomMembers[rt]) roomMembers[rt] = []; roomMembers[rt].push(units[uu].key); }
      var refInfo = {}, rid = 0; /* unitKey → {clockId, off(к корню комнаты), connected} */
      for (var rmk in roomMembers) { if (!roomMembers.hasOwnProperty(rmk)) continue;
        var mem = roomMembers[rmk], conn = mem.length > 1;
        for (var mk = 0; mk < mem.length; mk++) refInfo[mem[mk]] = { clockId: rid, off: offToRoot(mem[mk]), connected: conn };
        rid++;
      }
      /* НАДЁЖНОСТЬ ПРИВЯЗКИ единицы к комнате = макс. реальная corr к другой единице ТОЙ ЖЕ
         комнаты (из попарных рёбер). Нужна для выбора device-анкора: камера из многих файлов
         должна якориться файлом с СИЛЬНОЙ корреляцией к рекордеру, а не случайным (self-match
         даёт 1.0 у всех → выбор вслепую → вся камера могла уехать). */
      var unitRoomCorr = {};
      for (var uc = 0; uc < units.length; uc++) unitRoomCorr[units[uc].key] = 0;
      for (var up = 0; up < unitPairs.length; up++) {
        var ep = unitPairs[up];
        if (refInfo[ep.a] && refInfo[ep.b] && refInfo[ep.a].clockId === refInfo[ep.b].clockId) {
          if (ep.corr > unitRoomCorr[ep.a]) unitRoomCorr[ep.a] = ep.corr;
          if (ep.corr > unitRoomCorr[ep.b]) unitRoomCorr[ep.b] = ep.corr;
        }
      }
      if (typeof opt.onGraph === 'function') opt.onGraph({ unitPairs: unitPairs, refInfo: refInfo, unitRoomCorr: unitRoomCorr });

      /* 4. каждый клип → лучшая по корреляции единица → позиция в часах её комнаты.
         ПРОИЗВОДИТЕЛЬНОСТЬ: при МНОГИХ источниках (300+) полный перебор клип×ВСЕ_единицы —
         это O(clips×units) FFT-корреляций (на кейсе 5: 1347×355 ≈ 478k → ~11 мин, таймаут).
         Но «лучшая единица» почти всегда — СОБСТВЕННАЯ единица клипа (self-match≈1.0). Поэтому
         при большом N матчим только против ТОП-K самых длинных единиц (референсов), а
         собственную учитываем по self-shortcut (позиция клипа в своём источнике = его inPoint).
         При малом N (≤ maxFullMatch) — полный перебор, поведение НЕ меняется (кейсы 1–4). */
      var maxFullMatch = opt.maxFullMatch || 160;
      var fullMatch = units.length <= maxFullMatch;
      var refUnits = units;
      if (!fullMatch) {
        refUnits = units.slice().sort(function (a, b) { return b.maxLen - a.maxLen; });
        refUnits = refUnits.slice(0, opt.maxRefs || 60);
      }
      var CROSS_MINLEN = opt.crossMinLenSec || 15;
      var clips = (snapshot.clips || []).filter(function (c) { return c.trackType === 'audio' && c.mediaPath; });
      return mapSeries(clips, function (c) {
        return deps.extractEnvelope(c.mediaPath, { startSec: c.inPointSec, durSec: c.endSec - c.startSec, windowMs: coarseMs })
          .then(function (e) {
            var fineEnv = e.env; /* полное разрешение — для coarse-to-fine перепроверки */
            var cenv = DS > 1 ? downsample(e.env, DS) : e.env;
            e = { env: cenv };
            var myDev = deviceKey(c.mediaPath);
            var ownKey = recorderKey(c.mediaPath);
            var best = null, cross = null, ownSeen = false;
            for (var ri = 0; ri < refUnits.length; ri++) {
              if (refUnits[ri].key === ownKey) ownSeen = true;
              var lr = locateUnit(refUnits[ri], e.env);
              if (!best || lr.corr > best.corr) best = { unitKey: refUnits[ri].key, posSec: lr.posSec, corr: lr.corr, track: lr.track };
              /* лучшее ребро к ДРУГОМУ устройству — якорь для непривязанных по таймкоду
                 клипов (аудио-бэг рекордера): ставятся относительно надёжно разложенной
                 камеры, минуя вырожденные часы компоненты. posSec = старт ин-поинта клипа
                 внутри ПОЛНОЙ огибающей источника-партнёра. */
              /* якорь только к ДОСТАТОЧНО ДЛИННОМУ партнёру: короткий референс (напр. 1с
                 C027.braw в кейсе 4) скользит внутри длинного клипа и даёт ложный NCC-пик,
                 утаскивая клип в мусор. Абсолютный порог отделяет ложные короткие партнёры
                 (1–13с) от здоровых (20–89с). */
              if (refUnits[ri].dev !== myDev && refUnits[ri].maxLen * dt >= CROSS_MINLEN &&
                  (!cross || lr.corr > cross.corr))
                cross = { partnerPath: refUnits[ri].repPath, posSec: lr.posSec, corr: lr.corr, partnerLenSec: refUnits[ri].maxLen * dt, track: lr.track };
            }
            /* собственная единица не попала в референсы (большой N) → self-shortcut:
               клип сидит в своём источнике на позиции inPoint, self-corr=1 → побеждает. */
            if (!ownSeen && unitMap[ownKey] && (!best || best.corr < 1))
              best = { unitKey: ownKey, posSec: c.inPointSec, corr: 1, track: null };
            /* coarse-to-fine: перепроверка матчей клипа на полном разрешении
               (self-shortcut без track — позиция и так точная). */
            if (DS > 1) {
              if (best && best.track && best.track.envFull) {
                var fb = refineFine(best.track.envFull, fineEnv, best.posSec);
                if (fb) { best.posSec = fb.posSec; best.corr = fb.corr; } else best.corr = 0;
              }
              if (cross && cross.track && cross.track.envFull) {
                var fx = refineFine(cross.track.envFull, fineEnv, cross.posSec);
                if (fx) { cross.posSec = fx.posSec; cross.corr = fx.corr; } else cross.corr = 0;
              }
            }
            return { clip: c, best: best, cross: cross };
          });
      }).then(function (matched) {
        function med(a) { var b = a.slice().sort(function (p, q) { return p - q; }); return b[Math.floor(b.length / 2)]; }
        /* clockPos = позиция клипа в его единице + офсет единицы к корню комнаты.
           connected = клип привязан к НАДЁЖНОЙ (многоузловой) комнате. */
        for (var m0 = 0; m0 < matched.length; m0++) {
          var mm0 = matched[m0], ri = mm0.best ? refInfo[mm0.best.unitKey] : null;
          mm0.connected = !!(mm0.best && mm0.best.corr >= clipGate && ri && ri.connected);
          if (mm0.best && ri) { mm0.clockId = ri.clockId; mm0.clockPos = mm0.best.posSec + ri.off; }
        }
        /* база каждой СВЯЗАННОЙ комнаты: медиана(startSec - clockPos) */
        var rawByClock = {};
        for (var m2 = 0; m2 < matched.length; m2++) { var mm2 = matched[m2]; if (!mm2.connected) continue;
          if (!rawByClock[mm2.clockId]) rawByClock[mm2.clockId] = []; rawByClock[mm2.clockId].push(mm2.clip.startSec - mm2.clockPos); }
        var baseByClock = {};
        for (var su in rawByClock) if (rawByClock.hasOwnProperty(su)) baseByClock[su] = med(rawByClock[su]);
        /* позиция клипа внутри его комнаты (нормируем к началу комнаты = 0) */
        var minByClock = {};
        for (var m3 = 0; m3 < matched.length; m3++) { var v3 = matched[m3]; if (!v3.connected) continue;
          v3.roomTarget = (baseByClock[v3.clockId] || 0) + v3.clockPos;
          if (minByClock[v3.clockId] == null || v3.roomTarget < minByClock[v3.clockId]) minByClock[v3.clockId] = v3.roomTarget; }
        /* раскладываем КОМНАТЫ последовательно: комната 0 с 0, следующая — после конца пред. */
        var clockIds = []; for (var ck in minByClock) if (minByClock.hasOwnProperty(ck)) clockIds.push(+ck);
        clockIds.sort(function (a, b) { return a - b; });
        var roomStart = {}, cursor = 0, GAP = 2;
        for (var ci = 0; ci < clockIds.length; ci++) {
          var cid = clockIds[ci]; roomStart[cid] = cursor; var roomEnd = 0;
          for (var m4 = 0; m4 < matched.length; m4++) { var v4 = matched[m4]; if (!v4.connected || v4.clockId != cid) continue;
            var le = (v4.roomTarget - minByClock[cid]) + (v4.clip.endSec - v4.clip.startSec); if (le > roomEnd) roomEnd = le; }
          cursor += roomEnd + GAP;
        }
        /* несвязанные клипы — последовательно В КОНЕЦ, статус 'unsynced' (красный label).
           ВАЖНО: связанные аудио-копии одного физического клипа (напр. P-камера: 1 видео +
           4 аудио-дорожки) — это ОДНА единица, двигаются вместе. Группируем по инстансу
           (mediaPath+inPoint+исходный start), назначаем ОДИН target на группу; иначе каждая
           копия тянула бы связанную группу дальше (был баг: клип уезжал на 20 мин в пустоту). */
        var unsynced = matched.filter(function (m) { return !m.connected; });
        function instKey(m) { return m.clip.mediaPath + '|' + Math.round(m.clip.inPointSec * 100) + '|' + Math.round(m.clip.startSec * 100); }
        var ugroups = {}, uorder = [];
        for (var ug = 0; ug < unsynced.length; ug++) {
          var uk = instKey(unsynced[ug]);
          if (!ugroups[uk]) { ugroups[uk] = { dur: unsynced[ug].clip.endSec - unsynced[ug].clip.startSec, firstStart: unsynced[ug].clip.startSec, members: [] }; uorder.push(uk); }
          ugroups[uk].members.push(unsynced[ug]);
        }
        uorder.sort(function (a, b) { return ugroups[a].firstStart - ugroups[b].firstStart; });
        var ucur = cursor;
        for (var uo = 0; uo < uorder.length; uo++) {
          var grp = ugroups[uorder[uo]];
          for (var gm = 0; gm < grp.members.length; gm++) grp.members[gm].endTarget = ucur;
          ucur += grp.dur + GAP;
        }

        /* UNIT-уровневый якорь: НАДЁЖНОЕ ребро юнита к юниту ДРУГОГО устройства.
           Per-clip cross считается по КУСКУ клипа и на длинных рекордерах бывает слабым
           (Track 1_008: 0.37), тогда как ребро ПОЛНЫХ огибающих — 0.94: трансформу для
           пере-якоривания после device-TC нужна именно связь юнита, иначе рекордер
           остаётся на до-TC координатах (+1500с). НО одиночному ребру доверять нельзя
           (ZOOM Tr1: ложное 0.68 утаскивало трек на -1129с — комнатная логика ему уже
           не доверяла). Правила те же, что при слиянии комнат: берём ребро, только если
           ЕГО ПОЗИЦИЯ подтверждена вторым независимым партнёром (кластер согласных
           implied-позиций) ЛИБО ребро одиночное, но очень сильное (corr≥0.8). */
        var unitBestEdge = {};
        (function () {
          var perUnit = {};
          for (var ue = 0; ue < unitPairs.length; ue++) {
            var eb = unitPairs[ue];
            if (!(eb.corr > 0)) continue;
            var uA = unitMap[eb.a], uB = unitMap[eb.b];
            if (uA.dev === uB.dev) continue; /* якорь только к другому физическому устройству */
            /* edge: start(sml=b) = start(big=a) + offset → старт a внутри b = -offset */
            if (!perUnit[eb.a]) perUnit[eb.a] = [];
            if (!perUnit[eb.b]) perUnit[eb.b] = [];
            perUnit[eb.a].push({ partner: eb.b, corr: eb.corr, startInPartner: -eb.offset, partnerLenSec: uB.maxLen * dt, partnerPath: uB.repPath });
            perUnit[eb.b].push({ partner: eb.a, corr: eb.corr, startInPartner: eb.offset, partnerLenSec: uA.maxLen * dt, partnerPath: uA.repPath });
          }
          var LONE_GATE = 0.8, CLUSTER_TOL = 3.0, LONE_MINLEN = 20.0;
          for (var pu in perUnit) { if (!perUnit.hasOwnProperty(pu)) continue;
            var edges = perUnit[pu], best = null;
            for (var ei0 = 0; ei0 < edges.length; ei0++) {
              var ei = edges[ei0], riP = refInfo[ei.partner]; if (!riP) continue;
              /* implied-старт юнита в координатах комнаты партнёра */
              var impI = riP.off + ei.startInPartner;
              var support = 0, top = ei, seenP = {};
              for (var ej0 = 0; ej0 < edges.length; ej0++) {
                var ej = edges[ej0], rjP = refInfo[ej.partner];
                if (!rjP || rjP.clockId !== riP.clockId) continue;
                if (Math.abs((rjP.off + ej.startInPartner) - impI) >= CLUSTER_TOL) continue;
                if (!seenP[ej.partner]) { seenP[ej.partner] = 1; support++; }
                if (ej.corr > top.corr) top = ej;
              }
              if (support < 2 && top.corr < LONE_GATE) continue;
              /* КОРОТКИЙ партнёр = ложный NCC-пик, утаскивает клип в мусор (кейс 4
                 _017/018/022/002 → 1.2с C027.braw). Короткий референс даёт широкий пик и
                 ложную кластер-поддержку от других коротких клипов того же устройства,
                 поэтому длину проверяем БЕЗУСЛОВНО, а не только для одиночных рёбер. */
              if (!(top.partnerLenSec >= LONE_MINLEN)) continue;
              if (!best || top.corr > best.corr)
                best = { corr: top.corr, startInPartner: top.startInPartner, partnerLenSec: top.partnerLenSec, partnerPath: top.partnerPath };
            }
            if (best) unitBestEdge[pu] = best;
          }
        })();
        var rows = [];
        for (var n = 0; n < matched.length; n++) {
          var x2 = matched[n], c2 = x2.clip;
          var aCorr = (x2.best && unitRoomCorr[x2.best.unitKey] != null) ? unitRoomCorr[x2.best.unitKey] : 0;
          var anc = x2.cross ? { path: x2.cross.partnerPath, offsetSec: x2.cross.posSec, corr: x2.cross.corr, partnerLenSec: x2.cross.partnerLenSec } : null;
          var ube = unitBestEdge[recorderKey(c2.mediaPath)];
          if (ube && (!anc || ube.corr > anc.corr))
            anc = { path: ube.partnerPath, offsetSec: ube.startInPartner + c2.inPointSec, corr: ube.corr, partnerLenSec: ube.partnerLenSec };
          if (x2.connected) {
            var target = roomStart[x2.clockId] + (x2.roomTarget - minByClock[x2.clockId]);
            if (target < 0) target = 0;
            rows.push({ nodeId: c2.nodeId, name: c2.name, trackIndex: c2.trackIndex, mediaPath: c2.mediaPath,
              shiftSec: target - c2.startSec, targetSec: target, confidence: x2.best ? x2.best.corr : 0,
              anchorCorr: aCorr, anchor: anc, component: x2.clockId, slope: 0, status: 'sync' });
          } else {
            rows.push({ nodeId: c2.nodeId, name: c2.name, trackIndex: c2.trackIndex, mediaPath: c2.mediaPath,
              shiftSec: x2.endTarget - c2.startSec, targetSec: x2.endTarget, confidence: x2.best ? x2.best.corr : 0,
              anchorCorr: aCorr, anchor: anc, component: -1, slope: 0, status: 'unsynced' });
          }
        }
        return rows;
      });
    });
  }

  global.SyncRunner = { buildAnchorEnvelope: buildAnchorEnvelope, runSync: runSync, runSourceSync: runSourceSync, runClipSync: runClipSync, uniqueSources: uniqueSources, mapSeries: mapSeries };
})(typeof window !== 'undefined' ? window : this);
