// Path classes (04-regions §3.3 "Path classes"; REG-05, REG-06, REG-32; rulings R4-16, R4-20): which table a LIVE path's blob
// gets. First match wins: 1 conflict-marker rows, 2 binary, 3 special (symlink/submodule mode, .ipynb, any filter=, any
// working-tree-encoding), 4 a loaded grammar and decodable, 5 otherwise ≤ 300 rows, 6 otherwise. Called only for paths of
// scope class LIVE (REG-32): the scope decisions (symlink, LFS, quarantined, SAVE_ONLY, LOCAL_ONLY) are the callers'.
// Bytes only: rows are 0x0A splits and decoding is a read-only strict decode.
import { posix } from 'node:path';
import type { PathAttrs } from '../data/attrs.js';
import { conflictMarkerRows, isBinaryBytes } from '../data/rows.js';
import { decodeStrict, lineArray } from './lines.js';
import { languageOf } from './runtime.js';
import type { FileMode, Language, PathClass } from './types.js';

/** Glossary §20 "Grammarless text files": whole file up to 300 rows, blank-line blocks above. */
export const GRAMMARLESS_WHOLE_FILE_MAX_LINES = 300;

export interface PathFacts { readonly mode: FileMode; readonly attrs: PathAttrs; }   // attributes at EPOCH_BASE (DAT-13)

/** lang is the language of the symbol table (class 4 only, else null); decodable is the strict UTF-8 decode of the blob, for
 *  every class; blockReason says why a class 5/6 path has no symbol table: no grammar for its extension, not UTF-8, or its
 *  grammar did not load (REGION_BLOCK_ONLY's reason). */
export interface PathClassVerdict { readonly cls: PathClass; readonly lang: Language | null; readonly decodable: boolean; readonly blockReason: 'no_grammar' | 'not_utf8' | 'grammar_unavailable' | null; }

const SPECIAL_MODES: ReadonlySet<FileMode> = new Set<FileMode>(['120000', '160000']);

/** Row 3's notebook test: the last component's extension, case-folded (a coarser class on doubt, P2). */
function isNotebook(path: string): boolean {
  return posix.extname(posix.basename(path)).toLowerCase() === '.ipynb';
}

/** First match wins: 1 conflict-marker rows (Plan 2 conflictMarkerRows), 2 binary (isBinaryBytes or -text/binary), 3 mode 120000/160000, .ipynb, any filter=, any working-tree-encoding, 4 a loaded grammar and decodable, 5 otherwise ≤ 300 lines, 6 otherwise; called only for LIVE paths. */
export function pathClassOf(path: string, blob: Buffer, facts: PathFacts, grammarOk: (l: Language) => boolean): PathClassVerdict {
  const decodable = decodeStrict(blob) !== null;
  const verdict = (cls: PathClass, lang: Language | null, blockReason: PathClassVerdict['blockReason']): PathClassVerdict =>
    Object.freeze({ cls, lang, decodable, blockReason });
  if (conflictMarkerRows(blob).size > 0) return verdict(1, null, null);
  const a = facts.attrs;
  if (isBinaryBytes(blob) || a.binary || a.text === 'unset') return verdict(2, null, null);
  if (SPECIAL_MODES.has(facts.mode) || isNotebook(path) || a.filter !== null || a.workingTreeEncoding !== null) return verdict(3, null, null);
  const lang = languageOf(path);
  if (lang !== null && decodable && grammarOk(lang)) return verdict(4, lang, null);
  const reason = lang === null ? 'no_grammar' : !decodable ? 'not_utf8' : 'grammar_unavailable';
  return verdict(lineArray(blob).length <= GRAMMARLESS_WHOLE_FILE_MAX_LINES ? 5 : 6, null, reason);
}
