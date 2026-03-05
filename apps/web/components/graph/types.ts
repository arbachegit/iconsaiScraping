export type EntityType =
  | 'empresa'
  | 'pessoa'
  | 'politico'
  | 'mandato'
  | 'emenda'
  | 'noticia';

export type RelationshipType =
  | 'societaria'
  | 'fundador'
  | 'diretor'
  | 'fornecedor'
  | 'empregado'
  | 'emenda_beneficiario'
  | 'mencionado_em'
  | 'noticia_menciona';

export type LayoutType = 'fcose' | 'dagre' | 'concentric';

export interface GraphNode {
  id: string;
  type: EntityType;
  label: string;
  data?: Record<string, unknown>;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  tipo_relacao: RelationshipType;
  strength: number;
  confidence?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphFilters {
  entityTypes: EntityType[];
  relationshipTypes: RelationshipType[];
  minStrength: number;
  timeRange?: {
    start: string;
    end: string;
  };
}

export const ENTITY_TYPES: EntityType[] = [
  'empresa',
  'pessoa',
  'politico',
  'mandato',
  'emenda',
  'noticia',
];

export const RELATIONSHIP_TYPES: RelationshipType[] = [
  'societaria',
  'fundador',
  'diretor',
  'fornecedor',
  'empregado',
  'emenda_beneficiario',
  'mencionado_em',
  'noticia_menciona',
];
