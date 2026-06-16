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

  /** Парс xmeml → {clips:[{id,start,end,inP,out,path,name,type,fullMatch}]}. */
  function parseXml(xml) {
    var audioRegionStart = xml.indexOf('\n\t\t\t<audio>');
    var fileById = {}, fm;
    var fileRe = /<file id="([^"]+)"\s*>([\s\S]*?)<\/file>/g;
    while ((fm = fileRe.exec(xml))) {
      var pm = fm[2].match(/<pathurl>([\s\S]*?)<\/pathurl>/);
      if (pm) fileById[fm[1]] = decodePathUrl(pm[1]);
    }
    var clips = [], cm;
    var ciRe = /<clipitem id="([^"]+)"[^>]*>([\s\S]*?)<\/clipitem>/g;
    while ((cm = ciRe.exec(xml))) {
      var body = cm[2], offset = cm.index;
      var num = function (re) { var x = body.match(re); return x ? parseInt(x[1], 10) : null; };
      var fidM = body.match(/<file id="([^"]+)"/);
      var fid = fidM ? fidM[1] : null;
      var nameM = body.match(/<name>([\s\S]*?)<\/name>/);
      clips.push({
        id: cm[1], start: num(/<start>(-?\d+)<\/start>/), end: num(/<end>(-?\d+)<\/end>/),
        inP: num(/<in>(-?\d+)<\/in>/), out: num(/<out>(-?\d+)<\/out>/),
        fid: fid, path: fid ? fileById[fid] : null,
        name: nameM ? nameM[1] : cm[1], type: offset < audioRegionStart ? 'video' : 'audio',
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

  function med(a) { var b = a.slice().sort(function (p, q) { return p - q; }); return b[Math.floor(b.length / 2)]; }
  function genUuid() { var h = function () { return Math.floor(Math.random() * 16).toString(16); }; var s = ''; for (var i = 0; i < 32; i++) s += (i === 8 || i === 12 || i === 16 || i === 20) ? '-' + h() : h(); return s; }

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

    var planByKey = {}, clipById = {};
    for (var i = 0; i < clips.length; i++) clipById[clips[i].id] = clips[i];
    function keyOf(path, sf) { return path + '|' + sf; }
    for (var r = 0; r < rows.length; r++) {
      var c0 = clipById[rows[r].nodeId]; if (!c0) continue;
      planByKey[keyOf(c0.path, c0.start)] = {
        targetFrames: Math.max(0, Math.round(rows[r].targetSec / FRAME)),
        status: rows[r].status, comp: rows[r].component
      };
    }

    // Фаза 1: план каждого clipitem
    for (var a = 0; a < clips.length; a++) {
      var c = clips[a], p = planByKey[keyOf(c.path, c.start)];
      if (!p) { c.plan = null; continue; }
      var dur = c.end - c.start;
      c.plan = { start: p.targetFrames, end: p.targetFrames + dur, inP: c.inP, out: c.out,
        comp: p.comp, status: p.status, drop: false };
    }

    // Фаза 2: покрытие видео по комнатам
    var vCover = {};
    for (var b = 0; b < clips.length; b++) {
      var cv = clips[b]; if (cv.type !== 'video' || !cv.plan || cv.plan.status === 'unsynced') continue;
      var kc = cv.plan.comp;
      if (!vCover[kc]) vCover[kc] = { vs: cv.plan.start, ve: cv.plan.end };
      else { if (cv.plan.start < vCover[kc].vs) vCover[kc].vs = cv.plan.start; if (cv.plan.end > vCover[kc].ve) vCover[kc].ve = cv.plan.end; }
    }

    // Фаза 3: обрезать lone-аудио до покрытия видео своей комнаты (in/out тоже)
    var trimmedHead = 0, trimmedTail = 0, dropped = 0;
    for (var d = 0; d < clips.length; d++) {
      var ca = clips[d]; if (ca.type !== 'audio' || !ca.plan || ca.plan.status === 'unsynced') continue;
      var cov = vCover[ca.plan.comp]; if (!cov) continue;
      if (ca.plan.start < cov.vs) { var dh = cov.vs - ca.plan.start; ca.plan.start += dh; ca.plan.inP += dh; trimmedHead += dh; }
      if (ca.plan.end > cov.ve) { var dt = ca.plan.end - cov.ve; ca.plan.end -= dt; ca.plan.out -= dt; trimmedTail += dt; }
      if (ca.plan.end <= ca.plan.start) { ca.plan.drop = true; dropped++; }
    }

    // Фаза 5: сдвиг синхронных к 0
    var gmin = null;
    for (var e = 0; e < clips.length; e++) { var ce = clips[e]; if (ce.plan && !ce.plan.drop && ce.plan.status !== 'unsynced') { if (gmin === null || ce.plan.start < gmin) gmin = ce.plan.start; } }
    if (gmin === null) gmin = 0;
    for (var f = 0; f < clips.length; f++) { var cf = clips[f]; if (cf.plan && !cf.plan.drop && cf.plan.status !== 'unsynced') { cf.plan.start -= gmin; cf.plan.end -= gmin; } }

    // несвязанные → minStart для сдвига к 0 в своей секвенции
    var umin = null;
    for (var g = 0; g < clips.length; g++) { var cg = clips[g]; if (cg.plan && !cg.plan.drop && cg.plan.status === 'unsynced') { if (umin === null || cg.plan.start < umin) umin = cg.plan.start; } }
    if (umin === null) umin = 0;

    // Фаза 6: собрать ДВЕ секвенции
    var synced = 0, unsynced = 0, syncedEndF = 0, unsyncedEndF = 0;
    function renderClip(c, mode) {
      if (!c.plan || c.plan.drop) return '';
      var isUns = c.plan.status === 'unsynced';
      if (mode === 'synced' && isUns) return '';
      if (mode === 'unsynced' && !isUns) return '';
      var s = c.plan.start, en = c.plan.end;
      if (mode === 'unsynced') { s -= umin; en -= umin; }
      var block = c.fullMatch
        .replace(/<start>-?\d+<\/start>/, '<start>' + s + '</start>')
        .replace(/<end>-?\d+<\/end>/, '<end>' + en + '</end>')
        .replace(/<in>-?\d+<\/in>/, '<in>' + c.plan.inP + '</in>')
        .replace(/<out>-?\d+<\/out>/, '<out>' + c.plan.out + '</out>')
        .replace(/<pproTicksIn>-?\d+<\/pproTicksIn>/, '<pproTicksIn>' + (c.plan.inP * TPF) + '</pproTicksIn>')
        .replace(/<pproTicksOut>-?\d+<\/pproTicksOut>/, '<pproTicksOut>' + (c.plan.out * TPF) + '</pproTicksOut>');
      if (isUns) block = block.replace(/<labels>[\s\S]*?<\/labels>/, '<labels>\n\t\t\t\t\t\t<label2>Rose</label2>\n\t\t\t\t\t</labels>');
      if (mode === 'synced') { synced++; if (en > syncedEndF) syncedEndF = en; }
      else { unsynced++; if (en > unsyncedEndF) unsyncedEndF = en; }
      return block;
    }

    var seqM = xml.match(/<sequence\b[\s\S]*?<\/sequence>/);
    if (!seqM) throw new Error('<sequence> не найден');
    var seqTemplate = seqM[0];
    var xmlHead = xml.slice(0, seqM.index);
    var xmlTail = xml.slice(seqM.index + seqTemplate.length);

    function fixSeqHead(blk, endFrames) {
      var endTicks = endFrames * TPF;
      blk = blk.replace(/(<sequence\b[^>]*?)>/, function (full, h) {
        h = h.replace(/MZ\.EditLine="[0-9]+"/, 'MZ.EditLine="0"');
        h = h.replace(/MZ\.WorkInPoint="[0-9]+"/, 'MZ.WorkInPoint="0"');
        h = h.replace(/MZ\.WorkOutPoint="[0-9]+"/, 'MZ.WorkOutPoint="' + endTicks + '"');
        h = h.replace(/Monitor\.ProgramZoomOut="[0-9]+"/, 'Monitor.ProgramZoomOut="' + endTicks + '"');
        h = h.replace(/Monitor\.ProgramZoomIn="[0-9]+"/, 'Monitor.ProgramZoomIn="0"');
        return h + '>';
      });
      return blk.replace(/(<\/uuid>\s*<duration>)\d+(<\/duration>)/, '$1' + endFrames + '$2');
    }

    function buildSeq(mode, nameSuffix) {
      var blk = seqTemplate;
      for (var i = 0; i < clips.length; i++) { var rep = renderClip(clips[i], mode); if (rep !== clips[i].fullMatch) blk = blk.replace(clips[i].fullMatch, rep); }
      blk = blk.replace(/<name>([^<]*)<\/name>/, function (m, n) { return '<name>' + n + nameSuffix + '</name>'; });
      return blk;
    }

    var mainSeq = fixSeqHead(buildSeq('synced', '_SYNCED'), syncedEndF);
    var out = xmlHead + mainSeq;
    var hasUnsynced = false;
    for (var u = 0; u < clips.length; u++) if (clips[u].plan && !clips[u].plan.drop && clips[u].plan.status === 'unsynced') { hasUnsynced = true; break; }
    if (hasUnsynced) {
      var unsSeq = fixSeqHead(buildSeq('unsynced', '_UNSYNCED'), unsyncedEndF)
        .replace(/<uuid>[^<]*<\/uuid>/, '<uuid>' + genUuid() + '</uuid>')
        .replace(/<sequence id="sequence-1"/, '<sequence id="sequence-2"')
        .replace(/(id=")(clipitem|file|masterclip)-(\d+)(")/g, '$1$2-u$3$4')
        .replace(/(<(?:masterclipid|linkclipref)>)(clipitem|masterclip)-(\d+)(<)/g, '$1$2-u$3$4');
      out += '\n\t' + unsSeq;
    }
    out += xmlTail;

    return { xml: out, stats: { synced: synced, unsynced: unsynced, syncedEndSec: Math.round(syncedEndF * FRAME),
      unsyncedEndSec: Math.round(unsyncedEndF * FRAME), trimmedHeadSec: Math.round(trimmedHead * FRAME),
      trimmedTailSec: Math.round(trimmedTail * FRAME), dropped: dropped, hasUnsynced: hasUnsynced } };
  }

  global.FcpXmlTransform = {
    SECOND_TICKS: SECOND_TICKS,
    deriveRate: deriveRate, parseXml: parseXml, buildSnapshot: buildSnapshot, applySyncToXml: applySyncToXml
  };
})(typeof window !== 'undefined' ? window : this);
