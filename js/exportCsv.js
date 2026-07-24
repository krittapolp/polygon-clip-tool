window.App = window.App || {};

function buildCsvText(headerFields, rows, includeCluster) {
  const cols = includeCluster ? ['ClusterID', ...headerFields] : headerFields;
  const lines = [cols.map(App.csvEscape).join(',')];
  for (const r of rows) {
    const vals = includeCluster
      ? [r.clusterId || '', ...headerFields.map(f => r.raw[f])]
      : headerFields.map(f => r.raw[f]);
    lines.push(vals.map(App.csvEscape).join(','));
  }
  return lines.join('\r\n');
}

function exportName(ds) {
  const base = ds.fileName ? ds.fileName.replace(/\.csv$/i, '') : `dataset_${ds.id}`;
  const suffix = App.state.hasClip ? '_clipped' : '_export';
  return `${base}${suffix}.csv`;
}

App.exportDatasetCsv = function exportDatasetCsv(datasetId) {
  const ds = App.getDataset(datasetId);
  if (!ds) return;
  const rows = App.getActiveRows(datasetId);
  const csv = buildCsvText(ds.headerFields, rows, App.state.hasClip);
  App.downloadTextFile(exportName(ds), csv);
};

App.exportAllDatasetsZip = function exportAllDatasetsZip() {
  if (!App.state.datasets.length) return;
  const zip = new JSZip();
  const usedNames = new Set(); // two loaded files can share a filename — don't let the second silently overwrite the first in the zip
  for (const ds of App.state.datasets) {
    const rows = App.getActiveRows(ds.id);
    const csv = buildCsvText(ds.headerFields, rows, App.state.hasClip);
    let name = exportName(ds);
    if (usedNames.has(name)) {
      const base = name.replace(/\.csv$/i, '');
      name = `${base}_${ds.id}.csv`;
    }
    usedNames.add(name);
    zip.file(name, csv);
  }
  zip.generateAsync({ type: 'blob' }).then(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = App.state.hasClip ? 'rf_data_clipped.zip' : 'rf_data_export.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
};
