// Test-only worker entry (Plan 4 Task 1): calls initParser with its workerData and parses, off the main thread, the
// bytes of each message it is sent ({lang, bytes}); it answers {availability, rows, hasError} and waits for the next
// message (the test ends it with worker.terminate()).
import { parentPort, workerData } from 'node:worker_threads';
import type { Language } from '../../../src/regions/types.js';
import { initParser } from '../../../src/regions/worker/parser.js';
import type { WorkerInit } from '../../../src/regions/worker/protocol.js';

const port = parentPort;
if (port !== null) {
  const host = initParser(workerData as WorkerInit);
  let n = 0;
  port.on('message', (m: { lang: Language; bytes: Uint8Array }) => {
    void host.then((h) => {
      const tree = h.parse(m.lang, Buffer.from(m.bytes.buffer, m.bytes.byteOffset, m.bytes.byteLength), `probe:${n++}`, null);
      port.postMessage({
        availability: [...h.availability()],
        endRow: typeof tree === 'object' ? tree.rootNode.endPosition.row : null,
        hasError: typeof tree === 'object' ? tree.rootNode.hasError : null,
        outcome: typeof tree === 'object' ? 'tree' : tree,
      });
    });
  });
}
