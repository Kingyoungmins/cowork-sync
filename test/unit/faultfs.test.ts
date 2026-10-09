import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSystemErrorName } from 'node:util';
import { realFs } from '../../src/ports/fs.js';
import { FaultFs, type FaultOp } from '../sim/faultfs.js';

type FsErr = NodeJS.ErrnoException & { dest?: string };

let base = '';
let dir = '';

before(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowork-faultfs-'));
  dir = path.join(base, '공 백 dir');
  await fsp.mkdir(dir);
});

after(async () => {
  await fsp.rm(base, { recursive: true, force: true, maxRetries: 3 });
});

async function caught(p: Promise<unknown>): Promise<FsErr> {
  try {
    await p;
  } catch (e) {
    return e as FsErr;
  }
  throw new Error('expected the promise to reject');
}

test('a rule fails the matching op `times` times, then passes through', async () => {
  const ffs = new FaultFs(realFs);
  const p = path.join(dir, 'target-busy.txt');
  ffs.addRule({ op: 'writeFile', pathIncludes: 'target-busy', code: 'EBUSY', times: 2 });

  for (let i = 0; i < 2; i++) {
    const err = await caught(ffs.writeFile(p, Buffer.from('x\n')));
    assert.equal(err.code, 'EBUSY');
    assert.equal(err.syscall, 'open');
    assert.equal(err.path, p);
  }
  await ffs.writeFile(p, Buffer.from('ok\n'));
  assert.deepEqual(await ffs.readFile(p), Buffer.from('ok\n'));
  assert.equal(ffs.hits.get('writeFile:EBUSY:target-busy'), 2);
});

test('injected errors are indistinguishable in shape from real Node fs errors', async () => {
  const missing = path.join(dir, 'missing-for-shape.txt');
  const real = await caught(realFs.unlink(missing));

  const ffs = new FaultFs(realFs);
  const victim = path.join(dir, 'victim.txt');
  await realFs.writeFile(victim, Buffer.from('v\n'));
  ffs.addRule({ op: 'unlink', pathIncludes: 'victim', code: 'EPERM', times: 1 });
  const fake = await caught(ffs.unlink(victim));

  assert.equal(fake.constructor, Error);
  assert.equal(real.constructor, Error);
  assert.deepEqual(Object.keys(fake).sort(), Object.keys(real).sort());
  assert.equal(fake.code, 'EPERM');
  assert.equal(fake.syscall, 'unlink');
  assert.equal(fake.path, victim);
  assert.equal(typeof fake.errno, 'number');
  assert.equal(getSystemErrorName(fake.errno as number), 'EPERM');
  assert.match(fake.message, /^EPERM: [^,]+, unlink '.+'$/);
  assert.ok(fake.message.endsWith(`unlink '${victim}'`));
  // The faulted unlink had no side effect.
  assert.deepEqual(await realFs.readFile(victim), Buffer.from('v\n'));
});

test('rename and link errors carry dest like real ones and match either path', async () => {
  const realRename = await caught(realFs.rename(path.join(dir, 'nope-a'), path.join(dir, 'nope-b')));

  const ffs = new FaultFs(realFs);
  const from = path.join(dir, 'r-from.txt');
  const to = path.join(dir, 'r-to.locked');
  await realFs.writeFile(from, Buffer.from('r\n'));
  ffs.addRule({ op: 'rename', pathIncludes: '.locked', code: 'EACCES', times: 1 });
  const fake = await caught(ffs.rename(from, to));

  assert.deepEqual(Object.keys(fake).sort(), Object.keys(realRename).sort());
  assert.equal(fake.code, 'EACCES');
  assert.equal(fake.syscall, 'rename');
  assert.equal(fake.path, from);
  assert.equal(fake.dest, to);
  assert.ok(fake.message.endsWith(`rename '${from}' -> '${to}'`));
  assert.equal(await realFs.stat(to), null);

  ffs.addRule({ op: 'link', pathIncludes: 'r-from', code: 'EPERM', times: 1 });
  const linkErr = await caught(ffs.link(from, path.join(dir, 'r-link.txt')));
  assert.equal(linkErr.syscall, 'link');
  assert.equal(linkErr.dest, path.join(dir, 'r-link.txt'));
});

test('times: Infinity fails every call (filesystem without hard links, F-FS-8)', async () => {
  const ffs = new FaultFs(realFs);
  const src = path.join(dir, 'nolink-src.txt');
  await realFs.writeFile(src, Buffer.from('n\n'));
  ffs.addRule({ op: 'link', pathIncludes: '', code: 'EPERM', times: Infinity });
  for (let i = 0; i < 5; i++) {
    const err = await caught(ffs.link(src, path.join(dir, `nolink-${i}.txt`)));
    assert.equal(err.code, 'EPERM');
  }
  assert.equal(ffs.hits.get('link:EPERM:'), 5);
});

test('ENOSPC on writeFile reports syscall write and leaves the old bytes', async () => {
  const ffs = new FaultFs(realFs);
  const p = path.join(dir, 'full-disk.txt');
  await realFs.writeFile(p, Buffer.from('old\n'));
  ffs.addRule({ op: 'writeFile', pathIncludes: 'full-disk', code: 'ENOSPC', times: 1 });
  const err = await caught(ffs.writeFile(p, Buffer.from('new\n')));
  assert.equal(err.code, 'ENOSPC');
  assert.equal(err.syscall, 'write');
  assert.deepEqual(await realFs.readFile(p), Buffer.from('old\n'));
});

test('readFile faults report syscall open', async () => {
  const ffs = new FaultFs(realFs);
  const p = path.join(dir, 'chmod000.txt');
  await realFs.writeFile(p, Buffer.from('c\n'));
  ffs.addRule({ op: 'readFile', pathIncludes: 'chmod000', code: 'EACCES', times: 1 });
  const err = await caught(ffs.readFile(p));
  assert.equal(err.code, 'EACCES');
  assert.equal(err.syscall, 'open');
  assert.equal(err.path, p);
  assert.deepEqual(await ffs.readFile(p), Buffer.from('c\n'));
});

test('the first matching rule wins, in insertion order', async () => {
  const ffs = new FaultFs(realFs);
  const p = path.join(dir, 'order.txt');
  await realFs.writeFile(p, Buffer.from('o\n'));
  ffs.addRule({ op: 'readFile', pathIncludes: 'order', code: 'EACCES', times: 1 });
  ffs.addRule({ op: 'readFile', pathIncludes: 'order.txt', code: 'EBUSY', times: 1 });
  assert.equal((await caught(ffs.readFile(p))).code, 'EACCES');
  assert.equal((await caught(ffs.readFile(p))).code, 'EBUSY');
  assert.deepEqual(await ffs.readFile(p), Buffer.from('o\n'));
});

test('non-matching paths, other ops and non-faultable methods pass through', async () => {
  const ffs = new FaultFs(realFs);
  ffs.addRule({ op: 'writeFile', pathIncludes: 'only-this-one', code: 'EBUSY', times: 1 });
  const sub = path.join(dir, 'pass', 'through');
  await ffs.mkdirp(sub);
  const p = path.join(sub, 'free.txt');
  await ffs.writeFile(p, Buffer.from('f\n'));
  assert.deepEqual(await ffs.readFile(p), Buffer.from('f\n'));
  assert.deepEqual(await ffs.readdir(sub), ['free.txt']);
  const s = await ffs.stat(p);
  assert.ok(s !== null && s.isFile);
  await ffs.rmrf(path.join(dir, 'pass'));
  assert.equal(await ffs.stat(p), null);
  assert.equal(ffs.hits.size, 0);
});

test('addRule refuses times <= 0 and NaN', () => {
  const ffs = new FaultFs(realFs);
  assert.throws(() => ffs.addRule({ op: 'unlink', pathIncludes: 'x', code: 'EBUSY', times: 0 }), RangeError);
  assert.throws(() => ffs.addRule({ op: 'unlink', pathIncludes: 'x', code: 'EBUSY', times: -1 }), RangeError);
  assert.throws(() => ffs.addRule({ op: 'unlink', pathIncludes: 'x', code: 'EBUSY', times: Number.NaN }), RangeError);
});

// Real Node errors have exactly these own keys for single-path and two-path syscalls.
async function realShapeKeys(two: boolean): Promise<string[]> {
  const err = two
    ? await caught(realFs.rename(path.join(dir, 'shape-nope-a'), path.join(dir, 'shape-nope-b')))
    : await caught(realFs.unlink(path.join(dir, 'shape-nope')));
  return Object.keys(err).sort();
}

test('share-none lock: readFile, rename, unlink and link fail EBUSY with Node-identical errors until released', async () => {
  const ffs = new FaultFs(realFs);
  const f = path.join(dir, 'held-none.xlsx');
  await realFs.writeFile(f, Buffer.from('h\n'));
  const release = ffs.holdLock('held-none', 'share-none');

  const one = await realShapeKeys(false);
  const two = await realShapeKeys(true);
  const r = await caught(ffs.readFile(f));
  assert.equal(r.code, 'EBUSY');
  assert.equal(r.syscall, 'open');
  assert.equal(r.path, f);
  assert.deepEqual(Object.keys(r).sort(), one);
  assert.equal(r.constructor, Error);
  assert.equal(getSystemErrorName(r.errno as number), 'EBUSY');

  const to = path.join(dir, 'held-none-to.xlsx');
  const rn = await caught(ffs.rename(f, to));
  assert.equal(rn.code, 'EBUSY');
  assert.equal(rn.syscall, 'rename');
  assert.equal(rn.dest, to);
  assert.deepEqual(Object.keys(rn).sort(), two);

  const un = await caught(ffs.unlink(f));
  assert.equal(un.code, 'EBUSY');
  assert.equal(un.syscall, 'unlink');
  assert.deepEqual(Object.keys(un).sort(), one);

  const ln = await caught(ffs.link(f, path.join(dir, 'held-none-link')));
  assert.equal(ln.code, 'EBUSY');
  assert.equal(ln.syscall, 'link');
  assert.equal(await realFs.stat(path.join(dir, 'held-none-link')), null);

  // an unrelated path is untouched; the held file is untouched
  await ffs.writeFile(path.join(dir, 'free.txt'), Buffer.from('f\n'));
  assert.deepEqual(await realFs.readFile(f), Buffer.from('h\n'));

  release();
  assert.deepEqual(await ffs.readFile(f), Buffer.from('h\n'));
  await ffs.rename(f, to);
  await ffs.unlink(to);
});

test('share-read lock: readFile passes, rename and unlink fail EPERM', async () => {
  const ffs = new FaultFs(realFs);
  const f = path.join(dir, 'held-read.xlsx');
  await realFs.writeFile(f, Buffer.from('h\n'));
  const release = ffs.holdLock('held-read', 'share-read');
  assert.deepEqual(await ffs.readFile(f), Buffer.from('h\n'));
  const rn = await caught(ffs.rename(f, path.join(dir, 'held-read-to')));
  assert.equal(rn.code, 'EPERM');
  assert.equal(rn.syscall, 'rename');
  const un = await caught(ffs.unlink(f));
  assert.equal(un.code, 'EPERM');
  assert.equal(un.syscall, 'unlink');
  assert.deepEqual(await realFs.readFile(f), Buffer.from('h\n'));
  release();
  await ffs.unlink(f);
});

test('setNoHardLinks: link fails EPERM and creates nothing', async () => {
  const ffs = new FaultFs(realFs);
  const f = path.join(dir, 'nolink-src.txt');
  const l = path.join(dir, 'nolink-dst.txt');
  await realFs.writeFile(f, Buffer.from('n\n'));
  ffs.setNoHardLinks(true);
  const err = await caught(ffs.link(f, l));
  assert.equal(err.code, 'EPERM');
  assert.equal(err.syscall, 'link');
  assert.equal(err.path, f);
  assert.equal(err.dest, l);
  assert.equal(await realFs.stat(l), null);
  ffs.setNoHardLinks(false);
  await ffs.link(f, l);
  assert.deepEqual(await realFs.readFile(l), Buffer.from('n\n'));
});

test('interpose runs its hook before the inner op, at most times times', async () => {
  const ffs = new FaultFs(realFs);
  const f = path.join(dir, 'interpose.txt');
  await realFs.writeFile(f, Buffer.from('old\n'));
  const seen: string[] = [];
  ffs.interpose('readFile', 'interpose', async (p) => {
    seen.push(p);
    await realFs.writeFile(p, Buffer.from('raced\n'));
  });
  // the hook ran first, so the inner read sees what the hook wrote
  assert.deepEqual(await ffs.readFile(f), Buffer.from('raced\n'));
  await realFs.writeFile(f, Buffer.from('again\n'));
  assert.deepEqual(await ffs.readFile(f), Buffer.from('again\n'));
  assert.deepEqual(seen, [f]);

  let n = 0;
  ffs.interpose('lstat', 'interpose', async () => {
    n += 1;
  }, 2);
  for (let i = 0; i < 3; i++) await ffs.lstat(f);
  assert.equal(n, 2);
  await ffs.lstat(path.join(dir, 'unrelated-lstat'));
  assert.equal(n, 2);
});

test('calls records every op in call order', async () => {
  const ffs = new FaultFs(realFs);
  const a = path.join(dir, 'calls-a.txt');
  const b = path.join(dir, 'calls-b.txt');
  const c = path.join(dir, 'calls-c.txt');
  await ffs.writeFile(a, Buffer.from('a'));
  await ffs.readFile(a);
  await ffs.link(a, b);
  await ffs.rename(b, c);
  await ffs.lstat(c);
  await ffs.stat(c);
  await ffs.appendFile(c, Buffer.from('z'));
  await ffs.unlink(c);
  await ffs.unlink(a);
  assert.deepEqual(ffs.calls, [
    `writeFile ${a}`,
    `readFile ${a}`,
    `link ${a} -> ${b}`,
    `rename ${b} -> ${c}`,
    `lstat ${c}`,
    `stat ${c}`,
    `appendFile ${c}`,
    `unlink ${c}`,
    `unlink ${a}`,
  ]);
});

test('the widened ops (lstat, writeFileExclusive, rmdir, appendFile) take rules with matching syscalls', async () => {
  const ffs = new FaultFs(realFs);
  const p = path.join(dir, 'widened.txt');
  const cases: Array<[FaultOp, () => Promise<unknown>, string]> = [
    ['lstat', () => ffs.lstat(p), 'lstat'],
    ['writeFileExclusive', () => ffs.writeFileExclusive(p, Buffer.from('x')), 'open'],
    ['rmdir', () => ffs.rmdir(p), 'rmdir'],
    ['appendFile', () => ffs.appendFile(p, Buffer.from('x')), 'open'],
  ];
  for (const [op, run, syscall] of cases) {
    ffs.addRule({ op, pathIncludes: 'widened', code: 'EACCES', times: 1 });
    const err = await caught(run());
    assert.equal(err.code, 'EACCES');
    assert.equal(err.syscall, syscall);
  }
  assert.equal(await realFs.stat(p), null);
});

test('chmod is recorded in calls and takes rules (syscall chmod)', async () => {
  const ffs = new FaultFs(realFs);
  const p = path.join(dir, 'chmod-ffs.txt');
  await realFs.writeFile(p, Buffer.from('x'));
  await ffs.chmod(p, 0o644);
  assert.deepEqual(ffs.calls, [`chmod ${p}`]);
  ffs.addRule({ op: 'chmod', pathIncludes: 'chmod-ffs', code: 'EPERM', times: 1 });
  const err = await caught(ffs.chmod(p, 0o755));
  assert.equal(err.code, 'EPERM');
  assert.equal(err.syscall, 'chmod');
});
