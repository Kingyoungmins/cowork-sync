// Generic hook recorder: time, event, input keys, prompt_id, prompt head, tool/command head -> out/order.jsonl
// usage: node hook_rec.js <name>
const fs = require('fs'), path = require('path');
const t = Date.now(); let s = '';
process.stdin.on('data', d => (s += d));
process.stdin.on('end', () => {
  let ev = {}; try { ev = JSON.parse(s); } catch {}
  fs.appendFileSync(path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'out', 'order.jsonl'), JSON.stringify({
    kind: process.argv[2], t_ms: t, event: ev.hook_event_name, input_keys: Object.keys(ev).sort(),
    prompt_id: ev.prompt_id, prompt: typeof ev.prompt === 'string' ? ev.prompt.slice(0, 300) : undefined,
    tool_name: ev.tool_name, command: ev.tool_input?.command?.slice(0, 200),
    expansion: Object.fromEntries(Object.entries(ev).filter(([k]) => /expan|command_name|args|source/i.test(k)).map(([k, v]) => [k, String(v).slice(0, 200)])),
  }) + '\n');
});
