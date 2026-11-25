import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import {
  CARD_TEXT, nextStep, requestsSection, rowFor, typeOptions, type CardAction, type CredentialRow, type IssueStep,
} from '../../common/issue-credential-card.js';
import { ISSUER_TEXT, IssuerServiceRpc, type IssuableType, type IssueRequest } from '../../common/issuer-service.js';
import type { ServiceResult } from '../../common/service-result.js';
import '../issue-credential.css';

/**
 * The native Issue credential card (Phase 71, 71-12; D-15, D-21, D-22). It renders what the issuer service answers and calls it; no key, token or
 * engine code is in the browser. The officer picks a type their roles allow, fills in the claims in plain words, reads the one review sentence,
 * then confirms, which needs a fresh passkey or security key step-up. Revoke and Suspend each have their own review sentence. The "Credentials to
 * revoke" section appears only while a revocation request is open. Theme variables, lifted cards and codicons; every control is a native button,
 * select or input, so the card works by keyboard.
 */
export const ISSUE_CREDENTIAL_WIDGET_ID = 'sterling-issue-credential';
const CONFIRM_STEP_UP = 'sterling.session.confirmWithSecurityKey';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name: string): HTMLSpanElement {
  const node = element('span', `codicon codicon-${name}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}
function button(label: string, iconName: string | undefined, onClick: () => void, primary = false): HTMLButtonElement {
  const node = element('button', primary ? 'theia-button sterling-issue-primary' : 'theia-button secondary');
  node.type = 'button';
  if (iconName !== undefined) node.append(icon(iconName), ' ');
  node.append(label);
  node.addEventListener('click', onClick);
  return node;
}

@injectable()
export class IssueCredentialWidget extends BaseWidget {
  @inject(IssuerServiceRpc) private readonly service!: IssuerServiceRpc;
  @inject(CommandService) private readonly commands!: CommandService;

  private readonly status = element('p', 'sterling-issue-status');
  private readonly issueCard = element('section', 'sterling-issue-card');
  private readonly issuedCard = element('section', 'sterling-issue-card');
  private readonly requestsCard = element('section', 'sterling-issue-card sterling-issue-requests');
  private types: readonly IssuableType[] = [];
  private step: IssueStep = { step: 'form' };
  private chosen: string | undefined;
  private values: Record<string, string> = {};
  private pending: IssueRequest | undefined;
  private confirming: { hash: string; action: CardAction; review: string } | undefined;

  @postConstruct()
  protected init(): void {
    this.id = ISSUE_CREDENTIAL_WIDGET_ID;
    this.title.label = CARD_TEXT.title;
    this.title.caption = CARD_TEXT.title;
    this.title.iconClass = 'codicon codicon-verified';
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass('sterling-issue');
    this.status.setAttribute('role', 'status');
    this.requestsCard.hidden = true;
    const shell = element('main', 'sterling-issue-shell');
    const header = element('header', 'sterling-issue-header');
    header.append(element('h1', undefined, CARD_TEXT.title), button(CARD_TEXT.refresh, 'refresh', () => void this.load()));
    shell.append(header, element('p', 'sterling-issue-intro', CARD_TEXT.intro), this.status, this.requestsCard, this.issueCard, this.issuedCard);
    this.node.append(shell);
    void this.load();
  }

  protected override onActivateRequest(): void {
    (this.node.querySelector<HTMLElement>('select, input, button') ?? this.node).focus();
  }

  private say(message: string): void {
    this.status.textContent = message;
  }

  /** A refusal's sentence; when it asks for a step-up, a button that starts it. */
  private refusal(result: Extract<ServiceResult<unknown>, { kind: 'refused' }>, into: HTMLElement): void {
    into.replaceChildren(element('p', 'sterling-issue-refusal', result.reason));
    if (result.fix === ISSUER_TEXT.confirm) into.append(button(ISSUER_TEXT.confirm, 'key', () => void this.commands.executeCommand(CONFIRM_STEP_UP), true));
  }

  private async load(): Promise<void> {
    this.say('');
    const [types, issued, requests] = await Promise.all([this.service.issuableTypes(), this.service.listIssued(), this.service.listRevocationRequests()]);
    if (this.isDisposed) return;
    if (types.kind === 'ok') {
      this.types = types.value;
      this.chosen ??= this.types[0]?.type;
      this.renderIssue();
    } else {
      this.refusal(types, this.issueCard);
    }
    this.renderIssued(issued.kind === 'ok' ? issued.value.map(rowFor) : undefined, issued.kind === 'refused' ? issued : undefined);
    const sections = requests.kind === 'ok' ? requestsSection(requests.value) : undefined;
    this.requestsCard.hidden = sections === undefined;
    if (sections !== undefined) {
      this.requestsCard.replaceChildren(element('h2', undefined, CARD_TEXT.toRevoke), element('p', 'sterling-issue-intro', CARD_TEXT.toRevokeIntro));
      for (const section of sections) {
        const block = element('article', 'sterling-issue-request');
        const heading = element('h3');
        heading.append(icon('warning'), ` ${section.heading}`);
        block.append(heading);
        if (section.detail !== '') block.append(element('p', undefined, `${section.detail}. ${CARD_TEXT.seen} ${section.seenAt ?? ''}`));
        if (section.empty !== undefined) block.append(element('p', 'sterling-issue-muted', section.empty));
        block.append(this.rows(section.rows, section.id));
        this.requestsCard.append(block);
      }
    }
  }

  private renderIssue(): void {
    const card = this.issueCard;
    card.replaceChildren(element('h2', undefined, CARD_TEXT.title));
    if (this.types.length === 0) {
      card.append(element('p', 'sterling-issue-muted', CARD_TEXT.nothingIssuable));
      return;
    }
    const step = this.step;
    if (step.step === 'review' || step.step === 'signing') {
      const sentence = element('p', 'sterling-issue-review', step.sentence);
      sentence.setAttribute('aria-live', 'polite');
      card.append(sentence);
      if (step.step === 'signing') { card.append(element('p', 'sterling-issue-muted', CARD_TEXT.signing)); return; }
      const actions = element('div', 'sterling-issue-actions');
      actions.append(button(CARD_TEXT.confirm, 'key', () => void this.confirm(), true), button(CARD_TEXT.back, 'arrow-left', () => this.move({ kind: 'back' })));
      card.append(actions);
      return;
    }
    if (step.step === 'done') {
      card.append(element('p', 'sterling-issue-review', step.sentence));
      if (step.fileName !== undefined) card.append(button(`${CARD_TEXT.download}: ${step.fileName}`, 'save', () => this.saveFile()));
      card.append(button(CARD_TEXT.title, 'add', () => this.move({ kind: 'again' })));
      return;
    }
    const form = element('form', 'sterling-issue-form');
    form.addEventListener('submit', (event) => { event.preventDefault(); void this.review(); });
    const picker = element('select');
    for (const option of typeOptions(this.types)) {
      const node = element('option', undefined, option.label);
      node.value = option.value;
      node.selected = option.value === this.chosen;
      picker.append(node);
    }
    picker.addEventListener('change', () => { this.chosen = picker.value; this.values = {}; this.renderIssue(); });
    form.append(this.labelled(CARD_TEXT.type, picker));
    const type = this.types.find((entry) => entry.type === this.chosen);
    for (const field of type?.fields ?? []) {
      let control: HTMLInputElement | HTMLSelectElement;
      if (field.kind === 'choice') {
        control = element('select');
        for (const option of field.options ?? []) {
          const node = element('option', undefined, option.label);
          node.value = option.value;
          control.append(node);
        }
        if (this.values[field.name] === undefined && field.options?.length) this.values[field.name] = field.options[field.options.length - 1]?.value ?? '';
      } else {
        control = element('input');
        control.type = field.kind === 'date' ? 'date' : 'text';
        if (field.kind === 'person') control.placeholder = 'did:webvh:…';
      }
      control.name = field.name;
      control.value = this.values[field.name] ?? '';
      control.addEventListener('input', () => { this.values[field.name] = control.value; });
      control.addEventListener('change', () => { this.values[field.name] = control.value; });
      form.append(this.labelled(field.label, control, field.hint));
    }
    const delivery = element('select');
    for (const [value, label] of [['inbox', 'Their wallet in your organization'], ['file', 'A file for a single computer']] as const) {
      const node = element('option', undefined, label);
      node.value = value;
      node.selected = (this.values.delivery ?? 'inbox') === value;
      delivery.append(node);
    }
    delivery.addEventListener('change', () => { this.values.delivery = delivery.value; });
    form.append(this.labelled('Deliver to', delivery));
    if (step.message !== undefined) {
      const refusal = element('p', 'sterling-issue-refusal', step.message);
      refusal.setAttribute('role', 'alert');
      form.append(refusal);
      if (step.message.endsWith(`${ISSUER_TEXT.confirm}.`)) form.append(button(ISSUER_TEXT.confirm, 'key', () => void this.commands.executeCommand(CONFIRM_STEP_UP)));
    }
    const submit = element('button', 'theia-button sterling-issue-primary');
    submit.type = 'submit';
    submit.append(icon('eye'), ` ${CARD_TEXT.review}`);
    form.append(submit);
    card.append(form);
  }

  private labelled(text: string, control: HTMLElement, hint?: string): HTMLLabelElement {
    const label = element('label', 'sterling-issue-field');
    label.append(element('span', undefined, text), control);
    if (hint !== undefined) label.append(element('small', 'sterling-issue-muted', hint));
    return label;
  }

  private request(): IssueRequest | undefined {
    const type = this.types.find((entry) => entry.type === this.chosen);
    if (type === undefined) return undefined;
    const claims: Record<string, string> = {};
    for (const field of type.fields) if (!['subject', 'personName', 'until'].includes(field.name)) claims[field.name] = this.values[field.name] ?? '';
    return {
      type: type.type, subject: (this.values.subject ?? '').trim(), personName: this.values.personName ?? '', claims, until: this.values.until ?? '',
      delivery: this.values.delivery === 'file' ? 'file' : 'inbox',
    };
  }

  private move(event: Parameters<typeof nextStep>[1]): void {
    this.step = nextStep(this.step, event);
    this.renderIssue();
  }

  private async review(): Promise<void> {
    const request = this.request();
    if (request === undefined) return;
    const answer = await this.service.review(request);
    this.pending = request;
    this.move(answer.kind === 'ok' ? { kind: 'reviewed', sentence: answer.value.sentence } : { kind: 'refused', reason: answer.reason, ...(answer.fix === undefined ? {} : { fix: answer.fix }) });
  }

  private lastFile: { fileName: string; text: string } | undefined;

  private async confirm(): Promise<void> {
    if (this.pending === undefined) return;
    this.move({ kind: 'confirm' });
    const answer = await this.service.issue(this.pending);
    if (answer.kind === 'ok') {
      this.lastFile = answer.value.file;
      this.values = {};
      this.move({ kind: 'issued', sentence: answer.value.sentence, ...(answer.value.file === undefined ? {} : { fileName: answer.value.file.fileName }) });
      void this.load();
    } else {
      this.move({ kind: 'refused', reason: answer.reason, ...(answer.fix === undefined ? {} : { fix: answer.fix }) });
    }
  }

  private saveFile(): void {
    if (this.lastFile === undefined) return;
    const link = element('a');
    link.href = URL.createObjectURL(new Blob([this.lastFile.text], { type: 'application/json' }));
    link.download = this.lastFile.fileName;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  private renderIssued(rows: readonly CredentialRow[] | undefined, refusal: Extract<ServiceResult<unknown>, { kind: 'refused' }> | undefined): void {
    this.issuedCard.replaceChildren(element('h2', undefined, CARD_TEXT.issued));
    if (refusal !== undefined) {
      const box = element('div');
      this.refusal(refusal, box);
      this.issuedCard.append(box);
      return;
    }
    if (rows === undefined || rows.length === 0) { this.issuedCard.append(element('p', 'sterling-issue-muted', CARD_TEXT.noneIssued)); return; }
    this.issuedCard.append(this.rows(rows));
  }

  /** A list of credentials, each with its state in words and an icon, and the actions it allows; an action asks first with its review sentence. */
  private rows(rows: readonly CredentialRow[], requestId?: string): HTMLUListElement {
    const list = element('ul', 'sterling-issue-list');
    for (const row of rows) {
      const item = element('li', 'sterling-issue-row');
      const state = element('span', 'sterling-issue-state');
      state.append(icon(row.icon), ` ${row.state}`);
      item.append(element('strong', undefined, row.title), state, element('span', 'sterling-issue-muted', `Until ${row.until}`));
      const actions = element('div', 'sterling-issue-actions');
      if (this.confirming?.hash === row.hash) {
        actions.append(element('p', 'sterling-issue-review', this.confirming.review),
          button(CARD_TEXT.confirm, 'key', () => void this.act(row.hash, requestId), true),
          button(CARD_TEXT.cancel, 'close', () => { this.confirming = undefined; void this.load(); }));
      } else {
        for (const action of row.actions) {
          actions.append(button(action.label, action.action === 'revoke' ? 'circle-slash' : action.action === 'suspend' ? 'debug-pause' : 'debug-start', () => {
            this.confirming = { hash: row.hash, action: action.action, review: action.review };
            void this.load();
          }));
        }
      }
      item.append(actions);
      list.append(item);
    }
    return list;
  }

  private async act(hash: string, requestId?: string): Promise<void> {
    const confirming = this.confirming;
    if (confirming === undefined || confirming.hash !== hash) return;
    this.confirming = undefined;
    const call = confirming.action === 'revoke' ? this.service.revoke(hash) : confirming.action === 'suspend' ? this.service.suspend(hash) : this.service.clearSuspension(hash);
    const answer = await call;
    if (answer.kind === 'refused') this.say(answer.fix === undefined ? answer.reason : `${answer.reason} ${answer.fix}.`);
    // After the last of that person's credentials ends, the request is removed (it stays while any other officer's remain).
    if (answer.kind === 'ok' && requestId !== undefined) await this.service.resolveRequest(requestId);
    await this.load();
  }
}
