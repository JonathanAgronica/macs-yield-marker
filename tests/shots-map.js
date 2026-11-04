// Screenshots of the yield map over real Esri satellite imagery (needs internet), phone size 390x844.
// Run: NODE_PATH=... node tests/shots-map.js [url] [outDir]
const p = require('puppeteer-core'), fs = require('fs'), path = require('path');
const URL = process.argv[2] || 'https://jonathanagronica.github.io/macs-yield-marker/';
const OUT = process.argv[3] || '/workspace';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await p.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const g = await b.newPage();
  await g.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await g.goto(URL, { waitUntil: 'networkidle0' });
  await g.evaluate(() => {
    const s = App.state(), t0 = -24.9800, rows = [[0, 'vhigh'], [0.0001, 'high'], [0.0002, 'medium'], [0.0003, 'low'], [0.0004, 'vhigh'], [0.0005, 'medium'], [0.0006, 'high']];
    s.block = 'Block 7'; s.variety = 'A16'; s.settings.spacing['Block 7'] = 4;
    s.marks = rows.map(([dl, r], i) => ({ id: 'shot' + i, ts: Date.now() + i * 1000, lat: t0 + dl, lon: 152.38, rating: r, row: '12', block: 'Block 7', variety: 'A16', session: 'shot', acc: 3, treeFrom: i * 10 + 1, treeTo: i * 10 + 10, estimate: { vhigh: 4.6, high: 4.1, medium: 3.1, low: 1.6 }[r] }));
    s.marks[3].interpolated = true;                    // one averaged (skipped) segment, shown faded
    s.track = rows.map(([dl]) => ({ lat: t0 + dl, lon: 152.38 }));
    App.save(); App.render(); App.setView('map');
  });
  await sleep(7000);
  await g.evaluate(() => { const m = App.map().map; m.setView([-24.9797, 152.38], 18, { animate: false }); });
  await sleep(4000);
  await g.screenshot({ path: path.join(OUT, 'myl-v1-map.png') });
  await g.click('#viewMap [data-mode="kg"]');
  await g.evaluate(() => { const s = App.state(); s.marks[2].kg = 62; s.marks[4].kg = 148; s.marks[6].kg = 96; s.marks[3].kg = 21; App.save(); App.map().update(s); });
  await sleep(1500);
  await g.screenshot({ path: path.join(OUT, 'myl-v1-map-weight.png') });
  await b.close(); console.log('saved myl-v1-map.png, myl-v1-map-weight.png');
})();
