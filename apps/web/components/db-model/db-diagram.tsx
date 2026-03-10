'use client';

import { useEffect, useRef } from 'react';
import cytoscape, {
  type Core,
  type ElementDefinition,
  type EventObject,
  type LayoutOptions,
} from 'cytoscape';
import dagre from 'cytoscape-dagre';
import type { DbModelRelationship, DbModelTableSummary } from '@/lib/api';

let dagreRegistered = false;

function registerDagre() {
  if (dagreRegistered) return;
  cytoscape.use(dagre);
  dagreRegistered = true;
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('pt-BR', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value);
}

function buildElements(
  tables: DbModelTableSummary[],
  relationships: DbModelRelationship[]
): ElementDefinition[] {
  const visibleTableIds = new Set(tables.map((table) => table.name));

  const nodes = tables.map((table) => ({
    data: {
      id: table.name,
      label: `${table.name}\n${formatCompactNumber(table.estimatedRowCount)} registros\n${table.columnCount} colunas`,
      domainLabel: table.domainLabel,
      color: table.domainColor,
    },
  }));

  const edges = relationships
    .filter(
      (relationship) =>
        visibleTableIds.has(relationship.sourceTable) &&
        visibleTableIds.has(relationship.targetTable)
    )
    .map((relationship) => ({
      data: {
        id: relationship.id,
        source: relationship.sourceTable,
        target: relationship.targetTable,
        label: relationship.sourceColumn,
      },
    }));

  return [...nodes, ...edges];
}

const stylesheet = [
  {
    selector: 'node',
    style: {
      shape: 'round-rectangle',
      width: 190,
      height: 92,
      padding: 12,
      label: 'data(label)',
      'text-wrap': 'wrap',
      'text-max-width': 170,
      'font-size': 11,
      'font-weight': 600,
      'text-valign': 'center',
      'text-halign': 'center',
      color: '#e2e8f0',
      'background-color': 'data(color)',
      'background-opacity': 0.16,
      'border-width': 2,
      'border-color': 'data(color)',
      'border-opacity': 0.8,
      'overlay-opacity': 0,
    },
  },
  {
    selector: 'edge',
    style: {
      width: 1.8,
      'curve-style': 'bezier',
      'line-color': '#475569',
      'target-arrow-color': '#475569',
      'target-arrow-shape': 'triangle',
      label: 'data(label)',
      'font-size': 9,
      color: '#94a3b8',
      'text-background-color': '#0f172a',
      'text-background-opacity': 0.9,
      'text-background-padding': 2,
      'text-margin-y': -6,
      'overlay-opacity': 0,
    },
  },
  {
    selector: 'node:selected',
    style: {
      'border-color': '#facc15',
      'border-width': 3,
      'background-opacity': 0.24,
      'shadow-blur': 24,
      'shadow-color': '#facc15',
      'shadow-opacity': 0.25,
    },
  },
  {
    selector: 'edge:selected',
    style: {
      'line-color': '#facc15',
      'target-arrow-color': '#facc15',
      width: 3,
    },
  },
];

interface DbDiagramProps {
  tables: DbModelTableSummary[];
  relationships: DbModelRelationship[];
  selectedTableName: string | null;
  onSelectTable: (tableName: string | null) => void;
  onOpenTableModal?: (tableName: string) => void;
}

export function DbDiagram({
  tables,
  relationships,
  selectedTableName,
  onSelectTable,
  onOpenTableModal,
}: DbDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  useEffect(() => {
    registerDagre();
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: stylesheet,
      minZoom: 0.2,
      maxZoom: 2.5,
      wheelSensitivity: 0.15,
    });

    cyRef.current = cy;

    cy.on('tap', 'node', (event: EventObject) => {
      const tableName = String(event.target.data('id'));
      onSelectTable(tableName);
      onOpenTableModal?.(tableName);
    });

    cy.on('tap', (event: EventObject) => {
      if (event.target === cy) {
        onSelectTable(null);
      }
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [onSelectTable, onOpenTableModal]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.elements().remove();

    if (tables.length === 0) return;

    cy.add(buildElements(tables, relationships));

    const layoutOptions: LayoutOptions = {
      name: 'dagre',
      rankDir: 'LR',
      fit: true,
      padding: 36,
      rankSep: 120,
      nodeSep: 50,
      edgeSep: 24,
      animate: false,
    };

    cy.layout(layoutOptions).run();
  }, [relationships, tables]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.elements().unselect();

    if (!selectedTableName) return;

    const node = cy.$id(selectedTableName);
    if (!node || node.empty()) return;

    node.select();
    cy.animate({
      fit: {
        eles: node.closedNeighborhood(),
        padding: 120,
      },
      duration: 350,
    });
  }, [selectedTableName]);

  return <div ref={containerRef} className="h-full w-full" />;
}
