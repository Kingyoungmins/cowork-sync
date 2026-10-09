// Team configuration (glossary §17; rulings R-06, R-19): `.cowork/config.json` at EPOCH_BASE, read
// leniently for the keys Plan 2 uses. Schema validation (CFG-02) is Plan 7.
import type { GitRepo } from '../git/repo.js';
import type { Oid } from '../git/oid.js';
import { validPathSyntax } from '../sec/validators.js';
import { validGlob } from './scope.js';

export interface TeamConfig {
  sync: { include: string[]; exclude: string[]; allowSecretLike: string[]; maxNewFileBytes: number };
  merge: { insertionMerge: string[] };
  /** Raw: genesisBudget() decides. */
  host: { pushBudgetPerMin: unknown };
}

export const DEFAULT_INSERTION_MERGE: readonly string[] = Object.freeze(['CHANGELOG*', 'HISTORY*', 'NEWS*', '*.md', '*.txt']);

/** 03-data §3.6: the default and the maximum of sync.maxNewFileBytes. */
const MAX_NEW_FILE_BYTES = 1_048_576;

function defaults(): TeamConfig {
  return {
    sync: { include: [], exclude: [], allowSecretLike: [], maxNewFileBytes: MAX_NEW_FILE_BYTES },
    merge: { insertionMerge: [...DEFAULT_INSERTION_MERGE] },
    host: { pushBudgetPerMin: undefined },
  };
}

export const DEFAULT_TEAM_CONFIG: TeamConfig = defaults();

const CONFIG_PATH = '.cowork/config.json';

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** An array whose every element is a string; anything else is a mistyped field. */
function stringArray(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null;
  const out: string[] = [];
  for (const e of x) {
    if (typeof e !== 'string') return null;
    out.push(e);
  }
  return out;
}

/**
 * `.cowork/config.json` at `<epochBase>`: absent (or not a file) gives defaults; bytes that are not a
 * UTF-8 (BOM-less) JSON object give defaults and `invalid`; a mistyped field keeps its default.
 * The returned config is always a fresh copy.
 */
export async function readTeamConfig(repo: GitRepo, epochBase: Oid): Promise<{ config: TeamConfig; invalid: boolean; reason: string | null }> {
  const config = defaults();
  let reason: string | null = null;
  const blob = await repo.resolve(`${epochBase}:${CONFIG_PATH}`);
  if (blob === null || !(await repo.hasObject(blob, 'blob'))) return { config, invalid: false, reason: null };
  const bytes = await repo.readBlob(blob);

  let parsed: unknown;
  try {
    // ignoreBOM keeps U+FEFF in the text, so a BOM makes JSON.parse throw: the file must be BOM-less.
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return { config, invalid: true, reason: 'not a UTF-8 JSON object' };
  }
  if (!isRecord(parsed)) return { config, invalid: true, reason: 'not a UTF-8 JSON object' };

  const sync = parsed['sync'];
  if (isRecord(sync)) {
    const include = stringArray(sync['include']);
    if (include !== null) config.sync.include = include;
    const exclude = stringArray(sync['exclude']);
    if (exclude !== null) config.sync.exclude = exclude;
    const allow = stringArray(sync['allowSecretLike']);
    if (allow !== null) {
      // exact canonPaths, not globs: an entry that can never be a path matches nothing; it is dropped and noted
      config.sync.allowSecretLike = allow.filter((e) => validPathSyntax(e));
      const dropped = allow.filter((e) => !validPathSyntax(e));
      if (dropped.length > 0) reason = `ignored sync.allowSecretLike entries: ${JSON.stringify(dropped)}`;
    }
    const max = sync['maxNewFileBytes'];
    if (typeof max === 'number' && Number.isInteger(max) && max >= 0) config.sync.maxNewFileBytes = Math.min(max, MAX_NEW_FILE_BYTES);
  }
  const merge = parsed['merge'];
  if (isRecord(merge)) {
    const ins = stringArray(merge['insertionMerge']);
    if (ins !== null) config.merge.insertionMerge = ins;
  }
  // An invalid glob makes the whole config invalid (glossary §17: keep the last valid one; at first read, the defaults).
  const globFields: Array<[string, string[]]> = [
    ['sync.include', config.sync.include], ['sync.exclude', config.sync.exclude],
    ['merge.insertionMerge', config.merge.insertionMerge],
  ];
  for (const [field, globs] of globFields) {
    const bad = globs.find((g) => !validGlob(g));
    if (bad !== undefined) return { config: defaults(), invalid: true, reason: `invalid glob in ${field}: ${JSON.stringify(bad)}` };
  }
  const host = parsed['host'];
  if (isRecord(host) && 'pushBudgetPerMin' in host) config.host.pushBudgetPerMin = host['pushBudgetPerMin'];
  return { config, invalid: false, reason };
}

/** ENG-51, ruling R-19: an integer in 6–24 seeds the budget; anything else (absent, 30, "fast", 7.5) gives 12. */
export function genesisBudget(cfg: TeamConfig): number {
  const v = cfg.host.pushBudgetPerMin;
  return typeof v === 'number' && Number.isInteger(v) && v >= 6 && v <= 24 ? v : 12;
}
