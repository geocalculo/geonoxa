const GEO_NOXA_DATA = {
  zonas: "capas/zonas_saturadas/zonas_saturadas_calidad_aire.geojson",
  relaves: "capas/relaves/relaves_geonoxa_lite.geojson",
  hidricas: "data/plataformas_hidricas.geojson",
  lagos: "capas/lagos/lagos_chile.geojson",
  prc: "capas/zonas_urbanas/prc_visibles_centroides_ponderados_wgs84.geojson"
};

const noxaState = { layers: {}, poi: null, layerControl: null, centroidesData: null, relavesData: null, lagosCentroides: [], zonasSaturadasFeatures: [], lastSummaryKey: "", lastRelavesSummaryKey: "" };

const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([-27.3668, -70.3323], 8);

const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

const esri = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
  attribution: "Tiles &copy; Esri"
});

const baseLayers = { "OSM": osm, "Satélite": esri };
const overlays = {};
const fmt = n => Number(n || 0).toLocaleString("es-CL");
const fmt2 = n => Number(n || 0).toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function showWarning(message){ const el = document.getElementById("geonoxa-warning"); if(!el) return; el.innerHTML = message; el.style.display = "block"; clearTimeout(showWarning._timer); showWarning._timer = setTimeout(() => { el.style.display = "none"; }, 7000); }
function getProp(feature, names){ const p = feature?.properties || {}; for(const name of names){ if(p[name] !== undefined && p[name] !== null && String(p[name]).trim() !== "") return p[name]; } return ""; }
function hidroTipo(feature){ return String(getProp(feature, ["tipo", "TIPO", "categoria", "CATEGORIA", "clase", "CLASE", "nombre", "NOMBRE"])).toLowerCase(); }
function isWaterPolygon(feature){ const g = feature?.geometry?.type || ""; const tipo = hidroTipo(feature); return g.includes("Polygon") || tipo.includes("lago") || tipo.includes("laguna") || tipo.includes("embalse"); }
function isWaterLine(feature){ const g = feature?.geometry?.type || ""; const tipo = hidroTipo(feature); return g.includes("LineString") || tipo.includes("rio") || tipo.includes("río") || tipo.includes("curso") || tipo.includes("estero") || tipo.includes("quebrada"); }
function normalizeLatLng(a, b){
  const n1 = Number(a);
  const n2 = Number(b);
  if(!Number.isFinite(n1) || !Number.isFinite(n2)) return null;
  if(n1 >= -56 && n1 <= -17 && n2 >= -76 && n2 <= -66) return { lat: n1, lng: n2 };
  if(n2 >= -56 && n2 <= -17 && n1 >= -76 && n1 <= -66) return { lat: n2, lng: n1 };
  return null;
}
function layerInBounds(layer, bounds){ if(layer.getLatLng) return bounds.contains(layer.getLatLng()); if(layer.getBounds) return bounds.intersects(layer.getBounds()); return false; }
function countGeoJsonLayer(layer, filterFn){ if(!layer) return 0; const bounds = map.getBounds(); let count = 0; layer.eachLayer(child => { const feature = child.feature; if(filterFn && !filterFn(feature)) return; if(layerInBounds(child, bounds)) count += 1; }); return count; }
function updateSummary(){
  const bounds = map.getBounds();
  let zonas = 0;
  for(let i = 0; i < noxaState.zonasSaturadasFeatures.length; i += 1){
    const item = noxaState.zonasSaturadasFeatures[i];
    if(!bounds.intersects(item.bounds)) continue;
    zonas += 1;
  }

  let prc = 0;
  const prcFeatures = noxaState.centroidesData?.features || [];
  for(let i = 0; i < prcFeatures.length; i += 1){
    const feature = prcFeatures[i];
    const coords = feature?.geometry?.coordinates;
    if(!coords || coords.length < 2) continue;
    const [lng, lat] = coords;
    if(!bounds.contains([lat, lng])) continue;
    prc += 1;
  }

  const relaves = countGeoJsonLayer(noxaState.layers.relaves);
  const rios = countGeoJsonLayer(noxaState.layers.hidricas, isWaterLine);
  const lagos = (noxaState.lagosCentroides || []).filter(item => bounds.contains([item.lat, item.lng])).length;
  const total = zonas + relaves + rios + lagos + prc;
  document.getElementById("sum-zonas").textContent = `#${fmt(zonas)}`;
  document.getElementById("sum-relaves").textContent = `#${fmt(relaves)}`;
  document.getElementById("sum-rios").textContent = fmt(rios);
  document.getElementById("sum-lagos").textContent = `#${fmt(lagos)}`;
  document.getElementById("sum-prc").textContent = `#${fmt(prc)}`;
  document.getElementById("noxa-visible-total").textContent = fmt(total);
}

// Resumen dinámico de centroides PRC visibles en el viewport actual.
function updateIndexSummary(){
  if(!noxaState.centroidesData?.features?.length) return;
  const bounds = map.getBounds();
  const center = map.getCenter();
  const key = `${bounds.getSouth().toFixed(5)}|${bounds.getWest().toFixed(5)}|${bounds.getNorth().toFixed(5)}|${bounds.getEast().toFixed(5)}|${map.getZoom()}`;
  if(key === noxaState.lastSummaryKey) return;
  noxaState.lastSummaryKey = key;

  const features = noxaState.centroidesData.features;
  let count = 0;
  let areaTotal = 0;
  let weightTotal = 0;
  let hasWeight = false;
  let nearestName = "-";
  let nearestDist = Infinity;
  const top3 = [];

  for(let i = 0; i < features.length; i += 1){
    const feature = features[i];
    const coords = feature?.geometry?.coordinates;
    if(!coords || coords.length < 2) continue;
    const lng = coords[0];
    const lat = coords[1];
    if(!bounds.contains([lat, lng])) continue; // Leaflet [lat,lng] vs GeoJSON [lng,lat]

    const props = feature.properties || {};
    const area = Number(props.area_ha ?? props.superficie ?? props.superficie_ha ?? 0) || 0;
    const weight = Number(props.peso ?? props.weight ?? 0) || 0;
    const name = String(props.nombre_prc ?? props.nombre ?? props.NOMBRE ?? "Sin nombre");
    const dist = center.distanceTo([lat, lng]);

    count += 1;
    areaTotal += area;
    if(("peso" in props) || ("weight" in props)){ hasWeight = true; weightTotal += weight; }
    if(dist < nearestDist){ nearestDist = dist; nearestName = `${name} (${fmt(Math.round(dist))} m)`; }

    top3.push({ name, area });
  }

  top3.sort((a, b) => b.area - a.area);
  const avg = count ? areaTotal / count : 0;
  const top3Text = top3.slice(0, 3).map(item => `${item.name} (${fmt2(item.area)} ha)`).join(" · ") || "-";

  document.getElementById("sum-count").textContent = fmt(count);
  document.getElementById("sum-area").textContent = fmt2(areaTotal);
  document.getElementById("sum-avg").textContent = fmt2(avg);
  document.getElementById("sum-nearest").textContent = count ? nearestName : "-";
  document.getElementById("sum-weight").textContent = hasWeight ? fmt2(weightTotal) : "-";
  document.getElementById("sum-top3").textContent = top3Text;
}


function relaveAreaHa(props){
  const direct = Number(props.superficie_ha ?? props.SUPERFICIE_HA ?? props.superficie ?? props.SUPERFICIE ?? props.area_ha ?? props.AREA_HA);
  if(Number.isFinite(direct) && direct > 0) return direct;
  const m2 = Number(props.shape_area_m2 ?? props.SHAPE_AREA_M2 ?? props.area_m2 ?? props.AREA_M2);
  if(Number.isFinite(m2) && m2 > 0) return m2 / 10000;
  return 0;
}

function updateRelavesSummary(){
  if(!noxaState.relavesData?.features?.length) return;
  const bounds = map.getBounds();
  const center = map.getCenter();
  const key = `${bounds.getSouth().toFixed(5)}|${bounds.getWest().toFixed(5)}|${bounds.getNorth().toFixed(5)}|${bounds.getEast().toFixed(5)}|${map.getZoom()}`;
  if(key === noxaState.lastRelavesSummaryKey) return;
  noxaState.lastRelavesSummaryKey = key;

  const features = noxaState.relavesData.features;
  let count = 0;
  let areaTotal = 0;
  let tonTotal = 0;
  let nearestName = "-";
  let nearestDist = Infinity;
  const top3 = [];

  for(let i = 0; i < features.length; i += 1){
    const feature = features[i];
    const coords = feature?.geometry?.coordinates;
    if(!coords || coords.length < 2) continue;
    const [lng, lat] = coords;
    if(!bounds.contains([lat, lng])) continue;

    const props = feature.properties || {};
    const area = relaveAreaHa(props);
    const ton = Number(getProp(feature, ["ton_autorizadas", "TON_AUTORIZADAS", "toneladas", "TONELADAS", "toneladas_autorizadas", "TONELADAS_AUTORIZADAS"])) || 0;
    const name = String(getProp(feature, ["nombre", "NOMBRE", "nom_relave", "NOM_RELAVE", "RELAVE", "faena", "FAENA"]) || "Sin nombre");
    const dist = center.distanceTo([lat, lng]);

    count += 1;
    areaTotal += area;
    tonTotal += ton;
    if(dist < nearestDist){ nearestDist = dist; nearestName = `${name} (${fmt(Math.round(dist))} m)`; }
    top3.push({ name, area });
  }

  top3.sort((a, b) => b.area - a.area);
  const avg = count ? areaTotal / count : 0;
  const top3Text = top3.slice(0, 3).map(item => `${item.name} (${fmt2(item.area)} ha)`).join(" · ") || "-";

  document.getElementById("sum-relaves").textContent = `#${fmt(count)}`;
  document.getElementById("sum-relaves-area").textContent = fmt2(areaTotal);
  document.getElementById("sum-relaves-avg").textContent = fmt2(avg);
  document.getElementById("sum-relaves-ton").textContent = fmt2(tonTotal);
  document.getElementById("sum-relaves-nearest").textContent = count ? nearestName : "-";
  document.getElementById("sum-relaves-top3").textContent = top3Text;
}

async function loadJson(url){ const res = await fetch(url, { cache: "no-store" }); if(!res.ok) throw new Error(`${url} (${res.status})`); return res.json(); }
function popupTable(title, feature, fields){ const rows = fields.map(([label, keys]) => { const value = getProp(feature, keys); return value ? `<tr><td>${label}</td><td><strong>${value}</strong></td></tr>` : ""; }).join(""); return `<strong>${title}</strong><table style="margin-top:6px;border-spacing:0 3px">${rows}</table>`; }
function addZonas(fc){
  noxaState.zonasSaturadasFeatures = (fc?.features || []).map(feature => ({
    feature,
    bounds: L.geoJSON(feature).getBounds()
  })).filter(item => item.bounds && item.bounds.isValid());
  const layer = L.geoJSON(fc, { style: { color: "#ef4444", weight: 2, fillColor: "#ef4444", fillOpacity: 0.22 }, onEachFeature: (feature, lyr) => lyr.bindPopup(popupTable("Zona saturada", feature, [["Nombre", ["nombre", "NOMBRE", "zona", "ZONA"]], ["Contaminante", ["contaminante", "CONTAMINANTE"]], ["Decreto", ["decreto", "DECRETO"]], ["Superficie", ["superficie_ha", "SUPERFICIE_HA", "area_ha", "AREA_HA"]]])) }).addTo(map);
  noxaState.layers.zonas = layer;
  overlays["Zonas saturadas"] = layer;
}
function addRelaves(fc){
  noxaState.relavesData = fc;
  const layer = L.geoJSON(fc, {
    pointToLayer: (feature, latlng) => {
      const area = relaveAreaHa(feature?.properties || {});
      const radius = area > 0 ? Math.min(9, Math.max(5, 5 + Math.log10(area + 1))) : 5;
      return L.circleMarker(latlng, { radius, color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 0.9, weight: 1 });
    },
    onEachFeature: (feature, lyr) => lyr.bindPopup(popupTable("Relave", feature, [["Nombre", ["nombre", "NOMBRE", "nom_relave", "NOM_RELAVE", "RELAVE", "faena", "FAENA"]], ["Región", ["region", "REGION", "nom_region", "NOM_REGION"]], ["Comuna", ["comuna", "COMUNA", "nom_comuna", "NOM_COMUNA"]], ["Superficie ha", ["superficie_ha", "SUPERFICIE_HA", "superficie", "SUPERFICIE", "area_ha", "AREA_HA"]], ["Ton. autorizadas", ["ton_autorizadas", "TON_AUTORIZADAS", "toneladas", "TONELADAS", "toneladas_autorizadas", "TONELADAS_AUTORIZADAS"]], ["Estado", ["estado", "ESTADO"]]]))
  }).addTo(map);
  noxaState.layers.relaves = layer;
  overlays["Relaves"] = layer;
}
function addHidricas(fc){ const layer = L.geoJSON(fc, { style: feature => isWaterPolygon(feature) ? { color: "#22d3ee", weight: 1.5, fillColor: "#22d3ee", fillOpacity: 0.20 } : { color: "#38bdf8", weight: 2.2, opacity: 0.86 }, onEachFeature: (feature, lyr) => lyr.bindPopup(popupTable("Plataforma hídrica", feature, [["Nombre", ["nombre", "NOMBRE", "toponimo", "TOPONIMO"]], ["Tipo", ["tipo", "TIPO", "categoria", "CATEGORIA"]]])) }).addTo(map); noxaState.layers.hidricas = layer; overlays["Plataformas hídricas"] = layer; }
function addLagos(fc){
  const points = [];
  const layer = L.layerGroup();
  (fc.features || []).forEach(feature => {
    const props = feature.properties || {};
    const values = Object.values(props);
    const point = normalizeLatLng(values[values.length - 2], values[values.length - 1]);
    if(!point) return;
    points.push({ feature, lat: point.lat, lng: point.lng });
    L.circleMarker([point.lat, point.lng], {
      radius: 4,
      color: "#38bdf8",
      fillColor: "#38bdf8",
      fillOpacity: 0.85,
      weight: 1
    }).bindPopup(
      popupTable("Lago / laguna", feature, [
        ["Nombre", ["nombre", "NOMBRE", "nom_lago", "NOM_LAGO"]],
        ["Tipo", ["tipo", "TIPO", "categoria", "CATEGORIA"]],
        ["Región", ["region", "REGION", "nom_region", "NOM_REGION"]],
        ["Comuna", ["comuna", "COMUNA", "nom_comuna", "NOM_COMUNA"]],
        ["Superficie", ["superficie_ha", "SUPERFICIE_HA", "area_ha", "AREA_HA"]]
      ])
    ).addTo(layer);
  });
  noxaState.lagosCentroides = points;
  noxaState.layers.lagos = layer.addTo(map);
  overlays["Lagos / lagunas"] = noxaState.layers.lagos;
}
function addPrc(fc){ noxaState.centroidesData = fc; const layer = L.geoJSON(fc, { pointToLayer: (feature, latlng) => L.circleMarker(latlng, { radius: 6, color: "#d946ef", fillColor: "#a855f7", fillOpacity: 0.92, weight: 1.5 }), onEachFeature: (feature, lyr) => lyr.bindPopup(popupTable("Centro urbano PRC", feature, [["Comuna", ["comuna", "COMUNA", "nombre", "NOMBRE", "nombre_prc"]], ["Región", ["region", "REGION", "nom_region", "NOM_REGION"]], ["Superficie ha", ["superficie_ha", "SUPERFICIE_HA", "area_ha", "AREA_HA"]], ["Diám. equiv.", ["diam_eq_m", "DIAM_EQ_M"]]])) }).addTo(map); noxaState.layers.prc = layer; overlays["Centros urbanos PRC"] = layer; }

async function loadAllLayers(){
  const failures = [];
  const jobs = [loadJson(GEO_NOXA_DATA.zonas).then(addZonas).catch(e => failures.push(e.message)), loadJson(GEO_NOXA_DATA.relaves).then(addRelaves).catch(e => failures.push(e.message)), loadJson(GEO_NOXA_DATA.hidricas).then(addHidricas).catch(e => failures.push(e.message)), loadJson(GEO_NOXA_DATA.lagos).then(addLagos).catch(e => failures.push(e.message)), loadJson(GEO_NOXA_DATA.prc).then(addPrc).catch(e => failures.push(e.message))];
  await Promise.allSettled(jobs);
  noxaState.layerControl = L.control.layers(baseLayers, overlays, { collapsed: true }).addTo(map);
  const valid = Object.values(noxaState.layers).filter(Boolean);
  if(valid.length){ try{ const group = L.featureGroup(valid); map.fitBounds(group.getBounds(), { padding: [28, 28] }); }catch(e){ console.warn("No se pudo ajustar a capas cargadas", e); } }
  if(failures.length){ console.warn("GeoNOXA: capas no cargadas", failures); showWarning(`<strong>Capas pendientes:</strong><br>${failures.join("<br>")}`); }
  updateSummary();
  updateIndexSummary();
  updateRelavesSummary();
}

function buildMapQueryUrl(latlng){ const b = map.getBounds(); const bbox = [b.getNorth(), b.getEast(), b.getSouth(), b.getWest()].map(v => v.toFixed(6)).join(","); const params = new URLSearchParams({ lat: latlng.lat.toFixed(7), lon: latlng.lng.toFixed(7), zoom: String(map.getZoom()), bbox }); return `mapago.html?${params.toString()}`; }
map.on("click", function(e) { const url = buildMapQueryUrl(e.latlng); window.location.href = url; });
map.on("moveend zoomend", () => { updateSummary(); updateIndexSummary(); updateRelavesSummary(); });

(function setupLocate(){ const btn = document.getElementById("mira-rifle"); if(!btn) return; btn.addEventListener("click", () => { if(!navigator.geolocation){ showWarning("Geolocalización no disponible en este navegador."); return; } navigator.geolocation.getCurrentPosition(pos => { const latlng = [pos.coords.latitude, pos.coords.longitude]; map.setView(latlng, 13); L.circleMarker(latlng, { radius: 8, color: "#22c55e", fillColor: "#22c55e", fillOpacity: .8 }).addTo(map).bindPopup("Mi ubicación aproximada").openPopup(); }, () => showWarning("No fue posible obtener tu ubicación."), { enableHighAccuracy: true, timeout: 8000 }); }); })();
(function () { const homeBtn = document.getElementById("home-floating-btn"); if (!homeBtn) return; const host = String(window.location.hostname || "").toLowerCase(); const homeByHost = { "geonoxa.cl": "https://geonoxa.cl", "www.geonoxa.cl": "https://geonoxa.cl", "geoipt.cl": "https://geoipt.cl", "www.geoipt.cl": "https://geoipt.cl", "geoeva.cl": "https://geoeva.cl", "www.geoeva.cl": "https://geoeva.cl", "geonemo.cl": "https://geonemo.cl", "www.geonemo.cl": "https://geonemo.cl" }; homeBtn.href = homeByHost[host] || "./"; })();

(function setupWelcomeModal(){
  const modal = document.getElementById("welcomeModal");
  const startBtn = document.getElementById("startBtn");
  const dontShow = document.getElementById("dontShowAgain");
  if(!modal || !startBtn) return;
  const key = "geonoxa_welcome_hidden";
  if(localStorage.getItem(key) !== "1") modal.hidden = false;
  startBtn.addEventListener("click", () => { if(dontShow?.checked) localStorage.setItem(key, "1"); modal.hidden = true; });
})();

loadAllLayers();
