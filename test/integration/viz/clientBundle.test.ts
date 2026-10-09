// Plan 8a Task 14: the real page in the build (12 §3.12 "Bundle", §3.13 "Build", §9.5; VIZ-20, VIZ-37). L-VIZ-DOM, the client
// closure and the client typecheck are clean over the page's own modules; the page bundle holds none of the §9.5 sinks in its
// text; it builds for the §3.13 browser targets with no Node built-in and no module that imports the fold, and dist/viz.js stays
// within 1.5 MB with it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { lintVizClientClosure, lintVizClientProgram, lintVizSource } from '../../../tools/lint/vizRules.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BUILD = path.join(REPO, 'tools', 'build', 'build.mjs');
const CLIENT = 'src/viz/client';
const CLIENT_MODULES = ['a11y.ts', 'api.ts', 'log.ts', 'main.ts', 'office.ts', 'rewind.ts'].map((f) => `${CLIENT}/${f}`);
/** 12 §3.13 "Build": the browser floor. */
const TARGETS = ['es2022', 'chrome120', 'edge120', 'firefox128', 'safari17'];
/** 12 §3.12: dist/viz.js ≤ 1.5 MB (10^6-byte MB, as bundle.test.ts). */
const VIZ_JS_MAX_BYTES = 1_500_000;
/** The §9.5 sinks that must not appear in the page bundle's text at all. */
const SINKS: ReadonlyArray<[string, RegExp]> = [
  ['innerHTML', /\binnerHTML\b/], ['outerHTML', /\bouterHTML\b/], ['insertAdjacentHTML', /\binsertAdjacentHTML\b/], ['eval', /\beval\b/],
  ['new Function', /\bnew\s+Function\b/], ['EventSource', /\bEventSource\b/], ['WebSocket', /\bWebSocket\b/], ['Worker', /\bWorker\b/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/], ['DOMParser', /\bDOMParser\b/], ['document.write', /\bdocument\.write/], ['sendBeacon', /\bsendBeacon\b/],
  ['import(', /\bimport\s*\(/], ['postMessage', /\bpostMessage\b/], ['localStorage of the session', /localStorage\.setItem\(\s*["']X-Cowork-Session/],
];

interface MetaImport { path: string; kind: string; external?: boolean; }
interface Metafile {
  inputs: Record<string, { bytes: number; imports: MetaImport[] }>;
  outputs: Record<string, { bytes: number; entryPoint?: string; imports: MetaImport[]; inputs: Record<string, { bytesInOutput: number }> }>;
}

const tmp = mkdtempSync(path.join(tmpdir(), 'cowork-viz-client-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let built: { dist: string; node: Metafile; client: Metafile } | null = null;
function buildOnce(): { dist: string; node: Metafile; client: Metafile } {
  if (built !== null) return built;
  const dist = path.join(tmp, 'dist');
  const nodeMeta = path.join(tmp, 'meta', 'node.json');
  const clientMeta = path.join(tmp, 'meta', 'client.json');
  const r = spawnSync(process.execPath, [BUILD, '--outdir', dist, '--metafile', nodeMeta, '--client-metafile', clientMeta], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, `build failed:\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.stderr, '', 'the build warns about nothing');
  built = { dist, node: JSON.parse(readFileSync(path.join(nodeMeta), 'utf8')) as Metafile, client: JSON.parse(readFileSync(clientMeta, 'utf8')) as Metafile };
  return built;
}
const pageOutput = (m: Metafile): Metafile['outputs'][string] => {
  const outs = Object.values(m.outputs);
  assert.equal(outs.length, 1);
  return outs[0]!;
};

/** The page bundle's text: the same esbuild pass as build.mjs (its own CLIENT_TARGETS and options), checked byte-equal to the build's. */
async function pageText(expectedBytes: number): Promise<string> {
  const src = readFileSync(BUILD, 'utf8');
  const m = /const CLIENT_TARGETS = (\[[^\]]*\]);/.exec(src);
  assert.ok(m !== null, 'build.mjs declares CLIENT_TARGETS');
  const targets = JSON.parse(m[1]!.replace(/'/g, '"')) as string[];
  assert.deepEqual(targets, TARGETS, 'build.mjs bundles the page for the 12 §3.13 targets');
  const r = await esbuild({
    absWorkingDir: REPO, entryPoints: [path.join(REPO, CLIENT, 'main.ts')], bundle: true, platform: 'browser', format: 'iife', target: targets,
    minify: true, sourcemap: false, legalComments: 'none', charset: 'utf8', write: false, logLevel: 'silent',
  });
  const text = r.outputFiles[0]!.text;
  assert.equal(Buffer.byteLength(text, 'utf8'), expectedBytes, 'the text checked is the page the build embeds');
  return text;
}

test('T-VIZ-lints: L-VIZ-DOM is clean over the real client', async () => {
  // The real client: every page module exists and is bundled into the page.
  const names = readdirSync(path.join(REPO, CLIENT)).filter((n) => n.endsWith('.ts')).map((n) => `${CLIENT}/${n}`).sort();
  for (const f of CLIENT_MODULES) assert.ok(names.includes(f), `${f} exists`);
  const { client } = buildOnce();
  const page = pageOutput(client);
  for (const f of CLIENT_MODULES) assert.ok((page.inputs[f]?.bytesInOutput ?? 0) > 0, `${f} is in the page bundle`);
  // L-VIZ-DOM (and every other per-file viz rule) finds nothing in the page's modules.
  const findings = names.flatMap((f) => lintVizSource(f, readFileSync(path.join(REPO, ...f.split('/')), 'utf8')));
  assert.deepEqual(findings, []);
  // The client program closes over its own modules (L-VIZ-IMPORT) and typechecks with lib DOM (L-VIZ-TYPES).
  assert.deepEqual(lintVizClientClosure(REPO), []);
  assert.deepEqual(lintVizClientProgram(REPO), []);
  // The page bundle's text holds none of the §9.5 sinks.
  const text = await pageText(page.bytes);
  for (const [name, re] of SINKS) assert.doesNotMatch(text, re, `${name} in the page bundle`);
});

test('T-VIZ-lints: the client bundle builds for the 12 §3.13 targets, holds no Node built-in and no module importing src/board/fold.ts, and its size keeps dist/viz.js ≤ 1.5 MB', async () => {
  const { dist, node, client } = buildOnce();
  const page = pageOutput(client);
  assert.equal(page.entryPoint, `${CLIENT}/main.ts`);
  // No import is left in the iife, and every input is a repository source of the client program (no node:*, no package).
  assert.deepEqual(page.imports, []);
  for (const [key, input] of Object.entries(client.inputs)) {
    assert.ok(key.startsWith('src/'), `bundled input ${key}`);
    for (const imp of input.imports) {
      assert.ok(!imp.path.startsWith('node:') && imp.external !== true, `${key} imports ${imp.path}`);
      assert.notEqual(imp.path, 'src/board/fold.ts', `${key} imports the fold`);
    }
  }
  assert.ok(!('src/board/fold.ts' in page.inputs));
  for (const serverOnly of ['src/viz/model/frame.ts', 'src/viz/model/timeline.ts', 'src/viz/model/start.ts', 'src/viz/model/looks.ts', 'src/viz/server/project.ts']) {
    assert.ok(!(serverOnly in page.inputs), `${serverOnly} is server only`);
  }
  // The targets: the text checked is the build's own (pageText re-checks build.mjs's CLIENT_TARGETS and the byte count); no
  // Node global is referenced by the page.
  const text = await pageText(page.bytes);
  assert.doesNotMatch(text, /\brequire\s*\(|\bprocess\.|\bBuffer\b|__dirname/);
  // The page is embedded in dist/viz.js, which stays within the budget.
  const viz = Object.entries(node.outputs).find(([k]) => k.endsWith('viz.js'))![1];
  assert.ok((viz.inputs['viz-asset:app.js']?.bytesInOutput ?? 0) >= page.bytes, 'the page is embedded whole');
  const size = statSync(path.join(dist, 'viz.js')).size;
  assert.ok(size <= VIZ_JS_MAX_BYTES, `dist/viz.js is ${size} bytes`);
  assert.ok(page.bytes > 20_000, `the page bundle (${page.bytes} bytes) carries the real client`);
});
