// Command hook: records PRESENCE of messaging env vars + socket path (never the token value).
// usage: node hook_env.js <tag> [--token-out]
// --token-out also writes the token to out/secret/token.txt for the test script (deleted after the run).
const fs = require('fs'), path = require('path');
const tag = process.argv[2] || 'hook';
const dir = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'out');
fs.mkdirSync(dir, { recursive: true });
let input = '';
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () => {
  let ev = {};
  try { ev = JSON.parse(input); } catch {}
  const e = process.env;
  const rec = {
    t_ms: Date.now(), pid: process.pid, event: ev.hook_event_name, source: ev.source,
    has_MESSAGING_SOCKET: 'CLAUDE_CODE_MESSAGING_SOCKET' in e,
    MESSAGING_SOCKET: e.CLAUDE_CODE_MESSAGING_SOCKET || null,
    has_MESSAGING_TOKEN: 'CLAUDE_CODE_MESSAGING_TOKEN' in e,
    token_len: (e.CLAUDE_CODE_MESSAGING_TOKEN || '').length,
    has_CLAUDE_PROJECT_DIR: 'CLAUDE_PROJECT_DIR' in e,
    has_CLAUDE_PLUGIN_DATA: 'CLAUDE_PLUGIN_DATA' in e,
    session_id: ev.session_id,
    prompt_id: ev.prompt_id,
    input_keys: Object.keys(ev).sort(),
    prompt_head: typeof ev.prompt === 'string' ? ev.prompt.slice(0, 400) : undefined,
  };
  fs.appendFileSync(path.join(dir, `${tag}.jsonl`), JSON.stringify(rec) + '\n');
  if (process.argv.includes('--token-out') && e.CLAUDE_CODE_MESSAGING_TOKEN) {
    fs.mkdirSync(path.join(dir, 'secret'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'secret', 'token.txt'), e.CLAUDE_CODE_MESSAGING_TOKEN, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'secret', 'socket.txt'), e.CLAUDE_CODE_MESSAGING_SOCKET || '');
  }
  process.exit(0);
});
