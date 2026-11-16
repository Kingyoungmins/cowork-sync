// RESTORE and PARK on stored-form fixtures (Plan 3 Task 5; Review Focus 5; 03-data DAT-01, DAT-45, DAT-46, I-DAT-12, I-DAT-15,
// TC-DAT-02 hold/restore leg; ruling R3-16): merges run on stored-form blobs only — the 1.3 MB BOM+CRLF fixture on a
// core.autocrlf=true peer, a cp949 file and a UTF-16LE working-tree-encoding file — every byte outside the edited rows is kept,
// a CRLF restore-marker row is detected and never reaches refs/cowork/*, and a clean restore over a non-canonical disk writes
// canon(result, ref(p)). Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { park, restore } from '../../src/engine/holdOps.js';
import { publishStep } from '../../src/engine/publish.js';
import { canon } from '../../src/data/canon.js';
import { hasBom, hasRestoreMarkerRow, rows } from '../../src/data/rows.js';
import type { Oid } from '../../src/git/oid.js';
import { maskEntries } from '../../src/holds/mask.js';
import { RebaseCache } from '../../src/holds/rebase.js';
import { seededRandom } from '../../src/ports/random.js';
import { runMergeFile } from '../../src/git/merge.js';
import { gitCallsOf, readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { mergeSides } from '../helpers/mergeFileArgs.js';
import { blob, looseObjects, nr, pair, prepIt, remoteCoworkBlobs, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { buf, captureReady, prep } from '../helpers/publishHelpers.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const BIG = 'big.py';
const KO = 'ko.txt';
const HAN = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);   // cp949 for "Hangul" (two syllables)
const HUMAN = { humanEvidence: true, actor: 'human' } as const;
const MARKER = /^(<{7}|\|{7}|>{7}) cowork:/m;

/** `blob` with 1-based row n's content (its ending and row 1's BOM kept) replaced by `content`. */
function withRow(b: Buffer, n: number, content: Buffer | string): Buffer {
  const rs = rows(b);
  const row = rs[n - 1]!;
  const crlf = row.length >= 2 && row[row.length - 2] === 0x0d && row[row.length - 1] === 0x0a;
  const lf = !crlf && row.length >= 1 && row[row.length - 1] === 0x0a;
  const bom = n === 1 && hasBom(row);
  rs[n - 1] = Buffer.concat([bom ? row.subarray(0, 3) : Buffer.alloc(0), typeof content === 'string' ? Buffer.from(content, 'utf8') : content, Buffer.from(crlf ? '\r\n' : lf ? '\n' : '', 'latin1')]);
  return Buffer.concat(rs);
}

/** The 1-based rows where two blobs differ (same row count). */
function differingRows(a: Buffer, b: Buffer): number[] {
  const ra = rows(a);
  const rb = rows(b);
  assert.equal(ra.length, rb.length, 'same row count');
  return ra.flatMap((r, i) => (r.equals(rb[i]!) ? [] : [i + 1]));
}

/** The teammate's change of `path` lands and is applied here (disk = A = TIP). */
async function teamApplied(fx: CoreFixture, p: PeerFixture, path: string, bytes: Buffer): Promise<void> {
  await fx.pushTeamChange({ [path]: bytes });
  fx.advance(10_000);
  const r = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
  assert.ok(r.written.includes(path), JSON.stringify(r));
}

test('Review Focus 5: a conflicted RESTORE on the 1.3 MB BOM+CRLF fixture under core.autocrlf=true writes CRLF marker rows that are detected and never leave this PC', T10, async () => {
  const big = generateBigBomCrlf(26_436, seededRandom('t5-restore-bomcrlf'));
  await withPeers('restore-big-conflict', { autocrlf: [true], files: { 'README.md': buf('# big\n'), [BIG]: big } }, async (fx) => {
    const p = fx.peers[0]!;
    const team = withRow(big, 1000, '# row 1000 by the team');
    await teamApplied(fx, p, BIG, team);
    const id = await p.core.holds.hold(nr({
      paths: [BIG], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon',
      blobs: stages(await blob(p, big), await blob(p, withRow(big, 1000, '# row 1000 by this PC')), await blob(p, team), BIG),
    }));
    const it = await prepIt(p, { holdPaths: [BIG] });
    assert.deepEqual(await restore(p.core, it, id, HUMAN), { kind: 'RESTORED', markers: true });
    const disk = (await readWork(p, BIG))!;
    const markerRows = rows(disk).filter((r) => /^(<{7}|\|{7}|>{7}) cowork:/.test(r.toString('latin1')));
    assert.equal(markerRows.length, 3, 'the three cowork: rows');
    for (const r of markerRows) assert.ok(r.subarray(-2).equals(Buffer.from('\r\n')), `a marker row ends in CRLF: ${JSON.stringify(r.toString('latin1'))}`);
    assert.equal(hasRestoreMarkerRow(disk), true, 'detected in the staged copy (the disk bytes)');
    const rec = p.core.holds.get(id)!;
    const m = await maskEntries(p.core.repo, new Map([[BIG, { path: BIG, mode: '100644' as const, oid: await blob(p, disk) }]]), { A: it.A, scope: () => 'LIVE', records: [rec], mergeable: () => true }, new RebaseCache(p.core.repo, () => true));
    assert.ok(m.withheld.has(BIG), 'maskEntries withholds the path');
    // The restore is a local change of the human CS, captured with another edit. markers withholds big.py whole and RESTORE released
    // `conflict` (the record is no longer the K4 displacement, R3-EF4-14), so README.md is PINned dependency:<id> and nothing of the CS
    // publishes (HLD-42, 05 I13). The PIN's held side leaves the markers path out (pinnablePaths, final review F4), so its mirror
    // carries no restore-marker row to refs/cowork/* either.
    await writeWork(p, 'README.md', '# big, edited\n');
    await prep(p);
    fx.advance(20_000);
    const itc = await prep(p, true);
    const pairR = await captureReady(p, itc);
    assert.ok(pairR.paths.includes(BIG), 'the restored path is in the captured change-set');
    fx.advance(30_000);
    const r = await publishStep(p.core, await prep(p));
    assert.equal(r.c, null, JSON.stringify(r));
    const pins = p.core.holds.nonTerminal().filter((x) => x.kind === 'PIN' && x.guards.some((g) => g.name === `dependency:${id}`));
    assert.equal(pins.length, 1);
    assert.deepEqual(pins[0]!.paths, ['README.md']);
    for (const b of await remoteCoworkBlobs(fx)) assert.doesNotMatch(b.toString('latin1'), MARKER, 'no restore-marker row (with or without CR) in refs/cowork/*');
  });
});

test('a clean RESTORE over a non-canonical disk writes canon(result, ref(p))', T10, async () => {
  const A0 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8\r\n9\r\n', 'latin1')]);
  await withPeers('restore-canon', { autocrlf: [true], files: { 'README.md': buf('# canon\n'), 'bom.txt': A0 } }, async (fx) => {
    const p = fx.peers[0]!;
    const P = 'bom.txt';
    const h1 = withRow(A0, 5, 'five');
    const it0 = await prepIt(p);
    const id = await p.core.holds.hold(nr({ paths: [P], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(it0.A.get(P)!.oid, await blob(p, h1), P) }));
    // A Write dropped the BOM; the DAT-08 repair has not run.
    await writeWork(p, P, A0.subarray(3));
    fx.advance(2_500);
    const it = await prepIt(p, { holdPaths: [P] });
    const D = it.mat!.sRawMap.get(P)!.oid;
    const merged = await runMergeFile(p.core.repo, ['merge-file', '-p', '--diff3', '--object-id', '-L', 'cowork:disk', '-L', 'cowork:base', '-L', 'cowork:held', D, it0.A.get(P)!.oid, await blob(p, h1)]);
    assert.equal(merged.rc, 0, 'a clean merge');
    const raw = merged.out;
    assert.equal(hasBom(raw), false, "the clean merge's raw result lacks the BOM");
    const want = canon(raw, A0, false);
    assert.ok(want.ok && hasBom(want.out));
    const targets: string[] = [];
    const w = p.core.writer;
    const inner = w.writeLocalGroup.bind(w);
    w.writeLocalGroup = (entries, origin, he) => {
      for (const e of entries) targets.push(String(e.target));
      return inner(entries, origin, he);
    };
    const before = looseObjects(p);
    assert.deepEqual(await restore(p.core, it, id, HUMAN), { kind: 'RESTORED', markers: false });
    assert.deepEqual(targets, [await blob(p, want.out)], 'writeLocal received canon(result, ref(p))');
    assert.deepEqual(await readWork(p, P), want.out, 'the written file: BOM back, stored form');
    assert.deepEqual(await readWork(p, P), h1);
    for (const o of [...looseObjects(p)].filter((x) => !before.has(x))) {
      const type = (await p.core.repo.run(['cat-file', '-t', o])).stdout.toString('utf8').trim();
      if (type !== 'blob') continue;
      const bytes = await p.core.repo.readBlob(o as Oid);
      assert.equal(await p.core.repo.hashBytes(bytes, false), o, `${o} hashes to itself under hash-object --stdin --no-filters`);
    }
  });
});

test('Review Focus 5 / I-DAT-15: RESTORE keeps every byte outside the edited rows', T10, async () => {
  const big = generateBigBomCrlf(26_436, seededRandom('t5-restore-idat15'));
  const ko = Buffer.concat(Array.from({ length: 12 }, (_, i) => Buffer.concat([HAN, Buffer.from(` row ${i + 1}\r\n`, 'latin1')])));
  const cases = [
    { path: BIG, base: big, local: 1000, team: 2000, localRow: Buffer.from('# row 1000 by this PC', 'utf8'), teamRow: Buffer.from('# row 2000 by the team', 'utf8') },
    { path: KO, base: ko, local: 3, team: 9, localRow: Buffer.concat([HAN, HAN, Buffer.from(' local', 'latin1')]), teamRow: Buffer.concat([Buffer.from('team ', 'latin1'), HAN]) },
  ];
  await withPeers('restore-idat15', { autocrlf: [true], files: { 'README.md': buf('# i-dat-15\n'), [BIG]: big, [KO]: ko } }, async (fx) => {
    const p = fx.peers[0]!;
    for (const c of cases) {
      const team = withRow(c.base, c.team, c.teamRow);
      await teamApplied(fx, p, c.path, team);
      const id = await p.core.holds.hold(nr({
        paths: [c.path], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon',
        blobs: stages(await blob(p, c.base), await blob(p, withRow(c.base, c.local, c.localRow)), await blob(p, team), c.path),
      }));
      const before = (await readWork(p, c.path))!;
      assert.ok(before.equals(team));
      const it = await prepIt(p, { holdPaths: [c.path] });
      assert.deepEqual(await restore(p.core, it, id, HUMAN), { kind: 'RESTORED', markers: false }, c.path);
      const after = (await readWork(p, c.path))!;
      assert.deepEqual(differingRows(before, after), [c.local], `${c.path}: only row ${c.local} changed`);
      if (c.path === BIG) assert.ok(hasBom(after), 'the BOM is kept');
      assert.ok(after.equals(withRow(team, c.local, c.localRow)), `${c.path}: every CR and byte kept`);
    }
  });
});

test('TC-DAT-02 hold and restore leg: a cp949 file and a UTF-16LE working-tree-encoding file round-trip byte-exact through PARK and RESTORE', T10, async () => {
  const W16 = 'w16.txt';
  const utf16 = (s: string): Buffer => Buffer.from(s, 'utf16le');
  const w16Text = Array.from({ length: 9 }, (_, i) => `w16 row ${i + 1} \u{d55c}\u{ae00}\n`).join('');
  const ko = Buffer.concat(Array.from({ length: 9 }, (_, i) => Buffer.concat([HAN, Buffer.from(` row ${i + 1}\n`, 'latin1')])));
  const files = { 'README.md': buf('# tc-dat-02\n'), '.gitattributes': buf(`${W16} working-tree-encoding=UTF-16LE\n`), [W16]: utf16(w16Text), [KO]: ko };
  await withPeers('tc-dat-02', { files }, async (fx) => {
    const p = fx.peers[0]!;
    assert.deepEqual(await readWork(p, W16), utf16(w16Text), 'checked out as UTF-16LE');
    const edited: Record<string, Buffer> = {
      [W16]: utf16(w16Text.replace('w16 row 4 ', 'w16 row 4 edited ')),
      [KO]: withRow(ko, 4, Buffer.concat([HAN, Buffer.from(' row 4 edited', 'latin1')])),
    };
    for (const [path, bytes] of Object.entries(edited)) await writeWork(p, path, bytes);
    const paths = [W16, KO];
    const it = await prepIt(p, { holdPaths: paths });
    const ids: Record<string, string> = {};
    for (const path of paths) {
      // A revert PATCH over the edited row: h0 = A[p], h1 = the staged-copy read of the disk (S_disk[p], stored form).
      ids[path] = await p.core.holds.hold(nr({ paths: [path], blobs: pair(it.A.get(path)!.oid, it.mat!.sDiskMap.get(path)!.oid, path) }));
      const h1 = await p.core.repo.readBlob(it.mat!.sDiskMap.get(path)!.oid);
      if (path === W16) assert.equal(h1.toString('utf8'), w16Text.replace('w16 row 4 ', 'w16 row 4 edited '), 'h1 is the stored form (UTF-8)');
      else assert.ok(h1.equals(edited[KO]!), 'h1 is the cp949 bytes');
    }
    const from = gitCallsOf(p).length;
    for (const path of paths) assert.deepEqual(await park(p.core, it, ids[path]!, { humanEvidence: true, displacedBy: null, refreshMustBeDurable: false }), { kind: 'PARKED', companion: null }, path);
    assert.deepEqual(await readWork(p, W16), utf16(w16Text), 'parked: the team version, UTF-16LE');
    assert.deepEqual(await readWork(p, KO), ko);
    fx.advance(2_500);
    const it2 = await prepIt(p, { holdPaths: paths });
    for (const path of paths) assert.deepEqual(await restore(p.core, it2, ids[path]!, HUMAN), { kind: 'RESTORED', markers: false }, path);
    for (const path of paths) assert.deepEqual(await readWork(p, path), edited[path], `${path}: byte-identical to its bytes before the park`);
    // Every merge-file input and output is a stored-form blob: an object of the store, and never UTF-16 (no NUL byte).
    const mf = gitCallsOf(p).slice(from).filter((c) => c.args[0] === 'merge-file');
    assert.ok(mf.length >= 2);
    for (const c of mf) {
      for (const o of mergeSides(c.args)) {   // ruling G1-FILEFORM: the scratch files are named by the objects they copy
        assert.equal(await p.core.repo.hasObject(o as Oid, 'blob'), true);
        assert.equal((await p.core.repo.readBlob(o as Oid)).includes(0), false, `${o} is stored form`);
      }
    }
  });
});
