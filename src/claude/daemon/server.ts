// src/claude/daemon/server.ts — SEC-21…SEC-23, CCI-09, CCI-41 (plan 1346-1366): the real listen (bind; EADDRINUSE →
// removeStale once (A3-5) → rebind, else the squatter handshake as a client), the per-connection serverHandshake
// (3,000 ms like fakeDaemon; HandshakeFailureRate on every failure; onEvent → the O-IPC trace) and the A5-6 dispatch
// of authenticated session frames. The seat routing the pipeline preamble assigns to "the composition" runs here,
// before the STEP_ORDER loop (decision 7-16; `seat.register` is skipped in it): fromHook, the A5-2 pairing wait
// (awaitBound within the loader deadline, so no step runs under an unbound seat), the activity observation,
// EngineView.observe (A5-8) and TurnOrigin.onOtherHook. Every other step is runStep over the registered steps (a step
// that sets d.done stops the later ones); draftToReply is Task 7's finishReply (A7-4), which also resolves the
// reply's language. Errors fail closed (R-F2-14): a throw while handling any frame is logged as DAEMON_INTERNAL_ERROR
// and the connection is closed with no reply, so the loader applies G4 — never a neutral reply. Decisions continued
// from claudeDaemon.ts: 7-13 setVersionDrain/setReady are additive members (no pinned counterpart); 7-14 the ipc
// trace's peer is SeatRegistry.peerId() (the additive getter); 7-15 the held-hook flush rides attach
// (ClaudeDaemon.attach calls setReady) and a held hook keeps its arrival time; 7-18 the serve_then_drain trigger
// fires once (hello or the first hook), judged inline after the reply (R-F2-7: no version.check step); 7-20 a
// non-hook frame arriving with no bound seat (heartbeat/seat_end) closes the connection.
import { encodeFrame, LineReader } from '../wire/ndjson.js';
import { validateFrame } from '../wire/schema.js';
import type { SessionClientFrame, SessionServerFrame, ReplyFrame, McpHelloFrame } from '../wire/frames.js';
import { clientHandshake, serverHandshake, type FrameCodec, type SecureConn } from '../../sec/handshake.js';
import { HandshakeFailureRate } from '../../sec/securityLog.js';
import type { IpcConn, IpcServer } from '../../ports/ipc.js';
import { C } from '../wire/constants.js';
import { finishReply } from './carriers.js';
import { otherHookEvent } from './turns.js';
import type { DaemonCtx, HookRequest, ReplyDraft } from './ctx.js';
import type { Seat } from './seats.js';
import { STEP_ORDER, runStep } from './pipeline.js';

const codec: FrameCodec = { reader: () => new LineReader(), encode: encodeFrame, validate: (d, v) => validateFrame('session', d, v) };
const HANDSHAKE_TIMEOUT_MS = 3_000;
/** A5-2 (plan 1411-1415): the pairing wait of a hook that beat the MCP hello ends this long before the loader's own
 *  deadline, so the reply still meets it — untilMono = arrival + 2,500 for SessionStart (3,000 − 500) and arrival +
 *  1,000 for every other event (1,500 − 500). */
const PAIRING_REPLY_MARGIN_MS = 500;

/** A5-6's minimal reply superseded by Task 7's finishReply at this one call site (A7-4): the server calls it
 *  after the last step and writes the frame it returns (nothing else in this file changes). */
function draftToReply(r: HookRequest, d: ReplyDraft, ctx: DaemonCtx): ReplyFrame {
  return finishReply(r, d, ctx);
}

interface ConnState { seatKey: string | null; seat: Seat | null; mcp: boolean; }

export class ClaudeServer {
  private readonly ctx: DaemonCtx;
  private readonly key: Buffer;
  private readonly endpoint: string;
  private readonly fails: HandshakeFailureRate;
  private readonly conns = new Map<SecureConn, ConnState>();
  private readonly handlers = new Map<string, (f: SessionClientFrame, peer: { seatKey: string | null }) => Promise<SessionServerFrame | null>>();
  private readonly pendingHooks: Array<{ sc: SecureConn; f: Extract<SessionClientFrame, { t: 'hook' }>; arrivalMono: number }> = [];
  private ready = false;
  private versionDrain: (() => void) | null = null;
  private versionDrainFired = false;
  private ipcServer: IpcServer | null = null;
  private closed = false;

  constructor(ctx: DaemonCtx, key: Buffer, endpoint: string) {
    this.ctx = ctx;
    this.key = key;
    this.endpoint = endpoint;
    this.fails = new HandshakeFailureRate(ctx.ports.clock, ctx.ports.notifier, ctx.security);
  }

  private traceIpc(op: 'accept' | 'auth_ok' | 'auth_fail' | 'close', bytesToUnauthenticated: number): void {
    this.ctx.trace.emit({ kind: 'ipc', peer: this.ctx.seats.peerId(), op, bytesToUnauthenticated });   // decision 7-14
  }

  /** Binds; on EADDRINUSE runs the handshake as a client: pass → 'reuse'; fail → 'SEC_REFUSE_IPC_SQUATTER',
   *  a security event and one NT_SECURITY notification. */
  async listen(): Promise<'serving' | 'reuse' | 'SEC_REFUSE_IPC_SQUATTER'> {
    const ipc = this.ctx.ports.ipc;
    const bind = (): Promise<IpcServer> => ipc.listen(this.endpoint, (c: IpcConn) => this.accept(c));
    let server: IpcServer;
    try {
      server = await bind();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      await ipc.removeStale(this.endpoint);              // A3-5: once, before the squatter handshake
      try {
        server = await bind();
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e2;
        return this.squatterCheck();
      }
    }
    this.ipcServer = server;
    return 'serving';
  }

  /** The squatter check (SEC-21): connect and run the handshake AS A CLIENT with the daemon's key. */
  private async squatterCheck(): Promise<'reuse' | 'SEC_REFUSE_IPC_SQUATTER'> {
    try {
      const c = await this.ctx.ports.ipc.connect(this.endpoint, HANDSHAKE_TIMEOUT_MS);
      const sc = await clientHandshake(c, this.key, this.endpoint, this.ctx.ports.random, HANDSHAKE_TIMEOUT_MS, codec,
        { clock: this.ctx.ports.clock, onFail: (why) => this.fails.fail(why) });
      sc.close();                                                        // our own daemon holds the endpoint
      return 'reuse';
    } catch {
      this.fails.fail('squatter');                                       // the security event (SEC_IPC_HANDSHAKE_FAILED)
      this.ctx.security.event('SEC_REFUSE_IPC_SQUATTER', {});            // the refusal's own line (plan 2750)
      this.ctx.ports.notifier.raise('NT_SECURITY', 'SEC_REFUSE_IPC_SQUATTER', {});   // one notification per refusal
      return 'SEC_REFUSE_IPC_SQUATTER';
    }
  }

  private accept(c: IpcConn): void {
    if (this.closed) { c.destroy(); return; }
    this.traceIpc('accept', 0);
    void serverHandshake(c, this.key, this.endpoint, this.ctx.ports.random, (why) => {
      this.traceIpc('auth_fail', 0);
      this.fails.fail(why);
    }, codec, { clock: this.ctx.ports.clock, timeoutMs: HANDSHAKE_TIMEOUT_MS, onEvent: (op, bytes) => this.traceIpc(op, bytes) })
      .then((sc) => {
        this.traceIpc('auth_ok', 0);
        const state: ConnState = { seatKey: null, seat: null, mcp: false };
        this.conns.set(sc, state);
        sc.onClose(() => {
          this.traceIpc('close', 0);
          this.conns.delete(sc);
          // Only the connection that announced hello is the seat's MCP server; the loader's one-shot hook
          // connections close after their reply and never count as an MCP loss.
          if (state.mcp && state.seat !== null) this.ctx.seats.onMcpClosed(state.seat);
        });
        sc.onFrame((f) => {
          const frame = f as SessionClientFrame;
          const arrivalMono = this.ctx.ports.clock.monoMs();               // A5-2's frameArrivalMono (the hook's start)
          this.dispatch(sc, state, frame, arrivalMono).catch((e: unknown) => { this.failClosed(sc, frame, e); });
        });
      }, () => { /* the failure side already traced and recorded */ });
  }

  /** R-F2-14 (F2 #46, #101): a throw while handling a frame — a hook step, the hello, seat_end, ring_result or an
   *  onRequest handler — is logged as DAEMON_INTERNAL_ERROR (codes and the error's name only, never its message: R-37)
   *  and the connection is closed with no reply. Never a neutral reply: on a gating event that would be an allow; with
   *  the connection closed the hook client's request ends at once and the loader applies G4 (06 §3.4 row 0, CCI-16). */
  private failClosed(sc: SecureConn, f: SessionClientFrame, e: unknown): void {
    try {
      this.ctx.log.write('error', 'DAEMON_INTERNAL_ERROR', { t: f.t, event: f.t === 'hook' ? f.event : null, error: e instanceof Error ? e.name : 'unknown' });
    } catch {
      // The Log port never throws (R-37); a broken one must not turn this back into an unhandled rejection.
    } finally {
      sc.close();
    }
  }

  /** Request kinds other than hook frames (tool, acting, flow, wrap, since_*; Plans 6/7 add theirs); a handler
   *  never runs a supplied command, touches a path outside the main-worktree realpath, or returns a token, the
   *  key or an environment value (SEC-23). */
  onRequest(t: string, h: (f: SessionClientFrame, peer: { seatKey: string | null }) => Promise<SessionServerFrame | null>): void {
    this.handlers.set(t, h);
  }

  /** Decision 7-13: the composition binds ClaudeDaemon.close('version') here (the A5-6 serve_then_drain trigger). */
  setVersionDrain(cb: () => void): void {
    this.versionDrain = cb;
  }

  /** Decision 7-15: attach calls this; hook frames that arrived earlier are held unanswered (the loader's
   *  deadline governs). */
  setReady(): void {
    this.ready = true;
    for (const p of this.pendingHooks.splice(0)) {
      const state = this.conns.get(p.sc);
      if (state === undefined) continue;
      // Directly (no re-queue), with the frame's own arrival time (A5-2) and the same fail-closed catch (R-F2-14).
      this.processHook(p.sc, state, p.f, p.arrivalMono).catch((e: unknown) => { this.failClosed(p.sc, p.f, e); });
    }
  }

  /** The pipeline's seat.register routing (decision 7-16): fromHook, the activity observation (the lease renews
   *  through lastHookMono) and — for every event otherHookEvent admits (all but UserPromptSubmit and
   *  UserPromptExpansion, F2 #60) — TurnOrigin.onOtherHook with the hook's prompt_id (fallback (b), R5-36,
   *  F2 #31; the old line passed null and lost R5-36, audit #31). */
  private async seatRouting(f: Extract<SessionClientFrame, { t: 'hook' }>, arrivalMono: number): Promise<Seat> {
    const h = f.h;
    const seat = this.ctx.seats.fromHook({
      seat_key: h.seat_key, claude_pid: h.claude_pid, session_id: h.session_id,
      permission_mode: h.permission_mode, plugin_version: h.plugin_version, hook_proto: h.hook_proto,
    });
    // A5-2 (plan 1411-1415, 2773; 06 §3.11.2; F2 #30, #92): a seat not bound yet waits for the MCP hello's id, else
    // the daemon mints one (NO_MCP), before any step reads seat.seatId — within the loader deadline.
    if (seat.seatId === null && !seat.ended) {
      const loaderMs = f.event === 'SessionStart' ? C.LOADER_DEADLINE_SESSION_START_MS : C.LOADER_DEADLINE_MS;
      await this.ctx.seats.awaitBound(seat, arrivalMono + loaderMs - PAIRING_REPLY_MARGIN_MS);
    }
    this.ctx.seats.observeActivity(seat, f.event, f.payload);
    this.ctx.engine.observe(this.ctx.ports.clock.monoMs());               // A5-8 (plan 2773): after attach only, so ctx.engine is set
    if (otherHookEvent(f.event)) this.ctx.turns.onOtherHook(seat, h.prompt_id);   // F2 #31 #60: the real prompt_id (I-2b)
    return seat;
  }

  /** The A5-6 hook pipeline: the routing above (awaited: it may wait for the pairing), the STEP_ORDER loop over the
   *  registered steps (`seat.register` skipped — that routing; a step that sets d.done stops the later ones), then the
   *  draftToReply write and the once-only serve_then_drain trigger (decision 7-18). r.startedMono is the frame's
   *  arrival. A throw anywhere here fails closed in the caller's catch (R-F2-14). */
  private async processHook(sc: SecureConn, state: ConnState, f: Extract<SessionClientFrame, { t: 'hook' }>, arrivalMono: number): Promise<void> {
    const seat = await this.seatRouting(f, arrivalMono);
    state.seatKey = f.h.seat_key;
    state.seat = seat;
    const r: HookRequest = { frame: f, seat, startedMono: arrivalMono, extend: this.extendOf(), turn: null, trigger: null };
    const d: ReplyDraft = { carrier: 'none', items: [], deny: null, block: null, done: false };
    for (const id of STEP_ORDER[f.event]) {
      if (id === 'seat.register') continue;                            // the routing above (decision 7-16)
      await runStep(id, r, d, this.ctx);
      if (d.done) break;
    }
    sc.send(draftToReply(r, d, this.ctx));
    // Decision 7-18: the trigger fires on the hook's serve_then_drain verdict only (a newer caller), after the reply.
    if (this.ctx.versions.judge(f.h.plugin_version, f.h.hook_proto) === 'serve_then_drain') this.maybeVersionDrain();
  }

  private async dispatch(sc: SecureConn, state: ConnState, f: SessionClientFrame, arrivalMono: number): Promise<void> {
    switch (f.t) {
      case 'hook': {
        if (!this.ready) { this.pendingHooks.push({ sc, f, arrivalMono }); return; }   // held: it keeps its arrival time
        await this.processHook(sc, state, f, arrivalMono);                 // the flush path (7-15) calls processHook directly
        return;
      }
      case 'printed': {
        this.ctx.events.printed(f.batch_id);
        return;
      }
      case 'hello': {
        const hello = f as McpHelloFrame;
        const seat = this.ctx.seats.fromHello(hello);
        state.seatKey = hello.seat_key;
        state.seat = seat;
        state.mcp = true;                                                  // this connection is the seat's MCP server
        if (this.ctx.versions.judge(hello.plugin_version, hello.hook_proto) === 'serve_then_drain') this.maybeVersionDrain();
        return;
      }
      case 'heartbeat': {
        if (state.seat === null) { sc.close(); return; }                   // decision 7-20
        this.ctx.seats.onHeartbeat(state.seat);
        return;
      }
      case 'seat_end': {
        if (state.seat === null) { sc.close(); return; }
        await this.ctx.seats.end(state.seat, 'mcp_eof');
        state.seat = null;
        return;
      }
      case 'ring_result': {
        this.ctx.ring.onResult(f.nonce, f.result);
        return;
      }
      default: {
        const h = this.handlers.get(f.t);
        if (h === undefined) { sc.close(); return; }                       // a valid frame with no handler: close (no code invented)
        const reply = await h(f, { seatKey: state.seatKey });
        if (reply !== null) sc.send(reply);
        return;
      }
    }
  }

  /** SUSPECT only, once, ≤ 7,000 ms (CCI-17); Task 11 refines the interactions. */
  private extendOf(): (ms: number) => boolean {
    let used = false;
    return (ms: number): boolean => {
      if (used || ms < 1 || ms > C.SUSPECT_DEADLINE_MAX_MS) return false;
      used = true;
      return true;
    };
  }

  private maybeVersionDrain(): void {
    if (this.versionDrain !== null && !this.versionDrainFired) {
      this.versionDrainFired = true;
      this.versionDrain();
    }
  }

  /** A5-6: writes on that seat's MCP connection (false when none) — the Ringer's send (Task 6). Only a connection
   *  that announced hello is the seat's MCP connection: the loader's one-shot hook connections of the same seat carry
   *  state.seat too, but the hook client drops ring frames (ipcClient.ts:117), so writing there would lose the ring
   *  and still answer true (F2 #99, #71). With more than one MCP connection (a reconnect whose old connection has not
   *  closed yet) the newest one — the last in insertion order — wins. */
  sendToSeat(seatId: string, f: SessionServerFrame): boolean {
    let target: SecureConn | null = null;
    for (const [sc, state] of this.conns) {
      if (state.mcp && state.seat !== null && state.seat.seatId === seatId) target = sc;
    }
    if (target === null) return false;
    target.send(f);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const sc of this.conns.keys()) sc.close();
    this.conns.clear();
    await this.ipcServer?.close();
    this.ipcServer = null;
  }
}
