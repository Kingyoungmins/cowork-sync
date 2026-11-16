// /cowork resolve's Table 4 and HLD-57 (Plan 3 Task 11; 05-holds Table 4, HLD-57 (a)–(e), HLD-58, HLD-09, the §1 refusal table;
// 05 U5 resolve parts, P6, H1, H2, H4–H9; rulings R3-02, R3-06, R3-09, R3-23, R3-27; contract addition 2): every Table 4 row on its own
// path of one clone, the owner and fold-first rules, the fold-level rev CAS of the resolve's hold op, the writer refusals, the
// restore as an observed change, FREEZE(MASS), the next commands and --handoff. Records are made with Task 1's hold() (human verbs:
// humanEvidence true) unless a row says Claude. makeCores({n: 2}); git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimes, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { resolveLine } from '../../src/daemon/run.js';
import { applyStep } from '../../src/engine/apply.js';
import { enterMass, revertStep } from '../../src/engine/detect.js';
import { mirrorSync } from '../../src/engine/publish.js';
import { resolve, type ResolveResult } from '../../src/engine/resolve.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { pinCs, shadowRecord } from '../../src/holds/changesets.js';
import { NEXT_COMMAND, type ResolveRefusal } from '../../src/holds/codes.js';
import { guardName, makeGuard, type HoldRecord } from '../../src/holds/record.js';
import { readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, pair, plantRecord, prepIt, stages } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { holdOpsSince, opLine, plantOwn, remoteTip, win } from '../helpers/mirrorFixture.js';
import { buf, captureReady, prep, withCores } from '../helpers/publishHelpers.js';
import { captureAndLand, HUMAN, joinOnBoard, landHoldOps } from '../helpers/resolveFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const ROWS = ['rev_dis', 'rev_park', 'rev_hand', 'parked_rev', 'k4_res', 'k4_dis', 'join_pub', 'join_dis', 'join_park', 'lock', 'eol', 'hrej', 'unk', 'pub'];
/** The --handoff test's offerable shapes (a SHADOW, a claim PIN) that also carry a guard Table 4 refuses. */
const HANDOFF_ROWS = ['h_rev', 'h_con', 'h_cb', 'h_bm', 'h_ws'];
const at = (row: string): string => `t/${row}.txt`;
const FILES: Record<string, Buffer> = {
  'README.md': buf('# resolve table\n'), '.env': buf('KEY=1\n'),
  ...Object.fromEntries([...ROWS, ...HANDOFF_ROWS].map((r) => [at(r), buf(T9)])),
};
const SEAT = 'c'.repeat(32);
const done = (code: string, id: string, created: string | null = null): ResolveResult => ({ kind: 'done', code, id, created });
const guardsOf = (r: HoldRecord | undefined): string[] => (r?.guards ?? []).map((g) => g.name);
const shape = (r: HoldRecord | undefined): unknown[] => [r?.residence, r?.state, r?.offer, guardsOf(r)];
async function disk(p: PeerFixture, path: string): Promise<string | null> {
  return (await readWork(p, path))?.toString('utf8') ?? null;
}

/** An ON_DISK ACTIVE revert PATCH over `path` whose disk is T9{2:two,6:six} and whose held change is line 2 (h1 = T9{2:two}). */
async function revertRow(p: PeerFixture, path: string): Promise<void> {
  await writeWork(p, path, t9([2, 'two'], [6, 'six']));
}

test('05 U5 resolve part: every Table 4 row gives the listed result and next record state', T10, async () => {
  await withCores('resolve-table', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    for (const row of ['rev_dis', 'rev_park', 'rev_hand']) await revertRow(p, at(row));
    await writeWork(p, at('join_pub'), t9([4, 'j']));
    await writeWork(p, at('join_dis'), t9([4, 'j']));
    await writeWork(p, at('join_park'), t9([4, 'j']));
    await writeWork(p, at('eol'), t9([5, 'e']));
    await writeWork(p, at('hrej'), t9([8, 'h']));
    await writeWork(p, at('unk'), t9([9, 'u']));
    await writeWork(p, '.env', 'KEY=2\n');
    const it0 = await prepIt(p, { materialize: false });
    const a = it0.A.get(at('lock'))!.oid;   // every row's A[p] is T9
    const two = await blob(p, t9([2, 'two']));
    const h = core(p);
    const id = {
      rev_dis: await h.hold(nr({ paths: [at('rev_dis')], blobs: pair(a, two, at('rev_dis')) })),
      rev_park: await h.hold(nr({ paths: [at('rev_park')], blobs: pair(a, two, at('rev_park')) })),
      rev_hand: await h.hold(nr({ paths: [at('rev_hand')], blobs: pair(a, two, at('rev_hand')) })),
      parked_rev: await h.hold(nr({ paths: [at('parked_rev')], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(a, two, at('parked_rev')) })),
      k4_res: await h.hold(nr({ paths: [at('k4_res')], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(a, await blob(p, t9([3, 'mine'])), a, at('k4_res')) })),
      k4_dis: await h.hold(nr({ paths: [at('k4_dis')], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(a, await blob(p, t9([3, 'mine 2'])), a, at('k4_dis')) })),
      join_pub: await h.hold(nr({ kind: 'PIN', guard: 'join', paths: [at('join_pub')], blobs: pair(a, await blob(p, t9([4, 'j'])), at('join_pub')) })),
      join_dis: await h.hold(nr({ kind: 'PIN', guard: 'join', paths: [at('join_dis')], blobs: pair(a, await blob(p, t9([4, 'j'])), at('join_dis')) })),
      join_park: await h.hold(nr({ kind: 'PIN', guard: 'join', paths: [at('join_park')], blobs: pair(a, await blob(p, t9([4, 'older'])), at('join_park')) })),
      lock: await h.hold(nr({ kind: 'INCOMING', guard: 'lock', origin: 'daemon', paths: [at('lock')], blobs: pair(a, await blob(p, t9([7, 'tip'])), at('lock')) })),
      eol: await h.hold(nr({ guard: 'eol-bom', origin: 'daemon', paths: [at('eol')], blobs: pair(a, await blob(p, t9([5, 'e'])), at('eol')) })),
      hrej: await h.hold(nr({ kind: 'PIN', guard: 'host-reject', origin: 'daemon', paths: [at('hrej')], blobs: pair(a, await blob(p, t9([8, 'h'])), at('hrej')) })),
      env: await h.hold(nr({ guard: 'restart', origin: 'daemon', paths: ['.env'], blobs: pair(it0.A.get('.env')!.oid, await blob(p, 'KEY=2\n'), '.env') })),
    };
    // A record carrying a guard outside Table 3 (written by a newer daemon, R3-09).
    const unkId = '01ARZ3NDEKTSV4RRFFQ69G5FZZ';
    const base = p.core.holds.get(id.eol)!;
    await plantRecord(p, {
      ...base, id: unkId, rev: 1, paths: [at('unk')], blobs: pair(a, await blob(p, t9([9, 'u'])), at('unk')),
      guards: [{ name: 'future-guard', class: 'DECISION', owner: 'HLD' }], origin: 'human',
    });
    assert.equal(p.core.holds.get(id.env)!.local_only, true, 'the .env record is local_only (secret-like)');
    await landHoldOps(fx, p);
    const it = await prepIt(p, { forceFetch: true, holdPaths: [...ROWS.map(at), '.env'] });
    const run = (rid: string, verb: Parameters<typeof resolve>[3]): Promise<ResolveResult> => resolve(p.core, it, rid, verb, HUMAN);
    const masked = t9([6, 'six']);   // r's step-5 MASK result: the human's line 6 stays, the held line 2 goes

    // ON_DISK revert PATCH: --discard writes the MASK result; --park the same, OFF_DISK PARKED; --handoff is refused.
    assert.deepEqual(await run(id.rev_dis, 'discard'), done('RESOLVED_DISCARD', id.rev_dis));
    assert.equal(await disk(p, at('rev_dis')), masked);
    assert.equal(p.core.holds.get(id.rev_dis)!.state, 'RESOLVED_DISCARD');
    assert.deepEqual(await run(id.rev_park, 'park'), done('HOLD_PARKED', id.rev_park));
    assert.equal(await disk(p, at('rev_park')), masked);
    assert.deepEqual(shape(p.core.holds.get(id.rev_park)), ['OFF_DISK', 'PARKED', 'none', ['revert']]);
    assert.deepEqual(p.core.holdCode?.code, 'HOLD_PARKED');
    assert.deepEqual(await run(id.rev_hand, 'handoff'), { kind: 'refused', code: 'HOLD_NOT_OFFERABLE', params: { hid: id.rev_hand } });
    assert.deepEqual(shape(p.core.holds.get(id.rev_hand)), ['ON_DISK', 'ACTIVE', 'none', ['revert']]);

    // PARKED revert → --restore: ON_DISK ACTIVE, the PARKED displacement released, every other guard kept.
    assert.deepEqual(await run(id.parked_rev, 'restore'), done('HOLD_RESTORED', id.parked_rev));
    assert.deepEqual(shape(p.core.holds.get(id.parked_rev)), ['ON_DISK', 'ACTIVE', 'none', ['revert']]);
    assert.equal(await disk(p, at('parked_rev')), t9([2, 'two']));

    // OFF_DISK CONFLICTED K4 → --restore: ON_DISK, `conflict` released; --discard: state only.
    assert.deepEqual(await run(id.k4_res, 'restore'), done('HOLD_RESTORED', id.k4_res));
    assert.deepEqual(shape(p.core.holds.get(id.k4_res)), ['ON_DISK', 'ACTIVE', 'none', []]);
    assert.equal(await disk(p, at('k4_res')), t9([3, 'mine']));
    assert.deepEqual(await run(id.k4_dis, 'discard'), done('RESOLVED_DISCARD', id.k4_dis));
    assert.equal(p.core.holds.get(id.k4_dis)!.state, 'RESOLVED_DISCARD');
    assert.equal(await disk(p, at('k4_dis')), T9, 'an OFF_DISK discard writes nothing');

    // ON_DISK join PIN: --publish releases; --discard writes A[p]; --park parks after the held-side refresh.
    assert.deepEqual(await run(id.join_pub, 'publish'), done('RESOLVED_PUBLISH', id.join_pub));
    assert.deepEqual(shape(p.core.holds.get(id.join_pub)), ['ON_DISK', 'ACTIVE', 'none', []]);
    assert.ok(p.core.holds.local().explicit.includes(id.join_pub));
    assert.deepEqual(await run(id.join_dis, 'discard'), done('RESOLVED_DISCARD', id.join_dis));
    assert.equal(await disk(p, at('join_dis')), T9);
    assert.deepEqual(await run(id.join_park, 'park'), done('HOLD_PARKED', id.join_park));
    const jp = p.core.holds.get(id.join_park)!;
    assert.deepEqual(shape(jp), ['OFF_DISK', 'PARKED', 'none', ['join']]);
    assert.equal('h1' in jp.blobs ? jp.blobs.h1[at('join_park')] : null, await blob(p, t9([4, 'j'])), 'the held side was refreshed from the disk first');
    assert.equal(await disk(p, at('join_park')), T9);

    // INCOMING lock: --publish HOLD_GUARDS_REMAIN, --park HOLD_NOT_PARKABLE, --handoff HOLD_NOT_OFFERABLE, --discard ends it.
    assert.deepEqual(await run(id.lock, 'publish'), { kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid: id.lock, guards: ['lock'] } });
    assert.deepEqual(await run(id.lock, 'park'), { kind: 'refused', code: 'HOLD_NOT_PARKABLE', params: { hid: id.lock } });
    assert.deepEqual(await run(id.lock, 'handoff'), { kind: 'refused', code: 'HOLD_NOT_OFFERABLE', params: { hid: id.lock } });
    assert.deepEqual(shape(p.core.holds.get(id.lock)), ['ON_DISK', 'ACTIVE', 'none', ['lock']]);
    assert.deepEqual(await run(id.lock, 'discard'), done('RESOLVED_DISCARD', id.lock));
    assert.equal(p.core.holds.get(id.lock)!.state, 'RESOLVED_DISCARD');
    assert.equal(await disk(p, at('lock')), T9);

    // ON_DISK eol-bom PATCH: a PREDICATE remains; --discard writes A[p] (a whole-path guard).
    assert.deepEqual(await run(id.eol, 'publish'), { kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid: id.eol, guards: ['eol-bom'] } });
    assert.deepEqual(await run(id.eol, 'discard'), done('RESOLVED_DISCARD', id.eol));
    assert.equal(await disk(p, at('eol')), T9);

    // ON_DISK host-reject PIN: released only by resume (Table 3); --discard writes A[p].
    assert.deepEqual(await run(id.hrej, 'publish'), { kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid: id.hrej, guards: ['host-reject'] } });
    assert.deepEqual(await run(id.hrej, 'discard'), done('RESOLVED_DISCARD', id.hrej));
    assert.equal(await disk(p, at('hrej')), T9);

    // A local_only record (.env restart record): never parked; --discard writes A[p] and its op is a stub.
    assert.deepEqual(await run(id.env, 'park'), { kind: 'refused', code: 'HOLD_NOT_PARKABLE', params: { hid: id.env } });
    assert.deepEqual(await run(id.env, 'discard'), done('RESOLVED_DISCARD', id.env));
    assert.equal(await disk(p, '.env'), 'KEY=1\n');
    const stub = p.core.outbox.pendingHold(id.env);
    assert.ok(stub !== null);
    assert.deepEqual([stub.state, stub.local_only, stub.paths], ['RESOLVED_DISCARD', true, ['.env']], 'a content-free stub');

    // A guard outside Table 3: every verb refused HOLD_GUARDS_REMAIN naming it (R3-09), nothing changed.
    for (const verb of ['publish', 'discard', 'park', 'restore', 'handoff'] as const) {
      assert.deepEqual(await run(unkId, verb), { kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid: unkId, guards: ['future-guard'] } }, verb);
    }
    assert.equal(p.core.holds.get(unkId)!.rev, 1);
    assert.equal(await disk(p, at('unk')), t9([9, 'u']));

    // ON_DISK revert PATCH --publish (on peer 1): no write, guards [], explicit, the path in the human CS; RESOLVED_PUBLISH once the
    // publish lands and R1 runs.
    const q = fx.peers[1]!;
    await revertRow(q, at('pub'));
    const qit = await prepIt(q, { materialize: false });
    const pub = await q.core.holds.hold(nr({ paths: [at('pub')], blobs: pair(qit.A.get(at('pub'))!.oid, await blob(q, t9([2, 'two'])), at('pub')) }));
    // The CS that saw the edit closes and is captured (the record masks line 2 there): the path is in no open CS any more.
    fx.advance(25_000);
    await captureReady(q, await prep(q, true));
    assert.equal(q.core.cs.openPaths().has(at('pub')), false, 'precondition: no open CS holds the path');
    const head = q.core.holds.head();
    assert.deepEqual(await resolve(q.core, await prepIt(q, { holdPaths: [at('pub')] }), pub, 'publish', HUMAN), done('RESOLVED_PUBLISH', pub));
    assert.notEqual(q.core.holds.head(), head);
    assert.equal(await disk(q, at('pub')), t9([2, 'two'], [6, 'six']), 'no write');
    assert.deepEqual(shape(q.core.holds.get(pub)), ['ON_DISK', 'ACTIVE', 'none', []]);
    assert.ok(q.core.holds.local().explicit.includes(pub), 'local.explicit has it');
    assert.ok(q.core.cs.openPaths().has(at('pub')), 'its path is in the open human CS');
    await captureAndLand(fx, q);
    assert.equal(q.core.holds.get(pub)!.state, 'RESOLVED_PUBLISH', 'R1 ends it RESOLVED_PUBLISH, not SUBSUMED');
  });
});

/** A SHADOW (a PATCH carrying `claim:…`) or a PIN carrying `claim:…`: the shapes Table 4's --handoff applies to. */
function isShadowShape(r: HoldRecord): boolean {
  return (r.kind === 'PATCH' || r.kind === 'PIN') && r.guards.some((g) => guardName(g) === 'claim');
}

/** The peer's registry (a short name for the table's hold() calls). */
function core(p: PeerFixture): PeerFixture['core']['holds'] {
  return p.core.holds;
}

/** One revert record of peer `p` over `path`, mirrored and landed. */
async function mirroredRevert(fx: CoreFixture, p: PeerFixture, path: string): Promise<string> {
  await revertRow(p, path);
  const it = await prepIt(p, { materialize: false });
  const id = await p.core.holds.hold(nr({ paths: [path], blobs: pair(it.A.get(path)!.oid, await blob(p, t9([2, 'two'])), path) }));
  await landHoldOps(fx, p);
  return id;
}

/** Disk, registry head, record and outbox of `p` (the "nothing changed" snapshot). */
async function snapshotOf(p: PeerFixture, id: string, path: string): Promise<unknown> {
  return { disk: await disk(p, path), head: p.core.holds.head(), rec: p.core.holds.get(id) ?? null, outbox: JSON.stringify(p.core.outbox.toJson()) };
}

test('HLD-57 (a): a record owned by another peer is refused HOLD_NOT_OWNER with nothing changed, and an id neither the registry nor the fold names is refused HOLD_NOT_OWNER', T10, async () => {
  await withCores('resolve-owner', { n: 2, files: FILES }, async (fx) => {
    const [p, q] = [fx.peers[0]!, fx.peers[1]!];
    await joinOnBoard(fx, q);
    const theirs = await mirroredRevert(fx, q, at('rev_dis'));
    const it = await prepIt(p, { forceFetch: true, holdPaths: [at('rev_dis')] });
    assert.equal(it.fold.holds[theirs]?.owner, q.core.peerId, 'peer 0 folds peer 1\'s record');
    const before = await snapshotOf(p, theirs, at('rev_dis'));
    for (const verb of ['publish', 'discard', 'park', 'restore', 'handoff'] as const) {
      assert.deepEqual(await resolve(p.core, it, theirs, verb, HUMAN), { kind: 'refused', code: 'HOLD_NOT_OWNER', params: { hid: theirs } }, verb);
    }
    assert.deepEqual(await snapshotOf(p, theirs, at('rev_dis')), before, 'nothing changed');
    const nobody = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    assert.deepEqual(await resolve(p.core, it, nobody, 'discard', HUMAN), { kind: 'refused', code: 'HOLD_NOT_OWNER', params: { hid: nobody } });
    // Peer 1's own resolve of its record goes through.
    const qit = await prepIt(q, { forceFetch: true, holdPaths: [at('rev_dis')] });
    assert.equal((await resolve(q.core, qit, theirs, 'park', HUMAN)).kind, 'done');
  });
});

test('HLD-57 (b): a record whose folded state is terminal, or whose folded offer is accepted, is a no-op HOLD_ALREADY_RESOLVED with the registry head, the disk and the outbox unchanged', T10, async () => {
  await withCores('resolve-folded', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    // Accepted: an ordinary record (offer none) through born_leftover, handoff, accepted (test-only, R3-06), mirrored and folded.
    const acc = await mirroredRevert(fx, p, at('rev_dis'));
    for (const ev of ['born_leftover', 'handoff', 'accepted'] as const) assert.ok((await p.core.holds.offerEvent(acc, ev)) !== null, ev);
    await landHoldOps(fx, p);
    // Folded terminal while this registry still holds the record non-terminal: a board op of the record (a valid prev_rev) ends it.
    const term = await mirroredRevert(fx, p, at('rev_park'));
    const it1 = await prep(p);
    const r = p.core.holds.get(term)!;
    const f = it1.fold.holds[term]!;
    await plantOwn(fx, p, it1, (op) => [opLine(op(0), {
      type: 'hold', hold_id: term, rev: f.rev + 1, prev_rev: f.rev, kind: r.kind, residence: null, state: 'RESOLVED_DISCARD', offer: r.offer,
      guards: r.guards, paths: r.paths, origin: r.origin, cs_ids: r.cs_ids, peer_authors: r.peer_authors, local_only: r.local_only,
    })]);
    const it = await prepIt(p, { forceFetch: true, holdPaths: [at('rev_dis'), at('rev_park')] });
    assert.equal(it.fold.holds[acc]?.offer, 'accepted');
    assert.equal(it.fold.holds[term]?.state, 'RESOLVED_DISCARD');
    assert.equal(p.core.holds.get(term)!.state, 'ACTIVE', 'the registry still holds it ACTIVE');
    for (const [rid, path] of [[acc, at('rev_dis')], [term, at('rev_park')]] as const) {
      const before = await snapshotOf(p, rid, path);
      for (const verb of ['publish', 'discard', 'park', 'restore', 'handoff'] as const) {
        assert.deepEqual(await resolve(p.core, it, rid, verb, HUMAN), done('HOLD_ALREADY_RESOLVED', rid), `${rid} ${verb}`);
      }
      assert.deepEqual(await snapshotOf(p, rid, path), before, 'registry head, disk and outbox unchanged');
    }
  });
});

test('HLD-57 (c): the resolve\'s hold op carries prev_rev by mirrorSync\'s rule — the folded rev, or the rev of r\'s newest allocated pending op while one is in flight — replacing a still-pending unallocated draft of the record; a forged op of the record with a stale prev_rev folds as a no-op', T10, async () => {
  await withCores('resolve-prev-rev', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const id = await mirroredRevert(fx, p, at('rev_park'));
    let it = await prepIt(p, { forceFetch: true, holdPaths: [at('rev_park')] });
    const folded1 = it.fold.holds[id]!.rev;
    // A still-pending unallocated draft of the record (a new guard, mirrored), then the resolve: one draft, prev_rev = the folded rev.
    await p.core.holds.addGuard(id, 'claim-breach');
    assert.deepEqual((await mirrorSync(p.core, it)).drafted, [id]);
    const draft = p.core.outbox.pendingHold(id)!;
    assert.deepEqual([draft.prev_rev, p.core.outbox.allocatedHold(id)], [folded1, null], 'precondition: an unallocated draft');
    assert.deepEqual(await resolve(p.core, it, id, 'park', HUMAN), done('HOLD_PARKED', id));
    const rec = p.core.holds.get(id)!;
    const d = p.core.outbox.pendingHold(id)!;
    assert.deepEqual([d.rev, d.prev_rev, d.residence, d.state], [rec.rev, folded1, 'OFF_DISK', 'PARKED'], 'prev_rev = the folded rev');
    assert.ok(rec.rev > draft.rev);
    assert.equal(p.core.outbox.drafts().filter((x) => x.type === 'hold' && x.hold_id === id).length, 1, 'one draft: the unallocated one was replaced');
    // An allocated op in flight (its push rejected, kept with its seq): the next resolve chains on it.
    await fx.remote.rejectNext(1, 'transient-failed', '/board');
    assert.equal((await win(fx, p)).r.outcome, 'transient');
    const sent = p.core.outbox.allocatedHold(id);
    assert.ok(sent !== null, 'an allocated op is in flight');
    it = await prepIt(p, { forceFetch: true, holdPaths: [at('rev_park')] });
    assert.deepEqual(await resolve(p.core, it, id, 'discard', HUMAN), done('RESOLVED_DISCARD', id));
    const chained = p.core.outbox.pendingHold(id)!;
    assert.deepEqual([chained.rev, chained.prev_rev, chained.state], [p.core.holds.get(id)!.rev, sent.rev, 'RESOLVED_DISCARD'], 'prev_rev = the allocated op\'s rev');
    const landed = await win(fx, p, 31_000);
    assert.equal(landed.r.outcome, 'landed', JSON.stringify(landed.r));
    const it2 = await prep(p);
    assert.deepEqual([it2.fold.holds[id]!.rev, it2.fold.holds[id]!.state], [p.core.holds.get(id)!.rev, 'RESOLVED_DISCARD'], 'both ops folded in order');
    // A forged op with a stale prev_rev (HLD-10, R3-27) on a record folded at rev 2: the fold keeps rev 2.
    const other = await mirroredRevert(fx, p, at('rev_dis'));
    const pit = await prepIt(p, { forceFetch: true, holdPaths: [at('rev_dis')] });
    assert.deepEqual(await resolve(p.core, pit, other, 'park', HUMAN), done('HOLD_PARKED', other));
    await landHoldOps(fx, p);
    const fit = await prep(p);
    const foldedOther = fit.fold.holds[other]!;
    assert.equal(foldedOther.residence, 'OFF_DISK', 'precondition: the park folded');
    const o = p.core.holds.get(other)!;
    await plantOwn(fx, p, fit, (op) => [opLine(op(0), {
      type: 'hold', hold_id: other, rev: foldedOther.rev + 1, prev_rev: foldedOther.rev - 1, kind: o.kind, residence: 'ON_DISK', state: 'ACTIVE', offer: o.offer,
      guards: o.guards, paths: o.paths, origin: o.origin, cs_ids: o.cs_ids, peer_authors: o.peer_authors, local_only: o.local_only,
    })]);
    assert.deepEqual((await prep(p)).fold.holds[other], foldedOther, 'the forged op folded as a no-op');
  });
});

test('HLD-57 (d): a writer MISMATCH refuses HOLD_DISK_CHANGED with the record unchanged; a share-none lock returns {kind: \'locked\', paths} with nothing changed; a kept push intent refuses HOLD_DISK_CHANGED', T10, async () => {
  await withCores('resolve-writer', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    for (const row of ['rev_dis', 'rev_park']) await revertRow(p, at(row));
    const it0 = await prepIt(p, { materialize: false });
    const two = await blob(p, t9([2, 'two']));
    const dis = await p.core.holds.hold(nr({ paths: [at('rev_dis')], blobs: pair(it0.A.get(at('rev_dis'))!.oid, two, at('rev_dis')) }));
    const prk = await p.core.holds.hold(nr({ paths: [at('rev_park')], blobs: pair(it0.A.get(at('rev_park'))!.oid, two, at('rev_park')) }));
    const parked = await p.core.holds.hold(nr({ paths: [at('parked_rev')], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(it0.A.get(at('parked_rev'))!.oid, two, at('parked_rev')) }));
    const paths = [at('rev_dis'), at('rev_park'), at('parked_rev')];
    let it = await prepIt(p, { holdPaths: paths });

    // MISMATCH: the file changes between the decision and the writer's check.
    for (const [rid, verb] of [[dis, 'discard'], [prk, 'park']] as const) {
      const path = p.core.holds.get(rid)!.paths[0]!;
      const rec = p.core.holds.get(rid);
      p.fs.interpose('writeFileExclusive', '.new', async () => {
        await writeFile(workPath(p, path), t9([2, 'two'], [6, 'six'], [7, 'meanwhile']));
      });
      assert.deepEqual(await resolve(p.core, it, rid, verb, HUMAN), { kind: 'refused', code: 'HOLD_DISK_CHANGED', params: { hid: rid } }, verb);
      assert.deepEqual(p.core.holds.get(rid), rec, `${verb}: the record unchanged`);
      assert.deepEqual(p.core.holds.local().inflight, {}, `${verb}: no inflight entry left`);
      assert.equal(await disk(p, path), t9([2, 'two'], [6, 'six'], [7, 'meanwhile']), `${verb}: the newer edit kept`);
      await revertRow(p, path);
    }
    // A share-none holder on the target: {kind: 'locked', paths}, nothing changed (--park and --restore).
    it = await prepIt(p, { holdPaths: paths });
    for (const [rid, verb] of [[prk, 'park'], [parked, 'restore']] as const) {
      const path = p.core.holds.get(rid)!.paths[0]!;
      const rec = p.core.holds.get(rid);
      const before = await disk(p, path);
      const release = p.fs.holdLock(`${sep}${path.replace('/', sep)}`, 'share-none');
      try {
        assert.deepEqual(await resolve(p.core, it, rid, verb, HUMAN), { kind: 'locked', paths: [path] }, verb);
      } finally {
        release();
      }
      assert.deepEqual(p.core.holds.get(rid), rec, `${verb}: the record unchanged`);
      assert.equal(await disk(p, path), before, `${verb}: the disk unchanged`);
    }
    // A file the tick did not read (saved this instant: its 300 ms quiet period) has no current S_disk: its last one (here A[p], the
    // edit never read) would make the park target equal its pre-image — a "PARKED" that writes nothing and leaves the held line on disk.
    // Refused HOLD_DISK_CHANGED, nothing written; once the tick reads it, the same verb parks.
    const quiet = at('lock');
    await writeFile(workPath(p, quiet), t9([2, 'two'], [6, 'six']));
    const now = p.clock.wallMs() / 1_000;
    await utimes(workPath(p, quiet), now, now);
    const qid = await p.core.holds.hold(nr({ paths: [quiet], blobs: pair(it0.A.get(quiet)!.oid, two, quiet) }));
    it = await prepIt(p, { holdPaths: [...paths, quiet] });
    assert.ok(it.tick?.excluded.has(quiet), 'precondition: the tick did not read it');
    const recQ = p.core.holds.get(qid);
    assert.deepEqual(await resolve(p.core, it, qid, 'park', HUMAN), { kind: 'refused', code: 'HOLD_DISK_CHANGED', params: { hid: qid } });
    assert.deepEqual(p.core.holds.get(qid), recQ, 'the record stays ON_DISK');
    assert.equal(await disk(p, quiet), t9([2, 'two'], [6, 'six']));
    fx.advance(2_500);
    it = await prepIt(p, { holdPaths: [...paths, quiet] });
    assert.deepEqual(await resolve(p.core, it, qid, 'park', HUMAN), done('HOLD_PARKED', qid));
    assert.equal(await disk(p, quiet), t9([6, 'six']), 'read now: the park writes the MASK result');
    // A kept push intent: every disk-writing verb refuses HOLD_DISK_CHANGED before any write (R3-23).
    const view = p.core.view!;
    await p.core.commit({ intent: { kind: 'push', bnew: view.laB, c: null, lease_board: ABSENT, lease_code: ABSENT, cs_ids: [], writer_seq: 1, op_ids: [] }, t: new Map([['P', view.base]]) });
    for (const [rid, verb] of [[dis, 'discard'], [prk, 'park'], [parked, 'restore']] as const) {
      const rec = p.core.holds.get(rid);
      assert.deepEqual(await resolve(p.core, it, rid, verb, HUMAN), { kind: 'refused', code: 'HOLD_DISK_CHANGED', params: { hid: rid } }, verb);
      assert.deepEqual(p.core.holds.get(rid), rec);
    }
  });
});

test('HLD-57 (e): a --restore write is an observed change of the human CS: the next materialization creates no revert record for it and it publishes through the gate and T0', T10, async () => {
  await withCores('resolve-observed', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const path = at('k4_res');
    const ctl = at('k4_dis');
    // A teammate's line 3 on two paths (within retention: the provenance journal advances with the apply). The line is short enough
    // that restoring T9 is no > 50 % shrink (the shrink guard would hold the path back a tick).
    const TEAM_LINE = 'three by team';
    await fx.pushTeamChange({ [path]: buf(t9([3, TEAM_LINE])), [ctl]: buf(t9([3, TEAM_LINE])) });
    fx.advance(10_000);
    const itA = await prepIt(p, { forceFetch: true, materialize: true });
    await applyStep(p.core, itA);
    assert.equal(await disk(p, path), t9([3, TEAM_LINE]), 'the team version is on disk');
    const it0 = await prepIt(p, { materialize: true });
    const a = it0.A.get(path)!.oid;
    // This PC's held version removes the teammate's line (its base is the team version): restoring it is a revert of that line,
    // which the revert detector flags unless the write is observed.
    const k4 = await p.core.holds.hold(nr({ paths: [path], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(a, await blob(p, T9), a, path) }));
    const it = await prepIt(p, { holdPaths: [path] });
    assert.deepEqual(await resolve(p.core, it, k4, 'restore', HUMAN), done('HOLD_RESTORED', k4));
    assert.equal(await disk(p, path), T9, 'the held version is back on disk');
    const written = await blob(p, T9);
    assert.equal(p.core.observed.peek(path, written), true, 'the restore recorded its write (ObservedWrites)');
    // The control: the human removes the same teammate line on the other path by a plain save (unobserved, HLD-26).
    await writeWork(p, ctl, T9);
    // The next materialization: the restore's delta is consumed as observed (HLD-26 (b)): no revert record for it; the control's is one.
    fx.advance(3_000);
    const next = await prepIt(p, { materialize: true });
    assert.deepEqual([next.mat!.prevMap.get(path)?.oid, next.mat!.sDiskMap.get(path)?.oid], [a, written], 'precondition: the materialization sees the delta');
    const created = await revertStep(p.core, next);
    assert.equal(p.core.observed.peek(path, written), false, 'consumed by revertStep');
    const reverts = p.core.holds.nonTerminal().filter((x) => x.guards.some((g) => guardName(g) === 'revert'));
    assert.deepEqual(reverts.map((x) => x.paths), [[ctl]], 'a revert record for the unobserved save only');
    assert.deepEqual(created, reverts.map((x) => x.id));
    // ... and it publishes through the gate and T0 as the human CS's ordinary change; R1 then ends the record RESOLVED_PUBLISH.
    await captureAndLand(fx, p);
    const live = await p.core.repo.readTreeMap((await p.core.repo.readCommit((await prep(p)).tip)).tree);
    assert.equal(live.get(path)?.oid, written, 'the restored content published');
    assert.equal(live.get(ctl)?.oid, a, 'the control stays held (its revert record masks it)');
    assert.equal(p.core.holds.get(k4)!.state, 'RESOLVED_PUBLISH');
  });
});

test('HLD-58: under FREEZE(MASS) a human --park writes, while the Claude restore is refused HOLD_FROZEN', T10, async () => {
  await withCores('resolve-frozen', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await revertRow(p, at('rev_park'));
    const it0 = await prepIt(p, { materialize: true });
    const two = await blob(p, t9([2, 'two']));
    const prk = await p.core.holds.hold(nr({ paths: [at('rev_park')], blobs: pair(it0.A.get(at('rev_park'))!.oid, two, at('rev_park')) }));
    const mine = await p.core.holds.hold(nr({ paths: [at('k4_res')], residence: 'OFF_DISK', state: 'PARKED', guard: 'conflict', origin: SEAT, blobs: pair(it0.A.get(at('k4_res'))!.oid, two, at('k4_res')) }));
    await enterMass(p.core, it0, 'window');
    assert.ok(p.core.view!.meta.freeze_reasons.includes('MASS'));
    const it = await prepIt(p, { holdPaths: [at('rev_park'), at('k4_res')] });
    assert.deepEqual(await resolve(p.core, it, mine, 'restore', { actor: { seat: SEAT, agent: null }, humanEvidence: false }),
      { kind: 'refused', code: 'HOLD_FROZEN', params: { hid: mine } });
    assert.equal(await disk(p, at('k4_res')), T9, 'the Claude restore wrote nothing');
    assert.deepEqual(await resolve(p.core, it, prk, 'park', HUMAN), done('HOLD_PARKED', prk));
    assert.equal(await disk(p, at('rev_park')), t9([6, 'six']), 'the human park wrote under FREEZE');
  });
});

test('every refusal carries its 05 §1 next command', T10, () => {
  assert.equal(NEXT_COMMAND.HOLD_NOT_OWNER, '/cowork show <id>');
  assert.equal(NEXT_COMMAND.HOLD_RESTORE_CONFLICT, '/cowork show <id>');
  assert.equal(NEXT_COMMAND.HOLD_GUARDS_REMAIN, 'wait, cowork_request go-first, or --handoff');
  assert.equal(NEXT_COMMAND.HOLD_NOT_OFFERABLE, '/cowork resolve <id> --publish|--discard');
  assert.equal(NEXT_COMMAND.HOLD_DISK_CHANGED, 'repeat the command');
  assert.equal(NEXT_COMMAND.HOLD_FROZEN, '/cowork status');
  // The line the daemon subcommand prints carries that command (05 §1 "—": none). The runs through runDaemon are in
  // test/integration/daemon.resolve.test.ts ("prints every refusal it can reach").
  const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const printed = (code: ResolveRefusal): string => resolveLine({ kind: 'refused', code, params: { hid: id } }, id, 'again').line;
  const expect: Array<[ResolveRefusal, string | null]> = [
    ['HOLD_NOT_OWNER', `/cowork show ${id}`], ['HOLD_RESTORE_CONFLICT', `/cowork show ${id}`],
    ['HOLD_GUARDS_REMAIN', 'wait, cowork_request go-first, or --handoff'], ['HOLD_NOT_OFFERABLE', `/cowork resolve ${id} --publish|--discard`],
    ['HOLD_DISK_CHANGED', 'repeat the command'], ['HOLD_FROZEN', '/cowork status'], ['HOLD_NOT_PARKABLE', null],
  ];
  for (const [code, next] of expect) assert.equal(printed(code), `${code} {"hid":"${id}"}${next === null ? '' : ` next: ${next}`}`, code);
});

test('--handoff of a SHADOW or a claim PIN moves offer to offered with one mirrored op from the owner; revert, INCOMING, local_only, conflict, claim-breach, base-move, wake-scope and K7 t0 records are refused HOLD_NOT_OFFERABLE', T10, async () => {
  await withCores('resolve-handoff', { n: 2, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prepIt(p, { materialize: false });
    const a = (row: string): Oid => it0.A.get(at(row))!.oid;
    const held = async (k: number): Promise<Oid> => blob(p, t9([k, `held ${k}`]));
    const reg = p.core.holds;
    const claim = 'claim:abcdefghijklmnop';
    const shadow = await reg.hold(shadowRecord(claim, at('rev_dis'), a('rev_dis'), await held(1), SEAT));
    const claimPin = await reg.hold(pinCs(claim, [], [at('rev_park')], it0.A, { [at('rev_park')]: await held(2) }, SEAT, 'pending_leftover'));
    /** A SHADOW or claim PIN that also carries `guard` (added after its birth, as HLD-07 adds one): offerable by shape, refused by the guard. */
    const shadowWith = async (row: string, k: number, guard: string): Promise<string> => {
      const id = await reg.hold(shadowRecord(claim, at(row), a(row), await held(k), SEAT));
      await reg.addGuard(id, guard);
      return id;
    };
    const claimPinWith = async (row: string, k: number, guard: string): Promise<string> => {
      const id = await reg.hold(pinCs(claim, [], [at(row)], it0.A, { [at(row)]: await held(k) }, SEAT, 'pending_leftover'));
      await reg.addGuard(id, guard);
      return id;
    };
    const refusedIds: Array<[string, string]> = [
      ['revert', await reg.hold(nr({ paths: [at('rev_hand')], blobs: pair(a('rev_hand'), await held(3), at('rev_hand')) }))],
      ['INCOMING', await reg.hold(nr({ kind: 'INCOMING', guard: 'lock', origin: 'daemon', paths: [at('lock')], blobs: pair(a('lock'), await held(4), at('lock')) }))],
      ['conflict', await reg.hold(nr({ residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', paths: [at('k4_res')], blobs: pair(a('k4_res'), await held(5), at('k4_res')) }))],
      ['claim-breach', await reg.hold(nr({ residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'claim-breach', origin: 'daemon', paths: [at('k4_dis')], blobs: pair(a('k4_dis'), await held(6), at('k4_dis')) }))],
      ['base-move', await reg.hold(nr({ state: 'CONFLICTED', guard: 'base-move', origin: 'daemon', paths: [at('eol')], blobs: pair(a('eol'), await held(7), at('eol')) }))],
      ['wake-scope', await reg.hold(pinCs('wake-scope', [], [at('hrej')], it0.A, { [at('hrej')]: await held(8) }, 'wake', 'pending_leftover'))],
      ['K7 t0', await reg.hold(pinCs('t0', [], [at('unk')], it0.A, { [at('unk')]: await held(9) }, 'human', 'pending_leftover'))],
      // The shapes --handoff offers (a SHADOW, a claim PIN, offer pending_leftover) refused only by Table 4's "Refused when" column:
      // a local_only claim PIN (.env is secret-like) and SHADOWs / claim PINs that also carry revert, conflict, claim-breach,
      // base-move or wake-scope (HLD-66).
      ['local_only claim PIN', await reg.hold(pinCs(claim, [], ['.env'], it0.A, { '.env': await blob(p, 'KEY=9\n') }, SEAT, 'pending_leftover'))],
      ['SHADOW + revert', await shadowWith('h_rev', 10, 'revert')],
      ['SHADOW + conflict', await shadowWith('h_con', 11, 'conflict')],
      ['SHADOW + claim-breach', await shadowWith('h_cb', 12, 'claim-breach')],
      ['claim PIN + base-move', await claimPinWith('h_bm', 13, 'base-move')],
      ['claim PIN + wake-scope', await claimPinWith('h_ws', 14, 'wake-scope')],   // HLD-09's offerNext refuses it too (HLD-66)
    ];
    for (const [what, rid] of refusedIds.slice(-6)) {
      const r = reg.get(rid)!;
      assert.ok(isShadowShape(r) && r.offer === 'pending_leftover', `precondition: ${what} has an offerable shape`);
    }
    assert.equal(reg.get(refusedIds.find(([w]) => w === 'local_only claim PIN')![1])!.local_only, true, 'precondition: the .env claim PIN is local_only');
    await landHoldOps(fx, p);
    const it = await prepIt(p, { forceFetch: true });
    for (const [what, rid] of refusedIds) {
      const before = p.core.holds.get(rid);
      assert.deepEqual(await resolve(p.core, it, rid, 'handoff', HUMAN), { kind: 'refused', code: 'HOLD_NOT_OFFERABLE', params: { hid: rid } }, what);
      assert.deepEqual(p.core.holds.get(rid), before, `${what}: unchanged`);
    }
    const tip0 = await remoteTip(fx, p);
    for (const rid of [shadow, claimPin]) {
      assert.equal(p.core.holds.get(rid)!.offer, 'pending_leftover');
      assert.deepEqual(await resolve(p.core, it, rid, 'handoff', HUMAN), done('HOLD_OFFERED', rid));
      assert.equal(p.core.holds.get(rid)!.offer, 'offered');
    }
    const { r } = await win(fx, p);
    assert.equal(r.outcome, 'landed');
    const ops = (await holdOpsSince(p, tip0, r.bnew!)).map((x) => x.op);
    for (const rid of [shadow, claimPin]) {
      const mine = ops.filter((o) => o.hold_id === rid);
      assert.equal(mine.length, 1, 'one mirrored op');
      assert.equal(mine[0]!.offer, 'offered');
    }
    assert.ok(ops.every((o) => [shadow, claimPin].includes(o.hold_id)), 'no op for a refused record');
    assert.equal(makeGuard(claim).name, claim);
  });
});
