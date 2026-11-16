// The seed runner CLI (Task 19; 11-testing §3.11, ruling R-33): tools/sim/run-seeds.ts runs one or more profile groups
// (`--profile edits --seeds 80 --from 0 --profile faults --seeds 20 --from 80`) in contiguous shards, each a
// tools/sim/run-shard.ts child process fed through a seed-list file, with the real engine and the exit oracles;
// it prints one line per seed and every failure's (quoted) rerun command, rewrites its JSON report after every seed,
// gives a rerun command to every seed a shard crash or the run's deadline lost, and keeps a hung seed's diagnostics.
// Plan 3 Task 16 (R3-47, R3-49, R3-51, X-06, X-07): the `holds` profile (holdsSetup), every profile with a MarkerModel, settled =
// holdTimersSettled and exitOracles(ns, {holds: {markers}}) (tools/sim/profileRun.ts), per-profile default steps, report lines with
// peers, steps, kills and per-kind counts, and failure artifacts with one bundle of refs/cowork-local/* per peer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Folder } from '../../src/board/fold.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import { parseOid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import { guardName, isTerminal } from '../../src/holds/record.js';
import { profileRun } from '../../tools/sim/profileRun.js';
import type { SeedsReport } from '../../tools/sim/seedProtocol.js';
import { play, type Step } from '../helpers/holdsScript.js';
import { dropArtifacts } from '../helpers/simOps.js';
import { removeKeptRoot } from '../helpers/tmp.js';
import { HOLDS_PEER_PROFILE, PROFILES, resumeMassFrozen } from '../sim/generators.js';
import { holdTimersSettled, runSim, type SimContext } from '../sim/harness.js';
import { readRegistry } from '../sim/holdsView.js';
import { MarkerModel } from '../sim/markers.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const RUN_SEEDS = fileURLToPath(new URL('../../tools/sim/run-seeds.ts', import.meta.url));

function runSeeds(args: string[], env: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } {
  // cwd = repo root so `--import tsx` resolves from this repo's node_modules (Node >= 20.6).
  const r = spawnSync(process.execPath, ['--import', 'tsx', RUN_SEEDS, ...args], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const readReport = (file: string): SeedsReport => JSON.parse(readFileSync(file, 'utf8')) as SeedsReport;
const esc = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

test('run-seeds validates every flag before starting a child: exit 2 on any bad, missing, repeated or conflicting argument', () => {
  const bad: string[][] = [
    ['--bogus'], ['--seeds', '0'], ['--seeds', 'x'], ['--profile', 'nope'], ['--profile'], ['--parallel', '0'], ['--parallel', '65'],
    ['--from', '-1'], ['--from', '1.5'], ['--seed'], ['--seed', '--peers'], ['--seed', '-x'], ['--seed', 'a"b'], ['--seed', 'a$b'],
    ['--seed', 'a%b'], ['--mutant', 'M99'], ['--mutant', 'M05', '--mutant', 'M05'], ['--peers', '7'], ['--peers', '2', '--peers', '3'],
    ['--steps', 'x'], ['--steps', '-1'], ['--report'], ['--report', '--seeds'], ['--prefix'], ['--prefix', '--seeds'], ['--prefix', 'p!'],
    ['--prefix', 'a', '--prefix', 'b'], ['--seeds', '2', '--seed', 'x'], ['--seed', 'x', '--from', '3'], ['--seeds', '2', '--seeds', '3'],
    ['--profile', 'edits', '--seeds', '2', '--profile', 'edits', '--seeds', '2'], ['--seed', 'x', '--seed', 'x'],
    ['--timeout-min', '0'], ['--timeout-min', 'x'], ['--seed-timeout-min', '-1'],
  ];
  for (const args of bad) {
    const r = runSeeds(args);
    assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^sim:seeds: /m, JSON.stringify(args));
    assert.doesNotMatch(r.stdout, /^sim:seeds ok /m, `${JSON.stringify(args)}: no seed ran`);
  }
});

// Plan 3 Task 16: its own timeout — every profile now runs all seventeen exit oracles after every op (R3-49), and under a loaded
// `npm test` its four seeds took 1,248 s (Node 24's per-test default is 10 min).
test('run-seeds exits 0 for passing seeds, 1 when a mutant seed fails, 2 on bad arguments; shards cover [from, from + N) exactly once; failures print their rerun command', { timeout: 40 * 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-run-seeds-'));
  try {
    assert.equal(runSeeds(['--bogus']).code, 2);

    // 0: two groups in one call (edits 5-6, faults 7) in two shards over the concatenated list, one line each.
    const report = join(dir, 'ok.json');
    const ok = runSeeds(['--profile', 'edits', '--seeds', '2', '--from', '5', '--profile', 'faults', '--seeds', '1', '--from', '7', '--prefix', 'cli-', '--peers', '2', '--steps', '6', '--parallel', '2', '--report', report]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    for (const s of ['cli-edits-5', 'cli-edits-6', 'cli-faults-7']) assert.match(ok.stdout, new RegExp(`^sim:seeds ok ${s} \\d+ms$`, 'm'));
    assert.match(ok.stdout, /^sim:seeds: 2 seeds, 0 failures \(profile edits, peers 2, steps 6, 2 shards\)$/m);
    assert.match(ok.stdout, /^sim:seeds: 1 seeds, 0 failures \(profile faults, peers 2, steps 6, 2 shards\)$/m);
    const rep = readReport(report);
    const want = ['cli-edits-5', 'cli-edits-6', 'cli-faults-7'];
    assert.deepEqual(rep.runs, [{ profile: 'edits', seeds: ['cli-edits-5', 'cli-edits-6'] }, { profile: 'faults', seeds: ['cli-faults-7'] }]);
    assert.deepEqual(rep.shards, [['cli-edits-5', 'cli-edits-6'], ['cli-faults-7']], 'contiguous slices, in order');
    assert.deepEqual(rep.shards.flat(), want, 'the shards cover the seeds exactly once');
    assert.deepEqual(rep.results.map((x) => `${x.profile} ${x.seed}`), ['edits cli-edits-5', 'edits cli-edits-6', 'faults cli-faults-7']);
    assert.ok(rep.results.every((x) => x.ok && Number.isInteger(x.ms)), JSON.stringify(rep.results));
    assert.deepEqual([rep.peers, rep.steps, rep.mutants, rep.failures, rep.lost, rep.problems, rep.complete], [2, 6, [], 0, [], [], true]);

    // 1: a mutant seed fails with its oracle, its rerun command and its kept artifacts.
    const badReport = join(dir, 'bad.json');
    const bad = runSeeds(['--profile', 'edits', '--seed', 'cli-mutant-3', '--peers', '2', '--steps', '12', '--mutant', 'M05', '--report', badReport]);
    const badRep = readReport(badReport);
    try {
      assert.equal(bad.code, 1, bad.stdout + bad.stderr);
      assert.match(bad.stderr, /^sim:seeds FAIL cli-mutant-3 INV-BASE at step \d+: p1: A_set\(.+\) cause join: /m);
      assert.match(bad.stderr, /^ {2}rerun: npm run sim:seeds -- --profile edits --seed cli-mutant-3 --peers 2 --steps 12 --mutant M05$/m);
      assert.match(bad.stdout, /^sim:seeds: 1 seeds, 1 failures \(profile edits, peers 2, steps 12, 1 shards\)$/m);
      const f = badRep.results[0]!;
      assert.deepEqual([f.seed, f.profile, f.ok, f.oracle], ['cli-mutant-3', 'edits', false, 'INV-BASE']);
      assert.ok(f.artifacts !== undefined && existsSync(join(f.artifacts, 'op-log.jsonl')), JSON.stringify(f));
      assert.match(bad.stderr, new RegExp(`^ {2}artifacts: ${esc(f.artifacts!)}$`, 'm'));
    } finally {
      if (badRep.results[0]?.artifacts !== undefined) await removeKeptRoot(badRep.results[0].artifacts);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a red group does not hide another: a hung edits seed times out with its partial op-log and trace kept (and copied to --keep-dir) and its rerun command, while the faults seed of the same call is reported; a shard crash and the run\'s deadline give every lost seed a rerun command and keep the report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-run-seeds-'));
  const kept: string[] = [];
  try {
    // A seed that hangs at step 2 (test seam; its name holds spaces) under a 3 min seed timeout, next to a passing faults
    // seed in another shard. The timeout leaves the faults seed (well under a minute alone) room under npm test's parallel
    // load: at 1 min it timed out too in a loaded npm run ci.
    const r1 = join(dir, 'hang.json');
    const hang = runSeeds(['--profile', 'edits', '--seed', 'cli hang e', '--profile', 'faults', '--seed', 'cli-hang-f', '--peers', '2', '--steps', '4', '--parallel', '2', '--seed-timeout-min', '3', '--keep-dir', join(dir, 'kept'), '--report', r1],
      { COWORK_SIM_TEST_HANG_SEED: 'cli hang e' });
    const rep1 = readReport(r1);
    for (const x of rep1.results) if (x.artifacts !== undefined) kept.push(x.artifacts);
    assert.equal(hang.code, 1, hang.stdout + hang.stderr);
    assert.match(hang.stderr, /^sim:seeds FAIL cli hang e TIMEOUT at step 2: no result after 3 min/m);
    assert.match(hang.stderr, /^ {2}rerun: npm run sim:seeds -- --profile edits --seed "cli hang e" --peers 2 --steps 4$/m, 'the rerun command quotes the seed');
    assert.match(hang.stdout, /^sim:seeds ok cli-hang-f \d+ms$/m, 'the faults seed is reported');
    assert.match(hang.stdout, /^sim:seeds: 1 seeds, 0 failures \(profile faults/m);
    const t = rep1.results.find((x) => x.seed === 'cli hang e')!;
    assert.equal(t.oracle, 'TIMEOUT');
    assert.ok(t.artifacts !== undefined, JSON.stringify(t));
    const opLog = readFileSync(join(t.artifacts, 'op-log.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
    assert.ok(opLog.length >= 2, `the partial op-log is kept: ${opLog.length} entries`);
    assert.ok(existsSync(join(t.artifacts, 'trace.jsonl')), 'the partial trace is kept');
    assert.ok(existsSync(join(dir, 'kept', 'cli_hang_e', 'op-log.jsonl')), '--keep-dir holds a copy of the timed-out seed\'s artifacts');
    assert.match(hang.stderr, new RegExp(`^ {2}kept: ${esc(join(dir, 'kept', 'cli_hang_e'))}$`, 'm'));
    assert.equal(rep1.complete, true);

    // A shard that crashes after its first seed (test seam): its other seeds are lost, each with a rerun command.
    const r2 = join(dir, 'crash.json');
    const crash = runSeeds(['--profile', 'edits', '--seeds', '3', '--from', '0', '--prefix', 'cli-crash-', '--peers', '2', '--steps', '4', '--parallel', '1', '--report', r2],
      { COWORK_SIM_TEST_CRASH_AFTER: '1' });
    const rep2 = readReport(r2);
    assert.equal(crash.code, 2, crash.stdout + crash.stderr);
    assert.match(crash.stdout, /^sim:seeds ok cli-crash-edits-0 \d+ms$/m);
    for (const s of ['cli-crash-edits-1', 'cli-crash-edits-2']) {
      assert.match(crash.stderr, new RegExp(`^sim:seeds LOST ${s} \\(shard 0 ended with exit 70 before its result\\)$`, 'm'));
      assert.match(crash.stderr, new RegExp(`^ {2}rerun: npm run sim:seeds -- --profile edits --seed ${s} --peers 2 --steps 4$`, 'm'));
    }
    assert.deepEqual(rep2.lost.map((l) => l.seed), ['cli-crash-edits-1', 'cli-crash-edits-2']);
    assert.deepEqual([rep2.results.length, rep2.complete], [1, true]);

    // The run's own deadline (1 min: time for the shard to start and reach the hang at step 2 under load) ends a shard
    // whose seed hangs with no seed timeout: lost seeds with rerun commands, the report written with complete: false.
    const r3 = join(dir, 'deadline.json');
    const late = runSeeds(['--profile', 'edits', '--seed', 'cli-late-1', '--seed', 'cli-late-2', '--peers', '2', '--steps', '6', '--parallel', '1', '--timeout-min', '1', '--report', r3],
      { COWORK_SIM_TEST_HANG_SEED: 'cli-late-1' });
    const rep3 = readReport(r3);
    assert.equal(late.code, 2, late.stdout + late.stderr);
    assert.match(late.stderr, /^sim:seeds: the run's deadline \(1 min\) passed: shard 0 stopped while running cli-late-1$/m);
    assert.match(late.stderr, /^sim:seeds LOST cli-late-1 \(running at the deadline\)$/m);
    assert.match(late.stderr, /^sim:seeds LOST cli-late-2 \(not started at the deadline\)$/m);
    assert.deepEqual(rep3.lost.map((l) => [l.seed, l.rerun]), [
      ['cli-late-1', 'npm run sim:seeds -- --profile edits --seed cli-late-1 --peers 2 --steps 6'],
      ['cli-late-2', 'npm run sim:seeds -- --profile edits --seed cli-late-2 --peers 2 --steps 6'],
    ]);
    assert.equal(rep3.complete, false);
    const dumped = rep3.lost[0]?.artifacts;
    assert.ok(dumped !== undefined && existsSync(join(dumped, 'op-log.jsonl')), `the running seed's partial artifacts: ${JSON.stringify(rep3.lost[0])}`);
    kept.push(dumped);
  } finally {
    for (const k of kept) await removeKeptRoot(k);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Plan 3 Task 16: the holds profile, every exit oracle on every profile (R3-47, R3-49, R3-51, X-06, X-07) --------------------

const PLAN2_SIX = ['INV-FF', 'INV-OID', 'INV-FIRSTPARENT', 'INV-BASE', 'INV-PUSHED-IS-MERGE', 'INV-CONVERGE'];
/** Plan 3's ten and (F1 audit fix #28) O-RELEASED-ENDS. */
const PLAN3_ELEVEN = ['INV-MASK', 'INV-GROUP', 'O-READY', 'O-AND', 'O-OFFDISK', 'O-LIVE-RECORD', 'O-ATOMIC-PUB', 'INV-NOSILENT', 'INV-NOLOSS', 'INV-SECRET-HELD', 'O-RELEASED-ENDS'];
const SEVENTEEN = [...PLAN2_SIX, ...PLAN3_ELEVEN];
/** A HOLD_REVERT_HELD health event names its record in `refs` (HLD-60). */
const REVERT_HELD = 'HOLD_REVERT_HELD';

test('run-seeds --profile holds runs holdsSetup with 60 steps unless --steps, crash rate 0.02, and exitOracles(ns, {holds: {markers}}); --profile edits and faults now also pass a MarkerModel and SimOptions.settled = holdTimersSettled; each report line carries profile, steps, kills and per-kind counts', { timeout: 60 * 60_000 }, async () => {
  // The composition run-shard runs for each profile (tools/sim/profileRun.ts, the one composer of a seed).
  const h = profileRun('cli-holds-x', 'holds');
  assert.deepEqual(h.tuple, { seed: 'cli-holds-x', peers: 3, ops: PROFILES.holds.steps });
  assert.equal(h.tuple.ops, 60);
  assert.deepEqual(h.options.crash, { rate: 0.02 });
  assert.equal(h.options.settled, holdTimersSettled);
  assert.equal(h.options.beforeQuiescenceRound, resumeMassFrozen);
  assert.equal(h.options.peerProfile, HOLDS_PEER_PROFILE);
  assert.deepEqual(h.oracles.map((o) => o.name), SEVENTEEN);
  assert.ok(h.markers instanceof MarkerModel);
  assert.equal(profileRun('cli-holds-x', 'holds', { steps: 12 }).tuple.ops, 12, '--steps overrides the profile\'s 60');
  for (const p of ['edits', 'faults'] as const) {
    const e = profileRun(`cli-${p}-x`, p);
    assert.deepEqual(e.tuple, { seed: `cli-${p}-x`, peers: 3, ops: 40 }, `${p}: PROFILES.${p}.steps`);
    assert.ok(e.markers instanceof MarkerModel, `${p}: a MarkerModel`);
    assert.equal(e.options.settled, holdTimersSettled, `${p}: settled = holdTimersSettled`);
    assert.deepEqual(e.oracles.map((o) => o.name), SEVENTEEN, `${p}: exitOracles(ns, {holds: {markers}})`);
    assert.deepEqual(e.options.crash, p === 'faults' ? { rate: 0.02 } : undefined);
  }

  // Each report line: profile, steps (each group's own: --steps when given), peers, kills and the op-log rows per kind.
  const dir = mkdtempSync(join(tmpdir(), 'cowork-run-seeds-'));
  try {
    const report = join(dir, 'lines.json');
    const r = runSeeds(['--profile', 'holds', '--seed', 'cli-lines-h', '--profile', 'edits', '--seed', 'cli-lines-e', '--profile', 'faults', '--seed', 'cli-lines-f', '--peers', '2', '--steps', '6', '--parallel', '3', '--report', report]);
    const rep = readReport(report);
    for (const x of rep.results) if (x.artifacts !== undefined) await removeKeptRoot(x.artifacts);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^sim:seeds: 1 seeds, 0 failures \(profile holds, peers 2, steps 6, 3 shards\)$/m);
    assert.equal(rep.steps, 6);
    assert.ok(typeof rep.wallMs === 'number' && rep.wallMs > 0, 'the run\'s wall time');
    for (const x of rep.results) {
      assert.deepEqual([x.peers, x.steps], [2, 6], JSON.stringify(x));
      assert.ok(Number.isInteger(x.kills) && x.kills === (x.kinds?.['killed'] ?? 0), `kills = the killed rows: ${JSON.stringify(x)}`);
      const kinds = x.kinds ?? {};
      assert.ok(Object.values(kinds).every((n) => Number.isInteger(n) && n > 0), JSON.stringify(kinds));
      assert.equal(kinds['start'], 2, `${x.seed}: each of the 2 peers started once`);
      assert.ok((kinds['round'] ?? 0) > 20, `${x.seed}: the quiescence rounds are counted`);
    }
    assert.deepEqual(rep.results.map((x) => x.profile), ['holds', 'edits', 'faults']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // X-06, R3-37, R-32: an `edits` seed (the edits composition, its generator replaced by a script) whose informed edit of a teammate's
  // line makes a `revert` record, the script's last ops before quiescence: T* is declared only after the record's +10 min
  // HOLD_REVERT_HELD event has folded, and the 40 extra rounds make zero push attempts. Task 13's fix round 1 ruling (Option A,
  // holdTimersSettled) holds T* back only for a timer due within the lookahead ((extraLoops + 1) x loopMs = 102.5 s) once the K rule
  // holds, so the record ages 540 virtual s before quiescence (as the brief's quiescence-timers test does): its event then comes due
  // while the K rule is about to hold, and it cannot land before quiescence (the record is younger than 10 min when the ops end).
  const e = profileRun('cli-revert-0', 'edits');
  const facts: { ids: string[]; before: string[]; folded: string[]; tStar: string | null } = { ids: [], before: [], folded: [], tStar: null };
  const revertIds = async (ctx: SimContext): Promise<string[]> => {
    const reg = await readRegistry(ctx.git, ctx.peers[1]!.dir, 'main');
    return [...reg.records.values()].filter((r) => !isTerminal(r) && r.guards.some((g) => guardName(g) === 'revert')).map((r) => r.id);
  };
  const script: Step[] = [
    { rounds: 2 },
    { kind: 'new_file', peer: 0, params: { path: 'own/rv-p0.txt', rows: 4 } },
    { rounds: 14 },
    { kind: 'edit_peer_line', peer: 1, params: { path: 'own/rv-p0.txt' } },
    { rounds: 12 },   // p1's edit materializes after its quiet period: the revert record
    { probe: 'revert record', run: async (ctx) => { facts.before = await revertIds(ctx); return facts.before.join(','); } },
    { advance: 540_000 },
  ];
  const capture = {
    name: 'CAPTURE',
    async atQuiescence(ctx: SimContext): Promise<string | null> {
      facts.ids = await revertIds(ctx);
      facts.tStar = ctx.quiescence?.tStar ?? null;
      if (facts.tStar !== null) {
        const repo = new GitRepo(ctx.git, { workTree: ctx.peers[1]!.dir, gitDir: join(ctx.peers[1]!.dir, '.git'), coworkDir: join(ctx.peers[1]!.dir, '.git', 'cowork') }, () => ({
          attrTree: null, filterDrivers: [], identity: { name: 'reader', email: 'reader@cowork.invalid' }, wallMs: () => 0,
        }));
        const fold = (await new Folder(repo, '0'.repeat(32)).foldTo(parseOid(facts.tStar), null, PLAN2_REGION_SPEC)).state;
        facts.folded = Object.values(fold.events).filter((x) => x.kind === 'health' && x.reason_code === REVERT_HELD).flatMap((x) => x.refs);
      }
      return null;
    },
  };
  const run = await runSim({ ...e.tuple, ops: script.length }, e.factory, [...e.oracles, capture], { ...e.options, generator: play(script, e.markers) });
  assert.ok(run.ok, `${JSON.stringify(run.failure)}; artifacts ${String(run.artifactsDir)}`);
  await dropArtifacts(run);
  assert.equal(facts.before.length, 1, `one revert record on p1 before the 540 s advance: ${JSON.stringify(facts.before)}`);
  assert.deepEqual(facts.ids, facts.before, 'the same record at quiescence');
  // The record was younger than 10 min when the ops ended, so its event landed in a quiescence round: T* came after it.
  assert.ok(facts.folded.includes(facts.ids[0]!), `T* ${facts.tStar} folds its HOLD_REVERT_HELD event: ${JSON.stringify(facts.folded)}`);
  assert.equal(run.quiescence?.pushAttemptsInExtra, 0, 'zero push attempts in the 40 extra rounds');
  assert.equal(run.quiescence?.boardChangedInExtra, false);
});

/**
 * Three holds seeds that pass all seventeen exit oracles (the first three of Task 16's 100-seed holds measurement that did, on Windows),
 * and one that M38 makes fail (a measured seed whose ops hold a share lock over an incoming multi-path group).
 */
const HOLDS_OK: readonly string[] = ['meas-holds-0', 'meas-holds-1', 'meas-holds-25'];
const HOLDS_M38 = 'meas-holds-75';

test('run-seeds exits 0 when 3 holds seeds pass, 1 when a holds seed fails under --mutant M38, 2 on --profile holds2; a failing seed prints its seed tuple and rerun command and keeps <root>/artifacts with op-log.jsonl, remote.bundle and p0-local.bundle, p1-local.bundle, p2-local.bundle holding refs/cowork-local/*', { timeout: 85 * 60_000 }, async () => {
  const two = runSeeds(['--profile', 'holds2', '--seeds', '1']);
  assert.equal(two.code, 2, two.stdout + two.stderr);
  assert.match(two.stderr, /^sim:seeds: --profile is edits, faults, holds, got holds2$/m);

  const dir = mkdtempSync(join(tmpdir(), 'cowork-run-seeds-'));
  const kept: string[] = [];
  try {
    // 0: three holds seeds at the profile's 60 steps, every one through all seventeen exit oracles.
    const okReport = join(dir, 'ok.json');
    const ok = runSeeds(['--profile', 'holds', ...HOLDS_OK.flatMap((s) => ['--seed', s]), '--parallel', '3', '--report', okReport]);
    const okRep = readReport(okReport);
    for (const x of okRep.results) if (x.artifacts !== undefined) kept.push(x.artifacts);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    for (const s of HOLDS_OK) assert.match(ok.stdout, new RegExp(`^sim:seeds ok ${esc(s)} \\d+ms$`, 'm'));
    assert.match(ok.stdout, /^sim:seeds: 3 seeds, 0 failures \(profile holds, peers 3, steps 60, 3 shards\)$/m);
    assert.deepEqual(okRep.results.map((x) => [x.seed, x.profile, x.steps, x.ok]), HOLDS_OK.map((s) => [s, 'holds', 60, true]));

    // 1: M38 (apply writes the available paths of a group with a locked path) fails a holds seed: its oracle, its seed tuple, its
    // rerun command and its artifacts — the op-log, the remote bundle and one bundle of refs/cowork-local/* per peer.
    const badReport = join(dir, 'bad.json');
    const bad = runSeeds(['--profile', 'holds', '--seed', HOLDS_M38, '--mutant', 'M38', '--report', badReport]);
    const badRep = readReport(badReport);
    for (const x of badRep.results) if (x.artifacts !== undefined) kept.push(x.artifacts);
    assert.equal(bad.code, 1, bad.stdout + bad.stderr);
    const f = badRep.results[0]!;
    assert.deepEqual([f.seed, f.profile, f.ok, f.steps, f.peers], [HOLDS_M38, 'holds', false, 60, 3]);
    assert.match(bad.stderr, new RegExp(`^sim:seeds FAIL ${esc(HOLDS_M38)} ${esc(f.oracle ?? '')} at step \\d+: `, 'm'));
    assert.match(bad.stderr, new RegExp(`^ {2}tuple: \\{"seed":"${esc(HOLDS_M38)}","peers":3,"ops":60\\}$`, 'm'));
    assert.match(bad.stderr, new RegExp(`^ {2}rerun: npm run sim:seeds -- --profile holds --seed ${esc(HOLDS_M38)} --peers 3 --steps 60 --mutant M38$`, 'm'));
    assert.ok(f.artifacts !== undefined, JSON.stringify(f));
    for (const file of ['op-log.jsonl', 'trace.jsonl', 'remote.bundle', 'p0-local.bundle', 'p1-local.bundle', 'p2-local.bundle']) {
      assert.ok(existsSync(join(f.artifacts, file)), `${file} kept in ${f.artifacts}`);
    }
    for (const p of ['p0', 'p1', 'p2']) {
      const heads = spawnSync('git', ['bundle', 'list-heads', join(f.artifacts, `${p}-local.bundle`)], { encoding: 'utf8' }).stdout;
      const refs = heads.split('\n').filter((l) => l.length > 0).map((l) => l.split(' ')[1]);
      assert.ok(refs.length > 0 && refs.every((x) => x?.startsWith('refs/cowork-local/')), `${p}-local.bundle holds refs/cowork-local/* only: ${heads}`);
      assert.ok(refs.includes('refs/cowork-local/main/state'), `${p}-local.bundle holds the state ref`);
    }
  } finally {
    for (const k of kept) await removeKeptRoot(k);
    rmSync(dir, { recursive: true, force: true });
  }
});
