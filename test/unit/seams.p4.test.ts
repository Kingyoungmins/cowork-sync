// The Task 5 seams (R4-02, X-110, R4-67, R4-17): every src directory imports only the directories before it in
// X-110's one order; holds stay claim-free (no src/claims import; only mask.ts → regions/mapper at run time and
// ports.ts' type-only editCheck import), with L-CLAIMFREE-HOLDS and L-ONE-MAPPER passing on the tree and failing on planted
// imports; mask.ts takes its rows from hunks() and nothing else; the widened Plan 3 ports (A-01…A-03, A-12), the forward type
// declarations and the trace variants are additive; every EngineDeps construction site carries regions beside plan3Ports();
// Plan 4 creates no last_check store. The type-level halves are checked by tsc (npm run typecheck covers test/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConflictCtx } from '../../src/data/conflict.js';
import type { EditCheckEntry, EditCheckReason } from '../../src/regions/editCheck.js';
import type { ClaimLabel } from '../../src/board/ops.js';
import type { ClaimGrant } from '../../src/board/fold.js';
import type { HunkAttributionPort } from '../../src/claims/attribution.js';
import type { BreachPort } from '../../src/claims/breach.js';
import type { PlacementInput } from '../../src/claims/placement.js';
import type { RevertPrediction } from '../../src/claims/revertPredict.js';
import type { EngineCore } from '../../src/engine/core.js';
import type { GitRepo } from '../../src/git/repo.js';
import type { Oid } from '../../src/git/oid.js';
import {
  grammarlessEditCheck, noSymbols, openGate, passT0Regions,
  type EditCheckPort, type EditCheckVerdict, type PublishGatePort, type SymbolPort, type T0Finding, type T0RegionsPort, type T0Verdict,
} from '../../src/holds/ports.js';
import { LastCheckStore } from '../../src/holds/lastCheck.js';
import type { HoldRecord } from '../../src/holds/record.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { lintSource } from '../../tools/lint/rules.js';
import { TraceRecorder } from '../sim/traceRecorder.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** X-110's one cross-plan order (contract line 480): src/daemon and src/entry may import everything; src/version.ts
 *  (a src root file, in no directory) is a leaf every directory may import. */
const ORDER = ['ports', 'text', 'i18n', 'git', 'sec', 'data', 'regions', 'board', 'since', 'holds', 'claims', 'engine', 'claude', 'coord', 'lifecycle', 'cli'];
const rank = (dir: string): number => {
  const r = ORDER.indexOf(dir);
  if (r !== -1) return r;
  // The leaf consumers every ordered directory may sit under: the daemon and entry loaders, Plan 2's viewer and
  // src/cli's one view import of it (the cli renders through src/viz/cli/view.ts's outputMode, a Plan 2 fact).
  return dir === 'daemon' || dir === 'entry' || dir === 'viz' ? ORDER.length : -1;   // src root files (version.ts) sit before everything.
};
/** The real source directories under src/, in ORDER's order (then name). */
const ALL_DIRS = readdirSync(join(ROOT, 'src'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

const specifiersOf = (text: string): Array<{ spec: string; typeOnly: boolean; file: string }> => {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
  const out: Array<{ spec: string; typeOnly: boolean; file: string }> = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ spec: n.moduleSpecifier.text, typeOnly: ts.isImportDeclaration(n) && n.importClause?.isTypeOnly === true, file: 'x.ts' });
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (a !== undefined && ts.isStringLiteralLike(a)) out.push({ spec: a.text, typeOnly: false, file: 'x.ts' });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
};

const relativeDir = (file: string, spec: string): string | null => {
  if (!spec.startsWith('.')) return null;
  const dir = join(ROOT, file, '..');
  const target = join(dir, spec).replace(/\.js$/u, '');
  const m = target.match(/[/\\]src[/\\]([a-zA-Z]+)(?:[/\\]|$)/u);
  return m === null ? null : m[1]!;
};

const eachSource = (visit: (file: string, text: string) => void, dirs = ALL_DIRS): void => {
  for (const d of dirs) {
    const base = join(ROOT, 'src', d);
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) visit(p.slice(ROOT.length).replace(/\\/gu, '/'), readFileSync(p, 'utf8'));
      }
    };
    walk(base);
  }
};

test('each source directory imports only the directories before it', T10, () => {
  const violations: string[] = [];
  eachSource((file, text) => {
    const m = file.match(/src\/([a-zA-Z]+)\//u);
    if (m === null) return;   // src/version.ts and any src root file sit in no directory.
    const from = m[1]!;
    const fromRank = rank(from);
    for (const { spec, typeOnly } of specifiersOf(text)) {
      const to = relativeDir(file, spec);
      if (to === null) continue;
      if (to === from) continue;
      // The two X-110 holes: mask.ts's run-time mapper import and ports.ts's type-only editCheck import. The order
      // check is the run-time graph (type-only imports are erased at build); the REG-02 boundary counts every edge.
      if (typeOnly) continue;
      if (from === 'holds' && to === 'regions' && file.endsWith('src/holds/mask.ts')) continue;
      // src/cli renders through src/viz/cli/view.ts's outputMode (the one cli→viz edge, pre-existing Plan 2 wiring).
      if (from === 'cli' && to === 'viz') continue;
      if (rank(to) > fromRank) violations.push(`${file} -> ${spec}`);
      if (from === 'regions' && !['ports', 'git', 'sec', 'data'].includes(to) && rank(to) > rank('regions')) {
        violations.push(`${file} -> ${spec} (REG-02's stricter boundary)`);
      }
    }
  });
  // src/data/conflict.ts imports nothing from src/regions (R4-02, R1-058).
  assert.doesNotMatch(readFileSync(join(ROOT, 'src', 'data', 'conflict.ts'), 'utf8'), /from '\.\.\/regions\//u, 'src/data/conflict.ts imports no src/regions module');
  assert.deepEqual(violations, []);
});

test('holds stay claim-free', T10, () => {
  // No src/holds module imports src/claims.
  eachSource((file, text) => {
    if (!file.includes('src/holds/')) return;
    for (const { spec } of specifiersOf(text)) assert.doesNotMatch(spec, /claims/u, `${file}: ${spec}`);
  }, ['holds']);
  // mask.ts is the only run-time src/regions import, and only mapper.ts; ports.ts's is type-only.
  const mappers: string[] = [];
  const typeOnlyEditCheck: string[] = [];
  eachSource((file, text) => {
    if (!file.includes('src/holds/')) return;
    for (const { spec, typeOnly } of specifiersOf(text)) {
      const to = relativeDir(file, spec);
      if (to !== 'regions') continue;
      if (typeOnly) typeOnlyEditCheck.push(`${file} -> ${spec}`);
      else mappers.push(`${file} -> ${spec}`);
    }
  }, ['holds']);
  assert.deepEqual(mappers, ['src/holds/mask.ts -> ../regions/mapper.js']);
  assert.deepEqual(typeOnlyEditCheck, ['src/holds/ports.ts -> ../regions/editCheck.js']);
  // Plan 3's structural test passes with the Plan 4 additions to its forbidden set (R4-67): no claim module, no
  // src/regions/{touch,contained,groupName,partial} import in the claim-free modules.
  const CLAIMFREE = [
    'src/holds/revert.ts', 'src/holds/mask.ts', 'src/holds/rebase.ts', 'src/holds/evaluate.ts', 'src/holds/provenance.ts',
    'src/engine/holdOps.ts', 'src/engine/detect.ts',
  ];
  const FORBIDDEN = /claims|regions\/touch|regions\/contained|regions\/groupName|regions\/partial/u;
  for (const f of CLAIMFREE) {
    for (const { spec } of specifiersOf(readFileSync(join(ROOT, ...f.split('/')), 'utf8'))) {
      assert.doesNotMatch(spec, FORBIDDEN, `${f}: ${spec}`);
    }
  }
  // L-CLAIMFREE-HOLDS passes on the tree (every src/holds module) and fails on a planted claim-store import (R4-67, B3-08).
  const onTree: string[] = [];
  eachSource((file, text) => {
    for (const f of lintSource(file, text)) if (f.rule === 'L-CLAIMFREE-HOLDS') onTree.push(`${f.file}:${f.line} ${f.message}`);
  }, ['holds']);
  assert.deepEqual(onTree, [], 'L-CLAIMFREE-HOLDS passes on src/holds');
  const registry = readFileSync(join(ROOT, 'src', 'holds', 'registry.ts'), 'utf8');
  const planted = `import type { ClaimStore } from '../claims/store.js';\n${registry}`;
  assert.deepEqual(lintSource('src/holds/registry.ts', planted).filter((f) => f.rule === 'L-CLAIMFREE-HOLDS').map((f) => f.line), [1], 'a planted ClaimStore import in registry.ts is L-CLAIMFREE-HOLDS');
});

test('mask.ts takes its rows from hunks() and nothing else', T10, () => {
  const text = readFileSync(join(ROOT, 'src', 'holds', 'mask.ts'), 'utf8');
  const specs = specifiersOf(text).map((s) => s.spec);
  assert.equal(specs.includes('../regions/mapper.js'), true, 'mask.ts imports the mapper');
  assert.equal(specs.includes('../data/linediff.js'), false, 'mask.ts no longer imports linediff');
  assert.match(text, /import \{ hunks \} from '\.\.\/regions\/mapper\.js'/u, 'the one row source');
  assert.doesNotMatch(text, /matchedRows/u, 'no matchedRows anywhere in mask.ts');
  // R4-83: the L-ONE-MAPPER clause for src/holds/mask.ts passes on the tree and fires on a planted matchedRows import there.
  assert.deepEqual(lintSource('src/holds/mask.ts', text).filter((f) => f.rule === 'L-ONE-MAPPER'), [], 'L-ONE-MAPPER passes on mask.ts');
  const planted = `import { matchedRows } from '../data/linediff.js';\n${text}`;
  assert.deepEqual(lintSource('src/holds/mask.ts', planted).filter((f) => f.rule === 'L-ONE-MAPPER').map((f) => f.line), [1], 'a planted matchedRows import in mask.ts is L-ONE-MAPPER');
  // Plan 3's other holds modules are no region consumers: the clause is mask.ts's alone.
  assert.deepEqual(lintSource('src/holds/rebase.ts', "import { matchedRows } from '../data/linediff.js';\n").filter((f) => f.rule === 'L-ONE-MAPPER'), []);
});

// ---- Widened Plan 3 ports (types only; A-01…A-03, A-12) ----

/** Plan 3 Task 10's declared elements (X-07, X-08), restated: Plan 4's narrowed elements must stay assignable to them. */
type Plan3EditCheckEntry = { check?: 1 | 2 | 3 | 4; path: string; line?: number; reason: string };
type Plan3EditCheckVerdict = { verdict: 'pass' }
  | { verdict: 'fail'; failed: ReadonlyArray<1 | 2 | 3 | 4>; entries?: readonly Plan3EditCheckEntry[] }
  | { verdict: 'incomplete'; entries?: readonly Plan3EditCheckEntry[] };
type Plan3T0Finding = { check: 1 | 2 | 3 | 4; path: string; line?: number };

/** R4-42's 14 reasons, exhaustively: a 15th value fails the `never` arm, a removed one fails its case label (tsc). */
function reasonCheck(r: EditCheckReason): 1 | 2 | 3 | 4 | null {
  switch (r) {
    case 'new_error_node': case 'undecodable': case 'conflict_markers': return 1;
    case 'incompatible_caller': case 'orphan_call': return 2;
    case 'unresolved_import': case 'removed_name_called': return 3;
    case 'label_count': case 'shrink': case 'emptied': case 'deleted': return 4;
    case 'no_snapshot': case 'merge_conflict': case 'no_merge': return null;
    default: {
      const unreachable: never = r;
      return unreachable;
    }
  }
}
const REASONS: Readonly<Record<EditCheckReason, true>> = {
  new_error_node: true, undecodable: true, conflict_markers: true, incompatible_caller: true, orphan_call: true, unresolved_import: true,
  removed_name_called: true, label_count: true, shrink: true, emptied: true, deleted: true, no_snapshot: true, merge_conflict: true, no_merge: true,
};

test('EditCheckPort widens additively and narrows Plan 3\u2019s entries element', T10, () => {
  const port: EditCheckPort = grammarlessEditCheck;
  // Both call forms compile: Plan 3's five arguments and R4-39's trailing opts.
  const calls = (repo: GitRepo, a: Oid, r: Oid, tip: Oid, paths: readonly string[]): Array<Promise<EditCheckVerdict>> => [
    port.check(repo, a, r, tip, paths),
    port.check(repo, a, r, tip, paths, { csId: 'p/1', mode: 'predict' }),
  ];
  void calls;
  const entry: EditCheckEntry = { check: 1, path: 'a.py', reason: 'new_error_node', line: 3 };
  const asPlan3: Plan3EditCheckEntry = entry;   // X-08: the narrowed element stays assignable to Plan 3's
  const v1: EditCheckVerdict = { verdict: 'fail', failed: [1, 4], entries: [entry, { check: 4, path: 'a.py', reason: 'label_count' }] };
  const v2: EditCheckVerdict = { verdict: 'fail', failed: [1] };
  const v3: EditCheckVerdict = { verdict: 'incomplete', entries: [{ path: 'a.py', reason: 'no_snapshot' }] };
  const plan3: Plan3EditCheckVerdict[] = [v1, v2, v3, { verdict: 'pass' }];
  assert.equal(plan3.length, 4);
  assert.equal(asPlan3.reason, 'new_error_node');
  // Exactly the 14 values of R4-42, in their check groups.
  const all = Object.keys(REASONS) as EditCheckReason[];
  assert.equal(all.length, 14);
  assert.deepEqual(all.map((r) => reasonCheck(r)), [1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4, null, null, null]);
});

test('T0RegionsPort widens additively and narrows Plan 3\u2019s findings element', T10, () => {
  const port: T0RegionsPort = passT0Regions;
  const calls = (repo: GitRepo, tip: Oid, out: Oid, a: Oid, p: Oid): Array<Promise<T0Verdict>> => [
    port.check(repo, tip, out, ['b.py']),
    port.check(repo, tip, out, ['b.py'], { a, p, csIds: ['p/1'] }),
  ];
  void calls;
  const finding: T0Finding = { check: 2, path: 'b.py', line: 14, reason: 'incompatible_caller', symbol: { qualname: 'foo', simple: 'foo' } };
  const asPlan3: Plan3T0Finding = finding;   // X-07
  const v: T0Verdict = { pass: false, paths: ['b.py'], item: 2, findings: [finding] };
  // Plan 3's T0 drop reads findings[0] unchanged.
  const first = 'findings' in v ? v.findings?.[0] : undefined;
  assert.equal(first?.check, 2);
  assert.equal(asPlan3.path, 'b.py');
});

test('PublishGatePort widens additively', T10, async () => {
  const port: PublishGatePort = openGate;
  type GateAnswer = Awaited<ReturnType<PublishGatePort['gate']>>;
  const P1 = '0123456789abcdef0123456789abcdef';
  const blocked: GateAnswer = {
    block: {
      claimId: 'abcdefghij234567', claimIds: ['abcdefghij234567', 'bbbbbbbbbbbbbbbb'],
      detail: { blocked: [{ csId: 'p/1', claimId: 'abcdefghij234567', holder: { peer: P1, seat: 'human' }, path: 'a.py', reason: 'base-overlap' }], admitted: [] },
    },
  };
  // Plan 3's B1 slot reads only block.claimId: the Plan 3 form (no claimIds, no detail) is still an answer.
  const plan3Form: GateAnswer = { block: { claimId: 'abcdefghij234567' } };
  assert.equal('block' in blocked && blocked.block !== null ? blocked.block.claimId : null, 'abcdefghij234567');
  assert.ok(plan3Form);
  // claimStillBlocks keeps its signature (r: HoldRecord) => Promise<boolean>.
  const still: (r: HoldRecord) => Promise<boolean> = port.claimStillBlocks;
  assert.equal(await still({} as HoldRecord), true);
});

test('SymbolPort gains an optional shadowDependency', T10, () => {
  const plan3: SymbolPort = noSymbols;
  assert.equal(plan3.shadowDependency, undefined, 'noSymbols binds no shadowDependency');
  const withShadow: SymbolPort = {
    referencesHeldOnly: async () => false,
    shadowDependency: async (repo: GitRepo, shadow: HoldRecord, csA, csR) => {
      void repo; void shadow; void csA; void csR;
      return false;
    },
  };
  assert.equal(typeof withShadow.shadowDependency, 'function');
  // No module under src/ calls shadowDependency yet (Plan 5 wires it, R4-50): only its declaration names it.
  const callers: string[] = [];
  eachSource((file, text) => {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        const name = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : null;
        if (name === 'shadowDependency') callers.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  });
  assert.deepEqual(callers, [], 'no src module calls shadowDependency before Plan 5');
});

test('the forward type declarations change no behaviour', T10, async () => {
  // A ConflictCtx without the four hooks still type-checks (Plan 2's form); Task 9 makes conflict() call them.
  const plain: ConflictCtx = {
    repo: {} as GitRepo, isText: () => true, insertionMerge: () => false, concatAllowed: false, localOnly: () => false, ref: async () => null, write: false,
  };
  assert.equal(plain.hasGrammar, undefined);
  assert.equal(plain.tieBreak, undefined);
  // The forward types are importable (the type imports at the top of this file) and their modules export no runtime value yet.
  const label: ClaimLabel = { kind: 'function', qualname: 'f', simple: 'f', type: '', disc: '' };
  const grant: ClaimGrant = { req_id: 'r', grantee: { peer: 'p', epoch: 'e', seat: 'human' }, cs_id: 'p/1', since_height: 1 };
  const types: [ClaimLabel, ClaimGrant, PlacementInput?, RevertPrediction?, HunkAttributionPort?, BreachPort?, EditCheckReason?, EditCheckEntry?] = [label, grant];
  assert.equal(types.length, 2);
  const forwardOnly = ['../../src/claims/attribution.js', '../../src/claims/breach.js', '../../src/claims/placement.js', '../../src/claims/revertPredict.js', '../../src/regions/editCheck.js'];
  for (const m of forwardOnly) assert.deepEqual(Object.keys(await import(m) as object), [], `${m} exports no runtime value`);
});

test('the edit_check trace may carry checks', T10, () => {
  const withChecks: TraceEvent = { kind: 'edit_check', peer: 'p', cs: 'p/1', verdict: 'fail', checks: [1, 3] };
  const plan3Form: TraceEvent = { kind: 'edit_check', peer: 'p', cs: 'p/1', verdict: 'incomplete' };
  const t = new TraceRecorder();
  t.emit(withChecks);
  t.emit(plan3Form);
  assert.deepEqual(t.ofKind('edit_check').map((e) => e.checks ?? null), [[1, 3], null]);
});

/** Every key name inside a value (nested objects and arrays), with the path to it. */
function keysDeep(v: unknown, at = ''): Array<{ key: string; at: string }> {
  if (Array.isArray(v)) return v.flatMap((x) => keysDeep(x, `${at}[]`));
  if (v === null || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, x]) => [{ key: k, at: `${at}.${k}` }, ...keysDeep(x, `${at}.${k}`)]);
}
type ClaimAction = Extract<TraceEvent, { kind: 'claim' }>['action'];
const CLAIM_ACTIONS: Readonly<Record<ClaimAction, true>> = {
  draft: true, emit: true, reanchor: true, drift: true, tombstone: true, local_only: true, precheck_drop: true, precheck_block: true, rejected: true, discard: true,
};

test('the Plan 4 trace variants carry no duration, wall time, label, offset or edit-check text', T10, () => {
  const t = new TraceRecorder();
  // One event of each variant with every declared member set (object literals carry exactly the declared keys).
  t.emit({ kind: 'gate', peer: 'p', tip: 't', csIds: ['p/1'], blocked: [{ cs: 'p/1', claim: 'abcdefghij234567', holder: 'p/human', path: 'a.py', reason: 'base-overlap' }], admitted: [{ cs: 'p/2', claim: 'bbbbbbbbbbbbbbbb', path: 'b.py' }] });
  for (const action of Object.keys(CLAIM_ACTIONS) as ClaimAction[]) {
    t.emit({ kind: 'claim', peer: 'p', action, claim: 'abcdefghij234567', cs: 'p/1', path: 'a.py', anchor: null, ranges: [[1, 2]] });
  }
  t.emit({ kind: 'placement', peer: 'p', use: 'publish', path: 'a.py', sub: 'a' });
  t.emit({ kind: 'breach', peer: 'p', claim: 'abcdefghij234567', holder: 'p/human', commit: 'c', path: 'a.py', baseMove: false });
  assert.equal(t.ofKind('gate').length, 1);
  assert.deepEqual(t.ofKind('claim').map((e) => e.action), Object.keys(CLAIM_ACTIONS));
  assert.equal(t.ofKind('placement').length, 1);
  assert.equal(t.ofKind('breach').length, 1);
  const FORBIDDEN = new Set(['durationMs', 'wallMs', 'label', 'line', 'offset', 'startIndex', 'reason']);
  const bad = [...t.ofKind('gate'), ...t.ofKind('claim'), ...t.ofKind('placement'), ...t.ofKind('breach')]
    .flatMap((e) => keysDeep(e, e.kind))
    .filter((k) => FORBIDDEN.has(k.key) && k.at !== 'gate.blocked[].reason');
  assert.deepEqual(bad, [], 'no forbidden key but gate.blocked[].reason (a TouchReason or claim_overlap)');
});

// ---- Construction sites and the last_check store (B3-05, X-05, X-06) ----

/** Every .ts file under the repository's src/, test/ and tools/ (node_modules excluded), as repository paths with '/'. */
function repoSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push({ file: p.slice(ROOT.length).replace(/\\/gu, '/'), text: readFileSync(p, 'utf8') });
    }
  };
  for (const d of ['src', 'test', 'tools']) walk(join(ROOT, d));
  return out;
}

test('every EngineDeps construction site carries regions and still spreads plan3Ports()', T10, () => {
  // A construction site = an object literal naming ports, paths and regionSpec (the EngineDeps members no other shape has together).
  const sites: Array<{ at: string; regions: boolean; plan3: boolean }> = [];
  for (const { file, text } of repoSources()) {
    if (!text.includes('regionSpec')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n)) {
        const names = new Set(n.properties.map((x) => (x.name !== undefined && (ts.isIdentifier(x.name) || ts.isStringLiteral(x.name)) ? x.name.text : '')));
        if (names.has('ports') && names.has('paths') && names.has('regionSpec')) {
          const spreads = n.properties.filter(ts.isSpreadAssignment).map((x) => x.expression.getText(sf));
          sites.push({ at: `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`, regions: names.has('regions'), plan3: spreads.includes('plan3Ports()') });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const files = [...new Set(sites.map((s) => s.at.replace(/:\d+$/u, '')))].sort();
  // The plan's five sites, as built today: engineFixture.ts builds no literal (it reuses makeCores' deps, below); the sixth is
  // durability.reclone.test.ts's fresh-clone peer (reported, task-5-report.md).
  assert.deepEqual(files, ['src/daemon/run.ts', 'test/helpers/coreFixture.ts', 'test/integration/durability.reclone.test.ts', 'test/sim/engineAdapter.ts', 'tools/real/two-clone.ts']);
  assert.deepEqual(sites.filter((s) => !s.regions || !s.plan3), [], 'every site sets regions and spreads plan3Ports()');
  // engineFixture.ts re-binds plan3Ports() over makeCores' deps (regions already set there) before each Engine.create.
  assert.match(readFileSync(join(ROOT, 'test', 'helpers', 'engineFixture.ts'), 'utf8'), /Object\.assign\(p\.deps, plan3Ports\(\), portsFor\(ports, p\.deps, i\)\)/u);
});

test('Plan 4 creates no last_check store', T10, () => {
  // src/holds/lastCheck.ts is Plan 3's (X-05): its LastCheckStore with the eight members ChangeSets.lastCheck exposes.
  for (const m of ['record', 'get', 'pass', 'clearCs', 'noteCandidate', 'recordFor', 'passedFor', 'sharedFor']) {
    assert.equal(typeof (LastCheckStore.prototype as unknown as Record<string, unknown>)[m], 'function', `LastCheckStore.${m}`);
  }
  // EngineCore has no lastCheck member (type level; R4-75 withdrawn).
  const noMember: 'lastCheck' extends keyof EngineCore ? false : true = true;
  assert.equal(noMember, true);
  // No Plan 4 module writes ChangeSets.lastCheck: none under src/regions, src/claims or Plan 4's src/engine files calls its writers,
  // and none of them declares a last_check store file of its own.
  const PLAN4_ENGINE = ['claimHost', 'claimsStep', 'emitStep', 'labelStep', 'mergeChecks', 'regionCodes', 'regionDeps'].map((n) => `src/engine/${n}.ts`);
  const WRITERS = /\blastCheck\s*\.\s*(record|recordFor|pass|passedFor|sharedFor|noteCandidate|clearCs)\s*\(/u;
  const hits: string[] = [];
  for (const { file, text } of repoSources()) {
    const plan4 = file.startsWith('src/regions/') || file.startsWith('src/claims/') || PLAN4_ENGINE.includes(file);
    if (!plan4) continue;
    if (WRITERS.test(text)) hits.push(file);
    if (/lastCheck/iu.test(file.split('/').pop() ?? '')) hits.push(`${file} (a last_check store file)`);
  }
  assert.deepEqual(hits, []);
});

