// run by the '!' preprocessing line of /probe: records start, waits 1.5 s, records end.
// (the 1.5 s gap makes the ordering vs. the UserPromptSubmit hook unambiguous despite process-spawn overhead)
const fs = require('fs'), path = require('path');
const f = path.join(process.argv[2], 'order.jsonl');
fs.appendFileSync(f, JSON.stringify({ kind: 'bang_start', t_ms: Date.now() }) + '\n');
setTimeout(() => {
  fs.appendFileSync(f, JSON.stringify({ kind: 'bang_end', t_ms: Date.now() }) + '\n');
  console.log('BANG-RAN');
}, 1500);
