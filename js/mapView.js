window.App = window.App || {};

const LOD_ZOOM_THRESHOLD = 15;        // below this zoom, bins are sub-pixel anyway — draw lightweight markers instead
const VISIBLE_MARKER_FALLBACK = 3000; // if a file still has more bins than this *within view*, fall back to markers even when zoomed in
const VIEWPORT_PAD = 0.25;            // pad the culled area by 25% of the viewport so a small pan doesn't pop features in/out
const MAX_VISIBLE_PER_DATASET = 2500; // hard cap per file per redraw — matters right after load/clip, when "in view" still means "everything"

// Deterministic stride sample down to `cap` items, so a zoomed-out view showing "everything"
// (right after load, before the user has zoomed/panned) stays bounded instead of adding every row.
function sampleToCap(rows, cap) {
  if (rows.length <= cap) return rows;
  const stride = Math.ceil(rows.length / cap);
  const sampled = [];
  for (let i = 0; i < rows.length; i += stride) sampled.push(rows[i]);
  return sampled;
}

App._map = null;
App._mapDataLayer = null;
App._mapClusterLayer = null;
App._mapLegendCtl = null;
App._mapInited = false;
App._mapDataRenderer = null;
App._mapClusterRenderer = null;
App._mapRenderToken = 0;

App.initMap = function initMap() {
  if (App._mapInited) return;
  App._map = L.map('mapContainer', { preferCanvas: true }).setView([7.9, 98.35], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(App._map);
  // One shared canvas per layer group, reused across every redraw — creating a fresh L.canvas()
  // per shape per redraw leaves its old canvas element behind (each L.canvas() is its own <canvas>
  // added to the map), so re-rendering repeatedly (e.g. every cluster checkbox toggle) would
  // otherwise pile up orphaned canvases and the page would slow to a crawl.
  App._mapDataRenderer = L.canvas({ padding: 0.3 });
  App._mapClusterRenderer = L.canvas();
  App._mapDataLayer = L.layerGroup().addTo(App._map);
  App._mapClusterLayer = L.layerGroup().addTo(App._map);
  App._mapInited = true;

  // Pan/zoom only re-culls + redraws what's now in view — it never re-fits bounds,
  // so it doesn't fight the user's own navigation.
  App._map.on('moveend', App.debounce(drawVisibleFeatures, 120));
};

function buildLegend() {
  if (App._mapLegendCtl) {
    App._map.removeControl(App._mapLegendCtl);
    App._mapLegendCtl = null;
  }
  if (!App.state.datasets.length) return;
  const ctl = L.control({ position: 'bottomright' });
  ctl.onAdd = function () {
    const div = L.DomUtil.create('div', 'map-legend');
    let rows = '';
    App.state.datasets.forEach(ds => {
      rows += `<div><span class="legend-swatch" style="background:${ds.color}"></span>${App.escapeHtml(ds.fileName)}</div>`;
    });
    rows += `<div><span class="legend-swatch" style="background:transparent;border:2px solid #38bdf8"></span>Selected cluster</div>`;
    div.innerHTML = `<div class="map-legend-title">Loaded files</div>${rows}`;
    return div;
  };
  ctl.addTo(App._map);
  App._mapLegendCtl = ctl;
}

function fitToAllRows(datasetRowLists) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  let any = false;
  for (const rows of datasetRowLists) {
    for (const r of rows) {
      any = true;
      if (r.lon < minLon) minLon = r.lon;
      if (r.lon > maxLon) maxLon = r.lon;
      if (r.lat < minLat) minLat = r.lat;
      if (r.lat > maxLat) maxLat = r.lat;
    }
  }
  if (any) App._map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [20, 20] });
}

function paddedViewBbox() {
  const b = App._map.getBounds();
  const lonPad = (b.getEast() - b.getWest()) * VIEWPORT_PAD;
  const latPad = (b.getNorth() - b.getSouth()) * VIEWPORT_PAD;
  return [b.getWest() - lonPad, b.getSouth() - latPad, b.getEast() + lonPad, b.getNorth() + latPad];
}

App.renderClusterLayer = function renderClusterLayer() {
  App._mapClusterLayer.clearLayers();
  const selected = App.state.selectedClusterIds;
  for (const c of App.state.clusters) {
    const isSelected = selected.has(c.id);
    const outerLatLngs = c.ring.map(([lon, lat]) => [lat, lon]);
    // Leaflet renders holes correctly (even-odd fill) when given [outer, hole1, hole2, ...].
    const holeLatLngs = (c.holes || []).map(hole => hole.map(([lon, lat]) => [lat, lon]));
    const latlngs = holeLatLngs.length ? [outerLatLngs, ...holeLatLngs] : outerLatLngs;
    const poly = L.polygon(latlngs, {
      renderer: App._mapClusterRenderer,
      color: isSelected ? '#38bdf8' : '#64748b',
      weight: isSelected ? 3 : 1,
      fill: true, // keep fill on (even at 0 opacity) so the whole area — not just the thin border — is hoverable
      fillColor: '#38bdf8',
      fillOpacity: isSelected ? 0.08 : 0.01,
      opacity: 0.85
    });
    poly.bindTooltip(App.escapeHtml(c.id), { sticky: true });
    poly.on('click', () => {
      if (App.toggleClusterSelection) App.toggleClusterSelection(c.id);
    });
    poly.addTo(App._mapClusterLayer);
  }
};

// Redraws only the bins that overlap the current viewport, at a level of detail matched to
// the current zoom. Called after every pan/zoom (debounced) as well as after data changes —
// this is what keeps zoom/pan smooth regardless of total dataset size.
function drawVisibleFeatures() {
  if (!App._mapInited) return;
  App._mapDataLayer.clearLayers();
  if (!App.state.datasets.length) return;

  const token = ++App._mapRenderToken;
  const zoom = App._map.getZoom();
  const viewBbox = paddedViewBbox();
  const renderer = App._mapDataRenderer;
  const workItems = [];

  for (const ds of App.state.datasets) {
    const rows = App.getActiveRows(ds.id);
    const visible = rows.filter(r => App.bboxIntersects(r.bbox, viewBbox));
    const useMarkers = zoom < LOD_ZOOM_THRESHOLD || visible.length > VISIBLE_MARKER_FALLBACK;
    const sampled = sampleToCap(visible, MAX_VISIBLE_PER_DATASET);
    const fileName = App.escapeHtml(ds.fileName); // escape once per dataset, not once per row
    for (const r of sampled) workItems.push({ r, color: ds.color, fileName, useMarkers });
  }

  App.forEachChunked(workItems, (item) => {
    if (token !== App._mapRenderToken) return;
    const { r, color, fileName, useMarkers } = item;
    let layer;
    if (useMarkers) {
      layer = L.circleMarker([r.lat, r.lon], {
        renderer, radius: 3, color, fillColor: color, fillOpacity: 0.85, weight: 0
      });
    } else {
      const latlngs = r.ring.map(([lon, lat]) => [lat, lon]);
      layer = L.polygon(latlngs, {
        renderer, color, weight: 0.5, fillColor: color, fillOpacity: 0.75, opacity: 0.9
      });
    }
    layer.bindTooltip(`<b>${fileName}</b><br>${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}`, { sticky: true });
    layer.addTo(App._mapDataLayer);
  }, () => {});
}

// Full data-change entry point: re-fits the view to the active data, then redraws what's in view.
App.renderMapData = function renderMapData() {
  if (!App._mapInited) return;
  buildLegend();
  const allRowLists = App.state.datasets.map(ds => App.getActiveRows(ds.id));
  fitToAllRows(allRowLists);
  drawVisibleFeatures();
};

App.renderMap = function renderMap() {
  App.initMap();
  setTimeout(() => App._map.invalidateSize(), 50);
  App.renderClusterLayer();
  App.renderMapData();
};
