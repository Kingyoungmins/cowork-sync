// Audit #1 #2 (fix wave F1, group G1): git 2.53.0.windows.2's `merge-file --object-id` dies in BUG() whenever the git dir is
// explicit; Windows reports the abort as exit 3 with an empty stdout, which the old exit-code reading took for "3 conflicts".
// Ruling G1-RC: mergeFileRc reads an exit 1…127 as a conflict count only with git's conflict-opening rows in the output, and a
// BUG()/fatal/error line, a kill or an abort as an error. Ruling G1-FILEFORM: runMergeFile runs the callers' --object-id argv as
// `merge-file -p … -L ×3 <files>` over the objects' stored bytes in a private scratch directory (here with a fake git port).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MARKER_SIZE, mergeFileRc, runMergeFile } from '../../src/git/merge.js';
import type { Oid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import type { GitResult, GitRunner } from '../../src/git/runner.js';
import { makeTempRoot } from '../helpers/tmp.js';

const OID = '1111111111111111111111111111111111111111';
const BUG = 'BUG: repository.c:171: cannot reinitialize an already-initialized object directory\n';

function res(code: number, stdout: string | Buffer, stderr = '', o: { killed?: boolean; aborted?: boolean } = {}): GitResult {
  return {
    code, stdout: typeof stdout === 'string' ? Buffer.from(stdout, 'utf8') : stdout, stderr: Buffer.from(stderr, 'utf8'),
    killedByWatchdog: o.killed ?? false, aborted: o.aborted ?? false, durationMs: 1,
  };
}

/** One conflict hunk as git writes it with labels L / B / R (diff3 form). */
const hunk = (l: string, m = 7, eol = '\n'): string =>
  `${'<'.repeat(m)} ${l}${eol}x${eol}${'|'.repeat(m)} B${eol}b${eol}${'='.repeat(m)}${eol}y${eol}${'>'.repeat(m)} R${eol}`;

test('G1-RC: the git 2.53 BUG() abort (exit 3, empty stdout) is an error, not three conflicts', () => {
  assert.equal(mergeFileRc(res(3, '', BUG), DEFAULT_MARKER_SIZE, 'cowork:disk'), -1);
  assert.equal(mergeFileRc(res(3, ''), DEFAULT_MARKER_SIZE, 'cowork:disk'), -1, 'exit 3 with no stderr and no marker row');
  assert.equal(mergeFileRc(res(1, ''), DEFAULT_MARKER_SIZE, OID), -1, 'exit 1 with an empty stdout (a load failure) is no conflict');
  assert.equal(mergeFileRc(res(2, 'merged\n'), DEFAULT_MARKER_SIZE, OID), -1, 'exit 2 with no marker row');
  assert.equal(mergeFileRc(res(0, '', BUG), DEFAULT_MARKER_SIZE, OID), -1, 'a BUG line makes exit 0 an error too');
});

test('G1-RC: an exit 1…127 is a conflict count only with at least that many opening rows of the requested size and label', () => {
  const one = `a\n${hunk('cowork:disk')}c\n`;
  assert.equal(mergeFileRc(res(1, one), 7, 'cowork:disk'), 1);
  assert.equal(mergeFileRc(res(2, `${one}${hunk('cowork:disk')}`), 7, 'cowork:disk'), 2);
  assert.equal(mergeFileRc(res(2, one), 7, 'cowork:disk'), -1, 'two conflicts claimed, one opening row: impossible');
  assert.equal(mergeFileRc(res(1, one), 7, 'other-label'), -1, 'another label is not the requested opening row');
  assert.equal(mergeFileRc(res(1, hunk('cowork:disk', 9)), 7, 'cowork:disk'), -1, 'nine < is not a size-7 marker');
  assert.equal(mergeFileRc(res(1, hunk('cowork:disk', 9)), 9, 'cowork:disk'), 1);
  assert.equal(mergeFileRc(res(1, hunk(OID, 7, '\r\n')), 7, OID), 1, 'a CRLF marker row (git adds the CR of CRLF content)');
  assert.equal(mergeFileRc(res(1, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(hunk(OID))])), 7, OID), 1, 'row 1 BOM ignored');
  assert.equal(mergeFileRc(res(1, `${'<'.repeat(7)} ${OID}`), 7, OID), 1, 'a last row without LF');
  assert.equal(mergeFileRc(res(1, ` ${'<'.repeat(7)} ${OID}\n`), 7, OID), -1, 'only at a row start');
  // Content rows equal to the opening row count too: >= is the rule, so a file that already carries markers still merges.
  assert.equal(mergeFileRc(res(1, `${hunk('cowork:disk')}${hunk('cowork:disk')}`), 7, 'cowork:disk'), 1);
});

test('G1-RC: exit 0 is clean whatever the output (an empty merge is legal); every other end is an error', () => {
  assert.equal(mergeFileRc(res(0, ''), 7, OID), 0);
  assert.equal(mergeFileRc(res(0, 'merged\n', 'warning: something harmless\n'), 7, OID), 0, 'a warning never decides');
  for (const code of [-1, 128, 255, 3221225477]) assert.equal(mergeFileRc(res(code, hunk(OID)), 7, OID), -1, `exit ${code}`);
  assert.equal(mergeFileRc(res(1, hunk(OID), 'fatal: unable to read blob object\n'), 7, OID), -1);
  assert.equal(mergeFileRc(res(1, hunk(OID), 'warning: x\nBUG: something\n'), 7, OID), -1, 'a BUG line on any line');
  assert.equal(mergeFileRc(res(0, 'x\n', 'error: Could not stat /dev/null: No such file or directory\n'), 7, OID), -1, 'an error line (D1: fail closed)');
  assert.equal(mergeFileRc(res(255, '', 'error: Cannot merge binary files: x (a vs. b)\n'), 7, OID), -1, 'binary: exit 255');
  assert.equal(mergeFileRc(res(0, 'x\n', '', { killed: true }), 7, OID), -1, 'a watchdog kill');
  assert.equal(mergeFileRc(res(1, hunk(OID), '', { aborted: true }), 7, OID), -1, 'an abort');
});

const A = 'a'.repeat(40) as Oid;
const B = 'b'.repeat(40) as Oid;
const C = 'c'.repeat(40) as Oid;
const BYTES: Record<string, Buffer> = { [A]: Buffer.from('1\nA\n3\n'), [B]: Buffer.from('1\nB\n3\r\n'), [C]: Buffer.from([0xef, 0xbb, 0xbf, 0x43, 0x0a]) };

interface Seen { args: string[]; files: Buffer[]; dirMode: number | null }

/** A fake git port: cat-file --batch answers from BYTES (exit 128 for an oid not there), merge-file records its argv and side files. */
function fakeGit(seen: Seen[], reads: string[][], merge: GitResult): GitRunner {
  return {
    async run(args, opts) {
      if (args[0] === 'cat-file' && args[1] === '--batch') {
        const oids = (opts.stdin ?? Buffer.alloc(0)).toString('utf8').split('\n').filter((l) => l.length > 0);
        reads.push(oids);
        if (oids.some((o) => BYTES[o] === undefined)) return res(128, '', 'fatal: Not a valid object name\n');
        return res(0, Buffer.concat(oids.flatMap((o) => [Buffer.from(`${o} blob ${BYTES[o]!.length}\n`), BYTES[o]!, Buffer.from('\n')])));
      }
      if (args[0] === 'merge-file') {
        const files = args.slice(-3);
        seen.push({ args: [...args], files: files.map((f) => readFileSync(f)), dirMode: process.platform === 'win32' ? null : statSync(join(files[0]!, '..')).mode & 0o777 });
        return merge;
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
  };
}

async function withRepo(fn: (repo: (runner: GitRunner) => GitRepo, tmp: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = await makeTempRoot('g1-runmergefile');
  try {
    const workTree = join(root, 'w');
    const paths = { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') };
    const ctx = () => ({ attrTree: null, filterDrivers: [], identity: { name: 'T', email: 't@cowork.invalid' }, wallMs: () => 0 });
    await fn((runner) => new GitRepo(runner, paths, ctx), join(paths.coworkDir, 'tmp'));
  } finally {
    await cleanup();
  }
}

test('G1-FILEFORM: runMergeFile runs the --object-id argv as merge-file -p over scratch copies of the stored bytes, labelled with the oids, and removes them', async () => {
  await withRepo(async (repo, tmp) => {
    const seen: Seen[] = [];
    const reads: string[][] = [];
    const r = await runMergeFile(repo(fakeGit(seen, reads, res(1, `1\n<<<<<<<<< ${A}\nA\n`))), ['merge-file', '-p', '--object-id', '--diff3', '--marker-size=9', A, B, C]);
    assert.deepEqual(r, { rc: 1, out: Buffer.from(`1\n<<<<<<<<< ${A}\nA\n`) });
    assert.deepEqual(reads, [[A, B, C]], 'one cat-file --batch read of the sides');
    assert.equal(seen.length, 1);
    const { args, files, dirMode } = seen[0]!;
    assert.deepEqual(args.slice(0, 10), ['merge-file', '-p', '--diff3', '--marker-size=9', '-L', A, '-L', B, '-L', C]);
    assert.equal(args.length, 13, 'no --object-id, nothing else');
    assert.deepEqual(args.slice(-3).map((f) => f.slice(tmp.length + 1).replace(/\\/g, '/').replace(/^merge-\d+-\d+\//, '')), [`0.${A}`, `1.${B}`, `2.${C}`]);
    assert.ok(args.slice(-3).every((f) => f.startsWith(tmp)), 'under <coworkDir>/tmp');
    assert.deepEqual(files, [BYTES[A], BYTES[B], BYTES[C]], 'the stored bytes, byte for byte (CRLF and BOM kept)');
    if (dirMode !== null) assert.equal(dirMode, 0o700, 'a user-only directory');
    assert.deepEqual(readdirSync(tmp), [], 'the scratch directory is removed');
    // Caller labels are kept; equal sides are read once and still get a file each.
    const r2 = await runMergeFile(repo(fakeGit(seen, reads, res(0, 'ok\n'))), ['merge-file', '-p', '--object-id', '-L', 'cowork:disk', '-L', 'cowork:base', '-L', 'cowork:held', A, A, B]);
    assert.deepEqual(r2, { rc: 0, out: Buffer.from('ok\n') });
    assert.deepEqual(reads[1], [A, B]);
    assert.deepEqual(seen[1]!.args.slice(0, 8), ['merge-file', '-p', '-L', 'cowork:disk', '-L', 'cowork:base', '-L', 'cowork:held']);
    assert.deepEqual(seen[1]!.files, [BYTES[A], BYTES[A], BYTES[B]]);
    // The rc is mergeFileRc's: the crash and a count without the opening row of the current side's label are errors.
    assert.equal((await runMergeFile(repo(fakeGit(seen, reads, res(3, '', BUG))), ['merge-file', '-p', '--object-id', A, B, C])).rc, -1);
    assert.equal((await runMergeFile(repo(fakeGit(seen, reads, res(1, `<<<<<<< ${B}\n`))), ['merge-file', '-p', '--object-id', A, B, C])).rc, -1);
    assert.deepEqual(readdirSync(tmp), [], 'removed after every call');
  });
});

test('G1-FILEFORM: an unreadable side is rc -1 with no merge-file run; a malformed argv throws', async () => {
  await withRepo(async (repo, tmp) => {
    const seen: Seen[] = [];
    const reads: string[][] = [];
    const g = repo(fakeGit(seen, reads, res(0, 'x\n')));
    const missing = 'd'.repeat(40);
    assert.deepEqual(await runMergeFile(g, ['merge-file', '-p', '--object-id', A, missing, C]), { rc: -1, out: Buffer.alloc(0) });
    assert.equal(seen.length, 0, 'merge-file never ran');
    assert.ok(!existsSync(tmp) || readdirSync(tmp).length === 0);
    const bad: string[][] = [
      ['merge-file', '-p', A, B, C],                                   // no --object-id
      ['merge-file', '--object-id', A, B, C],                          // no -p
      ['merge-file', '-p', '--object-id', '-L', 'x', '-L', 'y', A, B, C],   // two labels
      ['merge-file', '-p', '--object-id', '-q', A, B, C],              // not a long flag word
      ['merge-file', '-p', '--object-id', '--marker-size=0', A, B, C],
      ['merge-file', '-p', '--object-id', A, B, 'HEAD:x'],             // a side that is no oid
      ['merge-tree', '-p', '--object-id', A, B, C],
    ];
    for (const argv of bad) await assert.rejects(() => runMergeFile(g, argv), Error, argv.join(' '));
    assert.equal(seen.length, 0);
  });
});
