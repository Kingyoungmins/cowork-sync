// The interface check's pure parts (04-regions §3.10; REG-26, REG-27). Task 1 declares CallArgs, Site and SiteSet as
// types only, because the RegionJob union's 'sites' output needs them before Task 7; Task 7 adds the rest of the module:
// the stoplist and the hit cap (glossary §20 "Region numbers"), the per-unit classifier (net over the CS, base versus ours,
// never per edit; a rename is a removal plus an addition), arity compatibility, JSON key paths, and the result types of
// interfaceCheck (src/regions/interfaceService.ts).
// C# SigSlice.overloadKey = <type qualname> + '\0' + <simple>.
import { decodeStrict } from './lines.js';
import type { Label, Language, ParamSlice, SigSlice, Unit } from './types.js';

export interface CallArgs { readonly positional: number; readonly keywords: readonly string[]; readonly splat: boolean; }
export interface Site { readonly path: string; readonly line: number; readonly name: string; readonly kind: 'call' | 'import' | 'identifier'; readonly receiver: 'bare' | 'self' | 'module' | 'type' | 'other'; readonly module: string | null; readonly args: CallArgs | null; readonly inComment: boolean; readonly inString: boolean; }
export interface SiteSet { readonly sites: readonly Site[]; }

/** 04 §3.10 "Note-only cases", glossary §20 "Region numbers": names whose callers produce a note only. */
export const CALLER_STOPLIST: ReadonlySet<string> = new Set(['get', 'set', 'run', 'main', 'init', '__init__', 'update', 'load', 'save', 'close']);
/** More hits than this for one name produce a note only (glossary §20 "Region numbers"). */
export const MAX_HITS_PER_NAME = 50;

export type ChangeClass = 'breaking' | 'compatible' | 'note';
export type BreakingKind = 'removed' | 'param_removed' | 'param_reordered' | 'param_renamed' | 'required_added' | 'varargs_removed' | 'overload_gone';
export interface Breaking { readonly path: string; readonly label: Label; readonly name: string; readonly kind: BreakingKind; readonly removal: boolean; }

type Verdict = { cls: ChangeClass; breaking: BreakingKind | null };
const breaking = (k: BreakingKind): Verdict => ({ cls: 'breaking', breaking: k });
const COMPATIBLE = (): Verdict => ({ cls: 'compatible', breaking: null });
const NOTE = (): Verdict => ({ cls: 'note', breaking: null });

type PySlice = Extract<SigSlice, { lang: 'python'; unit: 'function' }>;
type JsSlice = Extract<SigSlice, { lang: 'javascript' | 'typescript' | 'tsx' }>;
type CsSlice = Extract<SigSlice, { lang: 'c_sharp' }>;

const isJs = (s: SigSlice): s is JsSlice => s.lang === 'javascript' || s.lang === 'typescript' || s.lang === 'tsx';
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** A parameter's comparison name: its name, or its destructured names for a pattern. */
const paramName = (p: ParamSlice): string => (p.name !== '' || p.destructured === null ? p.name : `{${p.destructured.join(',')}}`);

/** The positional parameter list's break, if any: names removed, reordered or renamed (an appended parameter is not one). */
function positionalBreak(before: readonly string[], after: readonly string[]): BreakingKind | null {
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i++) {
    if (before[i] === after[i]) continue;
    const removed = before.filter((x) => !after.includes(x));
    const added = after.filter((x) => !before.includes(x));
    if (removed.length === 0) return 'param_reordered';   // the same names (or new ones inserted before old ones) at other positions
    if (added.length === 0 || removed.length > added.length) return 'param_removed';
    return 'param_renamed';
  }
  return before.length > after.length ? 'param_removed' : null;
}

/** A default value changed on a parameter both sides have. */
function defaultChanged(before: readonly ParamSlice[], after: readonly ParamSlice[]): boolean {
  return before.some((p) => {
    const q = after.find((x) => paramName(x) === paramName(p) && x.kind === p.kind);
    return q !== undefined && p.hasDefault && q.hasDefault && p.default !== q.default;
  });
}

function classifyPython(b: PySlice, o: PySlice): Verdict {
  const positional = (s: PySlice): string[] => s.params.filter((p) => p.kind === 'posonly' || p.kind === 'pos').map(paramName);
  const pos = positionalBreak(positional(b), positional(o));
  if (pos !== null) return breaking(pos);
  const has = (s: PySlice, k: ParamSlice['kind']): boolean => s.params.some((p) => p.kind === k);
  // a name callers could pass by keyword that the new signature no longer takes (and no **kwargs catches)
  const keywords = (s: PySlice): string[] => s.params.filter((p) => p.kind === 'pos' || p.kind === 'kwonly').map((p) => p.name);
  const after = new Set(keywords(o));
  if (!has(o, 'varkw') && keywords(b).some((n) => !after.has(n))) return breaking('param_removed');
  for (const p of o.params) {
    if ((p.kind !== 'posonly' && p.kind !== 'pos' && p.kind !== 'kwonly') || p.hasDefault) continue;
    const q = b.params.find((x) => x.name === p.name);
    if (q === undefined || q.hasDefault) return breaking('required_added');
  }
  if ((has(b, 'varargs') && !has(o, 'varargs')) || (has(b, 'varkw') && !has(o, 'varkw'))) return breaking('varargs_removed');
  if (!sameList(b.decorators, o.decorators) || defaultChanged(b.params, o.params)) return NOTE();
  return COMPATIBLE();
}

/** JS/TS: [required, max] of a parameter list; required counts up to the last required parameter, max is ∞ with a rest. */
function jsRange(ps: readonly ParamSlice[]): [number, number] {
  let required = 0;
  ps.forEach((p, i) => {
    if (p.kind !== 'rest' && !p.hasDefault) required = i + 1;
  });
  return [required, ps.some((p) => p.kind === 'rest') ? Number.POSITIVE_INFINITY : ps.length];
}

function classifyJs(b: JsSlice, o: JsSlice): Verdict {
  if (b.exported && (!o.exported || o.exportName !== b.exportName)) return breaking('removed');   // an export removed or renamed
  if (b.params === null || o.params === null) return COMPATIBLE();
  const names = (ps: readonly ParamSlice[]): string[] => ps.filter((p) => p.kind !== 'rest').map(paramName);
  const pos = positionalBreak(names(b.params), names(o.params));
  if (pos !== null) return breaking(pos);
  if (jsRange(o.params)[0] > jsRange(b.params)[0]) return breaking('required_added');
  if (b.params.some((p) => p.kind === 'rest') && !o.params.some((p) => p.kind === 'rest')) return breaking('varargs_removed');
  return defaultChanged(b.params, o.params) ? NOTE() : COMPATIBLE();
}

/** C#: whether a parameter list accepts every call the old one accepted (count range and names; types unchecked in v1). */
function csAcceptsOld(oldPs: readonly ParamSlice[], newPs: readonly ParamSlice[]): boolean {
  const range = (ps: readonly ParamSlice[]): [number, number] => [
    ps.filter((p) => p.kind !== 'params' && !p.hasDefault).length,
    ps.some((p) => p.kind === 'params') ? Number.POSITIVE_INFINITY : ps.length,
  ];
  const [oldReq, oldMax] = range(oldPs);
  const [newReq, newMax] = range(newPs);
  if (newReq > oldReq || newMax < oldMax) return false;
  return oldPs.every((p, i) => p.kind === 'params' || newPs[i]?.name === p.name);
}

function classifyCs(b: CsSlice, o: CsSlice): Verdict {
  if (b.isPrivate) return COMPATIBLE();   // the slice covers non-private members only
  if (o.isPrivate || b.overloadKey !== o.overloadKey) return breaking('removed');
  if (!csAcceptsOld(b.params, o.params)) return breaking('overload_gone');
  return defaultChanged(b.params, o.params) ? NOTE() : COMPATIBLE();
}

/** A unit's shape: its kind, except that JS/TS spells two shapes with two kinds each (Task 4's const kind) — a callable
 *  (`function f(…)`, a TS overload set, or a const bound to a function: it has a parameter list) and a class (`class C`, or a
 *  const bound to a class expression: no parameter list). */
function shapeOf(x: Unit): string {
  const s = x.sigSlice;
  if (s === null || !isJs(s)) return x.kind;
  if (x.kind === 'class' || (x.kind === 'const' && s.params === null)) return 'js-class';
  return x.kind === 'function' || x.kind === 'const' ? 'js-callable' : x.kind;
}

/**
 * Whether `ours` can carry `base`'s name on, so the two are classified by their slices (04 §3.10 "a unit or export removed"): the
 * same shape (shapeOf: the same unit kind, with `function f(…)` / `const f = (…) => …` and `class C` / `const C = class …` alike).
 * A function that now names a value, a class or a property (or the reverse) is the old unit removed, like the removal half of a
 * rename (P2: never a compatible change).
 */
export function sameUnitShape(base: Unit, ours: Unit): boolean {
  return shapeOf(base) === shapeOf(ours);
}

/**
 * Net per unit over the whole CS (base vs ours), never per edit; a rename is a removal plus an addition (the caller pairs units
 * by label, so a renamed unit arrives here as (old, null) and (null, new)). A removed unit is breaking, and so is a unit whose
 * name now belongs to another kind of unit (sameUnitShape); an added one is compatible;
 * a changed one by its signature slices (04 §3.10 "Classes"): a positional parameter removed, reordered or renamed, a new
 * required parameter, *args/**kwargs (a JS rest) removed, a JS/TS export removed, or a C# parameter list that no longer accepts
 * the old calls is breaking; a decorator or default-value change is a note; anything else (body-only, an appended optional
 * parameter, an optional keyword-only one, a private C# member, a class or module slice) is compatible.
 */
export function classifyUnit(base: Unit | null, ours: Unit | null): { cls: ChangeClass; breaking: BreakingKind | null } {
  if (ours === null) return base === null ? COMPATIBLE() : breaking('removed');
  if (base === null) return COMPATIBLE();
  if (!sameUnitShape(base, ours)) return breaking('removed');
  const b = base.sigSlice;
  const o = ours.sigSlice;
  if (b === null || o === null) return COMPATIBLE();
  if (b.lang === 'c_sharp' && o.lang === 'c_sharp') return classifyCs(b, o);
  if (b.lang === 'python' && o.lang === 'python') return b.unit === 'function' && o.unit === 'function' ? classifyPython(b, o) : COMPATIBLE();
  if (isJs(b) && isJs(o)) return classifyJs(b, o);
  return COMPATIBLE();
}

function pythonAccepts(ps: readonly ParamSlice[], args: CallArgs): boolean {
  const positional = ps.filter((p) => p.kind === 'posonly' || p.kind === 'pos');
  const varargs = ps.some((p) => p.kind === 'varargs');
  const varkw = ps.some((p) => p.kind === 'varkw');
  if (args.positional > positional.length && !varargs) return false;
  const bound = new Set(positional.slice(0, args.positional).map((p) => p.name));
  for (const k of args.keywords) {
    const p = ps.find((x) => x.name === k && (x.kind === 'pos' || x.kind === 'kwonly'));
    if (p === undefined) {
      if (!varkw) return false;
      continue;
    }
    if (bound.has(k)) return false;
    bound.add(k);
  }
  return ps.every((p) => (p.kind !== 'posonly' && p.kind !== 'pos' && p.kind !== 'kwonly') || p.hasDefault || bound.has(p.name));
}

function csAccepts(ps: readonly ParamSlice[], args: CallArgs): boolean {
  const fixed = ps.filter((p) => p.kind !== 'params');
  if (args.positional > fixed.length && !ps.some((p) => p.kind === 'params')) return false;
  const bound = new Set(fixed.slice(0, args.positional).map((p) => p.name));
  for (const k of args.keywords) {
    if (!ps.some((p) => p.name === k) || bound.has(k)) return false;
    bound.add(k);
  }
  return fixed.every((p) => p.hasDefault || bound.has(p.name));
}

/**
 * 04 §3.10 "Arity compatibility": Python — required positional parameters satisfied, no surplus positional without *args, every
 * keyword exists (and is not given twice) unless **kwargs; JS/TS — required ≤ count ≤ max without a rest parameter; C# — some
 * overload in `sigs` covers the argument count and every named argument (types are not checked in v1). A call with a splat
 * (`*x`, `**x`, `...x`) is 'note'. A slice that carries no parameter list (a class, a module, a TS overload set) cannot refute a
 * call: true.
 */
export function arityCompatible(lang: Language, sigs: readonly SigSlice[], args: CallArgs): boolean | 'note' {
  if (args.splat) return 'note';
  if (sigs.length === 0) return true;
  for (const s of sigs) {
    if (lang === 'python') {
      if (s.lang !== 'python' || s.unit !== 'function' || pythonAccepts(s.params, args)) return true;
    } else if (lang === 'c_sharp') {
      if (s.lang !== 'c_sharp' || csAccepts(s.params, args)) return true;
    } else {
      if (!isJs(s) || s.params === null) return true;
      const [required, max] = jsRange(s.params);
      if (args.positional >= required && args.positional <= max) return true;
    }
  }
  return false;
}

/** 04 §3.10: a JSON key-path change is a note in v1. Sorted dot paths, `[]` for array elements; null when the blob is not UTF-8 JSON. */
export function jsonKeyPaths(blob: Buffer): readonly string[] | null {
  const text = decodeStrict(blob);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\u{feff}/u, ''));
  } catch {
    return null;
  }
  const out = new Set<string>();
  const walk = (v: unknown, prefix: string): void => {
    if (Array.isArray(v)) {
      for (const e of v) walk(e, `${prefix}[]`);
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const p = prefix === '' ? k : `${prefix}.${k}`;
        out.add(p);
        walk(x, p);
      }
    }
  };
  walk(value, '');
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** line = the 1-based row in out of the call or import (F14). */
export interface Finding { readonly path: string; readonly line: number; readonly name: string; readonly removal: boolean; }
export interface InterfaceResult {
  readonly breaking: readonly Breaking[];
  readonly incompatibleCallers: readonly Finding[];   // definite calls not written by this CS
  readonly orphanCalls: readonly Finding[];
  readonly unresolvedImports: readonly Finding[];
  readonly notes: ReadonlyArray<{ readonly path: string; readonly line: number | null; readonly kind: 'possible' | 'too_many_hits' | 'stoplist' | 'json_key' | 'decorator' | 'default_value' | 'splat' }>;
  readonly incomplete: boolean;
  /** R4-72: which deadline stopped an incomplete check — 'grep' = the caller search's own 4× stop (deadline('caller_grep', 4), 600 ms), 'caller' = the deadline the caller passed
   *  (T0's 2,000 ms, the edit check's 500 ms) or an aborted grep; null when complete. */
  readonly incompleteBudget: 'grep' | 'caller' | null;
  readonly symbolDelta: { readonly added: readonly Label[]; readonly signatureChanged: readonly Label[] };          // HLD-48/49 (05 §8 Q2 default)
  readonly referencedNames: { readonly identifiers: readonly string[]; readonly imports: readonly string[] };
}
