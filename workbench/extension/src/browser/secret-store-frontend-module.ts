import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell.js';
import type { StatefulWidget } from '@theia/core/lib/browser/shell/shell-layout-restorer.js';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar-types.js';
import { WidgetFactory, WidgetManager } from '@theia/core/lib/browser/widget-manager.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command.js';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable.js';
import { PreferenceProviderProvider, PreferenceService } from '@theia/core/lib/common/preferences/index.js';
import {
  readSecretStoreStatus, SECRET_STORE_PATH, SECRET_STORE_TEXT, SecretStoreGuideSession, SecretStoreService,
  type SecretStoreGuidance
} from '../common/secret-store.js';
import { bindFrontendService } from './frontend-service.js';
import { defaultSterlingLocale, observeSterlingLocale, type SterlingLocale } from './sterling-locale.js';

const ENTRY_ID = 'sterling-secret-store';
const ENTRY_DOM_ID = `status-bar-${ENTRY_ID}`;
const GUIDE_ID = 'sterling-secret-store-guide';
const SETUP_COMMAND = { id: 'sterling.secretStore.setup', category: 'SovAI', label: 'Secret storage setup' };
const DOCUMENTATION_COMMAND = 'sterling.documentation.open';
// Layout data cannot supply the live request object that the factory requires.
const guideRequest = Object.freeze({});

const guideCopy = {
  'en-CA': {
    title: 'Set up secret storage',
    unavailable: SECRET_STORE_TEXT.unavailable,
    unavailableStatus: 'This Workbench has no usable secret store.',
    checking: 'Checking which secret store the backend selected.',
    stale: 'The latest check did not answer. Last confirmed choice.',
    limits: 'What this affects',
    impacts: [
      'Profiles that depend on saved API keys or provider credentials cannot save or retrieve them.',
      'This Workbench cannot verify and display the active signed Standing Orders or sign and apply a change. Where permitted, you can still read and plan.',
      'Shared staff projects cannot open in this local mode.',
      'Documentation and trusted local Resource Inventory remain available with their existing access checks.'
    ],
    choices: {
      noStore: 'This Workbench could not load the system keyring module or its native binding. The standalone container ships without that module and has no configured organization store in local mode. Use a hosted Workbench your organization has already configured, or ask its administrator to provision the approved authenticated OpenBao integration. A supported Workbench running directly on a computer can use its supported system keyring when that integration is available.',
      keyringFailed: 'This Workbench could not open the computer’s keyring. Unlock or restore the supported system keyring, or ask the computer’s administrator to repair it.',
      unavailable: 'Ask the administrator to confirm whether the supported system keyring or your organization’s hosted secret store is configured.',
      keyring: 'The backend selected this computer’s keyring.',
      openbao: 'The backend selected your organization’s secret store.',
      unknown: 'The secret store choice could not be checked.'
    },
    restart: 'After setup is corrected, restart the Workbench backend and reopen this browser tab. Reloading the tab alone cannot select a different store.',
    selected: 'This reports which store the backend selected. Sign-in and each read or save have their own checks.',
    checkNote: 'Check again rereads the backend’s selected store.',
    check: 'Check again',
    docs: 'Open Documentation',
    docsFailed: 'Documentation could not be opened.',
    continue: 'Continue without secret storage',
    close: 'Close'
  },
  'fr-CA': {
    title: 'Configurer le stockage des secrets',
    unavailable: 'Le stockage des secrets est indisponible',
    unavailableStatus: 'Cet espace de travail ne dispose d’aucun stockage des secrets utilisable.',
    checking: 'Vérification du stockage des secrets sélectionné par le serveur.',
    stale: 'La dernière vérification n’a donné aucun résultat. Dernier choix confirmé.',
    limits: 'Ce que cela change',
    impacts: [
      'Les profils qui dépendent de clés API ou d’identifiants de fournisseur enregistrés ne peuvent pas les enregistrer ni les récupérer.',
      'Cet espace de travail ne peut pas vérifier et afficher les Ordres permanents signés en vigueur, ni signer et appliquer une modification. Vous pouvez continuer à lire et à planifier là où vous y êtes autorisé.',
      'Les projets d’équipe partagés ne peuvent pas s’ouvrir dans ce mode local.',
      'La Documentation et l’Inventaire local des ressources approuvées demeurent accessibles selon les contrôles d’accès habituels.'
    ],
    choices: {
      noStore: 'Cet espace de travail n’a pas pu charger le module du trousseau système ou sa liaison native. Le conteneur autonome est livré sans ce module et sans stockage organisationnel configuré en mode local. Utilisez un espace de travail hébergé déjà configuré par votre organisation ou demandez à son administrateur de fournir l’intégration OpenBao authentifiée et approuvée. Un espace de travail pris en charge qui s’exécute directement sur un ordinateur peut utiliser le trousseau système lorsque l’intégration est disponible.',
      keyringFailed: 'Cet espace de travail n’a pas pu ouvrir le trousseau de l’ordinateur. Déverrouillez ou restaurez le trousseau système pris en charge, ou demandez à l’administrateur de l’ordinateur de le réparer.',
      unavailable: 'Demandez à l’administrateur de vérifier si le trousseau système pris en charge ou le stockage des secrets hébergé par votre organisation est configuré.',
      keyring: 'Le serveur a sélectionné le trousseau de cet ordinateur.',
      openbao: 'Le serveur a sélectionné le stockage des secrets de votre organisation.',
      unknown: 'Impossible de vérifier le choix du stockage des secrets.'
    },
    restart: 'Après la correction, redémarrez le serveur de l’espace de travail, puis rouvrez cet onglet. Recharger l’onglet seul ne permet pas de sélectionner un autre stockage.',
    selected: 'Cet état indique le stockage sélectionné par le serveur. La connexion et chaque lecture ou enregistrement font l’objet de leurs propres vérifications.',
    checkNote: 'Vérifier de nouveau relit le choix du serveur.',
    check: 'Vérifier de nouveau',
    docs: 'Ouvrir la documentation',
    docsFailed: 'Impossible d’ouvrir la documentation.',
    continue: 'Continuer sans stockage des secrets',
    close: 'Fermer'
  }
};

const guideStyles = `
  #${GUIDE_ID} { overflow: auto; padding: .75rem 1rem; }
  #${GUIDE_ID} h1 { font-size: 1.15em; margin-block: 0 .5em; }
  #${GUIDE_ID} h2 { font-size: 1em; margin-block: .5em; }
  #${GUIDE_ID} .secret-store-actions { display: flex; flex-wrap: wrap; gap: .5em; }
  #${GUIDE_ID} :focus-visible, #${ENTRY_DOM_ID}:focus-visible {
    outline: 1px solid var(--theia-focusBorder);
    outline-offset: -1px;
  }
  #${GUIDE_ID} button[aria-disabled="true"] { opacity: .6; cursor: default; }
  #${GUIDE_ID} [hidden] { display: none; }
`;

class SecretStoreGuide extends BaseWidget implements StatefulWidget {
  private readonly heading = document.createElement('h1');
  private readonly status = document.createElement('p');
  private readonly explanation = document.createElement('p');
  private readonly limits = document.createElement('div');
  private readonly limitsHeading = document.createElement('h2');
  private readonly impactList = document.createElement('ul');
  private readonly nextSteps = document.createElement('p');
  readonly checkButton = document.createElement('button');
  readonly docsButton = document.createElement('button');
  private readonly closeButton = document.createElement('button');

  constructor() {
    super();
    this.id = GUIDE_ID;
    this.title.closable = true;
    const section = document.createElement('section');
    this.heading.id = `${GUIDE_ID}-heading`;
    this.heading.tabIndex = -1;
    // Lumino owns the widget node's tabpanel role and label. Name the guide within it.
    section.setAttribute('aria-labelledby', this.heading.id);
    this.status.setAttribute('role', 'status');
    this.limits.append(this.limitsHeading, this.impactList);
    const actions = document.createElement('div');
    actions.className = 'secret-store-actions';
    for (const button of [this.checkButton, this.docsButton, this.closeButton]) {
      button.type = 'button';
      button.className = 'theia-button';
      actions.append(button);
    }
    this.closeButton.addEventListener('click', () => this.close());
    section.append(this.heading, this.status, this.explanation, this.limits, this.nextSteps, actions);
    this.node.append(section);
  }

  renderGuidance(guidance: SecretStoreGuidance, locale: SterlingLocale, checking: boolean, docsAvailable: boolean, docsFailed: boolean): void {
    const copy = guideCopy[locale];
    const unavailable = guidance.confirmed?.store === 'unavailable';
    const choiceText = copy.choices[guidance.choice];
    const status = unavailable ? copy.unavailableStatus : choiceText;
    this.title.label = this.heading.textContent = copy.title;
    this.node.lang = locale;
    this.status.textContent = [checking ? copy.checking : status, docsFailed ? copy.docsFailed : ''].filter(Boolean).join(' ');
    if (!checking && guidance.stale) this.status.textContent = `${copy.stale} ${this.status.textContent}`;
    this.explanation.textContent = unavailable ? choiceText : guidance.confirmed ? copy.selected : '';
    this.explanation.hidden = !this.explanation.textContent;
    this.limits.hidden = !unavailable;
    if (unavailable) {
      this.limitsHeading.textContent = copy.limits;
      this.impactList.replaceChildren(...copy.impacts.map(text => {
        const item = document.createElement('li');
        item.textContent = text;
        return item;
      }));
    }
    this.nextSteps.textContent = unavailable ? `${copy.restart} ${copy.checkNote}` : copy.checkNote;
    this.checkButton.textContent = copy.check;
    // Keep focus on the control while its action is guarded by the in-flight check.
    this.checkButton.setAttribute('aria-disabled', String(checking));
    this.docsButton.textContent = copy.docs;
    // The limitations list already names the Documentation view when its shortcut is unavailable.
    this.docsButton.hidden = !unavailable || !docsAvailable;
    this.closeButton.textContent = unavailable ? copy.continue : copy.close;
  }

  protected override onActivateRequest(): void {
    this.heading.focus();
  }

  storeState(): undefined { return undefined; }
  restoreState(): void { /* Guidance follows the current session rather than a saved layout. */ }
}

@injectable()
class SecretStoreView implements FrontendApplicationContribution, CommandContribution {
  @inject(SecretStoreService) private readonly service!: SecretStoreService;
  @inject(StatusBar) private readonly statusBar!: StatusBar;
  @inject(CommandRegistry) private readonly commands!: CommandRegistry;
  @inject(ApplicationShell) private readonly shell!: ApplicationShell;
  @inject(WidgetManager) private readonly widgets!: WidgetManager;
  @inject(PreferenceService) private readonly preferences!: PreferenceService;
  @inject(PreferenceProviderProvider) private readonly preferenceProviders!: PreferenceProviderProvider;

  private readonly shutdown = new AbortController();
  private readonly toDispose = new DisposableCollection();
  private readonly session = new SecretStoreGuideSession();
  private locale: SterlingLocale = defaultSterlingLocale;
  private checking?: Promise<void>;
  private opening?: Promise<void>;
  private guide?: SecretStoreGuide;
  private returnFocus?: () => void;
  private docsFailed = false;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(SETUP_COMMAND, { execute: () => this.openGuide() });
  }

  onDidInitializeLayout(): void {
    const style = document.createElement('style');
    style.textContent = guideStyles;
    document.head.append(style);
    this.toDispose.push(Disposable.create(() => style.remove()));
    this.enableStatusKeyboard();
    this.toDispose.push(observeSterlingLocale(this.preferences, this.preferenceProviders, locale => {
      this.locale = locale;
      this.renderGuide();
      this.updateStatus();
    }));
    void this.check();
  }

  onStop(): void {
    this.shutdown.abort();
    this.toDispose.dispose();
    this.guide?.dispose();
  }

  private check(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = readSecretStoreStatus(this.service, this.shutdown.signal).then(status => {
      if (this.shutdown.signal.aborted) return;
      this.session.accept(status);
      this.updateStatus();
    }).finally(() => {
      this.checking = undefined;
      if (!this.shutdown.signal.aborted) this.renderGuide();
    });
    void this.checking.then(() => {
      if (this.session.automaticallyOpen) return this.openGuide();
      return undefined;
    }).catch(() => undefined); // The status entry remains available if the panel cannot open.
    this.renderGuide();
    return this.checking;
  }

  private updateStatus(): void {
    const { guidance } = this.session;
    if (guidance.confirmed?.store !== 'unavailable') {
      void this.statusBar.removeElement(ENTRY_ID);
      return;
    }
    const copy = guideCopy[this.locale];
    const reason = copy.choices[guidance.choice];
    void this.statusBar.setElement(ENTRY_ID, {
      text: `$(warning) ${copy.unavailable}`,
      tooltip: guidance.stale ? `${copy.stale} ${reason}` : reason,
      command: SETUP_COMMAND.id,
      accessibilityInformation: { label: copy.unavailable, role: 'button' },
      alignment: StatusBarAlignment.LEFT,
      priority: 99
    });
  }

  private enableStatusKeyboard(): void {
    const bar = this.shell.node.querySelector<HTMLElement>('#theia-statusBar');
    if (!bar) return;
    // Theia renders command entries as divs without a tab stop or key handler.
    const makeFocusable = (): void => bar.querySelector(`#${ENTRY_DOM_ID}`)?.setAttribute('tabindex', '0');
    const keyboard = (event: KeyboardEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.id !== ENTRY_DOM_ID || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      if (!event.repeat) target.click();
    };
    const observer = new MutationObserver(makeFocusable);
    observer.observe(bar, { childList: true, subtree: true });
    bar.addEventListener('keydown', keyboard);
    makeFocusable();
    this.toDispose.push(Disposable.create(() => {
      observer.disconnect();
      bar.removeEventListener('keydown', keyboard);
    }));
  }

  private openGuide(): Promise<void> {
    if (this.shutdown.signal.aborted) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = this.revealGuide().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async revealGuide(): Promise<void> {
    const opener = document.activeElement;
    if (!this.guide?.node.contains(opener)) {
      const previous = this.shell.activeWidget ?? this.shell.currentWidget;
      this.returnFocus = () => {
        if (opener instanceof HTMLElement && opener.isConnected) {
          opener.focus();
          if (document.activeElement === opener) return;
        }
        const current = this.shell.activeWidget ?? this.shell.currentWidget;
        const fallback = current && !current.isDisposed ? current : previous;
        if (fallback?.isAttached) void this.shell.activateWidget(fallback.id);
      };
    }
    if (!this.guide) {
      const widget = await this.widgets.getOrCreateWidget<SecretStoreGuide>(GUIDE_ID, guideRequest);
      if (this.shutdown.signal.aborted) {
        widget.dispose();
        return;
      }
      this.guide = widget;
      this.docsFailed = false;
      widget.checkButton.addEventListener('click', () => { if (!this.checking) void this.check(); });
      widget.docsButton.addEventListener('click', () => void this.openDocumentation(widget));
      widget.node.addEventListener('focusin', () => this.markGuideVisible(widget));
      widget.disposed.connect(() => {
        const restore = this.returnFocus;
        this.returnFocus = undefined;
        this.guide = undefined;
        queueMicrotask(() => {
          if (!this.shutdown.signal.aborted && !this.guide) restore?.();
        });
      });
      this.renderGuide();
      try {
        await this.shell.addWidget(widget, { area: 'bottom' });
      } catch (error) {
        widget.dispose(); // Releases both this contribution's reference and the WidgetManager cache.
        throw error;
      }
    }
    const guide = this.guide;
    if (guide && !this.shutdown.signal.aborted) {
      void this.shell.activateWidget(guide.id).then(() => this.markGuideVisible(guide), () => undefined);
    }
  }

  private canOpenDocumentation(): boolean {
    return !!this.commands.getCommand(DOCUMENTATION_COMMAND) && this.commands.isEnabled(DOCUMENTATION_COMMAND);
  }

  private async openDocumentation(widget: SecretStoreGuide): Promise<void> {
    this.docsFailed = false;
    this.renderGuide();
    try {
      if (!this.canOpenDocumentation()) throw new Error('Documentation is disabled.');
      await this.commands.executeCommand(DOCUMENTATION_COMMAND);
    } catch {
      if (this.shutdown.signal.aborted || this.guide !== widget) return;
      this.docsFailed = true;
      this.renderGuide();
    }
  }

  private renderGuide(): void {
    const guide = this.guide;
    if (!guide) return;
    guide.renderGuidance(this.session.guidance, this.locale, !!this.checking, this.canOpenDocumentation(), this.docsFailed);
    this.markGuideVisible(guide);
  }

  private markGuideVisible(guide: SecretStoreGuide): void {
    if (guide === this.guide && guide.isAttached && guide.isVisible) this.session.markVisible();
  }
}

export default new ContainerModule(bind => {
  bind(WidgetFactory).toConstantValue({
    id: GUIDE_ID,
    createWidget: (options: unknown) => {
      if (options !== guideRequest) throw new Error('The secret storage guide has no saved layout.');
      return new SecretStoreGuide();
    }
  });
  bindFrontendService<SecretStoreService>(bind, SecretStoreService, SECRET_STORE_PATH);
  bind(SecretStoreView).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(SecretStoreView);
  bind(CommandContribution).toService(SecretStoreView);
});
