// daemon.js <repoDir> <origFile> <durationMs> <outJsonl> <gitExe>
// Every 2.5 s (fixed cadence, overrun -> skip slot): snapshot with a persistent private index
//   GIT_INDEX_FILE=.git/cowork/index git add -A ; git write-tree
// Every 4th tick (10 s), after that tick's snapshot: one apply of a modified version through a verifying writer,
// alternating two modes:
//   twophase  : 01-engine §3.11 shape - compare disk to snapshot blob, write tmp/<n>.new, lstat check,
//               rename p -> tmp/<n>.old, lstat(.old)==st0, fs.link(.new, p), unlink .new, .old kept >= 2 s (ring)
//   renameover: compare, write tmp/<n>.new, lstat check, rename .new over p (MoveFileExW REPLACE_EXISTING)
// Mismatch handling (per spec): re-snapshot p (git add -- p ; cat-file blob :p) and re-compare, <= 3 retries,
// then DEFERRED(mismatch). Rename EBUSY/EPERM/EACCES -> DEFERRED(locked). link EEXIST -> race.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { version, logger, errInfo, now, sleep } = require('./common');
const [repo, origFile, durationMs, out, gitExe, snapMode] = process.argv.slice(2);
// snapMode 'staged' = ENG-27 remedy: copy the bytes to .git/cowork/stage/ with a plain read, add with --work-tree=<stage>
const stageDir = path.join(repo, '.git', 'cowork', 'stage');
const P = 'hub.py';
const p = path.join(repo, P);
const tmpDir = path.join(repo, '.git', 'cowork', 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const env = { ...process.env, GIT_INDEX_FILE: path.join(repo, '.git', 'cowork', 'index'), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const orig = fs.readFileSync(origFile);
const log = logger(out);

function git(args) {
  const t0 = now();
  const r = spawnSync(gitExe, args, { cwd: repo, env, maxBuffer: 64 << 20 });
  return { rc: r.status, ms: now() - t0, out: r.stdout, stderr: r.stderr ? r.stderr.toString().trim().slice(0, 400) : '' };
}
const lf = (b) => Buffer.from(b.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
const sameStat = (a, b) => a.size === b.size && a.mtimeNs === b.mtimeNs && a.ino === b.ino;
const lstat = (f) => fs.lstatSync(f, { bigint: true });

let n = 0; let applySeq = 0;
const ring = [];

function apply(mode, tree) {
  const t0 = now(); applySeq++; const rec = { kind: 'apply', t: Date.now(), seq: applySeq, mode, attempts: 0, events: [] };
  let g = git(['cat-file', 'blob', `${tree}:${P}`]);
  let expected = g.out; rec.events.push(`blob:${g.rc}`);
  const target = version(orig, 'd0', applySeq, mode);
  const done = (outcome, extra) => Object.assign(rec, { outcome, ms: now() - t0 }, extra || {});
  for (let attempt = 1; attempt <= 4; attempt++) {
    rec.attempts = attempt;
    let stA, disk;
    try { stA = lstat(p); disk = fs.readFileSync(p); } catch (e) { rec.events.push('read:' + e.code); return done('read_error', { err: errInfo(e) }); }
    let eq = g.rc === 0 && lf(disk).equals(expected);
    let st0 = null;
    if (eq) { st0 = lstat(p); if (!sameStat(st0, stA)) { eq = false; rec.events.push('stat_changed_before_write'); } }
    if (!eq) {
      rec.events.push('mismatch');
      if (attempt === 4) return done('deferred_mismatch');
      const a = git(['add', '--', P]); g = git(['cat-file', 'blob', `:${P}`]); expected = g.out; // re-snapshot p
      rec.events.push(`resnap:${a.rc}/${g.rc}`);
      continue;
    }
    n++; const newF = path.join(tmpDir, `${n}.new`); const oldF = path.join(tmpDir, `${n}.old`);
    fs.writeFileSync(newF, target);
    if (mode === 'renameover') {
      try { fs.renameSync(newF, p); } catch (e) { try { fs.unlinkSync(newF); } catch (_) {} return done('deferred_locked', { err: errInfo(e) }); }
      return done('ok');
    }
    try { fs.renameSync(p, oldF); } catch (e) { try { fs.unlinkSync(newF); } catch (_) {} return done('deferred_locked', { err: errInfo(e) }); }
    const stOld = lstat(oldF);
    if (!sameStat(stOld, st0)) { // written between lstat and rename: put it back
      try { fs.linkSync(oldF, p); } catch (e) { rec.events.push('rollback_link:' + e.code); }
      try { fs.unlinkSync(newF); } catch (_) {}
      ring.push({ f: oldF, st: stOld, t: now() });
      return done('rolled_back_stat');
    }
    try { fs.linkSync(newF, p); } catch (e) {
      try { fs.unlinkSync(newF); } catch (_) {}
      ring.push({ f: oldF, st: stOld, t: now() });
      return done(e.code === 'EEXIST' ? 'race_eexist' : 'link_error', { err: errInfo(e) });
    }
    try { fs.unlinkSync(newF); } catch (_) {}
    ring.push({ f: oldF, st: stOld, t: now() });
    return done('ok');
  }
}

function checkRing(force) {
  while (ring.length && (force || now() - ring[0].t >= 2000)) {
    const r = ring.shift(); const rec = { kind: 'ring', t: Date.now(), f: path.basename(r.f) };
    try { rec.late_write = !sameStat(lstat(r.f), r.st); } catch (e) { rec.err = errInfo(e); }
    try { fs.unlinkSync(r.f); } catch (e) { rec.unlink_err = errInfo(e); }
    log(rec);
  }
}

(async () => {
  const start = now(); const end = start + Number(durationMs); let tick = 0;
  log({ kind: 'start', t: Date.now(), pid: process.pid });
  while (true) {
    const slot = start + tick * 2500;
    if (slot >= end) break;
    if (now() < slot) await sleep(slot - now());
    const lateMs = now() - slot;
    const t0 = now();
    let add;
    if (snapMode === 'staged') {
      let readErr = null;
      try { fs.mkdirSync(stageDir, { recursive: true }); fs.writeFileSync(path.join(stageDir, P), fs.readFileSync(p)); } catch (e) { readErr = errInfo(e); }
      add = git(['--git-dir=' + path.join(repo, '.git'), '--work-tree=' + stageDir, 'add', '-A']);
      if (readErr) add.stderr = 'stage_copy:' + readErr.code;
    } else add = git(['add', '-A']);
    const wt = git(['write-tree']);
    const tree = wt.out ? wt.out.toString().trim() : '';
    log({ kind: 'snap', t: Date.now(), tick, lateMs, ms: now() - t0,
      add: { rc: add.rc, ms: add.ms, stderr: add.stderr }, wt: { rc: wt.rc, ms: wt.ms, stderr: wt.stderr }, tree });
    if (tick % 4 === 3 && wt.rc === 0) log(apply(applySeq % 2 === 0 ? 'twophase' : 'renameover', tree));
    checkRing(false);
    tick++;
    while (start + tick * 2500 < now()) { log({ kind: 'skip', tick }); tick++; }
  }
  await sleep(2100); checkRing(true);
  log({ kind: 'end', t: Date.now(), cpu: process.cpuUsage(), wallMs: now() - start });
})();
