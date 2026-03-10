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
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function getGraphEntityId(node: Pick<GraphNode, 'id' | 'data'>): string {
  const raw = node.data?.entityId;
  if (typeof raw === 'string' && raw.trim() !== '') return raw;

  const idx = node.id.indexOf(':');
  return idx === -1 ? node.id : node.id.slice(idx + 1);
}
