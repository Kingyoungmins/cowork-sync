// R-V54: the en templates of the CLI's own codes. cli.js registers only these (VIZ-01: it bundles nothing of src/viz/** outside cli/**);
// src/viz/i18n/en.ts spreads them into EN_VIZ unchanged. Imports only the Catalog type.
//
// Every refusal template is the whole 10-product section 3.4 two-line refusal, the cause line with its code and the 12 section 1.2
// next line, so the CLI prints a render() result and nothing else (UX-01).
import type { Catalog } from '../../i18n/render.js';

export const EN_VIZ_CLI: Catalog = {
  UI_VIZ_OPENED: { text: 'Opened the read-only viewer in your browser. It stops 10 minutes after you close the tab.' },
  UI_VIZ_URL: { text: 'Open this link in your browser (it works once, within 2 minutes): {url}', params: { url: 'url' } },
  UI_VIZ_OPEN_FAILED: { text: 'Could not open a browser from here. To open the read-only viewer, run in a terminal: {cmd}', params: { cmd: 'cmd' } },
  UI_VIZ_TERMINAL_ONLY: { text: 'The read-only viewer opens only from a terminal. Run there: {cmd}', params: { cmd: 'cmd' } },
  RF_VIZ_START_FAILED: {
    text: 'cowork-sync: the viewer did not start (no ready report within 5 seconds, or its data folder failed the owner check) '
      + '[RF_VIZ_START_FAILED]\nnext: /cowork doctor',
  },
  RF_VIZ_BIND_FAILED: { text: 'cowork-sync: the viewer could not listen on 127.0.0.1 [RF_VIZ_BIND_FAILED]\nnext: /cowork doctor' },
  RF_VIZ_NO_ROOMS: {
    text: 'cowork-sync: no room to show; pass --repo with the folder of a repository where cowork-sync runs, or --demo for demo data '
      + '[RF_VIZ_NO_ROOMS]\nnext: /cowork start',
  },
  RF_VIZ_REPO_NOT_LIVE: {
    text: 'cowork-sync: that folder is not a main worktree with a fetched cowork-sync board [RF_VIZ_REPO_NOT_LIVE]\nnext: /cowork start',
  },
  RF_VIZ_DEMO_INVALID: {
    text: 'cowork-sync: the demo file is not a valid cowork-viz-demo/1 log (first bad line: {n}) [RF_VIZ_DEMO_INVALID]\n'
      + 'next: (none: fix the demo file)',
    params: { n: 'n' },
  },
  RF_UNKNOWN_FLAG: {
    text: 'cowork-sync: unknown flag; view takes --no-open and either --demo, --demo=FILE or --repo FOLDER (repeatable) [RF_UNKNOWN_FLAG]\n'
      + 'next: (none: run view with only those flags)',
  },
  START_TOOL_VERSION: {
    text: 'cowork-sync: git 2.43 or newer is needed, installed outside your repositories [START_TOOL_VERSION]\nnext: /cowork doctor',
  },
  UI_INTERNAL_ERROR: {
    text: 'cowork-sync: internal error; nothing was changed. To collect a report, run /cowork doctor --bundle with a folder outside this repository.',
  },
};
