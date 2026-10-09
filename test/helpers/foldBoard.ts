// Test helper (Plan 2 Task 6): a seeded generator of long board op streams, their fold from genesis, and
// a git fast-import writer that turns one stream into a real board chain in a single git process (a
// 600-commit board built through buildBoardCommit would cost ~2,400 git calls).
import type { BoardDraft, WriterId } from '../../src/board/boardCommit.js';
import { BOARD_SUBJECT, boardTrailers, CODE_SUBJECT } from '../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { foldCommit, initialFoldState, serializeFold, CHECKPOINT_EVERY, type FoldState } from '../../src/board/fold.js';
import { H, newEpoch, newPeerId } from '../../src/board/ids.js';
import { eventCid, type EventKind } from '../../src/board/ops.js';
import { genesisProtocol, serializeProtocol, type ProtocolJson } from '../../src/board/protocol.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import type { GitRepo } from '../../src/git/repo.js';
import { formatMessage, type Trailer } from '../../src/git/trailers.js';
import { randomHex, randomInt, seededRandom, type Random } from '../../src/ports/random.js';

export interface GenCommit { writer: WriterId | null; lines: string[]; }
/** b0SeatKey: the seat key B0 starts and ends at height 0 (compaction drops it at 512). */
export interface GenBoard { protocol: ProtocolJson; peers: string[]; commits: GenCommit[]; b0SeatKey: string; }

const KINDS: readonly EventKind[] = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'breach', 'freeze', 'unfreeze', 'incident', 'nonretryable', 'health'];
const CONFLICT: ReadonlySet<EventKind> = new Set(['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'breach']);
const CID_POOL: readonly string[] = Array.from({ length: 6 }, (_, i) => H(`pool-${i}`, 'cid'));
/** The seat B0 starts and ends: in no peer's seat pool, so nothing restarts it and compaction at 512 must drop it. */
const B0_SEAT = 'b0'.repeat(16);
const L = (o: Record<string, Json>): string => canonicalJson(o);

interface SimPeer { id: string; epoch: string; seq: number; status: 'none' | 'active' | 'left'; seats: string[]; regionSpec: string; }

function join(p: SimPeer, seq: number, display: string): string {
  return L({
    id: `${p.id}/${p.epoch}/${seq}`, type: 'join', display, plugin_version: '0.2.0', plugin_sha: 'f'.repeat(64), proto: 1, regionSpec: p.regionSpec,
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false,
  });
}

/** One random op of an active peer (some of them invalid against the fold, which decides). */
function randomOp(r: Random, p: SimPeer, seq: number): string {
  const id = `${p.id}/${p.epoch}/${seq}`;
  const pick = randomInt(r, 100);
  if (pick < 34) {
    const kind = KINDS[randomInt(r, KINDS.length)]!;
    const cid = CONFLICT.has(kind) ? CID_POOL[randomInt(r, CID_POOL.length)]! : eventCid(id, kind);
    const reason = kind === 'health' && randomInt(r, 3) === 0 ? 'HOST_THROTTLED' : 'TEST_REASON';
    return L({ id, type: 'event', cid, kind, refs: randomInt(r, 2) === 0 ? [] : ['src/a.ts'], reason_code: reason });
  }
  if (pick < 52) return L({ id, type: 'seat_start', seat_id: p.seats[randomInt(r, p.seats.length)]!, permission_mode: randomInt(r, 2) === 0 ? 'default' : 'acceptEdits' });
  if (pick < 68) return L({ id, type: 'seat_end', seat_id: p.seats[randomInt(r, p.seats.length)]!, permission_mode: 'default' });
  if (pick < 72) return L({ id, type: 'caps', custom_refs: true, lease: randomInt(r, 2) === 0, delete: true, push_options: false, two_parent_ok: true });
  if (pick < 75) return L({ id, type: 'save', save_commit: randomHex(r, 20), saved_live: randomHex(r, 20), chain_base: randomHex(r, 20), released_claim_ids: [] });
  if (pick < 80) {
    p.regionSpec = randomInt(r, 2) === 0 ? 'rs-1' : 'rs-2';
    return join(p, seq, 'Again');
  }
  if (pick < 86) return L({ id, type: 'note', target: null, text: 'hi' });
  if (pick < 90) return L({ id, type: 'claim', path: 'src/a.ts', claim_id: 'abcdefghijklmnop' });
  if (pick < 95) return '{"truncated":';
  return L({ id: `${p.id}/${p.epoch}/${Math.max(1, seq - 3)}`, type: 'leave' });   // a stale seq: a generic no-op
}

/**
 * A board of n commits from a seed: 4 peers; peer 3 is silent for heights 100–449 (a ghost from 300 on);
 * peers leave, rejoin, start new epochs and re-announce regionSpecs; ~1 % of commits carry no writer.
 * B0 also creates a height-0 event and an ended seat with a dedicated id (b0SeatKey), so compaction at 512
 * has both kinds of terminal record to drop.
 */
export function generateBoard(seed: string, n: number): GenBoard {
  const r = seededRandom(seed);
  const protocol = genesisProtocol(12, 'rs-1');
  const peers: SimPeer[] = Array.from({ length: 4 }, () => ({
    id: newPeerId(r), epoch: newEpoch(r), seq: 0, status: 'none' as const, seats: [randomHex(r, 16), randomHex(r, 16), randomHex(r, 16)], regionSpec: 'rs-1',
  }));
  const commits: GenCommit[] = [];
  const g = peers[0]!;
  const gid = (s: number): string => `${g.id}/${g.epoch}/${s}`;
  commits.push({
    writer: { peer: g.id, epoch: g.epoch, seq: 6 },
    lines: [
      join(g, 1, 'Genesis'),
      L({ id: gid(2), type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true }),
      L({ id: gid(3), type: 'seat_start', seat_id: B0_SEAT, permission_mode: 'default' }),
      L({ id: gid(4), type: 'event', cid: eventCid(gid(4), 'freeze'), kind: 'freeze', refs: [], reason_code: 'EPOCH_CHANGED' }),
      L({ id: gid(5), type: 'seat_end', seat_id: B0_SEAT, permission_mode: 'default' }),
    ],
  });
  g.seq = 6;
  g.status = 'active';
  for (let h = 1; h < n; h++) {
    if (randomInt(r, 100) === 0) {
      commits.push({ writer: null, lines: [L({ id: gid(1), type: 'leave' })] });
      continue;
    }
    const eligible = peers.filter((_, i) => !(i === 3 && h >= 100 && h < 450));
    const p = eligible[randomInt(r, eligible.length)]!;
    const lines: string[] = [];
    if (p.status === 'none') {
      lines.push(join(p, ++p.seq, 'Peer'));
      p.status = 'active';
    } else if (p.status === 'left') {
      if (randomInt(r, 2) === 0) {
        lines.push(join(p, ++p.seq, 'Back'));
        p.status = 'active';
      } else {
        lines.push(L({ id: `${p.id}/${p.epoch}/${++p.seq}`, type: 'note', target: null, text: 'while left' }));
      }
    } else {
      const roll = randomInt(r, 100);
      if (roll < 2) {
        p.epoch = newEpoch(r);
        p.seq = 0;
        lines.push(join(p, ++p.seq, 'New epoch'));
      } else if (roll < 4 && p !== g) {
        lines.push(L({ id: `${p.id}/${p.epoch}/${++p.seq}`, type: 'leave' }));
        p.status = 'left';
      } else {
        const k = randomInt(r, 5);
        for (let i = 0; i < k; i++) lines.push(randomOp(r, p, ++p.seq));
      }
    }
    commits.push({ writer: { peer: p.id, epoch: p.epoch, seq: ++p.seq }, lines });
  }
  return { protocol, peers: peers.map((p) => p.id), commits, b0SeatKey: `${g.id}/${commits[0]!.writer!.epoch}/${B0_SEAT}` };
}

export function genDraft(gen: GenBoard, c: GenCommit, liveCode: Oid, checkpoint: Buffer | null = null): BoardDraft {
  return { liveCode, writer: c.writer, cs: [], protocol: gen.protocol, opsLines: [...c.lines], checkpoint, heldIds: [] };
}

/** The fold from genesis: states[h] after folding commit h. */
export function foldAll(gen: GenBoard, self: string, liveCode: Oid): FoldState[] {
  const states: FoldState[] = [];
  let s = initialFoldState(gen.protocol);
  for (const c of gen.commits) {
    s = foldCommit(s, genDraft(gen, c, liveCode), self).state;
    states.push(s);
  }
  return states;
}

/** The honest checkpoint/state.json bytes of every checkpoint height. */
export function honestCheckpoints(states: readonly FoldState[]): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  states.forEach((s, h) => {
    if (h % CHECKPOINT_EVERY === 0) out.set(h, serializeFold(s));
  });
  return out;
}

const DATE = '1700000000 +0000';

function dataBlock(bytes: Buffer): Buffer[] {
  return [Buffer.from(`data ${bytes.length}\n`, 'utf8'), bytes, Buffer.from('\n', 'utf8')];
}

/**
 * Writes the board into `<prefix>/live` (L0) and `<prefix>/board` with one `git fast-import`: B0 = [L0]
 * with ops.jsonl, protocol.json and checkpoint/state.json; every later commit [previous, L0] replaces
 * ops.jsonl and, at checkpoint heights, checkpoint/state.json (protocol.json and the checkpoint carried).
 * Returns L0 and the board oids by height.
 */
export async function importBoard(repo: GitRepo, prefix: string, gen: GenBoard, checkpoints: ReadonlyMap<number, Buffer>): Promise<{ L0: Oid; oids: Oid[] }> {
  const parts: Buffer[] = [];
  const text = (s: string): void => { parts.push(Buffer.from(s, 'utf8')); };
  text(`commit ${prefix}/live\nmark :1\nauthor Fixture <fixture@cowork.invalid> ${DATE}\ncommitter Fixture <fixture@cowork.invalid> ${DATE}\n`);
  parts.push(...dataBlock(formatMessage(CODE_SUBJECT, [{ key: 'skip-checks', value: 'true' }, { key: 'Cowork-Proto', value: '1' }])));
  text('M 100644 inline README.md\n');
  parts.push(...dataBlock(Buffer.from('# board fixture\n', 'utf8')));
  gen.commits.forEach((c, h) => {
    const who = c.writer === null ? 'nobody' : c.writer.peer;
    text(`commit ${prefix}/board\nmark :${h + 2}\nauthor Peer <${who}@cowork.invalid> ${DATE}\ncommitter Peer <${who}@cowork.invalid> ${DATE}\n`);
    const trailers: Trailer[] = c.writer === null
      ? [{ key: 'skip-checks', value: 'true' }, { key: 'Cowork-Proto', value: '1' }]
      : boardTrailers(c.writer, [], new Map());
    parts.push(...dataBlock(formatMessage(BOARD_SUBJECT, trailers)));
    if (h === 0) {
      text('from :1\ndeleteall\nM 100644 inline protocol.json\n');
      parts.push(...dataBlock(serializeProtocol(gen.protocol)));
    } else {
      text(`from :${h + 1}\nmerge :1\n`);
    }
    text('M 100644 inline ops.jsonl\n');
    parts.push(...dataBlock(Buffer.from(c.lines.map((l) => `${l}\n`).join(''), 'utf8')));
    const ck = checkpoints.get(h);
    if (ck !== undefined) {
      text('M 100644 inline checkpoint/state.json\n');
      parts.push(...dataBlock(ck));
    } else if (h === 0) {
      throw new Error('importBoard: B0 needs its checkpoint');
    }
  });
  text('done\n');
  await repo.run(['fast-import', '--quiet', '--done'], { stdin: Buffer.concat(parts) });
  const list = await repo.run(['rev-list', '--first-parent', '--reverse', `${prefix}/board`]);
  const oids = list.stdout.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => parseOid(l));
  if (oids.length !== gen.commits.length + 1) throw new Error(`importBoard: expected ${gen.commits.length + 1} commits, got ${oids.length}`);
  return { L0: oids[0]!, oids: oids.slice(1) };
}
