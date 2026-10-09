// editor.js <id> <file> <origFile> <durationMs> <outJsonl> <seed>
// Saves <file> every 1-4 s (uniform random), alternating two styles:
//   inplace: open('w') (CREATE_ALWAYS, truncates) -> write -> close
//   atomic : write <file>.tmp-e<id>-<seq> -> rename over <file>  (MoveFileExW REPLACE_EXISTING via libuv)
// No retries: the first attempt's outcome is what is counted.
'use strict';
const fs = require('fs');
const { version, rng, logger, errInfo, now, sleep } = require('./common');
const [id, file, origFile, durationMs, out, seed] = process.argv.slice(2);
const orig = fs.readFileSync(origFile);
const rand = rng(Number(seed));
const log = logger(out);

(async () => {
  const end = now() + Number(durationMs);
  let seq = 0;
  while (true) {
    await sleep(1000 + rand() * 3000);
    if (now() >= end) break;
    seq++;
    const style = (seq + Number(id)) % 2 === 0 ? 'inplace' : 'atomic';
    const buf = version(orig, 'e' + id, seq, style);
    const t0 = now(); const steps = {}; let step = 'start'; let fd = null; let tmp = null;
    const rec = { t: Date.now(), editor: Number(id), seq, style };
    try {
      if (style === 'inplace') {
        step = 'open'; fd = fs.openSync(file, 'w'); steps.open = now() - t0;
        step = 'write'; fs.writeSync(fd, buf, 0, buf.length, 0); steps.write = now() - t0;
        step = 'close'; fs.closeSync(fd); fd = null; steps.close = now() - t0;
      } else {
        tmp = `${file}.tmp-e${id}-${seq}`;
        step = 'tmpwrite'; fs.writeFileSync(tmp, buf); steps.tmpwrite = now() - t0;
        step = 'rename'; fs.renameSync(tmp, file); tmp = null; steps.rename = now() - t0;
      }
      rec.ok = true;
    } catch (e) {
      rec.ok = false; rec.step = step; rec.err = errInfo(e);
      if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
      if (tmp) try { fs.unlinkSync(tmp); } catch (_) {}
    }
    rec.ms = now() - t0; rec.steps = steps;
    log(rec);
  }
})();
