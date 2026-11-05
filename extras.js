/* Extras: About Agronica screen, offline Help bot, and the slim product ad strip. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  // =================== About Agronica ===================
  // Contact details are the ones published on https://www.agronicaag.com/contact
  var ABOUT = { phone: '(+61) 475 570 872', tel: '+61475570872', emails: ['jonathan@agronicaag.com', 'admin@agronicaag.com'],
    address: '4468 Goodwood Road, Alloway QLD 4670', web: 'https://www.agronicaag.com',
    pin: { lat: -24.9857, lon: 152.3801 } };       // approximate: Goodwood Road, Alloway (OpenStreetMap) - no street-number geocode available
  var aboutMap = null;
  function mapsQuery() { return encodeURIComponent(ABOUT.address + ' Australia'); }
  function openAbout() {
    closeHelp(); $('sheet').classList.add('hidden'); var t = $('toast'); if (t) t.classList.remove('show');
    $('about').classList.remove('hidden'); $('about').scrollTop = 0;
    if (window.L && !aboutMap) {
      var ll = [ABOUT.pin.lat, ABOUT.pin.lon];
      aboutMap = L.map($('aboutMap'), { attributionControl: true }).setView(ll, 14);
      L.tileLayer((function () { try { return localStorage.getItem('myl-tile-url'); } catch (e) { return null; } })() || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 20, attribution: 'Tiles © Esri', crossOrigin: true }).addTo(aboutMap);
      L.circle(ll, { radius: 500, color: '#ffb400', weight: 2, dashArray: '6 6', fillOpacity: 0.08, interactive: false }).addTo(aboutMap);
      L.marker(ll, { icon: L.divIcon({ className: 'mm-pin', html: '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" fill="#ffb400" stroke="#fff" stroke-width="1.8"/><circle cx="12" cy="10" r="2.6" fill="#222"/></svg>', iconSize: [36, 36], iconAnchor: [18, 34] }), keyboard: false })
        .bindPopup('<b>Agronica</b><br>4468 Goodwood Road, Alloway QLD<br><small>Approximate map position</small>').addTo(aboutMap);
    } else if (aboutMap) setTimeout(function () { aboutMap.invalidateSize(); }, 50);
  }
  function closeAbout() { $('about').classList.add('hidden'); }
  function buildAbout() {
    var a = $('aboutBody');
    a.innerHTML =
      '<img src="img/agronica-logo.svg" alt="Agronica" class="about-logo">' +
      '<p class="about-lead">Agronomic services and products with accurate, pragmatic and confidential advice focused on productivity and profitability.</p>' +
      '<div class="card"><div class="card-title">What we do</div><ul class="about-list">' +
      '<li><b>Pest and Disease Management</b><span>Monitoring and identification of pests, diseases and weeds, using integrated pest and disease management.</span></li>' +
      '<li><b>Soil and Nutrition Management</b><span>Nutrient management plans, backed by soil and plant tissue testing.</span></li>' +
      '<li><b>Data Management and ESG</b><span>Turning data into insights: soil/leaf testing and residue, quality and maturity testing of crops.</span></li></ul></div>' +
      '<div class="card"><div class="card-title">Get in touch</div><div class="about-actions">' +
      '<a class="act" id="abCall" href="tel:' + ABOUT.tel + '"><svg class="ic"><use href="#i-phone"/></svg><span>Call<small>' + ABOUT.phone + '</small></span></a>' +
      ABOUT.emails.map(function (e, i) { return '<a class="act" id="abMail' + i + '" href="mailto:' + e + '?subject=Mac%27s%20Yield%20Marker%20enquiry"><svg class="ic"><use href="#i-mail"/></svg><span>Email<small>' + e + '</small></span></a>'; }).join('') +
      '<a class="act" id="abWeb" href="' + ABOUT.web + '" target="_blank" rel="noopener"><svg class="ic"><use href="#i-globe"/></svg><span>Website<small>www.agronicaag.com</small></span></a>' +
      '</div></div>' +
      '<div class="card"><div class="card-title">Find us</div><div class="about-addr"><b>' + ABOUT.address + '</b><br><span class="dim small-txt">Bundaberg region</span></div>' +
      '<div class="about-actions two"><a class="act" id="abMaps" href="https://www.google.com/maps/search/?api=1&query=' + mapsQuery() + '" target="_blank" rel="noopener"><svg class="ic"><use href="#i-pin"/></svg><span>Open in Maps</span></a>' +
      '<a class="act" id="abApple" href="https://maps.apple.com/?q=' + mapsQuery() + '" target="_blank" rel="noopener"><svg class="ic"><use href="#i-pin"/></svg><span>Apple Maps</span></a></div>' +
      '<div id="aboutMap" class="about-map"></div><div class="dim small-txt about-note">Approximate position on Goodwood Road, Alloway.</div></div>' +
      '<div class="card"><div class="card-title">About this app</div><p class="small-txt" style="margin:0;line-height:1.5">Mac\'s Yield Marker is part of the AgronicaWorld toolbox. Drive or walk your rows and rate yield, get prompted every few trees for a quick 1-5 estimate, record nut counts or bin weights, count nuts in a photo, and see a heat map of each block. Exports KML / CSV; uploads to AgronicaWorld once it is switched on. Photo counts are an on-device estimate (tap to correct) - calibrate the canopy % and NIS weight for your block.</p>' +
      '<p class="dim small-txt" id="photoCredit" style="margin:10px 0 0;line-height:1.45">App icon photo: &quot;Macadamia nut&quot; drying racks by Joseph Hill, via Wikimedia Commons (<a href="https://commons.wikimedia.org/wiki/File:Macadamia-nut-912598.jpg" target="_blank" rel="noopener" style="color:var(--orange)">File:Macadamia-nut-912598.jpg</a>), CC0 1.0 public domain dedication. Cropped, recoloured and overlaid with the Agronica mark.</p>' +
      '<p class="dim small-txt" style="margin:6px 0 0">Satellite imagery © Esri and its partners. Map library: Leaflet (BSD-2).</p></div>';
  }

  // =================== Help bot ===================
  var FAQ = [
    { id: 'start', label: 'Getting started', kw: ['start', 'begin', 'gps', 'first', 'how do i use', 'getting started', 'stop', 'permission', 'location', 'no fix', 'fix', 'session'],
      a: 'Type the block name and pick the variety, then press START and allow location. The pill turns "GPS OK" once there is a fix. Each START begins a new session; STOP ends it. The screen stays awake while tracking, and GPS keeps running whatever screen you are on.' },
    { id: 'rate', label: 'Rating while driving', kw: ['rate', 'rating', 'button', 'low', 'medium', 'high', 'very high', 'nil', 'drive', 'driving', 'tap', 'estimate', 'mark'],
      a: 'The five big buttons - VERY HIGH, HIGH, MEDIUM, LOW and NIL - save a yield rating at your GPS position with one tap. You get a beep (higher pitch = higher yield), a buzz and a colour flash, so you can keep your eyes on the row. Ratings are 1 (Nil) to 5 (Very high) in exports and uploads.' },
    { id: 'prompt', label: '10-tree prompts', kw: ['10', 'ten', 'prompt', 'every', 'segment', 'trees', 'tree count', 'spacing', 'skip', 'missed', 'pop up', 'number'],
      a: 'The app counts trees from the distance you travel along the row divided by the tree spacing (default 4 m - change it per block in the Menu). Every 10 trees (also set in the Menu, 0 turns it off) it beeps, buzzes and shows five huge 1-5 buttons for that segment. One tap saves it with the row and trees (e.g. 11-20). Tap SKIP or just ignore it - after 25 s it closes itself. GPS never stops. Use TREE +1 if the count drifts behind.' },
    { id: 'skip', label: 'Skipped segments', kw: ['skipped', 'interpolat', 'gap', 'average', 'blend', 'faded', 'missing'],
      a: 'A skipped or missed 10-tree prompt is still saved, flagged "interpolated". Its value is averaged from nearby real marks (inverse-distance weighted, within about 80 m) and updates when new marks arrive, so the heat map blends with no gaps. Interpolated marks show faded and dashed on the map, and you can edit one to give it a real rating.' },
    { id: 'row', label: 'Rows', kw: ['row', 'next row', 'u-turn', 'uturn', 'turn', 'auto row', 'headland'],
      a: 'The Row number is saved with every mark. Use the big + / - buttons to change it; this also resets the tree count. With "Auto row" on, the row goes up by one automatically when the GPS sees you U-turn at the end of a row.' },
    { id: 'count', label: 'Count / bin weight', kw: ['count', 'weight', 'kg', 'bin', 'bag', 'keypad', 'nuts', 'number pad', 'weigh'],
      a: 'Tap "Count / bin weight" under the rating buttons. Choose Nut count or Weight kg, type it on the big keypad and SAVE - it is stored at your GPS point with the row. Bin weights will also be sent to AgronicaWorld once uploads are turned on.' },
    { id: 'photo', label: 'Photo count', kw: ['photo', 'camera', 'picture', 'image', 'take a photo', 'ai', 'kg/ha', 't/ha', 'canopy', 'photo count'],
      a: 'In the Photo tab take a photo of part of a tree, choose one from your gallery, or press Live to use the camera. The phone circles the nuts it finds. Switch the view between Original, Highlight (the pink mask shows exactly which pixels the filter is picking up) and Compare (swipe the divider between the two). Nine filters: Green husk, Brown, Shape, Sat+value, Hue band, LAB a/b, ExG/blue, Otsu auto and Edge/circle. Tap a circle to remove it, tap a nut to add one. Set what % of the canopy the photo covers, the row and tree spacing, and the nut-in-shell weight (start ~7.5 g, calibrate). It shows nuts/tree, kg/ha and t/ha - an ESTIMATE only - and "Save as mark" puts it on the map.' },
    { id: 'aiphoto', label: 'AI count (cost)', kw: ['ai', 'ai count', 'ai nuts', 'second opinion', 'openai', 'cost', 'cents', 'charge', 'charged', 'spend', 'money', 'not switched on', 'ai not working', 'too many ai', 'confidence'],
      a: 'AI count is a second opinion on the photo: press AI count and the photo goes to the AgronicaWorld server, which counts nuts with an OpenAI vision model and sends the circles back in violet. It costs Agronica about 3c a photo (roughly 9c on a very heavy photo) - charged to Agronica\'s OpenAI account, not to your phone - and the app shows a one-off cost line first plus a running count of AI counts from this phone. The on-phone filters keep working the whole time: you see both counts side by side (On-phone and AI) and choose which one to save; tap a violet circle to remove it or tap a nut to add one, and the corrected AI count is what gets saved. If it says "AI counting is not switched on yet", Agronica has not added the OpenAI key on the server - use the on-phone count. "Too many AI counts - wait..." means the hourly limit (30 an hour per phone, 60 per network) - wait it out or carry on with the on-phone count. AI needs signal; the on-phone count works offline.' },
    { id: 'filters', label: 'Filters & presets', kw: ['filter', 'filters', 'filters do', 'preset', 'presets', 'slider', 'sliders', 'threshold', 'hue', 'saturation', 'brightness', 'radius', 'nut size', 'roundness', 'smoothing', 'best n', 'otsu', 'lab', 'exg', 'edge', 'circle', 'mask', 'highlight', 'save preset', 'not picking up', 'too many'],
      a: 'The sliders under the photo retune the detector live while you drag. Threshold = how sure a pixel has to be; Hue min/max = the colour window (used by Green husk and Hue band); Saturation and Brightness = how strong and how light the colour must be; Min/Max nut size = the nut radius in photo pixels; Roundness = how full and round a blob must be; Smoothing = how much speckle is averaged out; "Only show best N" = keep just the N most nut-like circles in a busy canopy. Presets save the whole set per block or variety: pick one from the list, or tune the sliders and press Save and give it a name (e.g. "Block 7 A16 sunny"). Four presets come built in: Green husk sunny, Green husk overcast, Brown fallen and Dense canopy. Del removes one of yours.' },
    { id: 'undo', label: 'Undo / edit / delete', kw: ['undo', 'delete', 'remove', 'wrong', 'mistake', 'oops', 'edit', 'change', 'fix a mark'],
      a: 'The arrow next to START undoes the last mark. To change an older one, open Summary (or tap a dot on the Yield map), tap Edit to change its rating, row, count or weight, or tap ✕ to delete it.' },
    { id: 'map', label: 'Yield map', kw: ['map', 'heat', 'colour', 'color', 'legend', 'satellite', 'offline', 'tiles', 'red', 'green', 'amber'],
      a: 'The Yield map tab shows a smooth heat map over Esri satellite imagery: red = low, amber = medium, green = high. Switch between Rating, Weight kg, Estimate and Count; weights and counts use a red-to-green colour ramp with the range in the legend. Tiles you have viewed are cached, and "Save area offline" downloads the current view for use without signal.' },
    { id: 'export', label: 'Export / share', kw: ['export', 'share', 'kml', 'csv', 'send', 'email', 'google earth', 'excel', 'download', 'file'],
      a: 'Summary (or Menu) -> KML or CSV. On most phones you get the share sheet; otherwise the file downloads. KML has coloured placemarks with all fields and opens in Google Earth / QGIS. CSV has time, lat, lon, accuracy, block, variety, row, trees, rating, estimate, count, weight and session for Excel.' },
    { id: 'import', label: 'Merge someone else\'s marks', kw: ['import', 'merge', 'combine', 'colleague', 'other person', 'someone else', 'duplicate'],
      a: 'Ask them to export a KML (or CSV) and send it to you, then Menu -> "Import / merge KML". Their marks are added and anything you already have is skipped as a duplicate.' },
    { id: 'upload', label: 'AgronicaWorld upload', kw: ['upload', 'agronicaworld', 'server', 'sync', 'cloud', 'send to agronica', 'heat map of blocks', 'privacy', 'data'],
      a: 'Marks are kept on your phone. Uploading to AgronicaWorld (for block heat maps) is built in but switched OFF until Agronica turns the server on. When on, marks queue while offline and send automatically with a random device ID. Until then, use Export.' },
    { id: 'install', label: 'Add to home screen', kw: ['home screen', 'install', 'add to home', 'icon', 'app store', 'pwa', 'shortcut', 'iphone', 'android'],
      a: 'iPhone: open the page in Safari, tap Share, then "Add to Home Screen". Android: Chrome menu -> "Install app". After the first load it also works without signal. iPhones do not vibrate from web apps, so you get the beeps only.' },
    { id: 'ads', label: 'About the ad strip', kw: ['ad ', 'ads', 'advert', 'sponsor', 'strip', 'banner', 'product'],
      a: 'The slim strip above the tabs shows product notices, changing every few seconds and pausing while you are tapping. It never pops up; tapping one opens that product page.' }
  ];
  var CONTACT_REPLY = 'For anything else, the Agronica team is happy to help: tap "Contact Agronica" below for phone, email and address.';
  function score(q, e) {
    var s = 0; q = ' ' + q.toLowerCase().replace(/[^a-z0-9\/ ]+/g, ' ') + ' ';
    e.kw.forEach(function (k) { if (q.indexOf(k) >= 0) s += k.length > 5 ? 3 : 2; });
    if (q.indexOf(e.label.toLowerCase()) >= 0) s += 4;
    return s;
  }
  function answer(q) {
    if (/\b(contact|phone|call|email|address|agronica|who are you|speak|talk to)\b/i.test(q) && !/(kml|share|sharing|export|research|data|collaborative|sync|opt)/i.test(q)) return { contact: true, text: 'You can reach Agronica on ' + ABOUT.phone + ' or ' + ABOUT.emails[0] + '. Tap the button below for all contact details and a map.' };
    var best = null, bs = 0;
    FAQ.forEach(function (e) { var s = score(q, e); if (s > bs) { bs = s; best = e; } });
    return best ? { faq: best, text: best.a } : { fallback: true, text: "I'm not sure about that one yet. Pick a topic below, or ask the Agronica team directly. " + CONTACT_REPLY };
  }
  var helpBuilt = false, chatLog;
  function addMsg(who, text, extra) {
    var m = el('div', 'msg-b ' + who); var t = el('div', 'bub', text); m.appendChild(t);
    if (who === 'bot') { var av = el('img', 'av'); av.src = 'img/helper.png'; av.alt = ''; m.insertBefore(av, t); }
    if (extra) t.appendChild(extra);
    chatLog.appendChild(m); chatLog.scrollTop = chatLog.scrollHeight; return m;
  }
  function contactBtn() { var b = el('button', 'soft full', 'Contact Agronica'); b.type = 'button'; b.id = 'helpContact'; b.onclick = openAbout; return b; }
  function ask(q) {
    q = (q || '').trim(); if (!q) return;
    addMsg('me', q);
    var r = answer(q);
    setTimeout(function () { addMsg('bot', r.text, r.contact || r.fallback ? contactBtn() : null); }, 180);
  }
  function buildHelp() {
    if (helpBuilt) return; helpBuilt = true;
    chatLog = $('helpLog');
    var chips = $('helpChips');
    FAQ.forEach(function (e) { var b = el('button', 'qchip', e.label); b.type = 'button'; b.setAttribute('data-faq', e.id); b.onclick = function () { ask(e.label); }; chips.appendChild(b); });
    var cc = el('button', 'qchip contact', 'Contact Agronica'); cc.type = 'button'; cc.id = 'helpChipContact'; cc.onclick = openAbout; chips.appendChild(cc);
    $('helpForm').onsubmit = function (e) { e.preventDefault(); var i = $('helpInput'); var q = i.value; i.value = ''; ask(q); };
    addMsg('bot', "G'day, I'm Macca, the Yield Marker Helper! Ask me how something works, or tap a topic below. I work offline.");
  }
  function openHelp() { buildHelp(); var t = $('toast'); if (t) t.classList.remove('show'); $('help').classList.remove('hidden'); setTimeout(function () { chatLog.scrollTop = chatLog.scrollHeight; }, 50); }
  function closeHelp() { var h = $('help'); if (h) h.classList.add('hidden'); }

  // =================== Ad strip ===================
  var ads = [], adIdx = 0, adTimer = null, lastTap = 0, ADMS = 6000;
  function showAd(i, instant) {
    var bar = $('adbar'), a = $('adLink'); if (!ads.length) { bar.classList.add('hidden'); return; }
    var ad = ads[i % ads.length];
    function apply() {
      a.href = ad.url; $('adImg').src = ad.image; $('adImg').alt = '';
      $('adName').textContent = ad.name + (ad.by ? ' by ' + ad.by : ''); $('adText').textContent = ad.text;
      a.setAttribute('aria-label', 'Ad: ' + ad.name + (ad.by ? ' by ' + ad.by : '') + ' - ' + ad.text); a.dataset.ad = i % ads.length;
      a.classList.remove('fade');
    }
    if (instant) apply(); else { a.classList.add('fade'); setTimeout(apply, 450); }
  }
  function nextAd() {
    if (document.hidden || ads.length < 2) return;
    if (Date.now() - lastTap < 8000) return;          // pause while the user is marking
    adIdx = (adIdx + 1) % ads.length; showAd(adIdx);
  }
  function loadAds() {
    fetch('ads.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (j) {
      var list = Array.isArray(j) ? j : (j && j.ads) || [];
      ads = list.filter(function (x) { return x && x.name && x.url; });
      ads.forEach(function (x) { if (x.image) { var im = new Image(); im.src = x.image; } });
      adIdx = 0; showAd(0, true); $('adbar').classList.toggle('hidden', !ads.length);
      clearInterval(adTimer); adTimer = setInterval(nextAd, ADMS);
    }).catch(function () { $('adbar').classList.add('hidden'); });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.rate, .ek, #undo, #rowUp, #rowDn, #treeUp'), function (b) { b.addEventListener('pointerdown', function () { lastTap = Date.now(); }, true); });

  // =================== wiring ===================
  buildAbout();
  Array.prototype.forEach.call(document.querySelectorAll('.js-about'), function (b) { b.onclick = openAbout; }); $('menuAbout').onclick = openAbout; $('closeAbout').onclick = closeAbout;
  Array.prototype.forEach.call(document.querySelectorAll('.js-help'), function (b) { b.onclick = openHelp; }); $('menuHelp').onclick = function () { $('sheet').classList.add('hidden'); openHelp(); };
  $('closeHelp').onclick = closeHelp; $('helpBack').onclick = closeHelp;
  loadAds();
  window.Extras = { openAbout: openAbout, openHelp: openHelp, answer: answer, FAQ: FAQ, ABOUT: ABOUT, ads: function () { return ads.slice(); }, adIndex: function () { return adIdx; }, tick: nextAd,
    aboutMap: function () { return aboutMap; } };
})();
