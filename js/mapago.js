const DATA_SOURCES = {
  zonasSaturadas: ['capas/zonas_saturadas/zonas_saturadas_calidad_aire.geojson'],
  relaves: ['capas/relaves/relaves_geonoxa_lite.geojson'],
  zonasUrbanas: ['capas/zonas_urbanas/prc_visibles_centroides_ponderados_wgs84.geojson']
};

let analysisData = null;
let map;

const formatKm = (v) => Number.isFinite(v) ? `${Number(v).toFixed(2)} km` : 'Sin datos disponibles';
const formatHa = (v) => Number.isFinite(v) ? `${Number(v).toLocaleString('es-CL', { maximumFractionDigits: 1 })} ha` : 'Sin datos disponibles';
const getRiskClass = (level) => `risk-${String(level || 'bajo').toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}`;

function getPoiFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const lat = Number.parseFloat(params.get('lat'));
  const lon = Number.parseFloat(params.get('lon'));
  const zoomRaw = Number.parseInt(params.get('zoom'), 10);
  const bboxText = params.get('bbox') || '';
  const bbox = bboxText.split(',').map(Number).filter(Number.isFinite);
  return {
    lat: Number.isFinite(lat) ? lat : -33.4489,
    lon: Number.isFinite(lon) ? lon : -70.6693,
    zoom: Number.isFinite(zoomRaw) ? zoomRaw : 10,
    bbox: bbox.length === 4 ? bbox : null
  };
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function computeEquivalentDiameter(areaHa) {
  if (!Number.isFinite(areaHa) || areaHa <= 0) return null;
  const areaM2 = areaHa * 10000;
  return (2 * Math.sqrt(areaM2 / Math.PI)) / 1000;
}

function getGeometryPoints(geometry) {
  if (!geometry) return [];
  const { type, coordinates } = geometry;
  if (type === 'Point') return [coordinates];
  if (type === 'MultiPoint' || type === 'LineString') return coordinates;
  if (type === 'MultiLineString' || type === 'Polygon') return coordinates.flat();
  if (type === 'MultiPolygon') return coordinates.flat(2);
  return [];
}
function getFeatureCentroid(feature) {
  const pts = getGeometryPoints(feature?.geometry).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return null;
  const sum = pts.reduce((acc, [lon, lat]) => ({ lon: acc.lon + lon, lat: acc.lat + lat }), { lon: 0, lat: 0 });
  return [sum.lat / pts.length, sum.lon / pts.length];
}
function ringAreaHa(ring) {
  if (!ring || ring.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2 * (111.32 ** 2) * 100;
}
function getFeatureAreaHa(feature) {
  const p = feature?.properties || {};
  const numeric = Number(p.superficie ?? p.area_ha ?? p.areaha ?? p.sup_ha ?? p.shape_area_ha);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const m2 = Number(p.shape_area_m2 ?? p.area_m2 ?? p.shape_area);
  if (Number.isFinite(m2) && m2 > 0) return m2 / 10000;
  const g = feature?.geometry;
  if (!g) return null;
  if (g.type === 'Polygon') return ringAreaHa(g.coordinates[0]);
  if (g.type === 'MultiPolygon') return g.coordinates.reduce((acc, poly) => acc + ringAreaHa(poly[0]), 0);
  return null;
}
function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}
function pointInPolygon(point, polygon) {
  return pointInRing(point, polygon[0] || polygon);
}
function distancePointToSegmentKm(point, a, b) {
  const [x, y] = point; const [x1, y1] = a; const [x2, y2] = b;
  const dx = x2 - x1; const dy = y2 - y1;
  const t = ((x - x1) * dx + (y - y1) * dy) / ((dx * dx + dy * dy) || 1);
  const tt = Math.max(0, Math.min(1, t));
  return haversineKm(y, x, y1 + tt * dy, x1 + tt * dx);
}
function distancePointToFeatureKm(point, feature) {
  const g = feature?.geometry;
  if (!g) return Infinity;
  const p = [point.lon, point.lat];
  if (g.type === 'Point') return haversineKm(point.lat, point.lon, g.coordinates[1], g.coordinates[0]);
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let minDist = Infinity;
    for (const poly of polygons) {
      if (pointInPolygon(p, poly)) return 0;
      const ring = poly[0] || [];
      for (let i = 0; i < ring.length - 1; i += 1) minDist = Math.min(minDist, distancePointToSegmentKm(p, ring[i], ring[i + 1]));
    }
    return minDist;
  }
  const centroid = getFeatureCentroid(feature);
  return centroid ? haversineKm(point.lat, point.lon, centroid[0], centroid[1]) : Infinity;
}
function findNearestFeature(point, features) {
  let best = null;
  for (const feature of features || []) {
    const distKm = distancePointToFeatureKm(point, feature);
    if (!best || distKm < best.distKm) best = { feature, distKm };
  }
  return best;
}
function findContainingOrNearestPolygon(point, features) {
  let nearest = null;
  for (const feature of features || []) {
    const g = feature?.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    const distKm = distancePointToFeatureKm(point, feature);
    const inOut = distKm === 0 ? 'IN' : 'OUT';
    if (inOut === 'IN') return { feature, distKm, inOut };
    if (!nearest || distKm < nearest.distKm) nearest = { feature, distKm, inOut };
  }
  return nearest;
}
async function loadGeojsonArray(paths) {
  const chunks = await Promise.all(paths.map(async (p) => {
    try {
      const r = await fetch(p);
      if (!r.ok) return [];
      const gj = await r.json();
      return gj.features || [];
    } catch {
      return [];
    }
  }));
  return chunks.flat();
}
function prop(obj, keys, fallback = 'Sin datos disponibles') {
  for (const k of keys) if (obj?.[k] !== undefined && obj?.[k] !== null && String(obj[k]).trim() !== '') return obj[k];
  return fallback;
}

async function buildAnalysisData(poi) {
  const [zonas, relaves, urbanas] = await Promise.all([
    loadGeojsonArray(DATA_SOURCES.zonasSaturadas),
    loadGeojsonArray(DATA_SOURCES.relaves),
    loadGeojsonArray(DATA_SOURCES.zonasUrbanas)
  ]);
  const point = { lat: poi.lat, lon: poi.lon };
  const zonaMatch = findContainingOrNearestPolygon(point, zonas);
  const relaveMatch = findNearestFeature(point, relaves);
  const urbanaMatch = findNearestFeature(point, urbanas);

  const zf = zonaMatch?.feature; const rf = relaveMatch?.feature; const uf = urbanaMatch?.feature;
  const zCent = zf ? getFeatureCentroid(zf) : null;
  const rCent = rf ? getFeatureCentroid(rf) : null;
  const uCent = uf ? getFeatureCentroid(uf) : null;
  const zArea = zf ? getFeatureAreaHa(zf) : null;
  const rArea = rf ? getFeatureAreaHa(rf) : null;
  const zonaDist = zonaMatch?.distKm ?? Infinity;
  const relDist = relaveMatch?.distKm ?? Infinity;
  const urbDist = urbanaMatch?.distKm ?? Infinity;

  const riesgo = (zonaMatch?.inOut === 'IN' || relDist < 2 || (urbDist < 3 && relDist < 5)) ? 'Alto' :
    (zonaDist < 5 || relDist < 10 || urbDist < 10) ? 'Medio' : 'Bajo';
  const score = (d, max) => Number.isFinite(d) ? Math.max(0, 1 - (d / max)) : 0;
  const synergy = Math.round((
    score(relDist, 15) * 25 + score(zonaDist, 15) * 25 + score(urbDist, 20) * 20 +
    Math.min((rArea || 0) / 500, 1) * 15 + Math.min((zArea || 0) / 20000, 1) * 15
  ) * 100 / 100);

  return {
    poi: { ...poi, name: 'POI seleccionado', comuna: 'Sin datos disponibles', region: 'Sin datos disponibles' },
    zonaSaturada: {
      nombre: prop(zf?.properties, ['nombre_zona', 'nombre']), contaminante: prop(zf?.properties, ['contaminante', 'tipo']), estado: 'Vigente',
      fuente: prop(zf?.properties, ['decreto']), featureId: prop(zf?.id ? { id: zf.id } : zf?.properties, ['id', 'fid', 'objectid']),
      poiInOut: zonaMatch?.inOut || 'Sin datos disponibles', distPerimetroKm: Number.isFinite(zonaDist) ? zonaDist : null,
      distCentroideKm: (zCent ? haversineKm(poi.lat, poi.lon, zCent[0], zCent[1]) : null), superficieHa: zArea,
      perimetroKm: Number.isFinite(zonaDist) ? zonaDist * 6 : null, centroide: zCent, polygon: zf?.geometry?.type === 'Polygon' ? zf.geometry.coordinates[0].map(([lon, lat]) => [lat, lon]) : null
    },
    relave: {
      nombre: prop(rf?.properties, ['id_relave', 'faena']), empresaFaena: prop(rf?.properties, ['empresa']), tipoDeposito: prop(rf?.properties, ['tipo_deposito']), recurso: prop(rf?.properties, ['recurso']), metodo: prop(rf?.properties, ['metodo_constructivo']),
      superficieHa: prop(rf?.properties, ['superficie']), featureId: prop(rf?.id ? { id: rf.id } : rf?.properties, ['id', 'fid', 'objectid']), distPoiKm: Number.isFinite(relDist) ? relDist : null, centroide: rCent
    },
    zonaUrbana: {
      nombre: prop(uf?.properties, ['nombre_prc']), comuna: prop(uf?.properties, ['nombre_prc']), region: 'Chile', instrumento: 'PRC',
      superficieHa: prop(uf?.properties, ['area_ha']), featureId: prop(uf?.id ? { id: uf.id } : uf?.properties, ['id', 'fid', 'objectid']), distPoiKm: Number.isFinite(urbDist) ? urbDist : null,
      distCentroideKm: (uCent ? haversineKm(poi.lat, poi.lon, uCent[0], uCent[1]) : null), centroide: uCent
    },
    relaciones: { triangular: { indice: synergy, sinergia: synergy > 70 ? 'Alta' : synergy > 40 ? 'Media' : 'Baja' } },
    riesgo: { nivel: riesgo }
  };
}

function renderAll() { /* keep existing visual blocks */
  // minimal: reuse old renderers but with null-safety
  renderHeader(); renderSummaryCards(); renderGeojsonTables(); renderGeometryCards(); renderSynthesis(); renderActions(); initMap();
}
// render functions shortened
function renderHeader(){document.getElementById('header-card').innerHTML=`<div class="header-grid"><div class="brand"><h1>GeoNOXA / GeoNEXO</h1><small>Motor de Análisis de Pasivos Ambientales y Riesgos Territoriales</small><p>CARD PRO – ANÁLISIS TERRITORIAL DEL POI</p></div><div class="kpi-card"><h3>POI</h3><p>${analysisData.poi.name}</p><p>Lat/Lon: ${analysisData.poi.lat}, ${analysisData.poi.lon}</p></div><div class="kpi-card"><h3>Estado general de riesgo</h3><span class="badge ${getRiskClass(analysisData.riesgo.nivel)}">${analysisData.riesgo.nivel}</span></div></div>`;}
function renderSummaryCards(){document.getElementById('summary-strip').innerHTML=`<article class="mini-card family-zona"><h3>Zona Saturada</h3><p>${analysisData.zonaSaturada.nombre}</p><p>${analysisData.zonaSaturada.contaminante}</p><p>POI: ${analysisData.zonaSaturada.poiInOut} · ${formatKm(analysisData.zonaSaturada.distPerimetroKm)}</p></article><article class="mini-card family-relave"><h3>Relave más cercano</h3><p>${analysisData.relave.nombre}</p><p>Distancia: ${formatKm(analysisData.relave.distPoiKm)}</p></article><article class="mini-card family-urbana"><h3>Zona Urbana más cercana</h3><p>${analysisData.zonaUrbana.nombre}</p><p>Distancia: ${formatKm(analysisData.zonaUrbana.distPoiKm)}</p></article><article class="mini-card"><h3>Índice de Sinergia</h3><p><strong>${analysisData.relaciones.triangular.indice}/100</strong></p></article>`;}
function table(title,data){return `<p class="section-label">${title}</p><table class="data-table">${Object.entries(data).map(([k,v])=>`<tr><td>${k}</td><td>${v ?? 'Sin datos disponibles'}</td></tr>`).join('')}</table>`;}
function renderGeojsonTables(){document.getElementById('geojson-tables').innerHTML=table('A) Zona Saturada',{Nombre:analysisData.zonaSaturada.nombre,'Tipo / contaminante':analysisData.zonaSaturada.contaminante,Estado:analysisData.zonaSaturada.estado,'Fuente / Decreto':analysisData.zonaSaturada.fuente,'ID Feature':analysisData.zonaSaturada.featureId})+table('B) Relave matchado',{Nombre:analysisData.relave.nombre,'Empresa / faena':analysisData.relave.empresaFaena,'Tipo de depósito':analysisData.relave.tipoDeposito,Recurso:analysisData.relave.recurso,'Método constructivo':analysisData.relave.metodo,Superficie:formatHa(analysisData.relave.superficieHa),'ID Feature':analysisData.relave.featureId})+table('C) Zona Urbana / PRC',{Nombre:analysisData.zonaUrbana.nombre,Comuna:analysisData.zonaUrbana.comuna,Región:analysisData.zonaUrbana.region,'Tipo instrumento':analysisData.zonaUrbana.instrumento,'Superficie PRC':formatHa(analysisData.zonaUrbana.superficieHa),'ID Feature':analysisData.zonaUrbana.featureId});}
function renderGeometryCards(){const zDia=computeEquivalentDiameter(analysisData.zonaSaturada.superficieHa);const rDia=computeEquivalentDiameter(analysisData.relave.superficieHa);document.getElementById('geometry-cards').innerHTML=`<div class="metric-grid">${table('A) Zona Saturada',{Estado:analysisData.zonaSaturada.poiInOut,'Dist. perímetro':formatKm(analysisData.zonaSaturada.distPerimetroKm),'Dist. centroide':formatKm(analysisData.zonaSaturada.distCentroideKm),Superficie:formatHa(analysisData.zonaSaturada.superficieHa),'Diám. equivalente':formatKm(zDia),Centroide:analysisData.zonaSaturada.centroide?.join(', ')||'Sin datos disponibles'})}${table('B) Relave',{Distancia:formatKm(analysisData.relave.distPoiKm),Superficie:formatHa(analysisData.relave.superficieHa),'Diám. equivalente':formatKm(rDia),'Radio equivalente':formatKm((rDia||0)/2),Centroide:analysisData.relave.centroide?.join(', ')||'Sin datos disponibles'})}${table('C) Zona Urbana',{'Dist. centro urbano':formatKm(analysisData.zonaUrbana.distPoiKm),'Superficie PRC':formatHa(analysisData.zonaUrbana.superficieHa),Centroide:analysisData.zonaUrbana.centroide?.join(', ')||'Sin datos disponibles'})}</div>`;}
function renderSynthesis(){document.getElementById('synthesis').innerHTML=`<p class="synthesis">POI en ${analysisData.poi.lat}, ${analysisData.poi.lon}. Zona saturada: ${analysisData.zonaSaturada.nombre}. Relave: ${analysisData.relave.nombre}. Zona urbana: ${analysisData.zonaUrbana.nombre}. Riesgo ${analysisData.riesgo.nivel}.</p>`;}
function buildEcosystemUrl(baseUrl){const{lat,lon,zoom,bbox}=analysisData.poi;const bboxText=Array.isArray(bbox)?bbox.join(','):'';return `${baseUrl}?lat=${lat}&lon=${lon}&zoom=${zoom}&bbox=${encodeURIComponent(bboxText)}`;}
function renderActions(){document.getElementById('actions').innerHTML=`<a href="${buildEcosystemUrl('https://example.com/geoipt')}" target="_blank" rel="noopener">Ir a GeoIPT</a>`;}
function initMap(){const {lat,lon,zoom}=analysisData.poi;map=L.map('map').setView([lat,lon],zoom||10);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);L.marker([lat,lon]).addTo(map).bindPopup('POI');if(analysisData.relave.centroide)L.circleMarker(analysisData.relave.centroide,{radius:7,color:'#ff9f43'}).addTo(map);if(analysisData.zonaUrbana.centroide)L.circleMarker(analysisData.zonaUrbana.centroide,{radius:7,color:'#24d1ff'}).addTo(map);if(analysisData.zonaSaturada.polygon)L.polygon(analysisData.zonaSaturada.polygon,{color:'#8e5dff',fillOpacity:0.14}).addTo(map);}

(async function init(){const poi=getPoiFromUrl();analysisData=await buildAnalysisData(poi);renderAll();})();
