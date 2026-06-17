(function () {
  'use strict';

  var btn = document.getElementById('syncXml');
  var statusEl = document.getElementById('status');
  var resultEl = document.getElementById('result');

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (kind ? ' status-' + kind : '');
  }
  function setBusy(busy) {
    btn.disabled = busy;
    btn.textContent = busy ? 'Синхронизация…' : 'Синхронизировать';
  }
  function showResult(html) { resultEl.innerHTML = html || ''; }

  /* ГИБРИД-ПАЙПЛАЙН (FCP7 XML round-trip, БЕЗ мутации живого таймлайна):
     host экспортирует активную секвенцию в FCP7 XML → панель парсит, гоняет DSP
     (ffmpeg-огибающие + FFT-NCC + граф комнат), пишет синхро-XML (две секвенции
     _SYNCED + опц. _UNSYNCED) → host importFiles → Premiere строит свежие секвенции.
     Это снимает все проблемы move()-подхода (длительность, плейхед, развал). */
  btn.addEventListener('click', function () {
    var T = window.FcpXmlTransform;
    var fs;
    try { fs = require('fs'); } catch (e) { setStatus('Node.js недоступен в панели (нужен --enable-nodejs)', 'error'); return; }

    setBusy(true); showResult('');
    setStatus('1/4 · Экспорт секвенции…', 'busy');
    window.PremiereBridge.exportActiveSequenceXml(function (err, exp) {
      if (err || !exp || !exp.path) { setStatus('Ошибка экспорта: ' + (err ? err.message : 'нет активной секвенции'), 'error'); setBusy(false); return; }
      var xml;
      try { xml = fs.readFileSync(exp.path, 'utf8'); } catch (e2) { setStatus('Не удалось прочитать XML: ' + e2.message, 'error'); setBusy(false); return; }

      var rate = T.deriveRate(xml);
      var parsed = T.parseXml(xml);
      setStatus('2/4 · «' + exp.seqName + '»: анализ ' + parsed.clips.length + ' клипов (огибающие)…', 'busy');

      var snapshot = T.buildSnapshot(parsed.clips, rate.frameSec);
      window.SyncRunner.runClipSync(snapshot, { extractEnvelope: window.AudioEnvelope.extractEnvelope },
        { refGate: 0.45, clipGate: 0.4, coarseWindowMs: 20 })
        .then(function (rows) {
          setStatus('3/4 · Сборка синхро-секвенции…', 'busy');
          var res = T.applySyncToXml(xml, parsed.clips, rows, { frameSec: rate.frameSec, ticksPerFrame: rate.ticksPerFrame });
          var outPath = exp.path.replace(/sync_premier_in\.xml$/, 'sync_premier_out.xml');
          fs.writeFileSync(outPath, res.xml, 'utf8');

          var s = res.stats;
          setStatus('4/4 · Импорт в проект…', 'busy');
          window.PremiereBridge.importSyncedXml(outPath, function (e3, imp) {
            setBusy(false);
            if (e3 || !imp || !imp.ok) { setStatus('Ошибка импорта: ' + (e3 ? e3.message : 'importFiles вернул false'), 'error'); return; }
            var names = (imp.imported || []).map(function (x) { return x.name; });
            setStatus('Готово ✓', 'ok');
            renderSummary(s, names);
          });
        })
        .catch(function (e4) { setStatus('Ошибка синхронизации: ' + e4.message, 'error'); setBusy(false); });
    });
  });

  /* Итоговая сводка: что создано и что попало в несвязанные. */
  function renderSummary(s, names) {
    var rows = [];
    names.forEach(function (n) {
      var isUns = /_UNSYNCED$/.test(n);
      rows.push('<div class="res-row">' +
        '<span class="dot ' + (isUns ? 'dot-red' : 'dot-green') + '"></span>' +
        '<b>' + n + '</b>' +
        '<span class="muted">' + (isUns ? s.unsynced + ' клипов без связи' : s.synced + ' клипов · ' + fmtTime(s.syncedEndSec)) + '</span>' +
        '</div>');
    });
    var notes = [];
    if (s.hasUnsynced) notes.push(s.unsynced + ' клипов без общего звука — в конце секвенции, помечены красным. Разберите вручную.');
    if (notes.length) rows.push('<div class="note">' + notes.join('<br>') + '</div>');
    showResult(rows.join(''));
  }

  function fmtTime(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
    return (h ? h + ':' : '') + (h ? ('0' + m).slice(-2) : m) + ':' + ('0' + x).slice(-2);
  }

  setStatus('Откройте секвенцию и нажмите «Синхронизировать».');
})();
