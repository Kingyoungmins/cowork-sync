// QUERY_SOURCES (R4-11): one query source per language. The worker compiles them (a source that does not compile makes
// its language unavailable, R1-024); the main thread imports them only to hash them into regionSpec (computeRegionSpec).
import type { Language } from '../types.js';
import { C_SHARP_QUERY } from './c_sharp.js';
import { JAVASCRIPT_QUERY } from './javascript.js';
import { PYTHON_QUERY } from './python.js';
import { TSX_QUERY } from './tsx.js';
import { TYPESCRIPT_QUERY } from './typescript.js';

export const QUERY_SOURCES: Readonly<Record<Language, string>> = Object.freeze({
  python: PYTHON_QUERY,
  javascript: JAVASCRIPT_QUERY,
  typescript: TYPESCRIPT_QUERY,
  tsx: TSX_QUERY,
  c_sharp: C_SHARP_QUERY,
});
