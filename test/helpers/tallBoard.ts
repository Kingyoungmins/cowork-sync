// A tall board for the PRO-27 compaction tests of the hold mirror (Plan 3 Task 4): board commits from the remote tip up to
// a target height, written by a synthetic team writer with one `git fast-import` (the Task 3 importBoard pattern, here on
// top of an existing board), honest checkpoints at every height ≡ 0 (mod 256) computed by folding the drafts from the
// peer's fold and carried in between (as buildBoardCommit carries them, so a peer can build on any height of it), held/<id>/
// subtrees put and removed as the ops need them, then pushed leased. Git is never mocked.
import assert from 'node:assert/strict';
import { BOARD_SUBJECT, boardTrailers, readBoardCommit, readHeldAll, type BoardDraft, type HeldBlob, type WriterId } from '../../src/board/boardCommit.js';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { CHECKPOINT_EVERY, foldCommit, serializeFold, type FoldState } from '../../src/board/fold.js';
import { newEpoch, newPeerId } from '../../src/board/ids.js';
import { PLAN2_REGION_SPEC } from '../../src/engine/deps.js';
import type { IterationCtx } from '../../src/engine/core.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import { formatMessage } from '../../src/git/trailers.js';
import { seededRandom } from '../../src/ports/random.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import type { CoreFixture, PeerFixture } from './coreFixture.js';

/** What the team writer puts into the commit at one height: op fields (each gets an op id) and held/ edits. */
export interface TallStep { ops?: Array<Record<string, unknown>>; put?: ReadonlyMap<string, readonly HeldBlob[]>; remove?: readonly string[]; }

const DATE = '1700000000 +0000';
const dataBlock = (bytes: Buffer): Buffer[] => [Buffer.from(`data ${bytes.length}\n`, 'utf8'), bytes, Buffer.from('\n', 'utf8')];

/**
 * Board commits at heights it.fold.height + 1 … top on the remote tip it.T (the peer fetched it), written by a team writer
 * whose first commit carries its join op; `steps` adds ops and held/ edits at chosen heights. Returns the new tip and the
 * team writer's peer id. `seed` names the team writer: a second call on the same peer passes another seed, so its writer is a
 * new teammate (a fresh join op and seq 1) rather than the first call's writer starting its seqs over.
 */
export async function tallBoard(fx: CoreFixture, p: PeerFixture, it: IterationCtx, top: number, steps: ReadonlyMap<number, TallStep>, seed = `tall/${p.name}`): Promise<{ tip: Oid; team: string }> {
  const repo = p.core.repo;
  const B = it.T as Oid;
  const base = await readBoardCommit(repo, B);
  const L = base.liveCode;
  const r = seededRandom(seed);
  const team = { peer: newPeerId(r), epoch: newEpoch(r) };
  let state: FoldState = it.fold;
  let held = new Set((await readHeldAll(repo, B)).keys());
  const parts: Buffer[] = [];
  const text = (s: string): void => { parts.push(Buffer.from(s, 'utf8')); };
  let mark = 0;
  let seq = 0;
  for (let h = state.height + 1; h <= top; h++) {
    const step = steps.get(h) ?? {};
    const fields: Array<Record<string, unknown>> = [];
    if (h === it.fold.height + 1) {
      fields.push({
        type: 'join', display: 'Teammate', plugin_version: PLUGIN_VERSION, plugin_sha: 'f'.repeat(64), proto: 1, regionSpec: PLAN2_REGION_SPEC,
        config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '' }, coauthor_optin: false,
      });
    }
    fields.push(...(step.ops ?? []));
    const lines = fields.map((f) => canonicalJson({ ...f, id: `${team.peer}/${team.epoch}/${++seq}` } as unknown as Json));
    const writer: WriterId = { ...team, seq: ++seq };
    for (const id of step.remove ?? []) held.delete(id);
    for (const id of step.put?.keys() ?? []) held.add(id);
    held = new Set([...held].sort());
    const draft: BoardDraft = { liveCode: L, writer, cs: [], protocol: base.protocol, opsLines: lines, checkpoint: null, heldIds: [...held] };
    state = foldCommit(state, draft, p.core.peerId).state;
    assert.equal(state.height, h);
    text(`commit refs/cowork-test/tall\nmark :${++mark}\nauthor Teammate <${team.peer}@cowork.invalid> ${DATE}\ncommitter Teammate <${team.peer}@cowork.invalid> ${DATE}\n`);
    parts.push(...dataBlock(formatMessage(BOARD_SUBJECT, boardTrailers(writer, [], new Map()))));
    text(mark === 1 ? `from ${B}\n` : `from :${mark - 1}\n`);
    text(`merge ${L}\n`);
    text('M 100644 inline ops.jsonl\n');
    parts.push(...dataBlock(Buffer.from(lines.map((l) => `${l}\n`).join(''), 'utf8')));
    // A new checkpoint/state.json at a checkpoint height; between them the last one is carried (from the parent's tree).
    if (h % CHECKPOINT_EVERY === 0) {
      text('M 100644 inline checkpoint/state.json\n');
      parts.push(...dataBlock(serializeFold(state)));
    }
    for (const id of step.remove ?? []) text(`D held/${id}\n`);
    for (const [id, blobs] of step.put ?? []) for (const b of blobs) text(`M 100644 ${b.oid} held/${id}/${b.stage}/${b.path}\n`);
  }
  text('done\n');
  await repo.run(['fast-import', '--quiet', '--done'], { stdin: Buffer.concat(parts) });
  const tip = parseOid((await repo.run(['rev-parse', 'refs/cowork-test/tall'])).stdout.toString('utf8').trim());
  const out = await runPush(repo, fx.remote.url, [pushSpec(tip, p.core.refs.remoteBoard, B)], []);
  assert.equal(out.statuses.get(p.core.refs.remoteBoard), 'ok', 'the tall board landed');
  return { tip, team: team.peer };
}
