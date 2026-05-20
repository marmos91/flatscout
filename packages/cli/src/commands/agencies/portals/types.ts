/**
 * One mined listing as fed into the probe-portal candidate pipeline.
 * Only the fields used for agency-website extraction are surfaced — full
 * listing data lives in the source plugins and isn't needed here.
 */
export interface PortalListing {
  /** Canonical listing URL — surfaced in `notes` of generated registry rows. */
  url: string;
  /** Free-text description; mined for outgoing URLs via `extractDescriptionUrls`. */
  description: string | null;
  /** Structured agency website when the portal exposes one. */
  agency_website?: string | null;
  /** Structured agency name when known — fallback identifier for the candidate. */
  agency_name?: string | null;
}

export interface PortalImpl {
  /** Stable portal identifier (matches CLI arg). */
  name: string;
  /**
   * Fetch up to `top` listings ordered by the portal's default "freshest first"
   * sort. Polite pacing + retries are the implementation's responsibility.
   * `log` receives short progress lines; the CLI surfaces them as `# …` comments.
   */
  fetchTop(top: number, signal: AbortSignal, log: (msg: string) => void): Promise<PortalListing[]>;
}
