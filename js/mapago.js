const analysisData = {
  poi: {
    name: 'POI Demo GeoNOXA',
    lat: -33.4489,
    lon: -70.6693,
    comuna: 'Santiago',
    region: 'Región Metropolitana',
    zoom: 11,
    bbox: '-70.95,-33.65,-70.35,-33.20'
  },
  zonaSaturada: {
    nombre: 'Zona Saturada RM Centro',
    contaminante: 'MP2.5 / NOx',
    estado: 'Vigente',
    fuente: 'DS 31/2016 MMA',
    featureId: 'ZS-RM-001',
    poiInOut: 'OUT',
    distPerimetroKm: 2.36,
    distCentroideKm: 9.41,
    superficieHa: 12840,
    perimetroKm: 78.2,
    centroide: [-33.52, -70.78],
    polygon: [[-33.35, -70.95], [-33.22, -70.7], [-33.38, -70.42], [-33.6, -70.52], [-33.63, -70.85]]
  },
  relave: {
    nombre: 'Relave El Progreso',
    empresaFaena: 'Minera Demo Norte',
    tipoDeposito: 'Tranque',
    recurso: 'Cobre',
    metodo: 'Aguas abajo',
    superficieHa: 84.5,
    featureId: 'RLV-5471',
    distPoiKm: 5.12,
    centroide: [-33.39, -70.58]
  },
  zonaUrbana: {
    nombre: 'PRC Santiago Centro',
    comuna: 'Santiago',
    region: 'Región Metropolitana',
    instrumento: 'PRC',
    superficieHa: 6520,
    featureId: 'URB-112',
    distPoiKm: 3.04,
    distCentroideKm: 7.5,
    centroide: [-33.45, -70.72]
  },
  relaciones: {
    poiZona: { exposicion: 'Media' },
    poiRelave: { exposicion: 'Media' },
    relaveUrbana: { distCentroKm: 4.45, distPerimetroKm: 2.1, prioridad: 'Alta' },
    urbanaZona: { distPerimetroKm: 1.62, distCentroideKm: 8.9, inOut: 'OUT', exposicionIndirecta: 'Alta' },
    triangular: { alineacion: 'Media', sinergia: 'Alta', impacto: 'Alto', indice: 74 }
  },
  riesgo: { nivel: 'Alto' }
};

let map;
function computeEquivalentDiameter(areaHa) {
  const areaM2 = areaHa * 10000;
  const diamM = 2 * Math.sqrt(areaM2 / Math.PI);
  return diamM / 1000;
}
const formatKm = (v) => `${Number(v).toFixed(2)} km`;
const formatHa = (v) => `${Number(v).toLocaleString('es-CL', { maximumFractionDigits: 1 })} ha`;
const getRiskClass = (level) => `risk-${level.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}`;
function buildEcosystemUrl(baseUrl) {
  const { lat, lon, zoom, bbox } = analysisData.poi;
  return `${baseUrl}?lat=${lat}&lon=${lon}&zoom=${zoom}&bbox=${encodeURIComponent(bbox)}`;
}
function renderHeader() {
  const c = document.getElementById('header-card');
  c.innerHTML = `<div class="header-grid"><div class="brand"><h1>GeoNOXA / GeoNEXO</h1><small>Motor de Análisis de Pasivos Ambientales y Riesgos Territoriales</small><p>CARD PRO – ANÁLISIS TERRITORIAL DEL POI</p></div><div class="kpi-card"><h3>POI</h3><p>${analysisData.poi.name}</p><p>Lat/Lon: ${analysisData.poi.lat}, ${analysisData.poi.lon}</p><p>${analysisData.poi.comuna} · ${analysisData.poi.region}</p></div><div class="kpi-card"><h3>Estado general de riesgo</h3><span class="badge ${getRiskClass(analysisData.riesgo.nivel)}">${analysisData.riesgo.nivel}</span><div class="legend"><span class="badge risk-low">Bajo</span><span class="badge risk-medium">Medio</span><span class="badge risk-high">Alto</span><span class="badge risk-critical">Crítico</span></div></div></div>`;
}
function renderSummaryCards() {
  const s = document.getElementById('summary-strip');
  s.innerHTML = `
  <article class="mini-card family-zona"><h3>Zona Saturada</h3><p>${analysisData.zonaSaturada.nombre}</p><p>${analysisData.zonaSaturada.contaminante}</p><p>POI: ${analysisData.zonaSaturada.poiInOut} · ${formatKm(analysisData.zonaSaturada.distPerimetroKm)}</p></article>
  <article class="mini-card family-relave"><h3>Relave más cercano</h3><p>${analysisData.relave.nombre}</p><p>Distancia: ${formatKm(analysisData.relave.distPoiKm)}</p><p>Superficie: ${formatHa(analysisData.relave.superficieHa)}</p></article>
  <article class="mini-card family-urbana"><h3>Zona Urbana más cercana</h3><p>${analysisData.zonaUrbana.nombre}</p><p>Distancia: ${formatKm(analysisData.zonaUrbana.distPoiKm)}</p><p>Superficie PRC: ${formatHa(analysisData.zonaUrbana.superficieHa)}</p></article>
  <article class="mini-card"><h3>Índice de Sinergia</h3><p><strong>${analysisData.relaciones.triangular.indice}/100</strong></p><span class="badge ${getRiskClass(analysisData.riesgo.nivel)}">${analysisData.relaciones.triangular.sinergia}</span></article>`;
}
function table(title, data) {
  return `<p class="section-label">${title}</p><table class="data-table">${Object.entries(data).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
}
function renderGeojsonTables() {
  document.getElementById('geojson-tables').innerHTML =
    table('A) Zona Saturada', { Nombre: analysisData.zonaSaturada.nombre, 'Tipo / contaminante': analysisData.zonaSaturada.contaminante, Estado: analysisData.zonaSaturada.estado, 'Fuente / Decreto': analysisData.zonaSaturada.fuente, 'ID Feature': analysisData.zonaSaturada.featureId }) +
    table('B) Relave matchado', { Nombre: analysisData.relave.nombre, 'Empresa / faena': analysisData.relave.empresaFaena, 'Tipo de depósito': analysisData.relave.tipoDeposito, Recurso: analysisData.relave.recurso, 'Método constructivo': analysisData.relave.metodo, Superficie: formatHa(analysisData.relave.superficieHa), 'ID Feature': analysisData.relave.featureId }) +
    table('C) Zona Urbana / PRC', { Nombre: analysisData.zonaUrbana.nombre, Comuna: analysisData.zonaUrbana.comuna, Región: analysisData.zonaUrbana.region, 'Tipo instrumento': analysisData.zonaUrbana.instrumento, 'Superficie PRC': formatHa(analysisData.zonaUrbana.superficieHa), 'ID Feature': analysisData.zonaUrbana.featureId });
}
function renderGeometryCards() { /* condensed */
  const zDia = computeEquivalentDiameter(analysisData.zonaSaturada.superficieHa);
  const rDia = computeEquivalentDiameter(analysisData.relave.superficieHa);
  const html = [
    { t: 'A) Zona Saturada más cercana', c: 'family-zona', d: { 'Estado POI': analysisData.zonaSaturada.poiInOut, 'Dist. perímetro': formatKm(analysisData.zonaSaturada.distPerimetroKm), 'Dist. centroide': formatKm(analysisData.zonaSaturada.distCentroideKm), Superficie: formatHa(analysisData.zonaSaturada.superficieHa), 'Diám. equivalente': formatKm(zDia), Perímetro: formatKm(analysisData.zonaSaturada.perimetroKm), Centroide: analysisData.zonaSaturada.centroide.join(', ') } },
    { t: 'B) Relave matchado', c: 'family-relave', d: { 'Dist. POI-relave': formatKm(analysisData.relave.distPoiKm), Superficie: formatHa(analysisData.relave.superficieHa), 'Diám. equivalente': formatKm(rDia), Centroide: analysisData.relave.centroide.join(', '), 'Radio equivalente': formatKm(rDia / 2) } },
    { t: 'C) Zona Urbana más cercana', c: 'family-urbana', d: { 'Dist. centro urbano': formatKm(analysisData.zonaUrbana.distPoiKm), 'Superficie PRC': formatHa(analysisData.zonaUrbana.superficieHa), 'Dist. centroide urbano': formatKm(analysisData.zonaUrbana.distCentroideKm), 'Centroide urbano': analysisData.zonaUrbana.centroide.join(', ') } }
  ];
  document.getElementById('geometry-cards').innerHTML = `<div class="metric-grid">${html.map((x) => `<article class="metric-card ${x.c}"><h3>${x.t}</h3>${table('', x.d)}</article>`).join('')}</div>`;
}
function renderRelationshipCards() {
  const rc = document.getElementById('relationship-cards');
  const items = [
    ['A) POI ↔ Zona Saturada', { 'POI dentro/fuera': analysisData.zonaSaturada.poiInOut, 'Distancia al perímetro': formatKm(analysisData.zonaSaturada.distPerimetroKm), 'Distancia al centroide': formatKm(analysisData.zonaSaturada.distCentroideKm), 'Nivel de exposición': analysisData.relaciones.poiZona.exposicion }],
    ['B) POI ↔ Relave', { 'Distancia al relave': formatKm(analysisData.relave.distPoiKm), 'Relave más cercano': analysisData.relave.nombre, 'Superficie relave': formatHa(analysisData.relave.superficieHa), 'Nivel de exposición': analysisData.relaciones.poiRelave.exposicion }],
    ['C) Relave ↔ Zona Urbana', { 'Distancia a centro urbano': formatKm(analysisData.relaciones.relaveUrbana.distCentroKm), 'Distancia a perímetro urbano': formatKm(analysisData.relaciones.relaveUrbana.distPerimetroKm), 'Prioridad territorial': analysisData.relaciones.relaveUrbana.prioridad }],
    ['D) Zona Urbana ↔ Zona Saturada', { 'Distancia centro urbano - perímetro': formatKm(analysisData.relaciones.urbanaZona.distPerimetroKm), 'Distancia centro urbano - centroide': formatKm(analysisData.relaciones.urbanaZona.distCentroideKm), 'Urbano dentro/fuera': analysisData.relaciones.urbanaZona.inOut, 'Exposición indirecta': analysisData.relaciones.urbanaZona.exposicionIndirecta }]
  ];
  rc.innerHTML = items.map(([t, d]) => `<article class="metric-card"><h3>${t}</h3>${table('', d)}</article>`).join('');
}
function renderTriangularRelation() {
  document.getElementById('triangular-relation').innerHTML = table('Matriz triangular', {
    'Alineación geométrica': analysisData.relaciones.triangular.alineacion,
    'Sinergia territorial': analysisData.relaciones.triangular.sinergia,
    'Potencial de impacto': analysisData.relaciones.triangular.impacto
  });
}
function renderSynthesis() {
  document.getElementById('synthesis').innerHTML = `<p class="synthesis">El POI se encuentra ${analysisData.zonaSaturada.poiInOut === 'IN' ? 'dentro' : 'fuera'} de la zona saturada ${analysisData.zonaSaturada.nombre}, a ${formatKm(analysisData.zonaSaturada.distPerimetroKm)} de su perímetro. El relave matchado ${analysisData.relave.nombre} se ubica a ${formatKm(analysisData.relave.distPoiKm)} del POI y presenta una superficie de ${formatHa(analysisData.relave.superficieHa)}. La cercanía entre relave, zona urbana y área saturada configura una condición de riesgo ${analysisData.riesgo.nivel}. Se recomienda revisar el reporte completo y descargar el KML para análisis externo.</p>`;
}
function initMap() {
  const { lat, lon, zoom } = analysisData.poi;
  map = L.map('map').setView([lat, lon], zoom);
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles &copy; Esri' });
  L.control.layers({ OSM: osm, MapSAT: sat }).addTo(map);
  L.marker([lat, lon]).addTo(map).bindPopup('POI');
  L.circleMarker(analysisData.relave.centroide, { radius: 7, color: '#ff9f43' }).addTo(map).bindPopup('Relave');
  L.circleMarker(analysisData.zonaUrbana.centroide, { radius: 7, color: '#24d1ff' }).addTo(map).bindPopup('Centroide urbano');
  L.polygon(analysisData.zonaSaturada.polygon, { color: '#8e5dff', fillOpacity: 0.14 }).addTo(map).bindPopup('Zona Saturada');
  const relaveRadiusM = (computeEquivalentDiameter(analysisData.relave.superficieHa) * 1000) / 2;
  L.circle(analysisData.relave.centroide, { radius: relaveRadiusM, color: '#ff9f43', fillOpacity: 0.08 }).addTo(map);
  L.polyline([[lat, lon], analysisData.relave.centroide], { color: '#ff9f43', dashArray: '6 4' }).addTo(map);
  L.polyline([[lat, lon], analysisData.zonaUrbana.centroide], { color: '#24d1ff', dashArray: '6 4' }).addTo(map);
  L.polyline([[lat, lon], analysisData.zonaSaturada.centroide], { color: '#8e5dff', dashArray: '6 4' }).addTo(map);
  L.polyline([analysisData.relave.centroide, analysisData.zonaUrbana.centroide], { color: '#ffd166' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  const homeControl = L.control({ position: 'topleft' });
  homeControl.onAdd = () => {
    const b = L.DomUtil.create('button', 'leaflet-bar');
    b.textContent = 'Home';
    b.style.padding = '4px 8px';
    b.onclick = () => map.setView([lat, lon], zoom);
    return b;
  };
  homeControl.addTo(map);
  document.getElementById('map-legend').innerHTML = 'Leyenda: ● POI | ● Relave | ● Centroide Urbano | ▰ Zona Saturada | -- Relaciones';
}
function renderActions() {
  const a = document.getElementById('actions');
  a.innerHTML = `
    <button>Descargar KML</button>
    <button>Descargar PDF</button>
    <button>Ver reporte completo</button>
    <a href="${buildEcosystemUrl('https://example.com/geoipt')}" target="_blank" rel="noopener">Ir a GeoIPT</a>
    <a href="${buildEcosystemUrl('https://example.com/geoeva')}" target="_blank" rel="noopener">Ir a GeoEVA</a>
    <a href="${buildEcosystemUrl('https://example.com/geonemo')}" target="_blank" rel="noopener">Ir a GeoNEMO</a>`;
}

(function init() {
  renderHeader();
  renderSummaryCards();
  renderGeojsonTables();
  renderGeometryCards();
  renderRelationshipCards();
  renderTriangularRelation();
  renderSynthesis();
  renderActions();
  initMap();
})();
