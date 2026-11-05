/* Server-side AI nut count (AgronicaWorld POST /api/yield/ai-count).
   Keeps the network, the client-side downscale and the spend bookkeeping out of photo.js so the screen code
   stays about the photo. The OpenAI key lives on the server: this file only ever sends the public ingest key.

   contract (README "AI count"):
     POST {AI_COUNT_URL}  X-Ingest-Key: <config INGEST_KEY>  multipart/form-data
       image   JPEG, long edge ~1600 px, quality 0.85 (downscaled here before upload)
       deviceId, sessionId, block, variety, row, treeFrom, treeTo, coverPct, rowSp, treeSp, nisG   (optional)
     ->  { ok, count, confidence, detections:[{x,y,r}] (0..1, r a fraction of width), nutsPerTree, kgHa, model, note }
     errors: 400 bad field, 413 too big (retried once smaller here), 415, 429 + Retry-After, 502, 503 no key
   limits: 30 calls/device/hour, 60/IP/hour. Cost ~3.1 US cents a photo on the default model. */
(function (root) {
  'use strict';
  var EDGE = 1600, EDGE_RETRY = 1200, QUALITY = 0.85, QUALITY_RETRY = 0.8;
  var MAX_BYTES = 6 * 1024 * 1024;          // server: image <= 6 MB, body <= 8 MB
  var COST_CENTS = 3;                       // ~3.1c: the notice says "about 3c"
  var SKEY = 'myl-ai-stats-v1', NKEY = 'myl-ai-notice-v1';

  var env = (typeof root !== 'undefined' ? root : {});

  // ---------- spend bookkeeping (device-local, survives reloads) ----------
  function read(k, d) { try { var v = JSON.parse(root.localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function write(k, v) { try { root.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function stats() { var s = read(SKEY, null) || {}; return { calls: s.calls || 0, last: s.last || null, cents: Math.round((s.calls || 0) * COST_CENTS) }; }
  function bump(extra) {
    var s = stats(); s.calls++;
    var out = { calls: s.calls, last: extra || null };
    write(SKEY, out); return stats();
  }
  function resetStats() { write(SKEY, { calls: 0, last: null }); return stats(); }
  // the cost line shows until the user ticks "don't show again" (defaults to hiding it forever on this phone)
  function noticeSeen() { return !!read(NKEY, false); }
  function setNoticeSeen(on) { write(NKEY, !!on); }

  // ---------- downscale ----------
  function srcSize(src) {
    return { w: src.naturalWidth || src.videoWidth || src.width || 0, h: src.naturalHeight || src.videoHeight || src.height || 0 };
  }
  // Draw the decoded photo onto a canvas with the long edge at `longEdge` (never upscaled) and encode it as JPEG.
  // EXIF is already applied upstream (createImageBitmap from-image / <img>), so this is a straight resample.
  function downscale(src, longEdge, quality) {
    longEdge = longEdge || EDGE; quality = quality || QUALITY;
    var s = srcSize(src), scale = Math.min(1, longEdge / Math.max(s.w || 1, s.h || 1));
    var w = Math.max(1, Math.round(s.w * scale)), h = Math.max(1, Math.round(s.h * scale));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    function encode(q) {
      return new Promise(function (res, rej) {
        if (c.toBlob) c.toBlob(function (b) { b ? res(b) : rej(new Error('Could not encode the photo')); }, 'image/jpeg', q);
        else { try { res(dataUrlBlob(c.toDataURL('image/jpeg', q))); } catch (e) { rej(e); } }
      });
    }
    return encode(quality).then(function (b) { return { blob: b, w: w, h: h, type: b.type || 'image/jpeg' }; });
  }
  function dataUrlBlob(url) {
    var parts = String(url).split(','), bin = atob(parts[1]), buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: 'image/jpeg' });
  }

  // ---------- request ----------
  function form(blob, meta) {
    var fd = new FormData();
    fd.append('image', blob, 'nut-photo.jpg');
    var m = meta || {};
    ['deviceId', 'sessionId', 'block', 'variety', 'row', 'treeFrom', 'treeTo', 'coverPct', 'rowSp', 'treeSp', 'nisG'].forEach(function (k) {
      var v = m[k];
      if (v == null || v === '') return;
      if (k === 'treeFrom' || k === 'treeTo') { v = Math.round(+v); if (!isFinite(v) || v < 0) return; }
      fd.append(k, String(v));
    });
    return fd;
  }
  function AiError(status, message, extra) {
    var e = new Error(message || ('HTTP ' + status)); e.status = status || 0;
    if (extra) for (var k in extra) if (extra[k] != null) e[k] = extra[k];
    return e;
  }
  // one POST; resolves with the parsed body, rejects with {status, retryAfter, body}
  function post(url, key, fd, timeoutMs) {
    var ctl = null, timer = 0;
    try { if (root.AbortController) ctl = new root.AbortController(); } catch (e) {}
    if (ctl) timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, timeoutMs || 60000);
    return fetch(url, { method: 'POST', headers: { 'X-Ingest-Key': key || '' }, body: fd, signal: ctl ? ctl.signal : undefined, mode: 'cors', credentials: 'omit' })
      .then(function (r) {
        clearTimeout(timer);
        return r.text().then(function (t) {
          var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
          if (!r.ok) {
            // Retry-After is only readable cross-origin when the server exposes it, so fall back to a number in the
            // error text ("try again in 42 s") and to a sane default in describe().
            var ra = 0;
            try { ra = +((r.headers && r.headers.get && r.headers.get('Retry-After')) || 0); } catch (e) { ra = 0; }
            var msg = (j && (j.error || j.message)) || ('HTTP ' + r.status);
            if (!(isFinite(ra) && ra > 0)) { var mm = String(msg).match(/(\d{1,5})\s*(?:s\b|sec|second)/i); if (mm) ra = +mm[1]; }
            throw AiError(r.status, msg, { retryAfter: isFinite(ra) && ra > 0 ? ra : 0, body: j });
          }
          if (!j) throw AiError(502, 'The AI server sent an empty reply');
          return j;
        });
      }, function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') throw AiError(0, 'The AI count timed out (60 s) - the on-phone count is still here');
        throw AiError(0, (err && err.message) || 'Network error');
      });
  }

  // downscale -> post; on 413 shrink once and retry. `onStage('downscale'|'upload'|'retry')` lets the screen talk.
  function count(opts) {
    opts = opts || {};
    var url = opts.url, key = opts.key, meta = opts.meta || {}, onStage = opts.onStage || function () {};
    if (!url) return Promise.reject(AiError(503, 'AI counting is not switched on yet - add the OpenAI key in AgronicaWorld'));
    if (!opts.photo) return Promise.reject(AiError(400, 'Take a photo first'));
    onStage('downscale');
    return downscale(opts.photo, EDGE, QUALITY).then(function (small) {
      if (small.blob.size > MAX_BYTES) throw AiError(413, 'That photo is too big to send');
      onStage('upload');
      return post(url, key, form(small.blob, meta), opts.timeoutMs).then(function (j) {
        return { body: j, sent: { w: small.w, h: small.h, bytes: small.blob.size, edge: EDGE }, retried: false };
      }, function (err) {
        if (!err || err.status !== 413) throw err;
        onStage('retry');                                  // 413: one retry, smaller (1200 px, q 0.8)
        return downscale(opts.photo, EDGE_RETRY, QUALITY_RETRY).then(function (s2) {
          return post(url, key, form(s2.blob, meta), opts.timeoutMs).then(function (j) {
            return { body: j, sent: { w: s2.w, h: s2.h, bytes: s2.blob.size, edge: EDGE_RETRY }, retried: true };
          });
        });
      });
    }).then(function (r) {
      var j = r.body || {};
      var dets = Array.isArray(j.detections) ? j.detections.filter(function (d) {
        return d && isFinite(d.x) && isFinite(d.y) && isFinite(d.r) && d.r > 0;
      }).map(function (d) { return { x: +d.x, y: +d.y, r: +d.r }; }) : [];
      var out = { ok: j.ok !== false, count: isFinite(j.count) ? Math.round(j.count) : dets.length, confidence: isFinite(j.confidence) ? +j.confidence : null,
        detections: dets, nutsPerTree: isFinite(j.nutsPerTree) ? Math.round(j.nutsPerTree) : null, kgHa: isFinite(j.kgHa) ? Math.round(j.kgHa) : null,
        model: j.model || '', note: j.note || '', sent: r.sent, retried: r.retried, at: Date.now() };
      bump({ count: out.count, model: out.model, at: out.at });
      return out;
    });
  }

  // plain-language message for a failed call (never throws, always says where the on-phone count went)
  function describe(err) {
    var st = err && err.status;
    if (st === 503) return 'AI counting is not switched on yet - add the OpenAI key in AgronicaWorld';
    if (st === 429) { var w = (err && err.retryAfter) || 60; return 'Too many AI counts - wait ' + w + ' s, or carry on with the on-phone count'; }
    if (st === 413) return 'That photo is still too big for the AI server after shrinking it - try a smaller photo';
    if (st === 415) return 'The AI server would not accept that image type';
    if (st === 401) return 'AI counting rejected the app key (401) - check INGEST_KEY in config.js';
    if (st === 400) return 'The AI server rejected the request: ' + ((err && err.message) || 'bad field');
    if (st === 502) return 'The AI model failed on this photo - the on-phone count is still here';
    if (st === 0) return "Could not reach AgronicaWorld for the AI count (" + ((err && err.message) || 'network error') + ") - the on-phone count is still here";
    return 'AI count failed' + (st ? ' (' + st + ')' : '') + ': ' + ((err && err.message) || 'unknown error');
  }

  var api = { count: count, downscale: downscale, form: form, describe: describe, stats: stats, bump: bump, resetStats: resetStats,
    noticeSeen: noticeSeen, setNoticeSeen: setNoticeSeen, COST_CENTS: COST_CENTS, EDGE: EDGE, EDGE_RETRY: EDGE_RETRY, QUALITY: QUALITY, MAX_BYTES: MAX_BYTES };
  root.AICount = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : this));
