import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeKeptRoot } from '../helpers/tmp.js';
import type { EngineFactory, SimContext } from '../sim/harness.js';
import { runSim } from '../sim/harness.js';
import { oracleFF, oracleOID } from '../sim/oracles.js';
import type { PeerClone } from '../sim/peers.js';

const PROBES = ['refs/cowork/probe-', 'refs/heads/cowork/probe-'];

/** A failed run keeps its temp root (artifactsDir is <mkdtemp base>/공 백 dir/artifacts): removeKeptRoot deletes that base only. */
async function dropArtifacts(dir: string | undefined): Promise<void> {
  if (dir === undefined) return;
  await removeKeptRoot(dir);
}

async function gitOk(ctx: SimContext, peer: PeerClone, args: string[]): Promise<string> {
  const r = await ctx.git.run(args, {
    class: args[0] === 'push' || args[0] === 'fetch' ? 'network' : 'local',
    cwd: peer.dir,
    identity: { name: peer.name, email: `${peer.name}@cowork.invalid` },
    wallMsForDates: ctx.clocks.get(peer.name)?.wallMs(),
  });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8').trim();
}

/** A new commit on top of the remote's main (same tree, message names the step). */
async function commitOnMain(ctx: SimContext, peer: PeerClone, step: number): Promise<string> {
  await gitOk(ctx, peer, ['fetch', '--no-tags', ctx.remote.url, '+refs/heads/main:refs/cowork-remote/main/branch']);
  const main = await gitOk(ctx, peer, ['rev-parse', 'refs/cowork-remote/main/branch']);
  return gitOk(ctx, peer, ['commit-tree', `${main}^{tree}`, '-p', main, '-m', `planted ${step}`]);
}

/** Runs `plan(step)` with whichever peer the harness picked. */
function scripted(plan: (ctx: SimContext, peer: PeerClone, step: number) => Promise<void>): EngineFactory {
  return (_ctx, peer) => ({
    peer,
    async step(ctx) { await plan(ctx, peer, ctx.opLog[ctx.opLog.length - 1]?.step ?? -1); },
  });
}

test('INV-FF passes for a creation followed by a fast-forward', async () => {
  const engine = scripted(async (ctx, peer, step) => {
    const c = await commitOnMain(ctx, peer, step);
    if (step === 0) await gitOk(ctx, peer, ['push', ctx.remote.url, `${c}:refs/cowork/main/code`]);
    if (step === 1) {
      await gitOk(ctx, peer, ['fetch', '--no-tags', ctx.remote.url, '+refs/cowork/main/code:refs/cowork-remote/main/code']);
      const tip = await gitOk(ctx, peer, ['rev-parse', 'refs/cowork-remote/main/code']);
      const child = await gitOk(ctx, peer, ['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'child']);
      await gitOk(ctx, peer, ['push', ctx.remote.url, `${child}:refs/cowork/main/code`]);
    }
  });
  const r = await runSim({ seed: 'ff-pass', peers: 2, ops: 2 }, engine, [oracleFF('refs/cowork/')]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, true, r.failure?.message);
});

test('INV-FF fails on a non-fast-forward rewrite of refs/cowork/<branch>/code', async () => {
  const engine = scripted(async (ctx, peer, step) => {
    const c = await commitOnMain(ctx, peer, step);
    await gitOk(ctx, peer, ['push', ctx.remote.url, `+${c}:refs/cowork/main/code`]);
  });
  const r = await runSim({ seed: 'ff-fail', peers: 2, ops: 3 }, engine, [oracleFF('refs/cowork/')]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, false);
  assert.equal(r.failure?.oracle, 'INV-FF');
  assert.equal(r.failure?.step, 1);
  assert.match(r.failure?.message ?? '', /refs\/cowork\/main\/code moved [0-9a-f]+ -> [0-9a-f]+/);
});

test('INV-FF fails on a deletion of refs/cowork/<branch>/board', async () => {
  const engine = scripted(async (ctx, peer, step) => {
    if (step === 0) await gitOk(ctx, peer, ['push', ctx.remote.url, `${await commitOnMain(ctx, peer, step)}:refs/cowork/main/board`]);
    if (step === 1) await gitOk(ctx, peer, ['push', ctx.remote.url, ':refs/cowork/main/board']);
  });
  const r = await runSim({ seed: 'ff-delete', peers: 2, ops: 2 }, engine, [oracleFF('refs/cowork/')]);
  await dropArtifacts(r.artifactsDir);
  assert.deepEqual([r.failure?.oracle, r.failure?.step], ['INV-FF', 1]);
  assert.match(r.failure?.message ?? '', /^refs\/cowork\/main\/board deleted/);
});

test('INV-FF checks only <prefix><branch>/board|code: other refs may be rewritten', async () => {
  const engine = scripted(async (ctx, peer, step) => {
    const c = await commitOnMain(ctx, peer, step);
    await gitOk(ctx, peer, ['push', ctx.remote.url, `+${c}:refs/heads/scratch`, `+${c}:refs/cowork/main/other`, `+${c}:refs/cowork/probe-x`]);
  });
  const r = await runSim({ seed: 'ff-other', peers: 2, ops: 3 }, engine, [oracleFF('refs/cowork/')]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, true, r.failure?.message);
  assert.ok(r.remoteRefs['refs/cowork/main/other'] !== undefined);
});

test('INV-OID fails on a remote deletion outside the allowed prefixes', async () => {
  const engine = scripted(async (ctx, peer, step) => {
    if (step === 0) await gitOk(ctx, peer, ['push', ctx.remote.url, `${await commitOnMain(ctx, peer, step)}:refs/cowork/main/board`]);
    if (step === 1) await gitOk(ctx, peer, ['push', ctx.remote.url, ':refs/cowork/main/board']);
  });
  const r = await runSim({ seed: 'oid-fail', peers: 2, ops: 2 }, engine, [oracleOID(PROBES)]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, false);
  assert.deepEqual([r.failure?.oracle, r.failure?.step], ['INV-OID', 1]);
  assert.match(r.failure?.message ?? '', /refs\/cowork\/main\/board deleted/);
});

test('probe refs of both namespaces may be created and deleted under INV-FF and INV-OID together', async () => {
  const engine = scripted(async (ctx, peer, step) => {
    if (step === 0) {
      const c = await commitOnMain(ctx, peer, step);
      await gitOk(ctx, peer, ['push', ctx.remote.url, `${c}:refs/cowork/probe-${peer.name}`, `${c}:refs/heads/cowork/probe-${peer.name}`]);
    }
    if (step === 1) await gitOk(ctx, peer, ['push', ctx.remote.url, `:refs/cowork/probe-${peer.name}`, `:refs/heads/cowork/probe-${peer.name}`]);
  });
  const r = await runSim({ seed: 'oid-probe', peers: 1, ops: 2 }, engine, [oracleFF('refs/cowork/'), oracleFF('refs/heads/cowork/'), oracleOID(PROBES)]);
  await dropArtifacts(r.artifactsDir);
  assert.equal(r.ok, true, r.failure?.message);
  assert.deepEqual(Object.keys(r.remoteRefs), ['refs/heads/main']);
});
