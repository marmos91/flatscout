import { describe, expect, it } from 'vitest';
import { LONG_TERM_PATTERNS, SHORT_TERM_PATTERNS } from '../src/engine/rental-term-lexicon.js';

interface Case {
  desc: string;
  text: string;
  match: boolean;
}

const SHORT_CASES: Case[] = [
  // DE
  { desc: 'DE befristet bis date', text: 'BEFRISTET BIS 31.05.2025 zu vermieten', match: true },
  { desc: 'DE befristet bis zum date', text: 'Befristet bis zum 1.6.2025 vermietet', match: true },
  { desc: 'DE bare befristet', text: 'Wohnung befristet zu vermieten', match: true },
  { desc: 'DE zwischenmiete', text: 'Zwischenmiete für 3 Monate', match: true },
  { desc: 'DE untermiete', text: 'Untermiete in Zürich', match: true },
  { desc: 'DE möbliert', text: 'Schöne möblierte Wohnung im Zentrum', match: true },
  { desc: 'DE auf zeit', text: 'Wohnung auf Zeit', match: true },
  { desc: 'DE temporär', text: 'Temporäre Vermietung möglich', match: true },
  { desc: 'DE permanent (negative)', text: 'Langfristige Vermietung gesucht', match: false },

  // FR
  { desc: 'FR jusqu’au date', text: 'Bail jusqu’au 30/06/2025', match: true },
  { desc: 'FR temporaire', text: 'Location temporaire centre-ville', match: true },
  { desc: 'FR meublée', text: 'Appartement meublé 3 pièces', match: true },
  { desc: 'FR sous-location', text: 'Sous-location pour l’été', match: true },
  { desc: 'FR permanent (negative)', text: 'Bail indéterminé proposé', match: false },

  // IT
  { desc: 'IT fino al date', text: 'Affitto fino al 31.12.2025', match: true },
  { desc: 'IT temporaneo', text: 'Affitto temporaneo a Lugano', match: true },
  { desc: 'IT ammobiliato', text: 'Appartamento ammobiliato', match: true },
  { desc: 'IT subaffitto', text: 'Subaffitto disponibile', match: true },
  { desc: 'IT permanent (negative)', text: 'Contratto a tempo indeterminato', match: false },

  // EN
  { desc: 'EN until date', text: 'Available until 15/08/2025', match: true },
  { desc: 'EN temporary', text: 'Temporary lease offered', match: true },
  { desc: 'EN furnished', text: 'Bright furnished flat downtown', match: true },
  { desc: 'EN short-term', text: 'Short-term rental, 3 months', match: true },
  { desc: 'EN short term spaced', text: 'short term available', match: true },
  { desc: 'EN sublet', text: 'Sublet from June', match: true },
  { desc: 'EN serviced apartment', text: 'Serviced apartment with cleaning', match: true },
  { desc: 'EN permanent (negative)', text: 'Long-term unfurnished flat', match: false },
];

const LONG_CASES: Case[] = [
  { desc: 'DE unbefristet', text: 'Unbefristete Wohnung in Zürich', match: true },
  { desc: 'DE dauermiete', text: 'Dauermiete bevorzugt', match: true },
  { desc: 'DE langfristig', text: 'Langfristige Vermietung', match: true },
  { desc: 'DE short marker (negative)', text: 'befristet bis Ende Jahr', match: false },

  { desc: 'FR bail indéterminé', text: 'Bail indéterminé', match: true },
  { desc: 'FR longue durée', text: 'Location longue durée', match: true },
  { desc: 'FR short marker (negative)', text: 'Location meublée temporaire', match: false },

  { desc: 'IT tempo indeterminato', text: 'Contratto a tempo indeterminato', match: true },
  { desc: 'IT lunga durata', text: 'Affitto di lunga durata', match: true },
  { desc: 'IT short marker (negative)', text: 'Subaffitto a Zurigo', match: false },

  { desc: 'EN unfurnished', text: 'Bright unfurnished 3.5 room flat', match: true },
  { desc: 'EN long-term', text: 'Long-term lease only', match: true },
  { desc: 'EN long term spaced', text: 'long term available', match: true },
  { desc: 'EN permanent lease', text: 'Permanent lease, no sublets', match: true },
  { desc: 'EN short marker (negative)', text: 'Furnished apartment for rent', match: false },
];

function matchesAny(text: string, patterns: { pattern: RegExp }[]): boolean {
  return patterns.some(({ pattern }) => pattern.test(text));
}

describe('SHORT_TERM_PATTERNS', () => {
  for (const c of SHORT_CASES) {
    it(c.desc, () => {
      expect(matchesAny(c.text, SHORT_TERM_PATTERNS)).toBe(c.match);
    });
  }
});

describe('LONG_TERM_PATTERNS', () => {
  for (const c of LONG_CASES) {
    it(c.desc, () => {
      expect(matchesAny(c.text, LONG_TERM_PATTERNS)).toBe(c.match);
    });
  }
});

describe('date capture groups', () => {
  it('Samariterstrasse fixture: extracts 31.05.2025', () => {
    const text =
      'BEFRISTET BIS 31.05.2025 zu vermieten im Kreis 7!\n\nDiese wunderschöne 4 Zimmer-Wohnung sucht einen neuen Mieter.';
    const m = SHORT_TERM_PATTERNS.find((p) => p.capturesDate)?.pattern.exec(text);
    expect(m?.groups?.endDate).toBe('31.05.2025');
  });

  it('every date-capturing pattern uses an endDate named group', () => {
    for (const p of SHORT_TERM_PATTERNS) {
      if (p.capturesDate) {
        expect(p.pattern.source).toContain('?<endDate>');
      }
    }
  });
});
