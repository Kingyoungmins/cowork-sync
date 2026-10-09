// The SIM seed runner (Plan 2 Task 19; 11-testing §3.11, rulings R-31…R-33). One call runs one or more profile groups:
// each `--profile` starts a group whose seeds are `${prefix}${profile}-${i}` for i in [from, from + N) (`--seeds N
// --from I`) or its `--seed` list. All the seeds, group after group, are cut into J contiguous slices; each slice is
// run by one tools/sim/run-shard.ts child process (the real engine, the profile's generator, the R-32 quiescence, the
// six exit oracles), whose seed list travels in a JSON file (never on a command line: Windows caps its length). Every
// child prints one JSON line per seed; this process prints one line per seed and, for every failure, its oracle, step,
// message, rerun command and kept artifacts, then one summary line per group, and rewrites the JSON report after every
// seed (`complete` once the run ended), so a red group never hides another and a killed run still leaves its report.
//
// Usage: tsx tools/sim/run-seeds.ts [--profile edits|faults [--seeds N] [--from I] | [--seed S]...]... [--prefix P]
//          [--peers 3] [--steps 40] [--parallel J] [--mutant <id>]... [--report <file.json>] [--keep-dir <dir>]
//          [--timeout-min M] [--seed-timeout-min T]
//   defaults: one group, --profile edits --seeds 10 --from 0; --peers 3 --steps 40 --parallel 4 (R-33: 4 processes);
//   --mutant (repeatable) switches a test-build mutant on (R-29) in every seed;
//   --timeout-min M: the run's deadline — the running seeds dump their partial artifacts, every seed without a result is
//   listed as lost with its rerun command, the report is kept, exit 2; --seed-timeout-min T: a seed still running after
//   T minutes fails as TIMEOUT with its partial op-log and trace (its shard's later seeds are lost); --keep-dir <dir>:
//   every failed or lost seed's artifacts are copied to <dir>/<seed> (CI uploads it; the runner's temp dir is lost).
//   Every flag is validated before any child starts; a group takes either a range or a --seed list.
// Exit: 0 every seed passed, 1 a seed failed (an oracle, no quiescence, a thrown error, a timeout), 2 usage or internal
// error or a lost seed (a shard that died, the deadline).
// tools/ is outside src/, so the L-CLOCK and L-PORTS lints do not apply here.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { cp, mkdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  badSeedText, isMutantId, isSeedLine, MUTANT_IDS, PROFILES_ALL, rerunCommand, type LostSeed, type Profile, type SeedLine, type SeedRef, type SeedsReport,
  type ShardInput,
} from './seedProtocol.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARD = resolve(REPO, 'tools', 'sim', 'run-shard.ts');
/** The op generator gives each peer one band of shared.txt: at most 6 peers (test/sim/generators.ts BANDS). */
const MAX_PEERS = 6;
const MAX_SEEDS = 100_000;
/** How long a shard gets to dump its running seed's artifacts after the deadline, before it is killed. */
const DUMP_GRACE_MS = 15_000;

class UsageError extends Error {}

interface Group { profile: Profile; profileSet: boolean; count: number | null; from: number | null; list: string[]; }
interface Args {
  groups: Array<{ profile: Profile; seeds: string[] }>;
  peers: number; steps: number; parallel: number; mutants: string[]; report: string | null; keepDir: string | null;
  timeoutMs: number; seedTimeoutMs: number;
}

const out = (line: string): void => { process.stdout.write(`${line}\n`); };
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

function int(flag: string, v: string, min: number, max: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(v) || Number(v) < min || Number(v) > max) throw new UsageError(`${flag} needs an integer in ${min}..${max}, got ${v}`);
  return Number(v);
}

function minutes(flag: string, v: string, min: number): number {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(v) || !(Number(v) >= min) || Number(v) > 24 * 60) throw new UsageError(`${flag} needs minutes (a number >= ${min}), got ${v}`);
  return Math.round(Number(v) * 60_000);
}

function parseArgs(argv: readonly string[]): Args {
  const groups: Group[] = [{ profile: 'edits', profileSet: false, count: null, from: null, list: [] }];
  const once = new Map<string, string>();
  let prefix = '';
  let peers = 3;
  let steps = 40;
  let parallel = 4;
  let report: string | null = null;
  let keepDir: string | null = null;
  let timeoutMs = 0;
  let seedTimeoutMs = 0;
  const mutants: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    const known = ['--profile', '--seeds', '--from', '--seed', '--prefix', '--peers', '--steps', '--parallel', '--mutant', '--report', '--keep-dir', '--timeout-min', '--seed-timeout-min'];
    if (!known.includes(flag)) throw new UsageError(`unknown argument ${flag}`);
    const v = argv[++i];
    if (v === undefined || (v.startsWith('--') && flag !== '--seed' && flag !== '--prefix')) throw new UsageError(`${flag} needs a value`);
    const g = groups[groups.length - 1] as Group;
    const global = (name: string): void => {
      if (once.has(name)) throw new UsageError(`${name} is given twice`);
      once.set(name, v);
    };
    switch (flag) {
      case '--profile': {
        if (!(PROFILES_ALL as readonly string[]).includes(v)) throw new UsageError(`--profile is edits or faults, got ${v}`);
        const cur = g.profileSet || g.count !== null || g.from !== null || g.list.length > 0 ? null : g;
        if (cur !== null) {
          cur.profile = v as Profile;
          cur.profileSet = true;
        } else {
          groups.push({ profile: v as Profile, profileSet: true, count: null, from: null, list: [] });
        }
        break;
      }
      case '--seeds':
        if (g.count !== null) throw new UsageError('--seeds is given twice for one --profile');
        g.count = int(flag, v, 1, MAX_SEEDS);
        break;
      case '--from':
        if (g.from !== null) throw new UsageError('--from is given twice for one --profile');
        g.from = int(flag, v, 0, Number.MAX_SAFE_INTEGER - MAX_SEEDS);
        break;
      case '--seed': {
        const bad = badSeedText(v);
        if (bad !== null) throw new UsageError(`--seed ${JSON.stringify(v)} ${bad}`);
        g.list.push(v);
        break;
      }
      case '--prefix': {
        global(flag);
        const bad = badSeedText(v, true);
        if (bad !== null) throw new UsageError(`--prefix ${JSON.stringify(v)} ${bad}`);
        prefix = v;
        break;
      }
      case '--peers': global(flag); peers = int(flag, v, 1, MAX_PEERS); break;
      case '--steps': global(flag); steps = int(flag, v, 0, 1_000_000); break;
      case '--parallel': global(flag); parallel = int(flag, v, 1, 64); break;
      case '--report': global(flag); report = v; break;
      case '--keep-dir': global(flag); keepDir = v; break;
      case '--timeout-min': global(flag); timeoutMs = minutes(flag, v, 0.01); break;
      case '--seed-timeout-min': global(flag); seedTimeoutMs = minutes(flag, v, 0.01); break;
      case '--mutant':
        if (!isMutantId(v)) throw new UsageError(`--mutant is an R-29 switch (${MUTANT_IDS.join(', ')}), got ${v}`);
        if (mutants.includes(v)) throw new UsageError(`--mutant ${v} is given twice`);
        mutants.push(v);
        break;
    }
  }
  const resolved = groups.map((g) => {
    if (g.list.length > 0 && (g.count !== null || g.from !== null)) throw new UsageError(`a --profile ${g.profile} group takes --seed or --seeds/--from, not both`);
    const seeds = g.list.length > 0 ? g.list : Array.from({ length: g.count ?? 10 }, (_, k) => `${prefix}${g.profile}-${(g.from ?? 0) + k}`);
    for (const s of seeds) {
      const bad = badSeedText(s);
      if (bad !== null) throw new UsageError(`seed ${JSON.stringify(s)} ${bad}`);
    }
    return { profile: g.profile, seeds };
  });
  const all = resolved.flatMap((g) => g.seeds);
  const dup = all.find((s, i) => all.indexOf(s) !== i);
  if (dup !== undefined) throw new UsageError(`seed ${dup} is named twice`);
  return { groups: resolved, peers, steps, parallel, mutants, report, keepDir, timeoutMs, seedTimeoutMs };
}

/** J contiguous slices covering the seeds exactly once, in order; the first N mod J slices hold one seed more. */
function slices<T>(seeds: readonly T[], j: number): T[][] {
  const n = Math.min(j, seeds.length);
  const base = Math.floor(seeds.length / n);
  const extra = seeds.length % n;
  const outSlices: T[][] = [];
  let at = 0;
  for (let k = 0; k < n; k++) {
    const size = base + (k < extra ? 1 : 0);
    outSlices.push(seeds.slice(at, at + size));
    at += size;
  }
  return outSlices;
}

/** Kills a shard and everything it started (git processes included). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

interface Shard {
  k: number; slice: SeedRef[]; child: ChildProcess | null; lines: SeedLine[]; running: SeedRef | null; problem: string | null;
  /** Artifacts a deadline dump wrote for the running seed. */
  dumped: string | null;
  done: Promise<void>;
}

async function main(argv: readonly string[]): Promise<number> {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`sim:seeds: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const refs: SeedRef[] = a.groups.flatMap((g) => g.seeds.map((seed) => ({ seed, profile: g.profile })));
  const cut = slices(refs, a.parallel);
  const settings = { peers: a.peers, steps: a.steps, mutants: a.mutants };
  const rerun = (s: SeedRef): string => rerunCommand(s, settings);
  const order = new Map(refs.map((s, i) => [s.seed, i]));
  const lost: LostSeed[] = [];
  const problems: string[] = [];
  const work = mkdtempSync(join(tmpdir(), 'cowork-run-seeds-'));
  let deadlineHit = false;

  const report = (complete: boolean): SeedsReport => {
    const results = shards.flatMap((s) => s.lines).sort((x, y) => (order.get(x.seed) ?? 0) - (order.get(y.seed) ?? 0));
    return {
      runs: a.groups, peers: a.peers, steps: a.steps, mutants: a.mutants, shards: cut.map((s) => s.map((x) => x.seed)),
      results, failures: results.filter((l) => !l.ok).length, lost, problems, complete,
    };
  };
  // The report on disk after every change (temp file + rename), so a run killed from outside still leaves one.
  let writing: Promise<void> = Promise.resolve();
  const saveReport = (complete: boolean): Promise<void> => {
    const file = a.report;
    if (file === null) return writing;
    const text = `${JSON.stringify(report(complete), null, 2)}\n`;
    writing = writing.then(async () => {
      const tmp = `${file}.tmp`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, file);
    }).catch((e: unknown) => { err(`sim:seeds: the report could not be written: ${e instanceof Error ? e.message : String(e)}`); });
    return writing;
  };

  // --keep-dir: a copy of every failed or lost seed's artifacts in a directory the CI job uploads (the temp root is lost
  // with the runner).
  const copies: Array<Promise<void>> = [];
  const keep = (seed: string, dir: string): void => {
    const into = a.keepDir;
    if (into === null) return;
    const to = join(into, seed.replace(/[^A-Za-z0-9._-]/g, '_'));
    copies.push(mkdir(into, { recursive: true }).then(() => cp(dir, to, { recursive: true })).then(
      () => err(`  kept: ${to}`),
      (e: unknown) => err(`sim:seeds: the artifacts of ${seed} could not be kept: ${e instanceof Error ? e.message : String(e)}`),
    ));
  };

  const print = (l: SeedLine): void => {
    if (l.ok) {
      out(`sim:seeds ok ${l.seed} ${l.ms}ms`);
      return;
    }
    err(`sim:seeds FAIL ${l.seed} ${l.oracle ?? 'UNKNOWN'} at step ${l.step ?? '?'}: ${(l.message ?? '').split('\n').join('\n    ')}`);
    err(`  rerun: ${rerun(l)}`);
    // runSim keeps the temp root of a failed run; test/helpers/tmp.ts removeKeptRoot(<dir>) deletes it.
    if (l.artifacts !== undefined) {
      err(`  artifacts: ${l.artifacts}`);
      keep(l.seed, l.artifacts);
    }
  };

  const shards: Shard[] = cut.map((slice, k) => ({ k, slice, child: null, lines: [], running: null, problem: null, dumped: null, done: Promise.resolve() }));
  for (const s of shards) {
    const input: ShardInput = { peers: a.peers, steps: a.steps, mutants: a.mutants as ShardInput['mutants'], seeds: s.slice, seedTimeoutMs: a.seedTimeoutMs };
    const file = join(work, `shard-${s.k}.json`);
    await writeFile(file, `${JSON.stringify(input)}\n`, 'utf8');
    s.done = new Promise((done) => {
      // cwd = the repo root, so `--import tsx` resolves from this repo's node_modules (Node >= 20.6).
      const child = spawn(process.execPath, ['--import', 'tsx', SHARD, '--input', file], {
        cwd: REPO, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, detached: process.platform !== 'win32',
      });
      s.child = child;
      let junk: string | null = null;
      createInterface({ input: child.stdout! }).on('line', (text) => {
        if (text.trim() === '') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        if (isSeedLine(parsed) && s.slice.some((x) => x.seed === parsed.seed && x.profile === parsed.profile) && !s.lines.some((l) => l.seed === parsed.seed)) {
          s.lines.push(parsed);
          s.running = null;
          print(parsed);
          void saveReport(false);
        } else {
          junk ??= text.slice(0, 200);
        }
      });
      createInterface({ input: child.stderr! }).on('line', (text) => {
        const m = /^sim:shard start (.+)$/.exec(text);
        if (m !== null) s.running = s.slice.find((x) => x.seed === m[1]) ?? null;
        err(`[shard ${s.k}] ${text}`);
      });
      child.on('message', (msg: unknown) => {
        const d = msg as { kind?: unknown; artifacts?: unknown } | null;
        if (d?.kind === 'dumped' && typeof d.artifacts === 'string') s.dumped = d.artifacts;
      });
      child.on('error', (e) => {
        s.problem = `shard ${s.k} did not start: ${e.message}`;
        done();
      });
      child.on('close', (code, signal) => {
        const missing = s.slice.filter((x) => !s.lines.some((l) => l.seed === x.seed));
        if (deadlineHit) {
          s.problem = `shard ${s.k} was stopped at the run's deadline`;
        } else if (code !== 0 && code !== 3) {
          s.problem = `shard ${s.k} ended with ${signal ?? `exit ${String(code)}`}`;
        } else if (missing.length > 0 && code === 0) {
          s.problem = `shard ${s.k} ended without a result for ${missing.map((x) => x.seed).join(', ')}`;
        } else if (junk !== null) {
          s.problem = `shard ${s.k} printed a line that is not a seed result: ${junk}`;
        }
        if (!deadlineHit) {
          const why = code === 3 ? `shard ${s.k} stopped after a seed timed out` : `shard ${s.k} ended with ${signal ?? `exit ${String(code)}`}`;
          for (const x of missing) {
            lost.push({ ...x, reason: `${why} before its result`, rerun: rerun(x) });
            err(`sim:seeds LOST ${x.seed} (${why} before its result)`);
            err(`  rerun: ${rerun(x)}`);
          }
        }
        void saveReport(false);
        done();
      });
    });
  }

  let timer: NodeJS.Timeout | undefined;
  const deadline = a.timeoutMs === 0 ? null : new Promise<'deadline'>((r) => { timer = setTimeout(() => r('deadline'), a.timeoutMs); });
  const all = Promise.all(shards.map((s) => s.done));
  try {
    if (deadline !== null && (await Promise.race([all.then(() => 'done' as const), deadline])) === 'deadline') {
      deadlineHit = true;
      // The running seeds dump their partial op-log and trace; then every shard still alive is killed.
      for (const s of shards) {
        if (s.child === null || s.child.exitCode !== null) continue;
        err(`sim:seeds: the run's deadline (${a.timeoutMs / 60_000} min) passed: shard ${s.k} stopped while running ${s.running?.seed ?? '(no seed)'}`);
        try {
          s.child.send({ kind: 'dump' });
        } catch {
          // the channel is gone: nothing to dump
        }
      }
      const grace = Date.now() + DUMP_GRACE_MS;
      while (Date.now() < grace && shards.some((s) => s.child !== null && s.child.exitCode === null && s.running !== null && s.dumped === null)) {
        await new Promise((r) => setTimeout(r, 200));
      }
      for (const s of shards) if (s.child !== null) killTree(s.child);
      await all;
      for (const s of shards) {
        for (const x of s.slice) {
          if (s.lines.some((l) => l.seed === x.seed)) continue;
          const isRunning = s.running?.seed === x.seed;
          const reason = isRunning ? 'running at the deadline' : 'not started at the deadline';
          lost.push({ ...x, reason, rerun: rerun(x), ...(isRunning && s.dumped !== null ? { artifacts: s.dumped } : {}) });
          err(`sim:seeds LOST ${x.seed} (${reason})`);
          err(`  rerun: ${rerun(x)}`);
          if (isRunning && s.dumped !== null) {
            err(`  artifacts: ${s.dumped}`);
            keep(x.seed, s.dumped);
          }
        }
      }
    } else {
      await all;
    }
  } finally {
    clearTimeout(timer);
    rmSync(work, { recursive: true, force: true });
  }

  await Promise.all(copies);
  for (const s of shards) if (s.problem !== null) problems.push(s.problem);
  for (const p of problems) err(`sim:seeds: ${p}`);
  const results = report(false).results;
  for (const g of a.groups) {
    const mine = results.filter((l) => l.profile === g.profile && g.seeds.includes(l.seed));
    out(`sim:seeds: ${mine.length} seeds, ${mine.filter((l) => !l.ok).length} failures (profile ${g.profile}, peers ${a.peers}, steps ${a.steps}, ${cut.length} shards)`);
  }
  await saveReport(!deadlineHit);
  if (problems.length > 0 || lost.length > 0) return 2;
  return results.every((l) => l.ok) ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => { err(`sim:seeds: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`); process.exitCode = 2; },
);
