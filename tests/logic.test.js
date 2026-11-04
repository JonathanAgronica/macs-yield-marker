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
t('upload mark payload: flat server shape, no tree/count', () => {
  const U = global.Upload; const p = U.markPayload(marks[1]);
  assert.deepEqual(Object.keys(p).slice(0, 5), ['id', 't', 'lat', 'lon', 'rating']); assert.equal(p.rating, 4); assert.equal(p.row, '3'); assert.equal(p.treeFrom, 11); assert.equal(p.treeTo, 20); assert.equal(p.estimate, 4);
  assert.ok(!('tree' in p) && !('count' in p), 'extra tree/count dropped');
  assert.deepEqual(Object.keys(U.markPayload(marks[0])).sort(), ['acc', 'heading', 'id', 'lat', 'lon', 'rating', 'row', 't'], 'only listed optional fields');
  assert.equal(U.markPayload(marks[3]), null, 'unrated count-only mark not sent as a rating mark');
  assert.equal(U.binPayload(marks[3]).weightKg, 412.5);
  assert.equal(U.markPayload({ ...marks[0], rating: 'nil' }).rating, 1);
  // photo mark keeps photoCount/estNutsPerTree/estKgHa; interpolated flag survives
  const ph = U.markPayload(marks[4]); assert.equal(ph.photoCount, 37); assert.equal(ph.estNutsPerTree, 370); assert.equal(ph.estKgHa, 868);
  assert.equal(U.markPayload(marks[2]).interpolated, true);
  // server-side ranges are respected so one bad value cannot fail a batch
  const bad = U.markPayload({ ...marks[0], heading: 400, kg: 9999, row: 'x'.repeat(30), treeFrom: 9, treeTo: 3, acc: -2 });
  assert.equal(bad.heading, 40); assert.equal(bad.binWeightKg, 5000); assert.equal(bad.row.length, 20); assert.ok(!('treeFrom' in bad) && !('treeTo' in bad)); assert.equal(bad.acc, 0);
});
t('upload session payload is FLAT (no nested session object)', () => {
  const U = global.Upload;
  const s = U.sessionPayload({ id: 's1', block: 'B7', variety: 'A16' }, { farm: 'F' });
  assert.match(s.deviceId, /^[0-9a-f-]{36}$/); assert.equal(s.sessionId, 's1'); assert.ok(s.submittedAt); assert.equal(s.farm, 'F'); assert.equal(s.block, 'B7'); assert.equal(s.variety, 'A16');
  assert.equal(s.appVersion, 'v2');
  assert.ok(!('session' in s), 'no nested object');
  const body = U.submitPayload({ id: 's1', block: 'B7' }, [U.markPayload(marks[1])], { farm: 'F' });
  ['deviceId', 'appVersion', 'sessionId', 'submittedAt', 'farm', 'block', 'marks'].forEach(k => assert.ok(k in body, 'top-level ' + k));
  assert.equal(body.marks.length, 1); assert.equal(body.session, undefined);
  assert.equal(U.sessionPayload({ id: 'a b/c' }).sessionId, 'a-b-c', 'sessionId sanitised to [A-Za-z0-9._:-]');
  assert.equal(U.sessionPayload({ id: 'TEST-agent-check-yield' }).sessionId, 'TEST-agent-check-yield', 'allowed chars kept');
  assert.equal(U.sessionPayload({ id: 'x'.repeat(80) }).sessionId.length, 64, 'sessionId max 64');
  const c = U.sessionPayload({ id: 's1' }, { contact: { name: 'Mac', email: 'mac@example.com' } }); assert.equal(c.contact.email, 'mac@example.com');
  assert.equal(U.enabled(), true, 'enabled: config.js has the URL + key');
});
t('upload batching respects 1 MB and 5000 marks', () => {
  const U = global.Upload, base = U.sessionPayload({ id: 'big', block: 'B7' });
  const mk = i => ({ id: 'm' + i, t: '2026-11-04T00:00:00.000Z', lat: -24.9, lon: 152.3, rating: 3 });
  const many = Array.from({ length: 11000 }, (_, i) => mk(i));
  const parts = U.chunks(base, many, null);
  assert.ok(parts.every(b => b.marks.length <= 5000), 'max 5000 marks: ' + parts.map(b => b.marks.length));
  assert.equal(parts.reduce((a, b) => a + b.marks.length, 0), 11000);
  const fat = Array.from({ length: 5000 }, (_, i) => ({ ...mk(i), id: 'f' + i, note: 'z'.repeat(240) }));
  const fp = U.chunks(base, fat, null);
  assert.ok(fp.length > 1, 'fat marks split: ' + fp.length); fp.forEach(b => assert.ok(Buffer.byteLength(JSON.stringify(b)) <= 1048576, 'under 1 MB: ' + Buffer.byteLength(JSON.stringify(b))));
  assert.equal(fp.reduce((a, b) => a + b.marks.length, 0), 5000);
  // the track rides on the first request only, and is dropped if it would eat the budget
  const tr = Array.from({ length: 500 }, (_, i) => ({ lat: -24.9, lon: 152.3, t: '2026-11-04T00:00:00.000Z' }));
  const tp = U.chunks(base, many, tr); assert.equal(tp[0].track.length, 500); assert.ok(tp.slice(1).every(b => !b.track));
  const huge = Array.from({ length: 20000 }, (_, i) => ({ lat: -24.9, lon: 152.3, t: '2026-11-04T00:00:00.000Z', pad: 'q'.repeat(40) }));
  assert.ok(U.chunks(base, [mk(1)], huge).every(b => !b.track), 'oversize track dropped, marks still sent');
  assert.equal(U.trackPayload(Array.from({ length: 30000 }, (_, i) => ({ lat: -24.9, lon: 152.3, ts: 1730000000000 }))).length, 20000, 'track capped at 20000');
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
