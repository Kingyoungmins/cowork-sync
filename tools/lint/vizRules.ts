// Lint rules of the visualizer (12-visualizer §9.5; plan 8a R-V34, R-V35, R-V55): the 8a exemptions from
// the Plan 1 rules (VIZ_ALLOW) and the rules L-VIZ-DOM, L-VIZ-GIT, L-VIZ-IMPORT, L-VIZ-URL, L-VIZ-NET and
// L-VIZ-TYPES. tools/lint/lint.ts applies them; tools/lint/rules.ts keeps the Plan 1/2 rules unchanged, except that its
// L-PID-KILL also allows the viewer CLI's POSIX group kill in src/viz/cli/spawn.ts (Plan 8a merge with Plan 2; VIZ-02).
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { VIZ_GIT_SUBCOMMANDS, vizGitArgvOk } from '../../src/viz/source/vizGitArgv.js';
import type { LintFinding } from './rules.js';

// ---------------------------------------------------------------------------------------------------------
// VIZ_ALLOW (R-V34)

/** A Plan 1 rule finding that 8a allows: in one of `files`, or in any file under `prefix`. A `rule` ending in
 *  `*` covers every rule id that starts with the text before it. */
export interface VizAllow { rule: string; files?: readonly string[]; prefix?: string; }

const CLIENT_DIR = 'src/viz/client/';

export const VIZ_ALLOW: readonly VizAllow[] = [
  // The node:http module load only (vizAllowed checks the module); L-VIZ-NET forbids every client use there.
  { rule: 'L-NET', files: ['src/viz/server/http.ts'] },
  { rule: 'L-PORTS', files: ['src/viz/cli/spawn.ts', 'src/viz/cli/opener.ts', 'src/viz/cli/ownerProbe.ts'] },
  // spawn.ts: only the open of the viewer's stderr file, <data dir>/log/viz-stderr.txt (Task 15 fix round 2 ruling).
  { rule: 'L-FS-PORT', files: ['src/viz/cli/ownerProbe.ts', 'src/viz/source/boundedRead.ts', 'src/viz/cli/spawn.ts'] },
  // Browser code (L-VIZ-IMPORT and the client typecheck cover it instead).
  { rule: 'L-CLOCK', prefix: CLIENT_DIR },
  { rule: 'L-RANDOM', prefix: CLIENT_DIR },
  { rule: 'L-FS-PORT', prefix: CLIENT_DIR },
  { rule: 'L-GIT-*', prefix: CLIENT_DIR },
];

/** The modules the L-NET exemption covers: `network module "<m>" loaded …` is lintSource's L-NET message. */
const HTTP_MODULES: ReadonlySet<string> = new Set(['http', 'node:http']);
const L_NET_MODULE = /^network module "([^"]*)"/;

function normalizeFile(file: string): string {
  return file.split('\\').join('/');
}

/** True when VIZ_ALLOW covers a lintSource finding (lint.ts drops it). Fails closed: an L-NET message that does
 *  not name the module is not covered. */
export function vizAllowed(f: LintFinding): boolean {
  const file = normalizeFile(f.file);
  return VIZ_ALLOW.some((a) => {
    const ruleOk = a.rule.endsWith('*') ? f.rule.startsWith(a.rule.slice(0, -1)) : f.rule === a.rule;
    const fileOk = (a.files !== undefined && a.files.includes(file)) || (a.prefix !== undefined && file.startsWith(a.prefix));
    if (!ruleOk || !fileOk) return false;
    if (a.rule !== 'L-NET') return true;
    const m = L_NET_MODULE.exec(f.message);
    return m !== null && HTTP_MODULES.has(m[1] as string);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Shared syntax helpers

type Report = (rule: string, at: ts.Node | number, message: string) => void;

/** Text of a string literal or a no-substitution template, else null. */
function literalString(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isNonNullExpression(x)
    || ts.isTypeAssertionExpression(x)) {
    x = x.expression;
  }
  return x;
}

/** The member a property or element access names (a literal key only), else null. */
function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return literalString(node.argumentExpression);
  return null;
}

/** `f(…)` → "f"; `a.b.f(…)` → "f". */
function calleeName(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  return memberName(e);
}

const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['window', 'self', 'globalThis', 'global', 'top', 'parent', 'frames']);

function isGlobalObject(e: ts.Expression): boolean {
  const x = unwrap(e);
  return ts.isIdentifier(x) && GLOBAL_OBJECTS.has(x.text);
}

/** True when the identifier is used as a value or type, not as a member name, a property key or a label. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p)
    || ts.isMethodSignature(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) && p.name === id) {
    return false;
  }
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

function isCallee(node: ts.Node): ts.CallExpression | null {
  const p = node.parent;
  return p !== undefined && ts.isCallExpression(p) && unwrap(p.expression) === node ? p : null;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

// ---------------------------------------------------------------------------------------------------------
// Module loads and their targets (L-VIZ-IMPORT and the client closure)

interface Load { spec: string | null; at: number; directive: string | null; }

/**
 * Every module a file names: import and export-from declarations (type-only included), import-equals,
 * require(), import() calls and `import('…')` types, and triple-slash references (`path` as a relative
 * load; `types` and `lib` as directives). A non-literal require()/import() has spec null.
 */
function loadsOf(sf: ts.SourceFile): Load[] {
  const out: Load[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ spec: n.moduleSpecifier.text, at: n.getStart(sf), directive: null });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)
      && ts.isStringLiteralLike(n.moduleReference.expression)) {
      out.push({ spec: n.moduleReference.expression.text, at: n.getStart(sf), directive: null });
    } else if (ts.isCallExpression(n)
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      const a0 = n.arguments[0];
      out.push({ spec: a0 !== undefined && ts.isStringLiteralLike(a0) ? a0.text : null, at: n.getStart(sf), directive: null });
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      out.push({ spec: n.argument.literal.text, at: n.getStart(sf), directive: null });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const r of sf.referencedFiles) {
    const spec = r.fileName.startsWith('.') || r.fileName.startsWith('/') ? r.fileName : `./${r.fileName}`;
    out.push({ spec, at: r.pos, directive: null });
  }
  for (const r of sf.typeReferenceDirectives) out.push({ spec: null, at: r.pos, directive: `types="${r.fileName}"` });
  for (const r of sf.libReferenceDirectives) out.push({ spec: null, at: r.pos, directive: `lib="${r.fileName}"` });
  return out.sort((a, b) => a.at - b.at);
}

type Target = { kind: 'node'; name: string } | { kind: 'file'; path: string } | { kind: 'other' };

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** A specifier as seen from a repository-relative file: a Node built-in, a repository file (NodeNext `.js` → `.ts`), or other. */
function targetOf(from: string, spec: string): Target {
  if (spec.startsWith('node:')) return { kind: 'node', name: spec.slice('node:'.length).split('/')[0] ?? '' };
  if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
    let p = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    if (p.endsWith('.js')) p = `${p.slice(0, -'.js'.length)}.ts`;
    else if (p.endsWith('.mjs')) p = `${p.slice(0, -'.mjs'.length)}.mts`;
    else if (!/\.[cm]?ts$/.test(p)) p = `${p}.ts`;
    return { kind: 'file', path: p };
  }
  const base = spec.split('/')[0] ?? '';
  if (BUILTINS.has(spec) || BUILTINS.has(base)) return { kind: 'node', name: base };
  return { kind: 'other' };
}

/** Pure leaves of src/git/ (no process, no file); the rest of src/git/ runs or wraps git. */
const PURE_GIT: ReadonlySet<string> = new Set(['src/git/oid.ts', 'src/git/enc.ts', 'src/git/trailers.ts', 'src/git/version.ts']);
/** Type-only declaration files of the viewer's I/O layers. */
const VIZ_TYPE_ONLY: ReadonlySet<string> = new Set(['src/viz/source/roomSource.ts', 'src/viz/server/models.ts', 'src/viz/server/viewModel.ts']);

/**
 * The I/O modules model/** and render/** must not import (VIZ-10 as amended: no I/O, clock, randomness or DOM;
 * Node only for node:crypto hashing): every Node built-in except crypto; the ports (fs, clock, random,
 * scheduler, lease, log, trace, crashpoint); src/git/ except its pure leaves; the engine and the entries; and the
 * viewer's I/O layers (source/**, server/**, cli/**, client/**, main.ts, assets.ts) except their type-only files.
 */
function isIoTarget(t: Target): boolean {
  if (t.kind === 'node') return t.name !== 'crypto';
  if (t.kind === 'other') return true;
  const p = t.path;
  if (p.startsWith('src/ports/') || p.startsWith('src/engine/') || p.startsWith('src/entry/')) return true;
  if (p.startsWith('src/git/')) return !PURE_GIT.has(p);
  if (VIZ_TYPE_ONLY.has(p)) return false;
  if (p === 'src/viz/main.ts' || p === 'src/viz/assets.ts') return true;
  return ['src/viz/source/', 'src/viz/server/', 'src/viz/cli/', 'src/viz/client/'].some((d) => p.startsWith(d));
}

/** What browser code (client/**, ui/**) never imports: src/ports, src/git, src/engine and the fold. */
function browserForbidden(p: string): boolean {
  return p.startsWith('src/ports/') || p.startsWith('src/git/') || p.startsWith('src/engine/') || p === 'src/board/fold.ts';
}

/** Only src/viz/main.ts, src/viz/cli/** and src/entry/cli.ts import src/viz/cli/** — and en.ts the CLI catalog (R-V54). */
function mayImportCli(from: string, target: string): boolean {
  if (from === 'src/viz/main.ts' || from.startsWith('src/viz/cli/') || from === 'src/entry/cli.ts') return true;
  return from === 'src/viz/i18n/en.ts' && target === 'src/viz/cli/strings.ts';
}

const OTHER_ENTRIES = /^src\/entry\/(?:daemon|hook|core|mcp|worker)\.ts$/;

function importRules(f: string, sf: ts.SourceFile, report: Report): void {
  const browser = f.startsWith(CLIENT_DIR) || f.startsWith('src/viz/ui/');
  const pure = f.startsWith('src/viz/model/') || f.startsWith('src/viz/render/');
  const r = (at: number, message: string): void => report('L-VIZ-IMPORT', at, message);
  for (const load of loadsOf(sf)) {
    if (load.directive !== null) {
      if (f.startsWith('src/viz/')) r(load.at, `/// <reference ${load.directive} /> adds declarations outside the program's own configuration`);
      continue;
    }
    if (load.spec === null) {
      if (browser || pure) r(load.at, `a module loaded by a non-literal specifier cannot be checked`);
      continue;
    }
    const spec = load.spec;
    const t = targetOf(f, spec);
    if (browser) {
      if (t.kind === 'node') r(load.at, `Node module "${spec}" in browser code`);
      else if (t.kind === 'other') r(load.at, `module "${spec}" in browser code (no package, no virtual module)`);
      else if (browserForbidden(t.path)) r(load.at, `"${spec}" (${t.path}) is not importable from browser code`);
    }
    if (pure && isIoTarget(t)) r(load.at, `I/O module "${spec}" in the pure ${f.startsWith('src/viz/model/') ? 'model' : 'render'} layer`);
    if (t.kind === 'file') {
      if (t.path.startsWith('src/viz/cli/') && !mayImportCli(f, t.path)) {
        r(load.at, `${t.path} is imported only by src/viz/main.ts, src/viz/cli/** and src/entry/cli.ts`);
      }
      if (OTHER_ENTRIES.test(f) && t.path.startsWith('src/viz/')) r(load.at, `${f} imports ${t.path}: no src/viz module outside cli.js and viz.js (VIZ-01)`);
      if (f === 'src/entry/cli.ts' && t.path.startsWith('src/viz/') && !t.path.startsWith('src/viz/cli/')) {
        r(load.at, `src/entry/cli.ts imports ${t.path}: cli.js bundles only src/viz/cli/** (VIZ-01, R-V54)`);
      }
      if (t.path === 'src/viz/assets.ts' && f !== 'src/entry/viz.ts') r(load.at, `src/viz/assets.ts is imported only by src/entry/viz.ts (R-V36)`);
    }
    if (spec.startsWith('viz-asset:') && f !== 'src/viz/assets.ts') r(load.at, `"${spec}" is imported only by src/viz/assets.ts (R-V36)`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// L-VIZ-DOM (src/viz/client/**; 12 §9.5, VIZ-37)

/** Members that are HTML, script or style sinks wherever they appear (also as object-literal keys). */
const DOM_MEMBERS: ReadonlySet<string> = new Set([
  'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'setHTMLUnsafe', 'parseHTMLUnsafe', 'createContextualFragment', 'srcdoc',
  'setAttributeNS', 'insertRule', 'sendBeacon', 'setProperty', 'onmessage',
]);
/** Globals the page never touches. */
const DOM_GLOBALS: ReadonlySet<string> = new Set(['DOMParser', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Worker', 'SharedWorker', 'eval']);
/** URL-valued members a non-literal value never reaches (the Blob-URL download link excepted). */
const URL_MEMBERS: ReadonlySet<string> = new Set(['href', 'src', 'srcset', 'action', 'formAction']);
const SET_ATTRIBUTE_FORBIDDEN: ReadonlySet<string> = new Set(['href', 'src', 'srcset', 'xlink:href', 'style', 'srcdoc', 'action', 'formaction']);
const API_PREFIX = '/api/v1/';
/** Binary operators whose result is always a number. */
const NUMERIC_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);
const ENUM_CONSTANT = /^[A-Z][A-Z0-9_]*$/;

function isDocument(e: ts.Expression): boolean {
  const x = unwrap(e);
  return (ts.isIdentifier(x) && x.text === 'document') || memberName(x) === 'document';
}

function isLocation(e: ts.Expression): boolean {
  const x = unwrap(e);
  return (ts.isIdentifier(x) && x.text === 'location') || memberName(x) === 'location';
}

/** `URL.createObjectURL(…)`: the one export download link's value. */
function isBlobUrl(e: ts.Expression): boolean {
  const x = unwrap(e);
  return ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'createObjectURL'
    && ts.isIdentifier(x.expression.expression) && x.expression.expression.text === 'URL';
}

/** An expression whose value is always a number. */
function isNumeric(e: ts.Expression): boolean {
  const x = unwrap(e);
  if (ts.isNumericLiteral(x)) return true;
  if (ts.isPrefixUnaryExpression(x)) {
    return x.operator === ts.SyntaxKind.PlusToken || x.operator === ts.SyntaxKind.MinusToken || x.operator === ts.SyntaxKind.TildeToken;
  }
  if (ts.isBinaryExpression(x)) {
    if (NUMERIC_OPERATORS.has(x.operatorToken.kind)) return true;
    return x.operatorToken.kind === ts.SyntaxKind.PlusToken && isNumeric(x.left) && isNumeric(x.right);
  }
  if (ts.isConditionalExpression(x)) return isNumeric(x.whenTrue) && isNumeric(x.whenFalse);
  if (ts.isCallExpression(x)) {
    const c = unwrap(x.expression);
    if (ts.isIdentifier(c)) return c.text === 'Number' || c.text === 'parseInt' || c.text === 'parseFloat';
    if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'Math') return true;
  }
  return false;
}

/** `NAME`, `NAME.key`, `NAME[k]`: a constant of an enum map. */
function isEnumConstant(e: ts.Expression): boolean {
  let x = unwrap(e);
  while (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) x = unwrap(x.expression);
  return ts.isIdentifier(x) && ENUM_CONSTANT.test(x.text);
}

/** A style property value: a literal, a number, an enum-map constant, a template of numbers, or a choice of those. */
function styleValueOk(e: ts.Expression): boolean {
  const x = unwrap(e);
  if (literalString(x) !== null || isNumeric(x) || isEnumConstant(x)) return true;
  if (ts.isTemplateExpression(x)) return x.templateSpans.every((s) => isNumeric(s.expression));
  if (ts.isConditionalExpression(x)) return styleValueOk(x.whenTrue) && styleValueOk(x.whenFalse);
  if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'toFixed') return isNumeric(x.expression.expression);
  return false;
}

/** A fetch's first argument: a literal or a template whose literal head starts with /api/v1/. */
function apiPath(a: ts.Expression | undefined): boolean {
  if (a === undefined) return false;
  const x = unwrap(a);
  const head = ts.isTemplateExpression(x) ? x.head.text : literalString(x);
  return head !== null && head.startsWith(API_PREFIX);
}

function domRules(sf: ts.SourceFile, report: Report): void {
  const r = (n: ts.Node, message: string): void => report('L-VIZ-DOM', n, message);
  const checkFetch = (node: ts.Node): void => {
    const call = isCallee(node);
    if (call === null) r(node, `fetch referenced without a literal /api/v1/ path`);
    else if (!apiPath(call.arguments[0])) r(node, `fetch whose first argument is not a literal starting ${API_PREFIX}`);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const m = memberName(n);
      if (m !== null) {
        if (DOM_MEMBERS.has(m)) r(n, `${m} is an HTML, script or style sink`);
        if ((m === 'write' || m === 'writeln') && isDocument(n.expression)) r(n, `document.${m}`);
        if (isGlobalObject(n.expression)) {
          if (m === 'open') r(n, `window.open`);
          if (DOM_GLOBALS.has(m)) r(n, `${m}`);
          if (m === 'fetch') checkFetch(n);
        }
      } else if (ts.isElementAccessExpression(n) && (isGlobalObject(n.expression) || isDocument(n.expression))) {
        r(n, `a computed member of a global object`);
      }
    }
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isMethodDeclaration(n)) && n.name !== undefined) {
      const key = ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : null;
      if (key !== null && DOM_MEMBERS.has(key)) r(n, `${key} as an object key (Object.assign sink)`);
    }
    if (ts.isBindingElement(n) && n.propertyName === undefined && ts.isIdentifier(n.name) && DOM_MEMBERS.has(n.name.text)) {
      r(n, `${n.name.text} destructured`);
    }
    if (ts.isBindingElement(n) && n.propertyName !== undefined && ts.isIdentifier(n.propertyName) && DOM_MEMBERS.has(n.propertyName.text)) {
      r(n, `${n.propertyName.text} destructured`);
    }
    if (ts.isIdentifier(n) && isReference(n)) {
      if (DOM_GLOBALS.has(n.text)) r(n, `${n.text}`);
      if (n.text === 'fetch') checkFetch(n);
      if (n.text === 'open' && isCallee(n) !== null) r(n, `open() (window.open)`);
    }
    if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === 'Function') {
      r(n, `the Function constructor`);
    }
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const name = calleeName(callee);
      const a0 = n.arguments[0];
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) r(n, `dynamic import()`);
      if (name === 'setTimeout' || name === 'setInterval') {
        const fn = a0 !== undefined && (ts.isArrowFunction(unwrap(a0)) || ts.isFunctionExpression(unwrap(a0)));
        if (!fn) r(n, `${name} without a function literal (a string argument is eval)`);
      }
      if (name === 'setAttribute' && !ts.isIdentifier(callee)) {
        const attr = a0 === undefined ? null : literalString(unwrap(a0));
        if (attr === null) r(n, `setAttribute with a non-literal attribute name`);
        else if (attr.toLowerCase().startsWith('on') || SET_ATTRIBUTE_FORBIDDEN.has(attr.toLowerCase())) r(n, `setAttribute('${attr}')`);
      }
      const oneValue = name === 'replaceSync' || (name === 'replace' && n.arguments.length === 1)
        || (name === 'assign' && ts.isPropertyAccessExpression(callee) && isLocation(callee.expression));
      if (oneValue && (a0 === undefined || literalString(unwrap(a0)) === null)) r(n, `${name} with a non-literal value`);
      if (name === 'addEventListener') {
        const type = a0 === undefined ? null : literalString(unwrap(a0));
        if (type === null) r(n, `addEventListener with a non-literal event type`);
        else if (type === 'message') r(n, `a message event listener`);
      }
    }
    if (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind)) {
      const left = unwrap(n.left);
      const plain = n.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      const literal = plain && literalString(unwrap(n.right)) !== null;
      const m = ts.isIdentifier(left) ? (left.text === 'location' ? 'location' : null) : memberName(left);
      if (m !== null && URL_MEMBERS.has(m)) {
        const blob = plain && m === 'href' && isBlobUrl(n.right) && !isLocation((left as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression);
        if (!literal && !blob) r(n, `a non-literal ${m}`);
      }
      if ((m === 'location' || m === 'cssText' || m === 'style') && !literal) r(n, `a non-literal ${m}`);
      if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && memberName(unwrap(left.expression)) === 'style') {
        if (m === null) r(n, `a style property with a computed name`);
        else if (m !== 'cssText' && (!plain || !styleValueOk(n.right))) r(n, `style.${m} set to a value that is not a number or an enum-map constant`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------------------------------------------------
// L-VIZ-GIT (src/viz/**; VIZ-07, V6)

/** What the static check passes for an element it cannot read (see vizGitArgvOk). */
const PLACEHOLDER = '<non-literal>';
const SPAWN_FNS: ReadonlySet<string> = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const SHELL_FNS: ReadonlySet<string> = new Set(['exec', 'execSync']);
const SET_LIKE: ReadonlySet<string> = new Set(['Set', 'Map', 'WeakSet', 'WeakMap']);
const COUNT_FLAGS: ReadonlySet<string> = new Set(['--skip=', '--max-count=']);
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/;

/** An argv element as the static check sees it. */
function argvElement(e: ts.Expression): string {
  const x = unwrap(e);
  const text = literalString(x);
  if (text !== null) return text;
  if (ts.isTemplateExpression(x) && COUNT_FLAGS.has(x.head.text) && x.templateSpans.length === 1 && x.templateSpans[0]?.literal.text === '') {
    return x.head.text + PLACEHOLDER;
  }
  return PLACEHOLDER;
}

const CHILD_PROCESS: ReadonlySet<string> = new Set(['child_process', 'node:child_process']);

/** `require('child_process')`, `import('node:child_process')` or `await import(…)` of it. */
function isChildProcessLoad(e: ts.Expression | undefined): boolean {
  if (e === undefined) return false;
  let x = unwrap(e);
  if (ts.isAwaitExpression(x)) x = unwrap(x.expression);
  if (!ts.isCallExpression(x)) return false;
  const loader = x.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(x.expression) && x.expression.text === 'require');
  const a0 = x.arguments[0];
  return loader && a0 !== undefined && ts.isStringLiteralLike(a0) && CHILD_PROCESS.has(a0.text);
}

/** How a file reaches child_process: local names bound to its spawn functions, and names bound to the module itself. */
interface ChildProcessBindings { fns: Map<string, string>; modules: Set<string>; }

function childProcessBindings(sf: ts.SourceFile): ChildProcessBindings {
  const b: ChildProcessBindings = { fns: new Map(), modules: new Set() };
  const named = (local: string, imported: string): void => {
    if (SPAWN_FNS.has(imported)) b.fns.set(local, imported);
    else if (imported === 'default') b.modules.add(local);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && CHILD_PROCESS.has(n.moduleSpecifier.text) && n.importClause !== undefined) {
      const c = n.importClause;
      if (c.name !== undefined) b.modules.add(c.name.text);
      if (c.namedBindings !== undefined && ts.isNamespaceImport(c.namedBindings)) b.modules.add(c.namedBindings.name.text);
      if (c.namedBindings !== undefined && ts.isNamedImports(c.namedBindings)) {
        for (const s of c.namedBindings.elements) named(s.name.text, (s.propertyName ?? s.name).text);
      }
    }
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteralLike(n.moduleReference.expression)
      && CHILD_PROCESS.has(n.moduleReference.expression.text)) {
      b.modules.add(n.name.text);
    }
    if (ts.isVariableDeclaration(n) && isChildProcessLoad(n.initializer)) {
      if (ts.isIdentifier(n.name)) b.modules.add(n.name.text);
      else if (ts.isObjectBindingPattern(n.name)) {
        for (const e of n.name.elements) {
          const key = e.propertyName ?? e.name;
          const imported = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
          if (imported !== null && ts.isIdentifier(e.name)) named(e.name.text, imported);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return b;
}

/** The child_process function a call invokes (`spawn(…)` of an imported binding, `cp.spawn(…)`, `require('child_process').spawn(…)`),
 *  else null: a same-named member of anything else (`/x/.exec(s)`) is not a spawn. */
function spawnCall(callee: ts.Expression, b: ChildProcessBindings): string | null {
  if (ts.isIdentifier(callee)) return b.fns.get(callee.text) ?? null;
  const m = memberName(callee);
  if (m === null || !SPAWN_FNS.has(m)) return null;
  const o = unwrap((callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression);
  return (ts.isIdentifier(o) && b.modules.has(o.text)) || isChildProcessLoad(o) ? m : null;
}

/** A `new Set([...])`/`new Map([...])` argument is a table, not an argv. */
function isTableArgument(arr: ts.ArrayLiteralExpression): boolean {
  let p: ts.Node = arr.parent;
  while (ts.isAsExpression(p) || ts.isParenthesizedExpression(p) || ts.isSatisfiesExpression(p)) p = p.parent;
  return ts.isNewExpression(p) && ts.isIdentifier(p.expression) && SET_LIKE.has(p.expression.text);
}

/** The one module that may pass `.run(` a non-literal argv: VizGit checks every argv with vizGitArgvOk before it spawns. */
const VIZ_GIT_FACADE = 'src/viz/source/vizGit.ts';

function gitRules(f: string, sf: ts.SourceFile, report: Report): void {
  const cli = f.startsWith('src/viz/cli/');
  const cp = cli ? childProcessBindings(sf) : null;
  const checked = new Set<ts.Node>();
  const check = (arr: ts.ArrayLiteralExpression): void => {
    if (checked.has(arr)) return;
    checked.add(arr);
    // A spread may expand to any number of elements (flags included) and a hole is no argument: neither is
    // one placeholder element, so neither can be checked.
    const unreadable = arr.elements.find((e) => ts.isSpreadElement(e) || ts.isOmittedExpression(e));
    if (unreadable !== undefined) {
      report('L-VIZ-GIT', unreadable, `${ts.isSpreadElement(unreadable) ? 'a spread' : 'a hole'} in a git argv cannot be checked against the viewer allowlist (VIZ-07)`);
      return;
    }
    const argv = arr.elements.map(argvElement);
    if (!vizGitArgvOk(argv, PLACEHOLDER)) {
      report('L-VIZ-GIT', arr, `git argv ${JSON.stringify(argv)} is not in the viewer allowlist (VIZ-07)`);
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const a0 = n.arguments[0] === undefined ? undefined : unwrap(n.arguments[0]);
      if (memberName(callee) === 'run') {
        if (a0 !== undefined && ts.isArrayLiteralExpression(a0)) check(a0);
        else if (f !== VIZ_GIT_FACADE) {
          report('L-VIZ-GIT', n, `.run( without an array-literal argv: only ${VIZ_GIT_FACADE} passes a non-literal argv (checked at run time, VIZ-07)`);
        }
      }
      const name = cp === null ? null : spawnCall(callee, cp);
      if (name !== null && a0 !== undefined) {
        const text = literalString(a0);
        if (text !== null) {
          const t = text.trim();
          const exe = SHELL_FNS.has(name) ? (t.startsWith('"') ? t.slice(1, t.indexOf('"', 1) < 0 ? undefined : t.indexOf('"', 1)) : (t.split(/\s+/)[0] ?? '')) : t;
          if (!ABSOLUTE.test(exe)) report('L-VIZ-GIT', n, `${name}('${exe}'): src/viz/cli/** spawns no bare executable name (12 §3.10.8)`);
        }
      }
    }
    if (ts.isArrayLiteralExpression(n) && !isTableArgument(n)) {
      const first = n.elements[0] === undefined ? null : literalString(unwrap(n.elements[0]));
      if (first !== null && VIZ_GIT_SUBCOMMANDS.has(first)) check(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------------------------------------------------
// L-VIZ-URL (src/viz/**; R-V55)

const LOOPBACK_HEAD = 'http://127.0.0.1:';

function urlRules(f: string, sf: ts.SourceFile, report: Report): void {
  const visit = (n: ts.Node): void => {
    const text = literalString(n);
    if (text !== null && text.includes('://')) report('L-VIZ-URL', n, `URL literal (only the viewer's loopback templates are allowed)`);
    if (ts.isTemplateExpression(n)) {
      const spans = n.templateSpans;
      const all = n.head.text + spans.map((s) => s.literal.text).join('');
      if (all.includes('://')) {
        const launch = f === 'src/viz/cli/view.ts' && n.head.text === LOOPBACK_HEAD && spans.length >= 1 && (spans[0]?.literal.text ?? '').startsWith('/#k=');
        const origin = f === 'src/viz/server/http.ts' && n.head.text === LOOPBACK_HEAD && spans.length === 1 && spans[0]?.literal.text === '';
        if (!launch && !origin) report('L-VIZ-URL', n, `URL template other than the launch URL in view.ts or the origin in http.ts`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------------------------------------------------
// L-VIZ-NET (src/viz/** outside client/**; S6, V14)

const NET_GLOBALS: ReadonlySet<string> = new Set(['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']);
/** Client members of the http module. */
const HTTP_CLIENT: ReadonlySet<string> = new Set(['request', 'get', 'globalAgent']);
/** Client names forbidden anywhere in http.ts. */
const SOCKET_CLIENT: ReadonlySet<string> = new Set(['Agent', 'connect', 'createConnection']);

function isHttpRequire(e: ts.Expression | undefined): boolean {
  if (e === undefined) return false;
  const x = unwrap(e);
  return ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'require'
    && x.arguments[0] !== undefined && ts.isStringLiteralLike(x.arguments[0]) && HTTP_MODULES.has(x.arguments[0].text);
}

/** `listen({ host: '127.0.0.1', … })` with no spread: anything else may bind beyond loopback. */
function loopbackListen(call: ts.CallExpression): boolean {
  const a0 = call.arguments[0] === undefined ? undefined : unwrap(call.arguments[0]);
  if (a0 === undefined || !ts.isObjectLiteralExpression(a0)) return false;
  if (a0.properties.some((p) => ts.isSpreadAssignment(p))) return false;
  const host = a0.properties.find((p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'host');
  return host !== undefined && ts.isPropertyAssignment(host) && literalString(unwrap(host.initializer)) === '127.0.0.1';
}

function netRules(f: string, sf: ts.SourceFile, report: Report): void {
  const r = (n: ts.Node, message: string): void => report('L-VIZ-NET', n, message);
  const httpTs = f === 'src/viz/server/http.ts';
  const httpNames = new Set<string>();
  if (httpTs) {
    const collect = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && HTTP_MODULES.has(n.moduleSpecifier.text) && n.importClause !== undefined) {
        const c = n.importClause;
        if (c.name !== undefined) httpNames.add(c.name.text);
        if (c.namedBindings !== undefined && ts.isNamespaceImport(c.namedBindings)) httpNames.add(c.namedBindings.name.text);
        if (c.namedBindings !== undefined && ts.isNamedImports(c.namedBindings)) {
          for (const s of c.namedBindings.elements) {
            const imported = (s.propertyName ?? s.name).text;
            if (HTTP_CLIENT.has(imported)) r(s, `http.${imported} imported (the viewer is a server only)`);
          }
        }
      }
      if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteralLike(n.moduleReference.expression)
        && HTTP_MODULES.has(n.moduleReference.expression.text)) {
        httpNames.add(n.name.text);
      }
      if (ts.isVariableDeclaration(n) && isHttpRequire(n.initializer)) {
        if (ts.isIdentifier(n.name)) httpNames.add(n.name.text);
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const b of n.name.elements) {
            const key = b.propertyName ?? b.name;
            if (ts.isIdentifier(key) && HTTP_CLIENT.has(key.text)) r(b, `http.${key.text} required (the viewer is a server only)`);
          }
        }
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
  }
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && isReference(n)) {
      if (NET_GLOBALS.has(n.text)) r(n, `${n.text}: no network client in viewer server code`);
      if (httpTs && SOCKET_CLIENT.has(n.text)) r(n, `${n.text}: no outbound socket`);
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const m = memberName(n);
      if (m !== null) {
        if (NET_GLOBALS.has(m) && isGlobalObject(n.expression)) r(n, `${m}: no network client in viewer server code`);
        if (httpTs && SOCKET_CLIENT.has(m)) r(n, `${m}: no outbound socket`);
        else if (httpTs && HTTP_CLIENT.has(m)) {
          const o = unwrap(n.expression);
          if (ts.isIdentifier(o) && httpNames.has(o.text)) r(n, `http.${m}: the viewer is a server only`);
        }
      }
    }
    if (httpTs && ts.isCallExpression(n) && calleeName(unwrap(n.expression)) === 'listen' && !loopbackListen(n)) {
      r(n, `listen() without the options object { host: '127.0.0.1', … }`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------------------------------------------------
// lintVizSource

/** L-VIZ-DOM, L-VIZ-GIT, L-VIZ-IMPORT, L-VIZ-URL and L-VIZ-NET over one repository-relative file. */
export function lintVizSource(file: string, text: string): LintFinding[] {
  const f = normalizeFile(file);
  const viz = f.startsWith('src/viz/');
  if (!viz && !f.startsWith('src/entry/')) return [];
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: LintFinding[] = [];
  const report: Report = (rule, at, message) => {
    const pos = typeof at === 'number' ? at : at.getStart(sf);
    out.push({ rule, file: f, line: sf.getLineAndCharacterOfPosition(pos).line + 1, message });
  };
  importRules(f, sf, report);
  if (viz) {
    const client = f.startsWith(CLIENT_DIR);
    if (client) domRules(sf, report);
    gitRules(f, sf, report);
    urlRules(f, sf, report);
    if (!client) netRules(f, sf, report);
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------------------------------------
// The client program (R-V35): its import closure (L-VIZ-IMPORT) and its typecheck (L-VIZ-TYPES)

const CLIENT_TSCONFIG = 'src/viz/client/tsconfig.json';
const CLIENT_PROGRAM_DIRS: readonly string[] = ['src/viz/client/', 'src/viz/ui/', 'src/viz/render/'];
const CLIENT_PROGRAM_FILES: ReadonlySet<string> = new Set([
  'src/viz/model/events.ts', 'src/viz/model/scene.ts', 'src/viz/model/layout.ts', 'src/viz/model/placement.ts', 'src/viz/model/cards.ts',
  'src/viz/model/labels.ts', 'src/viz/server/viewModel.ts', 'src/text/sanitize.ts', 'src/i18n/render.ts', 'src/viz/i18n/codes.ts',
]);

/** R-V35: the client program is exactly client/**, ui/**, the six shared model files, render/**, viewModel.ts, sanitize.ts, render.ts and codes.ts. */
function inClientProgram(rel: string): boolean {
  return CLIENT_PROGRAM_DIRS.some((d) => rel.startsWith(d)) || CLIENT_PROGRAM_FILES.has(rel);
}

function errorCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : String(e);
}

/**
 * Every `.ts` file (`.d.ts` included) under the directories `rels` of root, repository-relative. Only an absent
 * top-level directory (ENOENT) is skipped; any other error throws (lint exits 2) — a directory that cannot be
 * listed must never read as one without files.
 */
function tsFilesUnder(root: string, rels: readonly string[], what: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, optional: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(root, ...rel.split('/')), { withFileTypes: true });
    } catch (e) {
      if (optional && errorCode(e) === 'ENOENT') return;
      throw new Error(`${rel}: cannot list a directory of ${what} (${errorCode(e)})`);
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child, false);
      else if (e.isFile() && e.name.endsWith('.ts')) out.push(child);
    }
  };
  for (const d of rels) walk(d, true);
  return out;
}

/** The existing files of the client program under root, repository-relative, sorted. */
function clientProgramFiles(root: string): string[] {
  const out = tsFilesUnder(root, CLIENT_PROGRAM_DIRS.map((d) => d.slice(0, -1)), 'the client program');
  for (const f of CLIENT_PROGRAM_FILES) {
    let st;
    try {
      st = statSync(path.join(root, ...f.split('/')), { throwIfNoEntry: false });
    } catch (e) {
      throw new Error(`${f}: cannot read a file of the client program (${errorCode(e)})`);
    }
    if (st !== undefined) out.push(f);
  }
  return [...new Set(out)].sort();
}

/**
 * L-VIZ-IMPORT, client closure (R-V35): every module the client program's files import — type-only imports,
 * `import()` types and triple-slash references included — lies in the client program; no Node built-in,
 * package or virtual module. [] when <root>/src/viz/client/tsconfig.json is absent.
 */
export function lintVizClientClosure(root: string): LintFinding[] {
  if (!existsSync(path.join(root, ...CLIENT_TSCONFIG.split('/')))) return [];
  const out: LintFinding[] = [];
  for (const f of clientProgramFiles(root)) {
    const text = readFileSync(path.join(root, ...f.split('/')), 'utf8');
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const r = (at: number, message: string): void => {
      out.push({ rule: 'L-VIZ-IMPORT', file: f, line: sf.getLineAndCharacterOfPosition(at).line + 1, message });
    };
    for (const load of loadsOf(sf)) {
      if (load.directive !== null) r(load.at, `/// <reference ${load.directive} /> in the client program (R-V35)`);
      else if (load.spec === null) r(load.at, `a non-literal module load in the client program (R-V35)`);
      else {
        const t = targetOf(f, load.spec);
        if (t.kind !== 'file') r(load.at, `"${load.spec}" is not a module of the client program (R-V35)`);
        else if (!inClientProgram(t.path)) r(load.at, `${t.path} is outside the client program (R-V35), type-only imports included`);
      }
    }
  }
  return out;
}

/** The root program's include roots (tsconfig.json: src/**, test/**, tools/**). */
const MAIN_PROGRAM_DIRS: readonly string[] = ['src', 'test', 'tools'];
/** Libraries that declare browser globals: dom, dom.iterable, dom.asynciterable, webworker, webworker.importscripts, … */
const BROWSER_LIB = /^(?:dom|webworker)(?:\.|$)/i;

/**
 * L-VIZ-TYPES, main program (R-V35): lib DOM belongs to the client program alone. A `/// <reference lib="dom" />`
 * (or another browser library) in any other .ts or .d.ts file under src/**, test/** or tools/** — files the per-file
 * rules never read, a .d.ts that the include glob drops but a `/// <reference path>` still loads — would put the
 * browser globals into `npm run typecheck`'s program, so server code could reference them. Files of the client
 * program are left to L-VIZ-IMPORT (it reports every directive there).
 */
export function lintVizMainProgramDom(root: string): LintFinding[] {
  const out: LintFinding[] = [];
  for (const f of tsFilesUnder(root, MAIN_PROGRAM_DIRS, 'the main program').sort()) {
    if (inClientProgram(f)) continue;
    const text = readFileSync(path.join(root, ...f.split('/')), 'utf8');
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const r of sf.libReferenceDirectives) {
      if (!BROWSER_LIB.test(r.fileName)) continue;
      out.push({
        rule: 'L-VIZ-TYPES', file: f, line: sf.getLineAndCharacterOfPosition(r.pos).line + 1,
        message: `/// <reference lib="${r.fileName}" /> puts browser globals into the main program (tsconfig.json); lib DOM is the client program's alone (R-V35)`,
      });
    }
  }
  return out;
}

/**
 * L-VIZ-TYPES (R-V35): typechecks <root>/src/viz/client/tsconfig.json — lib ES2022 + DOM, types [] — with
 * ts.getParsedCommandLineOfConfigFile + createProgram + getPreEmitDiagnostics, one finding per diagnostic.
 * The program's roots are the tsconfig's files plus every existing file of the R-V35 client program, so
 * ui/**, render/** and the shared modules are checked for browser use even before the page imports them.
 * [] when that tsconfig is absent.
 */
export function lintVizClientProgram(root: string): LintFinding[] {
  const configPath = path.join(root, ...CLIENT_TSCONFIG.split('/'));
  if (!existsSync(configPath)) return [];
  const out: LintFinding[] = [];
  const rel = (abs: string): string => path.relative(root, abs).split(path.sep).join('/');
  const add = (d: ts.Diagnostic): void => {
    const message = `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    if (d.file !== undefined && d.start !== undefined) {
      out.push({ rule: 'L-VIZ-TYPES', file: rel(d.file.fileName), line: d.file.getLineAndCharacterOfPosition(d.start).line + 1, message });
    } else {
      out.push({ rule: 'L-VIZ-TYPES', file: CLIENT_TSCONFIG, line: 1, message });
    }
  };
  const host: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: ts.sys.readDirectory,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    onUnRecoverableConfigFileDiagnostic: add,
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host);
  if (parsed === undefined) {
    if (out.length === 0) out.push({ rule: 'L-VIZ-TYPES', file: CLIENT_TSCONFIG, line: 1, message: 'cannot read the client tsconfig' });
    return out;
  }
  const roots = [...new Set([...parsed.fileNames.map((p) => path.resolve(p)), ...clientProgramFiles(root).map((f) => path.join(root, ...f.split('/')))])];
  const program = ts.createProgram({
    rootNames: roots,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed),
  });
  for (const d of ts.getPreEmitDiagnostics(program)) add(d);
  return out;
}
