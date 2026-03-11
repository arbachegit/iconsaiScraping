'use client';

import { useEffect, useState } from 'react';
import type { GraphData } from './types';
import { useGraph } from './use-graph';
import { GraphToolbar } from './graph-toolbar';
import { GraphControlsPanel } from './graph-controls-panel';

interface GraphCanvasProps {
  initialData?: GraphData;
  className?: string;
  onInfoClick?: () => void;
  onStatsClick?: () => void;
}

export function GraphCanvas({ initialData, className = '', onStatsClick }: GraphCanvasProps) {
  const {
    containerRef,
    fitView,
    zoomIn,
    zoomOut,
    setGraphData,
    controls,
  } = useGraph();

  const [controlsPanelOpen, setControlsPanelOpen] = useState(true);

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
          frozen={controls.frozen}
          onToggleFreeze={controls.toggleFreeze}
          controlsPanelOpen={controlsPanelOpen}
          onToggleControlsPanel={() => setControlsPanelOpen(prev => !prev)}
          onStatsClick={onStatsClick}
        />

        <div className="relative flex-1">
          <div
            ref={containerRef}
            className="absolute inset-0 cursor-grab active:cursor-grabbing"
            data-graph-container
          />

          {/* Floating Controls Panel */}
          {controlsPanelOpen && (
            <GraphControlsPanel
              controls={controls}
              nodes={initialData?.nodes || []}
              onClose={() => setControlsPanelOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
