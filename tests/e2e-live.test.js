// LIVE end-to-end: one real mark through the app's real queue code against the real AgronicaWorld ingest.
// CORS on the ingest allows only Origin https://jonathanagronica.github.io, so this must run against the live site.
//
// Run: NODE_PATH=... node tests/e2e-live.test.js [liveUrl] [--reuse]
//   (no flag)  fresh profile, creates exactly ONE mark (sessionId TEST-agent-check-yield, block TEST, variety A4,
//              rating 3, -24.95/152.25) and saves its deviceId + mark id to tests/.e2e-last.json
//   --reuse    resends that same mark from the same device (a no-op resend: received should be 0, no new row)
const puppeteer = require('puppeteer-core');
const fs = require('fs'), path = require('path'), assert = require('assert');
const URL = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'https://jonathanagronica.github.io/macs-yield-marker/';
const REUSE = process.argv.includes('--reuse');
const SESSION = 'TEST-agent-check-yield';
const RECEIPT = path.join(__dirname, '.e2e-last.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const prev = REUSE && fs.existsSync(RECEIPT) ? JSON.parse(fs.readFileSync(RECEIPT, 'utf8')) : null;
  assert.ok(!REUSE || prev, '--reuse needs ' + RECEIPT + ' from a first run');
  // fresh profile: puppeteer's temp user-data-dir, no storage, no cache, no SW from an earlier run
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await b.newPage();
  const posts = [];
  page.on('response', async r => {
    if (r.request().method() !== 'POST' || !/\/api\/yield\/(submit|bins)/.test(r.url())) return;
    let j = null; try { j = await r.json(); } catch (e) {}
    posts.push({ url: r.url(), status: r.status(), body: j });
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  if (prev) await page.evaluateOnNewDocument(dev => { try { localStorage.setItem('myl-device-id', dev); } catch (e) {} }, prev.deviceId);
  await page.goto(URL, { waitUntil: 'networkidle0' });

  const cfg = await page.evaluate(() => ({ url: YM_CONFIG.INGEST_URL, ver: YM_CONFIG.APP_VERSION, key: !!YM_CONFIG.INGEST_KEY, enabled: Upload.enabled() }));
  console.log('   live config: ' + cfg.url + ' / ' + cfg.ver + ' / key ' + (cfg.key ? 'present' : 'MISSING') + ' / upload ' + (cfg.enabled ? 'ON' : 'OFF'));
  assert.equal(cfg.enabled, true, 'upload is enabled on the live site');
  assert.equal(cfg.ver, 'v3', 'live app version');

  const deviceId = await page.evaluate(() => Upload.deviceId());
  console.log('   ' + (prev ? 'reusing' : 'new') + ' test deviceId: ' + deviceId);
  if (prev) assert.equal(deviceId, prev.deviceId);

  // one mark, queued through the app's own queue code (Upload.enqueue -> Upload.flush)
  const queued = await page.evaluate(({ session, prev }) => {
    const now = Date.now(), ts = prev ? prev.ts : now;
    const s = App.state();
    s.sessions[session] = { id: session, block: 'TEST', variety: 'A4', start: ts, end: ts };
    s.cur = session; s.block = 'TEST'; s.variety = 'A4';
    const m = { id: prev ? prev.markId : 'ytest' + now.toString(36), ts: ts, lat: -24.95, lon: 152.25, acc: 3, rating: 'medium',
      row: '1', session: session, block: 'TEST', variety: 'A4' };
    s.marks.push(m); App.save(); App.render();
    window.__ymExtra = { farm: '' };            // no farm: this is a test row, not a real farm
    Upload.enqueue(m, s.sessions[session]);
    Upload._q().fails = 0; Upload._q().next = 0;
    return { id: m.id, ts: ts, pending: Upload.status().pending, payload: Upload.markPayload(m), sess: Upload.sessionPayload(s.sessions[session]) };
  }, { session: SESSION, prev });
  assert.equal(queued.pending, 1, 'one mark queued');
  console.log('   queued mark ' + queued.id + ' · session ' + queued.sess.sessionId + ' · appVersion ' + queued.sess.appVersion +
    ' · payload ' + JSON.stringify(queued.payload));

  const res = await page.evaluate(() => Upload.flush());
  for (let i = 0; i < 25 && !posts.length; i++) await sleep(200);   // wait for the POST response to land
  const post = posts.find(p => /\/submit$/.test(p.url));
  assert.ok(post, 'the app posted to /api/yield/submit');
  console.log('   POST /api/yield/submit -> HTTP ' + post.status + ' ' + JSON.stringify(post.body));

  assert.equal(post.status, 200, 'HTTP 200');
  assert.equal(post.body.ok, true);
  assert.equal(typeof post.body.received, 'number');
  assert.ok(post.body.matched && typeof post.body.matched === 'object' && !Array.isArray(post.body.matched), 'matched is a {block: count} map');
  assert.equal(typeof post.body.unmatched, 'number', 'unmatched count present');
  if (!prev) assert.equal(post.body.received, 1, 'received:1 for the new mark');
  else assert.ok(post.body.received === 0 || post.body.received === 1, 'no-op resend is accepted (received ' + post.body.received + ')');

  const after = await page.evaluate(() => ({ pending: Upload.status().pending, err: Upload.status().lastErr, text: Upload.statusText(), marks: Upload._q().marks }));
  assert.equal(after.pending, 0, 'local queue empty after the upload');
  assert.deepEqual(after.marks, {}, 'no queued marks left');
  assert.equal(after.err, '', 'no error: ' + after.err);
  assert.equal(posts.filter(p => /\/submit$/.test(p.url)).length, 1, 'exactly one submit request (no retries)');

  if (!prev) fs.writeFileSync(RECEIPT, JSON.stringify({ deviceId, markId: queued.id, ts: queued.ts, at: new Date().toISOString(), res: post.body }, null, 1));
  console.log('   local queue after flush: ' + after.pending + ' pending');
  console.log('   status area now says: "' + after.text + '"');
  console.log('   matched: ' + JSON.stringify(post.body.matched) + '  ·  unmatched: ' + post.body.unmatched);
  console.log('   TEST DEVICE ID (for deletion): ' + deviceId);
  assert.deepEqual(errors, []);
  console.log('\nPASS live end-to-end: HTTP ' + post.status + ', received:' + post.body.received + ', queue empty');
  await b.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
