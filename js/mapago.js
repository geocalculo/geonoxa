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

function computeEquivalentRadiusMeters(areaHa) {
  if (!Number.isFinite(areaHa) || areaHa <= 0) return null;
  const areaM2 = areaHa * 10000;
  return Math.sqrt(areaM2 / Math.PI);
}

function getLeafletPolygonCoords(feature) {
  const g = feature?.geometry;
  if (!g) return null;

  if (g.type === 'Polygon') {
    return g.coordinates.map((ring) =>
      ring.map(([lon, lat]) => [lat, lon])
    );
  }

  if (g.type === 'MultiPolygon') {
    return g.coordinates.map((poly) =>
      poly.map((ring) =>
        ring.map(([lon, lat]) => [lat, lon])
      )
    );
  }

  return null;
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
  let prcFeature = null;
  const prcName = prop(uf?.properties, ['nombre_prc']);
  if (prcName !== 'Sin datos disponibles') {
    const prcUrl = `capas/PRC_Chile/${prcName}.geojson`;
    try {
      const prcResponse = await fetch(prcUrl);
      if (prcResponse.ok) {
        const prcGeojson = await prcResponse.json();
        prcFeature = prcGeojson?.features?.[0] || null;
      } else {
        console.warn('PRC polygon not found', prcUrl);
      }
    } catch {
      console.warn('PRC polygon not found', prcUrl);
    }
  }

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
      nombre: prop(zf?.properties, ['nombre_zon']), contaminante: prop(zf?.properties, ['saturado']), estado: prop(zf?.properties, ['zona_dec']),
      fuente: prop(zf?.properties, ['decreto']), link: prop(zf?.properties, ['link']), latentes: prop(zf?.properties, ['latentes']),
      featureId: prop(zf?.properties, ['objectid']),
      poiInOut: zonaMatch?.inOut || 'Sin datos disponibles', distPerimetroKm: Number.isFinite(zonaDist) ? zonaDist : null,
      distCentroideKm: (zCent ? haversineKm(poi.lat, poi.lon, zCent[0], zCent[1]) : null), superficieHa: zArea,
      perimetroKm: Number.isFinite(zonaDist) ? zonaDist * 6 : null, centroide: zCent, feature: zf || null, polygon: getLeafletPolygonCoords(zf)
    },
    relave: {
      nombre: prop(rf?.properties, ['id_relave', 'faena']), empresaFaena: prop(rf?.properties, ['empresa']), tipoDeposito: prop(rf?.properties, ['tipo_deposito']), recurso: prop(rf?.properties, ['recurso']), metodo: prop(rf?.properties, ['metodo_constructivo']),
      superficieHa: prop(rf?.properties, ['superficie']), featureId: prop(rf?.id ? { id: rf.id } : rf?.properties, ['id', 'fid', 'objectid']), distPoiKm: Number.isFinite(relDist) ? relDist : null, centroide: rCent
    },
    zonaUrbana: {
      nombre: prop(uf?.properties, ['nombre_prc']), comuna: prop(uf?.properties, ['nombre_prc']), region: 'Chile', instrumento: 'PRC',
      superficieHa: prop(uf?.properties, ['area_ha']), featureId: prop(uf?.id ? { id: uf.id } : uf?.properties, ['id', 'fid', 'objectid']), distPoiKm: Number.isFinite(urbDist) ? urbDist : null,
      distCentroideKm: (uCent ? haversineKm(poi.lat, poi.lon, uCent[0], uCent[1]) : null), centroide: uCent, prcFeature
    },
    relaciones: { triangular: { indice: synergy, sinergia: synergy > 70 ? 'Alta' : synergy > 40 ? 'Media' : 'Baja' } },
    riesgo: { nivel: riesgo }
  };
}

function renderAll() {
  renderHeader();
  renderGeneralPanel();
  renderZonaSaturadaPanel();
  renderRelavePanel();
  renderZonaUrbanaPanel();
  renderRelationsPanel();
  renderActions();
  initMap();
}

function renderHeader() {
  document.getElementById('header-card').innerHTML = `<div class="header-grid">
    <div class="brand">
      <h1>GeoNOXA / GeoNEXO</h1>
      <small>Motor de Análisis de Pasivos Ambientales y Riesgos Territoriales</small>
      <p>CARD PRO – Análisis territorial del POI</p>
    </div>
    <div class="kpi-card text-13"><h3 class="sub-title">Estado general de riesgo</h3><span class="badge ${getRiskClass(analysisData.riesgo.nivel)}">${analysisData.riesgo.nivel}</span></div>
    <div class="kpi-card text-13"><h3 class="sub-title">Índice de sinergia</h3><p><strong>${analysisData.relaciones.triangular.indice}/100</strong></p></div>
    <div class="kpi-card text-13"><h3 class="sub-title">Coordenadas POI</h3><p>${analysisData.poi.lat}, ${analysisData.poi.lon}</p></div>
  </div>`;
}

function table(data) {
  return `<table class="data-table">${Object.entries(data).map(([k, v]) => `<tr><td>${k}</td><td>${v ?? 'Sin datos disponibles'}</td></tr>`).join('')}</table>`;
}

function renderGeneralPanel() {
  document.getElementById('general-layout').innerHTML = `<div class="subblock text-13"><h3 class="sub-title">Datos generales del análisis</h3>
    ${table({
      'POI lat/lon': `${analysisData.poi.lat}, ${analysisData.poi.lon}`,
      'Zona saturada seleccionada': analysisData.zonaSaturada.nombre,
      'Relave más cercano': analysisData.relave.nombre,
      'Zona urbana más cercana': analysisData.zonaUrbana.nombre,
      'Distancia POI-zona saturada': formatKm(analysisData.zonaSaturada.distPerimetroKm),
      'Distancia POI-relave': formatKm(analysisData.relave.distPoiKm),
      'Distancia POI-zona urbana': formatKm(analysisData.zonaUrbana.distPoiKm),
      'Riesgo general': analysisData.riesgo.nivel
    })}
  </div>
  <div class="subblock text-13"><h3 class="sub-title">Mapa de relaciones espaciales</h3><div id="map"></div><div id="map-legend" class="map-legend">POI · relave · círculo equivalente · zona saturada · PRC cercano · líneas de relación</div></div>`;
}

function renderZonaSaturadaPanel() {
  const zDia = computeEquivalentDiameter(analysisData.zonaSaturada.superficieHa);
  document.getElementById('zona-saturada-layout').innerHTML = `
    <article class="subblock zona text-13"><h3 class="sub-title">A) Ficha GeoJSON</h3>${table({
      nombre_zon: analysisData.zonaSaturada.nombre,
      zona_dec: analysisData.zonaSaturada.estado,
      saturado: analysisData.zonaSaturada.contaminante,
      latentes: analysisData.zonaSaturada.latentes,
      decreto: analysisData.zonaSaturada.fuente,
      link: analysisData.zonaSaturada.link,
      objectid: analysisData.zonaSaturada.featureId
    })}</article>
    <article class="subblock zona text-13"><h3 class="sub-title">B) Geometría propia</h3>${table({
      'IN/OUT': analysisData.zonaSaturada.poiInOut,
      'Distancia al perímetro': formatKm(analysisData.zonaSaturada.distPerimetroKm),
      'Distancia al centroide': formatKm(analysisData.zonaSaturada.distCentroideKm),
      'Superficie': formatHa(analysisData.zonaSaturada.superficieHa),
      'Perímetro': formatKm(analysisData.zonaSaturada.perimetroKm),
      'Diámetro equivalente': formatKm(zDia),
      'Centroide': analysisData.zonaSaturada.centroide?.join(', ') || 'Sin datos disponibles'
    })}</article>
    <article class="subblock zona text-13"><h3 class="sub-title">C) Relación con POI</h3>${table({
      'Estado POI IN/OUT': analysisData.zonaSaturada.poiInOut,
      'Nivel de exposición': analysisData.zonaSaturada.poiInOut === 'IN' ? 'Alta' : (analysisData.zonaSaturada.distPerimetroKm < 5 ? 'Media' : 'Baja'),
      'Interpretación breve': `POI ${analysisData.zonaSaturada.poiInOut === 'IN' ? 'dentro de' : 'fuera de'} zona saturada con riesgo ${analysisData.riesgo.nivel.toLowerCase()}.`
    })}</article>`;
}

function renderRelavePanel() {
  const rDia = computeEquivalentDiameter(Number(analysisData.relave.superficieHa));
  document.getElementById('relave-layout').innerHTML = `
    <article class="subblock relave text-13"><h3 class="sub-title">A) Ficha GeoJSON</h3>${table({
      id_relave: analysisData.relave.nombre,
      empresa: analysisData.relave.empresaFaena,
      faena: analysisData.relave.nombre,
      tipo_deposito: analysisData.relave.tipoDeposito,
      recurso: analysisData.relave.recurso,
      metodo_constructivo: analysisData.relave.metodo,
      superficie: formatHa(analysisData.relave.superficieHa)
    })}</article>
    <article class="subblock relave text-13"><h3 class="sub-title">B) Geometría propia</h3>${table({
      'Distancia POI-relave': formatKm(analysisData.relave.distPoiKm),
      'Superficie': formatHa(analysisData.relave.superficieHa),
      'Radio equivalente': formatKm((rDia || 0) / 2),
      'Diámetro equivalente': formatKm(rDia),
      'Centroide': analysisData.relave.centroide?.join(', ') || 'Sin datos disponibles'
    })}</article>
    <article class="subblock relave text-13"><h3 class="sub-title">C) Relación territorial</h3>${table({
      'Distancia relave a centro urbano': formatKm(analysisData.zonaUrbana.centroide && analysisData.relave.centroide ? haversineKm(analysisData.relave.centroide[0], analysisData.relave.centroide[1], analysisData.zonaUrbana.centroide[0], analysisData.zonaUrbana.centroide[1]) : null),
      'Prioridad territorial': analysisData.relave.distPoiKm < 5 ? 'Alta' : (analysisData.relave.distPoiKm < 12 ? 'Media' : 'Baja'),
      'Interpretación breve': 'Relave próximo incorporado en evaluación de exposición territorial.'
    })}</article>`;
}

function renderZonaUrbanaPanel() {
  document.getElementById('zona-urbana-layout').innerHTML = `
    <article class="subblock urbana text-13"><h3 class="sub-title">A) Ficha GeoJSON</h3>${table({
      nombre_prc: analysisData.zonaUrbana.nombre,
      comuna: analysisData.zonaUrbana.comuna,
      region: analysisData.zonaUrbana.region,
      instrumento: analysisData.zonaUrbana.instrumento,
      'superficie PRC': formatHa(analysisData.zonaUrbana.superficieHa)
    })}</article>
    <article class="subblock urbana text-13"><h3 class="sub-title">B) Geometría propia</h3>${table({
      'Distancia POI-centro urbano': formatKm(analysisData.zonaUrbana.distPoiKm),
      'Centroide urbano': analysisData.zonaUrbana.centroide?.join(', ') || 'Sin datos disponibles',
      'Superficie PRC': formatHa(analysisData.zonaUrbana.superficieHa),
      'Polígono PRC': analysisData.zonaUrbana.prcFeature ? 'Disponible' : 'No disponible'
    })}</article>
    <article class="subblock urbana text-13"><h3 class="sub-title">C) Relación con zona saturada</h3>${table({
      'Distancia centro urbano a zona saturada': formatKm(analysisData.zonaSaturada.distPerimetroKm),
      'Distancia centro urbano a centroide zona saturada': formatKm(analysisData.zonaUrbana.centroide && analysisData.zonaSaturada.centroide ? haversineKm(analysisData.zonaUrbana.centroide[0], analysisData.zonaUrbana.centroide[1], analysisData.zonaSaturada.centroide[0], analysisData.zonaSaturada.centroide[1]) : null),
      'Exposición indirecta': analysisData.riesgo.nivel === 'Alto' ? 'Alta' : 'Moderada'
    })}</article>`;
}

function renderRelationsPanel() {
  const cards = [
    ['POI ↔ Zona Saturada', formatKm(analysisData.zonaSaturada.distPerimetroKm)],
    ['POI ↔ Relave', formatKm(analysisData.relave.distPoiKm)],
    ['POI ↔ Zona Urbana', formatKm(analysisData.zonaUrbana.distPoiKm)],
    ['Relave ↔ Zona Urbana', formatKm(analysisData.relave.centroide && analysisData.zonaUrbana.centroide ? haversineKm(analysisData.relave.centroide[0], analysisData.relave.centroide[1], analysisData.zonaUrbana.centroide[0], analysisData.zonaUrbana.centroide[1]) : null)],
    ['Zona Urbana ↔ Zona Saturada', formatKm(analysisData.zonaUrbana.centroide && analysisData.zonaSaturada.centroide ? haversineKm(analysisData.zonaUrbana.centroide[0], analysisData.zonaUrbana.centroide[1], analysisData.zonaSaturada.centroide[0], analysisData.zonaSaturada.centroide[1]) : null)],
    ['Relación triangular / sinergia territorial', `${analysisData.relaciones.triangular.indice}/100 (${analysisData.relaciones.triangular.sinergia})`]
  ];
  document.getElementById('relations-layout').innerHTML = `
    <div class="relations-grid">
      ${cards.map(([t, v]) => `<article class="relation-card text-13"><h3 class="sub-title">${t}</h3><p>${v}</p></article>`).join('')}
    </div>
    <div class="subblock text-13">${table({
      'Índice de sinergia': `${analysisData.relaciones.triangular.indice}/100`,
      'Alineación geométrica': analysisData.relaciones.triangular.sinergia,
      'Potencial de impacto': analysisData.riesgo.nivel,
      'Síntesis automática GeoNOXA': `POI con riesgo ${analysisData.riesgo.nivel.toLowerCase()}, influenciado por ${analysisData.zonaSaturada.nombre}, ${analysisData.relave.nombre} y ${analysisData.zonaUrbana.nombre}.`
    })}</div>`;
}

function buildEcosystemUrl(baseUrl) { const { lat, lon, zoom, bbox } = analysisData.poi; const bboxText = Array.isArray(bbox) ? bbox.join(',') : ''; return `${baseUrl}?lat=${lat}&lon=${lon}&zoom=${zoom}&bbox=${encodeURIComponent(bboxText)}`; }

function initMap() {
  if (!analysisData || !document.getElementById('map')) return;
  if (map) map.remove();

  const poiLatLng = [analysisData.poi.lat, analysisData.poi.lon];
  map = L.map('map', { zoomControl: true }).setView(poiLatLng, analysisData.poi.zoom || 10);

  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  const mapSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
  });
  L.control.layers({ OSM: osm, MapSAT: mapSat }).addTo(map);
  L.control.scale({ metric: true, imperial: false }).addTo(map);

  const group = L.featureGroup().addTo(map);

  const poi = L.circleMarker(poiLatLng, { radius: 7, color: '#1d4ed8', weight: 2, fillColor: '#2563eb', fillOpacity: 0.85 })
    .bindPopup('POI')
    .addTo(group);

  let relaveCentroid = null;
  if (Array.isArray(analysisData.relave.centroide)) {
    relaveCentroid = analysisData.relave.centroide;
    L.circleMarker(relaveCentroid, { radius: 7, color: '#b45309', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.85 })
      .bindPopup(`Relave: ${analysisData.relave.nombre}`)
      .addTo(group);
  }

  const relaveRadiusMeters = computeEquivalentRadiusMeters(Number(analysisData.relave.superficieHa));
  if (relaveCentroid && Number.isFinite(relaveRadiusMeters) && relaveRadiusMeters > 0) {
    L.circle(relaveCentroid, { radius: relaveRadiusMeters, color: '#f59e0b', weight: 2, fillOpacity: 0.06 })
      .bindPopup('Círculo equivalente del relave')
      .addTo(group);
  }

  let urbanaCentroid = null;
  if (Array.isArray(analysisData.zonaUrbana.centroide)) {
    urbanaCentroid = analysisData.zonaUrbana.centroide;
    L.circleMarker(urbanaCentroid, { radius: 7, color: '#0f766e', weight: 2, fillColor: '#14b8a6', fillOpacity: 0.85 })
      .bindPopup(`Centroide urbano: ${analysisData.zonaUrbana.nombre}`)
      .addTo(group);
  }

  if (analysisData.zonaSaturada.polygon) {
    L.polygon(analysisData.zonaSaturada.polygon, { color: '#dc2626', weight: 2, fillColor: '#ef4444', fillOpacity: 0.14 })
      .bindPopup(`Zona saturada: ${analysisData.zonaSaturada.nombre}`)
      .addTo(group);
  }

  if (analysisData.zonaUrbana.prcFeature) {
    const prcCoords = getLeafletPolygonCoords(analysisData.zonaUrbana.prcFeature);
    if (prcCoords) {
      L.polygon(prcCoords, { color: '#7c3aed', weight: 2, fillColor: '#8b5cf6', fillOpacity: 0.08, dashArray: '4 4' })
        .bindPopup('Polígono PRC')
        .addTo(group);
    }
  }

  const lineStyle = { color: '#334155', weight: 1.8, opacity: 0.9, dashArray: '6 5' };
  const zCent = analysisData.zonaSaturada.centroide;
  if (relaveCentroid) L.polyline([poiLatLng, relaveCentroid], lineStyle).addTo(group);
  if (urbanaCentroid) L.polyline([poiLatLng, urbanaCentroid], lineStyle).addTo(group);
  if (Array.isArray(zCent)) L.polyline([poiLatLng, zCent], lineStyle).addTo(group);
  if (relaveCentroid && urbanaCentroid) L.polyline([relaveCentroid, urbanaCentroid], lineStyle).addTo(group);
  if (urbanaCentroid && Array.isArray(zCent)) L.polyline([urbanaCentroid, zCent], lineStyle).addTo(group);

  const bounds = group.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.12));
  poi.openPopup();
}
function renderActions() {
  document.getElementById('actions').innerHTML = `
    <button type="button">Descargar KML</button>
    <button type="button">Descargar PDF</button>
    <button type="button">Ver reporte completo</button>
    <a href="${buildEcosystemUrl('https://example.com/geoipt')}" target="_blank" rel="noopener">Ir a GeoIPT</a>
    <a href="${buildEcosystemUrl('https://example.com/geoeva')}" target="_blank" rel="noopener">Ir a GeoEVA</a>
    <a href="${buildEcosystemUrl('https://example.com/geonemo')}" target="_blank" rel="noopener">Ir a GeoNEMO</a>`;
}
(async function init(){const poi=getPoiFromUrl();analysisData=await buildAnalysisData(poi);renderAll();})();
