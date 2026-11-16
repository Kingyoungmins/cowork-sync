// A4-10 host check (R5-47): what a plugin's SessionStart hook sees. Writes paths only (no other variable, no prompt) and prints nothing.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const out = { root: process.env.CLAUDE_PLUGIN_ROOT ?? null, data: process.env.CLAUDE_PLUGIN_DATA ?? null };
writeFileSync(join(tmpdir(), 'cowork-plugin-data-probe.json'), `${JSON.stringify(out)}\n`);
