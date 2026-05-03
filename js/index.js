const GEO_NOXA_DATA = {
  zonas: "capas/zonas_saturadas/zonas_saturadas_calidad_aire.geojson",
  relaves: "capas/relaves/relaves_geonoxa_lite.geojson",
  hidricas: "data/plataformas_hidricas.geojson",
  lagos: "capas/lagos/lagos_chile.geojson",
  prc: "capas/zonas_urbanas/prc_visibles_centroides_ponderados_wgs84.geojson"
};

const ECOSYSTEM_LINKS = { geoipt: "https://geoipt.cl/", geoeva: "https://geoeva.cl/", geonemo: "https://geonemo.cl/", geonoxa: "index.html" };
const noxaState = { layers: {}, zonasSaturadasFeatures: [] };

const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([-27.3668, -70.3323], 8);
const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);
const esri = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles &copy; Esri" });
L.control.layers({ OSM: osm, "Satélite": esri }, {}, { collapsed: true }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

function showWarning(message){ const el = document.getElementById("geonoxa-warning"); if(!el) return; el.textContent = message; el.style.display = "block"; setTimeout(() => { el.style.display = "none"; }, 4000); }
function getSelectedRelavesN(){ const value = Number(localStorage.getItem("geonoxa_relaves_n") || 5); return Number.isFinite(value) && value >= 1 && value <= 10 ? value : 5; }
function isDesktopPointer(){ return window.matchMedia("(hover: hover) and (pointer: fine)").matches; }
function computePotentialConflicts(){ return 0; }
function buildCardUrl(latlng){ const p = new URLSearchParams({ lat: latlng.lat.toFixed(7), lon: latlng.lng.toFixed(7), zoom: String(map.getZoom()), n_relaves: String(getSelectedRelavesN()) }); return `mapago.html?${p.toString()}`; }
function openCardFromPoi(latlng){ window.location.href = buildCardUrl(latlng); }

function bindLayerInteractions(layer, tooltipText){
  if(isDesktopPointer() && tooltipText){ layer.bindTooltip(tooltipText, { sticky: true }); }
  layer.on("click", (e) => { L.DomEvent.stopPropagation(e); openCardFromPoi(e.latlng); });
}

function countLayerVisible(layer){ if(!layer) return 0; const bounds = map.getBounds(); let count = 0; layer.eachLayer((lyr)=>{ if(lyr.getLatLng && bounds.contains(lyr.getLatLng())) count += 1; else if(lyr.getBounds && bounds.intersects(lyr.getBounds())) count += 1; }); return count; }
function updateSummary(){
  const zonas = countLayerVisible(noxaState.layers.zonas);
  const relaves = countLayerVisible(noxaState.layers.relaves);
  document.getElementById("sum-zonas").textContent = String(zonas);
  document.getElementById("sum-relaves").textContent = String(relaves);
  document.getElementById("sum-conflicts").textContent = String(computePotentialConflicts());
}

async function loadJson(url){ const res = await fetch(url, { cache: "no-store" }); if(!res.ok) throw new Error(url); return res.json(); }
async function loadAllLayers(){
  try {
    const zonas = await loadJson(GEO_NOXA_DATA.zonas);
    noxaState.layers.zonas = L.geoJSON(zonas, { style: { color: "#ef4444", fillColor: "#fca5a5", fillOpacity: 0.35, weight: 1.5 }, onEachFeature: (f, l) => bindLayerInteractions(l, f?.properties?.nombre || "Zona saturada") }).addTo(map);
  } catch { showWarning("No se pudo cargar zonas saturadas"); }
  try {
    const relaves = await loadJson(GEO_NOXA_DATA.relaves);
    noxaState.layers.relaves = L.geoJSON(relaves, { pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 6, color: "#f97316", fillColor: "#f97316", fillOpacity: .95, weight: 1 }), onEachFeature: (f, l) => bindLayerInteractions(l, f?.properties?.id || "Relave") }).addTo(map);
  } catch { showWarning("No se pudo cargar relaves"); }
  try { const hidricas = await loadJson(GEO_NOXA_DATA.hidricas); noxaState.layers.hidricas = L.geoJSON(hidricas, { style: { color: "#0284c7", weight: 1.5 } }); } catch {}
  try { const prc = await loadJson(GEO_NOXA_DATA.prc); noxaState.layers.prc = L.geoJSON(prc, { pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 4, color: "#64748b" }) }); } catch {}
  updateSummary();
}

map.on("click", (e) => { openCardFromPoi(e.latlng); });
map.on("moveend zoomend", updateSummary);

document.getElementById("toggle-zonas").addEventListener("change", (e)=> e.target.checked ? noxaState.layers.zonas?.addTo(map) : map.removeLayer(noxaState.layers.zonas));
document.getElementById("toggle-relaves").addEventListener("change", (e)=> e.target.checked ? noxaState.layers.relaves?.addTo(map) : map.removeLayer(noxaState.layers.relaves));
document.getElementById("toggle-hidricas").addEventListener("change", (e)=> e.target.checked ? noxaState.layers.hidricas?.addTo(map) : map.removeLayer(noxaState.layers.hidricas));
document.getElementById("toggle-prc").addEventListener("change", (e)=> e.target.checked ? noxaState.layers.prc?.addTo(map) : map.removeLayer(noxaState.layers.prc));

(function setupRelavesSlider(){
  const slider = document.getElementById("relaves-range");
  const relavesHint = document.getElementById("relaves-hint");
  const saved = getSelectedRelavesN();
  slider.value = String(saved);
  relavesHint.innerText = "Analizarás los " + saved + " relaves más cercanos al hacer clic en el mapa";
  slider.addEventListener("input", () => {
    const n = Number(slider.value) || 5;
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

  fetch('/capas/regiones/regiones.json')
    .then((res) => res.json())
    .then((regiones) => {
      regiones.forEach((regionItem) => {
        const option = document.createElement("option");
        option.value = String(regionItem.id);
        option.textContent = regionItem.nombre;
        regionSelect.appendChild(option);
      });

      regionSelect.addEventListener("change", (e) => {
        const value = e.target.value;
        const region = regiones.find(r => String(r.id) === String(value));
        if (region) {
          map.setView(region.centro, region.zoom);
        }
      });
    })
    .catch(() => showWarning("No se pudo cargar regiones"));
})();

loadAllLayers();
