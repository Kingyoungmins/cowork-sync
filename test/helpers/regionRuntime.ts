// Test-side region runtime (Plan 4 Task 1): the pinned .wasm files from node_modules, copied into one
// per-process temp directory under the same names tools/build/build.mjs gives them in dist/grammars/
// (the build test pins the two copies byte-equal by sha256), and loaded through the real Fs port.
// testSnapshot (Task 4) registers bytes in a SnapshotStore under git's blob id, computed in memory.
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { realFs } from '../../src/ports/fs.js';
import { workerInitOf } from '../../src/regions/pool.js';
import { pathClassOf } from '../../src/regions/pathClass.js';
import { loadRegionRuntime, type RegionRuntime } from '../../src/regions/runtime.js';
import type { SnapshotStore } from '../../src/regions/snapshots.js';
import type { BlobRef, DiskSnapshotId, RegionTable, Unit } from '../../src/regions/types.js';
import { handle as handleTable } from '../../src/regions/worker/jobs/table.js';
import { initParser, type ParserHost } from '../../src/regions/worker/parser.js';
import type { WorkerInit } from '../../src/regions/worker/protocol.js';
import { makeTempRoot } from './tmp.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** dist/grammars/<name> ← node_modules/<source>: the same map as tools/build/build.mjs (R4-09, R4-11). */
export const TEST_GRAMMAR_SOURCES: ReadonlyArray<readonly [name: string, source: string]> = [
  ['tree-sitter.wasm', 'web-tree-sitter/web-tree-sitter.wasm'],
  ['tree-sitter-python.wasm', 'tree-sitter-python/tree-sitter-python.wasm'],
  ['tree-sitter-javascript.wasm', 'tree-sitter-javascript/tree-sitter-javascript.wasm'],
  ['tree-sitter-typescript.wasm', 'tree-sitter-typescript/tree-sitter-typescript.wasm'],
  ['tree-sitter-tsx.wasm', 'tree-sitter-typescript/tree-sitter-tsx.wasm'],
  ['tree-sitter-c_sharp.wasm', 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm'],
];

let processRoot: Promise<string> | undefined;

/** One makeTempRoot (spaces and non-ASCII) per test process, removed when the process exits. */
export function regionTempRoot(): Promise<string> {
  processRoot ??= makeTempRoot('regions').then(({ root }) => {
    process.once('exit', () => rmSync(dirname(root), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    return root;
  });
  return processRoot;
}

/** Copies the six pinned .wasm files under their dist/grammars/ names into `dir` (created). */
export async function copyGrammarsTo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, source] of TEST_GRAMMAR_SOURCES) {
    await copyFile(join(repoRoot, 'node_modules', ...source.split('/')), join(dir, name));
  }
}

let runtime: Promise<RegionRuntime> | undefined;

/**
 * Copies the six files from node_modules into one per-process temp directory and calls loadRegionRuntime(realFs, dir).
 * The directory is shared by every caller in the process: a test that changes a file works on its own copy.
 */
export function testRegionRuntime(): Promise<RegionRuntime> {
  runtime ??= (async () => {
    const dir = join(await regionTempRoot(), 'grammars');
    await copyGrammarsTo(dir);
    return loadRegionRuntime(realFs, dir);
  })();
  return runtime;
}

/** The WorkerInit a pool posts to a worker for `runtime` (bytes copied): the pool's own workerInitOf. */
export function testWorkerInit(rt: RegionRuntime, name: 'fg' | 'bg' = 'fg', generation = 0): WorkerInit {
  return workerInitOf(rt, name, generation);
}

const bundles = new Map<string, Promise<string>>();

/** Bundles one entry with esbuild into the per-process temp root (memoised per entry and variant). */
function bundleOnce(entry: string, variant: string, plugins: Plugin[]): Promise<string> {
  const key = `${variant}:${entry}`;
  let out = bundles.get(key);
  if (out === undefined) {
    const n = bundles.size;
    out = (async () => {
      const file = join(await regionTempRoot(), 'bundles', `${n}-${variant}-${basename(entry).replace(/\.[cm]?ts$/, '')}.mjs`);
      await build({
        entryPoints: [isAbsolute(entry) ? entry : join(repoRoot, ...entry.split('/'))],
        outfile: file,
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'esm',
        sourcemap: false,
        logLevel: 'silent',
        plugins,
      });
      return file;
    })();
    bundles.set(key, out);
  }
  return out;
}

/** Bundles a TypeScript entry with esbuild (platform 'node', format 'esm') into the per-process temp root and returns the .mjs path (tsx loaders are not relied on inside worker threads). */
export function bundleForTest(entry: string): Promise<string> {
  return bundleOnce(entry, 'plain', []);
}

/** bundleForTest('src/entry/worker.ts'): the production region worker entry. */
export function testWorkerPath(): Promise<string> {
  return bundleForTest('src/entry/worker.ts');
}

/**
 * X-37's test entry: the production src/entry/worker.ts (its kind table, runWorkerLoop and the jobs.ts dispatcher) with each
 * src/regions/worker/jobs/<file>.ts replaced at bundle time by a handler answering {handler: '<file>', job: job.kind}, so a
 * test sees which handler file each job kind reached without depending on what a production handler returns.
 */
export function recordingWorkerPath(): Promise<string> {
  const recording: Plugin = {
    name: 'recording-job-handlers',
    setup(b) {
      b.onLoad({ filter: /[\\/]src[\\/]regions[\\/]worker[\\/]jobs[\\/][A-Za-z]+\.ts$/ }, (args) => ({
        loader: 'ts',
        contents: `export async function handle(job: { kind: string }): Promise<unknown> {\n  return { handler: ${JSON.stringify(basename(args.path, '.ts'))}, job: job.kind };\n}\n`,
      }));
    },
  };
  return bundleOnce('src/entry/worker.ts', 'recording', [recording]);
}

/**
 * Registers `bytes` in `store` under path (owner defaults to 'test'); the oid is git's blob id sha1("blob <n>" NUL bytes),
 * computed in memory: no git process runs and no object is written (R1-035, OQ-17, REG-35).
 */
export function testSnapshot(store: SnapshotStore, path: string, bytes: Buffer, owner = 'test'): DiskSnapshotId {
  return store.register(path, blobIdOf(bytes), bytes, owner);
}

/** git's blob id of bytes, computed in memory. */
export function blobIdOf(bytes: Buffer): Oid {
  const header = Buffer.concat([Buffer.from(`blob ${bytes.length}`, 'ascii'), Buffer.from([0])]);
  return parseOid(createHash('sha1').update(header).update(bytes).digest('hex'));
}

let tableHost: Promise<ParserHost> | undefined;

/** One ParserHost per test process over testRegionRuntime() (the table tests share it; the process exit frees it). */
export function testTableHost(): Promise<ParserHost> {
  tableHost ??= testRegionRuntime().then((rt) => initParser(testWorkerInit(rt)));
  return tableHost;
}

/**
 * The region table the production 'table' job handler builds for path's blob on the calling thread: path class 4 (a symbol
 * table) or 6 (a block table) by pathClassOf with plain attributes; any other class throws (the service's NO_TABLE cases).
 * ref defaults to the blob's own id; prevRef asks for an incremental re-parse from that blob's live tree.
 */
export async function testTable(path: string, bytes: Buffer, o: { ref?: BlobRef; prevRef?: BlobRef } = {}): Promise<RegionTable> {
  const rt = await testRegionRuntime();
  const parser = await testTableHost();
  const v = pathClassOf(path, bytes, { mode: '100644', attrs: { filter: null, merge: null, text: null, binary: false, eol: null, generated: false, coworkOff: false, workingTreeEncoding: null } }, (l) => parser.availability().get(l) === 'ok');
  if (v.cls !== 4 && v.cls !== 6) throw new Error(`testTable(${path}): path class ${v.cls} has no table`);
  const t = await handleTable({ kind: 'table', lang: v.lang, cls: v.cls, ref: o.ref ?? blobIdOf(bytes), bytes, regionSpec: rt.regionSpec, prevRef: o.prevRef ?? null }, { parser, deadline: null });
  if (t === 'deadline' || !('units' in t)) throw new Error(`testTable(${path}): ${t === 'deadline' ? 'deadline' : t.reason}`);
  return t;
}

/** A unit without its sigSlice (Task 7 fills sigSlice; Task 4's table tests compare the rest, ruling PF-7). */
export type UnitShape = Omit<Unit, 'sigSlice'>;

export function withoutSigSlice(units: readonly Unit[]): UnitShape[] {
  return units.map(({ sigSlice: _s, ...rest }) => rest);
}
