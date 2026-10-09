import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { base32c, formatOpId, H, newEpoch, newPeerId, parseOpId } from '../../src/board/ids.js';
import { seededRandom } from '../../src/ports/random.js';
import { validId } from '../../src/sec/validators.js';

const PEER = '0123456789abcdef0123456789abcdef';
const EPOCH = 'fedcba9876543210fedcba9876543210';
const OP7 = `${PEER}/${EPOCH}/7`;

test('H matches the golden vectors', () => {
  // Computed independently of this code base: Python hashlib.sha256 over utf8(x) + b'\x00' + utf8(y),
  // base64.b32encode (RFC 4648 bit order), '=' stripped, alphabet translated to Crockford
  // (0123456789ABCDEFGHJKMNPQRSTVWXYZ), first 8 characters.
  const vectors: Array<[string, string, string]> = [
    ['', '', 'DRT0Q77Z'],
    ['a', 'b', 'B6S73BGV'],
    ['ab', '', 'JTEANTSP'],
    ['', 'ab', '1F8XN6JZ'],
    [OP7, 'health', 'HSG8XN4D'],
    [OP7, 'freeze', '6YQV501D'],
    [`${PEER}/${EPOCH}/12`, `${PEER}/${EPOCH}/13`, '8B6YG3PF'],
    ['한글', 'é', 'CPQJ9ZC5'],
  ];
  for (const [x, y, want] of vectors) {
    assert.equal(H(x, y), want, `H(${JSON.stringify(x)}, ${JSON.stringify(y)})`);
    assert.match(H(x, y), /^[0-9A-HJKMNP-TV-Z]{8}$/);
  }
  // The 0x00 separator keeps (ab, '') and (a, b) apart; the arguments are ordered.
  assert.notEqual(H('ab', ''), H('a', 'b'));
  assert.notEqual(H('a', 'b'), H('b', 'a'));

  // base32c: MSB-first 5-bit groups over the byte stream, the last group zero-padded on the right, no '='.
  assert.equal(base32c(new Uint8Array([])), '');
  assert.equal(base32c(new Uint8Array([0xff])), 'ZW');
  assert.equal(base32c(new Uint8Array(5)), '00000000');
  assert.equal(base32c(Uint8Array.from({ length: 10 }, (_, i) => i)), '000G40R40M30E209');
  assert.equal(base32c(new Uint8Array([0xde, 0xad, 0xbe, 0xef])), 'VTPVXVR');
  const empty = createHash('sha256').update(Buffer.alloc(0)).digest();
  assert.equal(base32c(empty), 'WERC8GMRZGE196QVYK49JVXS4GKTWGF4CJDS6K54JPCHPY2JQ1AG');
  // H is the first 8 characters of base32c(sha256(x ‖ 0x00 ‖ y)).
  const ab = createHash('sha256').update(Buffer.from('a\0b', 'utf8')).digest();
  assert.equal(H('a', 'b'), base32c(ab).slice(0, 8));
});

test('formatOpId and parseOpId round-trip and reject malformed ids', () => {
  const peer = newPeerId(seededRandom('ids-test'));
  const r = seededRandom('ids-test');
  assert.equal(newPeerId(r), peer, 'seeded ids are reproducible');
  const epoch = newEpoch(r);
  for (const id of [peer, epoch]) {
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.ok(validId('hex128', id));
  }
  assert.notEqual(peer, epoch);

  for (const seq of [1, 7, 4812, Number.MAX_SAFE_INTEGER]) {
    const s = formatOpId({ peer, epoch, seq });
    assert.equal(s, `${peer}/${epoch}/${seq}`);
    assert.ok(validId('op', s), 'a minted op id passes validId');
    assert.deepEqual(parseOpId(s), { peer, epoch, seq });
  }

  const malformed = [
    '',
    'x',
    `${peer}/${epoch}`,
    `${peer}/${epoch}/`,
    `${peer}/${epoch}/0`,
    `${peer}/${epoch}/01`,
    `${peer}/${epoch}/-1`,
    `${peer}/${epoch}/1.5`,
    `${peer}/${epoch}/1e3`,
    `${peer}/${epoch}/ 1`,
    `${peer}/${epoch}/1 `,
    `${peer}/${epoch}/1/2`,
    `${peer}/human/1`,
    `${peer.toUpperCase()}/${epoch}/1`,
    `${peer.slice(1)}/${epoch}/1`,
    `${peer}/${epoch}/9007199254740992`,
    `${peer}/${epoch}/9007199254740993`,
    `${peer}/${epoch}/99999999999999999999`,
  ];
  for (const s of malformed) assert.equal(parseOpId(s), null, JSON.stringify(s));

  for (const bad of [
    { peer, epoch, seq: 0 },
    { peer, epoch, seq: -1 },
    { peer, epoch, seq: 1.5 },
    { peer, epoch, seq: Number.NaN },
    { peer, epoch, seq: Number.MAX_SAFE_INTEGER + 1 },
    { peer: peer.toUpperCase(), epoch, seq: 1 },
    { peer, epoch: `${epoch.slice(0, 16)}/${epoch.slice(17)}`, seq: 1 },
  ]) {
    assert.throws(() => formatOpId(bad), RangeError, JSON.stringify(bad));
  }
});
