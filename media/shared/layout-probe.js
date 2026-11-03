// Test-only: loaded only when the extension-host tests run (NEAR_AI_E2E=1) and never published
// (.vscodeignore). Each page's script answers a 'layout-probe' message from the host with this
// measurement, so the tests can check that no page scrolls sideways at a given panel width.
(function () {
  // Boxes that scroll sideways on purpose: code and diffs (wrapping code would mislead), the chat's
  // conversation tab strip, and Markdown tables inside a chat reply.
  const ALLOWED = 'pre, .code-block, #conversation-tabs, .turn .table-wrap, .approval';
  const describe = (node) => node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\s+/).join('.') : '');
  // True when an ancestor below <body> scrolls or clips sideways, so the node cannot widen the page.
  const contained = (node) => {
    for (let parent = node.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX !== 'visible') return true;
    }
    return false;
  };
  window.nearAiLayoutProbe = function () {
    const doc = document.documentElement;
    const width = window.innerWidth;
    const edge = doc.clientWidth;
    const offenders = [];
    const scrollers = [];
    for (const node of document.body.querySelectorAll('*')) {
      const rect = node.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      if (rect.right > edge + 1 && !contained(node)) offenders.push(describe(node) + ' ends at ' + Math.round(rect.right) + 'px');
      const overflow = getComputedStyle(node).overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth + 1 && !node.closest(ALLOWED)) {
        scrollers.push(describe(node) + ' is ' + node.scrollWidth + 'px wide in ' + node.clientWidth + 'px');
      }
    }
    return {
      type: 'layout-probe-result', width, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth, bodyClientWidth: document.body.clientWidth,
      offenders: offenders.slice(0, 25), scrollers: scrollers.slice(0, 25)
    };
  };
})();
