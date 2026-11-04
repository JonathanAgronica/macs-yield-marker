// LIVE end-to-end: one real mark through the app's real queue code against the real AgronicaWorld ingest.
// CORS on the ingest allows only Origin https://jonathanagronica.github.io, so this must run against the live site.
// Run: NODE_PATH=... node tests/e2e-live.test.js [liveUrl]
// Creates exactly ONE mark (sessionId TEST-agent-check-yield, block TEST, variety A4, rating 3, -24.95/152.25).
const puppeteer = require('puppeteer-core');
const assert = require('assert');
const URL = process.argv[2] || 'https://jonathanagronica.github.io/macs-yield-marker/';
const SESSION = 'TEST-agent-check-yield';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  // fresh profile: puppeteer's temp user-data-dir, no storage, no cache, no SW from an earlier run
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await b.newPage();
  const posts = [];
  page.on('response', async r => {
    if (!/\/api\/yield\/(submit|bins)/.test(r.url())) return;
    let j = null; try { j = await r.json(); } catch (e) {}
    posts.push({ url: r.url(), status: r.status(), body: j });
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle0' });

  const cfg = await page.evaluate(() => ({ url: YM_CONFIG.INGEST_URL, ver: YM_CONFIG.APP_VERSION, key: !!YM_CONFIG.INGEST_KEY, enabled: Upload.enabled() }));
  console.log('   live config: ' + cfg.url + ' · ' + cfg.ver + ' · key ' + (cfg.key ? 'present' : 'MISSING') + ' · upload ' + (cfg.enabled ? 'ON' : 'OFF'));
  assert.equal(cfg.enabled, true, 'upload is enabled on the live site');

  const deviceId = await page.evaluate(() => Upload.deviceId());
  console.log('   test deviceId: ' + deviceId);

  // one mark, queued with the app's own queue code (Upload.enqueue -> flush)
  const queued = await page.evaluate((session) => {
    const now = Date.now();
    const s = App.state();
    s.sessions[session] = { id: session, block: 'TEST', variety: 'A4', start: now, end: now };
    s.cur = session; s.block = 'TEST'; s.variety = 'A4';
    const m = { id: 'ytest' + now.toString(36), ts: now, lat: -24.95, lon: 152.25, acc: 3, rating: 'medium', row: '1',
      session: session, block: 'TEST', variety: 'A4' };
    s.marks.push(m); App.save(); App.render();
    window.__ymExtra = { farm: '' };            // no farm: this is a test row, not a real farm
    Upload.enqueue(m, s.sessions[session]);
    return { id: m.id, pending: Upload.status().pending, deviceId: Upload.deviceId(), session: Upload.sessionPayload(s.sessions[session]) };
  }, SESSION);
  assert.equal(queued.pending, 1, 'one mark queued');
  console.log('   queued mark ' + queued.id + ' (session ' + queued.session.sessionId + ', appVersion ' + queued.session.appVersion + ')');

  const res = await page.evaluate(() => { Upload._q().fails = 0; Upload._q().next = 0; return Upload.flush(); });
  await sleep(600);
  const body = posts.find(p => /\/submit$/.test(p.url));
  assert.ok(body, 'the app posted to /api/yield/submit');
  console.log('   POST /api/yield/submit -> HTTP ' + body.status + ' ' + JSON.stringify(body.body));

  assert.equal(body.status, 200, 'HTTP 200');
  assert.equal(body.body.ok, true);
  assert.equal(body.body.received, 1, 'received:1');
  assert.ok(body.body.matched && typeof body.body.matched === 'object', 'matched block counts present');
  assert.equal(typeof body.body.unmatched, 'number', 'unmatched count present');

  const after = await page.evaluate(() => ({ pending: Upload.status().pending, err: Upload.status().lastErr, text: Upload.statusText(), marks: Upload._q().marks }));
  assert.equal(after.pending, 0, 'local queue empty after the upload');
  assert.deepEqual(after.marks, {}, 'no queued marks left');
  assert.equal(after.err, '', 'no error: ' + after.err);
  assert.equal(posts.length, 1, 'exactly one request (no retries): ' + posts.length);

  console.log('   local queue after flush: ' + after.pending + ' pending · status area says: "' + after.text + '"');
  console.log('   matched: ' + JSON.stringify(body.body.matched) + ' · unmatched: ' + body.body.unmatched);
  console.log('   TEST DEVICE ID (for deletion): ' + deviceId);
  assert.deepEqual(errors, []);
  console.log('\nPASS live end-to-end: HTTP 200, received:1, queue empty');
  await b.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
