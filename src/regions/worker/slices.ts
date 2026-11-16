// Signature slices and call sites from the worker's parse tree (04-regions §3.10 "Signature slices", "Callers", "Callees",
// "Import names"; REG-26, REG-27; Task 7 contract addition 3). Both walk named nodes and fields only; no query source is
// added (regionSpec does not change) and every row is read through lineTable (L-OFFSETS). Text is read from nodes, never
// encoded (L-UTF8-WRITE).
//
// Slices (one per symbol unit, Unit.sigSlice; tables.ts asks for them):
//   Python function/method: parameters (posonly, pos, kwonly, *args, **kwargs, names, defaults), decorators, return annotation;
//   Python class: bases, method names, class-level assignment names; Python module: carried by the const unit `__all__` —
//   its string list and the UPPER_CASE module names (each UPPER_CASE name is also a const unit of its own, R4-19);
//   JS/TS: formal parameters (count, rest, defaults, destructured names), export status and exported name, class member names;
//   C#: modifiers, private-ness, return type, parameters (types, ref/out/in/params, defaults), property and field types and the
//   overload key `<type qualname> \0 <simple>`.
//   ParamSlice.default (Task 7 addition, see src/regions/types.ts) keeps a default value's text without whitespace, so a
//   default-value change is a note (04 §3.10 "Classes") rather than a body-only change.
//
// Sites (the 'sites' job): every call and import site, plus identifier occurrences of the requested names (AST identifiers
// and whole-word occurrences inside comments and string literals, flagged inComment / inString from node ancestry).
import type { Node } from 'web-tree-sitter';
import type { CallArgs, Site } from '../interface.js';
import type { Language, ParamSlice, RegionUnitKind, SigSlice } from '../types.js';
import { rowsOf } from './lineTable.js';

type Deadline = { expired(): boolean } | null;

/** A node's text without whitespace (the label-convention/1 spelling of names and types). */
const squash = (s: string): string => s.replace(/\s+/gu, '');

/** A declared name: no whitespace, string-literal keys without their quotes. */
function nameText(n: Node | null): string {
  if (n === null) return '';
  const t = squash(n.text);
  return /^(['"`]).*\1$/su.test(t) ? t.slice(1, -1) : t;
}

/** Each name once, in first-seen order. */
function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

const param = (name: string, kind: ParamSlice['kind'], dflt: Node | null, extra: { destructured?: readonly string[]; type?: string | null; optional?: boolean } = {}): ParamSlice => {
  const p: { -readonly [K in keyof ParamSlice]: ParamSlice[K] } = {
    name, kind, hasDefault: dflt !== null || extra.optional === true, destructured: extra.destructured ?? null, type: extra.type ?? null,
  };
  if (dflt !== null) p.default = squash(dflt.text);
  return p;
};

// ---- C# type text (also tables.ts' label-convention/1 discriminators) ------------------------------------------------------

/** A C# type with whitespace removed; `T?` as Nullable<T>; tuple element names dropped (label-convention/1: no whitespace). */
export function csType(n: Node): string {
  if (n.type === 'nullable_type') return `Nullable<${csType(n.childForFieldName('type') ?? n.namedChildren[0] ?? n)}>`;
  if (n.type === 'tuple_element') {
    const t = n.childForFieldName('type');
    return t === null ? '' : csType(t);
  }
  if (n.childCount === 0) return n.text.replace(/\s+/gu, '');
  return n.children.filter((ch) => ch.type !== 'comment' && ch.type !== 'attribute_list').map(csType).join('');
}

// ---- Python -----------------------------------------------------------------------------------------------------------------

/** An UPPER_CASE module name (04 §3.10 Python module slice). */
export const UPPER_NAME = /^[A-Z][A-Z0-9_]*$/u;

function pySplatName(n: Node): string {
  return nameText(n.namedChildren.find((c) => c.type === 'identifier') ?? null);
}

function pyParams(list: Node | null): ParamSlice[] {
  const out: ParamSlice[] = [];
  if (list === null) return out;
  let mode: 'pos' | 'kwonly' = 'pos';
  for (const ch of list.namedChildren) {
    switch (ch.type) {
      case 'positional_separator':
        for (let i = 0; i < out.length; i++) {
          const p = out[i] as ParamSlice;
          if (p.kind === 'pos') out[i] = { ...p, kind: 'posonly' };
        }
        break;
      case 'keyword_separator':
        mode = 'kwonly';
        break;
      case 'identifier':
        out.push(param(ch.text, mode, null));
        break;
      case 'default_parameter':
      case 'typed_default_parameter':
        out.push(param(nameText(ch.childForFieldName('name')), mode, ch.childForFieldName('value')));
        break;
      case 'typed_parameter': {
        const inner = ch.namedChildren[0] ?? null;
        if (inner !== null && inner.type === 'list_splat_pattern') {
          out.push(param(pySplatName(inner), 'varargs', null));
          mode = 'kwonly';
        } else if (inner !== null && inner.type === 'dictionary_splat_pattern') {
          out.push(param(pySplatName(inner), 'varkw', null));
        } else {
          out.push(param(nameText(inner), mode, null));
        }
        break;
      }
      case 'list_splat_pattern':
        out.push(param(pySplatName(ch), 'varargs', null));
        mode = 'kwonly';
        break;
      case 'dictionary_splat_pattern':
        out.push(param(pySplatName(ch), 'varkw', null));
        break;
      case 'comment':
        break;
      default:
        out.push(param(squash(ch.text), mode, null));
    }
  }
  return out;
}

/** The function_definition of a (decorated) def. */
function pyDefinition(outer: Node): Node {
  return outer.type === 'decorated_definition' ? (outer.childForFieldName('definition') ?? outer) : outer;
}

export function pyFunctionSlice(outer: Node): SigSlice {
  const fn = pyDefinition(outer);
  const decorators = outer.type === 'decorated_definition'
    ? outer.namedChildren.filter((d) => d.type === 'decorator').map((d) => squash(d.namedChildren.filter((x) => x.type !== 'comment').map((x) => x.text).join('')))
    : [];
  const ret = fn.childForFieldName('return_type');
  return { lang: 'python', unit: 'function', params: pyParams(fn.childForFieldName('parameters')), decorators, returns: ret === null ? null : squash(ret.text) };
}

/** A class-body or module-level `NAME = …` / `NAME: T = …` with one identifier target. */
function pyAssignedName(stmt: Node): string | null {
  if (stmt.type !== 'expression_statement' || stmt.namedChildCount !== 1) return null;
  const a = stmt.namedChildren[0];
  if (a === undefined || a.type !== 'assignment') return null;
  const left = a.childForFieldName('left');
  return left !== null && left.type === 'identifier' ? left.text : null;
}

export function pyClassSlice(outer: Node): SigSlice {
  const cls = pyDefinition(outer);
  const bases = (cls.childForFieldName('superclasses')?.namedChildren ?? []).filter((b) => b.type !== 'comment').map((b) => squash(b.text));
  const methods: string[] = [];
  const assignments: string[] = [];
  for (const m of cls.childForFieldName('body')?.namedChildren ?? []) {
    const d = pyDefinition(m);
    if (d.type === 'function_definition') methods.push(nameText(d.childForFieldName('name')));
    const a = pyAssignedName(m);
    if (a !== null) assignments.push(a);
  }
  return { lang: 'python', unit: 'class', bases, methods: unique(methods), assignments: unique(assignments) };
}

/** The module slice carried by the `__all__` const unit (contract addition 3): its literal list of strings (null when the value is
 *  not a list or tuple of plain string literals) and the module's UPPER_CASE names. */
export function pyModuleSlice(allStmt: Node, upperNames: readonly string[]): SigSlice {
  const right = allStmt.namedChildren[0]?.childForFieldName('right') ?? null;
  let all: string[] | null = null;
  if (right !== null && (right.type === 'list' || right.type === 'tuple')) {
    const items: string[] = [];
    for (const s of right.namedChildren) {
      if (s.type === 'comment') continue;
      const parts = s.type === 'string' ? s.namedChildren.filter((c) => c.type !== 'string_start' && c.type !== 'string_end') : null;
      if (parts === null || parts.some((c) => c.type !== 'string_content')) {
        items.length = 0;
        all = null;
        break;
      }
      items.push(parts.map((c) => c.text).join(''));
      all = items;
    }
    if (right.namedChildren.filter((c) => c.type !== 'comment').length === 0) all = [];
  }
  return { lang: 'python', unit: 'module', all, upperNames: unique(upperNames) };
}

// ---- JavaScript, TypeScript, TSX ----------------------------------------------------------------------------------------------

const JS_FUNCTIONS: ReadonlySet<string> = new Set(['function_expression', 'arrow_function', 'generator_function', 'function', 'function_declaration', 'generator_function_declaration', 'method_definition']);

function jsDestructured(p: Node): string[] {
  const out: string[] = [];
  for (const ch of p.namedChildren) {
    switch (ch.type) {
      case 'shorthand_property_identifier_pattern':
      case 'identifier':
        out.push(ch.text);
        break;
      case 'pair_pattern':
        out.push(nameText(ch.childForFieldName('key')));
        break;
      case 'object_assignment_pattern':
      case 'assignment_pattern': {
        const left = ch.childForFieldName('left');
        if (left !== null) out.push(...(left.type === 'object_pattern' || left.type === 'array_pattern' ? jsDestructured(left) : [left.text]));
        break;
      }
      case 'object_pattern':
      case 'array_pattern':
        out.push(...jsDestructured(ch));
        break;
      default:
        break;
    }
  }
  return out;
}

/** One JS/TS parameter pattern with its default (null) or TS optional flag. */
function jsParam(pattern: Node, dflt: Node | null, optional: boolean): ParamSlice | null {
  switch (pattern.type) {
    case 'this':
      return null;   // a TS `this` parameter is not an argument
    case 'rest_pattern':
      return param(nameText(pattern.namedChildren[0] ?? null), 'rest', null);
    case 'object_pattern':
    case 'array_pattern':
      return param('', 'plain', dflt, { destructured: jsDestructured(pattern), optional });
    default:
      return param(nameText(pattern), 'plain', dflt, { optional });
  }
}

function jsParams(fn: Node): ParamSlice[] {
  const single = fn.childForFieldName('parameter');
  if (single !== null) return [param(nameText(single), 'plain', null)];
  const out: ParamSlice[] = [];
  for (const ch of fn.childForFieldName('parameters')?.namedChildren ?? []) {
    let p: ParamSlice | null = null;
    if (ch.type === 'required_parameter' || ch.type === 'optional_parameter') {
      const pattern = ch.childForFieldName('pattern');
      if (pattern !== null) p = jsParam(pattern, ch.childForFieldName('value'), ch.type === 'optional_parameter');
    } else if (ch.type === 'assignment_pattern') {
      const left = ch.childForFieldName('left');
      if (left !== null) p = jsParam(left, ch.childForFieldName('right'), false);
    } else if (ch.type !== 'comment') {
      p = jsParam(ch, null, false);
    }
    if (p !== null) out.push(p);
  }
  return out;
}

/** The member names of a class body: methods, fields and signatures, each once. */
function jsMembers(cls: Node | null): string[] {
  const out: string[] = [];
  for (const m of cls?.childForFieldName('body')?.namedChildren ?? []) {
    const name = m.childForFieldName('name') ?? m.childForFieldName('property');
    if (name !== null && m.type !== 'comment') out.push(nameText(name));
  }
  return unique(out);
}

/** export { local as exported } and export default <identifier> clauses of a program (no `from`): local name → exported name. */
export function jsExportClauses(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of root.namedChildren) {
    if (n.type !== 'export_statement' || n.childForFieldName('source') !== null) continue;
    for (const c of n.namedChildren) {
      if (c.type !== 'export_clause') continue;
      for (const s of c.namedChildren) {
        if (s.type !== 'export_specifier') continue;
        const local = nameText(s.childForFieldName('name'));
        const alias = s.childForFieldName('alias');
        if (!out.has(local)) out.set(local, alias === null ? local : nameText(alias));
      }
    }
    const value = n.childForFieldName('value');
    if (value !== null && value.type === 'identifier' && n.children.some((ch) => !ch.isNamed && ch.type === 'default') && !out.has(value.text)) out.set(value.text, 'default');
  }
  return out;
}

/** What tables.ts knows of a JS/TS piece. */
export interface JsPiece { readonly kind: RegionUnitKind; readonly outer: Node; readonly simple: string; readonly disc: string; readonly topLevel: boolean; readonly classValued: boolean; }

/** The declaration an export_statement wraps (its declaration or its default value), else the node itself. */
function unwrapExport(n: Node): Node {
  if (n.type !== 'export_statement') return n;
  return n.childForFieldName('declaration') ?? n.childForFieldName('value') ?? n;
}

/** The function or class node a const declaration binds (a single declarator's value). */
function declaratorValue(n: Node): Node | null {
  const d = unwrapExport(n);
  const decl = d.namedChildren.find((x) => x.type === 'variable_declarator') ?? null;
  return decl?.childForFieldName('value') ?? null;
}

export function jsSlice(lang: 'javascript' | 'typescript' | 'tsx', p: JsPiece, exports: ReadonlyMap<string, string>): SigSlice {
  let exported = false;
  let exportName: string | null = null;
  if (p.topLevel) {
    if (p.outer.type === 'export_statement') {
      exported = true;
      exportName = p.outer.children.some((ch) => !ch.isNamed && ch.type === 'default') ? 'default' : p.simple;
    } else if (exports.has(p.simple)) {
      exported = true;
      exportName = exports.get(p.simple) ?? p.simple;
    }
  }
  let params: ParamSlice[] | null = null;
  let members: string[] = [];
  if (p.kind === 'type') {
    members = [];
  } else if (p.classValued || p.kind === 'class') {
    const cls = p.kind === 'const' ? declaratorValue(p.outer) : unwrapExport(p.outer);
    members = jsMembers(cls);
  } else if (p.disc !== 'overload') {
    let fn: Node | null;
    if (p.kind === 'const') fn = declaratorValue(p.outer);
    else if (p.outer.type === 'pair') fn = p.outer.childForFieldName('value');
    else fn = unwrapExport(p.outer);
    if (fn !== null && JS_FUNCTIONS.has(fn.type)) params = jsParams(fn);
  }
  return { lang, params, exported, exportName, members };
}

// ---- C# ---------------------------------------------------------------------------------------------------------------------

const CS_TYPE_DECLS: ReadonlySet<string> = new Set(['class_declaration', 'struct_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'record_struct_declaration']);
const CS_ACCESS: ReadonlySet<string> = new Set(['public', 'private', 'protected', 'internal']);

function csParamSlices(list: Node | null): ParamSlice[] {
  const out: ParamSlice[] = [];
  if (list === null) return out;
  const kids = list.children;
  kids.forEach((ch, i) => {
    if (ch.type === 'parameter') {
      const mods = ch.namedChildren.filter((m) => m.type === 'modifier').map((m) => m.text.trim());
      const kind: ParamSlice['kind'] = ch.children.some((c) => !c.isNamed && c.type === 'params') || mods.includes('params') ? 'params'
        : mods.includes('ref') ? 'ref' : mods.includes('out') ? 'out' : mods.includes('in') ? 'in' : 'plain';
      const t = ch.childForFieldName('type');
      const eq = ch.children.findIndex((c) => !c.isNamed && c.type === '=');
      const dflt = eq < 0 ? null : (ch.children.slice(eq + 1).find((c) => c.isNamed) ?? null);
      out.push(param(nameText(ch.childForFieldName('name')), kind, dflt, { type: t === null ? null : csType(t) }));
    } else if (!ch.isNamed && ch.type === 'params') {
      const named = kids.slice(i + 1).filter((k) => k.isNamed);
      const t = named[0];
      const name = named[1];
      if (t !== undefined) out.push(param(nameText(name ?? null), 'params', null, { type: csType(t) }));
    }
  });
  return out;
}

/** The type declaration that contains a member (through #if branches), null at namespace or file level. */
function csContainer(n: Node): Node | null {
  for (let p = n.parent; p !== null; p = p.parent) {
    if (CS_TYPE_DECLS.has(p.type)) return p;
    if (p.type === 'namespace_declaration' || p.type === 'file_scoped_namespace_declaration' || p.type === 'compilation_unit') return null;
  }
  return null;
}

/** C#'s accessibility: an explicit private (not private protected) is private; with no access modifier a member of a class,
 *  struct or record is private, an interface or enum member is public and a top-level type is internal. */
function csIsPrivate(modifiers: readonly string[], n: Node): boolean {
  const access = modifiers.filter((m) => CS_ACCESS.has(m));
  if (access.length > 0) return access.includes('private') && !access.includes('protected');
  const c = csContainer(n);
  return c !== null && c.type !== 'interface_declaration' && c.type !== 'enum_declaration';
}

export function csSlice(kind: RegionUnitKind, n: Node, typeQualname: string, simple: string): SigSlice {
  const modifiers = n.namedChildren.filter((c) => c.type === 'modifier').map((c) => c.text.trim());
  let returns: string | null = null;
  let memberType: string | null = null;
  let params: ParamSlice[] = [];
  const typed = (x: Node | null): string | null => (x === null ? null : csType(x));
  switch (kind) {
    case 'method':
      returns = typed(n.childForFieldName('returns') ?? n.childForFieldName('type'));
      params = csParamSlices(n.childForFieldName('parameters'));
      break;
    case 'operator':
      returns = typed(n.childForFieldName('type'));
      params = csParamSlices(n.childForFieldName('parameters'));
      break;
    case 'ctor':
    case 'dtor':
      params = csParamSlices(n.childForFieldName('parameters'));
      break;
    case 'indexer':
      memberType = typed(n.childForFieldName('type'));
      params = csParamSlices(n.childForFieldName('parameters'));
      break;
    case 'property':
    case 'event':
      memberType = typed(n.childForFieldName('type') ?? n.namedChildren.find((c) => c.type === 'variable_declaration')?.childForFieldName('type') ?? null);
      break;
    case 'field':
      memberType = typed(n.namedChildren.find((c) => c.type === 'variable_declaration')?.childForFieldName('type') ?? null);
      break;
    default:
      break;
  }
  return { lang: 'c_sharp', isPrivate: csIsPrivate(modifiers, n), modifiers, returns, params, memberType, overloadKey: `${typeQualname}\u{0}${simple}` };
}

// ---- Call, import and identifier sites -----------------------------------------------------------------------------------------

/** AST node types whose text is a whole identifier, per language family. */
const IDENTIFIERS: Readonly<Record<'python' | 'js' | 'c_sharp', ReadonlySet<string>>> = Object.freeze({
  python: new Set(['identifier']),
  js: new Set(['identifier', 'property_identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern', 'type_identifier', 'private_property_identifier', 'statement_identifier']),
  c_sharp: new Set(['identifier']),
});
/** Literal text nodes scanned for whole-word occurrences (inString). */
const STRING_TEXT: Readonly<Record<'python' | 'js' | 'c_sharp', ReadonlySet<string>>> = Object.freeze({
  python: new Set(['string_content']),
  js: new Set(['string_fragment']),
  c_sharp: new Set(['string_literal_content', 'verbatim_string_literal', 'string_content', 'raw_string_content']),
});

const family = (lang: Language): 'python' | 'js' | 'c_sharp' => (lang === 'python' ? 'python' : lang === 'c_sharp' ? 'c_sharp' : 'js');

const WORD_BYTE = /[A-Za-z0-9_]/u;

/** 0-based indexes of whole-word occurrences of name in text (word constituents [A-Za-z0-9_], as git grep -w under LC_ALL=C). */
function wordIndexes(text: string, name: string): number[] {
  const out: number[] = [];
  if (name === '') return out;
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
    const before = i === 0 ? '' : text[i - 1] ?? '';
    const after = text[i + name.length] ?? '';
    if (!WORD_BYTE.test(before) && !WORD_BYTE.test(after)) out.push(i);
  }
  return out;
}

interface Walk {
  readonly fam: 'python' | 'js' | 'c_sharp';
  readonly path: string;
  readonly names: ReadonlySet<string>;
  /** names.size === 0: every call, no identifier site. */
  readonly all: boolean;
  /** The requested names that are maximal word runs, and the rest (scanned one by one). */
  readonly words: ReadonlySet<string>;
  readonly others: readonly string[];
  /** Python: a bound module name or alias → its dotted module; JS/TS: a namespace import binding → its specifier. */
  readonly modules: Map<string, string>;
  readonly sites: Site[];
}

const site = (w: Walk, line: number, name: string, kind: Site['kind'], receiver: Site['receiver'], module: string | null, args: CallArgs | null, flags: { inComment?: boolean; inString?: boolean } = {}): void => {
  w.sites.push({ path: w.path, line, name, kind, receiver, module, args, inComment: flags.inComment === true, inString: flags.inString === true });
};

/** A dotted identifier chain (`a`, `a.b.c`), else null. */
function dotted(n: Node): string | null {
  if (n.type === 'identifier') return n.text;
  if (n.type === 'attribute' || n.type === 'member_expression' || n.type === 'member_access_expression') {
    const obj = n.childForFieldName('object') ?? n.childForFieldName('expression');
    const prop = n.childForFieldName('attribute') ?? n.childForFieldName('property') ?? n.childForFieldName('name');
    const left = obj === null ? null : dotted(obj);
    return left === null || prop === null ? null : `${left}.${prop.text}`;
  }
  return null;
}

function pyArgs(list: Node | null): CallArgs {
  let positional = 0;
  const keywords: string[] = [];
  let splat = false;
  if (list !== null && list.type !== 'argument_list') return { positional: 1, keywords, splat };   // a generator expression argument
  for (const a of list?.namedChildren ?? []) {
    if (a.type === 'keyword_argument') keywords.push(nameText(a.childForFieldName('name')));
    else if (a.type === 'list_splat' || a.type === 'dictionary_splat') splat = true;
    else if (a.type !== 'comment') positional++;
  }
  return { positional, keywords, splat };
}

function jsArgs(list: Node | null): CallArgs {
  let positional = 0;
  let splat = false;
  for (const a of list?.namedChildren ?? []) {
    if (a.type === 'spread_element') splat = true;
    else if (a.type !== 'comment') positional++;
  }
  return { positional, keywords: [], splat };
}

function csArgs(list: Node | null): CallArgs {
  let positional = 0;
  const keywords: string[] = [];
  for (const a of list?.namedChildren ?? []) {
    if (a.type !== 'argument') continue;
    const name = a.childForFieldName('name');
    if (name !== null) keywords.push(name.text);
    else positional++;
  }
  return { positional, keywords, splat: false };
}

function pyCall(w: Walk, n: Node): void {
  const fn = n.childForFieldName('function');
  if (fn === null) return;
  const args = (): CallArgs => pyArgs(n.childForFieldName('arguments'));
  if (fn.type === 'identifier') {
    if (w.all || w.names.has(fn.text)) site(w, rowsOf(fn)[0], fn.text, 'call', 'bare', null, args());
    return;
  }
  if (fn.type !== 'attribute') return;
  const attr = fn.childForFieldName('attribute');
  const obj = fn.childForFieldName('object');
  if (attr === null || obj === null || !(w.all || w.names.has(attr.text))) return;
  const chain = dotted(obj);
  if (obj.type === 'identifier' && (obj.text === 'self' || obj.text === 'cls')) site(w, rowsOf(attr)[0], attr.text, 'call', 'self', null, args());
  else if (chain !== null && w.modules.has(chain)) site(w, rowsOf(attr)[0], attr.text, 'call', 'module', w.modules.get(chain) ?? null, args());
  else site(w, rowsOf(attr)[0], attr.text, 'call', 'other', chain, args());
}

function pyImport(w: Walk, n: Node): void {
  if (n.type === 'import_statement') {
    for (const c of n.childrenForFieldName('name')) {
      const mod = c.type === 'aliased_import' ? c.childForFieldName('name') : c;
      if (mod === null) continue;
      const module = squash(mod.text);
      const binding = c.type === 'aliased_import' ? nameText(c.childForFieldName('alias')) : (module.split('.')[0] ?? module);
      site(w, rowsOf(c)[0], binding, 'import', 'module', module, null);
    }
    return;
  }
  const modNode = n.childForFieldName('module_name');
  if (modNode === null) return;
  const module = squash(modNode.text);
  for (const c of n.childrenForFieldName('name')) {
    const nameNode = c.type === 'aliased_import' ? c.childForFieldName('name') : c;
    if (nameNode !== null) site(w, rowsOf(nameNode)[0], squash(nameNode.text), 'import', 'other', module, null);
  }
  const star = n.namedChildren.find((c) => c.type === 'wildcard_import');
  if (star !== undefined) site(w, rowsOf(star)[0], '*', 'import', 'other', module, null);
}

/** The specifier string of a JS/TS import or re-export. */
function jsSpecifier(n: Node): string | null {
  const src = n.childForFieldName('source');
  if (src === null) return null;
  return src.namedChildren.filter((c) => c.type === 'string_fragment').map((c) => c.text).join('');
}

function jsImport(w: Walk, n: Node): void {
  const spec = jsSpecifier(n);
  if (spec === null) return;
  for (const c of n.namedChildren) {
    if (c.type === 'import_clause') {
      for (const part of c.namedChildren) {
        if (part.type === 'identifier') site(w, rowsOf(part)[0], 'default', 'import', 'other', spec, null);
        else if (part.type === 'namespace_import') site(w, rowsOf(part)[0], '*', 'import', 'module', spec, null);
        else if (part.type === 'named_imports') {
          for (const s of part.namedChildren) {
            const name = s.type === 'import_specifier' ? s.childForFieldName('name') : null;
            if (name !== null) site(w, rowsOf(name)[0], nameText(name), 'import', 'other', spec, null);
          }
        }
      }
    } else if (c.type === 'export_clause') {
      for (const s of c.namedChildren) {
        const name = s.type === 'export_specifier' ? s.childForFieldName('name') : null;
        if (name !== null) site(w, rowsOf(name)[0], nameText(name), 'import', 'type', spec, null);
      }
    } else if (c.type === 'namespace_export') {
      site(w, rowsOf(c)[0], '*', 'import', 'type', spec, null);
    }
  }
  if (n.type === 'export_statement' && n.children.some((ch) => !ch.isNamed && ch.type === '*') && !n.namedChildren.some((c) => c.type === 'namespace_export')) {
    site(w, rowsOf(n)[0], '*', 'import', 'type', spec, null);
  }
}

function jsCall(w: Walk, n: Node): void {
  const fn = n.type === 'new_expression' ? n.childForFieldName('constructor') : n.childForFieldName('function');
  if (fn === null) return;
  const args = (): CallArgs => {
    const a = n.childForFieldName('arguments');
    return jsArgs(a !== null && a.type === 'arguments' ? a : null);
  };
  if (fn.type === 'identifier') {
    if (w.all || w.names.has(fn.text)) site(w, rowsOf(fn)[0], fn.text, 'call', 'bare', null, args());
    return;
  }
  if (fn.type !== 'member_expression') return;
  const prop = fn.childForFieldName('property');
  const obj = fn.childForFieldName('object');
  if (prop === null || obj === null || !(w.all || w.names.has(prop.text))) return;
  if (obj.type === 'this') site(w, rowsOf(prop)[0], prop.text, 'call', 'self', null, args());
  else if (obj.type === 'identifier' && w.modules.has(obj.text)) site(w, rowsOf(prop)[0], prop.text, 'call', 'module', w.modules.get(obj.text) ?? null, args());
  else site(w, rowsOf(prop)[0], prop.text, 'call', 'other', obj.type === 'identifier' ? obj.text : null, args());
}

/** The simple name a C# name node ends with (`Svc`, `N.Svc`, `Svc<T>` → Svc). */
function csLastName(n: Node): Node | null {
  if (n.type === 'identifier') return n;
  if (n.type === 'generic_name') return n.namedChildren.find((c) => c.type === 'identifier') ?? null;
  if (n.type === 'qualified_name') return csLastName(n.childForFieldName('name') ?? n.namedChildren[n.namedChildCount - 1] ?? n);
  if (n.type === 'member_access_expression') return csLastName(n.childForFieldName('name') ?? n);
  return null;
}

function csCall(w: Walk, n: Node): void {
  const args = (): CallArgs => csArgs(n.childForFieldName('arguments'));
  if (n.type === 'object_creation_expression') {
    const t = n.childForFieldName('type');
    const name = t === null ? null : csLastName(t);
    if (name !== null && (w.all || w.names.has(name.text))) site(w, rowsOf(name)[0], name.text, 'call', 'type', name.text, args());
    return;
  }
  const fn = n.childForFieldName('function');
  if (fn === null) return;
  if (fn.type === 'identifier' || fn.type === 'generic_name') {
    const name = csLastName(fn);
    if (name !== null && (w.all || w.names.has(name.text))) site(w, rowsOf(name)[0], name.text, 'call', 'bare', null, args());
    return;
  }
  if (fn.type !== 'member_access_expression') return;
  const nameNode = fn.childForFieldName('name');
  const name = nameNode === null ? null : csLastName(nameNode);
  const expr = fn.childForFieldName('expression');
  if (name === null || expr === null || !(w.all || w.names.has(name.text))) return;
  if (!expr.isNamed && expr.type === 'this') site(w, rowsOf(name)[0], name.text, 'call', 'self', null, args());
  else {
    const typeName = csLastName(expr);
    if (typeName !== null) site(w, rowsOf(name)[0], name.text, 'call', 'type', typeName.text, args());
    else site(w, rowsOf(name)[0], name.text, 'call', 'other', null, args());
  }
}

/** Python module bindings (`import a.b` binds a.b's chain, `import a.b as ab` binds ab) and JS/TS namespace imports. */
function moduleBindings(fam: 'python' | 'js' | 'c_sharp', root: Node): Map<string, string> {
  const out = new Map<string, string>();
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    if (fam === 'python' && n.type === 'import_statement') {
      for (const c of n.childrenForFieldName('name')) {
        if (c.type === 'aliased_import') {
          const mod = c.childForFieldName('name');
          const alias = c.childForFieldName('alias');
          if (mod !== null && alias !== null) out.set(alias.text, squash(mod.text));
        } else {
          const mod = squash(c.text);
          const parts = mod.split('.');
          for (let i = 1; i <= parts.length; i++) out.set(parts.slice(0, i).join('.'), parts.slice(0, i).join('.'));
        }
      }
      continue;
    }
    if (fam === 'js' && n.type === 'import_statement') {
      const spec = jsSpecifier(n);
      for (const c of n.namedChildren) {
        if (c.type !== 'import_clause') continue;
        for (const part of c.namedChildren) {
          const id = part.type === 'namespace_import' ? part.namedChildren.find((x) => x.type === 'identifier') : undefined;
          if (id !== undefined && spec !== null) out.set(id.text, spec);
        }
      }
      continue;
    }
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const ch = n.namedChild(i);
      if (ch !== null) stack.push(ch);
    }
  }
  return out;
}

/** A name made of word constituents only is found as a maximal [A-Za-z0-9_] run; any other name by its own whole-word scan. */
const WORD_NAME = /^[A-Za-z0-9_]+$/u;
const WORD_RUN = /[A-Za-z0-9_]+/gu;

/** Whole-word occurrences of the requested names inside one comment or string-literal node, one site per occurrence. */
function scanText(w: Walk, n: Node, flags: { inComment?: boolean; inString?: boolean }): void {
  const text = n.text;
  const first = rowsOf(n)[0];
  const rowAt = (i: number): number => {
    let row = first;
    for (let j = text.indexOf('\n'); j >= 0 && j < i; j = text.indexOf('\n', j + 1)) row++;
    return row;
  };
  for (const m of text.matchAll(WORD_RUN)) {
    if (w.words.has(m[0])) site(w, rowAt(m.index), m[0], 'identifier', 'other', null, null, flags);
  }
  for (const name of w.others) {
    for (const i of wordIndexes(text, name)) site(w, rowAt(i), name, 'identifier', 'other', null, null, flags);
  }
}

/**
 * The 'sites' job's walk (04 §3.10): every import site, the call sites (all of them when `names` is empty, else those whose
 * callee name is requested) and, for requested names, every identifier node plus whole-word occurrences inside comments
 * (inComment) and string literals (inString). Python and JS/TS calls resolve their receiver: `self.`/`cls.`/`this.` → self, a
 * module binding or namespace import → module (with its dotted module or specifier), anything else → other; C# `this.` → self,
 * `Name.M()` and `new Name()` → type (module = the simple name), a bare call → bare. Rows are the callee name's rows.
 */
export function sitesOf(lang: Language, root: Node, path: string, names: ReadonlySet<string>, deadline: Deadline): Site[] | 'deadline' {
  const fam = family(lang);
  const words = new Set([...names].filter((x) => WORD_NAME.test(x)));
  const w: Walk = { fam, path, names, all: names.size === 0, words, others: [...names].filter((x) => !words.has(x)), modules: moduleBindings(fam, root), sites: [] };
  const identifiers = IDENTIFIERS[fam];
  const strings = STRING_TEXT[fam];
  const stack: Node[] = [root];
  let visited = 0;
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    if ((++visited & 2047) === 0 && deadline !== null && deadline.expired()) return 'deadline';
    const t = n.type;
    if (t === 'comment') {
      if (!w.all) scanText(w, n, { inComment: true });
      continue;
    }
    if (strings.has(t)) {
      if (!w.all) scanText(w, n, { inString: true });
      continue;
    }
    if (fam === 'python') {
      if (t === 'call') pyCall(w, n);
      else if (t === 'import_statement' || t === 'import_from_statement') pyImport(w, n);
    } else if (fam === 'js') {
      if (t === 'call_expression' || t === 'new_expression') jsCall(w, n);
      else if (t === 'import_statement' || t === 'export_statement') jsImport(w, n);
    } else if (t === 'invocation_expression' || t === 'object_creation_expression') {
      csCall(w, n);
    }
    if (!w.all && identifiers.has(t) && names.has(n.text)) site(w, rowsOf(n)[0], n.text, 'identifier', 'other', null, null);
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const ch = n.namedChild(i);
      if (ch !== null) stack.push(ch);
    }
  }
  return w.sites;
}
