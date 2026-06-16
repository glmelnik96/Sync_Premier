/**
 * Тонкий ExtendScript-host плагина «ИИ: синхронизация».
 * Извлечён из родительского host/premiere.jsx (namespace $._EXT_PRM_ → $._SYNC_).
 * Только функции, нужные для синхронизации: снимок, mediaPath, сдвиг клипа,
 * checkpoint-бэкап и активация секвенции. Каждая возвращает JSON-строку.
 */
if (typeof $._SYNC_ === 'undefined') { $._SYNC_ = {}; }

$._SYNC_.version = '0.1.0';

/** Поиск клипа (и его дорожки) по nodeId — обход video + audio дорожек. */
$._SYNC_._findClipByNodeId = function (seq, nodeId) {
  var id = String(nodeId);
  var vi, ai, j, tr, it, n;
  for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
    tr = seq.videoTracks[vi];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try { it = tr.clips[j]; if (it && String(it.nodeId) === id) return { clip: it, isVideo: true, trackIndex: vi }; } catch (e0) {}
    }
  }
  for (ai = 0; ai < seq.audioTracks.numTracks; ai++) {
    tr = seq.audioTracks[ai];
    n = tr.clips.numItems;
    for (j = 0; j < n; j++) {
      try { it = tr.clips[j]; if (it && String(it.nodeId) === id) return { clip: it, isVideo: false, trackIndex: ai }; } catch (e1) {}
    }
  }
  return null;
};

/** Снимок активной секвенции: дорожки + клипы с mediaPath (для аудио), in/out, start/end. */
$._SYNC_.getTimelineSnapshot = function () {
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    }
    var seq = app.project.activeSequence;
    var tb = seq.timebase;
    var fps = 0;
    try { fps = tb > 0 ? Math.round(254016000000 / tb * 100) / 100 : 0; } catch (eFps) {}

    var playheadSec = 0;
    try { playheadSec = seq.getPlayerPosition().seconds; } catch (ePH) {}
    /* seq.end.seconds на части секвенций бросает/возвращает 0 — длительность берём
       как максимум по концам клипов (см. live-валидацию 2026-06-16), с фолбэком. */
    var seqOutSec = 0;
    try { var se = seq.end.seconds; if (se && se > 0) seqOutSec = se; } catch (eE) {}
    var maxClipEndSec = 0;

    var tracks = [];
    var vi, ti, track, item, j, n;
    for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
      track = seq.videoTracks[vi];
      tracks.push({ type: 'video', index: vi, name: track.name || ('V' + (vi + 1)), clipCount: track.clips.numItems });
    }
    for (ti = 0; ti < seq.audioTracks.numTracks; ti++) {
      track = seq.audioTracks[ti];
      tracks.push({ type: 'audio', index: ti, name: track.name || ('A' + (ti + 1)), clipCount: track.clips.numItems });
    }

    var clips = [];
    for (vi = 0; vi < seq.videoTracks.numTracks; vi++) {
      track = seq.videoTracks[vi];
      n = track.clips.numItems;
      for (j = 0; j < n; j++) {
        try {
          item = track.clips[j];
          if (!item) continue;
          if (item.end.seconds > maxClipEndSec) maxClipEndSec = item.end.seconds;
          clips.push({
            trackIndex: vi, trackType: 'video', name: item.name || '', nodeId: String(item.nodeId),
            startSec: item.start.seconds, endSec: item.end.seconds,
            inPointSec: item.inPoint ? item.inPoint.seconds : null,
            outPointSec: item.outPoint ? item.outPoint.seconds : null
          });
        } catch (e5) {}
      }
    }
    for (ti = 0; ti < seq.audioTracks.numTracks; ti++) {
      track = seq.audioTracks[ti];
      n = track.clips.numItems;
      for (j = 0; j < n; j++) {
        try {
          item = track.clips[j];
          if (!item) continue;
          var aMediaPath = '';
          try {
            var aPi = item.projectItem;
            if (aPi) {
              if (typeof aPi.getMediaPath === 'function') aMediaPath = String(aPi.getMediaPath() || '');
              else if (aPi.mediaPath) aMediaPath = String(aPi.mediaPath);
            }
          } catch (eMP) {}
          if (item.end.seconds > maxClipEndSec) maxClipEndSec = item.end.seconds;
          clips.push({
            trackIndex: ti, trackType: 'audio', name: item.name || '', nodeId: String(item.nodeId),
            startSec: item.start.seconds, endSec: item.end.seconds,
            inPointSec: item.inPoint ? item.inPoint.seconds : null,
            outPointSec: item.outPoint ? item.outPoint.seconds : null,
            mediaPath: aMediaPath.replace(/\\/g, '/')
          });
        } catch (e6) {}
      }
    }
    if (seqOutSec <= 0) seqOutSec = maxClipEndSec;
    return JSON.stringify({
      ok: true, sequenceName: seq.name, timebase: tb, fps: fps,
      playheadSec: playheadSec, sequenceOutSec: seqOutSec,
      videoTrackCount: seq.videoTracks.numTracks, audioTrackCount: seq.audioTracks.numTracks,
      tracks: tracks, hostVersion: $._SYNC_.version, clips: clips
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/** Путь к медиа клипа по nodeId. */
$._SYNC_.getClipMediaPath = function (nodeId) {
  try {
    if (!app.project || !app.project.activeSequence) return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    var seq = app.project.activeSequence;
    var found = $._SYNC_._findClipByNodeId(seq, nodeId);
    if (!found) return JSON.stringify({ ok: false, error: 'Клип не найден: ' + nodeId });
    var clip = found.clip;
    var pi = clip.projectItem;
    var mp = '';
    try {
      if (pi && typeof pi.getMediaPath === 'function') mp = String(pi.getMediaPath() || '');
      else if (pi && pi.mediaPath) mp = String(pi.mediaPath);
    } catch (eGP) {}
    if (!mp) return JSON.stringify({ ok: false, error: 'У клипа нет mediaPath' });
    return JSON.stringify({
      ok: true, mediaPath: mp.replace(/\\/g, '/'), name: clip.name || '',
      startSec: clip.start.seconds, endSec: clip.end.seconds,
      inPointSec: clip.inPoint ? clip.inPoint.seconds : 0,
      outPointSec: clip.outPoint ? clip.outPoint.seconds : null
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/** Установить позицию клипа в тиках с безопасным порядком (без транзиента start>end). */
$._SYNC_._setClipPosition = function (clip, newStartTicks, durTicks) {
  var newEnd = newStartTicks + durTicks;
  var curStart = parseFloat(clip.start.ticks);
  if (newStartTicks >= curStart) {
    /* сдвиг вправо: сначала end, потом start */
    clip.end = String(Math.round(newEnd));
    clip.start = String(Math.round(newStartTicks));
  } else {
    clip.start = String(Math.round(newStartTicks));
    clip.end = String(Math.round(newEnd));
  }
};

/** Сдвиг клипа И ВСЕХ связанных A/V-элементов на одну deltaTicks (сохраняет линковку). */
$._SYNC_.moveClip = function (paramsJson) {
  try {
    var p = JSON.parse(paramsJson);            /* {nodeId, deltaTicks} */
    if (!app.project || !app.project.activeSequence) return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    var seq = app.project.activeSequence;
    var found = $._SYNC_._findClipByNodeId(seq, p.nodeId);
    if (!found) return JSON.stringify({ ok: false, error: 'Клип не найден: ' + p.nodeId });
    var clip = found.clip;
    var delta = parseFloat(p.deltaTicks);
    /* Если delta отрицательная и какой-либо из связанных элементов уехал бы < 0 —
       ограничиваем delta так, чтобы самый левый элемент встал ровно в 0 (сохраняем
       относительную линковку между видео и аудио). */
    var items = [clip];
    try {
      if (typeof clip.getLinkedItems === 'function') {
        var li = clip.getLinkedItems();
        if (li && li.numItems) {
          items = [];
          for (var q = 0; q < li.numItems; q++) items.push(li[q]);
        }
      }
    } catch (eL) { items = [clip]; }

    var minStart = null, ii;
    for (ii = 0; ii < items.length; ii++) {
      var st = parseFloat(items[ii].start.ticks);
      if (minStart === null || st < minStart) minStart = st;
    }
    if (minStart + delta < 0) delta = -minStart; /* клампим единым сдвигом, без разрыва линковки */

    var moved = 0;
    for (ii = 0; ii < items.length; ii++) {
      var it = items[ii];
      var cs = parseFloat(it.start.ticks);
      var dur = parseFloat(it.end.ticks) - cs;
      $._SYNC_._setClipPosition(it, cs + delta, dur);
      moved++;
    }
    return JSON.stringify({ ok: true, nodeId: String(p.nodeId), movedItems: moved, appliedDeltaTicks: String(Math.round(delta)) });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/** Checkpoint: клон активной секвенции (Revert = activateSequenceById). */
$._SYNC_.backupActiveSequence = function () {
  try {
    if (!app.project || !app.project.activeSequence) return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    var seq = app.project.activeSequence;
    if (typeof seq.clone !== 'function') return JSON.stringify({ ok: false, error: 'Sequence.clone() недоступен' });
    var seqs = app.project.sequences;
    var before = {};
    for (var i = 0; i < seqs.numSequences; i++) before[String(seqs[i].sequenceID)] = 1;
    seq.clone();
    seqs = app.project.sequences;
    var created = null;
    for (var j = 0; j < seqs.numSequences; j++) {
      if (!before[String(seqs[j].sequenceID)]) { created = seqs[j]; break; }
    }
    if (!created) return JSON.stringify({ ok: false, error: 'clone() не создал новую секвенцию' });
    var d = new Date();
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var stamp = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
    try { created.name = String(seq.name) + ' [синхро-бэкап ' + stamp + ']'; } catch (eN) {}
    try {
      if (app.project.activeSequence && String(app.project.activeSequence.sequenceID) !== String(seq.sequenceID)) {
        app.project.activeSequence = seq;
      }
    } catch (eA) {}
    return JSON.stringify({ ok: true, backupId: String(created.sequenceID), backupName: String(created.name || ''), originalName: String(seq.name || '') });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/** Уплотнить дорожку: каждый клип прижимается к концу предыдущего (закрытие пауз/перекрытий). */
$._SYNC_.rippleCloseGaps = function (paramsJson) {
  try {
    var p = JSON.parse(paramsJson);            /* {trackType, trackIndex} */
    if (!app.project || !app.project.activeSequence) return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    var seq = app.project.activeSequence;
    var track = (p.trackType === 'audio' ? seq.audioTracks : seq.videoTracks)[p.trackIndex];
    if (!track) return JSON.stringify({ ok: false, error: 'Дорожка не найдена' });
    var items = [];
    for (var i = 0; i < track.clips.numItems; i++) items.push(track.clips[i]);
    items.sort(function (a, b) { return parseFloat(a.start.ticks) - parseFloat(b.start.ticks); });
    var cursor = items.length ? parseFloat(items[0].start.ticks) : 0;
    var moved = 0;
    for (var j = 0; j < items.length; j++) {
      var c = items[j];
      var dur = parseFloat(c.end.ticks) - parseFloat(c.start.ticks);
      if (Math.abs(parseFloat(c.start.ticks) - cursor) > 1) {
        $._SYNC_._setClipPosition(c, cursor, dur);
        moved++;
      }
      cursor = parseFloat(c.start.ticks) + dur;
    }
    return JSON.stringify({ ok: true, movedClips: moved });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/** Растяжка клипа по скорости для коррекции дрейфа. ratio>1 = быстрее (короче). */
$._SYNC_.setClipSpeed = function (paramsJson) {
  try {
    var p = JSON.parse(paramsJson);            /* {nodeId, ratio} */
    if (!app.project || !app.project.activeSequence) return JSON.stringify({ ok: false, error: 'Нет активной секвенции' });
    var seq = app.project.activeSequence;
    var found = $._SYNC_._findClipByNodeId(seq, p.nodeId);
    if (!found) return JSON.stringify({ ok: false, error: 'Клип не найден' });
    var clip = found.clip;
    if (typeof clip.setSpeed !== 'function') return JSON.stringify({ ok: false, error: 'setSpeed недоступен (нужен ffmpeg-фолбэк R5)' });
    clip.setSpeed(parseFloat(p.ratio));
    return JSON.stringify({ ok: true, nodeId: String(p.nodeId), ratio: p.ratio });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

/** Активировать секвенцию по sequenceID (Revert на бэкап). */
$._SYNC_.activateSequenceById = function (seqId) {
  try {
    if (!app.project) return JSON.stringify({ ok: false, error: 'Нет проекта' });
    var want = String(seqId);
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) {
      if (String(seqs[i].sequenceID) === want) {
        app.project.activeSequence = seqs[i];
        return JSON.stringify({ ok: true, name: String(seqs[i].name || '') });
      }
    }
    return JSON.stringify({ ok: false, error: 'Секвенция не найдена: ' + want });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
};

'OK';
