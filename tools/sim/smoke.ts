// SIM smoke gate (11-testing §3.3 harness, §3.11 CI; Plan 1 budget: 10 seeds per leg).
// Runs runSim() with the NaiveEngine and the INV-FF / INV-OID oracles over fixed seeds
// smoke-0 … smoke-<n-1>, one after another, and fails when any seed fails.
//
// Usage: tsx tools/sim/smoke.ts [--seeds <n>] [--peers <n>] [--ops <n>] [--seed <s>]... [--force-push-mutant]
//   defaults: --seeds 10 --peers 3 --ops 20; --seed (repeatable) replaces the smoke-<i> list;
//   --force-push-mutant runs naiveEngine({ forcePush: true }) to show the gate going red.
// Exit: 0 every seed passed, 1 a seed failed (oracle, liveness or thrown error),
//       2 usage error or unexpected internal error.
// tools/ is outside src/, so the L-CLOCK lint does not apply to performance.now() here.
import { runSim, type SeedTuple, type SimResult } from '../../test/sim/harness.js';
import { naiveEngine } from '../../test/sim/naiveEngine.js';
import { oracleFF, oracleOID } from '../../test/sim/oracles.js';

const CODE_REF = 'refs/cowork/main/code';
const DEFAULT_SEEDS = 10;
const DEFAULT_PEERS = 3;
const DEFAULT_OPS = 20;
const OPLOG_TAIL = 6;

class UsageError extends Error {}

interface SmokeArgs { seeds: string[]; peers: number; ops: number; forcePush: boolean; }

const out = (line: string): void => { process.stdout.write(`${line}\n`); };
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

function positiveInt(flag: string, v: string | undefined): number {
  if (v === undefined || !/^[1-9][0-9]*$/.test(v)) throw new UsageError(`${flag} needs a positive integer, got ${v ?? '(nothing)'}`);
  return Number(v);
}

function parseArgs(argv: readonly string[]): SmokeArgs {
  let count = DEFAULT_SEEDS;
  let peers = DEFAULT_PEERS;
  let ops = DEFAULT_OPS;
  let forcePush = false;
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seeds') count = positiveInt(a, argv[++i]);
    else if (a === '--peers') peers = positiveInt(a, argv[++i]);
    else if (a === '--ops') ops = positiveInt(a, argv[++i]);
    else if (a === '--seed') {
      const s = argv[++i];
      if (s === undefined || s === '' || s.startsWith('--')) throw new UsageError('--seed needs a value');
      only.push(s);
    } else if (a === '--force-push-mutant') forcePush = true;
    else throw new UsageError(`unknown argument ${a}`);
  }
  const seeds = only.length > 0 ? only : Array.from({ length: count }, (_, i) => `smoke-${i}`);
  return { seeds, peers, ops, forcePush };
}

function rerunHint(seed: string, a: SmokeArgs): string {
  return `npm run sim:smoke -- --seed ${seed} --peers ${a.peers} --ops ${a.ops}${a.forcePush ? ' --force-push-mutant' : ''}`;
}

/** null when the seed passed; otherwise "<ORACLE|LIVENESS> at step <n>: <message>". */
function verdict(r: SimResult, ops: number): string | null {
  if (!r.ok) {
    const f = r.failure;
    return f === undefined ? 'UNKNOWN at step ?: runSim returned ok=false without a failure' : `${f.oracle} at step ${f.step}: ${f.message}`;
  }
  // Liveness: an engine whose pushes silently stop landing would pass both oracles trivially.
  // A step has landed when any of its push attempts did (the engine retries a rejected push).
  const landed = new Set(r.opLog.filter((e) => e.kind === 'push' && e.detail.startsWith('ok ')).map((e) => e.step));
  if (landed.size !== ops) {
    let miss = 0;
    while (landed.has(miss)) miss++;
    return `LIVENESS at step ${miss}: ${landed.size} of ${ops} steps landed a push`;
  }
  if (r.remoteRefs[CODE_REF] === undefined) return `LIVENESS at step ${ops}: ${CODE_REF} is missing on the remote`;
  return null;
}

async function main(argv: readonly string[]): Promise<number> {
  let args: SmokeArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) { err(`sim:smoke: ${e.message}`); return 2; }
    throw e;
  }
  let failures = 0;
  for (const seed of args.seeds) {
    const t: SeedTuple = { seed, peers: args.peers, ops: args.ops };
    const started = performance.now();
    let result: SimResult | undefined;
    let problem: string | null;
    try {
      result = await runSim(t, naiveEngine({ forcePush: args.forcePush }), [oracleFF('refs/cowork/'), oracleOID(['refs/cowork/probe-'])]);
      problem = verdict(result, args.ops);
    } catch (e) {
      problem = `ERROR: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
    }
    const ms = Math.round(performance.now() - started);
    if (problem === null && result !== undefined) {
      out(`sim:smoke ok ${seed} peers=${t.peers} ops=${t.ops} code=${result.remoteRefs[CODE_REF]} ${ms}ms`);
      // A rejection the engine's retry absorbed does not fail the seed; name it on stderr so a
      // CI-only rejection can still be diagnosed.
      const retried = result.opLog.filter((e) => e.kind === 'push' && e.detail.startsWith('rejected '));
      if (retried.length > 0) err(`sim:smoke note ${seed}: ${retried.length} rejected push attempt(s) retried, every step landed`);
      for (const e of retried) err(`  #${e.step} ${e.peer} ${e.kind} ${e.detail}`);
      continue;
    }
    failures++;
    err(`sim:smoke FAIL ${seed} ${problem ?? 'ERROR: no result'}`);
    err(`  rerun: ${rerunHint(seed, args)}`);
    // runSim keeps the temp root of a failed run; whoever reads this removes it with removeKeptRoot(<dir>)
    // (test/helpers/tmp.ts), which deletes only a marked makeTempRoot base under the system temp directory.
    if (result?.artifactsDir !== undefined) err(`  artifacts: ${result.artifactsDir}`);
    for (const e of result?.opLog.slice(-OPLOG_TAIL) ?? []) err(`  #${e.step} ${e.peer} ${e.kind} ${e.detail}`);
  }
  out(`sim:smoke: ${args.seeds.length} seeds, ${failures} failures`);
  return failures === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => { err(`sim:smoke: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`); process.exitCode = 2; },
);
