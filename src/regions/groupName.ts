// The group-name addition (04-regions §3.12; REG-17, REG-14; T-REG-10): labels may add a conflict, never clear one. For C#
// methods, constructors, operators and indexers and for TypeScript function overload sets, a change that adds a member whose
// (type qualname, simple) equals that of a member covered by a foreign claim touches the claim with no range overlap (overload
// resolution changes; CS0111). Never Python or JavaScript: an @overload stub or a getter beside a held setter raises nothing
// (VERIFIED rc_touch R2); a merged duplicate there is the label-count tripwire's. Pure; the inputs come from this daemon's own
// tables, and which sibling partial files to look at is the caller's orchestration (partial.ts supplies the facts).
import type { Language, Unit } from './types.js';

export interface PartialTypeInfo { readonly simpleName: string; readonly files: readonly string[]; readonly failed: boolean; }

/** 04 §3.12's C# members: each overload its own unit (label-convention/1 gives simple = the CLR name: op_Addition, Item, the type's name for a constructor). */
const CS_GROUP_KINDS: ReadonlySet<string> = new Set(['method', 'ctor', 'operator', 'indexer']);

/** A unit whose label failed SEC-35 is unlabeled ({kind, '', '', '', ''}, Task 4 ruling): it never matches. */
const labeled = (u: Unit): boolean => u.label.qualname !== '' && u.label.simple !== '';

const sameGroup = (a: Unit, b: Unit): boolean => a.label.type === b.label.type && a.label.simple === b.label.simple;

function csHit(added: readonly Unit[], claimed: readonly Unit[]): boolean {
  const members = claimed.filter((c) => CS_GROUP_KINDS.has(c.kind) && labeled(c));
  return added.some((a) => CS_GROUP_KINDS.has(a.kind) && labeled(a) && members.some((c) => sameGroup(a, c)));
}

/** A TypeScript overload set is one unit with disc 'overload' (label-convention/1); a same-name function joining or extending a claimed set hits. */
function tsHit(added: readonly Unit[], claimed: readonly Unit[]): boolean {
  const fns = claimed.filter((c) => c.kind === 'function' && labeled(c));
  return added.some((a) => a.kind === 'function' && labeled(a)
    && fns.some((c) => sameGroup(a, c) && (a.label.disc === 'overload' || c.label.disc === 'overload')));
}

/** C# methods, constructors, operators and indexers and TypeScript function overload sets only: a unit the hunk adds whose (type qualname, simple) equals a member covered by the claim in this daemon's own table, or a member of a partial part of that type; never Python or JavaScript.
 *  hunk is used only for the 04 §3.12 failure fallback: when partial?.failed and lang === 'c_sharp', the hunk also hits when hunk.path ∈ partial.files or
 *  hunk.fileDeclaresPartial (labels add, never clear: a (type, simple) hit stands beside the fallback), and without a hunk to place a failed grep hits (P2). */
export function groupNameHit(lang: Language, added: readonly Unit[], claimed: readonly Unit[], partial: PartialTypeInfo | null, hunk?: { path: string; fileDeclaresPartial: boolean }): boolean {
  switch (lang) {
    case 'python':
    case 'javascript':
      return false;
    case 'typescript':
    case 'tsx':
      return tsHit(added, claimed);
    case 'c_sharp': {
      if (csHit(added, claimed)) return true;
      if (partial === null || !partial.failed) return false;
      return hunk === undefined || partial.files.includes(hunk.path) || hunk.fileDeclaresPartial;
    }
  }
}
