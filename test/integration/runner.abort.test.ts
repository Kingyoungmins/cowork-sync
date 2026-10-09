// GitCallOptions.abort (controller ruling P2-ABORT): an abort kills the git process tree exactly like a watchdog
// kill and the call resolves with aborted = true, so the Fetcher's abandon() can wait for the aborted fetch to exit
// before it starts the next one (O-FETCH: a peer never runs two fetches at once).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selfExitPrologue } from '../helpers/selfExit.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';

/** Single-quote a path for a sh command line; forward slashes work on every OS. */
function shq(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function initRepo(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const r = await testRunner().run(['init', '-q', '-b', 'main', dir], { class: 'local', cwd: root });
  assert.equal(r.code, 0, r.stderr.toString('utf8'));
  return dir;
}

test('an abort kills a long-running git and its grandchild like a watchdog kill and resolves with aborted (ruling P2-ABORT)', async () => {
  const { root, cleanup } = await makeTempRoot('runner-abort');
  try {
    const repo = await initRepo(root, 'r');
    const hb = join(root, 'heart beat.txt');
    const beater = join(root, 'beater.cjs');
    const spawner = join(root, 'spawner.cjs');
    // Both helpers end on their own once the cleanup removes the root (selfExitPrologue, 60 s at most): a runner that
    // ignores the abort fails the assertions below and leaves nothing running, and no pid is ever signalled after its
    // process died (lint L-PID-KILL).
    await writeFile(beater, Buffer.from(
      selfExitPrologue(root) +
      `const fs = require('fs');\n` +
      `setInterval(() => fs.appendFileSync(process.argv[2], 'x'), 20);\n`, 'utf8'));
    await writeFile(spawner, Buffer.from(
      selfExitPrologue(root) +
      `const { spawn } = require('child_process');\n` +
      `spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });\n` +
      `setInterval(() => {}, 1000);\n`, 'utf8'));
    const git = testRunner();
    const set = await git.run(['config', 'alias.hb', `!node ${shq(spawner)} ${shq(beater)} ${shq(hb)}`], { class: 'local', cwd: repo });
    assert.equal(set.code, 0, set.stderr.toString('utf8'));

    // Class 'local' and an unknown subcommand: no watchdog bounds this call, only the abort can end it.
    const ctl = new AbortController();
    const running = git.run(['hb'], { class: 'local', cwd: repo, abort: ctl.signal });
    for (let i = 0; i < 400 && !(existsSync(hb) && statSync(hb).size > 0); i++) await pause(25);
    assert.ok(existsSync(hb), 'the grandchild ran before the abort');
    ctl.abort();
    // Bounded, so a runner that ignores the abort fails here instead of hanging (the helpers end once the root is gone).
    let bound: NodeJS.Timeout | undefined;
    const r = await Promise.race([running, new Promise<null>((res) => { bound = setTimeout(() => res(null), 20_000); })]);
    clearTimeout(bound);
    assert.ok(r !== null, 'the aborted call did not resolve within 20 s');
    assert.equal(r.aborted, true);
    assert.equal(r.killedByWatchdog, false, 'an abort is not a watchdog kill');
    assert.notEqual(r.code, 0);
    await pause(500);
    const s1 = statSync(hb).size;
    await pause(1_000);
    const s2 = statSync(hb).size;
    assert.equal(s2, s1, 'heartbeat file kept growing: a grandchild survived the abort');
  } finally {
    await cleanup();
  }
});

test('an abort before the spawn starts nothing; ref-updating plumbing ignores it; a call that finished is never aborted', async () => {
  const { root, cleanup } = await makeTempRoot('runner-abort-pre');
  try {
    const repo = await initRepo(root, 'r');
    const marker = join(root, 'ran.txt');
    const writer = join(root, 'writer.cjs');
    await writeFile(writer, Buffer.from(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`, 'utf8'));
    const git = testRunner();
    const set = await git.run(['config', 'alias.mark', `!node ${shq(writer)}`], { class: 'local', cwd: repo });
    assert.equal(set.code, 0, set.stderr.toString('utf8'));

    const gone = new AbortController();
    gone.abort();
    const r = await git.run(['mark'], { class: 'local', cwd: repo, abort: gone.signal });
    assert.deepEqual({ aborted: r.aborted, killed: r.killedByWatchdog, code: r.code }, { aborted: true, killed: false, code: -1 });
    assert.equal(existsSync(marker), false, 'no git process was started');

    // update-ref is never killed (glossary §18), so an abort does not touch it either.
    const blob = await git.run(['hash-object', '-w', '--stdin'], { class: 'local', cwd: repo, stdin: Buffer.from('x\n') });
    const oid = blob.stdout.toString('utf8').trim();
    const ref = await git.run(['update-ref', 'refs/cowork-test/blob', oid], { class: 'refupdate', cwd: repo, abort: gone.signal });
    assert.deepEqual({ aborted: ref.aborted, code: ref.code }, { aborted: false, code: 0 }, ref.stderr.toString('utf8'));
    const read = await git.run(['rev-parse', '--verify', 'refs/cowork-test/blob'], { class: 'local', cwd: repo });
    assert.equal(read.stdout.toString('utf8').trim(), oid);

    // A signal that never fires, or fires after the call finished, changes nothing.
    const late = new AbortController();
    const ok = await git.run(['mark'], { class: 'local', cwd: repo, abort: late.signal });
    late.abort();
    assert.deepEqual({ aborted: ok.aborted, code: ok.code }, { aborted: false, code: 0 });
    assert.equal(existsSync(marker), true);
  } finally {
    await cleanup();
  }
});
