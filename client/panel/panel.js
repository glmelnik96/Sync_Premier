(function () {
  'use strict';

  var btn = document.getElementById('syncXml');
  var statusEl = document.getElementById('status');
  var resultEl = document.getElementById('result');
  var progEl = document.getElementById('progress');
  var progBar = document.getElementById('progressBar');

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (kind ? ' status-' + kind : '');
  }
  /* Честный индикатор стадий (пайплайн знает границы этапов, но не суб-прогресс DSP):
     frac 0..1 = доля пройденных стадий; state красит полосу при финале/ошибке. */
  function setProgress(frac, state) {
    progEl.className = 'progress' + (frac == null ? '' : ' active');
    progBar.className = 'progress-bar' + (state ? ' ' + state : '');
    if (frac != null) progBar.style.width = Math.round(frac * 100) + '%';
  }
  function setBusy(busy) {
    btn.disabled = busy;
    btn.textContent = busy ? 'Синхронизация…' : 'Синхронизировать';
  }
  function showResult(html) { resultEl.innerHTML = html || ''; }

  /* ГИБРИД-ПАЙПЛАЙН (FCP7 XML round-trip, БЕЗ мутации живого таймлайна):
     host экспортирует активную секвенцию в FCP7 XML → панель парсит, гоняет DSP
     (ffmpeg-огибающие + FFT-NCC + граф комнат), пишет синхро-XML (одна секвенция
     _SYNCED, несвязанные — в конец, Rose) → host importFiles → Premiere строит секвенцию.
     Это снимает все проблемы move()-подхода (длительность, плейхед, развал). */
  btn.addEventListener('click', function () {
    var T = window.FcpXmlTransform;
    var fs;
    try { fs = require('fs'); } catch (e) { setStatus('Node.js недоступен в панели (нужен --enable-nodejs)', 'error'); return; }

    setBusy(true); showResult(''); setProgress(0.05);
    setStatus('1/4 · Экспорт секвенции…', 'busy');
    window.PremiereBridge.exportActiveSequenceXml(function (err, exp) {
      if (err || !exp || !exp.path) { setStatus('Ошибка экспорта: ' + (err ? err.message : (exp && exp.error) || 'нет активной секвенции'), 'error'); setProgress(0.05, 'error'); setBusy(false); return; }
      var xml;
      try { xml = fs.readFileSync(exp.path, 'utf8'); } catch (e2) { setStatus('Не удалось прочитать XML: ' + e2.message, 'error'); setProgress(0.1, 'error'); setBusy(false); return; }

      var rate = T.deriveRate(xml);
      var parsed = T.parseXml(xml);
      setProgress(0.25);
      setStatus('2/4 · «' + exp.seqName + '»: анализ ' + parsed.clips.length + ' клипов (огибающие)…', 'busy');

      var snapshot = T.buildSnapshot(parsed.clips, rate.frameSec);
      window.SyncRunner.runClipSync(snapshot, { extractEnvelope: window.AudioEnvelope.extractEnvelope },
        { refGate: 0.45, clipGate: 0.4, coarseWindowMs: 20 })
        .then(function (rows) {
          setProgress(0.7);
          setStatus('3/4 · Сборка синхро-секвенции…', 'busy');
          var xopt = { frameSec: rate.frameSec, ticksPerFrame: rate.ticksPerFrame };
          var res = T.applySyncToXml(xml, parsed.clips, rows, xopt);
          /* Ф3.1: stretch-камера (record-run TC) → band-pass скан + warp-раскладка (pass 2) */
          var pass2 = Promise.resolve(res);
          if (res.stretch) {
            setProgress(0.8);
            setStatus('3/4 · Растянутая камера: warp-раскладка по звуку…', 'busy');
            pass2 = window.StretchWarp.computeTargets(res.stretch,
              { extractEnvelope: window.AudioEnvelope.extractEnvelope, SyncCore: window.SyncCore })
              .then(function (sw) {
                var hasT = false; for (var k in sw.targets) { if (sw.targets.hasOwnProperty(k)) { hasT = true; break; } }
                if (!hasT) return res;
                xopt.stretchTargets = sw.targets;
                xopt.stretchPinned = sw.pinned;
                return T.applySyncToXml(xml, parsed.clips, rows, xopt);
              });
          }
          return pass2;
        })
        .then(function (res) {
          var outPath = exp.path.replace(/sync_premier_in\.xml$/, 'sync_premier_out.xml');
          fs.writeFileSync(outPath, res.xml, 'utf8');

          var s = res.stats;
          setProgress(0.9);
          setStatus('4/4 · Импорт в проект…', 'busy');
          window.PremiereBridge.importSyncedXml(outPath, function (e3, imp) {
            setBusy(false);
            if (e3 || !imp || !imp.ok) { setStatus('Ошибка импорта: ' + (e3 ? e3.message : (imp && imp.error) || 'importFiles вернул false'), 'error'); setProgress(0.9, 'error'); return; }
            var names = (imp.imported || []).map(function (x) { return x.name; });
            setProgress(1, 'ok');
            setStatus('Готово ✓', 'ok');
            renderSummary(s, names);
          });
        })
        .catch(function (e4) { setStatus('Ошибка синхронизации: ' + e4.message, 'error'); setProgress(0.7, 'error'); setBusy(false); });
    });
  });

  /* Итоговая сводка: созданная секвенция + заметки о timecode/несвязанных. */
  function renderSummary(s, names) {
    var rows = [];
    names.forEach(function (n) {
      rows.push('<div class="res-row">' +
        '<span class="dot dot-green"></span>' +
        '<b>' + n + '</b>' +
        '<span class="muted">' + s.synced + ' клипов · ' + fmtTime(s.syncedEndSec) + '</span>' +
        '</div>');
    });
    if (s.hasUnsynced) {
      rows.push('<div class="res-row">' +
        '<span class="dot dot-red"></span>' +
        '<b>Не подтверждено звуком</b>' +
        '<span class="muted">' + s.unsynced + ' клипов · в конце, красным</span>' +
        '</div>');
    }
    var notes = [];
    if (s.tcRescued) notes.push(s.tcRescued + ' клипов без звукового совпадения поставлено по timecode (спанированная камера).');
    if (s.hasUnsynced) notes.push('Клипы без общего звука (красные) собраны в конце секвенции — разберите вручную.');
    if (notes.length) rows.push('<div class="note">' + notes.join('<br>') + '</div>');
    showResult(rows.join(''));
  }

  function fmtTime(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
    return (h ? h + ':' : '') + (h ? ('0' + m).slice(-2) : m) + ':' + ('0' + x).slice(-2);
  }

  setStatus('Откройте секвенцию и нажмите «Синхронизировать».');
})();
