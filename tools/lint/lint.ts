// CLI: lint every src/**/*.ts under --root (default: the current directory) with every rule, and every test/**/*.ts
// with the rules that also bind test code (lintTestSource: L-PID-KILL, L-TOKEN).
// Plan 5 Task 2: every other script of test/** and tools/** with lintToolSource (L-TOKEN); plugin/hooks/*.json (L-HOOKS-JSON) and
// plugin/commands/*.md (L-HUMAN-ONLY); and L-HOOK-THIN's walk of the import graph of src/entry/core.ts and src/entry/mcp.ts.
// Exit 0 with no findings, 1 with findings, 2 on a usage or catalogue error.
// The visualizer rules (vizRules.ts, R-V34, R-V35): lintSource findings that VIZ_ALLOW covers are dropped,
// lintVizSource findings are added, and — only when <root>/src/viz/client/{tsconfig.json,main.ts} exist — the
// client program's import closure (L-VIZ-IMPORT) and typecheck (L-VIZ-TYPES), and the check that no other file
// brings lib DOM into the main program (L-VIZ-TYPES). A client or main program directory that cannot be listed
// throws (exit 2). The summary counts the src/**/*.ts and test/**/*.ts files only (not the client program's files).
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import {
  lintCommandFile, lintCrashpoints, lintHooksJson, lintHookThin, lintSource, lintTestSource, lintToolSource, type LintFinding,
} from './rules.js';
import { lintVizClientClosure, lintVizClientProgram, lintVizMainProgramDom, lintVizSource, vizAllowed } from './vizRules.js';

const CRASHPOINT_PORT = 'src/ports/crashpoint.ts';
const CATALOGUE = 'test/crashpoints.json';
const CLIENT_PROGRAM = ['src/viz/client/tsconfig.json', 'src/viz/client/main.ts'];

async function listTs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listTs(full)));
    else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function crashpointNames(file: string, text: string): string[] {
  if (file === CRASHPOINT_PORT) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      const arg0 = node.arguments[0];
      if (name === 'crashpoint' && arg0 !== undefined && ts.isStringLiteral(arg0)) names.push(arg0.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** Task 6 format only: a JSON array of strings. Every other outcome throws (exit 2). */
async function readCatalogue(root: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path.join(root, ...CATALOGUE.split('/')), 'utf8');
  } catch (e) {
    throw new Error(`${CATALOGUE}: cannot read (${(e as NodeJS.ErrnoException).code ?? String(e)})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${CATALOGUE}: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!Array.isArray(json) || !json.every((x: unknown) => typeof x === 'string')) {
    throw new Error(`${CATALOGUE}: expected a JSON array of strings (Task 6 format)`);
  }
  return json as string[];
}

async function main(argv: string[]): Promise<number> {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1] !== undefined) root = path.resolve(argv[++i] as string);
    else { process.stderr.write(`lint: unknown argument ${argv[i]}\n`); return 2; }
  }
  const catalogue = await readCatalogue(root);
  const files = await listTs(path.join(root, 'src'));
  const findings: LintFinding[] = [];
  const callSites: string[] = [];
  for (const full of files) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    const text = await readFile(full, 'utf8');
    findings.push(...lintSource(rel, text).filter((f) => !vizAllowed(f)), ...lintVizSource(rel, text));
    callSites.push(...crashpointNames(rel, text));
  }
  findings.push(...lintCrashpoints(callSites, catalogue));
  if (CLIENT_PROGRAM.every((rel) => existsSync(path.join(root, ...rel.split('/'))))) {
    findings.push(...lintVizClientClosure(root), ...lintVizClientProgram(root), ...lintVizMainProgramDom(root));
  }
  const testFiles = await listTs(path.join(root, 'test'));
  for (const full of testFiles) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    findings.push(...lintTestSource(rel, await readFile(full, 'utf8')));
  }
  // Plan 5 Task 2: L-TOKEN also scans the JavaScript scripts of test/** and every script of tools/** (R5-03, "test files included").
  const scripts = [
    ...(await listFiles(path.join(root, 'test'), JS_SCRIPT)),
    ...(await listFiles(path.join(root, 'tools'), (n) => JS_SCRIPT(n) || (n.endsWith('.ts') && !n.endsWith('.d.ts')))),
  ];
  for (const full of scripts) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    findings.push(...lintToolSource(rel, await readFile(full, 'utf8')));
  }
  // The plugin package (06 §3.2, CCI-03): L-HOOKS-JSON over plugin/hooks/*.json, L-HUMAN-ONLY over plugin/commands/*.md.
  const hookFiles = await listFiles(path.join(root, 'plugin', 'hooks'), (n) => n.endsWith('.json'));
  const commandFiles = await listFiles(path.join(root, 'plugin', 'commands'), (n) => n.endsWith('.md'));
  for (const full of hookFiles) findings.push(...lintHooksJson(path.relative(root, full).split(path.sep).join('/'), await readFile(full, 'utf8')));
  for (const full of commandFiles) findings.push(...lintCommandFile(path.relative(root, full).split(path.sep).join('/'), await readFile(full, 'utf8')));
  // L-HOOK-THIN (R5-03): the import graph of src/entry/{core,mcp}.ts, from source (lint runs before build).
  findings.push(...lintHookThin((rel) => readSource(root, rel)));
  for (const f of findings) process.stderr.write(`${f.rule} ${f.file}:${f.line} ${f.message}\n`);
  const count = files.length + testFiles.length + scripts.length + hookFiles.length + commandFiles.length;
  process.stdout.write(`lint: ${count} files, ${findings.length} findings\n`);
  return findings.length === 0 ? 0 : 1;
}

const JS_SCRIPT = (name: string): boolean => /\.(?:mjs|cjs|js)$/.test(name);

/** Every file under dir (recursively, sorted by code unit) whose name passes keep; none when dir does not exist. Links are not followed and
 *  node_modules directories are skipped (a package's own files are not this repository's; fix r1). */
async function listFiles(dir: string, keep: (name: string) => boolean): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') out.push(...(await listFiles(full, keep)));
    } else if (e.isFile() && keep(e.name)) out.push(full);
  }
  return out;
}

/** A repository-relative source file's text, or null when it does not exist (absent files are absent from the L-HOOK-THIN walk). */
function readSource(root: string, rel: string): string | null {
  try {
    return readFileSync(path.join(root, ...rel.split('/')), 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => { process.stderr.write(`lint: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 2; },
);
