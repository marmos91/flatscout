export type * from './context.js';
export type * from './source.js';
export type * from './enricher.js';
export type * from './scorer.js';
export type * from './notifier.js';
export type * from './applicator.js';

import type { Source } from './source.js';
import type { Enricher } from './enricher.js';
import type { Scorer } from './scorer.js';
import type { Notifier } from './notifier.js';
import type { Applicator } from './applicator.js';

export type PluginKind = 'source' | 'enricher' | 'scorer' | 'notifier' | 'applicator';

export type PluginExport =
  | { kind: 'source'; plugin: Source }
  | { kind: 'enricher'; plugin: Enricher }
  | { kind: 'scorer'; plugin: Scorer }
  | { kind: 'notifier'; plugin: Notifier }
  | { kind: 'applicator'; plugin: Applicator };
