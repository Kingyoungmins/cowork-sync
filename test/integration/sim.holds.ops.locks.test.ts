// The holds catalogue's ops against the real engine: locks held by another program and S6 (Plan 3 Task 13; 11-testing §3.5 F-FS-1,
// F-HLD-1 S6 part; HLD-32, HLD-54, HLD-61, glossary §25.2 item 1). Scripted holds runs on real git against file:// bare remotes (fix
// round 1 split of sim.holds.ops.test.ts; helpers in test/helpers/holdsScript.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOid } from '../../src/git/oid.js';
import { isTerminal } from '../../src/holds/record.js';
import { REFS, SIM_TIMEOUT, okOrFail, type Step, scriptRun, engineAt, until, has, holdsOf, live, liveFile, disk, logCodes } from '../helpers/holdsScript.js';
import { realEngineOf } from '../sim/engineAdapter.js';
import { hangul304 } from '../sim/generators.js';
import type { Oracle } from '../sim/harness.js';
import { boardHolds, readRegistry } from '../sim/holdsView.js';
import { findMarkers } from '../sim/markers.js';

// ---- F-FS-1: locks held by another program ---------------------------------------------------------------------------------

test('lock_share_read on p2\'s shared.txt while p1 publishes a band edit: p2 defers the closure \'locked\', has one INCOMING lock record from 60 virtual s, and unlock lets the next permitted apply write it and end the record; lock_share_none on a file p0 just edited keeps it out of p0\'s captures and gives one \'unreadable\' PIN from 60 s that ends after unlock', { timeout: SIM_TIMEOUT }, async (t) => {
  let unreadablePins = 0;
  let pinSides = '';
  const LOCKED = 'fmt/m05.py';
  let phase: 'read' | 'none' | null = null;
  let lockedMono: number | null = null;
  const facts = { deferredLocked: false, readRecordAge: null as number | null, readEarly: false, pinAfterMs: null as number | null, captured: false };
  let mark = 0;
  const tracker: Oracle = {
    name: 'LOCKS',
    async afterEveryOp(ctx) {
      const events = ctx.trace.since(mark);
      const base = mark;
      mark = ctx.trace.events.length;
      if (phase === 'read') {
        const p2 = realEngineOf(ctx.engines[2]!);
        if (p2 === null) return null;
        const ins = await p2.inspect();
        if (ins.pending['shared.txt'] === 'locked') facts.deferredLocked = true;
        if (events.some((e) => e.kind === 'hold' && e.peer === p2.peerId && e.holdKind === 'INCOMING' && e.guards.includes('lock') && e.rev === 1)) {
          facts.readRecordAge = ins.pendingAgeMs['shared.txt'] ?? -1;
          if ((ins.pendingAgeMs['shared.txt'] ?? 0) < 60_000) facts.readEarly = true;
        }
      } else if (phase === 'none') {
        const p0 = realEngineOf(ctx.engines[0]!);
        if (p0 === null) return null;
        const ins = await p0.inspect();
        if (ins.ready.some((pair) => pair.paths.includes(LOCKED))) facts.captured = true;
        for (const [x, e] of events.entries()) {
          if (e.kind === 'hold' && e.peer === p0.peerId && e.rev === 1 && e.guards.includes('unreadable') && e.paths.includes(LOCKED) && facts.pinAfterMs === null) {
            facts.pinAfterMs = (ctx.trace.monoAt(base + x) ?? 0) - lockedMono!;
          }
        }
      }
      return null;
    },
  };
  let checked = false;
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'lock_share_read', peer: 2, params: { path: 'shared.txt' } },
    { probe: 'read', run: async () => { phase = 'read'; } },
    { kind: 'edit_band', peer: 1, params: { insert: false } },
    ...Array.from({ length: 30 }, (): Step => ({ rounds: 1 })),
    {
      probe: 'read-held', run: async (ctx) => {
        assert.ok(facts.deferredLocked, 'p2 deferred shared.txt with reason locked');
        const p2 = engineAt(ctx, 2);
        const deferred = ctx.trace.ofKind('apply').filter((e) => e.peer === p2.peerId && e.groups.some((g) => g.outcome === 'deferred' && g.paths.includes('shared.txt')));
        assert.ok(deferred.length > 0 && deferred.every((e) => e.groups.find((g) => g.paths.includes('shared.txt'))!.reason === 'locked'), 'the closure deferred \'locked\'');
        assert.ok(facts.readRecordAge !== null && facts.readRecordAge >= 60_000 && !facts.readEarly, `the INCOMING lock record came at 60 s (age ${facts.readRecordAge})`);
        assert.equal(live(await holdsOf(ctx, 2)).filter((r) => r.kind === 'INCOMING' && has(r, 'lock')).length, 1, 'one INCOMING lock record');
        phase = null;
      },
    },
    { kind: 'unlock', peer: 2 },
    { rounds: 6 },
    {
      probe: 'read-released', run: async (ctx) => {
        const rs = (await holdsOf(ctx, 2)).filter((r) => r.kind === 'INCOMING' && has(r, 'lock'));
        assert.deepEqual(rs.map((r) => r.state), ['SUBSUMED'], 'the lock record ended');
        const tip = (await liveFile(ctx, 'shared.txt'))!;
        assert.deepEqual(findMarkers((await disk(ctx, 2, 'shared.txt'))!), findMarkers(tip), 'the next permitted apply wrote it');
        assert.equal((await engineAt(ctx, 2).inspect()).pending['shared.txt'], undefined);
      },
    },
    { kind: 'edit_own', peer: 0, params: { path: LOCKED, row: 3, text: '    v4 = 4 p0 under a lock' } },
    {
      probe: 'none', run: async (ctx) => {
        lockedMono = ctx.clocks.get('p0')!.monoMs();
        phase = 'none';
      },
    },
    { kind: 'lock_share_none', peer: 0, params: { path: LOCKED } },
    ...Array.from({ length: 30 }, (): Step => ({ rounds: 1 })),
    {
      probe: 'none-held', run: async (ctx) => {
        assert.equal(facts.captured, false, `${LOCKED} stayed out of p0's captures`);
        assert.ok(facts.pinAfterMs !== null && facts.pinAfterMs >= 60_000, `one unreadable PIN from 60 s (after ${facts.pinAfterMs} ms)`);
        // the newest unreadable PIN's held side, as the registry stores it (the todo below names it)
        const reg = await readRegistry(ctx.git, ctx.peers[0]!.dir, 'main');
        const newest = [...reg.records.values()].filter((r) => r.kind === 'PIN' && has(r, 'unreadable') && r.paths.includes(LOCKED)).sort((a, b) => (a.id < b.id ? 1 : -1))[0];
        const sides = newest?.blobs as { h0: Record<string, string>; h1: Record<string, string> } | undefined;
        pinSides = sides === undefined ? 'none' : sides.h0[LOCKED] === sides.h1[LOCKED] ? 'h0 = h1' : 'h0 ≠ h1';
        assert.ok(!(await liveFile(ctx, LOCKED))!.toString('latin1').includes('p0 under a lock'), 'not published while locked');
        phase = null;
      },
    },
    { kind: 'unlock', peer: 0 },
    { rounds: 12 },
    {
      probe: 'none-released', run: async (ctx) => {
        const pins = (await holdsOf(ctx, 0)).filter((r) => r.kind === 'PIN' && has(r, 'unreadable') && r.paths.includes(LOCKED));
        assert.ok(pins.length >= 1 && pins.every((r) => isTerminal(r)), 'no unreadable PIN is left after unlock');
        unreadablePins = pins.length;
        assert.ok((await liveFile(ctx, LOCKED))!.toString('latin1').includes('p0 under a lock'), 'the edit published');
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-locks', () => steps, { oracles: [tracker] })).r);
  assert.ok(checked);
  // The brief's "one 'unreadable' PIN": the PIN over the never-staged edit holds h0 = h1 (h1 = privateBlob(p) of an edit no tick could
  // stage is A[p]); Task 13 found it ended SUBSUMED by R1 an iteration after its creation and created again while the exclusion
  // persisted (18 PINs in one run). Since Plan 3 Task EF R1 keeps a transient PIN while its guard holds (incomingStep releases it).
  await t.test('the share-none lock gives exactly one unreadable PIN', () => {
    assert.equal(unreadablePins, 1, `${unreadablePins} unreadable PINs over the lock (the newest: ${pinSides})`);
  });
});

// ---- S6 (HLD-61) -------------------------------------------------------------------------------------------------------------

test('age_24h: a durable ON_DISK revert record is parked by S6 at p0\'s next iteration (HOLD_AUTO_PARKED, disk = team version, held/ unchanged on the board), while a local_only portability record of the same age and a revert record of a partitioned peer (Plan 2 \'partition\' op before the jump, \'heal\' after the check) stay ON_DISK; the HOLD_MIRROR_REJECTED form is Task 12b\'s', { timeout: SIM_TIMEOUT }, async () => {
  const BAD = process.platform === 'win32' ? hangul304(1) : 'con.py';
  const ids: { p0: string; port: string; p2: string } = { p0: '', port: '', p2: '' };
  let heldBefore: string | null = null;
  let checked = false;
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 30, n: 1, text: 'p1-line' } },
    { kind: 'edit_band', peer: 1, params: { path: 'fmt/m04.py', insert: true, row: 6, n: 1, text: 'p1-line' } },
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },
    { kind: 'nonportable_name', peer: 0, params: { name: BAD } },
    { rounds: 12 },
    {
      probe: 'durable', run: async (ctx) => {
        const ins = await engineAt(ctx, 0).inspect();
        const rev = live(ins.holds).find((r) => has(r, 'revert'));
        const port = live(ins.holds).find((r) => has(r, 'portability'));
        assert.ok(rev !== undefined && port !== undefined);
        assert.deepEqual(ins.mirror[rev.id], { durable: true, rejected: null });
        ids.p0 = rev.id;
        ids.port = port.id;
        const board = (await ctx.remote.refs())[REFS.remoteBoard]!;
        heldBefore = JSON.stringify((await boardHolds(ctx.git, ctx.peers[0]!.dir, parseOid(board))).held.get(rev.id) ?? null);
      },
    },
    { kind: 'partition', peer: 0 },
    { kind: 'stale_save', peer: 2, params: { path: 'fmt/m04.py', buffer: 'genesis' } },
    until(2, 'p2 revert', async (ctx) => live(await holdsOf(ctx, 2)).some((r) => has(r, 'revert'))),
    {
      probe: 'not durable', run: async (ctx) => {
        const ins = await engineAt(ctx, 2).inspect();
        const rev = live(ins.holds).find((r) => has(r, 'revert'))!;
        assert.equal(ins.mirror[rev.id]?.durable, false, 'the partitioned peer\'s record never reached the board');
        ids.p2 = rev.id;
      },
    },
    { kind: 'age_24h', peer: 0 },
    { advance: 2_500 },
    { iterate: 0 },
    { iterate: 2 },
    {
      probe: 'parked', run: async (ctx) => {
        const h0 = await holdsOf(ctx, 0);
        const rev = h0.find((r) => r.id === ids.p0)!;
        assert.deepEqual([rev.residence, rev.state], ['OFF_DISK', 'PARKED'], 'S6 parked p0\'s durable revert record');
        assert.ok((await logCodes(ctx, 0)).some((l) => l.code === 'HOLD_AUTO_PARKED' && l.params['hid'] === ids.p0), 'HOLD_AUTO_PARKED');
        assert.ok((await disk(ctx, 0, 'shared.txt'))!.toString('latin1').includes('p1-line'), 'p0\'s disk holds the team version');
        const port = h0.find((r) => r.id === ids.port)!;
        assert.deepEqual([port.residence, port.local_only, isTerminal(port)], ['ON_DISK', true, false], 'the local_only record stays ON_DISK');
        const p2 = (await holdsOf(ctx, 2)).find((r) => r.id === ids.p2)!;
        assert.equal(p2.residence, 'ON_DISK', 'the partitioned peer\'s record stays ON_DISK');
        assert.ok((await engineAt(ctx, 2).inspect()).holdAgeMs[ids.p2]! >= 86_400_000, 'it is 24 h old too');
      },
    },
    { kind: 'heal', peer: 0 },
    // p0 left its network backoff (30 s doubling to 5 min, glossary §27.2) and pushed the park's op
    until(0, 'park mirrored', async (ctx) => (await engineAt(ctx, 0).inspect()).mirror[ids.p0]?.durable === true, 200),
    {
      probe: 'board', run: async (ctx) => {
        const board = (await ctx.remote.refs())[REFS.remoteBoard]!;
        const view = await boardHolds(ctx.git, ctx.peers[0]!.dir, parseOid(board));
        assert.equal(view.holds[ids.p0]?.residence, 'OFF_DISK', 'the park reached the board');
        assert.equal(JSON.stringify(view.held.get(ids.p0) ?? null), heldBefore, 'held/ unchanged');
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-age24h', () => steps)).r);
  assert.ok(checked);
});
