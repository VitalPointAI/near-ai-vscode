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
  // On request, sets the page's text in a wider stand-in font (monospace, 10% larger), once, so a
  // layout that only overflows with another machine's wider fonts shows up here too.
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'layout-stress' || document.documentElement.dataset.layoutStress) return;
    const root = document.documentElement;
    root.dataset.layoutStress = 'true';
    const size = parseFloat(getComputedStyle(root).getPropertyValue('--vscode-font-size')) || 13;
    root.style.setProperty('--vscode-font-family', 'monospace');
    root.style.setProperty('--vscode-font-size', Math.round(size * 1.1) + 'px');
  });
  // On request, does what a person would on the map (D-48 of 0.4.34): opens the visible layer drawer, presses Escape where focus is, or toggles
  // the full map; or clicks one button by its selector, so a test can drive a card's button in the real page. Test-only, like the rest of this file.
  window.addEventListener('message', (event) => {
    if (!event.data) return;
    if (event.data.type === 'layout-click' && typeof event.data.selector === 'string') {
      const node = document.querySelector(event.data.selector);
      if (node && typeof node.click === 'function') node.click();
      return;
    }
    if (event.data.type !== 'layout-act') return;
    const visible = (node) => node && node.getClientRects().length > 0;
    const act = event.data.act;
    if (act === 'open-layers') { const button = [...document.querySelectorAll('.ld-button')].find(visible); if (button) button.click(); }
    if (act === 'full-map') { const button = [...document.querySelectorAll('.map-full')].find(visible); if (button) button.click(); }
    if (act === 'escape') (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    // The COP map's ground (imagery, topographic, 3D terrain): set a base, turn 3D on or off, look somewhere, or take a picture of the map canvas.
    const cop = window.nearCopMap && window.nearCopMap.views ? window.nearCopMap.views()[0] : undefined;
    if (cop && act === 'map-base' && typeof event.data.base === 'string') cop.setBase(event.data.base);
    if (cop && act === 'map-terrain') cop.setTerrain(Boolean(event.data.on));
    if (cop && act === 'map-projection') cop.setProjection(event.data.projection === 'globe' ? 'globe' : 'map');
    if (cop && act === 'map-look' && event.data.camera) cop.look(event.data.camera);
    if (cop && act === 'map-snapshot' && cop.snapshot) { window.__nearMapSnapshot = undefined; cop.snapshot().then((url) => { window.__nearMapSnapshot = url; }, () => { window.__nearMapSnapshot = ''; }); }
  });
  // Every content security policy violation the page meets from the moment this script loads, so a test can tell a page that works under its
  // policy from one the policy quietly broke.
  const violations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    if (violations.length < 25) violations.push(event.violatedDirective + ' blocked ' + String(event.blockedURI || 'inline').slice(0, 120));
  });
  window.nearAiLayoutProbe = function () {
    const doc = document.documentElement;
    const width = window.innerWidth;
    const edge = doc.clientWidth;
    const offenders = [];
    const scrollers = [];
    // Controls marked data-must-read hold words a person has to read whole (the profile name, the sync state): a control whose text is wider
    // than its box (cut to an ellipsis or clipped) is reported, because that is invisible to the sideways-overflow checks above.
    const clipped = [];
    for (const node of document.body.querySelectorAll('[data-must-read]')) {
      const rect = node.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      if (node.scrollWidth > node.clientWidth + 1) clipped.push(describe(node) + ' text "' + (node.textContent || '').trim().slice(0, 40) + '" needs ' + node.scrollWidth + 'px in ' + node.clientWidth + 'px');
    }
    for (const node of document.body.querySelectorAll('*')) {
      const rect = node.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      if (rect.right > edge + 1 && !contained(node)) offenders.push(describe(node) + ' ends at ' + Math.round(rect.right) + 'px');
      const overflow = getComputedStyle(node).overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth + 1 && !node.closest(ALLOWED)) {
        scrollers.push(describe(node) + ' is ' + node.scrollWidth + 'px wide in ' + node.clientWidth + 'px');
      }
    }
    // Every image on the page and whether it decoded (naturalWidth above 0), so a test can tell an image that renders from a broken one.
    const images = [...document.body.querySelectorAll('img')].slice(0, 25).map((node) => ({ element: describe(node), naturalWidth: node.naturalWidth, complete: node.complete }));
    // Every trust badge under an answer, with its state and the title it shows, so a test can tell which answers carry one.
    const trustBadges = [...document.body.querySelectorAll('.trust-badge')].slice(0, 50).map((node) => ({ state: node.getAttribute('data-state') || '', title: ((node.querySelector('.trust-title') || node).textContent || '').trim() }));
    return {
      type: 'layout-probe-result', width, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth, bodyClientWidth: document.body.clientWidth,
      offenders: offenders.slice(0, 25), scrollers: scrollers.slice(0, 25), clipped: clipped.slice(0, 25), images, trustBadges,
      cspViolations: violations.slice(),
      // The COP map, where a page has one: whether MapLibre drew into a canvas, and the line the map shows when it fell back.
      map: (function () {
        const canvas = document.querySelector('canvas.maplibregl-canvas');
        const note = document.querySelector('.mapnote:not([hidden])');
        // Where the map's box is in the page's viewport, the open layer drawer and where focus is, and whether the full map is on.
        const box = [...document.querySelectorAll('.mapbox')].find((node) => node.getClientRects().length > 0);
        const rect = box ? box.getBoundingClientRect() : undefined;
        const panel = [...document.querySelectorAll('.ld-panel')].find((node) => !node.hidden && node.getClientRects().length > 0);
        const active = document.activeElement;
        return {
          maplibre: Boolean(canvas && canvas.width > 0 && canvas.height > 0), cop: Boolean(document.querySelector('.has-cop')), note: note ? (note.textContent || '').trim().slice(0, 200) : '',
          box: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height), viewport: window.innerHeight, scrollY: Math.round(window.scrollY) } : undefined,
          full: Boolean(box && box.classList.contains('full')),
          drawer: { open: Boolean(panel), focusInside: Boolean(panel && active && panel.contains(active)), buttonFocused: Boolean(active && active.classList && active.classList.contains('ld-button')), switches: panel ? panel.querySelectorAll('[role="switch"]').length : 0 },
          // The ground's state and the 3D height at Harrow Ridge's crest (KQ 4829, by the frame's linear transform), and every origin the page loaded from.
          ground: (function () {
            const cop = window.nearCopMap && window.nearCopMap.views ? window.nearCopMap.views()[0] : undefined;
            if (!cop) return undefined;
            try {
              const g = cop.inspect([-123.4208, -49.0655]);
              return { base: g.base, terrain: g.terrain, terrainReason: g.terrainReason, projection: g.projection, renderer: g.renderer, height: g.height, tiles: g.tiles, errors: g.errors, pitch: g.pitch, onMap: g.onMap, camera: g.camera };
            } catch (error) { return { base: '', terrain: '', terrainReason: String(error && error.message), projection: '', renderer: '' }; }
          })(),
          origins: [...new Set((performance.getEntriesByType ? performance.getEntriesByType('resource') : []).map((entry) => { try { return new URL(entry.name).origin; } catch (error) { return 'unparsed'; } }))].slice(0, 20),
          snapshot: typeof window.__nearMapSnapshot === 'string' ? window.__nearMapSnapshot : undefined
        };
      })(),
      composer: (function () {
        const box = document.getElementById('input');
        return box && typeof box.value === 'string' ? { value: box.value.slice(0, 400), caret: typeof box.selectionStart === 'number' ? box.selectionStart : null } : undefined;
      })(),
      cards: (function () {
        if (!document.getElementById('welcome')) return undefined;
        const staff = document.getElementById('staff-teams');
        return { staffTeams: staff ? (staff.textContent || '').slice(0, 400) : undefined, setupNudge: Boolean(document.getElementById('setup-nudge')) };
      })()
    };
  };
})();
