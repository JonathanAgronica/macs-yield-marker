// Upload queue test: stubs an AgronicaWorld endpoint and checks the JSON body, batching, and retry/backoff on failure.
// Run: NODE_PATH=... node tests/upload.test.js [baseUrl]
const puppeteer = require('puppeteer-core');
const http = require('http'), assert = require('assert');
const BASE = process.argv[2] || 'http://localhost:8231/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let got = [], failNext = 1, bins = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') return res.end('{}');
      if (req.url.endsWith('/bins')) { bins.push(JSON.parse(b)); res.end('{"ok":true}'); return; }
      if (failNext-- > 0) { res.statusCode = 503; return res.end('{"ok":false}'); }
      const j = JSON.parse(b); assert.equal(req.headers['x-ingest-key'], 'test-key'); got.push(j);
      res.end(JSON.stringify({ ok: true, received: j.marks.length, matched: { [j.session.block]: j.marks.length }, unmatched: [] }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await b.newPage();
  await page.evaluateOnNewDocument(port => { window.__cfg = { INGEST_URL: 'http://127.0.0.1:' + port + '/api/yield/submit', INGEST_KEY: 'test-key', APP_VERSION: 'v1', FARM: 'Alloway' }; }, port);
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const r = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 3500));           // let the app's own start-up kick fire against the 503
    YM_CONFIG.INGEST_URL = window.__cfg.INGEST_URL; YM_CONFIG.INGEST_KEY = 'test-key'; YM_CONFIG.FARM = 'Alloway';
    const s = App.state(); s.block = 'Block 7'; s.variety = 'A16';
    const add = (f, i) => { s.marks.push(Object.assign({ id: 'u' + i, ts: Date.now() + i, lat: -24.98 + i * 1e-4, lon: 152.38, acc: 3, session: 'up1', block: 'Block 7', variety: 'A16', row: '1' }, f)); };
    add({ rating: 'high', treeFrom: 1, treeTo: 10, estimate: 4 }, 1); add({ rating: 'low', kg: 61.5 }, 2); add({ count: 44 }, 3);
    s.sessions.up1 = { id: 'up1', block: 'Block 7', variety: 'A16', start: Date.now() }; s.cur = 'up1'; App.save();
    s.marks.forEach(m => Upload.enqueue(m, s.sessions.up1));
    Upload._q().fails = 0; Upload._q().next = 0;
    const a = await Upload.flush();
    return { pendingAfterFail: a.pending, fails: a.fails, next: a.next };
  });
  assert.ok(r.pendingAfterFail > 0, 'still queued after the 503'); assert.ok(r.fails >= 1); assert.ok(r.next > Date.now(), 'backoff set');
  failNext = 0;
  const r2 = await page.evaluate(() => { Upload._q().next = 0; Upload._q().fails = 0; return Upload.flush(); });
  await sleep(400);
  assert.equal(got.length, 1, 'expected one session POST, got ' + got.length);
  const body = got[0];
  assert.equal(body.session.deviceId.length, 36); assert.equal(body.session.appVersion, 'v1'); assert.equal(body.session.farm, 'Alloway');
  assert.equal(body.session.block, 'Block 7'); assert.equal(body.session.variety, 'A16'); assert.equal(body.session.sessionId, (await page.evaluate(() => App.state().cur)));
  assert.ok(!isNaN(Date.parse(body.session.submittedAt)));
  assert.equal(body.marks.length, 2, 'two rated marks (count-only mark is not a rating mark)');
  const est = body.marks.find(m => m.treeFrom === 1);
  assert.equal(est.rating, 4); assert.equal(est.treeTo, 10); assert.equal(est.estimate, 4); assert.equal(est.row, '1');
  assert.ok(/^\d{4}-\d\d-\d\dT/.test(est.t)); assert.ok(Math.abs(est.lat + 24.98) < 0.1);
  const low = body.marks.find(m => m.rating === 2); assert.equal(low.binWeightKg, 61.5);
  await sleep(300);
  assert.equal(bins.length, 1, 'bin weight posted'); assert.equal(bins[0].weightKg, 61.5); assert.equal(bins[0].deviceId, body.session.deviceId);
  assert.equal(await page.evaluate(() => Upload.status().pending), 0, 'queue drained');
  console.log('ok - upload: 503 then backoff, retry posts AgronicaWorld schema (session + 2 rated marks), bin weight to /api/yield/bins, queue drained');
  await b.close(); srv.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
