// The J5, J3 and J4 workspaces of the Staff Room (UX concept 5.6 to 5.11; owner direction 2026-11-19). Each section gets its own view of the run, drawn
// only from the host's model (src/domain/staff/staffRoomWorkspaces.ts): no demo data lives here. Gold is a person's decision and nothing else, violet is
// agent work, green is delivered. Decision buttons are the room's own (staffRoom.js decisionItem): they post only the product and the version hash the
// person saw, and the host runs the signed, person-only command. Movement is only transform and opacity, and none of it happens under reduced motion or
// Calm; every value is also in words. Long registers are shown a page at a time, so a large project stays fast. Every text goes in with textContent.
(function () {
  const PAGE = 40;
  const TABS = {
    j5: [['cells', 'COA cells'], ['compare', 'Comparison'], ['wargame', 'Wargame'], ['brief', 'Decision brief'], ['annexes', 'Annexes']],
    j3: [['current', 'Current ops'], ['dsm', 'DSM'], ['sync', 'Sync matrix'], ['fragos', 'FRAGOs'], ['rhythm', 'Battle rhythm']],
    j4: [['logstat', 'LOGSTAT'], ['calcs', 'Calculators'], ['movement', 'Movement and readiness'], ['support', 'Supportability'], ['annex', 'Logistics annex']]
  };
  const LEAD = {
    j5: 'Plans: COA cells work side by side, the comparison runs against the criteria a person approved, and the commander decides.',
    // renderJ3 rewrites the J3 line and its FRAGO tab in the profile's words (FRAGORD, or Frag O under NATO/Canadian).
    j3: 'Operations: the current picture, the decision support matrix and the battle rhythm. Every FRAGO is a draft until a person releases it.',
    j4: 'Logistics: every number comes from a calculator record that shows its formula. The J4 never commits resources; a person decides.'
  };

  function create(h) {
    const panes = new Map();
    const shown = new Map();
    // Every event log entry the page has seen, by id, across the whole log (not only the page shown): an escalation is announced wherever it is. A new
    // entry moves once, when it is first drawn (on this page or a later one); an old row never moves when paging.
    let seenLog = new Set();
    let toRise = new Set();
    let first = true;

    /** A list shown a page at a time: the rest stays one press away, so a register of thousands of rows never slows the room. */
    function paged(container, key, items, draw, empty) {
      if (!items.length) { if (empty) container.append(h.el('p', 'faint', empty)); return; }
      const limit = shown.get(key) || PAGE;
      const list = items.slice(0, limit);
      for (const item of list) draw(item, container);
      if (items.length > limit) {
        const more = h.button('Show ' + Math.min(PAGE, items.length - limit) + ' more of ' + (items.length - limit), 'ghost small more', () => { shown.set(key, limit + PAGE); render(h.model()); });
        container.append(more);
      }
    }

    /**
     * Makes a card that is not a button open something, from the pointer and from the keyboard alike: it takes focus, and Enter or Space on the card
     * itself (not on a control inside it) does what a click does. Every clickable card in the workspaces goes through here (drop 2 review).
     */
    function opener(node, action, hint) {
      node.tabIndex = 0;
      node.classList.add('opens');
      if (hint) node.setAttribute('aria-label', (node.getAttribute('aria-label') || '') + '. ' + hint);
      node.addEventListener('click', action);
      node.addEventListener('keydown', (event) => {
        if (event.target !== node || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        action();
      });
    }

    function stat(text, cls, label) { const chip = h.el('span', 'ws-stat ' + (cls || ''), text); if (label) chip.setAttribute('aria-label', label); return chip; }

    function build(id, pane) {
      const root = h.el('div', 'ws ws-' + id);
      const head = h.el('header', 'ws-h');
      const mark = h.el('div', 'ws-mark');
      mark.append(h.glyph(h.GLYPH[id], 'big'));
      const titles = h.el('div', 'ws-titles');
      const title = h.el('h2', '', '');
      title.id = 'ws-title-' + id;
      const lead = h.el('p', 'muted ws-lead', LEAD[id]);
      titles.append(title, lead);
      const stats = h.el('div', 'ws-stats');
      head.append(mark, titles, stats);
      const problems = h.el('div', 'problems');
      const decide = h.el('section', 'ws-decide');
      decide.setAttribute('aria-label', 'Decisions waiting for a named person in this section');
      decide.hidden = true;
      const body = h.el('div', 'ws-body');
      const main = h.el('div', 'ws-main');
      const tabs = h.el('div', 'subtabs');
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', id.toUpperCase() + ' views');
      const panels = h.el('div', 'subpanels');
      const tabButtons = new Map();
      const panelNodes = new Map();
      for (const [key, label] of TABS[id]) {
        const tab = h.el('button', 'subtab');
        tab.type = 'button';
        tab.id = id + 'tab-' + key;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', id + 'panel-' + key);
        tab.dataset.view = key;
        tab.append(h.el('span', '', label), h.el('span', 'count mono', ''));
        tab.addEventListener('click', () => showTab(id, key, true));
        tab.addEventListener('keydown', (event) => h.roving(event, [...tabButtons.values()], (next) => showTab(id, next.dataset.view, true)));
        tabButtons.set(key, tab);
        tabs.append(tab);
        const panel = h.el('div', 'subpanel');
        panel.id = id + 'panel-' + key;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
        panel.tabIndex = -1;
        panelNodes.set(key, panel);
        panels.append(panel);
      }
      let mapSlot;
      if (id === 'j3') {
        mapSlot = h.el('div', 'mapslot ws-map');
        mapSlot.setAttribute('aria-label', 'Common operational picture');
        panelNodes.get('current').append(mapSlot);
      }
      main.append(tabs, panels);
      const side = h.el('aside', 'ws-side');
      side.setAttribute('aria-label', id.toUpperCase() + ' products and agent work');
      const products = h.el('section', 'ws-products');
      products.append(h.el('h3', 'kicker', 'Products, owners and release state'));
      const productList = h.el('ol', 'ws-prodlist');
      products.append(productList);
      const agents = h.el('section', 'ws-agents');
      agents.append(h.el('h3', 'kicker ai-kicker', 'Agent work in this section'));
      const activity = h.el('ol', 'ws-activity');
      activity.setAttribute('aria-label', 'Agent work, newest first');
      agents.append(activity);
      side.append(products, agents);
      body.append(main, side);
      root.append(head, problems, decide, body);
      pane.replaceChildren(root);
      panes.set(id, { root, title, lead, stats, problems, decide, tabButtons, panelNodes, productList, activity, mapSlot });
    }

    function showTab(id, key, byUser) {
      const ws = panes.get(id);
      if (!ws || !ws.tabButtons.has(key)) return;
      const state = h.saved.wsTabs || (h.saved.wsTabs = {});
      const changed = state[id] !== key;
      state[id] = key;
      h.save();
      for (const [name, tab] of ws.tabButtons) { tab.setAttribute('aria-selected', name === key ? 'true' : 'false'); tab.tabIndex = name === key ? 0 : -1; }
      for (const [name, panel] of ws.panelNodes) panel.hidden = name !== key;
      const panel = ws.panelNodes.get(key);
      if (byUser && changed) h.anim(panel, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 200 });
    }

    // ---------- shared parts ----------
    function sectionHead(id, model) {
      const ws = panes.get(id);
      const data = model[id];
      const squad = model.squads.find((entry) => entry.section === id);
      h.setText(ws.title, (squad ? squad.name : id.toUpperCase()) + ' workspace');
      const decisions = model.decisions.filter((card) => card.section === id);
      const working = squad ? squad.members.filter((member) => member.state === 'working').length : 0;
      ws.stats.replaceChildren(
        stat(data.products.length + (data.products.length === 1 ? ' product' : ' products'), ''),
        stat(decisions.length + ' for a person', decisions.length ? 'human' : '', decisions.length + ' decisions waiting for a named person'),
        stat(working + ' agent' + (working === 1 ? '' : 's') + ' working', working ? 'ai' : '')
      );
      if (squad && squad.person) ws.stats.append(stat(squad.person, 'human person', 'Decided for this section: ' + squad.person));
      ws.problems.replaceChildren();
      for (const problem of data.problems) ws.problems.append(h.el('p', 'problem', problem));
      // Gold: what only a person can do here. The same cards, and the same signed path, as the room's decisions panel.
      ws.decide.replaceChildren();
      ws.decide.hidden = !decisions.length;
      if (decisions.length) {
        const head = h.el('div', 'decide-h');
        head.append(h.glyph('M8 2a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5zM3 14c0-3 2.2-5 5-5s5 2 5 5'), h.el('h3', '', 'Waiting for a named person'), h.el('span', 'wn', String(decisions.length)));
        const list = h.el('ul', 'decide-list');
        for (const card of decisions) list.append(h.decisionItem(card, 'ws'));
        ws.decide.append(head, list);
      }
      ws.productList.replaceChildren();
      paged(ws.productList, id + ':products', data.products, (row, parent) => {
        const li = h.el('li');
        const b = h.el('button', 'wprod');
        b.type = 'button';
        b.setAttribute('aria-label', row.title + ' version ' + row.version + ', ' + row.display + ', owner ' + row.owner + '. Opens its provenance.');
        const meta = h.el('span', 'pm');
        meta.append(h.el('span', 'st-pill ' + row.pill, row.display), h.el('span', '', row.owner));
        if (row.approvedBy) meta.append(h.el('span', 'human-line', row.approvedBy));
        b.append(h.el('span', 'pi', id.toUpperCase()), h.el('span', 'pn', row.title + ' v' + row.version), meta);
        b.addEventListener('click', () => h.openProductCard(row.product, b));
        li.append(b);
        parent.append(li);
      }, 'No products in this section yet. They appear here as its members propose them.');
      ws.activity.replaceChildren();
      if (!data.activity.length) ws.activity.append(h.el('li', 'empty', 'No agent work recorded for this section in the event log yet.'));
      for (const line of data.activity) {
        const li = h.el('li', 'act k-task');
        li.append(h.el('span', 'at mono', h.shortTime(line.at)), h.el('span', 'who', line.member), h.el('span', 'what', line.text));
        ws.activity.append(li);
      }
    }

    function productChip(product, empty) {
      if (!product) return h.el('span', 'st-pill draft', empty || 'not proposed yet');
      const chip = h.el('span', 'st-pill ' + product.pill, product.display + ' v' + product.version);
      chip.title = 'Owner ' + product.owner;
      return chip;
    }
    function memberOf(model, section, name) {
      const squad = model.squads.find((entry) => entry.section === section);
      return squad && squad.members.find((member) => member.id === name);
    }
    function agentBadge(member) {
      const badge = h.el('span', 'agent-badge s-' + member.state, member.id + ' · ' + member.stateText);
      badge.setAttribute('aria-label', member.id + ', an agent, ' + member.stateText + ': ' + member.task);
      return badge;
    }
    function rule(text) { return h.el('p', 'rule', text); }
    /** A tab's label, renamed in the profile's words (the host's model names the term; the page never picks one itself). */
    function relabel(ws, key, label) { const tab = ws.tabButtons.get(key); if (tab && typeof label === 'string' && label) h.setText(tab.children[0], label); }
    function grow(node, delay) { h.anim(node, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 450, delay: delay || 0, fill: 'backwards', easing: h.EASE.settle }); }
    function rise(node, delay) { h.anim(node, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 380, delay: delay || 0, fill: 'backwards' }); }

    // ---------- J5 ----------
    function renderJ5(model) {
      const ws = panes.get('j5');
      const j5 = model.j5;
      const counts = { cells: j5.cells.length, compare: j5.comparison.criteria.length, wargame: j5.wargame.total, brief: j5.brief.dissent.length, annexes: j5.annexes.rows.length };
      for (const [key, tab] of ws.tabButtons) h.setText(tab.children[1], String(counts[key]));

      const cells = ws.panelNodes.get('cells');
      cells.replaceChildren(rule('Each COA cell develops one distinct COA in the theme the lead planner gave it. The lead planner tests every COA; the commander chooses.'));
      if (!j5.cells.length) cells.append(h.el('p', 'faint', 'No COA cells yet. The lead planner writes the COA themes; each cell then drafts its COA statement and sketch.'));
      const grid = h.el('div', 'coa-grid');
      j5.cells.forEach((cell, index) => {
        const card = h.el('article', 'coa-cell');
        card.tabIndex = 0;
        card.setAttribute('aria-label', cell.coa + (cell.theme ? ', theme: ' + cell.theme : '') + (cell.product ? '. ' + cell.product.display + ' version ' + cell.product.version : '. Not drafted yet'));
        const head = h.el('div', 't');
        head.append(h.el('span', 'k mono', cell.coa), productChip(cell.product, 'not drafted yet'));
        card.append(head);
        if (cell.theme) card.append(h.el('p', 'theme', cell.theme));
        if (cell.differs) card.append(h.el('p', 'faint', 'Differs by: ' + cell.differs));
        const member = cell.owner ? memberOf(model, 'j5', cell.owner) : undefined;
        if (member) card.append(agentBadge(member));
        else if (cell.owner) card.append(h.el('p', 'faint', 'Cell: ' + cell.owner));
        if (cell.validity.length) {
          const tests = h.el('ul', 'tests');
          tests.setAttribute('aria-label', 'Validity tests for ' + cell.coa);
          for (const test of cell.validity) {
            const li = h.el('li', 'test t-' + test.result);
            li.append(h.el('span', 'tmark', test.result === 'pass' ? '✓' : test.result === 'fail' ? '✕' : test.result === 'risk' ? '▲' : '?'), h.el('b', '', test.test), document.createTextNode(' ' + test.result + (test.reason ? ': ' + test.reason : '')));
            li.children[0].setAttribute('aria-hidden', 'true');
            tests.append(li);
          }
          card.append(tests);
        } else card.append(h.el('p', 'faint', 'Validity tests (' + j5.tests.join(', ') + ') not recorded yet.'));
        if (cell.distinctFrom) card.append(h.el('p', 'faint', 'Distinct from: ' + cell.distinctFrom));
        if (cell.product) opener(card, () => h.openProductCard(cell.product.product, card), 'Opens its provenance.');
        grid.append(card);
        if (first) rise(card, index * 70);
      });
      cells.append(grid);

      const compare = ws.panelNodes.get('compare');
      compare.replaceChildren();
      const c = j5.comparison;
      if (c.approval) compare.append(h.el('p', 'human-line', 'Criteria and weights approved by ' + c.approval.by + ', ' + h.dtg(Date.parse(c.approval.at)) + ' (' + c.approval.product + ' v' + c.approval.version + ', signed).'));
      else compare.append(h.el('p', 'late', 'No person has approved the criteria and weights yet: until the commander approves them, the comparison is a proposal.'));
      if (!c.criteria.length) compare.append(h.el('p', 'faint', 'No comparison yet. The lead planner fills the comparison matrix in step 5, each section scoring its own criteria.'));
      else {
        const wrap = h.el('div', 'table-wrap');
        const t = h.el('table', 'grid-table cmp stack-narrow');
        t.setAttribute('aria-label', 'COA comparison: criteria, weights and scores');
        const thead = h.el('thead');
        const hr = h.el('tr');
        for (const label of ['Criterion', 'Weight', ...c.coas]) { const th = h.el('th', '', label); th.setAttribute('scope', 'col'); hr.append(th); }
        thead.append(hr);
        const tbody = h.el('tbody');
        for (const row of c.criteria) {
          const tr = h.el('tr');
          const name = h.el('td', '', row.criterion);
          name.dataset.label = 'Criterion';
          if (row.definition) name.title = row.definition;
          const weight = h.el('td', 'mono num', row.weight === undefined ? 'not set' : String(row.weight));
          weight.dataset.label = 'Weight';
          tr.append(name, weight);
          row.scores.forEach((score, i) => {
            const td = h.el('td');
            td.dataset.label = c.coas[i];
            const bar = h.el('span', 'sbar');
            const fill = h.el('span', 'sfill');
            fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, (score.score || 0) / 5)) + ')';
            bar.append(fill);
            bar.setAttribute('aria-hidden', 'true');
            td.append(bar, h.el('span', 'stext', score.text || 'not scored'));
            tr.append(td);
            if (first) grow(fill, 120 + i * 90);
          });
          tbody.append(tr);
        }
        const tfoot = h.el('tfoot');
        const fr = h.el('tr');
        fr.append(h.el('td', '', 'Weighted total (recomputed)'), h.el('td'));
        for (const total of c.totals) { const td = h.el('td', 'tot mono' + (total.best ? ' best' : ''), String(total.total)); td.dataset.label = total.coa; if (total.best) td.setAttribute('aria-label', total.coa + ' total ' + total.total + ', the highest'); fr.append(td); }
        tfoot.append(fr);
        t.append(thead, tbody, tfoot);
        wrap.append(t);
        compare.append(wrap);
        compare.append(h.el('p', 'faint', 'Totals are weight times score, recomputed by the extension from the matrix; they inform the commander, who decides.'));
      }
      if (c.product) { const row = h.el('p', 'chips'); row.append(h.el('span', 'faint', 'Comparison matrix '), productChip(c.product)); compare.append(row); }

      const wargame = ws.panelNodes.get('wargame');
      wargame.replaceChildren(rule('Action, reaction, counteraction: the J2 red cell plays to win. Results feed the comparison; a wargame alone never selects a COA.'));
      if (j5.wargame.problem) wargame.append(h.el('p', 'problem', j5.wargame.problem));
      if (!j5.wargame.games.length && !j5.wargame.problem) wargame.append(h.el('p', 'faint', 'No wargame recorded yet. The plans writer records each phase through the wargame tool in step 4.'));
      for (const game of j5.wargame.games) {
        const box = h.el('section', 'game');
        box.setAttribute('aria-label', game.coa + ' against ' + game.enemyCoa);
        const head = h.el('div', 't');
        head.append(h.el('span', 'k mono', game.coa), h.el('span', 'vs', 'against'), h.el('span', 'k mono hostile', game.enemyCoa), h.el('span', 'faint', 'Next: ' + game.next));
        box.append(head);
        paged(box, 'j5:game:' + game.coa + ':' + game.enemyCoa, game.turns, (turn, parent) => {
          const row = h.el('div', 'turn');
          row.append(h.el('span', 'tn mono', 'T' + turn.turn + ' ' + turn.when));
          const phases = h.el('ol', 'phases');
          for (const phase of turn.phases) {
            const li = h.el('li', 'ph ph-' + phase.side);
            li.append(h.el('span', 'pl mono', phase.phase.toUpperCase()));
            if (phase.moves.length) li.append(h.el('p', '', (phase.side === 'adversary' ? 'Adversary moves: ' : 'Friendly moves: ') + phase.moves.join(', ')));
            for (const result of phase.results) li.append(h.el('p', 'res', result));
            for (const dp of phase.decisionPoints) { const p = h.el('p', 'dp'); p.append(h.el('span', 'dia', '◆'), document.createTextNode(' ' + dp)); p.children[0].setAttribute('aria-hidden', 'true'); li.append(p); }
            li.append(h.el('p', 'faint', 'Recorded by ' + phase.recordedBy + ' ' + h.shortTime(phase.at)));
            phases.append(li);
          }
          row.append(phases);
          parent.append(row);
        });
        wargame.append(box);
      }

      const brief = ws.panelNodes.get('brief');
      brief.replaceChildren();
      const b = j5.brief;
      const top = h.el('div', 'chips');
      top.append(h.el('span', 'faint', 'COA decision brief '), productChip(b.product));
      brief.append(top);
      if (b.recommendation) {
        const rec = h.el('div', 'recommend');
        rec.append(h.el('span', 'kicker ai-kicker', 'Staff recommendation, drafted by agents'), h.el('p', '', b.recommendation));
        brief.append(rec);
      } else brief.append(h.el('p', 'faint', 'No recommendation written yet. The lead planner drafts it with its main risk and mitigation.'));
      const dissent = h.el('div', 'dissent');
      dissent.append(h.el('span', 'kicker', 'Dissent, unedited'));
      if (b.dissent.length) for (const line of b.dissent) dissent.append(h.el('p', '', line));
      else dissent.append(h.el('p', 'faint', 'No dissent recorded on the brief.'));
      brief.append(dissent);
      const red = h.el('p', 'chips');
      red.append(h.el('span', 'faint', 'Red team critique '), productChip(b.redTeam));
      brief.append(red);
      brief.append(h.el('p', 'human-line', 'Who decides: the ' + (b.decisionFor || 'commander') + '. Nothing after this step starts until a named person signs.'));

      const annexes = ws.panelNodes.get('annexes');
      annexes.replaceChildren(rule('The annex tracker, held to the ledger by the orders check: each letter from the doctrine profile, each annex released by a person before assembly.'));
      const a = j5.annexes;
      if (a.product) { const row = h.el('p', 'chips'); row.append(h.el('span', 'faint', 'Annex tracker '), productChip(a.product)); annexes.append(row); }
      if (!a.rows.length) annexes.append(h.el('p', 'faint', 'No annex tracker yet. The plans writer keeps it in step 7.'));
      else {
        annexes.append(h.el('p', a.blocking ? 'late' : 'ok-line', a.blocking ? a.blocking + ' finding' + (a.blocking === 1 ? '' : 's') + ' block assembly.' : 'Nothing blocks assembly.'));
        const list = h.el('div', 'annex-list');
        paged(list, 'j5:annexes', a.rows, (row, parent) => {
          const card = h.el('article', 'annex' + (row.blocked ? ' blocked' : ''));
          const head = h.el('div', 't');
          head.append(h.el('span', 'k mono', row.letter ? 'Annex ' + row.letter : 'No letter'), h.el('span', '', row.subject), h.el('span', 'st-pill ' + (row.status === 'done' ? 'released' : 'draft'), row.status));
          card.append(head, h.el('p', 'faint', 'Owner ' + (row.owner || 'not named') + ' · ' + (row.product ? row.product + ': ' + row.state : row.state)));
          for (const finding of row.findings) card.append(h.el('p', 'late', finding));
          parent.append(card);
        });
        annexes.append(list);
      }
    }

    // ---------- J3 ----------
    function renderJ3(model) {
      const ws = panes.get('j3');
      const j3 = model.j3;
      const counts = { current: j3.eventLog.total, dsm: j3.dsm.rows.length, sync: j3.sync.total, fragos: j3.fragos.length, rhythm: j3.rhythm.events.length };
      for (const [key, tab] of ws.tabButtons) h.setText(tab.children[1], String(counts[key]));
      // The fragmentary order in the profile's words: FRAGORD under the US profiles, Frag O under NATO/Canadian.
      const frago = typeof j3.frago === 'string' && j3.frago ? j3.frago : 'FRAGO';
      relabel(ws, 'fragos', frago + 's');
      h.setText(ws.lead, 'Operations: the current picture, the decision support matrix and the battle rhythm. Every ' + frago + ' is a draft until a person releases it.');

      const current = ws.panelNodes.get('current');
      for (const child of [...current.children]) if (child !== ws.mapSlot) child.remove();
      const log = h.el('section', 'evlog');
      log.append(h.el('h3', 'kicker', 'Event log, newest first'));
      log.append(h.el('p', 'faint', j3.eventLog.total + ' entr' + (j3.eventLog.total === 1 ? 'y' : 'ies') + ', ' + j3.eventLog.escalated + ' escalated to a person. The watch logs facts; interpretation is the JOC chief\'s.'));
      for (const trigger of j3.triggers) {
        const line = h.el('p', 'human-line', 'CCIR ' + trigger.ccir + ' reported as triggered by ' + trigger.member + ' ' + h.shortTime(trigger.at) + ': ' + trigger.report);
        log.append(line);
      }
      // New entries, by id, over the whole log: an escalation past the first page is still announced, and paging never animates old rows.
      const ids = new Set(j3.eventLog.rows.map((row) => row.id));
      toRise = new Set([...toRise].filter((id) => ids.has(id)));
      for (const row of j3.eventLog.rows) {
        if (first || seenLog.has(row.id)) continue;
        toRise.add(row.id);
        if (row.status === 'escalated') h.announce('Event log: ' + row.id + ' escalated' + (row.ccir ? ' on CCIR ' + row.ccir : '') + '.');
      }
      seenLog = ids;
      const rows = h.el('ol', 'evrows');
      rows.setAttribute('aria-label', 'Event log');
      paged(rows, 'j3:log', j3.eventLog.rows, (row, parent) => {
        const li = h.el('li', 'ev s-' + row.status);
        li.tabIndex = 0;
        const head = h.el('div', 't');
        head.append(h.el('span', 'mono faint', h.shortTime(row.time)), h.el('span', 'mono', row.id), h.el('span', 'st-pill ' + (row.status === 'escalated' ? 'awaiting' : row.status === 'closed' ? 'released' : 'draft'), row.status));
        if (row.ccir) head.append(h.el('span', 'chip ccir', 'CCIR ' + row.ccir));
        if (row.decisionPoint) head.append(h.el('span', 'chip ccir', row.decisionPoint));
        li.append(head, h.el('p', '', row.report), h.el('p', 'faint', 'Source: ' + row.source));
        li.setAttribute('aria-label', row.time + ', ' + row.status + (row.ccir ? ', matches CCIR ' + row.ccir : '') + (row.decisionPoint ? ', matches ' + row.decisionPoint : '') + ': ' + row.report);
        parent.append(li);
        if (toRise.delete(row.id)) rise(li, 0);
      }, 'No event log yet. The watch officer logs each report with its time and source, and flags CCIR and DSM matches.');
      log.append(rows);
      current.append(log);
      if (j3.ccir.length) {
        current.append(h.el('h3', 'kicker', 'CCIR register'));
        current.append(h.table(['ID', 'Type', 'Requirement', 'Decision point', 'Status'], j3.ccir.slice(0, PAGE).map((row) => [row.id, row.type.toUpperCase(), row.requirement, row.decisionPoint, row.status]), 'CCIR register'));
      }

      const dsm = ws.panelNodes.get('dsm');
      dsm.replaceChildren(ownerLine(j3.dsm.owner));
      if (!j3.dsm.rows.length) dsm.append(h.el('p', 'faint', 'No decision support matrix yet. The wargame gives its decision points; each names its PIR and a named decision maker.'));
      else {
        const list = h.el('div', 'dsm-list');
        paged(list, 'j3:dsm', j3.dsm.rows, (row, parent) => {
          const card = h.el('article', 'dsm' + (row.matched ? ' matched' : ''));
          card.tabIndex = 0;
          const head = h.el('div', 't');
          head.append(h.el('span', 'k mono', row.id), h.el('span', '', row.description));
          if (row.matched) head.append(h.el('span', 'st-pill awaiting', 'trigger reported'));
          card.append(head);
          const facts = [['Indicator', row.indicator], ['NAI', row.nai], ['PIR', row.pir], ['Recommended action', row.action], ['COA', row.coa]].filter((pair) => pair[1]);
          for (const [key, value] of facts) { const p = h.el('p', key === 'Recommended action' ? 'ai-line' : ''); p.append(h.el('b', '', key + ': '), document.createTextNode(value)); card.append(p); }
          card.append(h.el('p', 'human-line', 'Decides: ' + row.maker));
          card.setAttribute('aria-label', row.id + ': ' + row.description + '. Decides: ' + row.maker + (row.matched ? '. Its trigger was reported in the event log.' : ''));
          parent.append(card);
        });
        dsm.append(list);
      }

      const sync = ws.panelNodes.get('sync');
      sync.replaceChildren(ownerLine(j3.sync.owner));
      if (!j3.sync.rows.length) sync.append(h.el('p', 'faint', 'No synchronization matrix yet. It fills from the wargame, row by row, under one H-hour scale.'));
      else {
        const span = Math.max(60, j3.sync.to - j3.sync.from);
        const matrix = h.el('div', 'mx');
        matrix.setAttribute('role', 'table');
        matrix.setAttribute('aria-label', 'Synchronization matrix from ' + hHour(j3.sync.from) + ' to ' + hHour(j3.sync.to));
        // The H-hour scale over the tracks: start, middle and end.
        const scale = h.el('div', 'mxrow mxscale');
        scale.setAttribute('aria-hidden', 'true');
        const ticks = h.el('div', 'mxticks');
        for (let i = 0; i <= 2; i += 1) ticks.append(h.el('span', 'tick mono', hHour(Math.round(j3.sync.from + (span * i) / 2))));
        scale.append(h.el('span', 'rl', ''), ticks);
        matrix.append(scale);
        j3.sync.rows.forEach((row, rowIndex) => {
          const line = h.el('div', 'mxrow');
          line.setAttribute('role', 'row');
          const label = h.el('span', 'rl', row.row.replace(/-/g, ' '));
          label.setAttribute('role', 'rowheader');
          // A track with a dot at each entry's time (where in H-hour it falls), and the entries in words below it, in time order: nothing is placed
          // where it could run off the edge, and the words never depend on the dots.
          const lane = h.el('div', 'lane');
          lane.setAttribute('role', 'cell');
          const track = h.el('div', 'track');
          track.setAttribute('aria-hidden', 'true');
          const chips = h.el('div', 'mxchips');
          paged(chips, 'j3:sync:' + row.row, row.cells, (cell, parent) => {
            const where = Math.max(0, Math.min(1, (cell.offset - j3.sync.from) / span));
            const dot = h.el('span', 'mxdot mx-' + row.row);
            dot.style.left = 'calc(' + (where * 100).toFixed(2) + '% - ' + (where * 8).toFixed(2) + 'px)';
            track.append(dot);
            const chip = h.el('span', 'mxc mx-' + row.row + (cell.section ? ' sec-' + cell.section : ''));
            chip.append(h.el('b', 'mono', hHour(cell.offset)), document.createTextNode(' ' + cell.entry + (cell.section ? ' (' + cell.section.toUpperCase() + ')' : '')));
            chip.tabIndex = 0;
            chip.setAttribute('aria-label', row.row.replace(/-/g, ' ') + ' at ' + hHour(cell.offset) + (cell.coa ? ', ' + cell.coa : '') + ': ' + cell.entry);
            parent.append(chip);
            if (first) {
              h.anim(dot, [{ opacity: 0, transform: 'scale(0)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 420, delay: rowIndex * 60, fill: 'backwards', easing: h.EASE.settle });
              h.anim(chip, [{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 380, delay: 120 + rowIndex * 60, fill: 'backwards' });
            }
          });
          lane.append(track, chips);
          line.append(label, lane);
          matrix.append(line);
        });
        sync.append(matrix);
      }

      const fragos = ws.panelNodes.get('fragos');
      fragos.replaceChildren(rule('A ' + frago + ' is a draft the future operations planner writes. It is issued only when a named person releases it; nothing is sent by an agent.'));
      if (!j3.fragos.length) fragos.append(h.el('p', 'faint', 'No ' + frago + ' drafts. A trigger in the DSM or a branch leads the future operations planner to draft one.'));
      for (const frago of j3.fragos) {
        const card = h.el('article', 'frago');
        const head = h.el('div', 't');
        head.append(h.el('span', 'k mono', frago.title), productChip(frago));
        card.append(head, h.el('p', 'faint', 'Drafted by ' + frago.owner + ' · ' + h.shortTime(frago.at)));
        const waiting = model.decisions.find((cardData) => cardData.product === frago.product);
        if (waiting) { const list = h.el('ul', 'decide-list'); list.append(h.decisionItem(waiting, 'frago')); card.append(list); }
        else if (frago.pill !== 'released') card.append(h.el('p', 'faint', 'Not waiting for a person yet: it goes through the release guard first.'));
        fragos.append(card);
      }

      const rhythm = ws.panelNodes.get('rhythm');
      rhythm.replaceChildren();
      if (j3.rhythm.product) { const row = h.el('p', 'chips'); row.append(h.el('span', 'faint', 'Battle rhythm '), productChip(j3.rhythm.product)); rhythm.append(row); }
      rhythm.append(h.el('h3', 'kicker', 'Coming up'));
      if (!j3.rhythm.events.length) rhythm.append(h.el('p', 'faint', 'No battle rhythm events ahead. The JOC chief (or the chief of staff in a full staff) keeps the calendar.'));
      const cal = h.el('ol', 'cal');
      paged(cal, 'j3:rhythm', j3.rhythm.events, (event, parent) => {
        const li = h.el('li', 'calev k-' + event.kind);
        li.tabIndex = 0;
        // An event whose repeat the host does not know has no date (next is empty): it says so rather than show a wrong one.
        const when = event.next ? Date.parse(event.next) : NaN;
        const known = Number.isFinite(when);
        li.append(h.el('span', 'when mono', known ? h.dtg(when) : 'No date'), h.el('b', '', event.title), h.el('span', 'faint', event.kind.replace(/-/g, ' ') + ' · ' + event.minutes + ' min · ' + event.repeat + ' · chair ' + event.chair));
        if (event.inputs || event.outputs) li.append(h.el('span', 'faint', (event.inputs ? 'In: ' + event.inputs : '') + (event.inputs && event.outputs ? ' · ' : '') + (event.outputs ? 'Out: ' + event.outputs : '')));
        li.append(h.el('span', 'in mono', known ? h.inWords(when - h.now()) : event.repeat));
        li.setAttribute('aria-label', event.title + ', ' + (known ? h.dtg(when) + ', ' + h.inWords(when - h.now()) : 'no date: ' + event.repeat) + ', chaired by ' + event.chair);
        parent.append(li);
      });
      rhythm.append(cal);
      rhythm.append(h.el('h3', 'kicker', 'Suspenses'));
      if (!j3.suspenses.length) rhythm.append(h.el('p', 'faint', 'No open RFIs with a suspense.'));
      const sus = h.el('ol', 'cal');
      paged(sus, 'j3:suspenses', j3.suspenses, (row, parent) => {
        const li = h.el('li', 'calev' + (row.overdue ? ' overdue' : ''));
        const when = Date.parse(row.suspense);
        li.append(h.el('span', 'when mono', Number.isFinite(when) ? h.dtg(when) : row.suspense), h.el('b', '', row.id + ' ' + row.from.toUpperCase() + ' to ' + row.to.toUpperCase()), h.el('span', '', row.question));
        if (row.overdue) li.append(h.el('span', 'late', 'Past its suspense'));
        parent.append(li);
      });
      rhythm.append(sus);
    }

    function ownerLine(owner) {
      const p = h.el('p', 'owner-line' + (owner.handover ? ' handed' : ''));
      p.append(h.el('span', 'kicker', owner.phase === 'execution' ? 'Execution' : 'Planning'), document.createTextNode(' ' + owner.note));
      if (owner.handover) p.append(h.el('span', 'human-line', ' Signed ' + h.dtg(Date.parse(owner.handover.at)) + '.'));
      return p;
    }
    function hHour(minutes) { const sign = minutes < 0 ? '-' : '+'; const abs = Math.abs(minutes); return 'H' + sign + Math.floor(abs / 60) + (abs % 60 ? ':' + String(abs % 60).padStart(2, '0') : ''); }

    // ---------- J4 ----------
    function renderJ4(model) {
      const ws = panes.get('j4');
      const j4 = model.j4;
      const counts = { logstat: j4.logstat.units.length, calcs: j4.calcs.length, movement: j4.movement.length + j4.readiness.length, support: j4.supportability.length, annex: j4.annexes.length };
      for (const [key, tab] of ws.tabButtons) h.setText(tab.children[1], String(counts[key]));
      // The logistics annex in the profile's words (Sustainment annex under the US Army profile).
      const annexName = typeof j4.annexName === 'string' && j4.annexName ? j4.annexName : 'Logistics annex';
      relabel(ws, 'annex', annexName);
      const BAND = { red: 'Red', amber: 'Amber', green: 'Green', none: 'No band set' };

      const logstat = ws.panelNodes.get('logstat');
      logstat.replaceChildren(rule('Each unit\'s latest LOGSTAT, checked against the plausibility rules. A report that fails goes back to its unit and stays out until it passes; numbers are never fixed silently.'));
      logstat.append(h.el('p', 'faint', j4.logstat.reports + ' report' + (j4.logstat.reports === 1 ? '' : 's') + ' received.'));
      if (!j4.logstat.units.length && !j4.logstat.heldOut.length) logstat.append(h.el('p', 'faint', 'No LOGSTAT yet. The JLOC chief enters each unit\'s report through the logistics tool.'));
      const units = h.el('div', 'units');
      paged(units, 'j4:units', j4.logstat.units, (unit, parent) => {
        const card = h.el('article', 'unit band-' + unit.band);
        card.tabIndex = 0;
        card.setAttribute('aria-label', unit.unit + ', worst band ' + BAND[unit.band] + ', report ' + unit.report);
        const head = h.el('div', 't');
        head.append(h.el('b', '', unit.unit), h.el('span', 'band-chip b-' + unit.band, BAND[unit.band]), h.el('span', 'faint mono', unit.report));
        card.append(head);
        for (const line of unit.lines) {
          const row = h.el('div', 'cline');
          const pct = Number(line.capacity.replace(/,/g, '')) > 0 ? Math.max(0, Math.min(1, Number(line.onHand.replace(/,/g, '')) / Number(line.capacity.replace(/,/g, '')))) : 0;
          const bar = h.el('span', 'cbar b-' + line.band);
          const fill = h.el('span', 'cfill');
          fill.style.transform = 'scaleX(' + pct.toFixed(3) + ')';
          bar.append(fill);
          bar.setAttribute('aria-hidden', 'true');
          row.append(h.el('span', 'cn', line.commodity), bar, h.el('span', 'cv mono', line.onHand + ' / ' + line.capacity + ' ' + line.uom + (line.daysOfSupply ? ' · ' + line.daysOfSupply + ' DOS' : '')));
          row.title = line.words;
          row.setAttribute('aria-label', line.commodity + ': ' + line.words);
          card.append(row);
          if (line.forecast) card.append(h.el('p', 'faint', line.forecast));
          if (first) grow(fill, 60);
        }
        parent.append(card);
      });
      logstat.append(units);
      if (j4.logstat.heldOut.length) {
        logstat.append(h.el('h3', 'kicker', 'Held out until corrected'));
        for (const held of j4.logstat.heldOut) logstat.append(h.el('p', 'late', held.unit + ' (' + held.report + '): failed rule ' + held.rules.join(', ') + '. Sent back to the unit.'));
      }

      const calcs = ws.panelNodes.get('calcs');
      calcs.replaceChildren(rule('Every figure comes from a calculator record the calculator ledger vouches for, with its formula and the planning factors a person entered.'));
      for (const problem of j4.calcProblems) calcs.append(h.el('p', 'problem', problem));
      if (!j4.calcs.length) calcs.append(h.el('p', 'faint', 'No calculator records yet. The log plans officer runs the calculator for each COA and phase.'));
      const list = h.el('div', 'calc-list');
      paged(list, 'j4:calcs', j4.calcs, (calc, parent) => {
        const card = h.el('article', 'calc');
        const head = h.el('div', 't');
        head.append(h.el('span', 'k mono', 'calc:' + calc.id), h.el('span', '', calc.title), h.el('span', 'chip', calc.kind));
        card.append(head, h.el('p', 'result', calc.result));
        const formula = h.el('pre', 'formula mono');
        formula.textContent = calc.formula.join('\n');
        formula.setAttribute('aria-label', 'Formula for calc:' + calc.id);
        card.append(formula, h.el('p', 'faint', 'Computed by ' + calc.by + ' ' + h.shortTime(calc.at)));
        parent.append(card);
      });
      calcs.append(list);

      const movement = ws.panelNodes.get('movement');
      movement.replaceChildren();
      movement.append(h.el('h3', 'kicker', 'Notional movement tables'));
      if (!j4.movement.length) movement.append(h.el('p', 'faint', 'No movement table checked yet. The mobility planner checks notional tables only; never real lift or port data.'));
      else movement.append(h.table(['Serial', 'What', 'Mode', 'From', 'To', 'Arrives', 'Required', 'Feasible'], j4.movement.slice(0, shown.get('j4:move') || PAGE).map((row) => [row.serial, row.what, row.mode, row.from, row.to, h.shortTime(row.arrives) || row.arrives, h.shortTime(row.required) || row.required, (row.feasible ? 'Yes. ' : 'No: ') + row.why]), 'Movement board'));
      if (j4.movement.length > (shown.get('j4:move') || PAGE)) movement.append(h.button('Show more serials', 'ghost small more', () => { shown.set('j4:move', (shown.get('j4:move') || PAGE) + PAGE); render(h.model()); }));
      movement.append(h.el('h3', 'kicker', 'Equipment readiness'));
      if (!j4.readiness.length) movement.append(h.el('p', 'faint', 'No readiness import yet. The maintenance planner imports the readiness file a person exports.'));
      const ready = h.el('div', 'ready-grid');
      for (const row of j4.readiness) {
        const card = h.el('div', 'ready' + (row.stale ? ' stale' : ''));
        const ring = h.el('span', 'ring mono', Math.round(row.percent) + '%');
        ring.style.setProperty('--p', String(Math.max(0, Math.min(100, row.percent))));
        ring.setAttribute('aria-hidden', 'true');
        card.append(ring, h.el('b', '', row.equipment), h.el('span', 'faint', row.ready + ' of ' + row.onHand + ' ready · calc:' + row.record));
        if (row.stale) card.append(h.el('span', 'late', 'Data older than a day (as of ' + h.dtg(Date.parse(row.asOf)) + ')'));
        card.setAttribute('aria-label', row.equipment + ': ' + Math.round(row.percent) + ' percent ready, ' + row.ready + ' of ' + row.onHand + (row.stale ? '. The data is older than a day.' : ''));
        card.setAttribute('role', 'group');
        ready.append(card);
      }
      movement.append(ready);

      const support = ws.panelNodes.get('support');
      support.replaceChildren(rule('Supportability of each COA, function by function, with where and when support runs out. The J4 scores; the commander decides.'));
      if (!j4.supportability.length) support.append(h.el('p', 'faint', 'No supportability register yet. The log plans officer screens each COA in step 3.'));
      const coas = [...new Set(j4.supportability.map((row) => row.coa))];
      for (const coa of coas) {
        const box = h.el('section', 'support');
        box.append(h.el('h4', 'k mono', coa || 'COA'));
        for (const row of j4.supportability.filter((entry) => entry.coa === coa)) {
          const p = h.el('div', 'sup lv-' + row.level);
          p.append(h.el('span', 'band-chip b-' + (row.level === 'ok' ? 'green' : row.level === 'risk' ? 'amber' : row.level === 'bad' ? 'red' : 'none'), row.level === 'ok' ? 'Supportable' : row.level === 'risk' ? 'Risk' : row.level === 'bad' ? 'Not supportable' : 'Judgement'), h.el('b', '', row.fn), h.el('span', '', row.judgement));
          if (row.culminates) p.append(h.el('span', 'faint', 'Runs out: ' + row.culminates));
          p.append(h.el('span', row.verified ? 'faint' : 'late', row.calc ? 'calc:' + row.calc + (row.verified ? '' : ' (not vouched for by the calculator ledger)') : 'No calculator record cited'));
          box.append(p);
        }
        support.append(box);
      }

      const annex = ws.panelNodes.get('annex');
      annex.replaceChildren(rule('The ' + annexName.toLowerCase() + ', its letter from the doctrine profile, through the release guard to a person.'));
      if (!j4.annexes.length) annex.append(h.el('p', 'faint', 'No ' + annexName.toLowerCase() + ' yet. The J4 director drafts it in step 7.'));
      for (const row of j4.annexes) {
        const card = h.el('article', 'annex');
        const head = h.el('div', 't');
        head.append(h.el('span', '', row.title), h.el('span', 'st-pill ' + row.pill, row.state + (row.version ? ' v' + row.version : '')));
        card.append(head, h.el('p', 'faint', (row.owner ? 'Owner ' + row.owner + ' · ' : '') + row.tracker));
        annex.append(card);
      }
    }

    function render(model, previous) {
      if (!model) return;
      for (const id of ['j5', 'j3', 'j4']) {
        if (!panes.has(id)) continue;
        sectionHead(id, model);
        if (id === 'j5') renderJ5(model);
        else if (id === 'j3') renderJ3(model);
        else renderJ4(model);
        const state = h.saved.wsTabs || {};
        showTab(id, TABS[id].some(([key]) => key === state[id]) ? state[id] : TABS[id][0][0], false);
      }
      void previous;
      first = false;
    }

    return {
      build, render,
      mapSlot: (id) => (panes.get(id) || {}).mapSlot,
      tag: (id, model) => {
        if (id === 'j5') return model.j5.cells.length + ' COA' + (model.j5.cells.length === 1 ? '' : 's');
        if (id === 'j3') return model.j3.eventLog.escalated ? model.j3.eventLog.escalated + ' escalated' : model.j3.eventLog.total + ' logged';
        return model.j4.logstat.units.length + ' unit' + (model.j4.logstat.units.length === 1 ? '' : 's');
      }
    };
  }

  window.NearAiStaffWorkspaces = { create };
})();
