// Tiny stdio MCP server (no deps). On start: records env PRESENCE (booleans + socket path only).
// Tool "hookprobe": records the call time (used as an mcp_tool hook target in q10).
// usage: node mcp_probe.js <outdir>
const fs = require('fs'), path = require('path');
const dir = process.argv[2] || path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'out');
fs.mkdirSync(dir, { recursive: true });
const e = process.env;
fs.appendFileSync(path.join(dir, 'mcp_env.jsonl'), JSON.stringify({
  t_ms: Date.now(), pid: process.pid, cwd: process.cwd(),
  has_MESSAGING_SOCKET: 'CLAUDE_CODE_MESSAGING_SOCKET' in e,
  MESSAGING_SOCKET: e.CLAUDE_CODE_MESSAGING_SOCKET || null,
  has_MESSAGING_TOKEN: 'CLAUDE_CODE_MESSAGING_TOKEN' in e,
  token_len: (e.CLAUDE_CODE_MESSAGING_TOKEN || '').length,
  has_CLAUDE_PROJECT_DIR: 'CLAUDE_PROJECT_DIR' in e,
  has_CLAUDE_PLUGIN_DATA: 'CLAUDE_PLUGIN_DATA' in e,
  claude_env_keys: Object.keys(e).filter(k => /^CLAUDE/i.test(k)).sort(),
}) + '\n');

const send = m => process.stdout.write(JSON.stringify(m) + '\n');
let buf = '';
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: {
        protocolVersion: m.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '0.0.1' } } });
    } else if (m.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [{
        name: 'hookprobe', description: 'records a timestamp',
        inputSchema: { type: 'object', properties: { file: { type: 'string' } } } }] } });
    } else if (m.method === 'tools/call') {
      fs.appendFileSync(path.join(dir, 'mcp_calls.jsonl'),
        JSON.stringify({ t_ms: Date.now(), name: m.params?.name, args: m.params?.arguments }) + '\n');
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{}' }] } });
    } else if (m.id !== undefined) {
      send({ jsonrpc: '2.0', id: m.id, result: {} });
    }
  }
});
