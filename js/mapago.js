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
  const nRelavesRaw = Number(params.get('n_relaves')) || 5;
  const nRelaves = Math.max(1, Math.min(10, Math.round(nRelavesRaw)));

  return {
    lat: Number.isFinite(lat) ? lat : -33.4489,
    lon: Number.isFinite(lon) ? lon : -70.6693,
    zoom: Number.isFinite(zoomRaw) ? zoomRaw : 10,
    bbox: bbox.length === 4 ? bbox : null,
    nRelaves
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
function getRelaveAreaHa(feature) {
  const m2 = Number(feature?.properties?.shape_area_m2);
  if (Number.isFinite(m2) && m2 > 0) return m2 / 10000;
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

function findNearestFeatures(point, features, count) {
  return (features || [])
    .map((feature) => ({ feature, distKm: distancePointToFeatureKm(point, feature) }))
    .filter((item) => Number.isFinite(item.distKm))
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, count);
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
function featureIntersectsBbox(feature, bbox) {
  if (!feature?.geometry || !Array.isArray(bbox) || bbox.length !== 4) return true;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const points = getGeometryPoints(feature.geometry);
  if (!points.length) return false;
  let fMinLon = Infinity; let fMinLat = Infinity; let fMaxLon = -Infinity; let fMaxLat = -Infinity;
  points.forEach(([lon, lat]) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    fMinLon = Math.min(fMinLon, lon); fMinLat = Math.min(fMinLat, lat);
    fMaxLon = Math.max(fMaxLon, lon); fMaxLat = Math.max(fMaxLat, lat);
  });
  if (![fMinLon, fMinLat, fMaxLon, fMaxLat].every(Number.isFinite)) return false;
  return !(fMaxLon < minLon || fMinLon > maxLon || fMaxLat < minLat || fMinLat > maxLat);
}
function findNearestVisibleZonaBorder(point, zonas, bbox) {
  const p = [point.lon, point.lat];
  let best = null;
  for (const feature of zonas || []) {
    const g = feature?.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    if (!featureIntersectsBbox(feature, bbox)) continue;
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let bestPoint = null;
    let bestDistKm = Infinity;
    polygons.forEach((poly) => {
      const ring = poly[0] || [];
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [x1, y1] = ring[i]; const [x2, y2] = ring[i + 1];
        const dx = x2 - x1; const dy = y2 - y1;
        const t = ((p[0] - x1) * dx + (p[1] - y1) * dy) / ((dx * dx + dy * dy) || 1);
        const tt = Math.max(0, Math.min(1, t));
        const nearestLon = x1 + tt * dx; const nearestLat = y1 + tt * dy;
        const distKm = haversineKm(point.lat, point.lon, nearestLat, nearestLon);
        if (distKm < bestDistKm) { bestDistKm = distKm; bestPoint = [nearestLat, nearestLon]; }
      }
    });
    if (bestPoint && (!best || bestDistKm < best.distKm)) best = { feature, distKm: bestDistKm, nearestBorderPoint: bestPoint };
  }
  return best;
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

async function loadPrcFeatureByName(nombrePrc) {
  if (!nombrePrc || nombrePrc === 'Sin datos disponibles') return null;

  const url = `capas/PRC_Chile/${nombrePrc}.kml`;
  const layer = omnivore.kml(url);

  return new Promise((resolve) => {
    layer.on('ready', function() {
      resolve(layer);
    });

    layer.on('error', function() {
      console.warn('PRC KML not found', url);
      resolve(null);
    });
  });
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
  const nearestVisibleZona = findNearestVisibleZonaBorder(point, zonas, poi.bbox);
  const relaveGroup = findNearestFeatures(point, relaves, poi.nRelaves || 5);
  const relaveMatch = relaveGroup[0] || null;
  const urbanaMatch = findNearestFeature(point, urbanas);

  const zf = nearestVisibleZona?.feature || zonaMatch?.feature; const rf = relaveMatch?.feature; const uf = urbanaMatch?.feature;
  const prcFeature = await loadPrcFeatureByName(
    prop(uf?.properties, ['nombre_prc'])
  );

  const zCent = zf ? getFeatureCentroid(zf) : null;
  const rCent = rf ? getFeatureCentroid(rf) : null;
  const uCent = uf ? getFeatureCentroid(uf) : null;
  const zArea = zf ? getFeatureAreaHa(zf) : null;
  const rArea = rf ? getRelaveAreaHa(rf) : null;
  const zonaDist = nearestVisibleZona?.distKm ?? Infinity;
  const relDist = relaveMatch?.distKm ?? Infinity;
  const urbDist = urbanaMatch?.distKm ?? Infinity;

  const relaveAreas = relaveGroup.map(({ feature }) => getRelaveAreaHa(feature)).filter((v) => Number.isFinite(v) && v > 0);
  const relaveDistances = relaveGroup.map(({ distKm }) => distKm).filter((v) => Number.isFinite(v));
  const diametersKm = relaveAreas.map((ha) => computeEquivalentDiameter(ha)).filter((v) => Number.isFinite(v));
  const totalSuperficieHa = relaveAreas.reduce((acc, v) => acc + v, 0);

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
      perimetroKm: Number.isFinite(zonaDist) ? zonaDist * 6 : null, centroide: zCent, feature: zf || null, polygon: getLeafletPolygonCoords(zf),
      visibleEnBbox: Boolean(nearestVisibleZona), nearestBorderPoint: nearestVisibleZona?.nearestBorderPoint || null
    },
    relavesGrupo: {
      cantidadAnalizada: relaveGroup.length,
      distanciaMinKm: relaveDistances.length ? Math.min(...relaveDistances) : null,
      distanciaPromKm: relaveDistances.length ? relaveDistances.reduce((a, b) => a + b, 0) / relaveDistances.length : null,
      distanciaMaxKm: relaveDistances.length ? Math.max(...relaveDistances) : null,
      radioEnvolventeKm: relaveDistances.length ? Math.max(...relaveDistances) : null,
      superficieTotalHa: relaveAreas.length ? totalSuperficieHa : null,
      superficiePromedioHa: relaveAreas.length ? totalSuperficieHa / relaveAreas.length : null,
      diametroEquivalentePromedioKm: diametersKm.length ? diametersKm.reduce((a, b) => a + b, 0) / diametersKm.length : null,
      items: relaveGroup.map(({ feature, distKm }, index) => {
        const props = feature?.properties || {};
        const superficieHa = getRelaveAreaHa(feature);
        const centroide = getFeatureCentroid(feature);
        return {
          rank: index + 1,
          distPoiKm: Number.isFinite(distKm) ? distKm : null,
          superficieHa,
          centroide,
          nombre: prop(props, ['id_relave', 'faena']),
          faena: prop(props, ['faena']),
          recurso: prop(props, ['recurso']),
          comuna: prop(props, ['comuna'])
        };
      })
    },
    relave: {
      nombre: prop(rf?.properties, ['id_relave', 'faena']), empresaFaena: prop(rf?.properties, ['empresa']), tipoDeposito: prop(rf?.properties, ['tipo_deposito']), recurso: prop(rf?.properties, ['recurso']), metodo: prop(rf?.properties, ['metodo_constructivo']),
      superficieHa: rArea, featureId: prop(rf?.id ? { id: rf.id } : rf?.properties, ['id', 'fid', 'objectid']), distPoiKm: Number.isFinite(relDist) ? relDist : null, centroide: rCent
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

function getDistanceFactors() {
  const zonaVisible = analysisData.zonaSaturada.visibleEnBbox;
  return [
    { label: zonaVisible ? `Zona saturada a ${formatKm(analysisData.zonaSaturada.distPerimetroKm)}` : 'Zona saturada: no visible en el encuadre', value: zonaVisible ? analysisData.zonaSaturada.distPerimetroKm : Infinity },
    { label: `Relave cercano a ${formatKm(analysisData.relave.distPoiKm)}`, value: analysisData.relave.distPoiKm }
  ].sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity));
}

function renderAll() {
  renderHeader();
  renderTopLayout();
  renderSummaryCards();
  renderInterpretation();
  renderActions();
  initMap();
}

function renderHeader() {
  document.getElementById('header-card').innerHTML = `<div class="header-grid">
    <div class="brand">
      <h1>GeoNOXA | CARD PRO 2.0</h1>
      <p>Análisis territorial del POI</p>
    </div>
    <div class="meta">
      <p>POI: ${analysisData.poi.lat}, ${analysisData.poi.lon}</p>
      <p>Fecha análisis: ${new Date().toLocaleString('es-CL')}</p>
    </div>
  </div>`;
}

function renderTopLayout() {
  const score = analysisData.relaciones.triangular.indice || 0;
  const factors = getDistanceFactors();
  const riesgo = analysisData.riesgo.nivel.toLowerCase();
  const zonaDist = analysisData.zonaSaturada.visibleEnBbox ? formatKm(analysisData.zonaSaturada.distPerimetroKm) : 'no visible en el encuadre';
  const relaveDist = formatKm(analysisData.relave.distPoiKm);
  const alertText = `POI con riesgo ${riesgo}, influenciado principalmente por zona saturada cercana y relave en el entorno.`;

  document.getElementById('top-layout').innerHTML = `<article class="card panel summary-panel">
      <h2 class="section-title">RESUMEN DEL ANÁLISIS</h2>
      <p class="kpi-label">Riesgo territorial</p>
      <p class="risk-value ${getRiskClass(analysisData.riesgo.nivel)}">${analysisData.riesgo.nivel.toUpperCase()}</p>
      <div class="synergy-block">
        <p class="kpi-label">Índice de sinergia</p>
        <p class="score-value">${score} / 100</p>
        <div class="progress-track"><div class="progress-fill" style="width:${Math.max(0, Math.min(score, 100))}%"></div></div>
      </div>
      <div class="factors-block">
        <p class="kpi-label">Factores principales</p>
        <ul class="factors-list">${factors.map((f) => `<li>${f.label}</li>`).join('')}</ul>
      </div>
      <div class="summary-alert">${alertText}<span class="sr-only">Zona saturada a ${zonaDist}, relave cercano a ${relaveDist}.</span></div>
    </article>
    <article class="card panel map-panel">
      <h2 class="section-title">Mapa de relaciones espaciales</h2>
      <div class="map-wrap">
        <div id="map"></div>
        <aside class="legend-floating">
          <strong>Leyenda</strong>
          <ul>
            <li>POI</li><li>Relaves</li><li>Zona saturada</li><li>Círculo equivalente de relave</li><li>Círculo envolvente relaves</li><li>Distancia a zona saturada</li>
          </ul>
        </aside>
      </div>
    </article>`;
}

function renderSummaryCards() {
  const z = analysisData.zonaSaturada;
  const r = analysisData.relave;
  const rg = analysisData.relavesGrupo;
  document.getElementById('summary-cards').innerHTML = `
    <article class="summary-card zona">
      <h3>Zona Saturada</h3>
      <ul><li><strong>Nombre:</strong> ${z.nombre}</li><li><strong>Estado:</strong> ${z.estado}</li><li><strong>Distancia al POI:</strong> <span class="distance">${formatKm(z.distPerimetroKm)}</span></li></ul>
    </article>
    <article class="summary-card relave">
      <h3>Relave más cercano</h3>
      <ul><li><strong>ID:</strong> ${r.nombre}</li><li><strong>Faena:</strong> ${analysisData.relavesGrupo.items[0]?.faena || 'Sin datos disponibles'}</li><li><strong>Recurso:</strong> ${r.recurso}</li><li><strong>Comuna:</strong> ${analysisData.relavesGrupo.items[0]?.comuna || 'Sin datos disponibles'}</li><li><strong>Distancia al POI:</strong> <span class="distance">${formatKm(r.distPoiKm)}</span></li><li><strong>Superficie:</strong> ${formatHa(r.superficieHa)}</li></ul>
    </article>
    <article class="summary-card relave">
      <h3>Grupo de relaves analizados</h3>
      <ul>
        <li><strong>N relaves considerados:</strong> ${rg.cantidadAnalizada}</li>
        <li><strong>Distancia promedio al POI:</strong> <span class="distance">${formatKm(rg.distanciaPromKm)}</span></li>
        <li><strong>Distancia mínima:</strong> <span class="distance">${formatKm(rg.distanciaMinKm)}</span></li>
        <li><strong>Distancia máxima:</strong> <span class="distance">${formatKm(rg.distanciaMaxKm)}</span></li>
        <li><strong>Radio envolvente desde POI:</strong> <span class="distance">${formatKm(rg.radioEnvolventeKm)}</span></li>
        <li><strong>Superficie total:</strong> ${formatHa(rg.superficieTotalHa)}</li>
        <li><strong>Superficie promedio:</strong> ${formatHa(rg.superficiePromedioHa)}</li>
        <li><strong>Diámetro equivalente promedio:</strong> ${formatKm(rg.diametroEquivalentePromedioKm)}</li>
      </ul>
    </article>`;
}

function renderInterpretation() {
  const riesgo = analysisData.riesgo.nivel.toLowerCase();
  const zonaDist = analysisData.zonaSaturada.visibleEnBbox ? formatKm(analysisData.zonaSaturada.distPerimetroKm) : 'no visible en el encuadre';
  const relaveDist = formatKm(analysisData.relave.distPoiKm);
  const text = `El punto analizado presenta un riesgo ${riesgo}, influenciado principalmente por la cercanía de la zona saturada a ${zonaDist} y la presencia de un relave a ${relaveDist}.`;
  document.getElementById('interpretation').innerHTML = `<h2 class="section-title">INTERPRETACIÓN AUTOMÁTICA GEONOXA</h2><p>${text}</p>`;
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

  const relaveItems = analysisData.relavesGrupo?.items || [];
  relaveItems.forEach((relave, index) => {
    if (!Array.isArray(relave.centroide)) return;
    const isNearest = index === 0;

    L.circleMarker(relave.centroide, {
      radius: isNearest ? 9 : 7,
      color: isNearest ? '#92400e' : '#b45309',
      weight: isNearest ? 3 : 2,
      fillColor: isNearest ? '#f97316' : '#f59e0b',
      fillOpacity: 0.9
    })
      .bindPopup(`Relave #${relave.rank}: ${relave.nombre}`)
      .addTo(group);

    const relaveRadiusMeters = computeEquivalentRadiusMeters(Number(relave.superficieHa));
    if (Number.isFinite(relaveRadiusMeters) && relaveRadiusMeters > 0) {
      L.circle(relave.centroide, { radius: relaveRadiusMeters, color: isNearest ? '#ea580c' : '#f59e0b', weight: 2, fillOpacity: 0.04 })
        .bindPopup(`Círculo equivalente relave #${relave.rank}`)
        .addTo(group);
    }

  });

  let envelopeCircle = null;
  const envelopeRadiusKm = analysisData.relavesGrupo?.radioEnvolventeKm;
  const envelopeRadiusMeters = Number.isFinite(envelopeRadiusKm) ? envelopeRadiusKm * 1000 : null;
  if (Number.isFinite(envelopeRadiusMeters) && envelopeRadiusMeters > 0) {
    envelopeCircle = L.circle(poiLatLng, {
      radius: envelopeRadiusMeters,
      color: '#2563eb',
      weight: 2,
      fillColor: '#2563eb',
      fillOpacity: 0.12,
      opacity: 0.9,
      dashArray: '8,6'
    })
      .bindPopup(`Círculo envolvente relaves seleccionados<br>Radio: ${formatKm(envelopeRadiusKm)}<br>N relaves: ${analysisData.relavesGrupo.cantidadAnalizada}`)
      .bindTooltip(`Círculo envolvente relaves seleccionados · ${formatKm(envelopeRadiusKm)}`)
      .addTo(group);
  }

  if (analysisData.zonaSaturada.polygon) {
    L.polygon(analysisData.zonaSaturada.polygon, { color: '#8b5cf6', weight: 2, fillColor: '#8b5cf6', fillOpacity: 0.16 })
      .bindPopup(`Zona saturada: ${analysisData.zonaSaturada.nombre}`)
      .addTo(group);
  }


  const nearestBorderPoint = analysisData.zonaSaturada.nearestBorderPoint;
  if (analysisData.zonaSaturada.visibleEnBbox && Array.isArray(nearestBorderPoint)) {
    L.polyline([poiLatLng, nearestBorderPoint], { color: '#8b5cf6', weight: 2, dashArray: '6,6', opacity: 0.9 }).addTo(group);
    L.circleMarker(nearestBorderPoint, { radius: 5, color: '#8b5cf6', weight: 2, fillColor: '#8b5cf6', fillOpacity: 0.95 })
      .bindPopup('Borde más cercano zona saturada')
      .addTo(group);
  }

  const bounds = group.getBounds();
  if (envelopeCircle) bounds.extend(envelopeCircle.getBounds());
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.12));
  poi.openPopup();
}
function renderActions() {
  document.getElementById('actions').innerHTML = `
    <button type="button">Descargar KML</button>
    <button type="button">Descargar PDF</button>
    <button type="button">Ver análisis completo</button>
    <a href="${buildEcosystemUrl('https://example.com/geoipt')}" target="_blank" rel="noopener">Ir a GeoIPT</a>
    <a href="${buildEcosystemUrl('https://example.com/geoeva')}" target="_blank" rel="noopener">Ir a GeoEVA</a>
    <a href="${buildEcosystemUrl('https://example.com/geonemo')}" target="_blank" rel="noopener">Ir a GeoNEMO</a>`;
}
(async function init(){const poi=getPoiFromUrl();analysisData=await buildAnalysisData(poi);renderAll();})();
