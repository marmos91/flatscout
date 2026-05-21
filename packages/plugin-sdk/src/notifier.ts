import type { z } from 'zod';
import type { Listing } from '@flatscout/core';
import type { Context } from './context.js';
import type { ScoreResult } from './scorer.js';

export interface ListingEvent {
  listing: Listing;
  score: ScoreResult;
  /** Names of other sources in the same canonical group, sorted. Empty when this is the only source. Phase A addition. */
  also_seen_on?: string[];
}

export interface NotifierResponse {
  ok: boolean;
  message_id?: string;
}

/** A notifier plugin delivers a scored listing event to an external channel (Telegram, email, ...). */
export interface Notifier {
  name: string;
  configSchema: z.ZodTypeAny;
  notify(event: ListingEvent, ctx: Context): Promise<NotifierResponse>;
}
