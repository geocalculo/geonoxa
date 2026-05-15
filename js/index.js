const GEO_NOXA_DATA = {
  zonas: "capas/zonas_saturadas/zonas_saturadas_calidad_aire.geojson",
  relaves: "capas/relaves/relaves_geonoxa_lite.geojson",
  hidricas: "data/plataformas_hidricas.geojson",
  lagos: "capas/lagos/lagos_chile.geojson",
  prc: "capas/zonas_urbanas/prc_visibles_centroides_ponderados_wgs84.geojson"
};

const ECOSYSTEM_LINKS = { geoipt: "https://geoipt.cl/", geoeva: "https://geoeva.cl/", geonemo: "https://geonemo.cl/", geonoxa: "index.html" };
const noxaState = { layers: {}, zonasSaturadasFeatures: [] };
const RELAVES_OPTIONS = [5, 10, 15];
const RELAVE_LABEL_STORAGE_KEY = "geonoxa_relave_label_mode";
const RELAVE_LABEL_VALID_MODES = new Set(["none", "faena", "empresa", "tipo_deposito", "recurso"]);
let currentRelaveLabelField = null;
let relaveLabelsLayer = L.layerGroup();

const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([-27.3668, -70.3323], 8);
window.geoNoxaMap = map;
const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);
const esri = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles &copy; Esri" });
L.control.layers({ OSM: osm, "Satélite": esri }, {}, { collapsed: true }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
relaveLabelsLayer.addTo(map);

function showWarning(message){ const el = document.getElementById("geonoxa-warning"); if(!el) return; el.textContent = message; el.style.display = "block"; setTimeout(() => { el.style.display = "none"; }, 4000); }
function getRelavesCount(){
  const relavesSlider = document.getElementById("relaves-slider");
  const raw = Number(relavesSlider?.value ?? 5);
  if (raw <= 5) return 5;
  if (raw <= 10) return 10;
  return 15;
}
function getSelectedRelavesN(){
  const value = Number(localStorage.getItem("geonoxa_relaves_n") || 5);
  return RELAVES_OPTIONS.includes(value) ? value : 5;
}
function isDesktopPointer(){ return window.matchMedia("(hover: hover) and (pointer: fine)").matches; }
function buildCardUrl(latlng){ const nRelaves = getRelavesCount(); localStorage.setItem("geonoxa_relaves_n", String(nRelaves)); const p = new URLSearchParams({ lat: latlng.lat.toFixed(7), lon: latlng.lng.toFixed(7), zoom: String(map.getZoom()), n_relaves: String(nRelaves) }); return `mapago.html?${p.toString()}`; }
function openCardFromPoi(latlng){ window.location.href = buildCardUrl(latlng); }

function bindLayerInteractions(layer, tooltipText){
  if(isDesktopPointer() && tooltipText){ layer.bindTooltip(tooltipText, { sticky: true }); }
  layer.on("click", (e) => { L.DomEvent.stopPropagation(e); openCardFromPoi(e.latlng); });
}

function countLayerVisible(layer){ if(!layer || !map.hasLayer(layer)) return 0; const bounds = map.getBounds(); let count = 0; layer.eachLayer((lyr)=>{ if(lyr.getLatLng && bounds.contains(lyr.getLatLng())) count += 1; else if(lyr.getBounds && bounds.intersects(lyr.getBounds())) count += 1; }); return count; }
function toSearchItems(){
  const items = [];
  const addLayerItems = (layer, type, fields, labelBuilder) => {
    if(!layer) return;
    layer.eachLayer((lyr) => {
      const feature = lyr.feature;
      const properties = feature?.properties || {};
      const values = fields.map((f) => String(properties[f] ?? "")).filter(Boolean);
      if(!values.length) return;
      const label = labelBuilder(properties, values);
      const latlng = lyr.getLatLng ? lyr.getLatLng() : lyr.getBounds ? lyr.getBounds().getCenter() : null;
      if(!latlng) return;
      items.push({ type, label, searchText: values.join(" ").toLowerCase(), latlng, layer: lyr });
    });
  };

  addLayerItems(noxaState.layers.relaves, "Relave", ["id_relave", "empresa", "faena", "tipo_deposito", "recurso"],
    (p, v) => `${p.id_relave || "Relave"} · ${p.faena || p.empresa || v[0]}`);
  addLayerItems(noxaState.layers.zonas, "Zona saturada", ["nombre_zon", "zona_dec", "saturado", "latentes", "decreto"],
    (p, v) => `${p.nombre_zon || p.zona_dec || "Zona saturada"} · ${p.decreto || v[0]}`);

  return items;
}

function prioritizeResults(results){
  const bounds = map.getBounds();
  const center = map.getCenter();
  const inViewport = [];
  const outsideViewport = [];
  results.forEach((item) => {
    if(bounds.contains(item.latlng)) inViewport.push(item);
    else outsideViewport.push(item);
  });
  outsideViewport.sort((a, b) => center.distanceTo(a.latlng) - center.distanceTo(b.latlng));
  return [...inViewport, ...outsideViewport].slice(0, 3);
}

function highlightSearchResult(result){
  const layer = result.layer;
  if(!layer) return;
  const isCircle = !!layer.setRadius;
  const originalStyle = layer.options ? { ...layer.options } : null;
  const originalRadius = isCircle ? layer.getRadius() : null;

  if(layer.setStyle){ layer.setStyle({ color: "#2563eb", fillColor: "#60a5fa", weight: 3, fillOpacity: 0.9 }); }
  if(isCircle && originalRadius != null) layer.setRadius(Math.max(8, originalRadius + 3));
  if(layer.bringToFront) layer.bringToFront();

  setTimeout(() => {
    if(layer.setStyle && originalStyle) layer.setStyle(originalStyle);
    if(isCircle && originalRadius != null) layer.setRadius(originalRadius);
  }, 1800);
}

function setupSearch(){
  const input = document.getElementById("map-search");
  const resultsEl = document.getElementById("map-search-results");
  if(!input || !resultsEl) return;

  let lastResults = [];

  const render = (results) => {
    lastResults = results;
    resultsEl.innerHTML = "";
    if(!results.length){ resultsEl.style.display = "none"; return; }
    results.forEach((result) => {
      const li = document.createElement("div");
      li.className = "map-search-item";
      li.tabIndex = 0;
      li.textContent = `${result.label} · ${result.type}`;
      const selectResult = () => { map.setView(result.latlng, 15); highlightSearchResult(result); resultsEl.style.display = "none"; };
      li.addEventListener("click", selectResult);
      li.addEventListener("keydown", (e) => { if(e.key === "Enter") selectResult(); });
      resultsEl.appendChild(li);
    });
    resultsEl.style.display = "block";
  };

  input.addEventListener("input", () => {
    const term = input.value.trim().toLowerCase();
    if(term.length < 2){ render([]); return; }
    const matches = toSearchItems().filter((item) => item.searchText.includes(term));
    render(prioritizeResults(matches));
  });

  input.addEventListener("keydown", (e) => {
    if(e.key !== "Enter") return;
    const first = lastResults[0];
    if(!first) return;
    e.preventDefault();
    map.setView(first.latlng, 15);
    highlightSearchResult(first);
    resultsEl.style.display = "none";
  });

  document.addEventListener("click", (e) => {
    if(e.target === input || resultsEl.contains(e.target)) return;
    resultsEl.style.display = "none";
  });
}
function updateSummary(){
  const zonas = countLayerVisible(noxaState.layers.zonas);
  const relaves = countLayerVisible(noxaState.layers.relaves);
  document.getElementById("sum-zonas").textContent = String(zonas);
  document.getElementById("sum-relaves").textContent = String(relaves);
}

async function loadJson(url){ const res = await fetch(url, { cache: "no-store" }); if(!res.ok) throw new Error(url); return res.json(); }
async function loadAllLayers(){
  try {
    const zonas = await loadJson(GEO_NOXA_DATA.zonas);
    noxaState.layers.zonas = L.geoJSON(zonas, { style: { color: "#ef4444", fillColor: "#fca5a5", fillOpacity: 0.35, weight: 1.5 }, onEachFeature: (f, l) => bindLayerInteractions(l, f?.properties?.nombre_zon || "Zona saturada") }).addTo(map);
  } catch { showWarning("No se pudo cargar zonas saturadas"); }
  try {
    const relaves = await loadJson(GEO_NOXA_DATA.relaves);
    noxaState.layers.relaves = L.geoJSON(relaves, { pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 6, color: "#f97316", fillColor: "#f97316", fillOpacity: .95, weight: 1 }), onEachFeature: (f, l) => bindLayerInteractions(l, f?.properties?.faena || "Relave") }).addTo(map);
  } catch { showWarning("No se pudo cargar relaves"); }
  try { const hidricas = await loadJson(GEO_NOXA_DATA.hidricas); noxaState.layers.hidricas = L.geoJSON(hidricas, { style: { color: "#0284c7", weight: 1.5 } }); } catch {}
  try { const prc = await loadJson(GEO_NOXA_DATA.prc); noxaState.layers.prc = L.geoJSON(prc, { pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 4, color: "#64748b" }) }); } catch {}
  updateSummary();
}


function getStoredRelaveLabelMode(){
  const stored = localStorage.getItem(RELAVE_LABEL_STORAGE_KEY) || "none";
  return RELAVE_LABEL_VALID_MODES.has(stored) ? stored : "none";
}

function mapLabelModeToField(mode){
  if(mode === "none") return null;
  if(mode === "faena") return "faena";
  if(mode === "empresa") return "empresa";
  if(mode === "tipo_deposito") return "tipo_deposito";
  if(mode === "recurso") return "recurso";
  return null;
}

function isValidRelaveLabelValue(value){
  if(value == null) return false;
  const normalized = String(value).trim();
  if(!normalized) return false;
  const upper = normalized.toUpperCase();
  return upper !== "-" && upper !== "SIN INFORMACION";
}

function updateRelaveLabels(){
  const relavesLayer = noxaState.layers.relaves;
  relaveLabelsLayer.clearLayers();

  if(!currentRelaveLabelField) return;
  if(!relavesLayer) return;

  relavesLayer.eachLayer((layer) => {
    if(!layer?.feature || !layer.feature.properties) return;

    const props = layer.feature.properties;
    const value = props[currentRelaveLabelField];
    if(!isValidRelaveLabelValue(value)) return;

    const latlng = layer.getLatLng ? layer.getLatLng() : null;
    if(!latlng) return;

    const label = L.marker(latlng, {
      interactive: false,
      icon: L.divIcon({
        className: "relave-label",
        html: `<div>${String(value).trim()}</div>`,
        iconSize: [120, 20],
        iconAnchor: [60, -8]
      })
    });

    relaveLabelsLayer.addLayer(label);
  });
}

function setupRelaveLabelRadios(){
  const radios = document.querySelectorAll('input[name="relave-labels"]');
  if(!radios.length) return;

  const applyMode = (mode) => {
    const normalizedMode = RELAVE_LABEL_VALID_MODES.has(mode) ? mode : "none";
    currentRelaveLabelField = mapLabelModeToField(normalizedMode);
    localStorage.setItem(RELAVE_LABEL_STORAGE_KEY, normalizedMode);
    updateRelaveLabels();
  };

  const initialMode = getStoredRelaveLabelMode();
  radios.forEach((radio) => { radio.checked = radio.value === initialMode; });
  applyMode(initialMode);

  radios.forEach((radio) => {
    radio.addEventListener("change", (e) => {
      if(!e.target?.checked) return;
      applyMode(e.target.value);
    });
  });
}

map.on("click", (e) => { openCardFromPoi(e.latlng); });
map.on("moveend zoomend", () => { updateSummary(); updateRelaveLabels(); });


(function setupRelavesSlider(){
  const slider = document.getElementById("relaves-slider");
  const relavesHint = document.getElementById("relaves-hint");
  const saved = getSelectedRelavesN();
  slider.value = String(saved);
  relavesHint.innerText = "Analizarás los " + saved + " relaves más cercanos al hacer clic en el mapa";
  slider.addEventListener("input", () => {
    const n = getRelavesCount();
    slider.value = String(n);
    localStorage.setItem("geonoxa_relaves_n", String(n));
    relavesHint.innerText = "Analizarás los " + n + " relaves más cercanos al hacer clic en el mapa";
  });
})();

(function setupLocate(){
  const btn = document.getElementById("mira-rifle");
  btn.addEventListener("click", () => {
    if(!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 13));
  });
})();

(function setupGeoSwitch(){
  document.querySelectorAll("#geo-switch a[data-site]").forEach((link) => {
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      const base = ECOSYSTEM_LINKS[link.dataset.site];
      const c = map.getCenter();
      const url = new URL(base, window.location.href);
      url.searchParams.set("lat", c.lat.toFixed(7));
      url.searchParams.set("lon", c.lng.toFixed(7));
      url.searchParams.set("zoom", String(map.getZoom()));
      window.location.href = url.toString();
    });
  });
})();

(function setupRegionSelect(){
  const regionSelect = document.getElementById("region-select");
  if(!regionSelect) return;

  fetch("capas/regiones/regiones.json")
    .then((res) => res.json())
    .then((regiones) => {
      if(!Array.isArray(regiones) || !regiones.length) return;
      regiones.forEach((regionItem) => {
        if(regionItem?.id == null) return;
        const option = document.createElement("option");
        option.value = String(regionItem.id);
        option.textContent = regionItem.nombre;
        regionSelect.appendChild(option);
      });
      regionSelect.selectedIndex = 0;
      const first = regiones[0];
      if(Array.isArray(first?.centro) && first.centro.length === 2){
        map.setView(first.centro, Number(first.zoom) || map.getZoom());
      }

      regionSelect.addEventListener("change", (e) => {
        const region = regiones.find((r) => String(r.id) === e.target.value);
        if(!region) return;
        map.setView(region.centro, region.zoom);
      });
    })
    .catch(() => showWarning("No se pudo cargar regiones"));
})();

loadAllLayers().then(() => { setupRelaveLabelRadios(); updateRelaveLabels(); setupSearch(); });
