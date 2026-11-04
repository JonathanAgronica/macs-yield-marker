// Synthetic canopy test images for the photo detector (deterministic, no fixtures): leaf clutter + nut discs.
// Each returns { px, w, h, truth:[{x,y,r}] } in plain RGBA, canvas-free so Node and headless Chrome both use it.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function canvas(w, h, rgb) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = rgb[0]; px[i * 4 + 1] = rgb[1]; px[i * 4 + 2] = rgb[2]; px[i * 4 + 3] = 255; }
  return px;
}
// leaf clutter: mottled green with dark veins, a few bright specular leaf tips, and a blue-sky tint in the gaps
function leaves(px, w, h, rand, o = {}) {
  const base = o.base || [46, 92, 40], amp = o.amp || 34;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    // fine leaf texture (period ~4-8 px). A broad low-frequency wash would itself look like nut-sized bright
    // blobs and make the fixture unfair to any colour detector.
    const n = Math.sin(x * 0.9 + y * 0.7) * 0.35 + Math.sin(x * 0.23 - y * 0.31) * 0.3 + Math.cos(x * 1.7 - y * 1.3) * 0.15 + (rand() - 0.5) * 0.9;
    const v = n * amp;
    px[i] = Math.max(0, Math.min(255, base[0] + v * 0.7)); px[i + 1] = Math.max(0, Math.min(255, base[1] + v)); px[i + 2] = Math.max(0, Math.min(255, base[2] + v * 0.5));
  }
  // veins: thin light-green strokes
  for (let k = 0; k < (o.veins || 18); k++) {
    let x = rand() * w, y = rand() * h, a = rand() * Math.PI * 2;
    for (let s = 0; s < 90; s++) { x += Math.cos(a) * 1.1; y += Math.sin(a) * 1.1; a += (rand() - 0.5) * 0.25; const xi = Math.round(x), yi = Math.round(y); if (xi < 0 || yi < 0 || xi >= w || yi >= h) break; const i = (yi * w + xi) * 4; px[i] = 120; px[i + 1] = 165; px[i + 2] = 80; }
  }
  // shiny leaf highlights (the classic false positive)
  for (let k = 0; k < (o.shine || 22); k++) {
    const cx = rand() * w, cy = rand() * h, r = 2 + rand() * 4;
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue; const i = (y * w + x) * 4; px[i] = 200; px[i + 1] = 225; px[i + 2] = 120;
    }
  }
  return px;
}
function disc(px, w, h, cx, cy, r, rgb, rand, opts = {}) {
  for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(h - 1, cy + r + 1); y++) for (let x = Math.max(0, Math.floor(cx - r - 1)); x <= Math.min(w - 1, cx + r + 1); x++) {
    const d = Math.hypot(x - cx, y - cy); if (d > r) continue;
    const i = (y * w + x) * 4, sh = 0.86 + 0.28 * (1 - (d / r) * (d / r)) * (opts.lit === false ? 0.4 : 1) + (rand() - 0.5) * 0.08;
    px[i] = Math.min(255, rgb[0] * sh); px[i + 1] = Math.min(255, rgb[1] * sh); px[i + 2] = Math.min(255, rgb[2] * sh);
  }
  if (opts.highlight !== false) { // waxy specular spot, offset up-left
    const hx = cx - r * 0.3, hy = cy - r * 0.32, hr = Math.max(1, r * 0.28);
    for (let y = Math.max(0, Math.floor(hy - hr)); y <= Math.min(h - 1, hy + hr); y++) for (let x = Math.max(0, Math.floor(hx - hr)); x <= Math.min(w - 1, hx + hr); x++) {
      if ((x - hx) ** 2 + (y - hy) ** 2 > hr * hr) continue; const i = (y * w + x) * 4; px[i] = Math.min(255, px[i] + 90); px[i + 1] = Math.min(255, px[i + 1] + 90); px[i + 2] = Math.min(255, px[i + 2] + 80);
    }
  }
}
// green husk nuts in a loose cluster on leaf clutter
function greenNuts(seed = 7, w = 320, h = 240) {
  const rand = rng(seed), px = leaves(canvas(w, h, [46, 92, 40]), w, h, rand);
  const truth = [];
  const cols = 4, rows = 3;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const cx = 42 + i * (w - 84) / (cols - 1) + (rand() - 0.5) * 10, cy = 40 + j * (h - 80) / (rows - 1) + (rand() - 0.5) * 10, r = 13;
    disc(px, w, h, cx, cy, r, [150, 196, 78], rand); truth.push({ x: cx, y: cy, r });
  }
  return { px, w, h, truth };
}
// mature brown nuts on a green canopy
function brownNuts(seed = 11, w = 320, h = 240) {
  // 8 mature nuts on a loose grid (never touching, so the truth count is exact) among green leaves
  const rand = rng(seed), px = leaves(canvas(w, h, [40, 86, 38]), w, h, rand);
  const truth = [];
  const cols = 4, rows = 2;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const cx = 40 + i * (w - 80) / (cols - 1) + (rand() - 0.5) * 8, cy = 62 + j * (h - 124) + (rand() - 0.5) * 8, r = 15;
    disc(px, w, h, cx, cy, r, [136, 84, 42], rand); truth.push({ x: cx, y: cy, r });
  }
  return { px, w, h, truth };
}
// touching / overlapping nuts: one blob of 7 nuts in a tight cluster (distance transform must split them)
function overlappingNuts(seed = 5, w = 320, h = 240) {
  const rand = rng(seed), px = leaves(canvas(w, h, [46, 92, 40]), w, h, rand);
  const truth = [], cx = w / 2, cy = h / 2;
  for (let k = 0; k < 7; k++) { const a = k / 6 * Math.PI * 2, x = cx + Math.cos(a) * 22, y = cy + Math.sin(a) * 22; disc(px, w, h, x, y, 15, [152, 198, 80], rand); truth.push({ x, y, r: 15 }); }
  return { px, w, h, truth };
}
// hard clutter with no nuts at all: real foliage is many *elongated* leaves at random angles over dark gaps, with
// veins and the odd shiny tip. No filter should report a crowd of nuts here.
function leafOnly(seed = 3, w = 320, h = 240) {
  const rand = rng(seed), px = canvas(w, h, [22, 40, 20]);
  const leaf = (cx, cy, len, wid, ang, rgb) => {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let y = Math.max(0, Math.floor(cy - len)); y < Math.min(h, cy + len); y++) for (let x = Math.max(0, Math.floor(cx - len)); x < Math.min(w, cx + len); x++) {
      const dx = x - cx, dy = y - cy, u = (dx * ca + dy * sa) / len, v = (-dx * sa + dy * ca) / wid;
      if (u * u + v * v > 1) continue;
      const sh = 0.82 + 0.3 * (1 - (u * u + v * v)) + (rand() - 0.5) * 0.12, i = (y * w + x) * 4;
      px[i] = Math.min(255, rgb[0] * sh); px[i + 1] = Math.min(255, rgb[1] * sh); px[i + 2] = Math.min(255, rgb[2] * sh);
    }
  };
  // macadamia leaves are 10-25 cm long against a 25-35 mm nut, so at this scale a leaf is 3-5x a nut radius
  for (let k = 0; k < 34; k++) {
    const cx = rand() * w, cy = rand() * h, ang = rand() * Math.PI * 2, len = 52 + rand() * 62, wid = 11 + rand() * 16;
    leaf(cx, cy, len, wid, ang, [46 + rand() * 30, 96 + rand() * 40, 40 + rand() * 26]);
  }
  for (let k = 0; k < 26; k++) {   // shiny leaf tips and sun patches on leaves: the classic false positive
    const cx = rand() * w, cy = rand() * h;
    leaf(cx, cy, 8 + rand() * 12, 4 + rand() * 6, rand() * Math.PI, [150, 196, 95]);
  }
  return { px, w, h, truth: [] };
}
// partly hidden nut: only an arc of husk shows behind a leaf that covers 40% of it
function hiddenNuts(seed = 13, w = 320, h = 240) {
  const rand = rng(seed), px = leaves(canvas(w, h, [46, 92, 40]), w, h, rand);
  const truth = [];
  for (let k = 0; k < 4; k++) {
    const cx = 56 + k * 70, cy = 120, r = 16;
    disc(px, w, h, cx, cy, r, [150, 196, 78], rand);
    // one leaf lying across the lower ~40% of the nut, edge running at a slight angle so the visible part is an arc
    for (let y = Math.floor(cy - r - 2); y <= cy + r + 6; y++) for (let x = Math.floor(cx - r * 1.6); x <= cx + r * 1.6; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const cover = y - (cy + r * 0.15) - (x - cx) * 0.12;      // signed distance below the leaf edge
      if (cover < 0) continue; const i = (y * w + x) * 4, sh = 0.86 + rand() * 0.18;
      px[i] = 44 * sh; px[i + 1] = 88 * sh; px[i + 2] = 40 * sh;
    }
    truth.push({ x: cx, y: cy, r });
  }
  return { px, w, h, truth };
}
module.exports = { rng, canvas, leaves, disc, greenNuts, brownNuts, overlappingNuts, leafOnly, hiddenNuts };
