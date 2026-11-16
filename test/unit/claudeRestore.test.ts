// HLD-59's admissibility of a Claude restore (Plan 3 Task 11; 05-holds HLD-59, H3, DAT-45; rulings R3-54, R3-65; contract addition 2):
// claudeRestoreRefusal answers a reason ('not_owner' | 'binary' | 'quarantine' | 'state') or null, never a message code, and resolve()
// with a seat actor returns {kind: 'claude_refused', reason} for each refusal with nothing written to status (core.holdCode) or the
// daemon log. The pure half uses hand-built records; the resolve() half real hold records on a real clone (git is never mocked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeRestoreRefusal, resolve, type ClaudeRestoreReason } from '../../src/engine/resolve.js';
import type { Oid } from '../../src/git/oid.js';
import { HOLD_CODES, HOLD_LOG_CODES } from '../../src/holds/codes.js';
import type { HoldRecord, HoldState, Offer, Residence } from '../../src/holds/record.js';
import { writeWork } from '../helpers/coreFixture.js';
import { blob, nr, P, pair, prepIt, recordLog, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { binary, record, T9, t9 } from '../helpers/maskFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const SEAT = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const A0 = '1'.repeat(40) as Oid;
const H1 = '2'.repeat(40) as Oid;

function rec(o: { origin?: string; residence?: Residence | null; state?: HoldState; guards?: string[]; offer?: Offer; kind?: HoldRecord['kind'] }): HoldRecord {
  const r = record(pair(A0, H1), { residence: o.residence === undefined ? 'OFF_DISK' : o.residence, state: o.state ?? 'PARKED', guards: o.guards ?? [], ...(o.kind !== undefined ? { kind: o.kind } : {}) });
  return { ...r, origin: o.origin ?? SEAT, offer: o.offer ?? 'none' };
}
const text = (): boolean => false;
const CODE = /^[A-Z][A-Z0-9_]{2,47}$/;

test('claudeRestoreRefusal allows only a record whose origin is the calling seat in OFF_DISK PARKED or CONFLICTED with guard conflict, claim-breach or none, or a returned SHADOW, on text paths', T10, async () => {
  // null: the calling seat (any agent of it) and an admitted state.
  for (const origin of [SEAT, `${SEAT}/agent-7`]) {
    for (const state of ['PARKED', 'CONFLICTED'] as const) {
      for (const guards of [[], ['conflict'], ['claim-breach'], ['conflict', 'claim-breach']]) {
        assert.equal(claudeRestoreRefusal(rec({ origin, state, guards }), SEAT, text), null, `${origin} ${state} ${guards.join('+')}`);
      }
    }
    assert.equal(claudeRestoreRefusal(rec({ origin, guards: ['claim:abcdefghijklmnop'], offer: 'returned' }), SEAT, text), null, 'a returned SHADOW');
  }
  const reasons: Array<[string, ClaudeRestoreReason | null]> = [];
  const check = (what: string, r: HoldRecord, want: ClaudeRestoreReason, bin: (p: string) => boolean = text): void => {
    const got = claudeRestoreRefusal(r, SEAT, bin);
    reasons.push([what, got]);
    assert.equal(got, want, what);
  };
  check("another seat's record", rec({ origin: OTHER, guards: ['conflict'] }), 'not_owner');
  check('a seat whose id only starts like the caller', rec({ origin: `${SEAT}x` }), 'not_owner');
  check('the human', rec({ origin: 'human' }), 'not_owner');
  check('a binary path', rec({ guards: ['conflict'] }), 'binary', () => true);
  check('a quarantine-review record', rec({ kind: 'INCOMING', residence: 'ON_DISK', state: 'ACTIVE', guards: ['quarantine-review'] }), 'quarantine');
  check('a revert record', rec({ guards: ['revert'] }), 'state');
  check('an ON_DISK record', rec({ residence: 'ON_DISK', state: 'ACTIVE', guards: ['conflict'] }), 'state');
  check('an ON_DISK CONFLICTED record', rec({ residence: 'ON_DISK', state: 'CONFLICTED', guards: ['conflict'] }), 'state');
  check('a terminal record', rec({ residence: null, state: 'RESOLVED_DISCARD' }), 'state');
  check('a SHADOW not returned', rec({ guards: ['claim:abcdefghijklmnop'], offer: 'offered' }), 'state');
  check('conflict with a markers guard', rec({ guards: ['conflict', 'markers'] }), 'state');
  // No result is a message code (R3-54): reasons only, none of them registered.
  for (const [what, r] of reasons) {
    assert.ok(r !== null && !CODE.test(r), `${what}: ${String(r)} is a reason, not a code`);
    assert.ok(!HOLD_CODES.includes(String(r)) && !HOLD_LOG_CODES.includes(String(r)));
  }

  // resolve() with a seat actor returns {kind: 'claude_refused', reason} for each, writing nothing to holdCode or the log as a code.
  const BIN = 'img.bin';
  const files = { 'README.md': Buffer.from('# claude restore\n'), [P]: Buffer.from(T9), [BIN]: binary(0) };
  await withPeers('claude-restore', { files }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'mine']));
    const it0 = await prepIt(p, { materialize: false });
    const a = it0.A.get(P)!.oid;
    const mine = await blob(p, t9([2, 'mine']));
    const team = await blob(p, t9([2, 'team']));
    const bin0 = it0.A.get(BIN)!.oid;
    const bin1 = await blob(p, binary(1));
    const ids: Array<[string, string, ClaudeRestoreReason]> = [
      ['another seat', await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: OTHER, blobs: stages(a, mine, team) })), 'not_owner'],
      ['the daemon', await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: 'conflict', origin: 'daemon', blobs: pair(a, team) })), 'not_owner'],
      ['binary', await p.core.holds.hold(nr({ paths: [BIN], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: `${SEAT}/sub`, blobs: pair(bin0, bin1, BIN) })), 'binary'],
      ['quarantine', await p.core.holds.hold(nr({ kind: 'INCOMING', guard: 'quarantine-review', origin: SEAT, blobs: pair(a, team) })), 'quarantine'],
      // Distinct held sides: HLD-07 would attach an equal change to an earlier record (one change, one id).
      ['revert', await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: 'revert', origin: SEAT, blobs: pair(a, await blob(p, t9([5, 'r']))) })), 'state'],
      ['ON_DISK', await p.core.holds.hold(nr({ guard: 'join', kind: 'PIN', origin: SEAT, blobs: pair(a, await blob(p, t9([8, 'p']))) })), 'state'],
    ];
    const log = recordLog(p);
    p.core.holdCode = null;
    const head = p.core.holds.head();
    const it = await prepIt(p, { holdPaths: [P, BIN] });
    for (const [what, id, reason] of ids) {
      const r = await resolve(p.core, it, id, 'restore', { actor: { seat: SEAT, agent: null }, humanEvidence: false });
      assert.deepEqual(r, { kind: 'claude_refused', reason }, what);
    }
    // An id this registry does not hold: not this seat's record either.
    assert.deepEqual(await resolve(p.core, it, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'restore', { actor: { seat: SEAT, agent: null }, humanEvidence: false }),
      { kind: 'claude_refused', reason: 'not_owner' });
    assert.equal(p.core.holdCode, null, 'nothing in status');
    assert.deepEqual(log.lines, [], 'nothing in the log');
    assert.equal(p.core.holds.head(), head, 'no registry commit');
    assert.equal(p.core.outbox.drafts().filter((d) => d.type === 'hold').length, 0, 'no op drafted');
  });
});
