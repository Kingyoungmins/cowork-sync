// Review Focus 1 (Plan 3 Task 8; 05 U3, P4; HLD-07, HLD-18, HLD-26…HLD-29; R3-37): a human editor saving over a teammate's recent
// lines on the 1.3 MB BOM+CRLF fixture on a core.autocrlf=true peer — a plain informed edit, a stale buffer (the pre-apply bytes plus
// one change), a VS Code hot-exit restore (the same bytes renamed over the file) and a /rewind-style whole-file restore — with an
// untainted edit of row 20,000 in the same file. The teammate adds `TEAM_RF = 1` after row 1,000 and replaces row 5,000 with
// `ROW_5000_TEAM = 2`, applied before each case. "Publishes" = 20 s, a capture, publishStep lands. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOpId } from '../../src/board/ids.js';
import { applyStep } from '../../src/engine/apply.js';
import type { IterationCtx } from '../../src/engine/core.js';
import { revertStep } from '../../src/engine/detect.js';
import { evaluateRecords } from '../../src/engine/holdOps.js';
import { publishStep } from '../../src/engine/publish.js';
import { ABSENT, parseOid, type Oid } from '../../src/git/oid.js';
import type { TreeMap } from '../../src/git/repo.js';
import { blobAt, heldSide, type HoldRecord } from '../../src/holds/record.js';
import type { HoldOutcome } from '../../src/holds/registry.js';
import { revertDetector, taintOnlyH1, type DetectorDelta } from '../../src/holds/revert.js';
import { seededRandom } from '../../src/ports/random.js';
import { readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { captureReady, prep, remoteBoard, treeOf, withCores } from '../helpers/publishHelpers.js';
import { gitIn } from '../helpers/startFixture.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const ORIGINAL = generateBigBomCrlf(26_436, seededRandom('t8-rf1'));
/** The original rows without the BOM and without their CRLF. */
const ROWS: readonly string[] = (() => {
  const t = ORIGINAL.subarray(3).toString('utf8').split('\r\n');
  t.pop();
  return t;
})();

/**
 * big.py from the original rows: `rf` inserts the teammate's row (TEAM_RF = 1, or `rf` itself) after row 1,000, `team5000` replaces
 * row 5,000 with the teammate's ROW_5000_TEAM = 2; `set` replaces original rows (1-based). `team` sets both teammate changes.
 */
function big(o: { team?: boolean; rf?: string | boolean; team5000?: boolean; teamRf?: string; set?: Record<number, string> }): Buffer {
  const rf = o.rf === undefined ? (o.team === true ? (o.teamRf ?? 'TEAM_RF = 1') : null) : o.rf === false ? null : o.rf === true ? 'TEAM_RF = 1' : o.rf;
  const t5000 = o.team5000 ?? o.team === true;
  const out: string[] = [];
  ROWS.forEach((r, i) => {
    const n = i + 1;
    out.push(o.set?.[n] ?? (n === 5_000 && t5000 ? 'ROW_5000_TEAM = 2' : r));
    if (n === 1_000 && rf !== null) out.push(rf);
  });
  return Buffer.concat([BOM, Buffer.from(`${out.join('\r\n')}\r\n`, 'utf8')]);
}

const A_BYTES = big({ team: true });
const EDIT_20K = { 20_000: '# ROW_20000_MINE = 1' };
const T_HUMAN = { timeout: 15 * 60_000 };

async function withBig(label: string, fn: (fx: CoreFixture, p: PeerFixture) => Promise<void>): Promise<void> {
  await withCores(label, { n: 1, autocrlf: [true], files: { 'big.py': ORIGINAL } }, async (fx) => {
    const p = fx.peers[0]!;
    assert.equal(await p.core.repo.configGet('core.autocrlf'), 'true');
    await fx.pushTeamChange({ 'big.py': A_BYTES });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prep(p))).ran);
    assert.deepEqual(await readWork(p, 'big.py'), A_BYTES, 'applied: BOM + CRLF, byte-identical');
    assert.deepEqual(await revertStep(p.core, await prep(p, true)), []);
    await fn(fx, p);
  });
}

/** A tick, 1.5 s, a materializing iteration and revertStep. */
async function detect(fx: CoreFixture, p: PeerFixture): Promise<{ ids: string[]; it: IterationCtx }> {
  await prep(p);
  fx.advance(1_500);
  const it = await prep(p, true);
  return { ids: await revertStep(p.core, it), it };
}

/** Publishes the open human CS: 20 s, a capture, publishStep (landed or nothing). */
async function publish(fx: CoreFixture, p: PeerFixture): Promise<string> {
  fx.advance(20_000);
  const it = await prep(p, true);
  await revertStep(p.core, it);
  if (p.core.cs.closeDue()) await captureReady(p, it);
  return (await publishStep(p.core, it)).outcome;
}

/**
 * The live code at the remote: the last parent of the remote board's tip. (The code mirror is not it: a publish sets the mirror to
 * the TIP it built on, ENG-43, so the mirror lags this peer's own newest live commit.)
 */
async function remoteLive(fx: CoreFixture, p: PeerFixture): Promise<Oid> {
  const b = await p.core.repo.readCommit(parseOid((await remoteBoard(fx, p))!));
  return b.parents[b.parents.length - 1]!;
}

async function remoteBig(fx: CoreFixture, p: PeerFixture): Promise<Buffer> {
  const map = await treeOf(p, await remoteLive(fx, p));
  return p.core.repo.readBlob(map.get('big.py')!.oid);
}

const blobOf = async (p: PeerFixture, b: Buffer): Promise<Oid> => p.core.repo.hashBytes(b, false);
const h1Of = (r: HoldRecord): string | undefined => blobAt(heldSide(r), 'big.py');

function assertRevertPatch(r: HoldRecord, it: IterationCtx): void {
  assert.deepEqual([r.kind, r.residence, r.state, r.guards.map((g) => g.name), r.origin, r.paths], ['PATCH', 'ON_DISK', 'ACTIVE', ['revert'], 'human', ['big.py']]);
  assert.ok('h0' in r.blobs && blobAt(r.blobs.h0, 'big.py') === it.A.get('big.py')!.oid, 'h0 = A[big.py]');
}

/** A stale buffer: the pre-apply bytes plus the row-20,000 edit. */
const STALE = big({ team: false, set: EDIT_20K });

test('a plain informed edit of the teammate\'s row plus an edit of row 20,000 gives one revert PATCH whose h1 is taintOnlyH1, and the row-20,000 edit publishes in the same window through MASK step 5', T_HUMAN, async () => {
  await withBig('rf1-informed', async (fx, p) => {
    await writeWork(p, 'big.py', big({ team: true, teamRf: 'TEAM_RF = 9', set: EDIT_20K }));
    const { ids, it } = await detect(fx, p);
    assert.equal(ids.length, 1);
    const r = p.core.holds.get(ids[0]!)!;
    assertRevertPatch(r, it);
    assert.equal(h1Of(r), await blobOf(p, big({ team: true, teamRf: 'TEAM_RF = 9' })), 'h1 = A with only the TEAM_RF row changed');
    assert.equal(h1Of(r), await taintOnlyH1(p.core.repo, 'big.py', it.A.get('big.py')!.oid, it.mat!.sDiskMap.get('big.py')!.oid, p.core.prov, p.core.peerId));
    assert.equal(await publish(fx, p), 'landed');
    const pushed = await remoteBig(fx, p);
    assert.ok(pushed.equals(big({ team: true, set: EDIT_20K })), 'the row-20,000 edit, TEAM_RF = 1 unchanged, every other byte (BOM, CRLF) of A');
  });
});

test('a stale buffer (the pre-apply bytes plus an edit of row 20,000) saved in place gives one revert PATCH holding both teammate hunks; the row-20,000 edit publishes and the remote keeps TEAM_RF and ROW_5000_TEAM', T_HUMAN, async () => {
  await withBig('rf1-stale', async (fx, p) => {
    await writeWork(p, 'big.py', STALE);
    const { ids, it } = await detect(fx, p);
    assert.equal(ids.length, 1);
    const r = p.core.holds.get(ids[0]!)!;
    assertRevertPatch(r, it);
    assert.equal(h1Of(r), await blobOf(p, ORIGINAL), 'both teammate hunks held: h1 = A without TEAM_RF and with the original row 5,000');
    assert.equal(await publish(fx, p), 'landed');
    assert.ok((await remoteBig(fx, p)).equals(big({ team: true, set: EDIT_20K })), 'the remote keeps TEAM_RF and ROW_5000_TEAM and has the edit');
  });
});

test('a VS Code hot-exit restore (the same stale bytes written by rename over the file) gives the same record and the same publish', T_HUMAN, async () => {
  await withBig('rf1-hotexit', async (fx, p) => {
    const abs = workPath(p, 'big.py');
    await writeFile(`${abs}.hotexit`, STALE);
    await rename(`${abs}.hotexit`, abs);
    await writeWork(p, 'big.py', await readFile(abs));   // the editor's mtime, past the quiet window
    const { ids, it } = await detect(fx, p);
    assert.equal(ids.length, 1);
    const r = p.core.holds.get(ids[0]!)!;
    assertRevertPatch(r, it);
    assert.equal(h1Of(r), await blobOf(p, ORIGINAL));
    assert.equal(await publish(fx, p), 'landed');
    assert.ok((await remoteBig(fx, p)).equals(big({ team: true, set: EDIT_20K })));
  });
});

test('a /rewind-style whole-file restore of the pre-apply bytes gives one revert PATCH whose h1 equals the pre-apply blob, and no live commit changes big.py', T_HUMAN, async () => {
  await withBig('rf1-rewind', async (fx, p) => {
    const before = await remoteLive(fx, p);
    await writeFile(workPath(p, 'big.py'), ORIGINAL);
    await writeWork(p, 'big.py', ORIGINAL);
    const { ids, it } = await detect(fx, p);
    assert.equal(ids.length, 1);
    const r = p.core.holds.get(ids[0]!)!;
    assertRevertPatch(r, it);
    assert.equal(h1Of(r), await blobOf(p, ORIGINAL), 'h1 = the pre-apply blob');
    const outcome = await publish(fx, p);
    assert.ok(outcome === 'landed' || outcome === 'nothing', outcome);
    const after = await remoteLive(fx, p);
    const changed = after === before ? [] : (await gitIn(p, ['rev-list', '--first-parent', after, `^${before}`])).split('\n').filter((l) => l.length > 0);
    for (const c of changed) {
      const files = await gitIn(p, ['diff-tree', '-r', '--name-only', '--no-commit-id', `${c}^`, c]);
      assert.ok(!files.split('\n').includes('big.py'), `live commit ${c} does not change big.py`);
    }
    assert.ok((await remoteBig(fx, p)).equals(A_BYTES), 'the remote keeps A');
  });
});

test('a second save that keeps the tainted hunks and adds an untainted edit attaches to the same record', T_HUMAN, async () => {
  await withBig('rf1-attach', async (fx, p) => {
    const outcomes: HoldOutcome[] = [];
    const orig = p.core.holds.holdOutcome.bind(p.core.holds);
    Reflect.set(p.core.holds, 'holdOutcome', async (n: Parameters<typeof orig>[0]) => {
      const o = await orig(n);
      outcomes.push(o);
      return o;
    });
    await writeWork(p, 'big.py', STALE);
    const first = (await detect(fx, p)).ids;
    assert.equal(first.length, 1);
    // The editor reloads A (an untainted re-add of the teammate's rows), then the stale buffer is saved again with one more edit.
    await writeWork(p, 'big.py', A_BYTES);
    assert.deepEqual((await detect(fx, p)).ids, []);
    await writeWork(p, 'big.py', big({ team: false, set: { ...EDIT_20K, 21_000: '# ROW_21000_MINE = 1' } }));
    const second = (await detect(fx, p)).ids;
    assert.deepEqual(second, first, 'one id');
    assert.deepEqual(outcomes.map((o) => [o.id, o.created]), [[first[0], true], [first[0], false]]);
  });
});

/** The stale-buffer record released the way --publish does it, published, and ended RESOLVED_PUBLISH by R1. */
async function releaseAndPublish(fx: CoreFixture, p: PeerFixture, id: string): Promise<void> {
  await p.core.holds.markExplicit(id);
  await p.core.holds.releaseGuard(id, 'revert');
  p.core.cs.observe(['big.py']);
  assert.equal(await publish(fx, p), 'landed');
  await evaluateRecords(p.core, await prep(p, true), new Set(), []);
  assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_PUBLISH');
}

test('releasing the record the way --publish does publishes the hunks, R1 ends it RESOLVED_PUBLISH, and the revertDetector then stays quiet when the same hunks reappear', T_HUMAN, async () => {
  await withBig('rf1-release', async (fx, p) => {
    await writeWork(p, 'big.py', STALE);
    const [id] = (await detect(fx, p)).ids;
    assert.ok(id !== undefined);
    // While held, the untainted row-20,000 edit publishes alone.
    assert.equal(await publish(fx, p), 'landed');
    assert.ok((await remoteBig(fx, p)).equals(big({ team: true, set: EDIT_20K })));
    await releaseAndPublish(fx, p, id);
    assert.ok((await remoteBig(fx, p)).equals(STALE), 'the released hunks published');
    // This peer re-adds TEAM_RF = 1 (its own add) and publishes it (Task 8 fix round 1, finding 1: A holds TEAM_RF again, so the
    // removal below is a real delta against A), then removes it again: only the RESOLVED_PUBLISH record's exemption keeps it quiet.
    const readd = big({ rf: true, set: EDIT_20K });
    await writeWork(p, 'big.py', readd);
    assert.deepEqual((await detect(fx, p)).ids, []);
    assert.equal(await publish(fx, p), 'landed');
    assert.ok((await remoteBig(fx, p)).equals(readd), 'A holds TEAM_RF again');
    await writeWork(p, 'big.py', STALE);
    const { ids, it } = await detect(fx, p);
    assert.notEqual(it.mat!.sDiskMap.get('big.py')?.oid, it.A.get('big.py')?.oid, 'S_disk != A at the removal');
    assert.deepEqual(ids, []);
    assert.equal(p.core.holds.nonTerminal().length, 0);
    // The same delta at the detector: exempt with the record, tainted without it.
    const d: DetectorDelta = { path: 'big.py', prev: it.A.get('big.py')!.oid, next: it.mat!.sDiskMap.get('big.py')!.oid, binary: false };
    assert.deepEqual(await revertDetector(p.core.repo, [d], p.core.prov, p.core.peerId, [p.core.holds.get(id)!], p.core.rebase, it.A), [], 'exempt (HLD-29)');
    assert.deepEqual(await revertDetector(p.core.repo, [d], p.core.prov, p.core.peerId, [], p.core.rebase, it.A), [{ path: 'big.py', pin: false }], 'tainted without the record');
  });
});

// ---- 05 P4: INV-HLD-NOREVERT over the run, recomputed test-side --------------------------------------------------------

/** 05 §2 non-trivial, the test's own form. */
const nonTrivial = (s: string): boolean => {
  const t = s.replace(/\s/gu, '');
  return t.length > 0 && !/^[\p{P}\p{S}]+$/u.test(t);
};
const sha1 = async (s: string): Promise<string> => (await import('node:crypto')).createHash('sha1').update(Buffer.from(s, 'utf8')).digest('hex');
/** The test's own row diff: the rows of `before` and `after` that the other side lacks (multiset, endings ignored). */
function rowDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const split = (s: string): string[] => s.split('\n').map((r) => r.replace(/\r$/, '')).filter((r, i, a) => i < a.length - 1 || r.length > 0);
  const count = (rs: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rs) m.set(r, (m.get(r) ?? 0) + 1);
    return m;
  };
  const b = split(before);
  const a = split(after);
  const cb = count(b);
  const ca = count(a);
  const removed: string[] = [];
  for (const [r, n] of cb) for (let i = 0; i < n - (ca.get(r) ?? 0); i++) removed.push(r);
  const added: string[] = [];
  for (const [r, n] of ca) for (let i = 0; i < n - (cb.get(r) ?? 0); i++) added.push(r);
  return { removed, added };
}

test('INV-HLD-NOREVERT over the run: for every commit this peer pushed, a test-side recomputation finds no removed teammate line and no re-added teammate-deleted line unless covered by a RESOLVED_PUBLISH record', T_HUMAN, async () => {
  await withBig('rf1-p4', async (fx, p) => {
    // The run: an informed edit of the teammate's row (held; its untainted row-20,000 edit publishes), then its release.
    await writeWork(p, 'big.py', big({ team: true, teamRf: 'TEAM_RF = 9', set: EDIT_20K }));
    const [id] = (await detect(fx, p)).ids;
    assert.ok(id !== undefined);
    assert.equal(await publish(fx, p), 'landed');
    await releaseAndPublish(fx, p, id);
    assert.ok((await remoteBig(fx, p)).equals(big({ team: true, teamRf: 'TEAM_RF = 9', set: EDIT_20K })), 'the released change published');

    // The journal, read test-side: adds and dels by writer.
    const lines = (await readFile(join(p.deps.paths.coworkDir, 'prov', `${p.core.refs.e}.jsonl`), 'utf8')).split('\n').filter((l) => l.length > 0);
    const adds = new Map<string, Set<string>>();
    const dels = new Map<string, Set<string>>();
    for (const l of lines) {
      const e = JSON.parse(l) as { writer: string; paths: Record<string, { add: string[]; del: string[] }> };
      for (const c of Object.values(e.paths)) {
        for (const h of c.add) adds.set(h, new Set([...(adds.get(h) ?? []), e.writer]));
        for (const h of c.del) dels.set(h, new Set([...(dels.get(h) ?? []), e.writer]));
      }
    }
    const other = (m: Map<string, Set<string>>, h: string): boolean => [...(m.get(h) ?? [])].some((w) => w !== p.core.peerId);
    // RESOLVED_PUBLISH records' own changes, test-side.
    const covered = { removed: new Set<string>(), added: new Set<string>() };
    for (const r of p.core.holds.all().filter((x) => x.state === 'RESOLVED_PUBLISH')) {
      const h0 = 'h0' in r.blobs ? blobAt(r.blobs.h0, 'big.py') : undefined;
      const h1 = blobAt(heldSide(r), 'big.py');
      const t0 = h0 === undefined || h0 === ABSENT ? '' : (await p.core.repo.readBlob(h0 as Oid)).toString('utf8');
      const t1 = h1 === undefined || h1 === ABSENT ? '' : (await p.core.repo.readBlob(h1 as Oid)).toString('utf8');
      const d = rowDiff(t0.replace(/^\u{feff}/u, ''), t1.replace(/^\u{feff}/u, ''));
      for (const x of d.removed) covered.removed.add(await sha1(x));
      for (const x of d.added) covered.added.add(await sha1(x));
    }
    // Every live commit this peer pushed (Cowork-Writer peer = this peer), parent → commit.
    const tip = await remoteLive(fx, p);
    const chain = (await gitIn(p, ['rev-list', '--first-parent', tip])).split('\n').filter((l) => l.length > 0);
    let own = 0;
    let violations = 0;
    let uncoveredIgnoringRecords = 0;
    for (const c of chain) {
      const info = await p.core.repo.readCommit(parseOid(c));
      const w = info.trailers.find((t) => t.key === 'Cowork-Writer');
      if (w === undefined || parseOpId(w.value)?.peer !== p.core.peerId || info.parents.length === 0) continue;
      own += 1;
      const before: TreeMap = await treeOf(p, info.parents[0]!);
      const after: TreeMap = await treeOf(p, info.oid);
      const b = before.get('big.py');
      const a = after.get('big.py');
      if (b?.oid === a?.oid) continue;
      const tb = b === undefined ? '' : (await p.core.repo.readBlob(b.oid)).toString('utf8').replace(/^\u{feff}/u, '');
      const ta = a === undefined ? '' : (await p.core.repo.readBlob(a.oid)).toString('utf8').replace(/^\u{feff}/u, '');
      const d = rowDiff(tb, ta);
      for (const r of d.removed.filter(nonTrivial)) {
        const h = await sha1(r);
        if (other(adds, h)) {
          uncoveredIgnoringRecords += 1;
          if (!covered.removed.has(h)) violations += 1;
        }
      }
      for (const r of d.added.filter(nonTrivial)) {
        const h = await sha1(r);
        if (other(dels, h)) {
          uncoveredIgnoringRecords += 1;
          if (!covered.added.has(h)) violations += 1;
        }
      }
    }
    assert.ok(own >= 2, `this peer pushed its commits (${own})`);
    assert.equal(violations, 0, 'INV-HLD-NOREVERT');
    assert.ok(uncoveredIgnoringRecords > 0, 'the oracle sees the released removal (covered only by the RESOLVED_PUBLISH record)');
  });
});
