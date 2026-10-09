// One shard of the seed runner (Plan 2 Task 19; 11-testing §3.11, rulings R-31 and R-33): a child process of
// tools/sim/run-seeds.ts that runs the seeds of its input file one after another with the real engine (realEngine),
// each seed's profile generator (R-31: `edits`, or `faults` with crash injection p = 0.02 per step), the R-32
// quiescence and the six exit oracles, and prints one JSON line per seed on stdout:
//   {"seed":…, "profile":…, "ok":true|false, "oracle"?:…, "step"?:…, "message"?:…, "ms":…, "artifacts"?:…}
// A failed seed keeps its temp root (runSim): `artifacts` names its artifacts directory.
//
// Diagnostics of a hang: before a seed starts, `sim:shard start <seed>` goes to stderr. A seed still running after the
// input's seedTimeoutMs fails as TIMEOUT: its partial op-log and trace are written to <run root>/artifacts (the run's
// temp root is kept), its line names the step it reached, and the shard exits 3 (the hung run cannot be cancelled; the
// parent reports the shard's later seeds as lost). On the parent's `dump` message (its deadline passed) the running
// seed's partial artifacts are written the same way and their directory is sent back.
//
// Usage: tsx tools/sim/run-shard.ts --input <shard.json>   (a ShardInput, tools/sim/seedProtocol.ts)
// Exit: 0 every seed was run (the parent judges the lines), 2 usage or internal error, 3 a seed timed out.
// Test seams (never set in CI): COWORK_SIM_TEST_HANG_SEED=<seed> makes that seed hang at its step 2;
// COWORK_SIM_TEST_CRASH_AFTER=<n> makes the shard exit 70 after its n-th seed line.
// tools/ is outside src/, so the L-CLOCK lint does not apply to performance.now() here.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { seededRandom } from '../../src/ports/random.js';
import { realEngine } from '../../test/sim/engineAdapter.js';
import { editGenerator, PROFILES, seedFilesPlan2 } from '../../test/sim/generators.js';
import { DEFAULT_QUIESCENCE, runSim, type Oracle, type SimContext } from '../../test/sim/harness.js';
import { exitOracles } from '../../test/sim/oracles.js';
import { badSeedText, isMutantId, type SeedLine, type SeedRef, type ShardInput } from './seedProtocol.js';

/** R-31: crash injection of the `faults` profile, per step. */
const FAULTS_CRASH_RATE = 0.02;
const KEPT = /; artifacts kept in (.+)$/s;
const MAX_PEERS = 6;

class UsageError extends Error {}

function readInput(text: string): ShardInput {
  let x: Partial<ShardInput>;
  try {
    x = JSON.parse(text) as Partial<ShardInput>;
  } catch {
    throw new UsageError('the input file is not JSON');
  }
  const int = (v: unknown, min: number, max: number): boolean => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
  if (!int(x.peers, 1, MAX_PEERS) || !int(x.steps, 0, 1_000_000) || !int(x.seedTimeoutMs, 0, Number.MAX_SAFE_INTEGER)) throw new UsageError('peers, steps or seedTimeoutMs out of range');
  if (!Array.isArray(x.mutants) || !x.mutants.every((m) => typeof m === 'string' && isMutantId(m))) throw new UsageError('mutants: not R-29 switches');
  if (!Array.isArray(x.seeds) || x.seeds.length === 0) throw new UsageError('no seeds');
  for (const s of x.seeds as SeedRef[]) {
    if (typeof s?.seed !== 'string' || badSeedText(s.seed) !== null || (s.profile !== 'edits' && s.profile !== 'faults')) throw new UsageError(`bad seed entry ${JSON.stringify(s)}`);
  }
  return x as ShardInput;
}

const jsonl = (rows: readonly unknown[]): string => rows.map((e) => `${JSON.stringify(e)}\n`).join('');

/** The running seed's op-log and trace so far, in <run root>/artifacts (the root stays: runSim never returns). */
async function writePartial(ctx: SimContext): Promise<string> {
  const dir = join(ctx.root, 'artifacts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'op-log.jsonl'), jsonl(ctx.opLog));
  await writeFile(join(dir, 'trace.jsonl'), jsonl(ctx.trace.events));
  return dir;
}

/** The seed running now and the context its run exposes to oracles (from its first op on). */
const running: { seed: SeedRef | null; ctx: SimContext | null } = { seed: null, ctx: null };

function probe(): Oracle {
  return { name: 'PROBE', async afterEveryOp(ctx) { running.ctx = ctx; return null; } };
}

/** COWORK_SIM_TEST_HANG_SEED: an oracle that never answers once the seed reached step 2 (the loop kept alive). */
function hangAt2(): Oracle {
  return {
    name: 'TEST_HANG',
    afterEveryOp: (ctx) => (lastStep(ctx) < 2 ? Promise.resolve(null) : new Promise<string | null>(() => { setInterval(() => {}, 1_000); })),
  };
}

const lastStep = (ctx: SimContext | null): number => ctx?.opLog[ctx.opLog.length - 1]?.step ?? -1;

/** One seed of the exit run; never throws (a thrown engine or fixture error is a failed seed named ERROR). */
async function runSeed(s: SeedRef, a: ShardInput, started: number): Promise<SeedLine> {
  const ms = (): number => Math.round(performance.now() - started);
  const oracles = [probe(), ...(process.env['COWORK_SIM_TEST_HANG_SEED'] === s.seed ? [hangAt2()] : []), ...exitOracles()];
  try {
    const r = await runSim({ seed: s.seed, peers: a.peers, ops: a.steps }, realEngine({ mutants: new Set(a.mutants) }), oracles, {
      generator: editGenerator(PROFILES[s.profile]),
      quiescence: DEFAULT_QUIESCENCE,
      seedFiles: seedFilesPlan2(seededRandom(`${s.seed}/files`)),
      ...(s.profile === 'faults' ? { crash: { rate: FAULTS_CRASH_RATE } } : {}),
    });
    if (r.ok) return { ...s, ok: true, ms: ms() };
    const f = r.failure;
    return {
      ...s, ok: false, oracle: f?.oracle ?? 'UNKNOWN', step: f?.step ?? -1, message: f?.message ?? 'runSim returned ok=false without a failure', ms: ms(),
      ...(r.artifactsDir !== undefined ? { artifacts: r.artifactsDir } : {}),
    };
  } catch (e) {
    const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
    const kept = KEPT.exec(e instanceof Error ? e.message : String(e))?.[1];
    return { ...s, ok: false, oracle: 'ERROR', message, ms: ms(), ...(kept !== undefined ? { artifacts: kept } : {}) };
  }
}

/** The seed with its timeout: a TIMEOUT line (with the partial artifacts) when the run does not end in time. */
async function runWithTimeout(s: SeedRef, a: ShardInput): Promise<{ line: SeedLine; timedOut: boolean }> {
  const started = performance.now();
  if (a.seedTimeoutMs === 0) return { line: await runSeed(s, a, started), timedOut: false };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), a.seedTimeoutMs); });
  try {
    const r = await Promise.race([runSeed(s, a, started), timeout]);
    if (r !== 'timeout') return { line: r, timedOut: false };
    const ctx = running.ctx;
    const artifacts = ctx === null ? undefined : await writePartial(ctx).catch(() => undefined);
    const tail = ctx === null ? '' : `; op-log tail ${JSON.stringify(ctx.opLog.slice(-4))}`;
    return {
      line: {
        ...s, ok: false, oracle: 'TIMEOUT', step: lastStep(ctx), message: `no result after ${a.seedTimeoutMs / 60_000} min (the run reached step ${lastStep(ctx)})${tail}`,
        ms: Math.round(performance.now() - started), ...(artifacts !== undefined ? { artifacts } : {}),
      },
      timedOut: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  let input: ShardInput;
  try {
    if (argv.length !== 2 || argv[0] !== '--input' || argv[1] === undefined) throw new UsageError('usage: run-shard.ts --input <shard.json>');
    input = readInput(await readFile(argv[1], 'utf8'));
  } catch (e) {
    if (e instanceof UsageError || (e as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(`sim:shard: ${(e as Error).message}\n`);
      return 2;
    }
    throw e;
  }
  // The parent's deadline: write the running seed's partial artifacts and say where. The channel never keeps us alive.
  process.channel?.unref();
  process.on('message', (m: unknown) => {
    if ((m as { kind?: unknown } | null)?.kind !== 'dump') return;
    const seed = running.seed;
    const ctx = running.ctx;
    void (ctx === null ? Promise.resolve(undefined) : writePartial(ctx).catch(() => undefined)).then((artifacts) => {
      process.send?.({ kind: 'dumped', seed: seed?.seed ?? null, step: lastStep(ctx), ...(artifacts !== undefined ? { artifacts } : {}) });
    });
  });
  const crashAfter = Number(process.env['COWORK_SIM_TEST_CRASH_AFTER'] ?? 0);
  let done = 0;
  for (const s of input.seeds) {
    running.seed = s;
    running.ctx = null;
    process.stderr.write(`sim:shard start ${s.seed}\n`);
    const { line, timedOut } = await runWithTimeout(s, input);
    await new Promise<void>((resolve) => { process.stdout.write(`${JSON.stringify(line)}\n`, () => resolve()); });
    if (timedOut) return 3;
    if (crashAfter > 0 && ++done >= crashAfter) process.exit(70);
  }
  running.seed = null;
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // A timed-out run still holds the event loop (its pending git calls, timers): leave now (its line is written).
    if (code === 3) process.exit(3);
  },
  (e: unknown) => { process.stderr.write(`sim:shard: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`); process.exitCode = 2; },
);
