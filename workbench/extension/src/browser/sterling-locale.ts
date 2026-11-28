import { Disposable } from '@theia/core/lib/common/disposable.js';
import { PreferenceScope, type PreferenceContribution, type PreferenceProviderProvider, type PreferenceService } from '@theia/core/lib/common/preferences/index.js';

const languagePreference = 'sterling.displayLanguage';
export const defaultSterlingLocale = 'en-CA';
export type SterlingLocale = typeof defaultSterlingLocale | 'fr-CA';

export const sterlingLanguagePreference: PreferenceContribution = {
  schema: {
    title: 'Sterling',
    properties: {
      [languagePreference]: {
        type: 'string',
        enum: [defaultSterlingLocale, 'fr-CA'],
        enumItemLabels: ['English (Canada)', 'Français (Canada)'],
        default: defaultSterlingLocale,
        scope: PreferenceScope.User,
        overridable: false,
        description: 'Display language for supported Sterling views. Langue d’affichage des vues Sterling prises en charge.'
      }
    }
  }
};

export function observeSterlingLocale(
  preferences: PreferenceService, providers: PreferenceProviderProvider, update: (locale: SterlingLocale) => void
): Disposable {
  const user = providers(PreferenceScope.User);
  if (!user) {
    update(defaultSterlingLocale);
    return Disposable.NULL;
  }
  const ready = Promise.all([user.ready, preferences.ready]);
  let disposed = false;
  const refresh = (): void => {
    void ready.then(() => {
      if (disposed) return;
      const value = preferences.inspectInScope(languagePreference, PreferenceScope.User);
      update(value === 'fr-CA' ? value : defaultSterlingLocale);
    }, () => { if (!disposed) update(defaultSterlingLocale); });
  };
  // A hand-edited workspace value can shadow aggregate notifications. Observe the User provider directly.
  const listener = user.onDidPreferencesChanged(changes => {
    if (changes.some(change => change.preferenceName === languagePreference && !change.overrideIdentifier)) refresh();
  });
  refresh();
  return Disposable.create(() => {
    disposed = true;
    listener.dispose();
  });
}

const english = {
  aboutTitle: 'About Sterling Sov AI',
  aboutVersion: 'Version {version}',
  aboutVersionUnavailable: 'Version unavailable',
  aboutClose: 'Close',
  started: 'Get Started',
  edition: 'Canadian Defence Edition',
  heroDescription: 'Choose where your models run, build agent teams, and govern what they can do.',
  domains: 'Cyber · Space · Land · Sea · Air',
  playMotion: 'Play hero animation',
  pauseMotion: 'Pause hero animation',
  setup: 'Set up Sterling',
  openChat: 'Open Chat',
  sampleTeam: 'Explore a sample agent team',
  workAreas: 'Defence work areas',
  areaComponents: 'Capability components',
  activeArea: 'Open work area: {title}',
  capability: 'Capability Development',
  capabilityDescription: 'Organize the programs, projects, and products that deliver a capability.',
  training: 'Exercises & Training',
  trainingDescription: 'Prepare exercises and organize training.',
  planning: 'Planning',
  planningDescription: 'Develop strategic, operational, and tactical plans.',
  resources: 'Resource Management',
  resourcesDescription: 'Coordinate people, equipment, and capacity.',
  openLocalInventory: 'Open local Resource Inventory',
  actionUnavailable: 'This action is unavailable while the workbench is opening. Try again in a moment.',
  actionFailed: 'Sterling could not open this view. Try again after the workbench finishes loading.',
  shortcuts: 'Sterling shortcuts',
  portfolio: 'Portfolio',
  chat: 'Chat',
  teamStudio: 'Team Studio',
  agentActivity: 'Agent Activity',
  governance: 'Standing Orders',
  dataManagement: 'Data Management',
  contextGraph: 'Context Graph',
  contextGraphDescription: 'A connected graph shows how activities, responsibilities and resources relate across the evidence you can access.',
  contextGraphUnavailable: 'Context Graph is unavailable. No governed graph source is connected.',
  contextGraphDocumentation: 'Open Documentation',
  modelFactory: 'Model Factory',
  compliance: 'Compliance',
  documentation: 'Documentation',
  planned: '{label} (planned)',
  shortcutFailed: 'Could not open {label}. Wait a moment and try again.'
};

export type SterlingMessage = keyof typeof english;
export const sterlingMessages: Record<SterlingLocale, Readonly<Record<SterlingMessage, string>>> = {
  'en-CA': english,
  'fr-CA': {
    aboutTitle: 'À propos de Sterling Sov AI',
    aboutVersion: 'Version {version}',
    aboutVersionUnavailable: 'Version indisponible',
    aboutClose: 'Fermer',
    started: 'Premiers pas',
    edition: 'Édition canadienne pour la défense',
    heroDescription: 'Choisissez où exécuter vos modèles, créez des équipes d’agents et définissez ce qu’elles peuvent faire.',
    domains: 'Cyberespace · Espace · Terre · Mer · Air',
    playMotion: 'Reprendre l’animation',
    pauseMotion: 'Mettre l’animation en pause',
    setup: 'Configurer Sterling',
    openChat: 'Ouvrir la conversation',
    sampleTeam: 'Explorer un exemple d’équipe d’agents',
    workAreas: 'Espaces de travail de la défense',
    areaComponents: 'Composantes de la capacité',
    activeArea: 'Espace de travail ouvert : {title}',
    capability: 'Développement des capacités',
    capabilityDescription: 'Organisez les programmes, les projets et les produits qui contribuent à une capacité.',
    training: 'Exercices et entraînement',
    trainingDescription: 'Préparez les exercices et organisez l’entraînement.',
    planning: 'Planification',
    planningDescription: 'Élaborez des plans stratégiques, opérationnels et tactiques.',
    resources: 'Gestion des ressources',
    resourcesDescription: 'Coordonnez le personnel, le matériel et les capacités.',
    openLocalInventory: 'Ouvrir l’inventaire local des ressources',
    actionUnavailable: 'Cette action n’est pas disponible pendant l’ouverture de l’espace de travail. Réessayez dans un instant.',
    actionFailed: 'Sterling n’a pas pu ouvrir cette vue. Réessayez après le chargement de l’espace de travail.',
    shortcuts: 'Raccourcis Sterling',
    portfolio: 'Portefeuille',
    chat: 'Conversation',
    teamStudio: 'Studio d’équipes',
    agentActivity: 'Activité des agents',
    governance: 'Ordres permanents',
    dataManagement: 'Gestion des données',
    contextGraph: 'Graphe contextuel',
    contextGraphDescription: 'Un graphe connecté montre les liens entre les activités, les responsabilités et les ressources dans les éléments probants auxquels vous avez accès.',
    contextGraphUnavailable: 'Le graphe contextuel est indisponible. Aucune source de données régie n’est connectée.',
    contextGraphDocumentation: 'Ouvrir la documentation',
    modelFactory: 'Fabrique de modèles',
    compliance: 'Conformité',
    documentation: 'Documentation',
    planned: '{label} (prévu)',
    shortcutFailed: 'Impossible d’ouvrir « {label} ». Réessayez dans un instant.'
  }
};
