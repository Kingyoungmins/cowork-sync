// Detection ticks write no objects and no git process reads a working file (glossary §26.1 W1, W6; ENG-04, ENG-27;
// INV-ENG-NOREAD; O-STAGED; 01-engine tests 45 and 47; TC-ENG-18, TC-ENG-20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join, sep } from 'node:path';
import { AttrCache } from '../../src/data/attrs.js';
import { DEFAULT_TEAM_CONFIG } from '../../src/data/config.js';
import { DiskEq } from '../../src/engine/diskEq.js';
import { humanOnlyAttribution } from '../../src/engine/deps.js';
import { Snapshotter, type TickInput } from '../../src/engine/snapshot.js';
import { ABSENT } from '../../src/git/oid.js';
import { randomInt, seededRandom } from '../../src/ports/random.js';
import { noTrace } from '../../src/ports/trace.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';
import { contentCalls, makeSnapFixture, type SnapFixture } from '../helpers/snapFixture.js';

async function setup(s: SnapFixture): Promise<{ snap: Snapshotter; inp: TickInput; diskEq: DiskEq }> {
  const snap = new Snapshotter({
    repo: s.repo, fs: s.fs, clock: s.clock, trace: noTrace, peer: '0123456789abcdef0123456789abcdef',
    privateIndex: join(s.f.paths.coworkDir, 'main.index'),
    scratch: { detect: join(s.tmp, 'detect.index'), canon: join(s.tmp, 'canon.index') },
    stage: s.stage, statCache: s.statCache, attribution: humanOnlyAttribution,
    filters: { drivers: [], fingerprint: {}, overCap: null },
  });
  const aTree = (await s.repo.readCommit(s.head)).tree;
  await snap.reseed(aTree);
  const inp: TickInput = {
    A: s.A, aTree, epochBase: s.head, skip: new Set(),
    scope: { attrs: await new AttrCache(s.repo, s.fs).snapshot(s.head, s.A.keys()), config: DEFAULT_TEAM_CONFIG, mergeDrivers: new Set(), localOnlyPaths: new Set(), hooksPathDir: null },
  };
  const diskEq = new DiskEq({
    repo: s.repo, fs: s.fs, stage: s.stage, statCache: s.statCache,
    cmpIndex: join(s.tmp, 'cmp.index'), addIndex: join(s.tmp, 'add.index'),
    isFiltered: () => false, isText: () => true, mutants: new Set(),
    filters: { drivers: [], fingerprint: {}, overCap: null }, isCarried: (p) => snap.isCarried(p),
  });
  return { snap, inp, diskEq };
}

test('20 virtual minutes of saves of the 1.3 MB file every 2.5 s without a materialize leave the loose-object count and bytes unchanged; one materialize adds exactly the dirty blobs', async () => {
  const big = generateBigBomCrlf(26_436, seededRandom('t9-noobjects'));
  assert.ok(big.length > 1_200_000, `the 1.3 MB fixture (${big.length} bytes)`);
  const s = await makeSnapFixture('noobj-soak', { files: { 'big.py': big, 'README.md': Buffer.from('r\n') } });
  try {
    const { snap, inp } = await setup(s);
    const t0 = await snap.tick(inp);
    assert.equal(t0.dirty.size, 0);
    const loose0 = await s.loose();
    const objects0 = await s.objects();
    const saves = (20 * 60_000) / 2_500;
    assert.equal(saves, 480);
    let detected = 0;
    let lastId: string | null = null;
    for (let i = 0; i < saves; i++) {
      s.clock.advance(2_500);
      await s.write('big.py', Buffer.concat([big, Buffer.from(`# save ${i}\r\n`)]));
      const r = await snap.tick(inp);
      assert.equal(r.failed, false);
      if (r.changed.has('big.py')) detected++;
      lastId = r.dirty.get('big.py')?.id ?? null;
    }
    assert.equal(detected, saves, 'every save is still detected');
    assert.deepEqual(await s.loose(), loose0, 'loose-object count and bytes unchanged after 480 detection ticks');
    assert.equal((await s.objects()).size, objects0.size);

    const m = await snap.materialize(inp);
    const objects1 = await s.objects();
    const added = [...objects1].filter(([oid]) => !objects0.has(oid));
    const blobs = added.filter(([, type]) => type === 'blob').map(([oid]) => oid);
    assert.deepEqual(blobs, [m.sRawMap.get('big.py')?.oid], 'exactly the dirty blob');
    assert.equal(m.sRawMap.get('big.py')?.oid, lastId, 'made from the stage copy whose id the last tick computed');
    assert.ok(added.every(([, type]) => type === 'blob' || type === 'tree'), 'besides it only the S_raw trees');
  } finally {
    await s.cleanup();
  }
});

test('a DISK_EQ refresh comparison writes no object', async () => {
  const s = await makeSnapFixture('noobj-diskeq', { autocrlf: true, files: { 'big.py': generateBigBomCrlf(500, seededRandom('t9-eq')), 'src/a.txt': Buffer.from('one\n') } });
  try {
    const { diskEq } = await setup(s);
    const before = await s.loose();
    const x = s.A.get('big.py');
    assert.ok(x);
    assert.deepEqual(await diskEq.eq('big.py', x, x), { equal: true });
    await s.write('big.py', 'a brand new body that is in no object\r\n');
    assert.deepEqual(await diskEq.eq('big.py', x, x), { equal: false, reason: 'differs' });
    await s.write('src/new-file.txt', 'never stored\n');
    assert.deepEqual(await diskEq.eq('src/new-file.txt', ABSENT, null), { equal: false, reason: 'differs' });
    // The comparison ran through a stage-tree refresh on the scratch index, never with -q and never with -w.
    const refresh = s.calls.filter((c) => c.args[0] === 'update-index' && c.args.includes('--refresh'));
    assert.ok(refresh.length >= 2);
    for (const c of refresh) {
      assert.ok(!c.args.includes('-q'));
      assert.equal(c.opts.workTree, s.stage.root);
      assert.equal(c.opts.indexFile, join(s.tmp, 'cmp.index'));
    }
    assert.ok(!s.calls.some((c) => c.args.includes('-w')));
    assert.deepEqual(await s.loose(), before, 'loose-object count and bytes unchanged');
  } finally {
    await s.cleanup();
  }
});

test('over 1,000 ticks and 50 DISK_EQ calls no git argv names a working file', async () => {
  const files: Record<string, Buffer> = {};
  for (let i = 0; i < 6; i++) files[`src/f${i}.txt`] = Buffer.from(`file ${i}\nline two\nline three\n`);
  const s = await makeSnapFixture('noobj-noread', { files });
  try {
    const { snap, inp, diskEq } = await setup(s);
    const random = seededRandom('t9-noread');
    const pick = (n: number): number => randomInt(random, n);
    let eqCalls = 0;
    let created = 0;
    for (let tick = 0; tick < 1_000; tick++) {
      s.clock.advance(2_500);
      if (tick % 10 === 3) await s.write(`src/f${pick(6)}.txt`, `file edit ${tick}\nline two\nline three ${tick}\n`);
      if (tick % 97 === 5) await s.write(`src/new${created++}.txt`, `new ${tick}\n`);
      if (tick % 20 === 0 && eqCalls < 50) {
        const p = `src/f${pick(6)}.txt`;
        const x = s.A.get(p);
        assert.ok(x);
        if (eqCalls % 5 === 4) {
          const old = join(s.tmp, `${tick}.old`);
          await fsp.writeFile(old, `ring bytes ${tick}\n`);
          await diskEq.eqFile(p, old, x);
        } else {
          await diskEq.eq(p, x, x);
        }
        eqCalls++;
      }
      const r = await snap.tick(inp);
      assert.equal(r.failed, false);
      if (tick % 250 === 249) await snap.materialize(inp);
    }
    assert.equal(eqCalls, 50);
    const work = s.f.paths.workTree;
    const isWorkingFile = (a: string): boolean => a.startsWith(work + sep) && !a.startsWith(s.f.paths.gitDir);
    const content = contentCalls(s.calls);
    assert.ok(content.filter((c) => c.args[0] === 'add').length > 0, 'materializations ran route (a)');
    assert.ok(content.filter((c) => c.args[0] === 'hash-object').length > 100);
    for (const c of content) {
      assert.ok(!c.args.some(isWorkingFile), `no argv names a working file: ${c.args.join(' ')}`);
      assert.equal(c.opts.cwd, work, 'run at the repository root');
      if (c.args[0] === 'hash-object') {
        const file = c.args[c.args.indexOf('--') + 1];
        assert.ok(c.args.includes('--stdin') || (file !== undefined && file.startsWith(s.stage.root + sep)), `hash-object reads a stage copy or stdin: ${c.args.join(' ')}`);
      } else {
        assert.equal(c.opts.workTree, s.stage.root, `${c.args[0]} runs on the stage tree`);
      }
    }
    // Every daemon open of a working file is one read bracketed by two lstats; the daemon never writes one.
    const calls = s.fs.calls;
    let workReads = 0;
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i] as string;
      const sp = c.indexOf(' ');
      const op = c.slice(0, sp);
      const p = c.slice(sp + 1);
      if (!isWorkingFile(p)) continue;
      assert.ok(!['writeFile', 'rename', 'unlink', 'link', 'writeFileExclusive', 'appendFile', 'rmrf'].includes(op), `the daemon never changes a working file: ${c}`);
      if (op !== 'readFile') continue;
      workReads++;
      assert.equal(calls[i - 1], `lstat ${p}`);
      assert.equal(calls[i + 1], `lstat ${p}`);
    }
    assert.ok(workReads >= 100, `${workReads} staged reads`);
  } finally {
    await s.cleanup();
  }
});
