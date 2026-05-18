export type Platform = 'immomig' | 'casasoft' | 'schemaorg' | 'iframe-portal' | 'custom';

export interface Heuristic {
  platform: Platform;
  test: (input: HeuristicInput) => boolean;
}

export interface HeuristicInput {
  html: string;
  url: string;
  headers: Record<string, string>;
}

/** Catalog scanned in order; first match wins. `custom` is the implicit fallback. */
export const HEURISTICS: Heuristic[] = [
  {
    platform: 'immomig',
    test: ({ html }) =>
      /<meta\s+name=["']generator["']\s+content=["'][^"']*ImmoMig/i.test(html) || /\/ig\.fcgi/i.test(html),
  },
  {
    platform: 'casasoft',
    test: ({ html }) => /casasoft\.ch/i.test(html) || /\/api\/PropertySearch/i.test(html),
  },
  {
    platform: 'iframe-portal',
    test: ({ html }) => /<iframe[^>]+src=["'][^"']*(?:homegate|immoscout24)\.ch/i.test(html),
  },
  {
    platform: 'schemaorg',
    test: ({ html }) =>
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?@type["']?\s*:\s*["']RealEstateListing["']/i.test(
        html,
      ),
  },
];
