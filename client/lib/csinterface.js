/**
 * Упрощённый CSInterface для CEP 11 (полная версия — в Adobe CEP Samples).
 */
function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
  if (window.__adobe_cep__) {
    window.__adobe_cep__.evalScript(script, callback);
  } else if (callback) {
    callback('__adobe_cep__ unavailable');
  }
};

CSInterface.prototype.getExtensionPath = function () {
  return this.getSystemPath('extension');
};

CSInterface.prototype.getSystemPath = function (pathType) {
  var p = window.__adobe_cep__ ? window.__adobe_cep__.getSystemPath(pathType) : '';
  return p || '';
};
