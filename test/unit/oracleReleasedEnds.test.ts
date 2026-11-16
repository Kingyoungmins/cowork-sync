// O-RELEASED-ENDS (test/sim/oraclesHolds.ts; F1 audit fix #28, the EF3 review's carried liveness clause, Plan 3 ledger :193; 11-testing
// §3.4; 05-holds HLD-24 "released, waiting for R1", §3.6 R1, R3-17) judged on synthetic EngineInspections at a reached quiescence: the
// oracle reads only ctx.quiescence and each engine's inspect(), so no git runs here. Its real-engine runs are every exit seed (exitOracles
// appends it) and the TC-TST-02 cross-check of sim.exit.holds.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EngineInspection } from '../../src/engine/loop.js';
import type { NotConvergedWhy, PublishPause } from '../../src/engine/status.js';
import type { FreezeReason } from '../../src/engine/meta.js';
import type { Guard, HoldRecord, HoldState } from '../../src/holds/record.js';
import type { QuiescenceInfo, SimContext, SimEngine } from '../sim/harness.js';
import { oracleReleasedEnds } from '../sim/oraclesHolds.js';

const PEER = '0123456789abcdef0123456789abcdef';
const REVERT: Guard = { name: 'revert', class: 'DECISION', owner: 'HLD' };

let n = 0;
/** A record with the fields the oracle reads; ON_DISK ACTIVE PATCH with no guard (released) unless overridden. */
function rec(o: Partial<HoldRecord> & { paths: string[] }): HoldRecord {
  n++;
  return {
    id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(n).padStart(2, '0')}`, rev: 3, owner: PEER, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE',
    offer: 'none', declines: 0, displaced_by: null, blobs: { h0: {}, h1: {} }, guards: [], origin: 'human', cs_ids: [], peer_authors: [],
    local_only: false, age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1, ...o,
  };
}

interface Peer { holds: HoldRecord[]; why?: Record<string, NotConvergedWhy>; freeze?: FreezeReason[]; pause?: PublishPause; inspect?: false; inspectThrows?: true; }

const REACHED: QuiescenceInfo = { reached: true, tStar: 'f'.repeat(40), rounds: 61, pushAttemptsInExtra: 0, boardChangedInExtra: false };

function ctxOf(peers: readonly Peer[], quiescence: QuiescenceInfo | null = REACHED): SimContext {
  const engines = peers.map((p, i): SimEngine => {
    const ins = { holds: p.holds, notConvergedWhy: p.why ?? {}, freeze: p.freeze ?? [], publishPause: p.pause ?? null } as unknown as EngineInspection;
    return {
      peer: { name: `p${i}` } as SimEngine['peer'], step: async () => {},
      ...(p.inspect === false ? {} : p.inspectThrows === true ? { inspect: async () => { throw new Error('synthetic inspect failure'); } } : { inspect: async () => ins }),
    };
  });
  return { engines, quiescence } as unknown as SimContext;
}

const judge = (peers: readonly Peer[], q?: QuiescenceInfo | null): Promise<string | null> => oracleReleasedEnds().atQuiescence!(ctxOf(peers, q));
const own = (kind: string): NotConvergedWhy => ({ cause: 'blocked_publish', guard: kind });

test('O-RELEASED-ENDS fails at quiescence for a released PATCH or PIN that R1 never ended — listed with only its own release qualifier, or not listed at all', async () => {
  const patch = rec({ paths: ['f.py'] });
  const msg = await judge([{ holds: [patch], why: { 'f.py': own('patch') } }]);
  assert.ok(msg !== null && msg.startsWith(`O-RELEASED-ENDS (ends) p0 PATCH ${patch.id} (ACTIVE, rev 3) is released (no guard left) and still open at quiescence`), String(msg));
  assert.match(msg, /f\.py: \{"cause":"blocked_publish","guard":"patch"\}/);
  // A released PIN (R1 step 0: guard-less PIN), on the second peer; the first peer is clean.
  const pin = rec({ kind: 'PIN', blobs: { h0: {}, h1: {} }, paths: ['a.ts', 'b.ts'] });
  const m2 = await judge([{ holds: [] }, { holds: [pin], why: { 'a.ts': own('pin'), 'b.ts': own('pin') } }]);
  assert.ok(m2 !== null && m2.startsWith(`O-RELEASED-ENDS (ends) p1 PIN ${pin.id}`), String(m2));
  // A path status does not list at all is no excuse (INV-NOSILENT's breach, and the record still never ended).
  assert.match(String(await judge([{ holds: [patch] }])), /f\.py: not in not_converged/);
  // Fail closed (F1 G4 review:robust r1): an engine that cannot be inspected, or whose inspect() throws, fails the oracle — it never passes.
  assert.match(String(await judge([{ holds: [patch], why: { 'f.py': own('patch') }, inspect: false }])), /p0: the engine cannot be inspected/);
  assert.match(String(await judge([{ holds: [patch], why: { 'f.py': own('patch') }, inspectThrows: true }])), /p0: inspect\(\) failed: Error: synthetic inspect failure/);
  // Every open released record of every peer is named.
  const two = await judge([{ holds: [patch, pin], why: { 'f.py': own('patch'), 'a.ts': own('pin'), 'b.ts': own('pin') } }]);
  assert.equal(String(two).split(' | ').length, 2, String(two));
});

test('O-RELEASED-ENDS passes when nothing released is left open, when something else keeps the path back, outside its scope and before quiescence', async () => {
  const released = rec({ paths: ['f.py'] });
  const ownWhy = { 'f.py': own('patch') };
  const cases: Array<[string, Peer[], QuiescenceInfo | null | undefined]> = [
    ['no record', [{ holds: [] }], undefined],
    ...(['SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD'] as HoldState[]).map((state): [string, Peer[], undefined] => [`ended ${state}`, [{ holds: [rec({ paths: ['f.py'], state })] }], undefined]),
    ['a guard left', [{ holds: [rec({ paths: ['f.py'], guards: [REVERT] })], why: { 'f.py': { cause: 'blocked_publish', guard: 'revert' } } }], undefined],
    ['guard-less CONFLICTED (MASK withholds it whole)', [{ holds: [rec({ paths: ['f.py'], state: 'CONFLICTED' })], why: ownWhy }], undefined],
    ['guard-less local_only (MASK withholds it whole)', [{ holds: [rec({ paths: ['f.py'], local_only: true })], why: ownWhy }], undefined],
    ['OFF_DISK', [{ holds: [rec({ paths: ['f.py'], residence: 'OFF_DISK', state: 'PARKED' })] }], undefined],
    ['INCOMING (HLD-54, INV-GROUP)', [{ holds: [rec({ paths: ['f.py'], kind: 'INCOMING' })], why: { 'f.py': { cause: 'deferred', reason: 'incoming' } } }], undefined],
    ['the peer is frozen', [{ holds: [released], why: ownWhy, freeze: ['MASS'] }], undefined],
    ['the peer is publish-paused', [{ holds: [released], why: ownWhy, pause: 'OFFLINE' }], undefined],
    ['FREEZE/pause reason on the path', [{ holds: [released], why: { 'f.py': { cause: 'blocked_publish', reason: 'FREEZE' } } }], undefined],
    ['R3-53\'s gate keeps it back', [{ holds: [released], why: { 'f.py': { cause: 'blocked_publish', guard: 'portability' } } }], undefined],
    ['another record\'s guard on one of its paths', [{ holds: [rec({ paths: ['f.py', 'g.py'] }), rec({ paths: ['g.py'], guards: [REVERT] })], why: { 'f.py': own('patch'), 'g.py': { cause: 'blocked_publish', guard: 'revert' } } }], undefined],
    ['a deferral on the path', [{ holds: [released], why: { 'f.py': { cause: 'deferred', reason: 'locked' } } }], undefined],
    // judge() passes null through (only undefined defaults to REACHED): a run with no quiescence phase has nothing to judge.
    ['no quiescence phase', [{ holds: [released], why: ownWhy }], null],
    ['quiescence not reached', [{ holds: [released], why: ownWhy }], { ...REACHED, reached: false, tStar: null }],
  ];
  for (const [label, peers, q] of cases) assert.equal(await judge(peers, q), null, label);
});
// The 'an engine that cannot be inspected' passing case was removed on purpose by F1 G4 review:robust r1: an uninspectable engine now
// fails the oracle (fail closed), judged in the first test above. The 'no quiescence phase' case (q = null, the oracle's `q === null`
// branch) was dropped by the same commit b6b3a97 without a reason and is restored above (F2 #28).
