/**
 * Share with people, the section (Phase 33 D-58; 33-27): mounted on the Sterling work-area page of the open staff project and shown on its own
 * when an invitation file is opened. Plain DOM in the original theme: lifted cards, Theia colour variables and codicons only. Every action goes to
 * the share service in the backend; the section holds no key and shows only sentences, names, safety words and files to save. Text comes from
 * STAFF_SHARE_TEXT and the engine's own result sentences.
 */
import type { ServiceResult } from '../../common/service-result.js';
import { MANAGED_KEY_FILE_EXTENSION, MANAGED_KEY_FILE_MAX_BYTES, STAFF_SHARE_TEXT, type ShareConfirmation, type ShareOutcome, type ShareView, type StaffShareServer } from '../../common/staff-share.js';
import type { InvitationOpened } from './invite-open-handler.js';
import '../sterling-share.css';

const LEVELS = ['Public', 'Internal', 'Confidential', 'Restricted'] as const;
const clearanceOf = (level: string): unknown => ({ scale: 'org', level, compartments: [], releasability: [] });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function icon(name: string): HTMLElement {
  const node = el('i', undefined, `codicon codicon-${name}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function labelled(text: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): HTMLLabelElement {
  const label = el('label', text, 'sterling-share-field');
  label.append(control);
  return label;
}

function input(placeholder = ''): HTMLInputElement {
  const node = el('input');
  node.type = 'text';
  node.placeholder = placeholder;
  return node;
}

function levelSelect(chosen = 'Internal'): HTMLSelectElement {
  const select = el('select');
  for (const level of LEVELS) {
    const option = el('option', `org/${level}`);
    option.value = level;
    option.selected = level === chosen;
    select.append(option);
  }
  return select;
}

/** Saves a file the backend made (an invitation, a join request, a welcome) through the browser's own download. */
function save(file: { readonly name: string; readonly text: string }): void {
  const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
  const link = el('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readFile(accept: string, maximum = 4 * 1024 * 1024, tooLarge?: () => void): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = el('input');
    picker.type = 'file';
    picker.accept = accept;
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (file === undefined || file.size > maximum) {
        if (file !== undefined) tooLarge?.();
        resolve(undefined);
        return;
      }
      void file.text().then(resolve, () => resolve(undefined));
    });
    picker.addEventListener('cancel', () => resolve(undefined), { once: true });
    picker.click();
  });
}

export class ShareWithPeopleSection {
  readonly node = el('section', undefined, 'sterling-share');
  private readonly body = el('div', undefined, 'sterling-share-body');
  private readonly status = el('p', undefined, 'sterling-share-status');
  private invitation: InvitationOpened | undefined;
  private removal: { project: string | undefined; member: string; confirmation: ShareConfirmation } | undefined;
  private keyChange: { project: string | undefined; cell: string; confirmation: ShareConfirmation } | undefined;
  private lastKeyFile: { project: string; cell: string; recipient: string; repeat: string } | undefined;
  private disposed = false;

  constructor(private readonly server: StaffShareServer) {
    const header = el('header', undefined, 'sterling-share-header');
    const title = el('h2', STAFF_SHARE_TEXT.title);
    title.prepend(icon('organization'));
    title.id = `sterling-share-${Math.random().toString(36).slice(2)}`;
    this.node.setAttribute('aria-labelledby', title.id);
    header.append(title, el('p', STAFF_SHARE_TEXT.intro));
    this.status.setAttribute('role', 'status');
    this.node.append(header, this.status, this.body);
  }

  /** Opens the join flow filled in from an invitation file (InviteOpenHandler). */
  fillInvitation(opened: InvitationOpened): void {
    this.invitation = opened;
    void this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.node.remove();
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const answer = await this.server.view().catch(() => undefined);
    if (this.disposed) return;
    this.body.replaceChildren();
    if (this.invitation !== undefined) this.body.append(this.joinCard(this.invitation));
    if (answer === undefined || answer.kind === 'refused') {
      this.say(answer?.kind === 'refused' ? answer.reason : STAFF_SHARE_TEXT.noProject);
      return;
    }
    const view = answer.value;
    if (view.state === 'no-project') {
      this.say(STAFF_SHARE_TEXT.noProject);
      this.body.append(this.openCard());
      return;
    }
    if (view.state === 'not-shared') {
      this.say(STAFF_SHARE_TEXT.notShared);
      this.body.append(this.turnOnCard(), this.openCard());
      return;
    }
    this.say('');
    this.body.append(this.peopleCard(view));
    if (view.lead) {
      if (view.keyChanges?.length) this.body.append(this.keyChangesCard(view));
      this.body.append(this.inviteCard(view), this.serverCard(view));
    }
    if (view.project !== undefined && (view.canOpenManagedKeyFile || view.managedKeyFiles?.length)) {
      this.body.append(this.managedKeyFilesCard(view, view.project));
    }
    this.body.append(this.selfCard(view));
  }

  private say(text: string): void {
    this.status.textContent = text;
    this.status.hidden = text === '';
  }

  private card(title: string, iconName: string): HTMLElement {
    const card = el('article', undefined, 'sterling-share-card');
    const heading = el('h3', title);
    heading.prepend(icon(iconName));
    card.append(heading);
    return card;
  }

  private button(text: string, iconName: string, run: (button: HTMLButtonElement) => Promise<void>, primary = false): HTMLButtonElement {
    const node = el('button', text, primary ? 'sterling-share-primary' : 'sterling-share-action');
    node.type = 'button';
    node.prepend(icon(iconName));
    node.addEventListener('click', () => {
      node.disabled = true;
      void run(node).finally(() => { node.disabled = false; });
    });
    return node;
  }

  /** Shows an action's answer: its sentence, notices and safety words, and saves the file it made. */
  private async shown(answer: Promise<ServiceResult<ShareOutcome>>, after?: () => void): Promise<void> {
    const result = await answer.catch(() => undefined);
    if (result === undefined) { this.say(STAFF_SHARE_TEXT.noBackend); return; }
    if (result.kind === 'refused') { this.say(result.fix === undefined ? result.reason : `${result.reason} ${result.fix}.`); return; }
    const { message, notices, file, safetyWords, withheld } = result.value;
    this.say([message, ...(safetyWords === undefined ? [] : [`Six words: ${safetyWords.join(' ')}`]), ...(withheld ?? []), ...notices].join(' '));
    if (file !== undefined) save(file);
    after?.();
    await this.refresh();
  }

  private turnOnCard(): HTMLElement {
    const card = this.card(STAFF_SHARE_TEXT.turnOn, 'live-share');
    const level = levelSelect();
    card.append(labelled('Your own clearance, as you declare it', level),
      this.button(STAFF_SHARE_TEXT.turnOn, 'live-share', () => this.shown(this.server.turnOn({ clearance: clearanceOf(level.value) })), true));
    return card;
  }

  private openCard(): HTMLElement {
    const card = this.card(STAFF_SHARE_TEXT.openInvitation, 'mail');
    card.append(
      this.button(STAFF_SHARE_TEXT.openInvitation, 'folder-opened', async () => {
        const text = await readFile('.near-staff-invite');
        if (text !== undefined) this.fillInvitation({ text });
      }),
      this.button(STAFF_SHARE_TEXT.openWelcome, 'folder-opened', async () => {
        const text = await readFile('.near-staff-welcome');
        if (text !== undefined) await this.shown(this.server.openWelcome({ text }));
      }),
    );
    return card;
  }

  private joinCard(opened: InvitationOpened): HTMLElement {
    const card = this.card(opened.name === undefined ? 'Join shared work' : `Join ${opened.name}`, 'mail-read');
    if (opened.expiresAt !== undefined) card.append(el('p', STAFF_SHARE_TEXT.worksUntil(opened.expiresAt.slice(0, 10))));
    const name = input('Your name');
    card.append(labelled('Your name, as the lead knows you', name),
      this.button('Send my join request', 'send', () => this.shown(this.server.openInvitation({ text: opened.text, name: name.value.trim() }), () => { this.invitation = undefined; }), true));
    return card;
  }

  private async removeMember(project: string | undefined, member: string, requestId?: string): Promise<void> {
    const answer = await this.server.remove({ member, ...(requestId === undefined ? {} : { requestId }) }).catch(() => undefined);
    if (this.disposed) return;
    if (answer === undefined) { this.say(STAFF_SHARE_TEXT.noBackend); return; }
    if (answer.kind === 'ok' && answer.value.confirmation !== undefined) {
      this.keyChange = undefined;
      this.removal = { project, member, confirmation: answer.value.confirmation };
      await this.refresh();
      this.say(answer.value.message);
      return;
    }
    if (requestId !== undefined) {
      this.removal = undefined;
      if (answer.kind === 'refused') await this.refresh();
    }
    await this.shown(Promise.resolve(answer));
  }

  private async finishCellKeyChange(project: string | undefined, cell: string, requestId?: string): Promise<void> {
    const answer = await this.server.finishKeyChange({ cell, ...(requestId === undefined ? {} : { requestId }) }).catch(() => undefined);
    if (this.disposed) return;
    if (answer === undefined) { this.say(STAFF_SHARE_TEXT.noBackend); return; }
    if (answer.kind === 'ok' && answer.value.confirmation !== undefined) {
      this.removal = undefined;
      this.keyChange = { project, cell, confirmation: answer.value.confirmation };
      await this.refresh();
      this.say(answer.value.message);
      return;
    }
    if (requestId !== undefined) {
      this.keyChange = undefined;
      if (answer.kind === 'refused') await this.refresh();
    }
    await this.shown(Promise.resolve(answer));
  }

  private async saveManagedKeyFile(project: string, cell: string, recipient: string, repeat?: string): Promise<void> {
    const answer = await this.server.saveManagedKeys({ project, cell, recipient, ...(repeat === undefined ? {} : { repeat }) }).catch(() => undefined);
    if (this.disposed) return;
    if (answer === undefined) { this.say(STAFF_SHARE_TEXT.noBackend); return; }
    if (answer.kind === 'ok' && answer.value.fileRepeat !== undefined) {
      this.lastKeyFile = { project, cell, recipient, repeat: answer.value.fileRepeat };
    } else if (repeat !== undefined) {
      this.lastKeyFile = undefined;
      await this.refresh();
    }
    await this.shown(Promise.resolve(answer));
    if (answer.kind === 'ok') this.say(answer.value.message);
  }

  private managedKeyFilesCard(view: ShareView, project: string): HTMLElement {
    const card = this.card(STAFF_SHARE_TEXT.managedKeyFiles, 'key');
    for (const part of view.managedKeyFiles ?? []) {
      const item = el('div', undefined, 'sterling-share-row');
      const devices = el('select');
      const previous = this.lastKeyFile?.project === project && this.lastKeyFile.cell === part.cell ? this.lastKeyFile : undefined;
      for (const recipient of part.recipients) {
        const option = el('option', recipient.label);
        option.value = recipient.writer;
        option.selected = recipient.writer === previous?.recipient;
        devices.append(option);
      }
      const repeat = () => previous !== undefined && devices.value === previous.recipient ? previous.repeat : undefined;
      const button = this.button(STAFF_SHARE_TEXT.saveManagedKeys, 'save', () => this.saveManagedKeyFile(project, part.cell, devices.value, repeat()));
      const update = () => {
        button.textContent = repeat() === undefined ? STAFF_SHARE_TEXT.saveManagedKeys : STAFF_SHARE_TEXT.repeatManagedKeys;
      };
      devices.addEventListener('change', update);
      update();
      item.append(el('span', part.label), labelled(STAFF_SHARE_TEXT.managedKeyRecipient, devices), button);
      card.append(item);
    }
    if (view.canOpenManagedKeyFile) {
      card.append(this.button(STAFF_SHARE_TEXT.openManagedKeys, 'folder-opened', async () => {
        const text = await readFile(MANAGED_KEY_FILE_EXTENSION, MANAGED_KEY_FILE_MAX_BYTES, () => this.say(STAFF_SHARE_TEXT.managedKeyFileTooLarge));
        if (text !== undefined && !this.disposed) {
          const answer = await this.server.openManagedKeys({ project, text }).catch(() => undefined);
          if (answer === undefined) { this.say(STAFF_SHARE_TEXT.noBackend); return; }
          await this.shown(Promise.resolve(answer));
          if (answer.kind === 'ok') this.say(answer.value.message);
        }
      }));
    }
    return card;
  }

  private keyChangesCard(view: ShareView): HTMLElement {
    const card = this.card(STAFF_SHARE_TEXT.keyChanges, 'key');
    const list = el('ul', undefined, 'sterling-share-list');
    for (const part of view.keyChanges ?? []) {
      const item = el('li', undefined, 'sterling-share-row');
      item.append(el('span', part.label));
      const current = this.keyChange;
      const pending = current !== undefined && current.project === view.project && current.cell === part.cell ? current.confirmation : undefined;
      if (pending === undefined) item.append(this.button(STAFF_SHARE_TEXT.startKeyChange, 'key', () => this.finishCellKeyChange(view.project, part.cell)));
      else {
        const review = el('a', STAFF_SHARE_TEXT.reviewKeyChange);
        review.href = pending.url;
        review.target = '_blank';
        review.rel = 'noopener noreferrer';
        item.append(review, this.button(STAFF_SHARE_TEXT.finishKeyChange, 'key', () => this.finishCellKeyChange(view.project, part.cell, pending.requestId)));
      }
      list.append(item);
    }
    card.append(list);
    return card;
  }

  private peopleCard(view: ShareView): HTMLElement {
    const card = this.card('People', 'person');
    const list = el('ul', undefined, 'sterling-share-list');
    for (const person of view.people) {
      const item = el('li', undefined, 'sterling-share-row');
      item.append(el('span', person.seat === undefined ? person.name : `${person.name}, ${person.seat}`));
      if (view.lead) {
        const pending = this.removal?.project === view.project && this.removal?.member === person.member ? this.removal.confirmation : undefined;
        if (pending === undefined) item.append(this.button(STAFF_SHARE_TEXT.remove, 'trash', () => this.removeMember(view.project, person.member)));
        else {
          const review = el('a', STAFF_SHARE_TEXT.reviewRemoval);
          review.href = pending.url;
          review.target = '_blank';
          review.rel = 'noopener noreferrer';
          item.append(review, this.button(STAFF_SHARE_TEXT.finishRemoval, 'trash', () => this.removeMember(view.project, person.member, pending.requestId)));
        }
      }
      list.append(item);
    }
    card.append(list);
    return card;
  }

  private inviteCard(view: ShareView): HTMLElement {
    const card = this.card(STAFF_SHARE_TEXT.invite, 'person-add');
    const name = input('Name');
    const seat = input('Position, such as j4-planner');
    const level = levelSelect();
    card.append(labelled('Name', name), labelled('Position', seat), labelled('Clearance you declare for them', level),
      this.button(STAFF_SHARE_TEXT.invite, 'person-add', () => this.shown(this.server.invite({ name: name.value.trim(), seat: seat.value.trim(), clearance: clearanceOf(level.value) })), true));
    if (view.server !== undefined) card.append(this.button(STAFF_SHARE_TEXT.joinRequests, 'inbox', (button) => this.requests(card, button)));
    card.append(this.button(STAFF_SHARE_TEXT.openJoinRequest, 'folder-opened', async () => {
      const text = await readFile('.near-staff-join');
      if (text !== undefined) this.admitRow(card, { name: 'The person in this file', safetyWords: [], text });
    }));
    return card;
  }

  private async requests(card: HTMLElement, button: HTMLButtonElement): Promise<void> {
    const answer = await this.server.joinRequests().catch(() => undefined);
    if (answer === undefined || answer.kind === 'refused') { this.say(answer?.kind === 'refused' ? answer.reason : STAFF_SHARE_TEXT.noBackend); return; }
    if (answer.value.length === 0) this.say(STAFF_SHARE_TEXT.noJoinRequest);
    for (const request of answer.value) this.admitRow(card, request);
    button.focus();
  }

  private admitRow(card: HTMLElement, request: { readonly name: string; readonly safetyWords: readonly string[]; readonly text: string }): void {
    const row = el('div', undefined, 'sterling-share-request');
    row.append(el('strong', request.name));
    if (request.safetyWords.length > 0) row.append(el('p', `Compare these six words with them out loud or in person: ${request.safetyWords.join(' ')}`, 'sterling-share-words'));
    const matched = el('input');
    matched.type = 'checkbox';
    const check = el('label', STAFF_SHARE_TEXT.wordsMatch, 'sterling-share-check');
    check.prepend(matched);
    row.append(check, this.button(STAFF_SHARE_TEXT.admit, 'check', () => this.shown(this.server.admit({ request: request.text, codeMatched: matched.checked })), true));
    card.append(row);
  }

  private serverCard(view: ShareView): HTMLElement {
    const card = this.card('Your organization\'s server', 'server');
    const server = view.server;
    if (server === undefined || server.standing === 'revoked') {
      const level = levelSelect();
      card.append(labelled('Highest label the server may ever hold', level),
        this.button(STAFF_SHARE_TEXT.connect, 'plug', async () => {
          const hubFile = await readFile('.json');
          if (hubFile !== undefined) await this.shown(this.server.connectServer({ hubFile, ceiling: clearanceOf(level.value) }));
        }, true));
      return card;
    }
    card.append(el('p', server.address === undefined ? STAFF_SHARE_TEXT.noAddress : STAFF_SHARE_TEXT.reachesAt(server.address)));
    const address = input('server.example.org:8443');
    card.append(labelled(STAFF_SHARE_TEXT.changeAddress, address), this.button(STAFF_SHARE_TEXT.changeAddress, 'edit', () => this.shown(this.server.changeAddress({ address: address.value.trim() }))));
    card.append(el('p', STAFF_SHARE_TEXT.readmitHelp), el('p', server.words.join(' '), 'sterling-share-words'));
    const words = input('The twelve words');
    card.append(labelled('Words you compared', words), this.button(STAFF_SHARE_TEXT.readmit, 'shield', () => this.shown(this.server.readmit({ words: words.value }))));
    const parts = el('ul', undefined, 'sterling-share-list');
    for (const part of view.parts) {
      const item = el('li', undefined, 'sterling-share-row');
      item.append(el('span', part.onServer ? `${part.label}: held by the server` : part.label));
      if (!part.onServer) {
        item.append(this.button(STAFF_SHARE_TEXT.grant, 'unlock', async () => {
          // The trade-off is shown word for word before anything is written (DESIGN 10.2).
          const confirmed = window.confirm(STAFF_SHARE_TEXT.tradeOff);
          await this.shown(this.server.grant({ cell: part.cell, confirmed }));
        }));
      }
      parts.append(item);
    }
    card.append(parts, this.button(STAFF_SHARE_TEXT.revoke, 'debug-disconnect', () => this.shown(this.server.revoke())));
    return card;
  }

  private selfCard(view: ShareView): HTMLElement {
    const card = this.card('You', 'account');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = view.showWork;
    toggle.addEventListener('change', () => {
      void this.server.setShowWork(toggle.checked).then((answer) => this.say(answer.kind === 'ok' ? (answer.value ? STAFF_SHARE_TEXT.showWorkOn : STAFF_SHARE_TEXT.showWorkOff) : answer.reason));
    });
    const label = el('label', STAFF_SHARE_TEXT.showWork, 'sterling-share-check');
    label.prepend(toggle);
    const destination = input('/home/sterling/workspace/copy');
    card.append(label, labelled('Folder for a single-machine copy', destination),
      this.button(STAFF_SHARE_TEXT.singleCopy, 'files', () => this.shown(this.server.singleCopy({ destination: destination.value.trim() }))));
    return card;
  }
}
