// Region fixture corpus against real git (Plan 4 Task 2; R4-21, PF-4): the same-tail placement of git diff, the merge-tree
// misplacement of the premerge fixture, X7's 2-argument caller, S8's undecodable merge output, x2/x3 under py_compile, and the
// byte-exact storage of the form fixtures. Real git on temp roots with a space and Hangul in the path; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rows } from '../../src/data/rows.js';
import { mergeTree } from '../../src/git/merge.js';
import type { Oid } from '../../src/git/oid.js';
import type { FileMode, TreeEntry } from '../../src/git/repo.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { RC_TOUCH_R2, fixture, fixtureBytes, sweepScenario, type FixtureBytes } from '../helpers/regionFixtures.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fatal = new TextDecoder('utf-8', { fatal: true });
const strip = (b: Buffer): string[] => rows(b).map((r) => r.toString('utf8').replace(/\r?\n$/, ''));

let scratchN = 0;
async function treeOf(f: RepoFixture, files: Record<string, Buffer | null>): Promise<Oid> {
  await mkdir(join(f.paths.coworkDir, 'tmp'), { recursive: true });
  const entries = new Map<string, TreeEntry>();
  for (const [path, bytes] of Object.entries(files)) {
    if (bytes === null) continue;
    entries.set(path, { path, mode: '100644' as FileMode, oid: await f.repo.hashBytes(bytes, true) });
  }
  return f.repo.writeTreeMap(entries, join(f.paths.coworkDir, 'tmp', `region-fixtures-${process.pid}-${scratchN++}.idx`));
}

async function mergedBlob(f: RepoFixture, tree: Oid, path: string): Promise<Buffer> {
  const map = await f.repo.readTreeMap(tree);
  const e = map.get(path);
  assert.ok(e !== undefined, `${path} in the merged tree`);
  return f.repo.readBlob(e.oid);
}

test('the region fixtures are stored byte-exact: check-attr text is unset (PF-4)', async () => {
  const r = await testRunner().run(['check-attr', 'text', '--', 'test/fixtures/regions/forms/sample.bom.crlf.py'], { class: 'local', cwd: REPO });
  assert.equal(r.code, 0, r.stderr.toString('utf8'));
  assert.equal(r.stdout.toString('utf8'), 'test/fixtures/regions/forms/sample.bom.crlf.py: text: unset\n');
});

// Spec VERIFIED values re-pinned by the controller (R4-21, fix round 1) to what git 2.55 measures: each test fails, never skips, when git
// prints anything else, and reports the measured value through t.diagnostic so every CI leg (OS, git version) leaves evidence. The
// probes and the spec-edit notes are in test/fixtures/regions/README.md ("Pinned values", "Spec-edit notes").

async function gitVersion(): Promise<string> {
  const r = await testRunner().run(['version'], { class: 'local', cwd: REPO });
  return r.stdout.toString('utf8').trim();
}

/** The `@@ -a +b @@` part of every hunk header of `git diff --no-index -U0` between two buffers, git's defaults pinned. */
async function diffHeaders(label: string, a: Buffer, b: Buffer): Promise<string[]> {
  const { root, cleanup } = await makeTempRoot(label);
  try {
    const pa = join(root, 'a.py');
    const pb = join(root, 'b.py');
    await writeFile(pa, a);
    await writeFile(pb, b);
    // myers with the indent heuristic are git's defaults, pinned so no user config leaks in.
    const r = await testRunner().run(['diff', '--no-index', '-U0', '--no-color', pa, pb], {
      class: 'local',
      cwd: root,
      config: { 'diff.algorithm': 'myers', 'diff.indentHeuristic': 'true' },
    });
    assert.equal(r.code, 1, `git diff --no-index exits 1 on a difference: ${r.stderr.toString('utf8')}`);
    return r.stdout.toString('utf8').split('\n').filter((l) => l.startsWith('@@')).map((l) => (/^@@ [^@]+ @@/.exec(l) as RegExpExecArray)[0]);
  } finally {
    await cleanup();
  }
}

test('same-tail: real git diff places the 9-row insertion after line 5341', async (t) => {
  const row = RC_TOUCH_R2.find((r) => r.name === 'py_same_tail_def_after');
  assert.ok(row !== undefined);
  const post = strip(fixture(row.post));
  const block = post.slice(5341, 5350);
  assert.equal(block[0], 'def compute_discount(items):');
  assert.ok(block.slice(1, 6).every((r) => /^ {4}\S/.test(r) || /^ {8,}\S/.test(r)), 'five indented, non-empty body rows');
  assert.deepEqual(block.slice(6), ['    return round(total, 2)', '', '']);
  const base = strip(fixture('big_lf.py'));
  assert.deepEqual(block.slice(6), base.slice(5338, 5341), 'its last three rows equal base rows 5339–5341');
  const headers = await diffHeaders('region-same-tail', fixture('big_lf.py'), fixture(row.post));
  t.diagnostic(`${await gitVersion()}: ${headers.join(' ')}`);
  // 04 §3.4 says git placed it after 5339; git 2.55 places it after 5341, where FoldMapper/1 places it (controller ruling, R4-21).
  assert.deepEqual(headers, ['@@ -5341,0 +5342,9 @@']);
});

test('same-tail variant: git diff keeps the insertion after line 5341 where FoldMapper/1 places it after line 5338', async (t) => {
  const d = JSON.parse(fixture('same_tail/git_vs_foldmapper.json').toString('utf8')) as {
    base: string; post: string; git: string[]; foldMapper1: { hunks: Array<{ aLo: number; aHi: number; bLo: number; bHi: number }> };
  };
  const headers = await diffHeaders('region-same-tail-variant', fixture(d.base), fixture(d.post));
  t.diagnostic(`${await gitVersion()}: ${headers.join(' ')}`);
  assert.deepEqual(headers, d.git, 'git: row 5320 changed, the 9 rows inserted after base row 5341');
  // The two placements are both exact and different (04 §3.4: git diff output never feeds a claim, the fold, touch or gate).
  const insertion = d.foldMapper1.hunks.find((h) => h.aHi === h.aLo - 1);
  assert.ok(insertion !== undefined && insertion.aHi === 5338, 'FoldMapper/1 (pinned in the fixture, derived in the unit test): after 5338');
});

/** Rows from a unit's first row (its decorators, when `withDecorators`) to its last row before the blank-row pair. */
function unitOf(src: readonly string[], def: string, withDecorators: boolean): string[] {
  let i = src.indexOf(def);
  assert.ok(i >= 0, def);
  while (withDecorators && i > 0 && (src[i - 1] as string).startsWith('@')) i--;
  let j = i;
  while (j + 1 < src.length && !(src[j + 1] === '' && src[j + 2] === '')) j++;
  return src.slice(i, j + 1);
}

/** The merged orders.py of base, ours and theirs (one file each) through Plan 2's mergeTree. */
async function mergePremerge(label: string, dir: string): Promise<{ rc: number; conflicted: readonly string[]; merged: string[] | null }> {
  const f = await makeRepoFixture(label);
  try {
    const [base, ours, theirs] = await Promise.all(['base', 'ours', 'theirs'].map((s) => treeOf(f, { 'orders.py': fixture(`${dir}/${s}.py`) })));
    const m = await mergeTree(f.repo, base as Oid, ours as Oid, theirs as Oid);
    return { rc: m.rc, conflicted: m.conflicted, merged: m.rc === 0 ? strip(await mergedBlob(f, m.tree, 'orders.py')) : null };
  } finally {
    await f.cleanup();
  }
}

test('premerge: git 2.55 merge-tree merges the same-tail append geometry cleanly and compute_tax equals theirs', async (t) => {
  const side = (s: string): string[] => strip(fixture(`premerge/${s}.py`));
  const [base, ours, theirs] = [side('base'), side('ours'), side('theirs')];
  const m = await mergePremerge('region-premerge', 'premerge');
  t.diagnostic(`${await gitVersion()}: merge-tree rc ${m.rc}, conflicted [${m.conflicted.join(', ')}]`);
  assert.equal(m.rc, 0, 'merge-tree exits 0');
  assert.deepEqual(m.conflicted, []);
  // Each side adds one row (the unit test pins where); the intended result applies both where their authors put them.
  const added = (s: string[]): number => s.findIndex((r, i) => r !== base[i]);
  const [o, th] = [added(ours), added(theirs)];
  assert.ok(o >= 0 && th > o);
  assert.deepEqual([ours.length, theirs.length], [base.length + 1, base.length + 1]);
  const intended = [...base.slice(0, o), ours[o] as string, ...base.slice(o, th), theirs[th] as string, ...base.slice(th)];
  assert.deepEqual(m.merged, intended, 'the merge applies both appends where their authors put them (no misplacement on this git)');
  assert.deepEqual(unitOf(m.merged!, 'def compute_tax(total, rate):', false), unitOf(theirs, 'def compute_tax(total, rate):', false), 'compute_tax equals theirs');
});

test('premerge same-head: real merge-tree exits 0 and moves the owner\'s decorator edit onto the requester\'s new function', async (t) => {
  const side = (s: string): string[] => strip(fixture(`premerge/same_head/${s}.py`));
  const [ours, theirs] = [side('ours'), side('theirs')];
  const m = await mergePremerge('region-premerge-same-head', 'premerge/same_head');
  t.diagnostic(`${await gitVersion()}: merge-tree rc ${m.rc}, conflicted [${m.conflicted.join(', ')}]`);
  assert.equal(m.rc, 0, 'merge-tree exits 0');
  assert.deepEqual(m.conflicted, []);
  const merged = m.merged!;
  const VAT = 'def compute_vat(total):';
  const TAX = 'def compute_tax(total, rate):';
  t.diagnostic(`compute_vat ${JSON.stringify(unitOf(merged, VAT, true).slice(0, 2))}, compute_tax ${JSON.stringify(unitOf(merged, TAX, true).slice(0, 2))}`);
  // The moved row: the owner's edited decorator now decorates the requester's compute_vat, and compute_tax keeps the old one.
  assert.deepEqual(unitOf(merged, VAT, true).slice(0, 2), ['@functools.lru_cache(maxsize=128)', '@traced'], 'the owner\'s decorator row sits on compute_vat');
  assert.deepEqual(unitOf(merged, TAX, true).slice(0, 2), ['@functools.lru_cache(maxsize=None)', '@traced'], 'compute_tax lost the owner\'s edit');
  assert.notDeepEqual(unitOf(merged, TAX, true), unitOf(theirs, TAX, true), 'compute_tax in the merge is not the owner\'s version (04 Review Focus 1)');
  assert.notDeepEqual(unitOf(merged, VAT, true), unitOf(ours, VAT, true), 'compute_vat in the merge is not the requester\'s version');
});

test('S8: real merge-tree exits 0 with the undecodable corruptOut', async () => {
  const s = sweepScenario('S8');
  const f = await makeRepoFixture('region-s8');
  try {
    const pick = (k: 'base' | 'ours' | 'theirs'): Record<string, Buffer | null> =>
      Object.fromEntries(Object.entries(s.files).map(([p, v]) => [p, (v[k] ?? v.base) === null ? null : fixtureBytes((v[k] ?? v.base) as FixtureBytes)]));
    const [base, ours, theirs] = await Promise.all([treeOf(f, pick('base')), treeOf(f, pick('ours')), treeOf(f, pick('theirs'))]);
    const m = await mergeTree(f.repo, base, ours, theirs);
    assert.equal(m.rc, 0);
    const path = s.hazard!.path;
    const out = await mergedBlob(f, m.tree, path);
    assert.deepEqual(out, fixtureBytes(s.corruptOut![path]!), 'the plain merge output is the corruptOut');
    assert.throws(() => fatal.decode(out));
    assert.doesNotThrow(() => fatal.decode(fixtureBytes(s.files[path]!.theirs!)));
  } finally {
    await f.cleanup();
  }
});

function x7Side(side: 'base' | 'ours' | 'theirs'): Record<string, Buffer> {
  return { 'lib.py': fixture(`interface/X7/${side}/lib.py`), 'orders.py': fixture(`interface/X7/${side}/orders.py`) };
}

function python(): string | null {
  for (const exe of ['python3', 'python']) {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && /Python 3\./.test(`${r.stdout}${r.stderr}`)) return exe;
  }
  return null;
}

test('X7, x2 and x3 reproduce their caller hazards', async () => {
  const f = await makeRepoFixture('region-x7');
  try {
    assert.match(x7Side('base')['lib.py'].toString('utf8'), /^def foo\(a, b\):$/m);
    assert.match(x7Side('ours')['lib.py'].toString('utf8'), /^def foo\(a\):$/m);
    assert.equal(strip(x7Side('theirs')['orders.py'])[13], '    total = foo(price, qty)', 'theirs adds orders.py row 14');
    assert.ok(!strip(x7Side('base')['orders.py']).includes('    total = foo(price, qty)'));
    const [base, ours, theirs] = await Promise.all((['base', 'ours', 'theirs'] as const).map((s) => treeOf(f, x7Side(s))));
    const m = await mergeTree(f.repo, base as Oid, ours as Oid, theirs as Oid);
    assert.equal(m.rc, 0, 'merge-tree exits 0');
    const orders = strip(await mergedBlob(f, m.tree, 'orders.py'));
    assert.equal(orders[13], '    total = foo(price, qty)', 'the merged orders.py row 14 is the 2-argument call');
    assert.match((await mergedBlob(f, m.tree, 'lib.py')).toString('utf8'), /^def foo\(a\):$/m, 'the merged lib.py has the 1-argument foo');
  } finally {
    await f.cleanup();
  }
  // x2 (compute_price gains a required currency; E1 and E2 landed, E3 not) and x3 (from m import n after n is removed): the
  // half-done trees pass py_compile although they fail at run time.
  const x2 = ['pricing.py', 'orders.py', 'reports.py'];
  const x2Half: Record<string, Buffer> = {
    'pricing.py': fixture('interface/x2/E1/pricing.py'),
    'orders.py': fixture('interface/x2/E2/orders.py'),
    'reports.py': fixture('interface/x2/base/reports.py'),
  };
  assert.match(x2Half['pricing.py']!.toString('utf8'), /^def compute_price\(amount, currency\):$/m);
  assert.match(fixture('interface/x2/base/pricing.py').toString('utf8'), /^def compute_price\(amount\):$/m);
  assert.match(x2Half['reports.py']!.toString('utf8'), /compute_price\([^,()]+\)/, 'reports.py still calls the 1-argument form');
  assert.match(x2Half['reports.py']!.toString('utf8'), /\blegacy_total\(/, 'and calls the removed legacy_total');
  assert.doesNotMatch(x2Half['pricing.py']!.toString('utf8'), /def legacy_total\(/);
  assert.match(fixture('interface/x2/E3/reports.py').toString('utf8'), /compute_price\([^()]+, [^()]+\)/);
  const x3: Record<string, Buffer> = { 'm.py': fixture('interface/x3/ours/m.py'), 'app.py': fixture('interface/x3/base/app.py') };
  assert.match(x3['app.py']!.toString('utf8'), /^from m import n$/m);
  assert.match(fixture('interface/x3/base/m.py').toString('utf8'), /^def n\(/m);
  assert.doesNotMatch(x3['m.py']!.toString('utf8'), /^def n\(/m);
  const py = python();
  if (py === null) {
    process.stdout.write('# SKIP py_compile half of "X7, x2 and x3": no Python 3 on PATH\n');
    return;
  }
  const { root, cleanup } = await makeTempRoot('region-pycompile');
  try {
    for (const [dir, files] of [['x2', x2Half], ['x3', x3]] as const) {
      await mkdir(join(root, dir), { recursive: true });
      for (const [p, b] of Object.entries(files)) await writeFile(join(root, dir, p), b);
      for (const p of Object.keys(files)) {
        const r: SpawnSyncReturns<string> = spawnSync(py, ['-m', 'py_compile', join(root, dir, p)], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: join(root, 'pycache') } });
        assert.equal(r.status, 0, `${dir}/${p} passes py_compile: ${r.stderr}`);
      }
    }
    assert.deepEqual(Object.keys(x2Half).sort(), [...x2].sort());
  } finally {
    await cleanup();
  }
});
