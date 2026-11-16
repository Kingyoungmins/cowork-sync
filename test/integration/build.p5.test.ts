// Plan 5 Task 2: the build split (A2-1, A2-5) — dist/hook.js built alone with ./core.js left a run-time import and the loader texts defined from
// the catalogs tools/build/claudeCatalog.ts writes (X-54, R5-11, R1-211); the i18n/ catalogs in dist; --release (R-29 mutant seams); the
// outdir guard admitting i18n/ (X-107); the --version and no-argument rows of every entry (BL2-13). Runs
// `node tools/build/build.mjs --outdir <tmp>/dist --metafile <tmp>/meta.json`; the generated-texts and release-seam cells build a throwaway
// copy of the sources (src/, tools/build/, package.json and esbuild), never this repository.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { LOADER_TEXTS } from '../../src/claude/text/claudeText.js';
import { canonicalJsonLine } from '../../src/claude/wire/ndjson.js';
import { claudeCatalogRows } from '../../src/i18n/claude.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { lintDistLoader, lintDistPermission } from '../../tools/lint/p5rules.js';
import { makeTempRoot } from '../helpers/tmp.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const at = (rel: string): string => join(REPO, ...rel.split('/'));
const BUILD = at('tools/build/build.mjs');
const ENTRY_NAMES = ['cli', 'core', 'daemon', 'hook', 'mcp', 'viz', 'worker'];
/** Plan 5's nine outputs (plan:2540 "among the entries this build owns the output directory lists exactly"), pinned on their own beside the
 *  shared DIST_LIST, so a row dropped from both that list and the build still fails here (F2 #149). */
const OWNED = [...ENTRY_NAMES.map((n) => `${n}.js`), 'i18n/claude.en.json', 'i18n/claude.ko.json'].sort();
/** esbuild lists an object-valued define as a pseudo-input of the bundle that uses it. */
const DEFINE_INPUT = '<define:__COWORK_LOADER_TEXTS__>';

interface MetaImport { path: string; kind: string; external?: boolean }
interface Metafile {
  inputs: Record<string, unknown>;
  outputs: Record<string, { imports: MetaImport[]; inputs: Record<string, unknown> }>;
}

let tmp = '';
let cleanup: () => Promise<void> = async () => {};
before(async () => {
  ({ root: tmp, cleanup } = await makeTempRoot('build-p5'));
});
after(() => cleanup());

function runBuild(script: string, args: readonly string[], cwd = REPO): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

let built: { dist: string; meta: string } | null = null;
/** One test-form build of this repository for the cells that only read it. */
function buildOnce(): { dist: string; meta: string } {
  if (built !== null) return built;
  const dist = join(tmp, 'main', 'dist');
  const meta = join(tmp, 'main', 'meta.json');
  const r = runBuild(BUILD, ['--outdir', dist, '--metafile', meta]);
  assert.equal(r.status, 0, `build failed:\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.stderr, '', 'the build warns about nothing');
  built = { dist, meta };
  return built;
}

/** Every file under dir, as forward-slash paths relative to it. */
function listing(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listing(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]).sort();
}

/** build.test.ts's explicit DIST_LIST (X-107), read from that file so the two tests share one list. */
function distListOfBuildTest(): string[] {
  const rel = 'test/integration/build.test.ts';
  const sf = ts.createSourceFile(rel, readFileSync(at(rel), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let list: string[] | null = null;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'DIST_LIST' && n.initializer !== undefined
      && ts.isArrayLiteralExpression(n.initializer)) {
      list = n.initializer.elements.map((e) => {
        assert.ok(ts.isStringLiteral(e), 'DIST_LIST holds string literals only');
        return e.text;
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(list !== null, `${rel} declares DIST_LIST`);
  return list;
}

test('dist holds the seven entry bundles and the two Claude catalogs, and nothing outside the glossary §6 list', () => {
  const { dist, meta } = buildOnce();
  // The shared explicit list (X-107): build.test.ts's DIST_LIST, which the merged build extends with Plan 4's grammars/.
  const list = distListOfBuildTest();
  assert.deepEqual(listing(dist), [...list].sort());
  assert.deepEqual(listing(dist).filter((f) => !f.startsWith('grammars/')), OWNED, "Plan 5's nine outputs, pinned on their own (plan:2540; F2 #149)");

  // A second build into the same directory succeeds: the outdir guard admits the build's own i18n/ and grammars/ (X-107).
  const again = runBuild(BUILD, ['--outdir', dist, '--metafile', meta]);
  assert.equal(again.status, 0, `second build failed:\n${again.stdout}\n${again.stderr}`);
  assert.deepEqual(listing(dist), [...list].sort());
  assert.deepEqual(listing(dist).filter((f) => !f.startsWith('grammars/')), OWNED, "Plan 5's nine outputs, pinned on their own (plan:2540; F2 #149)");

  // A directory holding any other file — beside the bundles or inside i18n/ — is refused before anything is deleted.
  for (const [i, extra] of [['notes.txt'], ['i18n', 'notes.txt'], ['i18n', 'nested', 'x.json']].entries()) {
    const d = join(tmp, `guard-${i}`, 'dist');
    cpSync(dist, d, { recursive: true });
    mkdirSync(join(d, ...extra.slice(0, -1)), { recursive: true });
    writeFileSync(join(d, ...extra), 'not a build output\n');
    const r = runBuild(BUILD, ['--outdir', d]);
    assert.equal(r.status, 2, `${extra.join('/')} was not refused:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /refus/);
    assert.ok(existsSync(join(d, ...extra)), `${extra.join('/')} was deleted`);
    assert.ok(existsSync(join(d, 'hook.js')), 'the earlier build was deleted');
  }

  // An Object.prototype key is not the build's own subdirectory (F2 #150): an empty constructor/ or toString/, and a __proto__/ holding
  // 'a[object Object]' (String(Object.prototype) is '[object Object]', so endsWith admitted it), are refused before anything is deleted.
  const PROTO_CASES: ReadonlyArray<readonly [string, string?]> = [['constructor'], ['toString'], ['__proto__', 'a[object Object]']];
  for (const [i, [name, inner]] of PROTO_CASES.entries()) {
    const d = join(tmp, `guard-proto-${i}`, 'dist');
    cpSync(dist, d, { recursive: true });
    mkdirSync(join(d, name));
    if (inner !== undefined) writeFileSync(join(d, name, inner), 'not a build output\n');
    const r = runBuild(BUILD, ['--outdir', d]);
    assert.equal(r.status, 2, `${name}/ was not refused:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /refus/);
    assert.ok(existsSync(join(d, name)), `${name}/ was deleted`);
    if (inner !== undefined) assert.ok(existsSync(join(d, name, inner)), `${name}/${inner} was deleted`);
    assert.ok(existsSync(join(d, 'hook.js')), 'the earlier build was deleted');
  }
});

test('hook.js is bundled alone: core.js is a run-time import and no other module is inlined', () => {
  const { dist, meta } = buildOnce();
  const hookMeta = JSON.parse(readFileSync(`${meta}.hook.json`, 'utf8')) as Metafile;
  // The one input besides src/entry/hook.ts is esbuild's pseudo-input of the object define (no module).
  assert.deepEqual(Object.keys(hookMeta.inputs).filter((k) => k !== DEFINE_INPUT), ['src/entry/hook.ts']);
  const outputs = Object.entries(hookMeta.outputs);
  assert.equal(outputs.length, 1);
  const [outName, out] = outputs[0] as [string, Metafile['outputs'][string]];
  assert.ok(outName.endsWith('hook.js'), outName);
  for (const imp of out.imports) {
    assert.equal(imp.external, true, `hook.js bundles ${imp.path}`);
    assert.ok(imp.path.startsWith('node:') || (imp.path === './core.js' && imp.kind === 'dynamic-import'), `hook.js imports ${imp.path} (${imp.kind})`);
  }
  const mainMeta = JSON.parse(readFileSync(meta, 'utf8')) as Metafile;
  assert.equal(Object.keys(mainMeta.outputs).length, 6);
  assert.ok(Object.keys(mainMeta.outputs).every((k) => !k.endsWith('hook.js')), 'the main call does not build hook.js');

  const text = readFileSync(join(dist, 'hook.js'), 'utf8');
  assert.deepEqual(lintDistLoader(text), []);
  assert.ok(text.split('\n').length - (text.endsWith('\n') ? 1 : 0) <= 150, 'dist/hook.js has at most 150 lines');
  // Task 4's loader: once src/entry/hook.ts loads core.js (either quote style, any spacing), the bundle keeps that dynamic import verbatim
  // and exactly once (esbuild prints it with double quotes).
  if (/\bimport\(\s*(['"`])\.\/core\.js\1\s*\)/.test(readFileSync(at('src/entry/hook.ts'), 'utf8'))) {
    assert.equal(text.split('import("./core.js")').length - 1, 1);
  }
});

/** A throwaway copy of what the build reads: src/, tools/build/, package.json, esbuild and the grammar packages' .wasm sources
 *  (build.mjs's GRAMMAR_SOURCES — Plan 4's copyGrammars runs on this copy too). */
let checkout: string | null = null;
function tempCheckout(): string {
  if (checkout !== null) return checkout;
  const root = join(tmp, 'checkout');
  cpSync(at('src'), join(root, 'src'), { recursive: true });
  cpSync(at('tools/build'), join(root, 'tools', 'build'), { recursive: true });
  cpSync(at('package.json'), join(root, 'package.json'));
  for (const pkg of ['esbuild', '@esbuild', 'web-tree-sitter', 'tree-sitter-python', 'tree-sitter-javascript', 'tree-sitter-typescript', 'tree-sitter-c-sharp'])
    cpSync(at(`node_modules/${pkg}`), join(root, 'node_modules', pkg), { recursive: true });
  checkout = root;
  return root;
}

test('dist/hook.js embeds the three loader texts generated from the catalogs', () => {
  const { dist } = buildOnce();
  const hook = readFileSync(join(dist, 'hook.js'), 'utf8');
  for (const id of ['G4', 'PAUSED', 'HOOK_LOAD_FAIL'] as const) {
    for (const lang of ['en', 'ko'] as const) {
      assert.ok(hook.includes(JSON.stringify(LOADER_TEXTS[id][lang])), `dist/hook.js lacks ${id}.${lang} as a JSON string literal`);
    }
  }
  // The catalogs are claudeCatalog.ts's canonical serialization of the registry (X-54) …
  for (const lang of ['en', 'ko'] as const) {
    assert.equal(readFileSync(join(dist, 'i18n', `claude.${lang}.json`), 'utf8'), `${canonicalJsonLine(claudeCatalogRows(lang) as never)}\n`, lang);
  }
  // … and the build writes them only through it: claudeCatalog.ts run alone writes the same bytes, and no other file of tools/build calls a
  // file-writing function with an i18n/ or claude.<lang>.json argument.
  const alone = join(tmp, 'catalog-alone');
  const r = spawnSync(process.execPath, ['--import', 'tsx', at('tools/build/claudeCatalog.ts'), '--outdir', alone], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const lang of ['en', 'ko']) {
    assert.ok(readFileSync(join(alone, 'i18n', `claude.${lang}.json`)).equals(readFileSync(join(dist, 'i18n', `claude.${lang}.json`))), lang);
  }
  const WRITERS = new Set(['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'renameSync', 'rename']);
  const writers: string[] = [];
  for (const name of readdirSync(at('tools/build')).filter((n) => /\.(?:mjs|ts)$/.test(n))) {
    const text = readFileSync(at(`tools/build/${name}`), 'utf8');
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : '';
        if (WRITERS.has(callee) && n.arguments.some((a) => /i18n|claude\./.test(a.getText(sf)))) writers.push(name);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual([...new Set(writers)], ['claudeCatalog.ts']);

  // Generated, not copied by hand: a changed PAUSED row of the en seed module reaches dist/hook.js and i18n/claude.en.json on the next build.
  const root = tempCheckout();
  const seed = join(root, 'src', 'i18n', 'claude', 'en', 'seed.ts');
  const changed = 'cowork-sync is paused here by the user (a rebuilt row); edits are not coordinated.';
  const seedText = readFileSync(seed, 'utf8');
  assert.ok(seedText.includes(JSON.stringify(LOADER_TEXTS.PAUSED.en)));
  writeFileSync(seed, seedText.replace(JSON.stringify(LOADER_TEXTS.PAUSED.en), JSON.stringify(changed)));
  // Fix r1 minor: the shared throwaway checkout gets its seed back whether or not the cell passes (the release cell builds the same copy).
  try {
    const out = join(tmp, 'checkout-dist', 'dist');
    const b = runBuild(join(root, 'tools', 'build', 'build.mjs'), ['--outdir', out], root);
    assert.equal(b.status, 0, `build failed:\n${b.stdout}\n${b.stderr}`);
    const rebuilt = readFileSync(join(out, 'hook.js'), 'utf8');
    assert.ok(rebuilt.includes(JSON.stringify(changed)), 'the changed PAUSED row is in dist/hook.js');
    assert.ok(!rebuilt.includes(JSON.stringify(LOADER_TEXTS.PAUSED.en)), 'the old PAUSED row is gone');
    const catalog = JSON.parse(readFileSync(join(out, 'i18n', 'claude.en.json'), 'utf8')) as Record<string, { text: string }>;
    assert.equal(catalog.PAUSED?.text, changed);
  } finally {
    writeFileSync(seed, seedText);
  }
});

test('no bundle contains permissionDecision, and the release form removes every test seam', () => {
  const { dist } = buildOnce();
  const bundles = (d: string): Map<string, string> =>
    new Map(readdirSync(d).filter((n) => n.endsWith('.js')).map((n) => [`dist/${n}`, readFileSync(join(d, n), 'utf8')]));
  assert.deepEqual(lintDistPermission(bundles(dist)), []);

  // --release (this repository): no mutant switch and no test seam in any bundle (R-29; L-DIST itself is Plan 7's).
  const rel = join(tmp, 'release', 'dist');
  const r = runBuild(BUILD, ['--outdir', rel, '--release']);
  assert.equal(r.status, 0, `release build failed:\n${r.stdout}\n${r.stderr}`);
  const released = bundles(rel);
  assert.equal(released.size, ENTRY_NAMES.length);
  for (const [name, text] of released) {
    assert.ok(!text.includes('COWORK_TEST_MUTANT'), `${name} holds COWORK_TEST_MUTANT`);
    assert.ok(!text.includes('COWORK_TEST_'), `${name} holds a COWORK_TEST_ seam`);
  }
  assert.deepEqual(lintDistPermission(released), []);

  // The define itself, on a copy whose loader carries a probe seam: true in the test form (npm run build), false in the release form, and the
  // seam's dead branch is gone from the release bundle.
  const root = tempCheckout();
  const hookSrc = join(root, 'src', 'entry', 'hook.ts');
  const original = readFileSync(hookSrc, 'utf8');
  writeFileSync(hookSrc, `${original}export const TEST_BUILD_PROBE = __COWORK_TEST_BUILD__;\n`
    + `if (__COWORK_TEST_BUILD__) { process.stderr.write(process.env.COWORK_TEST_SEAM_PROBE ?? ''); }\n`
    + `export async function loadCoreProbe(): Promise<unknown> { return import('./core.js'); }\n`);
  try {
    for (const [form, args, expected] of [['test', [], 'true'], ['release', ['--release'], 'false']] as const) {
      const out = join(tmp, `probe-${form}`, 'dist');
      const meta = join(tmp, `probe-${form}`, 'meta.json');
      const b = runBuild(join(root, 'tools', 'build', 'build.mjs'), ['--outdir', out, '--metafile', meta, ...args], root);
      assert.equal(b.status, 0, `${form} build failed:\n${b.stdout}\n${b.stderr}`);
      const hookJs = join(out, 'hook.js');
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const m = await import(${JSON.stringify(pathToFileURL(hookJs).href)}); process.stdout.write(String(m.TEST_BUILD_PROBE));`], { encoding: 'utf8' });
      assert.equal(probe.stdout, expected, `${form}: ${probe.stderr}`);
      const text = readFileSync(hookJs, 'utf8');
      assert.equal(text.includes('COWORK_TEST_SEAM_PROBE'), form === 'test', `${form}: the seam's branch`);
      // ./core.js stays a run-time import of the bundle — the probe's plus the loader's own (A2-1 steps 7–8; Ruling P5-EC-11) — with no other module
      // inlined.
      const own = original.match(/\bimport\(\s*(['"`])\.\/core\.js\1\s*\)/g)?.length ?? 0;
      assert.equal(text.split('import("./core.js")').length - 1, 1 + own, `${form}: import("./core.js")`);
      // The probe adds lines, so the 150-line half of L-LOADER binds the unprobed test-form bundle only (the cell above, P5-EC-11); here every
      // other L-LOADER finding.
      assert.deepEqual(lintDistLoader(text).filter((f) => !/^dist\/hook\.js has \d+ lines \(at most \d+\)$/.test(f.message)), [], form);
      const hm = JSON.parse(readFileSync(`${meta}.hook.json`, 'utf8')) as Metafile;
      assert.deepEqual(Object.keys(hm.inputs).filter((k) => k !== DEFINE_INPUT), ['src/entry/hook.ts'], form);
    }
  } finally {
    writeFileSync(hookSrc, original);
  }
});

test('every entry keeps --version and the no-argument no-op', () => {
  const { dist } = buildOnce();
  for (const name of ENTRY_NAMES) {
    const file = join(dist, `${name}.js`);
    const v = spawnSync(process.execPath, [file, '--version'], { encoding: 'utf8' });
    assert.equal(v.status, 0, `${name}.js --version failed: ${v.stderr}`);
    assert.equal(v.stdout, `cowork-sync ${name} ${PLUGIN_VERSION}\n`);
    const noop = spawnSync(process.execPath, [file], { encoding: 'utf8', input: '' });
    assert.equal(noop.status, 0, `${name}.js without arguments failed: ${noop.stderr}`);
    assert.equal(noop.stdout, '', name);
  }
  const hook = spawnSync(process.execPath, [join(dist, 'hook.js')], { encoding: 'utf8', input: '' });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, '');
  assert.equal(hook.stderr, '');
});
