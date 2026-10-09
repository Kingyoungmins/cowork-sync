// JSON Schemas of the served view model, generated at test time from src/viz/server/viewModel.ts (R-V27; T-VIZ-api). A
// syntax-only walk with the TypeScript compiler API: type references resolve by name inside the file, and any construct the
// walk does not know fails the generator, so viewModel.ts must stay inside the supported constructs (R-V27's cost). Every
// object is additionalProperties: false; string-literal unions become `enum`; tuples become `prefixItems`; every named string
// alias becomes its `pattern`; a plain `string` carries `x-field` (its declaration-relative field path), which the S8 test
// compares with project.ts's SERVED_STRING_FIELDS. Nothing here is shipped.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export type Schema = Record<string, unknown>;
export type RootName = 'World' | 'RoomVM' | 'TimelinePage' | 'StreamPayload' | 'Session' | 'Strings';
export const ROOTS: readonly RootName[] = Object.freeze(['World', 'RoomVM', 'TimelinePage', 'StreamPayload', 'Session', 'Strings'] as const);

/** R-V27: every named string alias of viewModel.ts and its pattern (ReasonVM, DisplayId, TemplateText and ParamName as their comments say). */
export const ALIAS_PATTERNS: Readonly<Record<string, string>> = Object.freeze({
  Handle: '^[0-9a-f]{6,32}$',
  SeatHandle: '^[0-9A-HJKMNP-TV-Z]{6,32}$',
  ShortId: '^[0-9A-Za-z]{8,32}$',
  RoomId: '^r[0-9A-HJKMNP-TV-Z]{8}$',
  Code: '^[A-Z][A-Z0-9_]{2,47}$',
  ReasonVM: '^([A-Z][A-Z0-9_]{2,47}|\\?)$',
  Cid: '^[0-9A-HJKMNP-TV-Z]{8}$',
  ReqId: '^R[0-9A-HJKMNP-TV-Z]{8}$',
  CardId: '^(0|[1-9][0-9]{0,9})\\.(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,5})$',
  Hex64: '^[0-9a-f]{64}$',
  InstanceId: '^[0-9A-HJKMNP-TV-Z]{8}$',
  DisplayId: '^[0-9A-Za-z]{8,32}$',
  TemplateText: '^[^<>\\p{Cc}]{1,400}$',
  ParamName: '^[a-z][a-z0-9_]{0,31}$',
});

const VIEW_MODEL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'viz', 'server', 'viewModel.ts');

type Decl = ts.TypeAliasDeclaration | ts.InterfaceDeclaration;

class Generator {
  private readonly decls = new Map<string, Decl>();
  private readonly stack: string[] = [];

  constructor(private readonly sf: ts.SourceFile, private readonly patterns: Readonly<Record<string, string>>) {
    for (const st of sf.statements) {
      if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) {
        if (st.typeParameters !== undefined) this.fail(st, 'generic declaration');
        this.decls.set(st.name.text, st);
      }
    }
  }

  fail(n: ts.Node, what: string): never {
    const { line } = this.sf.getLineAndCharacterOfPosition(n.getStart(this.sf));
    throw new Error(`vizSchema: unsupported ${what} at line ${line + 1}: ${n.getText(this.sf).slice(0, 120)}`);
  }

  decl(name: string, at: ts.Node): Schema {
    const d = this.decls.get(name);
    if (d === undefined) this.fail(at, `reference to ${name}`);
    if (this.stack.includes(name)) this.fail(at, `recursive type ${name}`);
    this.stack.push(name);
    try {
      if (ts.isInterfaceDeclaration(d)) {
        if (d.heritageClauses !== undefined) this.fail(d, 'interface heritage');
        return this.object(d.members, name);
      }
      if (d.type.kind === ts.SyntaxKind.StringKeyword) {
        const pattern = this.patterns[name];
        if (pattern === undefined) this.fail(d, `string alias ${name} without a pattern`);
        return { type: 'string', pattern };
      }
      return this.type(d.type, name);
    } finally {
      this.stack.pop();
    }
  }

  private object(members: ts.NodeArray<ts.TypeElement>, field: string): Schema {
    const properties: Record<string, Schema> = Object.create(null) as Record<string, Schema>;
    const required: string[] = [];
    for (const m of members) {
      if (!ts.isPropertySignature(m) || m.type === undefined) this.fail(m, 'member');
      if (!ts.isIdentifier(m.name) && !ts.isStringLiteral(m.name)) this.fail(m, 'property name');
      const key = m.name.text;
      if (Object.prototype.hasOwnProperty.call(properties, key)) this.fail(m, `duplicate property ${key}`);
      properties[key] = this.type(m.type, `${field}.${key}`);
      if (m.questionToken === undefined) required.push(key);
    }
    return { type: 'object', properties, required, additionalProperties: false };
  }

  type(n: ts.TypeNode, field: string): Schema {
    switch (n.kind) {
      case ts.SyntaxKind.StringKeyword: return { type: 'string', 'x-field': field };
      case ts.SyntaxKind.NumberKeyword: return { type: 'number' };
      case ts.SyntaxKind.BooleanKeyword: return { type: 'boolean' };
      default: break;
    }
    if (ts.isParenthesizedTypeNode(n)) return this.type(n.type, field);
    if (ts.isLiteralTypeNode(n)) {
      const l = n.literal;
      if (ts.isStringLiteral(l)) return { type: 'string', enum: [l.text] };
      if (ts.isNumericLiteral(l)) return { const: Number(l.text) };
      if (l.kind === ts.SyntaxKind.NullKeyword) return { type: 'null' };
      if (l.kind === ts.SyntaxKind.TrueKeyword) return { const: true };
      if (l.kind === ts.SyntaxKind.FalseKeyword) return { const: false };
      this.fail(n, 'literal');
    }
    if (ts.isArrayTypeNode(n)) return { type: 'array', items: this.type(n.elementType, field) };
    if (ts.isTupleTypeNode(n)) {
      const items = n.elements.map((e) => {
        if (ts.isNamedTupleMember(e)) {
          if (e.questionToken !== undefined || e.dotDotDotToken !== undefined) this.fail(e, 'tuple member');
          return this.type(e.type, field);
        }
        if (ts.isOptionalTypeNode(e) || ts.isRestTypeNode(e)) this.fail(e, 'tuple member');
        return this.type(e, field);
      });
      return { type: 'array', prefixItems: items, items: false, minItems: items.length, maxItems: items.length };
    }
    if (ts.isTypeLiteralNode(n)) return this.object(n.members, field);
    if (ts.isUnionTypeNode(n)) return union(n.types.map((t) => this.type(t, field)));
    if (ts.isIntersectionTypeNode(n)) return this.intersection(n, n.types.map((t) => this.type(t, field)));
    if (ts.isIndexedAccessTypeNode(n)) {
      if (!ts.isTypeReferenceNode(n.objectType) || !ts.isIdentifier(n.objectType.typeName)) this.fail(n, 'indexed access');
      if (!ts.isLiteralTypeNode(n.indexType) || !ts.isStringLiteral(n.indexType.literal)) this.fail(n, 'indexed access');
      const owner = n.objectType.typeName.text;
      const d = this.decls.get(owner);
      if (d === undefined || !ts.isInterfaceDeclaration(d)) this.fail(n, 'indexed access');
      const key = n.indexType.literal.text;
      const m = d.members.find((x) => ts.isPropertySignature(x) && (ts.isIdentifier(x.name) || ts.isStringLiteral(x.name)) && x.name.text === key);
      if (m === undefined || !ts.isPropertySignature(m) || m.type === undefined) this.fail(n, 'indexed access');
      return this.type(m.type, `${owner}.${key}`);
    }
    if (ts.isTypeReferenceNode(n)) {
      if (!ts.isIdentifier(n.typeName)) this.fail(n, 'qualified reference');
      const name = n.typeName.text;
      const args = n.typeArguments ?? [];
      if (name === 'Array' && args.length === 1) return { type: 'array', items: this.type(args[0]!, field) };
      if (name === 'Record' && args.length === 2) {
        if (args[0]!.kind !== ts.SyntaxKind.StringKeyword) this.fail(n, 'Record key');
        return { type: 'object', additionalProperties: this.type(args[1]!, field) };
      }
      if (args.length > 0) this.fail(n, `generic reference ${name}`);
      return this.decl(name, n);
    }
    this.fail(n, ts.SyntaxKind[n.kind]);
  }

  /** Object operands merge; a union operand distributes ({…} & (A | B) → A' | B'). */
  private intersection(n: ts.Node, parts: Schema[]): Schema {
    let acc: Schema[] = [{ type: 'object', properties: Object.create(null) as Record<string, Schema>, required: [], additionalProperties: false }];
    for (const p of parts) {
      const options = Array.isArray(p['anyOf']) ? (p['anyOf'] as Schema[]) : [p];
      const next: Schema[] = [];
      for (const a of acc) for (const o of options) next.push(this.merge(n, a, o));
      acc = next;
    }
    return acc.length === 1 ? acc[0]! : { anyOf: acc };
  }

  private merge(n: ts.Node, a: Schema, b: Schema): Schema {
    if (a['type'] !== 'object' || b['type'] !== 'object' || a['properties'] === undefined || b['properties'] === undefined) this.fail(n, 'intersection operand');
    const properties: Record<string, Schema> = Object.create(null) as Record<string, Schema>;
    for (const [k, v] of Object.entries(a['properties'] as Record<string, Schema>)) properties[k] = v;
    for (const [k, v] of Object.entries(b['properties'] as Record<string, Schema>)) {
      if (Object.prototype.hasOwnProperty.call(properties, k)) this.fail(n, `intersection property ${k} declared twice`);
      properties[k] = v;
    }
    return { type: 'object', properties, required: [...(a['required'] as string[]), ...(b['required'] as string[])], additionalProperties: false };
  }
}

/** String enums merge into one enum; nested anyOf flattens. */
function union(members: Schema[]): Schema {
  const flat = members.flatMap((m) => (Array.isArray(m['anyOf']) ? (m['anyOf'] as Schema[]) : [m]));
  if (flat.every((m) => m['type'] === 'string' && Array.isArray(m['enum']))) return { type: 'string', enum: flat.flatMap((m) => m['enum'] as string[]) };
  return { anyOf: flat };
}

/** The schemas of the named declarations of a viewModel-like source (throws on an unsupported construct). */
export function schemasFromSource(text: string, roots: readonly string[], patterns: Readonly<Record<string, string>> = ALIAS_PATTERNS): Record<string, Schema> {
  const sf = ts.createSourceFile('viewModel.ts', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const g = new Generator(sf, patterns);
  const out: Record<string, Schema> = {};
  for (const r of roots) out[r] = g.decl(r, sf);
  return out;
}

let cached: Readonly<Record<RootName, Schema>> | null = null;

/** R-V27: the six served roots of src/viz/server/viewModel.ts. */
export function viewModelSchemas(): Readonly<Record<RootName, object>> {
  cached ??= Object.freeze(schemasFromSource(readFileSync(VIEW_MODEL, 'utf8'), ROOTS) as Record<RootName, Schema>);
  return cached;
}

/** Every `x-field` (the plain string fields) of a schema, sorted and deduplicated. */
export function stringFields(schema: object): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v === null || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o['x-field'] === 'string') found.add(o['x-field']);
    for (const x of Object.values(o)) walk(x);
  };
  walk(schema);
  return [...found].sort();
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function typeOk(t: unknown, v: unknown): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    default: throw new Error(`validate: unknown type ${String(t)}`);
  }
}

/** [] when `value` matches `schema` (the keywords the generator emits; additionalProperties false everywhere it says so). */
export function validate(schema: object, value: unknown, path = '$'): string[] {
  const s = schema as Schema;
  if (Array.isArray(s['anyOf'])) {
    const branches = s['anyOf'] as Schema[];
    const results = branches.map((b) => validate(b, value, path));
    if (results.some((r) => r.length === 0)) return [];
    const best = results.reduce((a, b) => (b.length < a.length ? b : a));
    return [`${path}: matches none of ${branches.length} branches`, ...best];
  }
  if (own(s, 'const') && value !== s['const']) return [`${path}: expected ${JSON.stringify(s['const'])}`];
  if (s['type'] !== undefined && !typeOk(s['type'], value)) return [`${path}: expected ${String(s['type'])}`];
  const errors: string[] = [];
  if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof s['pattern'] === 'string' && !new RegExp(s['pattern'], 'u').test(value as string)) errors.push(`${path}: ${JSON.stringify(value).slice(0, 80)} fails ${s['pattern']}`);
  if (s['type'] === 'object') {
    const v = value as Record<string, unknown>;
    const props = (s['properties'] ?? {}) as Record<string, Schema>;
    for (const k of (s['required'] ?? []) as string[]) if (!own(v, k)) errors.push(`${path}: missing ${k}`);
    for (const k of Object.keys(v)) {
      if (own(props, k)) errors.push(...validate(props[k]!, v[k], `${path}.${k}`));
      else if (s['additionalProperties'] === false) errors.push(`${path}: unexpected property ${k}`);
      else if (typeof s['additionalProperties'] === 'object') errors.push(...validate(s['additionalProperties'] as Schema, v[k], `${path}.${k}`));
    }
  }
  if (s['type'] === 'array') {
    const v = value as unknown[];
    if (typeof s['minItems'] === 'number' && v.length < s['minItems']) errors.push(`${path}: fewer than ${s['minItems']} items`);
    if (typeof s['maxItems'] === 'number' && v.length > s['maxItems']) errors.push(`${path}: more than ${s['maxItems']} items`);
    const prefix = (s['prefixItems'] ?? []) as Schema[];
    v.forEach((x, i) => {
      if (i < prefix.length) errors.push(...validate(prefix[i]!, x, `${path}[${i}]`));
      else if (s['items'] === false) errors.push(`${path}[${i}]: no item allowed`);
      else if (typeof s['items'] === 'object') errors.push(...validate(s['items'] as Schema, x, `${path}[${i}]`));
    });
  }
  return errors;
}
