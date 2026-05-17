import type { z } from 'zod';
import type { Listing } from '@wabe/core';
import type { Context } from './context.js';
import type { ScoreResult } from './scorer.js';

export interface ListingEvent {
  listing: Listing;
  score: ScoreResult;
}

export interface NotifierResponse {
  ok: boolean;
  message_id?: string;
}

export interface Notifier {
  name: string;
  configSchema: z.ZodTypeAny;
  notify(event: ListingEvent, ctx: Context): Promise<NotifierResponse>;
}
