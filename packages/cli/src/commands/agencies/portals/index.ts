/**
 * Per-portal listing fetchers feeding `wabe agencies probe-portal`. Each
 * portal implementation reuses its source plugin's wire knowledge to pull
 * the top-N listings, then exposes them as a flat `PortalListing[]` so the
 * probe-portal command can mine descriptions + agency.website fields
 * uniformly across portals.
 */

import type { PortalImpl } from './types.js';
import { flatfoxPortal } from './flatfox.js';

export type { PortalImpl, PortalListing } from './types.js';

const REGISTRY: Record<string, PortalImpl> = {
  flatfox: flatfoxPortal,
};

export function getPortal(name: string): PortalImpl | null {
  return REGISTRY[name] ?? null;
}

export function listPortals(): string[] {
  return Object.keys(REGISTRY);
}
