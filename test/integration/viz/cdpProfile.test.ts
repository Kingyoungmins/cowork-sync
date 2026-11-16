// The browser suites' temp profile removal (test/helpers/cdp.ts removeProfile; public CI of 2026-10-12, windows-latest Node 24: the
// smoke's after hook threw "EPERM, Permission denied: \\?\C:\...\cowork-cdp-…" from rmSync once its ≈ 5.5 s of retries ran out, and that
// throw failed the whole browserSmoke file). On Windows a file open without delete sharing blocks its directory's removal; a holder
// process opens one so (libuv's UV_FS_O_EXLOCK, share mode 0) and lets go by itself after a while. Elsewhere an open file blocks
// nothing, so these tests are SKIPPED there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROFILE_RM_MS, removeProfile } from '../../helpers/cdp.js';

const WIN = process.platform === 'win32';
const SKIP: string | false = WIN ? false : 'an open file blocks its directory\'s removal only on Windows';
/** libuv's UV_FS_O_EXLOCK (Windows: open with share mode 0); Node does not export it in fs.constants. */
const EXLOCK = 0x10000000;

/** A holder that opens `file` with no sharing, says "held", keeps it for `ms` and exits by itself (nothing is ever killed). */
async function hold(file: string, ms: number): Promise<{ released: Promise<void> }> {
  const src = `const fs = require('fs'); const [f, ms] = JSON.parse(process.argv[1]);
const fd = fs.openSync(f, fs.constants.O_RDWR | ${EXLOCK}); process.stdout.write('held\\n');
setTimeout(() => { fs.closeSync(fd); process.exit(0); }, ms);`;
  const child = spawn(process.execPath, ['-e', src, JSON.stringify([file, ms])], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const released = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
      if (out.includes('held\n')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`the holder exited (${code}) before it held ${file}`)));
  });
  return { released };
}

/** A profile-like temp directory with a nested file: the directory and that file. */
function profileDir(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-cdp-test-'));
  mkdirSync(join(dir, 'Default'));
  const file = join(dir, 'Default', 'held.bin');
  writeFileSync(file, 'x');
  return { dir, file };
}

test('removeProfile waits out a file held open in the profile and removes the directory once it is let go', { skip: SKIP, timeout: 60_000 }, async () => {
  const { dir, file } = profileDir();
  const h = await hold(file, 2_000);
  // The hold is real: a plain rmSync fails now, with the hosted runner's error.
  assert.throws(() => rmSync(dir, { recursive: true, force: true }), (e: NodeJS.ErrnoException) => e.code === 'EPERM' || e.code === 'EBUSY');
  assert.equal(await removeProfile(dir), null, 'removed');
  assert.equal(existsSync(dir), false);
  await h.released;
});

test('removeProfile never throws: a hold that outlasts its window leaves the directory and returns the reason', { skip: SKIP, timeout: 60_000 }, async () => {
  const { dir, file } = profileDir();
  const h = await hold(file, 3_000);
  const left = await removeProfile(dir, { windowMs: 300, stepMs: 100 });
  assert.ok(left !== null && /EPERM|EBUSY/u.test(left), `the reason: ${JSON.stringify(left)}`);
  assert.equal(existsSync(dir), true, 'left in place');
  await h.released;
  assert.equal(await removeProfile(dir), null, 'removed once the file is let go');
  assert.equal(existsSync(dir), false);
});

test('removeProfile: a missing directory is removed already; the window outlasts rmSync\'s own retries (≈ 5.5 s) by far', async () => {
  const dir = join(tmpdir(), `cowork-cdp-test-missing-${process.pid}-${Date.now()}`);
  assert.equal(await removeProfile(dir), null);
  assert.ok(PROFILE_RM_MS >= 20_000, `PROFILE_RM_MS ${PROFILE_RM_MS}`);
});
