// test/helpers/seatHarness.ts — Plan 5 Task 5 (A5-9, A5-12…A5-14; plan 2327-2340): seatHarness over
// makeEngines with one in-process ClaudeDaemon per peer listening on its real endpoint (realIpc + the real
// server handshake; the harness-gated GatedClock — Ruling P5-T3-1 — so a stalled handshake never fires
// early). Each peer's daemon is created first and its engineDeps reach makeEngines through A5-13's
// per-peer engineDeps option; ctx replaces wave-mates' modules with doubles (R5-55); pluginVersion/
// hookProto default to PLUGIN_VERSION/HOOK_PROTO (A5-14); humanLeaseMin (default 480, R5-62) is granted on
// every peer at start through SeatLeasePort.grantHuman — lease and lifetime tests pass 0.
// fakeSeat(opts): the MCP side rides the daemon's own endpoint as session frames (hello, heartbeat,
// seat_end, ring_result are c2s frames the server dispatch answers; the daemon-facing MCP dialer is a
// later task), so mcpEof() sends seat_end and closes, mcpDrop() closes without seat_end and kill() makes
// the harness's pidAlive false for the seat's pid. hook(event, json) opens a fresh connection per call
// (like the loader), builds the exact payload shape the schema checks, and returns the raw reply (exit 2
// iff deny; Task 6 wires runCore, A6-12). close() also clears the daemon scheduler's last pending
// setTimeout: the realScheduler re-arms it every 1 s against the harness clock, which no test advances
// after cleanup, so unclaimed it kept the test file's process open forever (the 44 h nudge/transitions
// hang; Decision 7-19's cleanup had to release every handle). Decision 7-19 (harness).
import type { Json } from '../../src/board/canonicalJson.js';
import { encodeFrame, LineReader } from '../../src/claude/wire/ndjson.js';
import { validateFrame } from '../../src/claude/wire/schema.js';
import type { HookHeader, ReplyFrame, SessionClientFrame, SessionServerFrame } from '../../src/claude/wire/frames.js';
import { HOOK_PROTO } from '../../src/claude/wire/frames.js';
import { C } from '../../src/claude/wire/constants.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { join } from 'node:path';
import { clientHandshake, type FrameCodec, type SecureConn } from '../../src/sec/handshake.js';
import { realIpc } from '../../src/ports/ipc.js';
import { realScheduler } from '../../src/ports/scheduler.js';
import { realRootProbe } from '../../src/ports/fs.js';
import { realWinAcl } from '../../src/sec/winAcl.js';
import { realSpawner } from '../../src/claude/client/spawn.js';
import type { LeasePort } from '../../src/ports/lease.js';
import type { DeferReason } from '../../src/holds/groups.js';
import type { ClaudeEnginePort, AppliedPath, AttributionPort } from '../../src/engine/deps.js';
import { humanOnlyAttribution } from '../../src/engine/deps.js';
import { hookAttribution } from '../../src/claude/daemon/attribution.js';
import type { Notifier } from '../../src/ports/notifier.js';
import { realRandom, randomHex } from '../../src/ports/random.js';
import { nullLog } from '../../src/ports/log.js';
import type { VirtualClock } from '../sim/vclock.js';
import { GatedClock } from './gatedClock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { makeEngines, type EngineFixture } from './engineFixture.js';
import { setupLiveRepo, PLATFORM } from './liveRepo.js';
import { createClaudeDaemon, plan5Bindings, type ClaudeBindings, type ClaudeDaemon, type ClaudeDaemonDeps,
  type CoordToolsPort, type RevertViewPort } from '../../src/claude/daemon/claudeDaemon.js';
import type { Outbox } from '../../src/board/outbox.js';
import { runCore, machineClock, type CoreEnv, type CoreOutcome } from '../../src/claude/client/hookCore.js';
import { parseHookInput } from '../../src/claude/wire/hookInput.js';
import type { McpToolResult, ToolName } from '../../src/claude/daemon/mcpTools.js';
import type { SecurityLog } from '../../src/sec/securityLog.js';

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** seatKeyOf's rule for tests: the seat_key a socket value derives to (A6-12). */
export const seatKeyOfSocket = (socket: string): string => sha256hex(socket);

const codec: FrameCodec = { reader: () => new LineReader(), encode: encodeFrame, validate: (d, v) => validateFrame('session', d, v) };

/** The exact payload defaults per event (the schema's closed shapes, 06 §3.4.3); PreToolUse is built by
 *  toolName (edit or shell). A test's `json` overrides these fields (and the header keys). */
const PAYLOAD_DEFAULTS: Record<string, Record<string, unknown>> = {
  SessionStart: { source: 'startup', transcript_path: null, messaging_present: true, static_policy_hits: [] },
  UserPromptSubmit: { nonces: [] },
  UserPromptExpansion: { command_name: 'cowork', verb: 'status', command_source: 'plugin', args_sha256: '0'.repeat(64), nonces: [], evidence: null },
  PostToolUse: { tool_name: 'Bash', tool_use_id: 'toolu_1', path: null, read: null, exit_status: 0, command: null },
  PostToolUseFailure: { tool_name: 'Bash', tool_use_id: 'toolu_1', command: null },
  PostToolBatch: { tool_use_ids: [] },
  PermissionDenied: { tool_name: 'Write', tool_use_id: 'toolu_1', command: null },
  Stop: { stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: null },
  StopFailure: { reason: null },
  SubagentStart: { agent_id: 'agent-1', agent_type: null, cwd: '' },
  SubagentStop: { stop_hook_active: false, background_tasks_running: 0 },
  SessionEnd: { reason: null },
  Notification: { type: 'idle_prompt' },
};
const HEADER_KEYS = new Set(['session_id', 'cwd', 'hook_event_name', 'permission_mode', 'prompt_id']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface SeatHarness {
  daemons: ClaudeDaemon[];
  engines: EngineFixture;
  fakeSeat(peer: number, opts?: FakeSeatOptions): FakeSeat;
  /** A raw session connection (server.test's pre-attach and routing cells): a fresh handshake on the daemon's endpoint. */
  session(peer: number): Promise<SessionConn>;
  keys(peer: number): Buffer;
  endpoint(peer: number): string;
  /** Attaches every noAttach daemon to its engine (the server.test's after-attach half). */
  attachAll(): Promise<void>;
  /** Moves the daemon clocks (the harness's GatedClock, releasing handshake sleepers) and every fixture clock. */
  advance(ms: number): Promise<void>;
  outboxOf(peer: number): Outbox;
  trace: TraceRecorder;
  close(): Promise<void>;
  cleanup(): Promise<void>;
}

/** A minimal wrapper over one session connection (the test builds frames itself; `frames` records what the daemon sent). */
export interface SessionConn { send(f: SessionClientFrame): void; frames(): SessionServerFrame[]; close(): void; }

/** I-14 (F2 #103): the attribution port answers from the daemon's windows binding (A5-5's engineDeps.attribution);
 *  before the daemon exists it answers the neutral humanOnly port, as the lease and claude ports do pre-attach. */
const attributionOf = (daemons: ClaudeDaemon[], i: number): AttributionPort => daemons[i]?.engineDeps.attribution ?? humanOnlyAttribution;

export async function seatHarness(o?: { peers?: number; noAttach?: boolean; bindings?: Partial<ClaudeBindings>; clock?: VirtualClock;
  ctx?: ClaudeDaemonDeps['ctxOverrides']; pluginVersion?: string; hookProto?: number; humanLeaseMin?: number; files?: Record<string, Buffer>;
  /** C-STOP (F2 #90): each peer's daemon gets ClaudeDaemonDeps.requestStop = () => requestStop(peer); none by default. */
  requestStop?: (peer: number) => void }): Promise<SeatHarness> {
  const peers = o?.peers ?? 1;
  const clock = o?.clock ?? new GatedClock({ startMono: 1_000_000 });
  const daemons: ClaudeDaemon[] = [];
  const engines = await makeEngines(`seat-harness-${harnessCount++}`, {
    n: peers,
    files: o?.files,
    // A5-13: every peer's lease IS its daemon's SeatLeasePort, read lazily (the daemon exists by the time an
    // engine iteration reads it; before attach the source is empty, so the lease idles from composition —
    // decision 7-1 reading (a), contract 2765).
    engineDeps: (i: number) => ({
      lease: { idleMs: () => daemons[i]?.ctx.seatLease.idleMs() ?? 0 } as LeasePort,
      // I-14 (F2 #103): the engine's attribution port IS its daemon's windows binding (run.ts spreads the daemon's
      // engineDeps — claude, attribution, lease; A5-5) — read lazily the same way: before the daemon exists it answers
      // the neutral humanOnly port, as the lease and claude ports do pre-attach.
      attribution: {
        removalAttributed: (p: string) => attributionOf(daemons, i).removalAttributed(p),
        shrinkAttributed: (p: string) => attributionOf(daemons, i).shrinkAttributed(p),
        observedEdit: (p: string) => attributionOf(daemons, i).observedEdit(p),
        hookAttributed: (p: string) => attributionOf(daemons, i).hookAttributed(p),
      } as AttributionPort,
      // I-14 (F2 #103): the engine's claude port IS its daemon's DeferSet (the real composition, run.ts's Task 8) —
      // read lazily the same way the lease is, so a pre-attach iteration answers the neutral. Without this the
      // engine's applied() fan-out never reaches the daemon (noClaude swallows it) and the composition's
      // onApplied subscribers never fire.
      claude: {
        txnOpen: () => daemons[i]?.ctx.defer.txnOpen() ?? false,
        deferred: () => daemons[i]?.ctx.defer.deferred() ?? new Map<string, DeferReason>(),
        recheck: (paths: readonly string[]) => daemons[i]?.ctx.defer.recheck(paths) ?? new Map<string, DeferReason>(),
        fenced: () => daemons[i]?.ctx.defer.fenced() ?? new Set<string>(),
        applied: (paths: readonly string[], detail?: ReadonlyArray<AppliedPath>) => { daemons[i]?.ctx.defer.applied(paths, detail); },
      } as ClaudeEnginePort,
    }),
  });
  const pluginVersion = o?.pluginVersion ?? PLUGIN_VERSION;
  const hookProto = o?.hookProto ?? HOOK_PROTO;
  const alive = new Set<number>();
  /** Every setTimeout the daemon's realScheduler arms (the 1 s ticker loop's re-arms included); close/cleanup clears
   *  the last one, which would otherwise re-arm forever against this harness's frozen clock and keep the process open. */
  const schedulerTimers: Array<ReturnType<typeof setTimeout>> = [];
  /** Clears every pending scheduler timer: the daemons' close stops the ticker loop's re-arm, but a timer already
   *  armed re-arms itself every 1 s against the harness clock, which no test advances after cleanup — leaving it
   *  pending kept the test file's process open forever (the 44 h nudge/transitions hang). */
  const clearSchedulerTimers = (): void => {
    for (const t of schedulerTimers.splice(0)) clearTimeout(t);
  };
  const endpoints: string[] = [];
  const keys: Buffer[] = [];
  const notifier: Notifier = { raise: () => undefined };   // (a harness double observes NT through `security` instead)
  const base = plan5Bindings({ testBuild: true });
  const bindings: ClaudeBindings = {
    ...base,
    coordTools: neutralCoordTools(), revertView: neutralRevertView(),   // inert doubles in place of the composition's two slots (outboxCoord(ctx), plan3RevertView(core))
    ...o?.bindings,
  };
  const security: SecurityLog = { event: () => undefined, flush: async () => undefined };
  try {
    for (const [i, peer] of engines.peers.entries()) {
      const repo = await setupLiveRepo(peer.clone.dir);
      endpoints[i] = repo.endpoint!;
      keys[i] = repo.key!;
      const daemon = createClaudeDaemon({
        repo, key: repo.key!, endpoint: repo.endpoint!, pluginVersion, hookProto,
        ports: {
          clock, random: peer.deps.ports.random, fs: peer.deps.ports.fs, scheduler: realScheduler(clock, (t) => { schedulerTimers.push(t); }),   // the harness clock's own scheduler (the atMono epoch matches); timers collected for close
          git: peer.core.repo, ipc: realIpc, notifier,
        },
        log: nullLog, security, trace: engines.trace, bindings,
        osLocale: 'en', pidAlive: (pid: number) => alive.has(pid), ctxOverrides: o?.ctx,
        heartbeatMs: () => peer.deps.ports.clock.monoMs(),   // A7-6: the engine's own heartbeat source (R-35; the peer's fixture clock, moved by h.advance)
        requestStop: () => o?.requestStop?.(i),               // C-STOP: close('version') ends here (the process exit is run.ts's)
      });
      if (o?.noAttach === true) {
        const bound = await daemon.listen();              // serving BEFORE attach: the server.test's pre-attach half
        if (bound !== 'serving') throw new Error(`seatHarness: peer ${i} listen returned ${bound}`);
      } else {
        await daemon.attach(peer.engine, peer.core);      // the engine first: the lease source fills; held hooks flush at listen
        const bound = await daemon.listen();
        if (bound !== 'serving') throw new Error(`seatHarness: peer ${i} listen returned ${bound}`);
        if ((o?.humanLeaseMin ?? 480) > 0) daemon.ctx.seatLease.grantHuman(o?.humanLeaseMin ?? 480);
      }
      daemons[i] = daemon;
    }
  } catch (e) {
    await engines.cleanup();
    throw e;
  }

  let seatCounter = 0;
  const attachedFlags: boolean[] = [];   // attachAll's guard: each daemon attaches at most once
  const harness: SeatHarness = {
    daemons, engines,
    trace: engines.trace,
    session: async (peer: number) => {
      const c = await realIpc.connect(endpoints[peer]!, 2_000);
      const sc = await clientHandshake(c, keys[peer]!, endpoints[peer]!, realRandom, 3_000, codec, { clock });
      const seen: SessionServerFrame[] = [];
      sc.onFrame((f) => { seen.push(f as SessionServerFrame); });
      return { send: (f: SessionClientFrame) => sc.send(f), frames: () => seen, close: () => sc.close() };
    },
    keys: (peer: number) => keys[peer]!,
    endpoint: (peer: number) => endpoints[peer]!,
    attachAll: async () => {
      for (const [i] of engines.peers.entries()) {
        if (!attachedFlags[i]!) {
          attachedFlags[i] = true;
          await daemons[i]!.attach(engines.peers[i]!.engine, engines.peers[i]!.core);
          if ((o?.humanLeaseMin ?? 480) > 0) daemons[i]!.ctx.seatLease.grantHuman(o?.humanLeaseMin ?? 480);
        }
      }
    },
    advance: async (ms: number) => {
      clock.advance(ms);
      engines.advance(ms);
      await new Promise<void>((r) => { setTimeout(r, 1).unref(); });   // let released sleepers and timers settle
    },
    outboxOf: (peer: number) => engines.peers[peer]!.core.outbox,
    fakeSeat: (peer: number, opts?: FakeSeatOptions) => fakeSeat(daemons[peer]!, endpoints[peer]!, keys[peer]!, clock, alive, pluginVersion, hookProto, ++seatCounter, opts),
    close: async () => {
      for (const d of daemons) await d.close('removal');
      clearSchedulerTimers();
    },
    cleanup: async () => {
      for (const d of daemons) await d.close('removal');
      clearSchedulerTimers();
      await engines.cleanup();
    },
  };
  return harness;
}

let harnessCount = 0;

/** Inert doubles for the two slots plan5Bindings returns (outboxCoordSlot, plan3RevertViewSlot); the harness passes
 *  them so its daemons never bind the composition's real coord tools or revert view. */
function neutralCoordTools(): CoordToolsPort {
  const ok = async (): Promise<{ ok: true; text: string }> => ({ ok: true, text: '' });
  return { request: ok, respond: ok, note: ok, release: ok, show: ok, status: ok } as unknown as CoordToolsPort;
}
function neutralRevertView(): RevertViewPort {
  return { view: async () => { throw new Error('seatHarness: revertView is bound by Task 15'); } } as unknown as RevertViewPort;
}

export interface FakeSeatOptions { seatKey?: string; seatId?: string; withMcp?: boolean; ccVersion?: string | null; agentId?: string | null; messaging?: boolean; pid?: number; pluginVersion?: string; hookProto?: number;
  /** A6-12: 'core' (default) runs the hook through runCore in process (the loader path); 'direct' sends the hand-built frame (version-negotiation cells). */
  mode?: 'core' | 'direct';
  /** A6-12: the CLAUDE_CODE_MESSAGING_SOCKET value runCore's env carries; the default seat_key is its sha-256 (seatKeyOf's rule). */
  socketValue?: string;
  /** Extra env keys runCore's env carries (the A4-11 kill switch COWORK_TEST_KILL_BEFORE_PRINTED in the delivery tests). */
  env?: Record<string, string>; }

export interface FakeSeat {
  hook(event: string, json?: Record<string, unknown>): Promise<CoreOutcome & { stdout: string; stderr: string; reply: ReplyFrame | null }>;
  hello(): Promise<void>;
  heartbeat(): Promise<void>;
  tool(name: ToolName, args: Json): Promise<McpToolResult>;
  mcpEof(): Promise<void>;
  mcpDrop(): void;
  kill(): void;
  seatId(): string | null;
  mcpScript(results: Array<'sent' | 'refused' | 'error' | 'silent'>): void;
  /** Sends one raw frame on the seat's MCP connection (server.test's routing cells), connecting first when needed. */
  sendSession(f: SessionClientFrame): Promise<void>;
  /** Closes the MCP connection without a seat_end (an MCP drop). */
  closeSession(): void;
  /** Every frame the MCP connection received, in order. */
  frames(): SessionServerFrame[];
}

function fakeSeat(daemon: ClaudeDaemon, endpoint: string, ipcKey: Buffer, clock: VirtualClock, alive: Set<number>, pluginVersion: string,
  hookProto: number, ordinal: number, opts?: FakeSeatOptions): FakeSeat {
  const root = daemon.ctx.repo.root;
  const pid = opts?.pid ?? 50_000 + ordinal;
  alive.add(pid);
  // A6-12: the hook's seat identity is seatKeyOf's rule — sha-256 of the socket value the core env carries. An
  // explicit seatKey (older cells) keeps its value only when the caller also passes a socketValue hashing to it;
  // the continuity cell derives its keys from fixed socket values instead.
  const socketValue = opts?.socketValue ?? `messaging-${ordinal}-${randomHex(realRandom, 8)}`;
  const seatKeyHex = opts?.seatKey ?? sha256hex(socketValue);
  const seatId = opts?.seatId ?? randomHex(realRandom, 16);
  const messaging = opts?.messaging ?? true;
  let script: Array<'sent' | 'refused' | 'error' | 'silent'> = [];
  let scriptIndex = 0;
  let mcp: SecureConn | null = null;
  const seen: SessionServerFrame[] = [];   // every frame the MCP connection received, in order (server.test's cells)

  const send = (f: SessionClientFrame): void => { mcp?.send(f); };
  const connectMcp = async (): Promise<void> => {
    const c = await realIpc.connect(endpoint, 2_000);
    mcp = await clientHandshake(c, ipcKey, endpoint, realRandom, 3_000, codec, { clock });
    mcp.onFrame((f) => {
      const frame = f as SessionServerFrame;
      seen.push(frame);
      if (frame.t === 'ring') {                       // A6-12's script; Task 6 tests drive it
        const next: 'sent' | 'refused' | 'error' | 'silent' | undefined = script[scriptIndex];
        scriptIndex += 1;
        if (next !== undefined && next !== 'silent') send({ t: 'ring_result', nonce: frame.nonce, result: next });
      }
    });
  };

  const hook = async (event: string, json?: Record<string, unknown>): Promise<CoreOutcome & { stdout: string; stderr: string; reply: ReplyFrame | null }> => {
    const input: Record<string, unknown> = { ...(PAYLOAD_DEFAULTS[event] ?? {}), ...(json ?? {}) };
    const mode = opts?.mode ?? 'core';
    if (event === 'PreToolUse') {
      const toolName = String(input['tool_name'] ?? 'Edit');
      if (EDIT_TOOLS.has(toolName)) {
        input['gating'] = 'edit';
        input['path'] = input['path'] ?? 'src/a.ts';
        // The core path derives `path` from tool_input.file_path (runCore's targetOf); the direct path keeps
        // the hand-built payload with its own `path` field.
        input['tool_input'] = input['tool_input'] ?? (mode === 'core'
          ? { old_string: 'a', new_string: 'b', file_path: join(root, 'src', 'a.ts') }
          : { old_string: 'a', new_string: 'b' });
      } else {
        input['gating'] = 'shell';
        input['command'] = input['command'] ?? 'ls';
        input['run_in_background'] = input['run_in_background'] ?? false;
      }
    }
    // A6-12: the default path is the loader's — runCore in process over a fresh realIpc session (steps 1–6);
    // mode 'direct' keeps the older hand-built frame path (version-negotiation cells and raw routing cells).
    if (mode === 'core') {
      // runCore takes the parsed HookInput: build the loader's raw hook json (its required session_id/cwd
      // included) and parse it exactly as the loader does. Nothing is stripped here: parseHookInput reads
      // these top-level fields (the HEADER_KEYS stripping belongs to the direct path's frame payload below).
      const raw: Record<string, unknown> = {
        ...input,
        hook_event_name: event,
        session_id: String(input['session_id'] ?? `sess-${ordinal}`),
        cwd: root,
        permission_mode: String(input['permission_mode'] ?? 'default'),
        prompt_id: (input['prompt_id'] as string | null) ?? null,
      };
      const parsed = parseHookInput(event as never, raw);
      const env: CoreEnv = {
        env: { CLAUDE_CODE_MESSAGING_SOCKET: socketValue, ...(opts?.env ?? {}) }, ppid: pid, pluginRoot: '',   // no runtime copy source: copyRuntime fails and is swallowed
        startNs: process.hrtime.bigint(), platform: PLATFORM, home: os.homedir(), osLocale: 'en',
      };
      const seen: string[] = [];
      const outcome = await runCore(event as never, parsed as never, daemon.ctx.repo, null, env, {
        stdout: (s) => { if (s !== '') seen.push(s); },
        stderr: () => undefined,
        flush: async () => undefined,
      }, {
        fs: daemon.ctx.ports.fs, ipc: realIpc, clock: machineClock, random: realRandom,
        spawner: { spawn: () => undefined }, acl: realWinAcl, uid: process.getuid?.() ?? null, probe: realRootProbe,   // P5-EC-9: no child starts
      });
      // The host sees only the encoded output (runCore returns the exit code); map the stdout back onto the
      // wire reply shape the older cells assert on: nothing → 'none', additionalContext → 'context'.
      const stdout = seen.join('');
      let reply: ReplyFrame | null = { t: 'reply', batch_id: '', decision: 'none', text: '', system: '', events: [], cursor: 0 };
      if (stdout !== '') {
        const o = JSON.parse(stdout) as Record<string, unknown>;
        const spec = o['hookSpecificOutput'] as { additionalContext?: string } | undefined;
        const block = o['decision'] === 'block' ? String(o['reason'] ?? '') : null;
        const system = typeof o['systemMessage'] === 'string' ? o['systemMessage'] : '';
        reply = block !== null
          ? { t: 'reply', batch_id: '', decision: 'block', text: block, system, events: [], cursor: 0 }
          : spec?.additionalContext !== undefined
            ? { t: 'reply', batch_id: '', decision: 'context', text: spec.additionalContext, system, events: [], cursor: 0 }
            : { t: 'reply', batch_id: '', decision: 'none', text: '', system, events: [], cursor: 0 };
      }
      return { ...outcome, stdout, stderr: '', reply };
    }
    const header: HookHeader = {
      seat_key: seatKeyHex, claude_pid: pid, session_id: String(input['session_id'] ?? `sess-${ordinal}`),
      prompt_id: (input['prompt_id'] as string | null) ?? null, agent_id: opts?.agentId ?? null, agent_type: null,
      permission_mode: String(input['permission_mode'] ?? 'default'), repo_root: root,
      plugin_version: opts?.pluginVersion ?? pluginVersion, hook_proto: opts?.hookProto ?? hookProto,
    };
    const payload: Record<string, unknown> = { ...input, event };
    for (const k of HEADER_KEYS) delete payload[k];
    const frame: SessionClientFrame = { t: 'hook', event: event as never, h: header, payload: payload as never };
    const c = await realIpc.connect(endpoint, 2_000);
    const sc = await clientHandshake(c, ipcKey, endpoint, realRandom, 3_000, codec, { clock });
    let reply: ReplyFrame | null = null;
    let error: Error | null = null;
    sc.onFrame((f) => {
      const fr = f as SessionServerFrame;
      if (fr.t === 'reply') reply = fr;
    });
    sc.onClose(() => { if (reply === null) error = new Error('connection closed before the reply'); });
    sc.send(frame);
    const deadline = clock.monoMs() + C.SUSPECT_DEADLINE_MAX_MS + 1_000;
    while (reply === null && error === null && clock.monoMs() < deadline) {
      clock.advance(10);
      await new Promise<void>((r) => { setTimeout(r, 1).unref(); });
    }
    sc.close();
    if (error !== null) throw error;
    const r = reply as ReplyFrame | null;
    return { exit: r?.decision === 'deny' ? 2 : 0, evidenceDelivered: false, stdout: '', stderr: '', reply: r };
  };

  return {
    hook,
    hello: async () => {
      if (mcp === null) await connectMcp();
      send({ t: 'hello', seat_id: seatId, seat_key: seatKeyHex, claude_pid: pid, cc_version: opts?.ccVersion ?? null, plugin_version: opts?.pluginVersion ?? pluginVersion, hook_proto: opts?.hookProto ?? hookProto, messaging_present: messaging });
      // F2 #9: the call-time 'all' source reads the registry, so hello waits briefly for the server to process the
      // frame (byKey set) — the shared-template semantics materialized at HOOK time and masked this race; a
      // re-hello (an alias) resolves at once. Best-effort: a hello that fails closed by design (the server.test
      // R-F2-14 cell's throwing fromHello) registers nothing, so the wait just returns.
      for (let i = 0; i < 400; i++) {
        if (daemon.ctx.seats.byKey(seatKeyHex) !== null) return;
        await new Promise<void>((r) => setTimeout(r, 5));
      }
    },
    heartbeat: async () => { if (mcp === null) await connectMcp(); send({ t: 'heartbeat' }); },
    tool: async (): Promise<McpToolResult> => {
      // Task 7 binds the server's tool dispatch (handleTool); 3a answers no tool request (the dispatch closes).
      throw new Error('seatHarness.tool: the tool dispatch lands with Task 7');
    },
    mcpEof: async () => { send({ t: 'seat_end' }); await new Promise<void>((r) => { setTimeout(r, 5).unref(); }); mcp?.close(); mcp = null; },
    mcpDrop: () => { mcp?.close(); mcp = null; },
    kill: () => { alive.delete(pid); },
    seatId: () => seatId,
    mcpScript: (results: Array<'sent' | 'refused' | 'error' | 'silent'>) => { script = results; scriptIndex = 0; },
    sendSession: async (f) => { if (mcp === null) await connectMcp(); send(f); },
    closeSession: () => { mcp?.close(); mcp = null; },   // a drop without seat_end (server.test's onMcpClosed cell)
    frames: () => seen,
  };
}
