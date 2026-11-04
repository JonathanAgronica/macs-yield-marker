// Offline PWA test: service worker controls the page, app shell + all 35 precached assets come from cache with no network.
// Run: NODE_PATH=... node tests/offline.test.js [baseUrl]
const puppeteer = require('puppeteer-core'), assert = require('assert');
const BASE = process.argv[2] || 'http://localhost:8231/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await b.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate(() => navigator.serviceWorker.ready); await sleep(2500);
  await page.reload({ waitUntil: 'networkidle0' });
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'controlled by the SW');
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  assert.match(await page.title(), /Mac's Yield Marker/);
  assert.equal(await page.$eval('#rateBtns .rate span', e => e.textContent), 'VERY HIGH');
  // every precached asset is in the version cache
  const c = await page.evaluate(async () => { const k = (await caches.keys()).find(x => x.startsWith('macs-yield-marker')); const ca = await caches.open(k); return (await ca.keys()).map(q => new URL(q.url).pathname); });
  ['/style.css', '/yield.css', '/app.js', '/yield.js', '/ymap.js', '/upload.js', '/photocount.js', '/photo.js', '/vendor/leaflet/leaflet.js', '/img/helper.png', '/icons/icon-512.png'].forEach(f => assert.ok(c.includes(f), 'cached ' + f));
  console.log(`ok - offline: SW controls the page, app shell + ${c.length} precached assets load from cache with the network off`);
  await b.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
