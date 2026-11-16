// The region runtime and regionSpec (REG-03, REG-04, R1-024, R1-040; rulings R4-11, R4-12, OQ-2, OQ-4, OQ-7, 3Q-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLAN2_REGION_SPEC, regionSpecId } from '../../src/engine/deps.js';
import { realFs } from '../../src/ports/fs.js';
import { QUERY_SOURCES } from '../../src/regions/queries/index.js';
import {
  computeRegionSpec, GRAMMAR_FILES, LANGUAGES, loadRegionRuntime, RegionRuntimeMissingError, RUNTIME_WASM,
} from '../../src/regions/runtime.js';
import { inlineWorkers } from '../../src/regions/worker/inline.js';
import { initParser } from '../../src/regions/worker/parser.js';
import { copyGrammarsTo, testRegionRuntime, testWorkerInit } from '../helpers/regionRuntime.js';
import { makeTempRoot } from '../helpers/tmp.js';
import { FaultFs } from '../sim/faultfs.js';

/**
 * regionSpec of the pinned runtime, grammars and query sources (pinned at the spike's first green run; Task 4 re-pins it
 * when it completes the query files — a reviewed one-line change).
 */
const REGION_SPEC_GOLDEN = 'd81f33dead459e8b5bd5eec14c3d8d8e829ed75f3c40f13170e765d9f491f5f4';

/** The six files in load order: the runtime, then GRAMMAR_FILES in LANGUAGES order. */
const FILES: readonly string[] = [RUNTIME_WASM, ...LANGUAGES.map((l) => GRAMMAR_FILES[l])];
const QUERIES: readonly string[] = LANGUAGES.map((l) => QUERY_SOURCES[l]);
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const ALL_OK = { python: 'ok', javascript: 'ok', typescript: 'ok', tsx: 'ok', c_sharp: 'ok' };

/** A fresh copy of the six files in its own temp directory (never the shared testRegionRuntime() one). */
async function withCopy<T>(label: string, body: (dir: string, root: string) => Promise<T>): Promise<T> {
  const { root, cleanup } = await makeTempRoot(label);
  try {
    const dir = join(root, 'grammars');
    await copyGrammarsTo(dir);
    return await body(dir, root);
  } finally {
    await cleanup();
  }
}

test('loadRegionRuntime reads the six .wasm files through the Fs port', async () => {
  assert.deepEqual(FILES, [
    'tree-sitter.wasm', 'tree-sitter-python.wasm', 'tree-sitter-javascript.wasm', 'tree-sitter-typescript.wasm', 'tree-sitter-tsx.wasm',
    'tree-sitter-c_sharp.wasm',
  ]);
  const dir = (await testRegionRuntime()).dir;
  const fs = new FaultFs(realFs);
  const runtime = await loadRegionRuntime(fs, dir);
  assert.deepEqual(fs.calls, FILES.map((name) => `readFile ${join(dir, name)}`));
  assert.equal(runtime.dir, dir);
  assert.ok(runtime.runtimeWasm.equals(await readFile(join(dir, RUNTIME_WASM))));
  assert.deepEqual([...runtime.grammars.keys()], [...LANGUAGES]);
  for (const lang of LANGUAGES) {
    assert.ok(runtime.grammars.get(lang)?.equals(await readFile(join(dir, GRAMMAR_FILES[lang]))), lang);
  }
  assert.equal(runtime.querySources, QUERY_SOURCES);
});

test('a missing .wasm file throws RegionRuntimeMissingError naming it', async () => {
  await withCopy('rt-missing', async (dir) => {
    await rm(join(dir, 'tree-sitter-c_sharp.wasm'));
    await assert.rejects(loadRegionRuntime(realFs, dir), (e: unknown) => e instanceof RegionRuntimeMissingError && e.file === 'tree-sitter-c_sharp.wasm');
    await copyGrammarsTo(dir);
    await rm(join(dir, 'tree-sitter.wasm'));
    await assert.rejects(loadRegionRuntime(realFs, dir), (e: unknown) => e instanceof RegionRuntimeMissingError && e.file === 'tree-sitter.wasm');
  });
});

test("computeRegionSpec is Plan 2's regionSpecId over the R4-11 parts", async () => {
  const value = computeRegionSpec([Buffer.from('a'), Buffer.from('b')], ['q1']);
  assert.equal(value, regionSpecId([sha256('a'), sha256('b'), sha256('q1'), 'extent-convention/1', 'label-convention/1', 'FoldMapper/1']));
  assert.equal(computeRegionSpec([Buffer.from('b'), Buffer.from('a')], ['q1']), value, 'the order of the inputs does not matter');
  assert.equal(computeRegionSpec([], []), PLAN2_REGION_SPEC);
  assert.match(value, /^[0-9a-f]{64}$/);
  // Every hash part is a bare lowercase 64-hex digest with no file name: the shipped runtime's value is regionSpecId over exactly those digests.
  const runtime = await testRegionRuntime();
  const files = await Promise.all(FILES.map((name) => readFile(join(runtime.dir, name))));
  const parts = [...files.map((b) => sha256(b)), ...QUERIES.map((q) => sha256(Buffer.from(q, 'utf8')))];
  for (const p of parts) assert.match(p, /^[0-9a-f]{64}$/);
  assert.equal(runtime.regionSpec, regionSpecId([...parts, 'extent-convention/1', 'label-convention/1', 'FoldMapper/1']));
});

test('the regionSpec golden for the pinned files', async () => {
  const dir = (await testRegionRuntime()).dir;
  assert.equal((await loadRegionRuntime(realFs, dir)).regionSpec, REGION_SPEC_GOLDEN);
  await withCopy('rt-golden', async (copy, root) => {
    // Flipping one byte of any of the six .wasm copies changes it.
    for (const name of FILES) {
      const original = await readFile(join(copy, name));
      const flipped = Buffer.from(original);
      const at = Math.floor(flipped.length / 2);
      flipped[at] = (flipped[at] as number) ^ 0x01;
      await writeFile(join(copy, name), flipped);
      assert.notEqual((await loadRegionRuntime(realFs, copy)).regionSpec, REGION_SPEC_GOLDEN, name);
      await writeFile(join(copy, name), original);
    }
    // Copying the six files into a differently named directory does not.
    const other = join(root, 'other grammars \u{B2E4}\u{B978}');
    await copyGrammarsTo(other);
    assert.equal((await loadRegionRuntime(realFs, other)).regionSpec, REGION_SPEC_GOLDEN);
  });
  // Appending one space to any one query source changes it.
  const files = await Promise.all(FILES.map((name) => readFile(join(dir, name))));
  assert.equal(computeRegionSpec(files, QUERIES), REGION_SPEC_GOLDEN);
  LANGUAGES.forEach((lang, i) => {
    const edited = QUERIES.map((q, j) => (j === i ? `${q} ` : q));
    assert.notEqual(computeRegionSpec(files, edited), REGION_SPEC_GOLDEN, lang);
  });
});

test('a grammar that fails to load in a worker does not change regionSpec', async () => {
  await withCopy('rt-truncated', async (dir) => {
    await truncate(join(dir, 'tree-sitter-c_sharp.wasm'), 1_000);
    const runtime = await loadRegionRuntime(realFs, dir);
    const shipped = await Promise.all(FILES.map((name) => readFile(join(dir, name))));
    assert.equal(shipped[5]?.length, 1_000);
    assert.equal(runtime.regionSpec, computeRegionSpec(shipped, QUERIES), 'computed from the shipped bytes, never from load success');
    const pool = await inlineWorkers(runtime);
    try {
      assert.deepEqual(Object.fromEntries(pool.availability()), { ...ALL_OK, c_sharp: 'unavailable' });
    } finally {
      await pool.close();
    }
  });
});

test('a query source that does not compile makes only its language unavailable', async () => {
  const runtime = await testRegionRuntime();
  const host = await initParser(testWorkerInit(runtime), { ...QUERY_SOURCES, python: '(nonexistent_node) @x' });
  assert.deepEqual(Object.fromEntries(host.availability()), { ...ALL_OK, python: 'unavailable' });
  assert.equal(host.parse('python', Buffer.from('x = 1\n', 'utf8'), 'p', null), 'unavailable');
  const good = await initParser(testWorkerInit(runtime));
  assert.deepEqual(Object.fromEntries(good.availability()), ALL_OK);
});
