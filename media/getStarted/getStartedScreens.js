(function (scope) {
  function element(doc, tag, text, attributes = {}) {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  function paragraph(doc, parent, text, className) {
    if (!text) return;
    const node = element(doc, 'p', text);
    if (className) node.className = className;
    parent.append(node);
  }

  function button(doc, text, click, id, className = 'secondary') {
    const node = element(doc, 'button', text, { type: 'button', id });
    node.className = className;
    node.addEventListener('click', click);
    return node;
  }

  function setDisabled(node, disabled) {
    if (disabled) node.setAttribute('disabled', '');
    else node.removeAttribute('disabled');
  }

  function action(doc, actions, post, text, type, primary = false, enabled = true) {
    if (!text) return;
    const node = button(doc, text, () => {
      if (enabled) post({ type });
    }, 'guide-action-' + type, primary ? 'primary' : 'secondary');
    setDisabled(node, !enabled);
    actions.append(node);
  }

  function fieldset(doc, heading) {
    const group = element(doc, 'fieldset');
    group.append(element(doc, 'legend', heading));
    return group;
  }

  function labeledInput(doc, parent, id, type, text) {
    const input = element(doc, 'input', undefined, { type, id });
    const label = element(doc, 'label', text, { for: id });
    if (type === 'text') parent.append(label, input);
    else parent.append(input, label);
    return input;
  }

  function textField(doc, parent, id, label, value, maxLength, onChange) {
    const row = element(doc, 'div', undefined, { class: 'text-field' });
    const input = labeledInput(doc, row, id, 'text', label);
    input.setAttribute('maxlength', String(maxLength));
    input.defaultValue = input.value = value ?? '';
    input.addEventListener('change', () => {
      input.defaultValue = input.value;
      onChange(input.value.slice(0, maxLength));
    });
    parent.append(row);
  }

  function questionField(doc, root, field, heading, post) {
    const answer = (value) => post({ type: 'answer', key: field.key, value });
    if (field.kind === 'text') {
      textField(doc, root, 'guide-' + field.key, field.heading ?? heading, field.selected[0], field.maxLength, answer);
      return;
    }
    const group = fieldset(doc, field.heading ?? heading);
    const inputs = field.choices.map(({ value, text }) => {
      const row = element(doc, 'div', undefined, { class: 'choice' });
      const input = labeledInput(doc, row, 'guide-' + field.key + '-' + value, field.kind, text);
      input.setAttribute('name', field.key);
      input.value = value;
      input.checked = field.selected.includes(value);
      group.append(row);
      return input;
    });
    for (const input of inputs) input.addEventListener('change', () => {
      answer(field.kind === 'checkbox' ? inputs.filter(node => node.checked).map(node => node.value) : input.value);
    });
    root.append(group);
  }

  function textList(doc, parent, items) {
    if (!items.length) return;
    const list = element(doc, 'ul');
    list.append(...items.map(text => element(doc, 'li', text)));
    parent.append(list);
  }

  function disclosure(doc, parent, id, label, panel) {
    const wrapper = element(doc, 'div', undefined, { class: 'disclosure' });
    const toggle = button(doc, label, () => expand(panel.hidden), id + '-button');
    toggle.setAttribute('aria-controls', id);
    panel.setAttribute('id', id);
    function expand(open) {
      toggle.setAttribute('aria-expanded', String(open));
      panel.hidden = !open;
    }
    wrapper.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) {
        event.preventDefault();
        expand(false);
        toggle.focus();
      }
    });
    expand(false);
    wrapper.append(toggle, panel);
    parent.append(wrapper);
  }

  function optionCard(doc, card, model, post) {
    const id = 'guide-option-' + card.optionId;
    const titleId = id + '-title';
    const article = element(doc, 'article', undefined, { class: 'card', 'aria-labelledby': titleId });
    article.setAttribute('data-outcome', card.outcome);
    const heading = element(doc, 'h2', undefined, { class: 'choice' });
    const input = labeledInput(doc, heading, id, 'radio', card.title);
    heading.children[1].setAttribute('id', titleId);
    input.value = card.optionId;
    article.append(heading);

    if (card.outcome === 'ruled-out') {
      // “Not for this work” arrives in outcomeText. A separate tab stop lets the user
      // hear the refusal without adding this radio to the native selection group.
      input.setAttribute('aria-disabled', 'true');
      input.setAttribute('aria-describedby', card.describedById);
      input.addEventListener('click', event => event.preventDefault());
      input.addEventListener('keydown', (event) => {
        if (event.key === ' ' || event.key === 'Enter') event.preventDefault();
      });
      const reason = element(doc, 'div', undefined, { id: card.describedById });
      paragraph(doc, reason, card.outcomeText, 'outcome');
      paragraph(doc, reason, card.reason);
      article.append(reason);
    } else {
      input.setAttribute('name', 'guide-option');
      input.checked = model.chosen === card.optionId;
      input.addEventListener('change', () => post({ type: 'choose', optionId: card.optionId }));
    }

    if (card.outcome === 'recommended') {
      paragraph(doc, article, model.reason);
      const facts = element(doc, 'div');
      textList(doc, facts, [card.lines.where, card.lines.proven, card.lines.notProven].filter(Boolean));
      if (facts.children.length) disclosure(doc, article, id + '-why', model.whyText, facts);
    }
    const details = element(doc, 'dl', undefined, { class: 'card-lines' });
    for (const [key, label] of Object.entries(model.cardLabels)) {
      details.append(element(doc, 'dt', label), element(doc, 'dd', card.lines[key]));
    }
    article.append(details);
    paragraph(doc, article, card.approvalNote, 'hint');
    paragraph(doc, article, card.trustLine, 'trust-line');
    return article;
  }

  function unavailableOptions(doc, root, model, post) {
    if (!model.notAvailable.length) return;
    const panel = element(doc, 'ul');
    for (const { title, reason, optionId, fix } of model.notAvailable) {
      const row = element(doc, 'li');
      row.append(element(doc, 'h2', title));
      paragraph(doc, row, reason);
      if (fix) row.append(button(doc, fix.label, () => post({ type: 'fix', optionId, action: fix.action }), 'guide-fix-' + optionId));
      panel.append(row);
    }
    disclosure(doc, root, 'guide-unavailable', model.notAvailableText, panel);
  }

  function foundServers(doc, root, model, post) {
    if (!model.candidates.length) return;
    const list = element(doc, 'ul');
    for (const { id, name, host, port, stateText, action: candidateAction, actionText } of model.candidates) {
      const row = element(doc, 'li');
      row.append(element(doc, 'h3', name));
      paragraph(doc, row, `${host}:${port}`, 'hint');
      paragraph(doc, row, stateText);
      if (candidateAction === 'approve' && actionText) {
        row.append(button(doc, actionText, () => post({ type: 'approve-candidate', candidateId: id }), 'guide-approve-' + id));
      } else if (candidateAction === 'ask') paragraph(doc, row, actionText);
      list.append(row);
    }
    root.append(element(doc, 'h2', model.candidatesHeading), list);
  }

  function scanOffer(doc, root, scan, post) {
    if (!scan.running && !scan.offered && !scan.reasonOff) return;
    root.append(element(doc, 'h2', scan.label));
    if (scan.running) {
      paragraph(doc, root, scan.progress);
      if (scan.progress) announce(doc, scan.progress);
      root.append(button(doc, scan.stopLabel, () => post({ type: 'scan-stop' }), 'guide-scan-stop'));
    } else if (scan.offered && scan.confirmText && scan.ranges.length) {
      paragraph(doc, root, scan.confirmText);
      root.append(button(doc, scan.confirmLabel, () => post({ type: 'scan-confirm', ranges: scan.ranges }), 'guide-scan-confirm'));
    } else paragraph(doc, root, scan.reasonOff);
  }

  function optionsScreen(doc, root, actions, model, post) {
    paragraph(doc, root, model.checkedOn, 'hint');
    const group = fieldset(doc, model.heading);
    const cards = element(doc, 'div', undefined, { class: 'cards' });
    for (const card of [...model.recommended, ...model.available, ...model.ruledOut]) cards.append(optionCard(doc, card, model, post));
    group.append(cards);
    root.append(group);

    if (model.needsReason && model.reasonPrompt) {
      textField(doc, root, 'guide-choice-reason', model.reasonPrompt, model.choiceReason, 200,
        text => post({ type: 'reason', text }));
    }
    unavailableOptions(doc, root, model, post);
    foundServers(doc, root, model, post);
    scanOffer(doc, root, model.scan, post);
    action(doc, actions, post, model.reviewText, 'review', true, model.canReview);
  }

  function checkScreen(doc, root, actions, model, post) {
    if (model.answers.length) {
      const summary = element(doc, 'dl', undefined, { class: 'answer-summary' });
      for (const { key, label, value, source, screen, changeText, changeLabel } of model.answers) {
        const answer = element(doc, 'dd');
        for (const text of value) paragraph(doc, answer, text);
        paragraph(doc, answer, source, 'hint');
        if (screen && changeText) {
          const change = button(doc, changeText, () => post({ type: 'change', screen }), 'guide-change-' + key, 'link-button');
          change.setAttribute('aria-label', changeLabel ?? changeText);
          answer.append(change);
        }
        summary.append(element(doc, 'dt', label), answer);
      }
      root.append(summary);
    }
    if (model.agentWork) questionField(doc, root, model.agentWork, model.heading, post);
    if (model.modeRow) {
      const { name, join, source } = model.modeRow;
      paragraph(doc, root, [name, join, source].join(' '));
    }
    paragraph(doc, root, model.nothingChangedText);
    for (const group of model.groups) {
      root.append(element(doc, 'h2', group.title));
      textList(doc, root, group.items.map(item => item.text));
    }
    paragraph(doc, root, model.clearanceText);
    paragraph(doc, root, model.lowerLabelText);

    let confirm;
    if (model.confirmRemovalText) {
      const row = element(doc, 'div', undefined, { class: 'choice' });
      confirm = labeledInput(doc, row, 'guide-confirm-removal', 'checkbox', model.confirmRemovalText);
      root.append(row);
    }
    const canApply = () => model.canApply && (!confirm || confirm.checked);
    const apply = button(doc, model.applyText, () => {
      if (canApply()) post(confirm ? { type: 'apply', confirmRemoval: true } : { type: 'apply' });
    }, 'guide-apply', 'primary');
    setDisabled(apply, !canApply());
    if (confirm) confirm.addEventListener('change', () => setDisabled(apply, !canApply()));
    actions.append(apply);
  }

  function report(doc, root, heading, rows) {
    if (!rows.length) return;
    const list = element(doc, 'ul');
    for (const { text, message } of rows) {
      const item = element(doc, 'li');
      paragraph(doc, item, text);
      paragraph(doc, item, message, 'hint');
      list.append(item);
    }
    root.append(element(doc, 'h2', heading), list);
  }

  function renderScreen(doc, root, model, post) {
    const actions = doc.getElementById('actions');
    root.replaceChildren();
    actions.replaceChildren();
    doc.getElementById('who-to-ask').textContent = model.whoToAsk;
    if (model.kind === 'fix') {
      paragraph(doc, root, model.sentence);
      return;
    }
    paragraph(doc, root, model.startingRules, 'hint');
    action(doc, actions, post, model.backText, 'back');
    action(doc, actions, post, model.pauseText, 'pause');
    switch (model.kind) {
      case 'question':
        for (const field of model.fields) questionField(doc, root, field, model.heading, post);
        action(doc, actions, post, model.nextText, 'next', true, model.canContinue);
        break;
      case 'checking':
        paragraph(doc, root, model.checkedOn, 'hint');
        paragraph(doc, root, model.progress);
        announce(doc, model.progress);
        textList(doc, root, model.slow);
        action(doc, actions, post, model.continueText, 'continue-without-slow', true);
        break;
      case 'options':
        optionsScreen(doc, root, actions, model, post);
        break;
      case 'check':
        checkScreen(doc, root, actions, model, post);
        break;
      case 'stopped':
        paragraph(doc, root, model.sentence);
        paragraph(doc, root, model.approvedDevice);
        action(doc, actions, post, model.nextText, 'next', true);
        break;
      case 'applying':
        break;
      case 'done':
        paragraph(doc, root, model.landing?.note);
        report(doc, root, model.doneHeading, model.done);
        report(doc, root, model.notDoneHeading, model.notDone);
        action(doc, actions, post, model.restartText, 'change-answers', true);
        break;
    }
  }

  function renderStepper(doc, list, model) {
    list.replaceChildren();
    for (const step of model.steps) {
      const item = element(doc, 'li', undefined, { 'data-state': step.state });
      if (step.state === 'current') item.setAttribute('aria-current', 'step');
      if (step.state === 'completed') {
        const completed = element(doc, 'span', model.completedText + ' ');
        completed.className = 'visually-hidden';
        item.append(completed);
      }
      item.append(element(doc, 'span', step.text));
      list.append(item);
    }
  }

  function announce(doc, text) {
    const live = doc.getElementById('live');
    if (live.textContent !== text) live.textContent = text;
  }

  const api = { renderScreen, renderStepper, announce };
  if (typeof module !== 'undefined') module.exports = api;
  else scope.nearGetStarted = api;
})(typeof window === 'undefined' ? globalThis : window);
