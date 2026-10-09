import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSource, type LintFinding } from '../../../tools/lint/rules.js';
import { lintVizSource, VIZ_ALLOW, vizAllowed } from '../../../tools/lint/vizRules.js';

/** What tools/lint/lint.ts reports for one file: lintSource minus VIZ_ALLOW, then lintVizSource. */
function lint(file: string, text: string): LintFinding[] {
  return [...lintSource(file, text).filter((f) => !vizAllowed(f)), ...lintVizSource(file, text)];
}
const rules = (file: string, text: string): string[] => lint(file, text).map((f) => f.rule);
const has = (file: string, text: string, rule: string): boolean => rules(file, text).includes(rule);

const HTTP = 'src/viz/server/http.ts';
const STORE = 'src/viz/server/store.ts';
const UI = 'src/viz/ui/x.ts';
const VIEW = 'src/viz/cli/view.ts';
const CLIENT = 'src/viz/client/x.ts';
const ELSEWHERE = [STORE, UI, VIEW];

test("T-VIZ-lints: VIZ_ALLOW exempts exactly http.ts's node:http load from L-NET, spawn/opener/ownerProbe from L-PORTS, ownerProbe, boundedRead and spawn (the viewer's stderr file, Task 15 fix round 2) from L-FS-PORT, and src/viz/client/** from L-CLOCK, L-RANDOM, L-FS-PORT and every L-GIT-* rule", () => {
  // L-NET: the http module load in http.ts, and nothing else.
  for (const load of [`import http from 'node:http';`, `import { createServer } from 'http';`, `import * as http from 'node:http';`]) {
    assert.deepEqual(rules(HTTP, load), [], load);
    for (const f of ELSEWHERE) assert.ok(has(f, load, 'L-NET'), `${f}: ${load}`);
  }
  for (const other of [`import net from 'node:net';`, `import https from 'node:https';`, `import { lookup } from 'node:dns';`, `import * as h2 from 'node:http2';`, `import tls from 'tls';`]) {
    assert.ok(has(HTTP, other, 'L-NET'), `http.ts: ${other}`);
  }

  // L-PORTS: spawn.ts, opener.ts and ownerProbe.ts.
  const cp = `import { spawn } from 'node:child_process';`;
  for (const f of ['src/viz/cli/spawn.ts', 'src/viz/cli/opener.ts', 'src/viz/cli/ownerProbe.ts']) assert.deepEqual(rules(f, cp), [], f);
  for (const f of [...ELSEWHERE, HTTP, CLIENT, 'src/viz/cli/dataDir.ts', 'src/viz/source/boundedRead.ts']) assert.ok(has(f, cp, 'L-PORTS'), f);

  // L-FS-PORT: ownerProbe.ts, boundedRead.ts and spawn.ts, which opens the viewer's stderr file in <data dir>/log for the child
  // (Task 15 fix round 2 ruling: an abort is never silent) (and the client, below).
  const fsLoad = `import { open } from 'node:fs/promises';`;
  for (const f of ['src/viz/cli/ownerProbe.ts', 'src/viz/source/boundedRead.ts', 'src/viz/cli/spawn.ts']) assert.deepEqual(rules(f, fsLoad), [], f);
  for (const f of [...ELSEWHERE, HTTP, 'src/viz/cli/opener.ts', 'src/viz/cli/dataDir.ts', 'src/viz/source/status.ts', 'src/viz/main.ts']) assert.ok(has(f, fsLoad, 'L-FS-PORT'), f);
  // L-PID-KILL (not VIZ_ALLOW's: rules.ts allows the group kill): spawn.ts's POSIX process-group kill (VIZ-02) only, never a bare
  // pid there, and no other viz file.
  const groupKill = `process.kill(-pgid, 'SIGTERM');`;
  assert.deepEqual(rules('src/viz/cli/spawn.ts', groupKill), []);
  assert.deepEqual(rules('src/viz/cli/spawn.ts', `process.kill(pid, 'SIGKILL');`), ['L-PID-KILL']);
  for (const f of [...ELSEWHERE, HTTP, CLIENT, 'src/viz/cli/opener.ts', 'src/viz/cli/ownerProbe.ts']) assert.ok(has(f, groupKill, 'L-PID-KILL'), f);
  assert.ok(VIZ_ALLOW.every((a) => a.rule !== 'L-PID-KILL'));

  // In the client the load is not L-FS-PORT's but L-VIZ-IMPORT forbids it.
  assert.ok(!has(CLIENT, fsLoad, 'L-FS-PORT'));
  assert.ok(has(CLIENT, fsLoad, 'L-VIZ-IMPORT'));

  // src/viz/client/**: L-CLOCK, L-RANDOM and every L-GIT-* rule.
  const clientOnly: [string, string][] = [
    ['L-CLOCK', 'const t = Date.now();'],
    ['L-CLOCK', 'const d = new Date();'],
    ['L-CLOCK', 'const p = performance.now();'],
    ['L-RANDOM', 'const r = Math.random();'],
    ['L-RANDOM', 'const u = crypto.randomUUID();'],
    ['L-GIT-FORBIDDEN', `const a = ['restore', '--staged', 'x'];`],
    ['L-GIT-FORBIDDEN', `const a = ['apply', '--index'];`],
    ['L-GIT-FORBIDDEN', `const a = ['switch', 'main'];`],
    ['L-GIT-SPAWN', `proc.spawn('git', []);`],
    ['L-GIT-ATOMIC', `const flag = '--atomic';`],
  ];
  for (const [rule, text] of clientOnly) {
    assert.deepEqual(rules(CLIENT, text), [], `${CLIENT}: ${text}`);
    assert.deepEqual(rules('src\\viz\\client\\deep\\y.ts', text), [], `backslash path: ${text}`);
    for (const f of ELSEWHERE) assert.ok(has(f, text, rule), `${f}: ${text}`);
  }
  // Exactly those: other Plan 1 rules still fire in the client, and only the client prefix is exempt.
  assert.ok(has(CLIENT, `const r = 'refs/worktree/x';`, 'L-REFS'));
  assert.ok(has(CLIENT, `const o = { permissionDecision: 'allow' };`, 'L-PERMISSION'));
  for (const f of ['src/viz/clientx/a.ts', 'src/viz/client.ts', 'src/vizclient/a.ts', 'src/viz/ui/client/a.ts', 'src/viz/server/client/a.ts']) {
    assert.ok(has(f, 'const t = Date.now();', 'L-CLOCK'), f);
  }
  // Every entry names a rule and either files or a prefix.
  for (const a of VIZ_ALLOW) assert.ok((a.files !== undefined) !== (a.prefix !== undefined), JSON.stringify(a));
});

const DOM_SINKS: readonly string[] = [
  'el.innerHTML = s;',
  `el['innerHTML'] = s;`,
  'Object.assign(el, { innerHTML: s });',
  'const h = el.outerHTML;',
  `el.insertAdjacentHTML('beforeend', s);`,
  'el.setHTMLUnsafe(s);',
  'const d = Document.parseHTMLUnsafe(s);',
  'document.write(s);',
  'document.writeln(s);',
  `const d = new DOMParser().parseFromString(s, 'text/html');`,
  'const f = document.createRange().createContextualFragment(s);',
  'frame.srcdoc = s;',
  'eval(s);',
  'window.eval(s);',
  `const f = new Function('return 1');`,
  `const f = Function('return 1');`,
  `setTimeout('tick()', 10);`,
  'setTimeout(code, 10);',
  'window.setInterval(`${s}`, 10);',
  `el.setAttributeNS(null, 'title', s);`,
  `el.setAttribute('onclick', s);`,
  `el.setAttribute('ONLOAD', s);`,
  `el.setAttribute('href', s);`,
  `el.setAttribute('src', s);`,
  `el.setAttribute('srcset', s);`,
  `el.setAttribute('xlink:href', s);`,
  `el.setAttribute('style', s);`,
  `el.setAttribute('srcdoc', s);`,
  `el.setAttribute('action', s);`,
  `el.setAttribute('formaction', s);`,
  'el.setAttribute(name, s);',
  'a.href = url;',
  `a['href'] = url;`,
  `a.href += '#x';`,
  'img.src = u;',
  'img.srcset = u;',
  'form.action = u;',
  'button.formAction = u;',
  'el.style.cssText = css;',
  'el.style = css;',
  'location = u;',
  'window.location = u;',
  'document.location = u;',
  'location.href = u;',
  'location.href = URL.createObjectURL(blob);',
  'location.assign(u);',
  'location.replace(u);',
  `el.style.setProperty('--x', '1');`,
  'sheet.insertRule(rule);',
  'sheet.replaceSync(css);',
  'void sheet.replace(css);',
  'el.style.width = w;',
  'el.style.background = `url(${u})`;',
  'el.style.left = `${x}px`;',
  `el.style[prop] = '1px';`,
  'window.open(u);',
  `open('/api/v1/world');`,
  `window.addEventListener('message', f);`,
  'window.addEventListener(kind, f);',
  'window.onmessage = f;',
  `const m = await import('./x.js');`,
  'const w = new WebSocket(u);',
  'const e = new EventSource(u);',
  'navigator.sendBeacon(u, d);',
  'const x = new XMLHttpRequest();',
  'const k = new Worker(u);',
  'void fetch(url);',
  `void fetch('/api/v2/world');`,
  `void fetch('https://evil.test/api/v1/world');`,
  'void fetch(`${base}/api/v1/world`);',
  `void fetch('api/v1/world');`,
  `void fetch('/api/v1');`,
  'void window.fetch(url);',
  'const f = fetch;',
];

const DOM_SAFE: readonly string[] = [
  'el.textContent = name;',
  'el.append(document.createTextNode(name));',
  'input.value = name;',
  'ctx.fillText(name, 1, 2);',
  `const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'cowork.webm'; a.click(); URL.revokeObjectURL(a.href);`,
  `void fetch('/api/v1/world');`,
  `void fetch('/api/v1/world', { headers: { 'X-Cowork-Session': s } });`,
  'void fetch(`/api/v1/rooms/${room}/timeline?from=${a}&to=${b}`);',
  // Ordinary page glue the rule must leave alone.
  `el.style.display = hidden ? 'none' : '';`,
  'el.style.left = `${x * z}px`;',
  'el.style.width = `${Math.round(w)}px`;',
  'el.style.cursor = CURSORS.grab;',
  'el.style.opacity = OPACITY[state];',
  `el.setAttribute('aria-label', label);`,
  `el.setAttribute('data-motion', 'reduced');`,
  `a.href = '#log';`,
  `el.addEventListener('click', () => toggle());`,
  'setTimeout(() => tick(), 100);',
  'const id = setInterval(function () { tick(); }, 100);',
  'canvas.width = w * z;',
  'ctx.drawImage(sprite, 0, 0);',
  'const m = new Map<string, number>(); m.get(k);',
];

test('T-VIZ-lints: L-VIZ-DOM fires on every 12 §9.5 sink in src/viz/client/** and on nothing else', () => {
  for (const s of DOM_SINKS) {
    assert.ok(has(CLIENT, s, 'L-VIZ-DOM'), `client: ${s}`);
    assert.ok(has('src/viz/client/main.ts', s, 'L-VIZ-DOM'), `client main: ${s}`);
    for (const f of [UI, STORE, 'src/viz/render/raster.ts', 'src/text/sanitize.ts']) assert.ok(!has(f, s, 'L-VIZ-DOM'), `${f}: ${s}`);
  }
  for (const s of DOM_SAFE) assert.deepEqual(lint(CLIENT, s), [], `safe: ${s}`);
});

test('T-VIZ-lints: L-VIZ-GIT checks .run( argvs and git-subcommand array literals against vizGitArgvOk, and bare executable names spawned in src/viz/cli/**', () => {
  const GIT = 'src/viz/source/vizGit.ts';
  const pass = [
    `await git.run(['rev-parse', '--verify', '-q', ref], opts);`,
    `const a = ['rev-parse', '--verify', '-q', ref];`,
    `const a = ['rev-list', '--first-parent', '--max-count=1281', tip];`,
    'const a = [\'rev-list\', \'--first-parent\', `--skip=${a}`, `--max-count=${b}`, tip];',
    `const a = ['rev-list', '--first-parent', '--count', tip] as const;`,
    `const a = ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/cowork-remote/'];`,
    `const a = ['cat-file', '--batch-check'];`,
    `await runner.run(['cat-file', '--batch'], { stdin });`,
    `const v = await runner.run(['version'], opts);`,
    // A non-literal argv is checked at run time by VizGit (vizGitArgvOk before every spawn).
    'await runner.run(args, opts);',
  ];
  for (const s of pass) assert.deepEqual(rules(GIT, s), [], s);
  assert.deepEqual(rules('src\\viz\\source\\vizGit.ts', 'await runner.run(args, opts);'), []);
  // Only vizGit.ts checks a non-literal argv at run time: everywhere else a `.run(` argv held in a variable,
  // spread into the call or missing fires (else `const argv = ['ls-remote', 'origin']; runner.run(argv)` passes).
  const nonLiteral = [
    'await runner.run(args, opts);',
    `const argv = ['ls-remote', 'origin'];\nawait runner.run(argv, opts);`,
    'await runner.run(...call);',
    'await runner.run(argv as string[], opts);',
    `await runner['run'](args, opts);`,
    'await runner?.run(args, opts);',
    'await this.run(args);',
    'await runner.run();',
  ];
  for (const s of nonLiteral) {
    for (const f of [STORE, 'src/viz/main.ts', VIEW, 'src/viz/source/git.ts', 'src/viz/source/vizGit/x.ts', CLIENT, UI]) {
      assert.ok(has(f, s, 'L-VIZ-GIT'), `${f}: ${s}`);
    }
  }
  const fire = [
    `const a = ['log'];`,
    `const a = ['cat-file', 'blob', x];`,
    `const a = ['for-each-ref', 'refs/heads/'];`,
    `const a = ['rev-list', '--first-parent', '--all'];`,
    `const a = ['rev-list', flag, tip];`,
    `const a = ['rev-list', '--first-parent', flag, tip];`,
    'const a = [\'rev-list\', \'--first-parent\', `--max-count=${n}0`, tip];',
    `const a = ['rev-list', '--first-parent', ...flags, tip];`,
    `const a = ['rev-parse', '--verify', '-q', ref, extra];`,
    `const a = ['show', oid];`,
    `const a = ['update-ref', ref, oid];`,
    `await git.run(['status'], opts);`,
    `await git.run(['diff', '--stat'], opts);`,
    `await git.run([cmd, '--batch'], opts);`,
    // A spread or a hole is not a literal argument: it may expand to any number of elements, flags included.
    `const a = ['rev-parse', '--verify', '-q', ...refs];`,
    `const a = ['rev-list', '--first-parent', '--count', ...tips];`,
    `await git.run(['rev-parse', '--verify', '-q', ...refs], opts);`,
    `await git.run(['cat-file', ...flags], { stdin });`,
    `await git.run([...argv], opts);`,
    `const a = ['rev-parse', '--verify', '-q', , ];`,
  ];
  for (const s of fire) {
    for (const f of [GIT, STORE, 'src/viz/main.ts', VIEW]) assert.ok(has(f, s, 'L-VIZ-GIT'), `${f}: ${s}`);
  }
  // src/viz/cli/** spawns no bare executable name: a call of a child_process function, however it is imported.
  const named = `import { spawn, spawnSync, exec, execSync, execFile, execFileSync, fork } from 'node:child_process';\n`;
  for (const [f, s] of [
    ['src/viz/cli/spawn.ts', `${named}spawn('taskkill', ['/PID', String(pid), '/T', '/F']);`],
    ['src/viz/cli/opener.ts', `${named}spawn('explorer', [url]);`],
    ['src/viz/cli/opener.ts', `${named}execFile('xdg-open', [url]);`],
    ['src/viz/cli/opener.ts', `${named}spawnSync('open', [url]);`],
    ['src/viz/cli/ownerProbe.ts', `${named}execFileSync('powershell.exe', ['-NoProfile']);`],
    ['src/viz/cli/spawn.ts', `${named}exec('taskkill /PID 1 /T /F');`],
    ['src/viz/cli/spawn.ts', `${named}execSync('"taskkill" /PID 1');`],
    ['src/viz/cli/spawn.ts', `${named}spawn('./bin/git', []);`],
    ['src/viz/cli/spawn.ts', `${named}fork('worker.js');`],
    ['src/viz/cli/spawn.ts', `import { exec as sh } from 'child_process';\nsh('taskkill /PID 1');`],
    ['src/viz/cli/opener.ts', `import * as cp from 'node:child_process';\ncp.spawnSync('open', [url]);`],
    ['src/viz/cli/opener.ts', `import * as cp from 'node:child_process';\ncp.exec('git');`],
    ['src/viz/cli/opener.ts', `import * as cp from 'node:child_process';\ncp['spawn']('explorer', [url]);`],
    ['src/viz/cli/opener.ts', `import cp from 'node:child_process';\ncp.execFile('xdg-open', [url]);`],
    ['src/viz/cli/opener.ts', `import cp = require('child_process');\ncp.spawn('open', [url]);`],
    ['src/viz/cli/opener.ts', `const cp = require('node:child_process');\ncp.exec('start');`],
    ['src/viz/cli/opener.ts', `const { spawn: run } = require('node:child_process');\nrun('xdg-open', [url]);`],
    ['src/viz/cli/opener.ts', `require('node:child_process').spawn('explorer', [url]);`],
    ['src/viz/cli/opener.ts', `const { execFile } = await import('node:child_process');\nexecFile('open', [url]);`],
  ] as const) {
    assert.ok(has(f, s, 'L-VIZ-GIT'), `${f}: ${s}`);
  }
  for (const [f, s] of [
    ['src/viz/cli/spawn.ts', `${named}spawn(taskkillPath, ['/PID', String(pid), '/T', '/F']);`],
    ['src/viz/cli/spawn.ts', `${named}spawn(process.execPath, [vizJs, 'serve']);`],
    ['src/viz/cli/opener.ts', `${named}spawn('/usr/bin/xdg-open', [url]);`],
    ['src/viz/cli/opener.ts', `${named}spawn('C:\\\\Windows\\\\explorer.exe', [url]);`],
    // RegExp.prototype.exec and other same-named members are not child_process calls.
    ['src/viz/cli/gitPath.ts', '/x/.exec(s);'],
    ['src/viz/cli/gitPath.ts', `const m = /^git version (\\d+)/.exec('taskkill');`],
    ['src/viz/cli/gitPath.ts', `const m = VERSION_RE.exec('version 2.43.0');`],
    ['src/viz/cli/spawn.ts', `${named}const m = /x/.exec('taskkill');`],
    ['src/viz/cli/spawn.ts', `import * as cp from 'node:child_process';\nconst m = RE.exec('taskkill');\ncp.spawn(taskkillPath, []);`],
  ] as const) {
    assert.deepEqual(rules(f, s), [], `${f}: ${s}`);
  }
});

test('T-VIZ-lints: L-VIZ-GIT ignores string tables that are not git argvs', () => {
  const rows = Array.from({ length: 16 }, (_, i) => `  '${'.'.repeat(i % 5)}${'#'.repeat(6)}${'o'.repeat(5 - (i % 5))}${'.'.repeat(5)}',`);
  const tables = [
    `export const BODY: readonly string[] = [\n${rows.join('\n')}\n];`,
    `export const SCENE_EVENT_KINDS = ['room_open', 'room_sign', 'room_badge', 'person_enter', 'person_respawn', 'person_exit', 'person_freeze', 'person_thaw', 'publish', 'conflict', 'save'] as const;`,
    `export const PAGE_SUBSET_PREFIXES: readonly string[] = ['UI_VIZ_', 'PH_', 'SS_'];`,
    `export const HUE_NAMES = ['APRICOT', 'AMBER', 'SKY', 'GREEN', 'LEMON', 'BLUE', 'PINK'] as const;`,
    `export const KINDS: ReadonlySet<string> = new Set(['log', 'show', 'checkout']);`,
  ];
  for (const f of ['src/viz/render/sprites.ts', 'src/viz/model/events.ts', 'src/viz/render/palette.ts']) {
    for (const t of tables) assert.deepEqual(rules(f, t), [], `${f}: ${t.slice(0, 60)}`);
  }
});

test('T-VIZ-lints: L-VIZ-IMPORT fires on node:* or src/ports|src/git|src/engine|src/board/fold.ts imports from client/** or ui/**, on an I/O module in model/** or render/**, on a src/viz/cli/** import from server/** or source/**, on any src/viz import from the daemon, hook, core, mcp or worker entries, and on a non-cli src/viz import from src/entry/cli.ts', () => {
  const fires = (f: string, s: string): boolean => has(f, s, 'L-VIZ-IMPORT');

  // client/** and ui/**
  const browserBad = [
    `import { readFile } from 'node:fs';`,
    `import { createHash } from 'node:crypto';`,
    `import path from 'path';`,
    `const os = require('node:os');`,
    `import type { Clock } from '../../ports/clock.js';`,
    `import { isOid } from '../../git/oid.js';`,
    `import type { StateStore } from '../../engine/state.js';`,
    `import type { FoldState } from '../../board/fold.js';`,
    `export { foldCommit } from '../../board/fold.js';`,
    `type F = import('../../board/fold.js').FoldState;`,
    `const m = await import('../../ports/fs.js');`,
    `/// <reference types="node" />\nexport {};`,
  ];
  const browserOk = [
    `import type { SceneEvent } from '../model/events.js';`,
    `import { sanitize } from '../../text/sanitize.js';`,
    `import { render } from '../../i18n/render.js';`,
    `import type { EventVM } from '../server/viewModel.js';`,
  ];
  for (const f of [CLIENT, UI]) {
    for (const s of browserBad) assert.ok(fires(f, s), `${f}: ${s}`);
    for (const s of browserOk) assert.ok(!fires(f, s), `${f}: ${s}`);
  }

  // model/** and render/**
  const ioBad = [
    `import { readFile } from 'node:fs';`,
    `import { readFile } from 'fs/promises';`,
    `import { spawn } from 'node:child_process';`,
    `import { createServer } from 'node:http';`,
    `import { tmpdir } from 'node:os';`,
    `import { Worker } from 'node:worker_threads';`,
    `import type { Fs } from '../../ports/fs.js';`,
    `import { realClock } from '../../ports/clock.js';`,
    `import { realRandom } from '../../ports/random.js';`,
    `import type { GitRunner } from '../../git/runner.js';`,
    `import type { GitRepo } from '../../git/repo.js';`,
    `import type { StateStore } from '../../engine/state.js';`,
    `import type { VizGit } from '../source/vizGit.js';`,
    `import type { RoomStore } from '../server/store.js';`,
    `import { runView } from '../cli/view.js';`,
  ];
  for (const f of ['src/viz/model/timeline.ts', 'src/viz/model/scene.ts', 'src/viz/render/raster.ts']) {
    for (const s of ioBad) assert.ok(fires(f, s), `${f}: ${s}`);
  }
  for (const s of [
    `import { createHash } from 'node:crypto';`,
    `import { foldCommit, type FoldState } from '../../board/fold.js';`,
    `import type { BoardDraft } from '../../board/boardCommit.js';`,
    `import type { Oid } from '../../git/oid.js';`,
    `import type { SceneEvent } from './events.js';`,
  ]) {
    assert.ok(!fires('src/viz/model/timeline.ts', s), `model: ${s}`);
  }

  // src/viz/cli/** is imported only by src/viz/main.ts, src/viz/cli/** and src/entry/cli.ts (and EN_VIZ_CLI by en.ts, R-V54).
  for (const f of ['src/viz/server/store.ts', 'src/viz/server/http.ts', 'src/viz/source/rooms.ts', 'src/viz/source/git.ts']) {
    assert.ok(fires(f, `import { runView } from '../cli/view.js';`), f);
    assert.ok(fires(f, `import { absolutize } from '../cli/paths.js';`), f);
  }
  assert.ok(!fires('src/viz/main.ts', `import { absolutize } from './cli/paths.js';`));
  assert.ok(!fires('src/viz/cli/view.ts', `import { spawnViewer } from './spawn.js';`));
  assert.ok(!fires('src/entry/cli.ts', `import { runView } from '../viz/cli/view.js';`));
  assert.ok(!fires('src/viz/i18n/en.ts', `import { EN_VIZ_CLI } from '../cli/strings.js';`));
  assert.ok(fires('src/viz/i18n/en.ts', `import { runView } from '../cli/view.js';`));
  assert.ok(fires('src/viz/i18n/codes.ts', `import { EN_VIZ_CLI } from '../cli/strings.js';`));

  // The daemon, hook, core, mcp and worker entries import nothing from src/viz/**.
  for (const e of ['daemon', 'hook', 'core', 'mcp', 'worker']) {
    const f = `src/entry/${e}.ts`;
    assert.ok(fires(f, `import { lookOf } from '../viz/model/looks.js';`), f);
    assert.ok(fires(f, `import type { EventVM } from '../viz/server/viewModel.js';`), f);
    assert.ok(fires(f, `import { runView } from '../viz/cli/view.js';`), f);
    assert.ok(!fires(f, `import { PLUGIN_VERSION } from '../version.js';`), f);
  }

  // src/entry/cli.ts imports only src/viz/cli/**.
  assert.ok(fires('src/entry/cli.ts', `import { main } from '../viz/main.js';`));
  assert.ok(fires('src/entry/cli.ts', `import type { SceneEvent } from '../viz/model/events.js';`));
  assert.ok(fires('src/entry/cli.ts', `import { EN_VIZ } from '../viz/i18n/en.js';`));
  assert.ok(!fires('src/entry/cli.ts', `import { PLUGIN_VERSION } from '../version.js';`));

  // Outside src/viz/** and the entries the rule says nothing.
  assert.deepEqual(lintVizSource('src/engine/x.ts', `import { readFile } from 'node:fs';`), []);
});

test('T-VIZ-lints: L-VIZ-URL allows only the launch template in view.ts and the origin template in http.ts', () => {
  const launch = 'const url = `http://127.0.0.1:${port}/#k=${k}`;';
  const origin = 'const origin = `http://127.0.0.1:${port}`;';
  assert.deepEqual(rules(VIEW, launch), []);
  assert.deepEqual(rules(HTTP, origin), []);
  // A regular expression is not a URL literal.
  assert.deepEqual(rules(VIEW, 'const URL_RE = /^http:\\/\\/127\\.0\\.0\\.1:[1-9][0-9]{0,4}\\/#k=[0-9a-f]{64}$/;'), []);

  const url = (f: string, s: string): boolean => has(f, s, 'L-VIZ-URL');
  assert.ok(url(VIEW, origin));
  assert.ok(url(HTTP, launch));
  for (const f of [VIEW, HTTP, STORE, CLIENT, UI, 'src/viz/model/events.ts', 'src/viz/main.ts']) {
    assert.ok(url(f, `const u = 'http://localhost:1/';`), f);
    assert.ok(url(f, 'const u = `file:///etc/passwd`;'), f);
  }
  for (const s of [launch, origin]) assert.ok(url(STORE, s), `store.ts: ${s}`);
  for (const s of [
    'const u = `https://127.0.0.1:${port}/#k=${k}`;',
    'const u = `http://127.0.0.1:${port}/x#k=${k}`;',
    'const u = `http://localhost:${port}/#k=${k}`;',
    'const u = `${scheme}://127.0.0.1:${port}/#k=${k}`;',
  ]) {
    assert.ok(url(VIEW, s), `view.ts: ${s}`);
  }
  for (const s of ['const u = `http://127.0.0.1:${port}/`;', 'const u = `http://127.0.0.1:${port}${path}`;', 'const u = `http://0.0.0.0:${port}`;']) {
    assert.ok(url(HTTP, s), `http.ts: ${s}`);
  }
});

test('T-VIZ-lints: L-VIZ-NET forbids client network use in server code', () => {
  const net = (f: string, s: string): boolean => has(f, s, 'L-VIZ-NET');
  // S6: the network globals anywhere in src/viz/** outside client/**.
  for (const f of [STORE, HTTP, UI, 'src/viz/source/git.ts', 'src/viz/model/timeline.ts', 'src/viz/main.ts', VIEW]) {
    assert.ok(net(f, 'void fetch(x);'), `${f}: fetch`);
    assert.ok(net(f, 'void globalThis.fetch(x);'), `${f}: globalThis.fetch`);
    assert.ok(net(f, 'const w = new WebSocket(u);'), `${f}: WebSocket`);
    assert.ok(net(f, 'const e = new EventSource(u);'), `${f}: EventSource`);
    assert.ok(net(f, 'const x = new XMLHttpRequest();'), `${f}: XMLHttpRequest`);
  }
  assert.ok(!net(CLIENT, `void fetch('/api/v1/world');`));

  const head = `import http from 'node:http';\n`;
  for (const s of [
    'http.get(u);',
    'http.request(u);',
    'const a = new http.Agent();',
    'const a = http.globalAgent;',
    'net.connect(p);',
    'const s = createConnection(p);',
    'server.listen({ host: h, port: 0 });',
    `server.listen({ host: '0.0.0.0', port: 0 });`,
    'server.listen({ port: 0 });',
    'server.listen(0);',
    `server.listen(0, '127.0.0.1');`,
    'server.listen(opts);',
    `server.listen({ host: '127.0.0.1', ...opts });`,
  ]) {
    assert.ok(net(HTTP, head + s), s);
  }
  assert.ok(net(HTTP, `import { request } from 'node:http';`));
  assert.ok(net(HTTP, `import { get as fetchIt } from 'http';`));
  assert.ok(net(HTTP, `import * as h from 'node:http';\nh.get(u);`));

  const server = `${head}const server = http.createServer(handler);\nserver.listen({ host: '127.0.0.1', port: 0, exclusive: true });\nconst host = req.headers['host'];\nconst v = headers.get('origin');\n`;
  assert.deepEqual(rules(HTTP, server), []);
  assert.deepEqual(rules(STORE, 'const m = new Map<string, number>();\nm.get(k);\nconst c = deps.connected;'), []);
});
