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
 *     LIS-фильтр по монотонности offset(tc) (допуск −2с) отсекает ложные пики.
 *  3. УПЛОТНЕНИЕ (итеративно ×4): кандидат в ЖЁСТКОМ монотонном окне офсета от фланговых
 *     пинов [p0.off−5с, p1.off+5с] @ corr≥0.45 → в пины → LIS заново. Левее первого пина
 *     (ведущий блок без соседа слева) — только длинные клипы ≥30с @ corr≥0.5: именно такой
 *     пин находит хвост ведущей TC-цепочки (короткие дают ложный офсет и ломают всю цепочку).
 *  4. ПРЕДИКТ: пин → своя аудио-позиция; левее первого пина → rigid-TC-цепочка, подвешенная
 *     к ПЕРВОМУ пину (off = P[0].off — выведено из данных, совпало с моделью Syncaila);
 *     между пинами → линейная интерполяция offset(tc); правее последнего → его офсет.
 *
 * Позиции клипов camera остаются «не подтверждёнными звуком» в терминах Syncaila →
 * вся камера по-прежнему метится Rose (fcpxml-transform), но раскладка близка к истинной.
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
  var ITER_ROUNDS = 4;
  var LEFT_TH = 0.5;       /* левое расширение: порог */
  var LEFT_MIN_DUR = 30;   /* левое расширение: мин длина клипа, с (критично!) */
  var MIN_PINS = 3;        /* меньше — не трогаем устройство (остаётся rigid-TC) */

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
      out.push({ key: s.key, tc: s.tc, tl: s.tl, off: s.tl - s.tc });
    }
    return out;
  }

  /* глобальный NCC-пик шаблона в сигнале (как sync-runner.locate: pad нулями на M) */
  function locate(SyncCore, sigEnv, tplEnv, dt) {
    var M = tplEnv.length;
    var pad = new Float64Array(sigEnv.length + 2 * M);
    pad.set(sigEnv, M);
    var r = SyncCore.globalNccPeak(pad, tplEnv);
    return { posSec: (r.lag - M) * dt, corr: r.corr };
  }

  /**
   * stretchInfo: result.stretch из applySyncToXml (pass 1):
   *   { frameSec, devices: [{ files: [{key, path, tcStartSec, inSec, durSec}],
   *                           backbones: [{path, srcStartSec, srcDurSec}] }] }
   * io: { extractEnvelope, SyncCore }
   * → Promise<{ targets: {key → targetFrames}, report: строка-сводка }>
   */
  function computeTargets(stretchInfo, io) {
    var FRAME = stretchInfo.frameSec;
    var extract = io.extractEnvelope, SyncCore = io.SyncCore;
    var targets = {}, notes = [];

    function processDevice(dev) {
      /* 1. огибающие бэкбонов (band-pass, полные) */
      var bbs = [];
      var chain = Promise.resolve();
      dev.backbones.forEach(function (b) {
        chain = chain.then(function () {
          return extract(b.path, { windowMs: WINDOW_MS, bandPass: true }).then(function (r) {
            if (r.env.length * r.dtSec >= BB_MIN_SEC)
              bbs.push({ path: b.path, srcStartSec: b.srcStartSec, env: r.env, dt: r.dtSec });
          }, function () { /* бэкбон не читается — пропускаем */ });
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
                    cands.push({ bb: bbs[bi].path, corr: lr.corr, tl: bbs[bi].srcStartSec + lr.posSec });
                  }
                scans.push({ key: f.key, tc: f.tcStartSec, segDur: segDur, cands: cands });
              }, function () {
                scans.push({ key: f.key, tc: f.tcStartSec, segDur: segDur, cands: [] });
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
          var pin = null;
          for (var a = 0; a < strong.length && !pin; a++)
            for (var b = a + 1; b < strong.length; b++)
              if (strong[b].bb !== strong[a].bb && Math.abs(strong[a].tl - strong[b].tl) <= CONS_TOL) {
                pin = (strong[a].tl + strong[b].tl) / 2; break;
              }
          if (pin == null) {
            var best = null;
            for (sj = 0; sj < strong.length; sj++) if (!best || strong[sj].corr > best.corr) best = strong[sj];
            if (best && best.corr >= PIN_SINGLE_TH) pin = best.tl;
          }
          if (pin != null) sel.push({ key: sc.key, tc: sc.tc, tl: pin });
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
            if (bc) added.push({ key: sc2.key, tc: sc2.tc, tl: bc.tl });
          }
          if (!added.length) break;
          pins = runLis(pins.concat(added));
        }
        /* 5. предикт: pin / цепочка от первого пина / warp-интерполяция */
        var tlOf = {}, pk;
        for (pk = 0; pk < pins.length; pk++) tlOf[pins[pk].key] = pins[pk].tl;
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
          if (tlOf.hasOwnProperty(sc3.key)) { tl = tlOf[sc3.key]; nPin++; }
          else if (sc3.tc < pins[0].tc) { tl = sc3.tc + pins[0].off; nChain++; }
          else { tl = sc3.tc + warp(sc3.tc); nWarp++; }
          targets[sc3.key] = Math.round(tl / FRAME);
        }
        notes.push('устройство: пинов ' + pins.length + ' (pin=' + nPin + ' chain=' + nChain + ' warp=' + nWarp + '), бэкбонов ' + bbs.length);
      });
    }

    var all = Promise.resolve();
    stretchInfo.devices.forEach(function (dev) {
      all = all.then(function () { return processDevice(dev); });
    });
    return all.then(function () {
      return { targets: targets, report: notes.join('; ') };
    });
  }

  global.StretchWarp = { computeTargets: computeTargets };
})(typeof window !== 'undefined' ? window : this);
