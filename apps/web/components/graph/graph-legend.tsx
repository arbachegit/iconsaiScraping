'use client';

import { Info } from 'lucide-react';

interface GraphLegendProps {
  onInfoClick?: () => void;
}

export function GraphLegend({ onInfoClick }: GraphLegendProps) {
  return (
    <div className="absolute bottom-4 left-4 z-10">
      <button
        onClick={onInfoClick}
        className="relative flex items-center justify-center h-14 w-14 rounded-full bg-red-500/20 border-2 border-red-500/60 text-red-400 shadow-lg transition-all hover:bg-red-500/30 hover:scale-110"
        title="Legenda e indicadores do grafo"
        style={{ animation: 'beacon-pulse 2s ease-in-out infinite' }}
      >
        <Info size={28} />
      </button>
    </div>
  );
}
