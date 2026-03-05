'use client';

import { useRef, useEffect } from 'react';
import type { Core } from 'cytoscape';

interface GraphMinimapProps {
  cy: Core | null;
}

export function GraphMinimap({ cy }: GraphMinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!cy || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#1f2937';
      ctx.fillRect(0, 0, width, height);

      const bb = cy.elements().boundingBox();
      if (bb.w === 0 || bb.h === 0) return;

      const padding = 10;
      const scaleX = (width - padding * 2) / bb.w;
      const scaleY = (height - padding * 2) / bb.h;
      const scale = Math.min(scaleX, scaleY);

      const offsetX = padding + (width - padding * 2 - bb.w * scale) / 2;
      const offsetY = padding + (height - padding * 2 - bb.h * scale) / 2;

      cy.edges().forEach((edge) => {
        const sp = edge.source().position();
        const tp = edge.target().position();
        ctx.strokeStyle = '#4b5563';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo((sp.x - bb.x1) * scale + offsetX, (sp.y - bb.y1) * scale + offsetY);
        ctx.lineTo((tp.x - bb.x1) * scale + offsetX, (tp.y - bb.y1) * scale + offsetY);
        ctx.stroke();
      });

      cy.nodes().forEach((node) => {
        const pos = node.position();
        const x = (pos.x - bb.x1) * scale + offsetX;
        const y = (pos.y - bb.y1) * scale + offsetY;
        ctx.fillStyle = node.style('background-color') || '#6b7280';
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      });

      const ext = cy.extent();
      const vx = (ext.x1 - bb.x1) * scale + offsetX;
      const vy = (ext.y1 - bb.y1) * scale + offsetY;
      const vw = ext.w * scale;
      const vh = ext.h * scale;
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1;
      ctx.strokeRect(vx, vy, vw, vh);
    };

    draw();
    cy.on('render viewport', draw);

    return () => {
      cy.off('render viewport', draw as any);
    };
  }, [cy]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!cy || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const bb = cy.elements().boundingBox();
    if (bb.w === 0 || bb.h === 0) return;

    const padding = 10;
    const scaleX = (canvas.width - padding * 2) / bb.w;
    const scaleY = (canvas.height - padding * 2) / bb.h;
    const scale = Math.min(scaleX, scaleY);

    const offsetX = padding + (canvas.width - padding * 2 - bb.w * scale) / 2;
    const offsetY = padding + (canvas.height - padding * 2 - bb.h * scale) / 2;

    const graphX = (x - offsetX) / scale + bb.x1;
    const graphY = (y - offsetY) / scale + bb.y1;

    cy.pan({
      x: cy.width() / 2 - graphX * cy.zoom(),
      y: cy.height() / 2 - graphY * cy.zoom(),
    });
  };

  return (
    <div className="absolute bottom-3 right-3 overflow-hidden rounded border border-gray-700 bg-gray-900/90 shadow-lg">
      <canvas
        ref={canvasRef}
        width={160}
        height={100}
        onClick={handleClick}
        className="cursor-pointer"
      />
    </div>
  );
}
