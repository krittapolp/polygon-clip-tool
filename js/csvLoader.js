window.App = window.App || {};

// Every raw CSV is expected to carry center_longitude, center_latitude, and a Polygon
// (bin footprint) column, regardless of filename or what other columns it has.
function normalizeRow(raw) {
  const lon = App.numOrNull(raw.center_longitude);
  const lat = App.numOrNull(raw.center_latitude);
  const ring = App.parseBinRing(raw.Polygon);
  if (lon === null || lat === null || !ring) return null;

  return {
    lon, lat, ring,
    bbox: App.bboxOfRing(ring),
    raw
  };
}

// Parses a File object with PapaParse and returns { headerFields, rows, rowCount, skipped, fileName }.
// Uses the `chunk` callback (batches of rows) rather than `step` (one row at a time) — far fewer
// worker->main-thread messages for the same file, which is the dominant cost for large CSVs.
App.loadCsvFile = function loadCsvFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headerFields = null;
    let skipped = 0;
    let parsedCount = 0;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      worker: true,
      chunkSize: 1024 * 1024,
      chunk: function (results) {
        if (!headerFields) headerFields = results.meta.fields;
        for (const raw of results.data) {
          parsedCount++;
          const row = normalizeRow(raw);
          if (row) rows.push(row);
          else skipped++;
        }
        if (onProgress) onProgress(parsedCount);
      },
      complete: function () {
        resolve({ headerFields, rows, rowCount: rows.length, skipped, fileName: file.name });
      },
      error: function (err) {
        reject(err);
      }
    });
  });
};
