(function () {
  const vscode = acquireVsCodeApi();
  const post = (message) => vscode.postMessage(message);
  const heading = document.getElementById('heading');
  const content = document.getElementById('content');
  const stepper = document.getElementById('stepper');
  const actions = document.getElementById('actions');
  let current;

  window.addEventListener('message', ({ data }) => {
    if (!data || typeof data !== 'object') return;
    // The kit loads the entry before its extra scripts.
    const page = window.nearGetStarted;
    if (!page) return;
    switch (data.type) {
      case 'screen': {
        const model = data.screen;
        if (!model || typeof model.heading !== 'string') return;
        const next = model.screen ?? model.kind;
        const sameScreen = next === current;
        const active = sameScreen ? document.activeElement : undefined;
        const activeId = active?.getAttribute('id');
        const draft = active?.getAttribute('type') === 'text' && active.value !== active.defaultValue
          ? active.value : undefined;
        const expanded = sameScreen && model.kind === 'options'
          ? [...content.querySelectorAll('[aria-expanded="true"]')].map(button => button.getAttribute('id')) : [];
        page.renderScreen(document, content, model, post);
        page.renderStepper(document, stepper, model);
        for (const id of expanded) {
          const button = document.getElementById(id);
          const panel = button && document.getElementById(button.getAttribute('aria-controls'));
          if (panel) {
            button.setAttribute('aria-expanded', 'true');
            panel.hidden = false;
          }
        }
        document.title = model.heading;
        heading.textContent = model.heading;
        if (!sameScreen) {
          heading.focus();
        } else if (activeId) {
          const replacement = document.getElementById(activeId);
          if (replacement && draft !== undefined) replacement.value = draft;
          (replacement ?? heading).focus();
        }
        current = next;
        break;
      }
      case 'progress':
      case 'announce':
        if (typeof data.text === 'string') page.announce(document, data.text);
        break;
    }
  });

  window.addEventListener('DOMContentLoaded', () => {
    // Match the scrolling clearance to the height of the footer, including when its buttons wrap.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        document.documentElement.style.setProperty('--guide-footer-height', actions.offsetHeight + 'px');
      }).observe(actions);
    }
    post({ type: 'ready' });
  }, { once: true });
})();
