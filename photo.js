/* Photo Count screen: capture / choose a photo, tag with GPS + row + tree, count nuts on-device (PhotoCount),
   tap to add / remove, yield estimate, save as a mark. "AI count" posts to YM_CONFIG.AI_COUNT_URL (disabled while blank; no keys in this app). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); }, PC = window.PhotoCount, Y = window.YM, App = window.App;
  var SKEY = 'myl-photo-settings-v1', MAXW = 720;
  var img = null, W = 0, H = 0, px = null, auto = [], added = [], removed = {}, tag = null;
  var set = (function () { try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch (e) { return {}; } })();
  var o = Object.assign({ filter: 'green', enhance: false, thr: 50, minR: 8, maxR: 45, round: 45, coverPct: 10, nisG: 7.5, rowSp: 8 }, set);
  function saveSet() { try { localStorage.setItem(SKEY, JSON.stringify(o)); } catch (e) {} }
  function load(file) {
    var p = App.lastPos(), st = App.state();
    tag = { ts: Date.now(), pos: p ? { lat: p.lat, lon: p.lon, acc: p.acc } : null, row: String(st.row), tree: String(Math.floor(st.trees) + 1), name: file.name };
    var url = URL.createObjectURL(file), im = new Image();
    im.onload = function () { setImage(im); URL.revokeObjectURL(url); };
    im.src = url;
  }
  function setImage(im) {
    img = im; var s = Math.min(1, MAXW / Math.max(im.naturalWidth, im.naturalHeight)); W = Math.round(im.naturalWidth * s); H = Math.round(im.naturalHeight * s);
    var c = $('phCanvas'); c.width = W; c.height = H;
    var ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0, W, H); px = ctx.getImageData(0, 0, W, H).data;
    added = []; removed = {}; $('phWrap').classList.remove('empty');
    var t = tag || {};
    $('phTag').textContent = (t.pos ? 'GPS ' + t.pos.lat.toFixed(5) + ', ' + t.pos.lon.toFixed(5) + ' (±' + Math.round(t.pos.acc) + ' m)' : 'No GPS fix - press START on the Mark tab to tag photos') + ' · row ' + (t.row || '-') + ' · tree ' + (t.tree || '-');
    run();
  }
  var runT;
  function run() { clearTimeout(runT); runT = setTimeout(function () { if (!px) return; auto = PC.detect(px, W, H, o).nuts; removed = {}; draw(); }, 60); }
  function nuts() { return auto.filter(function (n, i) { return !removed[i]; }).concat(added); }
  function draw() {
    var c = $('phCanvas'), ctx = c.getContext('2d'); if (!img) return;
    ctx.drawImage(img, 0, 0, W, H);
    var lw = Math.max(1.5, W / 320);
    auto.forEach(function (n, i) { if (removed[i]) return; circle(ctx, n, n.cluster ? '#ffb400' : '#ff2bd6', lw); });
    added.forEach(function (n) { circle(ctx, n, '#00e5ff', lw); });
    var N = nuts().length; $('phN').textContent = N;
    $('phNsub').textContent = '(auto ' + auto.length + (added.length ? ', +' + added.length : '') + (Object.keys(removed).length ? ', −' + Object.keys(removed).length : '') + ')';
    calc();
  }
  function circle(ctx, n, col, lw) { ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(3, n.r), 0, Math.PI * 2); ctx.lineWidth = lw * 2.2; ctx.strokeStyle = '#000a'; ctx.stroke(); ctx.lineWidth = lw; ctx.strokeStyle = col; ctx.stroke(); }
  function calc() {
    var e = PC.yieldEstimate(nuts().length, { coverPct: o.coverPct, rowSp: o.rowSp, treeSp: treeSp(), nisG: o.nisG }), r = PC.ratingFromTHa(e.tHa), rt = Y.RATINGS[r - 1];
    $('phOut').innerHTML = '<div class="sr"><span>Nuts per tree</span><b>' + e.nutsPerTree + '</b></div><div class="sr"><span>Trees per ha</span><b>' + e.treesHa + '</b></div>' +
      '<div class="sr big"><span>Estimated yield</span><b>' + e.kgHa.toLocaleString() + ' kg/ha · ' + e.tHa + ' t/ha NIS</b></div>' +
      '<div class="sr"><span>Rating</span><b><i class="dot" style="background:' + rt.color + '"></i>' + r + ' ' + rt.label + '</b></div>';
    return { e: e, r: r };
  }
  function treeSp() { var v = +$('phTreeSp').value; return v > 0 ? v : App.spacing(); }
  function tapCanvas(ev) {
    if (!img) return;
    var c = $('phCanvas'), b = c.getBoundingClientRect(), x = (ev.clientX - b.left) * W / b.width, y = (ev.clientY - b.top) * H / b.height;
    var best = -1, bd = 1e9, src = null;
    auto.forEach(function (n, i) { if (removed[i]) return; var d = Math.hypot(n.x - x, n.y - y); if (d < Math.max(n.r, 8) * 1.3 && d < bd) { bd = d; best = i; src = 'a'; } });
    added.forEach(function (n, i) { var d = Math.hypot(n.x - x, n.y - y); if (d < Math.max(n.r, 8) * 1.3 && d < bd) { bd = d; best = i; src = 'm'; } });
    if (src === 'a') removed[best] = true; else if (src === 'm') added.splice(best, 1);
    else { var rs = auto.map(function (n) { return n.r; }).sort(function (a, b) { return a - b; }); added.push({ x: x, y: y, r: rs.length ? rs[rs.length >> 1] : (o.minR + o.maxR) / 2 }); }
    draw();
  }
  function saveMark() {
    if (!img) { App.toast('Take a photo first'); return; }
    var res = calc(), t = tag || {}, st = App.state();
    var f = { rating: Y.RATINGS[res.r - 1].id, photoCount: nuts().length, estNutsPerTree: res.e.nutsPerTree, estKgHa: res.e.kgHa, row: t.row || String(st.row), tree: t.tree || '' , photoFilter: o.filter };
    var m = App.addMark(f, { pos: t.pos || App.lastPos() });
    if (m) { App.toast('Saved photo estimate: ' + res.e.tHa + ' t/ha (' + Y.RATINGS[res.r - 1].label + ')'); App.beep(900, 90); App.vib(40); }
    else App.toast('No GPS fix - start GPS on the Mark tab, then save');
  }
  function syncUi() {
    [].forEach.call(document.querySelectorAll('.ph-seg [data-f]'), function (b) { b.classList.toggle('on', b.getAttribute('data-f') === o.filter); });
    $('phEnh').checked = !!o.enhance;
    [['phThr', 'thr', ''], ['phMin', 'minR', ' px'], ['phMax', 'maxR', ' px'], ['phRnd', 'round', '%']].forEach(function (s) { $(s[0]).value = o[s[1]]; $(s[0] + 'V').textContent = o[s[1]] + s[2]; });
    $('phCover').value = o.coverPct; $('phNis').value = o.nisG; $('phRowSp').value = o.rowSp; if (!$('phTreeSp').dataset.touched) $('phTreeSp').value = App.spacing();
    var ai = (window.YM_CONFIG || {}).AI_COUNT_URL; $('phAi').disabled = !ai; $('phAiNote').textContent = ai ? '' : 'AI count (server-side model on AgronicaWorld) is coming - disabled until Agronica switches it on.';
  }
  // ---- wiring ----
  $('phTake').onclick = function () { $('phCam').click(); };
  $('phPick').onclick = function () { $('phFile').click(); };
  $('phCam').onchange = $('phFile').onchange = function () { if (this.files[0]) load(this.files[0]); this.value = ''; };
  $('phCanvas').addEventListener('click', tapCanvas);
  [].forEach.call(document.querySelectorAll('.ph-seg [data-f]'), function (b) { b.onclick = function () { o.filter = b.getAttribute('data-f'); saveSet(); syncUi(); run(); }; });
  $('phEnh').onchange = function () { o.enhance = this.checked; saveSet(); run(); };
  [['phThr', 'thr'], ['phMin', 'minR'], ['phMax', 'maxR'], ['phRnd', 'round']].forEach(function (s) { $(s[0]).oninput = function () { o[s[1]] = +this.value; if (o.minR >= o.maxR) { if (s[1] === 'minR') o.maxR = o.minR + 2; else o.minR = Math.max(2, o.maxR - 2); } saveSet(); syncUi(); run(); }; });
  [['phCover', 'coverPct'], ['phNis', 'nisG'], ['phRowSp', 'rowSp']].forEach(function (s) { $(s[0]).oninput = function () { if (+this.value > 0) { o[s[1]] = +this.value; saveSet(); calc(); } }; });
  $('phTreeSp').oninput = function () { this.dataset.touched = 1; calc(); };
  $('phReset').onclick = function () { added = []; removed = {}; draw(); };
  $('phSave').onclick = saveMark;
  $('phAi').onclick = function () {
    var url = (window.YM_CONFIG || {}).AI_COUNT_URL; if (!url || !img) return;
    $('phAiNote').textContent = 'Sending photo to AgronicaWorld...';
    $('phCanvas').toBlob(function (b) {
      var fd = new FormData(); fd.append('photo', b, 'photo.jpg'); fd.append('meta', JSON.stringify({ deviceId: window.Upload && window.Upload.deviceId(), tag: tag, filter: o.filter }));
      fetch(url, { method: 'POST', body: fd }).then(function (r) { return r.json(); }).then(function (j) {
        if (Array.isArray(j.nuts)) { auto = j.nuts; removed = {}; added = []; draw(); $('phAiNote').textContent = 'AI count: ' + j.nuts.length; } else $('phAiNote').textContent = 'AI count: ' + (j.count != null ? j.count : 'no result');
      }).catch(function (e) { $('phAiNote').textContent = 'AI count failed: ' + e.message; });
    }, 'image/jpeg', 0.85);
  };
  window.Photo = { shown: syncUi, setImage: function (im, t) { tag = t || tag; setImage(im); }, count: function () { return nuts().length; }, auto: function () { return auto.slice(); }, opts: o, run: run, calc: calc };
  syncUi();
})();
