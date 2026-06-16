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

  /* ГИБРИД-ПАЙПЛАЙН (FCP7 XML round-trip, БЕЗ move()):
     host экспортирует секвенцию в XML → панель парсит, гоняет DSP, пишет синхро-XML
     (две секвенции _SYNCED/_UNSYNCED) → host importFiles. Никакой мутации живого
     таймлайна — Premiere строит свежие секвенции импортом. */
  document.getElementById('syncXml').addEventListener('click', function () {
    var T = window.FcpXmlTransform;
    var fs; try { fs = require('fs'); } catch (e) { setStatus('Ошибка: Node fs недоступен (нужен <CEFCommandLine>)'); return; }
    setStatus('Экспорт секвенции в XML…');
    window.PremiereBridge.exportActiveSequenceXml(function (err, exp) {
      if (err || !exp || !exp.path) { setStatus('Ошибка экспорта: ' + (err ? err.message : 'нет пути')); return; }
      var xml;
      try { xml = fs.readFileSync(exp.path, 'utf8'); } catch (e2) { setStatus('Ошибка чтения XML: ' + e2.message); return; }
      var rate = T.deriveRate(xml);
      var parsed = T.parseXml(xml);
      setStatus('Секвенция «' + exp.seqName + '»: ' + parsed.clips.length + ' клипов, синхронизация (огибающие)…');
      var snapshot = T.buildSnapshot(parsed.clips, rate.frameSec);
      window.SyncRunner.runClipSync(snapshot, { extractEnvelope: window.AudioEnvelope.extractEnvelope },
        { refGate: 0.45, clipGate: 0.4, coarseWindowMs: 20 })
        .then(function (rows) {
          var res = T.applySyncToXml(xml, parsed.clips, rows, { frameSec: rate.frameSec, ticksPerFrame: rate.ticksPerFrame });
          var outPath = exp.path.replace(/sync_premier_in\.xml$/, 'sync_premier_out.xml');
          fs.writeFileSync(outPath, res.xml, 'utf8');
          var s = res.stats;
          setStatus('Импорт синхро-секвенций (_SYNCED ' + s.syncedEndSec + 'с' + (s.hasUnsynced ? ', _UNSYNCED ' + s.unsynced + ' клипов' : '') + ')…');
          window.PremiereBridge.importSyncedXml(outPath, function (e3, imp) {
            if (e3 || !imp || !imp.ok) { setStatus('Ошибка импорта: ' + (e3 ? e3.message : 'importFiles=false')); return; }
            var names = (imp.imported || []).map(function (x) { return x.name; }).join(', ');
            setStatus('Готово ✓ Созданы секвенции: ' + names);
          });
        })
        .catch(function (e4) { setStatus('Ошибка синхронизации: ' + e4.message); });
    });
  });

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
      var toEnd = lastRows.filter(function (r) { return r.status === 'unsynced'; });
      var i = 0;
      /* СИНХРОНИЗАЦИЯ: только сдвиг клипов (вместе со связанным A/V).
         Ripple-закрытие пауз НЕ применяем — паузы между клипами в синхро-раскладке
         осмысленны (камера не писала), уплотнение разрушило бы выравнивание. */
      function finishUnsynced() {
        /* Несвязанные клипы: сдвинуть в конец + красный label (нечего синхронизировать). */
        var j = 0;
        (function nextU() {
          if (j >= toEnd.length) {
            setStatus('Синхронизировано: ' + toMove.length + ', без связи (в конец): ' + toEnd.length + '. Обновление…');
            window.PremiereBridge.refreshActiveSequence(function () {
              setStatus('Готово. Синхронизировано: ' + toMove.length + ', без связи: ' + toEnd.length);
            });
            return;
          }
          var u = toEnd[j++];
          window.PremiereBridge.moveClipTo(u.nodeId, Math.round(u.targetSec * TICKS_PER_SECOND), function () {
            window.PremiereBridge.setClipLabel(u.nodeId, 6, function () {
              setStatus('В конец ' + j + '/' + toEnd.length); nextU();
            });
          });
        })();
      }
      (function next() {
        if (i >= toMove.length) { finishUnsynced(); return; }
        var r = toMove[i++];
        window.PremiereBridge.moveClipTo(r.nodeId, Math.round(r.targetSec * TICKS_PER_SECOND), function (e) {
          if (e) { setStatus('Ошибка moveClip: ' + e.message); return; }
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
