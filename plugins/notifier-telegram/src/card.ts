import type { Listing } from '@wabe/core';
import type { ListingEvent } from '@wabe/plugin-sdk';

export interface RenderedCard {
  text: string;
  buttons: Array<{ text: string; url: string }>;
  /** When true, the notifier should disable Telegram's link-preview unfurl — set for sources whose detail URLs return 403 to bots (DataDome/Cloudflare). */
  disablePreview: boolean;
}

/**
 * Sources whose detail URLs are DataDome-walled — Telegram's link-preview bot
 * (its own UA, not Wabe's transport) will get 403 trying to unfurl, so suppress
 * the inline preview. Note: this is purely about Telegram's preview fetch;
 * Wabe's own fetch goes through the browser bridge / Playwright / undici
 * transport selector and is unaffected.
 */
const PREVIEW_SUPPRESS_SOURCES = new Set(['source-immoscout24', 'source-homegate', 'source-comparis']);

/** Formats a date as DD.MM.YYYY in UTC (matches the lexicon's parse format). */
function formatDmy(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

/** Returns the 🗓 short-term line for short listings, or null for long/unknown. */
function renderShortTermLine(listing: Listing): string | null {
  if (listing.rental_term !== 'short') return null;
  return listing.lease_until ? `🗓 short-term · until ${formatDmy(listing.lease_until)}` : '🗓 short-term';
}

/** Strips the conventional `source-` prefix from plugin names for compact display. */
function shortSourceName(name: string): string {
  return name.startsWith('source-') ? name.slice('source-'.length) : name;
}

/** Returns the `Also on:` line when at least one other source is listed; null otherwise. */
function renderAlsoOnLine(alsoSeenOn: string[] | undefined): string | null {
  if (!alsoSeenOn || alsoSeenOn.length === 0) return null;
  return `🔁 Also on: ${alsoSeenOn.map(shortSourceName).join(', ')}`;
}

/**
 * Renders a scored listing event into a Telegram message body plus inline
 * keyboard buttons.
 *
 * The text is a fixed four-line layout (location · rooms · price · area, then
 * optional address, fit score, and agency-or-listed-time). Each line falls
 * back to `?` / `Unknown` when the underlying field is null so the layout is
 * preserved. Buttons are: a `📷 Photos` link when at least one photo is
 * present (pointing at the first image), and always an `🔗 Open listing`
 * link to the canonical URL. The `now` parameter is injectable for
 * deterministic testing of the "listed N min ago" string.
 */
export function renderCard(event: ListingEvent, now: Date = new Date()): RenderedCard {
  const { listing, score } = event;
  const minutesAgo = Math.max(0, Math.round((now.getTime() - listing.first_seen_at.getTime()) / 60000));
  const lines = [
    `🏠 ${listing.location.neighborhood ?? listing.location.city ?? 'Unknown'} · ${listing.rooms ?? '?'}Zi · ${listing.price.currency} ${listing.price.total ?? '?'} · ${listing.area_m2 ?? '?'}m²`,
    listing.location.address ? `📍 ${listing.location.address}` : null,
    renderShortTermLine(listing),
    `⭐ Fit ${score.final}/100`,
    listing.agency ? `🏢 ${listing.agency} · listed ${minutesAgo} min ago` : `listed ${minutesAgo} min ago`,
    renderAlsoOnLine(event.also_seen_on),
  ].filter((l): l is string => l !== null);
  const buttons: Array<{ text: string; url: string }> = [];
  if (listing.photos[0]) buttons.push({ text: '📷 Photos', url: listing.photos[0] });
  buttons.push({ text: '🔗 Open listing', url: listing.url });
  return {
    text: lines.join('\n'),
    buttons,
    disablePreview: PREVIEW_SUPPRESS_SOURCES.has(listing.source),
  };
}
