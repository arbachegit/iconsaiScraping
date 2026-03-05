'use client';

import { useState, useCallback } from 'react';
import type { Core } from 'cytoscape';
import {
  Network,
  GitBranch,
  Circle,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Download,
  Expand,
} from 'lucide-react';
import type { LayoutType } from './types';
import { exportPNG } from './graph-export';

interface GraphToolbarProps {
  cy: Core | null;
  currentLayout: LayoutType;
  onLayoutChange: (layout: LayoutType) => void;
  onFitView: () => void;
}

const layoutButtons: { type: LayoutType; icon: typeof Network; label: string }[] = [
  { type: 'fcose', icon: Network, label: 'Force-directed' },
  { type: 'dagre', icon: GitBranch, label: 'Hierarchical' },
  { type: 'concentric', icon: Circle, label: 'Radial' },
];

export function GraphToolbar({ cy, currentLayout, onLayoutChange, onFitView }: GraphToolbarProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleZoomIn = useCallback(() => {
    if (!cy) return;
    cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }, [cy]);

  const handleZoomOut = useCallback(() => {
    if (!cy) return;
    cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }, [cy]);

  const handleExport = useCallback(() => {
    if (!cy) return;
    exportPNG(cy);
  }, [cy]);

  const handleFullscreen = useCallback(() => {
    const container = document.querySelector('[data-graph-container]');
    if (!container) return;

    if (!isFullscreen) {
      container.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
    setIsFullscreen((prev) => !prev);
  }, [isFullscreen]);

  return (
    <div className="flex items-center gap-1 border-b border-gray-800 bg-gray-900 px-3 py-2">
      <div className="flex items-center gap-1 rounded-md border border-gray-700 bg-gray-800 p-0.5">
        {layoutButtons.map(({ type, icon: Icon, label }) => (
          <button
            key={type}
            onClick={() => onLayoutChange(type)}
            title={label}
            className={`rounded px-2 py-1.5 transition-colors ${
              currentLayout === type
                ? 'bg-gray-600 text-white'
                : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
            }`}
          >
            <Icon size={16} />
          </button>
        ))}
      </div>

      <div className="mx-2 h-5 w-px bg-gray-700" />

      <button
        onClick={handleZoomIn}
        title="Zoom in"
        className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
      >
        <ZoomIn size={16} />
      </button>
      <button
        onClick={handleZoomOut}
        title="Zoom out"
        className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
      >
        <ZoomOut size={16} />
      </button>
      <button
        onClick={onFitView}
        title="Fit view"
        className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
      >
        <Maximize2 size={16} />
      </button>

      <div className="mx-2 h-5 w-px bg-gray-700" />

      <button
        onClick={handleExport}
        title="Export PNG"
        className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
      >
        <Download size={16} />
      </button>
      <button
        onClick={handleFullscreen}
        title="Fullscreen"
        className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
      >
        <Expand size={16} />
      </button>
    </div>
  );
}
