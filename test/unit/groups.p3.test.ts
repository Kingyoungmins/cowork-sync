// Publication groups and readiness on ChangeSets (Plan 3 Task 10; 05-holds HLD-38, HLD-39, 05 U11, TC-HLD-11 (c); rulings
// R3-44): a ChangeSets on a VirtualClock with scripted signals and hand-built HeldPins. Captures write trees, so they run on a
// real clone (git is never mocked); a capture is called in the group form (pins given), as captureStep calls it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TreeEntry, TreeMap } from '../../src/git/repo.js';
import { ChangeSets, HUMAN_CS_QUIET_MS, type HeldPin, type ReadyPair } from '../../src/holds/changesets.js';
import type { MaskResult } from '../../src/holds/mask.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { VirtualClock } from '../sim/vclock.js';

const T10 = { timeout: 10 * 60_000 };
const PEER = '0123456789abcdef0123456789abcdef';
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const PIN_ID = '01JC0000000000000000000000';

let tool = 0;
function effect(seat: string, paths: readonly string[]): CsSignal {
  return { kind: 'effect', seat, agent: null, toolUseId: `toolu_${++tool}`, paths, turnOrigin: 'prompt' };
}

interface Ctx {
  f: RepoFixture; clock: VirtualClock; cs: ChangeSets; scratch: string;
  tm(files: Record<string, string>): Promise<Map<string, TreeEntry>>;
  /** A capture in the group form (pins given, no kept push intent). */
  capture(sDisk: TreeMap, A: TreeMap, pins?: readonly HeldPin[]): Promise<ReadyPair[]>;
}

async function setup(label: string): Promise<Ctx> {
  const f = await makeRepoFixture(label);
  const dir = join(f.paths.coworkDir, 'tmp');
  await mkdir(dir, { recursive: true });
  const clock = new VirtualClock();
  const cs = new ChangeSets(PEER, clock);
  const scratch = join(dir, 'groups.index');
  const tm = async (files: Record<string, string>): Promise<Map<string, TreeEntry>> => {
    const m = new Map<string, TreeEntry>();
    for (const [p, t] of Object.entries(files)) m.set(p, { path: p, mode: '100644', oid: await f.repo.hashBytes(Buffer.from(t, 'utf8'), true) });
    return m;
  };
  const capture = async (sDisk: TreeMap, base: TreeMap, pins: readonly HeldPin[] = []): Promise<ReadyPair[]> => {
    const r = await cs.capture(f.repo, sDisk, base, scratch, new Set(), pins);
    return r?.pairs ?? [];
  };
  return { f, clock, cs, scratch, tm, capture };
}

/** The identity MASK: P is the composed R (no record), so a test reads which pairs composeP took. */
const noMask = async (X: TreeMap): Promise<MaskResult> => ({ entries: new Map(X), withheld: new Set(), partial: new Set(), conflicted: [] });

const humanId = (n: number): string => `${PEER}/human/${n}`;

test('groups() is the transitive closure of open and ready CSs and held PINs sharing a path, keyed by the smallest cs_id', T10, async () => {
  const c = await setup('groups-closure');
  try {
    const { cs } = c;
    // A/1 {a, b}; the human CS {b, c} (unclaimed deltas), captured so it carries <peer>/human/1; a PIN {c, d}; B/1 {x}.
    cs.signal(effect(A, ['a.txt', 'b.txt']));
    cs.observe(['a.txt', 'b.txt']);
    cs.observe(['b.txt', 'c.txt']);
    c.clock.advance(HUMAN_CS_QUIET_MS);
    const base = await c.tm({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n', 'd.txt': 'd0\n', 'x.txt': 'x0\n' });
    const disk = await c.tm({ 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n', 'd.txt': 'd0\n', 'x.txt': 'x1\n' });
    const pairs = await c.capture(disk, base);
    assert.deepEqual(pairs.map((p) => p.csId).sort(), [`${A}/1`, humanId(1)].sort(), 'the human CS was captured with its seat neighbour');
    cs.signal(effect(B, ['x.txt']));
    cs.observe(['x.txt']);
    const pin: HeldPin = { id: PIN_ID, paths: ['c.txt', 'd.txt'], guards: ['t0'] };
    const groups = cs.groups([pin]);
    assert.equal(groups.length, 2);
    const first = groups.find((g) => g.csIds.includes(`${A}/1`))!;
    assert.deepEqual(first.csIds, [humanId(1), `${A}/1`].sort());
    assert.equal(first.key, [humanId(1), `${A}/1`].sort()[0], 'keyed by the smallest cs_id');
    assert.deepEqual(first.paths, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    assert.deepEqual(first.pins, [PIN_ID]);
    assert.equal(first.ready, false, 'a group holding a held PIN is not ready');
    const second = groups.find((g) => g.csIds.includes(`${B}/1`))!;
    assert.deepEqual(second, { key: `${B}/1`, csIds: [`${B}/1`], paths: ['x.txt'], pins: [], ready: false });
    // Without the PIN the human CS and A/1 still share b.txt, and d.txt belongs to no CS.
    const free = cs.groups([]);
    assert.deepEqual(free.map((g) => g.paths).sort(), [['a.txt', 'b.txt', 'c.txt'], ['x.txt']]);
    // A PIN alone (no CS shares its paths) forms no group.
    assert.equal(cs.groups([{ id: PIN_ID, paths: ['z.txt'], guards: ['join'] }]).length, 2);
  } finally {
    await c.f.cleanup();
  }
});

test('a group holding a held PIN is not ready and composeP publishes none of its paths while keeping its pairs journaled', T10, async () => {
  const c = await setup('groups-pinned');
  try {
    const { cs, f } = c;
    const base = await c.tm({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' });
    // A closed seat CS {a, b} and a closed seat CS {c}: both groups ready from their closing captures.
    cs.signal(effect(A, ['a.txt', 'b.txt']));
    cs.signal({ kind: 'stop', seat: A });
    cs.signal(effect(B, ['c.txt']));
    cs.signal({ kind: 'stop', seat: B });
    const disk = await c.tm({ 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' });
    const pairs = await c.capture(disk, base);
    assert.equal(pairs.length, 2);
    assert.deepEqual(cs.groups([]).map((g) => g.ready), [true, true]);
    // A held PIN on b.txt (any guard: HLD-38's held PINs are every ON_DISK PIN with guards) holds the whole {a, b} group.
    const pins: HeldPin[] = [{ id: PIN_ID, paths: ['b.txt'], guards: ['claim:abcdefghij234567'] }];
    const held = cs.groups(pins).find((g) => g.csIds.includes(`${A}/1`))!;
    assert.equal(held.ready, false);
    assert.deepEqual(held.pins, [PIN_ID]);
    const comp = await cs.composeP(f.repo, base, noMask, pins);
    assert.equal(comp.P.get('a.txt')!.oid, base.get('a.txt')!.oid, 'a.txt (not pinned itself) publishes A');
    assert.equal(comp.P.get('b.txt')!.oid, base.get('b.txt')!.oid);
    assert.equal(comp.P.get('c.txt')!.oid, disk.get('c.txt')!.oid, 'the other ready group publishes');
    assert.deepEqual(comp.csIds, [`${B}/1`]);
    assert.deepEqual(comp.groups.map((g) => [g.key, g.ready, g.pins]), [[`${A}/1`, false, [PIN_ID]], [`${B}/1`, true, []]]);
    assert.deepEqual([...comp.withheldWhole], []);
    assert.deepEqual(cs.ready().map((p) => p.csId).sort(), [`${A}/1`, `${B}/1`], 'R3-44: the held group\'s pairs stay journaled');
    // The PIN released (no longer held): the group publishes from the same pairs.
    const free = await cs.composeP(f.repo, base, noMask, []);
    assert.deepEqual(free.csIds.sort(), [`${A}/1`, `${B}/1`]);
    assert.equal(free.P.get('b.txt')!.oid, disk.get('b.txt')!.oid);
  } finally {
    await c.f.cleanup();
  }
});

test('05 U11: a group of two open seat CSs is ready only from a capture taken when both latest effects were covered', T10, async () => {
  const c = await setup('groups-u11');
  try {
    const { cs } = c;
    const base = await c.tm({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 's.txt': 's0\n' });
    cs.signal(effect(A, ['a.txt', 's.txt']));
    cs.signal(effect(B, ['b.txt', 's.txt']));
    // A green checkpoint covers A/1's latest effect and asks for a capture; B/1 is still uncovered.
    cs.signal({ kind: 'checkpoint', seat: A, source: 'green', candSeq: 1, paths: [] });
    const first = await c.capture(await c.tm({ 'a.txt': 'a1\n', 'b.txt': 'b1\n', 's.txt': 's1\n' }), base);
    assert.deepEqual(first.map((p) => p.csId).sort(), [`${A}/1`, `${B}/1`], 'a member without a pair always gets one');
    assert.equal(cs.table().passing[`${A}/1`], false);
    let [g] = cs.groups([]);
    assert.equal(g!.ready, false, 'B/1 was uncovered at the capture: not a passing capture');
    // Both covered: the next capture is passing and the group is ready.
    cs.signal({ kind: 'checkpoint', seat: B, source: 'green', candSeq: 1, paths: [] });
    const second = await c.capture(await c.tm({ 'a.txt': 'a2\n', 'b.txt': 'b2\n', 's.txt': 's2\n' }), base);
    assert.equal(second.length, 2);
    assert.deepEqual(cs.table().passing, { [`${A}/1`]: true, [`${B}/1`]: true });
    [g] = cs.groups([]);
    assert.equal(g!.ready, true);
    assert.deepEqual(g!.csIds, [`${A}/1`, `${B}/1`]);
  } finally {
    await c.f.cleanup();
  }
});

test('a later uncovered effect by either member keeps the earlier passing capture ready and composeP still uses it', T10, async () => {
  const c = await setup('groups-later');
  try {
    const { cs, f } = c;
    const base = await c.tm({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 's.txt': 's0\n' });
    cs.signal(effect(A, ['a.txt', 's.txt']));
    cs.signal(effect(B, ['b.txt', 's.txt']));
    cs.signal({ kind: 'checkpoint', seat: A, source: 'tool', candSeq: 1, paths: [] });
    cs.signal({ kind: 'checkpoint', seat: B, source: 'green', candSeq: 1, paths: [] });
    const passing = await c.tm({ 'a.txt': 'a1\n', 'b.txt': 'b1\n', 's.txt': 's1\n' });
    await c.capture(passing, base);
    assert.equal(cs.groups([])[0]!.ready, true);
    // Later effects by both members (no check covers them): the passing capture stays ready (HLD-39, TC-HLD-11 (c)).
    cs.signal(effect(A, ['a.txt']));
    cs.signal(effect(B, ['s.txt']));
    assert.equal(cs.groups([])[0]!.ready, true);
    assert.equal(cs.table().cs.find((e) => e.cs_id === `${A}/1`)!.covered, false);
    // A capture taken now (B's green checkpoint again, A uncovered) is not passing: it never replaces the passing pairs.
    cs.signal({ kind: 'checkpoint', seat: B, source: 'green', candSeq: 2, paths: [] });
    await c.capture(await c.tm({ 'a.txt': 'a9\n', 'b.txt': 'b9\n', 's.txt': 's9\n' }), base);
    assert.equal(cs.groups([])[0]!.ready, true);
    const comp = await cs.composeP(f.repo, base, noMask, []);
    for (const p of ['a.txt', 'b.txt', 's.txt']) assert.equal(comp.P.get(p)!.oid, passing.get(p)!.oid, `${p} from the passing capture`);
    assert.deepEqual(comp.csIds.sort(), [`${A}/1`, `${B}/1`]);
  } finally {
    await c.f.cleanup();
  }
});

test('a group of closed CSs is ready from its closing capture without any check', T10, async () => {
  const c = await setup('groups-closed');
  try {
    const { cs } = c;
    const base = await c.tm({ 'a.txt': 'a0\n', 'h.txt': 'h0\n' });
    // A seat CS closed at its stop (no checkpoint, no edit check) and a human CS closed by its 20 s quiet, sharing a.txt.
    cs.signal(effect(A, ['a.txt']));
    cs.observe(['a.txt']);
    cs.signal({ kind: 'stop', seat: A });
    cs.observe(['a.txt', 'h.txt']);
    assert.equal(cs.groups([])[0]!.ready, false, 'nothing captured yet');
    c.clock.advance(HUMAN_CS_QUIET_MS);
    const pairs = await c.capture(await c.tm({ 'a.txt': 'a1\n', 'h.txt': 'h1\n' }), base);
    assert.deepEqual(pairs.map((p) => p.csId).sort(), [humanId(1), `${A}/1`].sort());
    const [g] = cs.groups([]);
    assert.equal(g!.ready, true);
    assert.deepEqual(cs.table().passing, { [humanId(1)]: true, [`${A}/1`]: true });
    assert.deepEqual(cs.table().cs.map((e) => [e.cs_id, e.state, e.covered]).sort(), [[humanId(1), 'closed', false], [`${A}/1`, 'closed', false]].sort());
  } finally {
    await c.f.cleanup();
  }
});
