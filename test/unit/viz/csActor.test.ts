// parseCsActor: the shared change-set id grammar (Plan 8a Task 2; 12 §9.7 item 4; ruling R-V07).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsActor } from '../../../src/board/csActor.js';
import { validId } from '../../../src/sec/validators.js';

const PEER = '0123456789abcdef0123456789abcdef';
const SEAT = 'fedcba9876543210fedcba9876543210';

test('parseCsActor accepts <peer>/human/<n> and <seat>/<turn-seq> and refuses near misses', () => {
  assert.deepEqual(parseCsActor(`${PEER}/human/1`), { kind: 'human', peer: PEER, n: 1 });
  assert.deepEqual(parseCsActor(`${PEER}/human/42`), { kind: 'human', peer: PEER, n: 42 });
  assert.deepEqual(parseCsActor(`${SEAT}/1`), { kind: 'seat', seat: SEAT, turnSeq: 1 });
  assert.deepEqual(parseCsActor(`${SEAT}/9007199254740991`), { kind: 'seat', seat: SEAT, turnSeq: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(parseCsActor(`${PEER}/human/9007199254740991`), { kind: 'human', peer: PEER, n: Number.MAX_SAFE_INTEGER });

  const misses = [
    `${PEER.slice(1)}/human/1`,                 // 31 hex
    `${PEER}0/human/1`,                         // 33 hex
    `${SEAT.slice(1)}/3`,
    `${SEAT}a/3`,
    `${PEER.toUpperCase()}/human/1`,            // upper case
    `${SEAT.toUpperCase()}/3`,
    `${PEER}/HUMAN/1`,
    `${PEER}/human/0`,                          // n = 0
    `${SEAT}/0`,
    `${PEER}/human/01`,                         // a leading zero
    `${SEAT}/007`,
    `${PEER}/human/1/2`,                        // an extra segment
    `${SEAT}/1/2`,
    `${SEAT}/human`,
    `${PEER}/human/9007199254740992`,           // beyond MAX_SAFE_INTEGER
    `${SEAT}/9007199254740993`,
    `${SEAT}/99999999999999999999`,
    `${PEER}/human/1 `,
    ` ${SEAT}/1`,
    `${SEAT}/+1`,
    `${SEAT}/1.0`,
    `${SEAT}/1e3`,
    `${PEER}/robot/1`,
    `${PEER}//1`,
    '',
    '/',
  ];
  for (const s of misses) assert.equal(parseCsActor(s), null, JSON.stringify(s));
  // Built on the validId('cs') grammar: everything parseCsActor accepts, validId accepts.
  for (const s of [`${PEER}/human/1`, `${SEAT}/1`]) assert.equal(validId('cs', s), true);
  // A non-string never parses.
  assert.equal(parseCsActor(42 as unknown as string), null);
});
