// REBASE and its (id, rev, A[p]) cache (05-holds §3.4 item 1; HLD-13, HLD-14; rulings R3-18, R3-19), on a real clone.
// Notation (Task 1 notes): T9 is the 9-line LF text "1\n…9\n" at src/t9.txt; T9{2:two} replaces line 2; B0…B3 are distinct
// 64-byte binary blobs with a NUL at byte 10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyStep } from '../../src/engine/apply.js';
import { currentA, pathIsFiltered, prepareIteration, type EngineCore } from '../../src/engine/core.js';
import { mergeFile } from '../../src/git/merge.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import { GitRepo, type TreeEntry, type TreeMap } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { HoldOperatorError, RebaseCache } from '../../src/holds/rebase.js';
import { makeGuard, type BlobMap, type HoldBlobs, type HoldRecord } from '../../src/holds/record.js';
import { gitCallsOf, makeCores, workPath, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { mergeSides } from '../helpers/mergeFileArgs.js';
import { spyRunner, type GitCall } from '../helpers/snapFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const PEER = '0123456789abcdef0123456789abcdef';
const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const P = 'src/t9.txt';
const T9 = '1\n2\n3\n4\n5\n6\n7\n8\n9\n';

/** T9 with line n replaced by text, for every [n, text]. */
function t9(...edits: Array<[number, string]>): string {
  const rows = T9.split('\n').slice(0, 9);
  for (const [n, s] of edits) rows[n - 1] = s;
  return `${rows.join('\n')}\n`;
}

/** B<k>: 64 bytes of one letter with a NUL at byte 10. */
function binary(k: number): Buffer {
  const b = Buffer.alloc(64, 0x41 + k);
  b[10] = 0;
  return b;
}

interface Ctx { f: RepoFixture; repo: GitRepo; calls: GitCall[]; blob(s: string | Buffer): Promise<Oid>; text(o: OidOrAbsent): Promise<string>; }

async function withRepo(label: string, fn: (c: Ctx) => Promise<void>): Promise<void> {
  const f = await makeRepoFixture(label);
  try {
    const calls: GitCall[] = [];
    const repo = new GitRepo(spyRunner(f.runner, calls), f.paths, fixtureContext);
    await fn({
      f, repo, calls,
      blob: (s) => repo.hashBytes(typeof s === 'string' ? Buffer.from(s, 'utf8') : s, true),
      text: async (o) => (o === ABSENT ? '<ABSENT>' : (await repo.readBlob(o)).toString('utf8')),
    });
  } finally {
    await f.cleanup();
  }
}

/** A map A with one entry per path (ABSENT: no entry). */
function amap(entries: Record<string, OidOrAbsent>): TreeMap {
  const m = new Map<string, TreeEntry>();
  for (const [path, oid] of Object.entries(entries)) if (oid !== ABSENT) m.set(path, { path, mode: '100644', oid });
  return m;
}

function record(blobs: HoldBlobs, o: { id?: string; rev?: number; guards?: string[]; paths?: string[] } = {}): HoldRecord {
  return {
    id: o.id ?? ID, rev: o.rev ?? 1, owner: PEER, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none',
    declines: 0, displaced_by: null, paths: o.paths ?? [P], blobs, guards: (o.guards ?? ['revert']).map((g) => makeGuard(g)), origin: 'human',
    cs_ids: [], peer_authors: [], local_only: false, age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1,
  };
}

const pair = (h0: OidOrAbsent, h1: OidOrAbsent, path = P): HoldBlobs => ({ h0: { [path]: h0 }, h1: { [path]: h1 } });
const mergeCalls = (c: Ctx): GitCall[] => c.calls.filter((x) => x.args[0] === 'merge-file');

test('REBASE is single-step from the original pair', T10, async () => {
  await withRepo('rebase-single', async (c) => {
    const cache = new RebaseCache(c.repo, () => true);
    const h0 = await c.blob(T9);
    const h1 = await c.blob(t9([2, 'two']));
    const r = record(pair(h0, h1));
    const a1 = await c.blob(t9([8, 'eight']));
    const out = await cache.rebase(r, amap({ [P]: a1 }));
    assert.deepEqual(out, { ok: true, h0p: { [P]: a1 }, h1p: { [P]: await c.blob(t9([2, 'two'], [8, 'eight'])) } });
    const first = (out as { h1p: BlobMap }).h1p[P]!;
    const a2 = await c.blob(t9([8, 'EIGHT']));
    const before = mergeCalls(c).length;
    const out2 = await cache.rebase(r, amap({ [P]: a2 }));
    assert.ok(out2.ok);
    assert.equal(await c.text(out2.h1p[P]!), t9([2, 'two'], [8, 'EIGHT']));
    const calls = mergeCalls(c).slice(before);
    assert.equal(calls.length, 1);
    const argv = calls[0]!.args;
    assert.deepEqual(mergeSides(argv), [a2, h0, h1], 'mf(A[p], H0[p], H1[p]) from the original pair');
    assert.ok(!mergeSides(argv).includes(first), 'never the first result');
  });
});

test('REBASE reports a conflict on an adjacent-line team edit', T10, async () => {
  await withRepo('rebase-adjacent', async (c) => {
    const cache = new RebaseCache(c.repo, () => true);
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))));
    const A = amap({ [P]: await c.blob(t9([3, 'three'])) });
    assert.deepEqual(await cache.rebase(r, A), { ok: false, conflicted: [P] });
    // Measured: merge-file exits 1 (one conflict) on lines 2 and 3.
    const direct = await mergeFile(c.repo, A.get(P)!.oid, await c.blob(T9), await c.blob(t9([2, 'two'])));
    assert.equal(direct.rc, 1);
  });
});

test('REBASE of a stage record uses (s1, s2)', T10, async () => {
  await withRepo('rebase-stage', async (c) => {
    const cache = new RebaseCache(c.repo, () => true);
    const r = record({ s1: { [P]: await c.blob(T9) }, s2: { [P]: await c.blob(t9([2, 'two'])) }, s3: { [P]: await c.blob(t9([2, 'TWO'])) } }, { guards: ['conflict'] });
    const a = await c.blob(t9([8, 'eight']));
    const out = await cache.rebase(r, amap({ [P]: a }));
    assert.deepEqual(out, { ok: true, h0p: { [P]: a }, h1p: { [P]: await c.blob(t9([2, 'two'], [8, 'eight'])) } });
  });
});

test('REBASE is cached by (id, rev, A[p])', T10, async () => {
  await withRepo('rebase-cache', async (c) => {
    const cache = new RebaseCache(c.repo, () => true);
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))));
    const A = amap({ [P]: await c.blob(t9([8, 'eight'])) });
    const first = await cache.rebase(r, A);
    const n0 = c.calls.length;
    assert.deepEqual(await cache.rebase(r, A), first);
    assert.equal(c.calls.length, n0, 'a cached REBASE makes no git call');
    assert.deepEqual(await cache.rebase(r, new Map(A)), first);
    assert.equal(c.calls.length, n0, 'the key is A[p], not the map object');
    // A new rev of r recomputes.
    await cache.rebase({ ...r, rev: 2 }, A);
    assert.equal(mergeCalls(c).length, 2);
    // A[p] changed recomputes.
    const A2 = amap({ [P]: await c.blob(t9([8, 'EIGHT'])) });
    const n1 = c.calls.length;
    await cache.rebase(r, A2);
    assert.equal(mergeCalls(c).length, 3);
    assert.ok(c.calls.length > n1);
    // clear() forgets every entry.
    const n2 = c.calls.length;
    await cache.rebase(r, A);
    await cache.rebase(r, A2);
    assert.equal(c.calls.length, n2);
    cache.clear();
    await cache.rebase(r, A);
    await cache.rebase(r, A2);
    assert.equal(mergeCalls(c).length, 5);
    // The key's id: another record with the same rev, pair and A[p] recomputes (its REBASE is its own).
    await cache.rebase({ ...r, id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ' }, A);
    assert.equal(mergeCalls(c).length, 6, 'a different id is a different key');
    await cache.rebase({ ...r, id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ' }, A);
    assert.equal(mergeCalls(c).length, 6);
  });
});

test('a rev evaluated before it is committed never serves another content of that rev (the key carries the path\'s pair)', T10, async () => {
  // commitMany's HLD-07 check REBASEs the records as the batch's patches leave them (rev + 1) before the commit; a refused batch
  // must not leave an entry that answers for the rev + 1 a later commit gives other blobs.
  await withRepo('rebase-cache-uncommitted', async (c) => {
    const cache = new RebaseCache(c.repo, () => true);
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))));
    const A = amap({ [P]: await c.blob(t9([8, 'eight'])) });
    const phantom = { ...r, rev: 2, blobs: pair(await c.blob(T9), await c.blob(t9([2, 'refused batch']))) };
    assert.deepEqual(await cache.rebase(phantom, A), { ok: true, h0p: { [P]: A.get(P)!.oid }, h1p: { [P]: await c.blob(t9([2, 'refused batch'], [8, 'eight'])) } });
    const committed = { ...r, rev: 2, blobs: pair(await c.blob(T9), await c.blob(t9([2, 'committed']))) };
    assert.deepEqual(await cache.rebase(committed, A), { ok: true, h0p: { [P]: A.get(P)!.oid }, h1p: { [P]: await c.blob(t9([2, 'committed'], [8, 'eight'])) } });
    assert.equal(mergeCalls(c).length, 2, 'the committed rev 2 is recomputed');
    await cache.rebase(committed, A);
    assert.equal(mergeCalls(c).length, 2, 'and cached under its own pair');
  });
});

test('REBASE outputs are route (c) blobs in the object store', T10, async () => {
  await withRepo('rebase-route-c', async (c) => {
    const cache = new RebaseCache(c.repo, () => true);
    const want = t9([2, 'two'], [8, 'route c']);
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))));
    const out = await cache.rebase(r, amap({ [P]: await c.blob(t9([8, 'route c'])) }));
    assert.ok(out.ok);
    const h1p = out.h1p[P]! as Oid;
    const env = { ...process.env, LC_ALL: 'C' };
    const hashed = spawnSync('git', ['hash-object', '--stdin', '--no-filters'], { cwd: c.f.paths.workTree, input: Buffer.from(want, 'utf8'), env });
    assert.equal(hashed.stdout.toString('utf8').trim(), h1p);
    assert.equal(spawnSync('git', ['cat-file', '-e', h1p], { cwd: c.f.paths.workTree, env }).status, 0, 'written (-w) before rebase returns');
    const written = c.calls.filter((x) => x.args[0] === 'hash-object');
    assert.ok(written.some((x) => x.args.includes('-w') && x.args.includes('--stdin') && x.args.includes('--no-filters')));
  });
});

test('binary, filtered and ABSENT sides use the whole-path rule and run no merge-file', T10, async () => {
  await withRepo('rebase-whole-path', async (c) => {
    const BIN = 'img/b.dat';
    // The binary path has no attribute and is binary by its bytes (DAT-04); every path is mergeable by attributes here.
    const cache = new RebaseCache(c.repo, () => true);
    const [b0, b1, b2] = [await c.blob(binary(0)), await c.blob(binary(1)), await c.blob(binary(2))];
    const bin = record(pair(b0, b1, BIN), { paths: [BIN] });
    assert.deepEqual(await cache.rebase(bin, amap({ [BIN]: b0 })), { ok: true, h0p: { [BIN]: b0 }, h1p: { [BIN]: b1 } });
    assert.deepEqual(await cache.rebase(bin, amap({ [BIN]: b1 })), { ok: true, h0p: { [BIN]: b1 }, h1p: { [BIN]: b1 } });
    assert.deepEqual(await cache.rebase(bin, amap({ [BIN]: b2 })), { ok: false, conflicted: [BIN] });

    const [e0, e1, e2] = [await c.blob(T9), await c.blob(t9([2, 'two'])), await c.blob(t9([8, 'eight']))];
    // A deletion (h1 ABSENT) and a creation (h0 ABSENT) of a text path.
    const del = record(pair(e0, ABSENT), { id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' });
    assert.deepEqual(await cache.rebase(del, amap({ [P]: e0 })), { ok: true, h0p: { [P]: e0 }, h1p: { [P]: ABSENT } });
    assert.deepEqual(await cache.rebase(del, amap({ [P]: e2 })), { ok: false, conflicted: [P] });
    const add = record(pair(ABSENT, e1), { id: '01ARZ3NDEKTSV4RRFFQ69G5FAX' });
    assert.deepEqual(await cache.rebase(add, amap({})), { ok: true, h0p: { [P]: ABSENT }, h1p: { [P]: e1 } });
    assert.deepEqual(await cache.rebase(add, amap({ [P]: e2 })), { ok: false, conflicted: [P] });
    assert.equal(mergeCalls(c).length, 0, 'no merge-file in any of these');
  });
  // A path with a real filter=crypt attribute at EPOCH_BASE, through the core's binding mergeable(p) = pathIsText(p) &&
  // !pathIsFiltered(p): mergeable lines, but a filtered path never merges.
  await withCore('rebase-whole-path-crypt', { '.gitattributes': Buffer.from('*.enc filter=crypt\n', 'utf8'), 'src/s.enc': Buffer.from(T9, 'utf8') }, async (_fx, p) => {
    const ENC = 'src/s.enc';
    const core = p.core;
    assert.ok((await prepareIteration(core, 1, { materialize: false, forceFetch: true })).ok, 'EPOCH_BASE attributes of A ∪ TIP');
    assert.equal(pathIsFiltered(core, ENC), true);
    const blob = (s: string): Promise<Oid> => core.repo.hashBytes(Buffer.from(s, 'utf8'), true);
    const [e0, e1, e2] = [await blob(T9), await blob(t9([2, 'two'])), await blob(t9([8, 'eight']))];
    const enc = record(pair(e0, e1, ENC), { paths: [ENC] });
    const before = coreMergeCalls(p);
    assert.deepEqual(await core.rebase.rebase(enc, amap({ [ENC]: e0 })), { ok: true, h0p: { [ENC]: e0 }, h1p: { [ENC]: e1 } });
    assert.deepEqual(await core.rebase.rebase(enc, amap({ [ENC]: e1 })), { ok: true, h0p: { [ENC]: e1 }, h1p: { [ENC]: e1 } });
    assert.deepEqual(await core.rebase.rebase(enc, amap({ [ENC]: e2 })), { ok: false, conflicted: [ENC] });
    assert.equal(coreMergeCalls(p), before, 'no merge-file on the filtered path');
  });
});

/** A one-peer core fixture over `files`, bootstrapped. */
async function withCore(label: string, files: Record<string, Buffer>, fn: (fx: CoreFixture, p: PeerFixture) => Promise<void>): Promise<void> {
  const fx = await makeCores(label, { n: 1, files });
  try {
    await fx.bootstrap();
    await fn(fx, fx.peers[0]!);
  } finally {
    await fx.cleanup();
  }
}

const coreMergeCalls = (p: PeerFixture): number => gitCallsOf(p).filter((x) => x.args.includes('merge-file')).length;

test('REBASE\'s base is A[p], never tree(LA_C)[p]', T10, async () => {
  await withRepo('rebase-base-a', async (c) => {
    const cache = new RebaseCache(c.repo, () => true);
    const h0 = await c.blob(T9);
    const h1 = await c.blob(t9([2, 'two']));
    const r = record(pair(h0, h1));
    // A pending path: the state's A[p] is still T9 while live code at LA_C already has T9{8:eight} (the apply deferred p).
    const aP = h0;
    const laC = await c.blob(t9([8, 'eight']));
    const out = await cache.rebase(r, amap({ [P]: aP }));
    assert.ok(out.ok);
    assert.equal(await c.text(out.h1p[P]!), t9([2, 'two']));
    // A test-local operator with tree(LA_C)[p] as its base: it would publish the team's line 8 as this record's change.
    const wrong = await mergeFile(c.repo, laC, h0, h1);
    assert.equal(wrong.rc, 0);
    assert.equal(wrong.out.toString('utf8'), t9([2, 'two'], [8, 'eight']));
    assert.notEqual(await c.text(out.h1p[P]!), wrong.out.toString('utf8'));
  });
});

test('REBASE\'s base is A[p], never tree(LA_C)[p], through the registry\'s call path', T10, async () => {
  await withCore('rebase-base-a-core', { 'src/t9.txt': Buffer.from(T9, 'utf8') }, async (fx, p) => {
    const core: EngineCore = p.core;
    const repo = core.repo;
    const blob = (s: string): Promise<Oid> => repo.hashBytes(Buffer.from(s, 'utf8'), true);
    // A pending path: the team's T9{8:eight} is applied while a share-read holder refuses the rename (deferred 'locked'), so
    // LA_C := TIP while the state's A[p] stays T9 (ENG-36).
    await fx.pushTeamChange({ [P]: Buffer.from(t9([8, 'eight']), 'utf8') });
    const release = p.fs.holdLock(workPath(p, P), 'share-read');
    fx.advance(10_000);
    const prep = await prepareIteration(core, 1, { materialize: 'auto', forceFetch: true });
    assert.ok(prep.ok);
    const report = await applyStep(core, prep.it);
    release();
    assert.equal(report.deferred.get(P), 'locked');
    const T9oid = await blob(T9);
    const eight = await blob(t9([8, 'eight']));
    assert.equal((await currentA(core)).A.get(P)?.oid, T9oid, 'A[p] = T9');
    assert.equal((await repo.readTreeMap((await repo.readCommit(core.view!.laC)).tree)).get(P)?.oid, eight, 'tree(LA_C)[p] = T9{8:eight}');
    // r: (T9{5:five}, T9{2:two,5:five}). REBASE at A[p] gives T9{2:two}; at tree(LA_C)[p] it would give T9{2:two,8:eight}.
    const hold = (h0: Oid, h1: Oid, guard: string): ReturnType<typeof core.holds.holdOutcome> => core.holds.holdOutcome({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [P], blobs: { h0: { [P]: h0 }, h1: { [P]: h1 } }, guard, origin: 'human', cs_ids: [], displaced_by: null,
    });
    const id = (await hold(await blob(t9([5, 'five'])), await blob(t9([2, 'two'], [5, 'five'])), 'revert')).id;
    const m0 = gitCallsOf(p).filter((x) => x.args.includes('merge-file')).length;
    const viaLaC = await hold(eight, await blob(t9([2, 'two'], [8, 'eight'])), 'join');
    assert.equal(viaLaC.created, true, 'a held side that converges only under a tree(LA_C) base is another change');
    const argv = gitCallsOf(p).filter((x) => x.args.includes('merge-file')).slice(m0)[0]!.args;
    assert.deepEqual(mergeSides(argv), [T9oid, await blob(t9([5, 'five'])), await blob(t9([2, 'two'], [5, 'five']))], 'mf(A[p], H0[p], H1[p])');
    assert.ok(!argv.includes(eight), 'tree(LA_C)[p] never reaches merge-file');
    assert.deepEqual(await hold(T9oid, await blob(t9([2, 'two'])), 'join'), { id, created: false, attachedGuard: 'join', conflictedExisting: false }, 'REBASE at A[p] converges');
  });
});

test('the core clears its RebaseCache at every iteration start, so a pruned REBASE output is never served', T10, async () => {
  // h0, h1 and A[p] are committed files (reachable through HEAD); only the REBASE output is a loose unreferenced object.
  const files = { 'src/t9.txt': Buffer.from(T9, 'utf8'), 'src/two.txt': Buffer.from(t9([2, 'two']), 'utf8'), 'src/eight.txt': Buffer.from(t9([8, 'eight']), 'utf8') };
  await withCore('rebase-cache-iteration', files, async (_fx, p) => {
    const core = p.core;
    const repo = core.repo;
    const blob = (s: string): Promise<Oid> => repo.hashBytes(Buffer.from(s, 'utf8'), false);
    const env = { ...process.env, LC_ALL: 'C' };
    const exists = (o: OidOrAbsent): boolean => spawnSync('git', ['cat-file', '-e', o], { cwd: p.deps.paths.workTree, env }).status === 0;
    assert.ok((await prepareIteration(core, 1, { materialize: false, forceFetch: true })).ok);
    const r = record(pair(await blob(T9), await blob(t9([2, 'two']))));
    const A = amap({ [P]: await blob(t9([8, 'eight'])) });
    const first = await core.rebase.rebase(r, A);
    assert.ok(first.ok);
    const out = first.h1p[P]!;
    assert.equal(exists(out), true);
    const gc = spawnSync('git', ['gc', '--prune=now', '--quiet'], { cwd: p.deps.paths.workTree, encoding: 'utf8', env });
    assert.equal(gc.status, 0, gc.stderr);
    assert.equal(exists(out), false, 'a user\'s gc pruned the unreferenced REBASE output');
    assert.equal(exists(A.get(P)!.oid), true);
    const m0 = coreMergeCalls(p);
    assert.ok((await prepareIteration(core, 2, { materialize: false, forceFetch: true })).ok);
    const again = await core.rebase.rebase(r, A);
    assert.equal(coreMergeCalls(p), m0 + 1, 'the new iteration recomputes');
    assert.deepEqual(again, first);
    assert.equal(exists(out), true, 'the output is in the object store again (route (c) -w)');
    const m1 = coreMergeCalls(p);
    await core.rebase.rebase(r, A);
    assert.equal(coreMergeCalls(p), m1, 'within one iteration the cache answers');
  });
});

test('paths named __proto__ and constructor are ordinary blob-map keys', T10, async () => {
  await withRepo('rebase-proto-paths', async (c) => {
    const cache = new RebaseCache(c.repo, () => true);
    const PROTO = '__proto__';
    const CTOR = 'constructor';
    const base = await c.blob(T9);
    const held = await c.blob(t9([2, 'two']));
    const a = await c.blob(t9([8, 'eight']));
    const merged = await c.blob(t9([2, 'two'], [8, 'eight']));
    const r = record({ h0: { [PROTO]: base, [CTOR]: base }, h1: { [PROTO]: held, [CTOR]: held } }, { paths: [PROTO, CTOR] });
    const out = await cache.rebase(r, amap({ [PROTO]: a, [CTOR]: a }));
    assert.deepEqual(out, { ok: true, h0p: { [PROTO]: a, [CTOR]: a }, h1p: { [PROTO]: merged, [CTOR]: merged } });
    assert.ok(out.ok && Object.prototype.hasOwnProperty.call(out.h0p, PROTO) && Object.prototype.hasOwnProperty.call(out.h1p, PROTO), 'own keys');
    assert.equal(await cache.converges(r, amap({ [PROTO]: a, [CTOR]: a }), { [PROTO]: merged, [CTOR]: merged }), true);
    // A filter-failure record holds no h1 for `constructor`: a conflict, never Object.prototype.constructor read as an oid.
    const ff = record({ h0: { [CTOR]: base }, h1: {} }, { paths: [CTOR], guards: ['filter-failure'], id: '01ARZ3NDEKTSV4RRFFQ69G5FAX' });
    assert.deepEqual(await cache.rebase(ff, amap({ [CTOR]: a })), { ok: false, conflicted: [CTOR] });
    const ffProto = record({ h0: { [PROTO]: base }, h1: {} }, { paths: [PROTO], guards: ['filter-failure'], id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' });
    assert.deepEqual(await cache.rebase(ffProto, amap({ [PROTO]: a })), { ok: false, conflicted: [PROTO] });
  });
});

/** The loose object file of `o` in the fixture's object store. */
function looseFile(f: RepoFixture, o: Oid): string {
  const file = join(f.paths.gitDir, 'objects', o.slice(0, 2), o.slice(2));
  assert.ok(readdirSync(join(f.paths.gitDir, 'objects', o.slice(0, 2))).includes(o.slice(2)), 'the object is loose');
  return file;
}

test('a merge-file error is not a conflict', T10, async (t) => {
  const f = await makeRepoFixture('rebase-operator-error');
  try {
    // The input becomes unreadable exactly while the merge reads it (after REBASE's own blob read): a real git process that dies on a
    // corrupt object, never a mocked exit code. Ruling G1-FILEFORM: merge-file runs over scratch copies of the sides, which runMergeFile
    // reads with one cat-file --batch — the second read naming h1 (the first is REBASE's binary sniff of the same sides). The runner
    // wrapper only swaps the loose file around that read.
    const calls: GitCall[] = [];
    const exits: number[] = [];
    const reads: number[] = [];
    let corrupt: { file: string; good: Buffer; h1: Oid; seen: number } | null = null;
    const inner = spyRunner(f.runner, calls);
    const runner: GitRunner = {
      async run(args, opts) {
        const names = corrupt !== null && args[0] === 'cat-file' && args[1] === '--batch' && args.length === 2 && opts.stdin?.toString('utf8').includes(corrupt.h1) === true;
        const plant = names && ++corrupt!.seen === 2;
        if (plant) writeFileSync(corrupt!.file, Buffer.from('this is not a zlib stream', 'utf8'));
        try {
          const res = await inner.run(args, opts);
          if (plant) reads.push(res.code);
          if (args[0] === 'merge-file') exits.push(res.code);
          return res;
        } finally {
          if (plant) writeFileSync(corrupt!.file, corrupt!.good);
        }
      },
    };
    const repo = new GitRepo(runner, f.paths, fixtureContext);
    const cache = new RebaseCache(repo, () => true);
    const blob = (s: string): Promise<Oid> => repo.hashBytes(Buffer.from(s, 'utf8'), true);
    const h0 = await blob(T9);
    const h1 = await blob(t9([2, 'only in this test: corrupt me']));
    const r = record(pair(h0, h1));
    const A = amap({ [P]: await blob(t9([8, 'eight'])) });
    const file = looseFile(f, h1);
    chmodSync(file, 0o644);
    corrupt = { file, good: readFileSync(file), h1, seen: 0 };
    const err = await cache.rebase(r, A).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof HoldOperatorError, `got ${String(err)}`);
    assert.equal(err.op, 'rebase');
    assert.equal(err.path, P);
    assert.equal(err.holdId, r.id);
    assert.match(err.message, /merge-file ended abnormally, its stderr names an error, or its exit is not a conflict count/);
    assert.equal(reads.length, 1, 'the merge read its sides once, over the corrupt object');
    assert.equal(exits.length, 0, 'no merge-file ran over an unreadable side (rc -1: an error, not a conflict count)');
    t.diagnostic(`cat-file --batch exit on the corrupt input: ${reads[0]}`);
    // Nothing was cached: with the object readable again the next call runs merge-file again and merges.
    corrupt = null;
    const out = await cache.rebase(r, A);
    assert.equal(exits.length, 1);
    assert.deepEqual(exits[0], 0);
    assert.doesNotThrow(() => mergeSides(calls.filter((c) => c.args[0] === 'merge-file').at(-1)!.args), 'the executed form is the file form over scratch copies (G1-FILEFORM)');
    assert.ok(out.ok);
    assert.equal((await repo.readBlob(out.h1p[P] as Oid)).toString('utf8'), t9([2, 'only in this test: corrupt me'], [8, 'eight']));
  } finally {
    await f.cleanup();
  }
});

test('converges: equal, REBASE-converging and diverging held sides', T10, async () => {
  await withRepo('rebase-converges', async (c) => {
    const cache = new RebaseCache(c.repo, () => true);
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))));
    const A0 = amap({ [P]: await c.blob(T9) });
    assert.equal(await cache.converges(r, A0, { [P]: await c.blob(t9([2, 'two'])) }), true);
    const A1 = amap({ [P]: await c.blob(t9([8, 'eight'])) });
    assert.equal(await cache.converges(r, A1, { [P]: await c.blob(t9([2, 'two'], [8, 'eight'])) }), true);
    assert.equal(await cache.converges(r, A1, { [P]: await c.blob(t9([2, 'TWO'], [8, 'eight'])) }), false);
    const A2 = amap({ [P]: await c.blob(t9([3, 'three'])) });
    assert.equal(await cache.converges(r, A2, { [P]: await c.blob(t9([2, 'two'], [8, 'eight'])) }), false);
    assert.equal(await cache.converges(r, A2, { [P]: await c.blob(t9([2, 'TWO'], [8, 'eight'])) }), false);
    assert.equal(await cache.converges(r, A2, { [P]: await c.blob(t9([2, 'two'], [3, 'three'])) }), false, 'a REBASE conflict never converges');
    // Another path set never converges.
    assert.equal(await cache.converges(r, A1, { [P]: await c.blob(t9([2, 'two'], [8, 'eight'])), 'src/other.txt': ABSENT }), false);
    // Final review r2 D-1 (HLD-07 "the current H1'", R3-14; the brief's "with A = T9{3:three} … always false"): an h1 equal to r's
    // STORED held side is r's change only while A is r's original base. At A = T9 that is decided by equality, without git.
    const held = await c.blob(t9([2, 'two']));
    const m0 = mergeCalls(c).length;
    assert.equal(await cache.converges(record(r.blobs, { id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ' }), A0, { [P]: held }), true, 'A is r\'s base: equal to the held side converges');
    assert.equal(mergeCalls(c).length, m0, 'decided by equality: no merge-file');
    // Once A moved, the stored side is not H1': at A1 (a clean REBASE, H1' = T9{2:two, 8:eight}) the stored side is a different
    // change (it also drops A1's row 8 — a stale save over a teammate's newer line), and at A2 REBASE conflicts, so r has no H1'.
    assert.equal(await cache.converges(record(r.blobs, { id: '01ARZ3NDEKTSV4RRFFQ69G5FB0' }), A1, { [P]: held }), false, 'A moved: equal to the stored held side is not H1\'');
    assert.deepEqual(await cache.rebase(record(r.blobs, { id: '01ARZ3NDEKTSV4RRFFQ69G5FAY' }), A2), { ok: false, conflicted: [P] }, 'REBASE at A = T9{3:three} conflicts');
    assert.equal(await cache.converges(record(r.blobs, { id: '01ARZ3NDEKTSV4RRFFQ69G5FB1' }), A2, { [P]: held }), false, 'a REBASE conflict: equal to the stored held side never converges');
  });
});

/**
 * Claim-state reads in a module's source (HLD-06): an import from a claim, gate or fence module, or of a name containing one of
 * those words (PublishGatePort, the one claim-dependent input), an import from the board fold (FoldState carries `claims`), or a
 * `claims` member read. Guard names in string literals ('claim', 'claim-breach') are Table 3 rows, not claim state.
 */
function claimReads(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*import\s+([^;]*?)\s+from\s+'([^']+)'/gms)) {
    const names = m[1]!;
    const spec = m[2]!;
    if (/claim|gate|fence/i.test(spec) || /\/board\/fold(\.js)?$/.test(spec)) out.push(`import from ${spec}`);
    for (const n of names.match(/[A-Za-z_$][\w$]*/g) ?? []) if (/claim|gate|fence/i.test(n)) out.push(`import of ${n}`);
  }
  for (const m of src.matchAll(/(?:\??\.\s*claims\b|\[\s*['"`]claims['"`]\s*\])/g)) out.push(`read of ${m[0]}`);
  return out;
}

test('no operator of this task reads claim state', T10, async () => {
  // The scanner catches realistic violations ...
  const planted: Array<[string, string]> = [
    ['fold claims', 'import type { FoldState } from \'../board/fold.js\';\nexport const held = (s: FoldState): number => Object.keys(s.claims).length;\n'],
    ['the gate port', 'import type { EngineDeps, PublishGatePort } from \'../engine/deps.js\';\nexport type G = PublishGatePort;\n'],
    ['an index read', 'export const c = (s: Record<string, unknown>): unknown => s[\'claims\'];\n'],
    ['an optional read', 'export const c = (s?: { claims: object }): unknown => s?.claims;\n'],
    ['a claim module', 'import { claimOf } from \'../coord/claims.js\';\nexport const x = claimOf;\n'],
  ];
  for (const [what, src] of planted) assert.notDeepEqual(claimReads(src), [], what);
  // ... and finds none in this task's operators.
  const root = process.cwd();
  for (const file of ['rebase.ts', 'registry.ts', 'record.ts', 'offers.ts', 'codes.ts']) {
    const src = readFileSync(join(root, 'src', 'holds', file), 'utf8');
    assert.ok([...src.matchAll(/^\s*import\s/gm)].length > 0 || file === 'codes.ts', file);
    assert.deepEqual(claimReads(src), [], file);
  }
  await withRepo('rebase-claim-free', async (c) => {
    const cache = new RebaseCache(c.repo, () => true);
    const blobs = pair(await c.blob(T9), await c.blob(t9([2, 'two'])));
    const A = amap({ [P]: await c.blob(t9([8, 'eight'])) });
    const plain = await cache.rebase(record(blobs, { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }), A);
    const claimed = await cache.rebase(record(blobs, { id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', guards: ['revert', 'claim:abcdefghij234567'] }), A);
    assert.deepEqual(claimed, plain);
  });
});
