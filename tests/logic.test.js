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
  assert.equal(s.appVersion, 'v4');
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
t('photo detector finds synthetic nuts with the original three filters', () => {
  const w = 240, h = 180, px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = 25; px[i * 4 + 1] = 60; px[i * 4 + 2] = 28; px[i * 4 + 3] = 255; }
  const C = [[30, 30], [90, 40], [160, 50], [60, 120], [130, 130], [200, 140]];
  const paint = (col) => { for (const [cx, cy] of C) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < 121) { const i = (y * w + x) * 4; px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; } };
  paint([160, 205, 70]); assert.equal(PC.detect(px, w, h, { filter: 'green', minR: 4, maxR: 20 }).nuts.length, 6); assert.equal(PC.detect(px, w, h, { filter: 'shape', minR: 4, maxR: 20 }).nuts.length, 6);
  paint([140, 85, 40]); assert.equal(PC.detect(px, w, h, { filter: 'brown', minR: 4, maxR: 20 }).nuts.length, 6);
});
// ---------- v3 filter bench ----------
const S = require('./synth.js');
const SETS = {
  green: S.greenNuts(), brown: S.brownNuts(), overlap: S.overlappingNuts(), hidden: S.hiddenNuts(),
  leafA: S.leafOnly(3), leafB: S.leafOnly(17), leafC: S.leafOnly(42)
};
const run = (img, o) => PC.detect(img.px, img.w, img.h, Object.assign({ minR: 8, maxR: 30, round: 45, smooth: 30 }, o));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
t('v3: every filter mode runs and is declared', () => {
  assert.deepEqual(PC.FILTERS, ['green', 'brown', 'shape', 'satval', 'hueband', 'lab', 'exg', 'otsu', 'edge']);
  for (const f of PC.FILTERS) for (const s of Object.values(SETS)) {
    const r = run(s, { filter: f });
    assert.ok(Array.isArray(r.nuts) && r.mask && r.score, f + ' returns nuts/mask/score');
    assert.ok(r.nuts.every(nn => isFinite(nn.x) && isFinite(nn.y) && isFinite(nn.r) && nn.r > 0), f + ' finite circles');
  }
});
// the four scenes the filters must actually handle: green husk, brown, touching, half-hidden
t('v3: green-husk filters find green nuts (12 truth)', () => {
  for (const f of ['green', 'shape', 'satval', 'hueband', 'lab', 'exg', 'edge', 'otsu']) {
    const c = run(SETS.green, { filter: f }).nuts.length;
    assert.ok(near(c, 12, 5), f + ' found ' + c + ' of 12');
  }
  // and the two house favourites are exact on a clean cluster
  assert.equal(run(SETS.green, { filter: 'green' }).nuts.length, 12);
});
t('v3: brown filter finds mature nuts (8 truth) and ignores green ones', () => {
  const b = run(SETS.brown, { filter: 'brown' }).nuts.length, g = run(SETS.green, { filter: 'brown' }).nuts.length;
  assert.ok(near(b, 8, 4), 'brown found ' + b + ' of 8'); assert.equal(g, 0, 'brown filter on green nuts: ' + g);
});
t('v3: overlapping nuts are split, not merged into one blob (7 truth)', () => {
  for (const f of ['green', 'hueband', 'lab', 'edge', 'shape', 'otsu']) {
    const c = run(SETS.overlap, { filter: f }).nuts.length;
    assert.ok(c >= 3 && c <= 10, f + ' split into ' + c + ' (7 nuts in one touching cluster)');
  }
  // a merged cluster would report 1; the distance transform must separate at least half of them
  assert.ok(run(SETS.overlap, { filter: 'green' }).nuts.length >= 4, 'at least 4 of 7 separated');
});
t('v3: partly hidden nuts (arc only) are found by the edge/circle and shape filters', () => {
  assert.ok(near(run(SETS.hidden, { filter: 'edge' }).nuts.length, 4, 1), 'edge: ' + run(SETS.hidden, { filter: 'edge' }).nuts.length);
  assert.ok(near(run(SETS.hidden, { filter: 'shape' }).nuts.length, 4, 1), 'shape: ' + run(SETS.hidden, { filter: 'shape' }).nuts.length);
});
t('v3: no filter returns an absurd count on leaf clutter (no nuts present)', () => {
  for (const f of PC.FILTERS) for (const [k, s] of Object.entries(SETS)) {
    if (!k.startsWith('leaf')) continue;
    const c = run(s, { filter: f }).nuts.length;
    assert.ok(c <= 40, f + ' on ' + k + ' invented ' + c + ' nuts');
    assert.ok(c <= s.w * s.h / 900, f + ' on ' + k + ': ' + c + ' is more than one nut per 30x30 px');
  }
  // the filters tuned for green husk must not turn a leaf wall into a crowd: the best behaved stay in the teens
  for (const f of ['green', 'brown', 'lab', 'otsu', 'edge']) for (const k of ['leafA', 'leafB', 'leafC']) {
    const c = run(SETS[k], { filter: f }).nuts.length;
    assert.ok(c <= 25, f + ' on ' + k + ': ' + c + ' false positives');
  }
});
t('v3: brown filter has no false positives on green leaf clutter', () => {
  for (const k of ['leafA', 'leafB', 'leafC']) assert.equal(run(SETS[k], { filter: 'brown' }).nuts.length, 0, k);
  for (const k of ['green', 'overlap', 'hidden']) assert.equal(run(SETS[k], { filter: 'brown' }).nuts.length, 0, 'brown on ' + k);
});
t('v3: threshold, smoothing, min/max radius, roundness and topN all change the result', () => {
  const lo = run(SETS.leafA, { filter: 'green', thr: 5 }).nuts.length, hi = run(SETS.leafA, { filter: 'green', thr: 95 }).nuts.length;
  assert.ok(lo > hi, 'threshold 5 vs 95 on leaf clutter: ' + lo + ' / ' + hi);
  // smoothing's job is stability: the raw pass jitters with pixel noise, the smoothed one lands on the truth
  const rawCounts = [3, 9, 17, 42].map(sd => run(S.leafOnly(sd), { filter: 'green', smooth: 0 }).nuts.length);
  const smoothCounts = [3, 9, 17, 42].map(sd => run(S.leafOnly(sd), { filter: 'green', smooth: 60 }).nuts.length);
  const spread = a => Math.max(...a) - Math.min(...a);
  assert.ok(spread(smoothCounts) <= spread(rawCounts) + 2, 'smoothing steadies the count across noise: ' + spread(rawCounts) + ' -> ' + spread(smoothCounts));
  assert.ok(run(SETS.green, { filter: 'green', smooth: 60 }).nuts.length <= run(SETS.green, { filter: 'green', smooth: 0 }).nuts.length, 'smoothing does not inflate a clean cluster');
  assert.ok(run(SETS.green, { filter: 'green', maxR: 9 }).nuts.length <= 2, 'tiny max radius clamps the count');
  assert.equal(run(SETS.green, { filter: 'green', minR: 40, maxR: 60 }).nuts.length, 0, 'huge min radius finds nothing at this scale');
  assert.equal(run(SETS.green, { filter: 'green', topN: 5 }).nuts.length, 5, 'topN keeps the best 5');
  assert.equal(run(SETS.green, { filter: 'green', topN: 0 }).nuts.length, 12, 'topN 0 = all');
  const strict = run(SETS.leafA, { filter: 'shape', round: 100 }).nuts.length, loose = run(SETS.leafA, { filter: 'shape', round: 0 }).nuts.length;
  assert.ok(strict <= loose, 'roundness 100 filters at least as hard as 0: ' + strict + ' vs ' + loose);
});
t('v3: hue band sliders actually move the band', () => {
  const inside = run(SETS.green, { filter: 'hueband', hMin: 55, hMax: 100 }).nuts.length;
  const outside = run(SETS.green, { filter: 'hueband', hMin: 200, hMax: 260 }).nuts.length;
  assert.ok(inside >= 9, 'husk hue band finds the nuts: ' + inside); assert.equal(outside, 0, 'magenta band finds none: ' + outside);
});
t('v3: Otsu auto-threshold adapts to the photo instead of a fixed cut', () => {
  const a = run(SETS.green, { filter: 'otsu' }), b = run(SETS.brown, { filter: 'otsu' });
  assert.ok(near(a.nuts.length, 12, 4), 'otsu on green nuts: ' + a.nuts.length);
  assert.ok(a.stats.cut > 0.1 && a.stats.cut < 0.9, 'sane cut ' + a.stats.cut);
  assert.ok(b.stats.cut > 0.1 && b.stats.cut < 0.9);
  // the threshold slider biases Otsu without destroying it
  assert.ok(run(SETS.green, { filter: 'otsu', thr: 0 }).nuts.length >= run(SETS.green, { filter: 'otsu', thr: 100 }).nuts.length);
});
t('v3: LAB separation puts green husk and mature brown on opposite a* sides', () => {
  const nut = PC.srgb2lab(150, 196, 78), leaf = PC.srgb2lab(46, 92, 40), brown = PC.srgb2lab(136, 84, 42);
  assert.ok(brown[1] > 0 && nut[1] < 0 && leaf[1] < 0, 'a*: brown ' + brown[1].toFixed(1) + ', nut ' + nut[1].toFixed(1) + ', leaf ' + leaf[1].toFixed(1));
  assert.ok(nut[2] > leaf[2] + 15, 'b* husk > leaf by a wide margin');
  assert.ok(nut[0] > leaf[0] + 20, 'husk is much lighter (L*) than leaf');
});
t('v3: detect is pure (input pixels untouched) and idempotent', () => {
  const img = SETS.green, before = Buffer.from(img.px);
  const a = run(img, { filter: 'green' }).nuts.length, b = run(img, { filter: 'green' }).nuts.length;
  assert.equal(a, b, 'same input, same count'); assert.ok(Buffer.compare(before, Buffer.from(img.px)) === 0, 'source pixels unchanged');
});
t('v3: a 480 px preview pass agrees with the 1280 px full pass within ~30%', () => {
  // this is the promise the live preview makes: the number you see while dragging is close to the settled one
  const k = 1280 / 480, big = SETS.green;
  const full = run(big, { filter: 'green', minR: 14, maxR: 80 }).nuts.length;
  const half = PC.detect(big.px, big.w, big.h, { filter: 'green', minR: 14 / 1.6, maxR: 80 / 1.6, round: 45, smooth: 30 }).nuts.length;
  assert.ok(Math.abs(full - half) <= Math.max(4, full * 0.35), 'full ' + full + ' vs scaled ' + half);
});
t('v3: detection performance stays inside a phone frame budget', () => {
  // 480 px preview copy; generous ceiling so a slow CI box does not flake, but a quadratic blow-up still fails
  const t0 = Date.now(); for (let i = 0; i < 5; i++) run(SETS.leafA, { filter: 'green' });
  const per = (Date.now() - t0) / 5;
  assert.ok(per < 400, 'preview pass ' + per.toFixed(0) + ' ms at 320x240');
});
t('v3: no filter returns NaN / negative / absurd values for degenerate input', () => {
  const cases = [{ px: new Uint8ClampedArray(4), w: 1, h: 1 }, { px: new Uint8ClampedArray(4 * 4), w: 2, h: 2 },
    (() => { const w = 64, h = 48, px = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { px[i * 4] = 0; px[i * 4 + 1] = 0; px[i * 4 + 2] = 0; px[i * 4 + 3] = 255; } return { px, w, h }; })(),
    (() => { const w = 64, h = 48, px = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h * 4; i++) px[i] = 255; return { px, w, h }; })()];
  for (const c of cases) for (const f of PC.FILTERS) {
    const r = PC.detect(c.px, c.w, c.h, { filter: f, minR: 3, maxR: 20 });
    assert.ok(Array.isArray(r.nuts) && r.nuts.length < 50, f + ' on ' + c.w + 'x' + c.h + ': ' + r.nuts.length);
    assert.ok(r.nuts.every(nn => isFinite(nn.x) && isFinite(nn.y) && isFinite(nn.r)), f + ' finite on degenerate input');
  }
});
t('v3: presets are the documented four and every one produces a sane count', () => {
  const P = [
    { name: 'Green husk sunny', o: { filter: 'hueband', thr: 48, hMin: 46, hMax: 104, sat: 24, bri: 26, minR: 14, maxR: 80, round: 45, smooth: 25, topN: 0 } },
    { name: 'Green husk overcast', o: { filter: 'satval', thr: 35, sat: 30, bri: 22, minR: 12, maxR: 80, round: 35, smooth: 40, topN: 0 } },
    { name: 'Brown fallen', o: { filter: 'brown', thr: 25, minR: 10, maxR: 70, round: 30, smooth: 30, topN: 0 } },
    { name: 'Dense canopy', o: { filter: 'otsu', thr: 55, minR: 10, maxR: 46, round: 60, smooth: 35, topN: 40 } }
  ];
  for (const p of P) for (const k of ['green', 'brown', 'leafA']) {
    const r = run(SETS[k], p.o);
    assert.ok(r.nuts.length <= 60, p.name + ' on ' + k + ': ' + r.nuts.length);
  }
  assert.ok(run(SETS.green, P[0].o).nuts.length >= 9, 'sunny preset finds the green nuts: ' + run(SETS.green, P[0].o).nuts.length);
  assert.ok(run(SETS.brown, P[2].o).nuts.length >= 5, 'brown preset finds the brown nuts: ' + run(SETS.brown, P[2].o).nuts.length);
  assert.equal(run(SETS.leafA, P[2].o).nuts.length, 0, 'brown preset invents nothing on green leaves');
  assert.ok(run(SETS.leafA, P[3].o).nuts.length <= 40, 'dense-canopy preset caps itself with best-N');
});
// ---------- v4: AI count module (pure parts; the network + canvas paths run in tests/ai.test.js) ----------
const AI = require('../aicount.js');
t('v4: AI error messages are plain language and always point back to the on-phone count', () => {
  const msg = st => AI.describe(Object.assign(new Error('x'), { status: st }));
  assert.equal(msg(503), 'AI counting is not switched on yet - add the OpenAI key in AgronicaWorld');
  assert.match(msg(429), /wait 60 s/); assert.match(AI.describe({ status: 429, retryAfter: 42 }), /wait 42 s/);
  assert.match(msg(413), /too big/); assert.match(msg(415), /image type/); assert.match(msg(401), /rejected the app key/);
  assert.match(msg(400), /rejected the request/); assert.match(msg(502), /on-phone count is still here/);
  assert.match(msg(0), /on-phone count is still here/); assert.match(msg(0), /Could not reach AgronicaWorld/);
  assert.match(AI.describe({ status: 400, message: 'coverPct must be 0-100' }), /coverPct/);
});
t('v4: AI request carries the documented multipart fields and nothing else', () => {
  const seen = {};
  global.FormData = function () { this.append = (k, v) => { (seen[k] = seen[k] || []).push(v); }; };
  const fd = AI.form({ size: 10 }, { deviceId: 'd1', sessionId: 's1', block: 'B7', variety: 'A16', row: '4', treeFrom: 7, treeTo: 7,
    coverPct: 10, rowSp: 8, treeSp: 4, nisG: 7.5, tree: '9', preset: 'x' });
  assert.ok(fd);
  assert.deepEqual(Object.keys(seen).sort(), ['block', 'coverPct', 'deviceId', 'image', 'nisG', 'row', 'rowSp', 'sessionId', 'treeFrom', 'treeTo', 'treeSp', 'variety'].sort());
  assert.equal(seen.treeFrom[0], '7'); assert.equal(seen.coverPct[0], '10');
  // blank optional fields are left out entirely, so the server's range checks never see an empty string
  const seen2 = {}; global.FormData = function () { this.append = (k, v) => { seen2[k] = v; }; };
  AI.form({ size: 1 }, { deviceId: 'd1', block: '', variety: null, row: '', treeFrom: NaN, coverPct: 0 });
  assert.deepEqual(Object.keys(seen2).sort(), ['coverPct', 'deviceId', 'image'].sort());
  assert.equal(AI.EDGE, 1600); assert.equal(AI.EDGE_RETRY, 1200); assert.equal(AI.QUALITY, 0.85);
});
t('v4: AI spend counter and the "don\'t show again" flag persist locally', () => {
  AI.resetStats();
  assert.deepEqual(AI.stats().calls, 0); assert.equal(AI.noticeSeen(), false);
  AI.bump({ count: 9 }); AI.bump({ count: 4 });
  assert.equal(AI.stats().calls, 2); assert.ok(AI.stats().cents >= 6, 'about 3c a call: ' + AI.stats().cents);
  AI.setNoticeSeen(true); assert.equal(AI.noticeSeen(), true); AI.setNoticeSeen(false); assert.equal(AI.noticeSeen(), false);
  AI.resetStats(); assert.equal(AI.stats().calls, 0);
});
console.log(`\n${n} logic tests passed`);
