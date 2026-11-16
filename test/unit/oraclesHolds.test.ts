// The test-side operators of Task 14's oracles (test/sim/oraclesHolds.ts; 05-holds §3.4 items 1–2, HLD-13, HLD-14, HLD-15; rulings R3-18,
// R3-21, R3-50) and the one-site rule of the Plan 3 mutants. testMask and testRebase run file-form `git merge-file -p` on a real clone
// (makeRepoFixture: a temp root with a space and Hangul); git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { binary, pair, record, ulidOf } from '../helpers/maskFixture.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { parseLocal, simScope } from '../sim/holdsView.js';
import { andClause, singleCollisions, testMask, testRebase, type Entry } from '../sim/oraclesHolds.js';

/** R3-55: every test file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const rowsText = (n: number, edit: Record<number, string> = {}, drop: readonly number[] = []): string =>
  Array.from({ length: n }, (_, k) => k + 1).filter((k) => !drop.includes(k)).map((k) => `${edit[k] ?? `row ${k}`}\n`).join('');

interface Ctx { f: RepoFixture; scratch: string; blob(b: string | Buffer): Promise<Oid>; }

async function withRepo(label: string, files: Record<string, Buffer>, fn: (c: Ctx) => Promise<void>): Promise<void> {
  const f = await makeRepoFixture(label, { files });
  try {
    await fn({
      f, scratch: join(f.root, 'scratch'),
      blob: (b) => f.repo.hashBytes(typeof b === 'string' ? Buffer.from(b, 'utf8') : b, true),
    });
  } finally {
    await f.cleanup();
  }
}

const entry = (oid: Oid): Entry => ({ mode: '100644', oid });

test('testMask applies 05 §3.4 item 2 steps 1–6 in order on a 9-path fixture', T10, async () => {
  const CI = '.github/workflows/ci.yml';
  const IGN = '.gitignore';
  const SKIP = 'cfg/skip.txt';
  const LO = 'lo.txt';
  const BOM = 'bom.txt';
  const PIN = 'pin.txt';
  const CONF = 'conf.txt';
  const REV = 'rev.txt';
  const BIN = 'bin.dat';
  const seed: Record<string, Buffer> = {
    '.cowork/config.json': Buffer.from('{"sync":{"exclude":["cfg/skip.txt"]}}\n', 'utf8'),
    'README.md': Buffer.from('fixture\n', 'utf8'),
  };
  await withRepo('oracles-testmask', seed, async (c) => {
    const head = (await c.f.repo.resolve('HEAD'))!;
    // A: every path at its base; X: every path changed locally (rev.txt: the held row 5 and an own row 15).
    const A = new Map<string, Entry>();
    const X = new Map<string, Entry>();
    for (const p of [CI, IGN, SKIP, LO, BOM, PIN, CONF]) {
      A.set(p, entry(await c.blob(rowsText(6))));
      X.set(p, entry(await c.blob(rowsText(6, { 3: `${p} local` }))));
    }
    const aRev = await c.blob(rowsText(20));
    const heldRev = await c.blob(rowsText(20, { 5: 'held revert of the teammate row' }));
    A.set(REV, entry(aRev));
    X.set(REV, entry(await c.blob(rowsText(20, { 5: 'held revert of the teammate row', 15: 'own untainted row' }))));
    A.set(BIN, entry(await c.blob(binary(0))));
    X.set(BIN, entry(await c.blob(binary(1))));
    const at = (p: string): Oid => A.get(p)!.oid;
    const on = (p: string): Oid => X.get(p)!.oid;
    const records: HoldRecord[] = [
      record(pair(at(LO), on(LO), LO), { id: ulidOf(1), paths: [LO], guards: ['revert'], local_only: true }),
      record(pair(at(BOM), on(BOM), BOM), { id: ulidOf(2), paths: [BOM], guards: ['eol-bom'] }),
      record(pair(at(PIN), on(PIN), PIN), { id: ulidOf(3), paths: [PIN], kind: 'PIN', guards: ['join'] }),
      record({ s1: { [CONF]: at(CONF) }, s2: { [CONF]: on(CONF) }, s3: { [CONF]: ABSENT } }, { id: ulidOf(4), paths: [CONF], state: 'CONFLICTED', guards: ['conflict'] }),
      record(pair(aRev, heldRev, REV), { id: ulidOf(5), paths: [REV], guards: ['revert'] }),
      // OFF_DISK: a parked PATCH holding another row, and a marker companion (guard-less, local_only) — neither changes anything (R3-21)
      record(pair(aRev, await c.blob(rowsText(20, { 10: 'parked row' })), REV), { id: ulidOf(6), paths: [REV], residence: 'OFF_DISK', state: 'PARKED', guards: ['revert'] }),
      record(pair(aRev, await c.blob(rowsText(20, { 12: 'companion row' })), REV), { id: ulidOf(7), paths: [REV], residence: 'OFF_DISK', state: 'PARKED', guards: [], local_only: true }),
      record(pair(at(BIN), on(BIN), BIN), { id: ulidOf(8), paths: [BIN], guards: ['revert'] }),
    ];
    const scope = await simScope(c.f.runner, c.f.paths.workTree, head, records);
    assert.deepEqual([CI, IGN, SKIP, LO, REV].map((p) => scope(p, '100644', 0)), ['QUARANTINED', 'SAVE_ONLY', 'UNMANAGED', 'LOCAL_ONLY', 'LIVE'], 'the fixture\'s scope classes');
    const out = await testMask(c.f.runner, c.scratch, c.f.paths.workTree, X, A, records, scope, (p) => p === BIN);
    assert.equal(out.entries.size, 9, 'one entry per path of the 9-path fixture');
    for (const p of [CI, IGN, SKIP, LO, BOM, PIN, CONF, BIN]) assert.deepEqual(out.entries.get(p), A.get(p), `${p} takes A[p]`);
    assert.equal(out.entries.get(REV)?.oid, await c.blob(rowsText(20, { 15: 'own untainted row' })), 'rev.txt: only the held row is reverse-merged, the OFF_DISK records change nothing');
    assert.deepEqual([...out.withheld].sort(), [CI, IGN, SKIP, LO, BOM, PIN, CONF, BIN].sort());
    assert.deepEqual([...out.partial], [REV]);
    assert.deepEqual(out.conflicted, []);
    // Without its step-5 record rev.txt keeps X (step 6), and with the OFF_DISK records alone it keeps X too.
    const offOnly = records.filter((r) => r.residence === 'OFF_DISK');
    const plain = await testMask(c.f.runner, c.scratch, c.f.paths.workTree, new Map([[REV, X.get(REV)!]]), new Map([[REV, A.get(REV)!]]), offOnly, scope, () => false);
    assert.deepEqual(plain.entries.get(REV), X.get(REV), 'step 6: OFF_DISK records mask nothing');
    assert.deepEqual([...plain.partial, ...plain.withheld], []);
  });
});

test('testRebase is single-step from the original pair: two A moves give the same H1\' as one move to the final A; rc ≠ 0 marks the record conflicted and its path takes A; two PATCHes on one path apply in ULID order', T10, async () => {
  await withRepo('oracles-testrebase', { 'README.md': Buffer.from('fixture\n', 'utf8') }, async (c) => {
    const P = 'f.txt';
    const repo = c.f.paths.workTree;
    const a0 = await c.blob(rowsText(20));
    const r = record(pair(a0, await c.blob(rowsText(20, { 10: 'held' })), P), { id: ulidOf(1), paths: [P] });
    // Two clean moves (rows 2, then 18) and one move to the final A give the same H1'.
    const a1 = await c.blob(rowsText(20, { 2: 'team 2' }));
    const a2 = await c.blob(rowsText(20, { 2: 'team 2', 18: 'team 18' }));
    const one = await testRebase(c.f.runner, c.scratch, repo, r, new Map([[P, entry(a2)]]));
    const first = await testRebase(c.f.runner, c.scratch, repo, r, new Map([[P, entry(a1)]]));
    assert.ok(one.ok && first.ok);
    assert.equal(first.h0p.get(P), a1, 'H0\' = A');
    const two = await testRebase(c.f.runner, c.scratch, repo, record(pair(a1, first.h1p.get(P)!, P), { id: ulidOf(1), paths: [P] }), new Map([[P, entry(a2)]]));
    assert.ok(two.ok);
    assert.equal(two.h1p.get(P), one.h1p.get(P), 'two moves give the one-move H1\'');
    assert.equal(one.h1p.get(P), await c.blob(rowsText(20, { 2: 'team 2', 10: 'held', 18: 'team 18' })));
    // Single-step from the ORIGINAL pair: a move through a conflicting A and back is clean (a chained rebase would have died at a1').
    const aX = await c.blob(rowsText(20, { 10: 'team 10' }));
    assert.deepEqual(await testRebase(c.f.runner, c.scratch, repo, r, new Map([[P, entry(aX)]])), { ok: false }, 'rc ≠ 0 is a conflict');
    const back = await testRebase(c.f.runner, c.scratch, repo, r, new Map([[P, entry(a0)]]));
    assert.ok(back.ok);
    assert.equal(back.h1p.get(P), (r.blobs as { h1: Record<string, Oid> }).h1[P], 'A == H0: H1\' = H1');
    // An ABSENT A runs no merge-file: the whole-path rule (R3-18) — H0 != ABSENT and H1 != ABSENT → a conflict.
    assert.deepEqual(await testRebase(c.f.runner, c.scratch, repo, r, new Map()), { ok: false });
    // In MASK: the conflicting record is reported and its path takes A whole.
    const live = (): 'LIVE' => 'LIVE';
    const xDisk = await c.blob(rowsText(20, { 10: 'held', 15: 'own' }));
    const masked = await testMask(c.f.runner, c.scratch, repo, new Map([[P, entry(xDisk)]]), new Map([[P, entry(aX)]]), [r], live, () => false);
    assert.deepEqual(masked.conflicted, [r.id]);
    assert.deepEqual(masked.entries.get(P), entry(aX));
    assert.deepEqual([...masked.withheld], [P]);
    // Two PATCHes on one path apply in ULID order: both reverse merges run (newer listed first), and when both conflict the older ULID is
    // the one reported (the chain stops at its first conflict).
    const r1 = record(pair(a0, await c.blob(rowsText(20, { 4: 'held 4' })), P), { id: ulidOf(3), paths: [P] });
    const r2 = record(pair(a0, await c.blob(rowsText(20, { 16: 'held 16' })), P), { id: ulidOf(4), paths: [P] });
    const both = await c.blob(rowsText(20, { 4: 'held 4', 10: 'own 10', 16: 'held 16' }));
    const m2 = await testMask(c.f.runner, c.scratch, repo, new Map([[P, entry(both)]]), new Map([[P, entry(a0)]]), [r2, r1], live, () => false);
    assert.equal(m2.entries.get(P)?.oid, await c.blob(rowsText(20, { 10: 'own 10' })));
    assert.deepEqual([...m2.partial], [P]);
    const clash = await c.blob(rowsText(20, { 4: 'other 4', 16: 'other 16' }));
    const m3 = await testMask(c.f.runner, c.scratch, repo, new Map([[P, entry(clash)]]), new Map([[P, entry(a0)]]), [r2, r1], live, () => false);
    assert.deepEqual(m3.conflicted, [r1.id], 'the older ULID is merged (and conflicts) first');
  });
});

// ---- Integration I-1 (rulings R3-FF2-D1, R3-FF3-D1, R3-FF4-A1): the oracles model INCOMING and INV-HLD-SINGLE as the engine does ----

test('I-1 simScope: an INCOMING record never makes a path LOCAL_ONLY (R3-21 as amended, core.ts localOnlyScope); an ON_DISK local_only PATCH still does', T10, async () => {
  await withRepo('oracles-scope-incoming', { 'README.md': Buffer.from('fixture\n', 'utf8') }, async (c) => {
    const head = (await c.f.repo.resolve('HEAD'))!;
    const a = await c.blob(rowsText(6));
    const x = await c.blob(rowsText(6, { 3: 'mine' }));
    const records: HoldRecord[] = [
      record(pair(a, x, 'in.txt'), { id: ulidOf(1), kind: 'INCOMING', paths: ['in.txt'], guards: ['lock'], local_only: true }),
      record(pair(a, x, 'qr.cfg'), { id: ulidOf(2), kind: 'INCOMING', paths: ['qr.cfg'], guards: ['local-only-conflict'], local_only: true }),
      record(pair(a, x, 'lo.txt'), { id: ulidOf(3), paths: ['lo.txt'], guards: ['secret-scan'], local_only: true }),
    ];
    const scope = await simScope(c.f.runner, c.f.paths.workTree, head, records);
    assert.deepEqual(['in.txt', 'qr.cfg', 'lo.txt'].map((p) => scope(p, '100644', 0)), ['LIVE', 'LIVE', 'LOCAL_ONLY']);
  });
});

test('I-1 parseLocal: local.json settleCopies is exposed (copy id → its parent) when present and absent when the writer left it out', T10, () => {
  const base = { companions: {}, explicit: [], rejected: {}, inflight: {}, keepSyncing: [] };
  const withCopies = parseLocal(Buffer.from(JSON.stringify({ ...base, settleCopies: { [ulidOf(9)]: ulidOf(8) } }), 'utf8'));
  assert.deepEqual(withCopies.settleCopies, { [ulidOf(9)]: ulidOf(8) });
  const without = parseLocal(Buffer.from(JSON.stringify(base), 'utf8'));
  assert.equal('settleCopies' in without, false, 'one shape with registry.ts: the empty map is left out');
});

test('I-1 O-AND clause: an INCOMING record holds nothing back (it masks at no step, R3-21 as amended), local_only or not; PINs, CONFLICTED, local_only and whole-path records are held whole; an ACTIVE guarded PATCH by rows', T10, () => {
  const b = pair(ABSENT, ABSENT, 'p.txt');
  const cell = (o: Parameters<typeof record>[1]): ReturnType<typeof andClause> => andClause(record(b, { paths: ['p.txt'], ...o }));
  assert.equal(cell({ kind: 'INCOMING', guards: ['lock'] }), null, 'INCOMING lock');
  assert.equal(cell({ kind: 'INCOMING', guards: ['collision'] }), null, 'INCOMING collision');
  assert.equal(cell({ kind: 'INCOMING', guards: ['quarantine-review'], local_only: true }), null, 'INCOMING quarantine-review (local_only)');
  assert.equal(cell({ kind: 'PIN', guards: ['join'] }), 'whole');
  assert.equal(cell({ guards: ['revert'], local_only: true }), 'whole', 'a local_only PATCH');
  assert.equal(cell({ guards: ['eol-bom'] }), 'whole', 'a whole-path guard');
  assert.equal(cell({ state: 'CONFLICTED', guards: ['conflict'] }), 'whole');
  assert.equal(cell({ guards: ['revert'] }), 'rows', 'an ACTIVE guarded PATCH');
  assert.equal(cell({ guards: [] }), null, 'guard-less');
  assert.equal(cell({ residence: 'OFF_DISK', state: 'PARKED', guards: ['revert'] }), null, 'OFF_DISK');
  assert.equal(cell({ residence: null, state: 'GONE', guards: [] }), null, 'terminal');
});

test('I-1 INV-HLD-SINGLE keys non-terminal records by H1\' at the current A (HLD-07): the D-1 pair is two changes; a settle copy is exempt against its parent; a real duplicate and a converging pair are flagged; a REBASE conflict collides with nothing', T10, async () => {
  await withRepo('oracles-single', { 'README.md': Buffer.from('fixture\n', 'utf8') }, async (c) => {
    const repo = c.f.paths.workTree;
    const F = 'f.py';
    const plain = await c.blob(rowsText(30));
    const team1 = await c.blob(rowsText(30, { 10: 'TEAM = 1' }));
    const both = await c.blob(rowsText(30, { 10: 'TEAM = 1', 20: 'TEAM2 = 2' }));
    const A = new Map([[F, entry(both)]]);
    const single = (records: readonly HoldRecord[], copies: Record<string, string> = {}): Promise<string[]> =>
      singleCollisions(c.f.runner, c.scratch, repo, records, A, copies);
    // D-1 (final review r2 D-1): r1 reverted TEAM over the old A; r2 reverts TEAM and TEAM2 over the current A. Same stored h1, other
    // bases: r1's H1' at A keeps TEAM2, r2's is h1 — two changes, both kept.
    const r1 = record(pair(team1, plain, F), { id: ulidOf(1), paths: [F] });
    const r2 = record(pair(both, plain, F), { id: ulidOf(2), paths: [F] });
    assert.deepEqual(await single([r1, r2]), [], 'the D-1 pair is two changes');
    // A3-1's settle copy (ruling R3-FF4-A1): r (ON_DISK, h0 = A) and its OFF_DISK copy share H1' = Da: exempt against each other only.
    const da = await c.blob(rowsText(30, { 10: 'TEAM = 1', 20: 'TEAM2 = 2', 25: 'mine' }));
    const r = record(pair(both, da, F), { id: ulidOf(3), paths: [F] });
    const copy = record(pair(both, da, F), { id: ulidOf(4), paths: [F], residence: 'OFF_DISK', state: 'PARKED', guards: ['revert'] });
    assert.deepEqual(await single([r, copy], { [copy.id]: r.id }), [], 'a settle copy and its parent');
    const flagged = await single([r, copy]);
    assert.equal(flagged.length, 1, 'without the settleCopies mark the same pair is one change twice');
    assert.match(flagged[0]!, new RegExp(`${r.id} and ${copy.id}`));
    // A real duplicate beside them still flags (the exemption is the copy's against its parent alone).
    const dup = record(pair(both, da, F), { id: ulidOf(5), paths: [F] });
    const withDup = await single([r, copy, dup], { [copy.id]: r.id });
    assert.ok(withDup.some((x) => x.includes(`${r.id} and ${dup.id}`)), withDup.join(' | '));
    // Converging (HLD-07: "equals, or REBASE-converges to, the current H1'"): stored pairs differ, the H1' at A is the same.
    const conv = record(pair(team1, await c.blob(rowsText(30, { 10: 'TEAM = 1', 25: 'mine' })), F), { id: ulidOf(6), paths: [F] });
    const convergent = await single([r, conv]);
    assert.equal(convergent.length, 1, 'a REBASE-converging pair is one change');
    // A REBASE conflict at A has no H1': it collides with nothing (ruling R3-FF3-D1).
    const clash = await c.blob(rowsText(30, { 20: 'other 20' }));
    const k1 = record(pair(plain, clash, F), { id: ulidOf(7), paths: [F] });
    const k2 = record(pair(plain, clash, F), { id: ulidOf(8), paths: [F] });
    assert.deepEqual(await single([k1, k2]), [], 'both REBASEs conflict at A');
    // Kind and path set still part of the key; a terminal record is never counted.
    assert.deepEqual(await single([r, record(pair(both, da, F), { id: ulidOf(9), paths: [F], kind: 'PIN', guards: ['join'] })]), []);
    assert.deepEqual(await single([r, record(pair(both, da, F), { id: ulidOf(10), paths: [F], state: 'GONE', residence: null, guards: [] })]), []);
  });
});

// ---- R3-50: one site each ------------------------------------------------------------------------------------------------

const SRC = join(fileURLToPath(new URL('../..', import.meta.url)), 'src');

/** Every *.ts file under `dir` (sorted). */
async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

/**
 * The sites that read mutant `id` under `dir`: every quoted occurrence ('Mnn' or "Mnn") outside the MutantId union's declaration line,
 * as `<file>:<line>`.
 */
async function mutantSites(dir: string, id: string): Promise<string[]> {
  const out: string[] = [];
  const quoted = new RegExp(`['"]${id}['"]`, 'g');
  for (const file of await tsFiles(dir)) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, k) => {
      if (/export type MutantId\s*=/.test(line)) return;
      for (const _ of line.matchAll(quoted)) out.push(`${relative(dir, file).split(sep).join('/')}:${k + 1}`);
    });
  }
  return out;
}

test('each of M19, M25, M28, M33, M38 and M39 is read at exactly one site in src/ (source scan for the mutant id string)', T10, async () => {
  const sites: Record<string, string[]> = {};
  for (const id of ['M19', 'M25', 'M28', 'M33', 'M38', 'M39']) sites[id] = await mutantSites(SRC, id);
  for (const [id, at] of Object.entries(sites)) assert.equal(at.length, 1, `${id} is read at exactly one site (found ${JSON.stringify(at)})`);
  // The scanner itself: a second site, a double-quoted one and the union declaration are told apart.
  const tmp = await mkdtemp(join(tmpdir(), 'cowork-mutant-scan-'));
  try {
    await mkdir(join(tmp, 'a'), { recursive: true });
    await writeFile(join(tmp, 'a', 'deps.ts'), "export type MutantId = 'M19' | 'M25';\n");
    await writeFile(join(tmp, 'a', 'one.ts'), "if (m.has('M19')) x();\n");
    await writeFile(join(tmp, 'two.ts'), 'const y = mutants.has("M19");\n// M19 in a comment is no read\n');
    assert.deepEqual(await mutantSites(tmp, 'M19'), ['a/one.ts:1', 'two.ts:1']);
    assert.deepEqual(await mutantSites(tmp, 'M25'), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
