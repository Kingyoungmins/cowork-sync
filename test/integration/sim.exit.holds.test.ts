// The exit oracle set and the exit seeds (Plan 3 Task 16; 11-testing §3.3 run steps 4–5, §3.4, TST-07, TC-TST-02; rulings R3-49, R3-51,
// R3-55, X-112): exitOracles(ns, {holds: {markers}}) composes Plan 2's six exit oracles with Plan 3's eleven (ten, and O-RELEASED-ENDS
// since F1 audit fix #28); the exit seeds of every profile pass all of them through tools/sim/run-shard.ts (the composition run-seeds
// uses); Task 15's NOLOSS plant fires INV-NOLOSS
// alone; a holds script with Plan 3's timers reaches T* only once no hold timer can push in the extra rounds. Real git against
// file:// bare remotes; git is never mocked. A multi-seed test runs its first seed under `npm test` and every seed under
// `npm run test:sim` (TEST_SIM_FULL=1, R3-55).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Folder } from '../../src/board/fold.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import { RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import { parseOid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import { guardName, isTerminal } from '../../src/holds/record.js';
import { profileRun } from '../../tools/sim/profileRun.js';
import type { Profile, SeedLine } from '../../tools/sim/seedProtocol.js';
import { play, type Step } from '../helpers/holdsScript.js';
import { dropArtifacts, observing } from '../helpers/simOps.js';
import { removeKeptRoot } from '../helpers/tmp.js';
import { holdsSetup } from '../sim/generators.js';
import { runSim, type OpLogEntry, type Oracle, type SimContext } from '../sim/harness.js';
import { readRegistry } from '../sim/holdsView.js';
import { findMarkers, MarkerModel } from '../sim/markers.js';
import { exitOracles, notReadyReason } from '../sim/oracles.js';
import type { PeerClone } from '../sim/peers.js';

const PLAN2_SIX = ['INV-FF', 'INV-OID', 'INV-FIRSTPARENT', 'INV-BASE', 'INV-PUSHED-IS-MERGE', 'INV-CONVERGE'];
const PLAN3_ELEVEN = ['INV-MASK', 'INV-GROUP', 'O-READY', 'O-AND', 'O-OFFDISK', 'O-LIVE-RECORD', 'O-ATOMIC-PUB', 'INV-NOSILENT', 'INV-NOLOSS', 'INV-SECRET-HELD', 'O-RELEASED-ENDS'];

test('exitOracles(ns) and exitOracles(ns, {}) return exactly Plan 2\'s six in order; exitOracles(ns, {holds: {markers}}) returns those six followed by oracleMask, oracleGroup, oracleReady, oracleAnd, oracleOffDisk, oracleLiveRecord, oracleAtomicPub, oracleNoSilent, oracleNoloss, oracleHeldSecret and oracleReleasedEnds', () => {
  const names = (os: ReadonlyArray<{ name: string }>): string[] => os.map((o) => o.name);
  assert.deepEqual(names(exitOracles()), PLAN2_SIX);
  assert.deepEqual(names(exitOracles(RELEASE_NAMESPACE)), PLAN2_SIX);
  assert.deepEqual(names(exitOracles(RELEASE_NAMESPACE, {})), PLAN2_SIX);
  const markers = new MarkerModel('x');
  const all = exitOracles(RELEASE_NAMESPACE, { holds: { markers } });
  assert.deepEqual(names(all), [...PLAN2_SIX, ...PLAN3_ELEVEN]);
  // Fresh instances on every call (each oracle keeps per-run cursors): no oracle object is shared between two calls.
  const again = exitOracles(RELEASE_NAMESPACE, { holds: { markers } });
  assert.ok(all.every((o, i) => o !== again[i]), 'every call builds its own oracles');
  // Nine Plan 3 oracles run after every op (INV-NOLOSS also at quiescence); INV-SECRET-HELD and O-RELEASED-ENDS run only there.
  const tail = all.slice(6);
  assert.ok(tail.slice(0, 9).every((o) => typeof o.afterEveryOp === 'function'), 'the nine incremental oracles run after every op');
  assert.equal(typeof tail[8]!.atQuiescence, 'function', 'INV-NOLOSS ends with its full scan');
  assert.equal(typeof tail[9]!.atQuiescence, 'function', 'INV-SECRET-HELD runs at quiescence');
  assert.deepEqual([typeof tail[10]!.atQuiescence, tail[10]!.afterEveryOp], ['function', undefined], 'O-RELEASED-ENDS runs only at quiescence');
});

// ---- INV-PUSHED-IS-MERGE never takes the engine's word that a group is not ready (TST-07; the Task 10 carry; R3-53, R3-63) -------

test('INV-PUSHED-IS-MERGE excuses a publication group the compose event marks not ready only for a reason it finds itself: with every member journaled, no held PIN and no R3-53 name the group is unexcused; a member without a journaled ready pair, a not-stageable name on the peer\'s disk, and its fix missing from the published C each excuse it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-notready-'));
  try {
    type Args = Parameters<typeof notReadyReason>;
    const peer = { name: 'p0', dir, filterCountFile: '', opts: {}, canary: '' } as unknown as PeerClone;
    const opLog: OpLogEntry[] = [];
    const ctx = { opLog, peers: [peer] } as unknown as SimContext;
    // No registry commit (no held PIN to find), no state commit (no CS table): the reasons left are the journal's and the op-log's.
    const w = { e: {}, state: null, holds: new Map(), compose: { registry: null } } as unknown as Args[2];
    const X = `${'a'.repeat(32)}/human/1`;
    const Y = `${'a'.repeat(32)}/human/2`;
    const j = { base: '', tP: null, epochBase: '', ready: [{ csId: X, order: 1, R: new Map(), A: new Map(), paths: ['own/x.txt'] }], fold: null } as unknown as Args[3];
    const group = (csIds: string[]): Args[4] => ({ key: csIds.join('+'), csIds, paths: ['own/x.txt'], pins: [], ready: false });
    const C = (paths: string[]): Args[5] => new Map(paths.map((p) => [p, { mode: '100644', oid: 'b'.repeat(40) }])) as unknown as Args[5];
    const verdict = (csIds: string[], c: string[] = []): Promise<string | null> => notReadyReason(ctx, peer, w, j, group(csIds), C(c));
    assert.equal(await verdict([X]), null, "the compose event's ready flag alone excuses nothing");
    assert.equal(await verdict([X, Y]), `(c) ${Y} has no journaled ready pair`, 'R3-63: an open or uncaptured member');
    // R3-53: p0's nonportable_name op wrote a name no record can carry (not stageable), then the fix renamed it.
    const bad = 'np/bad-k1.txt';
    opLog.push({ step: 3, peer: 'p0', kind: 'nonportable_name', detail: `dt=1 ${JSON.stringify(bad)} np/ok-p0-1.txt stageable=false rule=1 CWM_t_1_p0 CWM_t_2_p0` });
    assert.equal(await verdict([X]), null, 'the name is gone from the disk and no fix was written: nothing holds the group');
    mkdirSync(join(dir, 'np'), { recursive: true });
    writeFileSync(join(dir, 'np', 'bad-k1.txt'), 'bad\n');
    assert.equal(await verdict([X]), `(d) ${JSON.stringify(bad)} is on disk`);
    unlinkSync(join(dir, 'np', 'bad-k1.txt'));
    opLog.push({ step: 9, peer: 'p0', kind: 'nonportable_name', detail: `dt=1 ${JSON.stringify(bad)} -> np/fixed-1.txt` });
    assert.equal(await verdict([X]), `(d) the fix np/fixed-1.txt of ${JSON.stringify(bad)} is not in this publish's C`);
    assert.equal(await verdict([X], ['np/fixed-1.txt']), null, 'the fix published: the latch is released');
    // Another peer's name is not this peer's gate.
    opLog.push({ step: 11, peer: 'p1', kind: 'nonportable_name', detail: `dt=1 "np/other.txt" np/ok-p1-2.txt stageable=false rule=1 CWM_t_3_p1 CWM_t_4_p1` });
    writeFileSync(join(dir, 'np', 'other.txt'), 'other\n');
    assert.equal(await verdict([X], ['np/fixed-1.txt']), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the exit seeds through run-shard (TST-07, CS-52, X-07; R3-49, R3-55) ------------------------------------------------------

/** R3-55: every seed under `npm run test:sim`, the first of each profile under `npm test`. */
const FULL = process.env['TEST_SIM_FULL'] === '1';
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SHARD = fileURLToPath(new URL('../../tools/sim/run-shard.ts', import.meta.url));

/**
 * Engine defects these exit seeds reach on this plan's base (Task 16's report diagnoses each; the controller dispatches the fixes): a
 * seed whose run fails with exactly this oracle and message is pinned as a `todo` naming the defect — the oracle stays strict, and
 * any other failure fails the test. `hosts`: the hosts on which the seed reaches it (unset: every host).
 */
// EF4 round 1 (merged): holds-x-0's E16-A pin went (it passes since E2-1, R3-EF4-4). EF4 round 2 (merged): the holds-x-2 pin
// (INV-SECRET-HELD after the portability rename) and the holds-x-3 pin (the E16-C group-iv residual) went — both seeds pass through
// run-shard on the merged head (ok, 3 peers, 60 steps). No exit seed is pinned.
const KNOWN_DEFECTS: Readonly<Record<string, { oracle: string; message: RegExp; defect: string; hosts?: readonly NodeJS.Platform[] }>> = Object.freeze({});

const EXIT_SEEDS: ReadonlyArray<{ seed: string; profile: Profile }> = Object.freeze([
  ...[0, 1, 2, 3].map((k) => ({ seed: `holds-x-${k}`, profile: 'holds' as const })),
  ...[0, 1, 2, 3].map((k) => ({ seed: `edits-x-${k}`, profile: 'edits' as const })),
  ...[0, 1].map((k) => ({ seed: `faults-x-${k}`, profile: 'faults' as const })),
]);

/** One seed through tools/sim/run-shard.ts (its --profile form: the composition run-seeds uses), as a child process: its result line. */
function runShard(profile: Profile, seed: string): Promise<SeedLine> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', SHARD, '--profile', profile, '--seed', seed], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', reject);
    child.on('close', (code) => {
      const line = Buffer.concat(out).toString('utf8').split('\n').find((l) => l.startsWith('{'));
      if (code !== 0 || line === undefined) {
        reject(new Error(`run-shard ${profile} ${seed}: exit ${String(code)}; ${Buffer.concat(err).toString('utf8').slice(-2000)}`));
        return;
      }
      resolve(JSON.parse(line) as SeedLine);
    });
  });
}

test('every exit oracle passes on holds seeds holds-x-0…holds-x-3, edits seeds edits-x-0…edits-x-3 and faults seeds faults-x-0, faults-x-1, each run through run-shard with exitOracles(ns, {holds: {markers}})', { timeout: (FULL ? 180 : 80) * 60_000, concurrency: FULL ? 4 : 3 }, async (t) => {
  // R3-55: npm test runs the first seed of each profile, npm run test:sim all ten.
  const seeds = FULL ? EXIT_SEEDS : EXIT_SEEDS.filter((s) => /-x-0$/.test(s.seed));
  const run = profileRun('holds-x-0', 'holds');
  assert.deepEqual(run.oracles.map((o) => o.name), [...PLAN2_SIX, ...PLAN3_ELEVEN], 'run-shard\'s composition asserts all seventeen');
  const subtests: Array<Promise<void>> = [];
  for (const { seed, profile } of seeds) {
    // Each seed's own timeout (Node 24's --test-timeout of 10 min applies to every subtest; the parent's does not propagate): 40 min,
    // over the 30-min seed timeout of the CI legs; TEST_SIM_FULL's ten in waves of 4 stay under the parent's 180.
    subtests.push(t.test(`${profile} ${seed}`, { timeout: 40 * 60_000 }, async (st) => {
      const line = await runShard(profile, seed);
      if (line.artifacts !== undefined) await removeKeptRoot(line.artifacts);
      const known = KNOWN_DEFECTS[seed];
      if (!line.ok && known !== undefined && (known.hosts === undefined || known.hosts.includes(process.platform)) && line.oracle === known.oracle && known.message.test(line.message ?? '')) {
        st.todo(known.defect);
      }
      assert.ok(line.ok, `${seed}: ${line.oracle} at step ${String(line.step)}: ${line.message ?? ''}`);
      assert.deepEqual([line.seed, line.profile, line.peers, line.steps], [seed, profile, 3, profile === 'holds' ? 60 : 40]);
    }));
  }
  await Promise.all(subtests);
});

// A generator defect the 100-seed measurement found (meas-holds-54: ERROR `teamPush: no board on the remote (bootstrap first)` at step
// 1, before any peer had started): the test-only non-conforming writer can only push onto a board, so a draw before genesis landed is a
// skipped op, never a thrown run.
test('a nonconforming_push drawn before the remote has a board (no peer started yet) is skipped, not a thrown run', { timeout: 30 * 60_000 }, async () => {
  const s = holdsSetup('holds-team-early', { script: [{ kind: 'nonconforming_push', peer: 0, params: { variant: 'plain', paths: ['own/team-early.txt'] } }, { rounds: 2 }] });
  const r = await runSim({ ...s.tuple, ops: 2 }, s.factory, [], { ...s.options, quiescence: undefined });
  await dropArtifacts(r);
  assert.ok(r.ok, JSON.stringify(r.failure));
  const row = r.opLog.find((e) => e.kind === 'nonconforming_push');
  assert.equal(row?.detail.replace(/^dt=\d+ /, ''), 'nonconforming_push p0 skipped (no board on the remote yet)');
});

// ---- TC-TST-02 cross-check: Task 15's NOLOSS plant under all seventeen oracles ----------------------------------------------------

test('every Task 14 oracle stays green on Task 15\'s NOLOSS plant while INV-NOLOSS fails', { timeout: 80 * 60_000 }, async () => {
  // Task 15's plant (sim.noloss.mutants.test.ts): one unpublished marker row deleted from its author's working file between two steps,
  // the model not told. Run with exitOracles(ns, {holds: {markers}}), observed so the run goes on: only INV-NOLOSS fires.
  const s = holdsSetup('holds-nl-tst02', { script: [] });
  const facts = new Map<string, unknown>();
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_band', peer: 0, params: { insert: false } },
    {
      probe: 'mark', run: async (ctx) => {
        const e = [...ctx.opLog].reverse().find((x) => x.kind === 'edit_band' && x.peer === 'p0' && findMarkers(Buffer.from(x.detail, 'latin1')).length > 0)!;
        facts.set('m', findMarkers(Buffer.from(e.detail, 'latin1')).pop());
      },
    },
    {
      probe: 'delete shared.txt', run: async (ctx) => {
        // The plant: the row with the marker leaves p0's shared.txt; the reference model is not told.
        const p = ctx.peers[0]!;
        const abs = join(p.dir, 'shared.txt');
        const mk = facts.get('m') as string;
        const before = await readFile(abs);
        await writeFile(abs, Buffer.from(before.toString('latin1').split(/(?<=\n)/).filter((r) => !r.includes(mk)).join(''), 'latin1'));
        const sec = ctx.clocks.get(p.name)!.wallMs() / 1_000;
        await utimes(abs, sec, sec);
        return mk;
      },
    },
    { rounds: 12 },
  ];
  const obs = observing(exitOracles(RELEASE_NAMESPACE, { holds: { markers: s.markers } }));
  const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, obs.oracles, { ...s.options, generator: play(steps, s.markers) });
  await dropArtifacts(r);
  const plantStep = r.opLog.find((e) => e.kind === 'probe' && e.detail.includes('delete shared.txt'))?.step;
  const f = obs.fired.get('INV-NOLOSS');
  const fired = JSON.stringify(Object.fromEntries(obs.fired));
  assert.ok(f !== undefined, `INV-NOLOSS fired: ${fired}`);
  assert.equal(f.step, plantStep, 'at the plant\'s step');
  assert.match(f.message, new RegExp(`marker ${String(facts.get('m'))} \\(author p0, path shared\\.txt, written at step \\d+\\) is in no location`));
  assert.deepEqual([...obs.fired.keys()], ['INV-NOLOSS'], `every Task 14 oracle (and Plan 2's six, INV-SECRET-HELD) stays green: ${fired}`);
});

// ---- quiescence with Plan 3's timers (X-07; 11-testing §3.3 run step 5; INV-CONVERGE, INV-HLD-BUDGET, R-32) ------------------------

test('quiescence with Plan 3 timers: a holds script that creates a revert record early, then {advance: 540_000}, then (step 55) leaves an INCOMING lock deferral, reaches T* within 400 rounds although the 60 s INCOMING stub and the record\'s +10 min HOLD_REVERT_HELD event push during quiescence (each restarting K, the event\'s 10-minute mark falling inside the K window), and then makes zero push attempts in the 40 extra rounds', { timeout: 80 * 60_000 }, async () => {
  const s = holdsSetup('holds-timers-0', { script: [] });
  const facts: { record: string | null; pushes: Array<{ round: number; what: string }>; tStarFold: { revertHeld: string[]; incoming: string[] } | null } = { record: null, pushes: [], tStarFold: null };
  const head: Step[] = [
    { rounds: 2 },
    { kind: 'new_file', peer: 0, params: { path: 'own/tq-p0.txt', rows: 4 } },
    { rounds: 14 },
    { kind: 'edit_peer_line', peer: 1, params: { path: 'own/tq-p0.txt' } },
    { rounds: 12 },   // p1's edit materializes after its quiet period: the revert record
    {
      probe: 'revert record', run: async (ctx) => {
        const reg = await readRegistry(ctx.git, ctx.peers[1]!.dir, 'main');
        const r = [...reg.records.values()].find((x) => !isTerminal(x) && x.guards.some((g) => guardName(g) === 'revert'));
        assert.ok(r !== undefined, 'p1 holds a revert record');
        facts.record = r.id;
        return r.id;
      },
    },
    { advance: 540_000 },
  ];
  const pad: Step[] = Array.from({ length: 55 - head.length }, (_, k): Step => ({ iterate: k % 3 }));
  const tail: Step[] = [
    // step 55: p2's shared.txt held share-read (never released), then p0's band edit: p2's apply defers its closure 'locked'.
    { kind: 'lock_share_read', peer: 2, params: { path: 'shared.txt' } },
    { kind: 'edit_band', peer: 0, params: { insert: false } },
    { rounds: 3 },
  ];
  const steps = [...head, ...pad, ...tail];
  assert.equal(head.length + pad.length, 55, 'the lock comes at step 55');
  // During quiescence: which pushes landed (a hold op's INCOMING stub, a HOLD_REVERT_HELD event) and in which round.
  let cursor = 0;
  const pushes: Oracle = {
    name: 'QUIESCENCE-PUSHES',
    async afterEveryOp(ctx) {
      const from = cursor;
      cursor = ctx.trace.events.length;
      if (ctx.phase === 'ops') return null;
      const round = ctx.opLog.filter((e) => e.kind === 'round').length;
      for (const e of ctx.trace.events.slice(from)) if (e.kind === 'push' && e.outcome === 'landed') facts.pushes.push({ round, what: `${e.purpose} ${String(e.bnew)}` });
      return null;
    },
    async atQuiescence(ctx) {
      const tStar = ctx.quiescence?.tStar ?? null;
      if (tStar === null) return null;
      const repo = new GitRepo(ctx.git, { workTree: ctx.peers[2]!.dir, gitDir: join(ctx.peers[2]!.dir, '.git'), coworkDir: join(ctx.peers[2]!.dir, '.git', 'cowork') }, () => ({
        attrTree: null, filterDrivers: [], identity: { name: 'reader', email: 'reader@cowork.invalid' }, wallMs: () => 0,
      }));
      const fold = (await new Folder(repo, '0'.repeat(32)).foldTo(parseOid(tStar), null, PLAN2_REGION_SPEC)).state;
      facts.tStarFold = {
        revertHeld: Object.values(fold.events).filter((x) => x.kind === 'health' && x.reason_code === 'HOLD_REVERT_HELD').flatMap((x) => x.refs),
        incoming: Object.entries(fold.holds).filter(([, h]) => h.kind === 'INCOMING').map(([id]) => id),
      };
      return null;
    },
  };
  const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [...exitOracles(RELEASE_NAMESPACE, { holds: { markers: s.markers } }), pushes], { ...s.options, generator: play(steps, s.markers) });
  assert.ok(r.ok, `${JSON.stringify(r.failure)}; artifacts ${String(r.artifactsDir)}; quiescence ${JSON.stringify(r.quiescence)}`);
  const q = r.quiescence!;
  assert.equal(q.reached, true);
  assert.ok(q.rounds <= 400, `T* within 400 rounds: ${q.rounds}`);
  assert.equal(q.pushAttemptsInExtra, 0, 'zero push attempts in the 40 extra rounds');
  assert.equal(q.boardChangedInExtra, false);
  // Both timers pushed during quiescence, before T* (the T* board folds both): the 60 s INCOMING stub and the +10 min event.
  assert.ok(facts.tStarFold !== null && facts.record !== null);
  assert.ok(facts.tStarFold.revertHeld.includes(facts.record), `T* folds the HOLD_REVERT_HELD event of ${facts.record}: ${JSON.stringify(facts.tStarFold)}`);
  assert.ok(facts.tStarFold.incoming.length >= 1, `T* folds the INCOMING lock record's stub: ${JSON.stringify(facts.tStarFold)}`);
  assert.ok(facts.pushes.length >= 2, `at least two hold pushes landed during quiescence (each restarting K): ${JSON.stringify(facts.pushes)}`);
});
