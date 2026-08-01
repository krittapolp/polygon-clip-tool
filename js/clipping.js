window.App = window.App || {};

// Test whether (lon,lat) falls inside any of the given clusters. A spatial grid index narrows
// the candidate list down from "every selected cluster" to "clusters whose bbox overlaps this cell".
function pointInAnyCluster(lon, lat, index) {
  const candidates = App.querySpatialIndex(index, lon, lat);
  if (!candidates) return null;
  for (const c of candidates) {
    if (!App.pointInBbox(lon, lat, c.bbox)) continue;
    if (App.pointInPolygonWithHoles(lon, lat, c.ring, c.holes)) return c.id;
  }
  return null;
}

// Clips `rows` against `selectedClusters` (array of cluster objects). Time-sliced so the UI stays responsive.
// Resolves with { rows: [...clipped, tagged with clusterId], total, matched }.
App.clipRowsToClusters = function clipRowsToClusters(rows, selectedClusters, onProgress) {
  return new Promise(resolve => {
    if (!selectedClusters || selectedClusters.length === 0) {
      resolve({ rows: rows.slice(), total: rows.length, matched: rows.length });
      return;
    }
    const index = App.buildSpatialIndex(selectedClusters);
    const out = [];
    let processed = 0;
    App.forEachChunked(rows, (row) => {
      processed++;
      const clusterId = pointInAnyCluster(row.lon, row.lat, index);
      if (clusterId) out.push(Object.assign({ clusterId }, row));
    }, () => {
      resolve({ rows: out, total: rows.length, matched: out.length });
    });
    if (onProgress) {
      const total = rows.length;
      const timer = setInterval(() => {
        onProgress(processed, total);
        if (processed >= total) clearInterval(timer);
      }, 150);
    }
  });
};
