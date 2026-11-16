// Region tables (04-regions §3.3 "Units per language", extent-convention/1, label-convention/1, "Error spans"; §3.13 <imports>;
// REG-05, REG-16, INV-REG-PARTITION; rulings R4-18, R4-19). buildTable turns one parse tree into the table of its blob:
// cowork's query (src/regions/queries/*, the fixed capture names only) marks the unit candidates and their names, wrappers,
// comments, import-class nodes, IIFE wrappers and branches; the structure — which candidate is a unit (top level, a class
// body, a namespace, a branch, an IIFE body) and which folds into its named ancestor — is decided here, and every row is
// read through lineTable. blockTable is the class-6 table: the blank-line blocks of the raw 0x0A split, no decoding.
//
// The unit model (§Interfaces, Unit): a class/type contributes one non-leaf unit (its extent) and one residue leaf unit
// (the extent minus its members' extents); functions, methods, consts and gap blocks are leaf units. Leaf units, <imports>
// and gap blocks are pairwise row-disjoint by construction: siblings are placed in row order and a unit never starts at or
// above the last row of the sibling before it (a unit squeezed out by a one-row neighbour folds into that neighbour), a
// member never starts on its type's first row (so a residue is never empty), units never overlap <imports>, and gap blocks
// are the non-blank rows left over. Unit.sigSlice comes from slices.ts (Task 7): every function, method, class (its residue too),
// JS/TS const and C# member carries one; Python's `__all__` const carries the module slice; other consts and blocks carry null.
import { Query, type Node, type Tree } from 'web-tree-sitter';
import { decodeStrict, isBlankRow, lineArray, normalizeRanges } from '../lines.js';
import { QUERY_SOURCES } from '../queries/index.js';
import { labelKey, type Label, type Language, type Range, type Ranges, type RegionTable, type RegionUnitKind, type SigSlice, type Unit } from '../types.js';
import { csharpConversionName, csharpOperatorName, VALID_LABEL_FIELD } from './conventions.js';
import { ownsRows, rowsOf } from './lineTable.js';
import { csSlice, csType, jsExportClauses, jsSlice, pyClassSlice, pyFunctionSlice, pyModuleSlice, UPPER_NAME } from './slices.js';

type Deadline = { expired(): boolean } | null;

/** Thrown inside a build when its deadline expires; buildTable answers 'deadline'. */
class DeadlineHit extends Error {}

type UnitCapture = 'function' | 'class' | 'method' | 'const' | 'type' | 'ctor' | 'dtor' | 'property' | 'indexer' | 'event' | 'field' | 'operator';
type Flag = 'decorator' | 'attribute' | 'export' | 'signature' | 'comment' | 'import' | 'iife' | 'branch';
const UNIT_CAPTURES: ReadonlySet<string> = new Set<UnitCapture>(['function', 'class', 'method', 'const', 'type', 'ctor', 'dtor', 'property', 'indexer', 'event', 'field', 'operator']);
const FLAGS: ReadonlySet<string> = new Set<Flag>(['decorator', 'attribute', 'export', 'signature', 'comment', 'import', 'iife', 'branch']);

interface Captures {
  /** Unit candidates by node id, with the first @name of their match. */
  readonly units: Map<number, { readonly kind: UnitCapture; readonly name: Node | null }>;
  /** TS function signatures by node id, with their @name. */
  readonly signatures: Map<number, Node | null>;
  readonly flags: Map<number, Set<Flag>>;
  readonly comments: Node[];
}

/** One compiled query per grammar object of this realm (the grammars themselves are cached per realm by parser.ts). */
const QUERIES = new WeakMap<object, Query>();

function queryFor(tree: Tree, lang: Language): Query {
  let q = QUERIES.get(tree.language);
  if (q === undefined) {
    q = new Query(tree.language, QUERY_SOURCES[lang]);
    QUERIES.set(tree.language, q);
  }
  return q;
}

function captures(q: Query, root: Node, deadline: Deadline): Captures {
  const c: Captures = { units: new Map(), signatures: new Map(), flags: new Map(), comments: [] };
  const matches = q.matches(root, deadline === null ? undefined : { progressCallback: () => deadline.expired() });
  if (deadline !== null && deadline.expired()) throw new DeadlineHit();
  for (const m of matches) {
    let unit: { kind: UnitCapture; node: Node } | null = null;
    let signature: Node | null = null;
    let name: Node | null = null;
    for (const cap of m.captures) {
      if (cap.name === 'name') name ??= cap.node;
      else if (cap.name.startsWith('unit.') && UNIT_CAPTURES.has(cap.name.slice(5))) unit = { kind: cap.name.slice(5) as UnitCapture, node: cap.node };
      else if (cap.name === 'signature') signature = cap.node;
      else if (FLAGS.has(cap.name)) {
        let set = c.flags.get(cap.node.id);
        if (set === undefined) {
          set = new Set();
          c.flags.set(cap.node.id, set);
        }
        set.add(cap.name as Flag);
        if (cap.name === 'comment') c.comments.push(cap.node);
      }
    }
    if (unit !== null && !c.units.has(unit.node.id)) c.units.set(unit.node.id, { kind: unit.kind, name });
    if (signature !== null && !c.signatures.has(signature.id)) c.signatures.set(signature.id, name);
  }
  return c;
}

const has = (c: Captures, n: Node | null, f: Flag): boolean => n !== null && c.flags.get(n.id)?.has(f) === true;

/** A declared name as a label field: no whitespace, string-literal keys without their quotes. */
function nameText(n: Node | null): string {
  if (n === null) return '';
  const t = n.text.replace(/\s+/gu, '');
  return /^(['"`]).*\1$/su.test(t) ? t.slice(1, -1) : t;
}

const join = (prefix: string, name: string): string => (prefix === '' ? name : `${prefix}.${name}`);

/** A unit candidate placed in a container: the rows come from `outer` (start, extent-convention/1 step 1) and `last` (end). */
interface Piece {
  readonly kind: RegionUnitKind;
  readonly outer: Node;
  readonly last: Node;
  /** Members start below this row (a type's declaration row; 0 for a non-container). */
  readonly header: number;
  readonly qualname: string;
  readonly simple: string;
  readonly type: string;
  disc: string;
  readonly branch: { readonly group: number; readonly index: number } | null;
  /** Container (class/type) members; null for a leaf. */
  readonly members: Piece[] | null;
}

// ---- Python ---------------------------------------------------------------------------------------------------------------

/** A def / class (decorated or not) as a unit: a method when it sits in a class body (type ≠ ''). */
function pyDef(n: Node, c: Captures, prefix: string, type: string, branch: Piece['branch']): Piece | null {
  const decl = n.type === 'decorated_definition' ? n.childForFieldName('definition') : n;
  if (decl === null) return null;
  const u = c.units.get(decl.id);
  if (u === undefined || (u.kind !== 'function' && u.kind !== 'class')) return null;
  const simple = nameText(u.name);
  const qualname = join(prefix, simple);
  if (u.kind === 'function') {
    return { kind: type === '' ? 'function' : 'method', outer: n, last: n, header: 0, qualname, simple, type, disc: pyDisc(n), branch, members: null };
  }
  const body = decl.childForFieldName('body');
  const members: Piece[] = [];
  for (const m of body?.namedChildren ?? []) {
    const p = pyDef(m, c, qualname, qualname, null);
    if (p !== null) members.push(p);
  }
  return { kind: 'class', outer: n, last: n, header: rowsOf(decl)[0], qualname, simple, type, disc: '', branch, members };
}

/** label-convention/1: `@x.setter` → setter, `@x.deleter` → deleter; any other decorator (a `@property` getter) → ''. */
function pyDisc(n: Node): string {
  if (n.type !== 'decorated_definition') return '';
  for (const d of n.namedChildren) {
    if (d.type !== 'decorator') continue;
    const m = /\.(setter|deleter)$/u.exec(d.text.replace(/\s+/gu, ''));
    if (m !== null) return m[1] as string;
  }
  return '';
}

/** A module-level `NAME = …` / `NAME: T = …` with a single identifier target (a chained `a = b = …` is not one). */
function pyConst(n: Node, c: Captures): Piece | null {
  const u = c.units.get(n.id);
  if (u === undefined || u.kind !== 'const' || n.namedChildCount !== 1) return null;
  const right = n.namedChildren[0]?.childForFieldName('right');
  if (right === null || right === undefined || right.type === 'assignment') return null;
  const simple = nameText(u.name);
  return { kind: 'const', outer: n, last: n, header: 0, qualname: simple, simple, type: '', disc: '', branch: null, members: null };
}

/** The defs and classes of each branch of a module-level `if` (if = 0, each elif, else last). */
function pyBranches(n: Node, c: Captures, out: Piece[]): void {
  const blocks: Node[] = [];
  const first = n.childForFieldName('consequence');
  if (first !== null) blocks.push(first);
  for (const alt of n.childrenForFieldName('alternative')) {
    const b = alt.childForFieldName(alt.type === 'elif_clause' ? 'consequence' : 'body');
    if (b !== null) blocks.push(b);
  }
  blocks.forEach((b, index) => {
    for (const m of b.namedChildren) {
      const p = pyDef(m, c, '', '', { group: n.id, index });
      if (p !== null) out.push(p);
    }
  });
}

function pythonPieces(root: Node, c: Captures): Piece[] {
  const out: Piece[] = [];
  for (const n of root.namedChildren) {
    if (has(c, n, 'branch')) {
      pyBranches(n, c, out);
      continue;
    }
    const p = pyDef(n, c, '', '', null) ?? pyConst(n, c);
    if (p !== null) out.push(p);
  }
  return out;
}

// ---- JavaScript, TypeScript, TSX --------------------------------------------------------------------------------------------

const FUNCTION_VALUES: ReadonlySet<string> = new Set(['function_expression', 'arrow_function', 'generator_function', 'function']);

/** JS/TS accessor discriminator: the anonymous `get` / `set` token of a method_definition. */
function accessor(m: Node): string {
  for (const ch of m.children) {
    if (!ch.isNamed && (ch.type === 'get' || ch.type === 'set')) return ch.type;
  }
  return '';
}

/** The method_definition members of a class body. */
function jsClassMembers(body: Node | null, c: Captures, qualname: string): Piece[] {
  const out: Piece[] = [];
  for (const m of body?.namedChildren ?? []) {
    const u = c.units.get(m.id);
    if (m.type !== 'method_definition' || u === undefined) continue;
    const simple = nameText(u.name);
    out.push({ kind: 'method', outer: m, last: m, header: 0, qualname: join(qualname, simple), simple, type: qualname, disc: accessor(m), branch: null, members: null });
  }
  return out;
}

/** The methods and function-valued pairs of an object literal bound at top level to `obj` (qualname obj.name). */
function jsObjectMembers(obj: Node, c: Captures, binding: string): Piece[] {
  const out: Piece[] = [];
  for (const m of obj.namedChildren) {
    const u = c.units.get(m.id);
    if (u === undefined || u.kind !== 'method') continue;
    const simple = nameText(u.name);
    out.push({ kind: 'method', outer: m, last: m, header: 0, qualname: join(binding, simple), simple, type: '', disc: m.type === 'method_definition' ? accessor(m) : '', branch: null, members: null });
  }
  return out;
}

/** A class as a container (non-leaf unit, residue and methods); kind 'const' when a const/let/var declarator binds it (04 §3.3 JS/TS row). */
function jsClass(outer: Node, last: Node, cls: Node, c: Captures, simple: string, kind: 'class' | 'const' = 'class'): Piece {
  return { kind, outer, last, header: rowsOf(cls)[0], qualname: simple, simple, type: '', disc: '', branch: null, members: jsClassMembers(cls.childForFieldName('body'), c, simple) };
}

/** The pieces of one top-level declaration (export-wrapped or not). */
function jsDecl(n: Node, c: Captures): Piece[] {
  let outer = n;
  let d: Node = n;
  if (n.type === 'export_statement') {
    const declaration = n.childForFieldName('declaration');
    if (declaration !== null) d = declaration;
    else {
      // export default <function | class>: named by its own name, else 'default'
      const value = n.childForFieldName('value');
      if (value === null) return [];
      const simple = nameText(value.childForFieldName('name')) || 'default';
      if (FUNCTION_VALUES.has(value.type)) return [{ kind: 'function', outer: n, last: n, header: 0, qualname: simple, simple, type: '', disc: '', branch: null, members: null }];
      if (value.type === 'class') return [jsClass(n, n, value, c, simple)];
      return [];
    }
  }
  const u = c.units.get(d.id);
  switch (d.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      if (u === undefined) return [];
      const simple = nameText(u.name);
      return [{ kind: 'function', outer, last: outer, header: 0, qualname: simple, simple, type: '', disc: '', branch: null, members: null }];
    }
    case 'class_declaration':
    case 'abstract_class_declaration':
      return u === undefined ? [] : [jsClass(outer, outer, d, c, nameText(u.name))];
    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration': {
      if (u === undefined) return [];
      const simple = nameText(u.name);
      return [{ kind: 'type', outer, last: outer, header: rowsOf(d)[0], qualname: simple, simple, type: '', disc: '', branch: null, members: [] }];
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      const declarators = d.namedChildren.filter((x) => x.type === 'variable_declarator');
      const only = declarators.length === 1 ? declarators[0] : undefined;
      if (only === undefined) return [];
      // 04 §3.3 JS/TS row: a single declarator bound to an arrow function, a function expression or a class is a unit of kind
      // const (the query marks the candidate @unit.function / @unit.class; the kind is decided here). A class-valued one keeps
      // the class structure: its non-leaf unit and residue are kind const, its methods are methods of the bound name.
      const du = c.units.get(only.id);
      const value = only.childForFieldName('value');
      if (du !== undefined && du.kind === 'function') {
        const simple = nameText(du.name);
        return [{ kind: 'const', outer, last: outer, header: 0, qualname: simple, simple, type: '', disc: '', branch: null, members: null }];
      }
      if (du !== undefined && du.kind === 'class' && value !== null) return [jsClass(outer, outer, value, c, nameText(du.name), 'const')];
      const name = only.childForFieldName('name');
      if (value !== null && value.type === 'object' && name !== null && name.type === 'identifier') return jsObjectMembers(value, c, nameText(name));
      return [];
    }
    case 'expression_statement': {
      const e = d.namedChildren[0];
      if (e === undefined || e.type !== 'assignment_expression') return [];
      const left = e.childForFieldName('left');
      const right = e.childForFieldName('right');
      if (left === null || right === null || right.type !== 'object' || (left.type !== 'identifier' && left.type !== 'member_expression')) return [];
      return jsObjectMembers(right, c, nameText(left));
    }
    default:
      return [];
  }
}

/** The function_signature a node is or wraps (`export function f(…): T;`), with its name. */
function signatureOf(n: Node, c: Captures): { sig: Node; name: string } | null {
  const s = n.type === 'export_statement' ? n.childForFieldName('declaration') : n;
  if (s === null || s.type !== 'function_signature' || !c.signatures.has(s.id)) return null;
  return { sig: s, name: nameText(c.signatures.get(s.id) ?? null) };
}

/** The name of the function_declaration a node is or wraps. */
function implementationName(n: Node, c: Captures): string | null {
  const d = n.type === 'export_statement' ? n.childForFieldName('declaration') : n;
  if (d === null || d.type !== 'function_declaration') return null;
  const u = c.units.get(d.id);
  return u === undefined ? null : nameText(u.name);
}

/** The bodies an IIFE / UMD wrapper call hands its declarations from: a function callee and function arguments. */
function iifeBodies(call: Node): Node[] {
  const out: Node[] = [];
  const fn = (x: Node | null | undefined): void => {
    let f = x ?? null;
    while (f !== null && f.type === 'parenthesized_expression') f = f.namedChildren[0] ?? null;
    if (f === null || !FUNCTION_VALUES.has(f.type)) return;
    const body = f.childForFieldName('body');
    if (body !== null && body.type === 'statement_block') out.push(body);
  };
  fn(call.childForFieldName('function'));
  for (const a of call.childForFieldName('arguments')?.namedChildren ?? []) fn(a);
  return out;
}

/** A statement list (the program, or an IIFE body treated as top level). */
function jsList(nodes: readonly Node[], c: Captures, out: Piece[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as Node;
    if (n.type === 'comment') continue;
    const sig = signatureOf(n, c);
    if (sig !== null) {
      // an overload set: consecutive same-name signatures (comments between them included), then the implementation
      let lastIndex = i;
      let size = 1;
      for (let j = i + 1; j < nodes.length; j++) {
        const m = nodes[j] as Node;
        if (m.type === 'comment') continue;
        if (signatureOf(m, c)?.name === sig.name) {
          lastIndex = j;
          size++;
          continue;
        }
        if (implementationName(m, c) === sig.name) {
          lastIndex = j;
          size++;
        }
        break;
      }
      out.push({ kind: 'function', outer: n, last: nodes[lastIndex] as Node, header: 0, qualname: sig.name, simple: sig.name, type: '', disc: size > 1 ? 'overload' : '', branch: null, members: null });
      i = lastIndex;
      continue;
    }
    out.push(...jsDecl(n, c));
    const call = n.type === 'expression_statement' ? n.namedChildren[0] : undefined;
    if (call !== undefined && has(c, call, 'iife')) for (const body of iifeBodies(call)) jsList(body.namedChildren, c, out);
  }
}

// ---- C# ---------------------------------------------------------------------------------------------------------------------

/** The normalized parameter type list `(T1,T2)`: ref/out/in kept as `ref:T`, `params` and `this` dropped (CLR signatures). */
function csParams(list: Node | null): string {
  if (list === null) return '()';
  const out: string[] = [];
  const kids = list.children;
  kids.forEach((ch, i) => {
    if (ch.type === 'parameter') {
      const t = ch.childForFieldName('type');
      const mods = ch.namedChildren.filter((m) => m.type === 'modifier' && (m.text === 'ref' || m.text === 'out' || m.text === 'in')).map((m) => m.text);
      const ty = t === null ? '' : csType(t);
      out.push(mods.length > 0 ? `${mods.join(':')}:${ty}` : ty);
    } else if (!ch.isNamed && ch.type === 'params') {
      const t = kids.slice(i + 1).find((k) => k.isNamed);
      if (t !== undefined) out.push(csType(t));
    }
  });
  return `(${out.join(',')})`;
}

const CS_KIND: Readonly<Record<UnitCapture, RegionUnitKind>> = Object.freeze({
  function: 'function', class: 'type', method: 'method', const: 'const', type: 'type', ctor: 'ctor', dtor: 'dtor',
  property: 'property', indexer: 'indexer', event: 'event', field: 'field', operator: 'operator',
});

function csDecl(n: Node, c: Captures, prefix: string, type: string, branch: Piece['branch']): Piece | null {
  const u = c.units.get(n.id);
  if (u === undefined) return null;
  const kind = CS_KIND[u.kind];
  if (kind === 'type') {
    const simple = nameText(u.name);
    const qualname = join(prefix, simple);
    const members: Piece[] = [];
    const body = n.childForFieldName('body');
    if (body !== null && body.type === 'declaration_list') csList(body.namedChildren, c, qualname, qualname, members, null);
    return { kind, outer: n, last: n, header: rowsOf(n.childForFieldName('name') ?? n)[0], qualname, simple, type, disc: '', branch, members };
  }
  let simple: string;
  let disc = '';
  switch (u.kind) {
    case 'dtor':
      simple = 'Finalize';
      disc = csParams(n.childForFieldName('parameters'));
      break;
    case 'indexer':
      simple = 'Item';
      disc = csParams(n.childForFieldName('parameters'));
      break;
    case 'operator': {
      const params = n.childForFieldName('parameters');
      if (n.type === 'conversion_operator_declaration') {
        simple = csharpConversionName(n.children.some((ch) => !ch.isNamed && ch.type === 'explicit') ? 'explicit' : 'implicit');
      } else {
        const arity = (params?.namedChildren ?? []).filter((p) => p.type === 'parameter').length;
        simple = csharpOperatorName(n.childForFieldName('operator')?.type ?? '', arity, n.children.some((ch) => !ch.isNamed && ch.type === 'checked'));
      }
      disc = csParams(params);
      break;
    }
    case 'method':
    case 'ctor':
      simple = nameText(u.name);
      disc = csParams(n.childForFieldName('parameters'));
      break;
    default:   // property, event, field: no discriminator
      simple = nameText(u.name);
  }
  return { kind, outer: n, last: n, header: 0, qualname: join(prefix, simple), simple, type, disc, branch, members: null };
}

/** The declarations of each branch of a `#if` (#if = 0, each #elif, #else last); a nested #if is its own group. */
function csBranches(n: Node, c: Captures, prefix: string, type: string, out: Piece[]): void {
  let node: Node | null = n;
  let index = 0;
  while (node !== null) {
    const condition = node.childForFieldName('condition');
    const alternative: Node | null = node.childForFieldName('alternative');
    const members = node.namedChildren.filter((m) => m.id !== condition?.id && m.id !== alternative?.id);
    csList(members, c, prefix, type, out, { group: n.id, index });
    node = alternative;
    index++;
  }
}

/** A declaration list: the compilation unit, a namespace body, a type body or a branch. prefix = the namespace or type qualname. */
function csList(nodes: readonly Node[], c: Captures, prefix: string, type: string, out: Piece[], branch: Piece['branch']): void {
  let ns = prefix;
  for (const n of nodes) {
    if (n.type === 'file_scoped_namespace_declaration') {
      ns = join(prefix, nameText(n.childForFieldName('name')));
    } else if (n.type === 'namespace_declaration') {
      const body = n.childForFieldName('body');
      if (body !== null) csList(body.namedChildren, c, join(ns, nameText(n.childForFieldName('name'))), '', out, branch);
    } else if (has(c, n, 'branch')) {
      csBranches(n, c, ns, type, out);
    } else {
      const p = csDecl(n, c, ns, type, branch);
      if (p !== null) out.push(p);
    }
  }
}

// ---- Placement, residue, gap blocks, labels -------------------------------------------------------------------------------

interface Placed { readonly piece: Piece; readonly lo: number; readonly hi: number; readonly members: Placed[]; }

interface Rows {
  /** commentStart[r] = the first row of the comment that owns row r (extent-convention/1 step 2); 0 when r is not a comment row. */
  readonly commentStart: Int32Array;
}

/** Step 2: extend a start row upward over contiguous comment rows, never to or above `floor`. */
function extendUp(start: number, floor: number, rows: Rows): number {
  let s = start;
  for (let r = s - 1; r > floor; r = s - 1) {
    const c = rows.commentStart[r] ?? 0;
    if (c === 0 || c <= floor) break;
    s = c;
  }
  return s;
}

/** Places siblings in row order: each starts below `floor` and below the sibling before it; one squeezed out folds into it. */
function place(pieces: readonly Piece[], floor: number, rows: Rows, imports: Range | null): Placed[] {
  const sorted = pieces.map((p, i) => ({ p, i, raw: rowsOf(p.outer)[0] })).sort((a, b) => a.raw - b.raw || a.i - b.i);
  const out: Placed[] = [];
  let prev = floor;
  for (const { p, raw } of sorted) {
    if (imports !== null && raw >= imports[0]) prev = Math.max(prev, imports[1]);
    const hi = rowsOf(p.last)[1];
    const lo = Math.max(extendUp(raw, prev, rows), prev + 1);
    if (lo > hi) continue;
    if (imports !== null && lo <= imports[1] && hi >= imports[0]) continue;
    const members = p.members === null ? [] : place(p.members, Math.max(p.header, lo), rows, null);
    out.push({ piece: p, lo, hi, members });
    prev = hi;
  }
  return out;
}

/** label-convention/1's branch ordinal: a key that repeats in two or more sibling branches gets '#<branch>' on each definition. */
function branchOrdinals(placed: readonly Placed[]): void {
  const all: Piece[] = [];
  const walk = (ps: readonly Placed[]): void => {
    for (const p of ps) {
      all.push(p.piece);
      walk(p.members);
    }
  };
  walk(placed);
  const groups = new Map<number, Map<string, Set<number>>>();
  const key = (p: Piece): string => `${p.kind}\u{0}${p.qualname}\u{0}${p.disc}`;
  for (const p of all) {
    if (p.branch === null) continue;
    let g = groups.get(p.branch.group);
    if (g === undefined) {
      g = new Map();
      groups.set(p.branch.group, g);
    }
    let branches = g.get(key(p));
    if (branches === undefined) {
      branches = new Set();
      g.set(key(p), branches);
    }
    branches.add(p.branch.index);
  }
  const tagged = all.filter((p) => p.branch !== null && (groups.get(p.branch.group)?.get(key(p))?.size ?? 0) >= 2);
  for (const p of tagged) p.disc = `${p.disc}#${(p.branch as { index: number }).index}`;
}

/** A unit before its id: ranges, parent and label. */
interface Draft { kind: RegionUnitKind; label: Label; ranges: Ranges; parent: Draft | null; leaf: boolean; residue: boolean; granularity: 'symbol' | 'block'; sigSlice: SigSlice | null; }

const BLOCK_LABEL: Label = Object.freeze({ kind: 'block', qualname: '', simple: '', type: '', disc: '' });

/** [lo, hi] minus the given closed ranges. */
function subtract(lo: number, hi: number, holes: readonly Range[]): Ranges {
  const out: Array<[number, number]> = [];
  let at = lo;
  for (const [a, b] of normalizeRanges(holes.map(([x, y]) => [x, y] as const))) {
    if (a > at) out.push([at, Math.min(a - 1, hi)]);
    at = Math.max(at, b + 1);
  }
  if (at <= hi) out.push([at, hi]);
  return out;
}

/** label-convention/1 under SEC-35: the label of a piece when every non-empty field passes validLabel's pattern; otherwise the
 *  unit is unlabeled (its kind and four empty fields), never a label with a field SEC-35 would refuse. */
function labelOf(p: Piece): Label {
  const fields = [p.qualname, p.simple, p.type, p.disc];
  const ok = fields.every((f) => f === '' || VALID_LABEL_FIELD.test(f));
  return ok ? { kind: p.kind, qualname: p.qualname, simple: p.simple, type: p.type, disc: p.disc } : { kind: p.kind, qualname: '', simple: '', type: '', disc: '' };
}

/** A unit carries a label when its qualname is non-empty (block units and SEC-35-unlabeled units do not). */
const labelled = (l: Label): boolean => l.qualname !== '';

/** A residue carries its class/type's slice (the same object). */
function emit(placed: readonly Placed[], parent: Draft | null, out: Draft[], sliceOf: (p: Piece) => SigSlice | null): void {
  for (const pl of placed) {
    const p = pl.piece;
    const label = labelOf(p);
    const sigSlice = sliceOf(p);
    if (p.members === null) {
      out.push({ kind: p.kind, label, ranges: [[pl.lo, pl.hi]], parent, leaf: true, residue: false, granularity: 'symbol', sigSlice });
      continue;
    }
    const own: Draft = { kind: p.kind, label, ranges: [[pl.lo, pl.hi]], parent, leaf: false, residue: false, granularity: 'symbol', sigSlice };
    out.push(own);
    out.push({ kind: p.kind, label: { ...label }, ranges: subtract(pl.lo, pl.hi, pl.members.map((m) => [m.lo, m.hi] as const)), parent: own, leaf: true, residue: true, granularity: 'symbol', sigSlice });
    emit(pl.members, own, out, sliceOf);
  }
}

/** Task 7: the signature slice of a piece (04 §3.10; contract addition 3: Python's module slice rides on the `__all__` const). */
function slicer(lang: Language, root: Node, pieces: readonly Piece[]): (p: Piece) => SigSlice | null {
  if (lang === 'python') {
    const upper = pieces.filter((p) => p.kind === 'const' && UPPER_NAME.test(p.simple)).map((p) => p.simple);
    return (p) => {
      if (p.kind === 'function' || p.kind === 'method') return pyFunctionSlice(p.outer);
      if (p.kind === 'class') return pyClassSlice(p.outer);
      return p.kind === 'const' && p.simple === '__all__' ? pyModuleSlice(p.outer, upper) : null;
    };
  }
  if (lang === 'c_sharp') return (p) => csSlice(p.kind, p.outer, p.type, p.simple);
  const exports = jsExportClauses(root);
  return (p) => jsSlice(lang, { kind: p.kind, outer: p.outer, simple: p.simple, disc: p.disc, topLevel: p.type === '' && p.kind !== 'method', classValued: p.members !== null && p.kind !== 'type' }, exports);
}

/** <imports> (04 §3.13): the first run of top-level nodes that starts with an import-class node and continues over import-class
 *  nodes and comments, ending at the last import-class node. */
function importsOf(top: readonly Node[], isImport: (n: Node) => boolean): Range | null {
  const first = top.findIndex(isImport);
  if (first < 0) return null;
  let last = first;
  for (let j = first + 1; j < top.length; j++) {
    const n = top[j] as Node;
    if (isImport(n)) last = j;
    else if (n.type !== 'comment') break;
  }
  return [rowsOf(top[first] as Node)[0], rowsOf(top[last] as Node)[1]];
}

/** Every ERROR and MISSING node's rows (04 §3.3 "Error spans"); only subtrees that hold an error are walked. A MISSING node is
 *  zero-width at the place the parser gave up (an unclosed JS brace gets its MISSING `}` at the end of the file), so its span
 *  is the rows of the construct it is missing from (its parent): the rows a broken tree cannot vouch for. */
function errors(root: Node, deadline: Deadline): { spans: Ranges; count: number } {
  const spans: Array<[number, number]> = [];
  let count = 0;
  if (!root.hasError) return { spans, count };
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    if (n.isError || n.isMissing) {
      spans.push([...rowsOf(n.isMissing ? (n.parent ?? n) : n)]);
      count++;
    }
    if (n.hasError) for (const ch of n.children) stack.push(ch);
    if ((count & 63) === 63 && deadline !== null && deadline.expired()) throw new DeadlineHit();
  }
  return { spans: normalizeRanges(spans), count };
}

function finish(drafts: Draft[], o: { grammar: Language | null; regionSpec: string; decodable: boolean; lineCount: number; imports: Range | null; errorSpans: Ranges; errorCount: number }): RegionTable {
  const order = drafts.map((d, i) => ({ d, i })).sort((a, b) => (a.d.ranges[0]?.[0] ?? 0) - (b.d.ranges[0]?.[0] ?? 0) || Number(a.d.leaf) - Number(b.d.leaf) || a.i - b.i);
  const ids = new Map<Draft, number>();
  order.forEach(({ d }, i) => ids.set(d, i + 1));
  const units: Unit[] = order.map(({ d }) => ({
    unitId: ids.get(d) as number,
    kind: d.kind,
    label: d.label,
    ranges: d.ranges,
    parentUnitId: d.parent === null ? null : (ids.get(d.parent) as number),
    leaf: d.leaf,
    residue: d.residue,
    sigSlice: d.sigSlice,
    granularity: d.granularity,
  }));
  // 04 §3.3 "labelCounts counts each label key": every labelled unit once — a class/type through its residue leaf unit (the
  // non-leaf unit carries the same key and is not counted again), so two same-name classes count 2; block units and
  // SEC-35-unlabeled units carry no label and are not counted.
  const labelCounts: Record<string, number> = {};
  for (const u of units) {
    if (!u.leaf || u.granularity !== 'symbol' || !labelled(u.label)) continue;
    const k = labelKey(u.label);
    labelCounts[k] = (labelCounts[k] ?? 0) + 1;
  }
  return { grammar: o.grammar, regionSpec: o.regionSpec, decodable: o.decodable, lineCount: o.lineCount, units, imports: o.imports, errorSpans: o.errorSpans, errorCount: o.errorCount, labelCounts };
}

/** The gap blocks: maximal runs of non-blank rows outside every placed unit and <imports> (R4-18). */
function gapBlocks(lines: readonly Buffer[], covered: readonly Range[]): Draft[] {
  const taken = new Uint8Array(lines.length + 2);
  for (const [lo, hi] of covered) for (let r = Math.max(1, lo); r <= Math.min(hi, lines.length); r++) taken[r] = 1;
  return blankLineRuns(lines, (r) => taken[r] === 1);
}

/** Maximal runs of non-blank rows not excluded, as block drafts. */
function blankLineRuns(lines: readonly Buffer[], excluded: (row: number) => boolean): Draft[] {
  const out: Draft[] = [];
  let start = 0;
  for (let r = 1; r <= lines.length + 1; r++) {
    const open = r <= lines.length && !excluded(r) && !isBlankRow(lines[r - 1] as Buffer, r);
    if (open && start === 0) start = r;
    if (!open && start !== 0) {
      out.push({ kind: 'block', label: BLOCK_LABEL, ranges: [[start, r - 1]], parent: null, leaf: true, residue: false, granularity: 'block', sigSlice: null });
      start = 0;
    }
  }
  return out;
}

/** The class-6 table (04 §3.3 row 6): the blank-line blocks of the raw 0x0A split; nothing is decoded but the decodable flag. */
export function blockTable(bytes: Buffer, regionSpec: string): RegionTable {
  const lines = lineArray(bytes);
  return finish(blankLineRuns(lines, () => false), { grammar: null, regionSpec, decodable: decodeStrict(bytes) !== null, lineCount: lines.length, imports: null, errorSpans: [], errorCount: 0 });
}

const IMPORT_DECLS: ReadonlySet<string> = new Set(['lexical_declaration', 'variable_declaration']);

/**
 * The class-4 table of one blob from its parse tree (REG-05): units per language, extent-convention/1, label-convention/1,
 * error spans and label counts (over the symbol leaf units). 'deadline' when the deadline expires while the table is built.
 */
export function buildTable(lang: Language, tree: Tree, bytes: Buffer, regionSpec: string, deadline: Deadline): RegionTable | 'deadline' {
  try {
    const root = tree.rootNode;
    const c = captures(queryFor(tree, lang), root, deadline);
    const lines = lineArray(bytes);
    const text = (decodeStrict(bytes) ?? '').split('\n');
    const rowText = (r: number): string => text[r - 1] ?? '';
    const commentStart = new Int32Array(lines.length + 2);
    for (const cm of c.comments) {
      if (!ownsRows(cm, rowText)) continue;
      const [lo, hi] = rowsOf(cm);
      for (let r = lo; r <= hi && r <= lines.length; r++) commentStart[r] = lo;
    }
    const top = root.namedChildren;
    const isImport = (n: Node): boolean => has(c, n, 'import')
      || (IMPORT_DECLS.has(n.type) && n.namedChildren.length > 0
        && n.namedChildren.every((d) => d.type !== 'variable_declarator' || has(c, d.childForFieldName('value'), 'import'))
        && n.namedChildren.some((d) => d.type === 'variable_declarator'));
    const imports = importsOf(top, isImport);
    const pieces: Piece[] = [];
    if (lang === 'python') pieces.push(...pythonPieces(root, c));
    else if (lang === 'c_sharp') csList(top, c, '', '', pieces, null);
    else jsList(top, c, pieces);
    if (deadline !== null && deadline.expired()) throw new DeadlineHit();
    const placed = place(pieces, 0, { commentStart }, imports);
    branchOrdinals(placed);
    const drafts: Draft[] = [];
    emit(placed, null, drafts, slicer(lang, root, pieces));
    drafts.push(...gapBlocks(lines, [...placed.map((p) => [p.lo, p.hi] as const), ...(imports === null ? [] : [imports])]));
    const e = errors(root, deadline);
    return finish(drafts, { grammar: lang, regionSpec, decodable: true, lineCount: lines.length, imports, errorSpans: e.spans, errorCount: e.count });
  } catch (err) {
    if (err instanceof DeadlineHit) return 'deadline';
    throw err;
  }
}
