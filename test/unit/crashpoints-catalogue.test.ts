import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 11-testing §3.6, one entry per name (the adopt row is three names;
// registry.cas has two call sites but one name). Sorted by code unit.
const CATALOGUE_3_6 = [
  'adopt.index_renamed',
  'adopt.lock',
  'adopt.ref',
  'apply.between_groups',
  'apply.group.mid',
  'apply.group.phase1',
  'apply.group.phase2',
  'apply.intent',
  'apply.state',
  'deny.prerecord',
  'join.first_apply',
  'publish.landed',
  'publish.out_built',
  'publish.sent',
  'recover.displaced',
  'recover.reanchor',
  'registry.cas',
  'save.branch_pushed',
  'snapshot.index_written',
  'stop.flushed',
];

const raw = readFileSync(new URL('../crashpoints.json', import.meta.url));

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

test('crashpoints.json is the full §3.6 catalogue', () => {
  const parsed: unknown = JSON.parse(raw.toString('utf8'));
  assert.ok(Array.isArray(parsed));
  assert.deepEqual(parsed, CATALOGUE_3_6);
});

test('names are unique, sorted by code unit and well-formed', () => {
  const names = JSON.parse(raw.toString('utf8')) as string[];
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([...names].sort(byCodeUnit), names);
  for (const n of names) assert.match(n, /^[a-z]+(\.[a-z0-9_]+)+$/);
});

test('file is UTF-8 without BOM, LF only, with a trailing newline', () => {
  assert.notDeepEqual(raw.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal(raw.includes(0x0d), false);
  assert.equal(raw[raw.length - 1], 0x0a);
  assert.equal(raw.toString('utf8'), `${JSON.stringify(CATALOGUE_3_6, null, 2)}\n`);
});
