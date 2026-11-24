import type { OptionKind } from './ids';
import type { RecommendReason } from './recommend';

export const STOP_CLASSIFIED_TEXT =
  'Classified and Protected C information may be processed only on a computer your organization has approved for that level. This guide cannot tell whether this computer is one. Ask {contact} before you continue.';
export const STOP_CONTRACT_TEXT =
  "Before processing your client's Protected information on your own computers, your organization needs written IT approval from the Contract Security Program for this contract. For a cloud service, your client department must approve it. Ask your company security officer.";
export const NOT_SURE_TEXT = 'We treat this as Protected B until you know. Check the marking on the documents, or ask {contact}.';
export const PROTECTED_B_EXPLAINED_TEXT =
  "Disclosing Protected B information can cause serious injury to a person, an organization or the government. A cloud service needs a Medium cloud assessment against the Canadian Centre for Cyber Security's requirements and approval from your organization after its own assessment. Contractors also need written IT approval from the Contract Security Program before processing a client's Protected information on their own computers. Your organization's rules here keep Protected B on computers it controls unless they record approval for a service.";
export const STARTING_RULES_TEXT = "These are the starting rules. Your organization's security officer decides whether to change them.";
export const DISCLAIMER_TEXT = 'Your organization categorizes information. This guide applies your answers as labels.';
export const KEPT_HIGHER_TEXT = 'This project is already labelled {label}. The guide does not lower labels.';
export const LOWERING_SEPARATE_TEXT = "Lowering this project's label is a separate decision with a recorded reason.";
export const APPROVED_DEVICE_NOTE_TEXT = 'Recorded as approved for that level by {name}.';
export const NO_RULE_FOR_NEED_TEXT = "Your organization's rules do not allow {need}. Ask {contact}.";
export const SMALLER_LOCAL_MODELS_TEXT = 'Smaller local models: slower and weaker on long agent runs.';
export const MODEL_APPROVAL_NOTE_TEXT = 'No approval on record for this model yet';
export const NO_FIT_TEXT = 'None of the available options fits this work. Ask {contact}, or set up local AI on a machine that can run it.';

const YES_NO_UNSURE_TEXT = Object.freeze({ yes: 'Yes', no: 'No', 'not-sure': 'Not sure' });

export const QUESTION_TEXT = Object.freeze({
  q1: {
    heading: 'What kind of work will you mostly do here?',
    choices: {
      software: 'Write or review software', staff: 'Staff work in a headquarters section',
      analysis: 'Analyse information and data', 'capital-projects': 'Plan or manage capital projects',
      writing: 'Write and research documents',
      'capability-development': 'Capability development: programs, products and projects',
      planning: 'Planning: operational or administrative', 'resource-management': 'Resource management',
      'exercises-training': 'Exercises and training', 'something-else': 'Something else',
    },
    staffSections: {
      j1: 'J1', j2: 'J2', j3: 'J3', j4: 'J4', j5: 'J5', j6: 'J6', j7: 'J7', j8: 'J8', j9: 'J9', joint: 'Joint staff',
    },
  },
  q2: {
    heading: "What will this project's work touch?",
    choices: {
      public: 'Only public or published information', internal: "Your organization's internal work",
      personal: 'Personal information about people, including HR, health, pay or security details',
      'protected-a': 'Documents marked Canada, Protected: Protected A',
      'protected-b': 'Documents marked Canada, Protected: Protected B',
      'protected-c': 'Documents marked Canada, Protected: Protected C',
      classified: 'Classified documents, including Canada, Classified: Confidential or higher and NATO: NATO Restricted or higher',
      contract: "A client's information under a contract with a security clause", 'not-sure': 'Not sure',
    },
  },
  q2a: {
    heading: 'Does the personal information include sensitive details such as medical information, personnel files, finances, security screening or information about children?',
    choices: YES_NO_UNSURE_TEXT,
  },
  q2b: {
    heading: "What level does the contract's security requirements check list name for the client's information?",
    choices: {
      'protected-a': 'Canada, Protected: Protected A', 'protected-b': 'Canada, Protected: Protected B',
      classified: 'Classified', 'not-sure': 'Not sure',
    },
    approvalHeading: 'Has your organization received written IT approval from the Contract Security Program for this contract?',
    approvalChoices: YES_NO_UNSURE_TEXT,
  },
  q3: { heading: 'Must the work stay in Canada, including where the AI runs?', choices: YES_NO_UNSURE_TEXT },
  q4: {
    heading: 'Will agents edit files, run commands or work while you are away?',
    choices: { agents: 'Yes, that is the point', 'answers-only': 'Only answer my questions', 'not-sure': 'Not sure' },
  },
} as const);

export const OPTION_NAME_TEXT: Readonly<Record<OptionKind, string>> = Object.freeze({
  'this-computer': 'this computer',
  'org-server': "your organization's server",
  'org-tee': "your organization's private hardware",
  'near-private': 'NEAR AI private hardware',
  'near-all': 'NEAR AI Cloud, all models',
  'vendor-tee': 'private hardware from another provider',
  'vendor-region': 'a service in a named region',
});

export const RECOMMEND_REASON_TEXT: Readonly<Record<RecommendReason, string>> = Object.freeze({
  'stays-in-canada': "We recommend {option} because it meets your organization's rules about where {label} can be processed.",
  'keeps-on-controlled-machines': "We recommend {option} because it can process {label} on a computer your organization controls.",
  'larger-models': 'Recommended: NEAR AI private hardware (checked each time it is used). Work at this label may go there, and it runs larger models than this computer can.',
  'no-option': 'No option here can hold {label}. Ask {contact}, or set up local AI on a machine that can run it.',
  'only-viable': 'We recommend {option} because it is the only available option for {label}.',
  order: 'We recommend {option} as the first option in your rules that can handle {label}.',
  classified: STOP_CLASSIFIED_TEXT,
  'protected-c': STOP_CLASSIFIED_TEXT,
  'contract-unapproved': STOP_CONTRACT_TEXT,
});

/**
 * Owner D10, D-59: in the Defence edition the guide never calls the workspace folder "this project". It names the chosen work area's own kind of
 * work, or "this folder" when the kind is not known. "Project" stays only as a Capability Development kind of work.
 */
export const FOLDER_NOUN_TEXT = Object.freeze({
  planning: 'plan',
  'resource-management': 'inventory',
  'exercises-training': 'exercise or training',
  'capability-development': 'program, product or project',
  folder: 'folder'
});

/** The word for the workspace folder, or undefined outside the Defence edition (no rewrite there). */
export function folderNoun(edition: 'ca-defence' | undefined, kindOfWork?: string): string | undefined {
  if (edition !== 'ca-defence') return undefined;
  const { folder, ...byKind }: Readonly<Record<string, string>> = FOLDER_NOUN_TEXT;
  return kindOfWork !== undefined && Object.hasOwn(byKind, kindOfWork) ? byKind[kindOfWork] : folder;
}

const oneWord = (noun: string): boolean => /^[a-z]+$/.test(noun);
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const possessive = (noun: string): string => oneWord(noun) ? `${noun}'s` : "folder's";
const titled = (noun: string): string => oneWord(noun) ? capital(noun) : 'Folder';

/** Whole phrases, tried in this order at each position. A text with none of them is returned unchanged. */
export const FOLDER_PHRASES: readonly { readonly phrase: string; to(noun: string): string }[] = Object.freeze([
  { phrase: "this project's", to: (noun: string) => `this ${possessive(noun)}` },
  { phrase: "This project's", to: (noun: string) => `This ${possessive(noun)}` },
  { phrase: 'this project’s', to: (noun: string) => `this ${possessive(noun).replace("'", '’')}` },
  { phrase: 'This project’s', to: (noun: string) => `This ${possessive(noun).replace("'", '’')}` },
  { phrase: 'a project folder', to: () => 'a folder' },
  { phrase: 'your project files', to: () => 'the files in this folder' },
  { phrase: 'the project files', to: () => 'the files in this folder' },
  { phrase: 'shared project settings', to: () => 'shared settings' },
  { phrase: 'These project settings', to: () => 'These settings' },
  { phrase: 'your project team', to: () => 'your software team' },
  { phrase: 'every project on this computer', to: () => 'every folder on this computer' },
  { phrase: 'this project', to: (noun: string) => `this ${noun}` },
  { phrase: 'This project', to: (noun: string) => `This ${noun}` },
  { phrase: 'the project', to: (noun: string) => `the ${noun}` },
  { phrase: 'The project', to: (noun: string) => `The ${noun}` },
  { phrase: 'Project label', to: (noun: string) => `${titled(noun)} label` },
  { phrase: 'Project mode', to: (noun: string) => `${titled(noun)} mode` }
].map((entry) => Object.freeze(entry)));

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PHRASE_PATTERN = new RegExp(`(?<![\\w-])(?:${FOLDER_PHRASES.map(({ phrase }) => escape(phrase)).join('|')})(?![\\w-])`, 'g');

/** User text only: one pass, so a replacement is never matched again. Code identifiers never pass through here (plan 23). */
export function applyFolderWords(text: string, noun: string): string {
  return text.replace(PHRASE_PATTERN, (found) => FOLDER_PHRASES.find(({ phrase }) => phrase === found)?.to(noun) ?? found);
}
