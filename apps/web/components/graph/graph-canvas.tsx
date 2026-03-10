'use client';

import { useEffect } from 'react';
import { Orbit } from 'lucide-react';
import type { GraphData } from './types';
import { useGraph } from './use-graph';
import { GraphToolbar } from './graph-toolbar';
import { GraphSidebar } from './graph-sidebar';
import { GraphLegend } from './graph-legend';

interface GraphCanvasProps {
  initialData?: GraphData;
  className?: string;
  onInfoClick?: () => void;
}

export function GraphCanvas({ initialData, className = '', onInfoClick }: GraphCanvasProps) {
  const {
    containerRef,
    fitView,
    zoomIn,
    zoomOut,
    selectedNode,
    setSelectedNode,
    setGraphData,
    getConnections,
    radialDistance,
    setRadialDistance,
  } = useGraph();

  useEffect(() => {
    if (initialData) {
      setGraphData(initialData);
    }
  }, [initialData, setGraphData]);

  return (
    <div className={`relative flex h-full w-full bg-[#0a0e1a] ${className}`}>
      <div className="flex flex-1 flex-col">
        <GraphToolbar
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onFitView={fitView}
        />

        <div className="relative flex-1">
          <div
            ref={containerRef}
            className="absolute inset-0 cursor-grab active:cursor-grabbing"
            data-graph-container
          />

          {/* Radial distance control — top-right corner */}
          <div className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-lg border border-cyan-500/20 bg-[#0f1629]/90 px-3 py-2 backdrop-blur-sm">
            <Orbit size={14} className="flex-shrink-0 text-cyan-400" />
            <input
              type="range"
              min={0.3}
              max={6}
              step={0.1}
              value={radialDistance}
              onChange={(e) => setRadialDistance(parseFloat(e.target.value))}
              className="h-1 w-24 cursor-pointer appearance-none rounded-full bg-slate-700 accent-cyan-500 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400"
              title="Distancia radial dos nos"
            />
            <span className="min-w-[2rem] text-right text-[10px] font-medium tabular-nums text-slate-400">
              {radialDistance.toFixed(1)}x
            </span>
          </div>
        </div>

        <GraphLegend onInfoClick={onInfoClick} />
      </div>

      {selectedNode && (
        <GraphSidebar
          node={selectedNode}
          connections={getConnections(selectedNode.id)}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}
