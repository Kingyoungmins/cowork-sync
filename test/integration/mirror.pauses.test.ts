// Hold mirrors under pauses (Plan 3 Task 4; glossary §8 FREEZE row and the VERSION regionSpec row; 02-protocol PRO-45; 05-holds
// F2, F6, HLD-10; Review Focus 4): `hold` ops ride board-only pushes under FREEZE and the regionSpec VERSION pause, wait queued
// (never dropped) under INCIDENT, NONRETRYABLE, OFFLINE and the proto VERSION pause, and a record created while the remote is
// unreachable is mirrored in the first window after reconnect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PushState } from '../../src/board/outbox.js';
import { publishStep } from '../../src/engine/publish.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { durableNow, holdOpsOf, holdPatch, remoteTip, win } from '../helpers/mirrorFixture.js';
import { buf, editAndCapture, failedResult, prep, pushCalls, withCores, wrapGit } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const P = 'src/t9.txt';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# mirror pauses fixture\n'),
  [P]: buf(T9),
  'src/a.txt': buf('a1\na2\na3\n'),
  'src/b.txt': buf('b1\nb2\nb3\n'),
};

test('hold ops ride board-only pushes under FREEZE and the regionSpec VERSION pause and wait under the others', T10, async () => {
  await withCores('mpause-states', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    // A ready pair waits too: under FREEZE no code goes, only the board-only op.
    await editAndCapture(fx, p, { 'src/b.txt': 'b1\nb2 local\nb3\n' });
    // FREEZE (MASS): a board-only push carries the op and no code.
    const frozen = await holdPatch(p, P, t9([4, 'frozen']));
    await p.core.commit({ meta: { ...p.core.view!.meta, freeze_reasons: ['MASS'] } });
    const f = await win(fx, p);
    assert.deepEqual(f.it.pushStates, ['frozen']);
    assert.equal(f.r.outcome, 'landed', JSON.stringify(f.r));
    assert.equal(f.r.c, null, 'no code under FREEZE');
    assert.deepEqual((await holdOpsOf(p, f.r.bnew!)).map((o) => o.hold_id), [frozen.id]);
    await p.core.commit({ meta: { ...p.core.view!.meta, freeze_reasons: [] } });
    // The regionSpec VERSION pause: the same.
    const version = await holdPatch(p, 'src/a.txt', 'a1\na2 version\na3\n');
    fx.advance(6_000);
    const vit = await prep(p);
    vit.pushStates = ['version_board_only'];
    const v = await publishStep(p.core, vit);
    assert.equal(v.outcome, 'landed', JSON.stringify(v));
    assert.equal(v.c, null);
    assert.deepEqual((await holdOpsOf(p, v.bnew!)).map((o) => o.hold_id), [version.id]);
    // INCIDENT, NONRETRYABLE, OFFLINE and the proto VERSION pause: zero push attempts, the draft still pending.
    const waiting = await holdPatch(p, P, t9([6, 'waits']));
    const pushes = pushCalls(p);
    const tip = await remoteTip(fx, p);
    for (const state of ['incident', 'nonretryable', 'offline', 'version_proto'] satisfies PushState[]) {
      fx.advance(6_000);
      const it = await prep(p);
      it.pushStates = [state];
      const r = await publishStep(p.core, it);
      assert.deepEqual([r.attempted, r.outcome], [false, 'skipped'], `${state}: ${JSON.stringify(r)}`);
      assert.equal(pushCalls(p), pushes, `${state}: zero push attempts`);
      assert.equal(p.core.outbox.pendingHold(waiting.id)?.hold_id, waiting.id, `${state}: queued, never dropped`);
    }
    assert.equal(await remoteTip(fx, p), tip);
    // The first window after the state clears lands the op (the ready pair publishes with it).
    const ok = await win(fx, p);
    assert.equal(ok.r.outcome, 'landed', JSON.stringify(ok.r));
    assert.ok((await holdOpsOf(p, ok.r.bnew!)).some((o) => o.hold_id === waiting.id));
    assert.equal(await durableNow(p, waiting.id), true);
  });
});

test('Review Focus 4: a record created while offline is mirrored in the first window after reconnect', T10, async () => {
  await withCores('mpause-offline', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prep(p);
    let offline = true;
    const restore = wrapGit(p, (args, opts, inner) => (offline && (args[0] === 'fetch' || args[0] === 'ls-remote') ? Promise.resolve(failedResult(128)) : inner(args, opts)));
    try {
      const { id } = await holdPatch(p, P, t9([4, 'offline held']));
      const tip = await remoteTip(fx, p);
      // 30 virtual minutes without a successful fetch: never durable, nothing pushed.
      for (let t = 0; t < 30; t++) {
        fx.advance(60_000);
        const it = await prep(p);
        assert.equal(it.fetched?.ok, false);
        const r = await publishStep(p.core, it);
        assert.equal(r.attempted, false, JSON.stringify(r));
        assert.equal(Object.hasOwn(it.fold.holds, id), false, 'never durable');
      }
      assert.equal(pushCalls(p), 0);
      assert.equal(await remoteTip(fx, p), tip);
      // Reconnect: the first window's Bnew carries its op; durable after that fold. The first fetch after reconnect waits out
      // the network backoff (30 s doubling to 5 min, ENG-19), so the first window comes 5 min after the last failed fetch.
      offline = false;
      const { r } = await win(fx, p, 301_000);
      assert.equal(r.outcome, 'landed', JSON.stringify(r));
      assert.deepEqual((await holdOpsOf(p, r.bnew!)).map((o) => [o.hold_id, o.prev_rev]), [[id, null]]);
      assert.equal(await durableNow(p, id), true);
    } finally {
      restore();
    }
  });
});
