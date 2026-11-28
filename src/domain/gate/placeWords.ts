// Where a request runs, and a date, in the words people read (glossary rows Runs on and Allowed): one place for the trust line (trust.ts) and the passport
// refusals (passportStep.ts). Pure, and a leaf: it imports types only, so neither user meets a load-time cycle (74.1-04).
import type { EndpointClass, EndpointRegion } from './endpoints';

export const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

/** The fixed words of a place; TRUST_LINE_TEXT carries the same objects. */
export const PLACE_TEXT = Object.freeze({
  places: Object.freeze({
    local: 'this computer',
    'org-plain': 'your organization\'s server',
    'org-tee': 'your organization\'s server (private hardware)',
    'nearai-tee': 'NEAR AI private hardware',
    unknown: 'a place your rules do not name'
  }),
  vault: 'Cohere vault',
  outsideProvider: 'outside provider',
  anOutsideProvider: 'an outside provider',
  in: 'in',
  regions: Object.freeze({ CA: 'Canada', US: 'the United States', EU: 'the European Union' })
});

/** A place as the words need it (TrustPlace has this shape). */
export interface ShownPlace {
  readonly class: EndpointClass | 'unknown';
  readonly region: EndpointRegion;
  readonly provider?: string;
  readonly forwardedTo?: string;
  readonly endpointId?: string;
}

/** A date as people read it, in UTC: "1 Dec 2027". A text that is not a date is returned as it is. */
export function dateShown(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const date = new Date(at);
  return `${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] as string} ${String(date.getUTCFullYear())}`;
}

function regionShown(region: EndpointRegion): string | undefined {
  return region === 'unstated' ? undefined : PLACE_TEXT.regions[region];
}

function outsideProvider(name: string | undefined): string {
  return name === undefined ? PLACE_TEXT.anOutsideProvider : `${PLACE_TEXT.outsideProvider} (${name})`;
}

/** The place in the glossary's words; vendor places add their region. */
export function placeShown(place: ShownPlace): string {
  switch (place.class) {
    case 'local':
    case 'org-plain':
    case 'org-tee':
    case 'nearai-tee':
    case 'unknown':
      return PLACE_TEXT.places[place.class];
    case 'vendor-tee':
    case 'vendor-region': {
      const base = place.provider?.startsWith('cohere') === true ? PLACE_TEXT.vault : outsideProvider(place.provider ?? place.endpointId);
      const region = regionShown(place.region);
      return region === undefined ? base : `${base} ${PLACE_TEXT.in} ${region}`;
    }
    case 'forwarded':
      return outsideProvider(place.forwardedTo ?? place.provider);
    case 'closed-api':
      return outsideProvider(place.provider ?? place.forwardedTo ?? place.endpointId);
  }
}

/**
 * A model's origin in words (74.1-UI-SPEC S4, Q5: country names, never codes). Shared with the sovereignty badge of Phase 48.4, which reads the same words.
 * A code not in the table is shown as it is; none (or XX) is "origin unknown".
 */
export const ORIGIN_TEXT = Object.freeze({
  countries: Object.freeze({
    CA: 'Canada', US: 'United States', DE: 'Germany', FR: 'France', GB: 'United Kingdom', CN: 'China', JP: 'Japan', KR: 'South Korea', IL: 'Israel',
    AE: 'United Arab Emirates', IN: 'India', IT: 'Italy', NL: 'Netherlands', SE: 'Sweden', CH: 'Switzerland', ES: 'Spain', AU: 'Australia', RU: 'Russia'
  } as Readonly<Record<string, string>>),
  unknown: 'origin unknown'
});

/** A model family in words (74.1-UI-SPEC S4); a family not in the table is shown as stored, none is "family unknown". */
export const FAMILY_TEXT = Object.freeze({
  families: Object.freeze({
    command: 'Command', deepseek: 'DeepSeek', flux: 'FLUX', glm: 'GLM', gpt: 'GPT', granite: 'Granite', kimi: 'Kimi', llama: 'Llama', nemotron: 'Nemotron',
    qwen: 'Qwen', whisper: 'Whisper'
  } as Readonly<Record<string, string>>),
  unknown: 'family unknown'
});

/** The origin words of an ISO code. */
export function originShown(code: string | undefined): string {
  if (code === undefined || code === '' || code === 'XX') return ORIGIN_TEXT.unknown;
  return Object.prototype.hasOwnProperty.call(ORIGIN_TEXT.countries, code) ? ORIGIN_TEXT.countries[code] as string : code;
}

/** The family words of a lineage family token. */
export function familyShown(family: string | undefined): string {
  if (family === undefined || family === '') return FAMILY_TEXT.unknown;
  return Object.prototype.hasOwnProperty.call(FAMILY_TEXT.families, family) ? FAMILY_TEXT.families[family] as string : family;
}
