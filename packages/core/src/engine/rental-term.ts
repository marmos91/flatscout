import { LONG_TERM_PATTERNS, SHORT_TERM_PATTERNS } from './rental-term-lexicon.js';

export type RentalTerm = 'long' | 'short' | 'unknown';

export interface ClassifyInput {
  /** Free-text description in any supported language; null/undefined safe. */
  description?: string | null;
  /** Pre-parsed end date from a structured API field, when available. */
  lease_until?: Date | null;
  /** Per-source furnished/serviced/temporary flag, when available. */
  is_furnished?: boolean | null;
  /** Per-source minimum-stay hint in days. Currently informational; not consumed by the decision tree. */
  min_stay_days?: number | null;
}

export interface ClassifyResult {
  rental_term: RentalTerm;
  lease_until: Date | null;
  /** Which signal drove the verdict. `none` means the result is `unknown`. */
  signal: 'structured' | 'description' | 'none';
}

/**
 * Strictly parses a date string under the whitelist
 * `D.M.YYYY` / `D/M/YYYY` / `D.M.YY` (separator may be `.` or `/`).
 *
 * Returns null on any deviation — empty string, two-digit invalid year,
 * out-of-range day/month, missing groups. We never guess.
 */
export function parseDateStrict(raw: string): Date | null {
  const m = raw.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/);
  if (!m) return null;
  const [, dayStr, monthStr, yearStr] = m as [string, string, string, string];
  const day = Number.parseInt(dayStr, 10);
  const month = Number.parseInt(monthStr, 10);
  let year = Number.parseInt(yearStr, 10);
  if (yearStr.length === 2) year += year >= 70 ? 1900 : 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Round-trip guard: rejects e.g. 31.02.2025 (would otherwise land in March).
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

/**
 * Classifies a listing's rental term using a deterministic decision tree
 * over structured signals first, free-text markers second.
 *
 * Order matters: structured `lease_until` and `is_furnished` outrank
 * description regex, and short-term markers outrank long-term ones (a
 * listing that says "möbliert auf zeit, langfristig auch möglich" stays
 * `short` — the explicit short signal binds).
 */
export function classifyRentalTerm(input: ClassifyInput): ClassifyResult {
  if (input.lease_until != null) {
    return { rental_term: 'short', lease_until: input.lease_until, signal: 'structured' };
  }
  if (input.is_furnished === true) {
    return { rental_term: 'short', lease_until: null, signal: 'structured' };
  }
  // Strip common markdown emphasis markers (`**bold**`, `_italic_`) before
  // matching — Flatfox descriptions are markdown-formatted and bold around
  // "befristet" / dates otherwise breaks `\s+` in our patterns.
  const text = (input.description ?? '').replace(/[*_]+/g, ' ');
  if (text.length > 0) {
    for (const { pattern, capturesDate } of SHORT_TERM_PATTERNS) {
      const m = text.match(pattern);
      if (!m) continue;
      let leaseUntil: Date | null = null;
      if (capturesDate && m.groups?.endDate) {
        leaseUntil = parseDateStrict(m.groups.endDate);
      }
      return { rental_term: 'short', lease_until: leaseUntil, signal: 'description' };
    }
    for (const { pattern } of LONG_TERM_PATTERNS) {
      if (pattern.test(text)) {
        return { rental_term: 'long', lease_until: null, signal: 'description' };
      }
    }
  }
  return { rental_term: 'unknown', lease_until: null, signal: 'none' };
}
