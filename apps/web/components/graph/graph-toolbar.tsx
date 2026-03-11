'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Expand,
  Database,
  Snowflake,
  Play,
  SlidersHorizontal,
  BarChart3,
} from 'lucide-react';

interface GraphToolbarProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  frozen?: boolean;
  onToggleFreeze?: () => void;
  controlsPanelOpen?: boolean;
  onToggleControlsPanel?: () => void;
  onStatsClick?: () => void;
}

export function GraphToolbar({
  onZoomIn, onZoomOut, onFitView,
  frozen, onToggleFreeze,
  controlsPanelOpen, onToggleControlsPanel,
  onStatsClick,
}: GraphToolbarProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleFullscreen = useCallback(() => {
    const container = document.querySelector('[data-graph-container]');
    if (!container) return;

    if (!isFullscreen) {
      container.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
    setIsFullscreen((prev) => !prev);
  }, [isFullscreen]);

  return (
    <div className="flex items-center gap-1 border-b border-cyan-500/10 bg-[#0f1629] px-3 py-2">
      <button
        onClick={onZoomIn}
        title="Zoom in"
        className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
      >
        <ZoomIn size={16} />
      </button>
      <button
        onClick={onZoomOut}
        title="Zoom out"
        className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
      >
        <ZoomOut size={16} />
      </button>
      <button
        onClick={onFitView}
        title="Fit view"
        className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
      >
        <Maximize2 size={16} />
      </button>

      <div className="mx-2 h-5 w-px bg-cyan-500/10" />

      {/* Freeze Physics */}
      {onToggleFreeze && (
        <button
          onClick={onToggleFreeze}
          title={frozen ? 'Descongelar layout' : 'Congelar layout'}
          className={`rounded p-1.5 transition-colors ${
            frozen
              ? 'bg-cyan-500/15 text-cyan-400'
              : 'text-slate-400 hover:bg-slate-800 hover:text-white'
          }`}
        >
          {frozen ? <Snowflake size={16} /> : <Play size={16} />}
        </button>
      )}

      {/* Controls Panel Toggle */}
      {onToggleControlsPanel && (
        <button
          onClick={onToggleControlsPanel}
          title="Painel de controles"
          className={`rounded p-1.5 transition-colors ${
            controlsPanelOpen
              ? 'bg-cyan-500/15 text-cyan-400'
              : 'text-slate-400 hover:bg-slate-800 hover:text-white'
          }`}
        >
          <SlidersHorizontal size={16} />
        </button>
      )}

      {/* Statistics Modal */}
      {onStatsClick && (
        <button
          onClick={onStatsClick}
          title="Estatisticas do grafo"
          className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
        >
          <BarChart3 size={16} />
        </button>
      )}

      <div className="mx-2 h-5 w-px bg-cyan-500/10" />

      <button
        onClick={handleFullscreen}
        title="Fullscreen"
        className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
      >
        <Expand size={16} />
      </button>

      <div className="mx-2 h-5 w-px bg-cyan-500/10" />

      <Link
        href="/db"
        title="Database"
        className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
      >
        <Database size={16} />
      </Link>
    </div>
  );
}
