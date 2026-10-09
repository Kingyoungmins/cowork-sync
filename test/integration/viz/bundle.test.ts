import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BUILD = path.join(REPO, 'tools', 'build', 'build.mjs');
/** 12 §3.12: dist/viz.js ≤ 1.5 MB with the client and the bundled demo (MB = 10^6 bytes, as the board's 5 MB cap). */
const VIZ_JS_MAX_BYTES = 1_500_000;
const ASSETS = ['viz-asset:app.js', 'viz-asset:app.css', 'viz-asset:demo.jsonl'];
const OTHER_ENTRIES = ['daemon', 'hook', 'core', 'mcp', 'worker'];

interface MetaImport { path: string; kind: string; external?: boolean; }
interface Metafile {
  inputs: Record<string, { bytes: number; imports: MetaImport[] }>;
  outputs: Record<string, { bytes: number; entryPoint?: string; imports: MetaImport[]; inputs: Record<string, { bytesInOutput: number }> }>;
}
interface Built { dist: string; node: Metafile; client: Metafile; }

const tmp = mkdtempSync(path.join(tmpdir(), 'cowork-viz-bundle-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let built: Built | null = null;

/** One build (both esbuild passes) for the whole file. */
function build(): Built {
  if (built !== null) return built;
  const dist = path.join(tmp, 'dist');
  const nodeMeta = path.join(tmp, 'meta', 'node.json');
  const clientMeta = path.join(tmp, 'meta', 'client.json');
  const r = spawnSync(process.execPath, [BUILD, '--outdir', dist, '--metafile', nodeMeta, '--client-metafile', clientMeta], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, `build failed:\n${r.stdout}\n${r.stderr}`);
  built = {
    dist,
    node: JSON.parse(readFileSync(nodeMeta, 'utf8')) as Metafile,
    client: JSON.parse(readFileSync(clientMeta, 'utf8')) as Metafile,
  };
  return built;
}

function output(m: Metafile, name: string): Metafile['outputs'][string] {
  const hits = Object.entries(m.outputs).filter(([k]) => k === `${name}.js` || k.endsWith(`/${name}.js`));
  assert.equal(hits.length, 1, `${name}.js among ${Object.keys(m.outputs).join(', ')}`);
  return (hits[0] as [string, Metafile['outputs'][string]])[1];
}

test('T-VIZ-lints: viz.js bundles the client, app.css and the demo log as text; node:http appears only in viz.js; cli.js contains src/viz/cli/** and no other src/viz module; no src/viz module in daemon, hook, core, mcp or worker; the client bundle contains no module importing src/board/fold.ts; dist/viz.js ≤ 1.5 MB', () => {
  const { dist, node, client } = build();
  const viz = output(node, 'viz');

  // The client pass: one iife bundle of src/viz/client/main.ts, embedded byte for byte as viz-asset:app.js.
  const clientOutputs = Object.values(client.outputs);
  assert.equal(clientOutputs.length, 1);
  const page = clientOutputs[0] as Metafile['outputs'][string];
  assert.equal(page.entryPoint, 'src/viz/client/main.ts');
  assert.deepEqual(page.imports, []);
  assert.equal(node.inputs['viz-asset:app.js']?.bytes, page.bytes);
  assert.equal(node.inputs['viz-asset:app.css']?.bytes, statSync(path.join(REPO, 'src', 'viz', 'client', 'app.css')).size);
  assert.equal(node.inputs['viz-asset:demo.jsonl']?.bytes, statSync(path.join(REPO, 'src', 'viz', 'demo', 'plan2.jsonl')).size);
  for (const a of ASSETS) assert.ok((viz.inputs[a]?.bytesInOutput ?? 0) > 0, `${a} is bundled into viz.js`);
  const vizText = readFileSync(path.join(dist, 'viz.js'), 'utf8');
  assert.ok(vizText.includes('cowork-viz-demo/1'), 'the bundled demo log is in viz.js');

  // Every import of every bundle is an external Node built-in (R-V36); node:http only in viz.js (VIZ-01).
  for (const [file, o] of Object.entries(node.outputs)) {
    for (const imp of o.imports) {
      assert.equal(imp.external, true, `${file} bundles ${imp.path}`);
      assert.ok(imp.path.startsWith('node:'), `${file} imports ${imp.path}`);
      if (o !== viz) assert.ok(imp.path !== 'node:http', `${file} imports node:http`);
    }
  }
  // No third-party code in viz.js or the page (VIZ-20): every input is a repository source or a viz asset.
  for (const key of [...Object.keys(viz.inputs), ...Object.keys(page.inputs)]) {
    assert.ok(key.startsWith('src/') || ASSETS.includes(key), `bundled input ${key}`);
  }

  // cli.js: src/viz/cli/** and no other src/viz module (VIZ-01, R-V54).
  for (const key of Object.keys(output(node, 'cli').inputs)) {
    if (key.startsWith('src/viz/')) assert.ok(key.startsWith('src/viz/cli/'), `cli.js bundles ${key}`);
  }
  // F-8a-2: the moved data-directory and SDDL leaves are in cli.js (and, being src/data and src/sec, are no src/viz module).
  const cliInputs = Object.keys(output(node, 'cli').inputs);
  assert.ok(cliInputs.includes('src/data/pluginDataDir.ts'), 'cli.js bundles src/data/pluginDataDir.ts');
  assert.ok(cliInputs.includes('src/sec/sddl.ts'), 'cli.js bundles src/sec/sddl.ts');
  // daemon, hook, core, mcp and worker: nothing of src/viz.
  for (const name of OTHER_ENTRIES) {
    for (const key of Object.keys(output(node, name).inputs)) assert.ok(!key.startsWith('src/viz/'), `${name}.js bundles ${key}`);
  }

  // The page bundles no module that imports the fold (model/frame.ts, timeline.ts and start.ts are server only).
  assert.ok(!('src/board/fold.ts' in page.inputs), 'the page bundles src/board/fold.ts');
  for (const key of Object.keys(page.inputs)) {
    const imports = client.inputs[key]?.imports ?? [];
    assert.ok(!imports.some((i) => i.path === 'src/board/fold.ts'), `${key} imports src/board/fold.ts`);
  }

  assert.ok(viz.bytes <= VIZ_JS_MAX_BYTES, `dist/viz.js is ${viz.bytes} bytes`);
  assert.equal(statSync(path.join(dist, 'viz.js')).size, viz.bytes);
});

test('src/viz/assets.ts is imported only by src/entry/viz.ts', () => {
  // In the bundles.
  const { node } = build();
  const importers = (target: string): string[] =>
    Object.entries(node.inputs).filter(([, i]) => i.imports.some((x) => x.path === target)).map(([k]) => k).sort();
  assert.deepEqual(importers('src/viz/assets.ts'), ['src/entry/viz.ts']);
  for (const a of ASSETS) assert.deepEqual(importers(a), ['src/viz/assets.ts'], a);

  // In every source file, bundled or not (type-only imports included).
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(path.join(REPO, ...rel.split('/')), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (e.name.endsWith('.ts')) files.push(`${rel}/${e.name}`);
    }
  };
  walk('src');
  const assetsImporters: string[] = [];
  const virtualImporters = new Set<string>();
  for (const f of files) {
    const info = ts.preProcessFile(readFileSync(path.join(REPO, ...f.split('/')), 'utf8'), true, true);
    for (const { fileName: spec } of info.importedFiles) {
      if (spec.startsWith('viz-asset:')) virtualImporters.add(f);
      if (!spec.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec)).replace(/\.js$/, '.ts');
      if (target === 'src/viz/assets.ts') assetsImporters.push(f);
    }
  }
  assert.deepEqual(assetsImporters, ['src/entry/viz.ts']);
  assert.deepEqual([...virtualImporters], ['src/viz/assets.ts']);
});

test('dist/viz.js serve is the viewer process (Task 15): a malformed serve argv writes one RF_VIZ_START_FAILED ready line and exits 1', () => {
  const { dist } = build();
  const r = spawnSync(process.execPath, [path.join(dist, 'viz.js'), 'serve'], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, '{"v":1,"refuse":"RF_VIZ_START_FAILED"}\n');
});
