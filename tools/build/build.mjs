// Bundles the seven plugin entry points (glossary §6, and 12-visualizer's dist/viz.js) into single-file ESM
// bundles: src/entry/<name>.ts -> <outdir>/<name>.js (default outdir: dist/), writes the Claude-facing catalogs
// <outdir>/i18n/claude.{en,ko}.json (Plan 5 Task 2, X-54), and copies the region runtime into <outdir>/grammars/:
// tree-sitter.wasm and the five grammar .wasm files (Plan 4, R4-09; glossary §6 grammars/*.wasm).
// The output directory is emptied first, so it holds exactly those files; an --outdir that could hold anything else
// (the repo, src/, a folder with other files) is refused before deleting.
// No runtime dependencies except web-tree-sitter, which esbuild bundles into worker.js only (R4-09); every import
// left after bundling is a Node built-in (and, in dist/hook.js, ./core.js).
//
// dist/viz.js (12-visualizer §3.13 "Build", plan 8a R-V36): after the --outdir guard, the page
// src/viz/client/main.ts is bundled in memory (iife, the browser floor targets, minified, no source map),
// then the node entries are built with the `viz-asset` plugin, which serves `viz-asset:app.js` (that page
// bundle), `viz-asset:app.css` (src/viz/client/app.css) and `viz-asset:demo.jsonl` (src/viz/demo/plan2.jsonl)
// as text modules. Only src/viz/assets.ts imports them. This script imports no local module.
//
// Plan 5 Task 2 (A2-1, A2-5, X-54, ruling P5-EB-5, P5-EB-11): order parseArgs -> checkOutdir -> rm/mkdir (8a's), then
//   1. tools/build/claudeCatalog.ts, the one writer of <outdir>/i18n/claude.{en,ko}.json, runs as a child for this outdir (bundled in
//      memory by esbuild and run with a fixed argv; it exits on its own);
//   2. src/entry/hook.ts is built alone (bundle, format esm, unminified so L-LOADER's 150-line limit measures real code) with ./core.js
//      left a run-time import, and the defines __COWORK_LOADER_TEXTS__ (G4, PAUSED, HOOK_LOAD_FAIL in en and ko, read back from those
//      catalogs), __COWORK_TEST_BUILD__ and __COWORK_VERSION__ (package.json's version);
//   3. the main call bundles core, daemon, worker, mcp, cli and viz with __COWORK_TEST_BUILD__ defined the same way.
// Plan 4 (R4-09, R4-11; audit #15): copyGrammars copies the runtime and the five grammars into <outdir>/grammars/ after the
//   node entries — nothing is written outside <outdir> (the in-tree daemon tests pass their own region binding instead).
// --release defines __COWORK_TEST_BUILD__ false and turns on esbuild's syntax minification (dead-code removal), so every mutant site
// and test seam behind it is removed from the bundles; without it (npm run build, CI) the test form is built.
//
// Usage: node tools/build/build.mjs [--outdir <dir>] [--metafile <file>] [--client-metafile <file>] [--release]
//   --metafile: esbuild's metafile of the main call (and <file>.hook.json, the one of the hook call);
//   --client-metafile: the one of the page bundle.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ENTRY_NAMES = ['core', 'daemon', 'worker', 'mcp', 'cli', 'viz'];
/** The page's browser floor (12-visualizer §3.13 "Build"). */
const CLIENT_TARGETS = ['es2022', 'chrome120', 'edge120', 'firefox128', 'safari17'];
/** <outdir>/grammars/<name> <- node_modules/<source> (R4-09, R4-11). web-tree-sitter 0.27 ships its runtime as web-tree-sitter.wasm. */
const GRAMMAR_SOURCES = [
  ['tree-sitter.wasm', 'web-tree-sitter/web-tree-sitter.wasm'],
  ['tree-sitter-python.wasm', 'tree-sitter-python/tree-sitter-python.wasm'],
  ['tree-sitter-javascript.wasm', 'tree-sitter-javascript/tree-sitter-javascript.wasm'],
  ['tree-sitter-typescript.wasm', 'tree-sitter-typescript/tree-sitter-typescript.wasm'],
  ['tree-sitter-tsx.wasm', 'tree-sitter-typescript/tree-sitter-tsx.wasm'],
  ['tree-sitter-c_sharp.wasm', 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm'],
];
const GRAMMARS_DIR = 'grammars';
/** The build's own subdirectories of --outdir and the one file suffix each may hold (Plans 4 and 5; schema/ is Plan 7's). */
const OWN_SUBDIR_SUFFIX = Object.freeze({ i18n: '.json', [GRAMMARS_DIR]: '.wasm' });
/** The three loader texts (R5-40) and their catalog rows. */
const LOADER_ROWS = { G4: 'G4', PAUSED: 'PAUSED', HOOK_LOAD_FAIL: 'T-HOOK_LOAD_FAIL' };
const CLAUDE_LANGS = ['en', 'ko'];
/** The catalog writer's time bound (a run takes well under a second; a loaded CI machine gets ample slack). */
const CATALOG_WRITER_TIMEOUT_MS = 120_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fail(message, code) {
  process.stderr.write(`build: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { outdir: join(repoRoot, 'dist'), metafile: null, 'client-metafile': null, release: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--outdir' || a === '--metafile' || a === '--client-metafile') && i + 1 < argv.length) {
      opts[a.slice(2)] = resolve(argv[++i]);
    } else if (a === '--release') {
      opts.release = true;
    } else {
      fail(`unknown argument ${a}`, 2);
    }
  }
  return opts;
}

/** True when `child` is `parent` or lies under it (case-insensitive on Windows and macOS). */
function within(child, parent) {
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  const rel = relative(fold ? parent.toLowerCase() : parent, fold ? child.toLowerCase() : child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** p with its nearest existing ancestor resolved through links (macOS /var -> /private/var, junctions). */
function realish(p) {
  let head = resolve(p);
  const rest = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    rest.unshift(basename(head));
    head = up;
  }
  return join(realpathSync.native(head), ...rest);
}

/**
 * The output directory is emptied before the build, so refuse any directory that could hold
 * anything but an earlier build: the repository or a parent of it, a folder inside src/, or an
 * existing folder holding anything other than plain .js files and the build's own subfolders —
 * i18n/ of plain .json files (Plan 5) and grammars/ of .wasm files (Plan 4).
 */
function checkOutdir(outdir) {
  const real = realish(outdir);
  const root = realpathSync.native(repoRoot);
  if (within(root, real)) fail(`refusing --outdir ${outdir}: it contains the repository`, 2);
  if (within(real, join(root, 'src'))) fail(`refusing --outdir ${outdir}: it is inside src/`, 2);
  if (!existsSync(outdir)) return;
  if (!statSync(outdir).isDirectory()) fail(`refusing --outdir ${outdir}: it is not a directory`, 2);
  for (const entry of readdirSync(outdir, { withFileTypes: true })) {
    if (entry.isDirectory() && Object.hasOwn(OWN_SUBDIR_SUFFIX, entry.name)) {
      const suffix = OWN_SUBDIR_SUFFIX[entry.name];
      for (const inner of readdirSync(join(outdir, entry.name), { withFileTypes: true })) {
        if (!inner.isFile() || !inner.name.endsWith(suffix)) {
          fail(`refusing --outdir ${outdir}: it holds ${entry.name}/${inner.name}, which is not an earlier build output`, 2);
        }
      }
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      fail(`refusing --outdir ${outdir}: it holds ${entry.name}, which is not an earlier build output`, 2);
    }
  }
}

/** Copies the runtime and the five grammars into <outdir>/grammars/ under their dist names (R4-09). Nothing is written
 * outside <outdir> (audit #15: the in-tree daemon tests pass their own region binding to runDaemon instead). */
function copyGrammars(outdir) {
  const dir = join(outdir, GRAMMARS_DIR);
  mkdirSync(dir, { recursive: true });
  for (const [name, source] of GRAMMAR_SOURCES) {
    const from = join(repoRoot, 'node_modules', ...source.split('/'));
    if (!existsSync(from)) fail(`missing ${source} (run npm ci)`, 1);
    copyFileSync(from, join(dir, name));
  }
}

function writeMetafile(file, metafile) {
  if (file === null) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(metafile, null, 2) + '\n');
}

/** X-54: runs tools/build/claudeCatalog.ts (the one writer of <outdir>/i18n/claude.{en,ko}.json) as a child for this outdir. */
async function writeClaudeCatalogs(outdir) {
  const writer = await build({
    absWorkingDir: repoRoot,
    entryPoints: [join(repoRoot, 'tools', 'build', 'claudeCatalog.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    charset: 'utf8',
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
  });
  if (writer.outputFiles.length !== 1) fail(`the catalog writer bundle has ${writer.outputFiles.length} output files, expected 1`, 1);
  // Fix r1 minor: the child (two small JSON writes) is bounded, so a stuck writer fails the build instead of hanging it.
  const r = spawnSync(process.execPath, ['--input-type=module', '-', '--outdir', outdir], {
    cwd: repoRoot, input: writer.outputFiles[0].text, encoding: 'utf8', windowsHide: true, timeout: CATALOG_WRITER_TIMEOUT_MS,
  });
  if (r.error !== undefined) fail(`tools/build/claudeCatalog.ts did not run: ${r.error.message}`, 1);
  if (r.status !== 0) fail(`tools/build/claudeCatalog.ts failed (exit ${r.status}):\n${r.stdout}${r.stderr}`, 1);
}

/** The three loader texts × en, ko, read back from the catalogs claudeCatalog.ts wrote (generated, never copied by hand; R1-211). */
function loaderTexts(outdir) {
  const catalogs = {};
  for (const lang of CLAUDE_LANGS) {
    catalogs[lang] = JSON.parse(readFileSync(join(outdir, 'i18n', `claude.${lang}.json`), 'utf8'));
  }
  const texts = {};
  for (const [key, row] of Object.entries(LOADER_ROWS)) {
    texts[key] = {};
    for (const lang of CLAUDE_LANGS) {
      const text = catalogs[lang][row]?.text;
      if (typeof text !== 'string') fail(`i18n/claude.${lang}.json has no ${row} row, which dist/hook.js embeds`, 1);
      texts[key][lang] = text;
    }
  }
  return texts;
}

/** Keeps the loader's `import('./core.js')` a run-time import of dist/hook.js (A2-1): core.js is never bundled into the loader. */
const coreExternal = {
  name: 'core-external',
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: './core.js', external: true }));
  },
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  checkOutdir(opts.outdir);
  rmSync(opts.outdir, { recursive: true, force: true });
  mkdirSync(opts.outdir, { recursive: true });
  const testBuild = String(!opts.release);

  // The page: one in-memory iife bundle, embedded into dist/viz.js as /app.js.
  const page = await build({
    absWorkingDir: repoRoot,
    entryPoints: [join(repoRoot, 'src', 'viz', 'client', 'main.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: CLIENT_TARGETS,
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    write: false,
    metafile: true,
    logLevel: 'warning',
  });
  if (page.outputFiles.length !== 1) fail(`the page bundle has ${page.outputFiles.length} output files, expected 1`, 1);
  const assets = new Map([
    ['app.js', page.outputFiles[0].text],
    ['app.css', readFileSync(join(repoRoot, 'src', 'viz', 'client', 'app.css'), 'utf8')],
    ['demo.jsonl', readFileSync(join(repoRoot, 'src', 'viz', 'demo', 'plan2.jsonl'), 'utf8')],
  ]);
  const vizAssets = {
    name: 'viz-asset',
    setup(b) {
      b.onResolve({ filter: /^viz-asset:/ }, (args) => {
        const name = args.path.slice('viz-asset:'.length);
        if (!assets.has(name)) return { errors: [{ text: `unknown viz asset ${args.path}` }] };
        return { path: name, namespace: 'viz-asset' };
      });
      b.onLoad({ filter: /.*/, namespace: 'viz-asset' }, (args) => ({ contents: assets.get(args.path), loader: 'text' }));
    },
  };

  // The Claude-facing catalogs, then the loader built alone from them (A2-1).
  await writeClaudeCatalogs(opts.outdir);
  const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || version === '') fail('package.json has no version', 1);
  const hook = await build({
    absWorkingDir: repoRoot,
    entryPoints: { hook: join(repoRoot, 'src', 'entry', 'hook.ts') },
    outdir: opts.outdir,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    splitting: false,
    minify: false,
    minifySyntax: opts.release,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    metafile: true,
    logLevel: 'warning',
    plugins: [coreExternal],
    define: {
      __COWORK_LOADER_TEXTS__: JSON.stringify(loaderTexts(opts.outdir)),
      __COWORK_TEST_BUILD__: testBuild,
      __COWORK_VERSION__: JSON.stringify(version),
    },
  });

  const entryPoints = {};
  for (const name of ENTRY_NAMES) entryPoints[name] = join(repoRoot, 'src', 'entry', `${name}.ts`);
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints,
    outdir: opts.outdir,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    splitting: false,
    minifySyntax: opts.release,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    metafile: true,
    logLevel: 'warning',
    plugins: [vizAssets],
    define: { __COWORK_TEST_BUILD__: testBuild },
  });
  copyGrammars(opts.outdir);
  writeMetafile(opts.metafile, result.metafile);
  writeMetafile(opts.metafile === null ? null : `${opts.metafile}.hook.json`, hook.metafile);
  writeMetafile(opts['client-metafile'], page.metafile);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err), 1));
