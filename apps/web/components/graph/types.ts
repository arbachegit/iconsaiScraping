export type EntityType = string;

export type RelationshipType = string;

export interface GraphNode {
  id: string;
  type: EntityType;
  label: string;
  data?: Record<string, unknown>;
  // D3 simulation mutable fields
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  index?: number;
}

export interface GraphEdge {
  id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  tipo_relacao: RelationshipType;
  strength: number;
  confidence?: number;
  label?: string;
  created_at?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type ZoomLevel = 'macro' | 'intermediate' | 'detail';
export type RankingMetric = 'none' | 'degree' | 'betweenness' | 'pagerank';

/** All graph visualization controls exposed by use-graph */
export interface GraphControls {
  // Physics
  frozen: boolean;
  toggleFreeze: () => void;
  radialDistance: number;
  setRadialDistance: (v: number) => void;

  // Semantic zoom
  zoomLevel: ZoomLevel;

  // Evidence threshold (0-1)
  evidenceThreshold: number;
  setEvidenceThreshold: (v: number) => void;

  // Edge density (top %)
  edgeDensityPercent: number;
  setEdgeDensityPercent: (v: number) => void;

  // Entity type filters
  hiddenTypes: ReadonlySet<string>;
  toggleType: (type: string) => void;

  // Graph depth control (hops)
  depthHops: number;
  setDepthHops: (h: number) => void;

  // Ego network focus
  egoNodeId: string | null;
  egoHops: number;
  setEgoNodeId: (id: string | null) => void;
  setEgoHops: (h: number) => void;

  // Smart search / focus
  focusNode: (nodeId: string) => void;
  highlightNodeId: string | null;
  clearHighlight: () => void;

  // Path finder
  pathSourceId: string | null;
  pathTargetId: string | null;
  setPathSourceId: (id: string | null) => void;
  setPathTargetId: (id: string | null) => void;
  pathNodeIds: ReadonlySet<string>;

  // Node ranking
  rankingMetric: RankingMetric;
  setRankingMetric: (m: RankingMetric) => void;
}

export function getGraphEntityId(node: Pick<GraphNode, 'id' | 'data'>): string {
  const raw = node.data?.entityId;
  if (typeof raw === 'string' && raw.trim() !== '') return raw;

  const idx = node.id.indexOf(':');
  return idx === -1 ? node.id : node.id.slice(idx + 1);
}
