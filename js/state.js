window.App = window.App || {};

// Flat color palette, one color assigned per loaded CSV file (cycles if more files than colors).
App.DATASET_COLORS = ['#ef4444', '#38bdf8', '#f472b6', '#4ade80', '#facc15', '#a78bfa', '#fb923c', '#2dd4bf'];

App.state = {
  datasets: [],           // [{ id, fileName, headerFields, rows, rowCount, skipped, color }]
  nextDatasetId: 1,
  clusters: [],            // [{ id, ring, bbox }]
  selectedClusterIds: new Set(),
  clippedById: {},         // datasetId -> clipped rows
  hasClip: false
};

App.getDataset = function getDataset(id) {
  return App.state.datasets.find(d => d.id === id);
};

App.getActiveRows = function getActiveRows(id) {
  if (App.state.hasClip) return App.state.clippedById[id] || [];
  const ds = App.getDataset(id);
  return ds ? ds.rows : [];
};

App.colorForIndex = function colorForIndex(i) {
  return App.DATASET_COLORS[i % App.DATASET_COLORS.length];
};
