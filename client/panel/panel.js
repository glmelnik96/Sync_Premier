(function () {
  'use strict';
  var statusEl = document.getElementById('status');
  function setStatus(s) { statusEl.textContent = s; }

  function pGetClipMediaPath(nodeId) {
    return new Promise(function (res, rej) {
      window.PremiereBridge.getClipMediaPath(nodeId, function (e, d) { e ? rej(e) : res(d.mediaPath); });
    });
  }

  function renderResults(rows) {
    var html = rows.map(function (r) {
      return '<div class="clip-row status-' + r.status + '"><span>' + r.name + ' (A' + (r.trackIndex + 1) +
        ')</span><span>' + (r.shiftSec * 1000).toFixed(0) + 'мс · ' + r.status + ' · ' + r.confidence.toFixed(2) + '</span></div>';
    }).join('');
    document.getElementById('results').innerHTML = html;
  }

  document.getElementById('analyze').addEventListener('click', function () {
    setStatus('Чтение таймлайна…');
    window.PremiereBridge.getTimelineSnapshot(function (err, snap) {
      if (err) { setStatus('Ошибка: ' + err.message); return; }
      var audio = window.TrackExtractor.audioTracksWithCoverage(snap);
      var anchor = window.SyncGraph.pickAnchorTrack(audio);
      setStatus('Секвенция: ' + snap.sequenceName + ' | опора: Audio ' + (anchor + 1) + ' | анализ клипов…');
      window.SyncRunner.runSync(snap, anchor, {
        getClipMediaPath: pGetClipMediaPath,
        extractEnvelope: window.AudioEnvelope.extractEnvelope
      }, {})
        .then(function (rows) { renderResults(rows); setStatus('Готово: ' + rows.length + ' клипов'); })
        .catch(function (e) { setStatus('Ошибка: ' + e.message); });
    });
  });

  setStatus('Готово к анализу.');
})();
