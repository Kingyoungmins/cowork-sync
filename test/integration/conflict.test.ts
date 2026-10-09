import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { concatMarkerSize, conflict, type ConflictCtx, type ConflictVerdict, type Stage } from '../../src/data/conflict.js';
import { conflictMarkerRows, rows, stripEnding } from '../../src/data/rows.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

async function blob(f: RepoFixture, content: string | Buffer): Promise<Oid> {
  return f.repo.hashBytes(typeof content === 'string' ? Buffer.from(content, 'utf8') : content, true);
}

/** A Plan 2 context: every path text, `*.md` insertion-merge, concat allowed, no local_only record, ref = refs[p]. */
function ctxFor(f: RepoFixture, refs: Record<string, Buffer | null>, over: Partial<ConflictCtx> = {}): ConflictCtx {
  return {
    repo: f.repo,
    isText: () => true,
    insertionMerge: (p) => p.endsWith('.md'),
    concatAllowed: true,
    localOnly: () => false,
    ref: async (p) => refs[p] ?? null,
    write: true,
    ...over,
  };
}

function takeTip(entry: Stage, s1: Stage, s2: Stage, s3: Stage): ConflictVerdict {
  return { kind: 'TAKE_TIP', entry, stages: { s1, s2, s3 } };
}

async function concatBytes(f: RepoFixture, v: ConflictVerdict): Promise<Buffer> {
  assert.equal(v.kind, 'CONCAT', `expected CONCAT, got ${JSON.stringify(v)}`);
  return f.repo.readBlob((v as { kind: 'CONCAT'; blob: Oid }).blob);
}

const decodes = (b: Buffer): boolean => {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

/** Row content with the ending ignored and row 1's BOM removed. */
function rowKeys(b: Buffer): string[] {
  return rows(b).map((r, i) => {
    const x = i === 0 && r.subarray(0, 3).equals(BOM) ? r.subarray(3) : r;
    return stripEnding(x).toString('latin1');
  });
}

/** D9 tripwire legs (i) and (iii) on an output. */
function assertTripwire(out: Buffer, stages: Buffer[]): void {
  if (stages.every(decodes)) assert.ok(decodes(out), 'leg (i): the output decodes as UTF-8');
  const known = new Set(stages.flatMap(rowKeys));
  for (const k of rowKeys(out)) {
    if (/^[\t\n\v\f\r ]*$/.test(k)) continue;
    assert.ok(known.has(k), `leg (iii): output row ${JSON.stringify(k)} occurs in s1, s2 or s3`);
  }
}

test('same-line edit gives TAKE_TIP with stages (A, LOCAL, TIP)', async () => {
  const f = await makeRepoFixture('conflict-same-line');
  try {
    const A = '1\n2\n3\n4\n5\n';
    const s1 = await blob(f, A);
    const s2 = await blob(f, '1\nLOCAL\n3\n4\n5\n');
    const s3 = await blob(f, '1\nTIP\n3\n4\n5\n');
    for (const path of ['src/a.txt', 'notes.md']) {
      // notes.md qualifies for insertion-merge, but the region's base block is not empty (D9 step 2).
      const v = await conflict(ctxFor(f, { [path]: Buffer.from(A) }), path, s1, s2, s3, 'content');
      assert.deepEqual(v, takeTip(s3, s1, s2, s3), path);
    }
    const ro = await conflict(ctxFor(f, { 'src/a.txt': Buffer.from(A) }, { write: false }), 'src/a.txt', s1, s2, s3, 'content');
    assert.deepEqual(ro, takeTip(s3, s1, s2, s3));
  } finally {
    await f.cleanup();
  }
});

test("end-of-file appends to notes.md give CONCAT with TIP's block first and the D9 separator; tripwire legs (i) and (iii) hold", async () => {
  const f = await makeRepoFixture('conflict-concat');
  try {
    // LF, with a blank row ending TIP's block and starting LOCAL's: no grammar in Plan 2, so the separator
    // adds no blank row (need = 0) and both blocks stay byte for byte, TIP's first.
    const A = '# Notes\n\n- a\n';
    const T = `${A}- tip 팁\n\n`;
    const L = `${A}\n- local 1\n- local 2\n`;
    const [s1, s2, s3] = [await blob(f, A), await blob(f, L), await blob(f, T)];
    const v = await conflict(ctxFor(f, { 'notes.md': Buffer.from(A) }), 'notes.md', s1, s2, s3, 'content');
    const out = await concatBytes(f, v);
    assert.equal(out.toString('utf8'), `${A}- tip 팁\n\n\n- local 1\n- local 2\n`);
    assertTripwire(out, [Buffer.from(A), Buffer.from(L), Buffer.from(T)]);
    assert.equal(conflictMarkerRows(out).size, 0);

    // The same race on a BOM+CRLF file: endings and BOM survive, canon(out, ref) changes nothing.
    const A2 = Buffer.concat([BOM, Buffer.from('# 노트\r\n\r\n- a\r\n')]);
    const T2 = Buffer.concat([A2, Buffer.from('- tip\r\n')]);
    const L2 = Buffer.concat([A2, Buffer.from('- local\r\n')]);
    const v2 = await conflict(ctxFor(f, { 'docs/notes.md': A2 }), 'docs/notes.md', await blob(f, A2), await blob(f, L2), await blob(f, T2), 'content');
    const out2 = await concatBytes(f, v2);
    assert.ok(out2.equals(Buffer.concat([A2, Buffer.from('- tip\r\n- local\r\n')])), JSON.stringify(out2.toString('latin1')));
    assertTripwire(out2, [A2, L2, T2]);

    // TIP's last row has no terminator: the base's line ending is appended before LOCAL's block;
    // LOCAL's own missing terminator is kept.
    const T3 = `${A}- tip`;
    const L3 = `${A}- local`;
    const v3 = await conflict(ctxFor(f, { 'notes.md': Buffer.from(A) }), 'notes.md', s1, await blob(f, L3), await blob(f, T3), 'content');
    assert.equal((await concatBytes(f, v3)).toString('utf8'), `${A}- tip\n- local`);

    // write=false: the same id, no object.
    const s2b = await blob(f, `${A}- only local\n`);
    const s3b = await blob(f, `${A}- only tip\n`);
    const idOnly = await conflict(ctxFor(f, { 'notes.md': Buffer.from(A) }, { write: false }), 'notes.md', s1, s2b, s3b, 'content');
    assert.equal(idOnly.kind, 'CONCAT');
    const id = (idOnly as { blob: Oid }).blob;
    assert.equal(await f.repo.hasObject(id, 'blob'), false);
    const stored = await conflict(ctxFor(f, { 'notes.md': Buffer.from(A) }), 'notes.md', s1, s2b, s3b, 'content');
    assert.deepEqual(stored, { kind: 'CONCAT', blob: id });
    assert.equal((await f.repo.readBlob(id)).toString('utf8'), `${A}- only tip\n- only local\n`);

    // Not qualified → TAKE_TIP: a path outside merge.insertionMerge, a differing regionSpec in the live
    // set (concatAllowed false), and a non-blank row present in both blocks.
    const ref = { 'notes.md': Buffer.from(A), 'src/notes.txt': Buffer.from(A) };
    assert.deepEqual(await conflict(ctxFor(f, ref), 'src/notes.txt', s1, s2b, s3b, 'content'), takeTip(s3b, s1, s2b, s3b));
    assert.deepEqual(await conflict(ctxFor(f, ref, { concatAllowed: false }), 'notes.md', s1, s2b, s3b, 'content'), takeTip(s3b, s1, s2b, s3b));
    const s2c = await blob(f, `${A}- same\n- local\n`);
    const s3c = await blob(f, `${A}- tip\n- same\n`);
    assert.deepEqual(await conflict(ctxFor(f, ref), 'notes.md', s1, s2c, s3c, 'content'), takeTip(s3c, s1, s2c, s3c));
  } finally {
    await f.cleanup();
  }
});

test("an already-concatenated unit gives CONCAT of TIP's entry with no record, and LOCAL rows outside the regions survive when the tripwire passes", async () => {
  const f = await makeRepoFixture('conflict-already');
  try {
    // 01-engine test 43, unit form: this peer's publish resolved p by concat (C = A + tip + local) while
    // its apply was coalesced; the next apply merges A / S_disk = A + local / C. Step 0a needs neither
    // merge.insertionMerge nor concatAllowed.
    const A = 'def a():\n    pass\n\n\nx = 1\n';
    const local = 'def local_helper():\n    return 2\n';
    const tip = 'def tip_helper():\n    return 1\n';
    const s1 = await blob(f, A);
    const s2 = await blob(f, A + local);
    const s3 = await blob(f, A + tip + local);
    const plain = ctxFor(f, { 'src/mod.py': Buffer.from(A) }, { insertionMerge: () => false, concatAllowed: false });
    assert.deepEqual(await conflict(plain, 'src/mod.py', s1, s2, s3, 'content'), { kind: 'CONCAT', blob: s3 });

    // LOCAL also edited a row outside the region after the capture (two unchanged rows in between):
    // the result is TIP's entry plus that edit, stored by route (c) after canon.
    const edited = 'def a():\n    return 0\n\n\nx = 1\n';
    const s2e = await blob(f, edited + local);
    const v = await conflict(plain, 'src/mod.py', s1, s2e, s3, 'content');
    const out = await concatBytes(f, v);
    assert.equal(out.toString('utf8'), edited + tip + local);
    assert.notEqual((v as { blob: Oid }).blob, s3);
    assertTripwire(out, [Buffer.from(A), Buffer.from(edited + local), Buffer.from(A + tip + local)]);

    // The same on CRLF: canon(out, ref) keeps the stored form.
    const crlf = (s: string): Buffer => Buffer.from(s.replace(/\n/g, '\r\n'));
    const ref = { 'src/mod.cs': crlf(A) };
    const v2 = await conflict(
      ctxFor(f, ref, { insertionMerge: () => false }),
      'src/mod.cs',
      await blob(f, crlf(A)),
      await blob(f, crlf(edited + local)),
      await blob(f, crlf(A + tip + local)),
      'content',
    );
    assert.ok((await concatBytes(f, v2)).equals(crlf(edited + tip + local)));

    // When canon refuses the merged result (a MIXED ref whose matched rows end differently), step 0a
    // falls through to the general rule, which keeps LOCAL whole.
    const mixedRef = Buffer.from('def a():\r\n    pass\n\n\nx = 1\r\n');
    const refused = await conflict(ctxFor(f, { 'src/mod.py': mixedRef }, { insertionMerge: () => false }), 'src/mod.py', s1, s2e, s3, 'content');
    assert.deepEqual(refused, takeTip(s3, s1, s2e, s3));

    // LOCAL's block not inside TIP's block → not step 0a.
    const s3x = await blob(f, A + tip);
    assert.deepEqual(await conflict(plain, 'src/mod.py', s1, s2, s3x, 'content'), takeTip(s3x, s1, s2, s3x));
  } finally {
    await f.cleanup();
  }
});

test('binary, add/add, modify/delete and rename units give TAKE_TIP', async () => {
  const f = await makeRepoFixture('conflict-other');
  try {
    const A = '# Notes\n\n- a\n';
    const s1 = await blob(f, A);
    const s2 = await blob(f, `${A}- local\n`);
    const s3 = await blob(f, `${A}- tip\n`);
    const ctx = ctxFor(f, { 'notes.md': Buffer.from(A) });
    // The same stages concat as a content unit...
    assert.equal((await conflict(ctx, 'notes.md', s1, s2, s3, 'content')).kind, 'CONCAT');
    // ...but a unit the caller classified 'other' (binary, filtered, mode, directory/file) is whole-file.
    assert.deepEqual(await conflict(ctx, 'notes.md', s1, s2, s3, 'other'), takeTip(s3, s1, s2, s3));
    // A binary or filtered path at EPOCH_BASE (isText false).
    assert.deepEqual(await conflict(ctxFor(f, {}, { isText: () => false }), 'notes.md', s1, s2, s3, 'content'), takeTip(s3, s1, s2, s3));
    // Binary content (a NUL in the first 8,000 bytes) even when reported as a content unit.
    const b1 = await blob(f, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x0a]));
    const b2 = await blob(f, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x0a, 0x4c, 0x0a]));
    const b3 = await blob(f, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x0a, 0x54, 0x0a]));
    assert.deepEqual(await conflict(ctxFor(f, {}), 'data.md', b1, b2, b3, 'content'), takeTip(b3, b1, b2, b3));
    // add/add: no stored-form base.
    assert.deepEqual(await conflict(ctx, 'notes.md', ABSENT, s2, s3, 'other'), takeTip(s3, ABSENT, s2, s3));
    assert.deepEqual(await conflict(ctx, 'notes.md', ABSENT, s2, s3, 'content'), takeTip(s3, ABSENT, s2, s3));
    // modify/delete, both ways: TIP's entry, including its absence.
    assert.deepEqual(await conflict(ctx, 'notes.md', s1, s2, ABSENT, 'other'), takeTip(ABSENT, s1, s2, ABSENT));
    assert.deepEqual(await conflict(ctx, 'notes.md', s1, ABSENT, s3, 'content'), takeTip(s3, s1, ABSENT, s3));
    // Rename carry (01-engine §3.10): TIP renamed p, LOCAL edited it → stages (A[p], LOCAL[p], ABSENT).
    assert.deepEqual(await conflict(ctx, 'notes.md', s1, s2, ABSENT, 'other'), takeTip(ABSENT, s1, s2, ABSENT));
  } finally {
    await f.cleanup();
  }
});

test('a localOnly path gives DEFER(local_only_conflict)', async () => {
  const f = await makeRepoFixture('conflict-local-only');
  try {
    const A = '# Notes\n\n- a\n';
    const s1 = await blob(f, A);
    const s2 = await blob(f, `${A}- local\n`);
    const s3 = await blob(f, `${A}- tip\n`);
    const calls: string[][] = [];
    const spy: GitRunner = {
      run(args, opts) {
        calls.push([...args]);
        return f.runner.run(args, opts);
      },
    };
    const repo = new GitRepo(spy, f.paths, fixtureContext);
    const ctx = ctxFor(f, { 'notes.md': Buffer.from(A) }, { repo, localOnly: (p) => p === 'notes.md' });
    const defer = { kind: 'DEFER', reason: 'local_only_conflict' };
    // Even a unit that would concat, a binary unit and a deletion: steps 0a-5 do not run (no git call).
    assert.deepEqual(await conflict(ctx, 'notes.md', s1, s2, s3, 'content'), defer);
    assert.deepEqual(await conflict(ctx, 'notes.md', s1, s2, s3, 'other'), defer);
    assert.deepEqual(await conflict(ctx, 'notes.md', s1, s2, ABSENT, 'other'), defer);
    assert.deepEqual(calls, []);
    // Another path in the same context is not deferred.
    assert.equal((await conflict(ctx, 'other.md', s1, s2, s3, 'content')).kind, 'CONCAT');
  } finally {
    await f.cleanup();
  }
});

test('no verdict ever carries a conflict-marker row absent from both sides', async () => {
  const f = await makeRepoFixture('conflict-markers');
  try {
    const kinds = { CONCAT: 0, TAKE_TIP: 0 };
    const check = async (path: string, base: Buffer, local: Buffer, tip: Buffer): Promise<Buffer | null> => {
      const [s1, s2, s3] = [await blob(f, base), await blob(f, local), await blob(f, tip)];
      const v = await conflict(ctxFor(f, { [path]: base }), path, s1, s2, s3, 'content');
      if (v.kind === 'TAKE_TIP') {
        kinds.TAKE_TIP++;
        assert.deepEqual(v, takeTip(s3, s1, s2, s3), 'TAKE_TIP keeps TIP and records LOCAL as s2');
        return null;
      }
      assert.equal(v.kind, 'CONCAT', JSON.stringify(v));
      kinds.CONCAT++;
      const out = await f.repo.readBlob(v.blob);
      const sides = new Set([...conflictMarkerRows(local), ...conflictMarkerRows(tip)]);
      for (const m of conflictMarkerRows(out)) assert.ok(sides.has(m), `marker row ${JSON.stringify(m)} is in LOCAL or TIP`);
      assertTripwire(out, [base, local, tip]);
      return out;
    };

    // Fixed cases: git-width marker rows inside the appended blocks (the concat marker size keeps them
    // content, so the race still concatenates), and a stage with a 40-wide run so the size is 41.
    const A = '# Notes\n\n- a\n';
    const withMarkers = await check('notes.md', Buffer.from(A), Buffer.from(`${A}<<<<<<< local text\n=======\n`), Buffer.from(`${A}>>>>>>> tip text\n`));
    assert.equal(withMarkers?.toString('utf8'), `${A}>>>>>>> tip text\n<<<<<<< local text\n=======\n`);
    const run40 = `${'<'.repeat(40)} content\n`;
    const v40local = Buffer.from(`${A}${run40}${'='.repeat(32)}\n`);
    await check('notes.md', Buffer.from(A), v40local, Buffer.from(`${A}- tip\n`));
    const s40 = await conflict(ctxFor(f, { 'notes.md': Buffer.from(A) }), 'notes.md', await blob(f, A), await blob(f, v40local), await blob(f, `${A}- tip\n`), 'content');
    assert.equal((await concatBytes(f, s40)).toString('utf8'), `${A}- tip\n${run40}${'='.repeat(32)}\n`);

    // Random triples over a small alphabet that includes marker-shaped rows of git's width and wider.
    const alphabet = ['a', 'b', '', '- item', '<<<<<<< x', '=======', '>>>>>>> y', '||||||| z', `${'<'.repeat(35)} q`, `${'='.repeat(33)}`];
    const rowArb = fc.constantFrom(...alphabet);
    const edit = fc.tuple(fc.nat(), fc.nat({ max: 2 }), rowArb);
    const apply = (base: string[], edits: Array<[number, number, string]>): string[] => {
      const out = [...base];
      for (const [pos, op, r] of edits) {
        const at = out.length === 0 ? 0 : pos % (out.length + 1);
        if (op === 0 && out.length > 0) out.splice(Math.min(at, out.length - 1), 1);
        else if (op === 1) out.splice(at, 0, r);
        else out.push(r);
      }
      return out;
    };
    const text = (rs: string[]): Buffer => Buffer.from(rs.map((r) => `${r}\n`).join(''));
    await fc.assert(
      fc.asyncProperty(
        fc.array(rowArb, { minLength: 1, maxLength: 8 }),
        fc.array(edit, { minLength: 1, maxLength: 4 }),
        fc.array(edit, { minLength: 1, maxLength: 4 }),
        async (base, le, te) => {
          await check('notes.md', text(base), text(apply(base, le)), text(apply(base, te)));
        },
      ),
      { numRuns: 30, seed: 4242 },
    );
    // The generated races reach both outcomes (counted over the fixed and the generated cases).
    assert.ok(kinds.CONCAT > 3 && kinds.TAKE_TIP > 3, JSON.stringify(kinds));
  } finally {
    await f.cleanup();
  }
});

test('concatMarkerSize is max(32, longest run + 1)', () => {
  const b = (s: string): Buffer => Buffer.from(s, 'latin1');
  assert.equal(concatMarkerSize([]), 32);
  assert.equal(concatMarkerSize([b('')]), 32);
  assert.equal(concatMarkerSize([b('<<<<<<< ours\n=======\n>>>>>>> theirs\n')]), 32);
  assert.equal(concatMarkerSize([b(`${'<'.repeat(31)}\n`)]), 32);
  assert.equal(concatMarkerSize([b(`${'<'.repeat(32)}\n`)]), 33);
  assert.equal(concatMarkerSize([b('x\n'), b(`a\n${'|'.repeat(40)} base\r\n`), b(`${'>'.repeat(35)}`)]), 41);
  assert.equal(concatMarkerSize([b(`${'='.repeat(50)}\r\n`)]), 51);
  // Only a run at a row start counts, and a run is one repeated marker character.
  assert.equal(concatMarkerSize([b(` ${'<'.repeat(50)}\nx${'='.repeat(50)}\n`)]), 32);
  assert.equal(concatMarkerSize([b(`${'<>'.repeat(30)}\n`)]), 32);
  assert.equal(concatMarkerSize([b(`${'<'.repeat(20)}${'='.repeat(20)}\n`)]), 32);
  // Row 1's BOM does not hide a run.
  assert.equal(concatMarkerSize([Buffer.concat([BOM, b(`${'<'.repeat(40)}\n`)])]), 41);
});
