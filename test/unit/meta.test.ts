import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBytes, type Json } from '../../src/board/canonicalJson.js';
import { parseOid } from '../../src/git/oid.js';
import { MetaTooNewError, parseMeta, serializeMeta, type Meta } from '../../src/engine/meta.js';

const O = (c: string): ReturnType<typeof parseOid> => parseOid(c.repeat(40));

/** Every 01-engine §3.2 field and every flagged Plan 2 field, each with a non-trivial value. */
function fullMeta(): Meta {
  return {
    v: 1, proto: 1,
    peer_id: '0123456789abcdef0123456789abcdef', epoch: 'fedcba9876543210fedcba9876543210', seq_next: 42,
    branch: 'feature/x', enc: 'feature%2Fx',
    pinned: { url: 'https://example.invalid/team/repo.git', identity: [O('1'), O('2')] },
    H_adopt: O('3'), EPOCH_BASE: O('4'),
    expected_epoch: { symref: 'refs/heads/feature/x', head: O('3'), stash: O('5') },
    freeze_reasons: ['EPOCH', 'INCIDENT'], config_detail: ['url', 'filter'],
    incident: { n: 2, observed_board: O('6'), observed_code: null },
    nonretryable: { lease: O('7'), hold_id: '01J9ZQ3V5W6X7Y8Z9A0B1C2D3E' },
    rejections: { lease: O('7'), n: 2 },
    throttle: { signal: 'http_429' },
    pending: { 'src/a.txt': 'locked', 'docs/\u{D55C}.md': 'mismatch' },
    displaced: ['89abcdef0123', 'aaaaaaaaaaaa'],
    fold_board: O('8'),
    fold_verified: { board: O('9'), height: 256 },
    checkpoint_mismatch: true,
    outbox: { entries: [{ draft: { type: 'leave' }, op: null }], nested: [1, 'two', null, true] },
    cs_human_next: 7,
    incident_next: 3,
  };
}

const META_KEYS = [
  // 01-engine §3.2
  'v', 'proto', 'peer_id', 'epoch', 'seq_next', 'branch', 'enc', 'pinned', 'H_adopt', 'EPOCH_BASE', 'expected_epoch',
  'freeze_reasons', 'config_detail', 'incident', 'nonretryable', 'rejections', 'throttle', 'pending', 'displaced',
  // Plan 2 additions (R-14, P2-FOLDPERSIST)
  'fold_board', 'fold_verified', 'checkpoint_mismatch', 'outbox', 'cs_human_next', 'incident_next',
].sort();

/** Every object key in the meta JSON outside the opaque outbox. */
function keysDeep(v: unknown, out: string[]): string[] {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      if (k !== 'outbox') keysDeep(x, out);
    }
  }
  return out;
}

function withField(m: Meta, key: string, value: Json | undefined): Buffer {
  const o = JSON.parse(serializeMeta(m).toString('utf8')) as Record<string, Json>;
  if (value === undefined) delete o[key];
  else o[key] = value;
  return canonicalBytes(o);
}

test('parseMeta and serializeMeta round-trip byte-stably with every 01-engine §3.2 field and no timestamp', () => {
  const m = fullMeta();
  const buf = serializeMeta(m);
  assert.equal(buf.toString('utf8'), canonicalBytes(m as unknown as Json).toString('utf8'), 'canonical JSON (RFC 8785)');
  assert.ok(buf[0] === 0x7b && !buf.includes(0x0a), 'no BOM, no whitespace, no trailing newline');
  const back = parseMeta(buf);
  assert.deepEqual(back, m);
  assert.ok(serializeMeta(back).equals(buf), 'serialize(parse(b)) == b');
  assert.deepEqual(Object.keys(back).sort(), META_KEYS);

  // The null/empty forms round-trip too.
  const quiet: Meta = {
    ...m, freeze_reasons: [], config_detail: [], incident: null, nonretryable: null, rejections: null, throttle: null,
    pending: {}, displaced: [], fold_board: null, fold_verified: null, checkpoint_mismatch: false, outbox: [],
    expected_epoch: { ...m.expected_epoch, stash: null },
  };
  assert.ok(serializeMeta(parseMeta(serializeMeta(quiet))).equals(serializeMeta(quiet)));
  assert.deepEqual(parseMeta(serializeMeta(quiet)), quiet);

  // No wall-clock or monotonic timestamp anywhere (ENG-05).
  for (const k of keysDeep(JSON.parse(buf.toString('utf8')), [])) {
    assert.doesNotMatch(k, /time|stamp|date|wall|mono|_ms$|_at$|since|until/i, `meta key ${k}`);
  }
  // ...and none can be added: an unknown field is refused, as is a missing one.
  assert.throws(() => parseMeta(withField(m, 'updated_wall_ms', 1_700_000_000_000)));
  assert.throws(() => parseMeta(withField(m, 'incident_next', undefined)));
  assert.throws(() => serializeMeta({ ...m, saved_at: 1 } as unknown as Meta));

  // Bytes another writer could have produced but serializeMeta never does are refused.
  const pretty = Buffer.from(JSON.stringify(m, null, 2), 'utf8');
  assert.throws(() => parseMeta(pretty));
  assert.throws(() => parseMeta(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf])));

  // Field checks (a sample per kind of field).
  const bad: Array<[string, Json]> = [
    ['proto', 2], ['peer_id', 'peer'], ['epoch', 'A'.repeat(32)], ['seq_next', 0], ['seq_next', 1.5],
    ['enc', 'feature/x'], ['H_adopt', 'abc'], ['EPOCH_BASE', null],
    ['freeze_reasons', ['EPOCH', 'EPOCH']], ['freeze_reasons', ['THROTTLE']], ['config_detail', ['host']],
    ['incident', { n: 0, observed_board: null, observed_code: null }],
    ['nonretryable', { lease: O('7'), hold_id: 'not-a-ulid' }],
    ['rejections', { lease: 'ABSENT', n: 1 }], ['throttle', { signal: 'THROTTLE' }],
    ['pending', { 'src/a.txt': 'later' }], ['pending', { '../x': 'locked' }],
    ['displaced', ['89abcdef012']], ['displaced', ['111111111111', '222222222222', '333333333333', '444444444444']],
    ['fold_board', 'ABSENT'], ['fold_verified', { board: O('9'), height: -1 }], ['checkpoint_mismatch', 0],
    ['cs_human_next', 0], ['incident_next', 0],
    ['pinned', { url: 'u', identity: ['x'] }], ['expected_epoch', { symref: 'HEAD', head: O('1') }],
  ];
  for (const [key, value] of bad) {
    assert.throws(() => parseMeta(withField(m, key, value)), Error, `${key} = ${JSON.stringify(value)}`);
  }
});

test('meta.v 2 throws MetaTooNewError', () => {
  const m = fullMeta();
  const v2 = withField(m, 'v', 2);
  assert.throws(() => parseMeta(v2), MetaTooNewError);
  // A newer schema may have other fields: v decides first.
  const o = JSON.parse(serializeMeta(m).toString('utf8')) as Record<string, Json>;
  o['v'] = 2;
  o['a_v2_field'] = { anything: true };
  delete o['pending'];
  assert.throws(() => parseMeta(canonicalBytes(o)), MetaTooNewError);
  assert.throws(() => parseMeta(Buffer.from('{"v":17}', 'utf8')), MetaTooNewError);
  // An older or malformed v is not "too new".
  for (const v of [0, 1.5, '2', null]) {
    assert.throws(() => parseMeta(withField(m, 'v', v)), (e: unknown) => e instanceof Error && !(e instanceof MetaTooNewError), `v = ${JSON.stringify(v)}`);
  }
  assert.ok(new MetaTooNewError('x') instanceof Error);
});
