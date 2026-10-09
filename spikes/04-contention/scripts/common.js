// Shared helpers for spike 04 (Windows file contention). No credentials anywhere.
'use strict';
const fs = require('fs');

// Fixed-width marker line appended to the pristine file, so every written version has the same length
// and a partial (torn) read shows up as a size mismatch.  Width: 40 bytes incl. CRLF.
function marker(who, seq, style) {
  const s = `# SPIKE04 ${who.padEnd(3)} ${String(seq).padStart(8, '0')} ${style.padEnd(8)}`;
  return Buffer.from(s.padEnd(38, '.') + '\r\n', 'latin1');
}
function version(orig, who, seq, style) { return Buffer.concat([orig, marker(who, seq, style)]); }

// xorshift32, seeded, so runs are reproducible from the logged seed
function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

function logger(file) {
  const fd = fs.openSync(file, 'a');
  return (obj) => fs.writeSync(fd, JSON.stringify(obj) + '\n');
}
function errInfo(e) { return { code: e.code, errno: e.errno, syscall: e.syscall, message: String(e.message).slice(0, 300) }; }
const now = () => Number(process.hrtime.bigint()) / 1e6; // monotonic ms
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

module.exports = { marker, version, rng, logger, errInfo, now, sleep };
