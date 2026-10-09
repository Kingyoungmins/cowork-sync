import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { humanOnlyAttribution, PLAN2_REGION_SPEC, regionSpecId } from '../../src/engine/deps.js';

const sha256hex = (s: string): string => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

test('PLAN2_REGION_SPEC is regionSpecId of the three Plan 2 parts, lowercase hex', () => {
  const parts = ['FoldMapper/1', 'extent-convention/1', 'label-convention/1'];
  // Sorted by UTF-16 code units ('F' < 'e' < 'l'), joined by '\n', sha256, lowercase hex.
  const expected = sha256hex('FoldMapper/1\nextent-convention/1\nlabel-convention/1');
  assert.equal(PLAN2_REGION_SPEC, expected);
  assert.equal(regionSpecId(parts), expected);
  assert.match(PLAN2_REGION_SPEC, /^[0-9a-f]{64}$/);
  // The order of the parts does not matter; the input array is not reordered.
  const reversed = [...parts].reverse();
  assert.equal(regionSpecId(reversed), expected);
  assert.deepEqual(reversed, ['label-convention/1', 'extent-convention/1', 'FoldMapper/1']);
  // Any other part set is another id.
  assert.notEqual(regionSpecId(['FoldMapper/2', 'extent-convention/1', 'label-convention/1']), expected);
  assert.notEqual(regionSpecId(parts.slice(0, 2)), expected);
  assert.equal(regionSpecId([]), sha256hex(''));
  // A part holding the separator would make two part sets collide: refused.
  assert.throws(() => regionSpecId(['a\nb']));
});

test('humanOnlyAttribution: removal false, shrink true', () => {
  for (const p of ['src/a.txt', 'notes.md', 'deep/dir/x.bin']) {
    assert.equal(humanOnlyAttribution.removalAttributed(p), false);
    assert.equal(humanOnlyAttribution.shrinkAttributed(p), true);
  }
});
