// The static shell document and the in-memory asset map (12-visualizer §3.10.4, §3.10.5; VIZ-33, VIZ-34). The shell holds no data and
// no human text (the page renders every string from /api/v1/strings), and no inline script or style (the CSP allows 'self' only).
// Static assets come from memory, so no URL can name a file.
import type { ServerAssets } from './http.js';

export const SHELL_HTML: string = '<!doctype html><html><head><meta charset="utf-8"><title></title>'
  + '<link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head>'
  + '<body><main id="app"></main></body></html>';

/** Exactly '/', '/app.js', '/app.css' and '/favicon.ico' (answered 204); anything else null. /app.js is text/javascript (the build
 *  bundles the page as utf8, ledger ruling for Task 10). */
export function staticRoute(path: string, a: ServerAssets): { type: string; body: string } | 'favicon' | null {
  switch (path) {
    case '/': return { type: 'text/html; charset=utf-8', body: SHELL_HTML };
    case '/app.js': return { type: 'text/javascript; charset=utf-8', body: a.appJs };
    case '/app.css': return { type: 'text/css; charset=utf-8', body: a.appCss };
    case '/favicon.ico': return 'favicon';
    default: return null;
  }
}
