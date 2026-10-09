// The verdict of one OS in sim-exit.yml (Plan 2 Task 19; roadmap row 2's exit criterion, rulings R-31 and R-33): it
// reads the run-seeds reports of that OS's shards and passes only when the seeds they report are exactly the expected
// set — `${prefix}${profile}-${i}` for every i in [from, from + N), each reported once, of that profile, every one
// passed — with no lost seed, no problem and every report complete. A count alone never passes it. The summary line
// carries the per-OS seed and failure counts the ledger records.
//
// Usage: tsx tools/sim/exit-verdict.ts --reports <dir> --profile edits|faults --from I --seeds N [--prefix P] [--label L]
// Exit: 0 the verdict passes, 1 it does not, 2 usage error or a report that cannot be read.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { badSeedText, isSeedLine, PROFILES_ALL, type Profile, type SeedLine } from './seedProtocol.js';

class InputError extends Error {}

interface Args { dir: string; profile: Profile; from: number; seeds: number; prefix: string; label: string; }

function parseArgs(argv: readonly string[]): Args {
  const v = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string;
    const value = argv[i + 1];
    if (!['--reports', '--profile', '--from', '--seeds', '--prefix', '--label'].includes(flag)) throw new InputError(`unknown argument ${flag}`);
    if (value === undefined || value.startsWith('--')) throw new InputError(`${flag} needs a value`);
    if (v.has(flag)) throw new InputError(`${flag} is given twice`);
    v.set(flag, value);
  }
  const need = (f: string): string => {
    const x = v.get(f);
    if (x === undefined) throw new InputError(`${f} is required`);
    return x;
  };
  const int = (f: string, min: number): number => {
    const x = need(f);
    if (!/^(0|[1-9][0-9]*)$/.test(x) || Number(x) < min) throw new InputError(`${f} needs an integer >= ${min}, got ${x}`);
    return Number(x);
  };
  const profile = need('--profile');
  if (!(PROFILES_ALL as readonly string[]).includes(profile)) throw new InputError(`--profile is edits or faults, got ${profile}`);
  const prefix = v.get('--prefix') ?? '';
  if (badSeedText(prefix, true) !== null) throw new InputError(`--prefix ${JSON.stringify(prefix)} ${badSeedText(prefix, true)}`);
  return { dir: need('--reports'), profile: profile as Profile, from: int('--from', 0), seeds: int('--seeds', 1), prefix, label: v.get('--label') ?? profile };
}

interface Report { file: string; results: SeedLine[]; lost: Array<{ seed: string; reason: string }>; problems: string[]; complete: boolean; }

function asReport(file: string, x: unknown): Report {
  const o = x as { results?: unknown; lost?: unknown; problems?: unknown; complete?: unknown } | null;
  const bad = (what: string): never => { throw new InputError(`${file} is not a run-seeds report (${what})`); };
  if (typeof o !== 'object' || o === null) bad('not an object');
  if (!Array.isArray(o!.results) || !o!.results.every(isSeedLine)) bad('results');
  if (!Array.isArray(o!.lost) || !o!.lost.every((l) => typeof (l as { seed?: unknown }).seed === 'string')) bad('lost');
  if (!Array.isArray(o!.problems) || !o!.problems.every((p) => typeof p === 'string')) bad('problems');
  if (typeof o!.complete !== 'boolean') bad('complete');
  return { file, results: o!.results as SeedLine[], lost: o!.lost as Report['lost'], problems: o!.problems as string[], complete: o!.complete as boolean };
}

async function main(argv: readonly string[]): Promise<number> {
  let a: Args;
  let reports: Report[];
  try {
    a = parseArgs(argv);
    let names: string[];
    try {
      names = (await readdir(a.dir)).filter((n) => n.endsWith('.json')).sort();
    } catch (e) {
      throw new InputError(`cannot read ${a.dir}: ${(e as Error).message}`);
    }
    reports = [];
    for (const n of names) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(a.dir, n), 'utf8'));
      } catch (e) {
        throw new InputError(`${n} is not JSON: ${(e as Error).message}`);
      }
      reports.push(asReport(n, parsed));
    }
  } catch (e) {
    if (e instanceof InputError) {
      process.stderr.write(`exit-verdict: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  const expected = new Set(Array.from({ length: a.seeds }, (_, i) => `${a.prefix}${a.profile}-${a.from + i}`));
  const seen = new Map<string, number>();
  const lines: string[] = [];
  let failures = 0;
  let wrongProfile = 0;
  let passed = 0;
  for (const r of reports) {
    for (const x of r.results) {
      seen.set(x.seed, (seen.get(x.seed) ?? 0) + 1);
      if (x.profile !== a.profile) {
        wrongProfile++;
        lines.push(`WRONG PROFILE ${x.seed} (${x.profile})`);
      }
      if (!x.ok) {
        failures++;
        lines.push(`FAIL ${x.seed} ${x.oracle ?? 'UNKNOWN'} at step ${x.step ?? '?'}: ${(x.message ?? '').split('\n')[0] ?? ''}`);
      } else if (expected.has(x.seed) && x.profile === a.profile && seen.get(x.seed) === 1) {
        passed++;
      }
    }
  }
  const missing = [...expected].filter((s) => !seen.has(s));
  const unexpected = [...seen.keys()].filter((s) => !expected.has(s)).sort();
  const duplicated = [...seen].filter(([, k]) => k > 1).map(([s, k]) => `${s} (${k} results)`).sort();
  for (const s of missing) lines.push(`MISSING ${s}`);
  for (const s of unexpected) lines.push(`UNEXPECTED ${s}`);
  for (const s of duplicated) lines.push(`DUPLICATED ${s}`);
  let lost = 0;
  let problems = 0;
  let incomplete = 0;
  for (const r of reports) {
    for (const l of r.lost) {
      lost++;
      lines.push(`LOST ${l.seed} (${l.reason})`);
    }
    for (const p of r.problems) {
      problems++;
      lines.push(`PROBLEM ${r.file}: ${p}`);
    }
    if (!r.complete) {
      incomplete++;
      lines.push(`INCOMPLETE ${r.file}`);
    }
  }
  for (const l of lines.slice(0, 200)) process.stdout.write(`${l}\n`);
  if (lines.length > 200) process.stdout.write(`… ${lines.length - 200} more\n`);
  const ok = passed === a.seeds && failures + missing.length + unexpected.length + duplicated.length + wrongProfile + lost + problems + incomplete === 0;
  process.stdout.write(`${a.label}: ${passed} of ${a.seeds} ${a.profile} seeds passed; failures ${failures}, missing ${missing.length}, unexpected ${unexpected.length}, duplicated ${duplicated.length}, wrong profile ${wrongProfile}, lost ${lost}, problems ${problems}, incomplete reports ${incomplete}\n`);
  return ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => { process.stderr.write(`exit-verdict: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`); process.exitCode = 2; },
);
