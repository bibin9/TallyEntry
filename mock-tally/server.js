// SIMULATED TallyPrime on http://localhost:9000 for testing the connector without Tally.
// NOT TallyPrime. Do not run this on the client's Tally PC while Tally uses port 9000.
//
//   node mock-tally/server.js [--port 9000] [--bulk]   (--bulk adds 5,000 customers and 10,000 items)
// Extra endpoints for demos: GET /sim/daybook, POST /sim/rename {from,to}, POST /sim/edit {masterId}

import http from 'node:http';
import { TallySim } from '../app/core/tally-sim.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 9000));
const sim = new TallySim();
if (process.argv.includes('--bulk')) sim.seedBulk();

http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const send = (code, s, type = 'text/xml; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(s); };
  try {
    if (req.url === '/sim/daybook') return send(200, JSON.stringify(sim.dayBook(), null, 2), 'application/json');
    if (req.url === '/sim/rename') { const { from, to } = JSON.parse(body); sim.renameLedger(from, to); return send(200, '{"ok":true}', 'application/json'); }
    if (req.url === '/sim/edit') { const { masterId } = JSON.parse(body); sim.editVoucherInTally(masterId); return send(200, '{"ok":true}', 'application/json'); }
    if (req.method !== 'POST') return send(200, '<RESPONSE>TallyPrime Server is Running (SIMULATOR)</RESPONSE>');
    return send(200, sim.handle(body));
  } catch (e) { return send(500, `<RESPONSE><LINEERROR>${e.message}</LINEERROR></RESPONSE>`); }
}).listen(PORT, () => console.log(`SIMULATED TallyPrime (not real Tally) on http://localhost:${PORT}, company "${sim.company}"`));
