window.App = window.App || {};

function extractClusterId(description) {
  if (!description) return null;
  // e.g. "Unknown Area Type<BR><BR><B>ID</B> = STH0011-2"
  const m = description.match(/ID<\/B>\s*=\s*([^\s<]+)/i);
  return m ? m[1].trim() : null;
};

function parseKmlCoordinates(text) {
  // "lon,lat,alt lon,lat,alt ..." separated by any whitespace/newlines
  return text.trim().split(/\s+/).map(tuple => {
    const parts = tuple.split(',');
    return [parseFloat(parts[0]), parseFloat(parts[1])];
  }).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

function ringFromLinearRing(linearRingEl) {
  if (!linearRingEl) return null;
  const coordsEl = linearRingEl.getElementsByTagName('coordinates')[0];
  if (!coordsEl) return null;
  const ring = parseKmlCoordinates(coordsEl.textContent);
  return ring.length >= 3 ? ring : null;
}

// Parses a KML Document string into an array of { id, ring, holes, bbox }.
// A KML <Polygon> has exactly one <outerBoundaryIs> and zero or more <innerBoundaryIs>
// (holes) — e.g. a buffered drive-test route often has many holes where the buffer
// self-intersects at sharp turns. Google Earth draws every ring; a parser that only reads
// the first <coordinates> misses the holes and produces a different (wrong, for clipping) shape.
App.parseKmlClusters = function parseKmlClusters(kmlText) {
  const doc = new DOMParser().parseFromString(kmlText, 'text/xml');
  const placemarks = Array.from(doc.getElementsByTagName('Placemark'));
  const clusters = [];
  let autoIdx = 0;
  const seenIdCounts = new Map(); // some source KMZs reuse the same ID for two distinct areas

  for (const pm of placemarks) {
    const polygonEl = pm.getElementsByTagName('Polygon')[0];
    if (!polygonEl) continue;

    const outerEl = polygonEl.getElementsByTagName('outerBoundaryIs')[0];
    const ring = ringFromLinearRing(outerEl && outerEl.getElementsByTagName('LinearRing')[0]);
    if (!ring) continue;

    const holes = [];
    for (const innerEl of Array.from(polygonEl.getElementsByTagName('innerBoundaryIs'))) {
      const hole = ringFromLinearRing(innerEl.getElementsByTagName('LinearRing')[0]);
      if (hole) holes.push(hole);
    }

    const nameEl = pm.getElementsByTagName('name')[0];
    const descEl = pm.getElementsByTagName('description')[0];
    let id = nameEl && nameEl.textContent.trim();
    if (!id) id = extractClusterId(descEl && descEl.textContent);
    if (!id) id = `Cluster-${++autoIdx}`;

    // Disambiguate a reused ID so each area is still its own independently selectable entry
    // (otherwise two different polygons sharing one ID would always select/clip together).
    const seenCount = (seenIdCounts.get(id) || 0) + 1;
    seenIdCounts.set(id, seenCount);
    if (seenCount > 1) id = `${id} (${seenCount})`;

    clusters.push({
      id,
      ring,
      holes,
      bbox: App.bboxOfRing(ring)
    });
  }
  return clusters;
};

// Accepts a File (.kmz or .kml) and resolves an array of clusters.
App.loadKmzFile = function loadKmzFile(file) {
  const isKmz = /\.kmz$/i.test(file.name);
  if (!isKmz) {
    return file.text().then(App.parseKmlClusters);
  }
  return JSZip.loadAsync(file).then(zip => {
    const kmlEntry = Object.values(zip.files).find(f => /\.kml$/i.test(f.name));
    if (!kmlEntry) throw new Error('No .kml file found inside KMZ archive.');
    return kmlEntry.async('string');
  }).then(App.parseKmlClusters);
};
