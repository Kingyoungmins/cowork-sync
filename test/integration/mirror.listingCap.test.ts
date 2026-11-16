// EF5 minors (BoardCapError carries the cap that tripped; 02-protocol §2.1 BOARD_FULL {records, cap}; PRO-06, R3-74): a publish
// whose held/ put the writer's held/ listing cap refuses (HELD_LISTING_MAX_BYTES, final review F13 r2 E-1) — a listing over 32 MiB
// while the §3.1 tree sum is far under 5 MB — opens the tree-cap episode with BOARD_FULL naming the listing cap, not the 5 MB tree
// cap the board has not reached. The board is planted by a synthetic teammate (tallBoard); git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_TREE_MAX_BYTES, HELD_LISTING_MAX_BYTES, type HeldBlob } from '../../src/board/boardCommit.js';
import type { Oid } from '../../src/git/oid.js';
import { holdPatch, win } from '../helpers/mirrorFixture.js';
import { buf, LogRecorder, prep, withCores } from '../helpers/publishHelpers.js';
import { tallBoard } from '../helpers/tallBoard.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const FILES: Record<string, Buffer> = { 'README.md': buf('# listing cap fixture\n'), 'src/a.txt': buf('a1\na2\na3\n') };
/** The teammate hold id whose wide held/ subtree brings the listing to just under the cap. */
const W = '01JA0000000000000000000003';

/** The listing of one held/<id>/ subtree as the readers and the writer count it: each blob entry's `held/<id>/<stage>/<path>` bytes. */
function listingOf(id: string, blobs: readonly HeldBlob[]): number {
  let n = 0;
  for (const b of blobs) n += Buffer.byteLength(`held/${id}/${b.stage}/${b.path}`, 'utf8');
  return n;
}

/**
 * h1 blobs under E-1's 4,015-byte prefix (16 directories of 250-byte names) whose subtree lists exactly `target` bytes: 4,057 bytes
 * a row, the remainder spread over the first names (each path stays under the 4,096-byte repo path cap).
 */
function blobsListing(x: Oid, target: number): HeldBlob[] {
  const dir = Array.from({ length: 16 }, (_, i) => String.fromCharCode(97 + i).repeat(250)).join('/');
  const at = (i: number, pad: number): HeldBlob => ({ stage: 'h1', path: `${dir}/f${String(i).padStart(5, '0')}${'x'.repeat(pad)}`, oid: x });
  const row = listingOf(W, [at(0, 0)]);
  const n = Math.floor(target / row);
  let extra = target - n * row;
  const out: HeldBlob[] = [];
  for (let i = 0; i < n; i++) {
    const pad = Math.min(extra, 70);
    extra -= pad;
    out.push(at(i, pad));
  }
  assert.equal(extra, 0, 'the remainder fits the names');
  assert.ok(out.every((b) => Buffer.byteLength(b.path, 'utf8') <= 4_096));
  assert.equal(listingOf(W, out), target);
  return out;
}

test('BOARD_FULL names HELD_LISTING_MAX_BYTES when the held/ listing cap refused the put, and the put waits like a tree-cap episode (EF5 minors)', T10, async () => {
  await withCores('mbudget-listing', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    const told = (code: string): unknown[] => log.lines.filter((l) => l.code === code).map((l) => l.params);
    const it = await prep(p);
    // A teammate's held/<W>/ lists 20 bytes under the cap (every reader still reads the board; its §3.1 sum is ~0.4 MB).
    const x = await p.core.repo.hashBytes(buf('x\n'), true);
    const h = it.fold.height + 1;
    await tallBoard(fx, p, it, h, new Map([[h, { put: new Map([[W, blobsListing(x, HELD_LISTING_MAX_BYTES - 20)]]) }]]), 'listing-cap/near');
    await prep(p);   // the fetch that reveals the planted tip anchors the governor
    // This peer's record puts held/<id>/h0/src/a.txt and held/<id>/h1/src/a.txt (2 × 44 listed bytes): the listing would pass the cap.
    const { id } = await holdPatch(p, 'src/a.txt', 'a1\na2 held\na3\n');
    const w = await win(fx, p, 10_000);
    assert.deepEqual(told('PUBLISH_BUILD_FAILED'), [], JSON.stringify(w.r));
    assert.ok(p.core.outbox.pendingHold(id) !== null && p.core.outbox.allocatedHold(id) === null,
      `the creation waits unallocated: ${JSON.stringify({ r: w.r, code: p.core.holdCode, pending: p.core.outbox.pendingHold(id), allocated: p.core.outbox.allocatedHold(id) })}`);
    const params = { records: String(w.it.fold.record_count), cap: String(HELD_LISTING_MAX_BYTES) };
    assert.notEqual(params.cap, String(BOARD_TREE_MAX_BYTES));
    assert.deepEqual(p.core.holdCode, { code: 'BOARD_FULL', params }, 'status names the listing cap that tripped');
    assert.deepEqual(told('BOARD_FULL'), [params], 'the log line too, once');
  });
});
