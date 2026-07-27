/**
 * Модуль обновления плагина с GitHub (ES5 IIFE, Node-зависимости только внутри функций).
 *
 * Источник истины версии — "version" в package.json ветки main (публичный репозиторий):
 * бамп версии + пуш в main = релиз. Проверка: raw.githubusercontent (без токена).
 *
 * Применение — ГИБРИД:
 * - папка плагина — git-клон (.git есть) → `git pull --ff-only` (dev-машина;
 *   локальные коммиты/расхождение НЕ затираются — pull честно падает);
 * - иначе (конечный пользователь без git) → скачать zip main, распаковать во temp,
 *   скопировать поверх папки плагина (fs.cpSync). Файлы панели не залочены CEP
 *   (Chromium держит их в памяти) → замена на лету безопасна; после обновления
 *   нужна перезагрузка панели (location.reload — jsx перечитается через ensureHost).
 *
 * Все функции принимают root (путь к корню расширения) явно — тестируемость вне CEP.
 */
(function (global) {
  'use strict';

  var REPO = 'glmelnik96/Sync_Premier';
  var BRANCH = 'main';
  var RAW_PKG_URL = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/package.json';
  var ZIP_URL = 'https://codeload.github.com/' + REPO + '/zip/refs/heads/' + BRANCH;
  var FETCH_TIMEOUT_MS = 15000;
  var ZIP_TIMEOUT_MS = 120000;

  function hasNode() { return typeof require !== 'undefined'; }

  /** '0.2.1' vs '0.3.0' → -1|0|1 (численно по сегментам; недостающие = 0). */
  function cmpVer(a, b) {
    var pa = String(a || '0').split('.'), pb = String(b || '0').split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i], 10) || 0, nb = parseInt(pb[i], 10) || 0;
      if (na !== nb) return na < nb ? -1 : 1;
    }
    return 0;
  }

  /** Локальная версия из <root>/package.json; null, если прочитать нельзя. */
  function localVersion(root) {
    if (!hasNode() || !root) return null;
    try {
      var pkg = JSON.parse(require('fs').readFileSync(root + '/package.json', 'utf8'));
      return pkg.version || null;
    } catch (e) { return null; }
  }

  /** fetch с таймаутом → Promise<текст>. */
  function fetchText(url, timeoutMs) {
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs) : null;
    return fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (txt) { if (t) clearTimeout(t); return txt; },
            function (e) { if (t) clearTimeout(t); throw e; });
  }

  /** Проверка обновления → cb(err, {current, latest, hasUpdate}).
      Нет version на main / сеть недоступна → err (вызывающий решает, шуметь ли). */
  function checkForUpdate(root, cb) {
    var current = localVersion(root);
    fetchText(RAW_PKG_URL, FETCH_TIMEOUT_MS)
      .then(function (txt) {
        var latest = null;
        try { latest = JSON.parse(txt).version || null; } catch (e) {}
        if (!latest) { cb(new Error('на main нет поля version')); return; }
        cb(null, { current: current, latest: latest,
          hasUpdate: current != null && cmpVer(current, latest) < 0 });
      })
      .catch(function (e) { cb(new Error('проверка обновлений: ' + (e && e.message ? e.message : e))); });
  }

  /** git pull --ff-only в root → cb(err). Расхождение/грязное дерево — честная ошибка. */
  function updateViaGit(root, cb) {
    var execFile = require('child_process').execFile;
    execFile('git', ['-C', root, 'pull', '--ff-only'], { timeout: 60000 },
      function (err, stdout, stderr) {
        if (err) { cb(new Error('git pull: ' + (String(stderr || '').trim() || err.message))); return; }
        cb(null);
      });
  }

  /** Скачать zip main → распаковать во temp → скопировать поверх root (без .git) → cb(err). */
  function updateViaZip(root, cb) {
    var fs = require('fs'), path = require('path'), os = require('os');
    var execFile = require('child_process').execFile;
    var tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sync_premier_upd_'));
    var zipPath = path.join(tmpBase, 'upd.zip');
    function cleanup() { try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) {} }
    function fail(msg) { cleanup(); cb(new Error(msg)); }

    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, ZIP_TIMEOUT_MS) : null;
    fetch(ZIP_URL, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (ab) {
        if (t) clearTimeout(t);
        fs.writeFileSync(zipPath, Buffer.from(ab));
        /* распаковка: win — PowerShell Expand-Archive; иначе unzip. execFile c массивом
           аргументов (без shell-конкатенации) — пути не интерполируются в команду. */
        var isWin = process.platform === 'win32';
        var bin = isWin ? 'powershell.exe' : 'unzip';
        var args = isWin
          ? ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:SP_ZIP -DestinationPath $env:SP_DST -Force']
          : ['-o', zipPath, '-d', tmpBase];
        var env = isWin ? Object.assign({}, process.env, { SP_ZIP: zipPath, SP_DST: tmpBase }) : process.env;
        execFile(bin, args, { timeout: 60000, env: env }, function (err) {
          if (err) { fail('распаковка: ' + err.message); return; }
          /* корневая папка архива: <Repo>-<branch> */
          var entries;
          try { entries = fs.readdirSync(tmpBase).filter(function (n) { return n !== 'upd.zip'; }); }
          catch (e) { fail('чтение архива: ' + e.message); return; }
          if (entries.length !== 1) { fail('неожиданная структура архива: ' + entries.join(', ')); return; }
          var srcDir = path.join(tmpBase, entries[0]);
          try {
            fs.cpSync(srcDir, root, { recursive: true, force: true });
          } catch (e2) { fail('копирование файлов: ' + e2.message); return; }
          cleanup();
          cb(null);
        });
      })
      .catch(function (e) { if (t) clearTimeout(t); fail('скачивание: ' + (e && e.message ? e.message : e)); });
  }

  /** Применить обновление (гибрид) → cb(err). */
  function applyUpdate(root, cb) {
    if (!hasNode() || !root) { cb(new Error('Node.js/путь расширения недоступны')); return; }
    var fs = require('fs');
    if (fs.existsSync(root + '/.git')) updateViaGit(root, cb);
    else updateViaZip(root, cb);
  }

  global.SyncUpdater = {
    REPO: REPO, cmpVer: cmpVer, localVersion: localVersion,
    checkForUpdate: checkForUpdate, applyUpdate: applyUpdate
  };
})(typeof window !== 'undefined' ? window : this);
