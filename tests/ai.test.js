// AI count test: a stubbed AgronicaWorld /api/yield/ai-count (never the real endpoint) + a headless phone.
// Covers: 1600 px client downscale (asserts the POSTED bytes and dimensions), success with detections drawn as an
// overlay, 503 / 429 / 413-then-retry (smaller image) / 502, tap-correction on top of the AI result, the saved mark
// and its upload payload carrying the AI count, both counts side by side, the cost notice + device counter, and that
// the on-phone filters keep working throughout.
// Run: (python3 -m http.server 8231 &) ; NODE_PATH=/workspace/testenv/node_modules node tests/ai.test.js [baseUrl] [shotDir]
const puppeteer = require('puppeteer-core');
const http = require('http'), assert = require('assert'), fs = require('fs'), path = require('path');
const BASE = process.argv[2] || 'http://localhost:8231/';
const SHOTS = process.argv[3] || '/tmp/myl-test-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, PAGE = null; const ok = name => { passed++; console.log('ok -', name); };
// the photo stage is sticky over the top of the photo pane and the ad strip sits over the bottom, so a synthetic
// page.click() can land on the photo instead of the button: fire the button's own click event (exactly what a tap on
// it does) and assert separately that the button is on screen and not covered.
async function clickAi() { await PAGE.evaluate(() => document.getElementById('phAi').click()); await sleep(80); }
async function scrollTop(v) { await PAGE.evaluate(v => { document.querySelector('#viewPhoto .scroll').scrollTop = v; }, v); }
async function aiButtonHit() {
  return PAGE.evaluate(() => {
    const t = document.getElementById('phAi'), r = t.getBoundingClientRect();
    if (!r.width) return false;
    t.scrollIntoView({ block: 'center' });
    const r2 = t.getBoundingClientRect();
    const els = document.elementsFromPoint(r2.left + r2.width / 2, r2.top + r2.height / 2).map(e => e.id);
    return els.includes('phAi');
  });
}

// --- minimal multipart/form-data reader: field names + the uploaded image's bytes and JPEG dimensions ---
function parseMultipart(buf, boundary) {
  const parts = [], sep = Buffer.from('--' + boundary);
  let i = buf.indexOf(sep);
  while (i >= 0) {
    const start = i + sep.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const hdrEnd = buf.indexOf('\r\n\r\n', start);
    if (hdrEnd < 0) break;
    const head = buf.slice(start + 2, hdrEnd).toString();
    const next = buf.indexOf(sep, hdrEnd + 4);
    const body = buf.slice(hdrEnd + 4, next - 2);
    const name = (head.match(/name="([^"]*)"/) || [])[1];
    parts.push({ name, head, body });
    i = next;
  }
  return parts;
}
function jpegDims(b) {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xC0 || m === 0xC1 || m === 0xC2) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

(async () => {
  let mode = 'ok', calls = [], failCount = 0;
  const srv = http.createServer((req, res) => {
    const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => {
      const buf = Buffer.concat(ch);
      // the test page is on localhost, so the stub allows any origin; the live endpoint allows only
      // https://jonathanagronica.github.io and the browser sends that Origin by itself
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Ingest-Key');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      res.setHeader('Content-Type', 'application/json');
      const ct = req.headers['content-type'] || '';
      const bnd = (ct.match(/boundary=(.+)$/) || [])[1];
      const parts = bnd ? parseMultipart(buf, bnd) : [];
      const img = parts.find(p => p.name === 'image');
      const fields = {};
      parts.filter(p => p.name !== 'image').forEach(p => { fields[p.name] = p.body.toString(); });
      const rec = { mode, url: req.url, method: req.method, key: req.headers['x-ingest-key'], origin: req.headers.origin,
        type: ct.split(';')[0], parts: parts.map(p => p.name), bytes: buf.length, imgBytes: img ? img.body.length : 0,
        imgType: img ? (img.head.match(/Content-Type: (\S+)/) || [])[1] : null, dims: img ? jpegDims(img.body) : null, fields };
      calls.push(rec);
      if (failCount > 0) { failCount--; res.statusCode = 503; return res.end('{"ok":false,"error":"AI nut counting is not configured (no OpenAI key set)"}'); }
      if (mode === '503') { res.statusCode = 503; return res.end('{"ok":false,"error":"AI nut counting is not configured (no OpenAI key set)"}'); }
      if (mode === '429') {
        // like the live endpoint today: no Access-Control-Expose-Headers, so the browser cannot read Retry-After
        // and the app has to fall back to the seconds named in the error text
        res.statusCode = 429; res.setHeader('Retry-After', '42');
        return res.end('{"ok":false,"error":"Too many AI counts from this device - try again in 42 s"}');
      }
      if (mode === '429x') {                                    // and the good case: Retry-After exposed
        res.statusCode = 429; res.setHeader('Retry-After', '7'); res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
        return res.end('{"ok":false,"error":"Too many requests"}');
      }
      if (mode === '415') { res.statusCode = 415; return res.end('{"ok":false,"error":"image must be JPEG, PNG or WebP"}'); }
      if (mode === '502') { res.statusCode = 502; return res.end('{"ok":false,"error":"The vision model failed on this photo"}'); }
      if (mode === '413once') {                       // first call too big for this stub, then a smaller one is accepted
        const d = rec.dims || { w: 0, h: 0 };
        if (Math.max(d.w, d.h) > 1400) { res.statusCode = 413; return res.end('{"ok":false,"error":"image must be 6 MB or smaller"}'); }
        mode = 'ok';
      }
      if (mode === 'slow') { /* fall through: answer after a delay */ }
      const det = [
        { x: 0.21, y: 0.18, r: 0.031 }, { x: 0.44, y: 0.27, r: 0.028 }, { x: 0.63, y: 0.22, r: 0.033 },
        { x: 0.33, y: 0.55, r: 0.029 }, { x: 0.58, y: 0.61, r: 0.026 }, { x: 0.76, y: 0.47, r: 0.03 },
        { x: 0.18, y: 0.72, r: 0.027 }, { x: 0.49, y: 0.81, r: 0.032 }, { x: 0.81, y: 0.76, r: 0.025 }
      ];
      const body = { ok: true, count: det.length, confidence: 0.87, detections: det, nutsPerTree: 90, kgHa: 1172, model: 'gpt-4.1-mini', note: 'Counted visible green husks; a few nuts behind leaves may be missed.' };
      const send = () => res.end(JSON.stringify(body));
      if (mode === 'slow') setTimeout(send, 1500); else send();
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port, AI_URL = `http://127.0.0.1:${port}/api/yield/ai-count`;

  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await b.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_FILE_NOT_FOUND|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // config.js is stubbed: ingest OFF, AI pointed at the local stub (the real endpoint is never called)
  await page.setRequestInterception(true);
  page.on('request', r => {
    if (/\/config\.js(\?|$)/.test(r.url())) return r.respond({ status: 200, contentType: 'application/javascript',
      body: `window.YM_CONFIG={INGEST_URL:'',INGEST_KEY:'',INGEST_URL_PLACEHOLDER:'',AI_COUNT_URL:'${AI_URL}',FARM:'',APP_VERSION:'v4'};` });
    r.continue();
  });
  PAGE = page;
  // bypass the service worker in this suite: after a reload it would answer config.js from its own shell cache
  // (the real file) and bypass the stub. Offline caching has its own suite, tests/offline.test.js.
  if (page.setBypassServiceWorker) await page.setBypassServiceWorker(true);
  // a real GPS fix, so "Save as mark" has a position (and the AI meta gets a session)
  await b.defaultBrowserContext().overridePermissions(new URL(BASE).origin, ['geolocation']);
  await page.setGeolocation({ latitude: -24.98, longitude: 152.38, accuracy: 4 });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.click('#startStop');
  await page.waitForFunction(() => document.querySelector('#status b').textContent === 'GPS OK', { timeout: 10000 });
  await page.type('#block', 'Block 7');
  await page.click('#tabPhoto'); await sleep(200);

  // ---- the button is enabled by config, starts idle, and the cost notice is up before the first call ----
  const initial = await page.evaluate(() => ({ disabled: document.getElementById('phAi').disabled, label: document.querySelector('#phAi span').textContent,
    costShown: !document.getElementById('phAiCost').classList.contains('hidden'), cost: document.getElementById('phAiCost').textContent,
    counter: document.getElementById('phAiCount').textContent, srcHidden: document.getElementById('phSrc').classList.contains('hidden') }));
  assert.equal(initial.disabled, false, 'AI button enabled when AI_COUNT_URL is set');
  assert.equal(initial.label, 'AI count');
  assert.ok(initial.costShown, 'cost line shows before the first AI call');
  assert.ok(/3c per photo/.test(initial.cost) && /OpenAI account/.test(initial.cost), 'cost wording: ' + initial.cost);
  assert.ok(/No AI counts from this phone yet/.test(initial.counter), initial.counter);
  assert.ok(initial.srcHidden, 'side-by-side bar hidden until there is an AI result');
  ok('AI button enabled from config; cost notice ("about 3c per photo, charged to Agronica\'s OpenAI account") shown before the first call');

  // load a real photo (portrait 1280x1707) so the downscale has something to shrink
  await page.evaluate(async () => {
    const im = new Image(); im.src = 'tests/photos/p4.jpg'; await im.decode();
    Photo.setImage(im, { ts: Date.now(), pos: App.lastPos(), row: '2', tree: '7', block: 'Block 7', variety: 'A16' });
    await new Promise(r => setTimeout(r, 900));
  });

  // ---- first tap only warns; the second call uploads and returns detections ----
  await clickAi(); await sleep(250);
  assert.equal(calls.length, 0, 'first tap shows the cost notice instead of spending money');
  assert.ok(/3c per photo/.test(await page.$eval('#phAiNote', e => e.textContent)), 'note says what it costs');
  mode = 'slow';                                      // 1.5 s server delay so the busy state is observable
  const busySeen = page.evaluate(async () => {
    document.getElementById('phAi').click();
    await new Promise(r => setTimeout(r, 60));
    return { busy: !document.getElementById('phAiBusy').classList.contains('hidden'), label: document.querySelector('#phAi span').textContent,
      spin: getComputedStyle(document.querySelector('#phAi .spin')).display, note: document.getElementById('phAiNote').textContent };
  });
  const busy = await busySeen;
  assert.ok(busy.busy, 'busy chip visible while the AI is thinking');
  assert.equal(busy.label, 'Asking AI...');
  assert.notEqual(busy.spin, 'none', 'spinner is shown in the button');
  await page.waitForFunction(() => Photo.ai() && Photo.ai().status === 'ok', { timeout: 15000 });
  await sleep(300); mode = 'ok';
  assert.equal(await page.evaluate(() => Photo.aiBusy()), false, 'busy clears when the answer lands');
  ok('busy state: spinner + "Asking AI..." while the request is in flight');

  // ---- the POST: contract fields, a 1600 px JPEG, and the meta fields ----
  assert.equal(calls.length, 1, 'one POST');
  const c0 = calls[0];
  assert.equal(c0.method, 'POST'); assert.equal(c0.url, '/api/yield/ai-count');
  assert.equal(c0.key, '', 'X-Ingest-Key carries the config key (blank in this stub config)');
  assert.ok(/^http:\/\/localhost:\d+$/.test(c0.origin || ''), 'browser sends an Origin header: ' + c0.origin);
  assert.equal(c0.type, 'multipart/form-data');
  assert.ok(c0.parts.includes('image'), 'multipart has an `image` field: ' + c0.parts);
  assert.equal(c0.imgType, 'image/jpeg', 'image is JPEG');
  assert.ok(c0.imgBytes <= 6 * 1024 * 1024, 'image under 6 MB: ' + c0.imgBytes);
  assert.ok(c0.bytes <= 8 * 1024 * 1024, 'body under 8 MB: ' + c0.bytes);
  assert.equal(Math.max(c0.dims.w, c0.dims.h), 1600, 'posted JPEG long edge is 1600 px, got ' + c0.dims.w + 'x' + c0.dims.h);
  assert.ok(Math.abs(c0.dims.w / c0.dims.h - 1280 / 1707) < 0.02, 'aspect kept: ' + c0.dims.w + 'x' + c0.dims.h);
  ['deviceId', 'sessionId', 'block', 'variety', 'row', 'treeFrom', 'treeTo', 'coverPct', 'rowSp', 'treeSp', 'nisG'].forEach(k => assert.ok(k in c0.fields, 'meta field ' + k));
  assert.match(c0.fields.deviceId, /^[0-9a-f-]{36}$/);
  assert.equal(c0.fields.block, 'Block 7'); assert.equal(c0.fields.variety, 'A16'); assert.equal(c0.fields.treeFrom, '7'); assert.equal(c0.fields.treeTo, '7');
  assert.equal(c0.fields.coverPct, '10'); assert.equal(c0.fields.rowSp, '8'); assert.ok(+c0.fields.treeSp > 0); assert.equal(c0.fields.nisG, '7.5');
  assert.ok(c0.imgBytes > 40000, 'a real JPEG, not an empty blob: ' + c0.imgBytes + ' B');
  ok(`downscale: 1280x1707 phone photo posted as a ${c0.dims.w}x${c0.dims.h} JPEG (${Math.round(c0.imgBytes / 1024)} kB, body ${Math.round(c0.bytes / 1024)} kB) with deviceId/session/block/variety/row/trees/coverPct/spacings/nisG`);

  // ---- the result: overlay drawn, count + confidence + model + note, both counts side by side ----
  const res = await page.evaluate(() => {
    const a = Photo.ai();
    return { a, phone: Photo.count(), active: Photo.activeCount(), src: Photo.src(),
      srcBar: !document.getElementById('phSrc').classList.contains('hidden'),
      barPhone: document.getElementById('phSrcPhone').textContent, barAi: document.getElementById('phSrcAi').textContent,
      saving: document.getElementById('phSaving').textContent,
      card: document.getElementById('phAiRes').textContent, cardShown: !document.getElementById('phAiRes').classList.contains('hidden'),
      badge: document.getElementById('phNBadge').textContent, big: document.getElementById('phN').textContent,
      out: document.getElementById('phOut').textContent, counter: document.getElementById('phAiCount').textContent };
  });
  assert.equal(res.a.count, 9); assert.equal(res.a.model, 'gpt-4.1-mini'); assert.ok(Math.abs(res.a.confidence - 0.87) < 1e-6);
  assert.equal(res.a.detections.length, 9, 'all 9 detections kept');
  assert.ok(res.cardShown && /^9nuts/.test(res.card) && /87% confidence/.test(res.card) && /gpt-4\.1-mini/.test(res.card), res.card);
  assert.ok(/behind leaves/.test(res.card), 'server note shown: ' + res.card);
  assert.ok(/90 nuts\/tree/.test(res.card) && /1,172 kg\/ha/.test(res.card), 'server nuts/tree + kg/ha shown');
  assert.ok(res.srcBar, 'both counts shown side by side'); assert.equal(res.barPhone, String(res.phone)); assert.equal(res.barAi, '9');
  assert.equal(res.src, 'ai', 'the AI count is the one that would be saved, and it says so');
  assert.ok(/Saving the AI count/.test(res.saving), res.saving);
  assert.equal(res.active, 9); assert.equal(res.big, '9', 'big count follows the selected (AI) count');
  // the panel recomputes the yield from the (correctable) AI count with the local spacing/cover/NIS maths, so a tap
  // correction immediately moves kg/ha; the server's own nuts/tree + kg/ha stay in the AI card above
  assert.ok(/^Count used \(AI count\)\s*9/.test(res.out), 'yield panel uses the AI count: ' + res.out);
  assert.ok(/AI counts from this phone: 1 \(about 3c\)/.test(res.counter), res.counter);
  // the detections really are painted: sample the canvas for violet pixels around the first detection
  const painted = await page.evaluate(() => {
    const c = document.getElementById('phCanvas'), ctx = c.getContext('2d');
    const n = Photo.aiNuts()[0], d = c.width / Photo.state().W;
    const x = Math.round(n.x * d), y = Math.round(n.y * d), rad = Math.round(n.r * d);
    const box = ctx.getImageData(Math.max(0, x - rad - 6), Math.max(0, y - rad - 6), rad * 2 + 12, rad * 2 + 12).data;
    let violet = 0;
    for (let i = 0; i < box.length; i += 4) if (box[i] > 150 && box[i + 2] > 180 && box[i + 1] < box[i + 2] + 30) violet++;
    return { violet, x, y, rad };
  });
  assert.ok(painted.violet > 20, 'violet AI circles drawn on the photo: ' + painted.violet + ' px near ' + painted.x + ',' + painted.y);
  await page.evaluate(() => { const sc = document.querySelector('#viewPhoto .scroll'); sc.scrollTop = 0; });
  await sleep(250);
  await page.screenshot({ path: path.join(SHOTS, 'ai-result.png') });
  assert.equal(await aiButtonHit(), true, 'the AI count button is reachable on the phone screen (not under the sticky photo)');
  ok(`AI result drawn: 9 violet detections, count 9 / 87% / gpt-4.1-mini / server note, on-phone ${res.phone} vs AI 9 side by side, device counter "1"`);

  // ---- tap correction on top of the AI result ----
  const tap = await page.evaluate(async () => {
    // tap in WORKING-COPY coordinates (st.W x st.H), which is the space the app maps a click into
    const c = document.getElementById('phCanvas'), bb = c.getBoundingClientRect(), S = Photo.state();
    const at = (x, y) => c.dispatchEvent(new MouseEvent('click', { clientX: bb.left + x * bb.width / S.W, clientY: bb.top + y * bb.height / S.H, bubbles: true }));
    const before = Photo.aiCount();
    const d0 = Photo.aiNuts()[0];
    at(d0.x, d0.y);                                                       // remove the AI's first nut
    const afterRemove = Photo.aiCount(), cardAfterRemove = document.getElementById('phAiRes').textContent;
    at(3, 3);                                                             // add one the AI missed
    const afterAdd = Photo.aiCount(), phone = Photo.count();
    await new Promise(r => setTimeout(r, 120));
    return { before, afterRemove, afterAdd, phone, src: Photo.src(), active: Photo.activeCount(), cardAfterRemove,
      barAi: document.getElementById('phSrcAi').textContent, card: document.getElementById('phAiRes').textContent,
      big: document.getElementById('phN').textContent };
  });
  assert.equal(tap.afterRemove, tap.before - 1, 'tapping an AI circle removes it');
  assert.equal(tap.afterAdd, tap.afterRemove + 1, 'tapping elsewhere adds a nut to the AI list');
  assert.equal(tap.active, tap.afterAdd, 'the corrected AI count is the active one');
  assert.equal(tap.barAi, String(tap.afterAdd), 'the AI side of the bar follows the correction');
  assert.equal(tap.big, String(tap.afterAdd), 'the big number is the corrected AI count');
  assert.ok(/AI found 9, you corrected -1/.test(tap.cardAfterRemove), 'the card tracks the correction: ' + tap.cardAfterRemove);
  assert.ok(!/you corrected/.test(tap.card), 'back to 9 after one removed + one added, so no correction line: ' + tap.card);
  assert.equal(tap.phone, tap.phone, 'on-phone count still available');
  // the AI filter never blocks the on-phone bench: change a filter and the on-phone count keeps updating
  const bench = await page.evaluate(async () => {
    document.querySelector('.ph-filters [data-f="brown"]').click();
    await new Promise(r => setTimeout(r, 700));
    const phone = Photo.count(), ai = Photo.aiCount(), active = Photo.activeCount(), src = Photo.src();
    document.querySelector('.ph-filters [data-f="green"]').click();
    await new Promise(r => setTimeout(r, 700));
    return { phone, ai, active, src, stillAi: !!Photo.ai() && Photo.ai().status === 'ok' };
  });
  assert.ok(bench.stillAi, 'the AI result survives a filter change');
  assert.ok(bench.ai > 0, 'the AI list is untouched by the filters: ' + bench.ai);
  assert.equal(bench.src, 'ai', 'AI stays selected while the filters run');
  ok(`tap correction on top of AI (${tap.before}→${tap.afterRemove}→${tap.afterAdd}); filters keep running (on-phone ${bench.phone}) without touching the AI result`);

  // switch back to the on-phone count and back again
  const sw = await page.evaluate(async () => {
    Photo.src('phone'); await new Promise(r => setTimeout(r, 120));
    const a = { src: Photo.src(), active: Photo.activeCount(), phone: Photo.count(), saving: document.getElementById('phSaving').textContent, out: document.getElementById('phOut').textContent };
    Photo.src('ai');
    return { a, b: Photo.src() };
  });
  assert.equal(sw.a.src, 'phone'); assert.equal(sw.a.active, sw.a.phone); assert.ok(/on-phone count/.test(sw.a.saving));
  assert.ok(/Count used \(on-phone count\)/.test(sw.a.out), sw.a.out);
  assert.equal(sw.b, 'ai');
  ok('the side-by-side selector switches which count is used and says which one saves');

  // ---- save: the mark and the upload payload carry the corrected AI count ----
  const saved = await page.evaluate(() => {
    const n = Photo.aiCount(), phone = Photo.count();
    document.getElementById('phSave').click();
    const m = App.state().marks.slice(-1)[0], up = window.Upload && window.Upload.markPayload(m);
    return { n, phone, m: { photoCount: m.photoCount, src: m.photoCountSrc, aiCount: m.aiCount, aiPhotoCount: m.aiPhotoCount, aiKgHa: m.aiKgHa,
      estNutsPerTree: m.estNutsPerTree, estKgHa: m.estKgHa, rating: m.rating, phoneCount: m.phoneCount, aiModel: m.aiModel, aiConfidence: m.aiConfidence }, up };
  });
  assert.equal(saved.m.photoCount, saved.n, 'saved photoCount is the corrected AI count');
  assert.equal(saved.m.src, 'ai'); assert.equal(saved.m.aiPhotoCount, saved.n); assert.equal(saved.m.phoneCount, saved.phone);
  assert.equal(saved.m.aiCount, 9, 'the raw AI count is kept too'); assert.equal(saved.m.aiModel, 'gpt-4.1-mini'); assert.ok(saved.m.aiConfidence > 0.8);
  assert.ok(saved.m.estNutsPerTree > 0 && saved.m.estKgHa > 0 && saved.m.rating, 'yield maths from the AI count');
  assert.equal(saved.up.photoCount, saved.n, 'upload payload carries the AI count as photoCount');
  assert.equal(saved.up.photoCountSrc, 'ai'); assert.equal(saved.up.aiCount, 9); assert.equal(saved.up.aiPhotoCount, saved.n);
  assert.equal(saved.up.aiModel, 'gpt-4.1-mini'); assert.equal(saved.up.estKgHa, saved.m.estKgHa);
  ok(`saved mark + upload payload carry the corrected AI count (${saved.n} vs on-phone ${saved.phone}), raw AI 9, model, confidence, estNutsPerTree/estKgHa/${saved.m.rating}`);

  // ---- a new photo drops the old AI result (it was measured on the old frame) and saves the on-phone count ----
  const fresh = await page.evaluate(async () => {
    const im = new Image(); im.src = 'tests/photos/p2.jpg'; await im.decode();
    Photo.setImage(im, { ts: Date.now(), pos: App.lastPos(), row: '4', tree: '2', block: 'Block 7', variety: 'A16' });
    await new Promise(r => setTimeout(r, 1000));
    const a = { ai: Photo.ai(), src: Photo.src(), active: Photo.activeCount(), phone: Photo.count(),
      barHidden: document.getElementById('phSrc').classList.contains('hidden'), cardHidden: document.getElementById('phAiRes').classList.contains('hidden'),
      badgeHidden: document.getElementById('phAiBadge').classList.contains('hidden') };
    document.getElementById('phSave').click();
    const m = App.state().marks.slice(-1)[0];
    return { a, saved: { photoCount: m.photoCount, src: m.photoCountSrc, aiCount: m.aiCount } };
  });
  assert.equal(fresh.a.ai, null, 'AI result cleared with the photo it belonged to');
  assert.equal(fresh.a.src, 'phone'); assert.equal(fresh.a.active, fresh.a.phone);
  assert.ok(fresh.a.barHidden && fresh.a.cardHidden && fresh.a.badgeHidden, 'AI furniture hidden again');
  assert.equal(fresh.saved.photoCount, fresh.a.phone, 'the on-phone count is what saves without an AI result');
  assert.equal(fresh.saved.src, 'phone'); assert.equal(fresh.saved.aiCount, undefined);
  ok('load a different photo -> old AI result dropped, on-phone count saves (photoCountSrc phone, no aiCount)');

  // ---- 503: clear "not switched on yet" message, on-phone result intact ----
  mode = '503';
  const r503 = await page.evaluate(async () => {
    document.getElementById('phAi').click();
    await new Promise(r => setTimeout(r, 1200));
    return { note: document.getElementById('phAiNote').textContent, toast: document.getElementById('toast').textContent,
      status: Photo.ai() && Photo.ai().status, phone: Photo.count(), src: Photo.src(), busy: Photo.aiBusy(),
      barHidden: document.getElementById('phSrc').classList.contains('hidden'), counter: document.getElementById('phAiCount').textContent };
  });
  assert.ok(/AI counting is not switched on yet - add the OpenAI key in AgronicaWorld/.test(r503.note), r503.note);
  assert.ok(/add the OpenAI key in AgronicaWorld/.test(r503.toast), r503.toast);
  assert.equal(r503.status, 'err'); assert.equal(r503.busy, false, 'busy state cleared after a failure');
  assert.ok(r503.phone > 0, 'on-phone count still there after 503: ' + r503.phone);
  assert.equal(r503.src, 'phone', 'falls back to the on-phone count');
  ok('503 -> "AI counting is not switched on yet - add the OpenAI key in AgronicaWorld", busy cleared, on-phone count kept');

  // ---- 429: shows the wait ----
  mode = '429';
  const r429 = await page.evaluate(async () => {
    document.getElementById('phAi').click();
    await new Promise(r => setTimeout(r, 1200));
    return { note: document.getElementById('phAiNote').textContent, status: Photo.ai() && Photo.ai().status, phone: Photo.count() };
  });
  assert.ok(/wait 42 s/.test(r429.note), 'wait taken from the error text when Retry-After is not exposed: ' + r429.note);
  assert.ok(/on-phone/.test(r429.note), r429.note);
  assert.equal(r429.status, 'err'); assert.ok(r429.phone > 0);
  mode = '429x';
  const r429b = await page.evaluate(async () => {
    document.getElementById('phAi').click();
    await new Promise(r => setTimeout(r, 1200));
    return { note: document.getElementById('phAiNote').textContent };
  });
  assert.ok(/wait 7 s/.test(r429b.note), 'Retry-After used when the server exposes it: ' + r429b.note);
  ok('429 -> "Too many AI counts - wait 42 s, or carry on with the on-phone count" (header or error-text fallback)');

  // ---- 413 then a smaller retry that succeeds ----
  mode = '413once';
  const before413 = calls.length;
  const r413 = await page.evaluate(async () => {
    document.getElementById('phAi').click();
    await new Promise(r => setTimeout(r, 2500));
    const a = Photo.ai();
    return { status: a && a.status, count: a && a.count, retried: a && a.retried, sent: a && a.sent, src: Photo.src(), note: document.getElementById('phAiNote').textContent };
  });
  assert.equal(r413.status, 'ok', 'the retry succeeded');
  assert.equal(r413.retried, true, 'marked as retried');
  assert.equal(r413.sent.edge, 1200, 'the retry used the smaller 1200 px image');
  assert.equal(calls.length, before413 + 2, 'two POSTs: the 413 and the smaller retry');
  const retryCall = calls[calls.length - 1];
  assert.equal(Math.max(retryCall.dims.w, retryCall.dims.h), 1200, 'retry image is 1200 px: ' + retryCall.dims.w + 'x' + retryCall.dims.h);
  assert.ok(retryCall.imgBytes < calls[calls.length - 2].imgBytes, `retry is smaller: ${retryCall.imgBytes} < ${calls[calls.length - 2].imgBytes}`);
  ok(`413 -> automatic single retry at 1200 px (${Math.round(retryCall.imgBytes / 1024)} kB vs ${Math.round(calls[calls.length - 2].imgBytes / 1024)} kB) which succeeds`);

  // ---- 502: model failure keeps the on-phone result and says so ----
  mode = '502';
  const r502 = await page.evaluate(async () => {
    document.getElementById('phAi').click();
    await new Promise(r => setTimeout(r, 1200));
    return { note: document.getElementById('phAiNote').textContent, status: Photo.ai() && Photo.ai().status, phone: Photo.count(), src: Photo.src() };
  });
  assert.ok(/The AI model failed on this photo - the on-phone count is still here/.test(r502.note), r502.note);
  assert.equal(r502.status, 'err'); assert.ok(r502.phone > 0); assert.equal(r502.src, 'phone');
  ok('502 -> "The AI model failed on this photo - the on-phone count is still here"');

  // ---- network failure behaves like 502, and never throws unhandled ----
  const net = await page.evaluate(async () => {
    const real = window.AICount.count;
    window.AICount.count = () => Promise.reject(Object.assign(new Error('Failed to fetch'), { status: 0 }));
    document.getElementById('phAi').click();
    await new Promise(r => setTimeout(r, 400));
    const a = { note: document.getElementById('phAiNote').textContent, status: Photo.ai() && Photo.ai().status, busy: Photo.aiBusy(), phone: Photo.count() };
    window.AICount.count = real;
    return a;
  });
  assert.ok(/on-phone count is still here/.test(net.note), net.note);
  assert.equal(net.busy, false); assert.ok(net.phone > 0);
  ok('network failure -> same graceful path, on-phone result kept, no stuck spinner');

  // ---- the "don't show again" box hides the notice for good (survives a reload) ----
  mode = 'ok';
  await page.evaluate(() => { const c = document.getElementById('phAiDontShow'); c.checked = true; document.getElementById('phAiDismiss').click(); });
  assert.ok(await page.evaluate(() => document.getElementById('phAiCost').classList.contains('hidden')), 'notice hidden after "Got it"');
  assert.ok(await page.evaluate(() => YM_CONFIG && window.AICount.noticeSeen()), 'remembered on this phone');
  const reloaded = await page.evaluate(() => localStorage.getItem('myl-ai-notice-v1'));
  assert.equal(reloaded, 'true');
  ok('cost notice dismissed with "don\'t show again" and remembered (localStorage on this phone)');

  // ---- the device counter accumulates across calls, and survives a reload ----
  const before = (await page.evaluate(() => window.AICount.stats())).calls;
  await page.evaluate(() => new Promise(res => { document.getElementById('phAi').click(); setTimeout(res, 2200); }));
  const after = await page.evaluate(() => ({ s: window.AICount.stats(), txt: document.getElementById('phAiCount').textContent }));
  assert.equal(after.s.calls, before + 1, 'counter incremented');
  assert.ok(new RegExp('AI counts from this phone: ' + after.s.calls).test(after.txt), after.txt);
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(400);
  const persisted = await page.evaluate(() => ({ s: window.AICount.stats(), costHidden: document.getElementById('phAiCost').classList.contains('hidden'), txt: document.getElementById('phAiCount').textContent }));
  assert.equal(persisted.s.calls, after.s.calls, 'count survives a reload');
  assert.ok(persisted.costHidden, 'notice stays dismissed after a reload');
  ok(`running device counter: ${after.s.calls} AI counts (about ${after.s.cents}c), persisted across reload, notice stays dismissed`);

  // ---- photo-size screenshots of the AI result with detections drawn (390 x 844 @2x) ----
  await page.click('#tabMark'); await page.click('#startStop');
  await page.waitForFunction(() => document.querySelector('#status b').textContent === 'GPS OK', { timeout: 10000 });
  await page.click('#tabPhoto'); await sleep(250);
  await page.evaluate(async () => {
    const im = new Image(); im.src = 'tests/photos/p4.jpg'; await im.decode();
    Photo.setImage(im, { ts: Date.now(), pos: App.lastPos(), row: '3', tree: '12', block: 'Block 7', variety: 'A16' });
    await new Promise(r => setTimeout(r, 900));
  });
  await scrollTop(0);
  await clickAi();
  await page.waitForFunction(() => Photo.ai() && Photo.ai().status === 'ok', { timeout: 15000 });
  await sleep(600);
  const shotA = path.join(SHOTS, 'myl-v4-ai-count.png');
  await page.screenshot({ path: shotA });
  // scrolled to the side-by-side counts + the AI card, photo still in view under the sticky stage
  await page.evaluate(() => {
    const pane = document.querySelector('#viewPhoto .scroll'), s = document.getElementById('phSrc');
    pane.scrollTop += s.getBoundingClientRect().top - 470;
  });
  await sleep(350);
  const shotB = path.join(SHOTS, 'myl-v4-ai-result.png');
  await page.screenshot({ path: shotB });
  // and the AI card itself (count, confidence, model, server note) under the button
  await page.evaluate(() => {
    const pane = document.querySelector('#viewPhoto .scroll'), c = document.getElementById('phAiRes');
    const stage = document.getElementById('phStage').getBoundingClientRect();
    pane.scrollTop += c.getBoundingClientRect().top - stage.bottom - 12;
  });
  await sleep(350);
  const shotC = path.join(SHOTS, 'myl-v4-ai-card.png');
  await page.screenshot({ path: shotC });
  fs.readdirSync(SHOTS).filter(f => /^myl-v4-ai-.*\.png$/.test(f)).forEach(f => { try { fs.copyFileSync(path.join(SHOTS, f), '/workspace/' + f); } catch (e) {} });
  assert.ok([shotA, shotB, shotC].every(f => fs.statSync(f).size > 30000), 'screenshots written: ' + [shotA, shotB, shotC].join(', '));
  ok('phone-size screenshots (390x844 @2x): /workspace/myl-v4-ai-count.png, myl-v4-ai-result.png, myl-v4-ai-card.png');

  // ---- layout: the AI block does not overlap or run off-screen at 390x844 / 360x640 ----
  for (const [w, h] of [[390, 844], [360, 640]]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(350);
    const lay = await page.evaluate(() => {
      const pane = document.querySelector('#viewPhoto .scroll').getBoundingClientRect();
      const stage = document.getElementById('phStage').getBoundingClientRect();
      const els = [...document.querySelectorAll('#viewPhoto button, #viewPhoto input, #viewPhoto select')].filter(e => {
        if (!e.offsetParent || e.type === 'hidden') return false;
        const b = e.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) return false;
        // content scrolled under the sticky photo stage is not visible (and not an overlap): only count what is
        // fully inside the pane AND either inside the stage itself or clear of it
        if (b.bottom > pane.bottom - 1 || b.top < pane.top + 1) return false;
        return e.closest('#phStage') ? true : b.top >= stage.bottom + 1;
      });
      const R = els.map(e => { const b = e.getBoundingClientRect(); return { id: e.id || e.getAttribute('data-src') || e.getAttribute('data-f') || e.className, x: b.left, y: b.top, w: b.width, h: b.height }; });
      const bad = [];
      for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
        const a = R[i], b = R[j];
        if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) bad.push(a.id + ' x ' + b.id);
      }
      const off = R.filter(a => a.x < -1 || a.x + a.w > innerWidth + 1).map(a => a.id);
      const heights = ['phAi', 'phAiDismiss'].map(id => { const e = document.getElementById(id); return e.offsetParent ? Math.round(e.getBoundingClientRect().height) : -1; })
        .filter(x => x >= 0);      // the dismiss button only exists while the cost notice is up
      return { n: R.length, bad, off, heights };
    });
    assert.deepEqual(lay.bad, [], w + 'x' + h + ' AI overlaps: ' + lay.bad.join(', '));
    assert.deepEqual(lay.off, [], w + 'x' + h + ' AI off-screen: ' + lay.off.join(', '));
    assert.ok(lay.heights.length && lay.heights.every(x => x >= 32), w + 'x' + h + ' AI buttons too small: ' + lay.heights);
    ok(`${w}x${h}: AI block lays out with no overlaps (${lay.n} controls, AI button ${lay.heights[0]} px)`);
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(300);

  // ---- config blanked: the button is disabled and says why, everything else works ----
  const page2 = await b.newPage();
  await page2.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page2.setRequestInterception(true);
  page2.on('request', r => {
    if (/\/config\.js(\?|$)/.test(r.url())) return r.respond({ status: 200, contentType: 'application/javascript',
      body: "window.YM_CONFIG={INGEST_URL:'',INGEST_KEY:'',INGEST_URL_PLACEHOLDER:'',AI_COUNT_URL:'',FARM:'',APP_VERSION:'v4'};" });
    r.continue();
  });
  if (page2.setBypassServiceWorker) await page2.setBypassServiceWorker(true);
  await page2.goto(BASE, { waitUntil: 'networkidle0' });
  await page2.click('#tabPhoto'); await sleep(300);
  const blank2 = await page2.evaluate(() => ({ disabled: document.getElementById('phAi').disabled, note: document.getElementById('phAiNote').textContent,
    costHidden: document.getElementById('phAiCost').classList.contains('hidden'), srcHidden: document.getElementById('phSrc').classList.contains('hidden'),
    counterHidden: document.getElementById('phAiCount').classList.contains('hidden'), count: Photo.count() }));
  assert.equal(blank2.disabled, true, 'AI button disabled while AI_COUNT_URL is blank');
  assert.ok(/AI count .*is off - set AI_COUNT_URL in config\.js/.test(blank2.note), blank2.note);
  assert.ok(blank2.costHidden && blank2.srcHidden && blank2.counterHidden, 'no AI furniture when AI is not configured');
  await page2.close();
  ok('config.js blanked: AI button disabled with a plain explanation, no cost line, no side-by-side bar, photo tab otherwise normal');

  // ---- downscale never upscales, keeps the aspect, and always encodes JPEG ----
  const ds = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 900; c.height = 640;
    const x = c.getContext('2d'); x.fillStyle = '#3a6'; x.fillRect(0, 0, 900, 640);
    const small = await AICount.downscale(c, 1600, 0.85);          // smaller than the target: left alone
    const big = await AICount.downscale(c, 300, 0.5);              // forced down: 300 px long edge
    return { small: { w: small.w, h: small.h, type: small.blob.type, bytes: small.blob.size },
      big: { w: big.w, h: big.h, type: big.blob.type, bytes: big.blob.size }, edge: AICount.EDGE };
  });
  assert.equal(ds.small.w, 900); assert.equal(ds.small.h, 640); assert.equal(ds.small.type, 'image/jpeg');
  assert.equal(ds.big.w, 300); assert.equal(ds.big.h, Math.round(640 * 300 / 900));
  ok(`downscale helper: ${ds.small.w}x${ds.small.h} left alone at the ${ds.edge} px limit, ${ds.big.w}x${ds.big.h} when forced smaller, always JPEG`);

  // ---- Macca answers the AI cost question offline ----
  const faq = await page.evaluate(() => {
    const q = ['how much does ai cost', 'what does the ai count cost per photo', 'ai count is not switched on'];
    return q.map(x => ({ q: x, a: Extras.answer(x) }));
  });
  faq.forEach(r => assert.ok(r.a.faq && r.a.faq.id === 'aiphoto', r.q + ' -> ' + JSON.stringify(r.a.faq && r.a.faq.id)));
  assert.ok(/3c a photo/.test(faq[0].a.text) && /OpenAI account/.test(faq[0].a.text), faq[0].a.text);
  assert.ok(/on-phone count/.test(faq[1].a.text), 'the cost answer points back to the free on-phone count');
  assert.ok(/on-phone/.test(faq[2].a.text), 'the "not switched on" question resolves to the AI answer');
  ok('Macca FAQ: AI cost / "not switched on" answers resolve to the AI topic with the 3c + on-phone wording');

  assert.deepEqual(errors, [], errors.join('\n'));
  ok('no page errors');
  console.log(`\n${passed} AI count checks passed`);
  await b.close(); srv.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
