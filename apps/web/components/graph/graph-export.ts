'use client';

import type { Core } from 'cytoscape';

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportPNG(cy: Core, filename = 'graph.png'): void {
  const pngData = cy.png({
    output: 'blob',
    bg: '#030712',
    full: true,
    scale: 2,
    maxWidth: 4096,
    maxHeight: 4096,
  });

  if (pngData instanceof Blob) {
    downloadBlob(pngData, filename);
  } else {
    const link = document.createElement('a');
    link.href = pngData as string;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

export function exportSVG(cy: Core, filename = 'graph.svg'): void {
  const svgData = (cy as any).svg({
    full: true,
    bg: '#030712',
  });

  const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  downloadBlob(blob, filename);
}
