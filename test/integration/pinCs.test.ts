// The whole-CS PIN and SHADOW constructors (Plan 3 Task 10; 05-holds HLD-46, HLD-47 constructors, HLD-03 LIVE-only rule, HLD-07;
// CS-33…CS-35; ruling R3-07): pinCs builds a PIN over the LIVE paths it is given (H0 = A, H1 = the given map), shadowRecord the K1
// SHADOW; both through the real registry on an EngineCore over a real clone, mirrored by the next publish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBoardCommit } from '../../src/board/boardCommit.js';
import { parseOpLine, type HoldOp } from '../../src/board/ops.js';
import { ensureAttrs } from '../../src/engine/core.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { pinCs, shadowRecord } from '../../src/holds/changesets.js';
import { guardName, setBlob, type BlobMap } from '../../src/holds/record.js';
import { readWork, writeWork } from '../helpers/coreFixture.js';
import { heldIn, win } from '../helpers/mirrorFixture.js';
import { buf, editAndCapture, prep, stateA, withCores } from '../helpers/publishHelpers.js';

const T10 = { timeout: 10 * 60_000 };
const CS1 = '0123456789abcdef0123456789abcdef/human/1';
const SEAT = 'a'.repeat(32);

const FILES: Record<string, Buffer> = {
  'README.md': buf('# pinCs fixture\n'),
  'src/a.py': buf('def a():\n    return 1\n'),
  'src/b.py': buf('def b():\n    return 2\n'),
  '.github/workflows/ci.yml': buf('on: push\n'),
  '.gitignore': buf('*.log\n'),
};

test('pinCs builds a PIN over the LIVE paths it is given with H0 = A, H1 = the given map, the guard, origin, cs_ids and offer; shadowRecord is an OFF_DISK PARKED PATCH with guard claim:<id>, offer pending_leftover and displaced_by null', T10, async () => {
  await withCores('pincs-shape', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const it = await prep(p);
    const A = await stateA(p);
    // The new path's attributes are asked for as a creator does (R3-71: an unclassified path's record is local_only).
    await ensureAttrs(p.core, it.epochBase, ['src/new.py']);
    const r1 = await p.core.repo.hashBytes(buf('def a():\n    return 10\n'), true);
    const created = await p.core.repo.hashBytes(buf('new\n'), true);
    const h1: BlobMap = {};
    setBlob(h1, 'src/a.py', r1);
    setBlob(h1, 'src/new.py', created);
    setBlob(h1, 'src/other.py', r1);   // a path the PIN is not given: not in the record
    const n = pinCs('claim:abcdefghij234567', [CS1, `${SEAT}/2`], ['src/new.py', 'src/a.py'], A, h1, SEAT, 'pending_leftover');
    assert.deepEqual(n, {
      kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/a.py', 'src/new.py'],
      blobs: { h0: { 'src/a.py': A.get('src/a.py')!.oid, 'src/new.py': ABSENT }, h1: { 'src/a.py': r1, 'src/new.py': created } },
      guard: 'claim:abcdefghij234567', origin: SEAT, cs_ids: [CS1, `${SEAT}/2`].sort(), displaced_by: null, offer: 'pending_leftover',
    });
    // The registry takes it as is: one record with that guard, offer and local_only false (both paths LIVE).
    const id = await p.core.holds.hold(n);
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.kind, r.residence, r.state, r.offer, r.local_only, r.guards.map(guardName)], ['PIN', 'ON_DISK', 'ACTIVE', 'pending_leftover', false, ['claim']]);
    assert.equal(r.guards[0]!.name, 'claim:abcdefghij234567');
    assert.deepEqual(r.cs_ids, [CS1, `${SEAT}/2`].sort());

    const shadow = shadowRecord('claim:abcdefghij234567', 'src/b.py', A.get('src/b.py')!.oid, r1, SEAT);
    assert.deepEqual(shadow, {
      kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: ['src/b.py'],
      blobs: { h0: { 'src/b.py': A.get('src/b.py')!.oid }, h1: { 'src/b.py': r1 } },
      guard: 'claim:abcdefghij234567', origin: SEAT, cs_ids: [], displaced_by: null, offer: 'pending_leftover',
    });
    const sid = await p.core.holds.hold({ ...shadow, cs_ids: [`${SEAT}/2`] });
    const s = p.core.holds.get(sid)!;
    assert.deepEqual([s.kind, s.residence, s.state, s.offer, s.displaced_by, s.guards.map((g) => g.name)], ['PATCH', 'OFF_DISK', 'PARKED', 'pending_leftover', null, ['claim:abcdefghij234567']]);
    // OFF_DISK: it masks nothing (INV-HLD-OFFDISK).
    assert.ok(!p.core.holds.maskingRecords().some((m) => m.id === sid));
  });
});

test('a CS editing src/a.py, .github/workflows/ci.yml (QUARANTINED) and .gitignore (SAVE_ONLY) pinned with pinCs over its LIVE paths records only src/a.py, and its op and held/ entries name only src/a.py', T10, async () => {
  await withCores('pincs-live', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const edits = { 'src/a.py': 'def a():\n    return 11\n', '.github/workflows/ci.yml': 'on: [push, pull_request]\n', '.gitignore': '*.log\n*.tmp\n' };
    const { pair, it } = await editAndCapture(fx, p, edits);
    const all = Object.keys(edits).sort();
    assert.equal(it.scope('.github/workflows/ci.yml').cls, 'QUARANTINED');
    assert.equal(it.scope('.gitignore').cls, 'SAVE_ONLY');
    const live = all.filter((q) => it.scope(q).cls === 'LIVE');
    assert.deepEqual(live, ['src/a.py']);
    const R = await p.core.repo.readTreeMap(pair.R);
    const h1: BlobMap = {};
    for (const q of all) setBlob(h1, q, R.get(q)?.oid ?? ABSENT);
    // A K3-shaped claim PIN (its PREDICATE fails closed under openGate, R3-07), so the group stays held across windows.
    const id = await p.core.holds.hold(pinCs('claim:abcdefghij234567', [pair.csId], live, it.A, h1, 'human', 'none'));
    const r = p.core.holds.get(id)!;
    assert.deepEqual(r.paths, ['src/a.py']);
    assert.equal(r.local_only, false);
    // The next publish window: the PIN holds the group (nothing of the CS publishes) and its op leaves board-only.
    const { r: pub } = await win(fx, p);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.equal(pub.c, null, 'no code: the PIN holds the whole group');
    assert.deepEqual(pub.mirrored, [id]);
    const ops = (await readBoardCommit(p.core.repo, pub.bnew! as Oid)).opsLines.map((l) => parseOpLine(l)).filter((o): o is HoldOp => o?.type === 'hold');
    assert.deepEqual(ops.map((o) => [o.hold_id, o.paths]), [[id, ['src/a.py']]]);
    const held = await heldIn(p, pub.bnew! as Oid, id);
    assert.deepEqual(held?.map((h) => [h.stage, h.path]), [['h0', 'src/a.py'], ['h1', 'src/a.py']]);
    // The other two stay on disk under MASK step 1: untouched.
    assert.equal((await readWork(p, '.github/workflows/ci.yml'))!.toString('utf8'), edits['.github/workflows/ci.yml']);
    assert.equal((await readWork(p, '.gitignore'))!.toString('utf8'), edits['.gitignore']);
    assert.equal((await readWork(p, 'src/a.py'))!.toString('utf8'), edits['src/a.py']);
  });
});

test('a second hold of the same pinCs (same paths and h1) attaches to the first record', T10, async () => {
  await withCores('pincs-attach', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, 'src/a.py', 'def a():\n    return 12\n');
    const it = await prep(p, true);
    const h1: BlobMap = {};
    setBlob(h1, 'src/a.py', it.mat!.sDiskMap.get('src/a.py')!.oid);
    const n = pinCs('t0', [CS1], ['src/a.py'], it.A, h1, 'human', 'none');
    const id = await p.core.holds.hold(n);
    const rev = p.core.holds.get(id)!.rev;
    const again = await p.core.holds.holdOutcome(n);
    assert.equal(again.id, id, 'one id (HLD-07)');
    assert.equal(again.created, false);
    assert.equal(p.core.holds.get(id)!.rev, rev, 'the same guard and cs_ids: nothing changes');
    // A repeat hit with another guard joins the same record (one more guard, one rev).
    const third = await p.core.holds.holdOutcome(pinCs('claim:abcdefghij234567', [CS1], ['src/a.py'], it.A, h1, 'human', 'none'));
    assert.equal(third.id, id);
    assert.deepEqual(p.core.holds.get(id)!.guards.map((g) => g.name), ['t0', 'claim:abcdefghij234567']);
    assert.equal(p.core.holds.nonTerminal().length, 1);
  });
});
