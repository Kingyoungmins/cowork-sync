// Publish (01-engine §3.12; ENG-39…ENG-44; PRO-09, PRO-42; HLD-42; glossary §24 defaults 1 and 3; rulings R-02, R-30) on
// EngineCores over real clones of a file:// remote: the commit shapes, the ok update, publish-side K4 and concat, the
// rename carry, empty-oid injection, mutant M06, the publish trace event and the journal/crashpoint order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CODE_SUBJECT, parseCsTrailers, readBoardCommit } from '../../src/board/boardCommit.js';
import type { OpDraft } from '../../src/board/ops.js';
import { applyStep } from '../../src/engine/apply.js';
import { attachState, prepareIteration } from '../../src/engine/core.js';
import { publishStep, publishTreeRefused } from '../../src/engine/publish.js';
import { mergeTree } from '../../src/git/merge.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import { GitCommandError, type IndexEdit, type TreeEntry } from '../../src/git/repo.js';
import { setCrashHandler } from '../../src/ports/crashpoint.js';
import { gitCallsOf, readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import {
  blobText, buf, captureReady, editAndCapture, failedResult, lines, prep, pushCalls, remoteBoard, remoteCode, setMutants, stateA, treeOf,
  withCores, wrapGit,
} from '../helpers/publishHelpers.js';
import { testRunner } from '../helpers/tmp.js';

const ts = (name: string): string => lines(12, (i) => `export const ${name}${i} = ${i};`);
/** `text` with row i (1-based) replaced. */
function withRow(text: string, i: number, row: string): string {
  const rs = text.split('\n');
  rs[i - 1] = row;
  return rs.join('\n');
}
const P_BASE = lines(40, (i) => `value_${i} = ${i}  # p.py row ${i}`);
/** A pending op allowed in the ok state (a health event would be dropped in normal mode, P2-R18). */
const freezeEvent = (): OpDraft => ({ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'FREEZE_EPOCH' });
const NOTES = '# Notes\n\nalpha\n';

const FILES: Record<string, Buffer> = {
  'README.md': buf('# publish fixture\n'),
  'notes.md': buf(NOTES),
  'p.py': buf(P_BASE),
  'src/a.ts': buf(ts('a')),
  'src/w.ts': buf(ts('w')),
  'src/x.ts': buf(ts('x')),
  'src/y.ts': buf(ts('y')),
  'src/z.ts': buf(ts('z')),
};

const X_LOCAL = withRow(ts('x'), 2, 'export const x2 = 200; // local');
const X_TEAM = withRow(ts('x'), 2, 'export const x2 = 300; // team');
const Y_LOCAL = withRow(ts('y'), 6, 'export const y6 = 600; // local');
const Z_TEAM = withRow(ts('z'), 6, 'export const z6 = 600; // team');
const W_LOCAL = withRow(ts('w'), 9, 'export const w9 = 900; // local');

/** Advances past the governor window (a fetch that saw a new tip re-anchors it) and prepares the next iteration. */
async function windowOpen(fx: CoreFixture, p: PeerFixture): Promise<Awaited<ReturnType<typeof prep>>> {
  await prep(p);
  fx.advance(6_000);
  return prep(p);
}

test('a human CS publishes after 20 s quiet: C = commit-tree OUT -p TIP with Cowork-CS state=closed origin=human checks=skipped and Cowork-CS-Paths; Bnew parents [T, C]; the mirror refspec only when the fetched mirror is ABSENT or an ancestor of TIP', async () => {
  await withCores('pub-human', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const T0 = p.core.view!.laB;
    const TIP0 = p.core.view!.laC;
    const A_EDIT = withRow(ts('a'), 4, 'export const a4 = 44;');
    await writeWork(p, 'src/a.ts', A_EDIT);
    await prep(p);
    fx.advance(10_000);
    let it = await prep(p);
    assert.equal(p.core.cs.closeDue(), false, 'the human CS is not 20 s quiet yet');
    const early = await publishStep(p.core, it);
    assert.equal(early.outcome, 'nothing', 'nothing is ready before the close');
    assert.equal(pushCalls(p), 0);
    fx.advance(10_000);
    it = await prep(p, true);
    assert.equal(p.core.cs.closeDue(), true, '20 s without a change closes the human CS');
    const pair = await captureReady(p, it);
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.ok(r.c !== null && r.bnew !== null);

    const c = await p.core.repo.readCommit(r.c);
    assert.deepEqual(c.parents, [TIP0], 'C = commit-tree OUT -p TIP');
    assert.equal(c.subject, CODE_SUBJECT);
    const cs = parseCsTrailers(c.trailers);
    assert.deepEqual(cs.cs, [{ csId: pair.csId, state: 'closed', seq: 0, origin: 'human', checks: 'skipped', paths: 1 }]);
    assert.deepEqual(cs.paths.get(pair.csId), ['src/a.ts'], 'Cowork-CS-Paths lists the CS paths');
    assert.ok(c.trailers.some((t) => t.key === 'Cowork-Seat' && t.value === 'human'));
    assert.equal(await blobText(p, await treeOf(p, r.c), 'src/a.ts'), A_EDIT, 'OUT carries the published edit');
    const b = await p.core.repo.readCommit(r.bnew);
    assert.deepEqual(b.parents, [T0, r.c], 'Bnew parents [T, C]');
    const writer = (x: typeof b): string | undefined => x.trailers.find((t) => t.key === 'Cowork-Writer')?.value;
    assert.equal(writer(b), writer(c), 'C and Bnew share one Cowork-Writer (PRO-09)');
    assert.equal(await remoteBoard(fx, p), r.bnew);
    const code = p.core.refs.remoteCode;
    let push = fx.trace.ofKind('push').at(-1)!;
    assert.equal(push.purpose, 'publish');
    assert.ok(push.argv.includes(`--force-with-lease=${code}:${TIP0}`), 'the fetched mirror (TIP itself) is an ancestor of TIP: leased');
    assert.ok(push.argv.includes(`${TIP0}:${code}`), 'the mirror is set to TIP (live_code of the leased tip), lagging one publish');
    assert.ok(!push.argv.includes('--atomic'));

    // A fetched mirror that is not an ancestor of TIP gets no mirror refspec.
    const empty = await p.core.repo.emptyTree();
    const X = await p.core.repo.commitTree({ tree: empty, parents: [], subject: 'unrelated', trailers: [] });
    const moved = await runPush(p.core.repo, fx.remote.url, [pushSpec(X, code, TIP0)], []);
    assert.equal(moved.statuses.get(code), 'ok');
    await editAndCapture(fx, p, { 'src/y.ts': Y_LOCAL });
    it = await prep(p);
    assert.equal(it.fetched?.code, X);
    const r2 = await publishStep(p.core, it);
    assert.equal(r2.outcome, 'landed');
    push = fx.trace.ofKind('push').at(-1)!;
    assert.ok(!push.argv.some((a) => a.includes(code)), 'no mirror refspec');
    assert.equal(await remoteCode(fx, p), X, 'the mirror is left alone');

    // An ABSENT mirror is leased as absent and set to TIP.
    const del = await testRunner().run(['update-ref', '-d', code], { class: 'local', cwd: fx.remote.dir });
    assert.equal(del.code, 0);
    await editAndCapture(fx, p, { 'src/z.ts': Z_TEAM });
    it = await prep(p);
    assert.equal(it.fetched?.code, 'ABSENT');
    const r3 = await publishStep(p.core, it);
    assert.equal(r3.outcome, 'landed');
    push = fx.trace.ofKind('push').at(-1)!;
    assert.ok(push.argv.includes(`--force-with-lease=${code}:`));
    assert.ok(push.argv.includes(`${r2.c}:${code}`));
    assert.equal(await remoteCode(fx, p), r2.c);
  });
});

test('with P == A and no allowed ops no push is spawned', async () => {
  await withCores('pub-nothing', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const before = await remoteBoard(fx, p);
    let it = await prep(p);
    let r = await publishStep(p.core, it);
    assert.deepEqual({ attempted: r.attempted, outcome: r.outcome }, { attempted: false, outcome: 'nothing' });
    // A change-set whose edit was reverted before the close: its capture has R == A, so P == A.
    await writeWork(p, 'src/a.ts', withRow(ts('a'), 4, 'export const a4 = 44;'));
    await prep(p);
    await writeWork(p, 'src/a.ts', ts('a'));
    await prep(p);
    fx.advance(20_000);
    it = await prep(p, true);
    await captureReady(p, it);
    assert.equal(p.core.view!.ready.length, 1);
    r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'nothing');
    assert.equal(r.attempted, false);
    assert.equal(pushCalls(p), 0, 'no push spawned');
    assert.equal(p.core.pushAttempts, 0, 'no attempt counted');
    assert.equal(await remoteBoard(fx, p), before);
    assert.equal(p.core.view!.ready.length, 0, 'OUT == tree(TIP) with no ops: the pair counts as published (R-02)');
  });
});

test('a board-only publish carries ops only and repeats TIP as its last parent', async () => {
  await withCores('pub-board-only', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { pair } = await editAndCapture(fx, p, { 'src/y.ts': Y_LOCAL });
    // FREEZE: no code publish; a freeze event is allowed (PRO-45) and rides alone.
    await p.core.commit({ meta: { ...p.core.view!.meta, freeze_reasons: ['EPOCH'] } });
    p.core.outbox.add({ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'FREEZE_EPOCH' });
    const T = p.core.view!.laB;
    const TIP = p.core.view!.laC;
    const it = await prep(p);
    assert.deepEqual(it.pushStates, ['frozen']);
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(r.c, null, 'no code commit');
    const b = await readBoardCommit(p.core.repo, r.bnew!);
    assert.deepEqual(b.parents, [T, TIP], 'the last parent repeats TIP');
    assert.equal(b.liveCode, TIP);
    assert.deepEqual(b.cs, [], 'no change-set trailer');
    assert.equal(b.opsLines.length, 1);
    const op = JSON.parse(b.opsLines[0]!) as { type: string; kind: string; reason_code: string };
    assert.deepEqual([op.type, op.kind, op.reason_code], ['event', 'freeze', 'FREEZE_EPOCH']);
    assert.equal(fx.trace.ofKind('push').at(-1)!.purpose, 'board_only');
    const view = p.core.view!;
    assert.equal(view.laC, TIP, 'LA_C unchanged on a board-only publish');
    assert.equal(view.laB, r.bnew);
    assert.deepEqual(view.ready.map((x) => x.csId), [pair.csId], 'the ready pair waits for an unfrozen window');
    assert.equal(p.core.outbox.size, 0, 'the landed op left the outbox');
  });
});

test('the ok update sets LA_C := C, LA_B := Bnew and A[p] := C[p] only where C[p] == P[p]; a K4 path keeps its A', async () => {
  await withCores('pub-ok-update', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const A0 = await stateA(p);
    await editAndCapture(fx, p, { 'src/x.ts': X_LOCAL, 'src/y.ts': Y_LOCAL });
    await fx.pushTeamChange({ 'src/x.ts': buf(X_TEAM), 'src/z.ts': buf(Z_TEAM) });
    const it = await windowOpen(fx, p);
    const mark = fx.trace.events.length;
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(r.records.length, 1, 'one K4 record for src/x.ts');
    const view = p.core.view!;
    assert.equal(view.laC, r.c);
    assert.equal(view.laB, r.bnew);
    const C = await treeOf(p, r.c!);
    const A = await stateA(p);
    assert.equal(await blobText(p, C, 'src/y.ts'), Y_LOCAL);
    assert.equal(A.get('src/y.ts')?.oid, C.get('src/y.ts')?.oid, 'C[p] == P[p]: A follows C');
    assert.equal(await blobText(p, C, 'src/x.ts'), X_TEAM, 'K4: C takes TIP');
    assert.equal(A.get('src/x.ts')?.oid, A0.get('src/x.ts')?.oid, 'a K4 path keeps its A');
    assert.equal(await blobText(p, C, 'src/z.ts'), Z_TEAM);
    assert.equal(A.get('src/z.ts')?.oid, A0.get('src/z.ts')?.oid, 'C[p] == TIP[p] ≠ P[p]: A waits for the apply');
    const aSets = fx.trace.since(mark).filter((e) => e.kind === 'A_set');
    assert.deepEqual(aSets.map((e) => (e.kind === 'A_set' ? [e.path, e.cause] : [])), [['src/y.ts', 'push_confirmed']]);
    assert.equal(view.ready.length, 0, 'the published pair left the journal');
    assert.equal(view.meta.rejections, null);
    assert.equal(view.intent.kind, 'none');
  });
});

test('a publish-side K4 commits an ON_DISK CONFLICTED record before the push, publishes TIP[p] and the CS\'s other paths, never republishes LOCAL from a later capture, and the next apply moves the record OFF_DISK', async () => {
  await withCores('pub-k4', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const A0 = await stateA(p);
    const { pair } = await editAndCapture(fx, p, { 'src/x.ts': X_LOCAL, 'src/y.ts': Y_LOCAL });
    const team = await fx.pushTeamChange({ 'src/x.ts': buf(X_TEAM) });
    const it = await windowOpen(fx, p);
    const from = gitCallsOf(p).length;
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(r.records.length, 1);
    const id = r.records[0]!;
    const calls = gitCallsOf(p).slice(from);
    const cas = calls.findIndex((c) => c.args[0] === 'update-ref' && c.args.includes(p.core.refs.holds));
    const push = calls.findIndex((c) => c.args[0] === 'push');
    assert.ok(cas >= 0 && push > cas, 'the record is committed to the registry before the push is spawned');
    const rec = p.core.holds.get(id)!;
    assert.deepEqual([rec.kind, rec.state, rec.residence, rec.guards.map((g) => g.name)], ['PATCH', 'CONFLICTED', 'ON_DISK', ['conflict']]);
    const tipX = (await treeOf(p, team.live)).get('src/x.ts')!.oid;
    const localX = (await p.core.repo.readTreeMap(pair.R)).get('src/x.ts')!.oid;
    assert.deepEqual(rec.blobs, { s1: { 'src/x.ts': A0.get('src/x.ts')!.oid }, s2: { 'src/x.ts': localX }, s3: { 'src/x.ts': tipX } });
    const C = await treeOf(p, r.c!);
    assert.equal(C.get('src/x.ts')?.oid, tipX, 'TIP[p] is published');
    assert.equal(await blobText(p, C, 'src/y.ts'), Y_LOCAL, 'the CS\'s other paths publish (glossary §24 default 3)');

    // A later capture covering src/x.ts (LOCAL still on disk) never republishes LOCAL: MASK step 4 resets P[p] to A[p].
    await writeWork(p, 'src/w.ts', W_LOCAL);
    await prep(p);
    p.core.cs.observe(['src/x.ts']);
    fx.advance(20_000);
    const it2 = await prep(p, true);
    const pair2 = await captureReady(p, it2);
    assert.ok(pair2.paths.includes('src/x.ts'));
    const r2 = await publishStep(p.core, it2);
    assert.equal(r2.outcome, 'landed', JSON.stringify(r2));
    assert.deepEqual(r2.records, [], 'MASK step 4 withheld LOCAL: no second conflict, no record');
    const C2 = await treeOf(p, r2.c!);
    assert.equal(C2.get('src/x.ts')?.oid, tipX, 'LOCAL is not republished');
    assert.equal(await blobText(p, C2, 'src/w.ts'), W_LOCAL);
    assert.deepEqual(await readWork(p, 'src/x.ts'), buf(X_LOCAL), 'LOCAL stays on disk until the apply');

    // The next apply takes TIP for the unit, dedupes onto the same record and moves it OFF_DISK.
    fx.advance(10_000);
    const it3 = await prep(p, 'auto');
    const ar = await applyStep(p.core, it3);
    assert.ok(ar.written.includes('src/x.ts'), JSON.stringify(ar));
    assert.deepEqual(ar.records, [id], 'the registry dedupes onto the same record');
    assert.equal(p.core.holds.get(id)!.residence, 'OFF_DISK');
    assert.deepEqual(await readWork(p, 'src/x.ts'), buf(X_TEAM));
    assert.equal((await stateA(p)).get('src/x.ts')?.oid, tipX);
  });
});

// The case where a missing MASK step 4 would publish LOCAL outright: once the team puts p back to A[p], LOCAL merges
// cleanly against TIP, so only the CONFLICTED record keeps it out of P.
test('after a publish-side K4 and a teammate putting p back to A[p], a later capture covering p never republishes LOCAL: the pushed tree keeps p == A0[p]', async () => {
  await withCores('pub-k4-restored', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const A0 = await stateA(p);
    await editAndCapture(fx, p, { 'src/x.ts': X_LOCAL, 'src/y.ts': Y_LOCAL });
    await fx.pushTeamChange({ 'src/x.ts': buf(X_TEAM) });
    const r = await publishStep(p.core, await windowOpen(fx, p));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(r.records.length, 1, 'the K4 record of src/x.ts');
    assert.equal((await stateA(p)).get('src/x.ts')?.oid, A0.get('src/x.ts')!.oid, 'the K4 path keeps A');
    await fx.pushTeamChange({ 'src/x.ts': buf(ts('x')) });
    // A later capture covering src/x.ts (LOCAL still on disk) plus another edit.
    await writeWork(p, 'src/w.ts', W_LOCAL);
    const it1 = await prep(p);
    assert.equal(it1.tipMap.get('src/x.ts')?.oid, A0.get('src/x.ts')!.oid, 'TIP[x] == A[x] again');
    p.core.cs.observe(['src/x.ts']);
    fx.advance(20_000);
    const it2 = await prep(p, true);
    const pair2 = await captureReady(p, it2);
    assert.ok(pair2.paths.includes('src/x.ts'));
    const r2 = await publishStep(p.core, it2);
    assert.equal(r2.outcome, 'landed', JSON.stringify(r2));
    const C2 = await treeOf(p, r2.c!);
    assert.equal(C2.get('src/x.ts')?.oid, A0.get('src/x.ts')!.oid, 'the pushed tree keeps A0[x], never X_LOCAL');
    assert.equal(await blobText(p, C2, 'src/w.ts'), W_LOCAL, 'the other edit publishes');
    assert.deepEqual(r2.records, []);
    assert.deepEqual(await readWork(p, 'src/x.ts'), buf(X_LOCAL), 'LOCAL stays on disk (the registry holds it)');
  });
});

// Task 13 → 14 carry ruling (P2-QUARANTINE-IN, P2-NA-TRIGGER): a teammate's change that this clone does not apply keeps
// A[p] ≠ TIP[p]; MASK step 1 (a QUARANTINED path) and the composition (a colliding path is in no ready pair) keep P[p] ==
// A[p], so merge-tree takes TIP's side and the push never reverts the teammate's committed change.
test('a pending QUARANTINED TIP change and a pending colliding TIP creation stay TIP\'s in the push of an unrelated local edit', async () => {
  const S = '.claude/settings.json';
  await withCores('pub-not-applicable', { n: 1, files: { ...FILES, [S]: buf('{"theme":"light"}\n') } }, async (fx) => {
    const p = fx.peers[0]!;
    const A0 = await stateA(p);
    await mkdir(workPath(p, 'build'), { recursive: true });   // a local entry where the teammate creates the file `build`
    await writeWork(p, S, '{"theme":"light","local":1}\n');   // a local edit of the quarantined file: never published either
    const team = await fx.pushTeamChange({ [S]: buf('{"theme":"dark"}\n'), build: buf('#!/bin/sh\necho build\n') });
    fx.advance(10_000);
    const ar = await applyStep(p.core, await prep(p, 'auto'));
    assert.deepEqual([...ar.notApplicable].sort(), [[S, 'quarantine'], ['build', 'collision']], JSON.stringify([...ar.notApplicable]));
    assert.deepEqual(p.core.view!.meta.pending, { build: 'collision', [S]: 'quarantine' });
    const A1 = await stateA(p);
    assert.equal(A1.get(S)?.oid, A0.get(S)!.oid, 'A keeps the quarantined path');
    assert.equal(A1.has('build'), false, 'A keeps the colliding path absent');
    const { it } = await editAndCapture(fx, p, { 'src/y.ts': Y_LOCAL });
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const TIP = await treeOf(p, team.live);
    const C = await treeOf(p, r.c!);
    assert.equal(C.get(S)?.oid, TIP.get(S)!.oid, 'the quarantined path keeps TIP[p] (the teammate\'s change is not reverted)');
    assert.equal(C.get('build')?.oid, TIP.get('build')!.oid, 'the colliding path keeps TIP[p]');
    assert.equal(await blobText(p, C, 'src/y.ts'), Y_LOCAL);
    assert.equal((await readWork(p, S))!.toString('utf8'), '{"theme":"light","local":1}\n', 'the quarantined file is never written live; its local edit stays local');
  });
});

test('publish first: OUT keeps p2.py == TIP[p2.py] with the same K4 record and ENG-41 (b) passes', async () => {
  await withCores('pub-rename-carry', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const A0 = await stateA(p);
    const LOCAL_P = withRow(P_BASE, 25, 'value_25 = 2500  # local edit of row 25');
    const { pair } = await editAndCapture(fx, p, { 'p.py': LOCAL_P, 'src/y.ts': Y_LOCAL });
    const RENAMED = withRow(P_BASE, 3, 'value_3 = 300  # team edit of row 3');
    const team = await fx.pushTeamChange({ 'p.py': null, 'p2.py': buf(RENAMED) });
    const it = await windowOpen(fx, p);
    const mark = fx.trace.events.length;
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', `ENG-41 (b) passes and the publish lands: ${JSON.stringify(r)}`);
    const C = await treeOf(p, r.c!);
    const tip2 = (await treeOf(p, team.live)).get('p2.py')!;
    assert.equal(C.get('p2.py')?.oid, tip2.oid, 'OUT keeps p2.py == TIP[p2.py] (no local edit carried into it)');
    assert.equal(C.has('p.py'), false);
    assert.equal(await blobText(p, C, 'src/y.ts'), Y_LOCAL);
    assert.equal(r.records.length, 1);
    const rec = p.core.holds.get(r.records[0]!)!;
    const localP = (await p.core.repo.readTreeMap(pair.R)).get('p.py')!.oid;
    assert.deepEqual(rec.blobs, { s1: { 'p.py': A0.get('p.py')!.oid }, s2: { 'p.py': localP }, s3: { 'p.py': 'ABSENT' } });
    assert.equal(rec.state, 'CONFLICTED');
    const ev = fx.trace.since(mark).find((e) => e.kind === 'publish');
    assert.ok(ev !== undefined && ev.kind === 'publish');
    assert.deepEqual([...ev.replaced].sort((x, y) => (x.path < y.path ? -1 : 1)), [{ path: 'p.py', blob: null }, { path: 'p2.py', blob: tip2.oid }]);
    // The apply side computes the same record (dedupe) and removes p.py.
    fx.advance(10_000);
    const ar = await applyStep(p.core, await prep(p, 'auto'));
    assert.deepEqual(ar.records, [rec.id], 'the same K4 record');
    assert.equal(await readWork(p, 'p.py'), null);
    assert.equal(p.core.holds.get(rec.id)!.residence, 'OFF_DISK');
  });
});

test('after a publish-side concat the publisher\'s next apply takes TIP\'s entry with no record', async () => {
  await withCores('pub-concat', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const A0 = await stateA(p);
    await editAndCapture(fx, p, { 'notes.md': `${NOTES}local line\n` });
    await fx.pushTeamChange({ 'notes.md': buf(`${NOTES}team line\n`) });
    const it = await windowOpen(fx, p);
    const holdsBefore = fx.trace.ofKind('hold').length;
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.deepEqual(r.records, [], 'a concat makes no record');
    const C = await treeOf(p, r.c!);
    const out = (await blobText(p, C, 'notes.md'))!;
    assert.ok(out.includes('local line') && out.includes('team line'), out);
    assert.equal((await stateA(p)).get('notes.md')?.oid, A0.get('notes.md')?.oid, 'C[p] ≠ P[p]: A waits for the apply');
    fx.advance(10_000);
    const ar = await applyStep(p.core, await prep(p, 'auto'));
    assert.deepEqual(ar.records, [], 'no self-K4 (glossary §24 default 1)');
    assert.equal(fx.trace.ofKind('hold').length, holdsBefore, 'no record and no event');
    assert.equal((await readWork(p, 'notes.md'))!.toString('utf8'), out, 'TIP\'s entry is on disk');
    assert.equal((await stateA(p)).get('notes.md')?.oid, C.get('notes.md')?.oid);
    // A later edit stays on disk.
    await writeWork(p, 'notes.md', `${out}later\n`);
    fx.advance(10_000);
    const again = await applyStep(p.core, await prep(p, 'auto'));
    assert.equal(again.written.includes('notes.md'), false);
    assert.equal((await readWork(p, 'notes.md'))!.toString('utf8'), `${out}later\n`);
  });
});

test('final review FB-6: on Windows a publish whose OUT needs a whole-path edit (a D9 concat) over a TIP holding a root drive-prefix name (a:b.txt, which no index can hold) is a typed pause, never a silent build_failed: aborted path_not_indexable, no push, publishTreeRefused names it (status lists the pair: loop.carry.test.ts); once the name leaves TIP the next window lands', {
  skip: process.platform !== 'win32' ? 'git refuses a root drive-prefix name in an index only on Windows (the POSIX twin below)' : false,
}, async () => {
  await withCores('pub-fb6-colon', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, { 'notes.md': `${NOTES}local line\n`, 'src/y.ts': Y_LOCAL });
    await fx.pushTeamChange({ 'notes.md': buf(`${NOTES}team line\n`), 'a:b.txt': buf('ab\n') });
    const it = await windowOpen(fx, p);
    const before = await remoteBoard(fx, p);
    const r = await publishStep(p.core, it);
    assert.deepEqual([r.attempted, r.outcome, r.why], [false, 'aborted', 'path_not_indexable'], JSON.stringify(r));
    assert.deepEqual(publishTreeRefused(p.core), ['a:b.txt']);
    assert.equal(pushCalls(p), 0, 'no push spawned');
    assert.equal(await remoteBoard(fx, p), before, 'the remote is unchanged');
    assert.equal(p.core.view!.intent.kind, 'none', 'no push intent journaled');
    await fx.pushTeamChange({ 'a:b.txt': null });
    const r2 = await publishStep(p.core, await windowOpen(fx, p));
    assert.equal(r2.outcome, 'landed', JSON.stringify(r2));
    assert.equal(publishTreeRefused(p.core), null, 'a built OUT ends the pause');
    const C = await treeOf(p, r2.c!);
    assert.equal(await blobText(p, C, 'src/y.ts'), Y_LOCAL);
    const notes = (await blobText(p, C, 'notes.md'))!;
    assert.ok(notes.includes('local line') && notes.includes('team line'), notes);
  });
});

test('final review FB-6 (POSIX twin): where git indexes a root drive-prefix name the same publish builds OUT (the concat) over the TIP holding a:b.txt and lands, with TIP\'s a:b.txt in C', {
  skip: process.platform === 'win32' ? 'git for Windows refuses a root drive-prefix name in an index (the Windows test above)' : false,
}, async () => {
  await withCores('pub-fb6-colon-posix', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, { 'notes.md': `${NOTES}local line\n`, 'src/y.ts': Y_LOCAL });
    await fx.pushTeamChange({ 'notes.md': buf(`${NOTES}team line\n`), 'a:b.txt': buf('ab\n') });
    const r = await publishStep(p.core, await windowOpen(fx, p));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(publishTreeRefused(p.core), null);
    const C = await treeOf(p, r.c!);
    assert.equal(await blobText(p, C, 'a:b.txt'), 'ab\n');
    assert.equal(await blobText(p, C, 'src/y.ts'), Y_LOCAL);
  });
});

test('commit-tree exiting 128 with empty stdout spawns no push and leaves the remote unchanged', async () => {
  await withCores('pub-empty-oid', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { it } = await editAndCapture(fx, p, { 'src/y.ts': Y_LOCAL });
    p.core.outbox.add(freezeEvent());   // a pending op: its seq is allocated by take(), before C's commit-tree
    const outboxBefore = JSON.stringify(p.core.outbox.toJson());
    const before = await remoteBoard(fx, p);
    for (const sub of ['commit-tree', 'write-tree']) {
      let armed = true;
      const restore = wrapGit(p, async (args, opts, inner) => {
        // C's commit-tree names its parent (the merge-tree wrapper commits of R-30 have none).
        if (armed && args[0] === sub && (sub !== 'commit-tree' || args.includes('-p'))) {
          armed = false;
          return failedResult(128, `fatal: ${sub} refused`);
        }
        return inner(args, opts);
      });
      try {
        const r = await publishStep(p.core, it);
        assert.equal(armed, false, `the ${sub} injection fired`);
        assert.deepEqual([r.attempted, r.outcome, r.why], [false, 'aborted', 'build_failed'], JSON.stringify(r));
      } finally {
        restore();
      }
      assert.equal(pushCalls(p), 0, 'no push spawned');
      assert.equal(p.core.pushAttempts, 0);
      assert.equal(await remoteBoard(fx, p), before, 'the remote is unchanged');
      assert.equal(p.core.view!.intent.kind, 'none', 'no push intent journaled');
      assert.equal(JSON.stringify(p.core.outbox.toJson()), outboxBefore, `${sub}: the outbox is restored (no op keeps an unpersisted seq)`);
    }
    // Nothing is left half-allocated: the next window publishes.
    fx.advance(6_000);
    const r = await publishStep(p.core, await prep(p));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(p.core.outbox.size, 0);
  });
});

/** The ops of a board commit are below its writer seq (PRO-09). */
async function opsBelowWriter(p: PeerFixture, bnew: Oid): Promise<void> {
  const b = await readBoardCommit(p.core.repo, bnew);
  assert.ok(b.writer !== null);
  assert.ok(b.opsLines.length > 0);
  for (const line of b.opsLines) {
    const seq = Number((JSON.parse(line) as { id: string }).id.split('/')[2]);
    assert.ok(seq < b.writer.seq, `op seq ${seq} < writer seq ${b.writer.seq}`);
  }
}

test('a state update-ref failing at the push intent restores the outbox (no op keeps a seq the state never persisted); after a restart the next window lands', async () => {
  await withCores('pub-intent-fail', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { it } = await editAndCapture(fx, p, { 'src/y.ts': Y_LOCAL });
    p.core.outbox.add(freezeEvent());
    const before = JSON.stringify(p.core.outbox.toJson());
    const seqNext = p.core.view!.meta.seq_next;
    let armed = true;
    const restore = wrapGit(p, async (args, opts, inner) => {
      // The first state CAS of this publish is the push intent's (no K4 record, nothing dropped).
      if (armed && args[0] === 'update-ref' && args.includes(p.core.refs.state)) {
        armed = false;
        return failedResult(128, `fatal: update_ref failed for ref '${p.core.refs.state}'\n`);
      }
      return inner(args, opts);
    });
    try {
      await assert.rejects(publishStep(p.core, it), GitCommandError);
    } finally {
      restore();
    }
    assert.equal(armed, false, 'the intent commit was refused');
    assert.equal(JSON.stringify(p.core.outbox.toJson()), before, 'the outbox is restored: the op holds no seq');
    assert.deepEqual([p.core.view!.intent.kind, p.core.view!.meta.seq_next, pushCalls(p)], ['none', seqNext, 0]);
    // A later transition persists the outbox, and a restart reloads it from the state.
    await p.core.commit({ meta: { ...p.core.view!.meta, outbox: p.core.outbox.toJson() } });
    attachState(p.core, p.core.view!);
    fx.advance(6_000);
    const r = await publishStep(p.core, await prep(p));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(p.core.outbox.size, 0, 'the op landed');
    await opsBelowWriter(p, r.bnew!);
  });
});

test('an outbox op persisted with a seq at or above meta.seq_next (an allocation the state never recorded) never makes the writer seq collide: the next window lands', async () => {
  await withCores('pub-stale-seq', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, { 'src/y.ts': Y_LOCAL });
    const meta = p.core.view!.meta;
    p.core.outbox.add(freezeEvent());
    let n = meta.seq_next + 3;
    p.core.outbox.take([], { peer: p.core.peerId, epoch: meta.epoch }, { next: () => n++ }, { maxOps: 1_000, maxBytes: 65_536 });
    await p.core.commit({ meta: { ...meta, outbox: p.core.outbox.toJson() } });   // seq_next stays below the op's seq
    attachState(p.core, p.core.view!);
    const r = await publishStep(p.core, await prep(p));
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    await opsBelowWriter(p, r.bnew!);
    assert.ok(p.core.view!.meta.seq_next > meta.seq_next + 3, 'seq_next is persisted above every allocated seq');
  });
});

test('mutant M06 (S_disk pushed as OUT) is stopped by assert (b) or (c) before any push', async () => {
  await withCores('pub-m06', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, { 'src/y.ts': Y_LOCAL });
    await fx.pushTeamChange({ 'src/z.ts': buf(Z_TEAM) });
    const before = await remoteBoard(fx, p);
    setMutants(p, ['M06']);
    const it = await windowOpen(fx, p);
    p.core.outbox.add(freezeEvent());
    const outboxBefore = JSON.stringify(p.core.outbox.toJson());
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'aborted');
    assert.ok(r.why === 'publish_assert:b' || r.why === 'publish_assert:c', String(r.why));
    assert.equal(pushCalls(p), 0);
    assert.equal(await remoteBoard(fx, p), before);
    assert.equal(JSON.stringify(p.core.outbox.toJson()), outboxBefore, 'a failed assertion restores the outbox');
    setMutants(p, []);
    fx.advance(6_000);
    const ok = await publishStep(p.core, await prep(p));
    assert.equal(ok.outcome, 'landed', 'without the mutant the same publish lands');
  });
});

/**
 * Test seam: composeP as built, then `edit` on P — with MASK bypassed when `unmasked` — as if MASK had failed to withhold a
 * path (the publish's own check of P must still stop it). Replaces any earlier stub.
 */
function stubCompose(p: PeerFixture, unmasked: boolean, edit: (P: Map<string, TreeEntry>) => void = () => {}): void {
  const cs = p.core.cs;
  Reflect.deleteProperty(cs, 'composeP');
  const orig = cs.composeP.bind(cs);
  cs.composeP = async (repo, A, mask, pinned) => {
    const c = await orig(repo, A, unmasked ? (X) => new Map(X) : mask, pinned);
    edit(c.P);
    return c;
  };
}

test('a held path differing from A in P is reported with ENG-41\'s letter before the merge: (i) for a record-masked path, INV-MASK for a path class', async () => {
  const S = '.claude/settings.json';
  await withCores('pub-held-letter', { n: 1, files: { ...FILES, [S]: buf('{"a":1}\n') } }, async (fx) => {
    const p = fx.peers[0]!;
    const A0 = await stateA(p);
    const { pair } = await editAndCapture(fx, p, { 'src/x.ts': X_LOCAL });
    const localX = (await p.core.repo.readTreeMap(pair.R)).get('src/x.ts')!.oid;
    const a0x = A0.get('src/x.ts')!.oid;
    await p.core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', paths: ['src/x.ts'],
      blobs: { s1: { 'src/x.ts': a0x }, s2: { 'src/x.ts': localX }, s3: { 'src/x.ts': a0x } },
      guard: 'conflict', origin: 'daemon', cs_ids: [], displaced_by: null, local_only: false,
    });
    const merges = fx.trace.ofKind('merge').length;
    stubCompose(p, true);
    const r = await publishStep(p.core, await prep(p));
    assert.deepEqual([r.outcome, r.why], ['aborted', 'publish_assert:i'], 'a record-masked path: prePushAsserts\' letter (i)');
    // A path class (QUARANTINED) differing from A in P; MASK withholds src/x.ts again.
    const cfg = await p.core.repo.hashBytes(buf('{"a":2}\n'), true);
    stubCompose(p, false, (P) => P.set(S, { path: S, mode: '100644', oid: cfg }));
    const q = await publishStep(p.core, await prep(p));
    assert.deepEqual([q.outcome, q.why], ['aborted', 'publish_assert:INV-MASK'], 'a path class: INV-MASK');
    assert.equal(fx.trace.ofKind('merge').length, merges, 'both stop before the merge');
    assert.equal(pushCalls(p), 0);
  });
});

test('the publish trace event carries aTree, pTree, tip, outTree, c, bnew, conflicted and replaced', async () => {
  await withCores('pub-trace', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, { 'src/x.ts': X_LOCAL, 'src/y.ts': Y_LOCAL, 'notes.md': `${NOTES}local line\n` });
    const team = await fx.pushTeamChange({ 'src/x.ts': buf(X_TEAM), 'notes.md': buf(`${NOTES}team line\n`) });
    const it = await windowOpen(fx, p);
    const aTree = p.core.view!.base;
    const mark = fx.trace.events.length;
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const ev = fx.trace.since(mark).find((e) => e.kind === 'publish');
    assert.ok(ev !== undefined && ev.kind === 'publish');
    const tipTree = (await p.core.repo.readCommit(team.live)).tree;
    assert.equal(ev.peer, p.core.peerId);
    assert.equal(ev.t, it.T);
    assert.equal(ev.tip, team.live);
    assert.equal(ev.aTree, aTree);
    assert.equal(ev.c, r.c);
    assert.equal(ev.bnew, r.bnew);
    assert.equal(ev.outTree, (await p.core.repo.readCommit(r.c!)).tree);
    const P = await p.core.repo.readTreeMap(ev.pTree as Oid);
    assert.equal(await blobText(p, P, 'src/y.ts'), Y_LOCAL);
    assert.equal(await blobText(p, P, 'src/x.ts'), X_LOCAL);
    assert.deepEqual([...ev.conflicted].sort(), ['notes.md', 'src/x.ts']);
    const merge = fx.trace.since(mark).find((e) => e.kind === 'merge');
    assert.ok(merge !== undefined && merge.kind === 'merge');
    assert.deepEqual([merge.use, merge.base, merge.ours, merge.theirs], ['publish', aTree, ev.pTree, tipTree]);
    // INV-PUSHED-IS-MERGE: merge-tree --merge-base=aTree pTree TIP plus the accepted replacements == tree(C).
    const m = await mergeTree(p.core.repo, aTree, ev.pTree as Oid, tipTree);
    const edits: IndexEdit[] = ev.replaced.map((x) => {
      if (x.blob === null) return { path: x.path, remove: true };
      const mode = (it.tipMap.get(x.path) ?? it.A.get(x.path))?.mode ?? '100644';
      return { path: x.path, mode, oid: x.blob as Oid };
    });
    const rebuilt = await p.core.repo.editTree(m.tree, edits, join(p.deps.paths.coworkDir, 'tmp', 'test-oracle.index'));
    assert.equal(rebuilt, ev.outTree);
    assert.ok(ev.replaced.some((x) => x.path === 'src/x.ts' && x.blob === it.tipMap.get('src/x.ts')!.oid), 'the K4 path takes TIP');
  });
});

// Ruling P2-SCRATCHLOCK: a git child killed mid-write (write-tree under the watchdog, a power loss) leaves <index>.lock
// beside an engine scratch index; the next read-tree into it would fail rc 128 forever. Every read-tree into an engine
// scratch index first removes the index and its lock; .git/index.lock (the user's) is never touched.
test('P2-SCRATCHLOCK: a leftover tmp/p.index.lock and tmp/out.index.lock never wedge the publish: the window lands and .git/index.lock is left alone', async () => {
  await withCores('pub-scratchlock-build', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, { 'src/x.ts': X_LOCAL, 'src/y.ts': Y_LOCAL });
    await fx.pushTeamChange({ 'src/x.ts': buf(X_TEAM) });
    const it = await windowOpen(fx, p);
    const userLock = join(p.deps.paths.gitDir, 'index.lock');
    for (const f of [`${p.core.scratch('p')}.lock`, `${p.core.scratch('out')}.lock`, userLock]) await writeFile(f, '');
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(r.records.length, 1, 'the K4 replacement went through tmp/out.index');
    assert.equal(existsSync(userLock), true, 'the user\'s .git/index.lock is never touched');
    await unlink(userLock);
  });
});

test('P2-SCRATCHLOCK: a leftover tmp/a.index.lock never stops the ok update of a landed push (applyPushOk completes)', async () => {
  await withCores('pub-scratchlock-ok', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, { 'src/y.ts': Y_LOCAL });
    const it = await prep(p);
    await writeFile(`${p.core.scratch('a')}.lock`, '');
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const view = p.core.view!;
    assert.deepEqual([view.laB, view.laC, view.intent.kind], [r.bnew, r.c, 'none'], 'the ok update committed');
    const C = await treeOf(p, r.c!);
    assert.equal((await stateA(p)).get('src/y.ts')?.oid, C.get('src/y.ts')?.oid, 'A[p] := C[p] through tmp/a.index');
  });
});

test('the push intent with t/P and seq_next is journaled before the push; publish.out_built fires before the spawn, publish.sent after the push returns, publish.landed before the ok update', async () => {
  await withCores('pub-journal', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { it } = await editAndCapture(fx, p, { 'src/y.ts': Y_LOCAL });
    const T = p.core.view!.laB;
    const seen: Array<{ name: string; intent: string; P: string | undefined; seqNext: number; writerSeq: number | null; pushes: number; laB: string }> = [];
    setCrashHandler((name) => {
      if (!name.startsWith('publish.')) return;
      const v = p.core.view!;
      seen.push({
        name, intent: v.intent.kind, P: v.t.get('P'), seqNext: v.meta.seq_next,
        writerSeq: v.intent.kind === 'push' ? v.intent.writer_seq : null, pushes: pushCalls(p), laB: v.laB,
      });
    });
    let r;
    try {
      r = await publishStep(p.core, it);
    } finally {
      setCrashHandler(null);
    }
    assert.equal(r.outcome, 'landed');
    assert.deepEqual(seen.map((s) => s.name), ['publish.out_built', 'publish.sent', 'publish.landed']);
    const pTree = fx.trace.ofKind('publish').at(-1)!.pTree;
    const [built, sent, landed] = seen as [typeof seen[0], typeof seen[0], typeof seen[0]];
    assert.equal(built.intent, 'push', 'the push intent is journaled');
    assert.equal(built.P, pTree, 'with t/P = P');
    assert.ok(built.writerSeq !== null && built.seqNext === built.writerSeq + 1, 'seq_next persisted past the writer seq (PRO-08)');
    assert.equal(built.pushes, 0, 'publish.out_built fires before the spawn');
    assert.equal(sent.pushes, 1, 'publish.sent after the push returned');
    assert.equal(landed.intent, 'push');
    assert.equal(landed.laB, T, 'publish.landed before the ok update');
    assert.equal(p.core.view!.laB, r.bnew);
    assert.equal(p.core.view!.intent.kind, 'none');
  });
});

/** Final review FC-1: one own landing with board status ok (so no classify fetch ran); returns the landed Bnew and the lease. */
async function landOwnPublish(fx: CoreFixture, p: PeerFixture): Promise<{ bnew: string; lease: string }> {
  await editAndCapture(fx, p, { 'src/x.ts': X_LOCAL });
  const it = await windowOpen(fx, p);
  const lease = it.T as string;
  const r = await publishStep(p.core, it);
  assert.equal(r.outcome, 'landed', JSON.stringify(r));
  assert.equal(p.core.view!.laB, r.bnew);
  assert.notEqual(r.bnew, lease);
  return { bnew: r.bnew!, lease };
}

test('final review FC-1: a fetch that fails with no answer right after an own landing checks LA_B == Bnew against Bnew, never the pre-push lease: no false INCIDENT', async () => {
  await withCores('pub-fc1-failed', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { bnew } = await landOwnPublish(fx, p);
    // A network blip right after the landing.
    const restore = wrapGit(p, async (args, opts, inner) => (opts.class === 'network' ? failedResult(128, "fatal: unable to access 'remote': Could not resolve host\n") : inner(args, opts)));
    try {
      fx.advance(3_000);
      const failed = await prepareIteration(p.core, 9_002, { materialize: false, forceFetch: true });
      assert.ok(failed.ok, `a failed fetch after an own landing is no incident: ${JSON.stringify(failed)}`);
      assert.equal(failed.it.fetched?.ok, false, 'the fetch failed');
      assert.equal(failed.it.T, bnew, 'T = Bnew (LA_B), not the pre-push board');
    } finally {
      restore();
    }
    assert.deepEqual(p.core.view!.meta.freeze_reasons, [], 'no INCIDENT');
  });
});

test('final review FC-1: a deferred view right after an own landing (inside the fetch spacing: it repeats the pre-push board) checks against Bnew: no false INCIDENT', async () => {
  await withCores('pub-fc1-deferred', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { bnew } = await landOwnPublish(fx, p);
    const deferred = await prepareIteration(p.core, 9_001, { materialize: false, forceFetch: false });
    assert.ok(deferred.ok, `a deferred view after an own landing is no incident: ${JSON.stringify(deferred)}`);
    assert.equal(deferred.it.fetched?.deferred, true, 'the view was deferred');
    assert.equal(deferred.it.T, bnew, 'T = Bnew (LA_B), not the pre-push board');
    assert.deepEqual(p.core.view!.meta.freeze_reasons, [], 'no INCIDENT');
  });
});

test('final review FC minor: a teammate adding the file src/d while this peer adds src/d/x.ts: OUT keeps TIP\'s file, and src/d/x.ts (which cannot sit beside it) gets a K4 CONFLICTED ON_DISK record instead of being dropped silently; the CS\'s other paths still publish', async () => {
  await withCores('pub-df', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const X_UNDER_D = 'export const xd = 1; // under d\n';
    await editAndCapture(fx, p, { 'src/d/x.ts': X_UNDER_D, 'src/y.ts': Y_LOCAL });
    await fx.pushTeamChange({ 'src/d': buf('a file named d\n') });
    const it = await windowOpen(fx, p);
    const r = await publishStep(p.core, it);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(r.records.length, 1, `one K4 record: ${JSON.stringify(r)}`);
    const rec = p.core.holds.get(r.records[0]!)!;
    assert.deepEqual([rec.kind, rec.state, rec.residence, rec.paths, rec.guards.map((g) => g.name)], ['PATCH', 'CONFLICTED', 'ON_DISK', ['src/d/x.ts'], ['conflict']]);
    assert.deepEqual(rec.blobs, { s1: { 'src/d/x.ts': ABSENT }, s2: { 'src/d/x.ts': await p.core.repo.hashBytes(buf(X_UNDER_D), false) }, s3: { 'src/d/x.ts': ABSENT } });
    const C = await treeOf(p, r.c!);
    assert.equal(await blobText(p, C, 'src/d'), 'a file named d\n', 'TIP\'s file is published');
    assert.equal(C.has('src/d/x.ts'), false, 'the local path under it is not');
    assert.equal(await blobText(p, C, 'src/y.ts'), Y_LOCAL, 'the CS\'s other paths publish');
    assert.deepEqual(await readWork(p, 'src/d/x.ts'), buf(X_UNDER_D), 'LOCAL stays on disk');
  });
});
