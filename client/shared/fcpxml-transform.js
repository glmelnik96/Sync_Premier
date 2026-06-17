/**
 * FCP7 XML (xmeml) трансформер для синхронизации — ЧИСТАЯ строковая логика (ES5 IIFE,
 * без Node-зависимостей). Используется и панелью (гибрид), и standalone CLI.
 *
 * Поток: parseXml(xml) → buildSnapshot(clips) → [SyncRunner.runClipSync даёт rows] →
 * applySyncToXml(xml, clips, rows) → выходной XML с двумя секвенциями (_SYNCED + _UNSYNCED).
 *
 * Ключевые уроки (каждый — реальный баг на живом импорте Premiere):
 * - Premiere читает pproTicksIn/Out (тики), ИГНОРИРУЯ <in>/<out> → обновлять оба.
 * - Несвязанные клипы НЕЛЬЗЯ держать в той же секвенции (Premiere обрезает длительность
 *   по концу синхронного контента) → отдельная секвенция _UNSYNCED.
 * - Дубль sequence id → Premiere импортирует одну → уникальный id+суффикс на 2-й.
 */
(function (global) {
  'use strict';

  var SECOND_TICKS = 254016000000; // тиков в секунде (Premiere)

  function decodePathUrl(u) {
    var s = String(u).replace(/^file:\/\/localhost\//, '').replace(/^file:\/\//, '');
    try { s = decodeURIComponent(s); } catch (e) {}
    return s;
  }

  /** timebase/ntsc первой <rate> секвенции → {frameSec, ticksPerFrame}. */
  function deriveRate(xml) {
    var seqHead = xml.slice(0, xml.indexOf('<media>') >= 0 ? xml.indexOf('<media>') : xml.length);
    var tbM = seqHead.match(/<timebase>(\d+)<\/timebase>/);
    var ntscM = seqHead.match(/<ntsc>(TRUE|FALSE)<\/ntsc>/i);
    var tb = tbM ? parseInt(tbM[1], 10) : 24;
    var ntsc = ntscM ? /TRUE/i.test(ntscM[1]) : true;
    var frameSec = ntsc ? (1001 / (tb * 1000)) : (1 / tb);
    return { frameSec: frameSec, ticksPerFrame: Math.round(SECOND_TICKS * frameSec), timebase: tb, ntsc: ntsc };
  }

  /** Парс xmeml → {clips:[{id,start,end,inP,out,path,name,type,fullMatch, tcFrame,tcRateSec,srcDurFrames}]}.
      Timecode (frame/timebase/ntsc/displayformat) и длительность файла — из полного <file>
      блока; для clipitem'ов со ссылкой <file id=".."/> берутся по fileById. */
  function parseXml(xml) {
    var audioRegionStart = xml.indexOf('\n\t\t\t<audio>');
    var fileById = {}, fileTc = {}, fileDur = {}, fm;
    var fileRe = /<file id="([^"]+)"\s*>([\s\S]*?)<\/file>/g;
    while ((fm = fileRe.exec(xml))) {
      var fid0 = fm[1], fbody = fm[2];
      var pm = fbody.match(/<pathurl>([\s\S]*?)<\/pathurl>/);
      if (pm) fileById[fid0] = decodePathUrl(pm[1]);
      var dm = fbody.match(/<duration>(\d+)<\/duration>/);
      if (dm) fileDur[fid0] = parseInt(dm[1], 10);
      var tcm = fbody.match(/<timecode>([\s\S]*?)<\/timecode>/);
      if (tcm) {
        var tb = tcm[1].match(/<timebase>(\d+)<\/timebase>/);
        var fr = tcm[1].match(/<frame>(\d+)<\/frame>/);
        var nt = /<ntsc>TRUE<\/ntsc>/i.test(tcm[1]);
        if (tb && fr) {
          var tbN = parseInt(tb[1], 10);
          fileTc[fid0] = { frame: parseInt(fr[1], 10), realFps: nt ? (tbN * 1000 / 1001) : tbN };
        }
      }
    }
    /* границы sequence-level <track> (для определения исходной дорожки = устройства/камеры:
       карты импортируют файлы одной камеры на одну дорожку). Глобальный сквозной индекс. */
    var trackBounds = []; var trRe = /<track\b[^>]*>/g, trm, tIdxScan = 0;
    while ((trm = trRe.exec(xml))) { trackBounds.push({ pos: trm.index, idx: tIdxScan++ }); }
    function trackAt(off) { var t = -1; for (var i = 0; i < trackBounds.length; i++) { if (trackBounds[i].pos < off) t = trackBounds[i].idx; else break; } return t; }

    var clips = [], cm;
    var ciRe = /<clipitem id="([^"]+)"[^>]*>([\s\S]*?)<\/clipitem>/g;
    while ((cm = ciRe.exec(xml))) {
      var body = cm[2], offset = cm.index;
      var num = function (re) { var x = body.match(re); return x ? parseInt(x[1], 10) : null; };
      var fidM = body.match(/<file id="([^"]+)"/);
      var fid = fidM ? fidM[1] : null;
      var nameM = body.match(/<name>([\s\S]*?)<\/name>/);
      var tc = fid ? fileTc[fid] : null;
      clips.push({
        id: cm[1], start: num(/<start>(-?\d+)<\/start>/), end: num(/<end>(-?\d+)<\/end>/),
        inP: num(/<in>(-?\d+)<\/in>/), out: num(/<out>(-?\d+)<\/out>/),
        fid: fid, path: fid ? fileById[fid] : null,
        name: nameM ? nameM[1] : cm[1], type: offset < audioRegionStart ? 'video' : 'audio',
        trackId: trackAt(offset),
        tcStartSec: tc ? (tc.frame / tc.realFps) : null,
        srcDurSec: (fid && fileDur[fid] && tc) ? (fileDur[fid] / tc.realFps) : null,
        fullMatch: cm[0]
      });
    }
    return { clips: clips };
  }

  /** clips + frameSec → snapshot для SyncRunner.runClipSync (кадры → секунды). */
  function buildSnapshot(clips, frameSec) {
    return { clips: clips.map(function (c) {
      return { nodeId: c.id, name: c.name, trackType: c.type, mediaPath: c.path, trackIndex: 0,
        startSec: c.start * frameSec, endSec: c.end * frameSec, inPointSec: c.inP * frameSec };
    }) };
  }


  /**
   * Применить результаты синхронизации (rows из runClipSync) к XML.
   * rows: [{nodeId, targetSec, status('sync'|'unsynced'|...), component}]
   * → выходной xmeml с _SYNCED и (если есть несвязанные) _UNSYNCED.
   */
  function applySyncToXml(xml, clips, rows, opt) {
    opt = opt || {};
    var rate = deriveRate(xml);
    var FRAME = opt.frameSec || rate.frameSec;
    var TPF = opt.ticksPerFrame || rate.ticksPerFrame;
    var origName = opt.baseName || (xml.match(/<name>([^<]*)<\/name>/) || [])[1] || 'sync';

    /* МОДЕЛЬ Syncaila: НИКАКОЙ обрезки клипов. Каждый клип ставится на свою синхро-позицию
       в ПОЛНУЮ длину (in/out источника НЕ трогаем). Всё в ОДНОЙ непрерывной секвенции.
       Несвязанные клипы — вплотную в конец (без зазора → Premiere не обрезает воспр.),
       помечены красным. Прошлые «улучшения» (обрезка lone-аудио, 2 секвенции, drop) были
       причиной невалидного вывода: клипы пропадали и резались неправильно. */
    var planByKey = {}, clipById = {};
    for (var i = 0; i < clips.length; i++) clipById[clips[i].id] = clips[i];
    function keyOf(path, sf) { return path + '|' + sf; }
    for (var r = 0; r < rows.length; r++) {
      var c0 = clipById[rows[r].nodeId]; if (!c0) continue;
      planByKey[keyOf(c0.path, c0.start)] = {
        targetFrames: Math.round(rows[r].targetSec / FRAME),
        status: rows[r].status, comp: rows[r].component,
        conf: rows[r].confidence || 0, anchorCorr: rows[r].anchorCorr || 0
      };
    }

    /* ── РАЗМЕЩЕНИЕ ФАЙЛОВ УСТРОЙСТВА ПО TIMECODE (модель Syncaila) ──────────────────
       Камера, разбитая на МНОГО файлов (A065: 49 файлов; P-серия), импортируется на ОДНУ
       дорожку — это одно устройство с ОБЩИМ клоком. Если синхронизировать каждый файл
       НЕЗАВИСИМО по звуку, мелкие ошибки дают НАЛОЖЕНИЯ на дорожке → Premiere выкидывает
       перекрытые клипы (клипы «пропадают»). Решение: всё устройство привязывается к миру
       ОДНИМ файлом с САМОЙ СИЛЬНОЙ реальной корреляцией к комнате (anchorCorr — НЕ self-match),
       остальные файлы ставятся по дельте timecode относительно него. timecode'ы файлов не
       пересекаются → наложений нет. Так делает Syncaila. */
    var devByKey = {}; /* planKey → {tcStart, trackId, durFrames} (видео-дорожка приоритетна) */
    for (var sa = 0; sa < clips.length; sa++) {
      var sc = clips[sa]; if (sc.tcStartSec == null) continue;
      var sk = keyOf(sc.path, sc.start); if (!planByKey[sk]) continue;
      if (!devByKey[sk]) devByKey[sk] = { tcStart: sc.tcStartSec, trackId: sc.trackId, durFrames: sc.end - sc.start };
      else if (sc.type === 'video') devByKey[sk].trackId = sc.trackId; /* предпочесть видео-дорожку */
    }
    var devGroups = {}; /* trackId → [{key, tcStart, durFrames, plan}] */
    for (var dk in devByKey) if (devByKey.hasOwnProperty(dk)) {
      var d = devByKey[dk], tid = d.trackId;
      if (!devGroups[tid]) devGroups[tid] = [];
      devGroups[tid].push({ key: dk, tcStart: d.tcStart, durFrames: d.durFrames, plan: planByKey[dk] });
    }
    /* УСТРОЙСТВО = ЖЁСТКАЯ TIMECODE-ШКАЛА (модель Syncaila). Все файлы камеры — на ОДНОМ
       клоке: их взаимное положение задаётся ТОЛЬКО timecode (сохраняет РЕАЛЬНЫЕ паузы между
       записями — камера снимала 107 мин с паузами!). К миру устройство привязывается ОДНИМ
       якорем: файлом с МАКС реальной корреляцией к комнате (anchorCorr). Аудио-позиции
       отдельных файлов НЕ используем (короткий файл неоднозначно коррелирует с длинным
       рекордером → кластеризация и схлопывание пауз — была причина «таймлайн поломан»). */
    var rescued = 0;
    for (var tg in devGroups) if (devGroups.hasOwnProperty(tg)) {
      var files = devGroups[tg]; if (files.length < 2) continue; /* одиночный файл — оставляем аудио */
      /* якорь = файл с макс anchorCorr (реальная связь с комнатой, не self-match) */
      var anchor = null;
      for (var fi = 0; fi < files.length; fi++) {
        var fp = files[fi]; if (fp.plan.status === 'unsynced') continue;
        if (!anchor || (fp.plan.anchorCorr || 0) > (anchor.plan.anchorCorr || 0)) anchor = fp;
      }
      if (!anchor) continue; /* нет надёжного аудио-якоря — оставляем как есть */
      for (var pj = 0; pj < files.length; pj++) {
        var m = files[pj];
        /* позиция = позиция якоря + дельта timecode (жёсткая шкала устройства) */
        m.plan.targetFrames = anchor.plan.targetFrames + Math.round((m.tcStart - anchor.tcStart) / FRAME);
        if (m.plan.status === 'unsynced') rescued++;
        m.plan.status = 'sync';
        m.plan.comp = anchor.plan.comp;
      }
    }

    // план каждого clipitem: позиция = targetFrames; in/out = ОРИГИНАЛ (полная длина).
    for (var a = 0; a < clips.length; a++) {
      var c = clips[a], p = planByKey[keyOf(c.path, c.start)];
      if (!p) { c.plan = null; continue; }
      var dur = c.end - c.start;
      c.plan = { start: p.targetFrames, end: p.targetFrames + dur, status: p.status, comp: p.comp };
    }

    /* ── ПОСЛЕДОВАТЕЛЬНОСТЬ СЪЁМКИ ПО TIMECODE (модель Syncaila) ────────────────────
       Комнаты (компоненты аудио-синхро) не связаны звуком между собой, поэтому их
       хронологический порядок берём из TIMECODE. Якорь комнаты = её самый длинный
       источник (обычно рекордер с надёжным сквозным TC). «Реальное время начала
       комнаты» = tcStart(якорь) − (позиция якоря внутри комнаты). Комнаты раскладываются
       в порядке этого времени, ВПЛОТНУЮ (back-to-back, как Syncaila). Обобщается на любой
       источник с timecode; комнаты без TC сохраняют исходный относительный порядок. */
    var rooms = {}; /* comp → {clips:[], minStart} */
    for (var e = 0; e < clips.length; e++) {
      var ce = clips[e]; if (!ce.plan || ce.plan.status === 'unsynced') continue;
      var cmp = ce.plan.comp;
      if (!rooms[cmp]) rooms[cmp] = { comp: cmp, clips: [], minStart: ce.plan.start };
      rooms[cmp].clips.push(ce);
      if (ce.plan.start < rooms[cmp].minStart) rooms[cmp].minStart = ce.plan.start;
    }
    var roomList = [];
    for (var rc in rooms) if (rooms.hasOwnProperty(rc)) {
      var rm = rooms[rc], anchor = null;
      for (var ai = 0; ai < rm.clips.length; ai++) {
        var cl = rm.clips[ai];
        if (cl.tcStartSec == null) continue;
        if (!anchor || (cl.srcDurSec || 0) > (anchor.srcDurSec || 0)) anchor = cl;
      }
      rm.impliedSec = anchor ? (anchor.tcStartSec - (anchor.plan.start - rm.minStart) * FRAME) : null;
      roomList.push(rm);
    }
    /* комнаты с TC — по impliedSec; без TC — после, в исходном относительном порядке */
    var BIG = 1e12;
    roomList.sort(function (a, b) {
      var ka = (a.impliedSec == null) ? (BIG + a.minStart) : a.impliedSec;
      var kb = (b.impliedSec == null) ? (BIG + b.minStart) : b.impliedSec;
      return ka - kb;
    });
    /* разложить последовательно back-to-back, сохраняя внутрикомнатные позиции */
    var cursor = 0, syncedEndF = 0;
    for (var ri = 0; ri < roomList.length; ri++) {
      var room = roomList[ri], off = cursor - room.minStart, roomEnd = 0;
      for (var rj = 0; rj < room.clips.length; rj++) {
        var rcl = room.clips[rj];
        rcl.plan.start += off; rcl.plan.end += off;
        if (rcl.plan.end > roomEnd) roomEnd = rcl.plan.end;
      }
      cursor = roomEnd;
    }
    syncedEndF = cursor;

    // несвязанные → ВПЛОТНУЮ в конец (без зазора), сохраняя взаимное расположение групп
    var umin = null;
    for (var g = 0; g < clips.length; g++) { var cg = clips[g]; if (cg.plan && cg.plan.status === 'unsynced') { if (umin === null || cg.plan.start < umin) umin = cg.plan.start; } }
    var unsyncedShift = (umin === null) ? 0 : (syncedEndF - umin);
    for (var h = 0; h < clips.length; h++) { var ch = clips[h]; if (ch.plan && ch.plan.status === 'unsynced') { ch.plan.start += unsyncedShift; ch.plan.end += unsyncedShift; } }

    // собрать ОДНУ секвенцию
    var synced = 0, unsynced = 0, endF = 0;
    function renderClip(c) {
      if (!c.plan) return '';
      var s = c.plan.start < 0 ? 0 : c.plan.start;
      var en = c.plan.end - (c.plan.start < 0 ? c.plan.start : 0);
      var block = c.fullMatch
        .replace(/<start>-?\d+<\/start>/, '<start>' + s + '</start>')
        .replace(/<end>-?\d+<\/end>/, '<end>' + en + '</end>');
      if (c.plan.status === 'unsynced') {
        block = block.replace(/<labels>[\s\S]*?<\/labels>/, '<labels>\n\t\t\t\t\t\t<label2>Rose</label2>\n\t\t\t\t\t</labels>');
        unsynced++;
      } else synced++;
      if (en > endF) endF = en;
      return block;
    }

    var seqM = xml.match(/<sequence\b[\s\S]*?<\/sequence>/);
    if (!seqM) throw new Error('<sequence> не найден');
    var seqTemplate = seqM[0];
    var xmlHead = xml.slice(0, seqM.index);
    var xmlTail = xml.slice(seqM.index + seqTemplate.length);

    var blk = seqTemplate;
    for (var b2 = 0; b2 < clips.length; b2++) { var rep = renderClip(clips[b2]); if (rep !== clips[b2].fullMatch) blk = blk.replace(clips[b2].fullMatch, rep); }
    blk = blk.replace(/<name>([^<]*)<\/name>/, function (m, n) { return '<name>' + n + '_SYNCED</name>'; });
    var endTicks = endF * TPF;
    blk = blk.replace(/(<sequence\b[^>]*?)>/, function (full, hh) {
      hh = hh.replace(/MZ\.EditLine="[0-9]+"/, 'MZ.EditLine="0"');
      hh = hh.replace(/MZ\.WorkInPoint="[0-9]+"/, 'MZ.WorkInPoint="0"');
      hh = hh.replace(/MZ\.WorkOutPoint="[0-9]+"/, 'MZ.WorkOutPoint="' + endTicks + '"');
      hh = hh.replace(/Monitor\.ProgramZoomOut="[0-9]+"/, 'Monitor.ProgramZoomOut="' + endTicks + '"');
      hh = hh.replace(/Monitor\.ProgramZoomIn="[0-9]+"/, 'Monitor.ProgramZoomIn="0"');
      return hh + '>';
    });
    blk = blk.replace(/(<\/uuid>\s*<duration>)\d+(<\/duration>)/, '$1' + endF + '$2');

    var out = xmlHead + blk + xmlTail;
    return { xml: out, stats: { synced: synced, unsynced: unsynced, tcRescued: rescued,
      syncedEndSec: Math.round(syncedEndF * FRAME), unsyncedEndSec: Math.round(endF * FRAME),
      trimmedHeadSec: 0, trimmedTailSec: 0, dropped: 0, hasUnsynced: unsynced > 0 } };
  }

  global.FcpXmlTransform = {
    SECOND_TICKS: SECOND_TICKS,
    deriveRate: deriveRate, parseXml: parseXml, buildSnapshot: buildSnapshot, applySyncToXml: applySyncToXml
  };
})(typeof window !== 'undefined' ? window : this);
