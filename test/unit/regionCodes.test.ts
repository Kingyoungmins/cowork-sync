// The region codes (R4-54, 04 §3.19, 02 §2.1): raiseRegionCode writes core.holdCode (Plan 3's status input, R3-61)
// and one log line — REGION_BUDGET deduplicated per path per 30 min Δmono (04 §2 / §3.19: per path, not per budget kind;
// never reopened by a wall jump),
// CLAIM_REJECTED once per (claim_id, reason) forever, every other code every time; REGION_BLOCK_ONLY at info, the
// rest at warn; the code names collide with no other plan's registry and their params stay SEC-38-clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { raiseRegionCode } from '../../src/engine/regionCodes.js';
import type { EngineCore } from '../../src/engine/core.js';
import { REGION_CODES, CLAIM_REJECTED, START_REGION_RUNTIME, REGION_LOG_ONLY_CODES } from '../../src/regions/codes.js';
import { HOLD_CODES, HOLD_LOG_CODES } from '../../src/holds/codes.js';
import { BUDGETS } from '../../src/regions/budgets.js';
import type { Clock } from '../../src/ports/clock.js';
import { VirtualClock } from '../sim/vclock.js';
import { LogRecorder } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A core stand-in: raiseRegionCode reads deps.ports.clock, deps.log and holdCode only. */
function fakeCore(clock: Clock, log: LogRecorder): EngineCore {
  return { deps: { ports: { clock }, log }, holdCode: null } as unknown as EngineCore;
}

/** A Clock whose wall time a test can move on its own (a PC clock jump): raiseRegionCode must read only Δmono. */
function jumpingClock(): { clock: Clock; advance(ms: number): void; jumpWall(ms: number): void } {
  let mono = 1_000;
  let wall = 1_800_000_000_000;
  return {
    clock: { monoMs: () => mono, wallMs: () => wall, sleep: async () => undefined },
    advance: (ms) => { mono += ms; wall += ms; },
    jumpWall: (ms) => { wall += ms; },
  };
}

test('raiseRegionCode writes holdCode and the log, REGION_BUDGET at most once per path per 30 min \u0394mono', T10, () => {
  const c = jumpingClock();
  const log = new LogRecorder();
  const core = fakeCore(c.clock, log);
  raiseRegionCode(core, 'REGION_BUDGET', { path: 'a.py', budget: 'parse' });
  assert.deepEqual(core.holdCode, { code: 'REGION_BUDGET', params: { path: 'a.py', budget: 'parse' } });
  assert.equal(log.lines.length, 1);
  assert.equal(log.lines[0]!.level, 'warn');
  assert.equal(log.lines[0]!.code, 'REGION_BUDGET');
  assert.deepEqual(log.lines[0]!.params, { path: 'a.py', budget: 'parse' });
  // 1,799,999 ms later: still inside the window — no second write.
  c.advance(BUDGETS.regionBudgetDedupeMs - 1);
  raiseRegionCode(core, 'REGION_BUDGET', { path: 'a.py', budget: 'parse' });
  assert.equal(log.lines.length, 1, 'the same call inside the window writes nothing');
  // Another budget kind of the same path inside the window writes nothing either: per path, not per kind.
  raiseRegionCode(core, 'REGION_BUDGET', { path: 'a.py', budget: 'map' });
  assert.equal(log.lines.length, 1, '{path: a.py, budget: map} inside the window writes nothing (per path, not per kind)');
  // A different path writes.
  raiseRegionCode(core, 'REGION_BUDGET', { path: 'b.py', budget: 'parse' });
  assert.equal(log.lines.length, 2);
  // At +1,800,000 ms the a.py window has closed: it writes again.
  c.advance(1);
  raiseRegionCode(core, 'REGION_BUDGET', { path: 'a.py', budget: 'parse' });
  assert.equal(log.lines.length, 3);
  // A wall-clock jump of −1 h does not reopen the window (Δmono decides), nor does a +1 h jump.
  c.jumpWall(-60 * 60_000);
  raiseRegionCode(core, 'REGION_BUDGET', { path: 'a.py', budget: 'map' });
  c.jumpWall(2 * 60 * 60_000);
  raiseRegionCode(core, 'REGION_BUDGET', { path: 'a.py', budget: 'parse' });
  assert.equal(log.lines.length, 3, 'a wall jump never reopens the window');
});

test('CLAIM_REJECTED once per (claim_id, reason); other codes every time', T10, () => {
  const clock = new VirtualClock({ startMono: 1_000 });
  const log = new LogRecorder();
  const core = fakeCore(clock, log);
  const claim = 'abcdefghij234567';
  raiseRegionCode(core, 'CLAIM_REJECTED', { claim_id: claim, reason: 'anchor' });
  raiseRegionCode(core, 'CLAIM_REJECTED', { claim_id: claim, reason: 'anchor' });
  assert.equal(log.lines.length, 1);
  raiseRegionCode(core, 'CLAIM_REJECTED', { claim_id: claim, reason: 'ranges' });
  assert.equal(log.lines.length, 2);
  clock.advance(10 * 24 * 60 * 60_000);
  raiseRegionCode(core, 'CLAIM_REJECTED', { claim_id: claim, reason: 'anchor' });
  assert.equal(log.lines.length, 2, 'CLAIM_REJECTED never repeats, not even after days');
  for (let i = 0; i < 3; i++) raiseRegionCode(core, 'REGION_SPEC_MISMATCH', { path: 'a.py', claim_id: claim, peer: 'P1' });
  assert.equal(log.lines.length, 5, 'REGION_SPEC_MISMATCH every time');
  raiseRegionCode(core, 'REGION_BLOCK_ONLY', { path: 'a.py', reason: 'no_grammar' });
  assert.equal(log.lines.length, 6);
  assert.equal(log.lines[5]!.level, 'info', 'REGION_BLOCK_ONLY logs at info');
  assert.equal(log.lines.slice(0, 5).every((l) => l.level === 'warn'), true, 'the other codes log at warn');
});

/** X-117 (Plan 5 X5-54): in a module listed here only these top-level lists are declarations; its other lists are references or selections
 *  (src/claude/wire/codes.ts: ROUTED_CODES references the owners' codes, PULL_MODE_SUPPRESSED and MANDATORY_FAMILIES select). Every other
 *  codes.ts module declares every code literal it holds. (F2 #88 #143, R-F2-4) */
const DECLARATION_LISTS: ReadonlyMap<string, readonly string[]> = new Map([['src/claude/wire/codes.ts', ['CCI_CODES', 'NEW_CODES', 'LOG_ONLY_CODES']]]);

/** The code names each codes.ts module under src/ declares (definitions: the string literals of the module, or of its
 *  DECLARATION_LISTS initializers only when it is listed there), keyed by module path. An identifier spread such as
 *  `...NEW_CODES` is not a literal and adds nothing. */
function declaredCodes(modules: ReadonlyMap<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, text] of modules) {
    const names: string[] = [];
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteralLike(n) && /^[A-Z][A-Z0-9_]+$/.test(n.text)) names.push(n.text);
      ts.forEachChild(n, visit);
    };
    const lists = DECLARATION_LISTS.get(file);
    if (lists === undefined) visit(sf);
    else {
      for (const st of sf.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && lists.includes(d.name.text) && d.initializer !== undefined) visit(d.initializer);
        }
      }
    }
    out.set(file, [...new Set(names)]);
  }
  return out;
}

/** X-29's one rule for all plans: an exact code name declared in two codes.ts modules (never a prefix). */
function collisions(modules: ReadonlyMap<string, string>): string[] {
  const owner = new Map<string, string>();
  const out: string[] = [];
  for (const [file, names] of declaredCodes(modules)) {
    for (const n of names) {
      const prev = owner.get(n);
      if (prev !== undefined && prev !== file) out.push(`${n}: ${prev} and ${file}`);
      else owner.set(n, file);
    }
  }
  return out;
}

/** Every codes.ts module under src/ except src/viz/i18n/codes.ts, the viewer's closed display-set registry (R-V43), which names
 *  other plans' codes and owns none, so it names no plan's registry uniquely. (A module whose lists mix declarations and
 *  references is scanned through DECLARATION_LISTS, never exempted.) */
function codeModules(): Map<string, string> {
  const out = new Map<string, string>();
  const scan = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.name === 'codes.ts') {
        const key = p.slice(ROOT.length).replace(/\\/gu, '/');
        if (key !== 'src/viz/i18n/codes.ts') out.set(key, readFileSync(p, 'utf8'));
      }
    }
  };
  scan(join(ROOT, 'src'));
  return out;
}

test('region codes collide with no other plan\u2019s code and carry SEC-38-clean params', T10, () => {
  // The Plan 4 names are disjoint from Plan 3's hold codes.
  const names = new Set<string>([...REGION_CODES, CLAIM_REJECTED, START_REGION_RUNTIME, ...REGION_LOG_ONLY_CODES]);
  for (const c of [...HOLD_CODES, ...HOLD_LOG_CODES]) assert.equal(names.has(c), false, `${c} collides with a hold code`);
  const modules = codeModules();
  assert.ok(modules.has('src/regions/codes.ts') && modules.has('src/holds/codes.ts'), [...modules.keys()].join(', '));
  // Plan 5's codes module is scanned (its declaration lists; F2 #88 #143): the whole-file exemption cannot quietly return.
  assert.ok(modules.has('src/claude/wire/codes.ts'), [...modules.keys()].join(', '));
  // The code-collision scan (X-29) passes on the tree ...
  assert.deepEqual(collisions(modules), []);
  // ... reads CCI_CODES and LOG_ONLY_CODES of src/claude/wire/codes.ts as declarations, and its ROUTED_CODES and
  // PULL_MODE_SUPPRESSED as references (by code name: readdir order is not sorted on every OS).
  const WIRE = 'src/claude/wire/codes.ts';
  const names0 = (ms: ReadonlyMap<string, string>): string[] => collisions(ms).map((c) => c.slice(0, c.indexOf(':')));
  const cciPlanted = new Map(modules).set(WIRE, "export const CCI_CODES = frozen(['HOLD_CREATED']);\n");
  assert.deepEqual(names0(cciPlanted), ['HOLD_CREATED'], 'a CCI_CODES declaration of a Plan 3 code collides');
  const line = collisions(cciPlanted)[0]!;
  assert.ok(line.includes('src/holds/codes.ts') && line.includes(WIRE), line);
  const refPlanted = new Map(modules).set(WIRE,
    "export const ROUTED_CODES = frozen(['HOLD_CREATED'] as const);\nexport const PULL_MODE_SUPPRESSED = frozen(['HOLD_CREATED'] as const);\n");
  assert.deepEqual(collisions(refPlanted), [], 'a ROUTED_CODES reference or a PULL_MODE_SUPPRESSED selection is no declaration');
  const logPlanted = new Map(modules).set(WIRE, "export const LOG_ONLY_CODES = frozen(['HOLD_CREATED'] as const);\n");
  assert.deepEqual(names0(logPlanted), ['HOLD_CREATED'], 'a LOG_ONLY_CODES declaration of a Plan 3 code collides');
  // ... passes on a planted prefix (Plan 6's CLAIM_BREACH beside Plan 4's CLAIM_* names) and fails on an exact duplicate.
  const withPrefix = new Map(modules).set('src/coord/codes.ts', "export const COORD_CODES = ['CLAIM_BREACH', 'CLAIM_BREACH_SELF'] as const;\n");
  assert.deepEqual(collisions(withPrefix), [], 'a prefix is never a collision');
  const withDuplicate = new Map(modules).set('src/coord/codes.ts', "export const COORD_CODES = ['CLAIM_BREACH', 'CLAIM_OVERLAP'] as const;\n");
  assert.deepEqual(collisions(withDuplicate), ['CLAIM_OVERLAP: src/regions/codes.ts and src/coord/codes.ts'], 'an exact duplicate fails');
  // No module other than src/regions/codes.ts declares any of Plan 4's names (definitions, not uses).
  for (const [file, declared] of declaredCodes(modules)) {
    if (file === 'src/regions/codes.ts') continue;
    assert.deepEqual(declared.filter((n) => names.has(n)), [], `${file} declares no Plan 4 code`);
  }
  // Uses are not definitions: raise calls in other modules are not codes.ts modules and are never scanned.
  assert.equal([...modules.keys()].every((f) => f.endsWith('/codes.ts')), true);
  // Every param value raised in this suite is an id, a path, a number or a closed-enum string (SEC-38): no free text.
  const log = new LogRecorder();
  const core = fakeCore(new VirtualClock({ startMono: 1_000 }), log);
  raiseRegionCode(core, 'REGION_BUDGET', { path: 'src/a.py', budget: 'parse' });
  raiseRegionCode(core, 'CLAIM_REJECTED', { claim_id: 'abcdefghij234567', reason: 'anchor' });
  raiseRegionCode(core, 'REGION_SPEC_MISMATCH', { path: 'src/a.py', claim_id: 'abcdefghij234567', peer: 'P1' });
  raiseRegionCode(core, 'REGION_BLOCK_ONLY', { path: 'src/a.py', reason: 'no_grammar' });
  const CLEAN = /^(?:[a-z2-7]{16}|[A-Za-z0-9_./-]+|[a-z_]+)$/u;
  for (const l of log.lines) {
    for (const [k, v] of Object.entries(l.params ?? {})) {
      assert.ok(typeof v === 'number' || (typeof v === 'string' && CLEAN.test(v)), `${l.code}.${k} = ${JSON.stringify(v)} is SEC-38-clean`);
    }
  }
});
