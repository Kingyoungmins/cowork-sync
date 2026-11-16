// The Plan 3 ports (Task 10; rulings R3-03, R3-04, R3-07; rev 2.5 X-15): the Plan 3 bindings grammarlessEditCheck, passT0Regions,
// openGate and noSymbols through one plan3Ports(), the fixtures' PortsOverride (static or a (deps, peerIndex) function), every
// EngineDeps construction site binding plan3Ports(), and HLD-50 item 3's t0Shrink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineDeps } from '../../src/engine/deps.js';
import type { Oid } from '../../src/git/oid.js';
import type { GitRepo, TreeEntry } from '../../src/git/repo.js';
import {
  grammarlessEditCheck, noSymbols, openGate, passT0Regions, plan3Ports, t0Shrink, type EditCheckPort, type EditCheckVerdict, type PublishGatePort,
} from '../../src/holds/ports.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { makeCores } from '../helpers/coreFixture.js';
import { makeEngines } from '../helpers/engineFixture.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';

const T10 = { timeout: 10 * 60_000 };
const ROOT = join(import.meta.dirname, '..', '..');
const NO_REPO = {} as GitRepo;
const OID = '0'.repeat(40) as Oid;

test('passT0Regions always passes; openGate never blocks and its claimStillBlocks answers true; noSymbols answers false', T10, async () => {
  assert.deepEqual(await passT0Regions.check(NO_REPO, OID, OID, ['a.py', 'b.py']), { pass: true });
  assert.deepEqual(await passT0Regions.check(NO_REPO, OID, OID, []), { pass: true });
  assert.deepEqual(await openGate.gate(NO_REPO, OID, new Map(), new Map(), ['a.py'], ['x/human/1']), { block: null });
  // R3-07: the claim PREDICATE fails closed — a claim record never releases while Plan 3 binds the gate.
  assert.equal(await openGate.claimStillBlocks({ id: 'r' } as unknown as HoldRecord), true);
  assert.equal(await noSymbols.referencesHeldOnly(NO_REPO, { id: 'r' } as unknown as HoldRecord, new Map(), new Map()), false);
});

test('rev 2.5: CoreOptions.ports and makeEngines accept a static PortsOverride and a (deps, peerIndex) => PortsOverride function; the function is called once per peer with that peer\'s built deps', T10, async () => {
  const scripted: EditCheckPort = { check: async (): Promise<EditCheckVerdict> => ({ verdict: 'fail', failed: [1] }) };
  const gate: PublishGatePort = { gate: async () => ({ block: null }), claimStillBlocks: async () => false };

  // The function form on makeCores: called once per peer, with that peer's deps; a scripted port for peer 1 only.
  const calls: Array<{ deps: EngineDeps; i: number }> = [];
  const cores = await makeCores('ports-fn', {
    n: 2,
    ports: (deps, i) => {
      calls.push({ deps, i });
      return i === 1 ? { editCheck: scripted } : {};
    },
  });
  try {
    assert.deepEqual(calls.map((c) => c.i), [0, 1], 'once per peer, in peer order');
    for (const [i, p] of cores.peers.entries()) {
      assert.equal(calls[i]!.deps, p.deps, 'the peer\'s own built deps');
      assert.equal(p.core.deps, p.deps);
    }
    assert.equal(cores.peers[0]!.deps.editCheck, grammarlessEditCheck, 'peer 0 keeps the Plan 3 binding');
    assert.equal(cores.peers[1]!.deps.editCheck, scripted, 'peer 1 gets the scripted port');
    for (const p of cores.peers) {
      assert.equal(p.deps.t0Regions, passT0Regions);
      assert.equal(p.deps.gate, openGate);
      assert.equal(p.deps.symbols, noSymbols);
    }
  } finally {
    await cores.cleanup();
  }

  // The static form on makeCores: every peer gets it.
  const fixed = await makeCores('ports-static', { n: 2, ports: { gate } });
  try {
    for (const p of fixed.peers) {
      assert.equal(p.deps.gate, gate);
      assert.equal(p.deps.editCheck, grammarlessEditCheck);
    }
  } finally {
    await fixed.cleanup();
  }

  // makeEngines: both forms reach the Engine's deps, the function once per peer.
  const seen: number[] = [];
  const engines = await makeEngines('ports-engines', {
    n: 2,
    ports: (deps, i) => {
      seen.push(i);
      assert.ok(deps.paths.workTree.length > 0);
      return i === 1 ? { editCheck: scripted } : {};
    },
  });
  try {
    assert.deepEqual(seen, [0, 1]);
    assert.equal(engines.peers[0]!.engine.core.deps.editCheck, grammarlessEditCheck);
    assert.equal(engines.peers[1]!.engine.core.deps.editCheck, scripted);
  } finally {
    await engines.cleanup();
  }
  const staticEngines = await makeEngines('ports-engines-static', { n: 1, ports: { gate } });
  try {
    assert.equal(staticEngines.peers[0]!.engine.core.deps.gate, gate);
  } finally {
    await staticEngines.cleanup();
  }
});

test('plan3Ports() returns exactly the four Plan 3 bindings, and every EngineDeps construction site uses it', async () => {
  const p = plan3Ports();
  assert.deepEqual(Object.keys(p).sort(), ['editCheck', 'gate', 'symbols', 't0Regions']);
  assert.equal(p.editCheck, grammarlessEditCheck);
  assert.equal(p.t0Regions, passT0Regions);
  assert.equal(p.gate, openGate);
  assert.equal(p.symbols, noSymbols);
  // R3-03, R3-04, R3-07: one binder. Each site spreads plan3Ports() and none binds one of the four fields itself (a later
  // plan's binder replaces plan3Ports() at each site, X-111). `npm run ci` type-checks tools/real/two-clone.ts.
  const sites = ['src/daemon/run.ts', 'tools/real/two-clone.ts', 'test/sim/engineAdapter.ts', 'test/helpers/coreFixture.ts', 'test/helpers/engineFixture.ts'];
  for (const site of sites) {
    const src = await readFile(join(ROOT, site), 'utf8');
    assert.match(src, /plan3Ports\(\)/, `${site} binds plan3Ports()`);
    for (const name of ['grammarlessEditCheck', 'passT0Regions', 'openGate', 'noSymbols']) {
      assert.doesNotMatch(src, new RegExp(`\\b${name}\\b`), `${site} names ${name} only through plan3Ports()`);
    }
    assert.doesNotMatch(src, /\b(editCheck|t0Regions|gate|symbols)\s*:/, `${site} constructs none of the four fields itself`);
  }
});

test('t0Shrink lists a path going from non-empty to empty or losing more than 50 % of its stored size unless attributed; exactly 50 %, an attributed shrink and a path empty in TIP pass', T10, async () => {
  const f = await makeRepoFixture('t0-shrink');
  try {
    const blob = async (p: string, size: number): Promise<TreeEntry> => ({ path: p, mode: '100644', oid: await f.repo.hashBytes(Buffer.from('x'.repeat(size), 'utf8'), true) });
    const tip = new Map<string, TreeEntry>();
    const out = new Map<string, TreeEntry>();
    const put = async (p: string, from: number | null, to: number | null): Promise<void> => {
      if (from !== null) tip.set(p, await blob(p, from));
      if (to !== null) out.set(p, await blob(p, to));
    };
    await put('a.txt', 100, 0);      // non-empty → empty
    await put('b.txt', 100, 49);     // > 50 % lost
    await put('c.txt', 100, 50);     // exactly 50 %
    await put('d.txt', 100, 40);     // attributed
    await put('e.txt', 0, 0);        // empty in TIP
    await put('f.txt', 100, null);   // non-empty → absent
    await put('g.txt', null, 10);    // new in OUT
    await put('h.txt', 100, 120);    // growth
    const paths = [...new Set([...tip.keys(), ...out.keys()])].sort();
    const got = await t0Shrink(f.repo, tip, out, paths, (p) => p === 'd.txt');
    assert.deepEqual(got, ['a.txt', 'b.txt', 'f.txt'], 'path order');
    assert.deepEqual(await t0Shrink(f.repo, tip, out, ['c.txt', 'e.txt', 'g.txt', 'h.txt'], () => false), []);
    assert.deepEqual(await t0Shrink(f.repo, tip, out, paths, () => true), [], 'every shrink attributed');
  } finally {
    await f.cleanup();
  }
});
