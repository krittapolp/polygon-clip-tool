window.App = window.App || {};

App._loadingFiles = []; // [{ tempId, fileName, rowCount }] transient, in-flight parses

function showToast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle('error', !!isError);
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, 3500);
}
App.showToast = showToast;

// ---------- Dataset list (CSV files) ----------

function renderDatasetList() {
  const ul = document.getElementById('datasetList');
  ul.innerHTML = '';

  for (const f of App._loadingFiles) {
    const li = document.createElement('li');
    const name = App.escapeHtml(f.fileName);
    li.innerHTML = `<span class="ds-swatch" style="background:#475569"></span><span class="ds-name ds-pending">${name}</span><span class="ds-count">loading… ${f.rowCount}</span>`;
    ul.appendChild(li);
  }

  for (const ds of App.state.datasets) {
    const li = document.createElement('li');
    const name = App.escapeHtml(ds.fileName);
    li.innerHTML = `
      <span class="ds-swatch" style="background:${ds.color}"></span>
      <span class="ds-name" title="${name}">${name}</span>
      <span class="ds-count">${ds.rowCount.toLocaleString()}</span>
      <button class="ds-remove" data-id="${ds.id}" title="ลบไฟล์นี้">&times;</button>
    `;
    ul.appendChild(li);
  }

  ul.querySelectorAll('.ds-remove').forEach(btn => {
    btn.addEventListener('click', () => removeDataset(Number(btn.dataset.id)));
  });

  document.getElementById('clearAllCsv').hidden = App.state.datasets.length === 0;
  document.getElementById('exportPanel').hidden = App.state.datasets.length === 0;
}

function removeDataset(id) {
  App.state.datasets = App.state.datasets.filter(d => d.id !== id);
  delete App.state.clippedById[id];
  renderDatasetList();
  App.renderMapData();
  showToast('ลบไฟล์ออกแล้ว');
}

async function handleCsvFiles(fileList) {
  const files = Array.from(fileList);
  for (const file of files) {
    const tempId = `tmp-${file.name}-${Date.now()}-${Math.random()}`;
    const loadingEntry = { tempId, fileName: file.name, rowCount: 0 };
    App._loadingFiles.push(loadingEntry);
    renderDatasetList();
    try {
      const result = await App.loadCsvFile(file, (count) => {
        loadingEntry.rowCount = count;
        renderDatasetList();
      });
      App._loadingFiles = App._loadingFiles.filter(f => f.tempId !== tempId);
      if (!result.rowCount) {
        showToast(`ไฟล์ ${file.name} ไม่มีแถวที่มี center_longitude/center_latitude/Polygon ครบ`, true);
        renderDatasetList();
        continue;
      }
      const id = App.state.nextDatasetId++;
      const color = App.colorForIndex(App.state.datasets.length);
      App.state.datasets.push({
        id, fileName: result.fileName, headerFields: result.headerFields,
        rows: result.rows, rowCount: result.rowCount, skipped: result.skipped, color
      });

      // A clip already applied to the other files shouldn't silently leave this new one
      // un-clipped (and invisible) until the user notices and re-clicks "Apply cluster clip".
      if (App.state.hasClip) {
        const selected = App.state.clusters.filter(c => App.state.selectedClusterIds.has(c.id));
        const clipResult = await App.clipRowsToClusters(result.rows, selected);
        App.state.clippedById[id] = clipResult.rows;
      }

      renderDatasetList();
      showToast(`โหลด ${file.name}: ${result.rowCount.toLocaleString()} bins (ข้าม ${result.skipped})`);
      App.renderMapData();
    } catch (err) {
      App._loadingFiles = App._loadingFiles.filter(f => f.tempId !== tempId);
      renderDatasetList();
      showToast(`โหลดไฟล์ ${file.name} ไม่สำเร็จ: ${err.message}`, true);
    }
  }
}

document.getElementById('clearAllCsv').addEventListener('click', () => {
  App.state.datasets = [];
  App.state.clippedById = {};
  App.state.hasClip = false;
  document.getElementById('clipSummary').textContent = '';
  renderDatasetList();
  App.renderMapData();
  showToast('ล้างไฟล์ CSV ทั้งหมดแล้ว');
});

// ---------- KMZ ----------

async function handleKmzFile(file) {
  const statusEl = document.getElementById('kmzStatus');
  statusEl.textContent = 'กำลังโหลด...';
  statusEl.classList.remove('ok');
  try {
    const clusters = await App.loadKmzFile(file);
    App.state.clusters = clusters;
    App.state.selectedClusterIds = new Set();
    App.state.hasClip = false;
    App.state.clippedById = {};
    document.getElementById('clipSummary').textContent = '';
    document.getElementById('clearKmz').hidden = false;
    renderClusterList();
    App.renderMap();

    if (!clusters.length) {
      statusEl.textContent = 'ไม่พบ polygon ในไฟล์นี้';
      statusEl.classList.remove('ok');
      document.getElementById('clusterPanel').hidden = true;
      showToast('ไม่พบ polygon ในไฟล์ KMZ/KML นี้', true);
      return;
    }
    statusEl.textContent = `โหลดแล้ว ${clusters.length} clusters`;
    statusEl.classList.add('ok');
    document.getElementById('clusterPanel').hidden = false;
    showToast(`โหลด cluster polygon สำเร็จ: ${clusters.length} พื้นที่`);
  } catch (err) {
    statusEl.textContent = `โหลดไม่สำเร็จ: ${err.message}`;
    showToast(`โหลด KMZ ไม่สำเร็จ: ${err.message}`, true);
  }
}

document.getElementById('clearKmz').addEventListener('click', () => {
  App.state.clusters = [];
  App.state.selectedClusterIds = new Set();
  App.state.hasClip = false;
  App.state.clippedById = {};
  document.getElementById('kmzStatus').textContent = 'ยังไม่ได้โหลด polygon';
  document.getElementById('kmzStatus').classList.remove('ok');
  document.getElementById('clusterPanel').hidden = true;
  document.getElementById('clearKmz').hidden = true;
  document.getElementById('clipSummary').textContent = '';
  document.getElementById('kmzInput').value = '';
  App.renderMap();
  showToast('ลบ polygon ที่โหลดไว้แล้ว');
});

// ---------- Cluster list ----------

function renderClusterList() {
  const container = document.getElementById('clusterList');
  const search = document.getElementById('clusterSearch').value.trim().toUpperCase();
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  // DOM id is the cluster's position in the master array, not its display id — a source KMZ can
  // reuse the same id text for two placemarks, which would otherwise produce two elements sharing
  // one DOM id/`for` pair (invalid HTML, and the <label> would bind to the wrong checkbox).
  App.state.clusters.forEach((c, idx) => {
    if (search && !c.id.toUpperCase().includes(search)) return;
    const div = document.createElement('div');
    div.className = 'cluster-item';
    const checked = App.state.selectedClusterIds.has(c.id) ? 'checked' : '';
    const label = App.escapeHtml(c.id);
    div.innerHTML = `<input type="checkbox" id="cl-${idx}" ${checked}><label for="cl-${idx}">${label}</label>`;
    div.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) App.state.selectedClusterIds.add(c.id);
      else App.state.selectedClusterIds.delete(c.id);
      App.renderClusterLayer();
    });
    frag.appendChild(div);
  });
  container.appendChild(frag);
}

App.toggleClusterSelection = function toggleClusterSelection(id) {
  if (App.state.selectedClusterIds.has(id)) App.state.selectedClusterIds.delete(id);
  else App.state.selectedClusterIds.add(id);
  renderClusterList();
  App.renderClusterLayer();
};

document.getElementById('clusterSearch').addEventListener('input', App.debounce(renderClusterList, 150));

document.getElementById('selectAllClusters').addEventListener('click', () => {
  const search = document.getElementById('clusterSearch').value.trim().toUpperCase();
  for (const c of App.state.clusters) {
    if (!search || c.id.toUpperCase().includes(search)) App.state.selectedClusterIds.add(c.id);
  }
  renderClusterList();
  App.renderClusterLayer();
});

document.getElementById('clearClusterSelection').addEventListener('click', () => {
  App.state.selectedClusterIds.clear();
  renderClusterList();
  App.renderClusterLayer();
});

// ---------- Clip ----------

document.getElementById('applyClip').addEventListener('click', async () => {
  if (!App.state.datasets.length) { showToast('กรุณาโหลดข้อมูล CSV ก่อน', true); return; }
  const selected = App.state.clusters.filter(c => App.state.selectedClusterIds.has(c.id));
  if (!selected.length) { showToast('กรุณาเลือกอย่างน้อย 1 cluster', true); return; }

  const progressWrap = document.getElementById('clipProgress');
  const fill = document.getElementById('clipProgressFill');
  const text = document.getElementById('clipProgressText');
  progressWrap.hidden = false;
  document.getElementById('applyClip').disabled = true;
  document.getElementById('resetClip').disabled = true; // block "show all" until this clip settles — it would otherwise get overwritten the moment this finishes

  const clippedById = {};
  let totalMatched = 0, totalRows = 0;
  for (const ds of App.state.datasets) {
    const result = await App.clipRowsToClusters(ds.rows, selected, (done, total) => {
      fill.style.width = `${total ? (done / total * 100) : 0}%`;
      text.textContent = `Clipping ${ds.fileName}: ${done.toLocaleString()} / ${total.toLocaleString()}`;
    });
    clippedById[ds.id] = result.rows;
    totalMatched += result.matched;
    totalRows += result.total;
  }

  App.state.clippedById = clippedById;
  App.state.hasClip = true;
  progressWrap.hidden = true;
  document.getElementById('applyClip').disabled = false;
  document.getElementById('resetClip').disabled = false;
  document.getElementById('clipSummary').textContent =
    `Matched ${totalMatched.toLocaleString()} / ${totalRows.toLocaleString()} bins across ${selected.length} cluster(s)`;
  showToast(`ตัดข้อมูลสำเร็จ: ${totalMatched.toLocaleString()} bins`);
  App.renderMapData();
});

document.getElementById('resetClip').addEventListener('click', () => {
  App.state.hasClip = false;
  App.state.clippedById = {};
  document.getElementById('clipSummary').textContent = 'แสดงข้อมูลทั้งหมด (ไม่ได้ตัด)';
  App.renderMapData();
});

// ---------- Export ----------

document.getElementById('exportAllZip').addEventListener('click', () => {
  if (!App.state.datasets.length) { showToast('ไม่มีข้อมูลให้ export', true); return; }
  App.exportAllDatasetsZip();
});

// ---------- Reset all ----------

document.getElementById('resetAll').addEventListener('click', () => {
  App._loadingFiles = [];
  App.state.datasets = [];
  App.state.clusters = [];
  App.state.selectedClusterIds = new Set();
  App.state.clippedById = {};
  App.state.hasClip = false;

  document.getElementById('csvInput').value = '';
  document.getElementById('kmzInput').value = '';
  document.getElementById('kmzStatus').textContent = 'ยังไม่ได้โหลด polygon';
  document.getElementById('kmzStatus').classList.remove('ok');
  document.getElementById('clusterPanel').hidden = true;
  document.getElementById('clearKmz').hidden = true;
  document.getElementById('clipSummary').textContent = '';
  document.getElementById('exportPanel').hidden = true;

  renderDatasetList();
  App.renderMap();
  showToast('ล้างข้อมูลทั้งหมดแล้ว เริ่มใหม่ได้เลย');
});

// ---------- File inputs ----------

document.getElementById('csvInput').addEventListener('change', (e) => {
  if (e.target.files.length) handleCsvFiles(e.target.files);
  e.target.value = '';
});
document.getElementById('kmzInput').addEventListener('change', (e) => {
  if (e.target.files.length) handleKmzFile(e.target.files[0]);
  e.target.value = '';
});

// ---------- Init ----------

renderDatasetList();
App.renderMap();

// Exposed for automated/dev testing only — not used by the normal UI flow above.
App._test = { renderDatasetList, renderClusterList, handleKmzFile, handleCsvFiles, removeDataset };
