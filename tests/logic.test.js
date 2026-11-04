// Node unit tests: ratings/colours, KML + CSV round-trip, merge de-dup, interpolation, summary, upload payload, photo maths.
// Run: NODE_PATH=/workspace/testenv/node_modules node tests/logic.test.js
const assert = require('assert');
const { DOMParser } = require('@xmldom/xmldom');
const Y = require('../yield.js');
global.self = global; global.YM = Y; global.YM_CONFIG = require('../config.js');
global.localStorage = { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); } };
require('../upload.js');
const PC = require('../photocount.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const base = { session: 's1', block: 'B7', variety: 'A16', acc: 3.2 };
const marks = [
  { id: 'a', ts: 1730000000000, lat: -24.9, lon: 152.3, rating: 'low', row: '3', tree: '4', heading: 92, ...base },
  { id: 'b', ts: 1730000002000, lat: -24.9001, lon: 152.3, rating: 'high', row: '3', treeFrom: 11, treeTo: 20, estimate: 4, ...base },
  { id: 'c', ts: 1730000004000, lat: -24.9002, lon: 152.3, interpolated: true, row: '3', treeFrom: 21, treeTo: 30, ...base },
  { id: 'd', ts: 1730000006000, lat: -24.9003, lon: 152.3, count: 120, kg: 412.5, row: '4', block: 'B7, "north"', session: 's1', variety: 'A16' },
  { id: 'e', ts: 1730000008000, lat: -24.9004, lon: 152.3, rating: 'vhigh', photoCount: 37, estNutsPerTree: 370, estKgHa: 868, row: '4', ...base }
];
t('colour ramp red -> amber -> green', () => { assert.equal(Y.ramp(0), '#e53935'); assert.equal(Y.ramp(0.5), '#ffb400'); assert.equal(Y.ramp(1), '#1e9e48'); assert.equal(Y.kmlColour('#e53935'), 'ff3539e5'); });
t('interpolation fills skipped segment from neighbours', () => { Y.fillInterpolated(marks); assert.ok(marks[2].rating, 'filled'); assert.ok(marks[2].estimate > 2 && marks[2].estimate < 5); });
t('KML round-trip keeps every field + aabbggrr colours', () => {
  const kml = Y.buildKml({ marks, track: [{ lat: -24.9, lon: 152.3 }, { lat: -24.901, lon: 152.3 }] });
  assert.ok(kml.includes('<color>ff3539e5</color>'), 'low = red'); assert.ok(kml.includes('<LineString>'));
  const back = Y.parseKml(kml, DOMParser).marks;
  assert.equal(back.length, marks.length);
  back.forEach((m, i) => { const o = marks[i]; ['id', 'ts', 'rating', 'row', 'block', 'variety', 'session'].forEach(f => assert.equal(String(m[f] ?? ''), String(o[f] ?? ''), f));
    ['count', 'kg', 'treeFrom', 'treeTo', 'estimate', 'photoCount', 'estKgHa', 'heading'].forEach(f => assert.equal(m[f] ?? null, o[f] ?? null, f)); assert.equal(!!m.interpolated, !!o.interpolated); assert.ok(Math.abs(m.lat - o.lat) < 1e-7); });
});
t('foreign KML points (no ExtendedData) import with rating from name', () => {
  const k = '<kml><Document><Placemark><name>High yield</name><Point><coordinates>152.1,-24.5,0</coordinates></Point></Placemark></Document></kml>';
  const m = Y.parseKml(k, DOMParser).marks; assert.equal(m.length, 1); assert.equal(m[0].rating, 'high');
});
t('CSV columns + round-trip (quotes, commas)', () => {
  const csv = Y.buildCsv({ marks }); const head = csv.split('\r\n')[0].split(',');
  ['time', 'lat', 'lon', 'accuracy_m', 'block', 'variety', 'row', 'tree', 'rating', 'count', 'weight_kg', 'session', 'tree_from', 'tree_to', 'estimate', 'interpolated'].forEach(c => assert.ok(head.includes(c), c));
  const back = Y.parseCsv(csv).marks; assert.equal(back.length, 5);
  assert.equal(back[3].block, 'B7, "north"'); assert.equal(back[3].kg, 412.5); assert.equal(back[3].count, 120); assert.equal(back[1].rating, 'high'); assert.equal(back[0].ts, marks[0].ts); assert.equal(back[2].interpolated, true);
});
t('merge de-duplicates by id and by time/position', () => {
  const r = Y.merge(marks, Y.parseKml(Y.buildKml({ marks }), DOMParser).marks); assert.equal(r.added.length, 0); assert.equal(r.dup, 5);
  const noId = marks.map(m => ({ ...m, id: '' })); const r2 = Y.merge(marks.map(m => ({ ...m, id: '' })), noId); assert.equal(r2.added.length, 0);
  const r3 = Y.merge(marks, [{ ts: 1, lat: 1, lon: 1, rating: 'low' }]); assert.equal(r3.added.length, 1); assert.ok(r3.added[0].id);
});
t('summary counts per rating, total/average weight', () => {
  const s = Y.summary(marks); assert.equal(s.byRating.low, 1); assert.equal(s.byRating.high, 1); assert.equal(s.byRating.vhigh, 1); assert.equal(s.interpolated, 1);
  assert.equal(s.totalKg, 412.5); assert.equal(s.avgKg, 412.5); assert.equal(s.totalCount, 120);
});
t('upload payload matches AgronicaWorld schema', () => {
  const U = global.Upload; const p = U.markPayload(marks[1]);
  assert.deepEqual(Object.keys(p).slice(0, 5), ['id', 't', 'lat', 'lon', 'rating']); assert.equal(p.rating, 4); assert.equal(p.row, '3'); assert.equal(p.treeFrom, 11); assert.equal(p.estimate, 4);
  assert.equal(U.markPayload(marks[3]), null, 'unrated count-only mark not sent as a rating mark'); assert.equal(U.binPayload(marks[3]).weightKg, 412.5);
  assert.equal(U.markPayload({ ...marks[0], rating: 'nil' }).rating, 1);
  const s = U.sessionPayload({ id: 's1', block: 'B7', variety: 'A16' }, { farm: 'F' }); assert.match(s.deviceId, /^[0-9a-f-]{36}$/); assert.equal(s.sessionId, 's1'); assert.ok(s.submittedAt); assert.equal(s.farm, 'F');
  assert.equal(U.enabled(), false, 'disabled while URL/key blank');
});
t('photo yield maths + t/ha rating bands', () => {
  const e = PC.yieldEstimate(50, { coverPct: 10, rowSp: 8, treeSp: 4, nisG: 7.5 }); assert.equal(e.nutsPerTree, 500); assert.equal(e.treesHa, 313); assert.equal(e.kgHa, 1172);
  assert.equal(PC.ratingFromTHa(0.2), 1); assert.equal(PC.ratingFromTHa(3), 3); assert.equal(PC.ratingFromTHa(6), 5);
});
t('photo detector finds synthetic nuts with each filter', () => {
  const w = 240, h = 180, px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = 25; px[i * 4 + 1] = 60; px[i * 4 + 2] = 28; px[i * 4 + 3] = 255; }
  const C = [[30, 30], [90, 40], [160, 50], [60, 120], [130, 130], [200, 140]];
  const paint = (col) => { for (const [cx, cy] of C) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < 121) { const i = (y * w + x) * 4; px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; } };
  paint([160, 205, 70]); assert.equal(PC.detect(px, w, h, { filter: 'green', minR: 4, maxR: 20 }).nuts.length, 6); assert.equal(PC.detect(px, w, h, { filter: 'shape', minR: 4, maxR: 20 }).nuts.length, 6);
  paint([140, 85, 40]); assert.equal(PC.detect(px, w, h, { filter: 'brown', minR: 4, maxR: 20 }).nuts.length, 6);
});
console.log(`\n${n} logic tests passed`);
