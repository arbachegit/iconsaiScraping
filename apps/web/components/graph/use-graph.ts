'use client';

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
import { ENTITY_COLORS } from './styles';
import type { GraphNode, GraphEdge, GraphData, GraphControls, ZoomLevel, RankingMetric } from './types';
import {
  degreeCentrality,
  betweennessCentrality,
  pageRank,
  shortestPath,
  egoNetwork,
  filterEdgesByThreshold,
  filterEdgesByDensity,
} from './graph-algorithms';

/* ── D3 refs ─────────────────────────────────────── */

interface D3Refs {
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null;
  simulation: d3.Simulation<GraphNode, GraphEdge> | null;
  zoom: d3.ZoomBehavior<SVGSVGElement, unknown> | null;
  g: d3.Selection<SVGGElement, unknown, null, undefined> | null;
  // Selection refs for reactive updates without rebuild
  linkSel: d3.Selection<SVGLineElement, GraphEdge, SVGGElement, unknown> | null;
  nodeSel: d3.Selection<SVGCircleElement, GraphNode, SVGGElement, unknown> | null;
  labelSel: d3.Selection<SVGTextElement, GraphNode, SVGGElement, unknown> | null;
  relLabelSel: d3.Selection<SVGTextElement, GraphNode, SVGGElement, unknown> | null;
  nodesData: GraphNode[];
  edgesData: GraphEdge[];
}

const EMPTY: D3Refs = {
  svg: null, simulation: null, zoom: null, g: null,
  linkSel: null, nodeSel: null, labelSel: null, relLabelSel: null,
  nodesData: [], edgesData: [],
};

/* ── Helpers ─────────────────────────────────────── */

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

function baseRadius(d: GraphNode): number {
  return isHub(d) ? 20 : 10;
}

function edgeId(e: GraphEdge): [string, string] {
  const s = typeof e.source === 'object' ? e.source.id : e.source;
  const t = typeof e.target === 'object' ? e.target.id : e.target;
  return [s, t];
}

/* ── Hook ────────────────────────────────────────── */

export function useGraph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const d3Ref = useRef<D3Refs>({ ...EMPTY });

  // Core data
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] });

  // ─── Control states ───
  const [radialDistance, setRadialDistance] = useState(1.5);
  const [frozen, setFrozen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>('detail');
  const [evidenceThreshold, setEvidenceThreshold] = useState(0);
  const [edgeDensityPercent, setEdgeDensityPercent] = useState(100);
  const [egoNodeId, setEgoNodeId] = useState<string | null>(null);
  const [egoHops, setEgoHops] = useState(2);
  const [highlightNodeId, setHighlightNodeId] = useState<string | null>(null);
  const [pathSourceId, setPathSourceId] = useState<string | null>(null);
  const [pathTargetId, setPathTargetId] = useState<string | null>(null);
  const [rankingMetric, setRankingMetric] = useState<RankingMetric>('none');
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [depthHops, setDepthHops] = useState(2);

  const toggleType = useCallback((type: string) => {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }, []);

  // ─── Computed: centrality ───
  const centralityMap = useMemo(() => {
    if (rankingMetric === 'none') return null;
    const { nodes, edges } = graphData;
    if (nodes.length === 0) return null;
    switch (rankingMetric) {
      case 'degree': return degreeCentrality(nodes, edges);
      case 'betweenness': return betweennessCentrality(nodes, edges);
      case 'pagerank': return pageRank(nodes, edges);
      default: return null;
    }
  }, [graphData, rankingMetric]);

  // ─── Computed: shortest path ───
  const pathNodeIds = useMemo<Set<string>>(() => {
    if (!pathSourceId || !pathTargetId) return new Set();
    const path = shortestPath(graphData.nodes, graphData.edges, pathSourceId, pathTargetId);
    return path ? new Set(path) : new Set();
  }, [graphData, pathSourceId, pathTargetId]);

  // ─── Computed: ego network ───
  const egoNodeIds = useMemo<Set<string> | null>(() => {
    if (!egoNodeId) return null;
    return egoNetwork(graphData.nodes, graphData.edges, egoNodeId, egoHops);
  }, [graphData, egoNodeId, egoHops]);

  // ─── Computed: edge visibility sets ───
  const thresholdVisibleEdges = useMemo(() => {
    if (evidenceThreshold <= 0) return null;
    return filterEdgesByThreshold(graphData.edges, evidenceThreshold);
  }, [graphData.edges, evidenceThreshold]);

  const densityVisibleEdges = useMemo(() => {
    if (edgeDensityPercent >= 100) return null;
    return filterEdgesByDensity(graphData.edges, edgeDensityPercent);
  }, [graphData.edges, edgeDensityPercent]);

  /* ═══════════════════════════════════════════════════
     D3 BUILD / REBUILD
     ═══════════════════════════════════════════════════ */

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    d3.select(container).select('svg').remove();
    if (d3Ref.current.simulation) d3Ref.current.simulation.stop();
    d3Ref.current = { ...EMPTY };

    if (graphData.nodes.length === 0) return;

    const rect = container.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 600;

    // Deep clone
    const nodes: GraphNode[] = graphData.nodes.map(n => ({ ...n, data: { ...n.data } }));
    const edges: GraphEdge[] = graphData.edges.map(e => ({
      ...e,
      source: typeof e.source === 'object' ? e.source.id : e.source,
      target: typeof e.target === 'object' ? e.target.id : e.target,
    }));

    const nodeIds = new Set(nodes.map(n => n.id));
    const validEdges = edges.filter(e => nodeIds.has(e.source as string) && nodeIds.has(e.target as string));

    const N = d3.map(nodes, d => d.id);
    const G = d3.map(nodes, d => d.type);
    const color = (type: string) => ENTITY_COLORS[type] || '#6b7280';

    // Forces
    const forceLink = d3.forceLink<GraphNode, GraphEdge>(validEdges)
      .id(({ index: i }) => N[i!])
      .distance(30 * radialDistance)
      .strength(1);
    const forceCharge = d3.forceManyBody<GraphNode>().strength(-30 * radialDistance);

    const simulation = d3.forceSimulation<GraphNode>(nodes)
      .force('link', forceLink)
      .force('charge', forceCharge)
      .force('center', d3.forceCenter(width / 2, height / 2));

    // SVG
    const svg = d3.select(container)
      .append('svg')
      .attr('width', '100%').attr('height', '100%')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .style('background', '#0a0e1a');

    // Defs: glow filter
    const defs = svg.append('defs');
    const filter = defs.append('filter').attr('id', 'glow');
    filter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'coloredBlur');
    const fm = filter.append('feMerge');
    fm.append('feMergeNode').attr('in', 'coloredBlur');
    fm.append('feMergeNode').attr('in', 'SourceGraphic');

    // Path highlight filter
    const pf = defs.append('filter').attr('id', 'path-glow');
    pf.append('feGaussianBlur').attr('stdDeviation', '5').attr('result', 'coloredBlur');
    const pfm = pf.append('feMerge');
    pfm.append('feMergeNode').attr('in', 'coloredBlur');
    pfm.append('feMergeNode').attr('in', 'SourceGraphic');

    const g = svg.append('g');

    // Zoom with semantic levels
    const zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 8])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
        const k = event.transform.k;
        const newLevel: ZoomLevel = k < 0.4 ? 'macro' : k < 1.2 ? 'intermediate' : 'detail';
        setZoomLevel(newLevel);

        // Semantic zoom: adjust labels visibility
        if (d3Ref.current.labelSel) {
          d3Ref.current.labelSel.attr('display', k < 0.4 ? 'none' : null);
          if (k >= 0.4 && k < 1.2) {
            // Intermediate: only hub labels
            d3Ref.current.labelSel.attr('display', d => isHub(d) ? null : 'none');
          }
        }
        if (d3Ref.current.relLabelSel) {
          d3Ref.current.relLabelSel.attr('display', k < 1.2 ? 'none' : null);
        }
        // Macro: density mode — smaller nodes
        if (d3Ref.current.nodeSel) {
          d3Ref.current.nodeSel.attr('r', d => baseRadius(d) * (k < 0.4 ? 0.6 : 1));
        }
      });

    svg.call(zoomBehavior);

    // ── Draw edges ──
    const linkSel = g.append('g').attr('class', 'links')
      .selectAll<SVGLineElement, GraphEdge>('line')
      .data(validEdges)
      .join('line')
      .attr('stroke', d => {
        const [s, t] = edgeId(d);
        const hubId = nodes.find(n => isHub(n))?.id || '';
        const nonHubId = s === hubId ? t : s;
        const nonHub = nodes.find(n => n.id === nonHubId);
        return color(nonHub?.type || '');
      })
      .attr('stroke-width', d => Math.max(0.6, (d.strength || 0.3) * 3))
      .attr('stroke-opacity', d => 0.2 + (d.strength || 0.3) * 0.5)
      .attr('stroke-dasharray', d => getStrokeDash(d.tipo_relacao));

    // ── Draw nodes ──
    const nodeSel = g.append('g').attr('class', 'nodes')
      .attr('stroke', '#fff').attr('stroke-width', 1.5)
      .selectAll<SVGCircleElement, GraphNode>('circle')
      .data(nodes).join('circle')
      .attr('r', d => baseRadius(d))
      .attr('fill', (d, i) => color(G[i]))
      .attr('fill-opacity', 0.85)
      .attr('stroke', (d, i) => color(G[i]))
      .attr('stroke-opacity', 0.6)
      .attr('cursor', 'pointer')
      .call(d3.drag<SVGCircleElement, GraphNode>()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null; d.fy = null;
        })
      );

    nodeSel.filter(d => isHub(d)).attr('filter', 'url(#glow)');
    nodeSel.append('title').text((d, i) => N[i]);

    // ── Labels ──
    const labelSel = g.append('g').attr('class', 'labels')
      .selectAll<SVGTextElement, GraphNode>('text')
      .data(nodes).join('text')
      .text(d => {
        const l = d.label || '';
        return l.length > 20 ? l.substring(0, 18) + '...' : l;
      })
      .attr('font-size', d => isHub(d) ? 11 : 9)
      .attr('fill', '#e5e7eb')
      .attr('text-anchor', 'middle')
      .attr('dy', d => baseRadius(d) + 12)
      .attr('paint-order', 'stroke')
      .attr('stroke', '#0a0e1a').attr('stroke-width', 3).attr('stroke-linejoin', 'round');

    // ── Relevance labels ──
    const relLabelSel = g.append('g').attr('class', 'relevance-labels')
      .selectAll<SVGTextElement, GraphNode>('text')
      .data(nodes.filter(d => d.data?.relevance != null))
      .join('text')
      .text(d => `${(d.data?.relevance as number) || 0}%`)
      .attr('font-size', 8).attr('font-weight', 600)
      .attr('fill', d => {
        const r = (d.data?.relevance as number) || 0;
        return r >= 80 ? '#4ade80' : r >= 50 ? '#facc15' : '#f87171';
      })
      .attr('text-anchor', 'start')
      .attr('dx', d => baseRadius(d) + 3).attr('dy', -2)
      .attr('paint-order', 'stroke')
      .attr('stroke', '#0a0e1a').attr('stroke-width', 2).attr('stroke-linejoin', 'round');

    // ── Click → select node ──
    nodeSel.on('click', (_event, d) => {
      setSelectedNode({ id: d.id, type: d.type, label: d.label, data: d.data });
    });

    // ── Double-click → ego network focus ──
    nodeSel.on('dblclick', (_event, d) => {
      setEgoNodeId(prev => prev === d.id ? null : d.id);
    });

    // ── Hover effects ──
    nodeSel
      .on('mouseenter', function (_event, d) {
        d3.select(this).transition().duration(150)
          .attr('r', baseRadius(d) * 1.3).attr('stroke-opacity', 1).attr('stroke-width', 3);

        const connectedIds = new Set<string>([d.id]);
        validEdges.forEach(e => {
          const [s, t] = edgeId(e);
          if (s === d.id) connectedIds.add(t);
          if (t === d.id) connectedIds.add(s);
        });

        linkSel.attr('stroke-opacity', l => {
          const [s, t] = edgeId(l);
          return s === d.id || t === d.id ? 0.9 : 0.15;
        }).attr('stroke-width', l => {
          const [s, t] = edgeId(l);
          return s === d.id || t === d.id ? 2.5 : 0.5;
        });
        nodeSel.attr('fill-opacity', n => connectedIds.has(n.id) ? 0.85 : 0.2);
        labelSel.attr('fill-opacity', n => connectedIds.has(n.id) ? 1 : 0.2);
        relLabelSel.attr('fill-opacity', n => connectedIds.has(n.id) ? 1 : 0.2);
      })
      .on('mouseleave', function () {
        nodeSel.transition().duration(150)
          .attr('r', d => baseRadius(d)).attr('stroke-opacity', 0.6).attr('stroke-width', 1.5).attr('fill-opacity', 0.85);
        labelSel.attr('fill-opacity', 1);
        relLabelSel.attr('fill-opacity', 1);
        linkSel.attr('stroke-opacity', d => 0.2 + (d.strength || 0.3) * 0.5)
          .attr('stroke-width', d => Math.max(0.6, (d.strength || 0.3) * 3));
      });

    svg.on('click', (event) => {
      if (event.target === svg.node()) setSelectedNode(null);
    });

    // ── Tick ──
    simulation.on('tick', () => {
      linkSel
        .attr('x1', d => (d.source as GraphNode).x!)
        .attr('y1', d => (d.source as GraphNode).y!)
        .attr('x2', d => (d.target as GraphNode).x!)
        .attr('y2', d => (d.target as GraphNode).y!);
      nodeSel.attr('cx', d => d.x!).attr('cy', d => d.y!);
      labelSel.attr('x', d => d.x!).attr('y', d => d.y!);
      relLabelSel.attr('x', d => d.x!).attr('y', d => d.y!);
    });

    d3Ref.current = { svg, simulation, zoom: zoomBehavior, g, linkSel, nodeSel, labelSel, relLabelSel, nodesData: nodes, edgesData: validEdges };

    return () => { simulation.stop(); d3.select(container).select('svg').remove(); };
  }, [graphData]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ═══ Reactive effects (no rebuild) ═══ */

  // Radial distance
  useEffect(() => {
    const { simulation } = d3Ref.current;
    if (!simulation) return;
    const lf = simulation.force('link') as d3.ForceLink<GraphNode, GraphEdge> | undefined;
    if (lf) lf.distance(30 * radialDistance);
    const cf = simulation.force('charge') as d3.ForceManyBody<GraphNode> | undefined;
    if (cf) cf.strength(-30 * radialDistance);
    if (!frozen) simulation.alpha(0.4).restart();
  }, [radialDistance, frozen]);

  // Evidence threshold + edge density → hide/show edges
  useEffect(() => {
    const { linkSel, edgesData } = d3Ref.current;
    if (!linkSel) return;
    linkSel.attr('display', d => {
      if (thresholdVisibleEdges && !thresholdVisibleEdges.has(d.id)) return 'none';
      if (densityVisibleEdges && !densityVisibleEdges.has(d.id)) return 'none';
      return null;
    });
  }, [thresholdVisibleEdges, densityVisibleEdges]);

  // Ego network focus → dim nodes outside ego
  useEffect(() => {
    const { nodeSel, linkSel, labelSel, relLabelSel } = d3Ref.current;
    if (!nodeSel) return;
    if (!egoNodeIds) {
      nodeSel.attr('fill-opacity', 0.85);
      labelSel?.attr('fill-opacity', 1);
      relLabelSel?.attr('fill-opacity', 1);
      linkSel?.attr('display', null); // reset (let threshold/density re-apply)
      return;
    }
    nodeSel.attr('fill-opacity', d => egoNodeIds.has(d.id) ? 0.85 : 0.08);
    labelSel?.attr('fill-opacity', d => egoNodeIds.has(d.id) ? 1 : 0.05);
    relLabelSel?.attr('fill-opacity', d => egoNodeIds.has(d.id) ? 1 : 0.05);
    linkSel?.attr('display', d => {
      const [s, t] = edgeId(d);
      return egoNodeIds.has(s) && egoNodeIds.has(t) ? null : 'none';
    });
  }, [egoNodeIds]);

  // Path finder highlight
  useEffect(() => {
    const { nodeSel, linkSel } = d3Ref.current;
    if (!nodeSel || !linkSel) return;
    if (pathNodeIds.size === 0) {
      nodeSel.attr('filter', d => isHub(d) ? 'url(#glow)' : null);
      linkSel.attr('stroke', d => {
        const [s, t] = edgeId(d);
        const hubId = d3Ref.current.nodesData.find(n => isHub(n))?.id || '';
        const nonHubId = s === hubId ? t : s;
        const nonHub = d3Ref.current.nodesData.find(n => n.id === nonHubId);
        return ENTITY_COLORS[nonHub?.type || ''] || '#6b7280';
      });
      return;
    }
    nodeSel.attr('filter', d => pathNodeIds.has(d.id) ? 'url(#path-glow)' : null)
      .attr('fill-opacity', d => pathNodeIds.has(d.id) ? 1 : 0.15);
    linkSel.attr('stroke', d => {
      const [s, t] = edgeId(d);
      return pathNodeIds.has(s) && pathNodeIds.has(t) ? '#fbbf24' : '#334155';
    }).attr('stroke-width', d => {
      const [s, t] = edgeId(d);
      return pathNodeIds.has(s) && pathNodeIds.has(t) ? 3 : 0.3;
    }).attr('stroke-opacity', d => {
      const [s, t] = edgeId(d);
      return pathNodeIds.has(s) && pathNodeIds.has(t) ? 1 : 0.1;
    });
  }, [pathNodeIds]);

  // Centrality → node radius
  useEffect(() => {
    const { nodeSel } = d3Ref.current;
    if (!nodeSel) return;
    if (!centralityMap) {
      nodeSel.attr('r', d => baseRadius(d));
      return;
    }
    nodeSel.attr('r', d => {
      const c = centralityMap.get(d.id) || 0;
      return baseRadius(d) + c * 12; // scale centrality to extra radius
    });
  }, [centralityMap]);

  // Smart search highlight
  useEffect(() => {
    const { nodeSel, labelSel, relLabelSel } = d3Ref.current;
    if (!nodeSel) return;
    if (!highlightNodeId) {
      nodeSel.attr('fill-opacity', 0.85);
      labelSel?.attr('fill-opacity', 1);
      relLabelSel?.attr('fill-opacity', 1);
      return;
    }
    // Dim everything except the highlighted node + neighbors
    const neighbors = new Set<string>([highlightNodeId]);
    d3Ref.current.edgesData.forEach(e => {
      const [s, t] = edgeId(e);
      if (s === highlightNodeId) neighbors.add(t);
      if (t === highlightNodeId) neighbors.add(s);
    });
    nodeSel.attr('fill-opacity', d => neighbors.has(d.id) ? 0.95 : 0.1);
    labelSel?.attr('fill-opacity', d => neighbors.has(d.id) ? 1 : 0.05);
    relLabelSel?.attr('fill-opacity', d => neighbors.has(d.id) ? 1 : 0.05);
  }, [highlightNodeId]);

  // Entity type filters → hide/show nodes by type
  useEffect(() => {
    const { nodeSel, linkSel, labelSel, relLabelSel } = d3Ref.current;
    if (!nodeSel) return;
    if (hiddenTypes.size === 0) {
      nodeSel.attr('display', null);
      labelSel?.attr('display', null);
      relLabelSel?.attr('display', null);
      linkSel?.attr('display', null);
      return;
    }
    nodeSel.attr('display', d => hiddenTypes.has(d.type) ? 'none' : null);
    labelSel?.attr('display', d => hiddenTypes.has(d.type) ? 'none' : null);
    relLabelSel?.attr('display', d => hiddenTypes.has(d.type) ? 'none' : null);
    linkSel?.attr('display', d => {
      const [s, t] = edgeId(d);
      const sNode = d3Ref.current.nodesData.find(n => n.id === s);
      const tNode = d3Ref.current.nodesData.find(n => n.id === t);
      if (sNode && hiddenTypes.has(sNode.type)) return 'none';
      if (tNode && hiddenTypes.has(tNode.type)) return 'none';
      return null;
    });
  }, [hiddenTypes]);

  // Depth filter → hide nodes beyond N hops
  useEffect(() => {
    const { nodeSel, linkSel, labelSel, relLabelSel } = d3Ref.current;
    if (!nodeSel) return;
    nodeSel.attr('display', d => {
      if (hiddenTypes.has(d.type)) return 'none';
      const hop = getNodeHop(d);
      if (hop !== null && hop > depthHops) return 'none';
      return null;
    });
    labelSel?.attr('display', d => {
      if (hiddenTypes.has(d.type)) return 'none';
      const hop = getNodeHop(d);
      if (hop !== null && hop > depthHops) return 'none';
      return null;
    });
    relLabelSel?.attr('display', d => {
      if (hiddenTypes.has(d.type)) return 'none';
      const hop = getNodeHop(d);
      if (hop !== null && hop > depthHops) return 'none';
      return null;
    });
    const visibleIds = new Set<string>();
    d3Ref.current.nodesData.forEach(d => {
      if (hiddenTypes.has(d.type)) return;
      const hop = getNodeHop(d);
      if (hop === null || hop <= depthHops) visibleIds.add(d.id);
    });
    linkSel?.attr('display', d => {
      const [s, t] = edgeId(d);
      return visibleIds.has(s) && visibleIds.has(t) ? null : 'none';
    });
  }, [depthHops, hiddenTypes]);

  /* ═══ Actions ═══ */

  const toggleFreeze = useCallback(() => {
    setFrozen(prev => {
      const { simulation } = d3Ref.current;
      if (!simulation) return prev;
      if (!prev) simulation.stop();
      else simulation.alpha(0.3).restart();
      return !prev;
    });
  }, []);

  const focusNode = useCallback((nodeId: string) => {
    setHighlightNodeId(nodeId);
    const { svg, zoom } = d3Ref.current;
    if (!svg || !zoom) return;
    const nd = d3Ref.current.nodesData.find(n => n.id === nodeId);
    if (!nd || nd.x == null || nd.y == null) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    svg.transition().duration(750).call(
      zoom.transform,
      d3.zoomIdentity.translate(rect.width / 2, rect.height / 2).scale(1.5).translate(-nd.x, -nd.y)
    );
  }, []);

  const clearHighlight = useCallback(() => setHighlightNodeId(null), []);

  const fitView = useCallback(() => {
    const { svg, zoom, g } = d3Ref.current;
    if (!svg || !zoom || !g) return;
    const container = containerRef.current;
    if (!container) return;
    const bounds = (g.node() as SVGGElement)?.getBBox();
    if (!bounds || bounds.width === 0) return;
    const rect = container.getBoundingClientRect();
    const pad = 40;
    const scale = Math.min((rect.width - pad * 2) / bounds.width, (rect.height - pad * 2) / bounds.height, 2);
    const tx = rect.width / 2 - (bounds.x + bounds.width / 2) * scale;
    const ty = rect.height / 2 - (bounds.y + bounds.height / 2) * scale;
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }, []);

  const zoomIn = useCallback(() => {
    const { svg, zoom } = d3Ref.current;
    if (svg && zoom) svg.transition().duration(300).call(zoom.scaleBy, 1.4);
  }, []);

  const zoomOut = useCallback(() => {
    const { svg, zoom } = d3Ref.current;
    if (svg && zoom) svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.4);
  }, []);

  const getConnections = useCallback((nodeId: string) => {
    return graphData.edges
      .filter(e => {
        const [s, t] = edgeId(e);
        return s === nodeId || t === nodeId;
      })
      .map(e => {
        const [s, t] = edgeId(e);
        const connectedId = s === nodeId ? t : s;
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

  // ─── Controls object ───
  const controls: GraphControls = useMemo(() => ({
    frozen, toggleFreeze,
    radialDistance, setRadialDistance,
    zoomLevel,
    evidenceThreshold, setEvidenceThreshold,
    edgeDensityPercent, setEdgeDensityPercent,
    hiddenTypes, toggleType,
    depthHops, setDepthHops,
    egoNodeId, egoHops, setEgoNodeId, setEgoHops,
    focusNode, highlightNodeId, clearHighlight,
    pathSourceId, pathTargetId, setPathSourceId, setPathTargetId, pathNodeIds,
    rankingMetric, setRankingMetric,
  }), [
    frozen, toggleFreeze, radialDistance, zoomLevel,
    evidenceThreshold, edgeDensityPercent,
    hiddenTypes, toggleType, depthHops,
    egoNodeId, egoHops, focusNode, highlightNodeId, clearHighlight,
    pathSourceId, pathTargetId, pathNodeIds, rankingMetric,
  ]);

  return {
    containerRef, fitView, zoomIn, zoomOut,
    selectedNode, setSelectedNode,
    graphData, setGraphData,
    getConnections,
    controls,
  };
}
