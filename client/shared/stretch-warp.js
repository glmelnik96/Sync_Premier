/**
 * Ф3.1: warp-раскладка «растянутой» камеры (кейс 5: P-камера, record-run TC).
 *
 * Контекст. Rigid-TC-блок валиден, только если TC камеры event-линеен. У stretch-камеры
 * (детект в fcpxml-transform: posSpan/tcSpan > 1.5) реальное событие растянуто относительно
 * TC (record-run: паузы невидимы в таймкоде) → offset(tc) = монотонная ступенчатая функция
 * с неизвестными скачками. Один якорь на всё устройство даёт сотни битых клипов.
 *
 * Метод (валидирован офлайн на кейсе 5: 339 → 65 битых из 355):
 *  1. СКАН: каждый клип камеры (шаблон [in, in+120с], band-pass 150–4000 Гц — давит
 *     ветер/гул накамерного микрофона) против каждого бэкбона (кросс-девайс источник
 *     ≥90с той же комнаты) → глобальный NCC-пик {corr, tl}.
 *  2. ПИНЫ: консенсус двух бэкбонов (±2с, corr≥0.60, клип≥5с) или одиночный corr≥0.70;
 *     clarity-гейт (резкость пика: corr − второй NCC-пик вне ±2с, порог 0.15) отсекает
 *     «мутные» пики коррелированной среды; LIS-фильтр по монотонности offset(tc)
 *     (допуск −2с) отсекает ложные пики.
 *  3. УПЛОТНЕНИЕ (итеративно ×4): кандидат в ЖЁСТКОМ монотонном окне офсета от фланговых
 *     пинов [p0.off−5с, p1.off+5с] @ corr≥0.45 → в пины → LIS заново. Левее первого пина
 *     (ведущий блок без соседа слева) — только длинные клипы ≥30с @ corr≥0.5: именно такой
 *     пин находит хвост ведущей TC-цепочки (короткие дают ложный офсет и ломают всю цепочку).
 *  4. ПРЕДИКТ: пин → своя аудио-позиция; левее первого пина → rigid-TC-цепочка, подвешенная
 *     к ПЕРВОМУ пину (off = P[0].off — выведено из данных, совпало с моделью Syncaila);
 *     между пинами → линейная интерполяция offset(tc); правее последнего → его офсет.
 *
 * Rose-семантика (модель Syncaila: Rose = не подтверждено звуком). Снимаем Rose
 * (pinned→opt.stretchPinned) со ВСЕХ базовых пинов после clarity-гейта и с левого
 * расширения: с гейтом 0/31 промахов на кейсе 5 (без него консенсус промахивался 3/22 —
 * коррелированная среда даёт согласный ложный пик даже на разных устройствах, но такие
 * пики «мутные»: clar ≤ 0.124). Пины уплотнения @0.45 (11/55 мимо, clarity их не
 * различает) остаются Rose, как и chain/warp-интерполированные — монтажёр знает, где проверять.
 *
 * ES5 IIFE, без Node-зависимостей в топ-уровне (ffmpeg — через переданный extractEnvelope).
 */
(function (global) {
  'use strict';

  var SEG_MAX_SEC = 120;   /* шаблон клипа: [in, in+min(dur,120с)] */
  var WINDOW_MS = 20;      /* огибающая скана (как coarse в sync-runner) */
  var BB_MIN_SEC = 90;     /* минимальная длина бэкбона */
  var PIN_CONS_TH = 0.60;  /* порог консенсусного пина */
  var PIN_SINGLE_TH = 0.70;/* порог одиночного пина */
  var PIN_MIN_DUR = 5;     /* минимальная длина клипа для базового пина, с */
  var CONS_TOL = 2;        /* согласие двух бэкбонов, с */
  var LIS_TOL = 2;         /* допуск немонотонности офсета, с */
  var ITER_TH = 0.45;      /* порог кандидата в монотонном окне */
  var ITER_TOLW = 5;       /* полуширина окна офсета от фланговых пинов, с */
  var FLUX_TH = 0.2;       /* ЭКСП: мин. flux-corr одиночного пика в монотонном окне */
  var ITER_ROUNDS = 4;
  var LEFT_TH = 0.5;       /* левое расширение: порог */
  var LEFT_MIN_DUR = 30;   /* левое расширение: мин длина клипа, с (критично!) */
  var MIN_PINS = 3;        /* меньше — не трогаем устройство (остаётся rigid-TC) */
  var CLAR_TH = 0.15;      /* clarity-гейт базового пина: corr − второй пик вне ±2с.
                              Эмпирика кейса 5 (12 ложных пинов): у ложных clar ≤ 0.124
                              при corr до 0.78 (среда коррелирует), у верных медиана
                              0.25 — резкость различает то, что corr не различает.
                              Порог с запасом. Мутный пик НЕ базовый пин (и не одиночный —
                              фолбэка нет), но остаётся кандидатом уплотнения, где его
                              ограничивает монотонное окно фланговых резких пинов. */

  /* LIS по неубыванию офсета (tl−tc) в порядке tc; возвращает отфильтрованные пины */
  function runLis(sel) {
    if (!sel.length) return [];
    sel.sort(function (a, b) { return a.tc - b.tc; });
    var n = sel.length, off = [], len = [], prev = [], i, j;
    for (i = 0; i < n; i++) { off.push(sel[i].tl - sel[i].tc); len.push(1); prev.push(-1); }
    for (i = 0; i < n; i++)
      for (j = 0; j < i; j++)
        if (off[i] >= off[j] - LIS_TOL && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    var bi = 0;
    for (i = 1; i < n; i++) if (len[i] > len[bi]) bi = i;
    var keep = [];
    for (i = bi; i >= 0; i = prev[i]) { keep.push(i); if (prev[i] === -1) break; }
    keep.reverse();
    var out = [];
    for (i = 0; i < keep.length; i++) {
      var s = sel[keep[i]];
      out.push({ key: s.key, tc: s.tc, tl: s.tl, off: s.tl - s.tc, trusted: s.trusted });
    }
    return out;
  }

  /* токен устройства по имени файла (как в fcpxml-transform): ZOOM0009_Tr1 → ZOOM0009.
     Консенсус требует РАЗНЫХ устройств: дорожки одного рекордера — почти дубликаты
     сигнала, их «согласие» не независимо. (Ложные консенсусы кейса 5 это НЕ убрало —
     среда коррелирует пики и между устройствами — но требование строго корректнее.) */
  function devTok(path) {
    var b = String(path).split(/[\/\\]/).pop().replace(/\.[^.]*$/, '');
    var i = b.indexOf('_');
    return i > 0 ? b.slice(0, i) : b;
  }

  /* глобальный NCC-пик шаблона в сигнале (как sync-runner.locate: pad нулями на M) */
  function locate(SyncCore, sigEnv, tplEnv, dt) {
    var M = tplEnv.length;
    var pad = new Float64Array(sigEnv.length + 2 * M);
    pad.set(sigEnv, M);
    /* exclLag ±2с → corr2 (второй пик) для clarity: резкость = corr − corr2 */
    var r = SyncCore.globalNccPeak(pad, tplEnv, { exclLag: Math.max(1, Math.round(2 / dt)) });
    return { posSec: (r.lag - M) * dt, corr: r.corr, clar: r.corr - r.corr2 };
  }

  /**
   * stretchInfo: result.stretch из applySyncToXml (pass 1):
   *   { frameSec, devices: [{ files: [{key, path, tcStartSec, inSec, durSec}],
   *                           backbones: [{path, srcStartSec, srcDurSec}] }] }
   * io: { extractEnvelope, SyncCore }
   * → Promise<{ targets: {key → targetFrames}, pinned: {key → 1 для ДОВЕРЕННЫХ пинов
   *   (подтверждены звуком → без Rose)}, report: строка-сводка }>
   */
  function computeTargets(stretchInfo, io) {
    var FRAME = stretchInfo.frameSec;
    var extract = io.extractEnvelope, SyncCore = io.SyncCore;
    var targets = {}, pinned = {}, notes = [];

    var extract2 = io.extractEnvelope2 || null; /* ЭКСП: вторая фича (onset-flux) */
    function processDevice(dev) {
      /* 1. огибающие бэкбонов (band-pass, полные) */
      var bbs = [], bbs2 = [];
      var chain = Promise.resolve();
      dev.backbones.forEach(function (b) {
        chain = chain.then(function () {
          return extract(b.path, { windowMs: WINDOW_MS, bandPass: true }).then(function (r) {
            if (r.env.length * r.dtSec >= BB_MIN_SEC)
              bbs.push({ path: b.path, srcStartSec: b.srcStartSec, env: r.env, dt: r.dtSec });
          }, function () { /* бэкбон не читается — пропускаем */ });
        });
        if (extract2) chain = chain.then(function () {
          return extract2(b.path, { windowMs: WINDOW_MS }).then(function (r) {
            if (r.env.length * r.dtSec >= BB_MIN_SEC)
              bbs2.push({ path: b.path, srcStartSec: b.srcStartSec, env: r.env, dt: r.dtSec });
          }, function () {});
        });
      });
      /* 2. скан клипов: глобальный пик по каждому бэкбону */
      var scans = []; /* {key, tc, segDur, cands:[{bb, corr, tl}]} */
      chain = chain.then(function () {
        var c2 = Promise.resolve();
        dev.files.forEach(function (f) {
          c2 = c2.then(function () {
            var segDur = Math.min(f.durSec, SEG_MAX_SEC);
            if (!(segDur >= 0.5) || !bbs.length) {
              scans.push({ key: f.key, tc: f.tcStartSec, segDur: segDur || 0, cands: [] });
              return;
            }
            return extract(f.path, { startSec: f.inSec, durSec: segDur, windowMs: WINDOW_MS, bandPass: true })
              .then(function (t) {
                var cands = [];
                if (t.env.length >= 25) /* <0.5с шаблона — судить не о чем */
                  for (var bi = 0; bi < bbs.length; bi++) {
                    var lr = locate(SyncCore, bbs[bi].env, t.env, t.dtSec);
                    cands.push({ bb: bbs[bi].path, corr: lr.corr, clar: lr.clar, tl: bbs[bi].srcStartSec + lr.posSec });
                  }
                var rec = { key: f.key, tc: f.tcStartSec, segDur: segDur, cands: cands, cands2: [] };
                scans.push(rec);
                if (!extract2) return;
                /* ЭКСП flux-скан: те же шаблонные границы, вторая фича */
                return extract2(f.path, { startSec: f.inSec, durSec: segDur, windowMs: WINDOW_MS })
                  .then(function (t2) {
                    if (t2.env.length >= 25)
                      for (var b2 = 0; b2 < bbs2.length; b2++) {
                        var lr2 = locate(SyncCore, bbs2[b2].env, t2.env, t2.dtSec);
                        rec.cands2.push({ bb: bbs2[b2].path, corr: lr2.corr, clar: lr2.clar, tl: bbs2[b2].srcStartSec + lr2.posSec });
                      }
                  }, function () {});
              }, function () {
                scans.push({ key: f.key, tc: f.tcStartSec, segDur: segDur, cands: [], cands2: [] });
              });
          });
        });
        return c2;
      });
      return chain.then(function () {
        /* 3. базовые пины: консенсус 2 бэкбонов ±2с @≥0.60 или одиночный @≥0.70 */
        var sel = [], si, sj;
        for (si = 0; si < scans.length; si++) {
          var sc = scans[si];
          if (sc.segDur < PIN_MIN_DUR || sc.tc == null) continue;
          var strong = [];
          for (sj = 0; sj < sc.cands.length; sj++) if (sc.cands[sj].corr >= PIN_CONS_TH) strong.push(sc.cands[sj]);
          var pin = null, dClar = 0;
          for (var a = 0; a < strong.length && !pin; a++)
            for (var b = a + 1; b < strong.length; b++)
              if (devTok(strong[b].bb) !== devTok(strong[a].bb) && Math.abs(strong[a].tl - strong[b].tl) <= CONS_TOL) {
                pin = (strong[a].tl + strong[b].tl) / 2;
                dClar = Math.min(strong[a].clar, strong[b].clar);
                break;
              }
          if (pin == null) {
            var best = null;
            for (sj = 0; sj < strong.length; sj++) if (!best || strong[sj].corr > best.corr) best = strong[sj];
            if (best && best.corr >= PIN_SINGLE_TH) { pin = best.tl; dClar = best.clar; }
          }
          /* clarity-гейт: мутный пик (clar < CLAR_TH) не берём в базу — вернётся через
             уплотнение, если согласован с окном соседей. Для консенсуса clar = min пары.
             trusted (снятие Rose) = ВСЕ базовые пины после clarity-гейта: до гейта консенсус
             промахивался (3/22, corr до 0.78 — среда коррелирует согласный ложный пик),
             с гейтом ложные ушли (их clar ≤ 0.124): 0/31 мимо на кейсе 5. */
          if (pin != null && dClar >= CLAR_TH) sel.push({ key: sc.key, tc: sc.tc, tl: pin, trusted: 1 });
        }
        var pins = runLis(sel);
        if (pins.length < MIN_PINS) {
          notes.push('устройство: пинов ' + pins.length + ' < ' + MIN_PINS + ' — rigid-TC без warp');
          return;
        }
        /* 4. итеративное уплотнение с жёстким монотонным окном + левое расширение */
        for (var round = 1; round <= ITER_ROUNDS; round++) {
          var have = {}, pi;
          for (pi = 0; pi < pins.length; pi++) have[pins[pi].key] = 1;
          var added = [];
          for (si = 0; si < scans.length; si++) {
            var sc2 = scans[si];
            if (have[sc2.key] || sc2.tc == null || !sc2.cands.length) continue;
            var p0 = null, p1 = null;
            for (pi = 0; pi < pins.length; pi++) {
              if (pins[pi].tc <= sc2.tc) p0 = pins[pi]; else { p1 = pins[pi]; break; }
            }
            if (!p1) continue; /* правее последнего пина — flat-warp, кандидатов не берём */
            var lo, th;
            if (p0) { lo = p0.off - ITER_TOLW; th = ITER_TH; }
            else { /* ведущий блок: только длинный клип с уверенным пиком. Нижней границы
                      нет: NCC-кандидат физически лежит внутри огибающей бэкбона, т.е.
                      tl ≥ старт самого левого бэкбона − длина шаблона — «в никуда» слева
                      пик уйти не может (офлайн-граница tl≥0 никогда не срабатывала). */
              if (sc2.segDur < LEFT_MIN_DUR) continue;
              lo = -Infinity; th = LEFT_TH;
            }
            var hi = p1.off + ITER_TOLW, bc = null;
            for (sj = 0; sj < sc2.cands.length; sj++) {
              var cd = sc2.cands[sj], o = cd.tl - sc2.tc;
              if (o < lo || o > hi || cd.corr < th) continue;
              if (!bc || cd.corr > bc.corr) bc = cd;
            }
            /* trusted: левое расширение (0.5/≥30с) — 0 промахов; уплотнение @0.45 — 11/55 мимо */
            if (bc) added.push({ key: sc2.key, tc: sc2.tc, tl: bc.tl, trusted: p0 ? 0 : 1 });
          }
          if (!added.length) break;
          pins = runLis(pins.concat(added));
        }
        /* ЭКСП 4b. flux-консенсус для беспиновых файлов: два КРОСС-девайс бэкбона согласны
           ±CONS_TOL по второй фиче (onset-flux) → пин. trusted:0 (Rose остаётся). LIS защищает
           монотонность. Стенд зоны 065–077: RMS 0/26 попаданий, flux 12/26. */
        if (extract2) {
          var haveF = {}, fi2, addedF = [];
          for (fi2 = 0; fi2 < pins.length; fi2++) haveF[pins[fi2].key] = 1;
          for (si = 0; si < scans.length; si++) {
            var sf = scans[si];
            if (haveF[sf.key] || sf.tc == null || !sf.cands2 || sf.cands2.length < 2) continue;
            var pinF = null;
            for (var fa = 0; fa < sf.cands2.length && pinF == null; fa++)
              for (var fb = fa + 1; fb < sf.cands2.length; fb++)
                if (devTok(sf.cands2[fb].bb) !== devTok(sf.cands2[fa].bb) &&
                    Math.abs(sf.cands2[fa].tl - sf.cands2[fb].tl) <= CONS_TOL) {
                  pinF = (sf.cands2[fa].tl + sf.cands2[fb].tl) / 2;
                  break;
                }
            if (pinF == null && !io.fluxNoFallback) {
              /* fallback: одиночный flux-пик в МОНОТОННОМ окне фланговых пинов
                 (off(tc) монотонен → истина обязана лежать между off соседей ±TOLW) */
              var pf0 = null, pf1 = null, pw;
              for (pw = 0; pw < pins.length; pw++) {
                if (pins[pw].tc <= sf.tc) pf0 = pins[pw]; else { pf1 = pins[pw]; break; }
              }
              if (pf0 && pf1) {
                var wlo = pf0.off - ITER_TOLW, whi = pf1.off + ITER_TOLW, bcf = null;
                for (var fc = 0; fc < sf.cands2.length; fc++) {
                  var cf = sf.cands2[fc], of2 = cf.tl - sf.tc;
                  if (of2 < wlo || of2 > whi || cf.corr < FLUX_TH) continue;
                  if (!bcf || cf.corr > bcf.corr) bcf = cf;
                }
                if (bcf) pinF = bcf.tl;
              }
            }
            if (pinF != null) addedF.push({ key: sf.key, tc: sf.tc, tl: pinF, trusted: 0 });
          }
          if (addedF.length) pins = runLis(pins.concat(addedF));
          notes.push('flux-пинов: кандидатов ' + addedF.length);
        }
        /* 5. предикт: pin / цепочка от первого пина / warp-интерполяция */
        var tlOf = {}, trustOf = {}, pk;
        for (pk = 0; pk < pins.length; pk++) {
          tlOf[pins[pk].key] = pins[pk].tl; trustOf[pins[pk].key] = pins[pk].trusted;
        }
        var warp = function (tc) {
          if (tc <= pins[0].tc) return pins[0].off;
          if (tc >= pins[pins.length - 1].tc) return pins[pins.length - 1].off;
          for (var w = 1; w < pins.length; w++) if (tc <= pins[w].tc) {
            var pa = pins[w - 1], pb = pins[w], t = (tc - pa.tc) / (pb.tc - pa.tc || 1);
            return pa.off + t * (pb.off - pa.off);
          }
          return pins[pins.length - 1].off;
        };
        var nPin = 0, nChain = 0, nWarp = 0;
        for (si = 0; si < scans.length; si++) {
          var sc3 = scans[si];
          if (sc3.tc == null) continue;
          var tl;
          if (tlOf.hasOwnProperty(sc3.key)) { tl = tlOf[sc3.key]; if (trustOf[sc3.key]) pinned[sc3.key] = 1; nPin++; }
          else if (sc3.tc < pins[0].tc) { tl = sc3.tc + pins[0].off; nChain++; }
          else { tl = sc3.tc + warp(sc3.tc); nWarp++; }
          targets[sc3.key] = Math.round(tl / FRAME);
        }
        var nTrust = 0;
        for (pk = 0; pk < pins.length; pk++) if (pins[pk].trusted) nTrust++;
        notes.push('устройство: пинов ' + pins.length + ' (pin=' + nPin + ' chain=' + nChain + ' warp=' + nWarp + ', доверенных ' + nTrust + '), бэкбонов ' + bbs.length);
      });
    }

    var all = Promise.resolve();
    stretchInfo.devices.forEach(function (dev) {
      all = all.then(function () { return processDevice(dev); });
    });
    return all.then(function () {
      return { targets: targets, pinned: pinned, report: notes.join('; ') };
    });
  }

  global.StretchWarp = { computeTargets: computeTargets };
})(typeof window !== 'undefined' ? window : this);
