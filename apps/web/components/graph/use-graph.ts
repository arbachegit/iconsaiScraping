'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import cytoscape, { type Core, type EventObject } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import dagre from 'cytoscape-dagre';
import { graphStylesheet } from './styles';
import { getLayoutOptions } from './layouts';
import type { GraphNode, GraphEdge, GraphData, LayoutType } from './types';

let extensionsRegistered = false;

function registerExtensions(): void {
  if (extensionsRegistered) return;
  cytoscape.use(fcose);
  cytoscape.use(dagre);
  extensionsRegistered = true;
}

function toElements(data: GraphData) {
  const nodes = data.nodes.map((n) => ({
    data: {
      id: n.id,
      label: n.label,
      type: n.type,
      ...n.data,
    },
    position: n.x !== undefined && n.y !== undefined ? { x: n.x, y: n.y } : undefined,
  }));

  const edges = data.edges.map((e) => ({
    data: {
      id: e.id,
      source: e.source,
      target: e.target,
      tipo_relacao: e.tipo_relacao,
      strength: e.strength,
      confidence: e.confidence,
    },
  }));

  return [...nodes, ...edges];
}

export function useGraph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] });
  const [currentLayout, setCurrentLayout] = useState<LayoutType>('fcose');
  const [cyReady, setCyReady] = useState(false);

  // Create Cytoscape instance ONCE
  useEffect(() => {
    registerExtensions();
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      style: graphStylesheet,
      elements: [],
      minZoom: 0.1,
      maxZoom: 5,
    });

    cyRef.current = cy;
    setCyReady(true);

    cy.on('tap', 'node', (evt: EventObject) => {
      const nodeData = evt.target.data();
      setSelectedNode({
        id: nodeData.id,
        type: nodeData.type,
        label: nodeData.label,
        data: nodeData,
      });
    });

    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) {
        setSelectedNode(null);
      }
    });

    cy.on('cxttap', 'node', (evt: EventObject) => {
      const nodeData = evt.target.data();
      setSelectedNode({
        id: nodeData.id,
        type: nodeData.type,
        label: nodeData.label,
        data: nodeData,
      });
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
      setCyReady(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update elements when graphData changes (without recreating cy)
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !cyReady) return;

    // Clear and re-add all elements
    cy.elements().remove();

    if (graphData.nodes.length > 0) {
      cy.add(toElements(graphData));
      const layout = getLayoutOptions(currentLayout, graphData.nodes.length);
      cy.layout(layout).run();
    }
  }, [graphData, currentLayout, cyReady]);

  const addNodes = useCallback((nodes: GraphNode[], edges: GraphEdge[]) => {
    setGraphData((prev) => ({
      nodes: [
        ...prev.nodes,
        ...nodes.filter((n) => !prev.nodes.some((existing) => existing.id === n.id)),
      ],
      edges: [
        ...prev.edges,
        ...edges.filter((e) => !prev.edges.some((existing) => existing.id === e.id)),
      ],
    }));
  }, []);

  const removeNodes = useCallback((nodeIds: string[]) => {
    setGraphData((prev) => ({
      nodes: prev.nodes.filter((n) => !nodeIds.includes(n.id)),
      edges: prev.edges.filter(
        (e) => !nodeIds.includes(e.source) && !nodeIds.includes(e.target)
      ),
    }));
  }, []);

  const setLayout = useCallback((layout: LayoutType) => {
    setCurrentLayout(layout);
  }, []);

  const fitView = useCallback(() => {
    cyRef.current?.fit(undefined, 50);
  }, []);

  const expandNode = useCallback(
    async (nodeId: string) => {
      try {
        const res = await fetch(`/api/graph/expand/${nodeId}`);
        if (!res.ok) return;
        const data: GraphData = await res.json();
        addNodes(data.nodes, data.edges);
      } catch {
        // Silently fail - node expansion is optional
      }
    },
    [addNodes]
  );

  return {
    cy: cyRef.current,
    containerRef,
    addNodes,
    removeNodes,
    setLayout,
    fitView,
    selectedNode,
    setSelectedNode,
    expandNode,
    graphData,
    setGraphData,
    currentLayout,
  };
}
