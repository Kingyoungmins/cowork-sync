// reader.js <file> <durationMs> <outJsonl>
// Holds a read handle on <file> with Node/libuv default sharing (FILE_SHARE_READ|WRITE|DELETE).
// Every 500 ms: if <file> was replaced (file id changed) close and reopen, so it always holds the current file;
// reads the content through the handle (like a viewer refreshing).
'use strict';
const fs = require('fs');
const { logger, errInfo, now, sleep } = require('./common');
const [file, durationMs, out] = process.argv.slice(2);
const log = logger(out);
(async () => {
  const end = now() + Number(durationMs); let fd = null; let reopens = 0, errors = 0, polls = 0;
  const buf = Buffer.alloc(2 << 20);
  while (now() < end) {
    polls++;
    try {
      if (fd === null || fs.fstatSync(fd, { bigint: true }).ino !== fs.statSync(file, { bigint: true }).ino) {
        if (fd !== null) fs.closeSync(fd);
        fd = null; fd = fs.openSync(file, 'r'); reopens++;
      }
      fs.readSync(fd, buf, 0, buf.length, 0);
    } catch (e) { errors++; if (errors <= 50) log({ kind: 'err', t: Date.now(), err: errInfo(e) }); }
    await sleep(500);
  }
  if (fd !== null) fs.closeSync(fd);
  log({ kind: 'end', polls, reopens, errors });
})();
