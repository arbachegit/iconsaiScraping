'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import * as d3 from 'd3';
import { ENTITY_COLORS } from './styles';
import type { GraphNode, GraphEdge, GraphData } from './types';

interface D3GraphRef {
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null;
  simulation: d3.Simulation<GraphNode, GraphEdge> | null;
  zoom: d3.ZoomBehavior<SVGSVGElement, unknown> | null;
  g: d3.Selection<SVGGElement, unknown, null, undefined> | null;
}

function getStrokeDash(tipo: string): string {
  if (tipo === 'fornecedor' || tipo === 'empregado' || tipo === 'emenda_beneficiario') return '6,3';
  if (tipo === 'mencionado_em' || tipo === 'noticia_menciona') return '2,3';
  return 'none';
}

function getNodeHop(node: GraphNode): number | null {
  const hop = node.data?.hop;
  return typeof hop === 'number' ? hop : null;
}

function isHub(d: GraphNode): boolean {
  return getNodeHop(d) === 0;
}

function getNodeRadius(d: GraphNode): number {
  return isHub(d) ? 20 : 10;
}

export function useGraph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const d3Ref = useRef<D3GraphRef>({ svg: null, simulation: null, zoom: null, g: null });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] });
  const [radialDistance, setRadialDistance] = useState(1.5);

  // Build/rebuild D3 ForceGraph when graphData changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Clear previous
    d3.select(container).select('svg').remove();
    if (d3Ref.current.simulation) {
      d3Ref.current.simulation.stop();
    }

    if (graphData.nodes.length === 0) return;

    const rect = container.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 600;

    // Deep clone so D3 can mutate
    const nodes: GraphNode[] = graphData.nodes.map(n => ({ ...n, data: { ...n.data } }));
    const edges: GraphEdge[] = graphData.edges.map(e => ({
      ...e,
      source: typeof e.source === 'object' ? e.source.id : e.source,
      target: typeof e.target === 'object' ? e.target.id : e.target,
    }));

    // Filter edges to only those whose source+target exist in nodes
    const nodeIds = new Set(nodes.map(n => n.id));
    const validEdges = edges.filter(e => nodeIds.has(e.source as string) && nodeIds.has(e.target as string));

    // ── D3 ForceGraph model ──
    const N = d3.map(nodes, d => d.id);
    const G = d3.map(nodes, d => d.type);

    const forceNode = d3.forceManyBody<GraphNode>().strength(-30);
    const forceLink = d3.forceLink<GraphNode, GraphEdge>(validEdges)
      .id(({ index: i }) => N[i!])
      .strength(1);

    const simulation = d3.forceSimulation<GraphNode>(nodes)
      .force('link', forceLink)
      .force('charge', forceNode)
      .force('center', d3.forceCenter(width / 2, height / 2));

    // SVG
    const svg = d3.select(container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .style('background', '#0a0e1a');

    // SVG filter for glow
    const defs = svg.append('defs');
    const filter = defs.append('filter').attr('id', 'glow');
    filter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'coloredBlur');
    const feMerge = filter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'coloredBlur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Zoom group
    const g = svg.append('g');

    const zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 6])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    svg.call(zoomBehavior);

    // Color by entity type
    const color = (type: string) => ENTITY_COLORS[type] || '#6b7280';

    // Draw edges
    const link = g.append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(validEdges)
      .join('line')
      .attr('stroke', d => {
        const src = typeof d.source === 'string' ? d.source : d.source.id;
        const tgt = typeof d.target === 'string' ? d.target : d.target.id;
        const hubId = nodes.find(n => isHub(n))?.id || '';
        const nonHubId = src === hubId ? tgt : src;
        const nonHub = nodes.find(n => n.id === nonHubId);
        return color(nonHub?.type || '');
      })
      .attr('stroke-width', d => Math.max(0.6, (d.strength || 0.3) * 3))
      .attr('stroke-opacity', d => 0.2 + (d.strength || 0.3) * 0.5)
      .attr('stroke-dasharray', d => getStrokeDash(d.tipo_relacao));

    // Draw nodes
    const node = g.append('g')
      .attr('class', 'nodes')
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .selectAll<SVGCircleElement, GraphNode>('circle')
      .data(nodes)
      .join('circle')
      .attr('r', d => getNodeRadius(d))
      .attr('fill', (d, i) => color(G[i]))
      .attr('fill-opacity', 0.85)
      .attr('stroke', (d, i) => color(G[i]))
      .attr('stroke-opacity', 0.6)
      .attr('cursor', 'pointer')
      .call(d3.drag<SVGCircleElement, GraphNode>()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
      );

    // Glow for hub node
    node.filter(d => isHub(d))
      .attr('filter', 'url(#glow)');

    // Node titles (tooltip)
    node.append('title')
      .text((d, i) => N[i]);

    // Node labels
    const labels = g.append('g')
      .attr('class', 'labels')
      .selectAll<SVGTextElement, GraphNode>('text')
      .data(nodes)
      .join('text')
      .text(d => {
        const label = d.label || '';
        return label.length > 20 ? label.substring(0, 18) + '...' : label;
      })
      .attr('font-size', d => isHub(d) ? 11 : 9)
      .attr('fill', '#e5e7eb')
      .attr('text-anchor', 'middle')
      .attr('dy', d => getNodeRadius(d) + 12)
      .attr('paint-order', 'stroke')
      .attr('stroke', '#0a0e1a')
      .attr('stroke-width', 3)
      .attr('stroke-linejoin', 'round');

    // Relevance labels (shown beside the dot when data.relevance exists)
    const relevanceLabels = g.append('g')
      .attr('class', 'relevance-labels')
      .selectAll<SVGTextElement, GraphNode>('text')
      .data(nodes.filter(d => d.data?.relevance != null))
      .join('text')
      .text(d => {
        const rel = (d.data?.relevance as number) || 0;
        return `${rel}%`;
      })
      .attr('font-size', 8)
      .attr('font-weight', 600)
      .attr('fill', d => {
        const rel = (d.data?.relevance as number) || 0;
        if (rel >= 80) return '#4ade80'; // green
        if (rel >= 50) return '#facc15'; // yellow
        return '#f87171'; // red
      })
      .attr('text-anchor', 'start')
      .attr('dx', d => getNodeRadius(d) + 3)
      .attr('dy', -2)
      .attr('paint-order', 'stroke')
      .attr('stroke', '#0a0e1a')
      .attr('stroke-width', 2)
      .attr('stroke-linejoin', 'round');

    // Click handler
    node.on('click', (_event, d) => {
      setSelectedNode({
        id: d.id,
        type: d.type,
        label: d.label,
        data: d.data,
      });
    });

    // Hover effects
    node
      .on('mouseenter', function (_event, d) {
        d3.select(this)
          .transition().duration(150)
          .attr('r', getNodeRadius(d) * 1.3)
          .attr('stroke-opacity', 1)
          .attr('stroke-width', 3);

        // Highlight connected edges
        link.attr('stroke-opacity', l => {
          const src = typeof l.source === 'object' ? l.source.id : l.source;
          const tgt = typeof l.target === 'object' ? l.target.id : l.target;
          return src === d.id || tgt === d.id ? 0.9 : 0.15;
        }).attr('stroke-width', l => {
          const src = typeof l.source === 'object' ? l.source.id : l.source;
          const tgt = typeof l.target === 'object' ? l.target.id : l.target;
          return src === d.id || tgt === d.id ? 2.5 : 0.5;
        });

        // Dim unconnected nodes
        const connectedIds = new Set<string>();
        connectedIds.add(d.id);
        validEdges.forEach(e => {
          const src = typeof e.source === 'object' ? e.source.id : e.source;
          const tgt = typeof e.target === 'object' ? e.target.id : e.target;
          if (src === d.id) connectedIds.add(tgt);
          if (tgt === d.id) connectedIds.add(src);
        });

        node.attr('fill-opacity', n => connectedIds.has(n.id) ? 0.85 : 0.2);
        labels.attr('fill-opacity', n => connectedIds.has(n.id) ? 1 : 0.2);
        relevanceLabels.attr('fill-opacity', n => connectedIds.has(n.id) ? 1 : 0.2);
      })
      .on('mouseleave', function () {
        node
          .transition().duration(150)
          .attr('r', d => getNodeRadius(d))
          .attr('stroke-opacity', 0.6)
          .attr('stroke-width', 1.5)
          .attr('fill-opacity', 0.85);

        labels.attr('fill-opacity', 1);
        relevanceLabels.attr('fill-opacity', 1);

        link.attr('stroke-opacity', d => 0.2 + (d.strength || 0.3) * 0.5)
          .attr('stroke-width', d => Math.max(0.6, (d.strength || 0.3) * 3));
      });

    // Background click to deselect
    svg.on('click', (event) => {
      if (event.target === svg.node()) {
        setSelectedNode(null);
      }
    });

    // Tick
    simulation.on('tick', () => {
      link
        .attr('x1', d => (d.source as GraphNode).x!)
        .attr('y1', d => (d.source as GraphNode).y!)
        .attr('x2', d => (d.target as GraphNode).x!)
        .attr('y2', d => (d.target as GraphNode).y!);

      node
        .attr('cx', d => d.x!)
        .attr('cy', d => d.y!);

      labels
        .attr('x', d => d.x!)
        .attr('y', d => d.y!);

      relevanceLabels
        .attr('x', d => d.x!)
        .attr('y', d => d.y!);
    });

    d3Ref.current = { svg, simulation, zoom: zoomBehavior, g };

    return () => {
      simulation.stop();
      d3.select(container).select('svg').remove();
    };
  }, [graphData]);

  // Update forces when radialDistance changes (adjusts link distance)
  useEffect(() => {
    const { simulation } = d3Ref.current;
    if (!simulation) return;

    const linkForce = simulation.force('link') as d3.ForceLink<GraphNode, GraphEdge> | undefined;
    if (linkForce) {
      linkForce.distance(30 * radialDistance);
    }

    const chargeForce = simulation.force('charge') as d3.ForceManyBody<GraphNode> | undefined;
    if (chargeForce) {
      chargeForce.strength(-30 * radialDistance);
    }

    simulation.alpha(0.4).restart();
  }, [radialDistance]);

  const fitView = useCallback(() => {
    const { svg, zoom, g } = d3Ref.current;
    if (!svg || !zoom || !g) return;

    const container = containerRef.current;
    if (!container) return;

    const bounds = (g.node() as SVGGElement)?.getBBox();
    if (!bounds || bounds.width === 0) return;

    const rect = container.getBoundingClientRect();
    const padding = 40;

    const scale = Math.min(
      (rect.width - padding * 2) / bounds.width,
      (rect.height - padding * 2) / bounds.height,
      2
    );

    const translateX = rect.width / 2 - (bounds.x + bounds.width / 2) * scale;
    const translateY = rect.height / 2 - (bounds.y + bounds.height / 2) * scale;

    svg.transition().duration(500).call(
      zoom.transform,
      d3.zoomIdentity.translate(translateX, translateY).scale(scale)
    );
  }, []);

  const zoomIn = useCallback(() => {
    const { svg, zoom } = d3Ref.current;
    if (!svg || !zoom) return;
    svg.transition().duration(300).call(zoom.scaleBy, 1.4);
  }, []);

  const zoomOut = useCallback(() => {
    const { svg, zoom } = d3Ref.current;
    if (!svg || !zoom) return;
    svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.4);
  }, []);

  const getConnections = useCallback((nodeId: string) => {
    return graphData.edges
      .filter(e => {
        const src = typeof e.source === 'object' ? e.source.id : e.source;
        const tgt = typeof e.target === 'object' ? e.target.id : e.target;
        return src === nodeId || tgt === nodeId;
      })
      .map(e => {
        const src = typeof e.source === 'object' ? e.source.id : e.source;
        const tgt = typeof e.target === 'object' ? e.target.id : e.target;
        const connectedId = src === nodeId ? tgt : src;
        const connectedNode = graphData.nodes.find(n => n.id === connectedId);
        return {
          id: connectedId,
          label: connectedNode?.label || `#${connectedId}`,
          type: connectedNode?.type || 'unknown',
          relationship: e.tipo_relacao,
          strength: typeof e.strength === 'number' ? e.strength : null,
          evidence: typeof e.label === 'string' && e.label.trim() !== '' ? e.label : null,
        };
      });
  }, [graphData]);

  return {
    containerRef,
    fitView,
    zoomIn,
    zoomOut,
    selectedNode,
    setSelectedNode,
    graphData,
    setGraphData,
    getConnections,
    radialDistance,
    setRadialDistance,
  };
}
