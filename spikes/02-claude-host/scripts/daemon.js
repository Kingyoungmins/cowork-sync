// detached daemon: appends a heartbeat every 2 s for 60 s. usage: node daemon.js <heartbeat-file>
const fs = require('fs');
const f = process.argv[2]; let n = 0;
const beat = () => fs.appendFileSync(f, JSON.stringify({ t_ms: Date.now(), pid: process.pid, ppid: process.ppid, n: n++ }) + '\n');
beat();
const iv = setInterval(() => { beat(); if (n > 30) { clearInterval(iv); process.exit(0); } }, 2000);
