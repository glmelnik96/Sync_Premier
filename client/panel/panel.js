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
      if (!rate.found) { setStatus('Не удалось определить частоту кадров секвенции (<timebase>) — синхрон отменён', 'error'); setProgress(0.25, 'error'); setBusy(false); return; }
      var parsed = T.parseXml(xml);
      setProgress(0.25);
      /* счёт по ИСТОЧНИКАМ (path|start), как в итоговой сводке: связка «видео+стерео»
         даёт 3 clipitem одного источника — показывать clipitem'ы значит завышать. */
      var srcSeen = {}, srcCount = 0;
      for (var sc0 = 0; sc0 < parsed.clips.length; sc0++) {
        var kk = (parsed.clips[sc0].path || parsed.clips[sc0].id) + '|' + parsed.clips[sc0].start;
        if (!srcSeen[kk]) { srcSeen[kk] = 1; srcCount++; }
      }
      setStatus('2/4 · «' + exp.seqName + '»: анализ ' + srcCount + ' клипов (огибающие)…', 'busy');

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
              { extractEnvelope: window.AudioEnvelope.extractEnvelope, SyncCore: window.SyncCore,
                extractPcm: window.AudioEnvelope.extractPcm, AudioFingerprint: window.AudioFingerprint })
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
          /* Нечего синхронизировать: ни один источник не подтверждён звуком и не размещён
             по timecode. НЕ создаём красную секвенцию из «нуля» — честно предупреждаем. */
          if (res.stats.nothingToSync) {
            setBusy(false); setProgress(null);
            setStatus('Нечего синхронизировать: не найдено клипов с общим звуком', 'error');
            showResult('<div class="note">Синхронизация по звуку требует ≥2 источников, записавших ОДИН И ТОТ ЖЕ звук (камеры + рекордер одной сцены). В текущей секвенции общего звука не найдено — секвенция не создана.</div>');
            return;
          }
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

  /* ── Окружение: статус ffmpeg сразу при старте (а не ошибка посреди синхрона).
     findFfmpegPath может дёргать `where` (до 5с) → уводим с первого кадра setTimeout'ом.
     null не мемоизируется → установка ffmpeg посреди сессии подхватится при синхроне. */
  var envEl = document.getElementById('envState');
  setTimeout(function () {
    var p = null;
    try { p = window.AudioEnvelope.findFfmpegPath(); } catch (e) {}
    if (p) { envEl.className = 'env-state ok'; envEl.textContent = 'ffmpeg: найден'; }
    else {
      envEl.className = 'env-state warn';
      envEl.innerHTML = 'ffmpeg не найден — анализ звука не сработает. Установите: <b>winget install ffmpeg</b> и переоткройте панель.';
    }
  }, 300);

  /* ── Обновления: версия в футере + ПОСТОЯННАЯ кнопка «Проверить обновления».
     Клик = проверка (raw package.json на main) → есть новая версия — сразу
     применение (git pull на dev-клоне / zip-замена у пользователя) →
     «перезагрузить панель» (reload перечитает и client-код, и jsx через
     ensureHost); нет новой — «Актуальная версия ✓». Ошибки видны на кнопке
     (текст + title с деталями), а не глотаются молча. */
  var verLabel = document.getElementById('verLabel');
  var updBtn = document.getElementById('updBtn');
  /* CEP отдаёт путь расширения как URI (file:///C:/Users/%D0%93...): ExtendScript
     File() это ест (jsx грузится), а Node fs — нет → кириллица в имени пользователя
     ломала чтение package.json (пустой футер, ложная «актуальная версия»).
     Нормализация: срезать file:///, раскодировать %-последовательности; для обычного
     пути — no-op (decodeURIComponent без % ничего не меняет, ошибка — оставляем как есть). */
  var extRoot = null;
  try {
    var rawP = String(new CSInterface().getExtensionPath() || '').replace(/^file:\/{2,3}/, '');
    try { rawP = decodeURIComponent(rawP); } catch (eD) {}
    extRoot = rawP.replace(/\\/g, '/') || null;
  } catch (eR) {}
  var curVer = window.SyncUpdater.localVersion(extRoot);
  verLabel.textContent = curVer ? 'v' + curVer : 'v?';
  verLabel.title = extRoot || 'путь расширения недоступен';
  var IDLE_TEXT = 'Проверить обновления';
  updBtn.hidden = false;
  updBtn.textContent = IDLE_TEXT;
  updBtn.onclick = function () {
    if (btn.disabled) return; /* не обновляемся во время синхрона */
    updBtn.disabled = true; updBtn.title = ''; updBtn.textContent = 'Проверка…';
    window.SyncUpdater.checkForUpdate(extRoot, function (err, info) {
      if (err) {
        updBtn.disabled = false; updBtn.textContent = 'Ошибка проверки — повторить';
        updBtn.title = err.message; return;
      }
      if (info.current == null) {
        /* локальная версия не прочиталась → «hasUpdate: false» ничего не значит */
        updBtn.disabled = false; updBtn.textContent = 'Ошибка: версия плагина не определена';
        updBtn.title = 'Не читается package.json в ' + (extRoot || '(путь недоступен)'); return;
      }
      if (!info.hasUpdate) {
        updBtn.disabled = false; updBtn.textContent = 'Актуальная версия ✓';
        setTimeout(function () { if (!updBtn.disabled) updBtn.textContent = IDLE_TEXT; }, 4000);
        return;
      }
      var fromTo = 'v' + (info.current || '?') + ' → v' + info.latest;
      updBtn.textContent = 'Обновление ' + fromTo + '…';
      window.SyncUpdater.applyUpdate(extRoot, function (e2) {
        updBtn.disabled = false;
        if (e2) { updBtn.textContent = 'Ошибка обновления — повторить'; updBtn.title = e2.message; return; }
        updBtn.textContent = 'Обновлено ' + fromTo + ' — перезагрузить панель';
        updBtn.onclick = function () { location.reload(); };
      });
    });
  };

  setStatus('Откройте секвенцию и нажмите «Синхронизировать».');
})();
