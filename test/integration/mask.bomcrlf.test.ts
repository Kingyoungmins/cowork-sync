// Review Focus 5 for MASK step 5 (Plan 3 Task 2; 05-holds HLD-13, §3.4 item 2; D-04): the reverse merge runs on stored-form
// blobs only, on a core.autocrlf=true clone, over the 1.3 MB BOM+CRLF fixture (Plan 1 generateBigBomCrlf, built as Plan 2's
// apply.bomcrlf test builds it) and over a cp949 file: only the unheld edited row reaches the output, every other byte (the BOM
// in row 1, the CR of every row) is X's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows } from '../../src/data/rows.js';
import { maskEntries } from '../../src/holds/mask.js';
import { RebaseCache } from '../../src/holds/rebase.js';
import { seededRandom } from '../../src/ports/random.js';
import { inputs, mergeCalls, pair, record, tmap, withMaskRepo, type MaskCtx } from '../helpers/maskFixture.js';
import { mergeSides } from '../helpers/mergeFileArgs.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';

/** `blob` with 1-based row n's content (its ending kept) replaced by `content`. */
function withRow(blob: Buffer, n: number, content: Buffer): Buffer {
  const rs = rows(blob);
  const row = rs[n - 1]!;
  const crlf = row.length >= 2 && row[row.length - 2] === 0x0d && row[row.length - 1] === 0x0a;
  const lf = !crlf && row.length >= 1 && row[row.length - 1] === 0x0a;
  const bom = n === 1 && row.length >= 3 && row[0] === 0xef && row[1] === 0xbb && row[2] === 0xbf;
  rs[n - 1] = Buffer.concat([bom ? row.subarray(0, 3) : Buffer.alloc(0), content, Buffer.from(crlf ? '\r\n' : lf ? '\n' : '', 'latin1')]);
  return Buffer.concat(rs);
}

/** Step 5 over (A, r holding row `held`, X = A with rows `held` and `edited` changed); the output must be A with row `edited` from X. */
async function check(c: MaskCtx, path: string, A0: Buffer, held: number, edited: number, heldRow: Buffer, editedRow: Buffer): Promise<void> {
  const a = await c.blob(A0);
  const h1 = await c.blob(withRow(A0, held, heldRow));
  const xBytes = withRow(withRow(A0, held, heldRow), edited, editedRow);
  const x = await c.blob(xBytes);
  const r = record(pair(a, h1, path), { paths: [path] });
  const before = c.calls.length;
  const out = await maskEntries(c.repo, tmap({ [path]: x }), inputs(tmap({ [path]: a }), [r]), new RebaseCache(c.repo, () => true));
  const got = await c.repo.readBlob(out.entries.get(path)!.oid);
  const want = withRow(A0, edited, editedRow);
  assert.ok(got.equals(want), `${path}: A with only row ${edited} edited`);
  const gr = rows(got);
  const xr = rows(xBytes);
  const ar = rows(A0);
  assert.equal(gr.length, xr.length);
  for (let i = 0; i < gr.length; i++) {
    if (i === held - 1) assert.ok(gr[i]!.equals(ar[i]!), `row ${held} is A's`);
    else assert.ok(gr[i]!.equals(xr[i]!), `row ${i + 1} is byte-identical to X's`);
  }
  // Stored form only: every merge-file input is one of the case's stored blobs (A, H1 — REBASE at A[p] = H0 gives H1 itself — and
  // X), every output is hashed by `hash-object --stdin --no-filters` (no --path, no filters, no working-tree read), and every input
  // and the output keep the CR of every row and the BOM: a filtered route on this core.autocrlf=true clone stores LF rows (another
  // blob, which `hash-object --path` shows).
  const calls = c.calls.slice(before);
  const merges = mergeCalls(calls);
  assert.ok(merges.length >= 1);
  const stored = new Set<string>([a, h1, x]);
  for (const m of merges) {
    assert.ok(!m.args.some((x2) => x2.startsWith('--path')), m.args.join(' '));
    for (const o of mergeSides(m.args)) assert.ok(stored.has(o), `${path}: merge-file input ${o} is a stored blob of the case`);
  }
  for (const h of calls.filter((k) => k.args[0] === 'hash-object')) {
    assert.ok(h.args.includes('--stdin') && h.args.includes('--no-filters') && !h.args.some((x2) => x2.startsWith('--path')), h.args.join(' '));
  }
  const crlfRows = (b: Buffer): boolean => rows(b).every((r) => r.length >= 2 && r[r.length - 2] === 0x0d && r[r.length - 1] === 0x0a);
  for (const o of [...stored, out.entries.get(path)!.oid]) {
    const bytes = await c.repo.readBlob(o as typeof a);
    assert.ok(crlfRows(bytes), `${path}: ${o} keeps the CR of every row`);
    assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), A0.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${path}: ${o} keeps A's BOM form`);
  }
  const filtered = (await c.repo.run(['hash-object', '--stdin', `--path=${path}`], { stdin: got })).stdout.toString('utf8').trim();
  assert.notEqual(filtered, out.entries.get(path)!.oid, `${path}: the output is not what a filtered route would store`);
}

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

test('Review Focus 5: step 5 on the 1.3 MB BOM+CRLF fixture and a cp949 file', T10, async () => {
  await withMaskRepo('mask-bomcrlf', async (c) => {
    assert.equal((await c.repo.configGet('core.autocrlf')), 'true', 'a core.autocrlf=true peer');
    const big = generateBigBomCrlf(26_436, seededRandom('t13-bomcrlf'));
    assert.ok(big.length > 1_200_000, 'about 1.3 MB');
    assert.ok(rows(big)[0]!.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'BOM in row 1');
    await check(c, 'big.py', big, 1000, 2000, Buffer.from('# held change on row 1000', 'utf8'), Buffer.from('# unheld edit on row 2000', 'utf8'));

    const HAN = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);   // cp949 for "Hangul" (two syllables)
    const cp = Buffer.concat(Array.from({ length: 12 }, (_, i) => Buffer.concat([HAN, Buffer.from(` row ${i + 1}\r\n`, 'latin1')])));
    await check(c, 'ko.txt', cp, 3, 7, Buffer.concat([HAN, HAN, Buffer.from(' held', 'latin1')]), Buffer.concat([Buffer.from('edited ', 'latin1'), HAN]));
  }, { autocrlf: true });
});
