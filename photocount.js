/* On-device macadamia nut counter + tunable filter bench (pure maths, no canvas, so it runs in Node tests too).
   detect(rgba, w, h, opts) -> { nuts:[{x,y,r,fill}], mask, score, stats }
   mask(rgba, w, h, opts)   -> Float32Array 0..1 "nut likelihood" (what the Highlight view paints)
   Every filter works in 0..1 pixel scores, so they share one threshold model and one blob/circle stage.

   opts:
     filter  'green' | 'brown' | 'shape' | 'satval' | 'hueband' | 'lab' | 'exg' | 'otsu' | 'edge'
     thr     0..100  score threshold (Otsu replaces it with an automatic cut when filter = 'otsu' and thr = 0)
     hMin,hMax 0..360 hue band (green + hueband)
     sat     0..100 minimum saturation   bri 0..100 minimum value/brightness
     minR,maxR px radius on the working copy   round 0..100 roundness/fill   smooth 0..100 mask smoothing
     topN    0 = all, else keep only the best N circles    enhance bool (CLAHE-style local contrast)
     adaptive bool (drop specks far smaller than the typical nut)                          */
(function (root) {
  'use strict';
  var DEFAULTS = { filter: 'green', enhance: false, thr: 50, minR: 8, maxR: 45, round: 45, smooth: 30,
    hMin: 48, hMax: 96, sat: 22, bri: 25, topN: 0, adaptive: true, adaptK: 0.6, otsuBias: 0 };
  var FILTERS = ['green', 'brown', 'shape', 'satval', 'hueband', 'lab', 'exg', 'otsu', 'edge'];
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rgb2hsv(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return [h, mx ? d / mx : 0, mx / 255];
  }
  // sRGB (0..255) -> CIE L*a*b*; a* is the green(-) / magenta(+) axis, b* the blue(-) / yellow(+) axis
  function srgb2lab(r, g, b) {
    function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    var R = lin(r), G = lin(g), B = lin(b);
    var X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    function f(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
    var fx = f(X), fy = f(Y), fz = f(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  // CLAHE-style local contrast: per-tile clipped histogram equalisation of brightness, bilinearly blended between tiles
  function enhance(px, w, h) {
    var T = 8, tw = Math.ceil(w / T), th = Math.ceil(h / T), maps = [], clip = 3, x, y, k;
    var V = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) V[i] = Math.max(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    for (var ty = 0; ty < T; ty++) for (var tx = 0; tx < T; tx++) {
      var hist = new Float64Array(256), n = 0;
      for (y = ty * th; y < Math.min(h, (ty + 1) * th); y++) for (x = tx * tw; x < Math.min(w, (tx + 1) * tw); x++) { hist[V[y * w + x]]++; n++; }
      var lim = Math.max(1, clip * n / 256), ex = 0;
      for (k = 0; k < 256; k++) if (hist[k] > lim) { ex += hist[k] - lim; hist[k] = lim; }
      var add = ex / 256, cdf = new Uint8Array(256), acc = 0;
      for (k = 0; k < 256; k++) { acc += hist[k] + add; cdf[k] = n ? Math.min(255, Math.round(acc / n * 255)) : k; }
      maps.push(cdf);
    }
    var out = new Uint8ClampedArray(px.length);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var p = y * w + x, v = V[p];
      var fx2 = x / tw - 0.5, fy2 = y / th - 0.5, x0 = Math.max(0, Math.floor(fx2)), y0 = Math.max(0, Math.floor(fy2)), x1 = Math.min(T - 1, x0 + 1), y1 = Math.min(T - 1, y0 + 1);
      var ax = clamp(fx2 - x0, 0, 1), ay = clamp(fy2 - y0, 0, 1);
      var nv = (maps[y0 * T + x0][v] * (1 - ax) + maps[y0 * T + x1][v] * ax) * (1 - ay) + (maps[y1 * T + x0][v] * (1 - ax) + maps[y1 * T + x1][v] * ax) * ay;
      var s = v ? nv / v : 1;
      out[p * 4] = px[p * 4] * s; out[p * 4 + 1] = px[p * 4 + 1] * s; out[p * 4 + 2] = px[p * 4 + 2] * s; out[p * 4 + 3] = 255;
    }
    return out;
  }
  function boxBlur(src, w, h, r) {
    r = Math.max(1, Math.round(r));
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, s, c;
    for (y = 0; y < h; y++) { s = 0; c = 0; for (x = -r; x < w; x++) { if (x + r < w) { s += src[y * w + x + r]; c++; } if (x - r - 1 >= 0) { s -= src[y * w + x - r - 1]; c--; } if (x >= 0) tmp[y * w + x] = s / c; } }
    for (x = 0; x < w; x++) { s = 0; c = 0; for (y = -r; y < h; y++) { if (y + r < h) { s += tmp[(y + r) * w + x]; c++; } if (y - r - 1 >= 0) { s -= tmp[(y - r - 1) * w + x]; c--; } if (y >= 0) out[y * w + x] = s / c; } }
    return out;
  }
  // fraction of pixels under each hue (10-degree bins) - used to snap the green band onto this photo's own foliage
  function hueHistogram(px, w, h) {
    var hist = new Float32Array(36), n = w * h;
    for (var i = 0; i < n; i++) {
      var hsv = rgb2hsv(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
      if (hsv[1] < 0.15 || hsv[2] < 0.1) continue;
      hist[Math.min(35, Math.floor(hsv[0] / 10))]++;
    }
    for (var k = 0; k < 36; k++) hist[k] /= n;
    return hist;
  }
  // Otsu's threshold over a 0..1 score map, searched in 0.02..0.8 (nuts are a minority of the frame)
  function otsu(score, n) {
    var B = 128, hist = new Float64Array(B), i;
    for (i = 0; i < n; i++) hist[Math.min(B - 1, Math.max(0, Math.round(score[i] * (B - 1))))]++;
    var sum = 0; for (i = 0; i < B; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, bestT = Math.round(0.35 * (B - 1));
    for (i = 0; i < B; i++) {
      wB += hist[i]; if (!wB) continue;
      var wF = n - wB; if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; bestT = i; }
    }
    return clamp(bestT / (B - 1), 0.06, 0.85);
  }
  // 0..1 score per pixel for the chosen filter. Higher = more nut-like. Nothing here is a hard mask:
  // the threshold + smoothing + blob stage downstream decide, so the preview and the count always agree.
  var radAt = null;   // per-pixel winning ring radius from the FRST pass (edge/circle filter only)
  var lastRad = null; // radius map from the most recent scoreMap call
  function scoreFor(px, w, h, o) {
    var n = w * h, s = new Float32Array(n), i, x, y;
    var t = o.thr / 100, satMin = o.sat / 100, briMin = o.bri / 100, lo = o.hMin, hi = o.hMax;
    radAt = null;
    if (o.filter === 'shape' || o.filter === 'edge') {
      // top-hat: brightness minus a wide local mean = bright blobs on a darker canopy. 'edge' adds a radial
      // symmetry (FRST) term so partly hidden nuts, which only show an arc, still score as round.
      var L = new Float32Array(n);
      for (i = 0; i < n; i++) L[i] = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) / 255;
      var rad = Math.max(3, Math.round(o.maxR * 1.5)), bl = boxBlur(L, w, h, rad);
      for (i = 0; i < n; i++) s[i] = clamp((L[i] - bl[i]) * 6, 0, 1);
      if (o.filter === 'edge') {
        // Fast radial symmetry transform: every strong gradient votes for the blob centre along its own direction,
        // once per candidate radius, and each radius map is normalised by its ring area so big rings don't win by
        // counting more pixels. A partly hidden nut shows only an arc, and those few votes still land on one centre.
        var rs = [], k;
        for (k = 1; k <= 4; k++) rs.push(Math.max(2.5, o.minR * 0.7 + (o.maxR * 0.75 - o.minR * 0.7) * (k - 1) / 3));
        var gx = new Float32Array(n), gy = new Float32Array(n), g;
        for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
          i = y * w + x;
          gx[i] = (L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1]) / 4;
          gy[i] = (L[i + w - 1] + 2 * L[i + w] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - w] - L[i - w + 1]) / 4;
        }
        var best = new Float32Array(n), bestR = new Float32Array(n);
        for (k = 0; k < rs.length; k++) {
          var votes = new Float32Array(n), r = rs[k], norm = 6.2832 * r;
          for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
            i = y * w + x; g = Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]);
            if (g < 0.05) continue;
            var px2 = Math.round(x + (gx[i] / g) * r), py2 = Math.round(y + (gy[i] / g) * r);
            if (px2 < 1 || py2 < 1 || px2 >= w - 1 || py2 >= h - 1) continue;
            votes[py2 * w + px2] += Math.min(1, g * 3);
          }
          votes = boxBlur(votes, w, h, Math.max(1, Math.round(r * 0.35)));
          for (i = 0; i < n; i++) { var vv = votes[i] / norm * 12; if (vv > best[i]) { best[i] = vv; bestR[i] = r; } }
        }
        // Blend rather than replace: the top-hat already finds the bright arc of a part-hidden nut, and the radial
        // term raises exactly those arcs that curve around one centre while a flat leaf edge (radial response ~0)
        // keeps only its top-hat score and is then rejected by the roundness test downstream.
        for (i = 0; i < n; i++) { var f = clamp(best[i] * 3.6, 0, 1); s[i] = s[i] * (0.45 + 0.55 * f); }
        radAt = bestR;
      }
      return s;
    }
    var hist = null;
    if (o.filter === 'otsu') hist = hueHistogram(px, w, h);
    for (i = 0; i < n; i++) {
      var j = i * 4, r = px[j], gg = px[j + 1], b = px[j + 2], v;
      // HSV inline: this loop runs per pixel per slider tick, so rgb2hsv's array allocation is measurable on a phone
      var mx = r > gg ? (r > b ? r : b) : (gg > b ? gg : b), mn = r < gg ? (r < b ? r : b) : (gg < b ? gg : b);
      var d = mx - mn, hue = 0, sat = mx ? d / mx : 0, val = mx / 255;
      if (d) { if (mx === r) hue = ((gg - b) / d) % 6; else if (mx === gg) hue = (b - r) / d + 2; else hue = (r - gg) / d + 4; hue *= 60; if (hue < 0) hue += 360; }
      switch (o.filter) {
        case 'brown':
          // mature / fallen nuts and brown shells: orange-brown hue, moderately saturated, not too dark or blown out
          v = (hue >= 5 && hue <= 48 ? 1 - Math.abs(hue - 26) / 34 : 0) * clamp((sat - 0.18) / 0.4, 0, 1) * clamp((val - 0.1) / 0.35, 0, 1) * clamp((0.95 - val) / 0.3, 0, 1);
          break;
        case 'satval':
          // bright waxy husk vs matte leaf: husks are both saturated and light; leaves are darker and either
          // very saturated (deep green) or desaturated (dusty green) - the middle band is what we want
          var sw = clamp(1 - Math.abs(((hue - 80 + 540) % 360) - 180) / 55, 0, 1);   // husk yellow-green, not leaf blue-green
          v = sw * clamp((sat - satMin) / 0.3, 0, 1) * clamp((val - briMin) / 0.35, 0, 1);
          break;
        case 'hueband':
          v = (hue >= lo && hue <= hi ? 1 : 0) * clamp((sat - satMin) / 0.3, 0, 1) * clamp((val - briMin) / 0.3, 0, 1);
          break;
        case 'lab':
          // LAB a*/b* separation: husk sits well up the b* (yellow) axis with L* high, leaf is dark with low b*,
          // and a* separates a mature brown nut (a* > 0, magenta side) from both. Works under coloured shade.
          var lab = srgb2lab(r, gg, b);
          v = clamp((lab[2] - 22) / 34, 0, 1) * clamp((lab[0] - 40) / 30, 0, 1) * clamp((lab[0] - 12 - clamp(-lab[1] - 20, 0, 1) * 22) / 30 + 1, 0, 1);
          break;
        case 'exg':
          // excess-green vs blue: ExG = 2g - r - b, then subtract blue so shiny leaves (blue sky reflection) fall away
          var exg = (2 * gg - r - b) / 255, ewb = (gg - b) / 255;
          var ew = clamp(1 - Math.abs(((hue - 80 + 540) % 360) - 180) / 50, 0, 1);   // ExG on its own rewards any green
          v = ew * clamp((exg - 0.06) / 0.14, 0, 1) * clamp((ewb - 0.05) / 0.18, 0, 1) * clamp((val - briMin) / 0.3, 0, 1);
          break;
        case 'otsu':
          // Otsu auto: score how far a pixel sits from this photo's own dominant foliage colour (the biggest hue
          // bin = leaf), weighted toward the *lighter* end, then let Otsu pick the cut between nut and leaf.
          var peak = 6; for (var k2 = 0; k2 < 36; k2++) if (hist[k2] > hist[peak]) peak = k2;
          var hc = peak * 10 + 5, dh = Math.abs(((hue - hc + 540) % 360) - 180);
          v = clamp(dh / 45, 0, 1) * clamp((val - briMin + 0.05) / 0.45, 0, 1) * clamp((sat - satMin * 0.5) / 0.3, 0, 1);
          break;
        default:
          // green husk: yellow-green (hue band, soft edges), lighter and less blue than leaves; ExG separates the
          // husk from leaf shadow. Macadamia husk sits around 60-85 deg, leaf green is more blue-green (90-125 deg).
          var eg = (2 * gg - r - b) / 255, hw = Math.max(6, (hi - lo) * 0.35);
          var hueFit = hue >= lo && hue <= hi ? clamp(Math.min(hue - lo, hi - hue) / hw, 0.35, 1) : 0;
          v = hueFit * clamp((sat - satMin) / 0.3, 0, 1) * clamp((val - briMin) / 0.3, 0, 1) * clamp((eg - 0.02) / 0.12, 0, 1);
      }
      s[i] = clamp(v, 0, 1);
    }
    return s;
  }
  // score map -> smoothed 0..1 likelihood
  function scoreMap(px, w, h, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {}), s = scoreFor(px, w, h, o), rad = radAt, sm = o.smooth == null ? 30 : o.smooth;
    if (sm > 0) s = boxBlur(s, w, h, Math.max(1, Math.round(1 + sm / 25)));   // one box pass: 2x cheaper, same look
    lastRad = rad;
    return s;
  }
  // The cut for a colour/shape score map: a percentile of this photo's own score distribution (robust to a filter's
  // absolute range), blended with a small absolute floor so a nearly-empty frame does not "find" one giant nut.
  function adaptiveCut(s, n, thr) {
    // Otsu on the filter's own score map: it finds the natural break between "foliage" and "nut" for this photo,
    // whatever the filter's absolute range happens to be. Otsu is capped below the frame maximum so a flat,
    // nut-free frame cannot set a cut above everything the filter produces (which would silently return zero).
    var mx = 0; for (var i = 0; i < n; i++) if (s[i] > mx) mx = s[i];
    var cut = otsu(s, n);
    cut = Math.min(cut, Math.max(0.12, mx * 0.55));
    cut += ((thr == null ? 50 : thr) - 50) / 260;      // slider: -0.19 .. +0.19 either side of the automatic cut
    return clamp(cut, 0.08, 0.9);
  }
  // Otsu's cut for a finished score map, nudged by the threshold slider: the slider at 50 is neutral (pure Otsu),
  // 0 subtracts 0.25 and 100 adds 0.25, so the user can bias it either way without losing the auto behaviour.
  function autoCut(s, n, t) { return clamp(otsu(s, n) + ((t == null ? 50 : t) - 50) / 200, 0.04, 0.9); }
  function binarise(s, cut) { var m = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) m[i] = s[i] >= cut ? 1 : 0; return m; }
  // separable 3x3 erosion / dilation: a horizontal then a vertical 3-tap window. Same result as testing all
  // eight neighbours, but it touches each pixel six times instead of nine-with-early-exit (the old hot spot).
  function morph(m, w, h, erode) {
    var tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), x, y, i, a, b, c;
    if (erode) {
      for (y = 0; y < h; y++) { var row = y * w;
        for (x = 0; x < w; x++) { a = x > 0 ? m[row + x - 1] : 0; b = m[row + x]; c = x < w - 1 ? m[row + x + 1] : 0; tmp[row + x] = a && b && c ? 1 : 0; } }
      for (x = 0; x < w; x++) for (y = 0; y < h; y++) { i = y * w + x; a = y > 0 ? tmp[i - w] : 0; b = tmp[i]; c = y < h - 1 ? tmp[i + w] : 0; out[i] = a && b && c ? 1 : 0; }
    } else {
      for (y = 0; y < h; y++) { var row2 = y * w;
        for (x = 0; x < w; x++) { a = x > 0 ? m[row2 + x - 1] : 0; b = m[row2 + x]; c = x < w - 1 ? m[row2 + x + 1] : 0; tmp[row2 + x] = a || b || c ? 1 : 0; } }
      for (x = 0; x < w; x++) for (y = 0; y < h; y++) { i = y * w + x; a = y > 0 ? tmp[i - w] : 0; b = tmp[i]; c = y < h - 1 ? tmp[i + w] : 0; out[i] = a || b || c ? 1 : 0; }
    }
    return out;
  }
  // summed-area table over a Float32/Uint8 plane, stride w+1, so a disc/box mean is four lookups
  function sat(src, w, h) {
    var S = new Float64Array((w + 1) * (h + 1)), x, y;
    for (y = 0; y < h; y++) { var rs = 0;
      for (x = 0; x < w; x++) { rs += src[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + rs; } }
    return S;
  }
  function boxSum(S, w, x0, y0, x1, y1) {   // inclusive pixel box
    if (x1 < x0 || y1 < y0) return 0;
    var W = w + 1;
    return S[(y1 + 1) * W + x1 + 1] - S[y0 * W + x1 + 1] - S[(y1 + 1) * W + x0] + S[y0 * W + x0];
  }
  // mean over the annulus r0..r1 (the "background" around a candidate nut)
  function ringMean(S, w, h, cx, cy, r0, r1) {
    var tot = discMean(S, w, h, cx, cy, r1) * Math.PI * r1 * r1;
    var inn = discMean(S, w, h, cx, cy, r0) * Math.PI * r0 * r0;
    var area = Math.PI * (r1 * r1 - r0 * r0);
    return area > 0 ? (tot - inn) / area : 0;
  }
  // mean over the disc of radius r centred on (cx,cy): summed over rows using the box table (fast + accurate enough)
  function discMean(S, w, h, cx, cy, r) {
    if (r <= 0) return 0;
    var tot = 0, cnt = 0, y, dy, half;
    for (y = Math.max(0, Math.ceil(cy - r)); y <= Math.min(h - 1, Math.floor(cy + r)); y++) {
      dy = y - cy; half = Math.sqrt(Math.max(0, r * r - dy * dy));
      var x0 = Math.max(0, Math.ceil(cx - half)), x1 = Math.min(w - 1, Math.floor(cx + half));
      if (x1 < x0) continue;
      tot += boxSum(S, w, x0, y, x1, y); cnt += x1 - x0 + 1;
    }
    return cnt ? tot / cnt : 0;
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
  // Fast path for live slider drags: the score map is computed on every other pixel and the mask is upsampled, and
  // the close is a single pass. Roughly 4x cheaper with the same count to within a nut or two, which is all a
  // "what am I about to pick up?" preview needs to be.
  function detectFast(px, w, h, o) {
    o = Object.assign({}, DEFAULTS, o || {}, { fast: true });
    var S2 = 2, w2 = Math.ceil(w / S2), h2 = Math.ceil(h / S2);
    var small = new Uint8ClampedArray(w2 * h2 * 4);
    for (var y2 = 0; y2 < h2; y2++) for (var x2 = 0; x2 < w2; x2++) {
      var si = ((y2 * S2) * w + x2 * S2) * 4, di = (y2 * w2 + x2) * 4;
      small[di] = px[si]; small[di + 1] = px[si + 1]; small[di + 2] = px[si + 2]; small[di + 3] = 255;
    }
    var r = detect(small, w2, h2, Object.assign({}, o, { minR: o.minR / S2, maxR: o.maxR / S2, smooth: o.smooth }));
    var m = new Uint8Array(w * h);
    for (y2 = 0; y2 < h; y2++) for (x2 = 0; x2 < w; x2++) m[y2 * w + x2] = r.mask[Math.min(h2 - 1, (y2 / S2) | 0) * w2 + Math.min(w2 - 1, (x2 / S2) | 0)];
    r.mask = m;
    r.nuts = r.nuts.map(function (n) { return { x: n.x * S2, y: n.y * S2, r: n.r * S2, fill: n.fill, score: n.score, contrast: n.contrast }; });
    r.stats.fast = true;
    return r;
  }
  function detect(px, w, h, o) {
    o = Object.assign({}, DEFAULTS, o || {});
    var img = o.enhance ? enhance(px, w, h) : px;
    var s = scoreMap(img, w, h, o), n = w * h;
    // The score ranges differ by filter (a hue test is near 0/1, a LAB product rarely passes 0.7), so a fixed cut
    // would starve some filters and drown others. Take the cut as a fraction of this map's own upper percentile:
    // thr 50 sits just under the 90th percentile of nut-likeness, and the slider moves it over a wide band.
    var cut = o.filter === 'otsu' ? autoCut(s, n, o.thr) : adaptiveCut(s, n, o.thr);
    var m = binarise(s, cut);
    m = morph(morph(m, w, h, true), w, h, false);           // open: removes speckle and thin leaf edges
    if (!o.fast) m = morph(morph(morph(m, w, h, false), w, h, true), w, h, true);   // close: fills specular highlights inside nuts
    else m = morph(m, w, h, false);
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
    var satM = sat(m, w, h), satS = sat(s, w, h);
    cand.forEach(function (c) {
      if (near(c)) return;
      var R = c.r * 1.15;
      c.fill = discMean(satM, w, h, c.x, c.y, R);      // how much of the disc is mask: real nuts fill most of it
      // "Is this a nut, or a patch of leaf?" A nut stands out from the foliage around it: the mean score inside the
      // circle is clearly higher than in the ring just outside. Leaf texture is self-similar, so its contrast is
      // small. This is the single most effective false-positive test on real canopy photos.
      var inner = discMean(satS, w, h, c.x, c.y, c.r * 0.85);
      var outer = ringMean(satS, w, h, c.x, c.y, c.r * 1.15, c.r * 1.8);
      c.contrast = inner - outer;
      if (c.fill < 0.5 + o.round / 300) return;
      // roundness also sets how much local contrast a blob needs; a blob sitting right at the minimum size gets a
      // higher bar, because sub-nut-sized bright specks are leaf highlights more often than they are nuts
      var atFloor = c.r <= o.minR * 0.92;
      if (c.contrast < (atFloor ? 0.16 : 0.09) + o.round / 500) return;
      var k = (Math.floor(c.x / G)) + ',' + (Math.floor(c.y / G)); (grid[k] = grid[k] || []).push(c);
      nuts.push({ x: c.x, y: c.y, r: R, fill: Math.round(c.fill * 100) / 100, score: Math.round(discMean(satS, w, h, c.x, c.y, R) * 100) / 100,
        contrast: Math.round(c.contrast * 100) / 100 });
    });
    // adaptive size check: drop specks much smaller than the typical nut in this photo (gaps between touching nuts, leaf tips)
    if (nuts.length >= 4 && o.adaptive !== false) {
      var rs = nuts.map(function (nn) { return nn.r; }).sort(function (a, b) { return a - b; }), top = rs.slice(Math.floor(rs.length * 0.5));
      var med = top[Math.floor(top.length / 2)] || 0;
      if (med > 0) nuts = nuts.filter(function (nn) { return nn.r >= med * (o.adaptK || 0.6); });
    }
    // 'only show best N': rank by how nut-like each circle is (mean filter strength over its disc x how full it is),
    // so a dense canopy collapses to the handful of most confident nuts instead of hundreds of leaves
    nuts.sort(function (a, b) { return (b.score * b.fill) - (a.score * a.fill); });
    if (o.topN > 0 && nuts.length > o.topN) nuts = nuts.slice(0, o.topN);
    return { nuts: nuts, mask: m, score: s, stats: { candidates: cand.length, cut: Math.round(cut * 100) / 100 } };
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
  var api = { detect: detect, detectFast: detectFast, scoreMap: scoreMap, enhance: enhance, rgb2hsv: rgb2hsv, srgb2lab: srgb2lab, otsu: otsu,
    yieldEstimate: yieldEstimate, ratingFromTHa: ratingFromTHa, T_BANDS: T_BANDS, FILTERS: FILTERS, DEFAULTS: DEFAULTS, adaptiveCut: adaptiveCut };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PhotoCount = api;
})(typeof self !== 'undefined' ? self : this);
