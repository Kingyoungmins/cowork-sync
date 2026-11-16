// The claim host, the engine's consumer map and the verdict seams of Plan 4 Task 5 (R4-36, R4-62, R4-77, R1-058, R2-M07; audit
// finding #12): RegionHost re-attaches per createEngineCore and refuses use before attach; it follows the core restartCore built;
// claimHostOf exposes the core's region state and the test-build mutant flags; Plan 3's per-peer CoreOptions.ports function sees
// each peer's deps.regions; the 04 §3.1 consumer map is declared on the Engine over Task 5's stubs; and the region verdict calls
// leave the registry, the outbox, the state ref and the object store unchanged (assertNoWrites, with its own failing check). Real
// git on file:// remotes (makeCores, makeEngines); git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import type { PeerId } from '../../src/board/ids.js';
import { RegionHost, type ClaimHostView } from '../../src/claims/host.js';
import type { PlacementInput } from '../../src/claims/placement.js';
import type { SeatKey } from '../../src/claims/types.js';
import { claimHostOf } from '../../src/engine/claimHost.js';
import { createEngineCore, prepareIteration, type EngineCore, type IterationCtx } from '../../src/engine/core.js';
import type { EngineDeps, MutantId } from '../../src/engine/deps.js';
import { emitStep } from '../../src/engine/emitStep.js';
import { claimsHeld, labelStep } from '../../src/engine/labelStep.js';
import type { Engine } from '../../src/engine/loop.js';
import { breachStep, placementStep } from '../../src/engine/mergeChecks.js';
import type { Oid } from '../../src/git/oid.js';
import { openGate, type PublishGatePort } from '../../src/holds/ports.js';
import { makeCores, type PeerFixture } from '../helpers/coreFixture.js';
import { makeEngines, withEngines } from '../helpers/engineFixture.js';
import { assertNoWrites } from '../helpers/regionAsserts.js';
import { restartCore, startOk, withStart } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

let iter = 0;
/** prepareIteration with a fresh fetch and no materialization; the iteration must be prepared. */
async function prep(core: EngineCore): Promise<IterationCtx> {
  const r = await prepareIteration(core, ++iter, { materialize: false, forceFetch: true });
  assert.ok(r.ok, `prepareIteration failed: ${JSON.stringify(r)}`);
  return r.it;
}

/** The parts of a host view that name its core (a view is a fresh object per claimHostOf call, so compare members). */
function sameCore(v: ClaimHostView, core: EngineCore): boolean {
  return v.store === core.claims && v.regions === core.regions && v.repo === core.repo && v.self === core.peerId;
}

test('RegionHost re-attaches per core and refuses use before attach', T10, async () => {
  const fresh = new RegionHost();
  assert.equal(fresh.attached, false);
  assert.throws(() => fresh.get(), /not attached/u);
  const fx = await makeCores('host-attach', { n: 2 });
  try {
    const [p0, p1] = fx.peers as [PeerFixture, PeerFixture];
    const host = p0.deps.regions.host;
    assert.equal(host.attached, true, 'createEngineCore(deps) attached the host');
    assert.equal(sameCore(host.get(), p0.core), true, 'get() returns claimHostOf(core)');
    // A second core over the same deps re-attaches: the host serves the new core, the first core's view is gone from it.
    const first = p0.core;
    const core2 = await createEngineCore(p0.deps);
    assert.equal(host.get().store, core2.claims, 'get().store === core2.claims');
    assert.equal(sameCore(host.get(), core2), true);
    assert.notEqual(host.get().store, first.claims, 'the first core\u2019s view is no longer reachable through the host');
    // Two cores built from two RegionDeps each attach their own host.
    assert.notEqual(p1.deps.regions.host, host, 'each peer\u2019s deps carry their own host');
    assert.equal(sameCore(p1.deps.regions.host.get(), p1.core), true);
  } finally {
    await fx.cleanup();
  }
});

test('the host follows the core restartCore built', T10, async () => {
  await withStart('host-restart', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    await startOk(p, 'genesis');
    const h = p.deps.regions.host;   // captured before any restart
    const old = p.core;
    await prep(old);
    const oldFold = old.leasedFold;
    assert.ok(oldFold !== null, 'the old core folded');
    await restartCore(p);   // Plan 2's process restart: a second createEngineCore(p.deps)
    assert.notEqual(p.core, old);
    assert.equal(h.get().store, p.core.claims, 'the host serves the new core');
    assert.equal(h.get().fold(), null, 'the new core has not folded yet: never the old core\u2019s fold');
    // The new core's first prepareIteration (its state was read from disk by createEngineCore; no restart start is needed
    // for a fold, and skipping it keeps this test inside its 10-minute cap on a loaded PC).
    const it = await prep(p.core);
    const lf = p.core.leasedFold;
    assert.ok(lf !== null);
    const f = h.get().fold();
    assert.ok(f !== null);
    assert.equal(f.state, lf.state, 'fold() is the new core\u2019s leasedFold');
    assert.equal(f.tip, lf.tip);
    assert.notEqual(f.state, oldFold.state, 'never the old core\u2019s fold');
    assert.equal(f.state, it.fold);
  });
});

test('claimHostOf exposes the core\u2019s region state', T10, async () => {
  const fx = await makeCores('host-view', { n: 1 });
  try {
    await fx.bootstrap();
    const p = fx.peers[0]!;
    const core = p.core;
    const host = claimHostOf(core);
    assert.equal(host.repo, core.repo);
    assert.equal(host.regions, core.regions);
    assert.equal(host.store, core.claims);
    assert.equal(host.self, core.peerId);
    assert.equal(host.regionSpec, p.deps.regionSpec, 'EngineDeps.regionSpec (PLAN2_REGION_SPEC until Task 16, R4-55)');
    assert.equal(host.fold(), null, 'null before the first prepareIteration');
    assert.equal(core.leasedFold, null);
    const it = await prep(core);
    // core.leasedFold is set after every fold of prepareIteration: the fold at the leased tip T (01-engine's pipeline tip).
    assert.deepEqual(core.leasedFold, { tip: it.T, state: it.fold });
    assert.deepEqual(host.fold(), { tip: it.T, state: it.fold, order: new Map() }, 'order is empty until Task 8 (Folder.claimOrder)');
    assert.equal(host.fold()!.state, it.fold);
    assert.equal(host.view(), null, 'null until Task 13 binds claimView');
    // raise(code, params) reaches raiseRegionCode: core.holdCode and one daemon-log line.
    host.raise('REGION_SPEC_MISMATCH', { path: 'a.py', claim_id: 'abcdefghij234567', peer: 'Peer p1' });
    assert.deepEqual(core.holdCode, { code: 'REGION_SPEC_MISMATCH', params: { path: 'a.py', claim_id: 'abcdefghij234567', peer: 'Peer p1' } });
  } finally {
    await fx.cleanup();
  }
});

test('MutantId gains M21, M22 and M46_1\u2026M46_4, reaching src/claims as flags', T10, async () => {
  // Type level: the six Plan 4 ids beside Plan 2's and Plan 3's (tsc checks this file).
  const ids: readonly MutantId[] = ['M05', 'M06', 'M07', 'M12', 'M17', 'M18', 'M19', 'M20', 'M25', 'M28', 'M33', 'M38', 'M39', 'M21', 'M22', 'M46_1', 'M46_2', 'M46_3', 'M46_4'];
  assert.equal(new Set(ids).size, 19);
  const fx = await makeCores('host-flags', { n: 1 });
  try {
    const p = fx.peers[0]!;
    const flagsWith = async (mutants: ReadonlySet<MutantId>): Promise<ClaimHostView['flags']> => {
      const deps: EngineDeps = { ...p.deps, testMutants: mutants };
      const core = await createEngineCore(deps);
      const viaHost = deps.regions.host.get().flags;
      assert.deepEqual(viaHost, claimHostOf(core).flags, 'the host the ports bind to carries the same flags');
      return viaHost;
    };
    assert.deepEqual(claimHostOf(p.core).flags, { perPcForeignness: false, matchByLabel: false, skipChecks: new Set() }, 'no mutants: every flag off');
    assert.deepEqual(await flagsWith(new Set(['M21'])), { perPcForeignness: true, matchByLabel: false, skipChecks: new Set() });
    assert.deepEqual(await flagsWith(new Set(['M22'])), { perPcForeignness: false, matchByLabel: true, skipChecks: new Set() });
    assert.deepEqual(await flagsWith(new Set(['M46_2', 'M46_4'])), { perPcForeignness: false, matchByLabel: false, skipChecks: new Set([2, 4]) });
    assert.deepEqual(await flagsWith(new Set(['M46_1', 'M46_3', 'M05'])), { perPcForeignness: false, matchByLabel: false, skipChecks: new Set([1, 3]) }, 'a Plan 2 mutant sets no claim flag');
  } finally {
    await fx.cleanup();
  }
});

/** A recording PublishGatePort over one peer's host: each gate call records the host's self (the peer it serves). */
function recordingGate(host: RegionHost, seen: PeerId[]): PublishGatePort {
  return {
    gate: async (...a) => {
      seen.push(host.get().self);
      return openGate.gate(...a);
    },
    claimStillBlocks: (r) => openGate.claimStillBlocks(r),
  };
}

test('Plan 3\u2019s per-peer CoreOptions.ports function sees each peer\u2019s deps.regions', T10, async () => {
  for (const build of ['cores', 'engines'] as const) {
    const calls: Array<{ i: number; deps: EngineDeps; host: RegionHost | undefined; gate: PublishGatePort }> = [];
    const ports = (deps: EngineDeps, i: number): { gate: PublishGatePort } => {
      const host = (deps as Partial<EngineDeps>).regions?.host;   // must already be set when the function runs (R4-77)
      const gate = recordingGate(host ?? new RegionHost(), []);
      calls.push({ i, deps, host, gate });
      return { gate };
    };
    const fx = build === 'cores' ? await makeCores('ports-fn-cores', { n: 2, ports }) : await makeEngines('ports-fn-engines', { n: 2, ports });
    try {
      assert.deepEqual(calls.map((c) => c.i), [0, 1], `${build}: called once per peer with its index`);
      for (const [i, p] of fx.peers.entries()) {
        const c = calls[i]!;
        assert.equal(c.deps, p.deps, `${build}: peer ${i}'s own deps`);
        assert.ok(c.host !== undefined, `${build}: deps.regions was set before the function ran (R4-77)`);
        assert.equal(c.host, p.deps.regions.host, `${build}: deps.regions.host is that peer's host`);
        assert.equal(p.deps.gate, c.gate, `${build}: peer ${i}'s deps.gate is the binding built for its own host`);
      }
      assert.notEqual(calls[0]!.host, calls[1]!.host);
    } finally {
      await fx.cleanup();
    }
  }
});

test('Plan 3\u2019s static CoreOptions.ports object still binds every peer (makeCores and makeEngines)', T10, async () => {
  // The brief's per-peer test, second half (split off so each half keeps its own 10-minute cap on a loaded PC).
  const fixed = recordingGate(new RegionHost(), []);
  for (const build of ['cores', 'engines'] as const) {
    const fx = build === 'cores' ? await makeCores('ports-static-cores', { n: 2, ports: { gate: fixed } }) : await makeEngines('ports-static-engines', { n: 2, ports: { gate: fixed } });
    try {
      for (const p of fx.peers) assert.equal(p.deps.gate, fixed, `${build}: the static form binds every peer`);
    } finally {
      await fx.cleanup();
    }
  }
});

test('the 04 \u00a73.1 consumer map is declared on the engine', T10, async () => {
  // Type level: the six members of the consumer map on Engine (tsc checks this file).
  type ConsumerMap = Pick<Engine, 'seatEffect' | 'predict' | 'claimView' | 'claimViewOf' | 'verifiedLabel' | 'predictRevert'>;
  await withEngines('consumer-map', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    const e: ConsumerMap = p.engine;
    const seat: SeatKey = { peer: p.engine.peerId, seat: 'human' };
    const anchor = (await p.core.repo.resolve('HEAD')) as Oid;
    assert.equal(e.claimView(), null, 'claimView() is null before Task 13');
    assert.deepEqual(e.claimViewOf(seat), [], 'claimViewOf(k) is [] before Task 13');
    assert.equal(e.verifiedLabel('abcdefghij234567', anchor), null, 'verifiedLabel is null before Task 13');
    const turn = { origin: 'prompt' as const, firstConfirmedInTurn: new Set<string>() };
    await assert.rejects(e.seatEffect({ seat: 'human', agent: 'a', csId: 'p/1', path: 'a.py', pre: 'ABSENT', post: 'ABSENT', turn }), /not bound before Task 1[12]/u);
    await assert.rejects(e.predict({ seat: 'human', agent: 'a', tool: 'Edit', input: {}, path: 'a.py', disk: 'unstable', viewBlob: null, turn }), /not bound before Task 1[12]/u);
    await assert.rejects(e.predictRevert(new Map(), anchor), /not bound before Task 1[12]/u);
    const ins = await p.engine.inspect();
    assert.deepEqual(ins.claims, { view: null, drafts: [], blocked: [], order: new Map() });
    assert.equal(claimsHeld(p.core.leasedFold?.state ?? null, p.engine.peerId), 0, 'claimsHeld \u2192 0 before Task 13');
    assert.equal(claimsHeld(null, p.engine.peerId), 0);
  });
});

test('region verdict calls leave the registry, the outbox and the object store unchanged', T10, async () => {
  await withEngines('no-writes', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    const core = p.core;
    const it = await prep(core);
    // Inputs written before the checks: two Python blobs (hash-object -w writes them; the checks below write none).
    const a = await core.repo.hashBytes(Buffer.from('def f():\n    return 1\n'), true);
    const b = await core.repo.hashBytes(Buffer.from('def f():\n    return 2\n\ndef g():\n    return 3\n'), true);
    const epochBase = core.view!.meta.EPOCH_BASE;
    const seat: SeatKey = { peer: core.peerId, seat: 'human' };
    const inp = { base: null, ours: null, theirs: null, out: null, paths: [], fence: null } as unknown as PlacementInput;
    const calls: ReadonlyArray<readonly [string, () => unknown]> = [
      ['Engine.claimView', () => p.engine.claimView()],
      ['Engine.claimViewOf', () => p.engine.claimViewOf(seat)],
      ['Engine.verifiedLabel', () => p.engine.verifiedLabel('abcdefghij234567', it.tip)],
      ['emitStep', () => emitStep(core, it, { liveCode: it.tip, liveTree: it.tipMap, changedPaths: new Set(['a.py']) })],
      ['placementStep', () => placementStep(core, it, 'apply', inp)],
      ['breachStep', () => breachStep(core, it, it.tip)],
      ['labelStep', () => labelStep(core, null)],
      ['core.regions.table', () => core.regions.table(b, 'a.py', { epochBase })],
      ['hunks', () => core.regions.hunks(a, b)],
      ['mapRanges', () => core.regions.mapRanges(a, b, [[1, 2]], 'fold')],
    ];
    for (const [name, fn] of calls) await assertNoWrites(core, fn).catch((e: unknown) => assert.fail(`${name}: ${e instanceof Error ? e.message : String(e)}`));
    // The helper's own check: a planted registry write fails it.
    const h0 = await core.repo.hashBytes(Buffer.from('one\n'), true);
    const h1 = await core.repo.hashBytes(Buffer.from('two\n'), true);
    await assert.rejects(
      assertNoWrites(core, () => core.holds.hold({
        kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/a.txt'], blobs: { h0: { 'src/a.txt': h0 }, h1: { 'src/a.txt': h1 } },
        guard: 'revert', origin: 'human', cs_ids: [], displaced_by: null,
      })),
      AssertionError,
      'a planted core.holds.hold(...) fails assertNoWrites',
    );
  });
});
