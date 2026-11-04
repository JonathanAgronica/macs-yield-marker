// Headless Chrome UI test (390x844 phone) with simulated GPS driving along a row.
// Run: (python3 -m http.server 8231 &) ; NODE_PATH=/workspace/testenv/node_modules node tests/ui.test.js [baseUrl] [shotDir]
const puppeteer = require('puppeteer-core');
const fs = require('fs'), path = require('path'), assert = require('assert');
const { DOMParser } = require('@xmldom/xmldom');
const Y = require('../yield.js');
const tileStub = require('./tile-stub.js');
const BASE = process.argv[2] || 'http://localhost:8231/';
const SHOTS = process.argv[3] || '/tmp/myl-test-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const DL = fs.mkdtempSync('/tmp/myl-dl-');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = { lat: -24.98, lon: 152.38 };
const north = (m, east = 0) => ({ latitude: T0.lat + m / 111320, longitude: T0.lon + east / (111320 * Math.cos(T0.lat * Math.PI / 180)), accuracy: 3 });
let passed = 0; const ok = (name) => { passed++; console.log('ok -', name); };

(async () => {
  const tiles = await tileStub.start();
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(new URL(BASE).origin, ['geolocation']);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_FILE_NOT_FOUND/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.evaluateOnNewDocument((u) => { try { localStorage.setItem('myl-tile-url', u); } catch (e) {} window.__vib = []; navigator.vibrate = p => { window.__vib.push(p); return true; };
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true }); }, tiles.imagery);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // config.js is stubbed with upload DISABLED: this test must never post marks to the live AgronicaWorld ingest
  await page.setRequestInterception(true);
  page.on('request', r => {
    if (/\/config\.js(\?|$)/.test(r.url())) return r.respond({ status: 200, contentType: 'application/javascript',
      body: "window.YM_CONFIG={INGEST_URL:'',INGEST_KEY:'',INGEST_URL_PLACEHOLDER:'',AI_COUNT_URL:'',FARM:'',APP_VERSION:'v3'};" });
    r.continue();
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await page.setGeolocation(north(0));
  await page.goto(BASE, { waitUntil: 'networkidle0' });

  // ---- layout: nothing overlaps at 390x844, rating buttons are big ----
  const lay = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#viewMark button, #viewMark input, #viewMark select, .tabs button, #adbar')].filter(e => e.offsetParent && getComputedStyle(e).visibility !== 'hidden');
    const r = els.map(e => { const b = e.getBoundingClientRect(); return { id: e.id || e.className || e.tagName, x: b.left, y: b.top, w: b.width, h: b.height }; });
    const bad = [];
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) { const a = r[i], b = r[j]; if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) bad.push(a.id + ' x ' + b.id); }
    const off = r.filter(a => a.x < -0.5 || a.y < -0.5 || a.x + a.w > innerWidth + 0.5 || a.y + a.h > innerHeight + 0.5).map(a => a.id);
    const rate = [...document.querySelectorAll('#rateBtns .rate')].map(e => e.getBoundingClientRect()).map(b => ({ w: b.width, h: b.height }));
    return { n: r.length, bad, off, rate };
  });
  assert.deepEqual(lay.bad, [], 'overlaps: ' + lay.bad.join(', ')); assert.deepEqual(lay.off, [], 'off-screen: ' + lay.off);
  assert.equal(lay.rate.length, 5); lay.rate.forEach(b => { assert.ok(b.h >= 60, 'rating button height ' + b.h); assert.ok(b.w >= 350); });
  ok(`no overlaps among ${lay.n} controls at 390x844; rating buttons ${Math.round(lay.rate[0].w)}x${Math.round(lay.rate[0].h)} px`);
  // smaller phones: layout must not overlap and rating buttons stay thumb-sized
  for (const [w, h] of [[360, 640], [375, 667], [412, 915]]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(300);
    const r = await page.evaluate(() => {
      const els = [...document.querySelectorAll('#viewMark button, #viewMark input, #viewMark select, .tabs button')].filter(e => e.offsetParent);
      const R = els.map(e => { const b = e.getBoundingClientRect(); return { id: e.id || e.className, x: b.left, y: b.top, w: b.width, h: b.height }; });
      const bad = [];
      for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) { const a = R[i], b = R[j]; if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) bad.push(a.id + ' x ' + b.id); }
      return { bad, rate: [...document.querySelectorAll('#rateBtns .rate')].map(e => Math.round(e.getBoundingClientRect().height)) };
    });
    assert.deepEqual(r.bad, [], w + 'x' + h + ' overlaps: ' + r.bad.join(', ')); assert.ok(Math.min(...r.rate) >= 48, w + 'x' + h + ' rating buttons too small: ' + r.rate);
    ok(`${w}x${h}: no overlaps, rating buttons ${r.rate[0]} px tall`);
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(300);

  // ---- session + one-tap rating ----
  await page.type('#block', 'Block 7'); await page.select('#variety', 'A16');
  await page.evaluate(() => { const s = App.state(); s.settings.spacing['Block 7'] = 4; App.save(); });
  await page.click('#startStop');
  await page.waitForFunction(() => document.querySelector('#status b').textContent === 'GPS OK', { timeout: 10000 });
  for (const r of ['vhigh', 'high', 'medium', 'low', 'nil']) { await page.click(`[data-rate="${r}"]`); await sleep(120); }
  let st = await page.evaluate(() => App.state());
  assert.deepEqual(st.marks.map(m => m.rating), ['vhigh', 'high', 'medium', 'low', 'nil']);
  assert.ok(st.marks.every(m => m.block === 'Block 7' && m.variety === 'A16' && m.row === '1' && Math.abs(m.lat - T0.lat) < 1e-6));
  assert.ok((await page.evaluate(() => window.__vib.length)) >= 5, 'vibration feedback');
  ok('five one-tap ratings saved at the GPS point with block/variety/row + vibration');
  await sleep(700); await page.screenshot({ path: path.join(SHOTS, 'myl-v1-mark.png') });

  // ---- drive along the row: trees counted by distance, prompt every 10 trees ----
  let d = 0;
  async function driveTo(m, east = 0) { while (d < m) { d = Math.min(m, d + 8); await page.setGeolocation(north(d, east)); await sleep(2050); } }
  await driveTo(56);
  await page.waitForSelector('#est:not(.hidden)', { timeout: 6000 });
  const head = await page.$eval('#estTitle', e => e.textContent); assert.equal(head, 'Trees 1-10');
  await page.screenshot({ path: path.join(SHOTS, 'myl-v1-estimate.png') });
  await page.click('[data-est="4"]');
  ok('tree count from distance (4 m spacing) triggered the 10-tree prompt; tapped 4');
  await driveTo(100); await page.waitForSelector('#est:not(.hidden)', { timeout: 6000 });
  assert.equal(await page.$eval('#estTitle', e => e.textContent), 'Trees 11-20'); await page.click('#estSkip');
  assert.ok((await page.evaluate(() => App.state().track.length)) > 5, 'GPS track kept running during prompts');
  await driveTo(144); await page.waitForSelector('#est:not(.hidden)', { timeout: 6000 }); await page.click('[data-est="2"]');
  st = await page.evaluate(() => App.state());
  const ests = st.marks.filter(m => m.treeFrom); assert.equal(ests.length, 3);
  assert.deepEqual(ests.map(m => [m.treeFrom, m.treeTo, m.estimate != null]), [[1, 10, true], [11, 20, true], [21, 30, true]]);
  assert.equal(ests[0].rating, 'high'); assert.equal(ests[1].interpolated, true); assert.ok(ests[1].rating, 'skipped segment interpolated from neighbours'); assert.ok(ests[1].estimate > 2 && ests[1].estimate < 4);
  ok('estimates saved with treeFrom/treeTo; skipped segment stored interpolated = ' + ests[1].estimate);
  // tree +1 override, row change resets
  const t0 = await page.evaluate(() => Math.floor(App.state().trees)); await page.click('#treeUp'); assert.equal(await page.evaluate(() => Math.floor(App.state().trees)), t0 + 1);
  await page.click('#rowUp'); st = await page.evaluate(() => App.state()); assert.equal(st.row, 2); assert.equal(Math.floor(st.trees), 0); assert.equal(await page.$eval('#rowVal', e => e.textContent), '2');
  ok('Tree +1 override and row + (resets tree count)');
  // auto row: U-turn detection
  await page.evaluate(() => { const s = App.state(); s.row = 2; s.trees = 0; s.lastPromptTree = 0; s.settings.autoRow = true; s.settings.every = 0; App.save(); App.setTrees(0); });
  await driveTo(176); await sleep(2200);                       // still heading north
  for (let i = 1; i <= 3; i++) { await page.setGeolocation(north(176 - i * 8)); await sleep(2100); }
  await sleep(1200);
  assert.equal(await page.evaluate(() => App.state().row), 3, 'auto row after U-turn');
  const tr0 = await page.evaluate(() => App.state().trees);
  assert.ok(tr0 < 3, 'tree count reset on auto row (was 1-2 trees past the turn, got ' + tr0 + ')');
  await page.evaluate(() => { App.state().settings.every = 10; App.save(); });
  ok('auto row +1 detected from the U-turn heading, tree count reset');

  // ---- count / bin weight keypad ----
  await page.click('#btnCount'); await page.waitForSelector('#pad:not(.hidden)');
  for (const k of ['1', '2', '3']) await page.click(`#keys [data-k="${k}"]`);
  await page.click('#pad [data-unit="kg"]'); for (const k of ['4', '5', '.', '5']) await page.click(`#keys [data-k="${k}"]`);
  await page.click('#padSave'); st = await page.evaluate(() => App.state()); const cm = st.marks[st.marks.length - 1];
  assert.equal(cm.count, 123); assert.equal(cm.kg, 45.5); assert.equal(cm.row, String(await page.evaluate(() => App.state().row)));
  ok('count / weight keypad saved 123 nuts + 45.5 kg at the GPS point');
  await page.click('#btnCount'); await page.click('#pad [data-unit="kg"]'); for (const k of ['3', '9', '0']) await page.click(`#keys [data-k="${k}"]`); await page.click('#padSave');
  // undo
  let n0 = (await page.evaluate(() => App.state().marks.length)); await page.click('#undo'); assert.equal(await page.evaluate(() => App.state().marks.length), n0 - 1);
  await page.click('#btnCount'); await page.click('#pad [data-unit="kg"]'); for (const k of ['3', '9', '0']) await page.click(`#keys [data-k="${k}"]`); await page.click('#padSave');
  ok('undo removes last mark');
  // edit + delete via Summary
  await page.click('#tabSum'); await sleep(200);
  const sum = await page.$eval('#sumBody', e => e.textContent); assert.ok(/Total weight435\.5 kg/.test(sum), sum); assert.ok(/Average weight217\.75 kg/.test(sum));
  const lastNil = st.marks.find(m => m.rating === 'nil').id;
  await page.click(`#list li[data-id="${lastNil}"] [data-act="edit"]`); await page.click('#padRate [data-r="medium"]'); await page.click('#padSave');
  assert.equal(await page.evaluate(id => App.state().marks.find(m => m.id === id).rating, lastNil), 'medium');
  const first = st.marks[0].id; await page.click(`#list li[data-id="${first}"] [data-act="del"]`); assert.equal(await page.evaluate(id => !!App.state().marks.find(m => m.id === id), first), false);
  ok('summary totals (435.5 kg, avg 217.75 kg); edit rating and delete from list');
  await page.screenshot({ path: path.join(SHOTS, 'myl-v1-summary.png') });

  // ---- map colours + heat layer ----
  await page.click('#tabMap'); await sleep(900);
  const map = await page.evaluate(() => { const v = App.map(); const c = v.heatCanvas(), g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let painted = 0; for (let i = 3; i < g.length; i += 4) if (g[i] > 0) painted++;
    return { dots: v.dots(), painted, marks: App.state().marks.map(m => ({ id: m.id, rating: m.rating, interp: !!m.interpolated, kg: m.kg })) }; });
  const byId = Object.fromEntries(map.marks.map(m => [m.id, m]));
  const rated = map.dots; assert.ok(rated.length >= 6);
  rated.forEach(dt => { const m = byId[dt.id]; assert.equal(dt.fill, Y.rating(m.rating).color, 'dot colour for ' + m.rating); if (m.interp) assert.ok(dt.op < 0.5, 'interpolated faded'); });
  assert.ok(map.painted > 500, 'heat canvas painted ' + map.painted);
  assert.equal(Y.rating('low').color, '#e53935'); assert.equal(Y.rating('high').color, '#7cb342');
  ok(`rating view: ${rated.length} dots coloured red→amber→green, interpolated faded, heat layer painted ${map.painted} px`);
  await page.evaluate(() => App.map().map.setZoom(18)); await sleep(500);
  await page.screenshot({ path: path.join(SHOTS, 'myl-v1-map.png') });
  await page.click('#viewMap [data-mode="kg"]'); await sleep(300);
  const kd = await page.evaluate(() => ({ dots: App.map().dots(), leg: document.querySelector('#legend').textContent, bar: !!document.querySelector('#legend .lg-bar') }));
  assert.equal(kd.dots.length, 2); assert.ok(kd.bar); assert.ok(/45\.5/.test(kd.leg) && /390 kg/.test(kd.leg), kd.leg);
  assert.deepEqual(kd.dots.map(x => x.fill).sort(), ['#1e9e48', '#e53935']);
  ok('weight view: ramp legend 45.5-390 kg, min red / max green');
  await page.screenshot({ path: path.join(SHOTS, 'myl-v1-map-weight.png') });
  await page.click('#viewMap [data-mode="rating"]');

  // ---- export KML + CSV, re-import with de-dup ----
  await page.click('#tabSum'); await page.select('#sumScope', 'all');
  await page.click('#expKml'); await page.click('#expCsv'); await sleep(1500);
  const files = fs.readdirSync(DL); const kmlF = files.find(f => f.endsWith('.kml')), csvF = files.find(f => f.endsWith('.csv'));
  assert.ok(kmlF && csvF, 'downloads ' + files);
  const kml = fs.readFileSync(path.join(DL, kmlF), 'utf8'), csv = fs.readFileSync(path.join(DL, csvF), 'utf8');
  st = await page.evaluate(() => App.state());
  const km = Y.parseKml(kml, DOMParser).marks; assert.equal(km.length, st.marks.length);
  assert.ok(kml.includes('<color>' + Y.kmlColour('#e53935') + '</color>') && kml.includes('<ExtendedData>') && kml.includes('name="treeFrom"') && kml.includes('name="interpolated"'));
  const cs = Y.parseCsv(csv).marks; assert.equal(cs.length, st.marks.length); assert.ok(csv.startsWith('time,lat,lon,accuracy_m,block,variety,row,tree,'));
  km.forEach(m => { const o = st.marks.find(x => x.id === m.id); assert.ok(o); assert.equal(m.rating, o.rating || ''); assert.equal(m.kg ?? null, o.kg ?? null); assert.equal(m.row, o.row); });
  ok(`exported KML (${km.length} coloured placemarks) + CSV (${cs.length} rows) round-trip`);
  // re-import own file -> all duplicates; then merge a colleague's file into an empty phone
  const r1 = await page.evaluate(k => App.importText(k, 'mine.kml'), kml); assert.equal(r1.added.length, 0); assert.equal(r1.dup, km.length);
  const colleague = Y.buildKml({ marks: [{ id: 'x1', ts: Date.now(), lat: T0.lat + 0.0003, lon: T0.lon, rating: 'high', row: '9', block: 'Block 7' }, km[0]] });
  const r2 = await page.evaluate(k => App.importText(k, 'col.kml'), colleague); assert.equal(r2.added.length, 1); assert.equal(r2.dup, 1);
  const r3 = await page.evaluate(c => App.importText(c, 'mine.csv'), csv); assert.equal(r3.added.length, 0);
  ok('import/merge: own KML all duplicates, colleague KML +1 new / 1 dup, CSV import de-duplicated');

  // ---- upload queue with no URL/key: queued, nothing sent, status says so ----
  const up = await page.evaluate(() => Upload.status()); assert.equal(up.enabled, false); assert.ok(up.pending > 0); assert.match(up.deviceId, /^[0-9a-f-]{36}$/);
  const upTxt = await page.$eval('#sumUp', e => e.textContent); assert.ok(/upload is off/i.test(upTxt), upTxt);
  ok(`upload off without a key (${up.pending} queued for later, device ${up.deviceId.slice(0, 8)}): "${upTxt}"`);

  // ---- About + Macca ----
  await page.click('#tabMark'); await page.click('#aboutLink'); await sleep(800);
  const ab = await page.$eval('#aboutBody', e => e.textContent);
  ['(+61) 475 570 872', 'jonathan@agronicaag.com', 'admin@agronicaag.com', '4468 Goodwood Road, Alloway QLD 4670', 'Joseph Hill', 'CC0'].forEach(s => assert.ok(ab.includes(s), s));
  assert.ok((await page.$eval('#photoCredit a', a => a.href)).includes('commons.wikimedia.org/wiki/File:Macadamia-nut-912598.jpg'), 'photo credit links to the Commons file');
  await page.screenshot({ path: path.join(SHOTS, 'myl-v1-about.png') });
  await page.evaluate(() => { document.getElementById('about').scrollTop = 99999; }); await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, 'myl-v1-about-credit.png') });
  await page.click('#closeAbout'); await page.click('#helpFab'); await sleep(300);
  await page.type('#helpInput', 'what if I miss a 10 tree prompt'); await page.click('#helpSend'); await sleep(500);
  const ans = await page.$$eval('#helpLog .bot .bub', b => b[b.length - 1].textContent); assert.ok(/SKIP|interpolated/i.test(ans), ans);
  assert.equal(await page.$eval('.help-head b', e => e.textContent), 'Macca the Yield Marker Helper');
  await page.screenshot({ path: path.join(SHOTS, 'myl-v1-helper.png') });
  await page.click('#closeHelp');
  ok('About page contacts + photo credit; Macca answers yield FAQ');

  // ---- ad strip ----
  const ad = await page.evaluate(() => ({ vis: !document.getElementById('adbar').classList.contains('hidden'), n: Extras.ads().length }));
  assert.ok(ad.vis && ad.n >= 5); ok('ad strip visible with ' + ad.n + ' ads');

  // ---- Photo count: filter bench, live preview, taps, presets ----
  await page.click('#tabPhoto'); await sleep(200);
  const res = [];
  for (const p of ['p1', 'p2', 'p3', 'p4']) {
    const r = await page.evaluate(async (src) => {
      const im = new Image(); im.src = src; await im.decode();
      Photo.setImage(im, { ts: Date.now(), pos: App.lastPos(), row: '2', tree: '5' }); await new Promise(r => setTimeout(r, 700));
      const out = { filters: {}, views: {} };
      for (const f of ['green', 'brown', 'shape', 'satval', 'hueband', 'lab', 'exg', 'otsu', 'edge']) {
        document.querySelector(`.ph-filters [data-f="${f}"]`).click();
        await new Promise(r => setTimeout(r, 420));
        out.filters[f] = Photo.count();
      }
      document.querySelector('.ph-filters [data-f="green"]').click(); await new Promise(r => setTimeout(r, 420));
      for (const v of ['original', 'highlight', 'compare']) { Photo.view(v); await new Promise(r => setTimeout(r, 200)); out.views[v] = Photo.count(); }
      Photo.view('highlight');
      return out;
    }, 'tests/photos/' + p + '.jpg');
    res.push([p, r]);
    await page.evaluate(() => { const sc = document.querySelector('#viewPhoto .scroll'); sc.scrollTop = document.getElementById('phWrap').offsetTop - 8; }); await sleep(200);
    await page.screenshot({ path: path.join(SHOTS, `myl-v1-photo-${p}.png`) });
  }
  console.log('   photo counts', JSON.stringify(res.map(r => [r[0], r[1].filters])));
  // every filter returns a finite count and the three views agree with each other
  for (const [name, r] of res) {
    for (const [f, c] of Object.entries(r.filters)) assert.ok(Number.isFinite(c) && c >= 0 && c < 4000, `${name} ${f}: ${c}`);
    assert.equal(r.views.original, r.views.highlight, name + ': view tabs must not change the count');
    assert.equal(r.views.compare, r.views.highlight, name + ': compare view must not change the count');
  }
  ok('photo: all 9 filters run on the 4 real photos, and Original / Highlight / Compare agree');

  // ---- every slider drags, the preview/count follows, no errors ----
  await page.evaluate(async () => {
    const im = new Image(); im.src = 'tests/photos/p4.jpg'; await im.decode();
    Photo.setImage(im, { ts: Date.now(), pos: App.lastPos(), row: '2', tree: '5' }); await new Promise(r => setTimeout(r, 900));
    Photo.view('highlight');
  });
  const sliders = [['phThr', [0, 50, 100, 50]], ['phHueMin', [0, 55, 120, 55]], ['phHueMax', [200, 110, 360, 110]], ['phSat', [0, 22, 90, 22]], ['phBri', [0, 25, 90, 25]],
    ['phMin', [3, 14, 60, 14]], ['phMax', [10, 80, 160, 80]], ['phRnd', [0, 45, 100, 45]], ['phSm', [0, 30, 100, 30]], ['phTopN', [0, 5, 20, 0]]];
  const sliderReport = [];
  for (const [id, values] of sliders) {
    const r = await page.evaluate(async (id, values) => {
      const el = document.getElementById(id), seen = [];
      for (const v of values) {
        el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 260));          // one animation frame + the debounce for the full pass
        seen.push({ v, n: Photo.count(), label: document.getElementById(id + 'V').textContent, prev: Photo.state().preview });
      }
      return seen;
    }, id, values);
    const counts = r.map(x => x.n);
    assert.ok(counts.every(c => Number.isFinite(c) && c >= 0), id + ' counts finite: ' + counts.join(','));
    assert.ok(counts.some(c => c > 0), id + ': ' + counts.join(',') + ' never found anything');
    sliderReport.push([id, counts.join('→')]);
  }
  ok('photo: all 10 sliders drag and update count + preview (' + sliderReport.map(r => r[0]).join(', ') + ')');
  console.log('   slider counts', sliderReport.map(r => r[0] + ' ' + r[1]).join(' | '));

  // ---- topN really caps the badge and the visible circles ----
  const topN = await page.evaluate(async () => {
    const el = document.getElementById('phTopN');
    el.value = 6; el.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 500));
    const a = { n: Photo.count(), badge: document.getElementById('phNBadge').textContent, auto: Photo.auto().length };
    el.value = 0; el.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 500));
    return { a, b: Photo.count() };
  });
  assert.equal(topN.a.n, 6, 'best-6 keeps 6'); assert.equal(topN.a.badge, '6', 'badge shows 6'); assert.equal(topN.a.auto, 6, 'only 6 circles');
  assert.ok(topN.b > 6, 'clearing best-N brings the rest back: ' + topN.b);
  ok('photo: "only show best N" caps the count, the live badge and the drawn circles');

  // ---- taps: one tap = one nut; double tap does not add two; taps during a pass are ignored ----
  const tap = await page.evaluate(async () => {
    Photo.view('original');
    const c = document.getElementById('phCanvas'), b = c.getBoundingClientRect();
    const at = (x, y) => c.dispatchEvent(new MouseEvent('click', { clientX: b.left + x * b.width / c.width, clientY: b.top + y * b.height / c.height, bubbles: true }));
    const n0 = Photo.count();
    at(4, 4); const n1 = Photo.count();
    at(4, 4); const n2 = Photo.count();                       // immediate second click at the same spot
    const n3 = (at(6, 6), Photo.count());                     // and a third, close by
    // a genuine second tap elsewhere still counts
    at(c.width - 6, c.height - 6); const n4 = Photo.count();
    // a tap landing on an existing circle removes it (never adds)
    const auto = Photo.auto()[0], bx = auto.x * b.width / c.width, by = auto.y * b.height / c.height;
    c.dispatchEvent(new MouseEvent('click', { clientX: b.left + bx, clientY: b.top + by, bubbles: true })); const n5 = Photo.count();
    return { n0, n1, n2, n3, n4, n5, auto: Photo.auto().length };
  });
  assert.equal(tap.n1, tap.n0 + 1, 'one tap adds exactly one nut');
  assert.equal(tap.n2, tap.n1, 'a double tap does not add a second nut');
  assert.equal(tap.n3, tap.n1, 'a third rapid tap in the same spot is swallowed too');
  assert.equal(tap.n4, tap.n3 + 1, 'a deliberate tap elsewhere still adds one');
  assert.equal(tap.n5, tap.n4 - 1, 'tapping an existing circle removes it instead of adding');
  ok(`photo: taps are one-for-one (${tap.n0}→${tap.n1}→${tap.n2}→${tap.n3}→${tap.n4}→${tap.n5})`);

  // ---- tap while a detection pass is queued must not race it ----
  const race = await page.evaluate(async () => {
    const el = document.getElementById('phThr');
    el.value = 20; el.dispatchEvent(new Event('input', { bubbles: true }));      // queues a preview pass
    const c = document.getElementById('phCanvas'), b = c.getBoundingClientRect();
    const before = Photo.count();
    c.dispatchEvent(new MouseEvent('click', { clientX: b.left + 3, clientY: b.top + 3, bubbles: true }));
    const during = Photo.count();
    await new Promise(r => setTimeout(r, 700));
    const after = Photo.count(), st = Photo.state();
    return { before, during, after, preview: st.preview, auto: Photo.auto().length };
  });
  assert.equal(race.during, race.before, 'a tap during a queued pass is ignored (no nut added, none lost)');
  assert.equal(race.preview, false, 'the full-resolution pass settled after the drag');
  ok('photo: a tap landing while a detection pass is queued is ignored, then the count settles');

  // ---- stale results cannot overwrite a newer photo (generation counter) ----
  const gen = await page.evaluate(async () => {
    const load = src => new Promise(async res => { const im = new Image(); im.src = src; await im.decode(); res(im); });
    const a = await load('tests/photos/p1.jpg'), b = await load('tests/photos/p4.jpg');
    Photo.setImage(a, { ts: 1, pos: App.lastPos(), row: '2', tree: '5' });
    Photo.setImage(b, { ts: 2, pos: App.lastPos(), row: '2', tree: '5' });   // immediately replace the photo
    await new Promise(r => setTimeout(r, 900));
    return { n: Photo.count(), st: Photo.state() };
  });
  assert.ok(gen.n > 0 && gen.st.W > 0, 'the newest photo is the one on screen');
  ok('photo: loading a second photo mid-pass leaves the newest photo and its count on screen');

  // ---- presets: apply a built-in, save one of my own, apply it back ----
  const pres = await page.evaluate(async () => {
    const sel = document.getElementById('phPreset');
    const names = [...sel.options].map(o => o.value).filter(Boolean);
    sel.value = 'Green husk sunny'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const sunny = { filter: Photo.opts.filter, n: Photo.count(), label: sel.value };
    sel.value = 'Dense canopy'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const dense = { filter: Photo.opts.filter, n: Photo.count(), topN: Photo.opts.topN, label: sel.value };
    // save my own preset from the current settings
    Photo.savePreset('Block 7 A16 test');
    await new Promise(r => setTimeout(r, 100));
    const mine = [...document.getElementById('phPreset').options].map(o => o.value);
    return { names, sunny, dense, mine };
  });
  assert.deepEqual(pres.names.slice(0, 4), ['Green husk sunny', 'Green husk overcast', 'Brown fallen', 'Dense canopy'], 'four built-in presets');
  assert.equal(pres.sunny.label, 'Green husk sunny'); assert.equal(pres.dense.topN, 40, 'dense preset applies best-N');
  assert.ok(pres.mine.includes('Block 7 A16 test'), 'my preset is in the list: ' + pres.mine.join(','));
  ok('photo: presets apply (' + pres.sunny.n + ' sunny / ' + pres.dense.n + ' dense) and a custom one saves');

  // ---- the saved mark carries the count through to the upload payload ----
  const payload = await page.evaluate(() => {
    Photo.view('original');
    const n = Photo.count();
    document.getElementById('phSave').click();
    const m = App.state().marks.slice(-1)[0];
    const up = window.Upload && window.Upload.markPayload(m);
    return { n, m: { photoCount: m.photoCount, estNutsPerTree: m.estNutsPerTree, estKgHa: m.estKgHa, rating: m.rating, photoFilter: m.photoFilter, photoPreset: m.photoPreset }, up };
  });
  assert.equal(payload.m.photoCount, payload.n, 'saved photoCount equals the on-screen count');
  assert.ok(payload.m.estNutsPerTree > 0 && payload.m.estKgHa > 0 && payload.m.rating, 'yield maths filled in');
  assert.equal(payload.up.photoCount, payload.n, 'upload payload carries photoCount');
  assert.equal(payload.up.estNutsPerTree, payload.m.estNutsPerTree); assert.equal(payload.up.estKgHa, payload.m.estKgHa);
  ok(`photo: saved mark ${payload.m.photoCount} nuts -> ${payload.m.estKgHa} kg/ha (${payload.m.rating}) and the upload payload carries photoCount/estNutsPerTree/estKgHa`);

  // ---- camera lifecycle: a live stream is stopped on tab change, on visibilitychange, and never leaks ----
  const cam = await page.evaluate(async () => {
    // a stand-in for navigator.mediaDevices.getUserMedia: a canvas-captured stream we can watch being stopped
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2a5'; ctx.fillRect(0, 0, 320, 240);
    const live = canvas.captureStream(10), track = live.getVideoTracks()[0];
    window.__cam = { asked: 0, stopped: 0, live, state: () => track.readyState };
    // canvas captureStream tracks do not fire "ended" on stop(); spy on stop() and read readyState instead
    const realStop = track.stop.bind(track);
    track.stop = () => { window.__cam.stopped++; realStop(); };
    const real = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = () => { window.__cam.asked++; return Promise.resolve(live); };
    document.getElementById('phLive').click();
    await new Promise(r => setTimeout(r, 600));
    const on = { live: Photo.state().live, shutter: !document.getElementById('phShutterRow').hidden, stopped: window.__cam.stopped, ready: track.readyState };
    // leave the tab: the stream must be released
    App.setView('mark'); await new Promise(r => setTimeout(r, 300));
    const off = { live: Photo.state().live, stopped: window.__cam.stopped, videoSrc: !!document.getElementById('phVideo').srcObject, ready: track.readyState };
    // re-enter and start again, then simulate the app going to the background
    App.setView('photo'); await new Promise(r => setTimeout(r, 200));
    document.getElementById('phLive').click(); await new Promise(r => setTimeout(r, 400));
    const again = { live: Photo.state().live, asked: window.__cam.asked };
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 300));
    const bg = { live: Photo.state().live, stopped: window.__cam.stopped, videoSrc: !!document.getElementById('phVideo').srcObject };
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange'));
    // restore, and make sure a permission denial is handled without a live track or an exception
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    Photo.stopLive(); document.getElementById('phLive').click(); await new Promise(r => setTimeout(r, 400));
    const denied = { live: Photo.state().live, shutter: document.getElementById('phShutterRow').hidden, toast: document.getElementById('toast').textContent };
    navigator.mediaDevices.getUserMedia = real;
    return { on, off, again, bg, denied, asked: window.__cam.asked, stopped: window.__cam.stopped };
  });
  assert.ok(cam.on.live && cam.on.shutter, 'live camera starts and shows the capture button');
  assert.equal(cam.on.ready, 'live', 'the track is live while the camera is on');
  assert.equal(cam.off.live, false, 'leaving the Photo tab stops the camera');
  assert.ok(cam.off.stopped >= 1, 'the media track is actually stopped, not just detached');
  assert.equal(cam.off.ready, 'ended', 'the track ends (readyState=ended), so no camera LED stays on');
  assert.equal(cam.off.videoSrc, false, 'the video element is left with no srcObject');
  assert.ok(cam.again.live && cam.asked >= 2, 're-entering the tab and pressing Live works again');
  assert.equal(cam.bg.live, false, 'going to the background stops the camera');
  assert.equal(cam.bg.videoSrc, false, 'and clears srcObject');
  assert.ok(cam.stopped >= 2, 'two tracks stopped in total: ' + cam.stopped);
  assert.equal(cam.denied.live, false, 'permission denial leaves no stream');
  assert.equal(cam.denied.shutter, true, 'the shutter button is hidden after a denial');
  assert.ok(/denied/i.test(cam.denied.toast), 'the user is told the camera was denied: "' + cam.denied.toast + '"');
  ok(`photo: camera stream lifecycle (start, tab-out stop, re-entry, background stop, denial) - ${cam.asked} starts, ${cam.stopped} tracks stopped`);

  // ---- EXIF/portrait: a rotated phone photo is laid out the right way up ----
  const orient = await page.evaluate(async () => {
    // paint "TOP" at the top of a landscape canvas, export it as JPEG, then re-encode with EXIF orientation 6
    // (rotate 90 CW): a browser that honours EXIF shows a portrait image with the text on its right edge.
    const c = document.createElement('canvas'); c.width = 400; c.height = 200;
    const x = c.getContext('2d'); x.fillStyle = '#123'; x.fillRect(0, 0, 400, 200);
    x.fillStyle = '#fff'; x.font = 'bold 60px sans-serif'; x.fillText('TOP', 20, 80);
    const jpeg = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    const buf = new Uint8Array(await jpeg.arrayBuffer());
    // splice an APP1 / EXIF orientation tag in right after SOI
    const exif = [0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,
      0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const out = new Uint8Array(buf.length + exif.length);
    out.set(buf.subarray(0, 2), 0); out.set(exif, 2); out.set(buf.subarray(2), 2 + exif.length);
    const file = new File([out], 'portrait.jpg', { type: 'image/jpeg' });
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    Photo.setImage(bmp, { ts: 1, pos: App.lastPos(), row: '2', tree: '5' });
    await new Promise(r => setTimeout(r, 800));
    const st = Photo.state();
    // read the working canvas back: the "TOP" band must be at the right-hand edge if the EXIF rotation applied
    const cv = document.createElement('canvas'); cv.width = st.W; cv.height = st.H;
    return { w: bmp.width, h: bmp.height, W: st.W, H: st.H, portrait: st.H > st.W, srcW: 400, srcH: 200 };
  });
  assert.ok(orient.portrait, 'a landscape 400x200 file tagged EXIF-6 becomes a portrait working image: ' + orient.W + 'x' + orient.H);
  assert.ok(orient.w === 200 && orient.h === 400, 'createImageBitmap applied the EXIF rotation (' + orient.w + 'x' + orient.h + ')');
  ok(`photo: EXIF orientation is applied (400x200 + orientation 6 -> ${orient.W}x${orient.H} working copy)`);

  // ---- retaking photos does not leak bitmaps, and the screen does not re-render in a loop ----
  const leak = await page.evaluate(async () => {
    let closed = 0;
    const load = src => new Promise(async res => { const im = new Image(); im.src = src; await im.decode(); res(im); });
    const first = await createImageBitmap(await (await fetch('tests/photos/p1.jpg')).blob());
    const realClose = first.close.bind(first);
    first.close = () => { closed++; realClose(); };
    Photo.setImage(first, { ts: 1, pos: App.lastPos(), row: '2', tree: '5' });
    await new Promise(r => setTimeout(r, 500));
    for (let i = 0; i < 3; i++) Photo.setImage(await load('tests/photos/p4.jpg'), { ts: i, pos: App.lastPos(), row: '2', tree: '5' });
    await new Promise(r => setTimeout(r, 900));
    // count repaints over a quiet second (no input): the draw loop must be idle
    let paints = 0; const c = document.getElementById('phCanvas');
    const obs = new MutationObserver(() => paints++); obs.observe(c, { attributes: true, attributeFilter: ['width', 'height'] });
    const html = document.getElementById('phOut').innerHTML;
    await new Promise(r => setTimeout(r, 1000)); obs.disconnect();
    return { closed, paints, outStable: html === document.getElementById('phOut').innerHTML, count: Photo.count() };
  });
  assert.ok(leak.closed >= 1, 'the previous ImageBitmap is released on retake: ' + leak.closed);
  assert.equal(leak.paints, 0, 'no canvas resizes while idle (no repaint loop): ' + leak.paints);
  assert.ok(leak.outStable, 'the results panel is not rewritten when nothing changed');
  ok(`photo: retakes release the old bitmap (${leak.closed} closed), 0 idle repaints, stable results panel`);

  // ---- layout: the photo bench must not overlap at 390x844 or 360x640 ----
  for (const [w, h] of [[390, 844], [360, 640]]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(350);
    const lay = await page.evaluate(() => {
      // only controls inside the visible part of the scrolling photo pane: content scrolled behind the fixed tab bar
      // is not an overlap, it is just scrolled content
      const pane = document.querySelector('#viewPhoto .scroll').getBoundingClientRect();
      const els = [...document.querySelectorAll('#viewPhoto button, #viewPhoto input, #viewPhoto select, .tabs button')].filter(e => {
        if (!e.offsetParent || e.type === 'hidden') return false;
        const b = e.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) return false;
        if (e.closest('.tabs')) return true;                       // the tab bar itself is always on screen
        return b.top >= pane.top + 1 && b.bottom <= pane.bottom - 1;   // fully visible inside the scroll pane
      });
      const R = els.map(e => { const b = e.getBoundingClientRect(); return { id: e.id || e.getAttribute('data-f') || e.getAttribute('data-v') || e.className || e.tagName, x: b.left, y: b.top, w: b.width, h: b.height }; });
      const bad = [];
      for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
        const a = R[i], b = R[j];
        // hidden-in-a-collapsed-row elements can share a box; only real overlaps count
        if (a.w < 1 || b.w < 1) continue;
        if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) bad.push(a.id + ' x ' + b.id);
      }
      const off = R.filter(a => a.w > 1 && (a.x < -1 || a.x + a.w > innerWidth + 1)).map(a => a.id);
      const taps = [...document.querySelectorAll('#viewPhoto button, #viewPhoto input[type=range]')].filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height);
      return { n: R.length, bad, off, minTouch: Math.min(...taps) };
    });
    assert.deepEqual(lay.bad, [], w + 'x' + h + ' photo overlaps: ' + lay.bad.join(', '));
    assert.deepEqual(lay.off, [], w + 'x' + h + ' photo off-screen: ' + lay.off.join(', '));
    assert.ok(lay.minTouch >= 32, w + 'x' + h + ' smallest photo control is ' + lay.minTouch + ' px tall');
    ok(`${w}x${h}: ${lay.n} photo controls, no overlaps, min height ${Math.round(lay.minTouch)} px`);
    await page.evaluate(() => { document.querySelector('#viewPhoto .scroll').scrollTop = 0; }); await sleep(150);
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(300);
  await page.evaluate(() => { document.querySelector('#viewPhoto .scroll').scrollTop = 0; }); await sleep(150);
  await page.screenshot({ path: path.join(SHOTS, 'myl-v1-photo.png') });
  // second layout check: photo + map tab bars
  await page.click('#tabMark'); await page.click('#startStop');
  assert.deepEqual(errors, [], errors.join('\n'));
  ok('no page errors');
  console.log(`\n${passed} UI checks passed`);
  await browser.close(); tiles.kill();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
