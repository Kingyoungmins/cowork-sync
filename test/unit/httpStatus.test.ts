import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHttpThrottle } from '../../src/git/httpStatus.js';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const read = (text: string): ReturnType<typeof readHttpThrottle> => readHttpThrottle(Buffer.from(text, 'utf8'));

test("readHttpThrottle finds 429 and 5xx in git's transport messages and nothing else", () => {
  // git's own transport reports (curl through http.c), as fetch and push print them.
  assert.equal(read(`fatal: unable to access 'https://github.com/team/repo.git/': The requested URL returned error: 429${LF}`), 'http_429');
  assert.equal(read(`error: RPC failed; HTTP 429 curl 22 The requested URL returned error: 429${LF}fatal: the remote end hung up unexpectedly${LF}`), 'http_429');
  assert.equal(read(`error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503${LF}`), 'http_5xx');
  assert.equal(read(`fatal: unable to access 'https://h/r.git/': The requested URL returned error: 500${CR}${LF}`), 'http_5xx');
  assert.equal(read(`error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502${LF}`), 'http_5xx');
  assert.equal(read(`error: RPC failed; HTTP 599${LF}`), 'http_5xx');
  assert.equal(read(`Writing objects: 100% (3/3)${CR}error: RPC failed; HTTP 504${LF}`), 'http_5xx');
  // A 429 anywhere in git's report wins over a 5xx (both start the fallback; 429 is the more specific signal).
  assert.equal(read(`error: RPC failed; HTTP 503${LF}fatal: The requested URL returned error: 429${LF}`), 'http_429');

  // Nothing else: other statuses, digits that only look like one, the host's own text, quoted URLs, rejections.
  const nothing = [
    '',
    `fatal: unable to access 'https://h/r.git/': The requested URL returned error: 404${LF}`,
    `fatal: unable to access 'https://h/r.git/': The requested URL returned error: 403${LF}`,
    `error: RPC failed; HTTP 400 curl 22${LF}`,
    `error: RPC failed; HTTP 200${LF}`,
    `error: RPC failed; HTTP 600${LF}`,
    `error: RPC failed; HTTP 4290${LF}`,
    `fatal: The requested URL returned error: 5030${LF}`,
    `remote: HTTP 429 Too Many Requests from the proxy${LF}`,
    `remote: The requested URL returned error: 503${LF}`,
    `   remote: error: HTTP 500 inside a hook${LF}`,
    `fatal: unable to access 'https://h/HTTP 503/r.git/': Could not resolve host: h${LF}`,
    `To https://h/r.git${LF} ! [remote rejected] 4295a1b2c3 -> refs/cowork/main/board (failed)${LF}`,
    `remote: fatal error in commit_refs${LF}`,
    `! [remote rejected] main -> main (cannot lock ref 'refs/cowork/main/board': is at 5030000000000000000000000000000000000000 but expected 4290000000000000000000000000000000000000)${LF}`,
    `ssh: connect to host h port 5000: Connection refused${LF}`,
    `fatal: the remote end hung up unexpectedly${LF}`,
    `policy: blocked${LF}`,
  ];
  for (const text of nothing) assert.equal(read(text), null, JSON.stringify(text));
});
