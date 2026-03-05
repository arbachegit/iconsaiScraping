'use client';

import { useEffect, useCallback } from 'react';
import type { GraphData } from './types';
import { useGraph } from './use-graph';
import { GraphToolbar } from './graph-toolbar';
import { GraphSidebar } from './graph-sidebar';
import { GraphMinimap } from './graph-minimap';
import { GraphLegend } from './graph-legend';

interface GraphCanvasProps {
  initialData?: GraphData;
  className?: string;
}

export function GraphCanvas({ initialData, className = '' }: GraphCanvasProps) {
  const {
    cy,
    containerRef,
    setLayout,
    fitView,
    selectedNode,
    setSelectedNode,
    expandNode,
    setGraphData,
    currentLayout,
  } = useGraph();

  useEffect(() => {
    if (initialData) {
      setGraphData(initialData);
    }
  }, [initialData, setGraphData]);

  const handleResize = useCallback(() => {
    if (cy) {
      cy.resize();
      cy.fit(undefined, 50);
    }
  }, [cy]);

  useEffect(() => {
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [handleResize]);

  return (
    <div className={`relative flex h-full w-full bg-gray-950 ${className}`}>
      <div className="flex flex-1 flex-col">
        <GraphToolbar
          cy={cy}
          currentLayout={currentLayout}
          onLayoutChange={setLayout}
          onFitView={fitView}
        />

        <div ref={containerRef} className="flex-1 cursor-grab active:cursor-grabbing" />

        <GraphMinimap cy={cy} />
        <GraphLegend />
      </div>

      {selectedNode && (
        <GraphSidebar
          node={selectedNode}
          cy={cy}
          onClose={() => setSelectedNode(null)}
          onExpand={() => expandNode(selectedNode.id)}
        />
      )}
    </div>
  );
}
