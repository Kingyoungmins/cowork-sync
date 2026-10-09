import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSource, lintCrashpoints, lintTestSource } from '../../tools/lint/rules.js';

function rules(file: string, text: string): string[] {
  return lintSource(file, text).map((f) => f.rule);
}

const F = 'src/daemon/example.ts';
/** Push argvs live only in src/git/push.ts (L-PUSH-ARGV); the push-shaped cases of the other rules are planted there. */
const PUSH = 'src/git/push.ts';

test('L-GIT-SPAWN flags spawn of git outside the runner', () => {
  assert.ok(rules(F, `import { spawn } from 'node:child_process';\nspawn('git', ['status']);`).includes('L-GIT-SPAWN'));
  assert.ok(rules(F, `cp.execSync('git rev-parse HEAD');`).includes('L-GIT-SPAWN'));
  assert.ok(rules(F, `cp.execFile('C:\\\\Program Files\\\\Git\\\\cmd\\\\git.exe', []);`).includes('L-GIT-SPAWN'));
});

test('L-GIT-SPAWN passes inside src/git/runner.ts and for git.run()', () => {
  assert.deepEqual(rules('src/git/runner.ts', `import { spawn } from 'node:child_process';\nspawn('git', ['status']);`), []);
  assert.deepEqual(rules(F, `await git.run(['status', '--porcelain'], { class: 'local', cwd });`), []);
});

test('L-PORTS flags child_process outside the runner (import, export-from, import-equals, require, dynamic import)', () => {
  assert.deepEqual(rules(F, `import { spawn } from 'node:child_process';`), ['L-PORTS']);
  assert.deepEqual(rules(F, `import cp from 'child_process';`), ['L-PORTS']);
  assert.deepEqual(rules(F, `export { spawn } from 'node:child_process';`), ['L-PORTS']);
  assert.deepEqual(rules(F, `import cp = require('child_process');`), ['L-PORTS']);
  assert.deepEqual(rules(F, `const cp = require('child_process');`), ['L-PORTS']);
  assert.deepEqual(rules(F, `const cp = await import('node:child_process');`), ['L-PORTS']);
});

test('L-PORTS passes for the runner and for other node built-ins', () => {
  assert.deepEqual(rules('src/git/runner.ts', `import { spawn } from 'node:child_process';`), []);
  assert.deepEqual(rules(F, `import path from 'node:path';\nimport { createHash } from 'node:crypto';`), []);
});

test('L-NET flags network modules in every load form, bare or node:-prefixed, with no allowed file in Plan 1', () => {
  assert.deepEqual(rules(F, `import http from 'node:http';`), ['L-NET']);
  assert.deepEqual(rules(F, `const https = require('https');`), ['L-NET']);
  assert.deepEqual(rules(F, `const dns = await import('node:dns/promises');`), ['L-NET']);
  assert.deepEqual(rules(F, `export { connect } from 'node:tls';`), ['L-NET']);
  assert.deepEqual(rules(F, `import net = require('net');`), ['L-NET']);
  assert.deepEqual(rules(F, `import dgram from 'dgram';\nimport * as h2 from 'node:http2';`), ['L-NET', 'L-NET']);
  assert.deepEqual(rules('src/entry/mcp.ts', `import net from 'node:net';`), ['L-NET']);
});

test('L-NET passes for other built-ins, relative modules and plain strings', () => {
  assert.deepEqual(rules(F, `import path from 'node:path';\nimport { createHash } from 'node:crypto';\nimport { tmpdir } from 'node:os';`), []);
  assert.deepEqual(rules(F, `import { netmask } from './netmask.js';\nimport { dnsName } from '../http-like/dns.js';`), []);
  assert.deepEqual(rules(F, `const kind = 'net';\nconst scheme = 'https';`), []);
});

test('L-CLOCK flags Date.now(), new Date() and performance.now() outside the Clock port', () => {
  assert.deepEqual(rules(F, `const a = Date.now();`), ['L-CLOCK']);
  assert.deepEqual(rules(F, `const b = new Date();`), ['L-CLOCK']);
  assert.deepEqual(rules(F, `const c = performance.now();`), ['L-CLOCK']);
});

test('L-CLOCK passes in src/ports/clock.ts and for clock.wallMs()', () => {
  assert.deepEqual(rules('src/ports/clock.ts', `const a = Date.now(); const c = performance.now(); const d = new Date(a);`), []);
  assert.deepEqual(rules(F, `const w = clock.wallMs(); const m = clock.monoMs();`), []);
});

test('L-RANDOM flags Math.random, randomBytes and randomUUID outside the Random port', () => {
  assert.deepEqual(rules(F, `const r = Math.random();`), ['L-RANDOM']);
  assert.deepEqual(rules(F, `import { randomBytes } from 'node:crypto';`), ['L-RANDOM']);
  assert.deepEqual(rules(F, `const u = crypto.randomUUID();`), ['L-RANDOM']);
  assert.deepEqual(rules(F, `const b = nodeCrypto.randomBytes(8);`), ['L-RANDOM']);
});

test('L-RANDOM passes in src/ports/random.ts and for random.bytes()', () => {
  assert.deepEqual(rules('src/ports/random.ts', `import { randomBytes } from 'node:crypto';\nconst b = randomBytes(8);`), []);
  assert.deepEqual(rules(F, `const b = random.bytes(8);`), []);
});

test('L-PERMISSION flags permissionDecision "allow" and "ask"', () => {
  assert.deepEqual(rules(F, `const out = { hookSpecificOutput: { permissionDecision: 'allow' } };`), ['L-PERMISSION']);
  assert.deepEqual(rules(F, `const out = { permissionDecision: denied ? 'deny' : 'ask' };`), ['L-PERMISSION']);
  assert.deepEqual(rules(F, `o.permissionDecision = "allow";`), ['L-PERMISSION']);
  assert.deepEqual(rules(F, `interface Out { permissionDecision: 'deny' | 'ask'; }`), ['L-PERMISSION']);
});

test('L-PERMISSION passes for "deny" and for unrelated "allow" strings', () => {
  assert.deepEqual(rules(F, `const out = { hookSpecificOutput: { permissionDecision: 'deny' } };`), []);
  assert.deepEqual(rules(F, `interface Out { permissionDecision: 'deny'; }\nconst mode = 'allow';`), []);
});

test('L-REFS flags + refspecs, --force, deletion refspecs and refs/worktree/', () => {
  assert.deepEqual(rules(PUSH, `await git.run(['push', url, '+refs/cowork/x/code:refs/cowork/x/code'], o);`), ['L-REFS']);
  assert.deepEqual(rules(PUSH, 'await git.run([\'push\', url, `+${oid}:refs/cowork/${b}/code`], o);'), ['L-REFS']);
  assert.deepEqual(rules(PUSH, `await git.run(['push', '--force', url, spec], o);`), ['L-REFS']);
  assert.deepEqual(rules(PUSH, `await git.run(['push', url, ':refs/cowork/x/board'], o);`), ['L-REFS']);
  assert.deepEqual(rules(F, `const r = 'refs/worktree/cowork';`), ['L-REFS']);
});

test('L-REFS passes for leased pushes, fetch refspecs and the probe-ref deletion', () => {
  assert.deepEqual(rules(PUSH, 'await git.run([\'push\', `--force-with-lease=refs/cowork/${b}/code:${tip}`, url, `${c}:refs/cowork/${b}/code`], o);'), []);
  assert.deepEqual(rules(F, `await git.run(['fetch', url, '+refs/cowork/x/board:refs/cowork-remote/x/board'], o);`), []);
  assert.deepEqual(rules(PUSH, 'await git.run([\'push\', url, `:refs/cowork/probe-${peerId}`], o);'), []);
});

test('L-MERGE-BASE flags git merge-base and merge-tree without --merge-base', () => {
  assert.deepEqual(rules(F, `await git.run(['merge-base', a, b], o);`), ['L-MERGE-BASE']);
  assert.deepEqual(rules(F, `await git.run(['merge-tree', '--write-tree', p, tip], o);`), ['L-MERGE-BASE']);
});

test('L-MERGE-BASE passes for merge-tree with --merge-base and for command tables', () => {
  assert.deepEqual(rules(F, 'await git.run([\'merge-tree\', \'--write-tree\', `--merge-base=${a}`, p, tip], o);'), []);
  assert.deepEqual(rules(F, `await git.run(['merge-tree', '--write-tree', '--merge-base', a, p, tip], o);`), []);
  assert.deepEqual(rules(F, `const ATTR = new Set(['merge-tree', 'merge-file', 'add']);`), []);
  assert.deepEqual(rules(F, `const x = '--merge-base';`), []);
});

test('L-MERGE-OPTS flags -X / --strategy-option, --union, merge=union and merge-file without --object-id', () => {
  assert.deepEqual(rules(F, `await git.run(['merge-tree', '--write-tree', '--merge-base', a, '-X', 'ours', p, tip], o);`), ['L-MERGE-OPTS']);
  assert.deepEqual(rules(F, 'await git.run([\'merge-tree\', \'--write-tree\', `--merge-base=${a}`, \'-Xtheirs\', p, tip], o);'), ['L-MERGE-OPTS']);
  assert.deepEqual(rules(F, `await git.run(['merge-tree', '--write-tree', '--merge-base', a, '--strategy-option=renormalize', p, tip], o);`), ['L-MERGE-OPTS']);
  assert.deepEqual(rules(F, `const extra = 'merge-tree -X ours';`), ['L-MERGE-OPTS']);
  assert.deepEqual(rules(F, `await git.run(['merge-file', '-p', '--object-id', '--union', a, b, c], o);`), ['L-MERGE-OPTS']);
  assert.deepEqual(rules(F, `const attrs = '*.lock merge=union';`), ['L-MERGE-OPTS']);
  assert.deepEqual(rules(F, `await git.run(['merge-file', '-p', cur, base, other], o);`), ['L-MERGE-OPTS']);
});

test('L-MERGE-OPTS passes for merge-file --object-id, the MERGE_FLAGS table, command tables and lowercase -x', () => {
  assert.deepEqual(rules(F, `await git.run(['merge-file', '-p', '--object-id', a, b, c], o);`), []);
  assert.deepEqual(rules(F, `export const MERGE_FLAGS: readonly string[] = Object.freeze(['-c', 'merge.renormalize=false', '-c', 'merge.renames=true', '-c', 'merge.directoryRenames=false']);`), []);
  assert.deepEqual(rules(F, `const MERGE_COMMANDS: ReadonlySet<string> = new Set(['merge-tree', 'merge-file']);`), []);
  assert.deepEqual(rules(F, `await git.run(['ls-files', '-z', '-x', pattern], o);`), []);
});

// A hash-object argv is allowed only in the blob-route files (L-OBJ-WRITE), so the L-HASH-STDIN cases are linted as one of them.
const H = 'src/data/blobRoutes.ts';

test('L-HASH-STDIN flags hash-object --stdin without --path', () => {
  assert.deepEqual(rules(H, `await git.run(['hash-object', '-w', '--stdin'], o);`), ['L-HASH-STDIN']);
});

test('L-HASH-STDIN passes with --path, with --no-filters (canon writer) and for file input', () => {
  assert.deepEqual(rules(H, 'await git.run([\'hash-object\', \'--stdin\', `--path=${p}`], o);'), []);
  assert.deepEqual(rules(H, `await git.run(['hash-object', '-w', '--no-filters', '--stdin'], o);`), []);
  assert.deepEqual(rules(H, `await git.run(['hash-object', '--', stagedPath], o);`), []);
});

test('L-OBJ-WRITE fires on hash-object and add argv outside the allowed files', () => {
  const hash = `await git.run(['hash-object', '-w', '--path=p', '--', copy], o);`;
  const add = `await git.run(['add', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], o);`;
  for (const f of [F, 'src/engine/publish.ts', 'src/engine/snapshot.ts', 'src/engine/diskEq.ts', 'src/holds/registry.ts']) {
    assert.deepEqual(rules(f, hash), ['L-OBJ-WRITE'], `hash-object in ${f}`);
  }
  for (const f of ['src/git/repo.ts', 'src/data/blobRoutes.ts']) assert.deepEqual(rules(f, hash), [], `hash-object in ${f}`);
  for (const f of [F, 'src/git/repo.ts', 'src/data/blobRoutes.ts', 'src/engine/writer.ts']) {
    assert.deepEqual(rules(f, add), ['L-OBJ-WRITE'], `add in ${f}`);
  }
  for (const f of ['src/engine/snapshot.ts', 'src/engine/diskEq.ts']) assert.deepEqual(rules(f, add), [], `add in ${f}`);
  // The rule keys on the subcommand, with or without -w; a --stdin argv also trips L-HASH-STDIN.
  assert.deepEqual(rules(F, `await git.run(['hash-object', '--', copy], o);`), ['L-OBJ-WRITE']);
  assert.ok(rules(F, `await git.run(['hash-object', '--stdin'], o);`).includes('L-OBJ-WRITE'));
  assert.deepEqual(rules('src\\engine\\diskEq.ts', add), [], 'Windows separators are normalised');
  // Not an argv: a command table, the runner's watchdog comparison, an `--add` option of another subcommand.
  assert.deepEqual(rules(F, `const S = new Set(['add', 'hash-object']);`), []);
  assert.deepEqual(rules(F, `if (sub === 'add' || sub === 'hash-object') return 1;`), []);
  assert.deepEqual(rules(F, `await git.run(['update-index', '--add', '--cacheinfo', x], o);`), []);
  assert.deepEqual(rules(F, `const flags = ['--add', 'hash-object'];`), []);
});

test('L-TOKEN flags CLAUDE_CODE_MESSAGING_TOKEN as identifier, key or literal outside src/entry/mcp.ts', () => {
  assert.deepEqual(rules(F, `const t = process.env.CLAUDE_CODE_MESSAGING_TOKEN;`), ['L-TOKEN']);
  assert.deepEqual(rules(F, `const t = process.env['CLAUDE_CODE_MESSAGING_TOKEN'];`), ['L-TOKEN']);
  assert.deepEqual(rules(F, `const { CLAUDE_CODE_MESSAGING_TOKEN: tok } = process.env;`), ['L-TOKEN']);
  assert.deepEqual(rules(F, 'const k = `${prefix}CLAUDE_CODE_MESSAGING_TOKEN`;'), ['L-TOKEN']);
  assert.deepEqual(rules('src/git/env.ts', `const NEVER = ['CLAUDE_CODE_MESSAGING_TOKEN', 'NODE_OPTIONS'];`), ['L-TOKEN']);
});

test('L-TOKEN passes in src/entry/mcp.ts, for the CLAUDE_ prefix list and for other CLAUDE_ names', () => {
  assert.deepEqual(rules('src/entry/mcp.ts', `const t = process.env.CLAUDE_CODE_MESSAGING_TOKEN;`), []);
  assert.deepEqual(rules('src/git/env.ts', `const NEVER_PREFIXES = ['CLAUDE_', 'ELECTRON_', 'VSCODE_'];`), []);
  assert.deepEqual(rules(F, `const s = process.env.CLAUDE_CODE_MESSAGING_SOCKET;`), []);
});

test('L-GIT-ATOMIC flags --atomic as an argv element or inside a command string', () => {
  assert.deepEqual(rules(PUSH, `await git.run(['push', '--porcelain', '--atomic', url, a, b], o);`), ['L-GIT-ATOMIC']);
  assert.deepEqual(rules(F, `const cmd = 'push --atomic';`), ['L-GIT-ATOMIC']);
});

test('L-GIT-ATOMIC passes for --no-atomic and for non-literal mentions', () => {
  assert.deepEqual(rules(PUSH, 'await git.run([\'push\', \'--porcelain\', \'--no-verify\', \'--no-atomic\', url, `${c}:refs/cowork/${b}/code`], o);'), []);
  assert.deepEqual(rules(F, `const caps = { atomic: true, pushOptions: false };`), []);
});

test('L-CRASHPOINTS flags a non-literal crashpoint() argument; passes for literals and the port itself', () => {
  assert.deepEqual(rules(F, `crashpoint(name);`), ['L-CRASHPOINTS']);
  assert.deepEqual(rules(F, `crashpoint('apply.intent');`), []);
  assert.deepEqual(rules('src/ports/crashpoint.ts', `export function crashpoint(name: string): void { if (h) h(name); }\ncrashpoint(x);`), []);
});

test('lintCrashpoints flags call sites missing from the catalogue', () => {
  const f = lintCrashpoints(['apply.intent', 'apply.bogus', 'apply.bogus'], ['apply.intent', 'publish.sent']);
  assert.equal(f.length, 1);
  assert.equal(f[0]?.rule, 'L-CRASHPOINTS');
  assert.match(f[0]?.message ?? '', /apply\.bogus/);
});

test('lintCrashpoints passes when every call site is catalogued (catalogue may be larger)', () => {
  assert.deepEqual(lintCrashpoints([], ['apply.intent']), []);
  assert.deepEqual(lintCrashpoints(['apply.intent'], ['apply.intent', 'publish.sent']), []);
});

test('L-GIT-FORBIDDEN fires on each forbidden argv and not on the allowed ones', () => {
  const hit = (code: string): string[] => rules(F, code);
  // An add argv is allowed only in the snapshot and DISK_EQ files (L-OBJ-WRITE), so the add cases are linted as one of them.
  const hitAdd = (code: string): string[] => rules('src/engine/snapshot.ts', code);
  for (const sub of ['checkout', 'checkout-index', 'switch', 'restore', 'stash', 'apply', 'gc']) {
    assert.deepEqual(hit(`await git.run(['${sub}', 'x'], o);`), ['L-GIT-FORBIDDEN'], sub);
  }
  assert.deepEqual(hit(`await git.run(['read-tree', '-u', tree], o);`), ['L-GIT-FORBIDDEN']);
  assert.deepEqual(hit(`await git.run(['read-tree', '-m', a, b], o);`), ['L-GIT-FORBIDDEN']);
  assert.deepEqual(hit(`await git.run(['read-tree', '-um', a, b], o);`), ['L-GIT-FORBIDDEN']);
  assert.deepEqual(hit(`await git.run(['reset', '--hard', 'HEAD'], o);`), ['L-GIT-FORBIDDEN']);
  assert.deepEqual(hitAdd(`await git.run(['add', '-A'], o);`), ['L-GIT-FORBIDDEN']);
  assert.deepEqual(hitAdd(`await git.run(['add', '--all'], o);`), ['L-GIT-FORBIDDEN']);
  assert.deepEqual(hitAdd(`await git.run(['add', '.'], o);`), ['L-GIT-FORBIDDEN']);
  assert.deepEqual(hitAdd(`await git.run(['add', '--', '.'], o);`), ['L-GIT-FORBIDDEN']);
  assert.deepEqual(hit(`await git.run(['update-index', '--refresh', '-q'], o);`), ['L-GIT-FORBIDDEN']);
  assert.deepEqual(hit(`await git.run(['update-index', '-q', '-z', '--refresh'], o);`), ['L-GIT-FORBIDDEN']);
  // Allowed: the plumbing the engine uses.
  assert.deepEqual(hit(`await git.run(['read-tree', tree], o);`), []);
  assert.deepEqual(hit(`await git.run(['read-tree', '--empty'], o);`), []);
  assert.deepEqual(hit(`await git.run(['reset', '--soft', 'HEAD'], o);`), []);
  assert.deepEqual(hitAdd(`await git.run(['add', '--', 'src/a.ts'], o);`), []);
  assert.deepEqual(hitAdd(`await git.run(['add', '-f', '--', 'a.ts'], o);`), []);
  assert.deepEqual(hit(`await git.run(['update-index', '--refresh'], o);`), []);
  assert.deepEqual(hit(`await git.run(['update-index', '-z', '--index-info'], o);`), []);
  assert.deepEqual(hit(`await git.run(['update-index', '-q', '--index-info'], o);`), []);
  assert.deepEqual(hit(`await git.run(['checkout-ish', 'x'], o);`), []);
  assert.deepEqual(hit(`const ACTIONS = new Set(['checkout', 'stash']);`), []);
  assert.deepEqual(hit(`const r = 'checkout';`), []);
});

test('L-FS-PORT fires on every fs load form outside src/ports/fs.ts', () => {
  for (const mod of ['fs', 'node:fs', 'fs/promises', 'node:fs/promises']) {
    assert.deepEqual(rules(F, `import x from '${mod}';`), ['L-FS-PORT'], mod);
    assert.deepEqual(rules(F, `import { readFile } from '${mod}';`), ['L-FS-PORT'], mod);
    assert.deepEqual(rules(F, `export { readFile } from '${mod}';`), ['L-FS-PORT'], mod);
    assert.deepEqual(rules(F, `import x = require('${mod}');`), ['L-FS-PORT'], mod);
    assert.deepEqual(rules(F, `const x = require('${mod}');`), ['L-FS-PORT'], mod);
    assert.deepEqual(rules(F, `const x = await import('${mod}');`), ['L-FS-PORT'], mod);
  }
  assert.deepEqual(rules(F, `import * as fs from 'node:fs';
import { promises } from 'fs';`), ['L-FS-PORT', 'L-FS-PORT']);
  // The port itself, files outside src/, other built-ins and lookalikes pass.
  assert.deepEqual(rules('src/ports/fs.ts', `import { promises as fsp } from 'node:fs';`), []);
  assert.deepEqual(rules('test/helpers/tmp.ts', `import { mkdirSync } from 'node:fs';`), []);
  assert.deepEqual(rules('tools/build/x.ts', `import { readFile } from 'node:fs/promises';`), []);
  assert.deepEqual(rules(F, `import path from 'node:path';
import { fileURLToPath } from 'node:url';`), []);
  assert.deepEqual(rules(F, `import { fsLike } from './fs.js';
import x from 'memfs';
const k = 'fs';`), []);
  assert.deepEqual(rules('src/ports/fs.ts.bak', `import x from 'node:fs';`), ['L-FS-PORT']);
});

/** Every <top>/**\/*.ts file as [repo-relative path, text]. */
function tsFiles(top: string): Array<[string, string]> {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const out: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) out.push([relative(root, full).split('\\').join('/'), readFileSync(full, 'utf8')]);
    }
  };
  walk(join(root, top));
  return out;
}

/** Every src/**\/*.ts file as [repo-relative path, text]. */
function srcFiles(): Array<[string, string]> {
  return tsFiles('src');
}

// Final review (exit-1 flake, root cause proven): tests killed survivors by PIDs read back from a file about 1.5 s after
// those processes had died; a reused PID made the SIGKILL (TerminateProcess(h, 1) on Windows) end an unrelated process,
// typically another test file's git, which then exited 1 with no stderr. A PID is safe to signal only while this
// process holds its handle (ChildProcess.kill) or as a signal-0 liveness probe. The one exception is the runner's POSIX
// group kill, which runs in the same tick as the `exited` check, before Node can reap the group leader.
test('L-PID-KILL flags process.kill with any signal but 0, in src/ and in test code', () => {
  for (const file of [F, 'src/git/runner.ts', 'test/integration/runner.test.ts', 'test/helpers/tmp.ts']) {
    assert.deepEqual(rules(file, `process.kill(pid, 'SIGKILL');`), ['L-PID-KILL'], file);
    assert.deepEqual(rules(file, `process.kill(pid);`), ['L-PID-KILL'], `${file}: no signal means SIGTERM`);
    assert.deepEqual(rules(file, `process.kill(pid, 9);`), ['L-PID-KILL'], file);
    assert.deepEqual(rules(file, `process.kill(Number(line), sig);`), ['L-PID-KILL'], `${file}: a signal that is not a literal 0`);
    assert.deepEqual(rules(file, `process['kill'](pid, 'SIGTERM');`), ['L-PID-KILL'], file);
    assert.deepEqual(rules(file, `globalThis.process.kill(pid, 'SIGINT');`), ['L-PID-KILL'], file);
    assert.deepEqual(rules(file, `for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }`), ['L-PID-KILL'], file);
  }
  // The group kill is allowed only in the runner and the viewer CLI's spawn.ts (VIZ-02); a bare pid is flagged there too.
  assert.deepEqual(rules(F, `process.kill(-pid, 'SIGKILL');`), ['L-PID-KILL']);
  assert.deepEqual(lintTestSource('test/integration/x.test.ts', `process.kill(-pid, 'SIGKILL');`).map((x) => x.rule), ['L-PID-KILL']);
  // Test code gets this rule and no other: Date.now(), child_process and git spawns stay allowed there.
  assert.deepEqual(lintTestSource('test/integration/x.test.ts',
    `import { spawn } from 'node:child_process';\nconst t = Date.now();\nspawn('git', ['status']);\nprocess.kill(pid, 'SIGKILL');\n`)
    .map((x) => [x.rule, x.line]), [['L-PID-KILL', 4]]);
});

test('L-PID-KILL passes for signal-0 probes, handle-based kills and the runner\'s POSIX group kill', () => {
  for (const file of [F, 'src/engine/loop.ts', 'test/integration/runner.test.ts']) {
    assert.deepEqual(rules(file, `try { process.kill(pid, 0); return true; } catch { return false; }`), [], file);
    assert.deepEqual(rules(file, `child.kill('SIGKILL');\nproc.kill();\nc.kill(9);`), [], file);
    assert.deepEqual(rules(file, `const kill = (p: number): void => undefined;\nkill(pid);\nprocess.exit(1);`), [], file);
  }
  assert.deepEqual(rules('src/git/runner.ts', `try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }`), []);
  assert.deepEqual(rules('src/viz/cli/spawn.ts', `process.kill(-pgid, 'SIGTERM');`), []);
  assert.deepEqual(rules('src/viz/cli/spawn.ts', `process.kill(pid, 'SIGKILL');`), ['L-PID-KILL']);

  // The real trees: no finding in src/ or test/, and the files that held the kills are among those linted.
  const files = [...tsFiles('src'), ...tsFiles('test')];
  const names = files.map(([f]) => f);
  for (const must of ['src/git/runner.ts', 'src/engine/loop.ts', 'test/integration/runner.test.ts', 'test/integration/runner.abort.test.ts']) {
    assert.ok(names.includes(must), must);
  }
  const hits = files.flatMap(([f, text]) => (f.startsWith('src/') ? lintSource(f, text) : lintTestSource(f, text))
    .filter((x) => x.rule === 'L-PID-KILL').map((x) => `${x.file}:${x.line}`));
  assert.deepEqual(hits, []);
  // …and the runner really holds a group kill: moved to another file, the rule fires on it.
  const runnerText = files.find(([f]) => f === 'src/git/runner.ts')![1];
  assert.ok(lintSource('src/git/other.ts', runnerText).some((x) => x.rule === 'L-PID-KILL'));
});

test('L-PUSH-ARGV, L-CLASSIFY-TEXT and L-MIRROR fire on planted sources and not on the real files', () => {
  // L-PUSH-ARGV: an argv starting `push` anywhere but src/git/push.ts (ENG-09: every refspec from pushSpec).
  assert.deepEqual(rules(F, `await repo.run(['push', '--porcelain', url, spec], o);`), ['L-PUSH-ARGV']);
  assert.deepEqual(rules('src/engine/publish.ts', 'await repo.run([\'push\', \'--porcelain\', \'--no-verify\', url, `${c}:refs/cowork/${b}/code`], o);'), ['L-PUSH-ARGV']);
  assert.deepEqual(rules('src/git/fetch.ts', `const argv = ['push', url];`), ['L-PUSH-ARGV']);
  assert.deepEqual(rules(PUSH, `const argv = ['push', '--porcelain', '--no-verify'];`), []);
  assert.deepEqual(rules(F, `const KINDS = new Set(['push', 'fetch']);\nconst p = 'push';\nconst purpose: PushPurpose = 'publish';`), []);
  // L-CLASSIFY-TEXT: no text identifier in the two outcome classifiers (glossary §26.2 item 2).
  for (const file of ['src/git/classify.ts', 'src/engine/pushResult.ts']) {
    assert.deepEqual(rules(file, `if (raw.stderr.includes('stale')) retry();`), ['L-CLASSIFY-TEXT'], file);
    assert.deepEqual(rules(file, `const t = e.stderrText;`), ['L-CLASSIFY-TEXT'], file);
    assert.deepEqual(rules(file, `if (/locked/.test(err.message)) retry();`), ['L-CLASSIFY-TEXT'], file);
    assert.deepEqual(rules(file, `function f({ stderr }: R): string { return String(stderr); }`), ['L-CLASSIFY-TEXT', 'L-CLASSIFY-TEXT'], file);
    assert.deepEqual(rules(file, `const s = o['message'];`), ['L-CLASSIFY-TEXT'], file);
    assert.deepEqual(rules(file, `const outcome = moved ? 'lease_lost' : 'transient';\nthrow new TypeError('bad observation');`), [], file);
  }
  assert.deepEqual(rules(PUSH, `const e = r.stderr;`), [], 'other files keep stderr for readHttpThrottle and the doctor');
  assert.deepEqual(rules('src/engine/publish.ts', `log.write('warn', 'X', { m: e.message });`), []);
  // L-MIRROR: the mirror's names only where the mirror is a lease value (PRO-13).
  assert.deepEqual(rules('src/engine/apply.ts', `const m = await repo.readRef(core.refs.localCode);`), ['L-MIRROR']);
  assert.deepEqual(rules('src/engine/incident.ts', `if (refs.remoteCode) x();`), ['L-MIRROR']);
  assert.deepEqual(rules(F, `const { localCode } = refs;`), ['L-MIRROR']);
  assert.deepEqual(rules(F, `const { remoteCode: mirror } = refs;`), ['L-MIRROR']);
  assert.deepEqual(rules(F, `const c = refs['remoteCode'];`), ['L-MIRROR']);
  for (const file of ['src/engine/refs.ts', 'src/engine/fetcher.ts', 'src/engine/publish.ts', 'src/engine/start.ts', 'src/engine/recover.ts']) {
    assert.deepEqual(rules(file, `const a = refs.localCode;\nconst b = refs.remoteCode;`), [], file);
  }
  assert.deepEqual(rules(F, `const b = refs.localBoard;\nconst r = refs.remoteBranch;\nconst c = view.code;\nconst s = refs.fetchSpecs;`), []);

  // The real files: none of the three fires anywhere in src/, and the files they guard are among those linted.
  const files = srcFiles();
  const names = files.map(([f]) => f);
  for (const must of ['src/git/push.ts', 'src/git/fetch.ts', 'src/git/classify.ts', 'src/engine/pushResult.ts', 'src/engine/fetcher.ts', 'src/engine/incident.ts', 'src/engine/refs.ts']) {
    assert.ok(names.includes(must), must);
  }
  const NEW = new Set(['L-PUSH-ARGV', 'L-CLASSIFY-TEXT', 'L-MIRROR']);
  const hits = files.flatMap(([f, text]) => lintSource(f, text).filter((x) => NEW.has(x.rule)).map((x) => `${x.rule} ${x.file}:${x.line}`));
  assert.deepEqual(hits, []);
  // …and push.ts really does hold push argvs: moved to another file, the rule fires on it.
  const pushText = files.find(([f]) => f === 'src/git/push.ts')![1];
  assert.ok(lintSource('src/engine/publish.ts', pushText).some((x) => x.rule === 'L-PUSH-ARGV'));
  const fetcherText = files.find(([f]) => f === 'src/engine/fetcher.ts')![1];
  assert.ok(lintSource('src/engine/apply.ts', fetcherText).some((x) => x.rule === 'L-MIRROR'));
});

test('findings carry the 1-based line and a forward-slash file path', () => {
  const f = lintSource('src\\daemon\\x.ts', `const a = 1;\nconst b = Date.now();\n`);
  assert.deepEqual(f.map((x) => [x.rule, x.file, x.line]), [['L-CLOCK', 'src/daemon/x.ts', 2]]);
});
