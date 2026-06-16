(function () {
  'use strict';
  var TICKS_PER_SECOND = 254016000000;
  var statusEl = document.getElementById('status');
  var applyBtn = document.getElementById('apply');
  var revertBtn = document.getElementById('revert');
  var lastRows = [];
  var backupSeqId = null;

  function setStatus(s) { statusEl.textContent = s; }

  function renderResults(rows) {
    var html = rows.map(function (r, idx) {
      return '<div class="clip-row status-' + r.status + '" data-idx="' + idx + '" style="cursor:pointer"><span>' +
        r.name + ' (A' + (r.trackIndex + 1) + ')</span><span>' + (r.shiftSec * 1000).toFixed(0) +
        'мс · ' + r.status + ' · ' + r.confidence.toFixed(2) + '</span></div>';
    }).join('');
    var resEl = document.getElementById('results');
    resEl.innerHTML = html;
    resEl.querySelectorAll('.clip-row').forEach(function (el) {
      el.addEventListener('click', function () {
        var r = lastRows[parseInt(el.getAttribute('data-idx'), 10)];
        if (!r || !r.refSeg) return;
        var shiftSamples = r.dtSec ? (r.shiftSec / r.dtSec) : 0;
        window.SyncWaveform.drawPair(document.getElementById('wave'), r.refSeg, r.clipEnv, shiftSamples);
      });
    });
  }

  function onAnalyzed(rows) {
    lastRows = rows;
    renderResults(rows);
    applyBtn.disabled = rows.length === 0;
  }

  document.getElementById('analyze').addEventListener('click', function () {
    setStatus('Чтение таймлайна…');
    window.PremiereBridge.getTimelineSnapshot(function (err, snap) {
      if (err) { setStatus('Ошибка: ' + err.message); return; }
      setStatus('Секвенция: ' + snap.sequenceName + ' | per-clip синхронизация (извлечение огибающих)…');
      /* Per-clip синхронизация (модель Syncaila): каждый клип матчится против
         референсов-«часов», roaming-источники и комнаты разделяются автоматически. */
      window.SyncRunner.runClipSync(snap, {
        extractEnvelope: window.AudioEnvelope.extractEnvelope
      }, { refGate: 0.45, clipGate: 0.4, coarseWindowMs: 20 })
        .then(function (rows) {
          onAnalyzed(rows);
          var comps = {}; rows.forEach(function (r) { if (r.component >= 0) comps[r.component] = 1; });
          setStatus('Готово: ' + rows.length + ' клипов, комнат: ' + Object.keys(comps).length);
        })
        .catch(function (e) { setStatus('Ошибка: ' + e.message); });
    });
  });

  applyBtn.addEventListener('click', function () {
    setStatus('Создаю checkpoint…');
    window.PremiereBridge.backupActiveSequence(function (err, b) {
      if (err) { setStatus('Ошибка backup: ' + err.message); return; }
      backupSeqId = b.backupId;
      revertBtn.disabled = !backupSeqId;
      var toMove = lastRows.filter(function (r) { return r.status === 'sync' || r.status === 'drift'; });
      var i = 0;
      (function next() {
        if (i >= toMove.length) {
          /* Task 12: ripple-закрытие пауз на затронутых дорожках */
          var tracks = {}; toMove.forEach(function (r) { tracks[r.trackIndex] = true; });
          var idxs = Object.keys(tracks); var ti = 0;
          (function nextTrack() {
            if (ti >= idxs.length) { setStatus('Применено + ripple: ' + toMove.length + ' клипов'); return; }
            window.PremiereBridge.rippleCloseGaps('audio', parseInt(idxs[ti++], 10), function () { nextTrack(); });
          })();
          return;
        }
        var r = toMove[i++];
        var deltaTicks = Math.round(r.shiftSec * TICKS_PER_SECOND);
        window.PremiereBridge.moveClip(r.nodeId, deltaTicks, function (e) {
          if (e) { setStatus('Ошибка moveClip: ' + e.message); return; }
          /* Task 13: коррекция дрейфа для drift-клипов */
          if (r.status === 'drift') {
            window.PremiereBridge.setClipSpeed(r.nodeId, 1 + r.slope, function (e2, d2) {
              if (e2 || !d2 || !d2.ok) setStatus('Дрейф ' + r.name + ': нативная коррекция недоступна (R5)');
              next();
            });
            return;
          }
          setStatus('Сдвинуто ' + i + '/' + toMove.length); next();
        });
      })();
    });
  });

  revertBtn.addEventListener('click', function () {
    if (!backupSeqId) return;
    window.PremiereBridge.activateSequenceById(backupSeqId, function (e) {
      setStatus(e ? 'Ошибка отката: ' + e.message : 'Откат выполнен (активирован checkpoint)');
    });
  });

  setStatus('Готово к анализу.');
})();
