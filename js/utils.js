window.App = window.App || {};

// "98.374702,7.85742 98.374883,7.85742 ..." -> [[lon,lat], ...]
App.parseBinRing = function parseBinRing(str) {
  if (!str) return null;
  const pts = str.trim().split(/\s+/).map(pair => {
    const parts = pair.split(',');
    return [parseFloat(parts[0]), parseFloat(parts[1])];
  }).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return pts.length >= 3 ? pts : null;
};

App.bboxOfRing = function bboxOfRing(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
};

App.unionBbox = function unionBbox(bboxes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bboxes) {
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
    if (b[2] > maxX) maxX = b[2];
    if (b[3] > maxY) maxY = b[3];
  }
  return [minX, minY, maxX, maxY];
};

App.pointInBbox = function pointInBbox(x, y, bbox) {
  return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
};

App.bboxIntersects = function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
};

// Ray-casting point-in-polygon, no external dependency needed for the hot path.
App.pointInRing = function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

// Uniform grid over a set of {bbox} items, so point lookups only test the handful
// of items whose bbox overlaps the point's cell instead of every item.
App.buildSpatialIndex = function buildSpatialIndex(items) {
  if (!items.length) return null;
  const overall = App.unionBbox(items.map(it => it.bbox));
  const n = Math.max(4, Math.min(64, Math.ceil(Math.sqrt(items.length))));
  const cellW = (overall[2] - overall[0]) / n || 1;
  const cellH = (overall[3] - overall[1]) / n || 1;
  const cells = new Map();
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  for (const it of items) {
    const x0 = clamp(Math.floor((it.bbox[0] - overall[0]) / cellW), 0, n - 1);
    const x1 = clamp(Math.floor((it.bbox[2] - overall[0]) / cellW), 0, n - 1);
    const y0 = clamp(Math.floor((it.bbox[1] - overall[1]) / cellH), 0, n - 1);
    const y1 = clamp(Math.floor((it.bbox[3] - overall[1]) / cellH), 0, n - 1);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cx + ',' + cy;
        let bucket = cells.get(key);
        if (!bucket) cells.set(key, (bucket = []));
        bucket.push(it);
      }
    }
  }
  return { overall, n, cellW, cellH, cells };
};

// Candidate items whose bbox overlaps the cell containing (x,y). Caller still does the exact test.
App.querySpatialIndex = function querySpatialIndex(index, x, y) {
  if (!index || !App.pointInBbox(x, y, index.overall)) return null;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const cx = clamp(Math.floor((x - index.overall[0]) / index.cellW), 0, index.n - 1);
  const cy = clamp(Math.floor((y - index.overall[1]) / index.cellH), 0, index.n - 1);
  return index.cells.get(cx + ',' + cy) || null;
};

App.numOrNull = function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Escapes text before it's interpolated into an innerHTML template — filenames and cluster IDs
// come from the user's own filesystem/KMZ, but an unescaped "<" or "&" in either would still
// break the markup (or worse, run as HTML) rather than just display oddly.
App.escapeHtml = function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

App.debounce = function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
};

// Process `items` in time-sliced batches (default ~12ms/tick, leaving room in a 16ms frame)
// instead of a fixed item count, so throughput adapts to how cheap onChunk actually is.
App.forEachChunked = function forEachChunked(items, onChunk, onDone, timeBudgetMs) {
  const budget = timeBudgetMs || 12;
  let i = 0;
  function step() {
    const start = performance.now();
    while (i < items.length) {
      onChunk(items[i], i);
      i++;
      if (performance.now() - start >= budget) break;
    }
    if (i < items.length) {
      setTimeout(step, 0);
    } else if (onDone) {
      onDone();
    }
  }
  step();
};

App.csvEscape = function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
};

App.downloadTextFile = function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
