'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  SkipForward,
  Clock,
  Globe,
  BarChart3,
  Building2,
  MapPin,
  Tags,
  FileSearch,
  Target,
  Network,
} from 'lucide-react';
import type { PipelineRun } from '@/lib/api';
import { getPipelineStatus } from '@/lib/api';

const PHASE_ICONS: Record<string, React.ElementType> = {
  crawl: Globe,
  cnae: BarChart3,
  tax: Building2,
  geo: MapPin,
  taxonomy: Tags,
  evidence: FileSearch,
  scoring: Target,
  graph: Network,
};

interface PipelineStatusProps {
  run: PipelineRun | null;
  runId: string | null;
  onComplete?: (run: PipelineRun) => void;
}

export function PipelineStatus({ run: initialRun, runId, onComplete }: PipelineStatusProps) {
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const isRunning = initialRun?.status === 'running';

  const { data: polledRun } = useQuery({
    queryKey: ['pipeline-status', runId],
    queryFn: () => getPipelineStatus(runId!),
    enabled: !!runId && isRunning,
    refetchInterval: isRunning ? 1500 : false,
  });

  const run = polledRun || initialRun;

  useEffect(() => {
    if (run && run.status !== 'running' && onCompleteRef.current) {
      onCompleteRef.current(run);
    }
  }, [run?.status, run]);

  if (!run) return null;

  const phases = Object.values(run.phases || {}).sort((a, b) => a.order - b.order);
  const completedCount = phases.filter((p) => p.status === 'success').length;
  const totalActive = phases.filter((p) => p.status !== 'skipped').length;
  const progressPct = totalActive > 0 ? Math.round((completedCount / totalActive) * 100) : 0;

  return (
    <div className="rounded-xl border border-cyan-500/20 bg-[#0f1629]/80 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {run.status === 'running' ? (
            <Loader2 className="h-4 w-4 text-cyan-400 animate-spin" />
          ) : run.status === 'completed' ? (
            <CheckCircle2 className="h-4 w-4 text-green-400" />
          ) : (
            <XCircle className="h-4 w-4 text-red-400" />
          )}
          <span className="text-sm font-medium text-white">
            Pipeline {run.status === 'running' ? 'em execução...' : run.status === 'completed' ? 'concluído' : 'com erros'}
          </span>
        </div>
        <span className="text-xs text-gray-400 font-mono tabular-nums">
          {progressPct}% ({completedCount}/{totalActive})
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-gray-800 rounded-full mb-4 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${progressPct}%`,
            background: run.status === 'error' || run.status === 'completed_with_errors'
              ? 'linear-gradient(90deg, #22c55e, #ef4444)'
              : 'linear-gradient(90deg, #06b6d4, #22c55e)',
          }}
        />
      </div>

      {/* Phase list */}
      <div className="space-y-1.5">
        {phases.map((phase) => {
          const Icon = PHASE_ICONS[phase.key] || Clock;
          return (
            <div
              key={phase.key}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors ${
                phase.status === 'running'
                  ? 'bg-cyan-500/10 border border-cyan-500/20'
                  : phase.status === 'success'
                    ? 'bg-green-500/5'
                    : phase.status === 'error'
                      ? 'bg-red-500/10'
                      : 'opacity-50'
              }`}
            >
              {/* Status icon */}
              {phase.status === 'running' ? (
                <Loader2 className="h-3.5 w-3.5 text-cyan-400 animate-spin flex-shrink-0" />
              ) : phase.status === 'success' ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-400 flex-shrink-0" />
              ) : phase.status === 'error' ? (
                <XCircle className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />
              ) : phase.status === 'skipped' ? (
                <SkipForward className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
              ) : (
                <Clock className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
              )}

              {/* Phase icon */}
              <Icon className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />

              {/* Label */}
              <span className="min-w-0 whitespace-nowrap overflow-hidden text-overflow-ellipsis text-gray-300 flex-1">
                {phase.label}
              </span>

              {/* Duration */}
              {phase.duration_ms != null && (
                <span className="text-gray-500 font-mono tabular-nums flex-shrink-0">
                  {phase.duration_ms < 1000
                    ? `${phase.duration_ms}ms`
                    : `${(phase.duration_ms / 1000).toFixed(1)}s`}
                </span>
              )}

              {/* Error message */}
              {phase.error && (
                <span className="text-red-400 truncate max-w-[120px]" title={phase.error}>
                  {phase.error}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Summary */}
      {run.summary && (
        <div className="mt-3 pt-3 border-t border-gray-800">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-500">Evidências</span>
              <span className="text-gray-300 font-mono tabular-nums">{run.summary.evidencias_total}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Oportunidades</span>
              <span className="text-gray-300 font-mono tabular-nums">{run.summary.oportunidades_total}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Leads quentes</span>
              <span className="text-orange-400 font-mono tabular-nums">{run.summary.oportunidades_quentes}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Relações grafo</span>
              <span className="text-gray-300 font-mono tabular-nums">{run.summary.grafo_relacoes}</span>
            </div>
            <div className="flex justify-between col-span-2">
              <span className="text-gray-500">Tempo total</span>
              <span className="text-gray-300 font-mono tabular-nums">
                {run.summary.total_duration_ms < 1000
                  ? `${run.summary.total_duration_ms}ms`
                  : `${(run.summary.total_duration_ms / 1000).toFixed(1)}s`}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
