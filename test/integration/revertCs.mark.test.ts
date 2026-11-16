// The revert shrink mark (Plan 3 Task 17; glossary §29.1 decision D2, §29.2 "clean HLD-41 rebase", §6 reverts.jsonl; 05-holds HLD-50
// item 3, Algorithm REV step 8, §8 Q18 option (a); 01-engine ENG-25, ENG-36; 11-testing TC-F10-10 variant, -15, -17 kernel halves;
// contract additions 2–4). Scripted T0RegionsPorts (recording, passing) through CoreOptions.ports; T0's shrink rule is made to apply
// to this peer's shrinks (shrinkAttributed false, as a hook binding gives a seat) so that only the mark exempts; the revert write is
// made the way Plan 7's confirm makes it (one writeLocalGroup with origin `revert:<of>`, then openRevertCs). Real clones; git is
// never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsTrailers } from '../../src/board/boardCommit.js';
import { applyStep } from '../../src/engine/apply.js';
import { attachCsTable, attachState, publicationGroups } from '../../src/engine/core.js';
import { captureStep } from '../../src/engine/csStep.js';
import { humanOnlyAttribution } from '../../src/engine/deps.js';
import { detectStep, recordStep } from '../../src/engine/holdSteps.js';
import { publishStep } from '../../src/engine/publish.js';
import { resolve } from '../../src/engine/resolve.js';
import { restart } from '../../src/engine/restart.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { GitCommandError } from '../../src/git/repo.js';
import { pinCs } from '../../src/holds/changesets.js';
import { passT0Regions, type PublishGatePort, type T0RegionsPort } from '../../src/holds/ports.js';
import { guardName, type HoldRecord } from '../../src/holds/record.js';
import { locateCs, revertInverse, type RevertResult } from '../../src/holds/revertCs.js';
import { KilledAt } from '../../src/ports/crashpoint.js';
import { errnoCode, realFs } from '../../src/ports/fs.js';
import { readWork, writeWork, type CoreFixture, type CoreOptions, type PeerFixture } from '../helpers/coreFixture.js';
import { blobText, buf, failedResult, lines, prep, remoteLiveCode, treeOf, withCores, wrapGit } from '../helpers/publishHelpers.js';
import { applyNow, confirmRevert, humanCs, publishNow, T10 } from '../helpers/revertFixture.js';
import { restartCore } from '../helpers/startFixture.js';

const BIG = lines(100, (i) => `big row ${i}`);
/** The CS to revert added 300 rows to the 100-row file: its revert shrinks the file by 75 % (TC-F10-15). */
const GROWN = `${BIG}${lines(300, (i) => `added row ${i}`)}`;
const N_TS = 'export const n = 1;\n';
/** GROWN with row `k` changed by the teammate. */
const teamEdit = (k: number, base = GROWN): string => base.replace(`big row ${k}\n`, `big row ${k} TEAM\n`);
const unattributed = { ...humanOnlyAttribution, shrinkAttributed: (): boolean => false };

/** A recording, passing T0RegionsPort (HLD-50 items 1–2 are Plan 4's; the shrink rule under test is item 3, t0Shrink). */
function regions(): { port: T0RegionsPort; calls: number } {
  const r: { port: T0RegionsPort; calls: number } = { calls: 0, port: passT0Regions };
  r.port = {
    check: async () => {
      r.calls += 1;
      return { pass: true };
    },
  };
  return r;
}

const t0Pins = (p: PeerFixture): number => p.core.holds.nonTerminal().filter((r) => r.guards.some((g) => guardName(g) === 't0')).length;

/** The loop's order up to the capture: prepareIteration 'auto' (it materializes when a capture is due), detectStep, captureStep. */
async function captureIteration(p: PeerFixture): Promise<string[]> {
  const it = await prep(p, 'auto');
  assert.ok(it.mat !== null, 'a capture was due: the iteration materialized');
  await detectStep(p.core, it);
  return (await captureStep(p.core, it)).captured;
}

/**
 * This peer's CS grows `file` from 100 to 400 rows (and creates n.ts when `withN`), published; its revert is computed and confirmed:
 * a 75 % shrink (and a deletion). Returns the reverted CS, the revert CS and its written oids.
 */
async function confirmed(fx: CoreFixture, p: PeerFixture, file = 'big.txt', withN = true): Promise<{ of: string; rev: string; written: Map<string, Oid | 'ABSENT'>; r: RevertResult }> {
  const own = await humanCs(fx, p, { [file]: GROWN, ...(withN ? { 'n.ts': N_TS } : {}) });
  await prep(p, true);
  p.deps.attribution = unattributed;
  const loc = await locateCs(p.core, own.csId, { mode: 'verb' });
  assert.ok(loc !== null && 'found' in loc, JSON.stringify(loc));
  const r = await revertInverse(p.core, loc.found, { mode: 'verb' });
  assert.ok(!('tooBig' in r));
  assert.equal(r.results.get(file)?.toString(), BIG);
  const { cs: rev, written } = await confirmRevert(p, own.csId, r);
  return { of: own.csId, rev, written, r };
}

async function pairR(p: PeerFixture, cs: string, path: string): Promise<Oid | 'ABSENT' | null> {
  const pair = p.core.cs.ready().find((x) => x.csId === cs);
  if (pair === undefined) return null;
  return (await p.core.repo.readTreeMap(pair.R)).get(path)?.oid ?? ABSENT;
}

async function liveText(fx: CoreFixture, p: PeerFixture, path: string): Promise<string | null> {
  return blobText(p, await treeOf(p, await remoteLiveCode(fx, p)), path);
}

const FILES: Record<string, Buffer> = { 'big.txt': buf(BIG), 'big2.txt': buf(BIG), 'big3.txt': buf(BIG), 'k6.txt': buf(BIG), 'w.txt': buf('w\n') };
const opts = (extra: Partial<CoreOptions> = {}): CoreOptions => ({ n: 1, files: FILES, ...extra });

test('TC-F10-15 kernel: a confirmed revert that shrinks a file by 75 % and deletes a file the CS created passes t0Shrink through the revert shrink mark and publishes in one commit with no t0 PIN', T10, async () => {
  const t0 = regions();
  await withCores('rev-mark-15', opts({ ports: { t0Regions: t0.port } }), async (fx) => {
    const p = fx.peers[0]!;
    const { rev, written } = await confirmed(fx, p);
    assert.ok(p.core.cs.revertMarks.covers('big.txt', written.get('big.txt')!));
    assert.ok(p.core.cs.revertMarks.covers('n.ts', ABSENT));
    assert.deepEqual(await captureIteration(p), [rev]);
    const before = await remoteLiveCode(fx, p);
    const pub = await publishNow(fx, p);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.deepEqual(pub.k7, [], 'no K7 PIN');
    assert.equal(t0Pins(p), 0, 'no t0 PIN');
    assert.ok(t0.calls > 0, 'T0 ran over the group (items 1–2 scripted)');
    const live = await remoteLiveCode(fx, p);
    assert.equal((await p.core.repo.readCommit(live)).parents[0], before, 'one live commit');
    assert.equal(await liveText(fx, p, 'big.txt'), BIG, 'the file shrank by 75 %');
    assert.equal(await liveText(fx, p, 'n.ts'), null, 'the created file is deleted');
  });
});

test('TC-F10-17 kernel: before the revert CS publishes, a different shrink of the same path still fails T0\'s shrink guard and ENG-25\'s exclusion; only the written blob is exempt', T10, async () => {
  await withCores('rev-mark-17', opts(), async (fx) => {
    const p = fx.peers[0]!;
    const { rev, written } = await confirmed(fx, p);
    assert.deepEqual(await captureIteration(p), [rev]);
    // A further 60 % cut of the reverted file (not a write the revert made).
    const CUT = lines(40, (i) => `big row ${i}`);
    await writeWork(p, 'big.txt', CUT);
    let it = await prep(p);
    assert.equal(it.tick!.excluded.get('big.txt'), 'shrink', 'ENG-25\'s exclusion holds the other shrink');
    const cutOid = await p.core.repo.hashBytes(buf(CUT), false);
    assert.ok(!p.core.cs.revertMarks.covers('big.txt', cutOid), 'the mark covers only the written blob');
    assert.ok(p.core.cs.revertMarks.covers('big.txt', written.get('big.txt')!));
    fx.advance(1_500);
    it = await prep(p);   // the second stable read (R-25) takes it: a human CS beside the revert CS, sharing big.txt (one group)
    assert.ok(it.tick!.dirty.has('big.txt'));
    fx.advance(20_000);
    await captureIteration(p);
    const pub = await publishNow(fx, p);
    assert.equal(pub.k7.length, 1, `T0's shrink guard fires on OUT: ${JSON.stringify(pub)}`);
    assert.equal(t0Pins(p), 1);
    assert.equal(await liveText(fx, p, 'big.txt'), GROWN, 'nothing of big.txt published');
  });
});

test('TC-F10-10 variant kernel: a clean teammate apply into another part of the reverted file before the push moves the mark to the rebased R[p], appends a rebase line fsynced before the apply\'s state update, and the revert publishes', T10, async () => {
  await withCores('rev-mark-10', opts(), async (fx) => {
    const p = fx.peers[0]!;
    const { of, rev, written } = await confirmed(fx, p);
    assert.deepEqual(await captureIteration(p), [rev]);
    assert.equal(await pairR(p, rev, 'big.txt'), written.get('big.txt'));
    // The publish is held (no publishStep yet); the teammate changes row 2, which the revert kept.
    await fx.pushTeamChange({ 'big.txt': buf(teamEdit(2)) });
    // The journal's lines of the revert CS at each state update of the apply (its intent commit J, then its ENG-36 update C).
    const atState: number[] = [];
    const restore = wrapGit(p, async (args, o, inner) => {
      if (args[0] === 'update-ref' && args.includes(p.core.refs.state)) atState.push((await p.core.reverts.byCs(rev)).length);
      return inner(args, o);
    });
    try {
      await applyNow(fx, p);
    } finally {
      restore();
    }
    const moved = await pairR(p, rev, 'big.txt');
    assert.ok(moved !== null && moved !== written.get('big.txt'), 'the pair was rebased (a clean HLD-41 rebase)');
    assert.equal((await p.core.repo.readBlob(moved as Oid)).toString('utf8'), teamEdit(2, BIG), 'R[p]: the revert result with the teammate\'s row merged in');
    assert.equal(p.core.cs.revertMarks.current(rev)!.get('big.txt'), moved, 'the mark followed the rebase');
    assert.equal(p.core.cs.revertMarks.current(rev)!.get('n.ts'), ABSENT);
    const ls = await p.core.reverts.byCs(rev);
    assert.equal(ls.length, 2);
    assert.deepEqual(ls[1], { cs: rev, of, t_local_ms: ls[0]!.t_local_ms, written: { 'big.txt': moved, 'n.ts': ABSENT } }, 'the rebase line: of and t_local_ms repeated, the whole current map');
    assert.equal(atState.at(-1), 2, 'the line was in the file before the state update that stores the rebased pair');
    assert.equal(atState[0], 1, 'and not yet at the intent commit of the apply');
    const pub = await publishNow(fx, p);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.equal(t0Pins(p), 0, 'no t0 PIN');
    assert.equal(await liveText(fx, p, 'big.txt'), teamEdit(2, BIG), 'the revert published with the teammate\'s change merged in');
  });
});

test('a K4 conflicting apply, an R[p] before the rebase that is not the mark\'s oid (another member\'s later capture) and a member effect after the capture leave the mark where it is', T10, async () => {
  await withCores('rev-mark-neg', opts(), async (fx) => {
    const p = fx.peers[0]!;
    const own = await humanCs(fx, p, { 'big.txt': GROWN, 'big2.txt': GROWN, 'big3.txt': GROWN });
    await prep(p, true);
    p.deps.attribution = unattributed;
    const loc = await locateCs(p.core, own.csId, { mode: 'verb' });
    assert.ok(loc !== null && 'found' in loc);
    const all = await revertInverse(p.core, loc.found, { mode: 'verb' });
    assert.ok(!('tooBig' in all));
    // Three revert CSs, one per file (Plan 7's confirm writes whatever result paths it confirms).
    const one = (path: string): RevertResult => ({ results: new Map([[path, all.results.get(path)!]]), paths: all.paths.filter((x) => x.path === path), kept: [], skipped: [] });
    const k4 = await confirmRevert(p, own.csId, one('big.txt'));
    const other = await confirmRevert(p, own.csId, one('big2.txt'));
    const effect = await confirmRevert(p, own.csId, one('big3.txt'));
    assert.deepEqual((await captureIteration(p)).sort(), [k4.cs, other.cs, effect.cs].sort());
    // big2.txt: another member's later capture — a human edit of the reverted file, captured with the revert CS (one group).
    await writeWork(p, 'big2.txt', teamEdit(50, BIG).replace('TEAM', 'HUMAN'));
    await prep(p);
    fx.advance(20_000);
    await captureIteration(p);
    assert.notEqual(await pairR(p, other.cs, 'big2.txt'), other.written.get('big2.txt'), 'R[p] is the later capture, not the mark\'s oid');
    // big3.txt: a member effect after the capture (on disk, not captured): S_disk[p] ≠ R[p] before the apply.
    await writeWork(p, 'big3.txt', teamEdit(50, BIG).replace('TEAM', 'HUMAN'));
    await prep(p);
    // One teammate commit: a row the revert removed on big.txt (a K4 conflict), row 2 of big2.txt and big3.txt (clean merges).
    await fx.pushTeamChange({ 'big.txt': buf(GROWN.replace('added row 250', 'added row 250 TEAM')), 'big2.txt': buf(teamEdit(2)), 'big3.txt': buf(teamEdit(2)) });
    fx.advance(10_000);
    const it = await prep(p);
    const apply = await applyStep(p.core, it);
    assert.ok(apply.ran);
    await recordStep(p.core, it, apply);
    const k4rec = p.core.holds.nonTerminal().find((r) => r.paths.includes('big.txt') && r.guards.some((g) => guardName(g) === 'conflict'));
    assert.ok(k4rec !== undefined && k4rec.cs_ids.includes(k4.cs), 'the K4 record names the revert CS (TIP on disk, the revert version restorable)');
    for (const x of [k4, other, effect]) {
      assert.deepEqual(p.core.cs.revertMarks.current(x.cs), x.written, `${x.cs}: the mark is where it was`);
      assert.equal((await p.core.reverts.byCs(x.cs)).length, 1, `${x.cs}: no rebase line`);
    }
  });
});

/** A scripted B1 (PublishGatePort) blocking every ready group holding `k6.txt` while `on()`; the claim PREDICATE follows it. */
function k6Gate(on: () => boolean): PublishGatePort {
  return {
    gate: async (_r, _t, _A, _R, paths) => (on() && paths.includes('k6.txt') ? { block: { claimId: 'abcdefghij234567' } } : { block: null }),
    claimStillBlocks: async () => on(),
  };
}

const claimPin = (p: PeerFixture): HoldRecord | undefined => p.core.holds.nonTerminal().find((r) => r.guards.some((g) => g.name.startsWith('claim:')));

test('restart re-derivation: a kill between the rebase line\'s append and the apply\'s state CAS, then restart, re-derives per path the newest line matching the journaled pair; a revert CS whose PIN was discarded or subsumed has no mark after a restart', T10, async () => {
  let claimed = false;
  await withCores('rev-mark-restart', opts({ ports: { gate: k6Gate(() => claimed) } }), async (fx) => {
    const p = fx.peers[0]!;
    const a = await confirmed(fx, p);
    assert.deepEqual(await captureIteration(p), [a.rev]);
    // The teammate's clean change to row 2; the apply is killed right after the rebase line's append completed (the rename that
    // publishes it), before the state CAS that would store the rebased pair (ENG-36).
    await fx.pushTeamChange({ 'big.txt': buf(teamEdit(2)) });
    p.fs.interpose('rename', 'reverts.jsonl', async (src) => {
      await realFs.rename(src, src.slice(0, -'.tmp'.length));
      throw new KilledAt('reverts.append');
    });
    fx.advance(10_000);
    await assert.rejects(applyStep(p.core, await prep(p)), KilledAt);
    const ls = await p.core.reverts.byCs(a.rev);
    assert.equal(ls.length, 2, 'the rebase line is durable');
    const rebased = ls[1]!.written['big.txt']!;
    assert.notEqual(rebased, a.written.get('big.txt'));
    // A new process: the state still journals the pre-apply pair (R[p] = the written blob) — the original line matches big.txt, both
    // lines match n.ts: per path, the newest matching line.
    await restartCore(p);
    const v = (await p.core.state.read())!;
    attachState(p.core, v);
    await attachCsTable(p.core, v);
    assert.equal(await pairR(p, a.rev, 'big.txt'), a.written.get('big.txt'));
    assert.deepEqual(p.core.cs.revertMarks.current(a.rev), a.written, 'the mark the journaled pair carries, never the line the crash orphaned');
    // The restart completes the interrupted apply (ENG-53), itself a clean HLD-41 rebase: the mark follows to the journaled R[p], whose
    // line is in the journal, so a later restart re-derives the same mark.
    await restart(p.core);
    assert.equal(await pairR(p, a.rev, 'big.txt'), rebased);
    assert.equal(p.core.cs.revertMarks.current(a.rev)!.get('big.txt'), rebased);
    await restartCore(p);
    await restart(p.core);
    assert.deepEqual(p.core.cs.revertMarks.current(a.rev), new Map<string, Oid | 'ABSENT'>([['big.txt', rebased], ['n.ts', ABSENT]]), 'the rebase line re-derives the moved mark');

    // A revert held by a K6 PIN and discarded: no mark after a restart.
    const b = await confirmed(fx, p, 'k6.txt', false);
    assert.deepEqual(await captureIteration(p), [b.rev]);
    claimed = true;
    await publishNow(fx, p);   // a's group lands; b's is held by B1 as a K6 PIN
    const k6 = claimPin(p)!;
    assert.ok(k6.cs_ids.includes(b.rev));
    assert.deepEqual(p.core.cs.revertMarks.current(b.rev), b.written, 'held: the mark stays');
    const res = await resolve(p.core, await prep(p, true), k6.id, 'discard', { humanEvidence: true, actor: 'human' });
    assert.equal(res.kind, 'done', JSON.stringify(res));
    await restartCore(p);
    await restart(p.core);
    assert.equal(p.core.cs.revertMarks.current(b.rev), null, 'discarded: no mark either side of a restart');

    // A revert CS a subsumed record names (R1's verdict when H1' == A, stood in here), its pair still journaled: no mark after a restart.
    claimed = false;
    const c = await confirmed(fx, p, 'big3.txt', false);
    assert.deepEqual(await captureIteration(p), [c.rev]);
    const it = await prep(p);
    const hid = await p.core.holds.hold(pinCs('claim:abcdefghij234566', [c.rev], ['big3.txt'], it.A, { 'big3.txt': c.written.get('big3.txt') as Oid }, 'human', 'none'));
    await p.core.holds.transition(hid, { state: 'SUBSUMED' });
    assert.ok(p.core.cs.ready().some((x) => x.csId === c.rev), 'its pair is still journaled');
    await restartCore(p);
    await restart(p.core);
    assert.equal(p.core.cs.revertMarks.current(c.rev), null, 'subsumed: no mark after a restart');
  });
});

// Plan 3 final review F8 (05-holds Algorithm REV step 8, §8 Q18 option (a), :359/:670): most of an apply's window lies before its
// appendMove (the write phase). A kill there leaves reverts.jsonl with the original line only; the restart's ENG-53 completion is itself
// a clean HLD-41 rebase that moves the mark, so it appends the moved mark's line, fsynced before its state update, and a second restart
// re-derives the mark on the rebased R[p] (a lost mark makes T0's shrink guard pin the confirmed revert as a K7 `t0` PIN).
test('restart re-derivation after a kill before the rebase line\'s append: the ENG-53 completion appends the moved mark\'s line before its state update, so a second restart re-derives the mark on the rebased R[p]', T10, async () => {
  await withCores('rev-mark-restart-early', opts(), async (fx) => {
    const p = fx.peers[0]!;
    const a = await confirmed(fx, p);
    assert.deepEqual(await captureIteration(p), [a.rev]);
    // The teammate's clean change to row 2; the apply is killed inside its rebase line's append, before the rename that would publish
    // the line (the journal keeps only the original line) and before the state CAS that would store the rebased pair.
    await fx.pushTeamChange({ 'big.txt': buf(teamEdit(2)) });
    p.fs.interpose('rename', 'reverts.jsonl', async () => {
      throw new KilledAt('reverts.append');
    });
    fx.advance(10_000);
    await assert.rejects(applyStep(p.core, await prep(p)), KilledAt);
    assert.equal((await p.core.reverts.byCs(a.rev)).length, 1, 'the rebase line never became durable');
    const rebased = await p.core.repo.hashBytes(buf(teamEdit(2, BIG)), false);
    assert.notEqual(rebased, a.written.get('big.txt'));
    // The first restart completes the interrupted apply (ENG-53): the mark follows the rebase, and its line is in the journal before the
    // state update that stores the rebased pair.
    await restartCore(p);
    const atState: number[] = [];
    const unwrap = wrapGit(p, async (args, o, inner) => {
      if (args[0] === 'update-ref' && args.includes(p.core.refs.state)) atState.push((await p.core.reverts.byCs(a.rev)).length);
      return inner(args, o);
    });
    try {
      await restart(p.core);
    } finally {
      unwrap();
    }
    assert.equal(await pairR(p, a.rev, 'big.txt'), rebased, 'the completion rebased the pair');
    assert.equal(p.core.cs.revertMarks.current(a.rev)!.get('big.txt'), rebased, 'the mark followed in memory');
    const ls = await p.core.reverts.byCs(a.rev);
    assert.equal(ls.length, 2, 'the completion appended the moved mark\'s line');
    assert.deepEqual(ls[1], { cs: a.rev, of: a.of, t_local_ms: ls[0]!.t_local_ms, written: { 'big.txt': rebased, 'n.ts': ABSENT } }, 'of and t_local_ms repeated, the whole current map');
    assert.ok(atState.length > 0 && atState[0] === 2, `the line was durable before the completion's state update (${JSON.stringify(atState)})`);
    // A second restart re-derives the moved mark from that line.
    await restartCore(p);
    await restart(p.core);
    assert.deepEqual(p.core.cs.revertMarks.current(a.rev), new Map<string, Oid | 'ABSENT'>([['big.txt', rebased], ['n.ts', ABSENT]]), 'the mark survives the second restart');
  });
});

// One fixture per case (fix round 1): the core fixture's virtual wall clock then started 60 s ahead of the real one, and the writer's
// files carry real mtimes, so a fixture that ran much longer in real time than in virtual time (a loaded machine) saw them as written
// in the quiet period. Plan 3 Task EF raised the margin to 24 h (coreFixture's WALL_MARGIN_MS); the cases keep their own fixtures.
test('the mark is dropped when the revert CS publishes, when its record becomes terminal and when it leaves journal/ready/ unpublished', T10, async () => {
  await withCores('rev-mark-drop-pub', opts(), async (fx) => {
    const p = fx.peers[0]!;
    // It publishes.
    const a = await confirmed(fx, p);
    assert.deepEqual(await captureIteration(p), [a.rev]);
    assert.deepEqual(p.core.cs.revertMarks.current(a.rev), a.written);
    assert.equal((await publishNow(fx, p)).outcome, 'landed');
    assert.equal(p.core.cs.revertMarks.current(a.rev), null, 'published');
  });
  let claimed = false;
  await withCores('rev-mark-drop-term', opts({ ports: { gate: k6Gate(() => claimed) } }), async (fx) => {
    const p = fx.peers[0]!;
    // Its record becomes terminal: a K6 PIN discarded.
    const b = await confirmed(fx, p, 'k6.txt', false);
    assert.deepEqual(await captureIteration(p), [b.rev]);
    claimed = true;
    await publishNow(fx, p);
    const k6 = claimPin(p)!;
    assert.deepEqual(p.core.cs.revertMarks.current(b.rev), b.written, 'held');
    const res = await resolve(p.core, await prep(p, true), k6.id, 'discard', { humanEvidence: true, actor: 'human' });
    assert.equal(res.kind, 'done', JSON.stringify(res));
    assert.equal(p.core.holds.get(k6.id)!.state, 'RESOLVED_DISCARD');
    await prep(p);   // the next iteration, before its tick
    assert.equal(p.core.cs.revertMarks.current(b.rev), null, 'its record turned terminal');
  });
  await withCores('rev-mark-drop-left', opts(), async (fx) => {
    const p = fx.peers[0]!;
    // It leaves journal/ready/ unpublished: a revert deleting n2.ts, which the teammate then deletes too (no path is left in its pair).
    const own = await humanCs(fx, p, { 'n2.ts': N_TS });
    await prep(p, true);
    const loc = await locateCs(p.core, own.csId, { mode: 'verb' });
    assert.ok(loc !== null && 'found' in loc);
    const r = await revertInverse(p.core, loc.found, { mode: 'verb' });
    assert.ok(!('tooBig' in r) && r.results.get('n2.ts') === ABSENT);
    const c = await confirmRevert(p, own.csId, r);
    assert.deepEqual(await captureIteration(p), [c.cs]);
    assert.ok(p.core.cs.ready().some((x) => x.csId === c.cs));
    await fx.pushTeamChange({ 'n2.ts': null });
    await applyNow(fx, p);
    assert.ok(!p.core.cs.ready().some((x) => x.csId === c.cs), 'the pair left journal/ready/ (withdrawn)');
    assert.equal(p.core.cs.revertMarks.current(c.cs), null, 'left unpublished');
  });
});

test('ENG-25 lift: the revert-shrunk path is captured from the written blob in the loop of the write, while a torn read or a later edit of that path gets the ordinary exclusion', T10, async () => {
  await withCores('rev-mark-lift', opts(), async (fx) => {
    const p = fx.peers[0]!;
    const { rev, written } = await confirmed(fx, p);
    const it = await prep(p, 'auto');
    assert.equal(it.tick!.excluded.get('big.txt'), undefined, 'the written blob needs no second stable snapshot');
    assert.equal(it.tick!.dirty.get('big.txt')?.id, written.get('big.txt'));
    assert.equal(it.tick!.dirty.get('n.ts')?.kind, 'remove', 'the written deletion needs no 1-s second reading');
    await detectStep(p.core, it);
    assert.deepEqual((await captureStep(p.core, it)).captured, [rev], 'captured in the loop of the write');
    assert.equal(await pairR(p, rev, 'big.txt'), written.get('big.txt'));
    assert.equal(await pairR(p, rev, 'n.ts'), ABSENT);
    // A later edit of that path: the ordinary exclusion.
    await writeWork(p, 'big.txt', lines(40, (i) => `big row ${i}`));
    assert.equal((await prep(p)).tick!.excluded.get('big.txt'), 'shrink');
  });
  await withCores('rev-mark-torn', opts(), async (fx) => {
    const p = fx.peers[0]!;
    const { rev, written } = await confirmed(fx, p);
    const bytes = (await readWork(p, 'big.txt'))!;
    // A torn read in the loop of the write: the staged read sees 0 bytes.
    await writeWork(p, 'big.txt', '');
    let it = await prep(p, 'auto');
    assert.equal(it.tick!.excluded.get('big.txt'), 'shrink', 'the ordinary exclusion');
    await detectStep(p.core, it);
    assert.deepEqual((await captureStep(p.core, it)).captured, [rev]);
    assert.notEqual(await pairR(p, rev, 'big.txt'), written.get('big.txt'), 'the capture took the last stable entry');
    assert.equal(publicationGroups(p.core).find((g) => g.csIds.includes(rev))!.ready, false, 'not ready until a snapshot shows the write');
    // The next completed snapshot re-captures the closed CS from the written blob (§8 Q18).
    await writeWork(p, 'big.txt', bytes);
    it = await prep(p, 'auto');
    assert.equal(it.tick!.excluded.get('big.txt'), undefined);
    await detectStep(p.core, it);
    assert.deepEqual((await captureStep(p.core, it)).captured, [rev]);
    assert.equal(await pairR(p, rev, 'big.txt'), written.get('big.txt'), 're-captured from the written blob');
    assert.equal(publicationGroups(p.core).find((g) => g.csIds.includes(rev))!.ready, true);
    assert.equal((await publishNow(fx, p)).outcome, 'landed');
    assert.equal(await liveText(fx, p, 'big.txt'), BIG);
  });
});

/**
 * Fails, once, the state update-ref the apply makes after its HLD-41 rebase (a non-CAS failure: git refuses, the ref stays where it
 * was, so casRef throws GitCommandError); the apply's intent commit before the rebase goes through. Returns the unwrap.
 */
function failStateUpdateAfterRebase(p: PeerFixture): () => void {
  const cs = p.core.cs;
  const rebase = cs.rebase.bind(cs);
  let rebased = false;
  cs.rebase = async (...a: Parameters<typeof rebase>) => {
    const r = await rebase(...a);
    rebased = true;
    return r;
  };
  let failed = false;
  const unwrap = wrapGit(p, async (args, o, inner) => {
    if (rebased && !failed && args[0] === 'update-ref' && args.includes(p.core.refs.state)) {
      failed = true;
      return failedResult(128, 'fatal: cannot lock ref\n');
    }
    return inner(args, o);
  });
  return () => {
    unwrap();
    Reflect.deleteProperty(cs, 'rebase');
  };
}

test('fix round 1 (finding 1): a failed apply state update (reverts.jsonl EPERM past its retries, a non-CAS update-ref failure) gives the revert marks back with the pre-rebase pairs: a moved mark returns to its journaled oid and a withdrawn revert CS keeps its mark', T10, async (t) => {
  await t.test('(a) the rebase line\'s append fails EPERM past its 3 retries', async () => {
    await withCores('rev-mark-fail-eperm', opts(), async (fx) => {
      const p = fx.peers[0]!;
      const { rev, written } = await confirmed(fx, p);
      assert.deepEqual(await captureIteration(p), [rev]);
      await fx.pushTeamChange({ 'big.txt': buf(teamEdit(2)) });
      // The rename that publishes reverts.jsonl: the first attempt and its 3 retries (a Windows reader holding the file).
      p.fs.addRule({ op: 'rename', pathIncludes: 'reverts.jsonl', code: 'EPERM', times: 4 });
      fx.advance(10_000);
      await assert.rejects(applyStep(p.core, await prep(p)), (e: unknown) => errnoCode(e) === 'EPERM');
      assert.equal(await pairR(p, rev, 'big.txt'), written.get('big.txt'), 'the error path restored the journal\'s pair');
      assert.deepEqual(p.core.cs.revertMarks.current(rev), written, 'the mark is the one that pair carries, not the rebased oid');
      assert.ok(p.core.cs.revertMarks.covers('big.txt', written.get('big.txt')!), 'T0 and ENG-25 still exempt the journaled content');
      assert.equal((await p.core.reverts.byCs(rev)).length, 1, 'no rebase line');
    });
  });
  await t.test('(b) the state update-ref fails (not a lost CAS) after the rebase line was appended', async () => {
    await withCores('rev-mark-fail-ref', opts(), async (fx) => {
      const p = fx.peers[0]!;
      const { rev, written } = await confirmed(fx, p);
      assert.deepEqual(await captureIteration(p), [rev]);
      await fx.pushTeamChange({ 'big.txt': buf(teamEdit(2)) });
      fx.advance(10_000);
      const unwrap = failStateUpdateAfterRebase(p);
      try {
        await assert.rejects(applyStep(p.core, await prep(p)), GitCommandError);
      } finally {
        unwrap();
      }
      assert.equal(await pairR(p, rev, 'big.txt'), written.get('big.txt'), 'the error path restored the journal\'s pair');
      assert.deepEqual(p.core.cs.revertMarks.current(rev), written, 'the mark is the one that pair carries, not the rebased oid');
      // ENG-36: the line was durable before the failed update; with the pair it moved for unstored, it is an orphan a restart skips
      // (the journaled pair's R[p] matches the original line), the safe direction.
      const ls = await p.core.reverts.byCs(rev);
      assert.equal(ls.length, 2, 'the rebase line was appended before the state update');
      assert.notEqual(ls[1]!.written['big.txt'], written.get('big.txt'));
    });
  });
  await t.test('(c) a withdrawn revert CS (the teammate deleted the file its revert deletes) gets its pair and its mark back', async () => {
    await withCores('rev-mark-fail-withdraw', opts(), async (fx) => {
      const p = fx.peers[0]!;
      const own = await humanCs(fx, p, { 'n2.ts': N_TS });
      await prep(p, true);
      const loc = await locateCs(p.core, own.csId, { mode: 'verb' });
      assert.ok(loc !== null && 'found' in loc);
      const r = await revertInverse(p.core, loc.found, { mode: 'verb' });
      assert.ok(!('tooBig' in r) && r.results.get('n2.ts') === ABSENT);
      const c = await confirmRevert(p, own.csId, r);
      assert.deepEqual(await captureIteration(p), [c.cs]);
      await fx.pushTeamChange({ 'n2.ts': null });
      fx.advance(10_000);
      const unwrap = failStateUpdateAfterRebase(p);
      try {
        await assert.rejects(applyStep(p.core, await prep(p)), GitCommandError);
      } finally {
        unwrap();
      }
      assert.ok(p.core.cs.ready().some((x) => x.csId === c.cs), 'the error path restored the journal\'s pair');
      assert.deepEqual(p.core.cs.revertMarks.current(c.cs), c.written, 'and the mark the withdrawal had dropped');
    });
  });
});

test('ENG-25 re-capture (gate:false): a human CS closed while one of its paths is shrink-excluded is captured from the old stable entry, the confirmed shrink is re-captured into that closed CS while it is unpublished, and goes to a new human CS once it has published', T10, async (t) => {
  const SMALL = BIG.replace('big row 3\n', 'big row 3 HUMAN\n');
  const SHRUNK = lines(10, (i) => `big row ${i}`);   // a 90 % shrink: ENG-25 takes it at the second stable read
  /** A human CS {big2.txt, w.txt} whose quiet period ends in the tick that first sees big2.txt shrunk: it closes and is captured. */
  const closeUnderExclusion = async (fx: CoreFixture, p: PeerFixture): Promise<{ c: string; it: Awaited<ReturnType<typeof prep>> }> => {
    await writeWork(p, 'big2.txt', SMALL);
    await writeWork(p, 'w.txt', 'w HUMAN\n');
    await prep(p);
    assert.deepEqual([...p.core.cs.openPaths()].sort(), ['big2.txt', 'w.txt']);
    fx.advance(20_000);
    await writeWork(p, 'big2.txt', SHRUNK);
    const it = await prep(p, 'auto');
    assert.equal(it.tick!.excluded.get('big2.txt'), 'shrink', 'the first reading of the shrink is excluded');
    assert.ok(it.mat !== null, 'the human CS closed: a capture was due');
    await detectStep(p.core, it);
    const captured = (await captureStep(p.core, it)).captured;
    assert.equal(captured.length, 1, JSON.stringify(captured));
    const c = captured[0]!;
    assert.equal(await pairR(p, c, 'big2.txt'), await p.core.repo.hashBytes(buf(SMALL), false), 'the capture took the last stable entry');
    return { c, it };
  };
  /**
   * The ticks that confirm the shrink (R-25). The capture's materialization reset big2.txt's stat cache (Plan 2: a materialized path is
   * clean again), which restarts the confirmation: one more excluded reading, then the stable one ≥ 1 s later takes it.
   */
  const confirmShrink = async (fx: CoreFixture, p: PeerFixture): Promise<Awaited<ReturnType<typeof prep>>> => {
    fx.advance(1_500);
    assert.equal((await prep(p)).tick!.excluded.get('big2.txt'), 'shrink', 'still excluded: the confirmation restarted');
    fx.advance(1_500);
    const it = await prep(p, 'auto');
    assert.ok(it.tick!.dirty.has('big2.txt') && it.tick!.excluded.get('big2.txt') === undefined, 'the second stable reading takes the shrink');
    return it;
  };
  await t.test('(a) unpublished: re-captured into the closed CS', async () => {
    await withCores('rev-eng25-closed', opts(), async (fx) => {
      const p = fx.peers[0]!;
      const { c } = await closeUnderExclusion(fx, p);
      const it = await confirmShrink(fx, p);
      assert.ok(!p.core.cs.openPaths().has('big2.txt'), 'the confirmed shrink is the closed CS\'s, not the open human CS\'s');
      assert.ok(it.mat !== null, 'the closed CS is due again');
      await detectStep(p.core, it);
      assert.deepEqual((await captureStep(p.core, it)).captured, [c], 're-captured into the same CS');
      assert.equal(await pairR(p, c, 'big2.txt'), await p.core.repo.hashBytes(buf(SHRUNK), false));
      const pub = await publishNow(fx, p);
      assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
      assert.deepEqual(parseCsTrailers((await p.core.repo.readCommit(pub.c!)).trailers).cs.map((x) => x.csId), [c], 'one CS');
      assert.equal(await liveText(fx, p, 'big2.txt'), SHRUNK);
      assert.equal(await liveText(fx, p, 'w.txt'), 'w HUMAN\n');
    });
  });
  await t.test('(b) published first: the confirmed shrink goes to a new human CS', async () => {
    await withCores('rev-eng25-published', opts(), async (fx) => {
      const p = fx.peers[0]!;
      const { c, it: capIt } = await closeUnderExclusion(fx, p);
      const first = await publishStep(p.core, capIt);   // the capture's own iteration publishes, before the shrink is confirmed
      assert.equal(first.outcome, 'landed', JSON.stringify(first));
      assert.equal(await liveText(fx, p, 'big2.txt'), SMALL, 'the published entry is the last stable one');
      await confirmShrink(fx, p);
      assert.ok(p.core.cs.openPaths().has('big2.txt'), 'a new human CS takes it');
      assert.ok(!p.core.cs.table().cs.some((e) => e.cs_id === c), 'the published CS is gone from the table');
      fx.advance(20_000);
      const captured = await captureIteration(p);
      assert.equal(captured.length, 1);
      assert.notEqual(captured[0], c);
      const pub = await publishNow(fx, p);
      assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
      assert.deepEqual(parseCsTrailers((await p.core.repo.readCommit(pub.c!)).trailers).cs.map((x) => x.csId), captured);
      assert.equal(await liveText(fx, p, 'big2.txt'), SHRUNK);
    });
  });
});


test('Task EF (item 5): the revert gate holds until the re-capture lands — a tick that routes the write to the revert CS in an iteration that does not materialize (a capture not due, the tests\' prep + publishStep) leaves its group not ready and publishes nothing of it; the next materializing iteration re-captures the written blob and the group publishes it in one commit', T10, async () => {
  await withCores('rev-gate-routed', opts(), async (fx) => {
    const p = fx.peers[0]!;
    const { rev, written } = await confirmed(fx, p);
    const bytes = (await readWork(p, 'big.txt'))!;
    // A torn read in the loop of the write: the capture takes the last stable entry and the gate keeps the group back.
    await writeWork(p, 'big.txt', '');
    let it = await prep(p, 'auto');
    assert.equal(it.tick!.excluded.get('big.txt'), 'shrink');
    await detectStep(p.core, it);
    assert.deepEqual((await captureStep(p.core, it)).captured, [rev]);
    assert.notEqual(await pairR(p, rev, 'big.txt'), written.get('big.txt'), 'the capture took the last stable entry');
    const group = (): ReturnType<typeof publicationGroups>[number] => publicationGroups(p.core).find((g) => g.csIds.includes(rev))!;
    assert.equal(group().ready, false, 'not ready while no tick has shown the write');
    // The write shows at the tick of a publishing iteration that does not materialize: the tick routes it to the revert CS (due again).
    await writeWork(p, 'big.txt', bytes);
    const tip0 = await remoteLiveCode(fx, p);
    const r = await publishNow(fx, p);
    assert.notEqual(r.outcome, 'landed', `nothing of the revert CS publishes before its re-capture: ${JSON.stringify(r)}`);
    assert.equal(await remoteLiveCode(fx, p), tip0, 'the live chain is unchanged');
    assert.equal(group().ready, false, 'the gate holds until the re-capture');
    assert.notEqual(await pairR(p, rev, 'big.txt'), written.get('big.txt'), 'still the pre-write pair');
    // The next materializing iteration re-captures the closed CS from the written blob; the group is ready and publishes it.
    it = await prep(p, 'auto');
    assert.ok(it.mat !== null, 'the re-capture is due: the iteration materializes');
    await detectStep(p.core, it);
    assert.deepEqual((await captureStep(p.core, it)).captured, [rev]);
    assert.equal(await pairR(p, rev, 'big.txt'), written.get('big.txt'), 're-captured from the written blob');
    assert.equal(group().ready, true);
    const pub = await publishNow(fx, p);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.equal(await liveText(fx, p, 'big.txt'), BIG);
    assert.equal(await liveText(fx, p, 'n.ts'), null, 'and the deletion, in the same commit');
    const cs = parseCsTrailers((await p.core.repo.readCommit(pub.c!)).trailers).cs;
    assert.deepEqual(cs.map((x) => [x.csId, x.seq]), [[rev, 1]], 'the revert CS publishes once, as seq 1');
  });
});
