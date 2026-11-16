import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { PLUGIN_VERSION } from '../../src/version.js';
import { testRegionRuntime } from '../helpers/regionRuntime.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const buildScript = join(repoRoot, 'tools', 'build', 'build.mjs');
const ENTRY_NAMES = ['cli', 'core', 'daemon', 'hook', 'mcp', 'viz', 'worker'];
/** X-107: the build's output directory as an explicit list, each plan appending its own entries (Plan 7 Task 19 replaces it
 *  with canonicalDistList()); test/integration/build.p5.test.ts reads this list. */
const DIST_LIST = [
  // Plan 1 (glossary §6) and Plan 8a's viz.js (C14): the seven entry bundles; hook.js is built alone (A2-1).
  'cli.js', 'core.js', 'daemon.js', 'hook.js', 'mcp.js', 'viz.js', 'worker.js',
  // Plan 5 (Task 2, X-54): the Claude-facing catalogs tools/build/claudeCatalog.ts writes.
  'i18n/claude.en.json', 'i18n/claude.ko.json',
  // Plan 4 (R4-09): the region runtime and the five grammars.
  'grammars/tree-sitter.wasm', 'grammars/tree-sitter-python.wasm', 'grammars/tree-sitter-javascript.wasm',
  'grammars/tree-sitter-typescript.wasm', 'grammars/tree-sitter-tsx.wasm', 'grammars/tree-sitter-c_sharp.wasm',
];
/** Plan 4's grammar files, for the byte-equality check against testRegionRuntime()'s copies. */
const GRAMMARS = [
  'tree-sitter.wasm', 'tree-sitter-python.wasm', 'tree-sitter-javascript.wasm',
  'tree-sitter-typescript.wasm', 'tree-sitter-tsx.wasm', 'tree-sitter-c_sharp.wasm',
];

interface Metafile {
  outputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[]; inputs: Record<string, unknown> }>;
}

/** Every file under dir, as forward-slash paths relative to it. */
function listing(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listing(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]).sort();
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

test('build produces the seven dist entries, the Claude catalogs and dist/grammars, each runnable on its own', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cowork-build-'));
  const out = join(tmp, 'dist');
  const metaPath = join(tmp, 'meta', 'metafile.json');
  try {
    const first = spawnSync(process.execPath, [buildScript, '--outdir', out], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(first.status, 0, `build failed:\n${first.stdout}\n${first.stderr}`);
    writeFileSync(join(out, 'stale.js'), 'leftover from an earlier build\n');

    // A second build over an outdir holding grammars/ (and a stale .js) succeeds.
    const r = spawnSync(process.execPath, [buildScript, '--outdir', out, '--metafile', metaPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `build failed:\n${r.stdout}\n${r.stderr}`);
    assert.deepEqual(listing(out), [...DIST_LIST].sort());
    const runtime = await testRegionRuntime();
    for (const name of GRAMMARS) {
      assert.equal(sha256(join(out, 'grammars', name)), sha256(join(runtime.dir, name)), `dist/grammars/${name} equals testRegionRuntime()'s copy`);
    }

    // The main call bundles six entries; hook.js is built alone (A2-1) and its metafile goes to <f>.hook.json (A2-5).
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Metafile;
    const outputs = Object.keys(meta.outputs);
    assert.equal(outputs.length, 6, `metafile outputs: ${outputs.join(', ')}`);
    assert.deepEqual(outputs.map((o) => o.split('/').pop()).sort(), ENTRY_NAMES.filter((n) => n !== 'hook').map((n) => `${n}.js`));
    for (const [file, info] of Object.entries(meta.outputs)) {
      const isWorker = file.endsWith('/worker.js');
      const bundlesTreeSitter = Object.keys(info.inputs).some((p) => p.split('\\').join('/').includes('node_modules/web-tree-sitter/'));
      assert.equal(bundlesTreeSitter, isWorker, `${file}: only worker.js bundles web-tree-sitter`);
      for (const imp of info.imports) {
        assert.equal(imp.external, true, `${file} bundles ${imp.path} instead of importing a built-in`);
        if (isWorker) assert.ok(isBuiltin(imp.path), `worker.js imports non-builtin ${imp.path}`);
        else assert.ok(imp.path.startsWith('node:'), `${file} imports non-builtin ${imp.path}`);
      }
    }
    const hookMeta = JSON.parse(readFileSync(`${metaPath}.hook.json`, 'utf8')) as Metafile;
    const hookOutputs = Object.entries(hookMeta.outputs);
    assert.equal(hookOutputs.length, 1, `hook metafile outputs: ${hookOutputs.map(([k]) => k).join(', ')}`);
    for (const imp of (hookOutputs[0] as [string, Metafile['outputs'][string]])[1].imports) {
      assert.equal(imp.external, true, `hook.js bundles ${imp.path}`);
      assert.ok(imp.path.startsWith('node:') || imp.path === './core.js', `hook.js imports ${imp.path}`);
    }

    for (const name of ENTRY_NAMES) {
      const file = join(out, `${name}.js`);
      const v = spawnSync(process.execPath, [file, '--version'], { encoding: 'utf8' });
      assert.equal(v.status, 0, `${name}.js --version failed: ${v.stderr}`);
      assert.equal(v.stdout, `cowork-sync ${name} ${PLUGIN_VERSION}\n`);

      const noop = spawnSync(process.execPath, [file], { encoding: 'utf8', input: '' });
      assert.equal(noop.status, 0, `${name}.js without arguments failed: ${noop.stderr}`);
      assert.equal(noop.stdout, '');
    }

    // An outdir whose grammars/ holds anything but .wasm files is refused, and nothing is deleted.
    const notes = join(out, 'grammars', 'notes.txt');
    writeFileSync(notes, 'not a build output\n');
    const refused = spawnSync(process.execPath, [buildScript, '--outdir', out], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(refused.status, 2, `an outdir with grammars/notes.txt was not refused:\n${refused.stdout}\n${refused.stderr}`);
    assert.match(refused.stderr, /refus/);
    assert.ok(existsSync(notes), 'grammars/notes.txt survives');
    assert.ok(existsSync(join(out, 'worker.js')), 'the earlier build survives');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('build refuses an unknown argument', () => {
  const r = spawnSync(process.execPath, [buildScript, '--bogus'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument --bogus/);
});

// Final review #10: the build empties --outdir first, so a mistyped --outdir (the repo, a parent of
// it, the sources, or any unrelated folder) must be refused before anything is deleted. Run against
// a throwaway copy of the script and esbuild, never against this repository.
test('build refuses an --outdir it must not empty, and deletes nothing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cowork-build-guard-'));
  const fake = join(tmp, 'repo');
  try {
    mkdirSync(join(fake, 'tools', 'build'), { recursive: true });
    copyFileSync(buildScript, join(fake, 'tools', 'build', 'build.mjs'));
    for (const pkg of ['esbuild', '@esbuild']) {
      cpSync(join(repoRoot, 'node_modules', pkg), join(fake, 'node_modules', pkg), { recursive: true });
    }
    mkdirSync(join(fake, 'src', 'entry'), { recursive: true });
    const keep = join(fake, 'src', 'entry', 'keep.ts');
    writeFileSync(keep, 'export {};\n');
    const notes = join(tmp, 'notes', 'notes.txt');
    mkdirSync(dirname(notes), { recursive: true });
    writeFileSync(notes, 'not a build output\n');
    // The same folders reached through a link (macOS: /var -> /private/var; Windows: a junction).
    const link = join(tmp, 'link');
    symlinkSync(fake, link, process.platform === 'win32' ? 'junction' : 'dir');

    for (const outdir of [fake, tmp, join(fake, 'src'), join(fake, 'src', 'entry', 'out'), dirname(notes), join(link, 'src', 'entry', 'out')]) {
      const r = spawnSync(process.execPath, [join(fake, 'tools', 'build', 'build.mjs'), '--outdir', outdir], {
        cwd: fake,
        encoding: 'utf8',
      });
      assert.equal(r.status, 2, `--outdir ${outdir} was not refused:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /refus/, outdir);
      assert.ok(existsSync(keep), `--outdir ${outdir} deleted the sources`);
      assert.ok(existsSync(notes), `--outdir ${outdir} deleted an unrelated folder's files`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** Every module specifier a source file loads: import/export-from, import-equals, require() and import(). */
function moduleSpecifiers(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteralLike(node.moduleReference.expression)) out.push(node.moduleReference.expression.text);
    if (ts.isCallExpression(node) && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])
      && ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkTs(full, out);
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('web-tree-sitter is the only package imported under src/', () => {
  const importers: string[] = [];
  for (const full of walkTs(join(repoRoot, 'src'))) {
    const rel = relative(repoRoot, full).split('\\').join('/');
    for (const spec of moduleSpecifiers(rel, readFileSync(full, 'utf8'))) {
      if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('node:') || isBuiltin(spec)) continue;
      // build.mjs's viz-asset plugin resolves these text modules at bundle time (src/viz/assets.ts only);
      // they are virtual, never a package import at runtime.
      if (spec.startsWith('viz-asset:')) continue;
      assert.equal(spec, 'web-tree-sitter', `${rel} imports the package ${spec}`);
      assert.ok(rel.startsWith('src/regions/worker/'), `${rel} imports web-tree-sitter outside src/regions/worker/`);
      importers.push(rel);
    }
  }
  assert.ok(importers.length > 0, 'the region worker imports web-tree-sitter');
  // REG-03: no second parser. package.json has no runtime dependency and no other parser package.
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  const grammars = new Set(['web-tree-sitter', 'tree-sitter-python', 'tree-sitter-javascript', 'tree-sitter-typescript', 'tree-sitter-c-sharp']);
  for (const name of Object.keys(pkg.devDependencies ?? {})) {
    if (grammars.has(name)) continue;
    assert.doesNotMatch(name, /tree-sitter|ctags|python|acorn|esprima|babel|parser|antlr|lezer/i, `${name} looks like a second parser`);
  }
});
