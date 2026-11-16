// The incoming form check (Plan 3 Task 6; 03-data §3.2 Algorithm D2, §3.10, DAT-11, I-DAT-13; 05-holds HLD-54; ruling R3-32):
// formCheckIncoming decides per path on (A, TIP) — a text, unfiltered path present on both sides violates when TIP's form (BOM,
// endings) is neither A's nor that of a base-move commit's second parent that changed p — and the apply defers a violating
// path's write group at once (`eol_form`), which becomes one INCOMING `eol-form` record at 60 s and is released when TIP's form
// conforms again. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chainBound, formCheckIncoming, pathChains, setChainWindow } from '../../src/data/formCheck.js';
import type { Oid } from '../../src/git/oid.js';
import { readWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { incomingRecords, loop, onlyWithGuard } from '../helpers/incomingFixture.js';
import { buf, prep, withCores } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const W = 'src/w.cs';
const CRLF = buf('a\r\nb\r\nc\r\n');
const LF = buf('a\nb\nc\n');

/** A tree = `base` with whole-path edits (a test-only scratch index under the peer's cowork tmp/). */
async function editTree(p: PeerFixture, base: Oid, edits: Record<string, Buffer>): Promise<Oid> {
  const repo = p.core.repo;
  const index = join(p.deps.paths.coworkDir, 'tmp', 'formcheck-test.index');
  const list = [];
  for (const [path, bytes] of Object.entries(edits)) list.push({ path, mode: '100644' as const, oid: await repo.hashBytes(bytes, true) });
  return repo.editTree(base, list, index);
}

test('formCheckIncoming flags a form change of a text unfiltered path, decided on (A, TIP)', T10, async () => {
  const files: Record<string, Buffer> = {
    'README.md': buf('# form check\n'), [W]: CRLF, 'src/v.cs': buf('one\r\ntwo\r\nthree\r\n'), 'src/bin.dat': Buffer.from('x\0y\r\nz\r\n', 'latin1'),
    'src/k.secret': buf('s1\r\ns2\r\n'), 'src/gone.cs': buf('g\r\n'), 'src/o.txt': buf('o\n'),
  };
  await withCores('formcheck-direct', { n: 1, files }, async (fx: CoreFixture) => {
    const p = fx.peers[0]!;
    const laC = p.core.view!.laC;
    // c1: w.cs LF (a form change), v.cs CRLF with an edited row, a binary and a filtered path changing form, a deletion and a new path.
    await fx.pushTeamChange({
      [W]: LF, 'src/v.cs': buf('one\r\nTWO\r\nthree\r\n'), 'src/bin.dat': Buffer.from('x\0y\nz\n', 'latin1'), 'src/k.secret': buf('s1\ns2\n'),
      'src/gone.cs': null, 'src/new.cs': buf('n\n'),
    }, { raw: true });
    const c2 = await fx.pushTeamChange({ [W]: buf('a\nB\nc\n') }, { raw: true });   // the newest commit that sets TIP[w.cs]
    await fx.pushTeamChange({ 'src/o.txt': buf('o2\n') });
    const it = await prep(p);
    assert.notEqual(it.tip, laC);
    // `k.secret` stands for a filter=crypt path: the engine's predicate is pathIsText && !pathIsFiltered at EPOCH_BASE.
    const textUnfiltered = (q: string): boolean => !q.endsWith('.secret');
    const got = await formCheckIncoming(p.core.repo, laC, it.tip, it.A, it.tipMap, textUnfiltered);
    assert.deepEqual(got, [{ path: W, commit: c2.live }]);
    // Decided on (A, TIP), not on the LA_C..TIP span: once an apply moved LA_C to TIP while w.cs stayed deferred (A keeps it), the
    // same pair is flagged again with the same commit.
    assert.deepEqual(await formCheckIncoming(p.core.repo, it.tip, it.tip, it.A, it.tipMap, textUnfiltered), [{ path: W, commit: c2.live }]);
    // With TIP's CRLF form kept everywhere, nothing violates.
    assert.deepEqual(await formCheckIncoming(p.core.repo, laC, laC, it.A, it.A, textUnfiltered), []);
    // The same chain read through a predicate that rejects w.cs: nothing (a path the attributes call binary or filtered).
    assert.deepEqual(await formCheckIncoming(p.core.repo, laC, it.tip, it.A, it.tipMap, (q) => q !== W && textUnfiltered(q)), []);
    // A path absent in A or in TIP is never checked: a TIP without w.cs, an A without w.cs.
    const noW = new Map(it.tipMap);
    noW.delete(W);
    assert.deepEqual(await formCheckIncoming(p.core.repo, laC, it.tip, it.A, noW, textUnfiltered), []);
    const aNoW = new Map(it.A);
    aNoW.delete(W);
    assert.deepEqual(await formCheckIncoming(p.core.repo, laC, it.tip, aNoW, it.tipMap, textUnfiltered), []);
  });
});

test("a base-move second parent's form is allowed", T10, async () => {
  await withCores('formcheck-basemove', { n: 1, files: { 'README.md': buf('# base move\n'), [W]: CRLF } }, async (fx) => {
    const p = fx.peers[0]!;
    const repo = p.core.repo;
    const L = p.core.view!.laC;
    const lTree = (await repo.readCommit(L)).tree;
    const A = await repo.readTreeMap(lTree);
    // X[p] LF: the branch commit a base move merged in carries the new form, and the base-move commit C takes it.
    const xTree = await editTree(p, lTree, { [W]: LF });
    const X = await repo.commitTree({ tree: xTree, parents: [L], subject: 'branch commit', trailers: [] });
    const C = await repo.commitTree({ tree: xTree, parents: [L, X], subject: 'base move', trailers: [] });
    const tipMap = await repo.readTreeMap(xTree);
    assert.deepEqual(await formCheckIncoming(repo, L, C, A, tipMap, () => true), [], 'X[p] LF allows TIP[p] LF');
    // A later ordinary commit on top keeps the allowance (the base move is still on the chain (LA_C, TIP]).
    const D = await repo.commitTree({ tree: await editTree(p, xTree, { 'README.md': buf('# later\n') }), parents: [C], subject: 'later', trailers: [] });
    assert.deepEqual(await formCheckIncoming(repo, L, D, A, await repo.readTreeMap((await repo.readCommit(D)).tree), () => true), []);
    // X2[p] CRLF: neither A's nor the second parent's form is TIP's LF → a violation named by the base-move commit.
    const x2Tree = await editTree(p, lTree, { [W]: buf('a\r\nb\r\nc\r\nd\r\n') });
    const X2 = await repo.commitTree({ tree: x2Tree, parents: [L], subject: 'branch commit 2', trailers: [] });
    const C2 = await repo.commitTree({ tree: xTree, parents: [L, X2], subject: 'base move 2', trailers: [] });
    assert.deepEqual(await formCheckIncoming(repo, L, C2, A, tipMap, () => true), [{ path: W, commit: C2 }]);
  });
});

test('the chain window bounds every walk, and formCheckIncoming fails closed at its edge', T10, async () => {
  await withCores('formcheck-window', { n: 1, files: { 'README.md': buf('# window\n'), [W]: CRLF } }, async (fx) => {
    const p = fx.peers[0]!;
    const repo = p.core.repo;
    const L = p.core.view!.laC;
    const lTree = (await repo.readCommit(L)).tree;
    const A = await repo.readTreeMap(lTree);
    // c1 sets w.cs LF (a non-conforming writer), then c2…c4 leave it alone.
    let tree = await editTree(p, lTree, { [W]: LF });
    const c1 = await repo.commitTree({ tree, parents: [L], subject: 'c1', trailers: [] });
    const chain = [c1];
    for (let i = 2; i <= 4; i++) {
      tree = await editTree(p, tree, { 'README.md': buf(`# window ${i}\n`) });
      chain.push(await repo.commitTree({ tree, parents: [chain.at(-1)!], subject: `c${i}`, trailers: [] }));
    }
    const [, c2, , c4] = chain as [Oid, Oid, Oid, Oid];
    const tipMap = await repo.readTreeMap(tree);
    const wants = new Map([[W, A.get(W)!.oid]]);
    try {
      setChainWindow(2);
      // LA_C = c4: the window ends two first-parent commits below it (c2, exclusive), so c1 is outside it: no commit, no stop.
      assert.equal(await chainBound(repo, c4), c2);
      assert.deepEqual((await pathChains(repo, c4, wants, await chainBound(repo, c4))).chains.get(W), { commits: [], stop: null }, 'the walk ends at the window');
      // LA_C = c2: the window reaches L (exclusive): c1 is on the chain but the commit that set A's blob (L) is not — no stop.
      const open = (await pathChains(repo, c4, wants, await chainBound(repo, c2))).chains.get(W)!;
      assert.deepEqual([open.commits.map((c) => c.commit), open.stop], [[c1], null]);
      // Fail closed: no commit of the window changed w.cs, yet TIP's form (LF) is not A's (CRLF): still a violation, named by c1.
      assert.deepEqual(await formCheckIncoming(repo, c4, c4, A, tipMap, () => true), [{ path: W, commit: c1 }]);
    } finally {
      setChainWindow(null);
    }
    // The default window reaches L: the chain is c1, L the stop.
    const full = (await pathChains(repo, c4, wants, await chainBound(repo, c4))).chains.get(W)!;
    assert.deepEqual([full.commits.map((c) => c.commit), full.stop], [[c1], L]);
    assert.deepEqual(await formCheckIncoming(repo, c4, c4, A, tipMap, () => true), [{ path: W, commit: c1 }]);
  });
});

test('an eol-form hold outlives the chain window: the non-conforming blob is never written (fail closed)', T10, async () => {
  const files = { 'README.md': buf('# window hold\n'), [W]: CRLF, 'src/f.txt': buf('f\n') };
  await withCores('formcheck-window-hold', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    const c1 = await fx.pushTeamChange({ [W]: LF }, { raw: true });
    fx.advance(10_000);
    await loop(p);
    assert.equal(p.core.view!.meta.pending[W], 'eol_form');
    try {
      setChainWindow(2);
      for (let i = 0; i < 3; i++) await fx.pushTeamChange({ 'src/f.txt': buf(`f${i}\n`) });   // three commits that leave w.cs alone
      for (let i = 0; i < 3; i++) {
        fx.advance(10_000);
        await loop(p);
      }
      assert.equal(p.core.view!.laC, (await prep(p)).tip, 'LA_C moved to TIP: the window from it no longer reaches c1');
      assert.deepEqual(await readWork(p, W), CRLF, 'the LF blob is never written');
      assert.equal(p.core.view!.meta.pending[W], 'eol_form', 'the hold stays');
      assert.deepEqual(fx.trace.ofKind('form_violation').at(-1), { kind: 'form_violation', peer: p.core.peerId, path: W, commit: c1.live });
    } finally {
      setChainWindow(null);
    }
  });
});

test('a form violation defers its write group at once and becomes an INCOMING eol-form record at 60 s', T10, async () => {
  const files = { 'README.md': buf('# eol form\n'), [W]: CRLF, 'src/u.txt': buf('u\n'), 'src/z.txt': buf('z\n') };
  await withCores('formcheck-defer', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    const c1 = await fx.pushTeamChange({ [W]: LF, 'src/u.txt': buf('u2\n') }, { raw: true });   // one CS: w.cs and its closure u.txt
    await fx.pushTeamChange({ 'src/z.txt': buf('z2\n') });                                    // another CS
    fx.advance(10_000);
    const first = await loop(p);
    assert.equal(first.apply.ran, true);
    assert.deepEqual(first.apply.written, ['src/z.txt'], 'every other group applied');
    assert.equal(p.core.view!.meta.pending[W], 'eol_form', 'deferred eol_form in the same loop');
    assert.equal(p.core.view!.meta.pending['src/u.txt'], 'closure');
    assert.deepEqual(first.apply.closures, [{ paths: ['src/u.txt', W], reason: 'eol_form', path: W }]);
    assert.deepEqual(fx.trace.ofKind('form_violation').map(({ path, commit }) => ({ path, commit })), [{ path: W, commit: c1.live }]);
    assert.deepEqual(incomingRecords(p), [], 'no record before 60 s');
    for (let t = 10; t < 60; t += 10) {
      fx.advance(10_000);
      const l = await loop(p);
      assert.deepEqual(l.created, [], `no record at +${t} s`);
    }
    fx.advance(10_000);
    const due = await loop(p);
    assert.equal(due.created.length, 1, 'one record at 60 s');
    const r = onlyWithGuard(p, 'eol-form');
    assert.deepEqual([r.kind, r.residence, r.state, r.paths], ['INCOMING', 'ON_DISK', 'ACTIVE', ['src/u.txt', W]]);
    assert.ok('h1' in r.blobs);
    assert.deepEqual(r.blobs.h0, { 'src/u.txt': due.it.A.get('src/u.txt')!.oid, [W]: due.it.A.get(W)!.oid });
    assert.deepEqual(r.blobs.h1, { 'src/u.txt': due.it.tipMap.get('src/u.txt')!.oid, [W]: due.it.tipMap.get(W)!.oid });
  });
});

test('I-DAT-13: a non-conforming writer\'s LF blob for a CRLF path is held as eol-form and released when a conforming commit restores the form', T10, async () => {
  const files = { 'README.md': buf('# i-dat-13\n'), [W]: CRLF, 'src/v.cs': buf('v1\r\nv2\r\n') };
  await withCores('formcheck-idat13', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ [W]: LF }, { raw: true });           // the test-only non-conforming writer
    await fx.pushTeamChange({ 'src/v.cs': buf('v1\r\nV2\r\n') });   // a conforming change in another CS
    fx.advance(10_000);
    const first = await loop(p);
    assert.deepEqual(first.apply.written, ['src/v.cs'], 'peers apply src/v.cs');
    assert.equal(p.core.view!.meta.pending[W], 'eol_form', 'and hold src/w.cs');
    for (let i = 0; i < 6; i++) {
      fx.advance(10_000);
      await loop(p);
    }
    const r = onlyWithGuard(p, 'eol-form');
    assert.deepEqual([r.kind, r.state, r.paths], ['INCOMING', 'ACTIVE', [W]]);
    // A conforming commit restores the CRLF form: TIP's form for p conforms again → applied, the record SUBSUMED.
    const restored = buf('a\r\nb\r\nc\r\nd\r\n');
    await fx.pushTeamChange({ [W]: restored }, { raw: true });
    fx.advance(10_000);
    const l = await loop(p);
    assert.deepEqual(l.apply.written, [W]);
    assert.equal(p.core.holds.get(r.id)!.state, 'SUBSUMED');
    assert.deepEqual(l.released, [r.id]);
    assert.equal(p.core.view!.meta.pending[W], undefined);
    assert.ok(!incomingRecords(p).some((x) => x.paths.includes(W)));
  });
});
