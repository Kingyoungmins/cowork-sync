// Plan 5 Task 4: markers, the paused path and evidence (R1-205, R1-206, R1-208, R2-J1, CCI-08, CCI-54; 06 test 4, TC-CCI-02, R5-38, SEC-25 step 1, SEC-26,
// 09 test 8 loader half, glossary §25 F5). The bundled loader of a test-form build; `sha256hex(s)` is the lowercase hex SHA-256 of the UTF-8 string.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LOADER_TEXTS } from '../../src/claude/text/claudeText.js';
import { evidenceFor, evidenceTag, normArgs, parseHookInput } from '../../src/claude/wire/hookInput.js';
import type { EvidenceRecord } from '../../src/claude/wire/frames.js';
import { canonicalJsonLine } from '../../src/claude/wire/ndjson.js';
import { fakeDaemon, type FakeDaemon } from '../helpers/fakeDaemon.js';
import { buildDist, copyDist, hookJson, loaderRepo, preToolJson, runLoader, type LoaderRepo } from '../helpers/loaderRun.js';

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const PAUSED_EN = 'cowork-sync is paused for this repo by the user; edits are not coordinated.';
const PAUSED_KO = '\u{C774} \u{C800}\u{C7A5}\u{C18C}\u{C758} cowork-sync \u{B294} \u{C0AC}\u{C6A9}\u{C790}\u{AC00} \u{C77C}\u{C2DC} \u{C911}\u{C9C0}\u{D588}\u{C2B5}\u{B2C8}\u{B2E4}. \u{D3B8}\u{C9D1}\u{C740} \u{C870}\u{C728}\u{B418}\u{C9C0} \u{C54A}\u{C2B5}\u{B2C8}\u{B2E4}.';

let build = '';
let dist = '';
let noCore = '';
let cleanups: Array<() => Promise<void>> = [];
before(async () => {
  const holder = await loaderRepo({ label: 'loader-markers-build' });
  cleanups.push(holder.cleanup);
  build = holder.base;
  dist = buildDist(join(build, 'build'));
  noCore = copyDist(dist, join(build, 'no-core'));
  rmSync(join(noCore, 'core.js'));
});
after(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function repoFor(label: string, o: Omit<Parameters<typeof loaderRepo>[0], 'label'> = {}): Promise<LoaderRepo> {
  const r = await loaderRepo({ label, ...o });
  cleanups.push(r.cleanup);
  return r;
}

const evidencePath = (r: LoaderRepo): string => join(r.gitdir, 'cowork', 'tmp', 'evidence.jsonl');
const evidenceLines = (r: LoaderRepo): string[] => (existsSync(evidencePath(r)) ? readFileSync(evidencePath(r), 'utf8').split('\n').filter((l) => l !== '') : []);
const pausedOn = (r: LoaderRepo): boolean => existsSync(join(r.gitdir, 'cowork', 'paused'));

function upe(r: LoaderRepo, args: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return hookJson('UserPromptExpansion', r.dir, { prompt: `/cowork ${args}`, command_args: args, ...extra });
}

/** The evidence line's record as the loader must have written it (09 §2): tagged with evidenceTag over the untagged record when a key exists. */
function checkLine(r: LoaderRepo, line: string, verb: string, args: string): Record<string, unknown> {
  const o = JSON.parse(line) as Record<string, unknown>;
  assert.equal(line, canonicalJsonLine(o as never), 'one canonical JSON line');
  const keys = r.key === null ? ['args_sha256', 'mono_ns', 'prompt_id', 'seat_key', 'used', 'verb'] : ['args_sha256', 'mono_ns', 'prompt_id', 'seat_key', 'tag', 'used', 'verb'];
  assert.deepEqual(Object.keys(o).sort(), keys);
  assert.equal(o['verb'], verb);
  assert.equal(o['args_sha256'], normArgs(`${verb} ${args}`).argsSha256);
  assert.equal(o['used'], false);
  assert.equal(o['prompt_id'], 'p1');
  assert.equal(o['seat_key'], String(process.pid), 'no socket variable: the pid seat key of the hook\'s parent (this process)');
  assert.match(String(o['mono_ns']), /^[1-9][0-9]*$/);
  if (r.key !== null) {
    const { tag, ...rec } = o;
    assert.equal(tag, evidenceTag(r.key, rec as unknown as EvidenceRecord));
  }
  return o;
}

test('UserPromptExpansion pause/resume create and remove <gitdir>/cowork/paused with core.js deleted; an acting verb writes one HMAC-tagged evidence.jsonl line with args_sha256 only; a cws- nonce in the prompt writes none', async () => {
  const r = await repoFor('loader-markers', { live: true });
  const run = async (json: Record<string, unknown>): Promise<void> => {
    const res = await runLoader('UserPromptExpansion', json, { dist: noCore, cwd: r.dir, env: r.env });
    assert.equal(res.exit, 0, res.stderr);
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, '');
  };
  await run(upe(r, 'pause'));
  assert.ok(pausedOn(r), 'pause creates the marker');
  await run(upe(r, 'pause'));
  assert.ok(pausedOn(r), 'pause again: still there (idempotent)');
  await run(upe(r, 'resume'));
  assert.ok(!pausedOn(r), 'resume removes it');
  await run(upe(r, 'pause', { command_name: 'cowork-sync:cowork' }));
  assert.ok(pausedOn(r), 'cowork-sync:cowork pause');
  await run(upe(r, 'resume', { command_name: 'cowork-sync:cowork' }));
  assert.ok(!pausedOn(r), 'cowork-sync:cowork resume');
  await run(upe(r, 'pause', { command_name: 'other' }));
  assert.ok(!pausedOn(r), 'another command changes nothing');
  await run(upe(r, 'pause', { expansion_type: 'prompt' }));
  assert.ok(!pausedOn(r), 'a prompt expansion changes nothing');
  r.setPaused(true);
  await run(upe(r, 'resume', { command_name: 'other' }));
  assert.ok(pausedOn(r), 'another command removes nothing');
  r.setPaused(false);

  const before = evidenceLines(r);
  await run(upe(r, 'save "COWORK_CANARY_SUMMARY"'));
  const lines = evidenceLines(r);
  assert.equal(lines.length, before.length + 1, 'exactly one line');
  const o = checkLine(r, lines[lines.length - 1]!, 'save', '"COWORK_CANARY_SUMMARY"');
  assert.equal(o['args_sha256'], sha256hex('"COWORK_CANARY_SUMMARY"'));
  assert.equal(readFileSync(evidencePath(r), 'utf8').split('COWORK_CANARY_SUMMARY').length - 1, 0, 'the canary occurs 0 times in the file');

  const n = evidenceLines(r).length;
  await run(upe(r, 'save "y"', { prompt: '/cowork save "y" cws-0123456789abcdef' }));
  assert.equal(evidenceLines(r).length, n, 'a cws- nonce in the prompt: no line');
});

test('paused: SessionStart and UserPromptSubmit print exactly the PAUSED line, other events nothing', async () => {
  assert.equal(LOADER_TEXTS.PAUSED.en, PAUSED_EN);
  assert.equal(LOADER_TEXTS.PAUSED.ko, PAUSED_KO);
  const r = await repoFor('loader-paused', { live: true, paused: true });
  const daemon: FakeDaemon = await fakeDaemon(r.endpoint as string, r.key as Buffer);
  try {
    for (const [lang, text] of [['en', PAUSED_EN], ['ko', PAUSED_KO]] as const) {
      r.setLanguage(lang);
      for (const event of ['SessionStart', 'UserPromptSubmit'] as const) {
        const res = await runLoader(event, hookJson(event, r.dir), { dist, cwd: r.dir, env: r.env });
        assert.equal(res.exit, 0, res.stderr);
        assert.equal(res.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }), `${lang} ${event}`);
        assert.equal(res.stderr, '');
      }
    }
    r.setLanguage('en');
    const quiet: Array<[string, Record<string, unknown>]> = [
      ['PreToolUse', preToolJson('Edit', r.dir)], ['PostToolUse', hookJson('PostToolUse', r.dir)], ['Stop', hookJson('Stop', r.dir)],
      ['SessionEnd', hookJson('SessionEnd', r.dir)], ['Notification', hookJson('Notification', r.dir)],
    ];
    for (const [event, json] of quiet) {
      const res = await runLoader(event, json, { dist, cwd: r.dir, env: r.env });
      assert.equal(res.exit, 0, `${event}: ${res.stderr}`);
      assert.equal(res.stdout, '', event);
      assert.equal(res.stderr, '', event);
    }
    const before = evidenceLines(r).length;
    const res = await runLoader('UserPromptExpansion', upe(r, 'save "p"'), { dist, cwd: r.dir, env: r.env });
    assert.equal(res.exit, 0);
    assert.equal(res.stdout + res.stderr, '');
    const lines = evidenceLines(r);
    assert.equal(lines.length, before + 1, 'an acting verb in the paused repo still writes its line');
    checkLine(r, lines[lines.length - 1]!, 'save', '"p"');
    assert.equal(daemon.connections(), 0, 'no IPC in a paused repo');
  } finally {
    await daemon.close();
  }
});

test('evidence rides the UserPromptExpansion request when the daemon answers, and the loader appends it when it does not', async () => {
  const r = await repoFor('loader-evidence', { live: true });
  const daemon = await fakeDaemon(r.endpoint as string, r.key as Buffer);
  try {
    // Live, the daemon answering {decision: 'none'}: the record rides the frame and the file is unchanged.
    const input = upe(r, 'save "x"');
    const t0 = process.hrtime.bigint();
    const res = await runLoader('UserPromptExpansion', input, { dist, cwd: r.dir, env: r.env });
    const t1 = process.hrtime.bigint();
    assert.equal(res.exit, 0, res.stderr);
    assert.equal(res.stdout + res.stderr, '');
    const hooks = daemon.frames().filter((f) => f.frame['t'] === 'hook');
    assert.equal(hooks.length, 1);
    const payload = hooks[0]!.frame['payload'] as Record<string, unknown>;
    // <the record>, built here from the input with Task 1's evidenceFor: the pid seat key of the hook's parent (this process) and the loader's start
    // time, which must be a machine-monotonic ns reading taken during the run (the same clock in every process).
    const monoNs = (payload['evidence'] as { mono_ns?: unknown } | null)?.mono_ns;
    assert.ok(typeof monoNs === 'string' && /^\d+$/.test(monoNs) && BigInt(monoNs) >= t0 && BigInt(monoNs) <= t1, `mono_ns ${String(monoNs)} within the run [${t0}, ${t1}]`);
    const record = evidenceFor(parseHookInput('UserPromptExpansion', input), String(process.pid), BigInt(monoNs));
    assert.deepEqual(record, { seat_key: String(process.pid), prompt_id: 'p1', verb: 'save', args_sha256: sha256hex('"x"'), mono_ns: monoNs, used: false });
    assert.deepEqual(payload, { event: 'UserPromptExpansion', command_name: 'cowork', verb: 'save', command_source: 'plugin', args_sha256: sha256hex('"x"'), nonces: [], evidence: record });
    assert.equal(evidenceLines(r).length, 0, 'delivered: evidence.jsonl unchanged');
    assert.ok(!('ancestry_has_claude' in (hooks[0]!.frame['h'] as object)) && !('ancestry_has_claude' in payload), 'the loader computes no ancestry_has_claude');

    // Live, the daemon stalling: exit 0 after the deadline with no output, and the loader appends the line.
    daemon.stall(30_000);
    const stalled = await runLoader('UserPromptExpansion', upe(r, 'save "x"'), { dist, cwd: r.dir, env: r.env });
    assert.equal(stalled.exit, 0);
    assert.equal(stalled.stdout + stalled.stderr, '');
    assert.ok(stalled.elapsedMs >= 1_450, `exited after the deadline (${stalled.elapsedMs} ms)`);
    const afterStall = evidenceLines(r);
    assert.equal(afterStall.length, 1);
    checkLine(r, afterStall[0]!, 'save', '"x"');
    daemon.stall(0);

    // Non-live: the line.
    r.setLive(false);
    const nonlive = await runLoader('UserPromptExpansion', upe(r, 'save "x"'), { dist, cwd: r.dir, env: r.env });
    assert.equal(nonlive.exit, 0);
    assert.equal(evidenceLines(r).length, 2);
    r.setLive(true);

    // The read-only `status --flow`: verb status, args_sha256 of its normal form, no evidence, no line. The brief writes sha256hex('--flow'); the
    // contract's normArgs (§Interfaces, SEC-25 as ruled by X-60) JSON-quotes every further word ('"fix the bug" "--sign"'), as the brief's own
    // save "x" cells do (sha256hex('"x"')), so the hash is sha256hex('"--flow"').
    const flow = await runLoader('UserPromptExpansion', upe(r, 'status --flow'), { dist, cwd: r.dir, env: r.env });
    assert.equal(flow.exit, 0);
    const last = daemon.frames().filter((f) => f.frame['t'] === 'hook').at(-1)!;
    const p2 = last.frame['payload'] as Record<string, unknown>;
    assert.equal(p2['verb'], 'status');
    assert.equal(p2['args_sha256'], normArgs('status --flow').argsSha256);
    assert.equal(p2['args_sha256'], sha256hex('"--flow"'), 'X-60: each further word JSON-quoted');
    assert.equal(p2['evidence'], null);
    assert.equal(evidenceLines(r).length, 2, 'no line for a read-only verb');
  } finally {
    await daemon.close();
  }

  // `/cowork start` in a non-live repo whose plugin data has no ipc.key: one untagged line.
  const bare = await repoFor('loader-evidence-nokey', { key: false });
  const start = await runLoader('UserPromptExpansion', upe(bare, 'start'), { dist, cwd: bare.dir, env: bare.env });
  assert.equal(start.exit, 0);
  const lines = evidenceLines(bare);
  assert.equal(lines.length, 1);
  const o = checkLine(bare, lines[0]!, 'start', '');
  assert.ok(!('tag' in o), 'untagged');
  assert.equal(o['args_sha256'], sha256hex(''));
});
