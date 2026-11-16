// Plan 5 Task 3: realIpc carries an authenticated session on this OS (R1-222; 11 §3.2 Ipc "the same, real").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { encodeFrame, LineReader } from '../../src/claude/wire/ndjson.js';
import { validateFrame } from '../../src/claude/wire/schema.js';
import { endpointRoot } from '../../src/data/canonRoot.js';
import { realClock } from '../../src/ports/clock.js';
import { realFs, realRootProbe } from '../../src/ports/fs.js';
import { realIpc, type IpcConn } from '../../src/ports/ipc.js';
import { realRandom } from '../../src/ports/random.js';
import { endpointName, socketDir } from '../../src/sec/endpoint.js';
import { clientHandshake, serverHandshake, type FrameCodec, type SecureConn } from '../../src/sec/handshake.js';
import { makeTempRoot } from '../helpers/tmp.js';

const codec: FrameCodec = { reader: () => new LineReader(), encode: encodeFrame, validate: (d, v) => validateFrame('session', d, v) };

/** The endpoint of <root>/repo/.git under `key`, on this OS (POSIX: in the verified socket directory). */
async function endpointFor(key: Buffer, gitdir: string): Promise<string> {
  const platform = process.platform;
  const root = endpointRoot(gitdir, realRootProbe, platform);
  if (platform === 'win32') return endpointName(key, root, platform, null);
  const dir = await socketDir(process.env, process.getuid?.() ?? -1, realFs, `${'0'.repeat(24)}.sock`);
  assert.ok(dir.ok, 'a socket directory');
  return endpointName(key, root, platform, dir.dir);
}

test('real IPC: realIpc carries an authenticated session on this OS', async (t) => {
  const tmp = await makeTempRoot('ipc-real');
  t.after(tmp.cleanup);
  const gitdir = path.join(tmp.root, 'repo', '.git');
  await mkdir(gitdir, { recursive: true });
  const key = Buffer.from(realRandom.bytes(32));
  const ep = await endpointFor(key, gitdir);

  const fails: string[] = [];
  const serverConns: SecureConn[] = [];
  const server = await realIpc.listen(ep, (c: IpcConn) => {
    serverHandshake(c, key, ep, realRandom, (why) => fails.push(why), codec, { clock: realClock, timeoutMs: 3_000 }).then((sc) => {
      serverConns.push(sc);
      sc.onFrame((f) => {
        const call = f as { t: string; call_id: string; args: { blob: string } };
        sc.send({ t: 'tool_result', call_id: call.call_id, text: call.args.blob, structured: null });
      });
    }, () => {});
  });
  let serverClosed = false;
  t.after(async () => {
    if (!serverClosed) await server.close();
  });

  const conn = await realIpc.connect(ep, 1_000);
  const client = await clientHandshake(conn, key, ep, realRandom, 3_000, codec);
  const replies: Array<{ call_id: string; text: string }> = [];
  let wake: (() => void) | null = null;
  client.onFrame((f) => {
    replies.push(f as { call_id: string; text: string });
    wake?.();
  });
  const blob = 'x'.repeat(10 * 1024);
  for (let i = 0; i < 100; i++) {
    const arrived = new Promise<void>((r) => { wake = r; });
    client.send({ t: 'tool', call_id: `c${i}`, name: 'cowork_status', args: { blob: `${i}:${blob}` } });
    await arrived;
  }
  assert.equal(replies.length, 100);
  replies.forEach((r, i) => {
    assert.equal(r.call_id, `c${i}`);
    assert.equal(r.text, `${i}:${blob}`);
  });
  assert.deepEqual(fails, []);
  assert.equal(serverConns.length, 1);

  // A connect to an endpoint nobody listens on rejects within 1,000 ms.
  const nobody = await endpointFor(Buffer.alloc(32, 0xee), gitdir);
  const t0 = performance.now();
  await assert.rejects(realIpc.connect(nobody, 1_000), (e: unknown) => ['ENOENT', 'ECONNREFUSED'].includes((e as NodeJS.ErrnoException).code ?? ''));
  assert.ok(performance.now() - t0 < 1_000, `rejected after ${performance.now() - t0} ms`);

  // Closing the server makes the client's onClose fire.
  const clientClosed = new Promise<void>((r) => client.onClose(r));
  await server.close();
  serverClosed = true;
  await clientClosed;
});
