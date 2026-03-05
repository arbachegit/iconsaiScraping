type Stylesheet = { selector: string; style: Record<string, any> };

const ENTITY_COLORS: Record<string, string> = {
  empresa: '#ef4444',
  pessoa: '#f97316',
  politico: '#3b82f6',
  mandato: '#a855f7',
  emenda: '#06b6d4',
  noticia: '#22c55e',
};

const ENTITY_SHAPES: Record<string, string> = {
  empresa: 'ellipse',
  pessoa: 'round-rectangle',
  politico: 'hexagon',
  mandato: 'diamond',
  emenda: 'star',
  noticia: 'diamond',
};

const EDGE_STYLES: Record<string, string> = {
  societaria: 'solid',
  fundador: 'solid',
  diretor: 'solid',
  fornecedor: 'dashed',
  empregado: 'dashed',
  emenda_beneficiario: 'dashed',
  mencionado_em: 'dotted',
  noticia_menciona: 'dotted',
};

function buildEntityStyles(): Stylesheet[] {
  return Object.entries(ENTITY_COLORS).map(([type, color]) => ({
    selector: `node[type="${type}"]`,
    style: {
      'background-color': color,
      shape: ENTITY_SHAPES[type] as any,
      label: 'data(label)',
      color: '#e5e7eb',
      'text-outline-color': '#111827',
      'text-outline-width': 2,
      'font-size': 11,
      'text-valign': 'bottom',
      'text-margin-y': 6,
      width: 40,
      height: 40,
      'border-width': 2,
      'border-color': color,
      'border-opacity': 0.6,
    },
  }));
}

function buildEdgeStyles(): Stylesheet[] {
  return Object.entries(EDGE_STYLES).map(([type, lineStyle]) => ({
    selector: `edge[tipo_relacao="${type}"]`,
    style: {
      'line-style': lineStyle as any,
      'line-color': '#6b7280',
      'target-arrow-color': '#6b7280',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      width: 1.5,
      opacity: 0.7,
    },
  }));
}

export const graphStylesheet: Stylesheet[] = [
  {
    selector: 'node',
    style: {
      'background-color': '#6b7280',
      label: 'data(label)',
      color: '#e5e7eb',
      'text-outline-color': '#111827',
      'text-outline-width': 2,
      'font-size': 11,
      'text-valign': 'bottom',
      'text-margin-y': 6,
      width: 40,
      height: 40,
    },
  },
  ...buildEntityStyles(),
  {
    selector: 'edge',
    style: {
      'line-color': '#6b7280',
      'target-arrow-color': '#6b7280',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      width: 1.5,
      opacity: 0.7,
    },
  },
  ...buildEdgeStyles(),
  {
    selector: 'node:active',
    style: {
      'border-width': 4,
      'border-color': '#ffffff',
      'z-index': 10,
    },
  },
  {
    selector: 'node:selected',
    style: {
      'border-width': 4,
      'border-color': '#facc15',
      'border-opacity': 1,
      'background-opacity': 1,
      'z-index': 20,
    },
  },
  {
    selector: 'edge:selected',
    style: {
      'line-color': '#facc15',
      'target-arrow-color': '#facc15',
      width: 3,
      opacity: 1,
    },
  },
];

export { ENTITY_COLORS, ENTITY_SHAPES, EDGE_STYLES };
