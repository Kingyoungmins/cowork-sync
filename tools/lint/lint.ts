// CLI: lint every src/**/*.ts under --root (default: the current directory) with every rule, and every test/**/*.ts
// with the rules that also bind test code (lintTestSource: L-PID-KILL).
// Exit 0 with no findings, 1 with findings, 2 on a usage or catalogue error.
// The visualizer rules (vizRules.ts, R-V34, R-V35): lintSource findings that VIZ_ALLOW covers are dropped,
// lintVizSource findings are added, and — only when <root>/src/viz/client/{tsconfig.json,main.ts} exist — the
// client program's import closure (L-VIZ-IMPORT) and typecheck (L-VIZ-TYPES), and the check that no other file
// brings lib DOM into the main program (L-VIZ-TYPES). A client or main program directory that cannot be listed
// throws (exit 2). The summary counts the src/**/*.ts and test/**/*.ts files only (not the client program's files).
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { lintCrashpoints, lintSource, lintTestSource, type LintFinding } from './rules.js';
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
  for (const f of findings) process.stderr.write(`${f.rule} ${f.file}:${f.line} ${f.message}\n`);
  process.stdout.write(`lint: ${files.length + testFiles.length} files, ${findings.length} findings\n`);
  return findings.length === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: unknown) => { process.stderr.write(`lint: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 2; },
);
