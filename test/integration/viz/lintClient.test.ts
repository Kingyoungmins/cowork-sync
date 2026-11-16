import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintVizClientClosure, lintVizClientProgram } from '../../../tools/lint/vizRules.js';
import { makeTempRoot } from '../../helpers/tmp.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const LINT = path.join(REPO, 'tools', 'lint', 'lint.ts');
const TSC = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
const read = (rel: string): string => readFileSync(path.join(REPO, ...rel.split('/')), 'utf8');

interface Run { code: number | null; stdout: string; stderr: string; }

function runLint(root: string): Run {
  // cwd = the repository so `--import tsx` resolves from its node_modules.
  const r = spawnSync(process.execPath, ['--import', 'tsx', LINT, '--root', root], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function runTsc(root: string): Run {
  const r = spawnSync(process.execPath, [TSC, '-p', path.join(root, 'tsconfig.json')], { cwd: root, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function put(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, Buffer.from(text, 'utf8'));
}

/** A lint root with the repository's real client tsconfig and a page entry that uses the DOM. */
async function clientRoot(root: string): Promise<void> {
  await put(root, 'test/crashpoints.json', '[]\n');
  await put(root, 'package.json', '{ "type": "module" }\n');
  await put(root, 'src/viz/client/tsconfig.json', read('src/viz/client/tsconfig.json'));
  await put(root, 'src/viz/client/main.ts', `document.body.textContent = 'cowork-sync';\nexport {};\n`);
}

test('T-VIZ-lints: the main program excludes src/viz/client/** and npm run lint typechecks the client program with lib DOM', async () => {
  // The configuration: the root program excludes the page; package.json's typecheck script is unchanged (R-V35).
  const rootConfig = JSON.parse(read('tsconfig.json')) as { exclude?: string[]; compilerOptions: { lib: string[]; types: string[] } };
  assert.deepEqual(rootConfig.exclude, ['src/viz/client/**']);
  assert.deepEqual(rootConfig.compilerOptions.lib, ['ES2022']);
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts['typecheck'], 'tsc -p tsconfig.json');
  assert.equal(scripts['lint'], 'tsx tools/lint/lint.ts');
  const clientConfig = JSON.parse(read('src/viz/client/tsconfig.json')) as { extends?: string; include: string[]; exclude: string[]; compilerOptions: Record<string, unknown> };
  assert.equal(clientConfig.extends, undefined);
  assert.deepEqual(clientConfig.include, ['./**/*.ts']);
  assert.deepEqual(clientConfig.exclude, []);
  assert.deepEqual(clientConfig.compilerOptions['lib'], ['ES2022', 'DOM']);
  assert.deepEqual(clientConfig.compilerOptions['types'], []);
  assert.equal(clientConfig.compilerOptions['noEmit'], true);
  for (const flag of ['strict', 'isolatedModules', 'forceConsistentCasingInFileNames', 'noFallthroughCasesInSwitch']) {
    assert.equal(clientConfig.compilerOptions[flag], (rootConfig.compilerOptions as Record<string, unknown>)[flag], flag);
  }

  // `npm run typecheck` (tsc -p tsconfig.json) over a copy of the real root config: the page may use the
  // DOM; a DOM global in server code fails.
  const main = await makeTempRoot('viz-main-program');
  try {
    await put(main.root, 'tsconfig.json', read('tsconfig.json'));
    await put(main.root, 'package.json', read('package.json'));
    symlinkSync(path.join(REPO, 'node_modules'), path.join(main.root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await put(main.root, 'src/viz/client/main.ts', `document.body.textContent = 'cowork-sync';\nexport {};\n`);
    await put(main.root, 'src/viz/server/ok.ts', `export const port = (): number => 0;\n`);
    const clean = runTsc(main.root);
    assert.equal(clean.code, 0, `${clean.stdout}\n${clean.stderr}`);
    await put(main.root, 'src/viz/server/dom.ts', `export const title = (): string => document.title;\n`);
    const dirty = runTsc(main.root);
    assert.notEqual(dirty.code, 0);
    assert.match(dirty.stdout, /src[\\/]viz[\\/]server[\\/]dom\.ts\(1,\d+\): error TS\d+: Cannot find name 'document'/);
    assert.doesNotMatch(dirty.stdout, /src[\\/]viz[\\/]client/);
  } finally {
    await rm(path.join(main.root, 'node_modules'), { force: true }).catch(() => undefined);
    await main.cleanup();
  }

  // `npm run lint` typechecks the client program: DOM yes, Node types no.
  const { root, cleanup } = await makeTempRoot('viz-client-program');
  try {
    await clientRoot(root);
    const clean = runLint(root);
    assert.equal(clean.code, 0, clean.stderr);
    assert.equal(clean.stdout, 'lint: 1 files, 0 findings\n');
    await put(root, 'src/viz/ui/bytes.ts', `export const size = (s: string): number => Buffer.byteLength(s, 'utf8');\n`);
    const dirty = runLint(root);
    assert.equal(dirty.code, 1, dirty.stderr);
    assert.match(dirty.stderr, /^L-VIZ-TYPES src\/viz\/ui\/bytes\.ts:1 TS\d+ Cannot find name 'Buffer'/m);
    assert.equal(dirty.stdout, `lint: 2 files, ${dirty.stderr.trim().split('\n').length} findings\n`);
  } finally {
    await cleanup();
  }
});

test("T-VIZ-lints: the client program's import closure is exactly the R-V35 set", async () => {
  const { root, cleanup } = await makeTempRoot('viz-client-closure');
  try {
    await clientRoot(root);
    // Every member of the R-V35 set, imported from ui/** (type-only and value imports): clean.
    const members: [string, string][] = [
      ['src/viz/model/events.ts', 'events'], ['src/viz/model/scene.ts', 'scene'], ['src/viz/model/layout.ts', 'layout'],
      ['src/viz/model/placement.ts', 'placement'], ['src/viz/model/cards.ts', 'cards'], ['src/viz/model/labels.ts', 'labels'],
      ['src/viz/render/palette.ts', 'palette'], ['src/viz/server/viewModel.ts', 'viewModel'], ['src/text/sanitize.ts', 'sanitize'],
      ['src/i18n/render.ts', 'render'], ['src/viz/i18n/codes.ts', 'codes'],
      // rev 2.5, F04-a: the shared area rule zone(p) (12 §3.13; CLIENT_PROGRAM_FILES in tools/lint/vizRules.ts).
      ['src/data/zone.ts', 'zone'],
    ];
    for (const [file, name] of members) await put(root, file, `export type ${name}T = number;\nexport const ${name} = 1;\n`);
    const fromUi = (file: string): string => path.posix.relative('src/viz/ui', file).replace(/\.ts$/, '.js');
    await put(root, 'src/viz/ui/all.ts', members.map(([file, name], i) => (i % 2 === 0
      ? `import type { ${name}T } from '${fromUi(file)}';\nexport type U${i} = ${name}T;\n`
      : `import { ${name} } from '${fromUi(file)}';\nexport const v${i} = ${name};\n`)).join(''));
    await put(root, 'src/viz/client/glue.ts', `import { v1 } from '../ui/all.js';\nexport const n = v1;\n`);
    const clean = runLint(root);
    assert.equal(clean.code, 0, clean.stderr);

    // A type-only import of the server-only model/timeline.ts from ui/**.
    await put(root, 'src/viz/model/timeline.ts',
      `import { createHash } from 'node:crypto';\nexport interface Timeline { heights: number }\nexport const seed = (s: string): string => createHash('sha256').update(s).digest('hex');\n`);
    await put(root, 'src/viz/ui/seek.ts', `import type { Timeline } from '../model/timeline.js';\nexport const empty: Timeline | null = null;\n`);
    const timeline = runLint(root);
    assert.equal(timeline.code, 1);
    assert.match(timeline.stderr, /^L-VIZ-IMPORT src\/viz\/ui\/seek\.ts:1 src\/viz\/model\/timeline\.ts is outside the client program/m);
    assert.match(timeline.stderr, /^L-VIZ-TYPES src\/viz\/model\/timeline\.ts:1 /m);
    await rm(path.join(root, 'src', 'viz', 'ui', 'seek.ts'));

    // A type-only import of src/board/fold.ts from ui/**.
    await put(root, 'src/board/fold.ts', `export interface FoldState { height: number; checkpoint: Buffer | null }\n`);
    await put(root, 'src/viz/ui/state.ts', `import type { FoldState } from '../../board/fold.js';\nexport const none: FoldState | null = null;\n`);
    const fold = runLint(root);
    assert.equal(fold.code, 1);
    assert.match(fold.stderr, /^L-VIZ-IMPORT src\/viz\/ui\/state\.ts:1 src\/board\/fold\.ts is outside the client program/m);
    assert.match(fold.stderr, /^L-VIZ-TYPES src\/board\/fold\.ts:1 TS\d+ Cannot find name 'Buffer'/m);
    await rm(path.join(root, 'src', 'viz', 'ui', 'state.ts'));

    // The closure is transitive: a shared model file may not reach a server-only one either.
    await put(root, 'src/viz/model/scene.ts', `import type { Timeline } from './timeline.js';\nexport type sceneT = number;\nexport const scene = 1;\nexport type T = Timeline;\n`);
    const transitive = runLint(root);
    assert.equal(transitive.code, 1);
    assert.match(transitive.stderr, /^L-VIZ-IMPORT src\/viz\/model\/scene\.ts:1 src\/viz\/model\/timeline\.ts is outside the client program/m);
  } finally {
    await cleanup();
  }
});

test('T-VIZ-lints: a /// <reference lib="dom" /> outside the client program fails L-VIZ-TYPES', async () => {
  const { root, cleanup } = await makeTempRoot('viz-lint-main-dom');
  try {
    await clientRoot(root);
    await put(root, 'src/viz/server/ok.ts', 'export const port = (): number => 0;\n');
    // Other lib references and the client's own DOM are not the main program's DOM.
    await put(root, 'test/helpers/es.ts', '/// <reference lib="es2023.array" />\nexport const es = 1;\n');
    assert.equal(runLint(root).code, 0);

    // test/** and tools/** are main-program files lint does not otherwise read; a .d.ts is skipped by the
    // per-file rules; a .d.ts next to a .ts of the same name is dropped by the include glob yet still loaded
    // through a `/// <reference path>`.
    const planted: [string, string][] = [
      ['test/helpers/cdp.ts', '/// <reference lib="dom" />\nexport const cdp = 1;\n'],
      ['tools/viz/page.ts', '// The page smoke.\n/// <reference lib="DOM" />\nexport const page = 1;\n'],
      ['test/helpers/iter.ts', '/// <reference lib="dom.iterable" />\nexport const iter = 1;\n'],
      ['test/helpers/worker.ts', '/// <reference lib="webworker" />\nexport const worker = 1;\n'],
      ['src/viz/server/globals.d.ts', '/// <reference lib="dom" />\ndeclare const x: number;\n'],
      ['src/viz/assets.d.ts', `/// <reference lib="dom" />\ndeclare module 'viz-asset:app.js' { const t: string; export default t; }\n`],
      ['src/viz/assets.ts', '/// <reference path="./assets.d.ts" />\nexport const a = 1;\n'],
    ];
    for (const [file, text] of planted) await put(root, file, text);
    const r = runLint(root);
    assert.equal(r.code, 1, r.stderr);
    const dom = ['test/helpers/cdp.ts:1', 'tools/viz/page.ts:2', 'test/helpers/iter.ts:1', 'test/helpers/worker.ts:1', 'src/viz/server/globals.d.ts:1', 'src/viz/assets.d.ts:1'];
    for (const file of dom) {
      assert.match(r.stderr, new RegExp(`^L-VIZ-TYPES ${file.replace(/\./g, '\\.')} /// <reference lib="[^"]+" /> puts browser globals into the main program`, 'm'), file);
    }
    assert.equal(r.stderr.trim().split('\n').length, dom.length, r.stderr);
    assert.doesNotMatch(r.stderr, /test\/helpers\/es\.ts/);
    // Inside the client program the directive is L-VIZ-IMPORT's (both programs would see it there), not this check's.
    for (const [file] of planted) await rm(path.join(root, ...file.split('/')));
    await put(root, 'src/viz/ui/x.ts', '/// <reference lib="dom" />\nexport const x = 1;\n');
    const ui = runLint(root);
    assert.equal(ui.code, 1);
    assert.match(ui.stderr, /^L-VIZ-IMPORT src\/viz\/ui\/x\.ts:1 /m);
    assert.doesNotMatch(ui.stderr, /puts browser globals into the main program/);
  } finally {
    await cleanup();
  }
});

test('T-VIZ-lints: a client program directory that cannot be listed fails lint instead of being skipped', async () => {
  const { root, cleanup } = await makeTempRoot('viz-lint-unreadable');
  try {
    await clientRoot(root);
    // Absent optional directories (ui/, render/) are fine.
    assert.equal(runLint(root).code, 0);
    // A file where src/viz/ui/ belongs: readdir fails with ENOTDIR, which must not read as "no ui/** files".
    await put(root, 'src/viz/ui', 'not a directory\n');
    const r = runLint(root);
    assert.equal(r.code, 2, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^lint: src\/viz\/ui: cannot list a directory of the client program \(ENOTDIR\)/m);
    assert.throws(() => lintVizClientClosure(root), /src\/viz\/ui: cannot list a directory of the client program \(ENOTDIR\)/);
    assert.throws(() => lintVizClientProgram(root), /src\/viz\/ui: cannot list a directory of the client program \(ENOTDIR\)/);
  } finally {
    await cleanup();
  }
});

test("lint over a --root without src/viz/client keeps Plan 1's output", async () => {
  const { root, cleanup } = await makeTempRoot('viz-lint-plan1');
  try {
    await put(root, 'test/crashpoints.json', JSON.stringify(['apply.intent']) + '\n');
    await put(root, 'src/ports/clock.ts', 'export const now = (): number => Date.now();\n');
    await put(root, 'src/engine/apply.ts', "import { crashpoint } from '../ports/crashpoint.js';\ncrashpoint('apply.intent');\n");
    const r = runLint(root);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'lint: 2 files, 0 findings\n');
    assert.equal(r.stderr, '');
    // Browser-only rules need the client program: without src/viz/client the ui/** file is plain main-program code.
    await put(root, 'src/viz/ui/bytes.ts', `export const size = (s: string): number => Buffer.byteLength(s, 'utf8');\n`);
    const r2 = runLint(root);
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r2.stdout, 'lint: 3 files, 0 findings\n');
  } finally {
    await cleanup();
  }
});

test('lint applies VIZ_ALLOW to lintSource findings and adds the lintVizSource findings', async () => {
  const { root, cleanup } = await makeTempRoot('viz-lint-allow');
  try {
    await clientRoot(root);
    await put(root, 'src/viz/server/http.ts',
      `import http from 'node:http';\nexport const server = http.createServer();\nserver.listen({ host: '127.0.0.1', port: 0, exclusive: true });\n`);
    await put(root, 'src/viz/client/clock.ts', 'export const t = (): number => Date.now();\n');
    const clean = runLint(root);
    assert.equal(clean.code, 0, clean.stderr);
    assert.equal(clean.stdout, 'lint: 3 files, 0 findings\n');

    await put(root, 'src/viz/server/store.ts', `import http from 'node:http';\nexport const get = (u: string): unknown => fetch(u);\nexport const h = http;\n`);
    const dirty = runLint(root);
    assert.equal(dirty.code, 1);
    assert.match(dirty.stderr, /^L-NET src\/viz\/server\/store\.ts:1 /m);
    assert.match(dirty.stderr, /^L-VIZ-NET src\/viz\/server\/store\.ts:2 /m);
    assert.doesNotMatch(dirty.stderr, /src\/viz\/server\/http\.ts|src\/viz\/client\/clock\.ts/);
  } finally {
    await cleanup();
  }
});
