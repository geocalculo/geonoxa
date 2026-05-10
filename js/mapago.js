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

  return {
    png: snapshot.toDataURL('image/png'),
    width: snapshot.width,
    height: snapshot.height
  };
}

async function exportPdfPro() {
  if (!window.jspdf?.jsPDF || !window.html2canvas) return;

  const printable = document.querySelector('.page-shell');
  const liveMap = document.getElementById('map');
  if (!printable || !liveMap) return;

  const mapImage = await generateStaticMapImage();
  if (!mapImage?.png) throw new Error('No fue posible generar imagen estática del mapa.');

  const exportRoot = printable.cloneNode(true);
  exportRoot.classList.add('pdf-export-root');

  const exportMap = exportRoot.querySelector('#map');
  if (exportMap) {
    const mapImg = document.createElement('img');
    mapImg.src = mapImage.png;
    mapImg.alt = 'Mapa GeoNOXA exportado';
    mapImg.style.display = 'block';
    mapImg.style.width = `${Math.round(mapImage.width)}px`;
    mapImg.style.height = `${Math.round(mapImage.height)}px`;
    mapImg.style.objectFit = 'fill';

    exportMap.innerHTML = '';
    exportMap.removeAttribute('data-leaflet-id');
    exportMap.className = '';
    exportMap.style.width = `${Math.round(mapImage.width)}px`;
    exportMap.style.height = `${Math.round(mapImage.height)}px`;
    exportMap.style.minHeight = `${Math.round(mapImage.height)}px`;
    exportMap.appendChild(mapImg);
  }

  document.body.classList.add('pdf-export-mode');
  document.body.appendChild(exportRoot);

  try {
    const canvas = await window.html2canvas(exportRoot, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
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