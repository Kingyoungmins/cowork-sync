// What tools/sim/run-seeds.ts, tools/sim/run-shard.ts, tools/sim/exit-verdict.ts and their tests share (Plan 2 Task 19):
// the profiles, R-29's mutant switches, the seed line a shard prints, the shard's input file, the report run-seeds
// writes, the seed and prefix syntax, and the quoting of a rerun command.
import type { MutantId } from '../../src/engine/deps.js';

export type Profile = 'edits' | 'faults';
export const PROFILES_ALL: readonly Profile[] = Object.freeze(['edits', 'faults']);

/** R-29's switches (src/engine/deps.ts MutantId); the check below fails to compile when the two lists differ. */
export const MUTANT_IDS = Object.freeze(['M05', 'M06', 'M07', 'M12', 'M17', 'M18', 'M20'] as const) satisfies readonly MutantId[];
type MissingMutant = Exclude<MutantId, (typeof MUTANT_IDS)[number]>;
const everyMutantListed: [MissingMutant] extends [never] ? true : never = true;
void everyMutantListed;

export function isMutantId(v: string): v is MutantId {
  return (MUTANT_IDS as readonly string[]).includes(v);
}

/** One seed's result, one JSON line on a shard's stdout. */
export interface SeedLine {
  seed: string; profile: Profile; ok: boolean; oracle?: string; step?: number; message?: string; ms: number; artifacts?: string;
}

export function isSeedLine(x: unknown): x is SeedLine {
  const o = x as Partial<SeedLine> | null;
  return typeof o === 'object' && o !== null && typeof o.seed === 'string' && (o.profile === 'edits' || o.profile === 'faults')
    && typeof o.ok === 'boolean' && typeof o.ms === 'number';
}

export interface SeedRef { seed: string; profile: Profile; }

/** The input file of one shard (the seed list travels in a file, never on a command line). */
export interface ShardInput {
  peers: number; steps: number; mutants: MutantId[]; seeds: SeedRef[];
  /** A seed still running after this long is stopped: its partial op-log and trace are kept and it fails as TIMEOUT (0 = never). */
  seedTimeoutMs: number;
}

/** A seed the run could not report (its shard died or the run's deadline passed), with the command that runs it again. */
export interface LostSeed extends SeedRef { reason: string; rerun: string; artifacts?: string; }

/** The JSON report of run-seeds (rewritten after every seed; `complete` once the run ended). */
export interface SeedsReport {
  runs: Array<{ profile: Profile; seeds: string[] }>;
  peers: number; steps: number; mutants: string[];
  shards: string[][];
  results: SeedLine[];
  failures: number;
  lost: LostSeed[];
  problems: string[];
  complete: boolean;
}

/** The longest seed and prefix the runner accepts. */
export const SEED_MAX = 128;
export const PREFIX_MAX = 64;

/**
 * Why `s` cannot be a seed (or, with `prefix`, a seed prefix), or null: no control character and none of `"` `$` `` ` ``
 * `%` `!` `\` (so a double-quoted rerun command means the same in sh, cmd and PowerShell), not starting with '-'
 * (it would read as a flag), within the length cap; a prefix may be empty.
 */
export function badSeedText(s: string, prefix = false): string | null {
  const max = prefix ? PREFIX_MAX : SEED_MAX;
  if (!prefix && s.length === 0) return 'is empty';
  if (s.length > max) return `is longer than ${max} characters`;
  if (s.startsWith('-')) return "starts with '-'";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) return 'holds a control character';
    if ('"$`%!\\'.includes(ch)) return `holds ${JSON.stringify(ch)}`;
  }
  return null;
}

const BARE = /^[A-Za-z0-9._:/=@+,-]+$/;

/** One argument of a printed command: bare when it is plain, else in double quotes (badSeedText keeps those safe). */
export function shellQuote(arg: string): string {
  return BARE.test(arg) ? arg : `"${arg}"`;
}

/** The command that runs one seed again with the run's settings. */
export function rerunCommand(s: SeedRef, a: { peers: number; steps: number; mutants: readonly string[] }): string {
  const args = ['--profile', s.profile, '--seed', s.seed, '--peers', String(a.peers), '--steps', String(a.steps), ...a.mutants.flatMap((m) => ['--mutant', m])];
  return `npm run sim:seeds -- ${args.map(shellQuote).join(' ')}`;
}
