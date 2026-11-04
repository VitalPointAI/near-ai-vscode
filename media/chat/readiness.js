// Declared only (61-25 RED): the sidebar's one profile-readiness rule.
(function (root) {
  'use strict';

  function missing() { throw new Error('not implemented'); }
  const api = Object.freeze({ welcomeState: missing, isReady: missing, track: missing, current: missing, onChange: missing });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearReadiness = api;
})(typeof window === 'undefined' ? globalThis : window);
