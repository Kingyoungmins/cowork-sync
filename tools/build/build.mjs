// Bundles the seven plugin entry points (glossary §6, and 12-visualizer's dist/viz.js) into single-file ESM
// bundles: src/entry/<name>.ts -> <outdir>/<name>.js (default outdir: dist/).
// The output directory is emptied first, so it holds exactly the seven files; an --outdir that could
// hold anything else (the repo, src/, a folder with other files) is refused before deleting.
// No runtime dependencies: every import left after bundling is a Node built-in.
//
// dist/viz.js (12-visualizer §3.13 "Build", plan 8a R-V36): after the --outdir guard, the page
// src/viz/client/main.ts is bundled in memory (iife, the browser floor targets, minified, no source map),
// then the node entries are built with the `viz-asset` plugin, which serves `viz-asset:app.js` (that page
// bundle), `viz-asset:app.css` (src/viz/client/app.css) and `viz-asset:demo.jsonl` (src/viz/demo/plan2.jsonl)
// as text modules. Only src/viz/assets.ts imports them. This script imports no local module.
//
// Usage: node tools/build/build.mjs [--outdir <dir>] [--metafile <file>] [--client-metafile <file>]
//   --metafile: esbuild's metafile of the node entries; --client-metafile: the one of the page bundle.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ENTRY_NAMES = ['hook', 'core', 'daemon', 'worker', 'mcp', 'cli', 'viz'];
/** The page's browser floor (12-visualizer §3.13 "Build"). */
const CLIENT_TARGETS = ['es2022', 'chrome120', 'edge120', 'firefox128', 'safari17'];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fail(message, code) {
  process.stderr.write(`build: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { outdir: join(repoRoot, 'dist'), metafile: null, 'client-metafile': null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--outdir' || a === '--metafile' || a === '--client-metafile') && i + 1 < argv.length) {
      opts[a.slice(2)] = resolve(argv[++i]);
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

/**
 * The output directory is emptied before the build, so refuse any directory that could hold
 * anything but an earlier build: the repository or a parent of it, a folder inside src/, or an
 * existing folder holding anything other than plain .js files.
 */
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

function checkOutdir(outdir) {
  const real = realish(outdir);
  const root = realpathSync.native(repoRoot);
  if (within(root, real)) fail(`refusing --outdir ${outdir}: it contains the repository`, 2);
  if (within(real, join(root, 'src'))) fail(`refusing --outdir ${outdir}: it is inside src/`, 2);
  if (!existsSync(outdir)) return;
  if (!statSync(outdir).isDirectory()) fail(`refusing --outdir ${outdir}: it is not a directory`, 2);
  for (const entry of readdirSync(outdir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      fail(`refusing --outdir ${outdir}: it holds ${entry.name}, which is not an earlier build output`, 2);
    }
  }
}

function writeMetafile(file, metafile) {
  if (file === null) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(metafile, null, 2) + '\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  checkOutdir(opts.outdir);
  rmSync(opts.outdir, { recursive: true, force: true });
  mkdirSync(opts.outdir, { recursive: true });

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
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    metafile: true,
    logLevel: 'warning',
    plugins: [vizAssets],
  });
  writeMetafile(opts.metafile, result.metafile);
  writeMetafile(opts['client-metafile'], page.metafile);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err), 1));
