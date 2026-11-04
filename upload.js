/* Queued upload to AgronicaWorld (heat mapping of blocks).
   DISABLED until YM_CONFIG.INGEST_URL and YM_CONFIG.INGEST_KEY are both set (config.js).
   Queue lives in localStorage, survives reloads/offline; retries with exponential backoff (30 s .. 30 min).
   Payload contract: README.md "AgronicaWorld upload payload". */
(function (root) {
  'use strict';
  var QKEY = 'myl-upload-q-v1', DKEY = 'myl-device-id', BATCH = 500;
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
  function markPayload(m) {
    var Y = root.YM, r = Y.rating15(m.rating);
    if (r == null) return null;                               // nothing to map yet (e.g. interpolated with no neighbours)
    var o = { id: m.id, t: new Date(m.ts).toISOString(), lat: +(+m.lat).toFixed(7), lon: +(+m.lon).toFixed(7), rating: r };
    if (m.acc != null) o.acc = Math.round(m.acc * 10) / 10;
    if (m.row !== '' && m.row != null) o.row = String(m.row);
    if (m.kg != null) o.binWeightKg = +m.kg;
    if (m.heading != null && isFinite(m.heading)) o.heading = Math.round(m.heading);
    // extras (server to accept / ignore): treeFrom, treeTo, estimate, interpolated, tree, count, photoCount, estNutsPerTree, estKgHa
    if (m.treeFrom != null) o.treeFrom = m.treeFrom;
    if (m.treeTo != null) o.treeTo = m.treeTo;
    if (m.estimate != null) o.estimate = m.estimate;
    if (m.interpolated) o.interpolated = true;
    if (m.tree !== '' && m.tree != null) o.tree = String(m.tree);
    if (m.count != null) o.count = m.count;
    if (m.photoCount != null) { o.photoCount = m.photoCount; o.estNutsPerTree = m.estNutsPerTree; o.estKgHa = m.estKgHa; }
    return o;
  }
  function sessionPayload(s, extra) {
    var c = cfg(), o = { deviceId: deviceId(), appVersion: c.APP_VERSION || 'v1', sessionId: s.id, submittedAt: new Date().toISOString() };
    var farm = (extra && extra.farm) || c.FARM; if (farm) o.farm = farm;
    if (s.block) o.block = s.block; if (s.variety) o.variety = s.variety;
    if (extra && extra.contact) o.contact = extra.contact;
    return o;
  }
  function binPayload(m) {
    var o = { deviceId: deviceId(), sessionId: m.session || undefined, block: m.block || undefined, binId: m.binId || undefined, weightKg: +m.kg, t: new Date(m.ts).toISOString() };
    if (isFinite(m.lat)) { o.lat = +(+m.lat).toFixed(7); o.lon = +(+m.lon).toFixed(7); }
    return o;
  }
  function binsUrl() { var u = cfg().INGEST_URL || ''; return cfg().BINS_URL || u.replace(/\/submit\/?$/, '/bins'); }

  // ---- queue ----
  // enqueue(mark, session): queues the mark (and its bin weight, if any). Re-queuing an id replaces it (edits / filled interpolations).
  function enqueue(m, s) {
    q.marks[m.id] = { s: s.id, m: m };
    q.sessions[s.id] = { id: s.id, block: s.block, variety: s.variety };
    if (m.kg != null) q.bins[m.id] = m;
    saveQ(); kick();
  }
  function forget(id) { delete q.marks[id]; delete q.bins[id]; saveQ(); }
  function pending() { return Object.keys(q.marks).length + Object.keys(q.bins).length; }
  var busy = false, timer = null;
  function kick(ms) { clearTimeout(timer); timer = setTimeout(flush, ms == null ? 1500 : ms); }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': cfg().INGEST_KEY }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json().catch(function () { return { ok: true }; }); });
  }
  function flush(extra) {
    if (!enabled() || busy || !pending()) return Promise.resolve(status());
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(status());
    if (Date.now() < q.next) { kick(q.next - Date.now()); return Promise.resolve(status()); }
    busy = true;
    var bySess = {};
    var unrated = 0;
    Object.keys(q.marks).forEach(function (id) { var e = q.marks[id], p = markPayload(e.m); if (p) (bySess[e.s] = bySess[e.s] || []).push(p); else { delete q.marks[id]; unrated++; } });
    // no rating yet: stays in the app + CSV/KML, not a rating upload (re-queued if a rating is added on edit)
    var jobs = [];
    Object.keys(bySess).forEach(function (sid) {
      var list = bySess[sid].slice(0, BATCH), s = q.sessions[sid] || { id: sid };
      jobs.push(post(cfg().INGEST_URL, { session: sessionPayload(s, extra || root.__ymExtra), marks: list }).then(function (res) {
        list.forEach(function (p) { if (q.marks[p.id] && root.YM.rating15(q.marks[p.id].m.rating) === p.rating) delete q.marks[p.id]; });
        q.last = { at: Date.now(), res: res };
      }));
    });
    Object.keys(q.bins).slice(0, BATCH).forEach(function (id) {
      jobs.push(post(binsUrl(), binPayload(q.bins[id])).then(function () { delete q.bins[id]; }));
    });
    q.unrated = unrated;
    return Promise.all(jobs).then(function () { q.fails = 0; q.next = 0; }, function (err) {
      q.fails++; q.next = Date.now() + Math.min(30 * 60e3, 30e3 * Math.pow(2, q.fails - 1)); q.lastErr = String(err && err.message || err);
    }).then(function () { busy = false; saveQ(); if (pending() && q.fails === 0) kick(500); else if (pending()) kick(q.next - Date.now()); return status(); });
  }
  function status() { return { enabled: enabled(), pending: pending(), fails: q.fails, next: q.next, last: q.last, lastErr: q.lastErr || '', deviceId: deviceId(), unrated: q.unrated || 0 }; }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', function () { q.next = 0; kick(200); });
    setInterval(function () { kick(0); }, 60e3);
    kick(3000);
  }
  var api = { enabled: enabled, enqueue: enqueue, forget: forget, flush: flush, status: status, deviceId: deviceId, markPayload: markPayload, sessionPayload: sessionPayload, binPayload: binPayload, uuid: uuid, _q: function () { return q; } };
  root.Upload = api;
})(typeof self !== 'undefined' ? self : this);
