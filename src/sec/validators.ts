// SEC-35 subset: the deterministic validators the fold and the data layer share.
// Every predicate is pure and decides on the string alone.

const MAX_PATH_BYTES = 4096;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Syntactic part of `validPath` (SEC-35): repo-relative POSIX, NFC, non-empty components, no `..`
 * component, no leading `/`, no drive letter and no `:` (so no `C:/x`), no `\`, no NUL, at most
 * 4,096 UTF-8 bytes. Evaluable on the path string alone, so every peer classifies a path identically.
 */
export function validPathSyntax(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.includes('\0') || p.includes('\\') || p.includes(':') || p.startsWith('/')) return false;
  if (LONE_SURROGATE.test(p)) return false;
  if (Buffer.byteLength(p, 'utf8') > MAX_PATH_BYTES) return false;
  if (p.normalize('NFC') !== p) return false;
  for (const component of p.split('/')) {
    if (component.length === 0 || component === '..') return false;
  }
  return true;
}

export type IdKind = 'op' | 'ulid' | 'cs' | 'hex128';

const HEX128 = /^[0-9a-f]{32}$/;
const SEQ = /^[1-9][0-9]*$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function validOpId(s: string): boolean {
  const parts = s.split('/');
  return parts.length === 3 && HEX128.test(parts[0] ?? '') && HEX128.test(parts[1] ?? '') && SEQ.test(parts[2] ?? '');
}

/** `<seat_id>/<turn-seq>` or `<peer_id>/human/<n>`; ids are 128-bit lowercase hex, counters positive decimals. */
function validCsId(s: string): boolean {
  const parts = s.split('/');
  if (parts.length === 2) return HEX128.test(parts[0] ?? '') && SEQ.test(parts[1] ?? '');
  if (parts.length === 3) return HEX128.test(parts[0] ?? '') && parts[1] === 'human' && SEQ.test(parts[2] ?? '');
  return false;
}

/** The glossary §2/§7 id formats: op id, ULID, change-set id, 128-bit lowercase hex. */
export function validId(kind: IdKind, s: string): boolean {
  if (typeof s !== 'string') return false;
  switch (kind) {
    case 'op': return validOpId(s);
    case 'ulid': return ULID.test(s);
    case 'cs': return validCsId(s);
    case 'hex128': return HEX128.test(s);
  }
}

const NAME = /^[\p{L}\p{M}\p{N}_ .'-]{1,64}$/u;

/** `[\p{L}\p{M}\p{N}_ .'-]{1,64}`; otherwise renderers show `peer-<first 6 of peer_id>`. */
export function validName(s: string): boolean {
  return typeof s === 'string' && NAME.test(s);
}
