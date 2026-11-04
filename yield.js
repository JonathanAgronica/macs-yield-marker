/* Mac's Yield Marker - pure data helpers (ratings, colour ramps, KML + CSV build/parse, merge, summary).
   Works in the browser (window.YM) and in Node (module.exports) for tests. */
(function (root) {
  'use strict';
  var RATINGS = [
    { id: 'nil', label: 'Nil', short: 'Nil', color: '#8e1b1b', v: 0 },
    { id: 'low', label: 'Low', short: 'Low', color: '#e53935', v: 1 },
    { id: 'medium', label: 'Medium', short: 'Med', color: '#ffb400', v: 2 },
    { id: 'high', label: 'High', short: 'High', color: '#7cb342', v: 3 },
    { id: 'vhigh', label: 'Very high', short: 'V.high', color: '#1e9e48', v: 4 }
  ];
  var VARIETIES = ['A4', 'A16', 'A38', '741', '344', '246', '816', '842', '660', 'A203', 'MCT1', 'P', 'G', 'J', 'R', '47', 'Other'];
  function rating(id) { for (var i = 0; i < RATINGS.length; i++) if (RATINGS[i].id === id) return RATINGS[i]; return null; }
  function rating15(id) { var r = rating(id); return r ? r.v + 1 : null; }
  function ratingFrom(s) {
    if (/^[1-5]$/.test(String(s).trim())) return RATINGS[+s - 1].id;
    if (!s) return '';
    s = String(s).trim().toLowerCase().replace(/[\s._-]+/g, '');
    if (s === 'veryhigh' || s === 'vhigh' || s === 'vh') return 'vhigh';
    if (s === 'med' || s === 'medium' || s === 'moderate') return 'medium';
    if (s === 'none' || s === 'nil' || s === 'zero') return 'nil';
    return rating(s) ? s : '';
  }
  // ---- colours ----
  function hex2rgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function rgb2hex(c) { return '#' + c.map(function (v) { v = Math.round(Math.max(0, Math.min(255, v))); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  var RAMP = ['#e53935', '#ffb400', '#1e9e48'];          // red (low) -> amber -> green (high)
  function ramp(t) {
    if (!isFinite(t)) t = 0.5; t = Math.max(0, Math.min(1, t));
    var seg = t < 0.5 ? 0 : 1, f = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    var a = hex2rgb(RAMP[seg]), b = hex2rgb(RAMP[seg + 1]);
    return rgb2hex([0, 1, 2].map(function (i) { return a[i] + (b[i] - a[i]) * f; }));
  }
  function kmlColour(hex) { return 'ff' + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3); }   // #rrggbb -> aabbggrr
  function kmlToHex(k) { k = (k || '').trim(); return k.length === 8 ? '#' + k.slice(6, 8) + k.slice(4, 6) + k.slice(2, 4) : ''; }
  // value of a mark for a map mode: 'rating' | 'count' | 'kg'
  function valueOf(m, mode) {
    if (mode === 'rating') { var r = rating(m.rating); return r ? r.v : null; }
    var v = m[mode]; return v == null || v === '' || !isFinite(+v) ? null : +v;
  }
  function range(marks, mode) {
    var lo = Infinity, hi = -Infinity;
    marks.forEach(function (m) { var v = valueOf(m, mode); if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    return lo === Infinity ? null : { min: lo, max: hi };
  }
  function colorFor(m, mode, rg) {
    if (mode === 'rating') { var r = rating(m.rating); return r ? r.color : null; }
    var v = valueOf(m, mode); if (v == null) return null;
    rg = rg || { min: v, max: v };
    return ramp(rg.max > rg.min ? (v - rg.min) / (rg.max - rg.min) : 0.5);
  }
  // colour used for a mark in KML: its rating colour, else a weight / count shade relative to the exported set
  function markColor(m, rgs) {
    return colorFor(m, 'rating') || colorFor(m, 'estimate', rgs && rgs.estimate) || colorFor(m, 'kg', rgs && rgs.kg) || colorFor(m, 'count', rgs && rgs.count) || '#cfcfcf';
  }
  // ---- formatting ----
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function isoLocal(ts) {
    var d = new Date(ts), o = -d.getTimezoneOffset(), s = o >= 0 ? '+' : '-'; o = Math.abs(o);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + s + p2(Math.floor(o / 60)) + ':' + p2(o % 60);
  }
  function fmtLocal(ts) { return isoLocal(ts).slice(0, 19).replace('T', ' '); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function num(v) { return v == null || v === '' || !isFinite(+v) ? null : +v; }
  function markTitle(m) {
    var r = rating(m.rating), bits = [];
    if (r) bits.push(r.label);
    if (m.estimate != null) bits.push('Est ' + m.estimate + (m.treeFrom ? ' (T' + m.treeFrom + '-' + m.treeTo + ')' : ''));
    if (m.count != null) bits.push(m.count + ' nuts');
    if (m.kg != null) bits.push(m.kg + ' kg');
    if (m.estKgHa != null) bits.push('Photo ' + m.photoCount + ' nuts ≈ ' + Math.round(m.estKgHa) + ' kg/ha');
    var where = (m.row ? 'R' + m.row : '') + (m.tree ? (m.row ? ' ' : '') + 'T' + m.tree : '');
    return (bits.join(' · ') || 'Mark') + (where ? ' (' + where + ')' : '');
  }
  function newId() { return 'y' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  var FIELDS = ['id', 'ts', 'session', 'block', 'variety', 'row', 'tree', 'treeFrom', 'treeTo', 'rating', 'estimate', 'count', 'kg', 'acc', 'heading', 'interpolated', 'photoCount', 'estNutsPerTree', 'estKgHa', 'by'];

  // ---- KML ----
  function buildKml(data, opts) {
    opts = opts || {};
    var marks = (data.marks || []).slice().sort(function (a, b) { return a.ts - b.ts; });
    var rgs = { estimate: range(marks, 'estimate'), kg: range(marks, 'kg'), count: range(marks, 'count') };
    var out = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2">', '<Document>',
      '<name>' + esc(opts.name || "Mac's Yield Marker") + '</name>',
      '<description>Exported by Mac\'s Yield Marker (Agronica). Rating colours: red = low, amber = medium, green = high.</description>'];
    RATINGS.forEach(function (r) {
      out.push('<Style id="r-' + r.id + '"><IconStyle><color>' + kmlColour(r.color) + '</color><scale>0.9</scale><Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle><LabelStyle><scale>0.7</scale></LabelStyle></Style>');
    });
    out.push('<Style id="track"><LineStyle><color>ff00b4ff</color><width>3</width></LineStyle></Style>');
    out.push('<Folder><name>Yield marks</name>');
    marks.forEach(function (m) {
      var col = markColor(m, rgs);
      out.push('<Placemark><name>' + esc(markTitle(m)) + '</name>' +
        '<TimeStamp><when>' + new Date(m.ts).toISOString() + '</when></TimeStamp>' +
        (m.rating ? '<styleUrl>#r-' + m.rating + '</styleUrl>' : '') +
        '<Style><IconStyle><color>' + kmlColour(col) + '</color><scale>0.9</scale><Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>' +
        '<description>' + esc(markTitle(m) + '\nBlock: ' + (m.block || '-') + '\nVariety: ' + (m.variety || '-') + '\nTime: ' + fmtLocal(m.ts) + '\nAccuracy: ' + (m.acc != null ? Math.round(m.acc) + ' m' : '-')) + '</description>' +
        '<ExtendedData>' + FIELDS.map(function (f) { var v = m[f]; return v == null || v === '' ? '' : '<Data name="' + f + '"><value>' + esc(v) + '</value></Data>'; }).join('') + '<Data name="app"><value>macs-yield-marker</value></Data></ExtendedData>' +
        '<Point><coordinates>' + (+m.lon).toFixed(7) + ',' + (+m.lat).toFixed(7) + ',0</coordinates></Point></Placemark>');
    });
    out.push('</Folder>');
    var tr = (data.track || []);
    if (tr.length > 1) {
      out.push('<Placemark><name>GPS track</name><styleUrl>#track</styleUrl><LineString><tessellate>1</tessellate><coordinates>' +
        tr.map(function (p) { return p.lon.toFixed(7) + ',' + p.lat.toFixed(7) + ',0'; }).join(' ') + '</coordinates></LineString></Placemark>');
    }
    out.push('</Document>', '</kml>');
    return out.join('\n');
  }
  function kids(el, tag) { return Array.prototype.slice.call(el.getElementsByTagName(tag)); }
  function text(el, tag) { var e = el.getElementsByTagName(tag)[0]; return e ? (e.textContent || '').trim() : ''; }
  function parseKml(str, DP) {
    DP = DP || root.DOMParser;
    var doc = new DP().parseFromString(str, 'application/xml');
    var marks = [];
    kids(doc, 'Placemark').forEach(function (pm) {
      var pt = pm.getElementsByTagName('Point')[0]; if (!pt) return;
      var c = text(pt, 'coordinates').split(',');
      var lon = parseFloat(c[0]), lat = parseFloat(c[1]); if (!isFinite(lat) || !isFinite(lon)) return;
      var d = {};
      kids(pm, 'Data').forEach(function (x) { d[x.getAttribute('name')] = text(x, 'value'); });
      kids(pm, 'SimpleData').forEach(function (x) { d[x.getAttribute('name')] = (x.textContent || '').trim(); });
      var when = text(pm, 'when'), name = text(pm, 'name');
      var ts = num(d.ts) || (when ? Date.parse(when) : NaN);
      var rt = ratingFrom(d.rating) || (!d.app ? ratingFrom((name.match(/very high|nil|low|medium|med|high/i) || [''])[0]) : '');
      marks.push({ id: d.id || '', ts: isFinite(ts) ? ts : Date.now(), lat: lat, lon: lon, acc: num(d.acc), session: d.session || '', block: d.block || '', variety: d.variety || '',
        row: d.row || '', tree: d.tree || '', treeFrom: num(d.treeFrom), treeTo: num(d.treeTo), estimate: num(d.estimate), heading: num(d.heading), interpolated: d.interpolated === 'true' || undefined, photoCount: num(d.photoCount), estNutsPerTree: num(d.estNutsPerTree), estKgHa: num(d.estKgHa), rating: rt, count: num(d.count), kg: num(d.kg), by: d.by || '', name: name });
    });
    return { marks: marks };
  }
  // ---- CSV ----
  var CSV_HEAD = ['time', 'lat', 'lon', 'accuracy_m', 'block', 'variety', 'row', 'tree', 'tree_from', 'tree_to', 'rating', 'rating_1to5', 'estimate', 'count', 'weight_kg', 'heading', 'interpolated', 'photo_count', 'est_nuts_per_tree', 'est_kg_ha', 'session', 'id'];
  function csvCell(v) { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function buildCsv(data) {
    var rows = [CSV_HEAD.join(',')];
    (data.marks || []).slice().sort(function (a, b) { return a.ts - b.ts; }).forEach(function (m) {
      var r = rating(m.rating);
      rows.push([isoLocal(m.ts), (+m.lat).toFixed(7), (+m.lon).toFixed(7), m.acc != null ? Math.round(m.acc * 10) / 10 : '', m.block, m.variety, m.row, m.tree, m.treeFrom, m.treeTo,
        r ? r.label : '', r ? r.v + 1 : '', m.estimate, m.count, m.kg, m.heading != null ? Math.round(m.heading) : '', m.interpolated ? 'true' : '', m.photoCount, m.estNutsPerTree, m.estKgHa, m.session, m.id].map(csvCell).join(','));
    });
    return rows.join('\r\n') + '\r\n';
  }
  function parseCsvRows(s) {
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || r[0]; });
  }
  function parseCsv(s) {
    var rows = parseCsvRows(s), h = rows.shift() || [];
    var ix = function (n) { return h.indexOf(n); };
    return { marks: rows.map(function (r) {
      var g = function (n) { var i = ix(n); return i >= 0 ? r[i] : ''; };
      return { id: g('id'), ts: Date.parse(g('time')), lat: +g('lat'), lon: +g('lon'), acc: num(g('accuracy_m')), block: g('block'), variety: g('variety'), row: g('row'), tree: g('tree'), treeFrom: num(g('tree_from')), treeTo: num(g('tree_to')), estimate: num(g('estimate')), heading: num(g('heading')), interpolated: g('interpolated') === 'true' || undefined, photoCount: num(g('photo_count')), estNutsPerTree: num(g('est_nuts_per_tree')), estKgHa: num(g('est_kg_ha')),
        rating: ratingFrom(g('rating')), count: num(g('count')), kg: num(g('weight_kg')), session: g('session') };
    }) };
  }
  // ---- merge with de-duplication ----
  function sameMark(a, b) {
    if (a.id && b.id) return a.id === b.id;
    return Math.abs(a.ts - b.ts) < 1500 && Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5 &&
      (a.rating || '') === (b.rating || '') && (a.count == null ? null : +a.count) === (b.count == null ? null : +b.count) && (a.kg == null ? null : +a.kg) === (b.kg == null ? null : +b.kg) && (a.estimate == null ? null : +a.estimate) === (b.estimate == null ? null : +b.estimate);
  }
  function merge(existing, incoming) {
    var added = [], dup = 0;
    incoming.forEach(function (m) {
      var all = existing.concat(added);
      for (var i = 0; i < all.length; i++) if (sameMark(all[i], m)) { dup++; return; }
      var c = {}; for (var k in m) if (m[k] !== undefined && k !== 'name') c[k] = m[k];
      if (!c.id) c.id = newId();
      added.push(c);
    });
    return { added: added, dup: dup };
  }
  // ---- interpolation: fill skipped segments (interpolated:true) from neighbouring real marks (inverse-distance weighted) ----
  function distM(a, b) { var R = 6371000, r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) / 2 * r); return R * Math.sqrt(dl * dl + dn * dn); }
  function fillInterpolated(marks, radius) {
    radius = radius || 80;
    var real = marks.filter(function (m) { return !m.interpolated && rating(m.rating); });
    var n = 0;
    marks.forEach(function (m) {
      if (!m.interpolated) return;
      var sw = 0, sv = 0;
      real.forEach(function (o) { var d = distM(m, o); if (d <= radius) { var w = 1 / Math.max(d, 2) / Math.max(d, 2); sw += w; sv += w * (rating(o.rating).v + 1); } });
      if (sw) { var v = sv / sw; m.estimate = Math.round(v * 10) / 10; m.rating = RATINGS[Math.max(0, Math.min(4, Math.round(v) - 1))].id; n++; }
      else { m.rating = ''; m.estimate = null; }
    });
    return n;
  }
  // ---- summary ----
  function summary(marks) {
    var s = { n: marks.length, byRating: {}, rated: 0, estimates: 0, totalEst: 0, counts: 0, totalCount: 0, weighed: 0, totalKg: 0 };
    RATINGS.forEach(function (r) { s.byRating[r.id] = 0; });
    marks.forEach(function (m) {
      if (m.interpolated) { s.interpolated = (s.interpolated || 0) + 1; return; }
      if (rating(m.rating)) { s.byRating[m.rating]++; s.rated++; }
      if (num(m.estimate) != null) { s.estimates++; s.totalEst += +m.estimate; }
      if (num(m.count) != null) { s.counts++; s.totalCount += +m.count; }
      if (num(m.kg) != null) { s.weighed++; s.totalKg += +m.kg; }
    });
    s.totalKg = Math.round(s.totalKg * 1000) / 1000;
    s.avgKg = s.weighed ? Math.round(s.totalKg / s.weighed * 100) / 100 : null;
    s.avgEst = s.estimates ? Math.round(s.totalEst / s.estimates * 100) / 100 : null;
    s.avgCount = s.counts ? Math.round(s.totalCount / s.counts * 10) / 10 : null;
    var sc = 0; RATINGS.forEach(function (r) { sc += r.v * s.byRating[r.id]; });
    s.avgRating = s.rated ? Math.round(sc / s.rated * 100) / 100 : null;
    return s;
  }
  var api = { RATINGS: RATINGS, VARIETIES: VARIETIES, rating: rating, rating15: rating15, ratingFrom: ratingFrom, ramp: ramp, kmlColour: kmlColour, kmlToHex: kmlToHex, valueOf: valueOf, range: range,
    colorFor: colorFor, markColor: markColor, isoLocal: isoLocal, fmtLocal: fmtLocal, markTitle: markTitle, newId: newId, buildKml: buildKml, parseKml: parseKml,
    buildCsv: buildCsv, parseCsv: parseCsv, CSV_HEAD: CSV_HEAD, merge: merge, fillInterpolated: fillInterpolated, distM: distM, sameMark: sameMark, summary: summary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.YM = api;
})(typeof self !== 'undefined' ? self : this);
