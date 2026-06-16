(function () {
  'use strict';
  var statusEl = document.getElementById('status');
  function setStatus(s) { statusEl.textContent = s; }

  document.getElementById('analyze').addEventListener('click', function () {
    setStatus('Модули: SyncCore=' + (!!window.SyncCore) +
      ' AudioEnvelope=' + (!!window.AudioEnvelope) +
      ' Node=' + (window.AudioEnvelope ? window.AudioEnvelope.hasNode() : false));
  });

  setStatus('Готово к анализу.');
})();
