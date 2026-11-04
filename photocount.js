/* On-device macadamia nut counter (pure, canvas-free maths so it also runs in Node tests).
   detect(rgba, w, h, opts) -> { nuts:[{x,y,r}], mask, stats }
   opts: filter 'green' | 'brown' | 'shape', enhance (bool), thr 0-100, minR, maxR (px radius), round 0-100 */
(function (root) {
  'use strict';
  function rgb2hsv(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return [h, mx ? d / mx : 0, mx / 255];
  }
  // CLAHE-style local contrast: per-tile clipped histogram equalisation of brightness, bilinearly blended between tiles
  function enhance(px, w, h) {
    var T = 8, tw = Math.ceil(w / T), th = Math.ceil(h / T), maps = [], clip = 3;
    var V = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) V[i] = Math.max(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    for (var ty = 0; ty < T; ty++) for (var tx = 0; tx < T; tx++) {
      var hist = new Float64Array(256), n = 0;
      for (var y = ty * th; y < Math.min(h, (ty + 1) * th); y++) for (var x = tx * tw; x < Math.min(w, (tx + 1) * tw); x++) { hist[V[y * w + x]]++; n++; }
      var lim = Math.max(1, clip * n / 256), ex = 0;
      for (var k = 0; k < 256; k++) if (hist[k] > lim) { ex += hist[k] - lim; hist[k] = lim; }
      var add = ex / 256, cdf = new Uint8Array(256), acc = 0;
      for (k = 0; k < 256; k++) { acc += hist[k] + add; cdf[k] = n ? Math.min(255, Math.round(acc / n * 255)) : k; }
      maps.push(cdf);
    }
    var out = new Uint8ClampedArray(px.length);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var p = y * w + x, v = V[p];
      var fx = x / tw - 0.5, fy = y / th - 0.5, x0 = Math.max(0, Math.floor(fx)), y0 = Math.max(0, Math.floor(fy)), x1 = Math.min(T - 1, x0 + 1), y1 = Math.min(T - 1, y0 + 1);
      var ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0));
      var nv = (maps[y0 * T + x0][v] * (1 - ax) + maps[y0 * T + x1][v] * ax) * (1 - ay) + (maps[y1 * T + x0][v] * (1 - ax) + maps[y1 * T + x1][v] * ax) * ay;
      var s = v ? nv / v : 1;
      out[p * 4] = px[p * 4] * s; out[p * 4 + 1] = px[p * 4 + 1] * s; out[p * 4 + 2] = px[p * 4 + 2] * s; out[p * 4 + 3] = 255;
    }
    return out;
  }
  function boxBlur(src, w, h, r) {
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (var y = 0; y < h; y++) { var s = 0, c = 0; for (var x = -r; x < w; x++) { if (x + r < w) { s += src[y * w + x + r]; c++; } if (x - r - 1 >= 0) { s -= src[y * w + x - r - 1]; c--; } if (x >= 0) tmp[y * w + x] = s / c; } }
    for (x = 0; x < w; x++) { s = 0; c = 0; for (y = -r; y < h; y++) { if (y + r < h) { s += tmp[(y + r) * w + x]; c++; } if (y - r - 1 >= 0) { s -= tmp[(y - r - 1) * w + x]; c--; } if (y >= 0) out[y * w + x] = s / c; } }
    return out;
  }
  // per-pixel score 0..1 then threshold -> binary mask
  function maskFor(px, w, h, o) {
    var n = w * h, m = new Uint8Array(n), t = o.thr / 100, i, hsv;
    if (o.filter === 'shape') {
      // bright round blobs: brightness minus local mean (blob / "top-hat" detector) - shape filtering happens on the components
      var L = new Float32Array(n); for (i = 0; i < n; i++) L[i] = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) / 255;
      var bl = boxBlur(L, w, h, Math.max(3, Math.round(o.maxR * 1.5)));
      for (i = 0; i < n; i++) m[i] = L[i] - bl[i] > 0.02 + t * 0.2 ? 1 : 0;
      return m;
    }
    for (i = 0; i < n; i++) {
      var r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]; hsv = rgb2hsv(r, g, b);
      if (o.filter === 'brown') {
        // mature / fallen nuts and brown shells: orange-brown hue, moderately saturated, not too dark
        m[i] = hsv[0] >= 8 && hsv[0] <= 45 && hsv[1] > 0.22 + t * 0.35 && hsv[2] > 0.12 && hsv[2] < 0.92 ? 1 : 0;
      } else {
        // green husk nuts: yellow-green, lighter and less blue than leaves. ExG = 2g - r - b
        var exg = (2 * g - r - b) / 255;
        m[i] = hsv[0] >= (o.hMin || 58) && hsv[0] <= (o.hMax || 98) && hsv[1] > 0.22 && hsv[1] < 0.85 && exg > 0.06 && r > b * 1.25 && hsv[2] > 0.25 + t * 0.5 ? 1 : 0;
      }
    }
    return m;
  }
  function morph(m, w, h, erode) {
    var o = new Uint8Array(m.length);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var v = erode ? 1 : 0;
      for (var dy = -1; dy <= 1 && (erode ? v : !v); dy++) for (var dx = -1; dx <= 1; dx++) {
        var yy = y + dy, xx = x + dx, q = yy < 0 || xx < 0 || yy >= h || xx >= w ? 0 : m[yy * w + xx];
        if (erode && !q) { v = 0; break; } if (!erode && q) { v = 1; break; }
      }
      o[y * w + x] = v;
    }
    return o;
  }
  // two-pass chamfer (3-4) distance transform, returned in pixels
  function dist(m, w, h) {
    var D = new Float32Array(w * h), INF = 1e9, i, x, y;
    for (i = 0; i < w * h; i++) D[i] = m[i] ? INF : 0;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) { i = y * w + x; if (!D[i]) continue; var v = D[i];
      if (x > 0) v = Math.min(v, D[i - 1] + 3); if (y > 0) { v = Math.min(v, D[i - w] + 3); if (x > 0) v = Math.min(v, D[i - w - 1] + 4); if (x < w - 1) v = Math.min(v, D[i - w + 1] + 4); } else v = Math.min(v, 3);
      if (x === 0 || x === w - 1) v = Math.min(v, 3); D[i] = v; }
    for (y = h - 1; y >= 0; y--) for (x = w - 1; x >= 0; x--) { i = y * w + x; if (!D[i]) continue; v = D[i];
      if (x < w - 1) v = Math.min(v, D[i + 1] + 3); if (y < h - 1) { v = Math.min(v, D[i + w] + 3); if (x < w - 1) v = Math.min(v, D[i + w + 1] + 4); if (x > 0) v = Math.min(v, D[i + w - 1] + 4); } else v = Math.min(v, 3);
      D[i] = v; }
    for (i = 0; i < w * h; i++) D[i] /= 3;
    return D;
  }
  function components(m, w, h) {
    var lab = new Int32Array(m.length), comps = [], stack = [];
    for (var i = 0; i < m.length; i++) {
      if (!m[i] || lab[i]) continue;
      var c = { n: 0, sx: 0, sy: 0, x0: 1e9, y0: 1e9, x1: -1, y1: -1, edge: 0 }; comps.push(c); lab[i] = comps.length; stack.push(i);
      while (stack.length) {
        var p = stack.pop(), x = p % w, y = (p - x) / w; c.n++; c.sx += x; c.sy += y;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        var nb = [p - 1, p + 1, p - w, p + w], ok = [x > 0, x < w - 1, y > 0, y < h - 1];
        for (var k = 0; k < 4; k++) { if (!ok[k]) { c.edge++; continue; } var q = nb[k]; if (m[q]) { if (!lab[q]) { lab[q] = comps.length; stack.push(q); } } else c.edge++; }
      }
    }
    return comps;
  }
  function detect(px, w, h, o) {
    o = Object.assign({ filter: 'green', enhance: false, thr: 50, minR: 8, maxR: 45, round: 45 }, o || {});
    var img = o.enhance ? enhance(px, w, h) : px;
    var m = maskFor(img, w, h, o);
    m = morph(morph(m, w, h, true), w, h, false);           // open: removes speckle and thin leaf edges
    m = morph(morph(morph(morph(m, w, h, false), w, h, false), w, h, true), w, h, true);   // close: fills specular highlights / blemishes inside nuts
    // touching nuts: distance transform of the mask; each local maximum (nut centre) with radius in range is a nut,
    // with non-maximum suppression so one nut gives one circle. Roundness = how full the disc of that radius is.
    var D = dist(m, w, h), nuts = [], cand = [], rMin = o.minR * 0.75, rMax = o.maxR;
    for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) {
      var v = D[y * w + x]; if (v < rMin || v > rMax) continue;
      var peak = true;
      for (var dy = -1; dy <= 1 && peak; dy++) for (var dx = -1; dx <= 1; dx++) if ((dx || dy) && D[(y + dy) * w + x + dx] > v) { peak = false; break; }
      if (peak) cand.push({ x: x, y: y, r: v });
    }
    cand.sort(function (a, b) { return b.r - a.r; });
    var grid = {}, G = Math.max(4, Math.round(rMax));
    function near(c) { var gx = Math.floor(c.x / G), gy = Math.floor(c.y / G);
      for (var i = -2; i <= 2; i++) for (var j = -2; j <= 2; j++) { var arr = grid[(gx + i) + ',' + (gy + j)]; if (!arr) continue;
        for (var k = 0; k < arr.length; k++) { var q = arr[k]; var dd = Math.hypot(q.x - c.x, q.y - c.y); if (dd < (q.r + c.r) * 0.72 || dd < q.r * 1.25) return true; } } return false; }
    cand.forEach(function (c) {
      if (near(c)) return;
      var R = c.r * 1.15, inn = 0, tot = 0;                    // disc slightly larger than the inscribed radius: real nuts fill most of it
      for (var yy = Math.max(0, Math.round(c.y - R)); yy <= Math.min(h - 1, Math.round(c.y + R)); yy++) for (var xx = Math.max(0, Math.round(c.x - R)); xx <= Math.min(w - 1, Math.round(c.x + R)); xx++) {
        if ((xx - c.x) * (xx - c.x) + (yy - c.y) * (yy - c.y) > R * R) continue; tot++; if (m[yy * w + xx]) inn++; }
      c.fill = tot ? inn / tot : 0;
      if (c.fill < 0.5 + o.round / 300) return;
      var k = (Math.floor(c.x / G)) + ',' + (Math.floor(c.y / G)); (grid[k] = grid[k] || []).push(c);
      nuts.push({ x: c.x, y: c.y, r: c.r * 1.15, fill: Math.round(c.fill * 100) / 100 });
    });
    // adaptive size check: drop specks much smaller than the typical nut in this photo (gaps between touching nuts, leaf tips)
    if (nuts.length >= 4 && o.adaptive !== false) {
      var rs = nuts.map(function (n) { return n.r; }).sort(function (a, b) { return a - b; }), top = rs.slice(Math.floor(rs.length * 0.5));
      var med = top[Math.floor(top.length / 2)];
      nuts = nuts.filter(function (n) { return n.r >= med * (o.adaptK || 0.6); });
    }
    return { nuts: nuts, mask: m, stats: { candidates: cand.length } };
  }
  // yield maths (estimate only)
  function yieldEstimate(count, p) {
    var cover = Math.max(0.1, +p.coverPct || 10) / 100, treesHa = 10000 / (Math.max(0.5, +p.rowSp || 8) * Math.max(0.5, +p.treeSp || 4));
    var nutsTree = count / cover, kgHa = nutsTree * treesHa * (+p.nisG || 7.5) / 1000;
    return { nutsPerTree: Math.round(nutsTree), treesHa: Math.round(treesHa), kgHa: Math.round(kgHa), tHa: Math.round(kgHa / 100) / 10 };
  }
  // t/ha NIS -> rating 1..5 (Australian orchards commonly ~2.5-4 t/ha NIS; tune with the block's own history)
  var T_BANDS = [0.5, 2, 3.5, 5];
  function ratingFromTHa(t) { var r = 1; for (var i = 0; i < T_BANDS.length; i++) if (t >= T_BANDS[i]) r = i + 2; return r; }
  var api = { detect: detect, enhance: enhance, rgb2hsv: rgb2hsv, yieldEstimate: yieldEstimate, ratingFromTHa: ratingFromTHa, T_BANDS: T_BANDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PhotoCount = api;
})(typeof self !== 'undefined' ? self : this);
