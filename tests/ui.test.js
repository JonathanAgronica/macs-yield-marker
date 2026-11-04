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

  // ---- upload queue stays disabled ----
  const up = await page.evaluate(() => Upload.status()); assert.equal(up.enabled, false); assert.ok(up.pending > 0); assert.match(up.deviceId, /^[0-9a-f-]{36}$/);
  ok(`upload disabled until configured (${up.pending} queued for later, device ${up.deviceId.slice(0, 8)})`);

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

  // ---- Photo count on real CC photos ----
  await page.click('#tabPhoto'); await sleep(200);
  const res = [];
  for (const p of ['p1', 'p2', 'p3', 'p4']) {
    const r = await page.evaluate(async (src) => {
      const im = new Image(); im.src = src; await im.decode();
      Photo.setImage(im, { ts: Date.now(), pos: App.lastPos(), row: '2', tree: '5' }); await new Promise(r => setTimeout(r, 120));
      const out = {}; const setR = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); };
      setR('phMin', 8); setR('phMax', 45); setR('phRnd', 45); await new Promise(r => setTimeout(r, 300));
      for (const f of ['green', 'shape']) { document.querySelector(`.ph-seg [data-f="${f}"]`).click(); await new Promise(r => setTimeout(r, 400)); out[f] = Photo.count(); }
      document.querySelector('.ph-seg [data-f="green"]').click(); await new Promise(r => setTimeout(r, 400));
      setR('phMin', 12); setR('phMax', 30); setR('phRnd', 70); await new Promise(r => setTimeout(r, 400)); out.tuned = Photo.count();
      if (!/p2|p3/.test(src)) { setR('phMin', 8); setR('phMax', 45); setR('phRnd', 45); await new Promise(r => setTimeout(r, 400)); }
      return out;
    }, 'tests/photos/' + p + '.jpg');
    res.push([p, r]);
    await page.evaluate(() => { const sc = document.querySelector('#viewPhoto .scroll'); sc.scrollTop = document.getElementById('phWrap').offsetTop - 8; }); await sleep(200); await page.screenshot({ path: path.join(SHOTS, `myl-v1-photo-${p}.png`) });
  }
  console.log('   photo counts', JSON.stringify(res));
  // tap to add / remove
  const before = await page.evaluate(() => Photo.count());
  await page.evaluate(() => { const c = document.getElementById('phCanvas'), b = c.getBoundingClientRect(), n = Photo.auto()[0];
    c.dispatchEvent(new MouseEvent('click', { clientX: b.left + n.x * b.width / c.width, clientY: b.top + n.y * b.height / c.height, bubbles: true }));
    c.dispatchEvent(new MouseEvent('click', { clientX: b.left + 3, clientY: b.top + 3, bubbles: true })); c.dispatchEvent(new MouseEvent('click', { clientX: b.left + 40, clientY: b.top + 3, bubbles: true })); });
  assert.equal(await page.evaluate(() => Photo.count()), before + 1, 'removed 1, added 2');
  const nm = (await page.evaluate(() => App.state().marks.length)); await page.click('#phSave');
  const pm = await page.evaluate(() => App.state().marks.slice(-1)[0]); assert.equal((await page.evaluate(() => App.state().marks.length)), nm + 1);
  assert.equal(pm.photoCount, before + 1); assert.ok(pm.estKgHa > 0 && pm.estNutsPerTree > 0 && pm.rating);
  ok(`photo count: tap remove/add, saved mark ${pm.photoCount} nuts -> ${pm.estKgHa} kg/ha (${pm.rating})`);
  await page.evaluate(() => document.querySelector('#viewPhoto .scroll').scrollTop = 0);
  await page.screenshot({ path: path.join(SHOTS, 'myl-v1-photo.png') });
  // second layout check: photo + map tab bars
  await page.click('#tabMark'); await page.click('#startStop');
  assert.deepEqual(errors, [], errors.join('\n'));
  ok('no page errors');
  console.log(`\n${passed} UI checks passed`);
  await browser.close(); tiles.kill();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
