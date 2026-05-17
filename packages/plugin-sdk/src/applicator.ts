import type { z } from 'zod';
import type { Listing } from '@wabe/core';
import type { Context } from './context.js';

export interface Application {
  listing: Listing;
  anschreiben: string;
  dossier: { path: string; mime: string }[];
}

export interface ApplicationResult {
  ok: boolean;
  delivery_id?: string;
}

export interface Applicator {
  name: string;
  configSchema: z.ZodTypeAny;
  apply(application: Application, ctx: Context): Promise<ApplicationResult>;
}
