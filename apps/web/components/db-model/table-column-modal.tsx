'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Eye,
  GripHorizontal,
  KeyRound,
  Link2,
  Loader2,
  X,
} from 'lucide-react';
import {
  getDbModelTableDetails,
  getDbModelTableSamples,
  type DbModelColumnDetail,
  type DbModelTableSummary,
} from '@/lib/api';
import { ScrollArea } from '@/components/ui/scroll-area';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('pt-BR', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value);
}

function formatPercent(value: number | null) {
  if (value == null) return '-';
  return `${(value * 100).toFixed(value >= 0.995 ? 0 : 1)}%`;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const MIN_WIDTH = 360;
const MIN_HEIGHT = 280;
const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 520;
const HEADER_HEIGHT = 48;
const MODAL_OFFSET_STEP = 30;

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface TableColumnModalProps {
  table: DbModelTableSummary;
  index: number;
  onClose: (tableName: string) => void;
  onFocus: (tableName: string) => void;
  zIndex: number;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function TableColumnModal({
  table,
  index,
  onClose,
  onFocus,
  zIndex,
}: TableColumnModalProps) {
  /* ---- position / size state ---- */
  const [pos, setPos] = useState({
    x: 120 + index * MODAL_OFFSET_STEP,
    y: 80 + index * MODAL_OFFSET_STEP,
  });
  const [size, setSize] = useState({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });

  /* ---- data state ---- */
  const [columns, setColumns] = useState<DbModelColumnDetail[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /* ---- samples state ---- */
  const [samples, setSamples] = useState<Record<string, string | null>>({});
  const [samplesLoading, setSamplesLoading] = useState(false);
  const [samplesLoaded, setSamplesLoaded] = useState(false);
  const [expandedSamples, setExpandedSamples] = useState<Record<string, boolean>>({});

  /* ---- refs for drag / resize ---- */
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null
  );
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
    origX: number;
    origY: number;
    edge: string;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  /* ---- fetch columns ---- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    getDbModelTableDetails(table.name)
      .then((res) => {
        if (!cancelled) {
          setColumns(res.table.columns);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Falha ao carregar colunas');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [table.name]);

  /* ---- fetch samples on demand ---- */
  const loadSamples = useCallback(() => {
    if (samplesLoaded || samplesLoading) return;
    setSamplesLoading(true);

    getDbModelTableSamples(table.name)
      .then((res) => {
        setSamples(res.samples);
        setSamplesLoaded(true);
      })
      .catch(() => {
        setSamplesLoaded(true);
      })
      .finally(() => {
        setSamplesLoading(false);
      });
  }, [samplesLoaded, samplesLoading, table.name]);

  function toggleSample(colName: string) {
    // Lazy-load samples on first click
    if (!samplesLoaded && !samplesLoading) {
      loadSamples();
    }
    setExpandedSamples((current) => ({ ...current, [colName]: !current[colName] }));
  }

  /* ---- drag handlers ---- */
  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onFocus(table.name);
      dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };

      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = ev.clientX - dragRef.current.startX;
        const dy = ev.clientY - dragRef.current.startY;
        setPos({
          x: Math.max(0, dragRef.current.origX + dx),
          y: Math.max(0, dragRef.current.origY + dy),
        });
      };

      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [onFocus, pos.x, pos.y, table.name]
  );

  /* ---- resize handlers ---- */
  const onResizeStart = useCallback(
    (edge: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onFocus(table.name);
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origW: size.w,
        origH: size.h,
        origX: pos.x,
        origY: pos.y,
        edge,
      };

      const onMove = (ev: MouseEvent) => {
        if (!resizeRef.current) return;
        const r = resizeRef.current;
        const dx = ev.clientX - r.startX;
        const dy = ev.clientY - r.startY;

        let newW = r.origW;
        let newH = r.origH;
        let newX = r.origX;
        let newY = r.origY;

        if (r.edge.includes('e')) newW = Math.max(MIN_WIDTH, r.origW + dx);
        if (r.edge.includes('s')) newH = Math.max(MIN_HEIGHT, r.origH + dy);
        if (r.edge.includes('w')) {
          const dw = Math.min(dx, r.origW - MIN_WIDTH);
          newW = r.origW - dw;
          newX = r.origX + dw;
        }
        if (r.edge.includes('n')) {
          const dh = Math.min(dy, r.origH - MIN_HEIGHT);
          newH = r.origH - dh;
          newY = r.origY + dh;
        }

        setSize({ w: newW, h: newH });
        setPos({ x: Math.max(0, newX), y: Math.max(0, newY) });
      };

      const onUp = () => {
        resizeRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [onFocus, pos.x, pos.y, size.h, size.w, table.name]
  );

  /* ---- render ---- */
  return (
    <div
      ref={containerRef}
      onMouseDown={() => onFocus(table.name)}
      className="fixed select-none"
      style={{
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
        zIndex,
      }}
    >
      {/* Resize edges */}
      <div onMouseDown={onResizeStart('n')} className="absolute -top-1 left-2 right-2 h-2 cursor-n-resize" />
      <div onMouseDown={onResizeStart('s')} className="absolute -bottom-1 left-2 right-2 h-2 cursor-s-resize" />
      <div onMouseDown={onResizeStart('w')} className="absolute top-2 -left-1 bottom-2 w-2 cursor-w-resize" />
      <div onMouseDown={onResizeStart('e')} className="absolute top-2 -right-1 bottom-2 w-2 cursor-e-resize" />
      <div onMouseDown={onResizeStart('nw')} className="absolute -top-1 -left-1 h-3 w-3 cursor-nw-resize" />
      <div onMouseDown={onResizeStart('ne')} className="absolute -top-1 -right-1 h-3 w-3 cursor-ne-resize" />
      <div onMouseDown={onResizeStart('sw')} className="absolute -bottom-1 -left-1 h-3 w-3 cursor-sw-resize" />
      <div onMouseDown={onResizeStart('se')} className="absolute -bottom-1 -right-1 h-3 w-3 cursor-se-resize" />

      {/* Modal body */}
      <div className="flex flex-col h-full rounded-2xl border border-cyan-500/25 bg-[#0c1120]/95 backdrop-blur-xl shadow-[0_0_40px_rgba(34,211,238,0.12)] overflow-hidden">
        {/* Header - drag handle */}
        <div
          onMouseDown={onDragStart}
          className="flex items-center justify-between gap-2 px-4 border-b border-cyan-500/15 cursor-grab active:cursor-grabbing flex-shrink-0"
          style={{ height: HEADER_HEIGHT }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <GripHorizontal className="h-4 w-4 text-slate-500 flex-shrink-0" />
            <span
              className="h-2.5 w-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: table.domainColor }}
            />
            <h3 className="text-sm font-semibold text-white truncate">{table.name}</h3>
            <span className="text-[11px] text-slate-500 flex-shrink-0">
              {table.columnCount} cols
            </span>
          </div>
          <button
            type="button"
            onClick={() => onClose(table.name)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700 bg-slate-900/70 text-slate-400 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300 transition-colors flex-shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Subtitle */}
        <div className="px-4 py-2 border-b border-cyan-500/10 flex-shrink-0">
          <p className="text-[11px] text-slate-400 truncate">{table.friendlyName}</p>
          <div className="flex items-center gap-2 mt-1">
            <span
              className="rounded-full border px-2 py-0.5 text-[10px]"
              style={{
                borderColor: `${table.domainColor}44`,
                backgroundColor: `${table.domainColor}15`,
                color: table.domainColor,
              }}
            >
              {table.domainLabel}
            </span>
            <span className="text-[10px] text-slate-500">
              {formatCompactNumber(table.estimatedRowCount)} registros
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center h-full gap-2">
              <Loader2 className="h-4 w-4 text-cyan-400 animate-spin" />
              <span className="text-xs text-slate-400">Carregando colunas...</span>
            </div>
          ) : error ? (
            <div className="p-4">
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-200">
                {error}
              </div>
            </div>
          ) : columns ? (
            <ScrollArea className="h-full">
              <div className="p-3 space-y-1.5">
                {/* Column header */}
                <div className="grid grid-cols-[minmax(0,1fr)_80px_60px] gap-2 px-3 py-1.5 text-[10px] text-slate-500 uppercase tracking-wider">
                  <span>Coluna</span>
                  <span className="text-right">Preench.</span>
                  <span className="text-right">Cobert.</span>
                </div>

                {columns.map((col) => {
                  const hasData = col.nonNullCount > 0;
                  const isExpanded = Boolean(expandedSamples[col.name]);
                  const sampleValue = samples[col.name];
                  const hasSample = samplesLoaded && sampleValue != null;

                  return (
                    <div
                      key={col.name}
                      className="rounded-xl border border-slate-800/60 bg-slate-950/50 hover:border-cyan-500/20 transition-colors"
                    >
                      {/* Top row: name + badges + stats */}
                      <div className="grid grid-cols-[minmax(0,1fr)_80px_60px] gap-2 items-center px-3 py-2.5">
                        {/* Column info */}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-xs font-medium text-white truncate">
                              {col.name}
                            </span>
                            {col.isPrimaryKey && (
                              <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-400/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-200 flex-shrink-0">
                                <KeyRound className="h-2.5 w-2.5" />
                                PK
                              </span>
                            )}
                            {col.isForeignKey && (
                              <span className="inline-flex items-center gap-0.5 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-1.5 py-0.5 text-[9px] text-cyan-200 flex-shrink-0">
                                <Link2 className="h-2.5 w-2.5" />
                                FK
                              </span>
                            )}
                            {hasData && (
                              <button
                                type="button"
                                onClick={() => toggleSample(col.name)}
                                className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[9px] flex-shrink-0 transition-colors ${
                                  isExpanded
                                    ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200'
                                    : 'border-emerald-400/25 bg-emerald-500/8 text-emerald-300/70 hover:border-emerald-400/40 hover:bg-emerald-500/15 hover:text-emerald-200'
                                }`}
                              >
                                <Eye className="h-2.5 w-2.5" />
                                ex
                              </button>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[10px] text-slate-500 truncate">{col.type}</span>
                            <span
                              className={`text-[9px] ${col.nullable ? 'text-slate-600' : 'text-orange-400/70'}`}
                            >
                              {col.nullable ? 'null' : 'req'}
                            </span>
                          </div>
                        </div>

                        {/* Non-null count */}
                        <div className="text-right">
                          <span className="text-xs font-semibold text-cyan-200" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {formatCompactNumber(col.nonNullCount)}
                          </span>
                        </div>

                        {/* Coverage */}
                        <div className="text-right">
                          <span className="text-[11px] text-slate-400" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {formatPercent(col.coverageRatio)}
                          </span>
                        </div>
                      </div>

                      {/* Full-width description line */}
                      <div className="border-t border-slate-800/40 px-3 py-1.5">
                        {col.references && (
                          <p className="text-[10px] text-cyan-400/70">
                            FK → {col.references.table}.{col.references.column}
                          </p>
                        )}
                        <p className="text-[10px] leading-4 text-slate-500">
                          {col.description || `${col.type}${col.nullable ? ', nullable' : ', required'}${col.isPrimaryKey ? ', primary key' : ''}${col.isForeignKey ? ', foreign key' : ''}`}
                        </p>
                      </div>

                      {/* Sample value (expanded) */}
                      {isExpanded && (
                        <div className="border-t border-emerald-500/15 bg-emerald-500/5 px-3 py-2">
                          {samplesLoading ? (
                            <div className="flex items-center gap-1.5">
                              <Loader2 className="h-3 w-3 text-emerald-400 animate-spin" />
                              <span className="text-[10px] text-emerald-300/70">Buscando exemplo...</span>
                            </div>
                          ) : hasSample ? (
                            <div>
                              <p className="text-[9px] uppercase tracking-wider text-emerald-400/60 mb-1">
                                Exemplo real
                              </p>
                              <p className="text-[11px] leading-5 text-emerald-200 font-mono break-all whitespace-pre-wrap">
                                {sampleValue}
                              </p>
                            </div>
                          ) : (
                            <p className="text-[10px] text-slate-500 italic">
                              Sem exemplo disponivel para esta coluna
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          ) : null}
        </div>
      </div>
    </div>
  );
}
