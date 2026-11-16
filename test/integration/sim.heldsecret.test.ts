// The held-bytes INV-SECRET slice and O-NOMARKER's held side (Plan 3 Task 15; T-05; 11-testing §3.4 INV-SECRET, §7 TC-HLD-06 (INV-SECRET
// part); 03-data DAT-46; ruling R3-49): after a conflicted restore and S6's markers park the bare remote holds no restore-marker row in
// any object and no local_only held byte; planted copies of the remote fail the oracle. Real git against file:// bare remotes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { stageable } from '../../src/engine/stagedRead.js';
import { RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import { isTerminal, type HoldRecord } from '../../src/holds/record.js';
import { alone, okOrFail, play, SIM_TIMEOUT, type Step } from '../helpers/holdsScript.js';
import { d26Steps, dropScratch, g, REFS, scratchRemote, viewOf } from '../helpers/nolossPlants.js';
import { holdsSetup, hostNames } from '../sim/generators.js';
import { runSim, type SimContext } from '../sim/harness.js';
import { readBlob, readRegistry } from '../sim/holdsView.js';
import type { NolossFound } from '../sim/oracleNoloss.js';
import { heldSecretVerdict, heldSide, oracleHeldSecret, oracleNoloss } from '../sim/oracleNoloss.js';
import { plantRegistry } from '../sim/oraclesHolds.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';

const NS = RELEASE_NAMESPACE;

/** The board tip of the scratch remote with `bytes` added at `path` of its tree (a new board commit, same parents and message). */
async function boardWithBlob(dir: string, path: string, bytes: Buffer): Promise<void> {
  const tip = await g(dir, ['rev-parse', `${REFS.remoteBoard}^{commit}`]);
  const index = join(dir, 'plant-held.index');
  await g(dir, ['read-tree', `${tip}^{tree}`], { indexFile: index });
  const blob = await g(dir, ['hash-object', '-w', '--stdin', '--no-filters'], { stdin: bytes });
  await g(dir, ['update-index', '--index-info'], { indexFile: index, stdin: Buffer.from(`100644 ${blob}\t${path}\n`, 'utf8') });
  const tree = await g(dir, ['write-tree'], { indexFile: index });
  await rm(index, { force: true });
  const parents = (await g(dir, ['rev-list', '--no-walk', '--parents', '-n', '1', tip])).split(' ').slice(1);
  const msg = await g(dir, ['log', '-1', '--format=%B', tip]);
  const board = await g(dir, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p])], { stdin: Buffer.from(`${msg}\n`, 'utf8') });
  await g(dir, ['update-ref', REFS.remoteBoard, board, tip]);
}

test('oracleHeldSecret: after the conflicted-restore scenario and S6\'s markers park, the bare remote holds no row beginning \'<<<<<<< cowork:\', \'||||||| cowork:\' or \'>>>>>>> cowork:\' and no h1/s2 blob of p0\'s portability record or marker companion; a scratch copy of the remote with a restore-marker blob added under held/<id>/h1/ fails it, and so does one holding the companion\'s h1 blob', { timeout: SIM_TIMEOUT }, async () => {
  const s = holdsSetup('holds-nl-secret', { script: [] });
  const markers = s.markers;
  const facts = new Map<string, unknown>();
  const at = new Map<string, NolossFound | null>();
  const npName = hostNames(undefined, process.platform, 1).find((x) => stageable(x) && x !== 'a:b.txt')!;
  const verdicts = new Map<string, string | null>();
  const d26 = d26Steps(markers, facts, at);
  const steps: Step[] = [
    ...d26.slice(0, d26.findIndex((x) => 'probe' in x && x.probe === 'companion') + 1),   // through the companion probe (it stays parked)
    { kind: 'nonportable_name', peer: 0, params: { name: npName } },   // a local_only portability record
    ...alone(0, 6),
    {
      probe: 'secret', run: async (ctx: SimContext) => {
        const reg = await readRegistry(ctx.git, ctx.peers[0]!.dir, 'main');
        const comp = facts.get('companion') as { id: string; parent: string };
        const companion = reg.records.get(comp.id)!;
        const portability = [...reg.records.values()].find((r) => !isTerminal(r) && r.guards.some((x) => x.name === 'portability'))!;
        facts.set('localOnly', { companion: companion.local_only, portability: portability?.local_only });
        verdicts.set('clean', await heldSecretVerdict(ctx, NS));
        // A restore-marker blob under held/<parent>/h1/notes.txt.
        const dir = await scratchRemote(ctx, 'secret-marker');
        await boardWithBlob(dir, `held/${comp.parent}/h1/notes.txt`, Buffer.from('note row 3\n<<<<<<< cowork:disk\np0\n||||||| cowork:base\nbase\n=======\nteam\n>>>>>>> cowork:held\n', 'latin1'));
        verdicts.set('marker-blob', await heldSecretVerdict(viewOf(ctx, { remoteDir: dir }), NS));
        await dropScratch(dir);
        // The companion's h1 blob in the remote.
        const h1 = heldSide(companion).find((x) => x.stage === 'h1')!;
        const bytes = await readBlob(ctx.git, ctx.peers[0]!.dir, h1.oid as Oid);
        const dir2 = await scratchRemote(ctx, 'secret-companion');
        const written = await g(dir2, ['hash-object', '-w', '--stdin', '--no-filters'], { stdin: bytes });
        facts.set('companionBlob', { h1: h1.oid, written });
        verdicts.set('companion-blob', await heldSecretVerdict(viewOf(ctx, { remoteDir: dir2 }), NS));
        await dropScratch(dir2);
        // The portability record's h1 blob (no restore-marker row): ruling R3-EF4-18 — a record local_only only for its not-live name is
        // outside the secret set (glossary §9: local_only for the name, not the bytes), as a loose object and under held/ at a portable name.
        const ph1 = heldSide(portability).find((x) => x.stage === 'h1')!;
        const pBytes = await readBlob(ctx.git, ctx.peers[0]!.dir, ph1.oid as Oid);
        const dir3 = await scratchRemote(ctx, 'secret-portability');
        await g(dir3, ['hash-object', '-w', '--stdin', '--no-filters'], { stdin: pBytes });
        facts.set('portabilityBlob', ph1.oid);
        verdicts.set('portability-blob', await heldSecretVerdict(viewOf(ctx, { remoteDir: dir3 }), NS));
        await dropScratch(dir3);
        const HELD_PORTABLE = `held/${comp.parent}/h1/np/fixed-1.txt`;
        const dir4 = await scratchRemote(ctx, 'secret-portability-held');
        await boardWithBlob(dir4, HELD_PORTABLE, pBytes);
        verdicts.set('portability-held', await heldSecretVerdict(viewOf(ctx, { remoteDir: dir4 }), NS));
        // The same bytes held by a local_only record for a secret-like name (no guard) or a portability record whose name is also
        // secret-like stay in the set: planted registry commits judged against that remote, then p0's registry ref goes back (no engine
        // step follows this probe).
        const p0 = ctx.peers[0]!.dir;
        const head = await g(p0, ['rev-parse', '--verify', 'refs/cowork-local/main/holds']);
        /** The portability record re-keyed to `path` with `guards`: same id, kind, state and held bytes. */
        const reKeyed = (path: string, guards: HoldRecord['guards']) => (r: HoldRecord): HoldRecord => ({
          ...r, paths: [path], guards, local_only: true, blobs: { h0: { [path]: ABSENT }, h1: { [path]: ph1.oid as Oid } },
        });
        try {
          const planted1 = await plantRegistry(ctx, 0, portability.id, reKeyed('own/server.pem', []));
          verdicts.set('secret-like-held', await heldSecretVerdict(viewOf(ctx, { remoteDir: dir4 }), NS));
          await g(p0, ['update-ref', 'refs/cowork-local/main/holds', head, planted1]);
          const planted2 = await plantRegistry(ctx, 0, portability.id, reKeyed('own/server.pem', portability.guards));
          verdicts.set('portability-secret-like-held', await heldSecretVerdict(viewOf(ctx, { remoteDir: dir4 }), NS));
          await g(p0, ['update-ref', 'refs/cowork-local/main/holds', head, planted2]);
        } finally {
          await g(p0, ['update-ref', 'refs/cowork-local/main/holds', head]);
          await dropScratch(dir4);
        }
        facts.set('portabilityId', portability.id);
      },
    },
  ];
  const options = { ...s.options, generator: play(steps, markers) };
  delete options.quiescence;
  const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [oracleNoloss(markers, NS), oracleHeldSecret(NS)], options);
  okOrFail(r);
  assert.deepEqual(facts.get('localOnly'), { companion: true, portability: true }, 'the companion and the portability record are local_only');
  assert.equal(verdicts.get('clean'), null, 'no restore-marker row and no local_only held byte in the remote');
  assert.match(verdicts.get('marker-blob') ?? '', /holds a restore-marker row \(<<<<<<< cowork:/);
  const cb = facts.get('companionBlob') as { h1: string; written: string };
  assert.equal(cb.written, cb.h1);
  // The companion's h1 is the half-done file, restore-marker rows included: the first clause to see it names the blob.
  assert.match(verdicts.get('companion-blob') ?? '', new RegExp(`blob ${cb.h1}`));
  const pb = facts.get('portabilityBlob') as string;
  const pid = facts.get('portabilityId') as string;
  assert.equal(verdicts.get('portability-blob'), null, 'R3-EF4-18: a portability record\'s bytes are outside the secret set');
  assert.equal(verdicts.get('portability-held'), null, 'R3-EF4-18: a portability record\'s bytes under held/ at a portable name');
  assert.match(verdicts.get('secret-like-held') ?? '', new RegExp(`^INV-SECRET \\(held bytes\\): the remote holds blob ${pb}, the held side of p0's ${pid} h1/own/server\\.pem — a local_only record's bytes$`));
  assert.match(verdicts.get('portability-secret-like-held') ?? '', new RegExp(`^INV-SECRET \\(held bytes\\): the remote holds blob ${pb}, the held side of p0's ${pid} h1/own/server\\.pem — a local_only record's bytes$`));
});
