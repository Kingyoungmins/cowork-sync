// Staged read and stage dir (01-engine §2 "staged read"; glossary §26.1 W1–W3; Review Focus 1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realFs, sameStat } from '../../src/ports/fs.js';
import { stageable, stagedRead, StageDir } from '../../src/engine/stagedRead.js';
import { StatCache } from '../../src/engine/statCache.js';
import { FaultFs } from '../sim/faultfs.js';

let base = '';
let dir = '';
let counter = 0;

before(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowork-staged-'));
  dir = path.join(base, '\u{acf5} \u{bc31} dir');
  await fsp.mkdir(dir);
});

after(async () => {
  await fsp.rm(base, { recursive: true, force: true, maxRetries: 3 });
});

async function fresh(bytes: Buffer): Promise<string> {
  const p = path.join(dir, `file-${counter++}.txt`);
  await fsp.writeFile(p, bytes);
  // A fixed past mtime: a later write must change (size, mtime_ns).
  await fsp.utimes(p, 1_600_000_000, 1_600_000_000);
  return p;
}

/** Appends one byte and moves the mtime, as an editor's in-place save does. */
async function touchAppend(p: string, n: number): Promise<void> {
  await fsp.appendFile(p, Buffer.from('x'));
  await fsp.utimes(p, 1_600_000_100 + n, 1_600_000_100 + n);
}

test('a stable file reads ok with its bytes and the second stat', async () => {
  const p = await fresh(Buffer.from('one\r\ntwo\r\n'));
  const ffs = new FaultFs(realFs);
  const r = await stagedRead(ffs, p);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.ok(r.bytes.equals(Buffer.from('one\r\ntwo\r\n')));
  const now = await realFs.lstat(p);
  assert.ok(now !== null && sameStat(r.stat, now), 'the returned stat is the one taken after the read');
  assert.equal(r.stat.size, r.bytes.length);
  // One read bracketed by two lstats; nothing else touches the file.
  assert.deepEqual(ffs.calls, [`lstat ${p}`, `readFile ${p}`, `lstat ${p}`]);
});

test('a change between the two lstats triggers one re-read, then unstable if it changes again', async () => {
  const p = await fresh(Buffer.from('alpha\n'));
  const once = new FaultFs(realFs);
  once.interpose('readFile', path.basename(p), async (q) => touchAppend(q, 1));
  const r1 = await stagedRead(once, p);
  assert.equal(r1.kind, 'ok', 'one change: the re-read is stable');
  if (r1.kind === 'ok') {
    assert.ok(r1.bytes.equals(Buffer.from('alpha\nx')));
    const now = await realFs.lstat(p);
    assert.ok(now !== null && sameStat(r1.stat, now));
  }
  assert.deepEqual(once.calls, [`lstat ${p}`, `readFile ${p}`, `lstat ${p}`, `readFile ${p}`, `lstat ${p}`]);

  const twice = new FaultFs(realFs);
  let n = 10;
  twice.interpose('readFile', path.basename(p), async (q) => touchAppend(q, n++), 5);
  const r2 = await stagedRead(twice, p);
  assert.deepEqual(r2, { kind: 'unstable' });
  assert.equal(twice.calls.filter((c) => c.startsWith('readFile ')).length, 2, 'at most one re-read');
});

test('EBUSY, EPERM and EACCES read as unreadable and ENOENT as missing', async () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES'] as const) {
    const p = await fresh(Buffer.from(`locked ${code}\n`));
    const ffs = new FaultFs(realFs);
    ffs.addRule({ op: 'readFile', pathIncludes: path.basename(p), code, times: 1 });
    assert.deepEqual(await stagedRead(ffs, p), { kind: 'unreadable', code });
  }
  // A share-none holder (Windows) refuses the open: unreadable, never a partial result.
  const held = await fresh(Buffer.from('held\n'));
  const lockFs = new FaultFs(realFs);
  const release = lockFs.holdLock(path.basename(held), 'share-none');
  assert.deepEqual(await stagedRead(lockFs, held), { kind: 'unreadable', code: 'EBUSY' });
  release();
  assert.equal((await stagedRead(lockFs, held)).kind, 'ok');

  const ffs = new FaultFs(realFs);
  const absent = path.join(dir, 'never-there.txt');
  assert.deepEqual(await stagedRead(ffs, absent), { kind: 'missing' });
  assert.deepEqual(ffs.calls, [`lstat ${absent}`], 'a missing file is never opened');

  const gone = await fresh(Buffer.from('deleted between lstat and read\n'));
  const del = new FaultFs(realFs);
  del.interpose('readFile', path.basename(gone), async (q) => fsp.unlink(q));
  assert.deepEqual(await stagedRead(del, gone), { kind: 'missing' });
});

test('an in-place truncation interposed between lstat and read never yields a 0-byte ok with a stale stat', async () => {
  const full = Buffer.from('a'.repeat(4096));
  // (1) truncated and left empty: whatever comes back describes the bytes it carries.
  const p1 = await fresh(full);
  const st1 = await realFs.lstat(p1);
  const f1 = new FaultFs(realFs);
  f1.interpose('readFile', path.basename(p1), async (q) => {
    await fsp.truncate(q, 0);
    await fsp.utimes(q, 1_600_000_200, 1_600_000_200);
  });
  const r1 = await stagedRead(f1, p1);
  assert.equal(r1.kind, 'ok');
  if (r1.kind === 'ok') {
    assert.equal(r1.bytes.length, 0);
    assert.equal(r1.stat.size, 0, 'the stat describes the empty bytes, never the stale full-size stat');
    assert.ok(st1 !== null && !sameStat(r1.stat, st1));
  }

  // (2) truncated, then the editor writes the rest before the second lstat: the re-read gets the full file.
  const p2 = await fresh(full);
  const f2 = new FaultFs(realFs);
  f2.interpose('readFile', path.basename(p2), async (q) => {
    await fsp.truncate(q, 0);
  });
  let lstats = 0;
  f2.interpose('lstat', path.basename(p2), async (q) => {
    lstats++;
    if (lstats !== 2) return; // the lstat before the read passes; the one after it sees the finished save
    await fsp.writeFile(q, Buffer.concat([full, Buffer.from('more')]));
    await fsp.utimes(q, 1_600_000_300, 1_600_000_300);
  }, 3);
  const r2 = await stagedRead(f2, p2);
  assert.equal(r2.kind, 'ok', 'the stat changed once: one re-read of the finished save');
  assert.ok(r2.kind === 'ok' && r2.bytes.equals(Buffer.concat([full, Buffer.from('more')])), 'never the torn empty read');
  assert.ok(r2.kind === 'ok' && r2.stat.size === r2.bytes.length);
  assert.equal(f2.calls.filter((c) => c.startsWith('readFile ')).length, 2);

  // (3) truncated with the old mtime restored (a coarse clock): the size alone forces the re-read, whose stat
  // describes the 0 bytes it returns, never the full-size st3.
  const p3 = await fresh(full);
  const st3 = await realFs.lstat(p3);
  assert.ok(st3 !== null && st3.size === 4096);
  const f3 = new FaultFs(realFs);
  f3.interpose('readFile', path.basename(p3), async (q) => {
    await fsp.truncate(q, 0);
    await fsp.utimes(q, 1_600_000_000, 1_600_000_000);
  });
  const r3 = await stagedRead(f3, p3);
  assert.equal(r3.kind, 'ok');
  assert.ok(r3.kind === 'ok' && r3.bytes.length === 0 && r3.stat.size === 0, 'the empty bytes come with the empty file stat');
  assert.equal(f3.calls.filter((c) => c.startsWith('readFile ')).length, 2, 'the size change forced one re-read');

  // (4) truncated before the read, then rewritten to the same size with the old mtime restored before the second
  // lstat: both lstats agree (size, mtime, file id, mode), so only the byte count shows the read was torn.
  const p4 = await fresh(full);
  const f4 = new FaultFs(realFs);
  f4.interpose('readFile', path.basename(p4), async (q) => {
    await fsp.truncate(q, 0);
  });
  let lstats4 = 0;
  f4.interpose('lstat', path.basename(p4), async (q) => {
    lstats4++;
    if (lstats4 !== 2) return;
    await fsp.writeFile(q, Buffer.from('b'.repeat(4096)));
    await fsp.utimes(q, 1_600_000_000, 1_600_000_000);
  }, 3);
  const r4 = await stagedRead(f4, p4);
  assert.ok(!(r4.kind === 'ok' && r4.bytes.length !== r4.stat.size), 'never an ok whose bytes disagree with its stat');
  assert.equal(r4.kind, 'ok');
  assert.ok(r4.kind === 'ok' && r4.bytes.equals(Buffer.from('b'.repeat(4096))), 'the re-read returns the rewritten bytes');
  assert.equal(f4.calls.filter((c) => c.startsWith('readFile ')).length, 2, 'the torn read was retried once');
});

test('StageDir refuses a path failing validPathSyntax and never follows a symlinked component', async () => {
  const root = path.join(dir, 'cowork', 'tmp', 'stage');
  const stage = new StageDir(realFs, root);
  assert.equal(stage.root, root);
  for (const bad of ['../escape.txt', 'a/../b', '/abs.txt', 'C:/x.txt', 'a\\b.txt', 'a//b', '', 'dir/']) {
    await assert.rejects(stage.write(bad, Buffer.from('x')), Error, `refuses ${JSON.stringify(bad)}`);
    assert.throws(() => stage.abs(bad), Error);
  }
  // P2-DOTGIT and P2-CARRY: a dotgit alias (on Windows GIT~1 opens .git itself) or a U+FFFD name is never staged.
  for (const bad of ['GIT~1/config', 'git~1/hooks/post-checkout', '.Git/x', 'src/.git./x', 'bad\u{fffd}.txt']) {
    assert.equal(stageable(bad), false, JSON.stringify(bad));
    await assert.rejects(stage.write(bad, Buffer.from('x')), Error, `refuses ${JSON.stringify(bad)}`);
    assert.throws(() => stage.abs(bad), Error);
  }
  for (const good of ['src/a.txt', '.github/x.yml', 'git~/x', 'a.git/x']) assert.equal(stageable(good), true, good);
  const ok = await stage.write('src/\u{c0c8} file.txt', Buffer.from('bytes\r\n'));
  assert.equal(ok, path.join(root, 'src', '\u{c0c8} file.txt'));
  assert.equal(stage.abs('src/\u{c0c8} file.txt'), ok);
  assert.ok((await fsp.readFile(ok)).equals(Buffer.from('bytes\r\n')));

  // A directory link inside the stage root pointing outside it (a junction needs no privilege on Windows).
  const outside = path.join(dir, 'outside');
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fsp.symlink(outside, path.join(root, 'evil'), 'junction');
  await assert.rejects(stage.write('evil/x.txt', Buffer.from('secret')), Error);
  await assert.rejects(stage.write('evil/keep.txt', Buffer.from('secret')), Error);
  await assert.rejects(stage.write('evil', Buffer.from('secret')), Error);
  assert.deepEqual(await fsp.readdir(outside), ['keep.txt'], 'nothing was written through the link');
  assert.equal(await fsp.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');

  await stage.remove('src/\u{c0c8} file.txt');
  await stage.remove('src/never-staged.txt'); // ENOENT is fine
  await assert.rejects(fsp.stat(ok));
  await stage.clear();
  assert.deepEqual(await fsp.readdir(root), []);
  assert.deepEqual(await fsp.readdir(outside), ['keep.txt'], 'clear() removed the link, not its target');
});

test('StatCache keeps one entry per path', () => {
  const c = new StatCache();
  assert.equal(c.size, 0);
  c.set('a', { stat: null, id: null, state: 'dirty' });
  c.set('b', { stat: null, id: null, state: 'clean', missingSinceMono: 5 });
  assert.equal(c.size, 2);
  assert.equal(c.get('b')?.missingSinceMono, 5);
  assert.deepEqual([...c.entries()].map(([p]) => p), ['a', 'b']);
  c.delete('a');
  assert.equal(c.get('a'), undefined);
  c.clear();
  assert.equal(c.size, 0);
});
