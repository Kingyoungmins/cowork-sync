// Audit #1 #2 (fix wave F1, group G1; rulings G1-RC, G1-FILEFORM). On git 2.53.0.windows.2 `merge-file --object-id` with an explicit
// git dir dies in BUG() — exit 3 with an empty stdout on Windows, a clean merge too — and the exit was read as "3 conflicts": restore()
// wrote the empty output over the working file and reported RESTORE_MARKERS, and every REBASE and MASK step 5 became a conflict.
// Here: the real git of this machine merges (runMergeFile's file form over the objects' stored bytes, byte-identical to the
// --object-id form where that form works), and a fake git port that ends merge-file
// like that crash (exit 3, empty stdout, the BUG line) or with a count and no marker row is an error everywhere it is read —
// mergeFile, restore() (refused, nothing written), REBASE and MASK (HoldOperatorError, never a conflict).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyStep } from '../../src/engine/apply.js';
import { restore } from '../../src/engine/holdOps.js';
import { mergeFile, runMergeFile } from '../../src/git/merge.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import type { GitResult, GitRunner } from '../../src/git/runner.js';
import { maskEntries } from '../../src/holds/mask.js';
import { HoldOperatorError, RebaseCache } from '../../src/holds/rebase.js';
import { readWork, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, P, prepIt, recordLog, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { inputs, pair, record, T9, t9, tmap, withMaskRepo } from '../helpers/maskFixture.js';
import { buf } from '../helpers/publishHelpers.js';
import { fixtureContext, makeRepoFixture } from '../helpers/repoFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };
const HUMAN = { humanEvidence: true, actor: 'human' } as const;
const BUG = 'BUG: repository.c:171: cannot reinitialize an already-initialized object directory\n';

type Fake = (args: readonly string[]) => GitResult | null;
/** The 2.53 crash as Windows reports it: exit 3, nothing on stdout, git's BUG line on stderr. */
const crash: Fake = (args) => (args[0] === 'merge-file' ? { code: 3, stdout: Buffer.alloc(0), stderr: Buffer.from(BUG), killedByWatchdog: false, aborted: false, durationMs: 1 } : null);
/** An exit 1 whose output carries no marker row (e.g. a process that died after writing part of a clean result). */
const countWithoutMarkers: Fake = (args) => (args[0] === 'merge-file' ? { code: 1, stdout: Buffer.from('partial\n'), stderr: Buffer.alloc(0), killedByWatchdog: false, aborted: false, durationMs: 1 } : null);

/** A runner answering merge-file from `fake` (no process) and every other call from `inner`; `seen` counts the faked calls. */
function faking(inner: GitRunner, fake: Fake, seen: { n: number }): GitRunner {
  return {
    run(args, opts) {
      const r = fake(args);
      if (r === null) return inner.run(args, opts);
      seen.n++;
      return Promise.resolve(r);
    },
  };
}

test('real git: merge-file merges on this machine (clean rc 0, a conflict rc 1 with its markers, labels and diff3)', T10, async () => {
  const f = await makeRepoFixture('g1-real-mergefile');
  try {
    const { repo } = f;
    const b = (s: string): Promise<Oid> => repo.hashBytes(Buffer.from(s, 'utf8'), true);
    const base = await b(T9);
    const clean = await mergeFile(repo, await b(t9([2, 'two'])), base, await b(t9([8, 'eight'])));
    assert.equal(clean.rc, 0, `clean merge rc ${clean.rc} (git ${process.platform}): ${clean.out.toString('utf8')}`);
    assert.equal(clean.out.toString('utf8'), t9([2, 'two'], [8, 'eight']));
    const same = await mergeFile(repo, base, base, base);
    assert.deepEqual([same.rc, same.out.toString('utf8')], [0, T9], 'B B B');
    const cur = await b(t9([2, 'TWO']));
    const oth = await b(t9([2, 'two']));
    const plain = await mergeFile(repo, cur, base, oth);
    assert.equal(plain.rc, 1);
    assert.ok(plain.out.toString('utf8').includes(`<<<<<<< ${cur}\nTWO\n=======\ntwo\n>>>>>>> ${oth}\n`), plain.out.toString('utf8'));
    const labelled = await mergeFile(repo, cur, base, oth, { diff3: true, labels: ['cowork:disk', 'cowork:base', 'cowork:held'] });
    assert.equal(labelled.rc, 1);
    assert.equal(labelled.out.toString('utf8'), '1\n<<<<<<< cowork:disk\nTWO\n||||||| cowork:base\n2\n=======\ntwo\n>>>>>>> cowork:held\n3\n4\n5\n6\n7\n8\n9\n');
    const two = await mergeFile(repo, await b(t9([2, 'TWO'], [8, 'EIGHT'])), base, await b(t9([2, 'two'], [8, 'eight'])), { markerSize: 9 });
    assert.equal(two.rc, 2, 'two conflicts, two opening rows of size 9');
    // An empty side: the empty blob, read as an empty file (the --object-id form printed "error: Could not stat /dev/null" for it).
    const absent = await mergeFile(repo, ABSENT, ABSENT, ABSENT);
    assert.deepEqual([absent.rc, absent.out.length], [0, 0], 'an empty clean merge is a merge');
    const empty = await b('');
    const addOne = await mergeFile(repo, await b('x\n'), empty, empty);
    assert.deepEqual([addOne.rc, addOne.out.toString('utf8')], [0, 'x\n'], 'an empty base and other: the current side');
    const addAdd = await mergeFile(repo, await b('x\n'), empty, await b('y\n'), { labels: ['L', 'B', 'R'] });
    assert.deepEqual([addAdd.rc, addAdd.out.toString('utf8')], [1, '<<<<<<< L\nx\n=======\ny\n>>>>>>> R\n'], 'add/add over an empty base');
    // An ABSENT side keeps its default label, the empty blob's oid (D1).
    const EMPTY = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
    const xb = await b('x\n');
    const yb = await b('y\n');
    const absentAdd = await mergeFile(repo, xb, ABSENT, yb);
    assert.deepEqual([absentAdd.rc, absentAdd.out.toString('utf8')], [1, `<<<<<<< ${xb}\nx\n=======\ny\n>>>>>>> ${yb}\n`]);
    const absentCur = await mergeFile(repo, ABSENT, xb, yb);
    assert.equal(absentCur.rc, 1);
    assert.ok(absentCur.out.toString('utf8').startsWith(`<<<<<<< ${EMPTY}\n`), absentCur.out.toString('utf8'));
    assert.ok(absentCur.out.toString('utf8').endsWith(`>>>>>>> ${yb}\n`), absentCur.out.toString('utf8'));
    // CRLF and BOM bytes pass through unchanged (stored form in, stored form out).
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const crlf = async (...rows: string[]): Promise<Oid> => repo.hashBytes(Buffer.concat([bom, Buffer.from(rows.map((r) => `${r}\r\n`).join(''), 'utf8')]), true);
    const cr = await mergeFile(repo, await crlf('1', 'TWO', '3', '4', '5'), await crlf('1', '2', '3', '4', '5'), await crlf('1', '2', '3', 'four', '5'));
    assert.equal(cr.rc, 0, 'edits one unchanged row apart merge cleanly');
    assert.deepEqual(cr.out, Buffer.concat([bom, Buffer.from('1\r\nTWO\r\n3\r\nfour\r\n5\r\n', 'utf8')]));
    // No scratch directory is left behind.
    const tmp = join(f.paths.coworkDir, 'tmp');
    assert.deepEqual(existsSync(tmp) ? readdirSync(tmp) : [], [], 'every merge removed its scratch directory');
  } finally {
    await f.cleanup();
  }
});

test('G1-FILEFORM: the file form is byte-identical to `merge-file --object-id` run where that form works (git -C <work tree>, no explicit git dir)', T10, async (t) => {
  const f = await makeRepoFixture('g1-byte-equal');
  try {
    const { repo, paths } = f;
    const b = (s: string): Promise<Oid> => repo.hashBytes(Buffer.from(s, 'utf8'), true);
    const base = await b(T9);
    const cur = await b(t9([2, 'TWO'], [8, 'EIGHT']));
    const oth = await b(t9([2, 'two'], [8, 'eight']));
    const clean = await b(t9([5, 'five']));
    // Outside the runner on purpose: the reference is git's own --object-id form, from the work tree root (MEASURED to merge on
    // git 2.53.0.windows.2 there), with the same MERGE_FLAGS.
    const reference = (args: string[]): { code: number | null; out: Buffer; err: string } => {
      const r = spawnSync('git', ['-C', paths.workTree, '-c', 'merge.renormalize=false', '-c', 'merge.renames=true', '-c', 'merge.directoryRenames=false', 'merge-file', ...args]);
      return { code: r.status, out: r.stdout, err: r.stderr.toString('utf8') };
    };
    const forms: string[][] = [
      ['-p', '--object-id', cur, base, oth],
      ['-p', '--object-id', clean, base, oth],
      ['-p', '--object-id', '--diff3', '--marker-size=9', '-L', 'ours', '-L', 'base', '-L', 'theirs', cur, base, oth],
      ['-p', '--object-id', '--diff3', '-L', 'cowork:disk', '-L', 'cowork:base', '-L', 'cowork:held', cur, base, oth],
      ['-p', '--object-id', '--marker-size=8', cur, base, oth],
      ['-p', '--object-id', '--ours', cur, base, oth],
    ];
    for (const form of forms) {
      const want = reference(form);
      t.diagnostic(`reference ${form.slice(1, 4).join(' ')} → exit ${want.code}${want.err.length > 0 ? ` (${want.err.split('\n')[0]})` : ''}`);
      assert.ok(want.code === 0 || want.code === 1 || want.code === 2, `the reference form ran (${want.code}): ${want.err}`);
      const got = await runMergeFile(repo, ['merge-file', ...form]);
      assert.equal(got.rc, want.code, form.join(' '));
      assert.deepEqual(got.out, want.out, `byte-identical: ${form.join(' ')}`);
    }
  } finally {
    await f.cleanup();
  }
});

test('fake git: the crash and a count without marker rows are mergeFile errors (rc -1), for every option form', T10, async () => {
  const f = await makeRepoFixture('g1-fake-mergefile');
  try {
    const b = (s: string): Promise<Oid> => f.repo.hashBytes(Buffer.from(s, 'utf8'), true);
    const [x, y, z] = [await b(T9), await b(t9([2, 'two'])), await b(t9([2, 'TWO']))];
    for (const fake of [crash, countWithoutMarkers]) {
      const seen = { n: 0 };
      const repo = new GitRepo(faking(f.runner, fake, seen), f.paths, fixtureContext);
      for (const o of [{}, { diff3: true }, { markerSize: 9 }, { diff3: true, labels: ['cowork:disk', 'cowork:base', 'cowork:held'] as const }]) {
        assert.equal((await mergeFile(repo, z, x, y, o)).rc, -1, JSON.stringify(o));
        assert.equal((await mergeFile(repo, x, x, x, o)).rc, -1, `clean form ${JSON.stringify(o)}`);
      }
      assert.equal(seen.n, 8);
    }
  } finally {
    await f.cleanup();
  }
});

test('fake git: REBASE and MASK step 5 throw HoldOperatorError on the crash — never a conflict, nothing cached', T10, async () => {
  await withMaskRepo('g1-fake-rebase-mask', async (c) => {
    const a = await c.blob(t9([8, 'eight']));
    const h0 = await c.blob(T9);
    const h1 = await c.blob(t9([2, 'two']));
    const r = record(pair(h0, h1));
    const A = tmap({ [P]: a });
    for (const fake of [crash, countWithoutMarkers]) {
      const seen = { n: 0 };
      const repo = new GitRepo(faking(c.f.runner, fake, seen), c.f.paths, fixtureContext);
      const cache = new RebaseCache(repo, () => true);
      const err = await cache.rebase(r, A).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof HoldOperatorError, `rebase: got ${String(err)}`);
      assert.equal(err.op, 'rebase');
      assert.match(err.message, /ended abnormally/);
      // MASK over X = the disk with the held change: step 5's REBASE / reverse merge fails the same way.
      const x = await c.blob(t9([2, 'two'], [8, 'eight']));
      const merr = await maskEntries(repo, tmap({ [P]: x }), inputs(A, [r]), cache).then(() => null, (e: unknown) => e);
      assert.ok(merr instanceof HoldOperatorError, `mask: got ${String(merr)}`);
      assert.equal(merr.op, 'mask');
      assert.ok(seen.n >= 2, 'merge-file was asked each time (nothing cached)');
    }
    // The real git rebases the same record.
    const ok = await new RebaseCache(c.repo, () => true).rebase(r, A);
    assert.ok(ok.ok);
    assert.equal(await c.text(ok.h1p[P]!), t9([2, 'two'], [8, 'eight']));
  });
});

/** A = T9{8:eight} through a teammate's change applied here (s3 = A, disk = A). */
async function teamEight(fx: Parameters<Parameters<typeof withPeers>[2]>[0], p: PeerFixture): Promise<void> {
  await fx.pushTeamChange({ [P]: buf(t9([8, 'eight'])) });
  fx.advance(10_000);
  const r = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
  assert.ok(r.written.includes(P), JSON.stringify(r));
}

// One test per fake (each a full peer setup: under this PC's load one test with both ran past the 10-minute cap).
for (const [what, fake, thenReal] of [['crashes (exit 3, empty stdout, the BUG line)', crash, true], ['claims a count without marker rows', countWithoutMarkers, false]] as const) {
  test(`fake git: restore() refuses HOLD_RESTORE_CONFLICT and writes nothing when merge-file ${what}${thenReal ? '; the real git then restores' : ''}`, T10, async () => {
    await withPeers(`g1-fake-restore-${thenReal ? 'crash' : 'count'}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      await teamEight(fx, p);
      const id = await p.core.holds.hold(nr({
        residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon',
        blobs: stages(await blob(p, T9), await blob(p, t9([2, 'two'])), await blob(p, t9([8, 'eight']))),
      }));
      const disk = t9([2, 'TWO'], [8, 'eight']);   // the human's unpublished edit D
      await writeWork(p, P, disk);
      const git = p.deps.ports.git;
      const realRun = git.run.bind(git);
      const log = recordLog(p);
      {
        const it = await prepIt(p, { holdPaths: [P] });
        const before = JSON.stringify(p.core.holds.get(id));
        const seen = { n: 0 };
        git.run = faking({ run: realRun }, fake, seen).run;
        let out;
        try {
          out = await restore(p.core, it, id, HUMAN);
        } finally {
          git.run = realRun;
        }
        assert.equal(seen.n, 1, 'restore ran merge-file once');
        assert.deepEqual(out, { kind: 'REFUSED', code: 'HOLD_RESTORE_CONFLICT' });
        assert.deepEqual(await readWork(p, P), Buffer.from(disk), 'the working file keeps D');
        assert.equal(JSON.stringify(p.core.holds.get(id)), before, 'the record is unchanged (OFF_DISK CONFLICTED, its held side kept)');
        assert.deepEqual(p.core.holds.local().inflight, {}, 'no inflight restore');
        assert.equal(log.lines.some((l) => l.code === 'HOLD_RESTORED' || l.code === 'RESTORE_MARKERS'), false, 'never reported as restored');
      }
      if (!thenReal) return;
      // The real git of this machine (2.53 included): the conflicted restore writes the cowork: markers over D's row 2.
      assert.deepEqual(await restore(p.core, await prepIt(p, { holdPaths: [P] }), id, HUMAN), { kind: 'RESTORED', markers: true });
      const rows = (await readWork(p, P))!.toString('utf8').split('\n');
      assert.deepEqual(rows.slice(0, 9), ['1', '<<<<<<< cowork:disk', 'TWO', '||||||| cowork:base', '2', '=======', 'two', '>>>>>>> cowork:held', '3']);
      assert.ok(rows.includes('eight'), 'the teammate row stays');
    });
  });
}
