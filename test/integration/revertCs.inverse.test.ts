// Algorithm REV steps 2–7, revertInverse, at function level on real clones (Plan 3 Task 17; 05-holds §3.6, HLD-68 FEAT-F10-03…-06,
// §8 Q17; 11-testing §7.11 TC-F10-02, -03, -04, -11 at function level; glossary §20 "Revert", §26.1 W6, §29.3; L-HOLD-STORES). Own
// change-sets are published by this peer's captures or crafted under a retired epoch of this peer (revertFixture.pushAs); the bounds
// run on a host that is the core with scripted trees (the kernel's structural RevertHost). Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CODE_SUBJECT, liveCommitTrailers, type CsTrailer } from '../../src/board/boardCommit.js';
import { conflictMarkerRows } from '../../src/data/rows.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import type { IndexEdit, TreeEntry, TreeMap } from '../../src/git/repo.js';
import { pinCs } from '../../src/holds/changesets.js';
import { lineHash, type ProvEntry } from '../../src/holds/provenance.js';
import { locateCs, revertInverse, type CsLocation, type RevertHost, type RevertResult } from '../../src/holds/revertCs.js';
import { gitCallsOf, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, lines, prep, withCores, wrapGit } from '../helpers/publishHelpers.js';
import { announce, applyNow, csTrailer, humanCs, pushAs, T10 } from '../helpers/revertFixture.js';
import { testRunner } from '../helpers/tmp.js';

const E2 = 'e2'.repeat(16);
const SEAT = '5'.repeat(32);
const text = (r: RevertResult, p: string): string | 'ABSENT' | undefined => {
  const v = r.results.get(p);
  return v === undefined ? undefined : v === ABSENT ? ABSENT : v.toString('utf8');
};

async function found(p: PeerFixture, csId: string): Promise<CsLocation> {
  const r = await locateCs(p.core, csId, { mode: 'verb' });
  assert.ok(r !== null && 'found' in r, `${csId}: ${JSON.stringify(r)}`);
  return r.found;
}

async function inverse(host: RevertHost, loc: CsLocation, mode: 'verb' | 'view' = 'verb'): Promise<RevertResult> {
  const r = await revertInverse(host, loc, { mode });
  assert.ok(!('tooBig' in r), 'not too big');
  return r;
}

/** A live commit of this peer (retired epoch E2) in its own repository, never pushed: the kernel reads C(t)'s commits by oid. */
async function craft(p: PeerFixture, parent: Oid, edits: readonly IndexEdit[], cs: readonly CsTrailer[], csPaths: ReadonlyMap<string, readonly string[]> = new Map()): Promise<Oid> {
  const repo = p.core.repo;
  const tree = await repo.editTree((await repo.readCommit(parent)).tree, edits, join(p.deps.paths.gitDir, 'revert-test.index'));
  const trailers = liveCommitTrailers({ peer: p.core.peerId, epoch: E2, seq: 1 }, ['human'], cs, csPaths, null);
  return repo.commitTree({ tree, parents: [parent], subject: CODE_SUBJECT, trailers });
}

/** The core as the kernel's host with a scripted A = TIP (`side`'s entries of `paths`): every path LIVE text, DISK_EQ true, no busy A/TIP view. */
function scripted(p: PeerFixture, tip: Oid, side: TreeMap, paths: readonly string[]): RevertHost {
  const A = new Map<string, TreeEntry>(paths.flatMap((path) => (side.has(path) ? [[path, side.get(path)!] as const] : [])));
  return {
    ...p.core,
    revertTrees: async () => ({ A, TIP: A, tip }),
    revertTreesNow: () => null,
    revertPaths: async () => () => ({ cls: 'LIVE', filtered: false, text: true }),
    revertDiskEq: async () => true,
  };
}

/** a.txt of TC-F10-02: 40 rows, row 12 `x = <v>`, and (add30) one row the CS added after row 29. */
function a40(v: string, add30: boolean): string {
  const out: string[] = [];
  for (let i = 1; i <= 40; i++) {
    out.push(i === 12 ? `x = ${v}` : `row ${i} of a.txt`);
    if (add30 && i === 29) out.push('line 30 the CS added');
  }
  return out.map((r) => `${r}\n`).join('');
}

/** TC-F10-02's state on peer 0: its CS set row 12 to `x = 2` and added row 30; peer 1 (the teammate) then set row 12 to `x = 3`. */
async function keptHunkScenario(fx: CoreFixture): Promise<{ p: PeerFixture; loc: CsLocation }> {
  const [p, q] = [fx.peers[0]!, fx.peers[1]!];
  const cs = await humanCs(fx, p, { 'a.txt': a40('2', true) });
  await announce(q);
  await applyNow(fx, q);
  await humanCs(fx, q, { 'a.txt': a40('3', true) });
  await applyNow(fx, p);
  await prep(p, true);
  return { p, loc: await found(p, cs.csId) };
}

const FILES: Record<string, Buffer> = {
  'a.txt': buf(a40('1', false)),
  'f.py': buf('def a():\n    return 1\n\ndef b():\n    return 2\n\ndef c():\n    return 3\n\ndef d():\n    return 4\n'),
  'b.ts': buf(lines(8, (i) => `b ${i}`)), 'c.ts': buf(lines(8, (i) => `c ${i}`)), 'g.txt': buf(lines(8, (i) => `g ${i}`)),
  'o.txt': buf(lines(10, (i) => `o.txt keeps row ${i}`)), 'r.txt': buf(lines(10, (i) => `r.txt renamed row ${i}`)),
  'img.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0x00, 0x10]), 'ex.txt': buf(lines(8, (i) => `ex ${i}`)),
  ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`f${n}.txt`, buf(lines(8, (i) => `f${n} row ${i}`))])),
};

test('TC-F10-02 function level: line 12 changed later by the teammate stays as a kept hunk naming the teammate, and line 30 the CS added is removed', T10, async () => {
  await withCores('rev-inv-02', { n: 2, files: FILES }, async (fx) => {
    const { p, loc } = await keptHunkScenario(fx);
    const r = await inverse(p.core, loc);
    assert.equal(text(r, 'a.txt'), a40('3', false), 'row 30 removed, row 12 keeps the teammate\'s x = 3');
    assert.deepEqual(r.kept, [{ path: 'a.txt', a: 12, b: 12, names: ['Peer p2'] }]);
    assert.deepEqual(r.skipped, []);
    const A = p.core.view!.base;
    assert.deepEqual(r.paths, [{ path: 'a.txt', del: 1, add: 0, disk: (await p.core.repo.readTreeMap(A)).get('a.txt')!.oid }]);
  });
});

test('TC-F10-03 function level: a CS published as checkpoint seq 1, checkpoint seq 2 and closed seq 3 reverts to the file before seq 1 plus the teammate\'s edit between seq 1 and 2, byte-equal', T10, async () => {
  await withCores('rev-inv-03', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const cs = `${SEAT}/1`;
    const base = FILES['f.py']!.toString('utf8');
    const s1 = base.replace('    return 1\n', '    return 1\n    a_extra = 1\n');
    const team = s1.replace('    return 2\n', '    return 22\n');
    const s2 = team.replace('    return 3\n', '    return 3\n    c_extra = 3\n');
    const s3 = s2.replace('    return 4\n', '    return 4\n    d_extra = 4\n');
    const list = new Map([[cs, ['f.py']]]);
    const c1 = await pushAs(fx, p, { epoch: E2, seq: 1, cs: [csTrailer(cs, 1, { state: 'checkpoint', seq: 1 })], csPaths: list, changes: { 'f.py': s1 } });
    await fx.pushTeamChange({ 'f.py': buf(team) });
    const c2 = await pushAs(fx, p, { epoch: E2, seq: 2, cs: [csTrailer(cs, 1, { state: 'checkpoint', seq: 2 })], csPaths: list, changes: { 'f.py': s2 } });
    const c3 = await pushAs(fx, p, { epoch: E2, seq: 3, cs: [csTrailer(cs, 1, { state: 'closed', seq: 3 })], csPaths: list, changes: { 'f.py': s3 } });
    await applyNow(fx, p);
    await prep(p, true);
    const loc = await found(p, cs);
    assert.deepEqual(loc.commits, [c1.live, c2.live, c3.live], 'C(t): every commit of the CS, first-parent order');
    const r = await inverse(p.core, loc);
    assert.equal(text(r, 'f.py'), base.replace('    return 2\n', '    return 22\n'), 'the file before seq 1 plus the teammate\'s edit, byte-equal');
    assert.deepEqual(r.kept, []);
    assert.deepEqual(r.skipped, []);
  });
});

test('TC-F10-04 function level: a path another Cowork-CS of the same commit covers is MIXED; a CS of 300 paths without Cowork-CS-Paths covers every path of its commit', T10, async () => {
  await withCores('rev-inv-04', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const peer = p.core.peerId;
    const s4 = `${SEAT}/4`;
    const h7 = `${peer}/human/7`;
    await pushAs(fx, p, {
      epoch: E2, seq: 1, cs: [csTrailer(s4, 2), csTrailer(h7, 1)], csPaths: new Map([[s4, ['b.ts', 'c.ts']], [h7, ['b.ts']]]),
      changes: { 'b.ts': lines(8, (i) => `b ${i}${i === 2 ? ' S4' : ''}${i === 7 ? ' H7' : ''}`), 'c.ts': lines(8, (i) => `c ${i}${i === 4 ? ' S4' : ''}`) },
    });
    await applyNow(fx, p);
    const it = await prep(p, true);
    const r4 = await inverse(p.core, await found(p, s4));
    assert.deepEqual(r4.skipped, [{ path: 'b.ts', key: 'MIXED' }], `b.ts is MIXED naming ${h7}'s cover`);
    assert.deepEqual([...r4.results.keys()], ['c.ts']);
    assert.equal(text(r4, 'c.ts'), lines(8, (i) => `c ${i}`), 'c.ts reverted');
    // The variant: 300 paths (no Cowork-CS-Paths: more than 256) sharing their commit with a CS listing b.ts. A commit of this peer's
    // repository read by the kernel at function level (C(t) given; the host is the core with its A and TIP holding the commit's sides).
    const s5 = `${SEAT}/5`;
    const h8 = `${peer}/human/8`;
    const created = Array.from({ length: 299 }, (_, i) => `n/n${String(i).padStart(3, '0')}.txt`);
    const nb = await p.core.repo.hashBytes(buf('created\n'), true);
    const bAfter = await p.core.repo.hashBytes(buf(lines(8, (i) => `b ${i} S5`)), true);
    const edits: IndexEdit[] = [...created.map((path): IndexEdit => ({ path, mode: '100644', oid: nb })), { path: 'b.ts', mode: '100644', oid: bAfter }];
    const c5 = await craft(p, it.tip, edits, [csTrailer(s5, 300), csTrailer(h8, 1)], new Map([[h8, ['b.ts']]]));
    const after = await p.core.repo.readTreeMap((await p.core.repo.readCommit(c5)).tree);
    const r5 = await inverse(scripted(p, it.tip, after, [...created, 'b.ts']), { csId: s5, epoch: E2, label: s5, commits: [c5] });
    assert.deepEqual(r5.skipped, [{ path: 'b.ts', key: 'MIXED' }]);
    assert.equal(r5.results.size, 299, 'every other path of the commit is the CS\'s');
    assert.ok(created.every((n) => r5.results.get(n) === ABSENT), 'the 299 files it created are deleted');
  });
});

test('TC-F10-11 function level: a created, untouched file gives ABSENT, a deleted file is restored, a binary changed later is FILE_CHANGED_LATER, a path now excluded is NOT_LIVE, and a rename pair with one side skipped skips the other as RENAME_PAIR (never both files present)', T10, async () => {
  await withCores('rev-inv-11', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const cs = await humanCs(fx, p, {
      'n.txt': lines(6, (i) => `n.txt created row ${i}`), 'o.txt': null, 'img.bin': Buffer.from([0x89, 0x50, 0x00, 0x7f, 0x00, 0x42]),
      'r.txt': null, 'q.txt': FILES['r.txt']!, 'ex.txt': lines(8, (i) => `ex ${i}${i === 3 ? ' CS' : ''}`),
    });
    await fx.pushTeamChange({ 'img.bin': Buffer.from([0x89, 0x50, 0x00, 0x7f, 0x00, 0x43]), 'q.txt': buf(`${FILES['r.txt']!.toString('utf8')}teammate row\n`) });
    await applyNow(fx, p);
    // ex.txt is no LIVE path any more: a secret-scan record makes it LOCAL_ONLY (D5 row 9) at the next iteration.
    let it = await prep(p);
    await p.core.holds.hold(pinCs('secret-scan', [], ['ex.txt'], it.A, { 'ex.txt': it.A.get('ex.txt')!.oid }, 'human', 'none'));
    it = await prep(p, true);
    assert.equal(it.scope('ex.txt').cls, 'LOCAL_ONLY');
    const r = await inverse(p.core, await found(p, cs.csId));
    assert.deepEqual([...r.results.keys()], ['n.txt', 'o.txt']);
    assert.equal(r.results.get('n.txt'), ABSENT, 'a created, untouched file: deleted');
    assert.equal(text(r, 'o.txt'), FILES['o.txt']!.toString('utf8'), 'a deleted file: restored');
    assert.deepEqual(r.skipped, [
      { path: 'ex.txt', key: 'NOT_LIVE' },
      { path: 'img.bin', key: 'FILE_CHANGED_LATER' },
      { path: 'q.txt', key: 'FILE_CHANGED_LATER' },
      { path: 'r.txt', key: 'RENAME_PAIR' },
    ]);
    assert.ok(!r.results.has('q.txt') && !r.results.has('r.txt'), 'never both files present');
  });
});

test('verb mode marks BUSY a path in the open human CS, under a non-terminal record, with A ≠ TIP or with disk ≠ A; view mode applies no BUSY', T10, async () => {
  await withCores('rev-inv-busy', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const changed = (n: number): string => lines(8, (i) => `f${n} row ${i}${i === 4 ? ' CS' : ''}`);
    const cs = await humanCs(fx, p, Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`f${n}.txt`, changed(n)])));
    await prep(p, true);
    await writeWork(p, 'f1.txt', `${changed(1)}open human CS\n`);
    let it = await prep(p);
    assert.ok(p.core.cs.openPaths().has('f1.txt'), 'f1.txt is in the open human CS');
    await p.core.holds.hold(pinCs('t0', [], ['f2.txt'], it.A, { 'f2.txt': it.A.get('f2.txt')!.oid }, 'human', 'none'));
    await fx.pushTeamChange({ 'f3.txt': buf(`${changed(3)}teammate row\n`) });
    it = await prep(p);   // fetched, not applied: A[f3] ≠ TIP[f3]
    assert.notEqual(it.A.get('f3.txt')!.oid, it.tipMap.get('f3.txt')!.oid);
    await writeWork(p, 'f4.txt', `${changed(4)}disk only\n`);   // no tick since: disk ≠ A
    const loc = await found(p, cs.csId);
    const verb = await inverse(p.core, loc, 'verb');
    assert.deepEqual(verb.skipped, [1, 2, 3, 4].map((n) => ({ path: `f${n}.txt`, key: 'BUSY' })));
    assert.deepEqual([...verb.results.keys()], ['f5.txt']);
    assert.equal(text(verb, 'f5.txt'), FILES['f5.txt']!.toString('utf8'));
    const view = await inverse(p.core, loc, 'view');
    assert.ok(view.skipped.every((s) => s.key !== 'BUSY'), JSON.stringify(view.skipped));
    assert.deepEqual(view.skipped, [{ path: 'f1.txt', key: 'CHANGED_NOW' }, { path: 'f4.txt', key: 'CHANGED_NOW' }], 'changed since the last materialization');
    assert.deepEqual([...view.results.keys()], ['f2.txt', 'f3.txt', 'f5.txt'], 'a held path and an A ≠ TIP path are computed in view mode');
  });
});

test('the step-5 backstop skips a whole path as TEAMMATE_LINE when a result would remove a teammate-added non-trivial line outside the CS\'s journaled add/del sets', T10, async () => {
  await withCores('rev-inv-backstop', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const planted = 'PLANTED = 1';
    const cs = await humanCs(fx, p, { 'g.txt': `${FILES['g.txt']!.toString('utf8')}${planted}\n` });
    await prep(p, true);
    const loc = await found(p, cs.csId);
    assert.deepEqual((await inverse(p.core, loc)).skipped, [], 'a correct run: the backstop is quiet');
    // Plant: the CS's own entry no longer lists the row as added, and a teammate entry (within the window) does.
    const file = join(p.deps.paths.coworkDir, 'prov', `${p.core.refs.e}.jsonl`);
    const entries = (await readFile(file, 'utf8')).split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as ProvEntry);
    const h = lineHash(buf(planted));
    const own = entries.find((e) => e.commit === cs.live)!;
    own.paths['g.txt']!.add = own.paths['g.txt']!.add.filter((x) => x !== h);
    const fake: ProvEntry = { commit: p.core.view!.laB, writer: 'd'.repeat(32), cs_ids: [], t_local_ms: own.t_local_ms, paths: { 'g.txt': { add: [h], del: [] } } };
    entries.splice(entries.indexOf(own), 0, fake);
    await writeFile(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
    assert.equal(await p.core.prov.load(p.core.view!.laC, null), 'loaded');
    const r = await inverse(p.core, loc);
    assert.deepEqual(r.skipped, [{ path: 'g.txt', key: 'TEAMMATE_LINE' }], 'the whole path is skipped');
    assert.equal(r.results.size, 0);
  });
});

test('revertInverse is the only merge-file --ours caller, no conflict marker reaches any result, and steps 1–7 write no object (no hash-object -w in gitCallsOf) and no file', T10, async () => {
  await withCores('rev-inv-w6', { n: 2, files: FILES }, async (fx) => {
    const { p, loc } = await keptHunkScenario(fx);
    const looseCount = async (): Promise<number> => {
      const r = await testRunner().run(['count-objects', '-v'], { class: 'local', cwd: p.deps.paths.workTree });
      return Number(/^count: (\d+)$/m.exec(r.stdout.toString('utf8'))![1]);
    };
    const callsBefore = gitCallsOf(p).length;
    const fsBefore = p.fs.calls.length;
    const objects = await looseCount();
    assert.ok(!gitCallsOf(p).some((c) => c.args.includes('--ours')), 'no --ours before the kernel ran');
    const r = await inverse(p.core, loc);
    const calls = gitCallsOf(p).slice(callsBefore);
    const fsCalls = p.fs.calls.slice(fsBefore);
    assert.ok(calls.some((c) => c.args[0] === 'merge-file' && c.args.includes('--ours')), 'the conflicting region took the --ours run');
    assert.ok(gitCallsOf(p).filter((c) => c.args.includes('--ours')).every((c) => c.args[0] === 'merge-file'));
    for (const [path, v] of r.results) if (v !== ABSENT) assert.deepEqual([...conflictMarkerRows(v)], [], `${path}: no conflict marker`);
    assert.ok(!calls.some((c) => c.args[0] === 'hash-object' && c.args.includes('-w')), 'no hash-object -w');
    assert.ok(!calls.some((c) => ['write-tree', 'mktree', 'commit-tree', 'update-index', 'update-ref', 'read-tree', 'add'].includes(c.args[0]!)), JSON.stringify(calls.map((c) => c.args[0])));
    assert.equal(await looseCount(), objects, 'no loose object');
    assert.deepEqual(fsCalls.filter((c) => /^(writeFile|writeFileExclusive|rename|link|unlink|appendFile|mkdirp|chmod|rmdir) /.test(c)), [], 'no file');
  });
});

test('2,001 paths, a 501st merge-file run or 30 s of the virtual clock give {tooBig: true}, and a path unchanged since the CS (step 4(a)) costs no merge-file run', T10, async () => {
  await withCores('rev-inv-bounds', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const it = await prep(p, true);
    const blob = async (s: string): Promise<Oid> => p.core.repo.hashBytes(buf(s), true);
    const uniform = (oid: Oid, paths: readonly string[]): TreeMap => new Map(paths.map((path) => [path, { path, mode: '100644', oid }]));
    const at = (cs: string, c: Oid): CsLocation => ({ csId: cs, epoch: E2, label: cs, commits: [c] });
    // 2,001 paths in one commit of the CS (no path list: > 256): past REVERT_MAX_PATHS before any merge.
    const big = Array.from({ length: 2_001 }, (_, i) => `big/f${String(i).padStart(4, '0')}`);
    const c2001 = await craft(p, it.tip, [...uniform(await blob('x\n'), big).values()], [csTrailer(`${SEAT}/20`, 2_001)]);
    assert.deepEqual(await revertInverse(p.core, at(`${SEAT}/20`, c2001), { mode: 'view' }), { tooBig: true });

    // 251 paths whose current text conflicts with the CS's change (2 merge-file runs each): the 501st run is never made.
    const [before, after, ours] = [await blob('a\nBEFORE\nb\n'), await blob('a\nAFTER\nb\n'), await blob('a\nOURS\nb\n')];
    const m = Array.from({ length: 251 }, (_, i) => `m/f${String(i).padStart(3, '0')}`);
    const parent = await craft(p, it.tip, [...uniform(before, m).values()], []);
    const cm = await craft(p, parent, [...uniform(after, m).values()], [csTrailer(`${SEAT}/21`, m.length)], new Map([[`${SEAT}/21`, m]]));
    const merges = (from: number): number => gitCallsOf(p).slice(from).filter((c) => c.args[0] === 'merge-file').length;
    let from = gitCallsOf(p).length;
    assert.deepEqual(await revertInverse(scripted(p, it.tip, uniform(ours, m), m), at(`${SEAT}/21`, cm), { mode: 'verb' }), { tooBig: true });
    assert.equal(merges(from), 500, 'REVERT_MAX_MERGES runs, then too big');

    // 30 s of the virtual clock: the first merge takes 31 s (scripted), the next path is past REVERT_MAX_MS.
    let slow = true;
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args.includes('merge-file') && slow) {
        slow = false;
        p.clock.advance(31_000);
      }
      return inner(args, opts);
    });
    try {
      assert.deepEqual(await revertInverse(scripted(p, it.tip, uniform(ours, m.slice(0, 3)), m.slice(0, 3)), at(`${SEAT}/21`, cm), { mode: 'verb' }), { tooBig: true });
    } finally {
      restore();
    }

    // Paths nobody touched since the CS (ours == after): step 4(a), no merge-file run, the files before the CS.
    from = gitCallsOf(p).length;
    const r = await revertInverse(scripted(p, it.tip, uniform(after, m.slice(0, 5)), m.slice(0, 5)), at(`${SEAT}/21`, cm), { mode: 'verb' });
    assert.ok(!('tooBig' in r));
    assert.equal(merges(from), 0);
    assert.deepEqual([...r.results.values()].map((v) => (v === ABSENT ? v : v.toString('utf8'))), Array(5).fill('a\nBEFORE\nb\n'));
  });
});
