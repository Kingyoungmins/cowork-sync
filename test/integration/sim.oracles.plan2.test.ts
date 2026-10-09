// The Plan 2 oracles against the real engine (Task 19; 11-testing §3.4 rows INV-FF (trace clause), INV-FIRSTPARENT,
// INV-BASE, INV-PUSHED-IS-MERGE, INV-CONVERGE, INV-OID; §3.9 M05, M06, M07, M17, M18, M20; TC-TST-02 form; TST-07;
// ruling R-29). Real git against a file:// bare remote; git is never mocked.
//
// Each mutant runs in a scripted scenario that gives it something to break, with every exit oracle observed (a run
// never stops on an oracle, so the test sees each one that fires); the same scenario without the mutant passes all six.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MutantId } from '../../src/engine/deps.js';
import { mergeTree } from '../../src/git/merge.js';
import type { Oid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { seededRandom } from '../../src/ports/random.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import {
  dropArtifacts, editRowStep, healStep, observing, partitionStep, peerAt, recoverStep, rewindBoardStep, rounds, scripted, touchFutureStep, writeFileStep, type Fired, type ScriptStep,
} from '../helpers/simOps.js';
import { testRunner } from '../helpers/tmp.js';
import { realEngine } from '../sim/engineAdapter.js';
import { gitCallsOf, recordGitCalls, type GitCallRecord } from '../sim/gitCalls.js';
import { seedFilesPlan2 } from '../sim/generators.js';
import { DEFAULT_QUIESCENCE, runSim, type Oracle, type QuiescenceOptions, type SimContext, type SimResult } from '../sim/harness.js';
import { exitOracles, oracleFF } from '../sim/oracles.js';
import type { RemoteLogEntry } from '../sim/remote.js';
import type { SeedsReport } from '../../tools/sim/seedProtocol.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const RUN_SEEDS = fileURLToPath(new URL('../../tools/sim/run-seeds.ts', import.meta.url));
const LONG = process.env['COWORK_SIM_LONG'] === '1';
/** A rerun aid: COWORK_SIM_ONLY=M06,M20 runs only those mutants' scenarios. */
const ONLY = process.env['COWORK_SIM_ONLY']?.split(',') ?? null;
/** Why the M18 pair is skipped, naming the test that catches M18 (ruling: Task 9's diskEq test; the exit sweep lists it). */
const M18_CATCHER_FILE = 'test/integration/diskEq.test.ts';
const M18_CATCHER = 'DISK_EQ on an i/crlf BOM+CRLF file under core.autocrlf=true is equal across 200 rewrites; mutant M18 reports not equal';
const M18_SKIP = `M18 is not observable in SIM (ENG-34's canon check covers for the swapped comparator; a PHANTOM PIN is excluded by R-32); caught by Task 9's diskEq test (${M18_CATCHER_FILE}: "${M18_CATCHER}", 01-engine test 1), which the exit sweep (sim-long.yml) runs`;
const only = (m: MutantId): { skip: string | false } => ({ skip: ONLY !== null && !ONLY.includes(m) && `COWORK_SIM_ONLY=${ONLY.join(',')}` });

/** R-32's quiescence with a short extra phase: the scenarios are not the R-31 run. */
const SHORT_Q: QuiescenceOptions = { ...DEFAULT_QUIESCENCE, extraLoops: 4 };
const NEW_ORACLES = ['INV-FIRSTPARENT', 'INV-BASE', 'INV-PUSHED-IS-MERGE', 'INV-CONVERGE'] as const;

const seedFiles = (seed: string): Record<string, Buffer> => seedFilesPlan2(seededRandom(`${seed}/files`));

/** Genesis on p0, join on p1, then p1's board-only first publish and p0 seeing it. */
const START_TWO: ScriptStep[] = [{ iterate: 0 }, { iterate: 1 }, { wait: 10_000 }, { iterate: 1 }, { iterate: 0 }];

interface Observed { r: SimResult; fired: Map<string, Fired>; ctx: SimContext; logs: Map<string, string[]>; }

/** The run's context and every peer's daemon log, read while the temp root still exists (atQuiescence runs last). */
function collector(): Oracle & { ctx: SimContext | null; logs: Map<string, string[]> } {
  const o: Oracle & { ctx: SimContext | null; logs: Map<string, string[]> } = {
    name: 'COLLECT', ctx: null, logs: new Map(),
    async afterEveryOp(ctx) { o.ctx = ctx; return null; },
    async atQuiescence(ctx) {
      o.ctx = ctx;
      for (const p of ctx.peers) {
        const text = await readFile(join(p.dir, '.git', 'cowork', 'log', 'daemon-0.jsonl'), 'utf8').catch(() => '');
        o.logs.set(p.name, text.split('\n').filter((l) => l.length > 0));
      }
      return null;
    },
  };
  return o;
}

async function observe(seed: string, peers: number, script: readonly ScriptStep[], mutants: readonly MutantId[], q: QuiescenceOptions = SHORT_Q): Promise<Observed> {
  const obs = observing(exitOracles());
  const col = collector();
  const r = await runSim({ seed, peers, ops: script.length }, realEngine({ mutants: new Set(mutants) }), [...obs.oracles, col], {
    generator: scripted(script), quiescence: q, seedFiles: seedFiles(seed),
  });
  await dropArtifacts(r);
  // R-32: a run that never reaches T* fails INV-CONVERGE ("no quiescence"); the harness reports it as QUIESCENCE.
  if (r.failure?.oracle === 'QUIESCENCE' && !obs.fired.has('INV-CONVERGE')) {
    obs.fired.set('INV-CONVERGE', { step: r.failure.step, phase: 'atQuiescence', message: r.failure.message });
  }
  assert.ok(col.ctx !== null);
  return { r, fired: obs.fired, ctx: col.ctx, logs: col.logs };
}

const show = (o: Observed): string => JSON.stringify({ fired: Object.fromEntries(o.fired), failure: o.r.failure, tail: o.r.opLog.slice(-6) });

/** The mutant run trips `expected` (and none of the other new oracles, nor INV-FF/INV-OID); the same script without it passes all six. */
async function firesOnlyOn(seed: string, peers: number, script: readonly ScriptStep[], mutant: MutantId, expected: (typeof NEW_ORACLES)[number], q?: QuiescenceOptions): Promise<Observed> {
  const control = await observe(seed, peers, script, [], q);
  assert.deepEqual([...control.fired.keys()], [], `without ${mutant} no oracle fires: ${show(control)}`);
  assert.ok(control.r.ok, show(control));
  const m = await observe(seed, peers, script, [mutant], q);
  assert.ok(m.fired.has(expected), `${mutant} trips ${expected}: ${show(m)}`);
  assert.deepEqual([...m.fired.keys()].sort(), [expected], `${mutant} trips ${expected} and no other oracle: ${show(m)}`);
  return m;
}

test('each new oracle fires on its mutant and on no other', { skip: !LONG && 'set COWORK_SIM_LONG=1 (the nightly mutation gate, 11-testing §3.11; sim-long.yml runs it)' }, async (t) => {
  await t.test('M07 + a board-rewind fault -> INV-FIRSTPARENT', only('M07'), async () => {
    const script: ScriptStep[] = [
      ...START_TWO,
      writeFileStep(0, 'own/m07.txt', ['m07 row 0', 'm07 row 1', 'm07 row 2']),
      { iterate: 0 }, { wait: 25_000 }, { iterate: 0 },    // p0 captures and publishes the file
      { wait: 10_000 }, { iterate: 1 }, { iterate: 0 },     // p1 applies it
      rewindBoardStep(1),                                    // the board loses that publish (server-side)
      { wait: 3_000 }, { iterate: 0 }, { iterate: 1 },      // INCIDENT on both (M07: the rewound tip is applied)
      { wait: 3_000 }, { iterate: 0 }, { iterate: 1 },
      recoverStep(0),                                        // the human restores LA_B (M07: refused, no incident)
      ...rounds(4, 2, 5_000),
    ];
    const m = await firesOnlyOn('plan2-m07', 2, script, 'M07', 'INV-FIRSTPARENT');
    assert.match(m.fired.get('INV-FIRSTPARENT')!.message, /not on TIP [0-9a-f]+'s first-parent chain|not on T [0-9a-f]+'s first-parent chain/);
  });

  await t.test('M05 (A seeded from TIP at join) -> INV-BASE', only('M05'), async () => {
    const script: ScriptStep[] = [
      { iterate: 0 },                                        // genesis
      writeFileStep(0, 'own/m05.txt', ['m05 row 0', 'm05 row 1']),
      { iterate: 0 }, { wait: 25_000 }, { iterate: 0 },     // published before p1 joins: TIP != HEAD
      { wait: 10_000 }, { iterate: 1 },                     // p1 joins
      ...rounds(5, 2, 5_000),
    ];
    const m = await firesOnlyOn('plan2-m05', 2, script, 'M05', 'INV-BASE');
    assert.match(m.fired.get('INV-BASE')!.message, /^p1: A_set\(own\/m05\.txt\) cause join: .*tree\(HEAD\)/);
  });

  await t.test('M06 (S_disk pushed as OUT) -> INV-PUSHED-IS-MERGE', only('M06'), async () => {
    // p1 captures one row of its band while the remote is partitioned (the fetch fails: no publish), then edits a
    // second row; once the remote answers again it publishes the captured pair. P holds the captured row only; M06 pushes
    // S_disk, which holds both rows — ENG-41 (b)/(c) pass it (the path is in diff(A, P)), INV-PUSHED-IS-MERGE does not.
    const script: ScriptStep[] = [
      ...START_TWO,
      editRowStep(1, 'shared.txt', 14, 'shared band 1 row 4 (14) p1 m06'),
      { iterate: 1 }, { wait: 25_000 },
      partitionStep(),
      { iterate: 1 },                                        // the change-set closes and is captured; the fetch fails
      editRowStep(1, 'shared.txt', 15, 'shared band 1 row 5 (15) p1 m06'),
      healStep(),
      { wait: 31_000 },                                      // past the 30 s network backoff
      { iterate: 1 },                                        // publishes the captured pair (M06: S_disk, both rows)
      ...rounds(6, 2, 5_000),
    ];
    const m = await firesOnlyOn('plan2-m06', 2, script, 'M06', 'INV-PUSHED-IS-MERGE');
    assert.match(m.fired.get('INV-PUSHED-IS-MERGE')!.message, /^p1: landed [0-9a-f]+ has shared\.txt = /);
  });

  await t.test('M17 with a deferred path -> INV-CONVERGE', only('M17'), async () => {
    const script: ScriptStep[] = [
      ...START_TWO,
      editRowStep(0, 'shared.txt', 4, 'shared band 0 row 4 (04) p0 m17'),
      { iterate: 0 }, { wait: 25_000 }, { iterate: 0 },     // p0 publishes band 0
      touchFutureStep(1, 'shared.txt', 60_000),             // p1's copy is in its quiet period at the next apply
      { wait: 1_000 }, { iterate: 1 },                      // the apply defers shared.txt; LA_C := TIP
      ...rounds(6, 2, 5_000),                                // the deferral clears; only "any A[p] != TIP[p]" re-applies
    ];
    const m = await firesOnlyOn('plan2-m17', 2, script, 'M17', 'INV-CONVERGE');
    assert.match(m.fired.get('INV-CONVERGE')!.message, /^p1: A\[shared\.txt\]/);
  });

  // Ruling (Task 19 fix round 1, spec-edit-list TC-TST-02): the M18 -> INV-CONVERGE pair is not demonstrable in SIM.
  // M18's switch (Task 9, src/engine/diskEq.ts) replaces the eq() comparator only. Every DISK_EQ caller in the writer
  // falls back to ENG-34's many-candidates canon check, which matches i/crlf bytes again, and a comparator that also
  // broke that check would make the path a PHANTOM PIN: the ping-pong breaker, listed in not_converged, which R-32
  // excludes from INV-CONVERGE. No SIM oracle can see M18; 01-engine test 1 (test/integration/diskEq.test.ts) kills it.
  await t.test('M18 (DISK_EQ by hash-object --path) -> INV-CONVERGE (phantom ping-pong)', { skip: M18_SKIP }, async () => {
    const script: ScriptStep[] = [
      ...START_TWO,
      editRowStep(0, 'big.py', 100, '# p0 m18'),
      { iterate: 0 }, { wait: 25_000 }, { iterate: 0 },     // p0 (autocrlf=false) publishes a row of the BOM+CRLF file
      ...rounds(6, 2, 5_000),                                // p1 (autocrlf=true) applies it
    ];
    await firesOnlyOn('plan2-m18', 2, script, 'M18', 'INV-CONVERGE', { ...SHORT_Q, extraLoops: 40, maxRounds: 120 });
  });

  await t.test('M20 (ready pair not rebased at an apply) -> the A_cap assert (or INV-PUSHED-IS-MERGE)', only('M20'), async () => {
    const script: ScriptStep[] = [
      ...START_TWO,
      editRowStep(0, 'shared.txt', 4, 'shared band 0 row 4 (04) p0 m20'),
      editRowStep(1, 'shared.txt', 14, 'shared band 1 row 4 (14) p1 m20'),
      { iterate: 0 }, { iterate: 1 }, { wait: 25_000 },
      { iterate: 0 },                                        // p0 publishes band 0
      { iterate: 1 },                                        // p1 captures band 1, applies band 0 (changes A[shared.txt]), publishes
      ...rounds(5, 2, 5_000),
    ];
    const control = await observe('plan2-m20', 2, script, []);
    assert.deepEqual([...control.fired.keys()], [], `without M20 no oracle fires: ${show(control)}`);
    assert.ok(control.r.ok, show(control));
    const m = await observe('plan2-m20', 2, script, ['M20']);
    const aCap = (m.logs.get('p1') ?? []).some((l) => /"code":"NOT_CONVERGED"/.test(l) && /"check":"a_cap"/.test(l));
    // ENG-39's A_cap assert stops the stale R before any push, so the pair never publishes: the only oracle that can see
    // it is INV-CONVERGE (p1's band-1 edit is never published). Without the assert, the stale pair would land and
    // INV-PUSHED-IS-MERGE would recompute P from the journal (its A_cap differs from A, ENG-39) and fire instead.
    const expected = aCap ? ['INV-CONVERGE'] : ['INV-PUSHED-IS-MERGE'];
    assert.ok(aCap || m.fired.has('INV-PUSHED-IS-MERGE'), `M20 is caught by the A_cap assert or INV-PUSHED-IS-MERGE: ${show(m)}`);
    assert.deepEqual([...m.fired.keys()].sort(), expected, `M20 trips ${expected.join(', ')} and no other oracle: ${show(m)}`);
  });
});

test('a \'+\' refspec planted into a recorded push argv fails the INV-FF trace clause', async () => {
  // A plant after the first landed push: a copy of it as a 'recover' push in its leased form (exempt); after the next
  // landed push: a copy as the daemon's own purpose with '+' (the violation).
  let planted = 0;
  let plantStep = -1;
  const plant: Oracle = {
    name: 'PLANT',
    async afterEveryOp(ctx) {
      // Board pushes (genesis, board_only, publish): their last argument is a `<oid>:refs/cowork/main/…` refspec.
      const pushes = ctx.trace.ofKind('push').filter((e) => e.outcome === 'landed' && e.purpose !== 'recover' && /:refs\/cowork\/main\//.test(e.argv.at(-1) ?? '') && !e.argv.some((a) => a.startsWith('+')));
      const e = pushes[planted];
      if (e === undefined || planted >= 2) return null;
      if (planted === 0) {
        ctx.trace.emit({ ...e, purpose: 'recover' });
      } else {
        ctx.trace.emit({ ...e, argv: e.argv.map((a, i) => (i === e.argv.length - 1 ? `+${a}` : a)) });
        plantStep = ctx.opLog[ctx.opLog.length - 1]!.step;
      }
      planted++;
      return null;
    },
  };
  const script: ScriptStep[] = [
    ...START_TWO,
    writeFileStep(0, 'own/ff.txt', ['ff row 0']),
    { iterate: 0 }, { wait: 25_000 }, { iterate: 0 }, { iterate: 1 },
    ...rounds(3, 2, 5_000),
  ];
  const r = await runSim({ seed: 'plan2-ff-plant', peers: 2, ops: script.length }, realEngine(), [plant, ...exitOracles()], {
    generator: scripted(script), quiescence: SHORT_Q, seedFiles: seedFiles('plan2-ff-plant'),
  });
  await dropArtifacts(r);
  assert.equal(planted, 2, `two plants: ${JSON.stringify(r.failure)}`);
  assert.deepEqual([r.failure?.oracle, r.failure?.step], ['INV-FF', plantStep], JSON.stringify(r.failure));
  assert.match(r.failure?.message ?? '', /push argv carries "\+[0-9a-f]{40,64}:refs\/cowork\/main\//);

  // The same clause on a recorded trace alone: a leased push passes; --force and -f fail; a 'recover' push passes only in
  // its leased form (--force-with-lease=<ref>:<expected oid> for every ref, no --force, -f or '+').
  const fake = (argv: string[], purpose: 'publish' | 'recover'): SimContext => {
    const events = [{ kind: 'push', peer: 'x', purpose, argv, bnew: null, outcome: 'landed' }];
    return {
      trace: { events, names: new Map() }, remote: { readRemoteLog: async () => [] },
    } as unknown as SimContext;
  };
  const ff = (argv: string[], purpose: 'publish' | 'recover'): Promise<string | null> => oracleFF('refs/cowork/').afterEveryOp!(fake(argv, purpose));
  const ref = 'refs/cowork/main/board';
  const spec = `${'a'.repeat(40)}:${ref}`;
  const leased = ['push', '--porcelain', '--no-verify', `--force-with-lease=${ref}:${'b'.repeat(40)}`, 'file:///r', spec];
  assert.equal(await ff(leased, 'publish'), null);
  assert.match((await ff([...leased, '--force'], 'publish')) ?? '', /'publish' push argv carries "--force"/);
  assert.match((await ff([...leased.slice(0, -1), '-f', spec], 'publish')) ?? '', /'publish' push argv carries "-f"/);
  assert.equal(await ff(leased, 'recover'), null, 'the leased recover is exempt');
  assert.equal(await ff([...leased.slice(0, 3), `--force-with-lease=${ref}:`, 'file:///r', spec], 'recover'), null, 'a lease expecting the ref absent is explicit');
  assert.match((await ff([...leased.slice(0, -1), `+${spec}`], 'recover')) ?? '', /'recover' push argv carries "\+a{40}:refs\/cowork\/main\/board"/);
  assert.match((await ff([...leased, '--force'], 'recover')) ?? '', /'recover' push argv carries "--force"/);
  assert.match((await ff([...leased.slice(0, -1), '-f', spec], 'recover')) ?? '', /'recover' push argv carries "-f"/);
  assert.match((await ff(['push', '--porcelain', '--force-with-lease', 'file:///r', spec], 'recover')) ?? '', /names refs\/cowork\/main\/board without --force-with-lease=/);
  assert.match((await ff(['push', '--porcelain', `--force-with-lease=${ref}`, 'file:///r', spec], 'recover')) ?? '', /names refs\/cowork\/main\/board without --force-with-lease=/);
  assert.match((await ff(['push', '--porcelain', 'file:///r', spec], 'recover')) ?? '', /without --force-with-lease=/);
});

// ---- planted bad traces (TC-TST-02, TST-07): each exit oracle fires on its own plant and on no other -----------------

/** What a plant changes in a finished run, judged by a fresh exit-oracle set. */
interface Plant {
  /** Trace events appended after the run's own. */
  add?: TraceEvent[];
  /** One recorded event replaced in place (a publish judged against the state it was journaled in). */
  swap?: { from: TraceEvent; to: TraceEvent };
  /** Git call records appended after the run's own (INV-OID's fault clause). */
  git?: GitCallRecord[];
  /** Remote-log entries appended after the remote's own. */
  log?: RemoteLogEntry[];
}

/**
 * Runs a fresh exitOracles() set over a view of the finished run (its remote, repos and engines) whose trace and git-call
 * log carry the plant: each afterEveryOp oracle once over the whole trace, then each atQuiescence oracle. Returns the
 * oracles that fired, by name.
 */
async function judge(ctx: SimContext, plant: Plant = {}): Promise<Record<string, string>> {
  const events = [...ctx.trace.events];
  if (plant.swap !== undefined) {
    const at = events.indexOf(plant.swap.from);
    assert.ok(at >= 0, 'the swapped event is in the trace');
    events[at] = plant.swap.to;
  }
  events.push(...(plant.add ?? []));
  const git: GitRunner = { run: (args, opts) => ctx.git.run(args, opts) };
  recordGitCalls(git).push(...(gitCallsOf(ctx.git) ?? []), ...(plant.git ?? []));
  const log = plant.log;
  const remote = log === undefined ? ctx.remote : { ...ctx.remote, readRemoteLog: async () => [...(await ctx.remote.readRemoteLog()), ...log] };
  const view: SimContext = { ...ctx, trace: { events, names: ctx.trace.names } as unknown as SimContext['trace'], git, remote };
  const fired: Record<string, string> = {};
  for (const o of exitOracles()) {
    const m = (await o.afterEveryOp?.call(o, view)) ?? (await o.atQuiescence?.call(o, view)) ?? null;
    if (m !== null) fired[o.name] = m;
  }
  return fired;
}

/** A commit object like `commit` with its tree line replaced (a test-only hook corrupting one pushed tree). */
async function withTree(repo: GitRepo, commit: string, tree: string): Promise<string> {
  const text = (await repo.run(['cat-file', 'commit', commit])).stdout.toString('utf8');
  const changed = text.replace(/^tree [0-9a-f]+$/m, `tree ${tree}`);
  assert.notEqual(changed, text);
  return (await repo.run(['hash-object', '-t', 'commit', '-w', '--stdin'], { stdin: Buffer.from(changed, 'utf8') })).stdout.toString('utf8').trim();
}

/** `tree` with `path` set to `bytes` (a scratch index in the run root). */
async function treeWith(repo: GitRepo, root: string, tree: string, path: string, bytes: Buffer): Promise<string> {
  const blob = await repo.hashBytes(bytes, true);
  const index = join(root, 'plant.index');
  await repo.readTreeIntoIndex(index, tree as Oid);
  await repo.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { class: 'refupdate', indexFile: index });
  return (await repo.run(['write-tree'], { indexFile: index })).stdout.toString('utf8').trim();
}

test('each exit oracle fires on its planted bad trace and on no other: INV-FF (-f, \'+\', a recover with --force or without an explicit lease, a recover lease that is not the old value), INV-OID (a foreign probe deletion, a push after a commit-tree exit 128), INV-FIRSTPARENT, INV-PUSHED-IS-MERGE (a corrupted pushed tree, a P the journal does not compose, a replacement the conflict function does not make), INV-CONVERGE (a corrupted file, an admitted untracked file; a tracked file grown past 50 MiB is SAVE_ONLY, not compared)', async () => {
  const results: Array<{ plant: string; fired: Record<string, string> }> = [];
  const PLANTS: Oracle = {
    name: 'PLANTS',
    async atQuiescence(ctx) {
      const p0 = peerAt(ctx, 0);
      const p1 = peerAt(ctx, 1);
      const idOf = (name: string): string => [...ctx.trace.names].find(([, n]) => n === name)![0];
      const run = async (plant: string, change: Plant = {}): Promise<void> => { results.push({ plant, fired: await judge(ctx, change) }); };
      const repo = new GitRepo(testRunner(), { workTree: realpathSync.native(p0.dir), gitDir: join(realpathSync.native(p0.dir), '.git'), coworkDir: join(realpathSync.native(p0.dir), '.git', 'cowork') },
        () => ({ attrTree: null, filterDrivers: [], identity: { name: 'plant', email: 'plant@cowork.invalid' }, wallMs: () => 1_700_000_000_000 }));
      const pushes = ctx.trace.ofKind('push');
      const pub = pushes.find((e) => e.purpose === 'publish' && e.outcome === 'landed' && e.peer === idOf('p0'));
      const rec = pushes.find((e) => e.purpose === 'recover' && e.outcome === 'landed');
      assert.ok(pub !== undefined && rec !== undefined, 'the run has a landed publish and a landed recover push');
      const insert = (argv: readonly string[], extra: string): string[] => [...argv.slice(0, -1), extra, argv.at(-1)!];

      await run('control');
      await run('FF -f', { add: [{ ...pub, argv: insert(pub.argv, '-f') }] });
      await run('FF +', { add: [{ ...pub, argv: pub.argv.map((a, i) => (i === pub.argv.length - 1 ? `+${a}` : a)) }] });
      await run('FF recover --force', { add: [{ ...pub, purpose: 'recover', argv: insert(pub.argv, '--force') }] });
      await run('FF recover bare lease', { add: [{ ...pub, purpose: 'recover', argv: pub.argv.map((a) => (a.startsWith('--force-with-lease=') ? '--force-with-lease' : a)) }] });
      // A recover's non-fast-forward update in the remote log: exempt when its lease expected the old value, else not.
      const tStar = ctx.quiescence!.tStar!;
      const board = 'refs/cowork/main/board';
      const moved: RemoteLogEntry = { ref: board, old: '1'.repeat(40), new: tStar };
      const recoverPush = (expect: string): TraceEvent => ({
        kind: 'push', peer: idOf('p0'), purpose: 'recover', bnew: tStar, outcome: 'landed',
        argv: ['push', '--porcelain', '--no-verify', `--force-with-lease=${board}:${expect}`, ctx.remote.url, `${tStar}:${board}`],
      });
      await run('FF recover lease == old', { add: [recoverPush('1'.repeat(40))], log: [moved] });
      await run('FF recover lease != old', { add: [recoverPush('2'.repeat(40))], log: [moved] });

      const other = idOf('p1');
      await run('OID foreign probe', { add: [{ kind: 'push', peer: idOf('p0'), purpose: 'probe', argv: ['push', '--porcelain', '--no-verify', `--force-with-lease=refs/cowork/probe-${other}:${'c'.repeat(40)}`, ctx.remote.url, `:refs/cowork/probe-${other}`], bnew: null, outcome: 'landed' }] });
      const dir0 = realpathSync.native(p0.dir);
      const dir1 = realpathSync.native(p1.dir);
      const fault = { cwd: dir0, sub: 'commit-tree', code: 128, stdoutEmpty: true };
      await run('OID push after a fault', { git: [fault, { cwd: dir0, sub: 'push', code: 0, stdoutEmpty: false }] });
      await run('OID fault, another peer pushes', { git: [fault, { cwd: dir1, sub: 'push', code: 0, stdoutEmpty: false }] });

      const merges = ctx.trace.ofKind('merge').filter((m) => m.peer === idOf('p1'));
      const states = ctx.trace.ofKind('state').filter((s) => s.peer === idOf('p1'));
      const m = merges.at(-1)!;
      const lastState = states.at(-1)!;
      await run('FIRSTPARENT', { add: [{ ...m, laC: lastState.next, base: lastState.base }] });

      const publish = ctx.trace.ofKind('publish').find((e) => e.peer === idOf('p0') && e.c !== null && e.bnew === pub.bnew)!;
      assert.ok(publish !== undefined, 'the landed publish has its publish event');
      const tipTree = (await repo.readCommit(publish.tip as Oid)).tree;
      const cTree = (await repo.readCommit(publish.c! as Oid)).tree;
      const corrupted = await treeWith(repo, ctx.root, cTree, 'own/plant.txt', Buffer.from('plant row 0\ncorrupted\n', 'utf8'));
      await run('PIM corrupted tree', { swap: { from: publish, to: { ...publish, c: await withTree(repo, publish.c!, corrupted) } } });
      // A P the journal does not compose, with a C that is that P's merge (an engine reporting its own P is believed by
      // an oracle that trusts it).
      const p2 = await treeWith(repo, ctx.root, publish.pTree, 'own/not-captured.txt', Buffer.from('never captured\n', 'utf8'));
      const merged = await mergeTree(repo, publish.aTree as Oid, p2 as Oid, tipTree);
      await run('PIM P not composed', { swap: { from: publish, to: { ...publish, pTree: p2, c: await withTree(repo, publish.c!, merged.tree) } } });
      // A "replacement" that reverts the publish's own change to TIP[p] (the old trust: any replacement taking TIP[p]).
      const tipMap = await repo.readTreeMap(tipTree);
      const reverted = await repo.readTreeMap(cTree);
      const changedPath = [...reverted.keys()].find((q) => reverted.get(q)?.oid !== tipMap.get(q)?.oid)!;
      assert.ok(changedPath !== undefined && !tipMap.has(changedPath), `the publish adds a path: ${changedPath}`);
      const without = (await repo.run(['write-tree'], { indexFile: await (async () => {
        const ix = join(ctx.root, 'plant-revert.index');
        await repo.readTreeIntoIndex(ix, cTree);
        await repo.run(['update-index', '--force-remove', changedPath], { class: 'refupdate', indexFile: ix });
        return ix;
      })() })).stdout.toString('utf8').trim();
      await run('PIM replacement', { swap: { from: publish, to: { ...publish, c: await withTree(repo, publish.c!, without), replaced: [{ path: changedPath, blob: null }] } } });

      // INV-CONVERGE: p1's working tree, changed and put back around each judgement.
      const readme = join(p1.dir, 'README.md');
      const bytes = readFileSync(readme);
      try {
        writeFileSync(readme, Buffer.concat([bytes, Buffer.from('planted line\n', 'utf8')]));
        await run('CONVERGE corrupted file');
        writeFileSync(readme, Buffer.alloc(52_428_800 + 1, 0x61));
        await run('CONVERGE tracked file past 50 MiB');
      } finally {
        writeFileSync(readme, bytes);
      }
      const extra = join(p1.dir, 'own', 'planted-untracked.txt');
      try {
        mkdirSync(join(p1.dir, 'own'), { recursive: true });
        writeFileSync(extra, 'an admitted new file\n');
        await run('CONVERGE untracked LIVE file');
      } finally {
        rmSync(extra, { force: true });
      }
      return null;
    },
  };
  const script: ScriptStep[] = [
    ...START_TWO,
    writeFileStep(0, 'own/plant.txt', ['plant row 0', 'plant row 1', 'plant row 2']),
    { iterate: 0 }, { wait: 25_000 }, { iterate: 0 },
    { wait: 10_000 }, { iterate: 1 }, { iterate: 0 },
    rewindBoardStep(1),
    { wait: 3_000 }, { iterate: 0 }, { iterate: 1 },
    { wait: 3_000 }, { iterate: 0 }, { iterate: 1 },
    recoverStep(0),
    ...rounds(4, 2, 5_000),
  ];
  const r = await runSim({ seed: 'plan2-plants', peers: 2, ops: script.length }, realEngine(), [PLANTS, ...exitOracles()], {
    generator: scripted(script), quiescence: SHORT_Q, seedFiles: seedFiles('plan2-plants'),
  });
  await dropArtifacts(r);
  assert.ok(r.ok, JSON.stringify({ failure: r.failure, tail: r.opLog.slice(-8) }));
  const by = new Map(results.map((x) => [x.plant, x.fired]));
  // Every plant is judged before any assertion, so one run lists every plant whose verdict is wrong.
  const wrong: string[] = [];
  const only = (plant: string, oracle: string | null, message?: RegExp): void => {
    const fired = by.get(plant);
    const keys = fired === undefined ? null : Object.keys(fired);
    const ok = fired !== undefined && JSON.stringify(keys) === JSON.stringify(oracle === null ? [] : [oracle])
      && (oracle === null || message === undefined || message.test(fired[oracle] ?? ''));
    if (!ok) wrong.push(`${plant}: expected ${oracle ?? 'none'}, fired ${JSON.stringify(fired ?? 'not judged')}`);
  };
  only('control', null);
  only('FF -f', 'INV-FF', /'publish' push argv carries "-f"/);
  only('FF +', 'INV-FF', /'publish' push argv carries "\+[0-9a-f]+:refs\/cowork\/main\//);
  only('FF recover --force', 'INV-FF', /'recover' push argv carries "--force"/);
  only('FF recover bare lease', 'INV-FF', /'recover' push argv names refs\/cowork\/main\/\w+ without --force-with-lease=/);
  only('FF recover lease == old', null);
  only('FF recover lease != old', 'INV-FF', /^refs\/cowork\/main\/board moved 1{40} -> [0-9a-f]+, not a first-parent fast-forward \(the recover push leased 2{40}\)/);
  only('OID foreign probe', 'INV-OID', /p0: a 'probe' push deletes refs\/cowork\/probe-[0-9a-f]+ \(only the peer's own probe ref/);
  only('OID push after a fault', 'INV-OID', /^p0: a push after its commit-tree exited 128 with empty stdout in the same op/);
  only('OID fault, another peer pushes', null);
  only('FIRSTPARENT', 'INV-FIRSTPARENT', /^p1: (apply|publish) merge with LA_C [0-9a-f]+ not on TIP [0-9a-f]+'s first-parent chain/);
  only('PIM corrupted tree', 'INV-PUSHED-IS-MERGE', /^p0: landed [0-9a-f]+ has own\/plant\.txt = 100644 [0-9a-f]+, the merge of A, P and TIP/);
  only('PIM P not composed', 'INV-PUSHED-IS-MERGE', /^p0: publish [0-9a-f]+: its P [0-9a-f]+ is not the journaled t\/P /);
  only('PIM replacement', 'INV-PUSHED-IS-MERGE', /^p0: landed [0-9a-f]+ has own\/plant\.txt = absent, the merge of A, P and TIP .* gives 100644 [0-9a-f]+/);
  only('CONVERGE corrupted file', 'INV-CONVERGE', /^p1: README\.md on disk is not T\*'s /);
  only('CONVERGE tracked file past 50 MiB', null);
  only('CONVERGE untracked LIVE file', 'INV-CONVERGE', /^p1: untracked own\/planted-untracked\.txt is LIVE, not in T\*/);

  assert.deepEqual(wrong, []);
});

test("M18's skipped SIM pair names its catching test, Task 9's diskEq test, which exists, switches M18 on and is in the exit sweep (sim-long.yml)", () => {
  assert.match(M18_SKIP, /Task 9's diskEq test/);
  const diskEq = readFileSync(join(REPO, ...M18_CATCHER_FILE.split('/')), 'utf8');
  assert.ok(diskEq.includes(`test('${M18_CATCHER}'`), `${M18_CATCHER_FILE} holds the test the skip names`);
  assert.match(diskEq, /mutants: \['M18'\]/, 'it switches M18 on');
  const sweep = readFileSync(join(REPO, '.github', 'workflows', 'sim-long.yml'), 'utf8');
  const longStep = /COWORK_SIM_LONG: '1'\n {8}run: npx tsx --test (.*)$/m.exec(sweep);
  assert.ok(longStep !== null && longStep[1]!.split(' ').includes(M18_CATCHER_FILE), 'the exit sweep runs it');
});

test('every exit oracle passes on 20 edits seeds and 10 faults seeds', { skip: !LONG && 'set COWORK_SIM_LONG=1 (sim-long.yml runs it; the per-push legs run 100 seeds through sim:seeds)' }, () => {
  // One call runs both groups, so a red edits group never hides the faults results; the report lists every seed.
  const dir = mkdtempSync(join(tmpdir(), 'cowork-seeds-'));
  try {
    const report = join(dir, 'exit.json');
    const r = spawnSync(process.execPath, [
      '--import', 'tsx', RUN_SEEDS, '--profile', 'edits', '--seeds', '20', '--profile', 'faults', '--seeds', '10', '--prefix', 'plan2-exit-', '--parallel', '4', '--report', report,
    ], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const rep = JSON.parse(readFileSync(report, 'utf8')) as SeedsReport;
    const failed = rep.results.filter((x) => !x.ok);
    assert.deepEqual([rep.results.filter((x) => x.profile === 'edits').length, rep.results.filter((x) => x.profile === 'faults').length], [20, 10], JSON.stringify(rep.lost));
    assert.deepEqual(failed, [], `${r.stdout.slice(-4_000)}${r.stderr.slice(-4_000)}`);
    assert.deepEqual([rep.lost, rep.problems, r.status], [[], [], 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
