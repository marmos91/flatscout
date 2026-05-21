import type { Listing, RentalTermPolicy } from '@flatscout/core';

/** Average month length used for duration arithmetic (Gregorian average). */
const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;

export interface GateVerdict {
  ok: boolean;
  /** Short human-readable reason; only set when `ok === false`. Goes into logs. */
  reason?: string;
}

/**
 * Pre-filter gate that decides whether a classified listing matches the user's
 * rental-term policy. Pure function — no I/O, no logging.
 *
 * Evaluation order:
 *   1. Auto-reject any listing whose detected `lease_until` is already in the
 *      past (we never want to surface expired offers, regardless of mode).
 *   2. Apply mode-specific rules; for `short` mode, also enforce optional
 *      `stay` window (date range and/or duration band).
 *
 * Insufficient-data stance: when a `stay` constraint requires both endpoints
 * (e.g. duration band needs `available_from` AND `lease_until`) but the
 * listing only supplies one, the listing is allowed through. Over-rejecting
 * on partial data is worse than letting the user review borderline matches.
 */
export function passes(listing: Listing, cfg: RentalTermPolicy, now: Date = new Date()): GateVerdict {
  if (listing.lease_until && listing.lease_until.getTime() < now.getTime()) {
    return { ok: false, reason: 'lease expired' };
  }

  if (cfg.mode === 'long') {
    if (listing.rental_term === 'short') return { ok: false, reason: 'rental_term=short' };
    if (listing.rental_term === 'unknown' && cfg.exclude_unknown) {
      return { ok: false, reason: 'rental_term=unknown (exclude_unknown=true)' };
    }
    return { ok: true };
  }

  // mode === 'short'
  if (listing.rental_term !== 'short') return { ok: false, reason: `rental_term=${listing.rental_term}` };
  const stay = cfg.stay;
  if (!stay) return { ok: true };

  if (stay.from && listing.available_from && listing.available_from.getTime() > stay.from.getTime()) {
    return { ok: false, reason: 'available_from after stay.from' };
  }
  if (stay.to && listing.lease_until && listing.lease_until.getTime() < stay.to.getTime()) {
    return { ok: false, reason: 'lease_until before stay.to' };
  }
  if ((stay.min_months != null || stay.max_months != null) && listing.available_from && listing.lease_until) {
    const months = (listing.lease_until.getTime() - listing.available_from.getTime()) / MS_PER_MONTH;
    if (stay.min_months != null && months < stay.min_months) {
      return { ok: false, reason: `duration ${months.toFixed(1)}mo < min_months ${stay.min_months}` };
    }
    if (stay.max_months != null && months > stay.max_months) {
      return { ok: false, reason: `duration ${months.toFixed(1)}mo > max_months ${stay.max_months}` };
    }
  }
  return { ok: true };
}
