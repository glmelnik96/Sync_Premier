/** Рендер огибающих на canvas. downsampleEnvelope — чистая (max-пулинг по бинам). */
(function (global) {
  'use strict';

  function downsampleEnvelope(env, targetPx) {
    var n = Math.max(1, targetPx);
    var out = new Float64Array(n);
    var per = env.length / n;
    for (var i = 0; i < n; i++) {
      var lo = Math.floor(i * per), hi = Math.floor((i + 1) * per), mx = 0;
      for (var j = lo; j < hi && j < env.length; j++) if (env[j] > mx) mx = env[j];
      out[i] = mx;
    }
    return out;
  }

  function drawPair(canvas, refEnv, clipEnv, shiftSamples) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height, mid = H / 2;
    ctx.clearRect(0, 0, W, H);
    function drawRow(env, yMid, color, offsetPx) {
      var ds = downsampleEnvelope(env, W);
      var mx = 1e-9; for (var i = 0; i < ds.length; i++) if (ds[i] > mx) mx = ds[i];
      ctx.strokeStyle = color; ctx.beginPath();
      for (var x = 0; x < W; x++) {
        var v = ds[x] / mx * (H / 2 - 2);
        var px = x + (offsetPx || 0);
        ctx.moveTo(px, yMid - v); ctx.lineTo(px, yMid + v);
      }
      ctx.stroke();
    }
    drawRow(refEnv, mid / 2, '#6c9', 0);
    var pxPerSample = W / Math.max(refEnv.length, clipEnv.length);
    drawRow(clipEnv, mid + mid / 2, '#c96', Math.round(shiftSamples * pxPerSample));
  }

  global.SyncWaveform = { downsampleEnvelope: downsampleEnvelope, drawPair: drawPair };
})(typeof window !== 'undefined' ? window : this);
