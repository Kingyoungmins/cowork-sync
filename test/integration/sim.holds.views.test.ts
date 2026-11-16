// The SIM harness for holds, its plumbing (Plan 3 Task 13; X-03, R3-47, R3-03, R3-04, R3-07, TST-03, R-32): realEngine's Plan 3
// bindings and platform, realEngineOf/faultFsOf, the test-side readers of holdsView, the teammate writer, TraceRecorder.monoAt, the
// afterEveryOp rounds and holdTimersSettled. Real git against file:// bare remotes; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readHeld } from '../../src/board/boardCommit.js';
import { Folder } from '../../src/board/fold.js';
import { foldPatch } from '../../src/engine/core.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import { refNames, RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { grammarlessEditCheck, noSymbols, openGate, passT0Regions } from '../../src/holds/ports.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { seededRandom } from '../../src/ports/random.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { faultFsOf, realEngine, realEngineOf } from '../sim/engineAdapter.js';
import { FaultFs } from '../sim/faultfs.js';
import { holdsSetup, scriptedGenerator, type ScriptStep } from '../sim/generators.js';
import {
  DEFAULT_QUIESCENCE, holdTimersSettled, runSim, type EngineFactory, type OpGenerator, type Oracle, type SimContext, type SimOptions, type SimResult,
} from '../sim/harness.js';
import { boardHolds, readRegistry, readStatus, simScope, treeEntries } from '../sim/holdsView.js';
import { MarkerModel } from '../sim/markers.js';
import { exitOracles } from '../sim/oracles.js';
import { createTeamWriter, teamPush } from '../sim/teamWriter.js';

const REFS = refNames('main', RELEASE_NAMESPACE);

/** A scripted SIM run on a loaded CI machine can outlast node:test's 10-minute default (R3-55: such a test sets its own timeout). */
const SIM_TIMEOUT = 30 * 60_000;

function okOrFail(r: SimResult): void {
  assert.ok(r.ok, `run failed: ${JSON.stringify(r.failure)}; artifacts kept in ${String(r.artifactsDir)}; op-log tail ${JSON.stringify(r.opLog.slice(-8))}`);
}

/** A script step that runs test code (an assertion probe or a custom op) and logs `probe <label>`. */
interface Probe { probe: string; run(ctx: SimContext): Promise<string | void>; }
type Step = ScriptStep | Probe;

/** Plays `steps` (one per harness step) through scriptedGenerator, with the probes inline. */
function play(steps: readonly Step[], markers: MarkerModel): OpGenerator {
  const inner = scriptedGenerator(steps.map((s): ScriptStep => ('probe' in s ? { advance: 0 } : s)), markers);
  return {
    next(ctx, step) {
      const s = steps[step];
      if (s !== undefined && 'probe' in s) return { peer: '*', kind: 'probe', run: async (c) => `${s.probe} ${(await s.run(c)) ?? ''}`.trim() };
      return inner.next(ctx, step);
    },
  };
}

/** `n` iterations of peer i alone, each 2.5 s of virtual time after the previous one. */
const alone = (i: number, n: number): Step[] => Array.from({ length: n }, () => [{ advance: 2_500 }, { iterate: i }] as Step[]).flat();

/** A scripted holds run: holdsSetup's composition with `steps`, optional quiescence and extra oracles. */
async function scriptRun(seed: string, steps: readonly Step[], o: { quiescence?: boolean; oracles?: Oracle[]; settled?: SimOptions['settled']; factory?: EngineFactory; peerProfile?: SimOptions['peerProfile']; peers?: number } = {}): Promise<{ r: SimResult; markers: MarkerModel }> {
  const s = holdsSetup(seed, { script: [], ...(o.peers === undefined ? {} : { peers: o.peers }) });
  const options: SimOptions = { ...s.options, generator: play(steps, s.markers) };
  if (o.quiescence !== true) delete options.quiescence;
  if (o.settled !== undefined) options.settled = o.settled;
  if (o.peerProfile !== undefined) options.peerProfile = o.peerProfile;
  const r = await runSim({ ...s.tuple, ops: steps.length }, o.factory ?? s.factory, o.oracles ?? [], options);
  return { r, markers: s.markers };
}

const engineAt = (ctx: SimContext, i: number) => {
  const e = realEngineOf(ctx.engines[i]!);
  assert.ok(e !== null, `p${i} has a running engine`);
  return e;
};

test('realEngine binds grammarlessEditCheck, passT0Regions, openGate and noSymbols, takes EngineDeps.platform from RealEngineOptions.platform, else PeerOptions.platform, else process.platform, and realEngineOf/faultFsOf return that peer\'s Engine and FaultFs (null Engine before its first step)', { timeout: SIM_TIMEOUT }, async () => {
  const bindings = async (seed: string, factory: EngineFactory, peerProfile: SimOptions['peerProfile']): Promise<string[]> => {
    const platforms: string[] = [];
    const fsBefore: FaultFs[] = [];
    const steps: Step[] = [
      {
        probe: 'before', run: async (ctx) => {
          for (const e of ctx.engines) {
            assert.equal(realEngineOf(e), null, `${e.peer.name}: no Engine before its first step`);
            const fs = faultFsOf(e);
            assert.ok(fs instanceof FaultFs);
            fsBefore.push(fs);
          }
        },
      },
      { rounds: 1 },
      {
        probe: 'after', run: async (ctx) => {
          for (const [i, e] of ctx.engines.entries()) {
            const engine = engineAt(ctx, i);
            const deps = engine.core.deps;
            assert.equal(deps.editCheck, grammarlessEditCheck, 'R3-03');
            assert.equal(deps.t0Regions, passT0Regions, 'R3-04');
            assert.equal(deps.gate, openGate, 'R3-07');
            assert.equal(deps.symbols, noSymbols, 'R3-07');
            assert.equal(faultFsOf(e), fsBefore[i], 'one FaultFs per peer');
            assert.equal(deps.ports.fs, faultFsOf(e), 'the engine reads and writes through that FaultFs');
            platforms.push(deps.platform);
          }
        },
      },
    ];
    const { r } = await scriptRun(seed, steps, { factory, peerProfile });
    okOrFail(r);
    return platforms;
  };
  // The option wins over PeerOptions.platform (p2 says win32) and over the host.
  const opt = await bindings('holds-bind-opt', realEngine({ platform: (i) => (['aix', 'freebsd', 'sunos'] as const)[i] as NodeJS.Platform }),
    (i) => ({ autocrlf: false, withFilter: false, ...(i === 2 ? { platform: 'win32' as const } : {}) }));
  assert.deepEqual(opt, ['aix', 'freebsd', 'sunos']);
  // Without it: PeerOptions.platform, else the host.
  const peer = await bindings('holds-bind-peer', realEngine(),
    (i) => ({ autocrlf: false, withFilter: false, ...(i === 1 ? { platform: 'freebsd' as const } : i === 2 ? { platform: 'win32' as const } : {}) }));
  assert.deepEqual(peer, [process.platform, 'freebsd', 'win32']);
});

test('readRegistry equals inspect().holds field for field on a peer holding a revert PATCH and a K4 record; boardHolds of the landed Bnew equals the fold\'s entries and readHeld; simScope classifies .gitignore SAVE_ONLY, .github/workflows/ci.yml QUARANTINED, a sync.exclude path UNMANAGED, a local_only ON_DISK record path LOCAL_ONLY, shared.txt LIVE, and throws on an EPOCH_BASE with .gitattributes', { timeout: SIM_TIMEOUT }, async () => {
  let checked = false;
  const steps: Step[] = [
    { rounds: 1 },                                                            // p0 genesis, p1 and p2 join
    { kind: 'edit_band', peer: 1, params: { insert: false } },               // p1's own band row, with its marker
    { rounds: 14 },                                                           // p1 publishes after its quiet window; p0 applies
    { kind: 'edit_peer_line', peer: 0, params: { path: 'shared.txt' } },     // p0 modifies p1's line: a revert PATCH (HLD-27)
    { kind: 'edit_same_line', peer: 1, params: { other: 0, row: 4 } },       // p1 and p0 rewrite notes.txt row 4
    ...alone(1, 14),                                                          // p1 alone publishes its row 4 first
    ...alone(0, 14),                                                          // p0: the revert record, and K4 over its row 4
    {
      probe: 'registry', run: async (ctx) => {
        const engine = engineAt(ctx, 0);
        const ins = await engine.inspect();
        const snap = await readRegistry(ctx.git, ctx.peers[0]!.dir, 'main');
        assert.equal(snap.head, ins.registryHead);
        const byId = new Map(ins.holds.map((r) => [r.id, r]));
        assert.deepEqual([...snap.records.keys()].sort(), [...byId.keys()].sort());
        for (const [id, r] of snap.records) assert.deepEqual(r, byId.get(id), `record ${id} field for field`);
        const has = (r: HoldRecord, g: string): boolean => r.guards.some((x) => x.name === g);
        const revert = ins.holds.find((r) => r.kind === 'PATCH' && has(r, 'revert') && r.paths.includes('shared.txt'));
        const k4 = ins.holds.find((r) => has(r, 'conflict') && r.paths.includes('notes.txt'));
        assert.ok(revert !== undefined, `a revert PATCH over shared.txt: ${JSON.stringify(ins.holds.map((r) => [r.kind, r.guards, r.paths]))}`);
        assert.ok(k4 !== undefined, `a K4 record over notes.txt: ${JSON.stringify(ins.holds.map((r) => [r.kind, r.guards, r.paths]))}`);
        assert.ok(snap.local !== null || snap.head !== null);
        // The landed board that carried both records' newest ops (a 'mirror' event of p0), folded test-side.
        const mirrors = ctx.trace.ofKind('mirror').filter((e) => e.peer === engine.peerId);
        const carried = (id: string): string | undefined => [...mirrors].reverse().find((e) => e.holds.some((x) => x.id === id && x.rev === byId.get(id)!.rev))?.bnew;
        const bnew = carried(revert.id);
        assert.ok(bnew !== undefined, 'the revert record\'s current rev was mirrored in a landed Bnew');
        const view = await boardHolds(ctx.git, ctx.peers[0]!.dir, parseOid(bnew));
        // The engine's fold (its patch, else its view) against boardHolds of the landed board it folded to (p0's newest Bnew or a later
        // landing it fetched): the test-side fold equals the engine's entries, unconditionally.
        const fp = foldPatch(engine.core);
        const fold = fp?.fold ?? engine.core.view!.fold;
        const foldBoard = fp?.meta.fold_board ?? engine.core.view!.meta.fold_board;
        assert.ok(fold !== null && foldBoard !== null, 'p0 has a fold');
        const atFold = foldBoard === bnew ? view : await boardHolds(ctx.git, ctx.peers[0]!.dir, parseOid(foldBoard));
        assert.deepEqual(atFold.holds, fold.holds, 'boardHolds of the folded board equals the fold\'s entries');
        assert.ok(Object.keys(fold.holds).includes(revert.id) && Object.keys(fold.holds).includes(k4.id), 'both records are in the fold');
        assert.deepEqual(view.holds[revert.id]?.guards.map((g) => g.name), revert.guards.map((g) => g.name));
        assert.equal(view.holds[revert.id]?.residence, 'ON_DISK');
        for (const id of Object.keys(view.holds)) assert.deepEqual(view.held.get(id) ?? null, await readHeld(engine.core.repo, parseOid(bnew), id), `held/${id}/ = readHeld`);
        assert.equal((view.held.get(revert.id) ?? []).length, 2, 'h0 and h1 of shared.txt');
        checked = true;
        return `${revert.id} ${k4.id} ${bnew}`;
      },
    },
  ];
  const { r } = await scriptRun('holds-views-registry', steps);
  okOrFail(r);
  assert.ok(checked);

  // simScope over a plain repository (no engine): the D5 rows the SIM reaches.
  const { root, cleanup } = await makeTempRoot('holds-simscope');
  try {
    const git = testRunner();
    const run = async (args: string[], cwd = root): Promise<string> => {
      const x = await git.run(args, { class: 'local', cwd, identity: { name: 't', email: 't@cowork.invalid' }, wallMsForDates: 1_700_000_000_000 });
      assert.equal(x.code, 0, `git ${args.join(' ')}: ${x.stderr.toString('utf8')}`);
      return x.stdout.toString('utf8').trim();
    };
    const files: Record<string, string> = {
      '.gitignore': '*.log\n', '.github/workflows/ci.yml': 'on: push\n', 'gen/out.txt': 'g\n', 'shared.txt': 's\n', 'secret/x.txt': 'x\n',
      '.cowork/config.json': '{"v":1,"sync":{"exclude":["gen/**"]}}\n',
    };
    for (const [p, text] of Object.entries(files)) {
      await mkdir(join(root, ...p.split('/').slice(0, -1)), { recursive: true });
      await writeFile(join(root, ...p.split('/')), text);
    }
    await run(['init', '-q', '-b', 'main', root]);
    await run(['add', '-A']);
    await run(['commit', '-q', '-m', 'base']);
    const base = parseOid(await run(['rev-parse', 'HEAD']));
    const localOnly = { id: '01J00000000000000000000000', state: 'ACTIVE', residence: 'ON_DISK', local_only: true, paths: ['secret/x.txt'] } as unknown as HoldRecord;
    const scope = await simScope(git, root, base, [localOnly]);
    assert.equal(scope('.gitignore', '100644', 6), 'SAVE_ONLY');
    assert.equal(scope('.github/workflows/ci.yml', '100644', 9), 'QUARANTINED');
    assert.equal(scope('gen/out.txt', '100644', 2), 'UNMANAGED');
    assert.equal(scope('secret/x.txt', '100644', 2), 'LOCAL_ONLY');
    assert.equal(scope('shared.txt', '100644', 2), 'LIVE');
    assert.equal(scope('a:b.txt', '100644', 2), 'UNMANAGED');
    assert.equal(scope('big.bin', '100644', 52_428_800), 'SAVE_ONLY');
    assert.equal(scope('sub', '160000', 0), 'UNMANAGED');
    // the same path under a terminal or OFF_DISK record is LIVE (R3-21)
    assert.equal((await simScope(git, root, base, [{ ...localOnly, residence: 'OFF_DISK' } as HoldRecord]))('secret/x.txt', '100644', 2), 'LIVE');
    await writeFile(join(root, '.gitattributes'), '*.txt text\n');
    await run(['add', '-A']);
    await run(['commit', '-q', '-m', 'attrs']);
    const withAttrs = parseOid(await run(['rev-parse', 'HEAD']));
    await assert.rejects(simScope(git, root, withAttrs, []), /unsupported scope input/);
  } finally {
    await cleanup();
  }
});

test('teamPush lands one live commit whose blob for crlf-stored.txt keeps \'a\\r\\nb\\r\\n\' verbatim, carries Cowork-CS and Cowork-CS-Paths and a leased board commit that every engine folds without an own rejection; every existing CoreFixture.pushTeamChange caller (the apply, apply.bomcrlf, publish and publish.rejections integration tests) passes unchanged through teamPush', { timeout: SIM_TIMEOUT }, async () => {
  let pushed: { board: Oid; live: Oid; tip: string } | null = null;
  const steps: Step[] = [
    { rounds: 1 },
    {
      probe: 'teamPush', run: async (ctx) => {
        const w = await createTeamWriter(ctx, seededRandom(`${ctx.seed}/team`));
        assert.equal(w.seq, 0);
        const tip = (await ctx.remote.refs())[REFS.remoteBoard]!;
        const out = await teamPush(ctx.git, ctx.remote.url, REFS, w, { 'crlf-stored.txt': Buffer.from('a\r\nb\r\n', 'utf8'), 'team/new.txt': Buffer.from('n\n', 'utf8') }, { wallMs: ctx.clocks.get('p0')!.wallMs() });
        assert.equal(w.seq, 1);
        pushed = { ...out, tip };
        return out.live;
      },
    },
    { rounds: 6 },
    {
      probe: 'folded', run: async (ctx) => {
        const p = pushed!;
        const git = ctx.git;
        const show = async (args: string[]): Promise<string> => (await git.run(args, { class: 'local', cwd: ctx.remote.dir })).stdout.toString('utf8');
        // verbatim: the stored blob keeps its CRLF (route (c), no canon)
        const blob = await show(['cat-file', 'blob', `${p.live}:crlf-stored.txt`]);
        assert.equal(blob, 'a\r\nb\r\n');
        const trailers = await show(['log', '-1', '--format=%(trailers:only)', p.live]);
        assert.match(trailers, /^Cowork-CS: /m);
        assert.match(trailers, /^Cowork-CS-Paths: /m);
        // the board commit's first parent is the tip it leased, and the remote's board is it (a fast-forward under the lease)
        assert.equal((await show(['rev-parse', `${p.board}^1`])).trim(), p.tip);
        assert.equal((await ctx.remote.readRemoteLog()).some((e) => e.ref === REFS.remoteBoard && e.old === p.tip && e.new === p.board), true, 'the lease: old = the tip it fetched');
        // every engine folded it: its laB reached the team's board, no incident, and its A holds the verbatim blob
        assert.deepEqual(ctx.trace.ofKind('incident'), []);
        for (const [i] of ctx.engines.entries()) {
          const ins = await engineAt(ctx, i).inspect();
          const chain = (await git.run(['rev-list', '--first-parent', ins.laB], { class: 'local', cwd: ctx.peers[i]!.dir })).stdout.toString('utf8');
          assert.ok(chain.includes(p.board), `p${i} folded the team's board`);
          const a = await treeEntries(git, ctx.peers[i]!.dir, ins.aTree);
          const remoteBlob = (await show(['rev-parse', `${p.live}:crlf-stored.txt`])).trim();
          assert.equal(a.get('crlf-stored.txt')?.oid, remoteBlob, `p${i} applied the verbatim blob`);
          assert.equal((await readStatus(ctx.peers[i]!.dir))?.state === 'incident', false);
        }
      },
    },
  ];
  const { r } = await scriptRun('holds-team-push', steps);
  okOrFail(r);
  assert.ok(pushed !== null);
});

test('TraceRecorder.monoAt gives each event the emitting peer\'s virtual mono time, the events carry none, and afterEveryOp oracles run after every quiescence and extra round', { timeout: SIM_TIMEOUT }, async () => {
  const probes: Array<number | null> = [];
  let patched = false;
  let ctxSeen: SimContext | null = null;
  let calls = 0;
  const counting: Oracle = { name: 'COUNT', async afterEveryOp() { calls++; return null; } };
  const steps: Step[] = [
    {
      probe: 'patch', run: async (ctx) => {
        // The probe: the emitting peer's clock read when each event is emitted (through the per-peer wrapper's emitAt).
        const rec = ctx.trace;
        const inner = rec.emitAt.bind(rec);
        rec.emitAt = (ev, mono) => {
          const name = rec.names.get(ev.peer);
          probes.push(name === undefined ? null : ctx.clocks.get(name)!.monoMs());
          inner(ev, mono);
        };
        patched = true;
        ctxSeen = ctx;
      },
    },
    { rounds: 1 },
    { kind: 'edit_band', peer: 0, params: { insert: false } },
    { kind: 'new_file', peer: 1 },
    { kind: 'append_md', peer: 2 },
    { rounds: 3 },
  ];
  const { r } = await scriptRun('holds-monoat', steps, { quiescence: true, oracles: [counting] });
  okOrFail(r);
  assert.ok(patched);
  const ctx = ctxSeen as unknown as SimContext;
  const events = ctx.trace.events;
  assert.equal(probes.length, events.length);
  let named = 0;
  for (let i = 0; i < events.length; i++) {
    const want = probes[i];
    if (want === null) continue;
    named++;
    assert.equal(ctx.trace.monoAt(i), want, `event ${i} (${events[i]!.kind}): monoAt = the emitting peer's mono`);
  }
  assert.ok(named > 50, `${named} events checked`);
  // TST-03: no event carries a time
  const timeKey = /(time|wall|mono|duration|ms$|Ms$|^at$)/i;
  for (const e of events) for (const k of Object.keys(e)) assert.ok(!timeKey.test(k), `${e.kind}.${k} looks like a time field`);
  // afterEveryOp: once per op step, once per quiescence round and once per extra round
  const q = r.quiescence!;
  assert.ok(q.reached);
  assert.equal(calls, steps.length + q.rounds + DEFAULT_QUIESCENCE.extraLoops);
});

test('holdTimersSettled holds T* back while a hold timer is due within 40 rounds', { timeout: SIM_TIMEOUT }, async () => {
  // Option A (Task 13 fix round 1 ruling): a revert record whose HOLD_REVERT_HELD event (+10 min) is not in the fold holds T* back only
  // when the event could come due within the extra rounds (its age + the 40 extra rounds, plus one round of slack for the ±100 ppm wall
  // drift, reaches 10 min) or is drafted and not landed; a fresh record no longer makes T* wait for its 10 minutes.
  const LOOKAHEAD = (DEFAULT_QUIESCENCE.extraLoops + 1) * DEFAULT_QUIESCENCE.loopMs;
  const REVERT_EVENT_MS = 600_000;
  const prefix: Step[] = [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { insert: false } },
    { rounds: 14 },
    { kind: 'edit_peer_line', peer: 0, params: { path: 'shared.txt' } },   // a revert PATCH at p0's next iteration (HLD-27)
  ];
  /** p0's revert record: its age and whether p0's fold holds its HOLD_REVERT_HELD event. */
  const revertOf = async (ctx: SimContext): Promise<{ id: string; age: number; posted: boolean } | null> => {
    const engine = engineAt(ctx, 0);
    const ins = await engine.inspect();
    const rec = ins.holds.find((x) => x.guards.some((g) => g.name === 'revert'));
    if (rec === undefined) return null;
    const fold = foldPatch(engine.core)?.fold ?? engine.core.view?.fold ?? null;
    const posted = fold !== null && Object.values(fold.events).some((e) => e.kind === 'health' && e.reason_code === 'HOLD_REVERT_HELD' && e.refs.includes(rec.id));
    return { id: rec.id, age: ins.holdAgeMs[rec.id] ?? -1, posted };
  };
  /** holdTimersSettled (the harness default and holdsSetup's), recording each answer with p0's revert record at that ask. */
  const asking = (): { settled: NonNullable<SimOptions['settled']>; asks: Array<{ answer: boolean; rec: { id: string; age: number; posted: boolean } | null }> } => {
    const asks: Array<{ answer: boolean; rec: { id: string; age: number; posted: boolean } | null }> = [];
    return { asks, settled: async (ctx) => { const answer = await holdTimersSettled(ctx); asks.push({ answer, rec: await revertOf(ctx) }); return answer; } };
  };
  /** At quiescence: p0's revert record and whether T*'s fold (folded test-side) holds its event. */
  const atT = (): Oracle & { seen: { id: string; posted: boolean; age: number } | null } => {
    const o: Oracle & { seen: { id: string; posted: boolean; age: number } | null } = {
      name: 'REVERT_AT_TSTAR', seen: null,
      async atQuiescence(ctx) {
        const ins = await engineAt(ctx, 0).inspect();
        const rec = ins.holds.find((x) => x.guards.some((g) => g.name === 'revert'));
        if (rec === undefined) return `no revert record on p0: ${JSON.stringify(ins.holds.map((x) => x.guards))}`;
        const tStar = parseOid(ctx.quiescence!.tStar!);
        const fold = await new Folder(engineAt(ctx, 0).core.repo, '0'.repeat(32)).foldTo(tStar, null, PLAN2_REGION_SPEC);
        const posted = Object.values(fold.state.events).some((e) => e.kind === 'health' && e.reason_code === 'HOLD_REVERT_HELD' && e.refs.includes(rec.id));
        o.seen = { id: rec.id, posted, age: ins.holdAgeMs[rec.id] ?? -1 };
        return null;
      },
    };
    return o;
  };
  assert.equal(holdsSetup('holds-settled', { script: [] }).options.settled, holdTimersSettled);

  // A fresh record (created in the first quiescence round): its event is not due within the extra rounds, so T* is declared at the first
  // round the K rule holds, before the event, and the 40 extra rounds still make no push (INV-CONVERGE, R-32).
  const fresh = asking();
  const early = atT();
  const a = await scriptRun('holds-settled', prefix, { quiescence: true, oracles: [early, ...exitOracles()], settled: fresh.settled, peers: 2 });
  okOrFail(a.r);
  assert.equal(fresh.asks.length, 1, `T* at the first round the K rule held (${fresh.asks.length} asks; first and last: ${JSON.stringify([fresh.asks[0], fresh.asks[fresh.asks.length - 1]])})`);
  const f0 = fresh.asks[0]!;
  assert.ok(f0.answer && f0.rec !== null && !f0.rec.posted && f0.rec.age + LOOKAHEAD < REVERT_EVENT_MS, `the fresh record did not hold T* back: ${JSON.stringify(f0)}`);
  assert.ok(early.seen !== null && !early.seen.posted && early.seen.id === f0.rec.id, `T* precedes the event: ${JSON.stringify(early.seen)}`);
  assert.equal(a.r.quiescence!.pushAttemptsInExtra, 0, 'zero pushes in the 40 extra rounds');
  assert.equal(a.r.quiescence!.boardChangedInExtra, false);

  // A near-due record (aged 440 s by a virtual jump before quiescence): the K rule holds while its event is due within the extra rounds,
  // so holdTimersSettled answers false until the event has folded; T* follows it and the 40 extra rounds make no push.
  const near = asking();
  const late = atT();
  const nearScript: Step[] = [
    ...prefix,
    { rounds: 14 },
    {
      probe: 'revert-before-jump', run: async (ctx) => {
        const rec = await revertOf(ctx);
        assert.ok(rec !== null && !rec.posted && rec.age < 60_000, `p0 holds a fresh revert record before the jump: ${JSON.stringify(rec)}`);
        return `${rec.id} age=${rec.age}`;
      },
    },
    { advance: 440_000 },
  ];
  const b = await scriptRun('holds-settled', nearScript, { quiescence: true, oracles: [late, ...exitOracles()], settled: near.settled, peers: 2 });
  okOrFail(b.r);
  const n0 = near.asks[0];
  assert.ok(n0 !== undefined && !n0.answer && n0.rec !== null && !n0.rec.posted && n0.rec.age < REVERT_EVENT_MS && n0.rec.age + LOOKAHEAD >= REVERT_EVENT_MS,
    `the K rule held before the event while it was due within the extra rounds, and T* waited: ${JSON.stringify(near.asks.slice(0, 3))}`);
  const yes = near.asks.findIndex((x) => x.answer);
  assert.ok(yes > 0 && near.asks[yes]!.rec?.posted === true, `settled answered true only once the event folded: ${JSON.stringify(near.asks.slice(Math.max(0, yes - 1), yes + 1))}`);
  assert.ok(late.seen !== null && late.seen.posted && late.seen.age >= REVERT_EVENT_MS, `T* follows the folded event: ${JSON.stringify(late.seen)}`);
  assert.equal(b.r.quiescence!.pushAttemptsInExtra, 0, 'zero pushes in the 40 extra rounds');
  assert.equal(b.r.quiescence!.boardChangedInExtra, false);
});
