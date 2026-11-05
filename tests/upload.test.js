// Upload queue test: stubs an AgronicaWorld endpoint and checks the FLAT JSON body, batching caps (1 MB / 5000 marks),
// retry/backoff on 5xx + 429, 400 field errors keeping the queue, bins, and the matched/unmatched status line.
// Run: NODE_PATH=... node tests/upload.test.js [baseUrl]
const puppeteer = require('puppeteer-core');
const http = require('http'), assert = require('assert');
const BASE = process.argv[2] || 'http://localhost:8231/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let got = [], failNext = 1, bins = [], mode = 'ok', reject400 = null;
  const seenMarks = new Set();   // server-side upsert memory, so a resend reports received:0
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') return res.end('{}');
      if (req.url.endsWith('/bins')) { bins.push(JSON.parse(b)); res.end('{"ok":true}'); return; }
      if (failNext-- > 0) { res.statusCode = 503; return res.end('{"ok":false,"error":"down"}'); }
      if (mode === '429') { res.statusCode = 429; res.setHeader('Retry-After', '7'); return res.end('{"ok":false,"error":"Too many requests from this network. Try again in 7 seconds."}'); }
      if (mode === '401') { res.statusCode = 401; return res.end('{"ok":false,"error":"Missing or wrong X-Ingest-Key header"}'); }
      if (mode === '400') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: reject400 })); }
      const j = JSON.parse(b); assert.equal(req.headers['x-ingest-key'], 'test-key'); got.push({ j, size: Buffer.byteLength(b) });
      // like the real server: count only marks inside "Block 7", everything else is unmatched; a resend is received:0
      const seen = seenMarks;
      let changed = 0, inside = 0;
      j.marks.forEach(m => { if (!seen.has(m.id)) { seen.add(m.id); changed++; if (Math.abs(m.lat + 24.98) < 0.005) inside++; } });
      res.end(JSON.stringify({ ok: true, received: changed, matched: inside ? { 'Block 7': inside } : {}, unmatched: changed - inside }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await b.newPage();
  // config.js is served as a stub pointing at the local endpoint: the app is never allowed to reach the live ingest
  await page.setRequestInterception(true);
  page.on('request', r => {
    if (/\/config\.js(\?|$)/.test(r.url())) return r.respond({ status: 200, contentType: 'application/javascript',
      body: `window.YM_CONFIG={INGEST_URL:'http://127.0.0.1:${port}/api/yield/submit',INGEST_KEY:'test-key',INGEST_URL_PLACEHOLDER:'',AI_COUNT_URL:'',FARM:'Alloway',APP_VERSION:'v4'};` });
    r.continue();
  });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  // 1) 503 -> backoff, queue kept
  const r = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 3500));           // let the app's own start-up kick fire against the 503
    const s = App.state(); s.block = 'Block 7'; s.variety = 'A16';
    const add = (f, i) => { s.marks.push(Object.assign({ id: 'u' + i, ts: Date.now() + i, lat: -24.98 + i * 1e-4, lon: 152.38, acc: 3, session: 'up1', block: 'Block 7', variety: 'A16', row: '1' }, f)); };
    add({ rating: 'high', treeFrom: 1, treeTo: 10, estimate: 4, tree: '5' }, 1); add({ rating: 'low', kg: 61.5 }, 2); add({ count: 44 }, 3);
    s.sessions.up1 = { id: 'up1', block: 'Block 7', variety: 'A16', start: Date.now() }; s.cur = 'up1'; App.save();
    s.marks.forEach(m => Upload.enqueue(m, s.sessions.up1));
    Upload._q().fails = 0; Upload._q().next = 0;
    const a = await Upload.flush();
    return { pendingAfterFail: a.pending, fails: a.fails, next: a.next, err: a.lastErr };
  });
  assert.ok(r.pendingAfterFail > 0, 'still queued after the 503'); assert.ok(r.fails >= 1); assert.ok(r.next > Date.now(), 'backoff set');
  assert.ok(/server error \(503\)/.test(r.err), 'error shown: ' + r.err);
  console.log('ok - 503 keeps the queue, sets backoff, and reports "' + r.err + '"');
  failNext = 0;
  // 2) retry: flat payload
  const r2 = await page.evaluate(() => { Upload._q().next = 0; Upload._q().fails = 0; return Upload.flush(); });
  await sleep(400);
  assert.equal(got.length, 1, 'expected one session POST, got ' + got.length);
  const body = got[0].j;
  assert.ok(!('session' in body), 'no nested session object');
  assert.equal(body.deviceId.length, 36); assert.equal(body.appVersion, 'v4'); assert.equal(body.farm, 'Alloway');
  assert.equal(body.block, 'Block 7'); assert.equal(body.variety, 'A16'); assert.equal(body.sessionId, 'up1');
  assert.ok(!isNaN(Date.parse(body.submittedAt)));
  ['deviceId', 'appVersion', 'sessionId', 'submittedAt', 'farm', 'block', 'variety', 'contact'].forEach(k => assert.ok(k in body || k === 'contact', 'flat key ' + k));
  assert.equal(body.marks.length, 2, 'two rated marks (count-only mark is not a rating mark)');
  const est = body.marks.find(m => m.treeFrom === 1);
  assert.equal(est.rating, 4); assert.equal(est.treeTo, 10); assert.equal(est.estimate, 4); assert.equal(est.row, '1');
  assert.ok(!('tree' in est), 'extra `tree` key dropped'); assert.ok(!('count' in est), 'extra `count` key dropped');
  // v4 photo-AI fields are additive and optional: a plain mark's key set is unchanged from v3
  assert.deepEqual(Object.keys(est).sort(), ['acc', 'estimate', 'id', 'lat', 'lon', 'rating', 'row', 't', 'treeFrom', 'treeTo']);
  assert.ok(/^\d{4}-\d\d-\d\dT/.test(est.t)); assert.ok(Math.abs(est.lat + 24.98) < 0.1);
  const low = body.marks.find(m => m.rating === 2); assert.equal(low.binWeightKg, 61.5);
  console.log('ok - flat payload: top-level deviceId/appVersion/sessionId/submittedAt/farm/block/variety + marks; no tree/count');
  // 3) matched/unmatched in the status area
  const st = await page.evaluate(() => { const s = Upload.status(); return { text: Upload.statusText(), last: s.last, pending: s.pending }; });
  assert.ok(st.text.includes('Block 7 2'), 'matched block count in status: ' + st.text);
  assert.ok(/0 outside a block/.test(st.text), st.text);
  assert.equal(st.last.res.received, 2); assert.deepEqual(st.last.res.matched, { 'Block 7': 2 }); assert.equal(st.last.res.unmatched, 0);
  console.log('ok - status shows the last response: "' + st.text + '"');
  // 4) a mark that misses every block shows up as unmatched
  const st2 = await page.evaluate(async () => {
    const s = App.state(), m = { id: 'u9', ts: Date.now(), lat: -25.5, lon: 153.0, acc: 4, rating: 'medium', session: 'up2', block: 'Block 9', variety: 'A4', row: '2' };
    s.marks.push(m); s.sessions.up2 = { id: 'up2', block: 'Block 9', variety: 'A4', start: Date.now() }; s.cur = 'up2'; App.save();
    Upload.enqueue(m, s.sessions.up2); Upload._q().next = 0; Upload._q().fails = 0;
    await Upload.flush();
    return { text: Upload.statusText(), last: Upload.status().last };
  });
  assert.equal(st2.last.res.received, 1); assert.equal(st2.last.res.unmatched, 1); assert.deepEqual(st2.last.res.matched, {});
  assert.ok(/1 outside a block/.test(st2.text), st2.text);
  console.log('ok - unmatched mark reported: "' + st2.text + '"');
  // 5) no-op resend (received:0) is a success, not an error
  const st3 = await page.evaluate(async () => {
    const s = App.state(), m = { id: 'u9', ts: Date.now(), lat: -25.5, lon: 153.0, acc: 4, rating: 'medium', session: 'up2', block: 'Block 9', variety: 'A4', row: '2' };
    Upload.enqueue(m, s.sessions.up2); Upload._q().next = 0; Upload._q().fails = 0;
    const r = await Upload.flush();
    return { pending: r.pending, err: r.lastErr, res: r.last && r.last.res };
  });
  assert.equal(st3.res.received, 0); assert.equal(st3.err, ''); assert.equal(st3.pending, 0, 'queue drained after a no-op resend');
  console.log('ok - resend returns received:0 and is treated as success (queue drained, no error)');
  // 6) 429 backs off using Retry-After and keeps the queue
  mode = '429';
  const st4 = await page.evaluate(async () => {
    const s = App.state(), m = { id: 'u10', ts: Date.now(), lat: -24.98, lon: 152.38, acc: 3, rating: 'high', session: 'up3', block: 'Block 7', variety: 'A16', row: '3' };
    s.sessions.up3 = { id: 'up3', block: 'Block 7', variety: 'A16', start: Date.now() }; s.cur = 'up3';
    Upload.enqueue(m, s.sessions.up3); Upload._q().next = 0; Upload._q().fails = 0;
    const r = await Upload.flush();
    return { pending: r.pending, next: r.next, err: r.lastErr };
  });
  assert.ok(st4.pending > 0, 'kept on 429'); assert.ok(st4.next - Date.now() >= 6000, 'Retry-After honoured'); assert.ok(/429/.test(st4.err), st4.err);
  console.log('ok - 429 backs off (Retry-After) and keeps the queue: "' + st4.err + '"');
  // 7) 400 names the field: shown, queue NOT wiped
  mode = '400'; reject400 = 'marks[0].rating must be a whole number from 1 to 5';
  const st5 = await page.evaluate(async () => { Upload._q().next = 0; Upload._q().fails = 0; const r = await Upload.flush(); return { pending: r.pending, err: r.lastErr, queued: Object.keys(Upload._q().marks) }; });
  assert.ok(st5.pending > 0, 'queue kept on 400'); assert.ok(st5.err.includes('marks[0].rating'), st5.err);
  console.log('ok - 400 keeps the queue and shows the server field message: "' + st5.err + '"');
  // 8) 401 = bad key
  mode = '401';
  const st6 = await page.evaluate(async () => { Upload._q().next = 0; Upload._q().fails = 0; const r = await Upload.flush(); return r.lastErr; });
  assert.ok(/rejected the key \(401\)/.test(st6), st6);
  console.log('ok - 401 reports a bad key: "' + st6 + '"');
  mode = 'ok';
  // 8b) v4: a photo mark carries which count it holds plus the AI second opinion, and the server sees them in the POST
  const ai = await page.evaluate(async () => {
    const s = App.state();
    const m = { id: 'ai1', ts: Date.now(), lat: -24.98, lon: 152.38, acc: 3, rating: 'high', session: 'up4', block: 'Block 7', variety: 'A16', row: '5',
      photoCount: 11, photoCountSrc: 'ai', aiCount: 9, aiPhotoCount: 11, phoneCount: 38, aiKgHa: 1172, aiNutsPerTree: 90, aiConfidence: 0.87, aiModel: 'gpt-4.1-mini',
      estNutsPerTree: 110, estKgHa: 1432, photoFilter: 'green', photoPreset: '' };
    s.sessions.up4 = { id: 'up4', block: 'Block 7', variety: 'A16', start: Date.now() }; s.cur = 'up4'; s.marks.push(m); App.save();
    const up = Upload.markPayload(m);
    Upload.enqueue(m, s.sessions.up4); Upload._q().next = 0; Upload._q().fails = 0;
    await Upload.flush();
    return { up };
  });
  const posted = got[got.length - 1].j.marks.find(x => x.id === 'ai1');
  assert.ok(posted, 'AI photo mark posted');
  assert.equal(posted.photoCount, 11); assert.equal(posted.photoCountSrc, 'ai'); assert.equal(posted.aiCount, 9); assert.equal(posted.aiPhotoCount, 11);
  assert.equal(posted.aiKgHa, 1172); assert.equal(posted.aiNutsPerTree, 90); assert.equal(posted.aiConfidence, 0.87); assert.equal(posted.aiModel, 'gpt-4.1-mini');
  assert.equal(posted.estKgHa, 1432); assert.ok(!('phoneCount' in posted), 'phoneCount stays on the phone');
  const plain = await page.evaluate(() => Upload.markPayload({ id: 'p', ts: Date.now(), lat: 1, lon: 2, rating: 'low', photoCount: 20, estKgHa: 900 }));
  assert.ok(!('photoCountSrc' in plain) && !('aiCount' in plain), 'a v3 photo mark is unchanged: ' + Object.keys(plain));
  console.log('ok - v4 photo mark posts photoCountSrc/aiCount/aiPhotoCount/aiKgHa/aiNutsPerTree/aiConfidence/aiModel; a v3 mark is byte-identical');
  // 9) bin weight posted to /api/yield/bins, with sessionId/binId/lat/lon
  await page.evaluate(async () => {
    const s = App.state(), m = { id: 'b1', ts: Date.now(), lat: -24.97, lon: 152.38, kg: 412.5, session: 'up1', block: 'Block 7', count: 9 };
    Upload.enqueue(m, s.sessions.up1); Upload._q().next = 0; Upload._q().fails = 0;
    for (let i = 0; i < 4; i++) { await Upload.flush(); Upload._q().next = 0; Upload._q().fails = 0; }
  });
  await sleep(300);
  const bin = bins.find(x => x.binId === 'b1'); assert.ok(bin, 'bin weight posted: ' + JSON.stringify(bins));
  assert.equal(bin.weightKg, 412.5); assert.equal(bin.deviceId, body.deviceId);
  assert.equal(bin.sessionId, 'up1'); assert.equal(bin.lat, -24.97); assert.equal(bin.lon, 152.38); assert.equal(bin.block, 'Block 7');
  assert.equal(bins.find(x => x.weightKg === 61.5).binId, 'u2', 'the mark bin weight queued with a mark is sent too');
  console.log('ok - bin weight -> /api/yield/bins {deviceId, sessionId, block, binId, weightKg, t, lat, lon}');
  // 10) batching caps: 1 MB and 5000 marks
  const batch = await page.evaluate(() => {
    const base = Upload.sessionPayload({ id: 'big', block: 'Block 7', variety: 'A16' }, { farm: 'Alloway' });
    const mk = i => ({ id: 'm' + i, t: '2026-11-04T00:00:00.000Z', lat: -24.9 - i * 1e-6, lon: 152.3, acc: 3.2, row: '123', rating: 3, heading: 180, treeFrom: i, treeTo: i + 9, estimate: 3.4, interpolated: true, photoCount: 37, estNutsPerTree: 370, estKgHa: 868 });
    const many = Array.from({ length: 12000 }, (_, i) => mk(i));
    const big = Array.from({ length: 4000 }, (_, i) => Object.assign(mk(i), { id: 'b' + i, row: 'x'.repeat(20), note: 'y'.repeat(40) }));
    const a = Upload.chunks(base, many, null), c = Upload.chunks(base, big, null);
    const sizes = a.map(x => JSON.stringify(x).length), csizes = c.map(x => JSON.stringify(x).length);
    return { n: a.length, counts: a.map(x => x.marks.length), maxSize: Math.max(...sizes), cn: c.length, cMax: Math.max(...csizes), cCounts: c.map(x => x.marks.length) };
  });
  assert.ok(batch.counts.every(n => n <= 5000), 'no request over 5000 marks: ' + batch.counts);
  assert.equal(batch.counts.reduce((a, b) => a + b, 0), 12000);
  assert.ok(batch.maxSize <= 1048576, 'under 1 MB: ' + batch.maxSize);
  assert.ok(batch.cn > 1 && batch.cMax <= 1048576, 'big marks split under 1 MB: ' + batch.cn + ' x ' + batch.cMax);
  console.log(`ok - batching: 12000 marks -> ${batch.n} requests (${batch.counts.join('+')}, max ${batch.maxSize} B); 4000 fat marks -> ${batch.cn} requests (max ${batch.cMax} B)`);
  // 11) sessionId sanitised to [A-Za-z0-9._:-]
  const sid = await page.evaluate(() => [Upload.cleanSessionId('s lzx3k2'), Upload.cleanSessionId('TEST-agent-check-yield'), Upload.cleanSessionId('a/b@c#d'), Upload.cleanSessionId('')]);
  assert.equal(sid[0], 's-lzx3k2'); assert.equal(sid[1], 'TEST-agent-check-yield'); assert.equal(sid[2], 'a-b-c-d'); assert.ok(sid[3].length > 0);
  console.log('ok - sessionId sanitised: "s lzx3k2" -> "' + sid[0] + '"');
  assert.equal(await page.evaluate(() => Upload.status().pending), 0, 'queue drained');
  console.log('\nall upload checks passed');
  await b.close(); srv.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
