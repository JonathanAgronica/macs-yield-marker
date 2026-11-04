/* Yield map: Leaflet + Esri World Imagery, a smooth IDW heat layer on a canvas, plus dots (interpolated marks faded).
   Leaflet is vendored (vendor/leaflet). Satellite tiles are cached by the service worker (sw.js). */
(function (root) {
  'use strict';
  var TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  var ATTR = 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
  var SAVED_CACHE = 'myl-tiles-saved', SAVE_LIMIT = 1500, MAX_NATIVE = 18;   // Esri World Imagery has 'Map data not yet available' gaps at z19 over parts of rural QLD; z19 is upscaled from z18
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function imageryUrl() { return lsGet('myl-tile-url') || TILE_URL; }   // test hook

  // ---- IDW heat layer ----
  var Heat = L.Layer.extend({
    initialize: function (opts) { this._pts = []; this._o = L.extend({ radiusM: 30, cell: 6, power: 2, opacity: 0.62 }, opts || {}); },
    setData: function (pts, rg) { this._pts = pts; this._rg = rg; this._redraw(); return this; },
    onAdd: function (map) {
      this._map = map; var c = this._c = L.DomUtil.create('canvas', 'yheat leaflet-zoom-hide');
      c.style.pointerEvents = 'none'; c.style.opacity = this._o.opacity;
      map.getPanes().overlayPane.appendChild(c);
      map.on('moveend zoomend resize', this._redraw, this); this._redraw();
    },
    onRemove: function (map) { L.DomUtil.remove(this._c); map.off('moveend zoomend resize', this._redraw, this); },
    _redraw: function () {
      var map = this._map; if (!map) return;
      var size = map.getSize(), c = this._c, tl = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(c, tl); c.width = size.x; c.height = size.y;
      var ctx = c.getContext('2d'); ctx.clearRect(0, 0, size.x, size.y);
      var pts = this._pts, rg = this._rg; if (!pts.length || !rg) return;
      var center = map.getCenter(), mpp = 40075016.686 * Math.abs(Math.cos(center.lat * Math.PI / 180)) / Math.pow(2, map.getZoom() + 8);
      var R = Math.max(10, this._o.radiusM / mpp), cell = this._o.cell, pw = this._o.power;
      var P = pts.map(function (p) { var q = map.latLngToContainerPoint([p.lat, p.lon]); return { x: q.x, y: q.y, v: p.v, w: p.w }; })
        .filter(function (p) { return p.x > -R && p.y > -R && p.x < size.x + R && p.y < size.y + R; });
      if (!P.length) return;
      // bucket points into a grid of R-sized bins so each cell only checks nearby points
      var B = {}, key = function (i, j) { return i + ',' + j; };
      P.forEach(function (p) { var k = key(Math.floor(p.x / R), Math.floor(p.y / R)); (B[k] = B[k] || []).push(p); });
      var span = rg.max - rg.min, Y = root.YM;
      for (var y = 0; y < size.y; y += cell) for (var x = 0; x < size.x; x += cell) {
        var cx = x + cell / 2, cy = y + cell / 2, bi = Math.floor(cx / R), bj = Math.floor(cy / R), sw = 0, sv = 0, dmin = Infinity;
        for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
          var arr = B[key(bi + di, bj + dj)]; if (!arr) continue;
          for (var n = 0; n < arr.length; n++) {
            var p = arr[n], dx = p.x - cx, dy = p.y - cy, d = Math.sqrt(dx * dx + dy * dy);
            if (d > R) continue; if (d < dmin) dmin = d;
            var w = p.w / Math.pow(Math.max(d, 2), pw); sw += w; sv += w * p.v;
          }
        }
        if (!sw) continue;
        var t = span > 0 ? (sv / sw - rg.min) / span : 0.5;
        var a = Math.max(0, 1 - dmin / R); a = Math.min(1, a * 1.6);
        ctx.globalAlpha = a; ctx.fillStyle = Y.ramp(t); ctx.fillRect(x, y, cell, cell);
      }
      ctx.globalAlpha = 1;
    }
  });

  function create(host, opts) {
    opts = opts || {};
    var map = L.map(host, { zoomControl: true, attributionControl: true, maxZoom: MAX_NATIVE + 1 }).setView([-24.87, 152.35], 13);
    L.tileLayer(imageryUrl(), { maxNativeZoom: MAX_NATIVE, maxZoom: MAX_NATIVE + 1, attribution: ATTR, crossOrigin: true }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    var heat = new Heat().addTo(map), dots = L.layerGroup().addTo(map), track = L.polyline([], { color: '#2d9cff', weight: 3, opacity: 0.8 }).addTo(map);
    var me = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 3, fillColor: '#2d9cff', fillOpacity: 1 });
    var st = { mode: 'rating', follow: false, fitted: false };
    function update(data) {
      var Y = root.YM, mode = st.mode, marks = data.marks || [];
      var vals = marks.filter(function (m) { return Y.valueOf(m, mode) != null; });
      var rg = mode === 'rating' ? { min: 0, max: 4 } : Y.range(vals, mode);
      heat.setData(vals.map(function (m) { return { lat: m.lat, lon: m.lon, v: Y.valueOf(m, mode), w: m.interpolated ? 0.5 : 1 }; }), rg);
      dots.clearLayers();
      vals.forEach(function (m) {
        var col = Y.colorFor(m, mode, rg);
        var cm = L.circleMarker([m.lat, m.lon], { radius: m.interpolated ? 5 : 7, color: '#fff', weight: m.interpolated ? 1 : 2, dashArray: m.interpolated ? '2 2' : null,
          fillColor: col, fillOpacity: m.interpolated ? 0.35 : 0.95, opacity: m.interpolated ? 0.5 : 1, className: 'ydot' + (m.interpolated ? ' interp' : '') });
        cm.bindPopup(function () { return popup(m); });
        cm.on('popupopen', function () { if (opts.onPopup) opts.onPopup(m, cm); });
        cm._ymId = m.id; cm.addTo(dots);
      });
      track.setLatLngs((data.track || []).map(function (p) { return [p.lat, p.lon]; }));
      if (!st.fitted && vals.length) { fit(vals); st.fitted = true; }
      legend(rg);
      return rg;
    }
    function popup(m) {
      var Y = root.YM, r = Y.rating(m.rating), rows = [['Rating', r ? r.label + ' (' + (r.v + 1) + ')' : '-']];
      if (m.estimate != null) rows.push(['Estimate', m.estimate + (m.interpolated ? ' (interpolated)' : '')]);
      if (m.treeFrom != null) rows.push(['Trees', m.treeFrom + '-' + m.treeTo]);
      if (m.count != null) rows.push(['Nut count', m.count]);
      if (m.kg != null) rows.push(['Bin weight', m.kg + ' kg']);
      if (m.estKgHa != null) rows.push(['Photo est.', Math.round(m.estKgHa) + ' kg/ha']);
      rows.push(['Row', m.row || '-'], ['Block', m.block || '-'], ['Time', Y.fmtLocal(m.ts)]);
      return '<div class="mm-pop"><b>' + Y.markTitle(m).replace(/</g, '&lt;') + '</b>' + rows.map(function (x) { return '<div class="pp-r"><span>' + x[0] + '</span><b>' + String(x[1]).replace(/</g, '&lt;') + '</b></div>'; }).join('') +
        '<div class="pp-a"><button type="button" class="soft" data-edit="' + m.id + '">Edit</button></div></div>';
    }
    function legend(rg) {
      var el = opts.legend; if (!el) return;
      var Y = root.YM;
      if (st.mode === 'rating') el.innerHTML = Y.RATINGS.map(function (r) { return '<span class="lg"><i style="background:' + r.color + '"></i>' + r.label + '</span>'; }).join('') + '<span class="lg"><i class="faded"></i>Interpolated</span>';
      else el.innerHTML = rg ? '<span class="lg-min">' + fmt(rg.min) + '</span><span class="lg-bar"></span><span class="lg-max">' + fmt(rg.max) + (st.mode === 'kg' ? ' kg' : st.mode === 'count' ? ' nuts' : '') + '</span>' : '<span class="dim">No ' + (st.mode === 'kg' ? 'weights' : st.mode === 'count' ? 'counts' : 'estimates') + ' yet</span>';
    }
    function fmt(v) { return Math.round(v * 10) / 10; }
    function fit(pts) { if (!pts.length) return; var b = L.latLngBounds(pts.map(function (p) { return [p.lat, p.lon]; })); map.fitBounds(b.pad(0.25), { maxZoom: 18, animate: false }); }
    function setPos(p) {
      if (!p) return; me.setLatLng([p.lat, p.lon]); if (!map.hasLayer(me)) me.addTo(map);
      if (st.follow) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 17), { animate: false });
    }
    function saveArea(onProgress) {
      var b = map.getBounds(), z0 = Math.max(8, Math.min(MAX_NATIVE, map.getZoom())), list = [];
      function tx(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
      function ty(lat, z) { var r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); }
      for (var z = z0; z <= MAX_NATIVE && list.length < SAVE_LIMIT; z++)
        for (var x = tx(b.getWest(), z); x <= tx(b.getEast(), z); x++) for (var y = ty(b.getNorth(), z); y <= ty(b.getSouth(), z); y++) list.push([z, x, y]);
      list = list.slice(0, SAVE_LIMIT);
      if (!('caches' in root)) return Promise.reject(new Error('Offline cache not available'));
      var done = 0, T = imageryUrl();
      return caches.open(SAVED_CACHE).then(function (c) {
        var i = 0;
        function worker() {
          if (i >= list.length) return Promise.resolve();
          var t = list[i++], u = T.replace('{z}', t[0]).replace('{y}', t[2]).replace('{x}', t[1]);
          return fetch(u, { mode: 'cors', cache: 'force-cache' }).then(function (r) { if (r.ok) return c.put(u, r); }).catch(function () {})
            .then(function () { done++; if (onProgress) onProgress(done, list.length); return worker(); });
        }
        return Promise.all([worker(), worker(), worker(), worker()]).then(function () { return list.length; });
      });
    }
    return { map: map, update: update, setPos: setPos, fit: fit, saveArea: saveArea, invalidate: function () { map.invalidateSize(); },
      setMode: function (m) { st.mode = m; }, mode: function () { return st.mode; }, setFollow: function (f) { st.follow = f; }, follow: function () { return st.follow; },
      dots: function () { var out = []; dots.eachLayer(function (l) { out.push({ id: l._ymId, fill: l.options.fillColor, op: l.options.fillOpacity }); }); return out; },
      heatCanvas: function () { return heat._c; } };
  }
  root.YMap = { create: create, Heat: Heat };
})(this);
