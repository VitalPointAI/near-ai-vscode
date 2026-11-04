// Test-only stub for the RED step of Phase 62 plan 16 task 2; the board layout probe arrives in the GREEN commit.
(function () {
  'use strict';
  if (!document.body || document.body.getAttribute('data-e2e') !== '1') return;
  window.NearAiBoardLayout = { collect: function () { return {}; }, check: function () { return []; }, measure: function () { return Promise.resolve({}); } };
})();
