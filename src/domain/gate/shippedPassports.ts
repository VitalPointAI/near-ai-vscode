// The passports and use-tier tables the extension ships (model provenance design 5.5 and 6.1, Phase 41 D-42, D-59). Pure data: no I/O, no clock, no vscode.
// They are part of the starting rules. Your organization's policy replaces a shipped passport by its `id`, so an id here never changes meaning: a corrected
// fact about the same model (licence, teachers, match ids for that model, hosting) keeps the id (74.1 D-09), and a row for a different model gets a new id.
// Every row passes parseModelsSection, none claims T3 or carries an evaluation (T3 needs your organization's own evaluation of the exact artifact), and
// every row whose base comes from the PRC is T0. Licences were re-read at each publisher on 2026-11-25 (74.1-RESEARCH.md section 1).
// No row names exact weights: an org-tee, org-plain or local passport for Command A+, Nemotron 3 or gpt-oss needs the SHA-256 of the weights (the artifact
// rule of 5.2), which only your organization's own passport for its own copy can carry. That passport adds org-tee with its artifact; these rows list
// nearai-tee, or for Command A+ the Cohere Model Vault classes (74.1 D-05), only (D-59). There is no row for abliterated derivatives or the privacy filter:
// an unlisted model is already T0 by `unknownMaxTier`, which is the effect those rows would have.
// Patterns are exact or anchored ids, never a brand name inside an id (8.2): `openai/gpt-oss-*` is open weights and is kept apart from the closed GPT API
// rows, whose patterns start with a version digit; `google/gemini-*` names the closed Gemini API and not Google's open-weight models.
// Each row has one literal `id: '<id>'` line: scripts/resource-check.mjs discovers the model inventory from those lines (74.1 D-10).
// This file imports types only, so models.ts may import it without a load-time cycle.
import type { Passport, PassportLegal, PassportLineage, PassportLicence, UseTier } from './models';
import type { EndpointClass } from './endpoints';

const ISSUED_AT = '2026-11-20T00:00:00.000Z';
const EXPIRES_AT = '2027-11-20T00:00:00.000Z';
const EVERY_TRIGGER = ['artifact-change', 'canada-law-change', 'fine-tune', 'hosting-change', 'licence-change', 'quantization', 'us-law-change'] as const;
const NO_FLAGS: PassportLegal = { coveredByUsLaw: false, entityList: false, removalOrders: [] };
// NVIDIA's Nemotron 3 cards name these post-training teachers (Super: DeepSeek, Qwen3 and Qwen3-Coder, Kimi K2 and gpt-oss-120b; Nano the same families;
// Ultra names no teacher on its card and keeps the family's list).
const NEMOTRON3_TEACHERS = [
  { model: 'DeepSeek V3.2', origin: 'CN', method: 'synthetic-data' },
  { model: 'Kimi K2', origin: 'CN', method: 'synthetic-data' },
  { model: 'Qwen3-Coder', origin: 'CN', method: 'synthetic-data' },
  { model: 'gpt-oss-120b', origin: 'US', method: 'synthetic-data' }
] as const;
const NEMOTRON3_LICENCE: Readonly<Record<'Nano' | 'Super' | 'Ultra', string>> = {
  Nano: 'NVIDIA Nemotron Open Model License',
  Super: 'NVIDIA Nemotron Open Model License',
  Ultra: 'OpenMDW-1.1'
};
// Command A+ 05-2026 is Apache 2.0 at Cohere (blog, docs, Hugging Face); the obligations carry the owner's hosting rule (74.1 D-05).
const COMMAND_A_PLUS_LICENCE: PassportLicence = {
  inherited: [], id: 'Apache-2.0',
  obligations: ['attribution', "Cohere's Usage Policy applies when Cohere hosts it (Model Vault)", "Your organization's own on-premise copy: your organization's passport with its artifact hash"]
};

interface Row {
  readonly id: string;
  readonly match: readonly string[];
  readonly developer: string;
  readonly origin: string;
  readonly lineage: PassportLineage;
  readonly licence: PassportLicence;
  readonly legal?: PassportLegal;
  readonly hosting: readonly EndpointClass[];
  readonly maxTier: UseTier;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function row(fields: Row): Passport {
  return {
    id: fields.id, match: fields.match, developer: fields.developer, origin: fields.origin, lineage: fields.lineage, licence: fields.licence,
    legal: fields.legal ?? NO_FLAGS, hosting: fields.hosting, maxTier: fields.maxTier, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, reevaluateOn: EVERY_TRIGGER
  };
}

/** The Nemotron 3 fields shared by every size; the row itself states its id. */
function nemotron3(size: 'Nano' | 'Super' | 'Ultra'): Omit<Row, 'id'> {
  return {
    match: [`nvidia/NVIDIA-Nemotron-3-${size}-*`],
    developer: 'NVIDIA',
    origin: 'US',
    lineage: { family: 'nemotron', base: `Nemotron 3 ${size} (pretrained from scratch by NVIDIA)`, teachers: NEMOTRON3_TEACHERS, method: 'pretrain+sft+rl' },
    licence: { id: NEMOTRON3_LICENCE[size], obligations: ['attribution'], inherited: ['check NVIDIA dataset licences'] },
    hosting: ['nearai-tee'],
    maxTier: 'T2'
  };
}

/** The closed API fields; the row itself states its id. */
function closedApi(match: readonly string[], developer: string, family: string, base: string): Omit<Row, 'id'> {
  return {
    match, developer, origin: 'US',
    lineage: { family, base, teachers: [], method: 'pretrain+sft+rl' },
    licence: { id: 'proprietary', obligations: ["the provider's terms of service"], inherited: [] },
    hosting: ['closed-api'],
    maxTier: 'T2'
  };
}

/** The shipped passports, sorted by id (provenance 5.5). */
export const SHIPPED_PASSPORTS: readonly Passport[] = deepFreeze([
  row({
    id: 'anthropic/claude',
    ...closedApi(['anthropic/*'], 'Anthropic', 'claude', 'Claude (closed weights)')
  }),
  row({
    id: 'black-forest-labs/flux.2-klein-4b',
    match: ['black-forest-labs/FLUX.2-klein-4B'],
    developer: 'Black Forest Labs',
    origin: 'DE',
    lineage: { family: 'flux', base: 'FLUX.2 klein 4B', teachers: [], method: 'pretrain' },
    // Only the 4B klein model is Apache 2.0; the 9B klein models are under another licence and match nothing here.
    licence: { id: 'Apache-2.0', obligations: ['attribution'], inherited: [] },
    hosting: ['nearai-tee'],
    maxTier: 'T2'
  }),
  row({
    id: 'cohere/command-a-plus',
    // The publisher's ids only: Cohere Labs' Hugging Face repositories and the id on Cohere's API and Model Vault. Third-party conversions match nothing.
    match: ['CohereLabs/command-a-plus-05-2026-*', 'command-a-plus-05-2026'],
    developer: 'Cohere',
    origin: 'CA',
    lineage: { family: 'command', base: 'Command A+ 05-2026 (MoE, 218B total, 25B active; text and image input)', teachers: [], method: 'pretrain+sft+rl' },
    licence: COMMAND_A_PLUS_LICENCE,
    // The owner's rule (74.1 D-05): the Cohere Model Vault classes, and your organization's on-premise hosting only through its own passport; never
    // NEAR AI's private hardware.
    hosting: ['vendor-region', 'vendor-tee'],
    maxTier: 'T2'
  }),
  row({
    id: 'deepseek-ai/deepseek',
    match: ['deepseek-ai/*'],
    developer: 'DeepSeek',
    origin: 'CN',
    lineage: { family: 'deepseek', base: 'DeepSeek', teachers: [], method: 'pretrain+sft+rl' },
    licence: { id: 'MIT', obligations: [], inherited: ['confirm per model'] },
    legal: { coveredByUsLaw: true, entityList: false, removalOrders: ['DHS notice ordering removal of DeepSeek from DHS systems'] },
    hosting: ['nearai-tee'],
    maxTier: 'T0'
  }),
  row({
    id: 'google/gemini',
    ...closedApi(['google/gemini-*'], 'Google', 'gemini', 'Gemini (closed weights)')
  }),
  row({
    id: 'ibm-granite/granite',
    // Granite 4.x (3b, 8b, 30b). The Guardian models have their own row; this pattern does not reach them.
    match: ['ibm-granite/granite-4.*'],
    developer: 'IBM',
    origin: 'US',
    lineage: { family: 'granite', base: 'Granite 4.x (pretrained by IBM; synthetic data made by IBM, no teacher named)', teachers: [], method: 'pretrain+sft+rl' },
    licence: { id: 'Apache-2.0', obligations: ['attribution'], inherited: [] },
    hosting: ['nearai-tee'],
    maxTier: 'T2'
  }),
  row({
    id: 'ibm-granite/granite-guardian',
    match: ['ibm-granite/granite-guardian-4.*'],
    developer: 'IBM',
    origin: 'US',
    lineage: { family: 'granite', base: 'Granite Guardian 4.x (fine-tuned from Granite 4.1 by IBM Research)', teachers: [], method: 'sft' },
    licence: { id: 'Apache-2.0', obligations: ['attribution'], inherited: [] },
    hosting: ['nearai-tee'],
    maxTier: 'T2'
  }),
  row({
    id: 'moonshotai/kimi',
    match: ['moonshotai/*'],
    developer: 'Moonshot AI',
    origin: 'CN',
    lineage: { family: 'kimi', base: 'Kimi', teachers: [], method: 'pretrain+sft+rl' },
    // Kimi K3's own licence; earlier Kimi models used Modified MIT, so each model is confirmed on its own card.
    licence: { id: 'Kimi K3 License', obligations: ['attribution', 'a separate agreement for large model-as-a-service businesses'], inherited: ['confirm per model'] },
    hosting: ['nearai-tee'],
    maxTier: 'T0'
  }),
  row({
    id: 'nvidia/llama-nemotron',
    match: ['nvidia/Llama-*Nemotron*'],
    developer: 'Meta, post-trained by NVIDIA',
    origin: 'US',
    lineage: { family: 'llama', base: 'Llama (Meta), post-trained by NVIDIA', teachers: [{ model: 'DeepSeek-R1', origin: 'CN', method: 'synthetic-data' }], method: 'sft+rl' },
    licence: { id: 'NVIDIA Open Model License', obligations: ['attribution'], inherited: ['Llama Community License'] },
    hosting: ['nearai-tee'],
    maxTier: 'T2'
  }),
  row({
    id: 'nvidia/nemotron-3-nano',
    ...nemotron3('Nano')
  }),
  row({
    id: 'nvidia/nemotron-3-super',
    ...nemotron3('Super')
  }),
  row({
    id: 'nvidia/nemotron-3-ultra',
    ...nemotron3('Ultra')
  }),
  row({
    id: 'nvidia/openreasoning-nemotron',
    match: ['nvidia/OpenReasoning-Nemotron-*'],
    // The base is Qwen2.5, so the origin is the PRC despite the name (8.2).
    developer: 'Alibaba (Qwen), post-trained by NVIDIA',
    origin: 'CN',
    lineage: { family: 'qwen', base: 'Qwen2.5, post-trained by NVIDIA', teachers: [], method: 'sft' },
    licence: { id: 'CC-BY-4.0', obligations: ['attribution'], inherited: ['Apache-2.0 (Qwen2.5 base)', 'confirm per model'] },
    hosting: ['nearai-tee'],
    maxTier: 'T0'
  }),
  row({
    id: 'openai/gpt',
    ...closedApi(['openai/gpt-4*', 'openai/gpt-5*', 'openai/gpt-6*', 'openai/gpt-7*', 'openai/gpt-8*', 'openai/gpt-9*'], 'OpenAI', 'gpt', 'GPT (closed weights)')
  }),
  row({
    id: 'openai/gpt-oss',
    match: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    developer: 'OpenAI',
    origin: 'US',
    lineage: { family: 'gpt', base: 'gpt-oss (open weights; training data not published)', teachers: [], method: 'pretrain+sft+rl' },
    licence: { id: 'Apache-2.0', obligations: ["OpenAI's gpt-oss usage policy"], inherited: [] },
    hosting: ['nearai-tee'],
    maxTier: 'T2'
  }),
  row({
    id: 'openai/whisper-large-v3',
    match: ['openai/whisper-large-v3'],
    developer: 'OpenAI',
    origin: 'US',
    lineage: { family: 'whisper', base: 'Whisper large-v3', teachers: [], method: 'pretrain' },
    // OpenAI's repository says MIT; the Hugging Face card's metadata says apache-2.0.
    licence: { id: 'MIT', obligations: ['attribution'], inherited: ['the Hugging Face card says apache-2.0'] },
    hosting: ['nearai-tee'],
    maxTier: 'T2'
  }),
  row({
    id: 'qwen/qwen',
    // Chat, VL, embedding and reranker models alike.
    match: ['Qwen/*'],
    developer: 'Alibaba (Qwen)',
    origin: 'CN',
    lineage: { family: 'qwen', base: 'Qwen', teachers: [], method: 'pretrain+sft+rl' },
    licence: { id: 'Apache-2.0', obligations: ['attribution'], inherited: ['confirm per model'] },
    hosting: ['nearai-tee'],
    maxTier: 'T0'
  }),
  row({
    id: 'x-ai/grok',
    ...closedApi(['x-ai/*'], 'xAI', 'grok', 'Grok (closed weights)')
  }),
  row({
    id: 'z-ai/glm',
    match: ['z-ai/*', 'zai-org/*'],
    developer: 'Zhipu AI',
    origin: 'CN',
    lineage: { family: 'glm', base: 'GLM', teachers: [], method: 'pretrain+sft+rl' },
    // GLM-5.3's own licence; earlier GLM models used MIT, so each model is confirmed on its own card.
    licence: { id: 'GLM-5.3 License', obligations: ['a Z.AI security review before large commercial model-as-a-service use'], inherited: ['confirm per model'] },
    legal: { coveredByUsLaw: false, entityList: true, removalOrders: [] },
    hosting: ['nearai-tee'],
    maxTier: 'T0'
  })
]);

/** The shipped label rows of provenance 6.1: Protected B and C and org Restricted are agent work; every classified level and NATO Confidential up are operational. */
export const SHIPPED_TIER_BY_LEVEL: Readonly<Record<string, UseTier>> = Object.freeze({
  'ca-classified/Confidential': 'T3',
  'ca-classified/Secret': 'T3',
  'ca-classified/Top Secret': 'T3',
  'ca-protected/Protected B': 'T2',
  'ca-protected/Protected C': 'T2',
  'nato/Cosmic Top Secret': 'T3',
  'nato/NATO Confidential': 'T3',
  'nato/NATO Secret': 'T3',
  'org/Restricted': 'T2'
});

/** The shipped project rows of provenance 6.1: a staff project is operational work, and agent work with the signed exercise attribute. */
export const SHIPPED_TIER_BY_PROJECT: Readonly<Record<string, UseTier>> = Object.freeze({ staff: 'T3', 'staff-exercise': 'T2' });
