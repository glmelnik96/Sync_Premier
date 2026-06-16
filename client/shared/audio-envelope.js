/**
 * ffmpeg → моно-PCM → RMS-огибающая @5мс. No-op без Node.js (CEP без <CEFCommandLine>).
 * findFfmpegPath/runFfmpeg адаптированы из родительского audio-preprocess.js.
 */
(function (global) {
  'use strict';

  var SAMPLE_RATE = 8000;
  var WINDOW_MS = 5;

  function hasNode() { return typeof require !== 'undefined'; }

  function findFfmpegPath() {
    if (!hasNode()) return null;
    var fs = require('fs');
    var cands = ['C:\\ffmpeg\\bin\\ffmpeg.exe', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
    for (var i = 0; i < cands.length; i++) { try { if (fs.existsSync(cands[i])) return cands[i]; } catch (e) {} }
    try {
      var execSync = require('child_process').execSync;
      var p = process.platform === 'win32'
        ? String(execSync('where ffmpeg', { timeout: 5000 })).trim().split('\n')[0]
        : String(execSync('which ffmpeg', { timeout: 5000 })).trim();
      if (p && fs.existsSync(p)) return p;
    } catch (e) {}
    return null;
  }

  /** Чистая функция: PCM Float32 → RMS-огибающая. Тестируется без ffmpeg. */
  function pcmToEnvelope(pcm, sampleRate, windowMs) {
    var sr = sampleRate || SAMPLE_RATE;
    var win = Math.max(1, Math.round((windowMs || WINDOW_MS) / 1000 * sr));
    var m = Math.floor(pcm.length / win);
    var env = new Float64Array(m);
    for (var k = 0; k < m; k++) {
      var s = 0;
      for (var j = 0; j < win; j++) { var v = pcm[k * win + j]; s += v * v; }
      env[k] = Math.sqrt(s / win);
    }
    return { dtSec: win / sr, env: env };
  }

  /** Извлечь огибающую из аудиофайла (опц. сегмент [startSec, durSec], опц. windowMs). */
  function extractEnvelope(path, opt) {
    opt = opt || {};
    var winMs = (typeof opt.windowMs === 'number') ? opt.windowMs : WINDOW_MS;
    return new Promise(function (resolve, reject) {
      if (!hasNode()) return reject(new Error('Node.js недоступен'));
      var bin = findFfmpegPath();
      if (!bin) return reject(new Error('ffmpeg не найден'));
      var args = ['-hide_banner', '-nostats', '-v', 'error'];
      if (opt.startSec != null) args.push('-ss', String(opt.startSec));
      if (opt.durSec != null) args.push('-t', String(opt.durSec));
      args.push('-i', path, '-map', '0:a:0?', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-');
      var execFile = require('child_process').execFile;
      execFile(bin, args, { timeout: 600000, maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer' },
        function (err, stdout) {
          if (err && !(stdout && stdout.length)) return reject(new Error('ffmpeg: ' + String(err.message || err)));
          var buf = stdout;
          var n = Math.floor(buf.length / 2);
          var pcm = new Float32Array(n);
          for (var i = 0; i < n; i++) pcm[i] = buf.readInt16LE(i * 2) / 32768;
          resolve(pcmToEnvelope(pcm, SAMPLE_RATE, winMs));
        });
    });
  }

  global.AudioEnvelope = {
    SAMPLE_RATE: SAMPLE_RATE, WINDOW_MS: WINDOW_MS,
    hasNode: hasNode, findFfmpegPath: findFfmpegPath,
    pcmToEnvelope: pcmToEnvelope, extractEnvelope: extractEnvelope
  };
})(typeof window !== 'undefined' ? window : this);
