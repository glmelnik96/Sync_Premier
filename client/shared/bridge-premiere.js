/**
 * Загрузка host/premiere-sync.jsx и вызовы ExtendScript с cold-start retry.
 * Адаптировано из родительского bridge-premiere.js (namespace $._SYNC_).
 */
(function (global) {
  var cs = new CSInterface();
  var hostLoaded = false;

  function escapeDoubleQuoted(s) {
    return s.replace(/\r/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  function extensionRoot() {
    var p = cs.getExtensionPath();
    return (p || '').replace(/\\/g, '/');
  }

  /* Известные timing-глитчи холодного старта CEP/ExtendScript — лечим повтором. */
  function isColdStartGlitch(s) {
    return s === 'EvalScript error.' || s === 'undefined' || s === '' || s === '__adobe_cep__ unavailable';
  }

  global.PremiereBridge = {
    ensureHost: function (callback) {
      if (hostLoaded) { if (callback) callback(null); return; }
      var attempt = 0;
      var DELAYS = [0, 300, 900];
      function tryLoad() {
        var root = extensionRoot();
        if (!root) {
          attempt++;
          if (attempt < DELAYS.length) setTimeout(tryLoad, DELAYS[attempt]);
          else if (callback) callback(new Error('Нет пути расширения (__adobe_cep__ unavailable)'));
          return;
        }
        var jsxPath = root + '/host/premiere-sync.jsx';
        var cmd = 'try{$.evalFile("' + jsxPath.replace(/"/g, '\\"') + '");"OK";}catch(e){"ERR:"+e.toString();}';
        cs.evalScript(cmd, function (res) {
          var s = String(res || '');
          if (s.indexOf('OK') !== -1) { hostLoaded = true; if (callback) callback(null); return; }
          attempt++;
          if (isColdStartGlitch(s) && attempt < DELAYS.length) setTimeout(tryLoad, DELAYS[attempt]);
          else if (callback) callback(new Error('Не удалось загрузить host/premiere-sync.jsx: ' + s));
        });
      }
      setTimeout(tryLoad, DELAYS[attempt]);
    },

    evalJson: function (expr, callback) {
      var TIMEOUT_MS = 30000;
      this.ensureHost(function (err) {
        if (err) { callback(err, null); return; }
        var state = 'pending';
        var finish = function (errArg, dataArg) {
          if (state !== 'pending') return;
          state = errArg ? 'timed_out' : 'completed';
          try { callback(errArg, dataArg); } catch (cbErr) {}
        };
        var timer = setTimeout(function () {
          finish(new Error('ExtendScript не ответил за ' + (TIMEOUT_MS / 1000) + 'с.'), null);
        }, TIMEOUT_MS);
        var attempt = 0;
        var DELAYS = [0, 250, 750];
        function tryEval() {
          cs.evalScript(expr, function (raw) {
            if (state !== 'pending') return;
            var s = typeof raw === 'string' ? raw : String(raw);
            if (isColdStartGlitch(s)) {
              attempt++;
              if (attempt < DELAYS.length) { setTimeout(tryEval, DELAYS[attempt]); return; }
              clearTimeout(timer);
              finish(new Error('ExtendScript вернул ошибку. raw=' + s), null);
              return;
            }
            clearTimeout(timer);
            try {
              var parsed = JSON.parse(s);
              if (parsed === null) { finish(new Error('Host вернул null'), null); return; }
              if (parsed && parsed._hostError === true) {
                finish(new Error('Host: [' + (parsed.fn || '?') + '] ' + (parsed.msg || '')), null);
                return;
              }
              finish(null, parsed);
            } catch (e) {
              finish(new Error('JSON от хоста: ' + String(raw).slice(0, 500)), null);
            }
          });
        }
        tryEval();
      });
    },

    getTimelineSnapshot: function (cb) { this.evalJson('$._SYNC_.getTimelineSnapshot()', cb); },

    getClipMediaPath: function (nodeId, cb) {
      var s = String(nodeId).replace(/"/g, '\\"');
      this.evalJson('$._SYNC_.getClipMediaPath("' + s + '")', cb);
    },

    moveClip: function (nodeId, deltaTicks, cb) {
      var json = escapeDoubleQuoted(JSON.stringify({ nodeId: nodeId, deltaTicks: deltaTicks }));
      this.evalJson('$._SYNC_.moveClip("' + json + '")', cb);
    },

    rippleCloseGaps: function (trackType, trackIndex, cb) {
      var json = escapeDoubleQuoted(JSON.stringify({ trackType: trackType, trackIndex: trackIndex }));
      this.evalJson('$._SYNC_.rippleCloseGaps("' + json + '")', cb);
    },

    setClipSpeed: function (nodeId, ratio, cb) {
      var json = escapeDoubleQuoted(JSON.stringify({ nodeId: nodeId, ratio: ratio }));
      this.evalJson('$._SYNC_.setClipSpeed("' + json + '")', cb);
    },

    backupActiveSequence: function (cb) { this.evalJson('$._SYNC_.backupActiveSequence()', cb); },

    activateSequenceById: function (seqId, cb) {
      var s = String(seqId).replace(/"/g, '\\"');
      this.evalJson('$._SYNC_.activateSequenceById("' + s + '")', cb);
    },

    refreshActiveSequence: function (cb) { this.evalJson('$._SYNC_.refreshActiveSequence()', cb); }
  };
})(window);
