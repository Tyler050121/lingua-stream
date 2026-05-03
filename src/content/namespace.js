(function initLinguaStreamNamespace() {
  window.LinguaStream = window.LinguaStream || {};
  window.LinguaStream.log = (...args) => console.debug("[LinguaStream]", ...args);
  window.LinguaStream.warn = (...args) => console.warn("[LinguaStream]", ...args);
})();
