// The viewer's bounded one-shot reads (Plan 8a Task 7; 12 §3.3.2, §3.3.6, VIZ-13; rulings R-V30, R-V46; S16, Review
// Focus 4): status.json and <gitdir>/cowork/peer through the BoundedReader port, over real files in a temp root whose path
// holds a space and Hangul. The FIFO and /dev/zero legs run on POSIX only; a symlink leg runs where symlinks can be made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realFs } from '../../../src/ports/fs.js';
import { fsBoundedReader, realBoundedReader, type BoundedReader } from '../../../src/viz/source/boundedRead.js';
import { readPeerFile, readStatus, STATUS_MAX_BYTES, type StatusRead } from '../../../src/viz/source/status.js';
import { FaultFs } from '../../sim/faultfs.js';
import { makeTempRoot } from '../../helpers/tmp.js';
import { spyNodeFs, type FsCall } from '../../helpers/vizFs.js';
import { statusBytes, within } from '../../helpers/vizStatus.js';

const POSIX = process.platform !== 'win32';
const PEER = '0123456789abcdef0123456789abcdef';
const WAIT_MS = 5_000;

async function coworkDir(label: string): Promise<{ gitdir: string; cowork: string; cleanup: () => Promise<void> }> {
  const { root, cleanup } = await makeTempRoot(label);
  const gitdir = join(root, 'repo', '.git');
  const cowork = join(gitdir, 'cowork');
  mkdirSync(cowork, { recursive: true });
  return { gitdir, cowork, cleanup };
}

/** A symlink at `link` to `target`, or false where this account cannot make one (Windows without the privilege). */
function trySymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

function mkfifo(p: string): void {
  const r = spawnSync('mkfifo', [p]);
  assert.equal(r.status, 0, `mkfifo: ${r.stderr?.toString() ?? ''}`);
}

/** status.json of exactly `size` bytes: a valid file padded with spaces after the closing brace. */
function padded(size: number): Buffer {
  const b = statusBytes();
  return Buffer.concat([b, Buffer.alloc(size - b.length, 0x20)]);
}

test('bounded reads: a FIFO and a symlink to /dev/zero at status.json → unreadable, at peer → null, a 1 MiB + 1 byte status.json → unreadable; none blocks', async (t) => {
  const { gitdir, cowork, cleanup } = await coworkDir('viz-bounded');
  try {
    const status = join(cowork, 'status.json');
    const peer = join(cowork, 'peer');
    const readers: Array<[string, BoundedReader]> = [['realBoundedReader', realBoundedReader], ['fsBoundedReader', fsBoundedReader(realFs)]];

    // The read cap: exactly 1 MiB parses, one byte more is unreadable (never parsed, no previous values).
    for (const [name, reader] of readers) {
      writeFileSync(status, padded(STATUS_MAX_BYTES));
      const ok = await within(WAIT_MS, readStatus(gitdir, null, { fs: realFs, reader }), `${name} 1 MiB`);
      assert.deepEqual([ok.present, ok.unreadable, ok.fields?.state], [true, false, 'ok'], `${name}: exactly 1 MiB is read`);
      writeFileSync(status, padded(STATUS_MAX_BYTES + 1));
      const over = await within(WAIT_MS, readStatus(gitdir, null, { fs: realFs, reader }), `${name} 1 MiB + 1`);
      assert.deepEqual([over.present, over.unreadable, over.fields], [true, true, null], `${name}: 1 MiB + 1 byte is unreadable`);
      unlinkSync(status);
    }

    // Both readers agree on every regular-file fixture (R-V30: two read paths, one result), and on the refusals.
    const fixtures: Array<[string, Buffer | null]> = [['empty', Buffer.alloc(0)], ['one byte', Buffer.from('x')], ['max − 1', Buffer.alloc(63, 0x61)], ['max', Buffer.alloc(64, 0x62)], ['max + 1', Buffer.alloc(65, 0x63)], ['absent', null]];
    const f = join(cowork, 'fixture.bin');
    for (const [label, bytes] of fixtures) {
      rmSync(f, { force: true });
      if (bytes !== null) writeFileSync(f, bytes);
      const want = bytes === null ? null : bytes.length > 64 ? 'too_large' : bytes;
      for (const [name, reader] of readers) assert.deepEqual(await within(WAIT_MS, reader.read(f, 64), `${name} ${label}`), want, `${name}: ${label}`);
    }
    rmSync(f, { force: true });
    const dir = join(cowork, 'a dir');
    mkdirSync(dir);
    for (const [name, reader] of readers) assert.equal(await within(WAIT_MS, reader.read(dir, 64), `${name} dir`), 'not_file', `${name}: a directory`);
    writeFileSync(join(cowork, 'target.txt'), Buffer.from('target'));
    if (trySymlink(join(cowork, 'target.txt'), f)) {
      for (const [name, reader] of readers) assert.equal(await within(WAIT_MS, reader.read(f, 64), `${name} symlink`), 'not_file', `${name}: a symlink to a regular file`);
      unlinkSync(f);
    } else {
      t.diagnostic('symlink leg skipped: this account cannot create symlinks');
    }

    if (!POSIX) {
      t.diagnostic('FIFO and /dev/zero legs skipped on win32 (POSIX only)');
      return;
    }
    // A FIFO with no writer would block an open without O_NONBLOCK, and a read of it forever.
    mkfifo(status);
    mkfifo(peer);
    for (const [name, reader] of readers) {
      const s = await within(WAIT_MS, readStatus(gitdir, null, { fs: realFs, reader }), `${name} FIFO status.json`);
      assert.deepEqual([s.present, s.unreadable, s.fields], [true, true, null], `${name}: a FIFO status.json is unreadable`);
      assert.equal(await within(WAIT_MS, readPeerFile(gitdir, reader), `${name} FIFO peer`), null, `${name}: a FIFO peer file is no peer`);
    }
    unlinkSync(status);
    unlinkSync(peer);
    // A symlink to /dev/zero would read without bound.
    symlinkSync('/dev/zero', status);
    symlinkSync('/dev/zero', peer);
    for (const [name, reader] of readers) {
      const s = await within(WAIT_MS, readStatus(gitdir, null, { fs: realFs, reader }), `${name} /dev/zero status.json`);
      assert.deepEqual([s.present, s.unreadable, s.fields], [true, true, null], `${name}: /dev/zero status.json is unreadable`);
      assert.equal(await within(WAIT_MS, readPeerFile(gitdir, reader), `${name} /dev/zero peer`), null, `${name}: /dev/zero peer is no peer`);
    }
    // /dev/zero itself (no symlink): a character device is not a regular file.
    assert.equal(await within(WAIT_MS, realBoundedReader.read('/dev/zero', 64), '/dev/zero'), 'not_file');
  } finally {
    await cleanup();
  }
});

test('readPeerFile over both readers: 32 lowercase hex after trim is the peer; upper case, 31 hex, 4,097 bytes, invalid UTF-8 and an absent file → null', async () => {
  const { gitdir, cowork, cleanup } = await coworkDir('viz-peer-file');
  try {
    const peer = join(cowork, 'peer');
    const readers: Array<[string, BoundedReader]> = [['realBoundedReader', realBoundedReader], ['fsBoundedReader', fsBoundedReader(realFs)]];
    // [label, file bytes (null: no file), the peer read]: positive controls at the trim and the 4,096-byte cap beside each refusal.
    const cases: Array<[string, Buffer | null, string | null]> = [
      ['the peer and a newline', Buffer.from(`${PEER}\n`, 'utf8'), PEER],
      ['the peer alone', Buffer.from(PEER, 'utf8'), PEER],
      ['spaces, a tab and CRLF around it', Buffer.from(` \t${PEER} \r\n`, 'utf8'), PEER],
      ['exactly 4,096 bytes (padded with spaces)', Buffer.from(PEER + ' '.repeat(4_096 - 32), 'utf8'), PEER],
      ['4,097 bytes (padded with spaces)', Buffer.from(PEER + ' '.repeat(4_097 - 32), 'utf8'), null],
      ['upper case', Buffer.from(`${PEER.toUpperCase()}\n`, 'utf8'), null],
      ['31 hex', Buffer.from(`${PEER.slice(1)}\n`, 'utf8'), null],
      ['33 hex', Buffer.from(`${PEER}0\n`, 'utf8'), null],
      ['two ids on two lines', Buffer.from(`${PEER}\n${PEER}\n`, 'utf8'), null],
      ['invalid UTF-8 after the id', Buffer.concat([Buffer.from(PEER, 'utf8'), Buffer.from([0xff, 0x0a])]), null],
      ['empty', Buffer.alloc(0), null],
      ['absent', null, null],
    ];
    for (const [label, bytes, want] of cases) {
      rmSync(peer, { force: true });
      if (bytes !== null) writeFileSync(peer, bytes);
      for (const [name, reader] of readers) {
        assert.equal(await within(WAIT_MS, readPeerFile(gitdir, reader), `${name} ${label}`), want, `${name}: ${label}`);
      }
    }
    // A directory at the peer path is no peer file either.
    rmSync(peer, { force: true });
    mkdirSync(peer);
    for (const [name, reader] of readers) assert.equal(await within(WAIT_MS, readPeerFile(gitdir, reader), `${name} dir`), null, `${name}: a directory`);
  } finally {
    await cleanup();
  }
});

test('readStatus reads only after an mtime change, with one open-read-close, and keeps the previous read on EPERM and ENOENT during a replace', async () => {
  const { gitdir, cowork, cleanup } = await coworkDir('viz-status-read');
  try {
    const status = join(cowork, 'status.json');
    let stamp = 1_700_000_000;
    /** Writes status.json and gives it an mtime no earlier write had (a coarse clock cannot hide the change). */
    const put = (over: Record<string, unknown>, p = status): void => {
      writeFileSync(p, statusBytes(over));
      stamp += 10;
      utimesSync(p, stamp, stamp);
    };

    // realBoundedReader: one open per changed mtime, none while it is unchanged, and never a whole-file readFile.
    put({ state: 'ok' });
    const calls: FsCall[] = [];
    const restore = spyNodeFs(calls);
    let r1: StatusRead;
    let r2: StatusRead;
    let r3: StatusRead;
    try {
      r1 = await readStatus(gitdir, null, { fs: realFs, reader: realBoundedReader });
      const afterFirst = calls.length;
      r2 = await readStatus(gitdir, r1, { fs: realFs, reader: realBoundedReader });
      const unchanged = calls.slice(afterFirst);
      put({ state: 'degraded' });
      const before3 = calls.length;
      r3 = await readStatus(gitdir, r2, { fs: realFs, reader: realBoundedReader });
      const changed = calls.slice(before3);
      const opens = (cs: FsCall[]): number => cs.filter((c) => c.op.endsWith('open') && c.paths.some((p) => p.includes('status.json'))).length;
      const wholeReads = calls.filter((c) => /readFile/.test(c.op) && c.paths.some((p) => p.includes('status.json')));
      assert.equal(opens(calls.slice(0, afterFirst)), 1, 'the first read: one open');
      assert.equal(opens(unchanged), 0, 'an unchanged mtime: no open');
      assert.equal(opens(changed), 1, 'a changed mtime: one open');
      assert.deepEqual(wholeReads, [], 'never a whole-file readFile');
    } finally {
      restore();
    }
    assert.equal(r1.fields?.state, 'ok');
    assert.equal(r2, r1, 'an unchanged mtime returns the previous read itself');
    assert.equal(r3.fields?.state, 'degraded');
    assert.notEqual(r3.mtimeNs, r1.mtimeNs);

    // fsBoundedReader over FaultFs: Windows lock holders and a replace by rename (glossary §26.1 W3).
    const ff = new FaultFs(realFs);
    const deps = { fs: ff, reader: fsBoundedReader(ff) };
    put({ state: 'ok' });
    const base = await readStatus(gitdir, null, deps);
    assert.equal(base.fields?.state, 'ok');

    // EPERM on the read (a delete-pending file during a rename over it) → the previous read; the next tick reads again.
    put({ state: 'offline' });
    ff.addRule({ op: 'readFile', pathIncludes: 'status.json', code: 'EPERM', times: 1 });
    assert.equal(await readStatus(gitdir, base, deps), base, 'EPERM keeps the previous read');
    const offline = await readStatus(gitdir, base, deps);
    assert.equal(offline.fields?.state, 'offline', 'the next tick reads the new file');

    // A share-none holder (EBUSY) → the previous read, until it lets go.
    put({ state: 'frozen', freeze_reasons: ['EPOCH'] });
    const release = ff.holdLock('status.json', 'share-none');
    assert.equal(await readStatus(gitdir, offline, deps), offline, 'a share-none lock keeps the previous read');
    release();
    const frozen = await readStatus(gitdir, offline, deps);
    assert.deepEqual([frozen.fields?.state, frozen.fields?.freeze_reasons], ['frozen', ['EPOCH']]);

    // ENOENT between the stat and the read (the old file gone, the new one not yet renamed in) → the previous read.
    put({ state: 'paused' });
    ff.interpose('readFile', 'status.json', async (p) => {
      unlinkSync(p);
    });
    assert.equal(await readStatus(gitdir, frozen, deps), frozen, 'ENOENT during a replace keeps the previous read');
    put({ state: 'paused' });
    assert.equal((await readStatus(gitdir, frozen, deps)).fields?.state, 'paused', 'the replaced file is read next tick');

    // A rename over the file between the stat and the read: the new bytes are read whole (one read, never a torn file).
    const before = await readStatus(gitdir, null, deps);
    put({ state: 'ok' });
    ff.interpose('readFile', 'status.json', async (p) => {
      const tmp = join(cowork, 'status.json.tmp');
      writeFileSync(tmp, statusBytes({ state: 'incident' }));
      renameSync(tmp, p);
    });
    const raced = await readStatus(gitdir, before, deps);
    assert.deepEqual([raced.unreadable, raced.fields?.state], [false, 'incident']);
  } finally {
    await cleanup();
  }
});
