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

  /** HTTP GET через Node https (НЕ браузерный fetch: у панели origin file:// →
      codeload режется CORS'ом; Node-запросам CORS не писан). Редиректы ≤5,
      таймаут на весь запрос → cb(err, Buffer). cb гарантированно один раз. */
  function httpGet(url, timeoutMs, cb, redirectsLeft) {
    if (redirectsLeft === undefined) redirectsLeft = 5;
    var https = require('https');
    var done = false;
    function once(err, buf) { if (!done) { done = true; cb(err, buf); } }
    var req = https.get(url, { headers: { 'User-Agent': 'SyncPremier-Updater' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        done = true;
        httpGet(res.headers.location, timeoutMs, cb, redirectsLeft - 1);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); once(new Error('HTTP ' + res.statusCode)); return; }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { once(null, Buffer.concat(chunks)); });
      res.on('error', function (e) { once(e); });
    });
    req.setTimeout(timeoutMs, function () { req.destroy(new Error('таймаут ' + Math.round(timeoutMs / 1000) + 'с')); });
    req.on('error', function (e) { once(e); });
  }

  /** Проверка обновления → cb(err, {current, latest, hasUpdate}).
      Нет version на main / сеть недоступна → err (вызывающий решает, шуметь ли). */
  function checkForUpdate(root, cb) {
    if (!hasNode()) { cb(new Error('Node.js недоступен в панели')); return; }
    var current = localVersion(root);
    httpGet(RAW_PKG_URL, FETCH_TIMEOUT_MS, function (err, buf) {
      if (err) { cb(new Error('проверка обновлений: ' + err.message)); return; }
      var latest = null;
      try { latest = JSON.parse(buf.toString('utf8')).version || null; } catch (e) {}
      if (!latest) { cb(new Error('на main нет поля version')); return; }
      cb(null, { current: current, latest: latest,
        hasUpdate: current != null && cmpVer(current, latest) < 0 });
    });
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

    httpGet(ZIP_URL, ZIP_TIMEOUT_MS, function (errDl, buf) {
      if (errDl) { fail('скачивание: ' + errDl.message); return; }
      fs.writeFileSync(zipPath, buf);
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
    });
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
