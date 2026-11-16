// The region runtime (04-regions §3.3 "Runtime", §2 "regionSpec"; REG-03, REG-04; rulings R4-09…R4-12, R4-16):
// the pinned web-tree-sitter runtime and five grammar .wasm files, read on the main thread through the Fs port and
// posted as bytes to the workers (which open no file, R4-12), and the regionSpec computed from those bytes and
// cowork's query sources. Nothing here parses: a grammar that later fails to load in a worker does not change
// regionSpec (REG-03's grammarless fallback is per peer, R4-11).
import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import type { Fs } from '../ports/fs.js';
import { QUERY_SOURCES } from './queries/index.js';
import type { Language } from './types.js';

export const LANGUAGES: readonly Language[] = Object.freeze(['python', 'javascript', 'typescript', 'tsx', 'c_sharp'] as const);

/** R4-10: the versions the ABI spike loaded (tree-sitter-typescript ships both the typescript and the tsx grammar); checked against package-lock.json. */
export const GRAMMAR_VERSIONS: Readonly<{ 'web-tree-sitter': string } & Record<Language, string>> = Object.freeze({
  'web-tree-sitter': '0.27.0',
  python: '0.25.0',
  javascript: '0.25.0',
  typescript: '0.23.2',
  tsx: '0.23.2',
  c_sharp: '0.23.5',
});

/** The grammar file names under dist/grammars/ (R4-09). */
export const GRAMMAR_FILES: Readonly<Record<Language, string>> = Object.freeze({
  python: 'tree-sitter-python.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  c_sharp: 'tree-sitter-c_sharp.wasm',
});

/** The runtime's name under dist/grammars/ (web-tree-sitter 0.27 ships it as web-tree-sitter.wasm; build.mjs renames it). */
export const RUNTIME_WASM = 'tree-sitter.wasm';

/** 04 §3.3: the lowercase extensions of each language. */
const EXTENSIONS: ReadonlyMap<string, Language> = new Map<string, Language>([
  ['.py', 'python'], ['.pyi', 'python'],
  ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'], ['.jsx', 'javascript'],
  ['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.cs', 'c_sharp'],
]);

/**
 * R4-16: the byte-exact lowercase extension of the last path component → its language, else null. `Foo.PY` has no
 * grammar (coarser on doubt, P2); a dotfile such as `.py` has no extension (path.posix.extname semantics).
 */
export function languageOf(path: string): Language | null {
  return EXTENSIONS.get(posix.extname(posix.basename(path))) ?? null;
}

export interface RegionRuntime {
  readonly dir: string;   // the grammars directory it was loaded from
  readonly runtimeWasm: Buffer; readonly grammars: ReadonlyMap<Language, Buffer>;
  readonly querySources: Readonly<Record<Language, string>>;   // src/regions/queries/*
  readonly regionSpec: string;                                  // R4-11
}

/** A runtime or grammar .wasm file that cannot be found (daemon start refuses with START_REGION_RUNTIME {file}, Task 16). */
export class RegionRuntimeMissingError extends Error {
  readonly file: string;
  constructor(file: string, cause?: unknown) {
    super(`region runtime file missing: ${file}`, cause === undefined ? undefined : { cause });
    this.name = 'RegionRuntimeMissingError';
    this.file = file;
  }
}

/** Errors that mean "no such file here" (a directory in the file's place included). */
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

/** The errno code of a thrown Fs error. Kept local (not the Fs port's errnoCode) so the worker modules that import this
 *  file's constants load nothing from src/ports/fs.ts at run time (R4-12; the Fs import above is type-only). */
function errnoOf(e: unknown): string | undefined {
  const c = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof c === 'string' ? c : undefined;
}

/**
 * Reads every .wasm through the Fs port (R4-12) — exactly one readFile per file, the runtime first, then the grammars in
 * LANGUAGES order; a missing file throws RegionRuntimeMissingError naming it (daemon start refuses); any other read
 * error propagates unchanged.
 */
export async function loadRegionRuntime(fs: Fs, dir: string): Promise<RegionRuntime> {
  const read = async (name: string): Promise<Buffer> => {
    try {
      return await fs.readFile(join(dir, name));
    } catch (e) {
      const code = errnoOf(e);
      if (code !== undefined && MISSING_CODES.has(code)) throw new RegionRuntimeMissingError(name, e);
      throw e;
    }
  };
  const runtimeWasm = await read(RUNTIME_WASM);
  const grammars = new Map<Language, Buffer>();
  for (const lang of LANGUAGES) grammars.set(lang, await read(GRAMMAR_FILES[lang]));
  const regionSpec = computeRegionSpec(
    [runtimeWasm, ...LANGUAGES.map((l) => grammars.get(l) as Buffer)],
    LANGUAGES.map((l) => QUERY_SOURCES[l]),
  );
  return Object.freeze({ dir, runtimeWasm, grammars, querySources: QUERY_SOURCES, regionSpec });
}

function sha256Hex(data: Buffer | string): string {
  return typeof data === 'string'
    ? createHash('sha256').update(data, 'utf8').digest('hex')
    : createHash('sha256').update(data).digest('hex');
}

/** The conventions every regionSpec names (04 §2). */
const CONVENTIONS: readonly string[] = ['extent-convention/1', 'label-convention/1', 'FoldMapper/1'];

/**
 * R4-11: regionSpecId([...sha256 hex of each .wasm, ...sha256 hex of each query source, 'extent-convention/1',
 * 'label-convention/1', 'FoldMapper/1']). Reimplements Plan 2's regionSpecId formula (sha256 lowercase hex over the parts
 * sorted by UTF-16 code units and joined by '\n') because src/regions may not import src/engine (R4-02); a Task 1 test pins
 * the equality. Each part is a bare digest (no file name), so the order of the inputs and the directory do not matter.
 * Computed from the shipped bytes, never from load success. Text is hashed as UTF-8 by the hash itself (L-UTF8-WRITE).
 */
export function computeRegionSpec(wasm: readonly Buffer[], querySources: readonly string[]): string {
  const parts = [...wasm.map((b) => sha256Hex(b)), ...querySources.map((q) => sha256Hex(q)), ...CONVENTIONS];
  return sha256Hex(parts.sort().join('\n'));
}
