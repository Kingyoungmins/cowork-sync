// R4-24's claim id (Task 5): newClaimId is RFC 4648 base32, lowercase, unpadded, of 10 Random bytes — 16 characters
// of [a-z2-7], never Plan 2's Crockford base32c; no clock input; and the ClaimStore skeleton (R4-28, PRO-38): CS
// blocks, rejection memory and the empty drafts bookkeeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newClaimId, base32Of, ClaimStore } from '../../src/claims/store.js';
import type { Random } from '../../src/ports/random.js';
import { seededRandom } from '../../src/ports/random.js';
import { TableCache } from '../../src/regions/cache.js';
import { SnapshotStore } from '../../src/regions/snapshots.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const bytes = (b: Uint8Array): Random => ({ bytes: (n: number) => (n === b.length ? b : Buffer.alloc(n)) });
const ZERO10 = new Uint8Array(10);
const FF10 = new Uint8Array(10).fill(0xff);
// 'helloworld' in ASCII: 68 65 6c 6c 6f 77 6f 72 6c 64.
const HELLO = Uint8Array.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x77, 0x6f, 0x72, 0x6c, 0x64]);
// bytes 00 01 … 09.
const COUNT = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

test('newClaimId is RFC 4648 base32 lowercase of 10 Random bytes', T10, () => {
  assert.equal(newClaimId(bytes(ZERO10)), 'aaaaaaaaaaaaaaaa');
  assert.equal(newClaimId(bytes(FF10)), '7777777777777777');
  assert.equal(newClaimId(bytes(HELLO)), 'nbswy3dpo5xxe3de');
  assert.equal(newClaimId(bytes(COUNT)), 'aaaqeayeaudaocaj');
  // 0x01 at 10 bytes: the pad branch of base32Of (a low bits tail).
  assert.equal(base32Of(Uint8Array.from([0xff, 0xff])), '777q');
  assert.equal(base32Of(new Uint8Array(0)), '');
  // Exactly 10 bytes per call, and no clock: the Random port is newClaimId's one input (its one parameter).
  const reads: number[] = [];
  const counting: Random = { bytes: (n: number) => { reads.push(n); return new Uint8Array(n); } };
  newClaimId(counting);
  newClaimId(counting);
  assert.deepEqual(reads, [10, 10], 'one 10-byte read per id');
  assert.equal(newClaimId.length, 1, 'newClaimId(random) takes no clock');
});

test('1,000 ids from seededRandom(c) match ^[a-z2-7]{16}$, are distinct and repeat under the same seed', T10, () => {
  const r = seededRandom('c');
  const seen = new Set<string>();
  for (let i = 0; i < 1_000; i++) {
    const id = newClaimId(r);
    assert.match(id, /^[a-z2-7]{16}$/, `id ${i}: ${id}`);
    seen.add(id);
  }
  assert.equal(seen.size, 1_000, 'all 1,000 ids distinct');
  // The same byte stream from a fresh equal-seeded PRNG repeats the first id exactly.
  const replay = seededRandom('c');
  const first = newClaimId(seededRandom('c'));
  void replay;
  assert.equal(newClaimId(seededRandom('c')), first, 'the same seed repeats');
});

const store = (): ClaimStore => new ClaimStore(new SnapshotStore(), new TableCache(), seededRandom('store'));

test('the ClaimStore skeleton blocks CSs and remembers rejections', T10, () => {
  const s = store();
  s.blockCs('p/1', 'abcdefghij234567');
  assert.equal(s.blockedBy('p/1'), 'abcdefghij234567');
  assert.equal(s.blockedBy('p/2'), null);
  assert.deepEqual(s.blockedAll(), [['p/1', 'abcdefghij234567']]);
  assert.equal(s.unblockWhere((o) => o === 'abcdefghij234567'), undefined);   // void: nothing to answer
  assert.equal(s.blockedBy('p/1'), null);
  s.blockCs('p/1', 'abcdefghij234567');
  assert.equal(s.unblockWhere((o) => o === 'no-match'), undefined);
  assert.equal(s.blockedBy('p/1'), 'abcdefghij234567');
});

test('markRejected answers true once per (claim_id, reason)', T10, () => {
  const s = store();
  assert.equal(s.markRejected('abcdefghij234567', 'anchor'), true);
  assert.equal(s.markRejected('abcdefghij234567', 'anchor'), false);
  assert.equal(s.markRejected('abcdefghij234567', 'ranges'), true);
  assert.equal(s.markRejected('bbbbbbbbbbbbbbbb', 'anchor'), true);
  assert.deepEqual(s.drafts(), []);   // drafts stay empty until Task 11
});
