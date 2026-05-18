import type { ListingEvent } from '@wabe/plugin-sdk';

export interface RenderedCard {
  text: string;
  buttons: Array<{ text: string; url: string }>;
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
    `⭐ Fit ${score.final}/100`,
    listing.agency ? `🏢 ${listing.agency} · listed ${minutesAgo} min ago` : `listed ${minutesAgo} min ago`,
  ].filter((l): l is string => l !== null);
  const buttons: Array<{ text: string; url: string }> = [];
  if (listing.photos[0]) buttons.push({ text: '📷 Photos', url: listing.photos[0] });
  buttons.push({ text: '🔗 Open listing', url: listing.url });
  return { text: lines.join('\n'), buttons };
}
