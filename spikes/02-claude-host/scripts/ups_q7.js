// UserPromptSubmit hook: records time + prompt text it received.
const fs = require('fs'), path = require('path');
const t = Date.now(); let s = '';
process.stdin.on('data', d => (s += d));
process.stdin.on('end', () => {
  let ev = {}; try { ev = JSON.parse(s); } catch {}
  fs.appendFileSync(path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'out', 'order.jsonl'),
    JSON.stringify({ kind: 'UserPromptSubmit', t_ms: t, prompt: ev.prompt, event: ev.hook_event_name }) + '\n');
});
