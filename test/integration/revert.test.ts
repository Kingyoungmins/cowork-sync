// The revert detector on real clones (Plan 3 Task 8; 05-holds §3.6 Algorithm D2, HLD-18, HLD-26…HLD-29; 05 U3, P4, TC-HLD-03;
// CS-23…CS-27; rulings R3-36, R3-37). f.py = 60 rows `row_<i> = <i>`; this peer's own earlier publish added `MINE = 1` after row
// 40, the teammate (the core fixture's synthetic writer) added `TEAM = 1` after row 20 and deleted `row_30`; all applied.
// "Materialize and detect" = a detection tick, 1.5 s, then a materializing iteration followed by revertStep. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, rename, truncate, unlink, utimes, appendFile, writeFile } from 'node:fs/promises';
import { applyStep } from '../../src/engine/apply.js';
import type { IterationCtx } from '../../src/engine/core.js';
import { humanOnlyAttribution } from '../../src/engine/deps.js';
import { revertStep } from '../../src/engine/detect.js';
import { evaluateRecords } from '../../src/engine/holdOps.js';
import { maskInputsOf, maskOptions, publishStep } from '../../src/engine/publish.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { heldRanges, maskEntries, maskReason } from '../../src/holds/mask.js';
import { blobAt, heldSide, type HoldRecord } from '../../src/holds/record.js';
import type { HoldOutcome } from '../../src/holds/registry.js';
import { lineHash } from '../../src/holds/provenance.js';
import { revertDetector, taintOnlyH1, type DetectorDelta } from '../../src/holds/revert.js';
import { gitCallsOf, readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, captureReady, editAndCapture, LogRecorder, prep, withCores } from '../helpers/publishHelpers.js';
import { gitIn } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };
const DAY = 86_400_000;

/** f.py: rows 1–60, row_30 present unless dropped, TEAM = 1 after row 20, MINE = 1 after row 40; `replace` maps a row's text. */
function fpy(o: { team: boolean; mine: boolean; row30: boolean; replace?: Record<string, string>; drop?: readonly string[]; after?: Record<string, string> }): string {
  const out: string[] = [];
  for (let i = 1; i <= 60; i++) {
    if (i !== 30 || o.row30) out.push(`row_${i} = ${i}`);
    if (i === 20 && o.team) out.push('TEAM = 1');
    if (i === 40 && o.mine) out.push('MINE = 1');
  }
  const rows: string[] = [];
  for (const r of out) {
    if (o.drop?.includes(r) === true) continue;
    rows.push(o.replace?.[r] ?? r);
    const extra = o.after?.[r];
    if (extra !== undefined) rows.push(extra);
  }
  return rows.map((r) => `${r}\n`).join('');
}

const G0 = 'g_1 = 1\ng_2 = 2\ng_3 = 3\n';
const IMG0 = Buffer.concat([Buffer.from([0, 1, 2, 3]), buf('IMG v0 original bytes\nmore original\n')]);
const IMG_TEAM = Buffer.concat([Buffer.from([0, 9, 8, 7]), buf('IMG TEAMBIN v1 bytes\nTEAMBIN = 1\n')]);
const FILES: Record<string, Buffer> = {
  'README.md': buf('# revert detector fixture\n'),
  'f.py': buf(fpy({ team: false, mine: false, row30: true })),
  'g.py': buf(G0),
  'img.bin': IMG0,
};

/** The A after the setup (this peer's MINE when `mine`, the teammate's TEAM and row_30 deletion). */
const AFTER = (mine: boolean): string => fpy({ team: true, mine, row30: false });

/**
 * The shared setup: optionally this peer's own publish of MINE = 1 (captured and landed), then the teammate's change, applied,
 * and one materializing detection that finds nothing (the applied bytes are no local delta).
 */
async function setup(fx: CoreFixture, p: PeerFixture, o: { mine: boolean; team?: Record<string, Buffer | null> } = { mine: true }): Promise<void> {
  if (o.mine) {
    await editAndCapture(fx, p, { 'f.py': fpy({ team: false, mine: true, row30: true }) });
    const r = await publishStep(p.core, await prep(p));
    assert.equal(r.outcome, 'landed', `own publish: ${JSON.stringify(r)}`);
  }
  await fx.pushTeamChange({ 'f.py': buf(AFTER(o.mine)), ...(o.team ?? {}) });
  fx.advance(10_000);
  const r = await applyStep(p.core, await prep(p));
  assert.ok(r.ran, `the apply ran: ${r.skipped ?? ''}`);
  assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), AFTER(o.mine));
  assert.deepEqual(await revertStep(p.core, await prep(p, true)), [], 'applied bytes are no local delta');
}

/** A detection tick, 1.5 s (a deletion's second read), then a materializing iteration and revertStep. */
async function detect(fx: CoreFixture, p: PeerFixture): Promise<{ ids: string[]; it: IterationCtx }> {
  await prep(p);
  fx.advance(1_500);
  const it = await prep(p, true);
  return { ids: await revertStep(p.core, it), it };
}

const reverts = (p: PeerFixture): HoldRecord[] => p.core.holds.nonTerminal().filter((r) => r.guards.some((g) => g.name === 'revert'));
const text = async (p: PeerFixture, o: string | undefined): Promise<string | null> => (o === undefined || o === ABSENT ? null : (await p.core.repo.readBlob(o as Oid)).toString('utf8'));
const aOid = (p: PeerFixture, it: IterationCtx, path: string): string | undefined => it.A.get(path)?.oid;

/** 05 P4 exp_a shape: a `revert` PATCH, ON_DISK ACTIVE, origin 'human', no cs, h0 = A[f.py], h1 = `h1Text`. */
async function assertRevertPatch(p: PeerFixture, r: HoldRecord, it: IterationCtx, h1Text: string): Promise<void> {
  assert.deepEqual([r.kind, r.residence, r.state, r.guards.map((g) => g.name), r.origin, r.cs_ids, r.paths], ['PATCH', 'ON_DISK', 'ACTIVE', ['revert'], 'human', [], ['f.py']]);
  assert.ok('h0' in r.blobs);
  assert.equal(blobAt(r.blobs.h0, 'f.py'), aOid(p, it, 'f.py'), 'h0 = A[f.py]');
  assert.equal(await text(p, blobAt(heldSide(r), 'f.py')), h1Text);
}

test('removing a teammate-added line is tainted; removing a pre-genesis line or a line this peer published is not', T10, async () => {
  await withCores('revert-basic', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    await writeWork(p, 'f.py', fpy({ team: true, mine: true, row30: false, drop: ['row_10 = 10'] }));
    assert.deepEqual((await detect(fx, p)).ids, [], 'a pre-genesis line');
    await writeWork(p, 'f.py', fpy({ team: true, mine: false, row30: false }));
    assert.deepEqual((await detect(fx, p)).ids, [], 'a line this peer published (and row_10 re-added: nobody removed it)');
    await writeWork(p, 'f.py', fpy({ team: false, mine: true, row30: false }));
    const { ids, it } = await detect(fx, p);
    assert.equal(ids.length, 1, 'the teammate\'s line');
    assert.equal(reverts(p).length, 1);
    await assertRevertPatch(p, p.core.holds.get(ids[0]!)!, it, fpy({ team: false, mine: true, row30: false }));
  });
});

test('re-adding a line a teammate deleted is tainted', T10, async () => {
  await withCores('revert-readd', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    await writeWork(p, 'f.py', fpy({ team: true, mine: true, row30: true }));   // a stale save brings row_30 back
    const { ids, it } = await detect(fx, p);
    assert.equal(ids.length, 1);
    await assertRevertPatch(p, p.core.holds.get(ids[0]!)!, it, fpy({ team: true, mine: true, row30: true }));
  });
});

test("a whitespace-only reindent of a teammate's line is exempt; a quote-style change of it is tainted", T10, async () => {
  await withCores('revert-ws', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const after = (q: string): string => fpy({ team: true, mine: true, row30: false, after: { 'row_50 = 50': q } });
    await setup(fx, p, { mine: true });
    // The teammate's second line: print('a') after row 50.
    await fx.pushTeamChange({ 'f.py': buf(after("print('a')")) });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prep(p))).ran);
    assert.deepEqual(await revertStep(p.core, await prep(p, true)), []);
    await writeWork(p, 'f.py', fpy({ team: true, mine: true, row30: false, replace: { 'TEAM = 1': 'TEAM =  1' }, after: { 'row_50 = 50': "print('a')" } }));
    assert.deepEqual((await detect(fx, p)).ids, [], 'a ws-equal pair');
    await writeWork(p, 'f.py', fpy({ team: true, mine: true, row30: false, replace: { 'TEAM = 1': 'TEAM =  1' }, after: { 'row_50 = 50': 'print("a")' } }));
    const { ids } = await detect(fx, p);
    assert.equal(ids.length, 1, 'a quote-style change is not whitespace');
  });
});

// ---- 05 U3 / TC-HLD-03: the revert table ----------------------------------------------------------------------------------

let stampSeq = 0;
/** The peer's virtual wall clock minus 1 s on the file's mtime (as writeWork does): the tick reads it after the quiet window. */
async function stamp(p: PeerFixture, path: string): Promise<void> {
  const t = (p.clock.wallMs() - 1_000 + (stampSeq++ % 100_000) / 1_000) / 1_000;
  await utimes(workPath(p, path), t, t);
}

type Writer = 'human_save' | 'rewind' | 'bash_sed' | 'formatter' | 'ws_formatter' | 'claude_edit';
type Cell = 'modify' | 'delete' | 're-add';

/** The bytes each cell writes over A (TEAM added, row_30 deleted; no own row); the whitespace-only formatter changes only whitespace. */
function cellBytes(w: Writer, c: Cell): string {
  if (w === 'ws_formatter') {
    const target = c === 're-add' ? 'row_29 = 29' : 'TEAM = 1';
    return fpy({ team: true, mine: false, row30: false, replace: { [target]: `  ${target.replace(' = ', '   =   ')}  ` } });
  }
  if (c === 'modify') return fpy({ team: true, mine: false, row30: false, replace: { 'TEAM = 1': 'TEAM = 2' } });
  if (c === 'delete') return fpy({ team: false, mine: false, row30: false });
  return fpy({ team: true, mine: false, row30: true });
}

/** Each writer's way of putting the bytes on disk (all unobserved but the Claude Edit, which the attribution port claims). */
async function write(p: PeerFixture, w: Writer, bytes: string): Promise<void> {
  const abs = workPath(p, 'f.py');
  switch (w) {
    case 'human_save':
    case 'claude_edit': {
      // An in-place write: the same file, overwritten and truncated.
      const h = await open(abs, 'r+');
      try {
        await h.write(buf(bytes), 0, Buffer.byteLength(bytes), 0);
        await h.truncate(Buffer.byteLength(bytes));
      } finally {
        await h.close();
      }
      break;
    }
    case 'rewind':
      await writeFile(abs, buf(bytes));   // a whole-file write
      break;
    case 'bash_sed':
      await truncate(abs, 0);              // truncate, then write
      await appendFile(abs, buf(bytes));
      break;
    case 'formatter':
    case 'ws_formatter':
      await writeFile(`${abs}.fmt-tmp`, buf(bytes));   // rename over
      await rename(`${abs}.fmt-tmp`, abs);
      break;
  }
  await stamp(p, 'f.py');
}

test('05 U3 / TC-HLD-03 table: modify, delete and re-add teammate lines through a human save, a /rewind restore, a Bash sed, a non-whitespace formatter, a whitespace-only formatter and a Claude Edit', { timeout: 30 * 60_000 }, async () => {
  const writers: Writer[] = ['human_save', 'rewind', 'bash_sed', 'formatter', 'ws_formatter', 'claude_edit'];
  const cells: Cell[] = ['modify', 'delete', 're-add'];
  const want = (w: Writer): boolean => w !== 'ws_formatter' && w !== 'claude_edit';
  const got: string[] = [];
  for (const w of writers) {
    for (const c of cells) {
      await withCores(`u3-${w}-${c}`, { n: 1, files: FILES }, async (fx) => {
        const p = fx.peers[0]!;
        await setup(fx, p, { mine: false });
        if (w === 'claude_edit') p.deps.attribution = { ...humanOnlyAttribution, observedEdit: (path: string): boolean => path === 'f.py' };
        await write(p, w, cellBytes(w, c));
        const { ids } = await detect(fx, p);
        got.push(`${w} ${c} ${ids.length === 1 ? 'yes' : ids.length === 0 ? 'no' : `?${ids.length}`}`);
      });
    }
  }
  const expected = writers.flatMap((w) => cells.map((c) => `${w} ${c} ${want(w) ? 'yes' : 'no'}`));
  assert.deepEqual(got, expected);
});

test('a delta landing exactly on an ObservedWrites entry is dropped and the entry consumed', T10, async () => {
  await withCores('revert-observed', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    const without = fpy({ team: false, mine: true, row30: false });
    const blob = await p.core.repo.hashBytes(buf(without), true);
    p.core.observed.record('f.py', blob);
    await writeWork(p, 'f.py', without);
    assert.deepEqual((await detect(fx, p)).ids, [], 'an attributed write is observed');
    assert.equal(p.core.observed.consume('f.py', blob), false, 'the entry was consumed');
    await writeWork(p, 'f.py', fpy({ team: false, mine: true, row30: true }));
    const { ids } = await detect(fx, p);
    assert.equal(ids.length, 1, 'a further different delta is examined normally (row_30 re-added)');
  });
});

test('a teammate line appended more than 14 days ago of local time is no longer protected', T10, async () => {
  await withCores('revert-retention', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    fx.advance(15 * DAY);
    await writeWork(p, 'f.py', fpy({ team: false, mine: true, row30: false }));
    assert.deepEqual((await detect(fx, p)).ids, []);
    assert.equal(reverts(p).length, 0);
  });
});

/** The binary setup: the teammate's img.bin and g.py's TEAM_G = 1 applied; a stale img.bin copy and g.py deleted, then detected. */
async function binaryAndDeletion(fx: CoreFixture, p: PeerFixture): Promise<{ ids: string[]; it: IterationCtx }> {
  await setup(fx, p, { mine: false, team: { 'img.bin': IMG_TEAM, 'g.py': buf(`${G0}TEAM_G = 1\n`) } });
  assert.deepEqual(await readWork(p, 'img.bin'), IMG_TEAM);
  await writeWork(p, 'img.bin', IMG0);   // a stale copy over the teammate's version
  await unlink(workPath(p, 'g.py'));
  return detect(fx, p);
}

test('a binary file whose teammate version is replaced becomes a PIN guard revert, and deleting a file holding a teammate line becomes a PIN with h1 ABSENT', T10, async () => {
  await withCores('revert-binary', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { ids } = await binaryAndDeletion(fx, p);
    assert.equal(ids.length, 2);
    const recs = ids.map((id) => p.core.holds.get(id)!).sort((a, b) => (a.paths[0]! < b.paths[0]! ? -1 : 1));
    const [g, img] = recs as [HoldRecord, HoldRecord];
    assert.deepEqual([g.kind, g.residence, g.state, g.guards.map((x) => x.name), g.paths], ['PIN', 'ON_DISK', 'ACTIVE', ['revert'], ['g.py']]);
    assert.equal(blobAt(heldSide(g), 'g.py'), ABSENT, 'a deletion: h1 ABSENT');
    assert.deepEqual([img.kind, img.residence, img.state, img.guards.map((x) => x.name), img.paths], ['PIN', 'ON_DISK', 'ACTIVE', ['revert'], ['img.bin']]);
    assert.equal(blobAt(heldSide(img), 'img.bin'), await p.core.repo.hashBytes(IMG0, false), 'h1 = the stale copy on disk');
  });
});

test('a binary path is held only as a whole-file PIN and HOLD_BINARY_WHOLE_FILE {hid, path} goes to the daemon log once per record and to status', T10, async () => {
  await withCores('revert-binary-code', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    const { ids, it } = await binaryAndDeletion(fx, p);
    const img = ids.map((id) => p.core.holds.get(id)!).find((r) => r.paths[0] === 'img.bin')!;
    assert.equal(img.kind, 'PIN', 'no PATCH for a binary path');
    const inp = maskInputsOf(p.core, it, p.core.holds.maskingRecords());
    assert.equal(maskReason('img.bin', inp), 'pin', 'MASK withholds the whole path');
    const sPub = await maskEntries(p.core.repo, it.mat!.sDiskMap, inp, p.core.rebase, maskOptions(p.core));
    assert.ok(sPub.withheld.has('img.bin'));
    assert.equal(sPub.entries.get('img.bin')?.oid, it.A.get('img.bin')?.oid, 'S_pub[img.bin] = A[img.bin]');
    assert.ok(!(await heldRanges(p.core.repo, it.mat!.sDiskMap, sPub)).has('img.bin'), 'no line-level held range');
    const lines = (): Array<{ code: string; params: Record<string, unknown> }> => log.lines.filter((l) => l.code === 'HOLD_BINARY_WHOLE_FILE');
    assert.deepEqual(lines().map((l) => l.params), [{ hid: img.id, path: 'img.bin' }]);
    assert.deepEqual(p.core.holdCode, { code: 'HOLD_BINARY_WHOLE_FILE', params: { hid: img.id, path: 'img.bin' } });
    // Task 8 fix round 1, finding 3: each further materialization re-meets the record — the editor reloads the teammate's img.bin
    // (no taint), then saves the stale copy again, which HLD-07 attaches to the same record (created: false). Without these
    // re-triggers img.bin never changes again and revertStep returns before the once-per-record check is ever reached.
    const outcomes: HoldOutcome[] = [];
    const orig = p.core.holds.holdOutcome.bind(p.core.holds);
    Reflect.set(p.core.holds, 'holdOutcome', async (n: Parameters<typeof orig>[0]) => {
      const o = await orig(n);
      outcomes.push(o);
      return o;
    });
    for (let i = 0; i < 10; i++) {
      await writeWork(p, 'img.bin', i % 2 === 0 ? IMG_TEAM : IMG0);
      const { ids: again } = await detect(fx, p);
      assert.deepEqual(again, i % 2 === 0 ? [] : [img.id], `iteration ${i}`);
    }
    assert.deepEqual(outcomes.map((o) => [o.id, o.created]), Array.from({ length: 5 }, () => [img.id, false]), 'five re-attachments');
    assert.equal(lines().length, 1, 'once per record over 10 further materializing iterations');
    assert.equal(p.core.holdCode?.code, 'HOLD_BINARY_WHOLE_FILE');
  });
});

test("taintOnlyH1 applies only the tainted hunks: h1 is A with only the TEAM removal, while maskEntries' S_pub is A plus the untainted edit of row 50", T10, async () => {
  await withCores('revert-taintonly', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    await writeWork(p, 'f.py', fpy({ team: false, mine: true, row30: false, replace: { 'row_50 = 50': 'row_50 = 5000' } }));
    const { ids, it } = await detect(fx, p);
    assert.equal(ids.length, 1);
    const r = p.core.holds.get(ids[0]!)!;
    const h1 = blobAt(heldSide(r), 'f.py')!;
    assert.equal(await text(p, h1), fpy({ team: false, mine: true, row30: false }), 'A with only the TEAM row removed');
    const sDisk = it.mat!.sDiskMap.get('f.py')!.oid;
    assert.equal(await taintOnlyH1(p.core.repo, 'f.py', it.A.get('f.py')!.oid, sDisk, p.core.prov, p.core.peerId), h1, "the record's h1 is taintOnlyH1's output");
    const sPub = await maskEntries(p.core.repo, it.mat!.sDiskMap, maskInputsOf(p.core, it, p.core.holds.maskingRecords()), p.core.rebase, maskOptions(p.core));
    assert.equal(await text(p, sPub.entries.get('f.py')?.oid), fpy({ team: true, mine: true, row30: false, replace: { 'row_50 = 50': 'row_50 = 5000' } }), 'S_pub: A plus the untainted edit, TEAM present');
  });
});

test("a user's diff.interHunkContext, diff.algorithm and diff.indentHeuristic do not merge the -U0 hunks: h1 holds only the tainted hunk and the nearby untainted edit publishes", T10, async () => {
  // Task 8 fix round 1, finding 7: the repository's (or ~/.gitconfig's) diff.interHunkContext reaches the two -U0 calls; at 3 or more
  // the TEAM removal and an edit two rows below it become one hunk, which taintOnlyH1 applied whole into h1 (MASK then withheld the
  // untainted edit, against HLD-28's "untainted edits on the same path publish normally").
  await withCores('revert-interhunk', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    await gitIn(p, ['config', 'diff.interHunkContext', '100']);
    await gitIn(p, ['config', 'diff.algorithm', 'histogram']);
    await gitIn(p, ['config', 'diff.indentHeuristic', 'true']);
    const edited = { 'row_22 = 22': 'row_22 = 2222' };
    await writeWork(p, 'f.py', fpy({ team: false, mine: true, row30: false, replace: edited }));
    const { ids, it } = await detect(fx, p);
    assert.equal(ids.length, 1);
    const h1 = blobAt(heldSide(p.core.holds.get(ids[0]!)!), 'f.py')!;
    assert.equal(await text(p, h1), fpy({ team: false, mine: true, row30: false }), 'A with only the TEAM row removed');
    const sPub = await maskEntries(p.core.repo, it.mat!.sDiskMap, maskInputsOf(p.core, it, p.core.holds.maskingRecords()), p.core.rebase, maskOptions(p.core));
    assert.equal(await text(p, sPub.entries.get('f.py')?.oid), fpy({ team: true, mine: true, row30: false, replace: edited }), 'S_pub: A plus the untainted edit, TEAM present');
  });
});

test('revertStep runs only on an iteration that materialized: a tick-only iteration creates no record and writes no object, and the next materializing iteration creates it from that S_disk', T10, async () => {
  await withCores('revert-ticks', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    await writeWork(p, 'f.py', fpy({ team: false, mine: true, row30: false }));
    const from = gitCallsOf(p).length;
    for (let i = 0; i < 3; i++) {
      fx.advance(2_500);
      const it = await prep(p);
      assert.equal(it.mat, null, 'a detection tick');
      assert.deepEqual(await revertStep(p.core, it), []);
    }
    assert.equal(reverts(p).length, 0, 'no record');
    const writes = gitCallsOf(p).slice(from).filter((c) => c.args[0] === 'hash-object' && c.args.includes('-w'));
    assert.deepEqual(writes.map((c) => c.args.join(' ')), [], 'no object written at the ticks');
    // A user editor saving the same stale buffer again changes nothing (05 B3 stale-buffer variant): the materialization decides.
    const it = await prep(p, true);
    const ids = await revertStep(p.core, it);
    assert.equal(ids.length, 1);
    const r = p.core.holds.get(ids[0]!)!;
    const want = await taintOnlyH1(p.core.repo, 'f.py', it.A.get('f.py')!.oid, it.mat!.sDiskMap.get('f.py')!.oid, p.core.prov, p.core.peerId);
    assert.equal(blobAt(heldSide(r), 'f.py'), want, "h1 against that iteration's S_disk");
  });
});

test('a second materialization with the same tainted hunks attaches to the same record', T10, async () => {
  await withCores('revert-attach', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    const outcomes: HoldOutcome[] = [];
    const orig = p.core.holds.holdOutcome.bind(p.core.holds);
    Reflect.set(p.core.holds, 'holdOutcome', async (n: Parameters<typeof orig>[0]) => {
      const o = await orig(n);
      outcomes.push(o);
      return o;
    });
    await writeWork(p, 'f.py', fpy({ team: false, mine: true, row30: false }));
    const first = (await detect(fx, p)).ids;
    assert.equal(first.length, 1);
    // The editor reloads the file (TEAM back: an untainted re-add), then the same TEAM removal is saved with an untainted row_55 edit.
    await writeWork(p, 'f.py', AFTER(true));
    assert.deepEqual((await detect(fx, p)).ids, []);
    await writeWork(p, 'f.py', fpy({ team: false, mine: true, row30: false, replace: { 'row_55 = 55': 'row_55 = 5555' } }));
    const second = (await detect(fx, p)).ids;
    assert.deepEqual(second, first, 'the same record');
    assert.deepEqual(outcomes.map((o) => [o.id, o.created]), [[first[0], true], [first[0], false]]);
    assert.equal(reverts(p).length, 1, 'one non-terminal record');
  });
});

test('a hunk covered by a RESOLVED_PUBLISH record on the path is exempt', T10, async () => {
  await withCores('revert-resolved', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await setup(fx, p);
    const without = fpy({ team: false, mine: true, row30: false });
    await writeWork(p, 'f.py', without);
    const [id] = (await detect(fx, p)).ids;
    assert.ok(id !== undefined);
    // Released the way --publish does it: explicit, the revert guard released, the path observed into the human CS.
    await p.core.holds.markExplicit(id);
    await p.core.holds.releaseGuard(id, 'revert');
    p.core.cs.observe(['f.py']);
    fx.advance(20_000);
    const capIt = await prep(p, true);
    await captureReady(p, capIt);
    const pub = await publishStep(p.core, capIt);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    const evIt = await prep(p, true);
    await evaluateRecords(p.core, evIt, new Set(), []);
    assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_PUBLISH');
    // This peer re-adds TEAM = 1 itself (its own add, untainted) and publishes it (Task 8 fix round 1, finding 1: so A holds TEAM
    // again and the removal below is a real delta against A — without the publish, S_disk == A at the removal and holdReverts made
    // no record whether or not the exemption held).
    await writeWork(p, 'f.py', AFTER(true));
    assert.deepEqual((await detect(fx, p)).ids, [], 'its own re-add: the teammate never deleted TEAM, this peer did');
    fx.advance(20_000);
    const reIt = await prep(p, true);
    await captureReady(p, reIt);
    assert.equal((await publishStep(p.core, reIt)).outcome, 'landed');
    assert.equal(await text(p, (await p.core.repo.readTreeMap(p.core.view!.base)).get('f.py')?.oid), AFTER(true), 'A holds TEAM again');
    assert.ok(p.core.prov.addedBy(lineHash(buf('TEAM = 1'))).some((w) => w !== p.core.peerId), "the teammate's add is still within retention");
    // Deleting it again: S_disk != A, the removed row is the teammate's add; only the RESOLVED_PUBLISH record's exemption (HLD-29)
    // keeps it from becoming a record.
    await writeWork(p, 'f.py', without);
    const { ids, it } = await detect(fx, p);
    assert.notEqual(it.mat!.sDiskMap.get('f.py')?.oid, it.A.get('f.py')?.oid, 'S_disk != A at the removal');
    assert.deepEqual(ids, []);
    assert.equal(reverts(p).length, 0);
    assert.deepEqual(p.core.holds.all().map((r) => [r.id, r.state]), [[id, 'RESOLVED_PUBLISH']], 'only the resolved record');
    // The same delta at the detector: exempt with the record, tainted without it.
    const d: DetectorDelta = { path: 'f.py', prev: it.A.get('f.py')!.oid, next: it.mat!.sDiskMap.get('f.py')!.oid, binary: false };
    const rec = p.core.holds.get(id)!;
    assert.deepEqual(await revertDetector(p.core.repo, [d], p.core.prov, p.core.peerId, [rec], p.core.rebase, it.A), [], 'exempt (HLD-29)');
    assert.deepEqual(await revertDetector(p.core.repo, [d], p.core.prov, p.core.peerId, [], p.core.rebase, it.A), [{ path: 'f.py', pin: false }], 'tainted without the record');
  });
});
