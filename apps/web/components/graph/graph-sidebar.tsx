'use client';

import { useMemo } from 'react';
import type { Core } from 'cytoscape';
import { X, ExternalLink, Expand, Link2 } from 'lucide-react';
import type { GraphNode } from './types';
import { ENTITY_COLORS } from './styles';

interface GraphSidebarProps {
  node: GraphNode;
  cy: Core | null;
  onClose: () => void;
  onExpand: () => void;
}

interface Connection {
  id: string;
  label: string;
  type: string;
  relationship: string;
}

export function GraphSidebar({ node, cy, onClose, onExpand }: GraphSidebarProps) {
  const connections = useMemo<Connection[]>(() => {
    if (!cy) return [];

    const cyNode = cy.getElementById(node.id);
    if (!cyNode || cyNode.empty()) return [];

    return cyNode.connectedEdges().map((edge) => {
      const connectedNode =
        edge.source().id() === node.id ? edge.target() : edge.source();
      return {
        id: connectedNode.id(),
        label: connectedNode.data('label') || connectedNode.id(),
        type: connectedNode.data('type') || 'unknown',
        relationship: edge.data('tipo_relacao') || 'unknown',
      };
    });
  }, [cy, node.id]);

  const entityColor = ENTITY_COLORS[node.type] || '#6b7280';

  const dataEntries = useMemo(() => {
    if (!node.data) return [];
    const exclude = new Set(['id', 'label', 'type']);
    return Object.entries(node.data).filter(
      ([key]) => !exclude.has(key) && node.data![key] !== undefined && node.data![key] !== null
    );
  }, [node.data]);

  return (
    <div className="flex w-80 flex-col border-l border-cyan-500/10 bg-[#0f1629]">
      <div className="flex items-center justify-between border-b border-cyan-500/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <div
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: entityColor }}
          />
          <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
            {node.type}
          </span>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="border-b border-cyan-500/10 px-4 py-3">
          <h3 className="text-lg font-semibold text-white">{node.label}</h3>
          <p className="mt-1 text-xs text-slate-500">ID: {node.id}</p>
        </div>

        {dataEntries.length > 0 && (
          <div className="border-b border-cyan-500/10 px-4 py-3">
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
              Details
            </h4>
            <dl className="space-y-1.5">
              {dataEntries.map(([key, value]) => (
                <div key={key} className="flex justify-between gap-2">
                  <dt className="min-w-0 flex-shrink-0 text-xs text-slate-500">
                    {key.replace(/_/g, ' ')}
                  </dt>
                  <dd className="min-w-0 truncate text-right text-xs text-slate-300">
                    {String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div className="px-4 py-3">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
            Connections ({connections.length})
          </h4>
          {connections.length === 0 ? (
            <p className="text-xs text-slate-600">No connections found</p>
          ) : (
            <ul className="space-y-1.5">
              {connections.map((conn) => (
                <li
                  key={conn.id}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-cyan-500/5"
                >
                  <div
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: ENTITY_COLORS[conn.type] || '#6b7280' }}
                  />
                  <span className="min-w-0 flex-1 truncate text-slate-300">{conn.label}</span>
                  <span className="flex-shrink-0 text-slate-600">{conn.relationship}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex gap-2 border-t border-cyan-500/10 px-4 py-3">
        <button
          onClick={onExpand}
          className="flex flex-1 items-center justify-center gap-1.5 rounded bg-[#1a2332] px-3 py-2 text-xs text-slate-300 transition-colors hover:bg-slate-700"
        >
          <Expand size={14} />
          Expand
        </button>
        <a
          href={`/dashboard/${node.type}/${node.id}`}
          className="flex flex-1 items-center justify-center gap-1.5 rounded bg-[#1a2332] px-3 py-2 text-xs text-slate-300 transition-colors hover:bg-slate-700"
        >
          <ExternalLink size={14} />
          Open
        </a>
      </div>
    </div>
  );
}
