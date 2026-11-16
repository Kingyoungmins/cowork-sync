// tools/lint/p5rules.ts — the Plan 5 rule bodies (Task 2), registered by rules.ts (lintSource) and lint.ts (the file scans and the import-graph
// walk): 06 §3.2's build lints (CCI-03), 11 §3.10's L-HOOKS-JSON, L-PERMISSION (widened), L-HUMAN-ONLY (Plan 5 parts), L-MCP-SCHEMA and L-TOKEN
// (Plan 5 form), and R5-03's L-LOADER, L-HOOK-THIN and L-SPAWN. Every check is a pure function of the texts it is given.
//   lintSource parts (p5SourceRules): L-TOKEN, L-PERMISSION (src/**), L-LOADER source half (src/entry/hook.ts), L-SPAWN, L-HUMAN-ONLY.
//   File entries: lintHooksJson (plugin/hooks/*.json), lintCommandFile (plugin/commands/*.md), lintDistLoader (dist/hook.js),
//   lintDistPermission (dist/*.js), lintMcpSchema (the MCP tool schemas, Task 14), lintHookThin / walkHookThin (the client tier's import graph).
import path from 'node:path';
import ts from 'typescript';
import { TOKEN_ENV } from '../../src/claude/client/mcp/doorbell.js';
import { C } from '../../src/claude/wire/constants.js';
import { HOOK_EVENTS, HOOK_REGISTRATIONS, type WireJson } from '../../src/claude/wire/frames.js';
import { canonicalJsonLine } from '../../src/claude/wire/ndjson.js';
import { literalText, loadedModule, type LintFinding } from './rules.js';

export type Report = (rule: string, node: ts.Node, message: string) => void;

/** 06 §3.16, glossary §15, CCI-47: the sentence every MCP tool description carries (L-MCP-SCHEMA). */
export const MCP_DESCRIPTION_SENTENCE = 'files a record on the shared cowork board; this is not a message to another session.';
/** Glossary §15: the eight MCP tools (L-HUMAN-ONLY). */
const GLOSSARY_TOOLS: ReadonlySet<string> = new Set([
  'cowork_status', 'cowork_show', 'cowork_request', 'cowork_respond', 'cowork_note', 'cowork_release', 'cowork_checkpoint', 'cowork_resolve',
]);
/** 11 §3.10 L-HUMAN-ONLY: the v2 verbs (and `undo`, rev 2.5 F10: this peer's own change-sets use `revert`). */
const V2_VERBS: ReadonlySet<string> = new Set(['override', 'adopt', 'end', 'gc', 'eol', 'protocol', 'blame', 'where', 'holds', 'undo']);
const PERMISSION_FIELD = 'permissionDecision';
const CHILD_PROCESS: ReadonlySet<string> = new Set(['child_process', 'node:child_process']);
const LOADER_FILE = 'src/entry/hook.ts';
const INBOX_PORT = 'src/ports/inbox.ts';
const SPAWNER = 'src/claude/client/spawn.ts';
const HOOK_ARG0 = '${CLAUDE_PLUGIN_ROOT}/dist/hook.js';

/** The MCP tier (CCI-47): the MCP server's files, bundled into dist/mcp.js. */
function inMcpTier(f: string): boolean {
  return f.startsWith('src/claude/client/mcp/') || f === 'src/entry/mcp.ts';
}

/** A relative module specifier resolved against the importing file, with the .js → .ts rule (forward slashes, repository-relative). */
export function resolveSpecifier(from: string, spec: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  return joined.endsWith('.js') ? `${joined.slice(0, -'.js'.length)}.ts` : joined;
}

/** A path literal naming the daemon bundle: `daemon.js`, `dist/daemon.js`, `${root}/dist/daemon.js`, … (a substitution reads as a separator). */
function isDaemonPath(text: string): boolean {
  return /(^|[\\/])daemon\.js$/i.test(text.split('${}').join('/'));
}

/** True when a literal reaches a call's (or `new`'s) argument list through expression nodes only (no statement or function boundary). */
function passedToCall(node: ts.Node): boolean {
  let child: ts.Node = node;
  let p: ts.Node | undefined = node.parent;
  while (p !== undefined) {
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && (p.arguments ?? []).some((a) => a === child)) return true;
    const through = ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p)
      || ts.isNonNullExpression(p) || ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || ts.isConditionalExpression(p)
      || ts.isBinaryExpression(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isPropertyAccessExpression(p)
      || ts.isObjectLiteralExpression(p) || ts.isPropertyAssignment(p) || ts.isCallExpression(p) || ts.isNewExpression(p);
    if (!through) return false;
    child = p;
    p = p.parent;
  }
  return false;
}

/** The name a variable declaration binds, when it is a plain identifier. */
function declaredName(node: ts.Node): string | null {
  return ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : null;
}

/** Every string literal under a node. */
function stringsUnder(node: ts.Node): ts.StringLiteralLike[] {
  const out: ts.StringLiteralLike[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** True for a dynamic `import(…)` call. */
function isDynamicImport(node: ts.Node): boolean {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/** A `require(…)` or `import(…)` whose argument is not a string literal: what it loads cannot be checked. */
function isComputedLoad(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
  if (!isRequire && !isDynamicImport(node)) return false;
  const arg0 = node.arguments[0];
  return arg0 === undefined || !ts.isStringLiteralLike(arg0);
}

/** The loader's admitted loads (R5-03, A2-1): `node:*`, and `./core.js` only through `import()`. */
function loaderLoadAllowed(node: ts.Node, spec: string): boolean {
  return spec.startsWith('node:') || (spec === './core.js' && isDynamicImport(node));
}

/** The Plan 5 parts of lintSource for one file (repository-relative, forward slashes); `report` applies rules.ts's ALLOW table. */
export function p5SourceRules(f: string, sf: ts.SourceFile, report: Report): void {
  const inSrc = f.startsWith('src/');
  const mcpTier = inMcpTier(f);
  const visit = (node: ts.Node): void => {
    // L-TOKEN (every file: src/**, test/**, tools/**): the token's name as an identifier, a string or a template part.
    const lit = literalText(node);
    if ((ts.isIdentifier(node) && node.text.includes(TOKEN_ENV)) || (lit !== null && lit.includes(TOKEN_ENV))) {
      report('L-TOKEN', node, `${TOKEN_ENV} referenced outside src/claude/client/mcp/doorbell.ts (INV-TOKEN, CCI-49)`);
    }
    const mod = loadedModule(node);
    if (inSrc) {
      // L-TOKEN: the inbox poster is loaded only by the MCP tier (no daemon code path opens an inbox socket).
      if (mod !== null && !mcpTier && f !== INBOX_PORT && resolveSpecifier(f, mod) === INBOX_PORT) {
        report('L-TOKEN', node, `${INBOX_PORT} loaded outside the MCP tier: only the MCP server posts to an inbox socket (INV-TOKEN)`);
      }
      // L-PERMISSION (widened, M26): no code token of src/** names the permission field, whatever its value (06 §3.2, CCI-11).
      if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.text.includes(PERMISSION_FIELD)) {
        report('L-PERMISSION', node, `${PERMISSION_FIELD} in src/: no hook output carries a permission decision (CCI-11, INV-CCI-NODECISION)`);
      } else if ((lit !== null && lit.includes(PERMISSION_FIELD)) || (ts.isRegularExpressionLiteral(node) && node.text.includes(PERMISSION_FIELD))) {
        report('L-PERMISSION', node, `${PERMISSION_FIELD} in src/: no hook output carries a permission decision (CCI-11, INV-CCI-NODECISION)`);
      }
      // L-LOADER (source half): the loader loads node:* only, and ./core.js only through import() (R5-03, A2-1).
      if (f === LOADER_FILE) {
        if (mod !== null && !loaderLoadAllowed(node, mod)) {
          report('L-LOADER', node, `the hook loader loads "${mod}": only node:* built-ins, and ./core.js through import() (R5-03)`);
        } else if (isComputedLoad(node)) {
          report('L-LOADER', node, `the hook loader loads a computed module: only node:* built-ins, and ./core.js through import() (R5-03)`);
        }
      }
      // L-SPAWN: a daemon bundle path passed to a call outside spawnDaemon() (06 §3.2, CCI-51; ALLOW: src/claude/client/spawn.ts).
      if (lit !== null && isDaemonPath(lit) && passedToCall(node)) {
        report('L-SPAWN', node, `"${lit}" passed to a call: only spawnDaemon() in ${SPAWNER} starts a daemon (CCI-51)`);
      }
      // L-SPAWN: the MCP tier spawns nothing — no child_process, no spawnDaemon, no import of the spawner (06 §3.2, R5-03).
      if (mcpTier && mod !== null) {
        const named = (ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined && ts.isNamedImports(node.importClause.namedBindings)
          && node.importClause.namedBindings.elements.some((e) => (e.propertyName ?? e.name).text === 'spawnDaemon'))
          || (ts.isExportDeclaration(node) && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
            && node.exportClause.elements.some((e) => (e.propertyName ?? e.name).text === 'spawnDaemon'));
        if (CHILD_PROCESS.has(mod)) {
          report('L-SPAWN', node, `"${mod}" loaded in the MCP tier: dist/mcp.js spawns nothing (06 §3.2)`);
        } else if (named || resolveSpecifier(f, mod) === SPAWNER) {
          report('L-SPAWN', node, `the MCP tier imports the daemon spawner: the MCP server never starts a daemon (06 §3.2, 06 #43)`);
        }
      }
      // L-HUMAN-ONLY: no MCP tool outside glossary §15; no v2 verb among the acting verbs (11 §3.10).
      const decl = declaredName(node);
      const init = ts.isVariableDeclaration(node) ? node.initializer : undefined;
      if (decl === 'TOOL_NAMES' && init !== undefined) {
        for (const s of stringsUnder(init)) {
          if (!GLOSSARY_TOOLS.has(s.text)) report('L-HUMAN-ONLY', s, `MCP tool "${s.text}" is not one of glossary §15's eight tools`);
        }
      }
      if (decl === 'ACTING_VERBS' && init !== undefined) {
        for (const s of stringsUnder(init)) {
          if (V2_VERBS.has(s.text)) report('L-HUMAN-ONLY', s, `"${s.text}" is a v2 verb (11 §3.10 L-HUMAN-ONLY)`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// L-HOOKS-JSON (11 §3.10; glossary §13 as superseded by §25 F5/F6; CCI-03 items 1–4)

/** The glossary §13 document: one group per HOOK_REGISTRATIONS row, in row order; no matcher key for a null matcher. */
export function expectedHooksJson(): WireJson {
  const hooks: Record<string, WireJson[]> = {};
  for (const r of HOOK_REGISTRATIONS) {
    const handler: WireJson = { type: 'command', command: 'node', args: [HOOK_ARG0, r.event], timeout: r.timeout };
    (hooks[r.event] ??= []).push(r.matcher === null ? { hooks: [handler] } : { matcher: r.matcher, hooks: [handler] });
  }
  return { hooks };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One handler: a command hook in exec form (`command: node`, `args: [<root>/dist/hook.js, <Event>]`) with the event's timeout; else why not. */
function handlerProblem(event: string, h: unknown): string | null {
  if (!isObject(h)) return `${event}: a handler is not an object`;
  if (h.type !== 'command') return `${event}: a "${String(h.type)}" hook (only exec-form command hooks; glossary §25 F6: other hook types fail open)`;
  if (h.command !== 'node' || !Array.isArray(h.args)) return `${event}: a shell-form command (exec form: "command": "node" with "args")`;
  if (canonicalJsonLine(h.args as WireJson) !== canonicalJsonLine([HOOK_ARG0, event])) {
    return `${event}: args ${JSON.stringify(h.args)}, expected ${JSON.stringify([HOOK_ARG0, event])}`;
  }
  // Fix r1 minor: the event's timeout comes from its HOOK_REGISTRATIONS row (10, SessionEnd 2), the one table expectedHooksJson uses too.
  const timeout = HOOK_REGISTRATIONS.find((r) => r.event === event)?.timeout;
  if (h.timeout !== timeout) return `${event}: timeout ${JSON.stringify(h.timeout)}, expected ${String(timeout)} (glossary §13)`;
  return null;
}

/** L-HOOKS-JSON over a hooks.json text: one finding per wrong handler or unknown event; a document with neither that still differs from
 *  glossary §13 (events, matchers, groups, keys) gets one finding. UTF-8 without BOM, LF only (CCI-05). */
export function lintHooksJson(file: string, text: string): LintFinding[] {
  const out: LintFinding[] = [];
  const add = (message: string, line = 1): void => { out.push({ rule: 'L-HOOKS-JSON', file, line, message }); };
  if (text.startsWith('\u{FEFF}')) add('hooks.json starts with a BOM (UTF-8 without BOM, CCI-05)');
  if (text.includes('\r')) add('hooks.json holds a CR (LF line ends, CCI-05)');
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    add(`hooks.json is not JSON (${e instanceof Error ? e.message : String(e)})`);
    return out;
  }
  const lineOf = (needle: string): number => {
    const i = text.indexOf(needle);
    return i < 0 ? 1 : text.slice(0, i).split('\n').length;
  };
  const before = out.length;
  const hooks = isObject(doc) ? doc.hooks : undefined;
  if (isObject(hooks)) {
    const known: ReadonlySet<string> = new Set(HOOK_EVENTS);
    for (const [event, groups] of Object.entries(hooks)) {
      if (!known.has(event)) {
        add(`event "${event}" is not registered by glossary §13 (no WorktreeCreate hook, no channel)`, lineOf(`"${event}"`));
        continue;
      }
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        const handlers = isObject(g) && Array.isArray(g.hooks) ? g.hooks : [];
        for (const h of handlers) {
          const problem = handlerProblem(event, h);
          if (problem !== null) add(problem, lineOf(`"${event}"`));
        }
      }
    }
  }
  if (out.length === before && canonicalJsonLine(doc as WireJson) !== canonicalJsonLine(expectedHooksJson())) {
    add('hooks.json differs from glossary §13 as superseded by §25 F5 (events, matchers, groups or keys)');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// L-HUMAN-ONLY over command files (06 §3.2: disable-model-invocation, no npx, no git push; CCI-03 items 6–7)

export function lintCommandFile(file: string, text: string): LintFinding[] {
  const out: LintFinding[] = [];
  // Fix r1 minor: a BOM or a CR is named as such (UTF-8 without BOM, LF; CCI-05), and the key checks below read the text without them.
  if (text.startsWith('\u{FEFF}')) out.push({ rule: 'L-HUMAN-ONLY', file, line: 1, message: 'a command file that starts with a BOM (UTF-8 without BOM, CCI-05)' });
  if (text.includes('\r')) out.push({ rule: 'L-HUMAN-ONLY', file, line: 1, message: 'a command file holding a CR (LF line ends, CCI-05)' });
  const body = text.replace(/^\u{FEFF}/u, '').replace(/\r\n?/g, '\n');
  const lines = body.split('\n');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(body);
  // The key in any YAML spelling (bare, "double" or 'single' quoted): exactly one occurrence, with the bare value true.
  const key = /^(["']?)disable-model-invocation\1\s*:/;
  const dmi = fm === null ? [] : (fm[1] as string).split('\n').filter((l) => key.test(l));
  if (dmi.length !== 1 || (dmi[0] as string).replace(key, '').trim() !== 'true') {
    out.push({ rule: 'L-HUMAN-ONLY', file, line: 1, message: 'a command file without "disable-model-invocation: true" (06 §3.2, SEC-25)' });
  }
  for (const [i, l] of lines.entries()) {
    if (/\bnpx\b/.test(l)) out.push({ rule: 'L-HUMAN-ONLY', file, line: i + 1, message: 'npx in a command file (humans reach the CLI only as node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js")' });
    if (/\bgit\s+push\b/.test(l)) out.push({ rule: 'L-HUMAN-ONLY', file, line: i + 1, message: 'git push in a command file (06 §3.2)' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// L-LOADER, dist half (06 §3.2, CCI-06; R5-03, A2-1): dist/hook.js ≤ 150 lines, loading only node:* and import("./core.js").

export function lintDistLoader(text: string): LintFinding[] {
  const file = 'dist/hook.js';
  const out: LintFinding[] = [];
  const count = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (count > C.LOADER_MAX_LINES) {
    out.push({ rule: 'L-LOADER', file, line: C.LOADER_MAX_LINES + 1, message: `dist/hook.js has ${count} lines (at most ${C.LOADER_MAX_LINES})` });
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node: ts.Node): void => {
    const mod = loadedModule(node);
    const line = (): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (mod !== null && !loaderLoadAllowed(node, mod)) {
      out.push({ rule: 'L-LOADER', file, line: line(), message: `dist/hook.js loads "${mod}": only node:* built-ins, and ./core.js through import()` });
    } else if (mod === null && isComputedLoad(node)) {
      out.push({ rule: 'L-LOADER', file, line: line(), message: 'dist/hook.js loads a computed module' });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// L-PERMISSION, dist half (06 §3.2: "the string permissionDecision anywhere in dist/"; M26 lint half).

export function lintDistPermission(files: ReadonlyMap<string, string>): LintFinding[] {
  const out: LintFinding[] = [];
  for (const [file, text] of files) {
    for (const [i, l] of text.split('\n').entries()) {
      if (l.includes(PERMISSION_FIELD)) out.push({ rule: 'L-PERMISSION', file, line: i + 1, message: `${PERMISSION_FIELD} in a bundle (06 §3.2)` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// L-MCP-SCHEMA (11 §3.10; CCI-47, CCI-67, R5-08): the eight live schemas ≤ 3,000 chars with F05's 80-char reserve; non-live and too-old:
// cowork_status alone, ≤ 400; every description carries the board sentence. A schema's size is its serialized {name, description, inputSchema}.

export function lintMcpSchema(schemas: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>, mode: 'live' | 'nonlive' | 'too_old'): LintFinding[] {
  const file = `toolSchemas(${mode})`;
  const out: LintFinding[] = [];
  const add = (message: string): void => { out.push({ rule: 'L-MCP-SCHEMA', file, line: 1, message }); };
  const size = (s: { name: string; description: string; inputSchema: unknown }): number =>
    JSON.stringify({ name: s.name, description: s.description, inputSchema: s.inputSchema }).length;
  for (const s of schemas) {
    if (!s.description.includes(MCP_DESCRIPTION_SENTENCE)) add(`${s.name}: the description lacks "${MCP_DESCRIPTION_SENTENCE}"`);
  }
  if (mode === 'live') {
    const total = schemas.reduce((n, s) => n + size(s), 0);
    if (total + C.CAPS.F05_CLAUSE_RESERVE > C.CAPS.SCHEMA_LIVE) {
      add(`the live schemas total ${total} chars + ${C.CAPS.F05_CLAUSE_RESERVE} reserved for F05 > ${C.CAPS.SCHEMA_LIVE}`);
    }
    return out;
  }
  if (schemas.length !== 1 || schemas[0]?.name !== 'cowork_status') {
    add(`${mode}: only cowork_status is listed (got ${schemas.map((s) => s.name).join(', ') || 'none'})`);
  }
  for (const s of schemas) {
    if (size(s) > C.CAPS.SCHEMA_NONLIVE) add(`${mode}: ${s.name} is ${size(s)} chars (at most ${C.CAPS.SCHEMA_NONLIVE})`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// L-HOOK-THIN (R5-03 as amended by X-61, X-63, X-110; CCI-51): the transitive import graph of the client tier's entries, from source
// (preProcessFile per file, relative specifiers with the .js → .ts rule; type-only imports count), reaches only R5-03's allow-list. Every
// other module — decided by its path, so it need not exist — is a finding with its import chain and is not walked further; a bare specifier
// other than node:* is a finding too (core.js and mcp.js bundle no package). A file the reader does not have is absent from the walk.

export const HOOK_THIN_ROOTS: readonly string[] = ['src/entry/core.ts', 'src/entry/mcp.ts'];
/** R5-03: the client tier itself and what it may import — src/claude/{client,wire,text}, src/text, src/i18n (every file under them). */
const HOOK_THIN_DIRS: readonly string[] = ['src/claude/client/', 'src/claude/wire/', 'src/claude/text/', 'src/text/', 'src/i18n/'];
/** R5-03's named files: five ports, five sec files, the two node-only src/data leaves (X-61, X-63), the one src/git exception (buildDaemonEnv
 *  for spawnDaemon) — and src/version.ts, Plan 1's PLUGIN_VERSION leaf that src/entry/{core,mcp}.ts print for --version (BL2-13; fix r1
 *  reading, pinned to import nothing by lint.p5.test.ts). */
const HOOK_THIN_FILES: ReadonlySet<string> = new Set([
  'src/ports/ipc.ts', 'src/ports/inbox.ts', 'src/ports/fs.ts', 'src/ports/clock.ts', 'src/ports/random.ts',
  'src/sec/ipcKey.ts', 'src/sec/winAcl.ts', 'src/sec/endpoint.ts', 'src/sec/handshake.ts', 'src/sec/sddl.ts',
  'src/data/pluginDataDir.ts', 'src/data/canonRoot.ts', 'src/git/env.ts', 'src/version.ts',
]);
/** R5-03 "src/ports (types)": any other src/ports file is admitted through a type-only edge only. */
const PORTS_FILE = /^src\/ports\/[^/]+\.ts$/;

/** Why the edge to target is off R5-03's list, or null when it is admitted. */
function hookThinOffList(target: string, typeOnly: boolean): string | null {
  if (HOOK_THIN_FILES.has(target) || HOOK_THIN_DIRS.some((d) => target.startsWith(d))) return null;
  if (PORTS_FILE.test(target)) {
    return typeOnly ? null : 'a value import of a src/ports file other than {ipc,inbox,fs,clock,random}.ts (R5-03: other src/ports files for types only)';
  }
  return 'not on R5-03\'s client-tier list (src/claude/{client,wire,text}, src/text, src/i18n, src/ports/{ipc,inbox,fs,clock,random}.ts and other src/ports '
    + 'types, src/sec/{ipcKey,winAcl,endpoint,handshake,sddl}.ts, src/data/{pluginDataDir,canonRoot}.ts, src/git/env.ts, src/version.ts, node:*; '
    + 'type-only imports count)';
}

/** The start offsets of the module specifiers of a file's type-only edges: `import type …`, `export type … from`, an import or re-export whose
 *  every named binding carries `type` (esbuild drops it under isolatedModules), and an import type (`typeof import('…')`). preProcessFile
 *  reports each specifier at the offset of its opening quote. */
function typeOnlyStarts(file: string, text: string): ReadonlySet<number> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause !== undefined) {
      const c = node.importClause;
      const named = c.namedBindings !== undefined && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : null;
      if (c.isTypeOnly || (c.name === undefined && named !== null && named.length > 0 && named.every((e) => e.isTypeOnly))) {
        out.add(node.moduleSpecifier.getStart(sf));
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const named = node.exportClause !== undefined && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null;
      if (node.isTypeOnly || (named !== null && named.length > 0 && named.every((e) => e.isTypeOnly))) out.add(node.moduleSpecifier.getStart(sf));
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      out.add(node.argument.literal.getStart(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface HookThinWalk {
  findings: LintFinding[];
  /** Every module the walk reached, with the first import chain that reached it (root first). */
  visited: ReadonlyMap<string, readonly string[]>;
}

export function walkHookThin(read: (rel: string) => string | null, roots: readonly string[] = HOOK_THIN_ROOTS): HookThinWalk {
  const findings: LintFinding[] = [];
  const visited = new Map<string, readonly string[]>();
  const reported = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) {
    if (!visited.has(r)) { visited.set(r, [r]); queue.push(r); }
  }
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const text = read(file);
    if (text === null) continue;
    const chain = visited.get(file) as readonly string[];
    const typeOnly = typeOnlyStarts(file, text);
    for (const ref of ts.preProcessFile(text, true, true).importedFiles) {
      if (ref.fileName.startsWith('node:')) continue;
      const resolved = resolveSpecifier(file, ref.fileName);
      const target = resolved ?? ref.fileName;
      const why = resolved === null
        ? 'a package or bare specifier: the client tier loads only node:* built-ins and R5-03\'s list'
        : hookThinOffList(resolved, typeOnly.has(ref.pos));
      if (why !== null) {
        const key = `${file}\n${target}`;
        if (!reported.has(key)) {
          reported.add(key);
          findings.push({
            rule: 'L-HOOK-THIN', file, line: text.slice(0, ref.pos).split('\n').length,
            message: `${[...chain, target].join(' → ')}: ${why}`,
          });
        }
        continue;
      }
      if (!visited.has(target)) {
        visited.set(target, [...chain, target]);
        queue.push(target);
      }
    }
  }
  return { findings, visited };
}

export function lintHookThin(read: (rel: string) => string | null, roots: readonly string[] = HOOK_THIN_ROOTS): LintFinding[] {
  return walkHookThin(read, roots).findings;
}
