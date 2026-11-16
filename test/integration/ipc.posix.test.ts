// Plan 5 Task 3 (ubuntu, macos only): real Unix sockets — one bind per endpoint, and A3-5's stale-socket removal (SEC-21 "binding it enforces
// one daemon per clone"). The stale socket comes from a child that listens and ends itself without closing its server (ruling P5-EB-9):
// the test never signals a process by pid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { lstat, symlink, unlink } from 'node:fs/promises';
import { realFs } from '../../src/ports/fs.js';
import { realIpc } from '../../src/ports/ipc.js';
import { realRandom } from '../../src/ports/random.js';
import { endpointName, socketDir } from '../../src/sec/endpoint.js';

const SKIP = process.platform === 'win32' ? 'Unix sockets (this runner is win32; the unit twins are in sec.endpoint.test.ts)' : false;

async function freshEndpoint(): Promise<string> {
  const dir = await socketDir(process.env, process.getuid?.() ?? -1, realFs, `${'0'.repeat(24)}.sock`);
  assert.ok(dir.ok, 'a socket directory');
  return endpointName(Buffer.from(realRandom.bytes(32)), `/ipc-posix-test/${process.pid}`, process.platform, dir.dir);
}

const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

/** A child that binds ep and ends itself without closing its server; resolves when it has exited. */
function exitAfterListen(ep: string, how: 'exit' | 'abort'): Promise<void> {
  const code = `const s = require('node:net').createServer(); s.listen(process.argv[1], () => process.${how === 'exit' ? 'exit(0)' : 'abort()'});`;
  return new Promise((resolve) => {
    execFile(process.execPath, ['-e', code, ep], { timeout: 10_000 }, () => resolve());
  });
}

/** The last resort of P5-EB-9: a live child killed through its own ChildProcess handle before its 'exit' event. */
function killedAfterListen(ep: string): Promise<void> {
  const code = `const s = require('node:net').createServer(); s.listen(process.argv[1], () => process.stdout.write('ready\\n')); setInterval(() => {}, 1000);`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code, ep], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.once('exit', () => resolve());
    child.stdout.once('data', () => child.kill('SIGKILL'));
  });
}

test('real sockets: one bind per endpoint, a stale socket is removed only when nothing listens', { skip: SKIP }, async (t) => {
  // realIpc.listen twice → the second rejects EADDRINUSE and the first keeps serving.
  const ep = await freshEndpoint();
  let accepted = 0;
  const server = await realIpc.listen(ep, (c) => { accepted += 1; c.destroy(); });
  await assert.rejects(realIpc.listen(ep, () => {}), (e: unknown) => (e as NodeJS.ErrnoException).code === 'EADDRINUSE');
  const conn = await realIpc.connect(ep, 1_000);
  await new Promise<void>((r) => conn.onClose(r));
  assert.equal(accepted, 1);
  // With a live listener removeStale → false and the file stays.
  assert.equal(await realIpc.removeStale(ep), false);
  assert.equal(await exists(ep), true);
  await server.close();

  // A child that bound ep2 and ended without closing leaves the socket file: removeStale → true, then listen succeeds.
  const ep2 = await freshEndpoint();
  let form = 'process.exit after listening';
  await exitAfterListen(ep2, 'exit');
  if (!(await exists(ep2))) {
    form = 'process.abort after listening';
    await exitAfterListen(ep2, 'abort');
  }
  if (!(await exists(ep2))) {
    form = 'ChildProcess.kill(SIGKILL) through its handle';
    await killedAfterListen(ep2);
  }
  t.diagnostic(`stale socket made by: ${form}`);
  assert.equal(await exists(ep2), true, 'the stale socket file is there');
  assert.equal(await realIpc.removeStale(ep2), true);
  assert.equal(await exists(ep2), false);
  const again = await realIpc.listen(ep2, () => {});
  await again.close();

  // A symlink placed at the endpoint → false (and it stays).
  const ep3 = await freshEndpoint();
  await symlink(ep2, ep3);
  t.after(() => unlink(ep3).catch(() => {}));
  assert.equal(await realIpc.removeStale(ep3), false);
  assert.equal(await exists(ep3), true);
  // Nothing at the endpoint → false.
  assert.equal(await realIpc.removeStale(await freshEndpoint()), false);
});
