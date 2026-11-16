// web-tree-sitter in a region worker (04-regions §3.3 "Runtime", §3.18; REG-03, REG-31; rulings R4-10, R4-12, R4-14):
// the runtime is initialised from the posted bytes (Emscripten wasmBinary) and each grammar from its posted bytes
// (Language.load(Uint8Array)) — a worker opens no file. A language whose grammar does not load, whose query does not
// compile or whose one-line self-test does not parse cleanly is unavailable (grammarless, P2: coarser, never a false
// pass). Parse trees stay in the worker, at most BUDGETS.liveTreesPerWorker of them, LRU by key.
//
// web-tree-sitter's binding is one module per JS realm (Parser.init initialises it once), so a second initParser in the
// same realm reuses it: it does so only for byte-identical runtime bytes and reports every language unavailable for
// any other runtime bytes (accepted by the controller, Task 1 fix round 1: one runtime per realm). Loaded grammars are
// cached per realm by content (sha256), so repeated hosts in one realm do not link a grammar into the shared wasm heap
// again. Every host in a realm allocates in that one wasm heap, and web-tree-sitter frees an object it was not asked
// to delete only through a FinalizationRegistry, which runs on JS garbage collection, not on wasm heap pressure — so a
// host is disposed explicitly (ParserHost.dispose: inlineWorkers.close() and runWorkerLoop's exit path).
import { createHash } from 'node:crypto';
import { Edit, Language as Grammar, Parser, Query, type Tree } from 'web-tree-sitter';
import { BUDGETS } from '../budgets.js';
import { QUERY_SOURCES } from '../queries/index.js';
import { LANGUAGES } from '../runtime.js';
import type { Language } from '../types.js';
import type { WorkerInit } from './protocol.js';

export type { Tree } from 'web-tree-sitter';

export interface ParserHost {
  availability(): ReadonlyMap<Language, 'ok' | 'unavailable'>;
  /** ≤ BUDGETS.liveTreesPerWorker live trees, LRU by key; old.edit is built by lineTable.inputEdit. With old, the parse starts from an edited copy
   *  of old.key's live tree (an incremental re-parse, R1-081; the live tree itself is left as it was) when that tree is live, of this language and
   *  old.edit is an edit; otherwise it parses from scratch. Both give the same tree.
   *  A returned tree stays valid until a later parse evicts or replaces its key. Bytes that are not UTF-8 have no tree ('unavailable': the caller's class-6 path). */
  parse(lang: Language, bytes: Buffer, key: string, deadline: { expired(): boolean } | null, old?: { key: string; edit: unknown }): Tree | 'deadline' | 'unavailable';
  liveKeys(): readonly string[];
  /** Deletes this host's live Trees, compiled Queries and Parsers (contract addition, Task 1 fix round 1); idempotent. Afterwards every tree it returned
   *  is invalid, parse answers 'unavailable', liveKeys() is empty and availability() reports every language unavailable. The realm's loaded grammars
   *  stay (shared by later hosts). inlineWorkers.close() and runWorkerLoop's exit path call it. */
  dispose(): void;
}

const NONE_AVAILABLE: ReadonlyMap<Language, 'ok' | 'unavailable'> = new Map(LANGUAGES.map((l) => [l, 'unavailable'] as const));

/** Frees one web-tree-sitter object; after a wasm trap the module may already be unusable, and a dispose must still finish. */
function quietDelete(o: { delete(): void }): void {
  try {
    o.delete();
  } catch {
    // nothing left to free in a dead module
  }
}

/** Read-only strict decode (04 §3.2; the BOM stays in the text, tree-sitter skips it); text is never encoded (L-UTF8-WRITE). */
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** One line per language that must parse with this root and no error node. */
const SELF_TEST: Readonly<Record<Language, { readonly text: string; readonly root: string }>> = Object.freeze({
  python: { text: 'x = 1\n', root: 'module' },
  javascript: { text: 'let x = 1;\n', root: 'program' },
  typescript: { text: 'let x: number = 1;\n', root: 'program' },
  tsx: { text: 'const x = <a />;\n', root: 'program' },
  c_sharp: { text: 'class A { }\n', root: 'compilation_unit' },
});

interface WasmApi { validate(bytes: Uint8Array): boolean; }

/** WebAssembly.validate (the global; tsconfig's lib carries no WebAssembly types). */
function wasmValid(bytes: Uint8Array): boolean {
  const api = (globalThis as unknown as { WebAssembly?: WasmApi }).WebAssembly;
  try {
    return api !== undefined && api.validate(bytes);
  } catch {
    return false;
  }
}

function asBuffer(u: Uint8Array): Buffer {
  return Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength);
}

/** The runtime this realm's web-tree-sitter binding was initialised with. */
let realmRuntime: { readonly bytes: Buffer; readonly ready: Promise<boolean> } | null = null;

/** True when this realm's binding runs exactly these runtime bytes. */
async function startRuntime(bytes: Uint8Array): Promise<boolean> {
  if (!wasmValid(bytes)) return false;
  if (realmRuntime !== null) return asBuffer(bytes).equals(realmRuntime.bytes) ? realmRuntime.ready : false;
  const own = Buffer.from(new Uint8Array(bytes));
  const ready = Parser.init({ wasmBinary: new Uint8Array(own) }).then(() => true, () => false);
  const entry = { bytes: own, ready };
  realmRuntime = entry;
  const ok = await ready;
  // A failed init leaves the binding uninitialised (web-tree-sitter keeps no module), so a later call may try again.
  if (!ok && realmRuntime === entry) realmRuntime = null;
  return ok;
}

/** Grammars loaded into this realm's binding, by sha256 of their bytes (null: the bytes do not load). */
const grammarCache = new Map<string, Promise<Grammar | null>>();

function loadGrammar(bytes: Uint8Array): Promise<Grammar | null> {
  if (!wasmValid(bytes)) return Promise.resolve(null);
  const key = createHash('sha256').update(bytes).digest('hex');
  let loaded = grammarCache.get(key);
  if (loaded === undefined) {
    loaded = Grammar.load(new Uint8Array(bytes)).catch(() => null);
    grammarCache.set(key, loaded);
  }
  return loaded;
}

interface Ready { readonly parser: Parser; readonly query: Query; }

/** A parser and the compiled query for one language, or null when the query does not compile or the self-test fails. */
function prepare(lang: Language, grammar: Grammar, source: string): Ready | null {
  let parser: Parser | null = null;
  let query: Query | null = null;
  try {
    parser = new Parser();
    parser.setLanguage(grammar);
    query = new Query(grammar, source);
    const probe = parser.parse(SELF_TEST[lang].text);
    const ok = probe !== null && probe.rootNode.type === SELF_TEST[lang].root && !probe.rootNode.hasError;
    probe?.delete();
    if (ok) return { parser, query };
  } catch {
    // a grammar the binding rejects or a query that does not compile: the language is unavailable
  }
  query?.delete();
  parser?.delete();
  return null;
}

/**
 * Initialises the runtime from init.runtimeWasm (Emscripten wasmBinary), loads each grammar with Language.load(Uint8Array), compiles its query and parses a built-in
 * one-line self-test snippet; any failure marks that language unavailable (a language whose query does not compile is grammarless).
 * In one JS realm (inlineWorkers, tests) every host shares the realm's one web-tree-sitter runtime: the first init's runtime bytes; a host given other
 * runtime bytes reports every language unavailable. Dispose a host that is no longer used (ParserHost.dispose).
 */
export async function initParser(init: WorkerInit, queries: Readonly<Record<Language, string>> = QUERY_SOURCES): Promise<ParserHost> {
  const ready = new Map<Language, Ready>();
  if (await startRuntime(init.runtimeWasm)) {
    for (const [lang, bytes] of init.grammars) {
      if (!LANGUAGES.includes(lang) || ready.has(lang)) continue;
      const grammar = await loadGrammar(bytes);
      const source = queries[lang];
      const prepared = grammar === null || typeof source !== 'string' ? null : prepare(lang, grammar, source);
      if (prepared !== null) ready.set(lang, prepared);
    }
  }
  let status: ReadonlyMap<Language, 'ok' | 'unavailable'> = new Map(
    LANGUAGES.map((l) => [l, ready.has(l) ? 'ok' : 'unavailable'] as const),
  );
  const live = new Map<string, Tree>();   // insertion order = recency (oldest first)
  let disposed = false;

  const remember = (key: string, tree: Tree): void => {
    const previous = live.get(key);
    if (previous !== undefined) {
      live.delete(key);
      if (previous !== tree) previous.delete();
    }
    live.set(key, tree);
    while (live.size > BUDGETS.liveTreesPerWorker) {
      const [oldestKey, oldest] = live.entries().next().value as [string, Tree];
      live.delete(oldestKey);
      oldest.delete();
    }
  };

  return {
    availability: () => status,
    parse(lang, bytes, key, deadline, old): Tree | 'deadline' | 'unavailable' {
      const r = ready.get(lang);
      if (r === undefined) return 'unavailable';
      let text: string;
      try {
        text = DECODER.decode(bytes);
      } catch {
        return 'unavailable';
      }
      if (deadline !== null && deadline.expired()) return 'deadline';
      // Incremental re-parse (R1-081): tree.edit mutates, so the edit goes to a copy and old.key's live tree stays valid for its own bytes.
      const prev = old === undefined || !(old.edit instanceof Edit) ? undefined : live.get(old.key);
      const base = prev !== undefined && prev.language === r.parser.language ? prev.copy() : null;
      let tree: Tree | null;
      try {
        if (base !== null) base.edit(old?.edit as Edit);
        tree = r.parser.parse(text, base, deadline === null ? undefined : { progressCallback: () => deadline.expired() });
      } finally {
        base?.delete();
      }
      if (tree === null) {
        r.parser.reset();   // a cancelled parse would otherwise resume on the next document
        return 'deadline';
      }
      remember(key, tree);
      return tree;
    },
    liveKeys: () => [...live.keys()],
    dispose(): void {
      if (disposed) return;
      disposed = true;
      status = NONE_AVAILABLE;
      for (const tree of live.values()) quietDelete(tree);
      live.clear();
      for (const r of ready.values()) {
        quietDelete(r.query);
        quietDelete(r.parser);
      }
      ready.clear();
    },
  };
}
