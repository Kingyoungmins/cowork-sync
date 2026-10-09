// One connection to the session inbox (Windows named pipe). Never prints the token.
// usage: node inject.js <socketPath> <tokenFile|-> <lineFile> <resultFile>
//   tokenFile '-' = send no auth line. lineFile holds the exact candidate line (without newline).
const net = require('net'), fs = require('fs');
const [sock, tokFile, lineFile, outFile] = process.argv.slice(2);
const cand = fs.readFileSync(lineFile, 'utf8');
const rec = { t_connect_ms: Date.now(), auth_sent: tokFile !== '-', candidate: cand, received: '', events: [] };
const c = net.connect(sock, () => {
  rec.events.push(['connected', Date.now()]);
  let payload = '';
  if (tokFile !== '-') payload += JSON.stringify({ type: 'auth', token: fs.readFileSync(tokFile, 'utf8').trim() }) + '\n';
  payload += cand + '\n';
  c.write(payload);
  setTimeout(() => { rec.events.push(['client_end', Date.now()]); c.end(); }, 2500);
});
c.on('data', d => { rec.received += d.toString(); rec.events.push(['data', Date.now()]); });
c.on('end', () => rec.events.push(['server_end', Date.now()]));
c.on('error', e => rec.events.push(['error', e.code || e.message, Date.now()]));
c.on('close', () => { rec.events.push(['close', Date.now()]); fs.appendFileSync(outFile, JSON.stringify(rec) + '\n'); });
