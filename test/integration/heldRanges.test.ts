// Held ranges (Plan 3 Task 2; 05-holds HLD-21; I1, CS-51): per step-5 path, the stored-form 1-based inclusive S_disk rows of
// diff(MASK_PATCH(S_disk[p]), S_disk[p]), computed in-process from existing blobs (no `git diff -U0`, L-HOLD-STORES), with row
// content compared the way canon compares it (row 1's BOM and every line ending ignored, 03-data D1 step 4). Notation:
// test/helpers/maskFixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertP, assertSPub, heldRanges, maskEntries } from '../../src/holds/mask.js';
import { HoldOperatorError, RebaseCache } from '../../src/holds/rebase.js';
import { inputs, looseObjects, P, pair, record, T9, t9, t9Delete, t9Insert, tmap, withMaskRepo } from '../helpers/maskFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const BOM = '\u{FEFF}';

test('heldRanges lists the stored-form S_disk rows of each step-5 path', T10, async () => {
  await withMaskRepo('held-ranges', async (c) => {
    const a = await c.blob(T9);
    const A = tmap({ [P]: a });
    const cases: Array<[string, string, string, Array<readonly [number, number]>]> = [
      ['a held line two lines from an unheld edit', t9([2, 'two']), t9([2, 'two'], [6, 'six']), [[2, 2]]],
      ['a held insertion', t9Insert(4, 'x1', 'x2'), t9Insert(4, 'x1', 'x2'), [[5, 6]]],
      ['a held deletion: the zero-length range after S_disk row 2', t9Delete(3), t9Delete(3), [[3, 2]]],
      // r's change adds a BOM and changes line 2: the BOM is form, not row content (canon's comparison), so only row 2 is held.
      ['a held change with a BOM: rows compared without it', `${BOM}${t9([2, 'two'])}`, `${BOM}${t9([2, 'two'], [6, 'six'])}`, [[2, 2]]],
    ];
    for (const [what, held, disk, want] of cases) {
      const r = record(pair(a, await c.blob(held)));
      const sDisk = tmap({ [P]: await c.blob(disk) });
      const sPub = await maskEntries(c.repo, sDisk, inputs(A, [r]), new RebaseCache(c.repo, () => true));
      assert.deepEqual([...sPub.partial], [P], `${what}: a step-5 path`);
      const before = looseObjects(c.f);
      const callsBefore = c.calls.length;
      const ranges = await heldRanges(c.repo, sDisk, sPub);
      assert.deepEqual([...ranges.keys()], [P], what);
      assert.deepEqual(ranges.get(P), want, what);
      assert.deepEqual(looseObjects(c.f), before, `${what}: the loose-object count is unchanged by the call`);
      // assertSPub and assertP compute their rows in-process too.
      assert.deepEqual(await assertSPub(c.repo, sDisk, sPub, inputs(A, [r]), new RebaseCache(c.repo, () => true)), { ok: true }, what);
      assert.deepEqual(await assertP(c.repo, sPub.entries, inputs(A, [r])), { ok: true }, what);
      for (const call of c.calls.slice(callsBefore)) {
        assert.ok(!call.args.some((x) => x === '-U0' || x === '--unified=0' || x.startsWith('--unified')), `${what}: ${call.args.join(' ')}`);
      }
    }

    // CRLF rows (a stored CRLF file): the endings are ignored like canon's; the held row is row 2 alone.
    const crlf = (s: string): string => s.replace(/\n/g, '\r\n');
    const aC = await c.blob(crlf(T9));
    const rC = record(pair(aC, await c.blob(crlf(t9([2, 'two'])))));
    const dC = tmap({ [P]: await c.blob(crlf(t9([2, 'two'], [6, 'six']))) });
    const sC = await maskEntries(c.repo, dC, inputs(tmap({ [P]: aC }), [rC]), new RebaseCache(c.repo, () => true));
    assert.deepEqual((await heldRanges(c.repo, dC, sC)).get(P), [[2, 2]], 'CRLF rows');

    // A PIN path, a withheld path and an unguarded PATCH give no entry.
    const two = await c.blob(t9([2, 'two']));
    const paths = ['src/pin.txt', 'src/k4.txt', 'src/free.txt'];
    const A2 = tmap(Object.fromEntries(paths.map((p) => [p, a])));
    const sDisk = tmap(Object.fromEntries(paths.map((p) => [p, two])));
    const records = [
      record(pair(a, two, 'src/pin.txt'), { kind: 'PIN', paths: ['src/pin.txt'], guards: ['join'] }),
      record({ s1: { 'src/k4.txt': a }, s2: { 'src/k4.txt': two }, s3: { 'src/k4.txt': a } }, { paths: ['src/k4.txt'], state: 'CONFLICTED', guards: ['conflict'] }),
      record(pair(a, two, 'src/free.txt'), { paths: ['src/free.txt'], guards: [] }),
    ];
    const sPub = await maskEntries(c.repo, sDisk, inputs(A2, records), new RebaseCache(c.repo, () => true));
    assert.deepEqual([...(await heldRanges(c.repo, sDisk, sPub)).keys()], []);
  });
});

test('heldRanges reports an unreadable S_disk blob as a HoldOperatorError, never a raw git error', T10, async () => {
  await withMaskRepo('held-ranges-corrupt', async (c) => {
    const a = await c.blob(T9);
    const r = record(pair(a, await c.blob(t9([2, 'two']))));
    const disk = t9([2, 'two'], [6, 'six'], [9, 'only in this test: corrupt me']);
    const d = await c.blob(disk);
    const sDisk = tmap({ [P]: d });
    const sPub = await maskEntries(c.repo, sDisk, inputs(tmap({ [P]: a }), [r]), new RebaseCache(c.repo, () => true));
    assert.deepEqual([...sPub.partial], [P]);
    const dir = join(c.f.paths.gitDir, 'objects', d.slice(0, 2));
    assert.ok(readdirSync(dir).includes(d.slice(2)), 'the S_disk blob is loose');
    const file = join(dir, d.slice(2));
    chmodSync(file, 0o644);
    writeFileSync(file, Buffer.from('this is not a zlib stream', 'utf8'));
    const err = await heldRanges(c.repo, sDisk, sPub).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof HoldOperatorError, `got ${String(err)}`);
    assert.equal(err.op, 'mask');
    assert.equal(err.path, P);
  });
});
