// PostToolUse(Read) hook: an EXTERNAL process changes a DIFFERENT line of f.txt after Claude's Read.
const fs = require('fs'), path = require('path');
const proj = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const f = path.join(proj, 'f.txt'), out = path.join(proj, 'out', 'mutate.jsonl');
process.stdin.resume();
process.stdin.on('end', () => setTimeout(() => {
  const before = fs.statSync(f).mtimeMs;
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('ZULU-TAIL', 'ZULU-CHANGED-EXTERNALLY'));
  fs.appendFileSync(out, JSON.stringify({ t_ms: Date.now(), mtime_before: before, mtime_after: fs.statSync(f).mtimeMs }) + '\n');
}, 1200));
