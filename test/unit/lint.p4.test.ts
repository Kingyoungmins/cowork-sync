// Plan 4's six lint rules (R1-040, R1-061, R1-062, R1-152, R2-N07, 3X-04; rulings R4-09, R4-12, R4-17, R4-83, PF-12),
// the rules on the real tree, and 3X-05: Plan 4 places no crashpoint and no yield point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSource } from '../../tools/lint/rules.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const LINT = fileURLToPath(new URL('../../tools/lint/lint.ts', import.meta.url));
const P4_RULES: ReadonlySet<string> = new Set(['L-REGION-DEPS', 'L-REGION-WRITE', 'L-OFFSETS', 'L-UTF8-WRITE', 'L-ONE-MAPPER', 'L-CLAIMFREE-HOLDS']);

/** The rule ids lintSource reports for one planted source, in order. */
function rules(file: string, text: string): string[] {
  return lintSource(file, text).map((f) => f.rule);
}

/** Only Plan 4's rule ids. */
function p4(file: string, text: string): string[] {
  return rules(file, text).filter((r) => P4_RULES.has(r));
}

test('L-REGION-DEPS: web-tree-sitter, worker_threads and I/O stay where R4-09 and R4-12 put them', () => {
  assert.deepEqual(rules('src/regions/runtime.ts', `import { Parser } from 'web-tree-sitter';`), ['L-REGION-DEPS']);
  assert.deepEqual(rules('src/regions/worker/parser.ts', `import { Parser } from 'web-tree-sitter';`), []);
  assert.deepEqual(rules('src/engine/x.ts', `const p = await import('web-tree-sitter');`), ['L-REGION-DEPS']);
  assert.deepEqual(rules('src/regions/service.ts', `import { Worker } from 'node:worker_threads';`), ['L-REGION-DEPS']);
  assert.deepEqual(rules('src/regions/pool.ts', `import { Worker } from 'node:worker_threads';`), []);
  assert.deepEqual(rules('src/entry/worker.ts', `import { parentPort } from 'node:worker_threads';`), []);
  assert.deepEqual(rules('src/regions/worker/main.ts', `import { parentPort } from 'worker_threads';`), ['L-REGION-DEPS']);
  assert.deepEqual(rules('src/regions/worker/tables.ts', `import { readFile } from 'node:fs';`).sort(), ['L-FS-PORT', 'L-REGION-DEPS']);
  assert.deepEqual(rules('src/regions/worker/x.ts', `import { GitRepo } from '../../git/repo.js';`), ['L-REGION-DEPS']);
  assert.deepEqual(rules('src/regions/worker/x.ts', `import { realFs } from '../../ports/fs.js';`), ['L-REGION-DEPS']);
  // PF-12: a type-only import counts like a value import.
  assert.deepEqual(rules('src/regions/worker/x.ts', `import type { GitRepo } from '../../git/repo.js';`), ['L-REGION-DEPS']);
  assert.deepEqual(rules('src/regions/worker/jobs/x.ts', `import { spawn } from 'node:child_process';`).sort(), ['L-PORTS', 'L-REGION-DEPS']);
  assert.deepEqual(rules('src/regions/worker/x.ts', `import type { Oid } from '../types.js';\nimport { realClock } from '../../ports/clock.js';`), []);
  assert.deepEqual(rules('src/engine/x.ts', `import { inlineWorkers } from '../regions/worker/inline.js';`), ['L-REGION-DEPS']);
  assert.deepEqual(rules('src/regions/service.ts', `import { inlineWorkers } from './worker/inline.js';`), ['L-REGION-DEPS']);
  // Outside src/ the rule does not apply (tests and tools bind inlineWorkers).
  assert.deepEqual(rules('test/helpers/regionDeps.ts', `import { inlineWorkers } from '../../src/regions/worker/inline.js';`), []);
});

test('L-REGION-WRITE: the region and claim modules write nothing', () => {
  const F = 'src/regions/service.ts';
  for (const src of [
    `await repo.hashBytes(b, true);`,
    `await hashRouteC(repo, b, true);`,
    `await hashRouteB(repo, p, f, write);`,
    `await repo.writeTreeMap(m, i);`,
    `await repo.editTree(t, e, i);`,
    `await repo.mktree(e);`,
    `await repo.commitTree(c);`,
    `await repo.casRef(r, n, p, m);`,
    `await repo.editIndex(i, e);`,
    `await mergeTree(repo, a, b, c);`,
    `await repo.run(['update-index', '--add']);`,
    `await repo.run(['hash-object', '-w', '--stdin']);`,
    `import { foldCommit } from '../board/fold.js';`,
    `import type { HoldRecord } from '../holds/record.js';`,
    `import { claimView } from '../claims/view.js';`,
    `import { EngineCore } from '../engine/core.js';`,
  ]) {
    assert.deepEqual(p4(F, src), ['L-REGION-WRITE'], src);
  }
  for (const src of [
    `await repo.run(['grep', '-z', '-n']);`,
    `await repo.run(['ls-tree', '-z', t]);`,
    `await repo.run(['cat-file', '--batch']);`,
    `await repo.run(['check-attr', '-z']);`,
    `await repo.run(['hash-object', '--stdin', '--no-filters']);`,
    `await hashRouteC(repo, b, false);`,
    `await repo.hashBytes(b, false);`,
    `import { rows } from '../data/rows.js';`,
    `const LANGS = ['python', 'javascript'];`,
  ]) {
    assert.deepEqual(p4(F, src), [], src);
  }
  assert.deepEqual(rules('src/claims/gate.ts', `await mergeFile(repo, a, b, c);`), ['L-REGION-WRITE']);
  assert.deepEqual(rules('src/claims/editCheckPort.ts', `await mergeFile(repo, a, b, c);`), []);
  assert.deepEqual(rules('src/claims/emit.ts', `await repo.casRef(r, n, p, m);`), ['L-REGION-WRITE']);
  // src/claims may import src/board and src/holds (R4-02); only src/regions may not.
  assert.deepEqual(rules('src/claims/view.ts', `import { foldCommit } from '../board/fold.js';`), []);
  // Outside src/regions and src/claims the rule does not apply.
  assert.deepEqual(rules('src/engine/publish.ts', `await repo.casRef(r, n, p, m);`), []);
});

test('L-OFFSETS: tree-sitter offsets only in lineTable.ts', () => {
  assert.deepEqual(rules('src/regions/worker/tables.ts', `const a = node.startIndex;`), ['L-OFFSETS']);
  assert.deepEqual(rules('src/claims/x.ts', `const b = n.endIndex;`), ['L-OFFSETS']);
  assert.deepEqual(rules('src/regions/worker/slices.ts', `const c = n.endPosition.column;`), ['L-OFFSETS']);
  assert.deepEqual(rules('src/regions/worker/slices.ts', `const d = n.startPosition.column;`), ['L-OFFSETS']);
  assert.deepEqual(rules('src/regions/worker/slices.ts', `const e = n['startIndex'];`), ['L-OFFSETS']);
  assert.deepEqual(rules('src/regions/worker/slices.ts', `const { endIndex } = n;`), ['L-OFFSETS']);
  for (const src of [`const a = node.startIndex;`, `const b = n.endIndex;`, `const c = n.endPosition.column;`]) {
    assert.deepEqual(rules('src/regions/worker/lineTable.ts', src), [], src);
  }
  assert.deepEqual(rules('src/regions/worker/tables.ts', `const r = node.startPosition.row + node.endPosition.row;`), []);
  assert.deepEqual(rules('src/engine/x.ts', `const k = cell.column;`), []);
  assert.deepEqual(rules('src/regions/worker/tables.ts', `const k = cell.column;`), []);
});

test('L-UTF8-WRITE: the region and claim modules never encode text', () => {
  assert.deepEqual(rules('src/regions/lines.ts', `const enc = new TextEncoder();`), ['L-UTF8-WRITE']);
  assert.deepEqual(rules('src/claims/x.ts', `const b = Buffer.from(text, 'utf8');`), ['L-UTF8-WRITE']);
  assert.deepEqual(rules('src/claims/x.ts', 'const b = Buffer.from(`x`);'), ['L-UTF8-WRITE']);
  assert.deepEqual(rules('src/claims/x.ts', `const b = Buffer.from('x');`), ['L-UTF8-WRITE']);
  assert.deepEqual(rules('src/regions/x.ts', `out.write('x');`), ['L-UTF8-WRITE']);
  for (const src of [`const b = Buffer.from([0x0a]);`, `const b = Buffer.concat(parts);`, `stream.write(buf);`, `const b = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);`]) {
    assert.deepEqual(rules('src/regions/x.ts', src), [], src);
  }
  assert.deepEqual(rules('src/engine/x.ts', `const enc = new TextEncoder();`), []);
  assert.deepEqual(rules('src/data/x.ts', `const b = Buffer.from(text, 'utf8');`), []);
  // R4-83: Plan 2 Log writes are codes, not encoded text.
  assert.deepEqual(rules('src/regions/x.ts', `host.log.write('warn', 'REGION_BUDGET', {path});`), []);
  assert.deepEqual(rules('src/claims/x.ts', `this.deps.log.write('warn', 'x', {});`), []);
  assert.deepEqual(rules('src/claims/x.ts', `securityLog.write('security', 'SEC_RECORD_INVALID', {field: 'label'});`), []);
});

test('L-ONE-MAPPER: FoldMapper/1 is the only line mapper of region consumers', () => {
  const imp = `import { matchedRows } from '../data/linediff.js';`;
  assert.deepEqual(rules('src/claims/view.ts', imp), ['L-ONE-MAPPER']);
  assert.deepEqual(rules('src/regions/x.ts', imp), ['L-ONE-MAPPER']);
  // R4-83 (Plan 4 Task 5): src/holds/mask.ts takes its rows from the mapper's hunks(), so the clause covers it too.
  assert.deepEqual(p4('src/holds/mask.ts', imp), ['L-ONE-MAPPER']);
  assert.deepEqual(p4('src/holds/rebase.ts', imp), []);
  assert.deepEqual(rules('src/data/canon.ts', `import { matchedRows } from './linediff.js';`), []);
  assert.deepEqual(rules('src/regions/x.ts', `import type { RowMatch } from '../data/linediff.js';`), ['L-ONE-MAPPER']);
  assert.deepEqual(rules('src/claims/x.ts', `import { matchedRows } from '../data/canon.js';`), ['L-ONE-MAPPER']);
  for (const src of [`await repo.run(['diff', a, b]);`, `await repo.run(['diff-tree', '-p', c]);`, `await repo.run(['log', '-p']);`]) {
    assert.ok(rules('src/regions/x.ts', src).includes('L-ONE-MAPPER'), src);
  }
  assert.deepEqual(p4('src/claims/x.ts', `const argv = ['diff', '--no-index', a, b];`), ['L-ONE-MAPPER']);
  assert.deepEqual(rules('src/claims/x.ts', `const argv = ['log', '--format=%H'];`), []);
  assert.deepEqual(rules('src/engine/x.ts', `const argv = ['diff-tree', '-p', c];`), []);
});

test('L-CLAIMFREE-HOLDS: holds read no claim state', () => {
  assert.deepEqual(rules('src/holds/registry.ts', `import type { ClaimStore } from '../claims/store.js';`), ['L-CLAIMFREE-HOLDS']);
  assert.deepEqual(rules('src/holds/mask.ts', `import { hunks } from '../regions/mapper.js';`), []);
  assert.deepEqual(rules('src/holds/revert.ts', `import { hunks } from '../regions/mapper.js';`), ['L-CLAIMFREE-HOLDS']);
  assert.deepEqual(rules('src/holds/mask.ts', `import { touch } from '../regions/touch.js';`), ['L-CLAIMFREE-HOLDS']);
  assert.deepEqual(rules('src/holds/ports.ts', `import type { EditCheckEntry } from '../regions/editCheck.js';`), []);
  assert.deepEqual(rules('src/holds/ports.ts', `import type { EditCheckEntry, EditCheckReason } from '../regions/editCheck.js';`), []);
  assert.deepEqual(rules('src/holds/ports.ts', `import { EditCheckEntry } from '../regions/editCheck.js';`), ['L-CLAIMFREE-HOLDS']);
  assert.deepEqual(rules('src/holds/registry.ts', `import type { EditCheckEntry } from '../regions/editCheck.js';`), ['L-CLAIMFREE-HOLDS']);
  assert.deepEqual(rules('src/holds/ports.ts', `import type { editCheck } from '../regions/editCheck.js';`), ['L-CLAIMFREE-HOLDS']);
  assert.deepEqual(rules('src/holds/ports.ts', `export { gate } from '../claims/gate.js';`), ['L-CLAIMFREE-HOLDS']);
  assert.deepEqual(rules('src/claims/x.ts', `import { hold } from '../holds/registry.js';`), []);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const srcFiles = (): string[] => walk(join(REPO, 'src')).map((f) => relative(REPO, f).split('\\').join('/'));

test('the six rules pass on the tree', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', LINT], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, `npm run lint:\n${r.stdout}\n${r.stderr}`);
  const findings = srcFiles().flatMap((f) => lintSource(f, readFileSync(join(REPO, f), 'utf8'))).filter((x) => P4_RULES.has(x.rule));
  assert.deepEqual(findings, []);
});

/** sha256 of test/crashpoints.json at the task's base commit e704bad (Plan 2's 14 names). */
const CRASHPOINTS_AT_BASE = '2e28398e3dac7b763db0e1fbfc3672c6051ec7872e6acd6b86db09b73337e440';

test('Plan 4 places no crashpoint and no yield point', () => {
  const catalogue = readFileSync(join(REPO, 'test', 'crashpoints.json'));
  assert.equal(createHash('sha256').update(catalogue).digest('hex'), CRASHPOINTS_AT_BASE);
  const regionFiles = srcFiles().filter((f) => f.startsWith('src/regions/') || f.startsWith('src/claims/'));
  assert.ok(regionFiles.length > 0);
  for (const f of regionFiles) {
    const text = readFileSync(join(REPO, f), 'utf8');
    assert.doesNotMatch(text, /\bcrashpoint\s*\(/, `${f} places a crashpoint`);
    assert.doesNotMatch(text, /\byieldPoint\s*\(/, `${f} places a yield point`);
  }
});
