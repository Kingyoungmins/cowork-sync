// Final review F7 (Plan 3 Task 10; 05-holds HLD-38, HLD-40, HLD-49; ruling R3-44): a human CS whose own paths have all vanished (a file
// the human created and then deleted) closes in a group that holds a held PIN. It joins that PIN as a bundle like any closing CS —
// closed, its cs_id, bundled into the PIN, the PIN's h1 refreshed to ABSENT for the vanished path — instead of being "consumed" and
// left open: it is not due again while the PIN is held (no materialization and no state commit every iteration), a later unrelated edit
// opens a new CS that publishes on its own (it is not bundled into the PIN), and when the claim releases the group's recapture drops the
// deleted file from the older pair, so the held hunk publishes without resurrecting it. Round 2 D-2: the partly vanished case (the same
// CS edits k6.txt again and deletes src/new.txt) refreshes the PIN's h1 per path — ABSENT for the deleted file, the new disk blob for
// k6.txt. A scripted PublishGatePort stands in for B1. Real clones; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { applyStep } from '../../src/engine/apply.js';
import { captureDue, type IterationCtx } from '../../src/engine/core.js';
import { captureStep } from '../../src/engine/csStep.js';
import { recordStep } from '../../src/engine/holdSteps.js';
import { publishStep, type PublishReport } from '../../src/engine/publish.js';
import { ABSENT } from '../../src/git/oid.js';
import type { PublishGatePort } from '../../src/holds/ports.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { blobText, buf, editAndCapture, prep, remoteLiveCode, treeOf, withCores } from '../helpers/publishHelpers.js';

const T10 = { timeout: 10 * 60_000 };
const CLAIM = 'abcdefghij234567';
const K6 = 'k6.txt';
const NEW = 'src/new.txt';
const README = 'README.md';
const FILES: Record<string, Buffer> = { [README]: buf('# vanished bundle\n'), [K6]: buf(T9) };
const HUNK = t9([4, 'a human hunk in a foreign claim']);

const claimPins = (p: PeerFixture): HoldRecord[] => p.core.holds.nonTerminal().filter((r) => r.kind === 'PIN' && r.guards.some((g) => g.name === `claim:${CLAIM}`));

/** One loop's capture, apply, record (and publish) steps: whether captureDue held, whether the state ref moved, the publish report. */
async function iterate(fx: CoreFixture, p: PeerFixture, publish: boolean): Promise<{ it: IterationCtx; due: boolean; moved: boolean; pub: PublishReport | null }> {
  fx.advance(3_000);
  const before = p.core.view!.commit;
  const it = await prep(p, 'auto');
  const due = captureDue(p.core);
  await captureStep(p.core, it);
  const ap = await applyStep(p.core, it);
  await recordStep(p.core, it, ap);
  const moved = p.core.view!.commit !== before;
  const pub = publish ? await publishStep(p.core, it) : null;
  return { it, due, moved, pub };
}

test('final review F7: a closing CS whose paths all vanished joins the held PIN as a bundle — one capture commit, not one per loop; a later unrelated edit publishes on its own; the release publishes the held hunk without the deleted file', T10, async () => {
  let claimed = true;
  const gate: PublishGatePort = {
    gate: async (_repo, _tip, _A, _R, paths) => (claimed && paths.includes(K6) ? { block: { claimId: CLAIM } } : { block: null }),
    claimStillBlocks: async () => claimed,
  };
  await withCores('f7-vanished-bundle', { n: 1, files: FILES, ports: { gate } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    // CS1 edits k6.txt (inside a foreign claim) and creates src/new.txt; B1 pins the whole CS (K6).
    await editAndCapture(fx, p, { [K6]: HUNK, [NEW]: 'brand new file\n' });
    fx.advance(30_000);
    const it0 = await prep(p, 'auto');
    await captureStep(core, it0);
    const held = await publishStep(core, it0);
    assert.equal(held.c, null, 'the claim PIN holds the group');
    const pins = claimPins(p);
    assert.equal(pins.length, 1);
    const pin = pins[0]!;
    assert.deepEqual(pin.paths, [K6, NEW]);
    assert.ok('h1' in pin.blobs);
    assert.notEqual(pin.blobs.h1[NEW], ABSENT, 'precondition: the PIN holds the created file');
    const tableBefore = core.cs.table().cs.map((e) => e.cs_id);
    // The human deletes the new file: the deletion opens a human CS on NEW, which shares NEW with the PIN.
    await unlink(workPath(p, NEW));
    await prep(p);
    fx.advance(1_500);
    await prep(p);
    assert.deepEqual([...core.cs.openPaths()], [NEW]);
    fx.advance(25_000);
    // Six loops after its quiet period: the first bundles the CS (one capture commit); none is due or commits afterwards.
    const loops: Array<{ due: boolean; moved: boolean }> = [];
    for (let i = 0; i < 6; i++) {
      const l = await iterate(fx, p, false);
      loops.push({ due: l.due, moved: l.moved });
    }
    assert.deepEqual(loops, [{ due: true, moved: true }, ...Array.from({ length: 5 }, () => ({ due: false, moved: false }))], 'one capture commit, then nothing due');
    const csNew = core.cs.table().cs.find((e) => !tableBefore.includes(e.cs_id));
    assert.ok(csNew !== undefined, 'the CS got its cs_id');
    assert.deepEqual([csNew.paths, csNew.state], [[NEW], 'closed']);
    assert.equal(core.view!.ready.some((x) => x.csId === csNew.cs_id), false, 'no ready pair: it is bundled into the PIN');
    const joined = core.holds.get(pin.id)!;
    assert.ok('h1' in joined.blobs);
    assert.deepEqual(joined.paths, [K6, NEW], 'the PIN keeps its paths');
    assert.deepEqual(joined.cs_ids, [...pin.cs_ids, csNew.cs_id].sort(), 'cs_ids ∪');
    assert.equal(joined.blobs.h1[NEW], ABSENT, 'h1 refreshed from R: the file is gone');
    assert.equal(joined.blobs.h1[K6], pin.blobs.h1[K6], 'the held hunk is kept');
    // An unrelated human edit afterwards opens a new CS outside the PIN's group: it publishes on its own.
    await writeWork(p, README, '# vanished bundle, an unrelated human edit\n');
    await prep(p);
    fx.advance(25_000);
    let landed: PublishReport | null = null;
    for (let i = 0; i < 3 && landed === null; i++) {
      const l = await iterate(fx, p, true);
      if (l.pub?.outcome === 'landed' && l.pub.c !== null) landed = l.pub;
    }
    assert.ok(landed !== null, 'the unrelated edit published');
    const afterReadme = core.holds.get(pin.id)!;
    assert.deepEqual([afterReadme.paths, afterReadme.cs_ids], [joined.paths, joined.cs_ids], 'the PIN did not grow: README.md is not bundled into it');
    const live1 = await treeOf(p, await remoteLiveCode(fx, p));
    assert.equal(await blobText(p, live1, README), '# vanished bundle, an unrelated human edit\n');
    assert.equal(await blobText(p, live1, K6), T9, 'the held hunk is still held');
    assert.equal(live1.has(NEW), false);
    // The claim releases: the bundled CS is due, the group is re-captured (the older pair loses the deleted file) and the hunk publishes.
    claimed = false;
    let released: PublishReport | null = null;
    for (let i = 0; i < 6 && released === null; i++) {
      const l = await iterate(fx, p, true);
      if (l.pub?.outcome === 'landed' && l.pub.c !== null) released = l.pub;
    }
    assert.ok(released !== null, 'the held group published after the release');
    const live2 = await treeOf(p, await remoteLiveCode(fx, p));
    assert.equal(await blobText(p, live2, K6), HUNK, 'the held hunk published');
    assert.equal(live2.has(NEW), false, 'the deleted file is not resurrected');
    assert.equal(core.cs.table().cs.some((e) => e.cs_id === csNew.cs_id), false, 'the bundled CS left the table (nothing to publish)');
    assert.equal(captureDue(core), false);
  });
});

test('final review r2 D-2: a closing CS whose paths partly vanished (k6.txt edited again, src/new.txt deleted) joins the held PIN — h1[src/new.txt] is ABSENT, h1[k6.txt] the new disk blob; the release publishes the hunk without src/new.txt', T10, async () => {
  const HUNK2 = t9([4, 'a human hunk in a foreign claim'], [8, 'a second human hunk']);
  let claimed = true;
  const gate: PublishGatePort = {
    gate: async (_repo, _tip, _A, _R, paths) => (claimed && paths.includes(K6) ? { block: { claimId: CLAIM } } : { block: null }),
    claimStillBlocks: async () => claimed,
  };
  await withCores('d2-partly-vanished-bundle', { n: 1, files: FILES, ports: { gate } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    // CS1 edits k6.txt (inside a foreign claim) and creates src/new.txt; B1 pins the whole CS (K6).
    await editAndCapture(fx, p, { [K6]: HUNK, [NEW]: 'brand new file\n' });
    fx.advance(30_000);
    const it0 = await prep(p, 'auto');
    await captureStep(core, it0);
    const held = await publishStep(core, it0);
    assert.equal(held.c, null, 'the claim PIN holds the group');
    const pins = claimPins(p);
    assert.equal(pins.length, 1);
    const pin = pins[0]!;
    assert.deepEqual(pin.paths, [K6, NEW]);
    assert.ok('h1' in pin.blobs);
    assert.notEqual(pin.blobs.h1[NEW], ABSENT, 'precondition: the PIN holds the created file');
    const tableBefore = core.cs.table().cs.map((e) => e.cs_id);
    // One CS: another edit of k6.txt and the deletion of src/new.txt (only NEW vanished; k6.txt has new bytes).
    await writeWork(p, K6, HUNK2);
    await unlink(workPath(p, NEW));
    await prep(p);
    fx.advance(1_500);
    await prep(p);
    assert.deepEqual([...core.cs.openPaths()].sort(), [K6, NEW]);
    fx.advance(25_000);
    const loops: Array<{ due: boolean; moved: boolean }> = [];
    for (let i = 0; i < 4; i++) {
      const l = await iterate(fx, p, false);
      loops.push({ due: l.due, moved: l.moved });
    }
    assert.deepEqual(loops, [{ due: true, moved: true }, ...Array.from({ length: 3 }, () => ({ due: false, moved: false }))], 'one capture commit, then nothing due');
    const cs2 = core.cs.table().cs.find((e) => !tableBefore.includes(e.cs_id));
    assert.ok(cs2 !== undefined, 'the CS got its cs_id');
    assert.equal(core.view!.ready.some((x) => x.csId === cs2.cs_id), false, 'no ready pair: it is bundled into the PIN');
    const joined = core.holds.get(pin.id)!;
    assert.ok('h1' in joined.blobs);
    assert.deepEqual(joined.paths, [K6, NEW], 'the PIN keeps its paths');
    assert.deepEqual(joined.cs_ids, [...pin.cs_ids, cs2.cs_id].sort(), 'cs_ids ∪');
    assert.equal(joined.blobs.h1[NEW], ABSENT, 'h1[src/new.txt] refreshed from R: the file is gone');
    assert.equal(joined.blobs.h1[K6], await core.repo.hashBytes(buf(HUNK2), true), 'h1[k6.txt] is the new disk blob');
    // The claim releases: the group is re-captured (the older pair loses the deleted file) and the hunk publishes.
    claimed = false;
    let released: PublishReport | null = null;
    for (let i = 0; i < 6 && released === null; i++) {
      const l = await iterate(fx, p, true);
      if (l.pub?.outcome === 'landed' && l.pub.c !== null) released = l.pub;
    }
    assert.ok(released !== null, 'the held group published after the release');
    const live = await treeOf(p, await remoteLiveCode(fx, p));
    assert.equal(await blobText(p, live, K6), HUNK2, 'the hunk published with its second edit');
    assert.equal(live.has(NEW), false, 'the deleted file is not resurrected');
    assert.deepEqual(core.cs.table().cs, [], 'the CS table is empty');
    assert.equal(captureDue(core), false);
  });
});
