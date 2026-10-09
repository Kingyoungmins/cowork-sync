// PreToolUse(Write) command hook. Behaviour keyed off the file name:
// throw.txt -> uncaught exception (exit 1), exit2.txt -> exit 2, sleep.txt -> sleep 8 s (> timeout 3 s), else exit 0.
// usage: node hook_q10.js <pre|post>
const fs = require('fs'), path = require('path');
const t = Date.now(), up = Math.round(process.uptime() * 1000);
const out = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'out', 'q10_hook.jsonl');
const phase = process.argv[2] || 'pre';
let s = '';
process.stdin.on('data', d => (s += d));
process.stdin.on('end', () => {
  let ev = {}; try { ev = JSON.parse(s); } catch {}
  const file = path.basename(ev.tool_input?.file_path || '');
  const log = extra => fs.appendFileSync(out, JSON.stringify({ phase, file, t_start_ms: t, node_uptime_at_start_ms: up, t_ms: Date.now(), ...extra }) + '\n');
  log({ step: 'start' });
  if (phase !== 'pre') return;
  if (file === 'throw.txt') { log({ step: 'throwing' }); throw new Error('probe uncaught exception'); }
  if (file === 'exit2.txt') { log({ step: 'exit2' }); process.stderr.write('blocked by probe hook (exit 2)'); process.exit(2); }
  if (file === 'sleep.txt') { log({ step: 'sleeping' }); setTimeout(() => { log({ step: 'sleep_done' }); process.exit(0); }, 8000); return; }
  process.exit(0);
});
