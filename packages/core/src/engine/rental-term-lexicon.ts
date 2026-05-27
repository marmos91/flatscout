/**
 * Multilingual regex lexicon used by `classifyRentalTerm` to detect
 * short-term and long-term lease markers in free-text descriptions.
 *
 * Patterns are case-insensitive and ordered most-specific (date-capturing
 * patterns first) so the classifier can extract `lease_until` whenever a
 * captured `endDate` group is present.
 */

export type Lang = 'de' | 'fr' | 'it' | 'en';

export interface TermPattern {
  lang: Lang;
  pattern: RegExp;
  /** True when `pattern` contains a named `(?<endDate>...)` capture group. */
  capturesDate?: boolean;
}

const RE_DDMMYYYY = '(?<endDate>\\d{1,2}[./]\\d{1,2}[./]\\d{2,4})';

export const SHORT_TERM_PATTERNS: TermPattern[] = [
  // Date-capturing patterns first.
  {
    lang: 'de',
    pattern: new RegExp(`befristet\\s+bis(?:\\s+zum)?\\s+${RE_DDMMYYYY}`, 'i'),
    capturesDate: true,
  },
  { lang: 'de', pattern: new RegExp(`bis(?:\\s+zum)?\\s+${RE_DDMMYYYY}`, 'i'), capturesDate: true },
  { lang: 'fr', pattern: new RegExp(`jusqu['’\\s]au\\s+${RE_DDMMYYYY}`, 'i'), capturesDate: true },
  { lang: 'it', pattern: new RegExp(`fino\\s+al\\s+${RE_DDMMYYYY}`, 'i'), capturesDate: true },
  { lang: 'en', pattern: new RegExp(`until\\s+${RE_DDMMYYYY}`, 'i'), capturesDate: true },

  // Generic short-term markers. Word boundaries via `\b` prevent substring
  // collisions like /befristet/ matching "unbefristet" or /furnished/ matching
  // "unfurnished" (both of which carry the OPPOSITE meaning).
  { lang: 'de', pattern: /\bbefristet\b/i },
  { lang: 'de', pattern: /\bzwischenmiete\b/i },
  { lang: 'de', pattern: /\buntermiete\b/i },
  { lang: 'de', pattern: /\bmöblierte?s?/i },
  { lang: 'de', pattern: /\bauf\s+zeit\b/i },
  { lang: 'de', pattern: /\btemporär/i },

  { lang: 'fr', pattern: /\btemporaire\b/i },
  { lang: 'fr', pattern: /\bmeublée?s?/i },
  { lang: 'fr', pattern: /\bsous-?location\b/i },
  { lang: 'fr', pattern: /\bbail\s+temporaire\b/i },

  { lang: 'it', pattern: /\btemporaneo\b/i },
  { lang: 'it', pattern: /\bammobiliato\b/i },
  { lang: 'it', pattern: /\bsubaffitto\b/i },

  { lang: 'en', pattern: /\btemporary\b/i },
  { lang: 'en', pattern: /\bfurnished\b/i },
  { lang: 'en', pattern: /\bshort[-\s]?term\b/i },
  { lang: 'en', pattern: /\bsublet\b/i },
  { lang: 'en', pattern: /\bserviced\s+apartment\b/i },
  { lang: 'en', pattern: /\b\d+\s+years?\s+limited\b/i },
  { lang: 'en', pattern: /\blimited\s+(?:lease|rental|contract|duration)\b/i },
];

export const LONG_TERM_PATTERNS: TermPattern[] = [
  { lang: 'de', pattern: /\bunbefristet/i },
  { lang: 'de', pattern: /\bdauermiete\b/i },
  { lang: 'de', pattern: /\blangfristig/i },
  { lang: 'fr', pattern: /\bbail\s+indéterminé/i },
  { lang: 'fr', pattern: /\blongue\s+durée/i },
  { lang: 'it', pattern: /\btempo\s+indeterminato\b/i },
  { lang: 'it', pattern: /\blunga\s+durata\b/i },
  { lang: 'en', pattern: /\bunfurnished\b/i },
  { lang: 'en', pattern: /\blong[-\s]?term\b/i },
  { lang: 'en', pattern: /\bpermanent\s+lease\b/i },
];
