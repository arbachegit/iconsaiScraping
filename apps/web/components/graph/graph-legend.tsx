'use client';

import { useState } from 'react';
import { Info } from 'lucide-react';
import { ENTITY_COLORS, EDGE_STYLES } from './styles';

const ENTITY_LABELS: Record<string, string> = {
  empresa: 'Empresa',
  pessoa: 'Pessoa',
  politico: 'Politico',
  mandato: 'Mandato',
  emenda: 'Emenda',
  noticia: 'Noticia',
};

const ENTITY_SHAPE_LABELS: Record<string, string> = {
  empresa: 'Circle',
  pessoa: 'Rounded Rect',
  politico: 'Hexagon',
  mandato: 'Diamond',
  emenda: 'Star',
  noticia: 'Diamond',
};

const EDGE_STYLE_LABELS: Record<string, string[]> = {
  solid: ['Societaria', 'Fundador', 'Diretor'],
  dashed: ['Fornecedor', 'Empregado', 'Beneficiario'],
  dotted: ['Mencionado', 'Noticia menciona'],
};

export function GraphLegend() {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div className="absolute bottom-3 left-3">
      <button
        onClick={() => setIsVisible((prev) => !prev)}
        className="rounded bg-[#0f1629]/90 p-1.5 text-slate-400 shadow-lg transition-colors hover:text-white"
        title="Toggle legend"
      >
        <Info size={16} />
      </button>

      {isVisible && (
        <div className="mt-1 rounded border border-cyan-500/20 bg-[#0f1629]/95 px-3 py-2.5 shadow-xl">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
            Entities
          </h4>
          <div className="mb-3 space-y-1">
            {Object.entries(ENTITY_COLORS).map(([type, color]) => (
              <div key={type} className="flex items-center gap-2 text-xs">
                <div
                  className="h-3 w-3 flex-shrink-0 rounded-sm"
                  style={{ backgroundColor: color }}
                />
                <span className="text-slate-300">{ENTITY_LABELS[type]}</span>
                <span className="text-slate-600">({ENTITY_SHAPE_LABELS[type]})</span>
              </div>
            ))}
          </div>

          <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
            Edges
          </h4>
          <div className="space-y-1">
            {Object.entries(EDGE_STYLE_LABELS).map(([style, labels]) => (
              <div key={style} className="flex items-center gap-2 text-xs">
                <svg width="24" height="8" className="flex-shrink-0">
                  <line
                    x1="0"
                    y1="4"
                    x2="24"
                    y2="4"
                    stroke="#94a3b8"
                    strokeWidth="2"
                    strokeDasharray={
                      style === 'dashed' ? '4,3' : style === 'dotted' ? '1,3' : undefined
                    }
                  />
                </svg>
                <span className="text-slate-300">{labels.join(', ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
