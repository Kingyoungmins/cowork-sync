// The en templates of cli.js's start, stop, status and help verbs (v0.1.0-preview). Refusals keep the 10-product section 3.4
// two-line form: the cause with its code, then one `next:` line. {c} is the command prefix the user types: `/cowork-sync:cowork` in a Claude
// Code slash command, `node "<plugin root>/dist/cli.js"` in a terminal. Imports only the Catalog type.
import type { Catalog } from '../i18n/render.js';

export const EN_COWORK_CLI: Catalog = {
  UI_COWORK_HELP: {
    text: 'cowork-sync {version}: live sync of one git branch between clones, through the git remote.\n'
      + '  {c} start [--branch <b>] [--publish=all|none]  start sync in this clone; the daemon keeps running in the background\n'
      + '  {c} status                                     show the sync state of this clone\n'
      + '  {c} stop                                       stop the daemon; your files stay as they are\n'
      + '  {c} view [--no-open] [--demo]                  open the read-only viewer (from a terminal)\n'
      + '  {c} help                                       this list\n'
      + 'start also takes --remote <name> and --name <display name>.',
    params: { version: 'cmd', c: 'cmd' },
  },
  UI_COWORK_STARTED: {
    text: 'cowork-sync: sync started on {branch} ({mode}); the daemon keeps running in the background.\nnext: {c} status',
    params: { branch: 'cmd', mode: 'cmd', c: 'cmd' },
  },
  UI_COWORK_STARTING: {
    text: 'cowork-sync: the daemon has not reported its start after {secs} s; it keeps trying in the background.\nnext: {c} status',
    params: { secs: 'n', c: 'cmd' },
  },
  UI_COWORK_ALREADY_RUNNING: { text: 'cowork-sync: sync already runs in this clone.' },
  /** Printed before the daemon's own refusal (its code line and its next line, relayed). */
  UI_COWORK_DAEMON_REFUSED: { text: 'cowork-sync: the daemon did not start; it said:' },
  UI_COWORK_STOPPED: { text: 'cowork-sync: sync stopped; your files stay as they are.\nnext: {c} start', params: { c: 'cmd' } },
  UI_COWORK_NOT_RUNNING: { text: 'cowork-sync: sync is not running in this clone.\nnext: {c} start', params: { c: 'cmd' } },
  UI_COWORK_STOP_PENDING: {
    text: 'cowork-sync: stop requested; the daemon is still finishing its current step after {secs} s.\nnext: {c} status',
    params: { secs: 'n', c: 'cmd' },
  },
  RF_COWORK_NOT_A_REPO: {
    text: 'cowork-sync: this folder is not inside a git work tree [RF_COWORK_NOT_A_REPO]\nnext: open your clone of the repository, then: {c} {verb}',
    params: { c: 'cmd', verb: 'cmd' },
  },
  RF_COWORK_NO_REMOTE: {
    text: 'cowork-sync: this repository has no git remote, and cowork-sync syncs through one [RF_COWORK_NO_REMOTE]\n'
      + 'next: git remote add origin <url> and push your branch, then: {c} start',
    params: { c: 'cmd' },
  },
  RF_COWORK_NO_BRANCH: {
    text: 'cowork-sync: HEAD is not on a branch [RF_COWORK_NO_BRANCH]\nnext: git switch <branch>, then: {c} start',
    params: { c: 'cmd' },
  },
  RF_COWORK_USAGE: { text: 'cowork-sync: {why} [RF_COWORK_USAGE]\nnext: {c} help', params: { why: 'cmd', c: 'cmd' } },
  RF_COWORK_START_FAILED: {
    text: 'cowork-sync: the daemon could not be started ({why}) [RF_COWORK_START_FAILED]\nnext: check that {daemon} exists, then: {c} start',
    params: { why: 'cmd', daemon: 'cmd', c: 'cmd' },
  },
  UI_COWORK_STATUS_RUNNING: {
    text: 'cowork-sync: running on {branch} as peer {peer} (state: {state})',
    params: { branch: 'cmd', peer: 'cmd', state: 'cmd' },
  },
  UI_COWORK_STATUS_STARTING: { text: 'cowork-sync: the daemon is running but has not written its status yet' },
  UI_COWORK_STATUS_STALE: {
    text: 'cowork-sync: the daemon holds the lock, but its status is {age} old (state: {state}); it may be stuck',
    params: { age: 'cmd', state: 'cmd' },
  },
  UI_COWORK_STATUS_DOWN: {
    text: 'cowork-sync: not running in this clone (last state on {branch}: {state})\nnext: {c} start',
    params: { branch: 'cmd', state: 'cmd', c: 'cmd' },
  },
  UI_COWORK_STATUS_NEVER: { text: 'cowork-sync: sync has not run in this clone yet.\nnext: {c} start', params: { c: 'cmd' } },
  UI_COWORK_STATUS_UNREADABLE: { text: '  status.json: unreadable ({path})', params: { path: 'cmd' } },
  UI_COWORK_STATUS_PEERS: { text: '  peers:         {peers}', params: { peers: 'cmd' } },
  UI_COWORK_STATUS_PUSH: { text: '  last publish:  {age}', params: { age: 'cmd' } },
  UI_COWORK_STATUS_FETCH: { text: '  last fetch:    {age}', params: { age: 'cmd' } },
  UI_COWORK_STATUS_PENDING: {
    text: '  waiting:       {ready} ready to publish, {open} open, {incoming} incoming, {holds} held',
    params: { ready: 'n', open: 'n', incoming: 'n', holds: 'n' },
  },
  UI_COWORK_STATUS_FROZEN: { text: '  frozen:        {reasons}', params: { reasons: 'cmd' } },
  UI_COWORK_STATUS_PAUSE: { text: '  publish pause: {pause}', params: { pause: 'cmd' } },
  UI_COWORK_STATUS_NOT_CONVERGED: { text: '  not converged: {paths}', params: { paths: 'cmd' } },
  UI_COWORK_STATUS_MESSAGE: { text: '  message:       {message}', params: { message: 'cmd' } },
  UI_COWORK_STATUS_FILES: { text: '  files:         {status} and {log}', params: { status: 'cmd', log: 'cmd' } },
  UI_COWORK_INTERNAL_ERROR: { text: 'cowork-sync: internal error ({what}); nothing was changed.', params: { what: 'cmd' } },
};
