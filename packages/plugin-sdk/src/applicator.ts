import type { z } from 'zod';
import type { Listing } from '@flatscout/core';
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

/** An applicator plugin submits a tenancy application (Anschreiben + dossier) to the landlord. */
export interface Applicator {
  name: string;
  configSchema: z.ZodTypeAny;
  apply(application: Application, ctx: Context): Promise<ApplicationResult>;
}
