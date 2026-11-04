/* Mac's Yield Marker - main app: session + GPS (2 s), driving rating buttons, row / tree counting with 10-tree estimate
   prompts, count / bin weight pad, edit / undo, yield map, summary, KML / CSV export + import, upload queue hook. */
(function () {
  'use strict';
  var KEY = 'myl-state-v1', Y = window.YM;
  var $ = function (id) { return document.getElementById(id); };
  var state = load();
  var watchId = null, tickTimer = null, wakeLock = null, lastPos = null, running = false, statusKind = 'off', updatePending = false;

  function blank() { return { marks: [], track: [], sessions: {}, cur: null, row: 1, trees: 0, lastPromptTree: 0, block: '', variety: 'A4',
    settings: { spacing: {}, every: 10, farm: '', sound: true, autoRow: true } }; }
  function load() {
    try { var s = JSON.parse(localStorage.getItem(KEY)); if (s && Array.isArray(s.marks)) { var b = blank(); for (var k in b) if (s[k] == null) s[k] = b[k]; for (var j in b.settings) if (s.settings[j] == null) s.settings[j] = b.settings[j]; return s; } } catch (e) {}
    return blank();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { msg('Storage full! Export now.'); } }
  var msgT;
  function msg(t, ms) { $('msg').textContent = t || ''; clearTimeout(msgT); if (t) msgT = setTimeout(function () { $('msg').textContent = ''; }, ms || 3500); }
  var toastT;
  function toast(t, ms) { var e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { e.classList.remove('show'); }, ms || 3000); }
  function spacing() { var v = +state.settings.spacing[state.block || '_']; return v > 0 ? v : 4; }
  function every() { var v = +state.settings.every; return v >= 0 ? v : 10; }
  function session() { return state.cur && state.sessions[state.cur]; }

  // ---------- feedback ----------
  var actx = null;
  function beep(freq, ms, n) {
    if (!state.settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      for (var i = 0; i < (n || 1); i++) {
        var o = actx.createOscillator(), g = actx.createGain(), t0 = actx.currentTime + i * (ms / 1000 + 0.07);
        o.frequency.value = freq; o.type = 'square'; g.gain.setValueAtTime(0.18, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + ms / 1000);
        o.connect(g); g.connect(actx.destination); o.start(t0); o.stop(t0 + ms / 1000 + 0.02);
      }
    } catch (e) {}
  }
  function vib(p) { if (state.settings.sound && navigator.vibrate) try { navigator.vibrate(p); } catch (e) {} }
  function flash(text, color) { var f = $('flash'); f.textContent = text; f.style.background = color; f.className = 'show sm'; setTimeout(function () { f.className = ''; }, 380); }

  // ---------- GPS ----------
  function setStatus(txt, cls) { var s = $('status'); s.className = 'pill ' + cls; s.querySelector('b').textContent = txt; statusKind = cls; if (cls === 'off' && updatePending) location.reload(); }
  function onPos(p) {
    lastPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: Date.now(), heading: p.coords.heading, speed: p.coords.speed };
    setStatus('GPS OK', 'on'); renderGps(); if (mapView) mapView.setPos(lastPos);
  }
  function onErr(e) {
    var m = { 1: 'Location permission denied', 2: 'Position unavailable', 3: 'GPS timeout' }[e.code] || e.message;
    msg(m + (location.protocol === 'http:' && location.hostname !== 'localhost' ? ' (GPS needs HTTPS)' : ''), 6000);
    if (running) setStatus('NO FIX', 'wait');
  }
  function start() {
    if (!('geolocation' in navigator)) { msg('Geolocation not supported'); return; }
    var id = 's' + Date.now().toString(36);
    state.sessions[id] = { id: id, block: state.block, variety: state.variety, start: Date.now(), end: null };
    state.cur = id; state.trees = 0; state.lastPromptTree = 0; save();
    running = true; setStatus('WAITING GPS', 'wait');
    watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    tickTimer = setInterval(tick, 2000); requestWake(); setStartBtn(true); render();
  }
  function stop() {
    running = false; clearInterval(tickTimer); tickTimer = null;
    if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; releaseWake();
    var s = session(); if (s) s.end = Date.now();
    closeEst(true); save(); setStatus('STOPPED', 'off'); setStartBtn(false); render();
  }
  function setStartBtn(on) { var b = $('startStop'); b.className = on ? 'stop' : 'start'; b.querySelector('span').textContent = on ? 'STOP' : 'START'; b.querySelector('use').setAttribute('href', on ? '#i-stop' : '#i-play'); }
  // heading of travel from the track (>= 3 m between points), for marks and U-turn (auto row) detection
  var travel = { heading: null, rowHeading: null, flips: 0, anchor: null };
  function tick() {
    if (!lastPos || Date.now() - lastPos.ts > 15000) return;
    var tp = { lat: lastPos.lat, lon: lastPos.lon, acc: lastPos.acc, ts: Date.now() };
    var prev = state.track[state.track.length - 1];
    state.track.push(tp);
    if (prev && lastPos.acc < 30) {
      var d = Y.distM(prev, tp);
      if (d > 0.4 && d < 60) addTreesByDistance(d);
    }
    if (!travel.anchor) travel.anchor = tp;
    else if (Y.distM(travel.anchor, tp) >= 3) { travel.heading = bearing(travel.anchor, tp); travel.anchor = tp; uturnCheck(); }
    save(); renderTrees();
  }
  function bearing(a, b) { var r = Math.PI / 180, y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r), x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r); return (Math.atan2(y, x) / r + 360) % 360; }
  function angDiff(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
  function uturnCheck() {
    var h = travel.heading; if (h == null) return;
    if (travel.rowHeading == null) { travel.rowHeading = h; return; }
    if (angDiff(h, travel.rowHeading) > 135) { if (++travel.flips >= 2) { travel.rowHeading = h; travel.flips = 0; if (state.settings.autoRow) { setRow(state.row + 1, true); toast('U-turn: row ' + state.row); } } }
    else { travel.flips = 0; travel.rowHeading = (travel.rowHeading + ((((h - travel.rowHeading) + 540) % 360) - 180) * 0.2 + 360) % 360; }
  }
  function addTreesByDistance(d) { setTrees(state.trees + d / spacing()); }
  function setTrees(v) {
    state.trees = Math.max(0, v);
    var n = every(), whole = Math.floor(state.trees + 1e-9);
    if (n > 0 && running && whole >= state.lastPromptTree + n) {
      var from = state.lastPromptTree + 1, to = state.lastPromptTree + n; state.lastPromptTree = to;
      openEst(from, to);
    }
    renderTrees();
  }
  function setRow(v, auto) {
    v = Math.max(1, Math.round(v) || 1);
    if (estOpen) closeEst(true);
    state.row = v; state.trees = 0; state.lastPromptTree = 0; save();
    $('rowVal').textContent = v; renderTrees();
    if (!auto) { beep(660, 60); vib(25); }
    else { beep(520, 90, 2); vib([60, 40, 60]); }
  }
  // ---------- wake lock ----------
  function requestWake() { if (!('wakeLock' in navigator) || wakeLock) return; navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; l.addEventListener('release', function () { if (wakeLock === l) wakeLock = null; }); }).catch(function () {}); }
  function releaseWake() { if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; } }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && running && !wakeLock) requestWake(); });

  // ---------- marks ----------
  function here() {
    if (!lastPos || Date.now() - lastPos.ts > 20000) return null;
    return lastPos;
  }
  function addMark(fields, opts) {
    opts = opts || {};
    var p = opts.pos || here();
    if (!p) { msg(running ? 'No GPS fix yet - mark NOT recorded' : 'Press START first - mark NOT recorded', 4000); beep(200, 250); vib([200]); return null; }
    var s = session() || { id: 'manual', block: state.block, variety: state.variety };
    var m = { id: Y.newId(), ts: Date.now(), lat: p.lat, lon: p.lon, acc: p.acc != null ? Math.round(p.acc * 10) / 10 : null,
      heading: travel.heading != null ? Math.round(travel.heading) : (p.heading != null && isFinite(p.heading) ? Math.round(p.heading) : null),
      session: s.id, block: state.block, variety: state.variety, row: String(state.row), tree: String(Math.floor(state.trees) + 1) };
    for (var k in fields) m[k] = fields[k];
    state.marks.push(m);
    refill(); save(); queue(m); render();
    return m;
  }
  function queue(m) { if (window.Upload) { var s = state.sessions[m.session] || { id: m.session, block: m.block, variety: m.variety }; window.__ymExtra = { farm: state.settings.farm }; window.Upload.enqueue(m, s); } }
  function refill() {
    var before = {}; state.marks.forEach(function (m) { if (m.interpolated) before[m.id] = m.rating; });
    Y.fillInterpolated(state.marks);
    state.marks.forEach(function (m) { if (m.interpolated && m.rating && before[m.id] !== m.rating) queue(m); });
  }
  function rate(id) {
    var r = Y.rating(id), m = addMark({ rating: id });
    if (!m) return;
    flash(r.label.toUpperCase(), r.color); beep(300 + r.v * 150, 110); vib(40);
    msg(r.label + ' saved - row ' + m.row + (m.acc != null ? ' (±' + Math.round(m.acc) + ' m)' : ''), 2500);
  }
  function undo() {
    if (!state.marks.length) { msg('Nothing to undo'); return; }
    var m = state.marks.pop(); if (window.Upload) window.Upload.forget(m.id);
    refill(); save(); render(); msg('Removed: ' + Y.markTitle(m)); beep(240, 120); vib(30);
  }
  function delMark(id) {
    var i = state.marks.findIndex(function (m) { return m.id === id; }); if (i < 0) return;
    state.marks.splice(i, 1); if (window.Upload) window.Upload.forget(id); refill(); save(); render();
  }

  // ---------- 10-tree estimate prompt (never blocks GPS; auto-skips after 25 s) ----------
  var estOpen = null, estT = null, ESTMS = 25000;
  function openEst(from, to) {
    if (estOpen) closeEst(true);
    var p = here();
    estOpen = { from: from, to: to, row: state.row, pos: p ? { lat: p.lat, lon: p.lon, acc: p.acc } : null };
    $('estTitle').textContent = 'Trees ' + from + '-' + to; $('estSub').textContent = 'Row ' + state.row + ' - tap the yield estimate (1-5)';
    $('est').classList.remove('hidden');
    var bar = $('estTimer').querySelector('i'); bar.style.transition = 'none'; bar.style.width = '100%';
    requestAnimationFrame(function () { requestAnimationFrame(function () { bar.style.transition = 'width ' + ESTMS + 'ms linear'; bar.style.width = '0%'; }); });
    beep(880, 140, 2); vib([120, 60, 120]);
    clearTimeout(estT); estT = setTimeout(function () { closeEst(true); }, ESTMS);
  }
  function closeEst(skipped, value) {
    if (!estOpen) return;
    var e = estOpen; estOpen = null; clearTimeout(estT); $('est').classList.add('hidden');
    var f = { treeFrom: e.from, treeTo: e.to, row: String(e.row), tree: String(e.to) };
    if (skipped) { f.interpolated = true; f.rating = ''; }
    else { f.estimate = value; f.rating = Y.RATINGS[value - 1].id; }
    var m = addMark(f, { pos: e.pos || here() });
    if (m && !skipped) { var r = Y.rating(m.rating); flash(value + ' ' + r.label.toUpperCase(), r.color); beep(300 + r.v * 150, 110); vib(40); msg('Trees ' + e.from + '-' + e.to + ': ' + r.label); }
    else if (m) msg('Skipped trees ' + e.from + '-' + e.to + ' - will be averaged from nearby marks');
  }

  // ---------- count / weight pad (secondary screen; also used to edit a mark) ----------
  var pad = { unit: 'count', count: '', kg: '', edit: null, rating: '' };
  function openPad(edit) {
    pad = { unit: 'count', count: '', kg: '', edit: edit || null, rating: edit ? edit.rating || '' : '' };
    if (edit) { pad.count = edit.count != null ? String(edit.count) : ''; pad.kg = edit.kg != null ? String(edit.kg) : ''; if (!pad.count && pad.kg) pad.unit = 'kg'; }
    $('padTitle').textContent = edit ? 'Edit mark - ' + Y.fmtLocal(edit.ts).slice(11) : 'Count / bin weight';
    $('padRate').classList.toggle('hidden', !edit); $('padDelete').classList.toggle('hidden', !edit);
    if (edit) { $('padRate').innerHTML = Y.RATINGS.map(function (r) { return '<button type="button" data-r="' + r.id + '" style="--c:' + r.color + '">' + (r.v + 1) + ' ' + r.short + '</button>'; }).join('') + '<label class="pr-row">Row <input id="padRow" inputmode="numeric" value="' + (edit.row || '') + '"></label>'; }
    $('pad').classList.remove('hidden'); renderPad();
  }
  function renderPad() {
    $('padCount').querySelector('b').textContent = pad.count || '–'; $('padKg').querySelector('b').textContent = pad.kg || '–';
    [].forEach.call(document.querySelectorAll('#pad [data-unit]'), function (b) { b.classList.toggle('on', b.getAttribute('data-unit') === pad.unit); });
    $('kDot').disabled = pad.unit === 'count';
    [].forEach.call(document.querySelectorAll('#padRate [data-r]'), function (b) { b.classList.toggle('on', b.getAttribute('data-r') === pad.rating); });
  }
  function padKey(k) {
    var v = pad[pad.unit];
    if (k === 'del') v = v.slice(0, -1);
    else if (k === '.') { if (v.indexOf('.') < 0) v = (v || '0') + '.'; }
    else if (v.length < 7) v = v === '0' ? k : v + k;
    pad[pad.unit] = v; beep(1200, 25); vib(10); renderPad();
  }
  function padSave() {
    var c = pad.count === '' ? null : parseInt(pad.count, 10), w = pad.kg === '' ? null : parseFloat(pad.kg);
    if (pad.edit) {
      var m = pad.edit; m.count = c; m.kg = w; m.rating = pad.rating;
      var rw = $('padRow'); if (rw) m.row = rw.value.trim();
      if (m.rating && m.interpolated) { delete m.interpolated; m.estimate = Y.rating15(m.rating); }
      else if (m.estimate != null && m.rating) m.estimate = Y.rating15(m.rating);
      refill(); save(); queue(m); render(); $('pad').classList.add('hidden'); toast('Mark updated'); return;
    }
    if (c == null && w == null) { toast('Enter a nut count or a weight'); return; }
    var mk = addMark({ count: c, kg: w });
    if (mk) { $('pad').classList.add('hidden'); toast('Saved ' + Y.markTitle(mk)); beep(900, 90); vib(40); }
  }

  // ---------- render ----------
  function curMarks() { return state.marks.filter(function (m) { return m.session === state.cur; }); }
  function renderGps() {
    var t = !running ? 'GPS off · ' + spacing() + ' m trees' : lastPos ? '±' + Math.round(lastPos.acc) + ' m · ' + lastPos.lat.toFixed(5) + ', ' + lastPos.lon.toFixed(5) : 'Waiting for GPS...';
    $('gpsTxt').textContent = t;
  }
  function renderTrees() {
    $('treeVal').textContent = Math.floor(state.trees);
    var n = every(); $('treeNext').textContent = n > 0 ? '/' + (state.lastPromptTree + n) : '';
    $('rowVal').textContent = state.row;
  }
  function render() {
    renderGps(); renderTrees();
    var cm = curMarks(), s = Y.summary(cm);
    $('nmarks').textContent = cm.length + ' marks';
    Y.RATINGS.forEach(function (r) { var e = $('n' + r.id.charAt(0).toUpperCase() + r.id.slice(1)); if (e) e.textContent = s.byRating[r.id] || ''; });
    if (view === 'sum') renderSum();
    if (view === 'map' && mapView) mapView.update(scopeData());
  }
  // summary / list / export scope
  function scopeVal() { var v = $('sumScope').value; return v || 'all'; }
  function scopeData() {
    var v = scopeVal(), marks = v === 'all' ? state.marks : state.marks.filter(function (m) { return m.session === v; });
    var s = state.sessions[v], track = s ? state.track.filter(function (p) { return p.ts >= s.start && (!s.end || p.ts <= s.end); }) : state.track;
    return { marks: marks, track: track };
  }
  function fillScope() {
    var sel = $('sumScope'), cur = sel.value;
    var ids = Object.keys(state.sessions).sort(function (a, b) { return state.sessions[b].start - state.sessions[a].start; });
    sel.innerHTML = '<option value="all">All marks</option>' + ids.map(function (id) { var s = state.sessions[id]; return '<option value="' + id + '">' + Y.fmtLocal(s.start).slice(0, 16) + ' ' + (s.block || '') + ' ' + (s.variety || '') + '</option>'; }).join('');
    sel.value = cur && (cur === 'all' || state.sessions[cur]) ? cur : (state.cur && state.sessions[state.cur] ? state.cur : 'all');
  }
  function renderSum() {
    var d = scopeData(), s = Y.summary(d.marks);
    var h = '<div class="sum-grid">' + Y.RATINGS.map(function (r) { return '<div class="sg" style="--c:' + r.color + '"><b>' + s.byRating[r.id] + '</b><span>' + r.label + '</span></div>'; }).join('') + '</div>';
    h += '<div class="sum-rows">' +
      row('Marks', s.n) + row('Average rating (1-5)', s.avgRating != null ? (s.avgRating + 1).toFixed(2) : '-') +
      row('10-tree estimates', s.estimates + (s.interpolated ? ' (+' + s.interpolated + ' skipped, interpolated)' : '')) +
      row('Nut counts', s.counts ? s.counts + ' (total ' + s.totalCount + ', avg ' + s.avgCount + ')' : '-') +
      row('Bins / bags weighed', s.weighed || '-') + row('Total weight', s.weighed ? s.totalKg + ' kg' : '-') + row('Average weight', s.avgKg != null ? s.avgKg + ' kg' : '-') +
      '</div>';
    var u = window.Upload && window.Upload.status();
    if (u) h += '<div class="dim small-txt">AgronicaWorld upload: ' + (u.enabled ? (u.pending ? u.pending + ' waiting' : 'all sent') + (u.lastErr ? ' · last error ' + u.lastErr : '') : 'off (not configured yet)') + '</div>';
    $('sumBody').innerHTML = h;
    var list = $('list'), ms = d.marks.slice().reverse();
    $('listCount').textContent = d.marks.length;
    list.innerHTML = ms.slice(0, 300).map(function (m) {
      var r = Y.rating(m.rating);
      return '<li data-id="' + m.id + '"' + (m.interpolated ? ' class="interp"' : '') + '><span class="tag" style="background:' + (r ? r.color : '#555') + '">' + (r ? r.v + 1 : '–') + '</span><span class="meta">' + esc(Y.markTitle(m)) +
        '<small>' + Y.fmtLocal(m.ts).slice(5, 16) + ' · row ' + esc(m.row || '-') + (m.block ? ' · ' + esc(m.block) : '') + (m.interpolated ? ' · interpolated' : '') + '</small></span>' +
        '<button type="button" class="del" data-act="edit">Edit</button><button type="button" class="del" data-act="del" aria-label="Delete">✕</button></li>';
    }).join('') + (ms.length > 300 ? '<li class="more dim">+' + (ms.length - 300) + ' older marks (export to see all)</li>' : '');
  }
  function row(a, b) { return '<div class="sr"><span>' + a + '</span><b>' + b + '</b></div>'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---------- views ----------
  var view = 'mark', mapView = null;
  function setView(v) {
    view = v; document.body.setAttribute('data-view', v);
    [['viewMark', 'mark'], ['viewMap', 'map'], ['viewSum', 'sum'], ['viewPhoto', 'photo']].forEach(function (x) { $(x[0]).classList.toggle('active', x[1] === v); });
    [].forEach.call(document.querySelectorAll('.tabs button'), function (b) { var on = b.getAttribute('data-v') === v; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    if (v === 'map') {
      fillScope();
      if (!mapView) mapView = window.YMap.create($('ymap'), { legend: $('legend') });
      setTimeout(function () { mapView.invalidate(); mapView.update(scopeData()); if (lastPos) mapView.setPos(lastPos); }, 30);
    }
    if (v === 'sum') { fillScope(); renderSum(); }
    if (v === 'photo' && window.Photo) window.Photo.shown();
  }

  // ---------- export / import ----------
  function stamp() { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()); }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function shareFile(name, text, type) {
    var file = null; try { file = new File([text], name, { type: type }); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: name, text: "Mac's Yield Marker export" }).catch(function (e) { if (e && e.name !== 'AbortError') download(name, text, type); });
    }
    download(name, text, type); toast('Saved ' + name);
  }
  function exportKml() { var d = scopeDataForExport(); if (!d.marks.length) { toast('No marks to export'); return; } shareFile('yield-' + fileTag() + stamp() + '.kml', Y.buildKml(d, { name: "Mac's Yield Marker " + stamp() }), 'application/vnd.google-earth.kml+xml'); }
  function exportCsv() { var d = scopeDataForExport(); if (!d.marks.length) { toast('No marks to export'); return; } shareFile('yield-' + fileTag() + stamp() + '.csv', Y.buildCsv(d), 'text/csv'); }
  function fileTag() { return state.block ? state.block.replace(/[^\w-]+/g, '_') + '-' : ''; }
  function scopeDataForExport() { if (view === 'sum' || view === 'map') return scopeData(); fillScope(); return scopeData(); }
  function importText(text, name) {
    var d;
    try { d = /\.csv$/i.test(name || '') || /^time,lat,lon/.test(text) ? Y.parseCsv(text) : Y.parseKml(text); } catch (e) { toast('Could not read that file'); return; }
    var r = Y.merge(state.marks, d.marks.filter(function (m) { return isFinite(m.lat) && isFinite(m.lon); }));
    r.added.forEach(function (m) { if (!m.session) m.session = 'import'; if (!state.sessions[m.session]) state.sessions[m.session] = { id: m.session, block: m.block, variety: m.variety, start: m.ts, end: m.ts, imported: true }; });
    state.marks = state.marks.concat(r.added).sort(function (a, b) { return a.ts - b.ts; });
    refill(); save(); render(); fillScope();
    toast('Imported ' + r.added.length + ' marks' + (r.dup ? ', skipped ' + r.dup + ' duplicates' : ''), 4500);
    return r;
  }

  // ---------- wiring ----------
  var vs = $('variety'); vs.innerHTML = Y.VARIETIES.map(function (v) { return '<option>' + v + '</option>'; }).join('');
  function knownVar(v) { return Y.VARIETIES.indexOf(v) >= 0 && v !== 'Other'; }
  vs.value = knownVar(state.variety) ? state.variety : 'Other';
  $('varOther').classList.toggle('hidden', vs.value !== 'Other'); if (vs.value === 'Other') $('varOther').value = state.variety === 'Other' ? '' : state.variety;
  vs.onchange = function () { $('varOther').classList.toggle('hidden', vs.value !== 'Other'); state.variety = vs.value === 'Other' ? ($('varOther').value.trim() || 'Other') : vs.value; syncSess(); };
  $('varOther').oninput = function () { state.variety = $('varOther').value.trim() || 'Other'; syncSess(); };
  $('block').value = state.block;
  $('block').oninput = function () { state.block = $('block').value.trim(); syncSess(); $('setSpacing').value = spacing(); renderTrees(); };
  function syncSess() { var s = session(); if (s && running) { s.block = state.block; s.variety = state.variety; } save(); }
  $('startStop').onclick = function () { running ? stop() : start(); };
  $('undo').onclick = undo;
  [].forEach.call(document.querySelectorAll('[data-rate]'), function (b) { b.addEventListener('click', function () { rate(b.getAttribute('data-rate')); }); });
  $('rowUp').onclick = function () { setRow(state.row + 1); msg('Row ' + state.row); };
  $('rowDn').onclick = function () { setRow(state.row - 1); msg('Row ' + state.row); };
  $('setAutoRow').onchange = function () { state.settings.autoRow = this.checked; save(); };
  $('treeUp').onclick = function () { setTrees(Math.floor(state.trees) + 1); beep(1000, 40); vib(15); };
  function syncToggles() { $('setAutoRow').checked = !!state.settings.autoRow; }
  $('btnCount').onclick = function () { openPad(); };
  [].forEach.call(document.querySelectorAll('#keys [data-k]'), function (b) { b.onclick = function () { padKey(b.getAttribute('data-k')); }; });
  [].forEach.call(document.querySelectorAll('#pad [data-unit]'), function (b) { b.onclick = function () { pad.unit = b.getAttribute('data-unit'); if (pad.unit === 'count') pad.count = pad.count.replace('.', ''); renderPad(); }; });
  $('padRate').onclick = function (e) { var b = e.target.closest('[data-r]'); if (b) { pad.rating = b.getAttribute('data-r'); renderPad(); } };
  $('padSave').onclick = padSave;
  $('padClose').onclick = $('padBack').onclick = function () { $('pad').classList.add('hidden'); };
  $('padDelete').onclick = function () { if (pad.edit && confirm('Delete this mark?')) { delMark(pad.edit.id); $('pad').classList.add('hidden'); toast('Mark deleted'); } };
  [].forEach.call(document.querySelectorAll('#estKeys [data-est]'), function (b) { b.onclick = function () { closeEst(false, +b.getAttribute('data-est')); }; });
  $('estSkip').onclick = function () { closeEst(true); beep(300, 80); };
  [].forEach.call(document.querySelectorAll('.tabs button'), function (b) { b.onclick = function () { setView(b.getAttribute('data-v')); }; });
  // map
  [].forEach.call(document.querySelectorAll('#viewMap .seg [data-mode]'), function (b) { b.onclick = function () {
    [].forEach.call(document.querySelectorAll('#viewMap .seg [data-mode]'), function (x) { x.classList.toggle('on', x === b); });
    mapView.setMode(b.getAttribute('data-mode')); mapView.update(scopeData()); }; });
  $('mapFit').onclick = function () { mapView.fit(scopeData().marks.concat(scopeData().track)); };
  $('mapFollow').onclick = function () { mapView.setFollow(!mapView.follow()); $('mapFollow').classList.toggle('on', mapView.follow()); if (lastPos) mapView.setPos(lastPos); };
  $('mapSave').onclick = function () { var b = $('mapSave'); b.disabled = true; mapView.saveArea(function (d, n) { $('mapMsg').textContent = 'Saving map tiles ' + d + ' / ' + n; }).then(function (n) { $('mapMsg').textContent = 'Saved ' + n + ' tiles for offline use'; }, function (e) { $('mapMsg').textContent = e.message; }).then(function () { b.disabled = false; }); };
  $('ymap').addEventListener('click', function (e) { var b = e.target.closest('[data-edit]'); if (b) { var m = state.marks.find(function (x) { return x.id === b.getAttribute('data-edit'); }); if (m) openPad(m); } });
  // summary
  $('sumScope').onchange = function () { renderSum(); if (mapView && view === 'map') mapView.update(scopeData()); };
  $('list').onclick = function (e) {
    var b = e.target.closest('button'), li = e.target.closest('li[data-id]'); if (!b || !li) return;
    var m = state.marks.find(function (x) { return x.id === li.getAttribute('data-id'); }); if (!m) return;
    if (b.getAttribute('data-act') === 'edit') openPad(m); else if (confirm('Delete this mark?\n' + Y.markTitle(m))) { delMark(m.id); toast('Mark deleted'); }
  };
  $('expKml').onclick = $('mExpKml').onclick = exportKml;
  $('expCsv').onclick = $('mExpCsv').onclick = exportCsv;
  $('impKml').onclick = $('mImp').onclick = function () { $('importFile').click(); };
  $('importFile').onchange = function () { var f = this.files[0]; if (!f) return; f.text().then(function (t) { importText(t, f.name); }); this.value = ''; $('sheet').classList.add('hidden'); };
  // menu + settings
  $('menuBtn').onclick = function () { $('setSpacing').value = spacing(); $('setEvery').value = every(); $('setFarm').value = state.settings.farm || ''; $('setSound').checked = !!state.settings.sound;
    var u = window.Upload && window.Upload.status(); $('upStatus').textContent = u ? (u.enabled ? 'AgronicaWorld upload ON · ' + u.pending + ' waiting' : 'AgronicaWorld upload is off until Agronica sets the server address and key.') + ' Device ID ' + u.deviceId.slice(0, 8) : '';
    $('sheet').classList.remove('hidden'); };
  $('closeSheet').onclick = function () { $('sheet').classList.add('hidden'); };
  $('mSum').onclick = function () { $('sheet').classList.add('hidden'); setView('sum'); };
  $('setSpacing').onchange = function () { var v = +this.value; if (v > 0) { state.settings.spacing[state.block || '_'] = v; save(); renderTrees(); } };
  $('setEvery').onchange = function () { var v = Math.max(0, Math.round(+this.value || 0)); state.settings.every = v; save(); renderTrees(); };
  $('setFarm').oninput = function () { state.settings.farm = this.value.trim(); save(); };
  $('setSound').onchange = function () { state.settings.sound = this.checked; save(); };
  $('clearBtn').onclick = function () { if (!state.marks.length) return; if (confirm('Delete ALL ' + state.marks.length + ' marks on this phone? Export first!')) { state.marks = []; state.track = []; save(); render(); toast('All marks deleted'); } };

  window.App = { state: function () { return state; }, addMark: addMark, rate: rate, setView: setView, setTrees: setTrees, setRow: setRow, openEst: openEst, closeEst: closeEst,
    importText: importText, exportKml: exportKml, exportCsv: exportCsv, lastPos: function () { return lastPos; }, spacing: spacing, toast: toast, beep: beep, vib: vib, map: function () { return mapView; },
    running: function () { return running; }, save: save, render: render, refill: refill };

  if (!window.isSecureContext && location.hostname !== 'localhost') msg('GPS requires HTTPS – open the https:// address', 10000);
  syncToggles(); render();
  if ('serviceWorker' in navigator) {
    var hadCtl = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      var chk = function () { try { reg.update(); } catch (e) {} };
      document.addEventListener('visibilitychange', function () { if (!document.hidden) chk(); });
      setInterval(chk, 30 * 60 * 1000);
    }).catch(function () {});
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadCtl) { hadCtl = true; return; }
      if (reloaded) return;
      if (statusKind === 'off') { reloaded = true; toast('App updated - reloading...', 1500); setTimeout(function () { location.reload(); }, 400); }
      else { updatePending = true; toast('App updated - will reload when GPS stops', 8000); }
    });
  }
})();
