(function () {
  'use strict';
  var statusEl = document.getElementById('status');
  function setStatus(s) { statusEl.textContent = s; }

  document.getElementById('analyze').addEventListener('click', function () {
    setStatus('Чтение таймлайна…');
    window.PremiereBridge.getTimelineSnapshot(function (err, snap) {
      if (err) { setStatus('Ошибка: ' + err.message); return; }
      var audio = window.TrackExtractor.audioTracksWithCoverage(snap);
      var anchor = window.SyncGraph.pickAnchorTrack(audio);
      setStatus('Секвенция: ' + snap.sequenceName + ' | аудиодорожек: ' + audio.length +
        ' | опора: Audio ' + (anchor + 1));
    });
  });

  setStatus('Готово к анализу.');
})();
