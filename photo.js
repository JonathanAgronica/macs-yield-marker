/* Photo Count screen: capture / choose a photo (or live camera), tune the nut filters with a live mask preview,
   tap to add / remove, yield estimate, save as a mark. "AI count" posts to YM_CONFIG.AI_COUNT_URL (off while blank).

   Performance model (this is what keeps slider drags smooth on a phone):
     - the photo is decoded once, EXIF-corrected, then kept as a downscaled working copy (<= 1280 px long edge);
     - a detection pass runs on a *preview* copy (<= 480 px long edge) while a slider moves, coalesced to one
       pass per animation frame, and only the latest request may write its result (generation counter);
     - when the user lets go, one full-resolution pass replaces the preview; taps are ignored while a pass is running
       so a tap can never land twice or race a detection. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); }, PC = window.PhotoCount, Y = window.YM, App = window.App;
  var SKEY = 'myl-photo-settings-v2', PKEY = 'myl-photo-presets-v1', MAXW = 1280, PREVIEW = 480;
  var WORK = 1280;   // long edge of the working copy (detection + saved mark maths)
  var FILTER_LABEL = { green: 'Green husk', brown: 'Brown nut', shape: 'Shape / blob', satval: 'Saturation + value', hueband: 'Hue band',
    lab: 'LAB a/b', exg: 'ExG vs blue', otsu: 'Otsu auto', edge: 'Edge / circle' };
  var FILTER_NOTE = {
    green: 'Yellow-green husk: hue band, saturation, brightness and excess-green (2g-r-b) together. Best on green set nuts in good light.',
    brown: 'Mature / fallen nuts and brown shells: orange-brown hue, moderate saturation, neither black nor blown out.',
    shape: 'Bright round blobs on a darker canopy (top-hat: brightness minus a wide local mean). Ignores colour.',
    satval: 'Bright waxy husk vs matte leaf: needs BOTH high saturation and high brightness, so dusty leaves and dark shade drop out.',
    hueband: 'Your own hue window (Hue min / Hue max sliders) - the one to reach for when a block has a colour cast.',
    lab: 'CIE LAB separation: high b* (yellow) and high L* (light) pick the husk, with a* keeping green leaf and brown nut apart.',
    exg: 'Excess-green minus blue: (2g-r-b) and (g-b) ratios, so shiny leaves reflecting sky (blue) are rejected.',
    otsu: 'Otsu auto-threshold: finds the cut between nut and leaf from this photo\'s own histogram. Threshold slider biases it.',
    edge: 'Edge / circle: bright top-hat plus radial symmetry (FRST) so partly hidden nuts that only show an arc still count.'
  };
  var PRESETS0 = [
    { name: 'Green husk sunny', o: { filter: 'hueband', thr: 48, hMin: 46, hMax: 104, sat: 24, bri: 26, minR: 14, maxR: 80, round: 45, smooth: 25, topN: 0 } },
    { name: 'Green husk overcast', o: { filter: 'satval', thr: 35, sat: 30, bri: 22, minR: 12, maxR: 80, round: 35, smooth: 40, topN: 0 } },
    { name: 'Brown fallen', o: { filter: 'brown', thr: 25, minR: 10, maxR: 70, round: 30, smooth: 30, topN: 0 } },
    { name: 'Dense canopy', o: { filter: 'otsu', thr: 55, minR: 10, maxR: 46, round: 60, smooth: 35, topN: 40 } }
  ];

  var st = {
    W: 0, H: 0, px: null,          // working copy (<= 1280 px long edge), RGBA
    pw: 0, ph: 0, ppx: null,       // preview copy (<= 480 px long edge), RGBA
    auto: [], added: [], removed: {},
    view: 'highlight', swipe: 50, busy: 0,
    gen: 0,                    // photo identity: bumps on every new photo, so stale async results are dropped
    runGen: 0,                 // detection identity: bumps on every pass, so only the newest result is painted
    mask: null, maskW: 0, maskH: 0, maskVersion: 0,   // mask from the pass that produced the current count
    lastPhoto: null,           // the decoded, EXIF-corrected full photo (for export / AI count)
    stream: null, live: false, tag: null, saving: false, editingName: false
  };
  var o = load();
  function defaults() {
    return { filter: 'green', enhance: false, thr: 50, minR: 14, maxR: 80, round: 45, smooth: 30, topN: 0,
      hMin: 48, hMax: 96, sat: 22, bri: 25, coverPct: 10, nisG: 7.5, rowSp: 8, view: 'highlight', preset: '' };
  }
  function load() {
    var a = {}; try { a = JSON.parse(localStorage.getItem(SKEY)) || {}; } catch (e) {}
    var d = defaults(); for (var k in d) if (a[k] == null) a[k] = d[k];
    if (PC && PC.FILTERS.indexOf(a.filter) < 0) a.filter = 'green';
    return a;
  }
  function saveSet() { try { localStorage.setItem(SKEY, JSON.stringify(o)); } catch (e) {} }
  function presets() {
    var a = []; try { a = JSON.parse(localStorage.getItem(PKEY)) || []; } catch (e) {}
    return (Array.isArray(a) ? a : []).concat([]).map(function (p) { return { name: String(p.name || '').slice(0, 40), o: p.o || {} }; }).filter(function (p) { return p.name; });
  }
  function savePresets(list) { try { localStorage.setItem(PKEY, JSON.stringify(list.slice(0, 40))); } catch (e) {} }
  function allPresets() { return PRESETS0.concat(presets()); }
  // user presets shadow a built-in of the same name, so "Save" over a built-in edits your copy from then on
  function findPreset(name) {
    var mine = presets(); for (var i = mine.length - 1; i >= 0; i--) if (mine[i].name === name) return mine[i];
    for (var j = 0; j < PRESETS0.length; j++) if (PRESETS0[j].name === name) return PRESETS0[j];
    return null;
  }

  // ---------- decode: EXIF orientation + downscale ----------
  // createImageBitmap with imageOrientation:'from-image' applies the EXIF rotation in Chrome/Safari 16+; the <img>
  // fallback relies on the browser's own EXIF handling (all current mobile browsers honour it), so a portrait
  // phone photo is never laid out sideways.
  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return decodeViaImg(file); });
    }
    return decodeViaImg(file);
  }
  function decodeViaImg(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () { URL.revokeObjectURL(url); res(im); };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Could not read that image')); };
      im.src = url;
    });
  }
  function drawTo(src, longEdge) {
    var sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height, s = Math.min(1, longEdge / Math.max(sw, sh));
    var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw * s)); c.height = Math.max(1, Math.round(sh * s));
    var ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(src, 0, 0, c.width, c.height);
    return { px: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
  }

  function setPhoto(src) {
    stopLive();
    var gen = ++st.gen, prev = st.lastPhoto;
    st.lastPhoto = src;
    var work;
    try { work = drawTo(src, WORK); } catch (e) { App.toast('Could not read that image'); return; }
    if (gen !== st.gen) return;
    st.W = work.w; st.H = work.h; st.px = work.px;
    var pv = drawTo(src, PREVIEW); st.pw = pv.w; st.ph = pv.h; st.ppx = pv.px;
    st.auto = []; st.added = []; st.removed = {}; st.mask = null;
    // a retaken photo must not leave the previous ImageBitmap (a full-size camera frame) alive
    if (prev && prev !== src && prev.close) { try { prev.close(); } catch (e) {} }
    var t = st.tag || {};
    $('phWrap').classList.remove('empty');
    $('phTag').textContent = (t.pos ? 'GPS ' + t.pos.lat.toFixed(5) + ', ' + t.pos.lon.toFixed(5) + ' (±' + Math.round(t.pos.acc) + ' m)' : 'No GPS fix - press START on the Mark tab to tag photos') + ' · row ' + (t.row || '-') + ' · tree ' + (t.tree || '-');
    draw();               // paint the original straight away so the screen never sits blank
    analyse(true);        // then detect at full working size
  }

  // ---------- the detection pass ----------
  // Every pass is synchronous inside one animation frame, so a tap can never land "during" a detection;
  // what can go stale is a *scheduled* pass (pending) or a result from an older settings generation (runGen).
  var rafId = 0, pending = null, idleTimer = 0;
  function analyse(full) {
    if (!st.px) return;
    var gen = ++st.runGen;
    if (!full && st.ppx) {
      // fast preview pass on the 480 px copy while a slider is moving: decimated scoring, ~4x cheaper, same count
      // to within a nut or two - the point is to show what the filter grabs as the slider moves, not to be exact
      var po = scaleOpts(o, st.pw, st.W), res = (PC.detectFast || PC.detect)(st.ppx, st.pw, st.ph, po);
      if (gen !== st.runGen) return;
      var kx = st.W / st.pw, ky = st.H / st.ph;
      st.auto = res.nuts.map(function (n) { return { x: n.x * kx, y: n.y * ky, r: n.r * kx, fill: n.fill, score: n.score }; });
      st.mask = res.mask; st.maskW = st.pw; st.maskH = st.ph; st.maskVersion = (st.maskVersion || 0) + 1; st.preview = true;
      st.removed = {};
      draw();
      scheduleFull();
      return;
    }
    var res2 = PC.detect(st.px, st.W, st.H, o);
    if (gen !== st.runGen) return;
    st.auto = res2.nuts; st.mask = res2.mask; st.maskW = st.W; st.maskH = st.H; st.maskVersion = (st.maskVersion || 0) + 1; st.preview = false;
    st.removed = {};
    draw();
  }
  // options scaled for a smaller working copy so the px-radius sliders mean the same on both passes
  function scaleOpts(opts, w, refW) {
    var k = refW / w, c = {}; for (var q in opts) c[q] = opts[q];
    c.minR = Math.max(2, opts.minR / k); c.maxR = Math.max(3, opts.maxR / k);
    return c;
  }
  function scheduleFull() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { if (st.px) analyse(true); }, 200);
  }
  // coalesce every settings change into one preview pass per animation frame
  function request(full) {
    if (pending) return;
    pending = { full: !!full };
    function tick() {
      if (!pending) return;
      pending = null; rafId = 0;
      showBusy(true);
      try { analyse(false); } catch (e) { console.warn('photo detect failed', e); }
      showBusy(false);
    }
    if (window.requestAnimationFrame) rafId = requestAnimationFrame(tick); else setTimeout(tick, 16);
  }
  function showBusy(on) { st.busy = !!on; var b = $('phBusy'); if (b) b.classList.toggle('hidden', !on); }

  function nuts() { return st.auto.filter(function (n, i) { return !st.removed[i]; }).concat(st.added); }

  // ---------- painting ----------
  function circ(ctx, n, col, lw, fill) {
    ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(3, n.r), 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.lineWidth = lw * 2.2; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.stroke();
    ctx.lineWidth = lw; ctx.strokeStyle = col; ctx.stroke();
  }
  function paintImage(ctx, w, h) {
    var src = st.lastPhoto;
    ctx.save(); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, 0, 0, w, h); ctx.restore();
  }
  // mask overlay: pink translucent where the detector sees nut-like pixels, so the user can see exactly what it
  // picks up. Painted from the mask of the pass that produced the count on screen (never a second detection).
  var maskCanvas = document.createElement('canvas'), maskCtx = maskCanvas.getContext('2d'), maskKey = '';
  function paintMask(ctx, w, h) {
    if (!st.mask) return;
    var m = st.mask, mw = st.maskW, mh = st.maskH;
    // rebuild the tinted bitmap only when the mask actually changed (painting happens on every draw, including
    // tap feedback, and re-tinting a megapixel mask each time is pure waste on a phone)
    var key = mw + 'x' + mh + ':' + (st.maskVersion || 0);
    if (key !== maskKey) {
      maskKey = key;
      if (maskCanvas.width !== mw || maskCanvas.height !== mh) { maskCanvas.width = mw; maskCanvas.height = mh; }
      var im = maskCtx.createImageData(mw, mh), d = im.data;
      for (var i = 0, n = m.length; i < n; i++) if (m[i]) { d[i * 4] = 255; d[i * 4 + 1] = 45; d[i * 4 + 2] = 190; d[i * 4 + 3] = 130; }
      maskCtx.putImageData(im, 0, 0);
    }
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.drawImage(maskCanvas, 0, 0, w, h); ctx.restore();
  }
  function drawMarkup(ctx, lw, sx, sy) {
    sx = sx || 1; sy = sy || 1;
    st.auto.forEach(function (n, i) { if (st.removed[i]) return; circ(ctx, { x: n.x * sx, y: n.y * sy, r: n.r * sx }, '#22ff88', lw); });
    st.added.forEach(function (n) { circ(ctx, { x: n.x * sx, y: n.y * sy, r: n.r * sx }, '#00e5ff', lw); });
  }
  var drawQueued = false;
  function draw() {
    if (drawQueued) return; drawQueued = true;
    var go = function () { drawQueued = false; paintNow(); };
    if (window.requestAnimationFrame) requestAnimationFrame(go); else setTimeout(go, 16);
  }
  function paintNow() {
    var c = $('phCanvas'); if (!c || !st.lastPhoto) return;
    var ctx = c.getContext('2d');
    // Backing store follows devicePixelRatio so a 390 px phone with dpr 3 gets a sharp photo, but the drawing
    // coordinate system stays st.W x st.H (so taps, circles and the mask all share one space).
    var cssW = c.clientWidth || c.parentNode.clientWidth || 360;
    var dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    var q = Math.max(1, Math.min(2.5, (cssW * dpr) / Math.max(1, st.W)));
    var bw = Math.round(st.W * q), bh = Math.round(st.H * q);
    if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
    else ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    ctx.setTransform(q, 0, 0, q, 0, 0);
    var lw = Math.max(1.4, st.W / 320), N = nuts().length;
    if (st.view === 'original') {
      paintImage(ctx, st.W, st.H);
      drawMarkup(ctx, lw);
    } else if (st.view === 'compare') {
      paintImage(ctx, st.W, st.H); drawMarkup(ctx, lw);               // left of the handle: highlighted
      var cut = Math.round(st.W * st.swipe / 100), cw = st.W - cut;
      if (cw > 0) {
        ctx.save(); ctx.beginPath(); ctx.rect(cut, 0, cw, st.H); ctx.clip();
        paintImage(ctx, st.W, st.H); drawMarkup(ctx, lw);             // right of the handle: original
        ctx.restore();
        ctx.save(); ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillRect(cut - 1, 0, 2, st.H);
        ctx.font = 'bold ' + Math.round(st.W / 28) + 'px system-ui,sans-serif'; ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(8, 8, Math.round(st.W / 7.2), Math.round(st.W / 24));
        ctx.fillStyle = '#fff'; ctx.fillText('HIGHLIGHT', 14, 11);
        var tw = ctx.measureText('ORIGINAL').width;
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(Math.min(st.W - tw - 20, cut + 8), 8, tw + 12, Math.round(st.W / 24));
        ctx.fillStyle = '#fff'; ctx.fillText('ORIGINAL', Math.min(st.W - tw - 14, cut + 14), 11);
        ctx.restore();
      }
    } else {
      paintImage(ctx, st.W, st.H);
      paintMask(ctx, st.W, st.H);
      drawMarkup(ctx, lw);
    }
    $('phN').textContent = N; $('phNBadge').textContent = N;
    $('phNsub').textContent = '(' + (st.preview ? 'fast preview' : 'auto') + ' ' + st.auto.length + (st.added.length ? ', +' + st.added.length : '') +
      (Object.keys(st.removed).length ? ', −' + Object.keys(st.removed).length : '') + (o.topN ? ', best ' + o.topN : '') + ')';
    calc();
  }
  var calcCache = '';
  function calc() {
    var e = PC.yieldEstimate(nuts().length, { coverPct: o.coverPct, rowSp: o.rowSp, treeSp: treeSp(), nisG: o.nisG }), r = PC.ratingFromTHa(e.tHa), rt = Y.RATINGS[r - 1];
    var html = '<div class="sr"><span>Nuts per tree</span><b>' + e.nutsPerTree + '</b></div><div class="sr"><span>Trees per ha</span><b>' + e.treesHa + '</b></div>' +
      '<div class="sr big"><span>Estimated yield</span><b>' + e.kgHa.toLocaleString() + ' kg/ha · ' + e.tHa + ' t/ha NIS</b></div>' +
      '<div class="sr"><span>Rating</span><b><i class="dot" style="background:' + rt.color + '"></i>' + r + ' ' + rt.label + '</b></div>';
    if (html !== calcCache) { calcCache = html; $('phOut').innerHTML = html; }   // no DOM churn (and no flicker) when nothing changed
    return { e: e, r: r };
  }
  function treeSp() { var v = +$('phTreeSp').value; return v > 0 ? v : App.spacing(); }

  // ---------- taps ----------
  // One tap = one nut. The canvas click handler is the only entry point (no touchstart+click double fire),
  // taps are ignored while a detection pass is running, and a short per-point lockout swallows the second
  // click of a double tap before it can hit a newly drawn circle.
  var lastTap = { t: 0, x: 0, y: 0 };
  function tapCanvas(ev) {
    if (!st.lastPhoto || st.preview || pending || st.busy) return;
    var c = $('phCanvas'), b = c.getBoundingClientRect(); if (!b.width) return;
    var x = (ev.clientX - b.left) * st.W / b.width, y = (ev.clientY - b.top) * st.H / b.height;
    var now = Date.now();
    if (now - lastTap.t < 90 && Math.hypot(x - lastTap.x, y - lastTap.y) < Math.max(6, st.W / 60)) return;
    lastTap = { t: now, x: x, y: y };
    var best = -1, bd = 1e9, src = null;
    st.auto.forEach(function (n, i) { if (st.removed[i]) return; var d = Math.hypot(n.x - x, n.y - y); if (d < Math.max(n.r, 8) * 1.3 && d < bd) { bd = d; best = i; src = 'a'; } });
    st.added.forEach(function (n, i) { var d = Math.hypot(n.x - x, n.y - y); if (d < Math.max(n.r, 8) * 1.3 && d < bd) { bd = d; best = i; src = 'm'; } });
    if (src === 'a') st.removed[best] = true; else if (src === 'm') st.added.splice(best, 1);
    else { var rs = st.auto.map(function (n) { return n.r; }).sort(function (a, b) { return a - b; }); st.added.push({ x: x, y: y, r: rs.length ? rs[rs.length >> 1] : (o.minR + o.maxR) / 2 }); }
    draw();
  }

  // ---------- presets ----------
  function applyPreset(name) {
    var p = findPreset(name); if (!p) return;
    for (var k in p.o) if (k in o) o[k] = p.o[k];
    o.preset = name; saveSet(); syncUi(); st.removed = {}; request(false);
    App.toast('Preset: ' + name);
  }
  var presetSig = '';
  function fillPresetSelect() {
    var sel = $('phPreset'), list = allPresets(), sig = JSON.stringify(list.map(function (p) { return p.name; }));
    if (sig !== presetSig) {   // rebuilding this <select> on every slider tick is what makes a phone stutter
      presetSig = sig;
      sel.innerHTML = '<option value="">Custom / no preset</option>' + list.map(function (p, i) {
        return '<option value="' + esc(p.name) + '">' + esc(p.name) + (i >= PRESETS0.length ? ' (mine)' : '') + '</option>';
      }).join('');
    }
    sel.value = o.preset && findPreset(o.preset) ? o.preset : '';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function presetPayload() {
    var p = {}; ['filter', 'thr', 'hMin', 'hMax', 'sat', 'bri', 'minR', 'maxR', 'round', 'smooth', 'topN', 'enhance'].forEach(function (k) { p[k] = o[k]; }); return p;
  }

  // ---------- live camera ----------
  function startLive() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { App.toast('Live camera not available - use Take photo'); $('phCam').click(); return; }
    stopLive();
    var gen = ++st.gen;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, audio: false }).then(function (s) {
      if (gen !== st.gen || document.body.getAttribute('data-view') !== 'photo') { s.getTracks().forEach(function (t) { t.stop(); }); return; }   // left the screen while the permission prompt was up
      st.stream = s; st.live = true;
      var v = $('phVideo'); v.srcObject = s; v.hidden = false; $('phWrap').classList.remove('empty');
      $('phShutterRow').hidden = false; $('phLive').classList.add('on');
      var t = s.getVideoTracks()[0]; if (t) t.addEventListener('ended', function () { if (st.stream === s) stopLive(); });
      var p = v.play(); if (p && p.catch) p.catch(function () {});
    }).catch(function (e) {
      st.live = false; $('phShutterRow').hidden = true; $('phLive').classList.remove('on');
      var m = e && (e.name || '') ;
      App.toast(m === 'NotAllowedError' ? 'Camera permission denied - use Take photo or Choose' : m === 'NotFoundError' ? 'No camera found - use Choose photo' : 'Camera unavailable - use Take photo', 4000);
    });
  }
  function captureLive() {
    var v = $('phVideo'); if (!st.live || !v || !v.videoWidth) return;
    var c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    var im = new Image(); im.onload = function () { stopLive(); st.tag = st.tag || tagNow('camera'); setPhoto(im); }; im.src = c.toDataURL('image/jpeg', 0.92);
  }
  function stopLive() {
    if (st.stream) { st.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); st.stream = null; }
    var v = $('phVideo'); if (v) { try { v.pause(); } catch (e) {} v.srcObject = null; v.hidden = true; }
    st.live = false; $('phShutterRow').hidden = true; var lb = $('phLive'); if (lb) lb.classList.remove('on');
  }

  // ---------- screen lifecycle ----------
  function tagNow(name) {
    var p = App.lastPos(), s = App.state();
    return { ts: Date.now(), pos: p ? { lat: p.lat, lon: p.lon, acc: p.acc } : null, row: String(s.row), tree: String(Math.floor(s.trees) + 1), name: name || '' };
  }
  function loadFile(file) {
    if (!file) return;
    st.tag = tagNow(file.name);
    decode(file).then(function (bmp) { setPhoto(bmp); }).catch(function () { App.toast('Could not read that image'); });
  }
  // called when the Photo tab is shown / hidden, and on visibilitychange: the camera never keeps a track alive off-screen
  function shown() { syncUi(); }
  function hidden() { stopLive(); }
  var wasLive = false;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { wasLive = st.live; stopLive(); }        // never hold a camera track in the background
    else if (wasLive && document.body.getAttribute('data-view') === 'photo') { wasLive = false; startLive(); }
  });

  // ---------- save ----------
  function saveMark() {
    if (!st.lastPhoto) { App.toast('Take a photo first'); return; }
    if (st.saving) return;
    st.saving = true;
    var res = calc(), t = st.tag || {}, s = App.state();
    var f = { rating: Y.RATINGS[res.r - 1].id, photoCount: nuts().length, estNutsPerTree: res.e.nutsPerTree, estKgHa: res.e.kgHa,
      row: t.row || String(s.row), tree: t.tree || '', photoFilter: o.filter, photoPreset: o.preset || '' };
    var m = App.addMark(f, { pos: t.pos || App.lastPos() });
    st.saving = false;
    if (m) { App.toast('Saved photo estimate: ' + res.e.tHa + ' t/ha (' + Y.RATINGS[res.r - 1].label + ')'); App.beep(900, 90); App.vib(40); }
    else App.toast('No GPS fix - start GPS on the Mark tab, then save');
  }

  // ---------- UI sync ----------
  var SLIDERS = [['phThr', 'thr', ''], ['phHueMin', 'hMin', '°'], ['phHueMax', 'hMax', '°'], ['phSat', 'sat', '%'], ['phBri', 'bri', '%'],
    ['phMin', 'minR', ' px'], ['phMax', 'maxR', ' px'], ['phRnd', 'round', '%'], ['phSm', 'smooth', '%'], ['phTopN', 'topN', '']];
  function syncUi() {
    [].forEach.call(document.querySelectorAll('.ph-filters [data-f]'), function (b) { var on = b.getAttribute('data-f') === o.filter; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    [].forEach.call(document.querySelectorAll('.ph-view [data-v]'), function (b) { var on = b.getAttribute('data-v') === st.view; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    $('phSwipeRow').hidden = st.view !== 'compare'; $('phSwipe').value = st.swipe; $('phSwipeV').textContent = st.swipe + '%';
    $('phEnh').checked = !!o.enhance;
    SLIDERS.forEach(function (s) {
      var e = $(s[0]); if (!e) return;
      if (String(e.value) !== String(o[s[1]])) e.value = o[s[1]];
      var v = $(s[0] + 'V'); if (v) v.textContent = (s[1] === 'topN' ? (o.topN > 0 ? o.topN : 'off') : o[s[1]] + s[2]);
    });
    $('phFilterNote').textContent = FILTER_NOTE[o.filter] || '';
    var hueOn = o.filter === 'green' || o.filter === 'hueband';
    $('phHueMin').disabled = $('phHueMax').disabled = !hueOn;
    $('phHueMin').closest('.field').style.opacity = $('phHueMax').closest('.field').style.opacity = hueOn ? 1 : 0.45;
    $('phCover').value = o.coverPct; $('phNis').value = o.nisG; $('phRowSp').value = o.rowSp; if (!$('phTreeSp').dataset.touched) $('phTreeSp').value = App.spacing();
    var ai = (window.YM_CONFIG || {}).AI_COUNT_URL; $('phAi').disabled = !ai; $('phAiNote').textContent = ai ? '' : 'AI count (server-side model on AgronicaWorld) is coming - disabled until Agronica switches it on.';
    fillPresetSelect();
  }

  // ---------- wiring ----------
  $('phTake').onclick = function () { stopLive(); $('phCam').click(); };
  $('phPick').onclick = function () { stopLive(); $('phFile').click(); };
  $('phLive').onclick = function () { if (st.live) stopLive(); else startLive(); };
  $('phShutter').onclick = captureLive;
  $('phCam').onchange = $('phFile').onchange = function () { var f = this.files[0]; this.value = ''; loadFile(f); };
  $('phCanvas').addEventListener('click', tapCanvas);
  [].forEach.call(document.querySelectorAll('.ph-filters [data-f]'), function (b) {
    b.onclick = function () { o.filter = b.getAttribute('data-f'); o.preset = ''; saveSet(); syncUi(); st.removed = {}; request(false); };
  });
  [].forEach.call(document.querySelectorAll('.ph-view [data-v]'), function (b) {
    b.onclick = function () { st.view = b.getAttribute('data-v'); o.view = st.view; saveSet(); syncUi(); draw(); };
  });
  $('phSwipe').oninput = function () { st.swipe = +this.value; $('phSwipeV').textContent = this.value + '%'; if (st.view === 'compare') draw(); };
  $('phEnh').onchange = function () { o.enhance = this.checked; saveSet(); st.removed = {}; request(false); };
  SLIDERS.forEach(function (s) {
    $(s[0]).oninput = function () {
      o[s[1]] = +this.value;
      if (s[1] === 'minR' && o.minR >= o.maxR) o.maxR = o.minR + 2;
      if (s[1] === 'maxR' && o.maxR <= o.minR) o.minR = Math.max(3, o.maxR - 2);
      o.preset = ''; saveSet();
      var v = $(s[0] + 'V'); if (v) v.textContent = (s[1] === 'topN' ? (o.topN > 0 ? o.topN : 'off') : o[s[1]] + s[2]);
      st.removed = {};
      request(false);
    };
    $(s[0]).onchange = function () { if (st.px) { clearTimeout(idleTimer); analyse(true); } };
  });
  [['phCover', 'coverPct'], ['phNis', 'nisG'], ['phRowSp', 'rowSp']].forEach(function (s) { $(s[0]).oninput = function () { if (+this.value > 0) { o[s[1]] = +this.value; saveSet(); calc(); } }; });
  $('phTreeSp').oninput = function () { this.dataset.touched = 1; calc(); };
  $('phPreset').onchange = function () { if (this.value) applyPreset(this.value); else { o.preset = ''; saveSet(); } };
  $('phPresetSave').onclick = function () {
    var row = $('phPresetNameRow'); row.hidden = false; var i = $('phPresetName');
    i.value = o.preset && presets().every(function (p) { return p.name !== o.preset; }) ? o.preset + ' copy' : (o.preset || '');
    i.focus();
  };
  $('phPresetOk').onclick = function () {
    var name = $('phPresetName').value.trim().slice(0, 40); if (!name) { App.toast('Give the preset a name'); return; }
    var list = presets().filter(function (p) { return p.name !== name; });
    list.push({ name: name, o: presetPayload() }); savePresets(list);
    o.preset = name; saveSet(); $('phPresetNameRow').hidden = true; syncUi(); App.toast('Preset saved: ' + name);
  };
  $('phPresetDel').onclick = function () {
    var name = $('phPreset').value; if (!name) { App.toast('Pick one of your presets first'); return; }
    var builtin = PRESETS0.some(function (p) { return p.name === name; });
    var list = presets().filter(function (p) { return p.name !== name; }); savePresets(list);
    if (builtin) { App.toast('Built-in preset reset'); }
    o.preset = ''; saveSet(); syncUi();
  };
  $('phReset').onclick = function () { st.added = []; st.removed = {}; draw(); };
  $('phSave').onclick = saveMark;
  $('phAi').onclick = function () {
    var url = (window.YM_CONFIG || {}).AI_COUNT_URL; if (!url || !st.lastPhoto) return;
    $('phAiNote').textContent = 'Sending photo to AgronicaWorld...';
    $('phCanvas').toBlob(function (b) {
      if (!b) return;
      var fd = new FormData(); fd.append('photo', b, 'photo.jpg'); fd.append('meta', JSON.stringify({ deviceId: window.Upload && window.Upload.deviceId(), tag: st.tag, filter: o.filter, preset: o.preset }));
      var gen = st.gen;
      fetch(url, { method: 'POST', body: fd }).then(function (r) { return r.json(); }).then(function (j) {
        if (gen !== st.gen) return;                     // a different photo landed while the model was thinking
        if (Array.isArray(j.nuts)) { st.auto = j.nuts; st.removed = {}; st.added = []; draw(); $('phAiNote').textContent = 'AI count: ' + j.nuts.length; } else $('phAiNote').textContent = 'AI count: ' + (j.count != null ? j.count : 'no result');
      }).catch(function (e) { $('phAiNote').textContent = 'AI count failed: ' + e.message; });
    }, 'image/jpeg', 0.85);
  };
  window.Photo = {
    shown: shown, hidden: hidden,
    setImage: function (im, t) { if (t) st.tag = t; setPhoto(im); },
    count: function () { return nuts().length; },
    auto: function () { return st.auto.slice(); },
    opts: o, run: function () { request(false); }, calc: calc,
    // test/debug hooks (also handy for a future calibration screen)
    presets: allPresets, applyPreset: applyPreset, savePreset: function (name) { var l = presets().filter(function (p) { return p.name !== name; }); l.push({ name: name, o: presetPayload() }); savePresets(l); o.preset = name; saveSet(); syncUi(); },
    view: function (v) { if (v) { st.view = v; o.view = v; syncUi(); draw(); } return st.view; },
    state: function () { return { W: st.W, H: st.H, pw: st.pw, ph: st.ph, preview: !!st.preview, busy: !!st.busy, live: st.live, gen: st.gen, filter: o.filter, topN: o.topN }; },
    stopLive: stopLive, tap: tapCanvas
  };
  // hidden camera controls that a UI test (or a keyboard) can drive
  window.addEventListener('pagehide', stopLive);
  syncUi();
  if (location.hash === '#photo-live') setTimeout(startLive, 300);
})();
