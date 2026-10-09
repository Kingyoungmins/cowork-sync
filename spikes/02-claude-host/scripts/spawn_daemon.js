// SessionStart hook: spawns daemon.js detached (stdio ignore, windowsHide), unref, exits at once.
const { spawn } = require('child_process'), fs = require('fs'), path = require('path');
const out = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'out');
fs.mkdirSync(out, { recursive: true });
process.stdin.resume(); process.stdin.on('end', () => {});
const c = spawn(process.execPath, [path.join(__dirname, 'daemon.js'), path.join(out, 'heartbeat.jsonl')],
  { detached: true, stdio: 'ignore', windowsHide: true });
c.unref();
fs.appendFileSync(path.join(out, 'spawn_hook.jsonl'), JSON.stringify({ t_ms: Date.now(), hook_pid: process.pid, daemon_pid: c.pid }) + '\n');
setTimeout(() => process.exit(0), 50);
