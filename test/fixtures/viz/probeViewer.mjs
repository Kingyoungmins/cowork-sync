// A probe that stands in for dist/viz.js in the Task 11 tests (spawn handshake, T-VIZ-env, the CLI modes).
// It records its environment, cwd and argv into <--data-dir>/probe.json, then answers per COWORK_PROBE_MODE (a test sets it on
// ViewerArgs.env; through runView the builder environment drops it, so the default applies):
//   ready (default)    a valid ready line {"v":1,"port":41234,"launch":<64 hex>}, then exit
//   refuse:<code>[:n]  a refusal ready line, then exit
//   sleep              a grandchild, then nothing for 6 s, then a valid line
//   malformed          a grandchild, then a schema-invalid line, then stays alive
//   oversized          a grandchild, then a 600-byte line, then stays alive
//   garbage            a grandchild, then non-JSON bytes, then stays alive
//   trickle            a grandchild, then 300 bytes without a LF, 300 more 200 ms later, then stays alive (the streaming cap)
//   group-children     a grandchild in its own process group (as the viewer runs git), then a malformed line; on SIGTERM it kills
//                      the grandchild and exits (what the viewer does for its git children), so the tree is gone only after a SIGTERM
//   stubborn           a grandchild, then a malformed line; ignores SIGTERM (only the escalation to SIGKILL ends it)
//   orphan             a grandchild (POSIX: in the probe's process group), then exit 3 without a line: the leader is gone before
//                      the CLI judges, and only a kill of the group reaches the grandchild
//   exit               exit 3 without a line
//   oom                a valid ready line, then JS heap allocations until V8 ends the process with its fatal "heap out of memory"
//                      (under the --max-old-space-size viewerArgv puts before the script), as a viewer over too many rooms would
// The probe and its grandchild end on their own once the data directory is gone (the test's cleanup removes it) or after 60 s
// (test/helpers/selfExit.ts, L-PID-KILL: tests never kill them by pid); both leave the data directory as their cwd first, which
// on Windows would block its removal (for node's own directory: the probe's environment may name no TEMP).
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const at = argv.indexOf('--data-dir');
const dataDir = at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : process.cwd();
const mode = process.env.COWORK_PROBE_MODE ?? 'ready';
const LAUNCH = '0123456789abcdef'.repeat(4);
const VALID = `{"v":1,"port":41234,"launch":"${LAUNCH}"}\n`;
const MALFORMED = '{"v":1,"port":"41234","launch":"x"}\n';
const HELPER_MAX_MS = 60_000;
const AWAY = dirname(process.execPath);

// The grandchild must outlive a kill of the probe alone, or "the whole tree is gone" proves nothing: on Windows libuv puts a
// non-detached child into a kill-on-close job object, so it is detached there (taskkill /T still finds it by its parent pid); on
// POSIX it stays in the probe's process group, except in group-children.
let grandchild = null;
if (['sleep', 'malformed', 'oversized', 'garbage', 'trickle', 'group-children', 'stubborn', 'orphan'].includes(mode)) {
  const detached = process.platform === 'win32' || mode === 'group-children';
  const lives = `const d = ${JSON.stringify(dataDir)}, born = Date.now();\n`
    + `setInterval(() => { if (!require('fs').existsSync(d) || Date.now() - born > ${HELPER_MAX_MS}) process.exit(0); }, 50);\n`;
  const g = spawn(process.execPath, ['-e', lives], { stdio: 'ignore', windowsHide: true, detached, cwd: AWAY });
  grandchild = g.pid ?? null;
  if (mode === 'group-children') {
    process.on('SIGTERM', () => {
      try { g.kill('SIGKILL'); } catch { /* gone */ }   // the held handle, never the bare pid
      process.exit(0);
    });
  }
}
if (mode === 'stubborn') process.on('SIGTERM', () => {});
writeFileSync(join(dataDir, 'probe.json'), JSON.stringify({ env: { ...process.env }, cwd: process.cwd(), argv, pid: process.pid, grandchild }));
// The cwd is recorded above; from here on the probe ends on its own as well.
process.chdir(AWAY);
{
  const born = Date.now();
  setInterval(() => { if (!existsSync(dataDir) || Date.now() - born > HELPER_MAX_MS) process.exit(0); }, 50).unref();
}

const stay = () => setInterval(() => {}, 1000);
if (mode === 'ready') {
  process.stdout.write(VALID);
} else if (mode.startsWith('refuse:')) {
  const [, code, line] = mode.split(':');
  process.stdout.write(line === undefined ? `{"v":1,"refuse":"${code}"}\n` : `{"v":1,"refuse":"${code}","line":${line}}\n`);
} else if (mode === 'sleep') {
  setTimeout(() => { process.stdout.write(VALID); stay(); }, 6_000);
} else if (mode === 'malformed' || mode === 'group-children' || mode === 'stubborn') {
  process.stdout.write(MALFORMED);
  stay();
} else if (mode === 'oversized') {
  process.stdout.write(`{"v":1,"port":41234,"launch":"${LAUNCH}","pad":"${'x'.repeat(520)}"}\n`);
  stay();
} else if (mode === 'trickle') {
  process.stdout.write(`{"v":1,"pad":"${'x'.repeat(286)}`);
  setTimeout(() => process.stdout.write('x'.repeat(300)), 200);
  stay();
} else if (mode === 'garbage') {
  process.stdout.write('ready!\n');
  stay();
} else if (mode === 'exit' || mode === 'orphan') {
  process.exit(3);
} else if (mode === 'oom') {
  // Small arrays of fresh objects: old-space (not off-heap Buffer) memory, kept alive until V8 gives up.
  process.stdout.write(VALID, () => {
    const keep = [];
    const fill = () => {
      for (let i = 0; i < 2_000; i++) keep.push(Array.from({ length: 64 }, (_, j) => ({ i, j })));
      setImmediate(fill);
    };
    fill();
  });
}
