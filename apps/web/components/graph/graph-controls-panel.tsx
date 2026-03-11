'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import {
  Snowflake, Play, SlidersHorizontal, Target,
  Route, BarChart3, Crosshair, X, Orbit,
  Eye, GitBranch, Layers, GripHorizontal,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { ENTITY_COLORS, ENTITY_LABELS } from './styles';
import type { GraphControls, GraphNode, RankingMetric } from './types';

interface GraphControlsPanelProps {
  controls: GraphControls;
  nodes: GraphNode[];
  onClose: () => void;
}

/* ── Slider row ── */
function SliderRow({ label, value, min, max, step, onChange, displayValue }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; displayValue?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-400">{label}</span>
        <span className="text-[10px] font-medium tabular-nums text-cyan-400">{displayValue ?? value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-cyan-500 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400"
      />
    </div>
  );
}

/* ── Collapsible section ── */
function Section({ title, icon, defaultOpen = true, children }: {
  title: string; icon: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(p => !p)}
        className="flex w-full items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500 hover:text-slate-300 transition-colors"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {icon}
        {title}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   FLOATING CONTROLS PANEL (draggable)
   ═══════════════════════════════════════════════ */

export function GraphControlsPanel({ controls, nodes, onClose }: GraphControlsPanelProps) {
  const {
    frozen, toggleFreeze,
    radialDistance, setRadialDistance,
    evidenceThreshold, setEvidenceThreshold,
    edgeDensityPercent, setEdgeDensityPercent,
    hiddenTypes, toggleType,
    depthHops, setDepthHops,
    egoNodeId, egoHops, setEgoNodeId, setEgoHops,
    pathSourceId, pathTargetId, setPathSourceId, setPathTargetId, pathNodeIds,
    rankingMetric, setRankingMetric,
    zoomLevel,
  } = controls;

  // ── Drag logic ──
  const [pos, setPos] = useState({ x: 16, y: 16 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('[data-drag-handle]')) return;
    dragging.current = true;
    dragStart.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setPos({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
    };
    const onUp = () => { dragging.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  // Counts
  const typeCounts: Record<string, number> = {};
  for (const n of nodes) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;

  const rankOptions: { value: RankingMetric; label: string }[] = [
    { value: 'none', label: 'Nenhum' },
    { value: 'degree', label: 'Grau (Degree)' },
    { value: 'betweenness', label: 'Intermediacao (Betweenness)' },
    { value: 'pagerank', label: 'PageRank' },
  ];

  const entityTypes = Object.keys(ENTITY_COLORS);

  return (
    <div
      className="absolute z-40"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={handleMouseDown}
    >
      <div className="w-64 max-h-[80vh] flex flex-col rounded-xl border border-cyan-500/20 bg-[#0f1629]/95 shadow-2xl backdrop-blur-md overflow-hidden">
        {/* ── Drag Handle / Header ── */}
        <div
          data-drag-handle
          className="flex items-center justify-between px-3 py-2 border-b border-cyan-500/10 flex-shrink-0 cursor-grab active:cursor-grabbing select-none"
        >
          <div className="flex items-center gap-1.5">
            <GripHorizontal size={12} className="text-slate-600" />
            <SlidersHorizontal size={12} className="text-cyan-400" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Controles</span>
          </div>
          <button onClick={onClose} className="rounded p-0.5 text-slate-500 hover:text-white transition-colors">
            <X size={12} />
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="overflow-y-auto flex-1 px-3 py-2 space-y-3">

          {/* 1. SEMANTIC ZOOM */}
          <Section title="Zoom Semantico" icon={<Layers size={10} />}>
            <div className="flex gap-1">
              {(['macro', 'intermediate', 'detail'] as const).map(level => (
                <span
                  key={level}
                  className={`flex-1 text-center text-[9px] rounded py-0.5 ${
                    zoomLevel === level ? 'bg-cyan-500/20 text-cyan-400 font-semibold' : 'bg-slate-800/40 text-slate-600'
                  }`}
                >
                  {level === 'macro' ? 'Macro' : level === 'intermediate' ? 'Inter' : 'Detalhe'}
                </span>
              ))}
            </div>
            <p className="mt-1 text-[8px] text-slate-600 leading-tight">
              Macro: clusters | Inter: hubs | Detalhe: tudo visivel
            </p>
          </Section>

          {/* 2. EVIDENCE THRESHOLD */}
          <Section title="Limiar de Evidencia" icon={<span className="text-[10px]">%</span>}>
            <SliderRow
              label="Probabilidade minima"
              value={evidenceThreshold}
              min={0} max={1} step={0.05}
              onChange={setEvidenceThreshold}
              displayValue={`${Math.round(evidenceThreshold * 100)}%`}
            />
          </Section>

          {/* 3. ENTITY TYPE FILTERS */}
          <Section title="Filtro de Entidades" icon={<Eye size={10} />}>
            <div className="space-y-1">
              {entityTypes.map(type => {
                const isHidden = hiddenTypes.has(type);
                const count = typeCounts[type] || 0;
                return (
                  <label key={type} className="flex items-center gap-2 cursor-pointer group">
                    <button
                      type="button"
                      onClick={() => toggleType(type)}
                      className={`relative flex-shrink-0 w-7 h-3.5 rounded-full transition-colors ${isHidden ? 'bg-slate-700' : 'bg-slate-600'}`}
                    >
                      <div
                        className={`absolute top-0.5 h-2.5 w-2.5 rounded-full transition-all ${isHidden ? 'left-0.5 opacity-30' : 'left-[14px]'}`}
                        style={{ backgroundColor: ENTITY_COLORS[type] }}
                      />
                    </button>
                    <div
                      className="h-2 w-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: ENTITY_COLORS[type], opacity: isHidden ? 0.2 : 1 }}
                    />
                    <span className={`text-[10px] flex-1 min-w-0 truncate ${isHidden ? 'text-slate-600 line-through' : 'text-slate-300 group-hover:text-white'}`}>
                      {ENTITY_LABELS[type] || type}
                    </span>
                    <span className="text-[9px] text-slate-600 tabular-nums flex-shrink-0">{count}</span>
                  </label>
                );
              })}
            </div>
          </Section>

          {/* 4. GRAPH DEPTH */}
          <Section title="Profundidade (Hops)" icon={<GitBranch size={10} />}>
            <div className="flex gap-1">
              {[1, 2, 3, 4].map(h => (
                <button
                  key={h}
                  onClick={() => setDepthHops(h)}
                  className={`flex-1 text-center text-[10px] rounded py-1 font-medium transition-colors ${
                    depthHops === h
                      ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                      : 'bg-slate-800/40 text-slate-500 border border-transparent hover:text-slate-300'
                  }`}
                >
                  {h}
                </button>
              ))}
            </div>
          </Section>

          {/* 5. EDGE DENSITY */}
          <Section title="Densidade de Arestas" icon={<span className="text-[10px]">~</span>}>
            <SliderRow
              label="Top conexoes por forca"
              value={edgeDensityPercent}
              min={5} max={100} step={5}
              onChange={setEdgeDensityPercent}
              displayValue={`${edgeDensityPercent}%`}
            />
          </Section>

          {/* 6. RADIAL DISTANCE */}
          <Section title="Distancia Radial" icon={<Orbit size={10} />} defaultOpen={false}>
            <SliderRow
              label="Espacamento entre nos"
              value={radialDistance}
              min={0.3} max={6} step={0.1}
              onChange={setRadialDistance}
              displayValue={`${radialDistance.toFixed(1)}x`}
            />
          </Section>

          {/* 7. EGO NETWORK */}
          <Section title="Rede Ego (Focus)" icon={<Crosshair size={10} />}>
            {egoNodeId ? (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 bg-slate-800/60 rounded px-2 py-1">
                  <Target size={10} className="text-cyan-400 flex-shrink-0" />
                  <span className="text-[10px] text-slate-300 truncate flex-1">
                    {nodes.find(n => n.id === egoNodeId)?.label || egoNodeId}
                  </span>
                  <button onClick={() => setEgoNodeId(null)} className="text-slate-500 hover:text-white">
                    <X size={10} />
                  </button>
                </div>
                <SliderRow
                  label="Profundidade"
                  value={egoHops} min={1} max={4} step={1}
                  onChange={v => setEgoHops(v)}
                  displayValue={`${egoHops} hop${egoHops > 1 ? 's' : ''}`}
                />
              </div>
            ) : (
              <p className="text-[9px] text-slate-500 italic">
                Duplo-clique em um no para ativar
              </p>
            )}
          </Section>

          {/* 8. FREEZE PHYSICS */}
          <div>
            <button
              onClick={toggleFreeze}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                frozen
                  ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30'
                  : 'bg-slate-800/60 text-slate-400 border border-slate-700/50 hover:text-white'
              }`}
            >
              {frozen ? <Snowflake size={13} /> : <Play size={13} />}
              {frozen ? 'Layout Congelado' : 'Congelar Layout'}
            </button>
          </div>

          {/* 10. PATH FINDER */}
          <Section title="Caminho Mais Curto" icon={<Route size={10} />} defaultOpen={false}>
            <div className="space-y-1.5">
              <NodePicker label="Origem" value={pathSourceId} nodes={nodes} onChange={setPathSourceId} />
              <NodePicker label="Destino" value={pathTargetId} nodes={nodes} onChange={setPathTargetId} />
              {pathNodeIds.size > 0 && (
                <div className="text-[9px] text-green-400 font-medium">
                  Caminho: {pathNodeIds.size} nos
                </div>
              )}
              {pathSourceId && pathTargetId && pathNodeIds.size === 0 && (
                <div className="text-[9px] text-red-400">Sem caminho</div>
              )}
              {(pathSourceId || pathTargetId) && (
                <button
                  onClick={() => { setPathSourceId(null); setPathTargetId(null); }}
                  className="text-[9px] text-slate-500 hover:text-white underline"
                >
                  Limpar
                </button>
              )}
            </div>
          </Section>

          {/* 12. NODE RANKING */}
          <Section title="Ranking (Centralidade)" icon={<BarChart3 size={10} />} defaultOpen={false}>
            <div className="space-y-1">
              {rankOptions.map(opt => (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="radio" name="ranking" value={opt.value}
                    checked={rankingMetric === opt.value}
                    onChange={() => setRankingMetric(opt.value)}
                    className="accent-cyan-500 h-3 w-3"
                  />
                  <span className={`text-[10px] ${rankingMetric === opt.value ? 'text-cyan-400 font-medium' : 'text-slate-400 group-hover:text-slate-300'}`}>
                    {opt.label}
                  </span>
                </label>
              ))}
            </div>
          </Section>

          {/* Interactions help */}
          <div className="border-t border-slate-700/30 pt-2">
            <div className="space-y-0.5 text-[8px] text-slate-600 leading-tight">
              <div><span className="text-slate-500">Clique</span> selecionar | <span className="text-slate-500">2x clique</span> ego</div>
              <div><span className="text-slate-500">Arrastar</span> mover | <span className="text-slate-500">Scroll</span> zoom</div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

function NodePicker({ label, value, nodes, onChange }: {
  label: string; value: string | null; nodes: GraphNode[];
  onChange: (id: string | null) => void;
}) {
  return (
    <div>
      <span className="text-[9px] text-slate-500">{label}</span>
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value || null)}
        className="mt-0.5 w-full rounded bg-slate-800/80 border border-slate-700/50 px-1.5 py-1 text-[10px] text-slate-300 outline-none focus:border-cyan-500/50"
      >
        <option value="">Selecionar no...</option>
        {nodes.map(n => (
          <option key={n.id} value={n.id}>
            {n.label} ({ENTITY_LABELS[n.type] || n.type})
          </option>
        ))}
      </select>
    </div>
  );
}
