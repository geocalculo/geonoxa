async function generateStaticMapImage() {
  const currentMap = window.map || map;
  const mapDiv = document.getElementById('map');
  if (!currentMap || !mapDiv || typeof window.leafletImage !== 'function') return null;

  await new Promise((resolve) => setTimeout(resolve, 120));

  const snapshot = await new Promise((resolve, reject) => {
    window.leafletImage(currentMap, (error, canvas) => {
      if (error || !canvas) {
        reject(error || new Error('No se pudo capturar el mapa con leaflet-image'));
        return;
      }
      resolve(canvas);
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
  const relavesEnVista = relaves.filter((f) => {
    const lat = Number(f?.properties?.latitud ?? f?.geometry?.coordinates?.[1]);
    const lon = Number(f?.properties?.longitud ?? f?.geometry?.coordinates?.[0]);
    return isPointInBbox(lat, lon, poi.bbox);
  });
  const relavesConDist = relavesEnVista
    .map((f) => {
      const lat = Number(f?.properties?.latitud ?? f?.geometry?.coordinates?.[1]);
      const lon = Number(f?.properties?.longitud ?? f?.geometry?.coordinates?.[0]);
      const dist = haversineKm(point.lat, point.lon, lat, lon);
      return {
        feature: f,
        distKm: Number.isFinite(dist) ? dist : Infinity
      };
    })
    .filter((item) => Number.isFinite(item.distKm))
    .sort((a, b) => a.distKm - b.distKm);
  const relaveGroup = relavesConDist.slice(0, poi.nRelaves || 5);
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

  const distPromRelaves = relaveDistances.length ? relaveDistances.reduce((a, b) => a + b, 0) / relaveDistances.length : null;
  const diamPromRelaves = diametersKm.length ? diametersKm.reduce((a, b) => a + b, 0) / diametersKm.length : null;
  const distCentroideZona = zCent ? haversineKm(poi.lat, poi.lon, zCent[0], zCent[1]) : null;
  const diamZona = computeEquivalentDiameter(zArea);

  const kpiRelaves = Number.isFinite(distPromRelaves) && Number.isFinite(diamPromRelaves) && diamPromRelaves > 0
    ? distPromRelaves / diamPromRelaves
    : NaN;
  const riesgoRelaves = clasificarRiesgoKPI(kpiRelaves);

  const kpiZona = Number.isFinite(distCentroideZona) && Number.isFinite(diamZona) && diamZona > 0
    ? distCentroideZona / diamZona
    : NaN;
  const riesgoZona = clasificarRiesgoKPI(kpiZona);

  const kpiCritico = [kpiRelaves, kpiZona].filter(Number.isFinite).reduce((min, v) => Math.min(min, v), Infinity);
  const factorDominante = kpiZona <= kpiRelaves ? 'zona saturada' : 'relaves';

  const riesgo = peorRiesgo(riesgoRelaves, riesgoZona);
  return {
    poi: { ...poi, name: 'POI seleccionado', comuna: 'Sin datos disponibles', region: 'Sin datos disponibles' },
    zonaSaturada: {
      nombre: prop(zf?.properties, ['nombre_zon']), contaminante: prop(zf?.properties, ['saturado']), estado: prop(zf?.properties, ['zona_dec']),
      fuente: prop(zf?.properties, ['decreto']), link: prop(zf?.properties, ['link']), latentes: prop(zf?.properties, ['latentes']),
      featureId: prop(zf?.properties, ['objectid']),
      poiInOut: zonaMatch?.inOut || 'Sin datos disponibles', distPerimetroKm: Number.isFinite(zonaDist) ? zonaDist : null,
      distCentroideKm: distCentroideZona, diametroZonaKm: diamZona, superficieHa: zArea,
      perimetroKm: Number.isFinite(zonaDist) ? zonaDist * 6 : null, centroide: zCent, feature: zf || null, polygon: getLeafletPolygonCoords(zf),
      visibleEnBbox: Boolean(nearestVisibleZona), nearestBorderPoint: nearestVisibleZona?.nearestBorderPoint || null
    },
    relavesGrupo: {
      totalEnVista: relavesEnVista.length,
      cantidadAnalizada: relaveGroup.length,
      distanciaMinKm: relaveDistances.length ? Math.min(...relaveDistances) : null,
      distanciaPromKm: distPromRelaves,
      distanciaMaxKm: relaveDistances.length ? Math.max(...relaveDistances) : null,
      radioEnvolventeKm: relaveDistances.length ? Math.max(...relaveDistances) : null,
      superficieTotalHa: relaveAreas.length ? totalSuperficieHa : null,
      superficiePromedioHa: relaveAreas.length ? totalSuperficieHa / relaveAreas.length : null,
      diametroEquivalentePromedioKm: diamPromRelaves,
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
    riesgo: { nivel: riesgo, relaves: riesgoRelaves, zona: riesgoZona, kpiRelaves, kpiZona, kpiCritico: Number.isFinite(kpiCritico) ? kpiCritico : NaN, factorDominante }
  };
}

function getMainKpiRiskClass() {
  const riesgo = analysisData.riesgo.nivel;
  if (riesgo === 'MUY ALTO') return 'kpi-muy-alto';
  if (riesgo === 'ALTO') return 'kpi-alto';
  if (riesgo === 'MEDIO') return 'kpi-medio';
  if (riesgo === 'BAJO') return 'kpi-bajo';
  return 'kpi-muy-bajo';
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
  const riesgo = analysisData.riesgo.nivel.toLowerCase();
  const alertText = `POI con riesgo ${riesgo}, determinado por el KPI más crítico entre zona saturada y relaves.`;

  document.getElementById('top-layout').innerHTML = `<article class="card panel summary-panel">
      <div class="card-topbar">
        <div class="card-topbar-left">
      <h2 class="section-title">RIESGO TERRITORIAL</h2>
      <p class="risk-value ${getRiskClass(analysisData.riesgo.nivel)}">${analysisData.riesgo.nivel.toUpperCase()}</p>
      <div class="kpi-main-block">
        <p class="kpi-label">KPI CRÍTICO</p>
        <p class="kpi-main-row" title="KPI = distancia al fenómeno / diámetro equivalente.&#10;Valores bajos indican mayor exposición relativa.">
          <span>KPI crítico:</span>
          <span class="kpi-main ${getMainKpiRiskClass()}">${Number.isFinite(analysisData.riesgo.kpiCritico) ? analysisData.riesgo.kpiCritico.toFixed(2) : 'N/D'}</span>
        </p>
        <div class="kpi-formula">
          <p><strong>Zona saturada:</strong><br>${formatKm(analysisData.zonaSaturada.distCentroideKm)} / ${formatKm(analysisData.zonaSaturada.diametroZonaKm)} = ${Number.isFinite(analysisData.riesgo.kpiZona) ? analysisData.riesgo.kpiZona.toFixed(2) : 'N/D'}</p>
          <p><strong>Relaves:</strong><br>${formatKm(analysisData.relavesGrupo.distanciaPromKm)} / ${formatKm(analysisData.relavesGrupo.diametroEquivalentePromedioKm)} = ${Number.isFinite(analysisData.riesgo.kpiRelaves) ? analysisData.riesgo.kpiRelaves.toFixed(2) : 'N/D'}</p>
        </div>
        <p class="kpi-note">Menor valor indica mayor exposición territorial.</p>
      </div>
      <div class="factors-block">
        <p class="kpi-label">Factores principales</p>
        <ul class="factors-list">
          <li><strong>KPI relaves:</strong> ${Number.isFinite(analysisData.riesgo.kpiRelaves) ? analysisData.riesgo.kpiRelaves.toFixed(2) : 'N/D'} <span class="factor-subtle">(${formatKm(analysisData.relavesGrupo.distanciaPromKm)} / ${formatKm(analysisData.relavesGrupo.diametroEquivalentePromedioKm)})</span></li>
          <li><strong>KPI zona saturada:</strong> ${Number.isFinite(analysisData.riesgo.kpiZona) ? analysisData.riesgo.kpiZona.toFixed(2) : 'N/D'} <span class="factor-subtle">(${formatKm(analysisData.zonaSaturada.distCentroideKm)} / ${formatKm(analysisData.zonaSaturada.diametroZonaKm)})</span></li>
        </ul>
      </div>
      <div class="summary-alert">${alertText}</div>
        </div>
        <div class="card-topbar-right">
          <div class="card-actions">
            <button id="btn-export-kml" class="btn-export btn-kml" type="button">
              <span class="btn-icon" aria-hidden="true">⇩</span>
              <span class="btn-text">EXPORTAR KML</span>
            </button>
            <button id="btn-export-pdf" class="btn-export btn-pdf" type="button">
              <span class="btn-icon" aria-hidden="true">▣</span>
              <span class="btn-text">PDF PRO</span>
            </button>
          </div>
        </div>
      </div>
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

function setButtonLoading(buttonId, isLoading, text) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  const icon = button.querySelector('.btn-icon');
  const label = button.querySelector('.btn-text');
  button.disabled = isLoading;
  if (label) label.textContent = isLoading ? text : (buttonId === 'btn-export-kml' ? EXPORT_BUTTON_DEFAULT.kml : EXPORT_BUTTON_DEFAULT.pdf);
  if (icon) icon.innerHTML = isLoading ? '<span class="btn-spinner" aria-hidden="true"></span>' : (buttonId === 'btn-export-kml' ? '⤓' : '▣');
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function validateKmlCoordinatePair(lat, lon, originalPoint) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  if (Math.abs(lon) < 40 && Math.abs(lat) > 60) {
    console.warn('[KML EXPORT] Posible inversión lon/lat detectada', originalPoint);
  }
  return true;
}

function leafletCoordToKml(point) {
  if (!Array.isArray(point) || point.length < 2) return null;
  const lat = Number(point[0]);
  const lon = Number(point[1]);
  if (!validateKmlCoordinatePair(lat, lon, point)) return null;
  return `${lon},${lat},0`;
}

function geoJsonCoordToKml(point) {
  if (!Array.isArray(point) || point.length < 2) return null;
  const lon = Number(point[0]);
  const lat = Number(point[1]);
  if (!validateKmlCoordinatePair(lat, lon, point)) return null;
  return `${lon},${lat},0`;
}

function polygonToKmlCoordinates(ring, coordToKmlFn = leafletCoordToKml) {
  if (!Array.isArray(ring)) return '';
  const coords = ring.map(coordToKmlFn).filter(Boolean);
  if (!coords.length) return '';
  if (coords[0] !== coords[coords.length - 1]) coords.push(coords[0]);
  return coords.join(' ');
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function polygonToKml(polyCoords) {
  const outer = polyCoords?.[0];
  if (!outer || !outer.length) {
    console.warn('Polygon vacío:', polyCoords);
    return '';
  }
  return polygonToKmlCoordinates(outer, geoJsonCoordToKml);
}

function multiPolygonToKml(multiCoords) {
  if (!Array.isArray(multiCoords) || !multiCoords.length) {
    console.warn('Coordinates inválidas:', multiCoords);
    return '';
  }

  const polygons = multiCoords
    .map((polyCoords) => {
      const coords = polygonToKml(polyCoords);
      if (!coords) return '';
      return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    })
    .filter(Boolean)
    .join('');

  return polygons ? `<MultiGeometry>${polygons}</MultiGeometry>` : '';
}

function geometryToKml(feature) {
  if (!feature || !feature.geometry) {
    console.warn('Feature sin geometry:', feature);
    return '';
  }

  const geom = feature.geometry;
  if (!geom.type) {
    console.warn('Geometry inválida:', feature);
    return '';
  }

  const coords = geom.coordinates;
  if (!Array.isArray(coords) || !coords.length) {
    console.warn('Coordinates inválidas:', coords);
    return '';
  }

  if (geom.type === 'Point') {
    const pointCoordinates = geoJsonCoordToKml(coords);
    return pointCoordinates ? `<Point><coordinates>${pointCoordinates}</coordinates></Point>` : '';
  }

  if (geom.type === 'Polygon') {
    const polygonCoordinates = polygonToKml(coords);
    return polygonCoordinates ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${polygonCoordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon>` : '';
  }

  if (geom.type === 'MultiPolygon') {
    return multiPolygonToKml(coords);
  }

  console.warn('Tipo geometry no soportado:', geom.type);
  return '';
}

function buildPolygonGeometryKml(rings) {
  if (!Array.isArray(rings) || !rings.length) return '';
  const polygonParts = [];
  rings.forEach((ring, index) => {
    if (!Array.isArray(ring) || !ring.length) return;
    const ringCoords = polygonToKmlCoordinates(ring, geoJsonCoordToKml);
    if (!ringCoords) return;
    if (index === 0) {
      polygonParts.push(`<outerBoundaryIs><LinearRing><coordinates>${ringCoords}</coordinates></LinearRing></outerBoundaryIs>`);
    } else {
      polygonParts.push(`<innerBoundaryIs><LinearRing><coordinates>${ringCoords}</coordinates></LinearRing></innerBoundaryIs>`);
    }
  });
  return polygonParts.length ? `<Polygon>${polygonParts.join('')}</Polygon>` : '';
}

function buildZonaSaturadaGeometryKml(feature) {
  const geometry = feature?.geometry;
  const coords = geometry?.coordinates;
  if (!geometry || !Array.isArray(coords) || !coords.length) return '';
  if (geometry.type === 'Polygon') return buildPolygonGeometryKml(coords);
  if (geometry.type === 'MultiPolygon') {
    const polygons = coords.map((polygonRings) => buildPolygonGeometryKml(polygonRings)).filter(Boolean);
    return polygons.length ? `<MultiGeometry>${polygons.join('')}</MultiGeometry>` : '';
  }
  return '';
}

function buildZonaSaturadaPlacemark() {
  const zona = analysisData?.zonaSaturada;
  const feature = zona?.feature;
  const geometry = feature?.geometry;
  const geometryType = geometry?.type;
  const coordinates = geometry?.coordinates;
  const rings = geometryType === 'Polygon'
    ? coordinates
    : (geometryType === 'MultiPolygon' ? coordinates.flat() : []);
  const vertices = rings.flat().filter((coord) => Array.isArray(coord) && coord.length >= 2);
  const firstVertex = vertices[0] || null;
  const lastVertex = vertices[vertices.length - 1] || null;
  const firstRing = Array.isArray(rings?.[0]) ? rings[0] : null;
  const hasClosedRing = Boolean(firstRing?.length) && JSON.stringify(firstRing[0]) === JSON.stringify(firstRing[firstRing.length - 1]);
  const leafletLayer = renderedAnalysisLayers?.getLayers?.()?.find((layer) => String(layer?.getPopup?.()?.getContent?.() || '').includes('Zona saturada:'));

  console.group('[KML EXPORT][ZONA SATURADA]');
  console.log('zona.feature existe?', Boolean(feature));
  console.log('geometry.type', geometryType || 'N/A');
  console.log('coordinates.length', Array.isArray(coordinates) ? coordinates.length : 0);
  console.log('Polygon o MultiPolygon', geometryType === 'Polygon' || geometryType === 'MultiPolygon' ? geometryType : 'No soportado');
  console.log('cantidad de vértices', vertices.length);
  console.log('primer vértice', firstVertex);
  console.log('último vértice', lastVertex);
  console.log('geometry vacía?', !Array.isArray(coordinates) || !coordinates.length);
  console.log('ring cerrado?', hasClosedRing);
  console.log('layer Leaflet asociado?', Boolean(leafletLayer));
  console.log(zona?.feature);
  console.groupEnd();

  const geometryXml = buildZonaSaturadaGeometryKml(feature);
  if (!geometryXml) return '';

  return `<Placemark><name>${escapeXml(`Zona Saturada: ${zona?.nombre || 'Sin nombre'}`)}</name><styleUrl>#zonaSaturadaStyle</styleUrl><ExtendedData>
      <Data name="estado"><value>${escapeXml(zona?.estado || 'N/D')}</value></Data>
      <Data name="distancia_poi_km"><value>${escapeXml(formatKm(zona?.distPerimetroKm))}</value></Data>
      <Data name="distancia_borde_km"><value>${escapeXml(formatKm(zona?.distPerimetroKm))}</value></Data>
      <Data name="distancia_centroide_km"><value>${escapeXml(formatKm(zona?.distCentroideKm))}</value></Data>
      <Data name="diametro_equivalente_km"><value>${escapeXml(formatKm(zona?.diametroZonaKm))}</value></Data>
      <Data name="KPI"><value>${escapeXml(Number.isFinite(analysisData?.riesgo?.kpiZona) ? analysisData.riesgo.kpiZona.toFixed(2) : 'N/D')}</value></Data>
    </ExtendedData>${geometryXml}</Placemark>`;
}

function latLngToKml(latlng) {
  if (!latlng) return '';
  return leafletCoordToKml([latlng.lat, latlng.lng]) || '';
}

function latLngsToKml(latlngs) {
  if (!Array.isArray(latlngs)) return '';
  const coords = latlngs.map(latLngToKml).filter(Boolean);
  if (!coords.length) return '';
  if (coords[0] !== coords[coords.length - 1]) coords.push(coords[0]);
  return coords.join(' ');
}


function createCircleRingCoords(centerLat, centerLon, radiusMeters, segments = 96) {
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon) || !Number.isFinite(radiusMeters) || radiusMeters <= 0) return [];
  const earthRadiusMeters = 6378137;
  const ring = [];
  const angularDistance = radiusMeters / earthRadiusMeters;
  const latRad = centerLat * Math.PI / 180;
  const lonRad = centerLon * Math.PI / 180;

  for (let i = 0; i < segments; i += 1) {
    const bearing = (i / segments) * 2 * Math.PI;
    const sinLat = Math.sin(latRad) * Math.cos(angularDistance) + Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing);
    const pointLatRad = Math.asin(Math.max(-1, Math.min(1, sinLat)));
    const pointLonRad = lonRad + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad),
      Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(pointLatRad)
    );
    ring.push([pointLatRad * 180 / Math.PI, ((pointLonRad * 180 / Math.PI + 540) % 360) - 180]);
  }

  if (ring.length) ring.push([...ring[0]]);
  return ring;
}

function collectRenderedLayersForKml() {
  const sourceGroup = renderedAnalysisLayers;
  const layers = [];
  if (!sourceGroup?.eachLayer) return layers;

  console.group('[KML EXPORT][SOURCE OF TRUTH]');
  sourceGroup.eachLayer((layer, index) => {
    const layerType = layer?.constructor?.name || 'UnknownLayer';
    const hasGetLatLng = typeof layer?.getLatLng === 'function';
    const hasGetLatLngs = typeof layer?.getLatLngs === 'function';
    const hasFeatureGeometry = Boolean(layer?.feature?.geometry);
    const radiusMeters = typeof layer?.getRadius === 'function' ? layer.getRadius() : null;
    const hasRadius = Number.isFinite(radiusMeters);
    const layerOptions = layer?.options || {};
    const centerLatLng = hasGetLatLng ? layer.getLatLng() : null;
    let exportAs = 'skip';
    let geometryXml = '';
    let extraData = '';
    let customName = '';

    if (layer instanceof L.Marker || layer instanceof L.CircleMarker) {
      const point = latLngToKml(layer.getLatLng());
      if (point) {
        exportAs = 'Point';
        geometryXml = `<Point><coordinates>${point}</coordinates></Point>`;
      }
    } else if (layer instanceof L.Circle) {
      const isBlueCircle = String(layerOptions.color || '').toLowerCase() === '#2563eb' || String(layerOptions.fillColor || '').toLowerCase() === '#2563eb';
      const hasFill = Number(layerOptions.fillOpacity) > 0;
      const isLarge = Number.isFinite(radiusMeters) && radiusMeters > 1000;
      const isEnvelopeCircle = isBlueCircle && hasFill && isLarge;
      if (isEnvelopeCircle) exportAs = 'skip';
    } else if (layer instanceof L.Polygon) {
      const rings = layer.getLatLngs();
      const outerRing = Array.isArray(rings?.[0]) ? rings[0] : rings;
      const polygonCoordinates = latLngsToKml(outerRing);
      if (polygonCoordinates) {
        exportAs = 'Polygon';
        geometryXml = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${polygonCoordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
      }
    } else if (layer instanceof L.Polyline) {
      const lineCoordinates = (layer.getLatLngs() || []).map(latLngToKml).filter(Boolean).join(' ');
      if (lineCoordinates) {
        exportAs = 'LineString';
        geometryXml = `<LineString><coordinates>${lineCoordinates}</coordinates></LineString>`;
      }
    } else if (layer?.feature?.geometry) {
      geometryXml = geometryToKml(layer.feature);
      if (geometryXml) exportAs = layer.feature.geometry.type;
    }

    console.log(`#${index + 1}`, {
      layerType,
      hasGetLatLng,
      hasGetLatLngs,
      hasFeatureGeometry,
      hasRadius,
      fillOpacity: layerOptions.fillOpacity,
      opacity: layerOptions.opacity,
      color: layerOptions.color,
      fillColor: layerOptions.fillColor,
      radiusMeters,
      centerLatLng,
      exportAs
    });

    if (!geometryXml) return;
    const layerName = customName || layer?.getPopup?.()?.getContent?.() || layer?.getTooltip?.()?.getContent?.() || layerType;
    if (String(layerName).includes('Zona saturada:')) return;
    layers.push({
      name: String(layerName).replace(/<[^>]*>/g, ' ').trim() || layerType,
      geometryXml,
      extraData
    });
  });
  console.log('Total layers detectadas:', layers.length);
  console.groupEnd();
  return layers;
}

function buildKml() {
  const poi = analysisData.poi;
  const fechaConsulta = new Date().toLocaleString('es-CL');
  const exportedLayers = collectRenderedLayersForKml();

  const poiDescription = `
    <ExtendedData>
      <Data name="latitud"><value>${escapeXml(poi.lat)}</value></Data>
      <Data name="longitud"><value>${escapeXml(poi.lon)}</value></Data>
      <Data name="fecha_consulta"><value>${escapeXml(fechaConsulta)}</value></Data>
      <Data name="radio_analisis"><value>${escapeXml(formatKm(analysisData.relavesGrupo?.radioEnvolventeKm))}</value></Data>
      <Data name="relaves_analizados"><value>${escapeXml(analysisData.relavesGrupo?.cantidadAnalizada ?? 0)}</value></Data>
      <Data name="zonas_saturadas"><value>${escapeXml(analysisData.zonaSaturada?.feature ? 1 : 0)}</value></Data>
    </ExtendedData>
    <description>${escapeXml(`Latitud: ${poi.lat} | Longitud: ${poi.lon} | Fecha consulta: ${fechaConsulta}`)}</description>
  `;

  const placemarks = exportedLayers.map((layer) => `<Placemark><name>${escapeXml(layer.name)}</name>${layer.extraData}${layer.geometryXml}</Placemark>`).join('');
  const zonaSaturadaPlacemark = buildZonaSaturadaPlacemark();
  const poiCoordinates = leafletCoordToKml([poi.lat, poi.lon]);
  const poiGeometry = poiCoordinates ? `<Point><coordinates>${poiCoordinates}</coordinates></Point>` : '';
  const envelopeRing = analysisData.kmlGeometries?.circuloEnvolventeRelaves?.coordinates;
  let envelopePlacemark = '';
  if (Array.isArray(envelopeRing) && envelopeRing.length >= 4) {
    const envelopeKmlCoordinates = envelopeRing
      .map((coord) => leafletCoordToKml(coord))
      .filter(Boolean)
      .join(' ');
    if (envelopeKmlCoordinates) {
      envelopePlacemark = `<Placemark><name>Círculo envolvente relaves seleccionados</name><styleUrl>#circuloEnvolventeStyle</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${envelopeKmlCoordinates}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
    }
  } else {
    console.warn('[KML EXPORT] círculo envolvente sin ring precomputado; no se exporta como polígono');
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>GeoNOXA_QUERY</name>
<Style id="poiStyle"><IconStyle><color>ffff8800</color><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/blu-circle.png</href></Icon></IconStyle></Style>
<Style id="circuloEnvolventeStyle"><LineStyle><color>ccff7b2f</color><width>2</width></LineStyle><PolyStyle><color>332f7bff</color></PolyStyle></Style>
<Style id="zonaSaturadaStyle"><LineStyle><color>ff0055ff</color><width>2</width></LineStyle><PolyStyle><color>440055ff</color></PolyStyle></Style>
<Folder><name>POI</name>${poiGeometry ? `<Placemark><name>POI</name><styleUrl>#poiStyle</styleUrl><description>${poiDescription}</description>${poiGeometry}</Placemark>` : ''}</Folder>
<Folder><name>Capas_Renderizadas</name>${zonaSaturadaPlacemark}${placemarks}${envelopePlacemark}</Folder>
</Document></kml>`;
}

function exportKML() {
  console.group('GeoNOXA exportKML');
  try {
    console.log('Exportando POI...');
    console.log('Exportando zonas saturadas...');
    console.log('Exportando relaves...');
    console.log('Exportando círculos equivalentes...');
    console.log('Exportando buffer análisis...');

    const kml = buildKml();
    console.log(kml);
    downloadTextFile('GeoNOXA_QUERY.kml', kml, 'application/vnd.google-earth.kml+xml');
    window.dataLayer?.push({
      event: 'download_kml',
      site: 'geonoxa',
      file_name: 'GeoNOXA_QUERY.kml',
      download_method: 'blob_anchor'
    });
    console.log('KML generado correctamente');
  } finally {
    console.groupEnd();
  }
}
async function exportPdfPro() {
  async function waitForLeafletTiles(mapInstance) {
    if (!mapInstance || typeof mapInstance.eachLayer !== 'function') return;
    const tilePromises = [];
    mapInstance.eachLayer((layer) => {
      if (!layer || !layer._container || typeof layer.on !== 'function') return;
      if (typeof layer.isLoading === 'function' && layer.isLoading()) {
        tilePromises.push(new Promise((resolve) => {
          const done = () => {
            layer.off('load', done);
            layer.off('tileerror', done);
            resolve();
          };
          layer.on('load', done);
          layer.on('tileerror', done);
          setTimeout(done, 2000);
        }));
      }
    });
    if (tilePromises.length) await Promise.all(tilePromises);
  }

  async function captureLeafletPng(mapInstance) {
    if (!mapInstance || !window.L?.simpleMapScreenshoter) return null;
    const screenshoter = window.L.simpleMapScreenshoter({
      hidden: true,
      preventDownload: true,
      cropImageByInnerWH: true,
      mimeType: 'image/png'
    }).addTo(mapInstance);
    try {
      const screenshot = await screenshoter.takeScreen('image');
      if (typeof screenshot === 'string' && screenshot.startsWith('data:image/png')) return screenshot;
      if (screenshot instanceof HTMLCanvasElement) return screenshot.toDataURL('image/png');
      return null;
    } finally {
      screenshoter.remove();
    }
  }

  async function stabilizeLeafletBeforePdf(mapInstance) {
    if (!mapInstance) return;

    try {
      mapInstance.invalidateSize(true);

      if (typeof mapInstance.stop === 'function') {
        mapInstance.stop();
      }

      if (typeof mapInstance.whenReady === 'function') {
        await new Promise((resolve) => mapInstance.whenReady(resolve));
      }

      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );

      if (typeof mapInstance.eachLayer === 'function') {
        mapInstance.eachLayer((layer) => {
          if (layer && typeof layer.redraw === 'function') {
            layer.redraw();
          }
        });
      }

      await waitForLeafletTiles(mapInstance);
      await new Promise((resolve) => setTimeout(resolve, 400));
    } catch (error) {
      console.warn('[PDF EXPORT] Falló la estabilización de Leaflet antes de exportar', error);
    }
  }

  if (!window.jspdf?.jsPDF || !window.html2canvas) return;
  const printable = document.querySelector('.page-shell');
  if (!printable) return;

  const mapElement = document.getElementById('map');
  let mapPng = null;
  if (mapElement) {
    try {
      await stabilizeLeafletBeforePdf(window.map || map);
      mapPng = await captureLeafletPng(window.map || map);
    } catch (error) {
      console.warn('[PDF EXPORT] No se pudo congelar el mapa como PNG, usando clon original', error);
    }
  }

  const printClone = printable.cloneNode(true);
  printClone.classList.add('pdf-export-root');
  if (mapPng) {
    const clonedMap = printClone.querySelector('#map');
    if (clonedMap) {
      clonedMap.innerHTML = '';
      clonedMap.removeAttribute('data-leaflet-id');
      clonedMap.classList.remove('leaflet-container');
      clonedMap.style.position = 'relative';
      clonedMap.style.overflow = 'hidden';
      const fixedMapImg = document.createElement('img');
      fixedMapImg.src = mapPng;
      fixedMapImg.alt = 'Mapa GeoNOXA';
      fixedMapImg.style.width = '100%';
      fixedMapImg.style.height = '100%';
      fixedMapImg.style.objectFit = 'contain';
      fixedMapImg.style.display = 'block';
      fixedMapImg.style.position = 'absolute';
      fixedMapImg.style.inset = '0';
      clonedMap.appendChild(fixedMapImg);
    }
  }

  document.body.classList.add('pdf-export-mode');
  document.body.appendChild(printClone);
  let canvas;
  try {
    canvas = await window.html2canvas(printClone, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#0b1220',
      logging: false,
      windowWidth: PDF_EXPORT_WIDTH,
      width: PDF_EXPORT_WIDTH,
      scrollX: 0,
      scrollY: 0
    });

    const imgData = canvas.toDataURL('image/png');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p', 'mm', 'a4');

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    let y = 0;
    let heightLeft = imgHeight;

    doc.addImage(imgData, 'PNG', 0, y, imgWidth, imgHeight);
    heightLeft -= pageHeight;

    while (heightLeft > 0) {
      y = heightLeft - imgHeight;
      doc.addPage();
      doc.addImage(imgData, 'PNG', 0, y, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }

    doc.save('GeoNOXA_PRO_QUERY.pdf');
  } finally {
    exportRoot.remove();
    document.body.classList.remove('pdf-export-mode');
  }
}