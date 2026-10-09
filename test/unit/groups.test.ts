import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { writeGroups, type DeferReason, type IncomingCs } from '../../src/holds/groups.js';

const PEER = '0123456789abcdef0123456789abcdef';
const O = (c: string): Oid => parseOid(c.repeat(40));
const cs = (n: number, paths: string[]): IncomingCs => ({ commit: O(String(n % 10)), csId: `${PEER}/human/${n}`, paths });
const set = (...ps: string[]): ReadonlySet<string> => new Set(ps);

test('write groups are connected components over shared paths; a deferred path defers its group with closure for the rest; other groups are unaffected', () => {
  // CS1–CS3 chain a–b–c–d (a fixed point, not one hop); CS4 is e–f; CS5 is g alone.
  const incoming = [cs(1, ['a', 'b']), cs(2, ['b', 'c']), cs(3, ['c', 'd']), cs(4, ['f', 'e']), cs(5, ['g'])];
  const applicable = set('a', 'b', 'c', 'd', 'e', 'f', 'g');

  const none = writeGroups(incoming, applicable, new Map());
  assert.deepEqual(none, { groups: [['a', 'b', 'c', 'd'], ['e', 'f'], ['g']], deferred: [] });

  // d is locked: its whole chain defers; d keeps its own reason, the rest is 'closure'; e–f and g still apply.
  const locked = writeGroups(incoming, applicable, new Map<string, DeferReason>([['d', 'locked']]));
  assert.deepEqual(locked.groups, [['e', 'f'], ['g']]);
  assert.deepEqual(locked.deferred, [{ paths: ['a', 'b', 'c'], reason: 'closure' }, { paths: ['d'], reason: 'locked' }]);

  // Two deferred paths with different reasons in one group, and a deferred singleton.
  const two = writeGroups(incoming, applicable, new Map<string, DeferReason>([['a', 'unstable'], ['c', 'unreadable'], ['g', 'disk_low']]));
  assert.deepEqual(two.groups, [['e', 'f']]);
  assert.deepEqual(two.deferred, [
    { paths: ['a'], reason: 'unstable' }, { paths: ['b', 'd'], reason: 'closure' }, { paths: ['c'], reason: 'unreadable' },
    { paths: ['g'], reason: 'disk_low' },
  ]);

  // Only applicable paths link CSs: x (not applicable, e.g. unmaterializable) does not join a–b with y–z.
  const viaX = writeGroups([cs(1, ['a', 'x']), cs(2, ['x', 'z'])], set('a', 'z'), new Map<string, DeferReason>([['a', 'locked']]));
  assert.deepEqual(viaX, { groups: [['z']], deferred: [{ paths: ['a'], reason: 'locked' }] });

  // A deferred path of W ∪ D that the caller left out of `applicable` still counts (D ⊆ W ∪ D).
  const dOnly = writeGroups([cs(1, ['a', 'b'])], set('a'), new Map<string, DeferReason>([['b', 'mismatch']]));
  assert.deepEqual(dOnly, { groups: [], deferred: [{ paths: ['a'], reason: 'closure' }, { paths: ['b'], reason: 'mismatch' }] });
});

test('a path of W in no incoming CS is a singleton group', () => {
  const r = writeGroups([cs(1, ['b', 'c'])], set('a', 'b', 'c', 'z'), new Map());
  assert.deepEqual(r, { groups: [['a'], ['b', 'c'], ['z']], deferred: [] });
  // A path in no CS that is deferred defers only itself.
  const d = writeGroups([cs(1, ['b', 'c'])], set('a', 'b', 'c'), new Map<string, DeferReason>([['a', 'race']]));
  assert.deepEqual(d, { groups: [['b', 'c']], deferred: [{ paths: ['a'], reason: 'race' }] });
  // No incoming CS at all (a commit without trailers is handed in as one CS by the caller): every path is its own group.
  assert.deepEqual(writeGroups([], set('q', 'p'), new Map()), { groups: [['p'], ['q']], deferred: [] });
});
