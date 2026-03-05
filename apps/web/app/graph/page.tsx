'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { isAuthenticated } from '@/lib/auth';
import { exploreGraph, type GraphExploreResponse } from '@/lib/api';
import { GraphCanvas } from '@/components/graph/graph-canvas';
import {
  LayoutDashboard,
  Network,
  Loader2,
  AlertCircle,
  Search,
} from 'lucide-react';

export default function GraphPage() {
  const router = useRouter();

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [graphData, setGraphData] = useState<GraphExploreResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stabilize canvas data to avoid infinite re-renders
  const canvasData = useMemo(() => {
    if (!graphData || graphData.nodes.length === 0) return null;
    return { nodes: graphData.nodes as any, edges: graphData.edges as any };
  }, [graphData]);

  // Auth check
  useEffect(() => {
    if (!isAuthenticated()) {
      router.push('/');
    }
  }, [router]);

  // Explore graph by company name
  const handleExplore = useCallback(async (query: string) => {
    const q = query.trim();
    if (q.length < 2) return;

    setIsLoading(true);
    setError(null);
    setGraphData(null);

    try {
      const data = await exploreGraph(q);
      setGraphData(data);
      if (data.nodes.length === 0) {
        setError(`Nenhuma empresa encontrada para "${q}"`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao explorar grafo');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    handleExplore(searchQuery);
  }, [searchQuery, handleExplore]);

  return (
    <div className="h-screen flex flex-col bg-[#0a0e1a] overflow-hidden">
      {/* Header */}
      <header className="flex-shrink-0 bg-[#0f1629]/80 backdrop-blur-xl border-b border-cyan-500/10">
        <div className="flex items-center justify-between px-4 lg:px-6 py-2.5">
          <div className="flex items-center gap-3">
            <picture>
              <source srcSet="/iconsai-logo.webp" type="image/webp" />
              <img
                src="/iconsai-logo.png"
                alt="Iconsai"
                className="h-8 w-auto"
              />
            </picture>
            <h1 className="text-lg font-bold bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-400 bg-clip-text text-transparent hidden sm:block">
              Graph Explorer
            </h1>
          </div>

          {/* Search Bar */}
          <form onSubmit={handleSubmit} className="flex items-center gap-2 flex-1 max-w-md mx-4">
            <div className="flex items-center flex-1 bg-slate-800/60 border border-cyan-500/20 rounded-lg px-3 py-1.5 focus-within:border-cyan-500/50 transition-colors">
              <Search className="h-4 w-4 text-slate-400 flex-shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Nome da empresa (ex: cesla)"
                className="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-500 outline-none px-2"
              />
            </div>
            <button
              type="submit"
              disabled={isLoading || searchQuery.trim().length < 2}
              className="h-9 px-4 bg-cyan-500/15 border border-cyan-500/50 text-cyan-400 rounded-lg text-xs font-medium hover:bg-cyan-500 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Explorar'}
            </button>
          </form>

          <nav className="flex items-center gap-2">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 h-9 px-3 bg-slate-400/10 border border-slate-400/20 text-slate-300 rounded-lg text-xs font-medium hover:bg-slate-400/20 transition-colors"
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Dashboard</span>
            </Link>
            <span className="inline-flex items-center gap-1.5 h-9 px-3 bg-cyan-500/15 border border-cyan-500/50 text-cyan-400 rounded-lg text-xs font-semibold">
              <Network className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Graph</span>
            </span>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative">
          {/* Empty State */}
          {!graphData && !isLoading && !error && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex flex-col items-center gap-4 text-center max-w-sm">
                <Network className="h-16 w-16 text-cyan-500/30" />
                <h2 className="text-lg font-semibold text-slate-300">Graph Explorer</h2>
                <p className="text-sm text-slate-500">
                  Digite o nome de uma empresa para visualizar suas conexoes: socios, noticias e relacoes.
                </p>
              </div>
            </div>
          )}

          {/* Loading */}
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0a0e1a]/80 z-10">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 text-cyan-400 animate-spin" />
                <span className="text-sm text-slate-400">
                  Explorando conexoes...
                </span>
              </div>
            </div>
          )}

          {/* Error */}
          {error && !isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0a0e1a]/80 z-10">
              <div className="flex flex-col items-center gap-4 max-w-sm text-center">
                <AlertCircle className="h-10 w-10 text-red-400" />
                <p className="text-sm text-slate-300">{error}</p>
              </div>
            </div>
          )}

          {/* Graph Canvas */}
          {canvasData && !isLoading && !error && (
            <GraphCanvas
              initialData={canvasData}
              className="h-full"
            />
          )}

          {/* Stats Badge */}
          {graphData && graphData.stats && !isLoading && !error && (
            <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
              <div className="bg-[#0f1629]/90 border border-cyan-500/20 rounded-lg px-3 py-1.5 flex items-center gap-3 text-xs">
                <span className="text-slate-400">Centro: <span className="text-cyan-400 font-medium">{graphData.center?.label}</span></span>
                <span className="text-slate-600">|</span>
                <span className="text-red-400">{graphData.stats.empresas} empresa</span>
                <span className="text-orange-400">{graphData.stats.socios} socios</span>
                <span className="text-green-400">{graphData.stats.noticias} noticias</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
