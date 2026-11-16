// A joiner frozen before its epoch's first board push, on real clones (ruling R3-EF4-3; 02-protocol §3.8 FREEZE row, §3.3 step 3b,
// PRO-16, PRO-45; 08-lifecycle §3.3 step 6.8; Plan 2 final review FC-7; 11-testing O-LIVE-RECORD; classes olive-record-portability-stub
// and olive-record-offdisk-conflict, meas-holds-3/35/38/53): peer 2 joins (its join op queued for its first board push), enters
// FREEZE(MASS) before that push, and records a local_only `portability` stub. Its first board push is board-only and carries the join
// first, the freeze event and the stub, so every fold records the epoch, the freeze and the record; before the ruling the join stayed
// queued and both other ops folded as generic no-ops (HOLD_MIRROR_REJECTED {generic}, the record off the board). Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBoardCommit } from '../../src/board/boardCommit.js';
import { parseOpId } from '../../src/board/ids.js';
import { parseOpLine, type Op } from '../../src/board/ops.js';
import { portabilityStep } from '../../src/engine/dataRecords.js';
import { enterMass } from '../../src/engine/detect.js';
import type { Oid } from '../../src/git/oid.js';
import { writeWork } from '../helpers/coreFixture.js';
import { prepIt, recordLog } from '../helpers/holdOpsFixture.js';
import { win } from '../helpers/mirrorFixture.js';
import { buf, prep } from '../helpers/publishHelpers.js';
import { startAll, withStart } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

/** A name D7 rule 2 refuses (portability.test.ts's): a reserved device name off win32, a 304-byte component on win32. */
const NAME = process.platform === 'win32' ? `${'\u{d55c}'.repeat(100)}.txt` : 'con.py';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# frozen joiner fixture\n'),
  'src/a.txt': buf('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n'),
};

test('a joiner that enters FREEZE(MASS) before its first board push sends its join first in that board-only push, so every fold records its epoch, its freeze event and its local_only portability stub (no generic rejection)', T10, async () => {
  await withStart('ef4-frozen-join', { n: 2, files: FILES }, async (fx) => {
    await startAll(fx);
    const [p0, p1] = [fx.peers[0]!, fx.peers[1]!];
    const epoch = p1.core.view!.meta.epoch;
    assert.deepEqual(p1.core.outbox.drafts().map((d) => d.type), ['join'], 'precondition: the join op waits for the first board push');
    const log = recordLog(p1);

    // FREEZE(MASS) before that push, entered the engine's way (one freeze event queued behind the join).
    const it0 = await prepIt(p1, { materialize: false });
    assert.equal(Object.hasOwn(it0.fold.peers, p1.core.peerId), false, 'precondition: no fold records the joiner yet');
    await enterMass(p1.core, it0, 'window', { paths: 1 });
    assert.deepEqual(p1.core.view!.meta.freeze_reasons, ['MASS']);
    assert.deepEqual(p1.core.outbox.drafts().map((d) => d.type), ['join', 'event']);

    // A non-portable new file: one local_only ON_DISK PATCH `portability` (its mirror is the content-free stub).
    await writeWork(p1, NAME, 'print(1)\n');
    fx.advance(2_500);
    const created = await portabilityStep(p1.core, await prepIt(p1, { materialize: false }));
    assert.equal(created.created.length, 1, JSON.stringify(created));
    const id = created.created[0]!;
    assert.equal(p1.core.holds.get(id)?.local_only, true, 'precondition: a local_only record');

    // Board-only windows under FREEZE until one lands.
    let bnew: Oid | null = null;
    for (let i = 0; i < 6 && bnew === null; i++) {
      const { it, r } = await win(fx, p1);
      assert.deepEqual(it.pushStates, ['frozen'], `window ${i}`);
      if (r.outcome === 'landed') {
        assert.equal(r.c, null, 'no code under FREEZE');
        bnew = r.bnew as Oid;
      }
    }
    assert.ok(bnew !== null, 'a board-only push of the frozen joiner landed');
    const ops = (await readBoardCommit(p1.core.repo, bnew)).opsLines.map((l) => parseOpLine(l)).filter((o): o is Op => o !== null);
    const own = ops.filter((o) => parseOpId(o.id)?.peer === p1.core.peerId);
    assert.equal(own[0]?.type, 'join', `the epoch's join leads its first board push (FC-7): ${JSON.stringify(own.map((o) => o.type))}`);
    assert.ok(own.every((o) => parseOpId(o.id)?.epoch === epoch), 'every op under the new epoch');
    assert.ok(own.some((o) => o.type === 'event' && o.kind === 'freeze' && o.reason_code === 'MASS'), 'the freeze event rides it');
    assert.ok(own.some((o) => o.type === 'hold' && o.hold_id === id && o.local_only), 'the stub rides it');
    assert.equal(p1.core.outbox.size, 0, 'nothing of the epoch is left queued');

    // The joiner's own fold: the epoch, the record; no own hold op folded as a no-op.
    const mine = await prep(p1);
    assert.equal(mine.fold.peers[p1.core.peerId]?.epoch, epoch, 'the joiner\'s fold records its epoch');
    assert.equal(Object.hasOwn(mine.fold.holds, id) ? mine.fold.holds[id]?.local_only : undefined, true, 'the joiner\'s fold holds the stub');
    assert.deepEqual(p1.core.folder.takeHoldRejections().filter((x) => x.holdId === id), [], 'no own hold rejection');
    assert.equal(Object.hasOwn(p1.core.holds.local().rejected, id), false, 'local.rejected does not name the record');
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_MIRROR_REJECTED'), [], 'HOLD_MIRROR_REJECTED is never raised');

    // The teammate's fold: the joiner's epoch, its freeze event and its record (O-LIVE-RECORD single).
    fx.advance(6_000);
    const theirs = await prep(p0);
    assert.equal(theirs.fold.peers[p1.core.peerId]?.epoch, epoch, 'the teammate\'s fold records the joiner\'s epoch');
    assert.equal(Object.hasOwn(theirs.fold.holds, id) ? theirs.fold.holds[id]?.local_only : undefined, true, 'the teammate\'s fold holds the stub');
    assert.ok(
      Object.values(theirs.fold.events).some((e) => e.kind === 'freeze' && e.reason_code === 'MASS' && parseOpId(e.op_id)?.peer === p1.core.peerId),
      'the teammate\'s fold holds the joiner\'s freeze event',
    );
  });
});
