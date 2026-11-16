// src/claude/client/hookCore.ts — dist/core.js, the per-hook core (06 §3.4.2 steps 1–6; CCI-09…CCI-11, R1-221…R1-224, R1-311; A4-3, A4-6…A4-9, A4-11,
// A4-14). The loader hands over a live, unpaused repo; core reads status.json (spawning the daemon when it is down), opens one authenticated session,
// sends exactly one hook frame, maps the reply through encodeOutput, flushes, sends printed{batch_id} and returns the exit code for the loader's
// process.exit. Client tier (L-HOOK-THIN): status.json is read as the wire's StatusHeartbeat, the mutant as ClientMutantId (A4-14).
import { createHash } from 'node:crypto';
import { join, posix, win32 } from 'node:path';
import { Deadline, openSession, request } from './ipcClient.js';
import { encodeOutput, type HookOutput } from './output.js';
import { staticPolicyCheck } from './policy.js';
import { copyRuntime, headBranch, realSpawner, spawnDaemon, type DaemonSpawner } from './spawn.js';
import { agentDefRoots, worktreeDenied } from './worktree.js';
import { claudeTemplateOf, loaderLang } from '../text/claudeText.js';
import { C } from '../wire/constants.js';
import { HOOK_PROTO, type EvidenceRecord, type HookEvent, type HookFrame, type HookHeader, type ReplyFrame, type StatusHeartbeat } from '../wire/frames.js';
import { buildPayload, gatingClass, parseHookInput, seatKeyOf, type HookInput } from '../wire/hookInput.js';
import { canonicalJsonLine } from '../wire/ndjson.js';
import { readUserJson } from '../wire/pluginData.js';
import { renderClaude, type ClaudeLang } from '../../i18n/claude.js';
import { canonRoot, endpointRoot, type LiveRepo, type RootProbe } from '../../data/canonRoot.js';
import { resolveDataDir } from '../../data/pluginDataDir.js';
import { machineMonoMs, realClock, type Clock } from '../../ports/clock.js';
import { realFs, realRootProbe, type Fs } from '../../ports/fs.js';
import { realIpc, type Ipc } from '../../ports/ipc.js';
import { realRandom, type Random } from '../../ports/random.js';
import type { HandshakeFailure } from '../../sec/handshake.js';
import { realWinAcl, type WinAcl } from '../../sec/winAcl.js';
import { PLUGIN_VERSION } from '../../version.js';

declare const __COWORK_TEST_BUILD__: boolean | undefined;
// P5-EC-4's guard, written at the seam: esbuild 0.24.2 folds `typeof __COWORK_TEST_BUILD__ === 'undefined' || __COWORK_TEST_BUILD__` to false under
// --release and drops the branch only where the expression itself stands (a module-level const of a module with imports stays a var, its seam kept).

/** A4-3: startNs is the loader's process.hrtime.bigint() at its first statement; Deadline starts at Number(startNs / 1_000_000n) on the same base as machineClock. */
export interface CoreEnv { env: Readonly<Record<string, string | undefined>>; ppid: number; pluginRoot: string; startNs: bigint; platform: NodeJS.Platform; home: string; osLocale: string | null; }
export interface CoreIo { stdout(s: string): void; stderr(s: string): void; flush(): Promise<void>; }
export interface CoreDeps { fs: Fs; ipc: Ipc; clock: Clock; random: Random; spawner: DaemonSpawner; acl: WinAcl; uid: number | null; probe: RootProbe; }
export interface CoreOutcome { exit: 0 | 2; evidenceDelivered: boolean; }

/** A4-3: core's production clock = realClock with monoMs = machineMonoMs (process.hrtime.bigint(), the base of the loader's startNs and of status.json). */
export const machineClock: Clock = { monoMs: machineMonoMs, wallMs: () => realClock.wallMs(), sleep: (ms) => realClock.sleep(ms) };

/** A4-6: the events whose output can carry the DAEMON_DOWN notice (PostToolUseFailure without its systemMessage, encodeOutput's rule). */
const NOTICE_EVENTS: ReadonlySet<HookEvent> = new Set(['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PostToolUse', 'PostToolUseFailure']);
const QUIET: CoreOutcome = Object.freeze({ exit: 0, evidenceDelivered: false });
/** How long one bounded wait sleeps before it checks again (an earlier settle ends it; no long timer outlives the hook in process). */
const POLL_MS = 50;

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** <gitdir>/cowork/status.json as the wire's StatusHeartbeat (one readFile: no handle held, W3); null when missing or not that shape. */
async function readStatus(fs: Fs, coworkDir: string): Promise<StatusHeartbeat | null> {
  try {
    const v: unknown = JSON.parse((await fs.readFile(join(coworkDir, 'status.json'))).toString('utf8'));
    if (!isRecord(v) || !Number.isFinite(v['heartbeat_mono_ms']) || !Number.isFinite(v['loop_period_ms'])) return null;
    return { heartbeat_mono_ms: v['heartbeat_mono_ms'] as number, loop_period_ms: v['loop_period_ms'] as number, state: typeof v['state'] === 'string' ? v['state'] : '' };
  } catch {
    return null;
  }
}

/** 06 §3.4.2 step 1 (and src/cli/statusText.ts's rule): down when missing, older than 3 loop periods, or ahead of now by more than a period (an earlier boot). */
const isDown = (s: StatusHeartbeat | null, now: number): boolean =>
  s === null || now - s.heartbeat_mono_ms > 3 * s.loop_period_ms || s.heartbeat_mono_ms > now + s.loop_period_ms;

/** Waits for p on the deadline's clock until the deadline at most. */
async function within(p: Promise<unknown>, deadline: Deadline): Promise<void> {
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  while (!settled && !deadline.expired()) await deadline.clock.sleep(Math.min(deadline.remainingMs(), POLL_MS));
}

/** SEC-22's client side for hooks (P5SEC #36): <gitdir>/cowork/tmp/handshake.jsonl, read by the daemon (Task 5 carry). */
const HANDSHAKE_RECORD = 'handshake.jsonl';
/** The record stops growing at 64 KiB (a squatter that answers every attempt for as long as no daemon drains it). */
const HANDSHAKE_RECORD_MAX_BYTES = 65_536;

/**
 * P5SEC #36: a hook has no security log (the daemon's is the one writer of security.jsonl, X-34), so the handshakes it saw fail are appended to
 * <coworkDir>/tmp/handshake.jsonl — one canonical line per reason, {code: 'SEC_IPC_HANDSHAKE_FAILED', count, mono_ms (machine clock, status.json's
 * base), side: 'hook', why} — for the daemon to move into its security log and HandshakeFailureRate. Best-effort; nothing is added to a record
 * that is not a regular file or holds 64 KiB already.
 */
async function recordHandshakeFailures(fs: Fs, coworkDir: string, whys: readonly HandshakeFailure[], monoMs: number): Promise<void> {
  const counts = new Map<HandshakeFailure, number>();
  for (const w of whys) counts.set(w, (counts.get(w) ?? 0) + 1);
  const text = [...counts].map(([why, count]) => `${canonicalJsonLine({ code: 'SEC_IPC_HANDSHAKE_FAILED', count, mono_ms: Math.floor(monoMs), side: 'hook', why })}\n`).join('');
  try {
    const dir = join(coworkDir, 'tmp');
    const p = join(dir, HANDSHAKE_RECORD);
    const st = await fs.lstat(p);
    if (st !== null && (st.isSymbolicLink || !st.isFile || st.size >= HANDSHAKE_RECORD_MAX_BYTES)) return;
    await fs.mkdirp(dir, 0o700);
    await fs.appendFile(p, Buffer.from(text, 'utf8'));
  } catch {
    // best-effort: the hook's answer never depends on its record
  }
}

/** A1-8: the canonical absolute target of an edit-class or Read call (tool_input.file_path, else notebook_path, against cwd); null otherwise. */
function targetOf(input: HookInput, platform: NodeJS.Platform, probe: RootProbe): string | null {
  const ti = input.tool_input;
  if (!isRecord(ti)) return null;
  const fp = typeof ti['file_path'] === 'string' ? ti['file_path'] : typeof ti['notebook_path'] === 'string' ? ti['notebook_path'] : null;
  if (fp === null) return null;
  return canonRoot((platform === 'win32' ? win32 : posix).resolve(input.cwd, fp), probe, platform);
}

/** Steps 1–6 with injected io and ports (the SIM fake seat calls this in process, R5-16). */
export async function runCore(event: HookEvent, input: HookInput, repo: LiveRepo, evidence: EvidenceRecord | null, env: CoreEnv, io: CoreIo, deps: CoreDeps): Promise<CoreOutcome> {
  const userText = repo.dataDir === '' ? null : await deps.fs.readFile(join(repo.dataDir, 'user.json')).then((b) => b.toString('utf8'), () => null);
  const prefs = readUserJson(userText);
  const lang: ClaudeLang = loaderLang(prefs.language, env.osLocale);
  const gating = event === 'PreToolUse';
  const deadline = new Deadline(deps.clock, Number(env.startNs / 1_000_000n), event === 'SessionStart' ? C.LOADER_DEADLINE_SESSION_START_MS : C.LOADER_DEADLINE_MS);
  const emit = async (out: HookOutput): Promise<0 | 2> => {
    io.stdout(out.stdout);
    io.stderr(out.stderr);
    await io.flush();
    return out.exit;
  };

  // A4-7: Agent|EnterWorktree are decided locally before any status.json read, without IPC, and never take G4 (06 §3.10).
  if (gatingClass(event, input.tool_name) === 'agent') {
    const denied = await worktreeDenied(input.tool_name as string, input.tool_input, await agentDefRoots(repo.root, env.home, deps.fs, env.env, env.platform), deps.fs);
    const out: HookOutput = denied ? { exit: 2, stdout: '', stderr: renderClaude('WORKTREE_DENY', {}, lang, 'deny') } : { exit: 0, stdout: '', stderr: '' };
    return { exit: await emit(out), evidenceDelivered: false };
  }

  // SessionStart: the runtime copy runs beside the request (A4-9) and the static policy read rides the payload (R2-B12).
  const copy = event === 'SessionStart' && repo.dataDir !== ''
    ? copyRuntime(env.pluginRoot, repo.dataDir, PLUGIN_VERSION, deps.fs, deps.random).catch(() => 'failed' as const) : null;
  const hits = event === 'SessionStart' ? await staticPolicyCheck(repo.root, { fs: deps.fs, platform: env.platform, home: env.home, env: env.env }) : [];
  const seatKey = seatKeyOf(env.env, env.ppid);
  const socket = env.env['CLAUDE_CODE_MESSAGING_SOCKET'];
  const payload = buildPayload(input, repo, {
    messaging_present: typeof socket === 'string' && socket !== '', static_policy_hits: hits, evidence, target: targetOf(input, env.platform, deps.probe),
  });
  const h: HookHeader = {
    seat_key: seatKey, claude_pid: env.ppid, session_id: input.session_id, prompt_id: input.prompt_id, agent_id: input.agent_id, agent_type: input.agent_type,
    permission_mode: input.permission_mode, repo_root: repo.root, plugin_version: PLUGIN_VERSION, hook_proto: HOOK_PROTO,
  };

  const failedHandshakes: HandshakeFailure[] = [];
  const outcome = await (async (): Promise<CoreOutcome> => {
    // (1) status.json: down (missing, stale) → spawn once before the first connect attempt; a detached HEAD spawns nothing (A4-8, R5-19).
    const status = await readStatus(deps.fs, repo.coworkDir);
    let reachable = true;
    if (isDown(status, deps.clock.monoMs())) {
      const branch = await headBranch(repo.gitdir, deps.fs);
      if (branch === null || repo.dataDir === '') {
        reachable = false;
      } else {
        await spawnDaemon({ repoRoot: repo.root, branch }, {
          fs: deps.fs, spawner: deps.spawner, env: env.env, pluginRoot: env.pluginRoot, dataDir: repo.dataDir, version: PLUGIN_VERSION, passthrough: prefs.envPassthrough,
        }).catch(() => {});
      }
    }
    // (2) the session (A4-5); unreachable: gating → G4, else the DAEMON_DOWN notice once per seat and outage (A4-6).
    const conn = reachable ? await openSession(repo, {
      fs: deps.fs, ipc: deps.ipc, random: deps.random, platform: env.platform, uid: deps.uid, acl: deps.acl, env: env.env,
      onHandshakeFail: (why) => { failedHandshakes.push(why); },
    }, deadline) : null;
    if (conn === null) {
      if (gating) return { exit: await emit(encodeOutput(event, { g4: true, lang })), evidenceDelivered: false };
      if (!NOTICE_EVENTS.has(event)) return QUIET;
      const episode = status === null ? 'missing' : String(status.heartbeat_mono_ms);
      const seen = join(repo.coworkDir, 'tmp', `seen-${(/^[0-9a-f]{64}$/.test(seatKey) ? seatKey : sha256hex(seatKey)).slice(0, 8)}`);
      if ((await deps.fs.readFile(seen).then((b) => b.toString('utf8'), () => null)) === episode) return QUIET;
      await deps.fs.mkdirp(join(repo.coworkDir, 'tmp'), 0o700).then(() => deps.fs.writeFile(seen, Buffer.from(episode, 'utf8'))).catch(() => {});
      const text = renderClaude(claudeTemplateOf('DAEMON_DOWN'), {}, lang);
      const notice: ReplyFrame = { t: 'reply', batch_id: '', decision: 'context', text, system: text, events: [], cursor: 0 };
      return { exit: await emit(encodeOutput(event, notice)), evidenceDelivered: false };
    }
    // (3)–(4) exactly one hook frame; frames until a reply (an extend raises the deadline once). A timeout or a closed connection after the handshake:
    // gating → G4, else nothing (the daemon was reachable, so no notice).
    const frame: HookFrame = { t: 'hook', event, h, payload };
    const reply = await request(conn, frame, deadline);
    if (reply === 'timeout' || reply.t !== 'reply') {
      conn.close();
      return gating ? { exit: await emit(encodeOutput(event, { g4: true, lang })), evidenceDelivered: false } : QUIET;
    }
    // (5) the output, flushed, then printed{batch_id} on the same connection (06 test 5); COWORK_TEST_KILL_BEFORE_PRINTED=1 (A4-11, test builds only)
    // stops right after the flush, as a hook killed there would.
    const exit = await emit(encodeOutput(event, reply));
    if (!((typeof __COWORK_TEST_BUILD__ === 'undefined' || __COWORK_TEST_BUILD__) && env.env['COWORK_TEST_KILL_BEFORE_PRINTED'] === '1')) conn.send({ t: 'printed', batch_id: reply.batch_id });
    conn.close();
    return { exit, evidenceDelivered: evidence !== null };
  })();
  // After the answer is out (it never waits for the record): the handshakes that failed, for the daemon's security log (P5SEC #36).
  if (failedHandshakes.length > 0) await recordHandshakeFailures(deps.fs, repo.coworkDir, failedHandshakes, deps.clock.monoMs());
  if (copy !== null) await within(copy, deadline);
  return outcome;
}

/** The loader's entry into core.js after steps 1–8 for a live, unpaused repo (06 §3.4.1 step 9). Never rejects for a loader-controlled failure: an
 *  internal failure (a malformed hook input included) is G4 for a gating event (A4-1) and exit 0 with no output otherwise; deadline expiry and
 *  connection failures are runCore's (A4-6). Production ports: realFs, realIpc, machineClock, realRandom, realSpawner, realWinAcl, the process uid
 *  and realRootProbe; the data directory is resolveDataDir's (null → '' and no key, so gating events take G4). */
export async function main(event: HookEvent, json: unknown, repo: { root: string; gitdir: string }, evidence: EvidenceRecord | null, env: CoreEnv): Promise<CoreOutcome> {
  const drain = (w: NodeJS.WriteStream): Promise<void> => new Promise((resolve) => { w.write('', () => resolve()); });
  const io: CoreIo = {
    stdout: (s) => { if (s !== '') process.stdout.write(s); },
    stderr: (s) => { if (s !== '') process.stderr.write(s); },
    flush: async () => { await Promise.all([drain(process.stdout), drain(process.stderr)]); },
  };
  const deps: CoreDeps = {
    fs: realFs, ipc: realIpc, clock: machineClock, random: realRandom, spawner: realSpawner, acl: realWinAcl, uid: process.getuid?.() ?? null, probe: realRootProbe,
  };
  let lang: ClaudeLang = 'en';
  try {
    const dataDir = resolveDataDir(env.env, env.home, env.platform, env.pluginRoot);
    const userText = dataDir === null ? null : await deps.fs.readFile(join(dataDir, 'user.json')).then((b) => b.toString('utf8'), () => null);
    lang = loaderLang(readUserJson(userText).language, env.osLocale);
    const live: LiveRepo = {
      root: repo.root, gitdir: repo.gitdir, coworkDir: join(repo.gitdir, 'cowork'), dataDir: dataDir ?? '', endpointRoot: endpointRoot(repo.gitdir, deps.probe, env.platform),
    };
    return await runCore(event, parseHookInput(event, json), live, evidence, env, io, deps);
  } catch {
    const out = encodeOutput(event, { g4: true, lang });
    io.stderr(out.stderr);
    await io.flush();
    return { exit: out.exit, evidenceDelivered: false };
  }
}
