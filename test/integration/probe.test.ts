// The genesis host probe (02-protocol §3.10; PRO-49, PRO-50; INV-OID; T-PRO-32 subset; ruling R-21) against host profiles
// emulated on the file:// bare remote. Results come from exit codes, porcelain status and a re-fetch of the probe ref,
// never from text. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBoardCommit } from '../../src/board/boardCommit.js';
import { parseOpLine, type CapsOp } from '../../src/board/ops.js';
import { runProbe, startDispatch } from '../../src/engine/start.js';
import type { Oid } from '../../src/git/oid.js';
import { gitCallsOf, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, wrapGit } from '../helpers/publishHelpers.js';
import { gitRemote, localCoworkRefs, pushSpawns, withStart } from '../helpers/startFixture.js';

const FILES: Record<string, Buffer> = {
  'README.md': buf('# probe fixture\n'),
  'src/a.txt': buf('one\ntwo\nthree\n'),
};
const ZERO = /^0+$/;

async function hr(fx: CoreFixture): Promise<Oid> {
  return (await fx.remote.refs())['refs/heads/main'] as Oid;
}

const peer = (fx: CoreFixture): PeerFixture => fx.peers[0]!;

test('a default file:// remote probes to {custom_refs, lease, delete, two_parent_ok: true, push_options: false} and the probe ref deletion is the only deletion in the reference-transaction log', async () => {
  await withStart('probe-default', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    const caps = await runProbe(p.core, await hr(fx));
    assert.deepEqual(caps, { custom_refs: true, lease: true, delete: true, two_parent_ok: true, push_options: false });
    const q = p.core.refs.probe(p.core.peerId);
    assert.equal((await fx.remote.refs())[q], undefined, 'the probe ref is gone');
    const deletions = (await fx.remote.readRefTxLog()).filter((e) => ZERO.test(e.new));
    assert.deepEqual(deletions.map((e) => e.ref), [q], 'the probe ref deletion is the only deletion');
  });
});

test('a hook refusing refs/cowork/* three times refuses START_REFUSED_CUSTOM_REFS; refusing once then accepting gives custom_refs true', async () => {
  await withStart('probe-custom-refs', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    await fx.remote.rejectNext(3, 'policy', 'refs/cowork/');
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'START_REFUSED_CUSTOM_REFS', params: {} });
    assert.deepEqual(Object.keys(await fx.remote.refs()), ['refs/heads/main'], 'nothing left on the remote');
    assert.deepEqual(await localCoworkRefs(p), []);
    const probes = fx.trace.ofKind('push').filter((e) => e.purpose === 'probe');
    assert.equal(probes.length, 3, 'three counted attempts of step 1');
  });
  await withStart('probe-custom-refs-once', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    await fx.remote.rejectNext(1, 'policy', 'refs/cowork/');
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.ok(r.ok && r.mode === 'genesis', JSON.stringify(r));
    const b0 = await readBoardCommit(p.core.repo, p.core.view!.laB);
    const caps = b0.opsLines.map((l) => parseOpLine(l)).find((o): o is CapsOp => o?.type === 'caps');
    assert.ok(caps !== undefined);
    assert.equal(caps.custom_refs, true);
    assert.equal(caps.lease, true);
  });
});

test('a hook that accepts any old value refuses START_REFUSED_NO_LEASE', async () => {
  await withStart('probe-no-lease', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    const q = p.core.refs.probe(p.core.peerId);
    // git checks --force-with-lease on the client against the advertised value, so no server hook ever sees a stale
    // lease. A host that accepts any old value is emulated here at that very point: every leased push to the probe
    // ref is sent with the remote's current value as its lease, so it lands whatever the probe's lease said (a real
    // push, its real outcome read by the probe).
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args[0] !== 'push') return inner(args, opts);
      const cur = (await fx.remote.refs())[q] ?? '';
      const rewritten = args.map((a) => (a.startsWith(`--force-with-lease=${q}:`) ? `--force-with-lease=${q}:${cur}` : a));
      return inner(rewritten, opts);
    });
    try {
      const r = await startDispatch(p.core, { publishLocal: null });
      assert.deepEqual(r, { ok: false, code: 'START_REFUSED_NO_LEASE', params: { namespace: 'refs/cowork/' } });
    } finally {
      restore();
    }
    assert.equal((await fx.remote.refs())[p.core.refs.remoteBoard], undefined, 'no genesis');
    assert.equal((await fx.remote.refs())[q], undefined, 'the probe ref is cleaned up (step 5 still ran)');
    assert.deepEqual(Object.keys(await fx.remote.refs()), ['refs/heads/main'], 'nothing left on the remote');
    assert.deepEqual(await localCoworkRefs(p), []);
  });
});

test('the probe sends -o ci.skip through governedPush and never changes core.caps, not even while it runs or when it throws', async () => {
  await withStart('probe-push-options', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    const before = p.core.caps;
    const seen: Array<{ args: string[]; caps: unknown }> = [];
    let fail = false;
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args[0] === 'push' && args.includes('-o')) {
        seen.push({ args: [...args], caps: p.core.caps });
        if (fail) throw new Error('the host hung up during the push-options step');
      }
      return inner(args, opts);
    });
    try {
      await runProbe(p.core, await hr(fx));
      assert.equal(seen.length, 1, 'one push with a push option: step 4');
      const argv = seen[0]!.args;
      assert.equal(argv[argv.indexOf('-o') + 1], 'ci.skip', 'step 4 carries -o ci.skip');
      assert.equal(seen[0]!.caps, before, 'core.caps is not changed while the probe runs');
      assert.equal(p.core.caps, before, 'core.caps is unchanged afterwards');
      fail = true;
      await assert.rejects(runProbe(p.core, await hr(fx)), /the host hung up/);
      assert.equal(seen.length, 2);
      assert.equal(seen[1]!.caps, before, 'core.caps is not changed while the failing step runs');
      assert.equal(p.core.caps, before, 'core.caps is unchanged after the probe threw');
    } finally {
      restore();
    }
  });
});

test('every probe push is a counted governed attempt and none waits for a window', async () => {
  await withStart('probe-governed', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    await fx.remote.rejectNext(1, 'policy', 'refs/cowork/probe-');
    const mono = p.clock.monoMs();
    const spawns = pushSpawns(gitCallsOf(p));
    const caps = await runProbe(p.core, await hr(fx));
    assert.equal(caps.custom_refs, true);
    const probes = fx.trace.ofKind('push').filter((e) => e.purpose === 'probe');
    assert.equal(probes.length, 6, 'step 1 twice, steps 2 to 5 once');
    assert.ok(probes.every((e) => e.outcome !== 'denied'), 'no attempt was denied');
    assert.equal(p.core.pushAttempts, probes.length, 'every attempt is counted');
    assert.equal(pushSpawns(gitCallsOf(p)) - spawns, probes.length, 'every spawned push is a governed attempt');
    assert.equal(p.core.governor.attemptsInWindow(), probes.length, 'counted for the per-peer cap');
    assert.equal(p.clock.monoMs(), mono, 'no attempt waited (the virtual clock never moved)');
  });
});

test('a probe ref left by an earlier crashed probe is deleted first (a counted attempt) and the probe runs as usual', async () => {
  await withStart('probe-leftover', { n: 1, files: FILES }, async (fx) => {
    const p = peer(fx);
    const q = p.core.refs.probe(p.core.peerId);
    const main = await hr(fx);
    await gitRemote(fx, ['update-ref', q, main]);
    assert.equal((await fx.remote.refs())[q], main);
    const caps = await runProbe(p.core, main);
    assert.deepEqual(caps, { custom_refs: true, lease: true, delete: true, two_parent_ok: true, push_options: false });
    assert.equal((await fx.remote.refs())[q], undefined, 'the probe ref is gone');
    const probes = fx.trace.ofKind('push').filter((e) => e.purpose === 'probe');
    assert.equal(probes.length, 6, 'the leftover deletion and steps 1 to 5');
    assert.ok(probes[0]!.argv.includes(`:${q}`), 'the first attempt deletes the leftover');
  });
});

