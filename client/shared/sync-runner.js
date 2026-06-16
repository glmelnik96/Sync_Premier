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
        unitPairs.push({ a: bigU.key, b: smlU.key, offset: lr2.posSec, corr: unitCorr(ra, rb) }); /* time[big]=time[sml]+offset */
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
      /* сильные рёбра → прямое транзитивное объединение */
      for (var se = 0; se < edgesByCorr.length; se++) {
        var ed = edgesByCorr[se]; if (ed.corr < strongGate) continue;
        var raR = find(ed.a), rbR = find(ed.b); if (raR === rbR) continue;
        uniteRoots(raR, rbR, ed.offset + offToRoot(ed.a) - offToRoot(ed.b)); /* rootA = rootB + d */
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

      /* 4. каждый клип → лучшая по корреляции единица → позиция в часах её комнаты */
      var clips = (snapshot.clips || []).filter(function (c) { return c.trackType === 'audio' && c.mediaPath; });
      return mapSeries(clips, function (c) {
        return deps.extractEnvelope(c.mediaPath, { startSec: c.inPointSec, durSec: c.endSec - c.startSec, windowMs: coarseMs })
          .then(function (e) {
            var best = null;
            for (var ri = 0; ri < units.length; ri++) {
              var lr = locateUnit(units[ri], e.env);
              if (!best || lr.corr > best.corr) best = { unitKey: units[ri].key, posSec: lr.posSec, corr: lr.corr };
            }
            return { clip: c, best: best };
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
        /* несвязанные клипы — последовательно В КОНЕЦ, статус 'unsynced' (красный label) */
        var unsynced = matched.filter(function (m) { return !m.connected; }).sort(function (a, b) { return a.clip.startSec - b.clip.startSec; });
        var ucur = cursor;
        for (var us = 0; us < unsynced.length; us++) { unsynced[us].endTarget = ucur; ucur += (unsynced[us].clip.endSec - unsynced[us].clip.startSec) + GAP; }

        var rows = [];
        for (var n = 0; n < matched.length; n++) {
          var x2 = matched[n], c2 = x2.clip;
          if (x2.connected) {
            var target = roomStart[x2.clockId] + (x2.roomTarget - minByClock[x2.clockId]);
            if (target < 0) target = 0;
            rows.push({ nodeId: c2.nodeId, name: c2.name, trackIndex: c2.trackIndex, mediaPath: c2.mediaPath,
              shiftSec: target - c2.startSec, targetSec: target, confidence: x2.best ? x2.best.corr : 0,
              component: x2.clockId, slope: 0, status: 'sync' });
          } else {
            rows.push({ nodeId: c2.nodeId, name: c2.name, trackIndex: c2.trackIndex, mediaPath: c2.mediaPath,
              shiftSec: x2.endTarget - c2.startSec, targetSec: x2.endTarget, confidence: x2.best ? x2.best.corr : 0,
              component: -1, slope: 0, status: 'unsynced' });
          }
        }
        return rows;
      });
    });
  }

  global.SyncRunner = { buildAnchorEnvelope: buildAnchorEnvelope, runSync: runSync, runSourceSync: runSourceSync, runClipSync: runClipSync, uniqueSources: uniqueSources, mapSeries: mapSeries };
})(typeof window !== 'undefined' ? window : this);
