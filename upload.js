/* Queued upload to AgronicaWorld (heat mapping of blocks).
   v4 adds optional photo-AI fields on a mark: photoCountSrc ('phone'|'ai'), aiCount, aiPhotoCount, aiKgHa, aiNutsPerTree,
   aiConfidence, aiModel - all optional, so a v3 mark still sends the same shape.
   Payload is FLAT (one session per request): { deviceId, appVersion, sessionId, submittedAt, farm?, block?, variety?,
   contact?, marks: [...], track?: [...] }. Disabled while YM_CONFIG.INGEST_URL / INGEST_KEY are blank (config.js).
   Queue lives in localStorage, survives reloads/offline; retries with exponential backoff (30 s .. 30 min),
   honouring Retry-After on 429. Batches respect the server caps: 5000 marks and 1 MB per request.
   Payload contract: README.md "AgronicaWorld upload payload". */
(function (root) {
  'use strict';
  var QKEY = 'myl-upload-q-v1', DKEY = 'myl-device-id';
  var MAX_BYTES = 950000;    // server body limit is 1 MB; leave room for the JSON framing
  var HARD_BYTES = 1048576;  // express '1mb'
  var MAX_MARKS = 5000;      // server: at most 5000 marks per submission
  var MAX_TRACK = 20000;     // server: at most 20000 track points per submission
  var BIN_PER_FLUSH = 20;    // bins go one request each (server: 300/hour per device)
  var BAD_CHARS = /[^A-Za-z0-9._:-]+/g;   // server sessionId / id class
  var enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  function bytes(s) { return enc ? enc.encode(s).length : s.length; }
  function cfg() { return root.YM_CONFIG || {}; }
  function enabled() { var c = cfg(); return !!(c.INGEST_URL && c.INGEST_KEY); }
  function uuid() {
    if (root.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); (root.crypto || { getRandomValues: function (a) { for (var i = 0; i < a.length; i++) a[i] = Math.random() * 256 | 0; return a; } }).getRandomValues(b);
    b[6] = b[6] & 15 | 64; b[8] = b[8] & 63 | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function deviceId() { var d = null; try { d = localStorage.getItem(DKEY); } catch (e) {} if (!d) { d = uuid(); try { localStorage.setItem(DKEY, d); } catch (e) {} } return d; }
  function loadQ() { try { return JSON.parse(localStorage.getItem(QKEY)) || { marks: {}, bins: {}, sessions: {}, fails: 0, next: 0, last: null }; } catch (e) { return { marks: {}, bins: {}, sessions: {}, fails: 0, next: 0, last: null }; } }
  var q = loadQ();
  function saveQ() { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch (e) {} }

  // ---- payload builders (pure; also used by tests) ----
  function num1(v) { return v == null || v === '' || !isFinite(+v) ? null : +v; }
  function int1(v) { var n = num1(v); return n == null ? null : Math.round(n); }
  function clip(s, n) { return String(s == null ? '' : s).slice(0, n); }
  // sessionId may only contain letters, numbers, . _ : - (max 64); anything else becomes '-'
  function cleanSessionId(v) {
    var s = String(v == null ? '' : v).replace(BAD_CHARS, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
    return s || 'session';
  }
  // One mark in the flat server shape. No `tree` / `count`: the server does not list them (they stay in the app + KML/CSV).
  function markPayload(m) {
    var Y = root.YM, r = Y.rating15(m.rating);
    if (r == null) return null;                               // nothing to map yet (e.g. interpolated with no neighbours)
    var o = { id: clip(m.id || Y.newId(), 64), t: new Date(m.ts).toISOString(), lat: +(+m.lat).toFixed(7), lon: +(+m.lon).toFixed(7), rating: r };
    var acc = num1(m.acc); if (acc != null) o.acc = Math.round(Math.max(0, acc) * 10) / 10;
    if (m.row !== '' && m.row != null) o.row = clip(m.row, 20);
    var kg = num1(m.kg); if (kg != null) o.binWeightKg = Math.min(5000, Math.max(0, kg));
    var hd = num1(m.heading); if (hd != null) o.heading = ((Math.round(hd) % 360) + 360) % 360;
    var tf = int1(m.treeFrom), tt = int1(m.treeTo);
    if (tf != null && tt != null && tt < tf) { tf = null; tt = null; }   // never let one bad pair fail a whole batch
    if (tf != null && tf >= 0) o.treeFrom = tf;
    if (tt != null && tt >= 0) o.treeTo = tt;
    var est = num1(m.estimate); if (est != null && est >= 0) o.estimate = est;
    if (m.interpolated) o.interpolated = true;
    var pc = int1(m.photoCount); if (pc != null && pc >= 0) o.photoCount = pc;
    var npt = num1(m.estNutsPerTree); if (npt != null && npt >= 0) o.estNutsPerTree = npt;
    var kgha = num1(m.estKgHa); if (kgha != null && kgha >= 0) o.estKgHa = kgha;
    // v4: which photo count the mark holds ('phone' | 'ai') and what the AI second opinion said, so a block can be
    // recalibrated against both. Optional and additive: a mark without them (all v3 marks) sends exactly as before.
    if (m.photoCountSrc === 'ai' || m.photoCountSrc === 'phone') o.photoCountSrc = m.photoCountSrc;
    var ac = int1(m.aiCount); if (ac != null && ac >= 0) o.aiCount = ac;
    var apc = int1(m.aiPhotoCount); if (apc != null && apc >= 0) o.aiPhotoCount = apc;
    var akg = num1(m.aiKgHa); if (akg != null && akg >= 0) o.aiKgHa = akg;
    var anpt = num1(m.aiNutsPerTree); if (anpt != null && anpt >= 0) o.aiNutsPerTree = anpt;
    var acf = num1(m.aiConfidence); if (acf != null && acf >= 0 && acf <= 1) o.aiConfidence = Math.round(acf * 100) / 100;
    if (m.aiModel) o.aiModel = clip(m.aiModel, 40);
    return o;
  }
  // Flat top level: no nested session object.
  function sessionPayload(s, extra) {
    var c = cfg(), s0 = s || {};
    var o = { deviceId: deviceId(), appVersion: clip(c.APP_VERSION || 'v1', 32), sessionId: cleanSessionId(s0.id), submittedAt: new Date().toISOString() };
    var farm = (extra && extra.farm) || s0.farm || c.FARM; if (farm) o.farm = clip(farm, 100);
    if (s0.block) o.block = clip(s0.block, 100);
    if (s0.variety) o.variety = clip(s0.variety, 50);
    var ct = extra && extra.contact;
    if (ct && (ct.name || ct.email)) o.contact = { name: clip(ct.name || '', 100) || null, email: clip(ct.email || '', 200) || null };
    return o;
  }
  function submitPayload(s, marks, extra) { var o = sessionPayload(s, extra); o.marks = marks; return o; }
  function binPayload(m) {
    var o = { deviceId: deviceId(), weightKg: Math.min(5000, Math.max(0, num1(m.kg) || 0)), t: new Date(m.ts).toISOString() };
    if (m.session) o.sessionId = cleanSessionId(m.session);
    if (m.block) o.block = clip(m.block, 100);
    o.binId = clip(m.binId || m.id || '', 64) || undefined;   // same id on a resend -> server upserts instead of duplicating
    if (num1(m.lat) != null && num1(m.lon) != null) { o.lat = +(+m.lat).toFixed(7); o.lon = +(+m.lon).toFixed(7); }
    return o;
  }
  function trackPayload(t) {
    if (!Array.isArray(t) || !t.length) return null;
    var pts = t.filter(function (p) { return p && num1(p.lat) != null && num1(p.lon) != null; }).map(function (p) {
      return { lat: +(+p.lat).toFixed(7), lon: +(+p.lon).toFixed(7), t: new Date(p.ts || p.t || Date.now()).toISOString() };
    });
    if (!pts.length) return null;
    if (pts.length > MAX_TRACK) { var src = pts; pts = []; for (var i = 0; i < MAX_TRACK; i++) pts.push(src[Math.floor(i * src.length / MAX_TRACK)]); }
    return pts;
  }
  function binsUrl() { var u = cfg().INGEST_URL || ''; return cfg().BINS_URL || u.replace(/\/submit\/?$/, '/bins'); }

  // ---- batching: <= 5000 marks and <= 1 MB per request ----
  // Splits marks into request bodies (base fields + marks, plus the session track on the first body when it fits).
  function chunks(base, marks, track) {
    var noTrack = bytes(JSON.stringify(base)) + 12;                    // '{"marks":[]}' framing
    var withTrack = noTrack + (track && track.length ? bytes(JSON.stringify(track)) + 11 : 0);
    var trk = track && track.length ? track : null;
    if (trk && withTrack > MAX_BYTES * 0.7) trk = null;                // a huge track must not starve the marks
    var lists = [], cur = [], size = trk ? withTrack : noTrack;
    for (var i = 0; i < marks.length; i++) {
      var len = bytes(JSON.stringify(marks[i])) + 1;
      if (cur.length && (cur.length >= MAX_MARKS || size + len > MAX_BYTES)) { lists.push(cur); cur = []; size = noTrack; }
      cur.push(marks[i]); size += len;
    }
    if (cur.length || !lists.length) lists.push(cur);
    return lists.map(function (list, i) {
      var body = {}, k; for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) body[k] = base[k];
      body.marks = list;
      if (i === 0 && trk) body.track = trk;
      return body;
    });
  }

  // ---- queue ----
  // enqueue(mark, session): queues the mark (and its bin weight, if any). Re-queuing an id replaces it (edits / filled interpolations).
  function enqueue(m, s) {
    q.marks[m.id] = { s: s.id, m: m };
    q.sessions[s.id] = { id: s.id, block: s.block, variety: s.variety };
    if (m.kg != null && num1(m.kg) != null) q.bins[m.id] = m;
    saveQ(); kick();
  }
  function forget(id) { delete q.marks[id]; delete q.bins[id]; saveQ(); }
  function pending() { return Object.keys(q.marks).length + Object.keys(q.bins).length; }
  var busy = false, timer = null;
  function kick(ms) { clearTimeout(timer); timer = setTimeout(flush, ms == null ? 1500 : ms); }
  function notify() {
    if (typeof window === 'undefined' || !window.dispatchEvent) return;
    try { window.dispatchEvent(new CustomEvent('ym-upload-status')); } catch (e) {}
  }
  function post(url, body) {
    var text = JSON.stringify(body);
    if (bytes(text) > HARD_BYTES) { var big = new Error('Upload batch too large (' + bytes(text) + ' bytes)'); big.status = 413; return Promise.reject(big); }
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': cfg().INGEST_KEY }, body: text })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
          if (!r.ok) {
            var e = new Error((j && j.error) || ('HTTP ' + r.status));
            e.status = r.status; e.body = j;
            var ra = r.headers && r.headers.get ? r.headers.get('Retry-After') : null; if (ra) e.retryAfter = +ra || 0;
            throw e;
          }
          return j || { ok: true };
        });
      });
  }
  function unmatchedOf(res) {
    if (!res) return 0;
    if (typeof res.unmatched === 'number') return res.unmatched;
    if (Array.isArray(res.unmatched)) return res.unmatched.length;
    return 0;
  }
  function tally(sum, res) {
    if (!res) return;
    if (typeof res.received === 'number') sum.received += res.received;
    var m = res.matched;
    if (m && typeof m === 'object' && !Array.isArray(m)) Object.keys(m).forEach(function (k) { sum.matched[k] = (sum.matched[k] || 0) + (+m[k] || 0); });
    sum.unmatched += unmatchedOf(res);
  }
  // human text for one server response: matched block counts + how many marks fell outside a block
  function describe(res) {
    if (!res) return '';
    var parts = [], m = res.matched;
    if (m && typeof m === 'object' && !Array.isArray(m)) Object.keys(m).forEach(function (k) { if (+m[k]) parts.push(k + ' ' + m[k]); });
    var rec = typeof res.received === 'number' ? res.received : null;
    return (rec == null ? '' : rec + ' received · ') + (parts.length ? 'matched ' + parts.join(', ') : 'no block matched') + ' · ' + unmatchedOf(res) + ' outside a block';
  }
  function describeError(st, msg) {
    if (st === 401) return 'the server rejected the key (401) - check INGEST_KEY in config.js';
    if (st === 400) return 'server rejected the data (400): ' + msg;
    if (st === 413) return 'too much data for one upload (413): ' + msg;
    if (st === 429) return 'uploading too fast (429): ' + msg;
    if (st >= 500) return 'server error (' + st + '): ' + msg;
    return msg;
  }
  function flush(extra) {
    var raw = extra || {}, stored = root.__ymExtra || {};
    extra = { farm: raw.farm || stored.farm, contact: raw.contact || stored.contact, track: raw.track || stored.track };
    if (!enabled() || busy || !pending()) return Promise.resolve(status());
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(status());
    if (Date.now() < q.next) { kick(q.next - Date.now()); return Promise.resolve(status()); }
    busy = true;
    var groups = {}, unrated = 0;
    Object.keys(q.marks).forEach(function (id) {
      var e = q.marks[id], p = markPayload(e.m), sid = cleanSessionId(e.s);
      if (!p) { delete q.marks[id]; unrated++; return; }        // unrated: stays in the app + CSV/KML, not a rating upload
      var g = groups[sid] || (groups[sid] = { sid: sid, s: q.sessions[e.s] || { id: e.s }, marks: [] });
      g.marks.push(p);
    });
    q.unrated = unrated;
    if (!q.trackSent) q.trackSent = {};
    var run = Promise.resolve(), lastRes = null, sum = { received: 0, matched: {}, unmatched: 0, requests: 0, tracks: 0 };
    Object.keys(groups).forEach(function (sid) {
      var g = groups[sid], sess = {}; for (var k in g.s) sess[k] = g.s[k]; sess.id = sid;
      var base = sessionPayload(sess, extra);
      // the session's GPS track rides along once per new stretch of driving (the server upserts it per session)
      var track = extra.track && cleanSessionId(extra.track.sid) === sid ? trackPayload(extra.track.points) : null;
      if (track && q.trackSent[sid] === track.length) track = null;
      chunks(base, g.marks, track).forEach(function (body) {
        run = run.then(function () {
          return post(cfg().INGEST_URL, body).then(function (res) {
            lastRes = res; sum.requests++; tally(sum, res);     // received:0 on a no-op resend is still a success
            if (body.track) { q.trackSent[sid] = body.track.length; sum.tracks++; }
            body.marks.forEach(function (p) { var e = q.marks[p.id]; if (e && root.YM.rating15(e.m.rating) === p.rating) delete q.marks[p.id]; });
            saveQ();
          });
        });
      });
    });
    Object.keys(q.bins).slice(0, BIN_PER_FLUSH).forEach(function (id) {
      var bin = binPayload(q.bins[id]);
      run = run.then(function () { return post(binsUrl(), bin).then(function () { delete q.bins[id]; saveQ(); }); });
    });
    return run.then(function () {
      q.fails = 0; q.next = 0; q.lastErr = '';
      if (lastRes) q.last = { at: Date.now(), res: lastRes, sum: sum };
      Object.keys(q.trackSent).forEach(function (k) { if (!q.sessions[k] && !groups[k]) delete q.trackSent[k]; });
    }, function (err) {
      var st = err && err.status, msg = String((err && err.message) || err);
      q.lastErr = describeError(st, msg);
      q.fails++;                                               // queue is kept: nothing is wiped on an error
      var wait = Math.min(30 * 60e3, 30e3 * Math.pow(2, q.fails - 1));
      if (err && err.retryAfter) wait = Math.max(wait, err.retryAfter * 1000);
      if (st === 401) wait = Math.max(wait, 10 * 60e3);
      q.next = Date.now() + wait;
    }).then(function () {
      busy = false; saveQ(); notify();
      if (pending() && q.fails === 0) kick(500); else if (pending()) kick(q.next - Date.now());
      return status();
    });
  }
  function status() { return { enabled: enabled(), pending: pending(), fails: q.fails, next: q.next, last: q.last, lastErr: q.lastErr || '', deviceId: deviceId(), unrated: q.unrated || 0 }; }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function timeShort(ts) { var d = new Date(ts); return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  // one line for the Summary + Menu status area: queue state, last upload's matched block counts and unmatched count
  function statusText() {
    var st = status();
    if (!st.enabled) return 'AgronicaWorld upload is off until Agronica sets the server address and key in config.js.';
    var s = 'AgronicaWorld upload ON · ' + (st.pending ? st.pending + ' waiting' : 'all sent');
    if (st.last) s += ' · last upload ' + timeShort(st.last.at) + ' · ' + describe(st.last.sum || st.last.res);
    if (st.lastErr) s += ' · last error: ' + st.lastErr;
    return s;
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', function () { q.next = 0; kick(200); });
    setInterval(function () { kick(0); }, 60e3);
    kick(3000);
  }
  var api = { enabled: enabled, enqueue: enqueue, forget: forget, flush: flush, status: status, statusText: statusText, describe: describe,
    markPayload: markPayload, sessionPayload: sessionPayload, submitPayload: submitPayload, binPayload: binPayload, trackPayload: trackPayload,
    chunks: chunks, cleanSessionId: cleanSessionId, deviceId: deviceId, uuid: uuid, MAX_BYTES: MAX_BYTES, MAX_MARKS: MAX_MARKS, _q: function () { return q; } };
  root.Upload = api;
})(typeof self !== 'undefined' ? self : this);
