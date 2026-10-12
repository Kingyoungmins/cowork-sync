// A test-only preload for the real viewer in T-VIZ-perf (Plan 8a final review B2): test/helpers/vizMemory.ts starts the child as
// `node --expose-gc --import <this file's URL> <viewerArgv(...)>` with an IPC channel (the shipped viewerArgv is unchanged). On the
// message 'gc' it runs two full (major) garbage collections and records process.memoryUsage(), then one memory-reducing major GC —
// V8's last-resort flavor (Heap::CollectAllAvailableGarbage: repeated full GCs that also give the committed but unused heap pages
// back, which is what V8's memory reducer does on its own some time after the allocation rate drops) — and answers
// { major, reduced }: the memory after the plain major GCs and after the memory-reducing one. So the test reads the viewer's
// resident memory after a major GC, never at a moment V8's own GC timing happens to pick. It touches nothing else: without an IPC
// channel or without --expose-gc it does nothing, and its channel is unref'd, so it never keeps the viewer alive.
if (typeof process.send === 'function' && typeof globalThis.gc === 'function') {
  process.on('message', (m) => {
    if (m !== 'gc') return;
    globalThis.gc();
    globalThis.gc();
    const major = process.memoryUsage();
    globalThis.gc({ type: 'major', execution: 'sync', flavor: 'last-resort' });
    process.send({ major, reduced: process.memoryUsage() });
  });
  process.channel?.unref();
}
