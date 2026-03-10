'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { isAuthenticated } from '@/lib/auth';
import {
  expandGraphNode,
  searchGraphEntities,
  deepSearchGraph,
  type GraphExploreResponse,
  type GraphSearchResult,
  type DeepSearchResponse,
  type GraphNodeData,
  type GraphEdgeData,
  type DeepSearchNode,
} from '@/lib/api';
import { GraphCanvas } from '@/components/graph/graph-canvas';
import type { GraphData } from '@/components/graph/types';
import {
  LayoutDashboard,
  Network,
  Database,
  Loader2,
  AlertCircle,
  Search,
  X,
  Radar,
  Eye,
  Info,
} from 'lucide-react';

const ENTITY_COLORS: Record<string, string> = {
  empresa: '#ef4444',
  pessoa: '#f97316',
  politico: '#3b82f6',
  mandato: '#a855f7',
  emenda: '#06b6d4',
  noticia: '#22c55e',
};

const ENTITY_LABELS: Record<string, string> = {
  empresa: 'Empresa',
  pessoa: 'Pessoa',
  politico: 'Politico',
  mandato: 'Mandato',
  emenda: 'Emenda',
  noticia: 'Noticia',
};

type GraphStats = GraphExploreResponse['stats'];

function getNodeRelevance(node: { data?: Record<string, unknown> }): number {
  return typeof node.data?.relevance === 'number' ? node.data.relevance : 0;
}

function getStatsCount(stats: GraphStats, type: string): number {
  const statsKey = type === 'pessoa' ? 'socios' : `${type}s`;
  return stats[statsKey as keyof GraphStats] ?? 0;
}

export default function GraphPage() {
  const router = useRouter();

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [graphData, setGraphData] = useState<GraphExploreResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Deep search mode
  const [isDeepSearch, setIsDeepSearch] = useState(false);
  const [deepSearchData, setDeepSearchData] = useState<DeepSearchResponse | null>(null);

  // Modal stack: supports stacking multiple modals
  type ModalEntry = { type: 'category' | 'info' | 'bayesian'; category?: string };
  const [modalStack, setModalStack] = useState<ModalEntry[]>([]);
  const pushModal = useCallback((entry: ModalEntry) => setModalStack(prev => [...prev, entry]), []);
  const popModal = useCallback(() => setModalStack(prev => prev.slice(0, -1)), []);

  // Hidden categories (toggle visibility)
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(new Set());

  // Autocomplete state
  const [suggestions, setSuggestions] = useState<GraphSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Stabilize canvas data to avoid infinite re-renders + filter hidden categories
  const canvasData = useMemo<GraphData | null>(() => {
    let nodes: GraphNodeData[] | DeepSearchNode[];
    let edges: GraphEdgeData[];
    if (isDeepSearch && deepSearchData && deepSearchData.nodes.length > 0) {
      nodes = deepSearchData.nodes;
      edges = deepSearchData.edges;
    } else if (!isDeepSearch && graphData && graphData.nodes.length > 0) {
      nodes = graphData.nodes;
      edges = graphData.edges;
    } else {
      return null;
    }
    if (hiddenCategories.size > 0) {
      const visibleNodes = nodes.filter(n => !hiddenCategories.has(n.type));
      const visibleIds = new Set(visibleNodes.map(n => n.id));
      const visibleEdges = edges.filter(e => {
        const src = typeof e.source === 'object' ? (e.source as { id: string }).id : e.source;
        const tgt = typeof e.target === 'object' ? (e.target as { id: string }).id : e.target;
        return visibleIds.has(src as string) && visibleIds.has(tgt as string);
      });
      return { nodes: visibleNodes, edges: visibleEdges };
    }
    return { nodes, edges };
  }, [graphData, deepSearchData, isDeepSearch, hiddenCategories]);

  const activeStats = useMemo(() => {
    if (isDeepSearch && deepSearchData) return deepSearchData.stats;
    if (!isDeepSearch && graphData) return graphData.stats;
    return null;
  }, [graphData, deepSearchData, isDeepSearch]);

  // All unfiltered nodes for modals
  const allNodes = useMemo(() => {
    if (isDeepSearch && deepSearchData) return deepSearchData.nodes;
    if (!isDeepSearch && graphData) return graphData.nodes;
    return [];
  }, [graphData, deepSearchData, isDeepSearch]);

  // Get nodes for a specific category (used by category modals)
  const getNodesForCategory = useCallback((cat: string) => {
    return allNodes.filter(n => n.type === cat);
  }, [allNodes]);

  // Auth check
  useEffect(() => {
    if (!isAuthenticated()) {
      router.push('/');
    }
  }, [router]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Live search after 2 characters (only in normal mode)
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    // In deep search mode, don't show autocomplete dropdown
    if (isDeepSearch) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }

    if (value.trim().length < 2) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const data = await searchGraphEntities(value.trim(), 200);
        setSuggestions(data.results || []);
        setShowDropdown(true);
      } catch {
        setSuggestions([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
  }, [isDeepSearch]);

  // Deep search: triggered by Enter key or button
  const handleDeepSearch = useCallback(async () => {
    const term = searchQuery.trim();
    if (term.length < 2) return;

    setShowDropdown(false);
    setSuggestions([]);
    setIsLoading(true);
    setError(null);
    setGraphData(null);
    setDeepSearchData(null);

    try {
      const data = await deepSearchGraph(term);
      setDeepSearchData(data);
      if (data.nodes.length === 0) {
        setError(`Nenhum resultado encontrado para "${term}" em nenhuma tabela`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro na busca profunda');
    } finally {
      setIsLoading(false);
    }
  }, [searchQuery]);

  // Handle Enter key
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && isDeepSearch) {
      e.preventDefault();
      handleDeepSearch();
    }
  }, [isDeepSearch, handleDeepSearch]);

  // Select a suggestion from the dropdown (normal mode)
  const handleSelectSuggestion = useCallback(async (result: GraphSearchResult) => {
    setSearchQuery(result.label);
    setShowDropdown(false);
    setSuggestions([]);
    setIsLoading(true);
    setError(null);
    setGraphData(null);
    setDeepSearchData(null);

    try {
      const data = await expandGraphNode(result.type, result.id);
      const nodes = (data.nodes || []).map((n: GraphNodeData & { hop?: number }) => ({
        ...n,
        data: {
          ...n.data,
          hop: n.data?.hop ?? n.hop ?? 1,
        },
      }));
      const edges: GraphEdgeData[] = data.edges || [];
      const statsMap: Record<string, number> = {};
      for (const n of nodes) {
        const t = n.type || 'unknown';
        statsMap[t] = (statsMap[t] || 0) + 1;
      }
      const adapted: GraphExploreResponse = {
        success: true,
        nodes,
        edges,
        center: data.center || { id: `${result.type}:${result.id}`, type: result.type, label: result.label },
        stats: {
          total_nodes: nodes.length,
          total_edges: edges.length,
          empresas: statsMap['empresa'] || 0,
          socios: statsMap['pessoa'] || 0,
          noticias: statsMap['noticia'] || 0,
          politicos: statsMap['politico'] || 0,
          emendas: statsMap['emenda'] || 0,
          mandatos: statsMap['mandato'] || 0,
        },
      };
      setGraphData(adapted);
      if (nodes.length === 0) {
        setError(`Nenhuma conexao encontrada para "${result.label}"`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao explorar grafo');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleClear = useCallback(() => {
    setSearchQuery('');
    setSuggestions([]);
    setShowDropdown(false);
    setGraphData(null);
    setDeepSearchData(null);
    setError(null);
  }, []);

  const toggleDeepSearch = useCallback(() => {
    setIsDeepSearch(prev => !prev);
    setSuggestions([]);
    setShowDropdown(false);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="h-screen flex flex-col bg-[#0a0e1a] overflow-hidden">
      {/* Header */}
      <header className="flex-shrink-0 bg-[#0f1629]/80 backdrop-blur-xl border-b border-cyan-500/10 z-50 relative">
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

          {/* Search Bar with Autocomplete + Deep Search Toggle */}
          <div ref={dropdownRef} className="relative flex-1 max-w-lg mx-4">
            <div className={`flex items-center flex-1 bg-slate-800/60 border rounded-lg px-3 py-1.5 transition-colors ${
              isDeepSearch
                ? 'border-amber-500/50 focus-within:border-amber-500/80'
                : 'border-cyan-500/20 focus-within:border-cyan-500/50'
            }`}>
              {/* Deep Search Toggle */}
              <button
                type="button"
                onClick={toggleDeepSearch}
                title={isDeepSearch ? 'Deep Search ativo (busca em TODAS as tabelas)' : 'Ativar Deep Search'}
                className={`flex-shrink-0 p-0.5 rounded transition-colors mr-1 ${
                  isDeepSearch
                    ? 'text-amber-400 bg-amber-500/20'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <Radar className="h-4 w-4" />
              </button>

              <Search className="h-4 w-4 text-slate-400 flex-shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onFocus={() => !isDeepSearch && suggestions.length > 0 && setShowDropdown(true)}
                placeholder={isDeepSearch
                  ? 'Deep Search: busca em TODAS as tabelas (Enter para buscar)...'
                  : 'Buscar empresas, pessoas, politicos, noticias...'
                }
                className="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-500 outline-none px-2"
              />
              {isSearching && (
                <Loader2 className="h-3.5 w-3.5 text-cyan-400 animate-spin flex-shrink-0" />
              )}
              {searchQuery && !isSearching && (
                <button
                  type="button"
                  onClick={handleClear}
                  className="flex-shrink-0 text-slate-500 hover:text-slate-300"
                >
                  <X size={14} />
                </button>
              )}

              {/* Deep search submit button */}
              {isDeepSearch && searchQuery.trim().length >= 2 && !isLoading && (
                <button
                  type="button"
                  onClick={handleDeepSearch}
                  className="flex-shrink-0 ml-1 px-2 py-0.5 bg-amber-500/20 text-amber-400 text-[10px] font-semibold rounded hover:bg-amber-500/30 transition-colors"
                >
                  GO
                </button>
              )}
            </div>

            {/* Deep search mode indicator */}
            {isDeepSearch && (
              <div className="absolute -bottom-5 left-0 right-0 flex justify-center">
                <span className="text-[9px] text-amber-400/70 font-medium tracking-wider uppercase">
                  Deep Search — Bayesian Evidence Model
                </span>
              </div>
            )}

            {/* Autocomplete Dropdown — only in normal mode */}
            {!isDeepSearch && showDropdown && suggestions.length > 0 && (() => {
              const grouped: Record<string, typeof suggestions> = {};
              const typeOrder: string[] = [];
              for (const r of suggestions) {
                if (!grouped[r.type]) {
                  grouped[r.type] = [];
                  typeOrder.push(r.type);
                }
                grouped[r.type].push(r);
              }
              return (
                <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-96 overflow-y-auto rounded-lg border border-cyan-500/20 bg-[#0f1629] shadow-2xl">
                  {typeOrder.map((type) => (
                    <div key={type}>
                      <div className="sticky top-0 z-10 flex items-center gap-2 bg-[#0d1220] px-3 py-1.5 border-b border-slate-800/50">
                        <div
                          className="h-2 w-2 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: ENTITY_COLORS[type] || '#6b7280' }}
                        />
                        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: ENTITY_COLORS[type] || '#6b7280' }}>
                          {ENTITY_LABELS[type] || type} ({grouped[type].length})
                        </span>
                      </div>
                      <ul>
                        {grouped[type].map((result) => (
                          <li key={`${result.type}-${result.id}`}>
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleSelectSuggestion(result)}
                              className="flex w-full items-center gap-3 px-3 py-2 text-left cursor-pointer transition-colors hover:bg-cyan-500/10 border-b border-slate-800/30 last:border-b-0"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="text-sm text-slate-200 truncate">{result.label}</div>
                                {result.subtitle && (
                                  <div className="text-xs text-slate-500 truncate">{result.subtitle}</div>
                                )}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* No results message */}
            {!isDeepSearch && showDropdown && suggestions.length === 0 && !isSearching && searchQuery.trim().length >= 2 && (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-lg border border-cyan-500/20 bg-[#0f1629] px-3 py-3 text-xs text-slate-500 text-center">
                Nenhum resultado para &quot;{searchQuery.trim()}&quot;
              </div>
            )}
          </div>

          <nav className="flex items-center gap-2">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 h-9 px-3 bg-slate-400/10 border border-slate-400/20 text-slate-300 rounded-lg text-xs font-medium hover:bg-slate-400/20 transition-colors"
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Dashboard</span>
            </Link>
            <Link
              href="/db"
              className="inline-flex items-center gap-1.5 h-9 px-3 bg-slate-400/10 border border-slate-400/20 text-slate-300 rounded-lg text-xs font-medium hover:bg-slate-400/20 transition-colors"
            >
              <Database className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">DB</span>
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
        {/* Left Legend Panel (deep search mode only) */}
        {isDeepSearch && deepSearchData && deepSearchData.nodes.length > 0 && (
          <div className="flex-shrink-0 w-48 bg-[#0f1629]/90 border-r border-cyan-500/10 overflow-y-auto p-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-amber-400/80 mb-3">
              Categorias
            </h3>
            <div className="space-y-1.5">
              {Object.entries(ENTITY_COLORS).map(([type, color]) => {
                const count = getStatsCount(deepSearchData.stats, type);
                if (count === 0) return null;
                const isHidden = hiddenCategories.has(type);
                return (
                  <div key={type} className="flex items-center gap-1.5 w-full rounded-md px-1.5 py-1 group">
                    {/* Toggle on/off */}
                    <button
                      type="button"
                      onClick={() => setHiddenCategories(prev => {
                        const next = new Set(prev);
                        if (next.has(type)) next.delete(type); else next.add(type);
                        return next;
                      })}
                      className="flex-shrink-0"
                      title={isHidden ? `Mostrar ${ENTITY_LABELS[type]}` : `Ocultar ${ENTITY_LABELS[type]}`}
                    >
                      <div
                        className={`h-3 w-3 rounded-full transition-all ${isHidden ? 'opacity-20 scale-75' : 'opacity-100'}`}
                        style={{ backgroundColor: color }}
                      />
                    </button>
                    <span className={`text-xs min-w-0 truncate flex-1 transition-colors ${isHidden ? 'text-slate-600 line-through' : 'text-slate-300'}`}>
                      {ENTITY_LABELS[type]}
                    </span>
                    <span className="text-[10px] text-slate-500 flex-shrink-0 tabular-nums">{count}</span>
                    {/* Eye icon → open category variables modal */}
                    <button
                      type="button"
                      onClick={() => pushModal({ type: 'category', category: type })}
                      className="flex-shrink-0 p-0.5 rounded text-slate-600 hover:text-cyan-400 transition-colors"
                      title={`Ver variaveis de ${ENTITY_LABELS[type]}`}
                    >
                      <Eye size={12} />
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 pt-3 border-t border-slate-700/50">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-amber-400/80 mb-2">
                Modelo
              </h3>
              <div className="space-y-1.5 text-[10px] text-slate-400 leading-tight">
                <div className="flex items-start gap-1.5">
                  <div className="h-2 w-2 mt-0.5 rounded-full bg-green-400 flex-shrink-0" />
                  <span>&gt;80% Forte</span>
                </div>
                <div className="flex items-start gap-1.5">
                  <div className="h-2 w-2 mt-0.5 rounded-full bg-yellow-400 flex-shrink-0" />
                  <span>50-80% Possivel</span>
                </div>
                <div className="flex items-start gap-1.5">
                  <div className="h-2 w-2 mt-0.5 rounded-full bg-red-400 flex-shrink-0" />
                  <span>&lt;50% Fraco</span>
                </div>
              </div>
              <p className="mt-2 text-[9px] text-slate-500 leading-tight">
                Bayesian: C = 1 - ∏(1 - p_i)
              </p>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-700/50">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-amber-400/80 mb-2">
                Fontes
              </h3>
              <div className="space-y-1 text-[10px] text-slate-400">
                <div>Contrato Social: 1.00</div>
                <div>Cadastro Gov: 0.95</div>
                <div>Politicos: 0.90</div>
                <div>Emendas: 0.85</div>
                <div>Bens/Receitas: 0.80</div>
                <div>Noticias: 0.50</div>
                <div>Topicos: 0.40</div>
              </div>

              {/* Bayesian Model explanation button */}
              <button
                type="button"
                onClick={() => pushModal({ type: 'bayesian' })}
                className="mt-3 w-full text-left px-2 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-400 font-medium hover:bg-amber-500/20 transition-colors"
              >
                Bayesian Evidence Model →
              </button>
            </div>

            {/* Info button (same as normal mode) */}
            <div className="mt-4 pt-3 border-t border-slate-700/50">
              <button
                type="button"
                onClick={() => pushModal({ type: 'info' })}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md bg-red-500/10 border border-red-500/20 text-[10px] text-red-400 font-medium hover:bg-red-500/20 transition-colors"
                style={{ animation: 'beacon-pulse 2s ease-in-out infinite' }}
              >
                <Info size={14} />
                Legenda do Grafo
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 relative">
          {/* Empty State */}
          {!canvasData && !isLoading && !error && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex flex-col items-center gap-4 text-center max-w-sm">
                <Network className="h-16 w-16 text-cyan-500/30" />
                <h2 className="text-lg font-semibold text-slate-300">Graph Explorer</h2>
                <p className="text-sm text-slate-500">
                  {isDeepSearch
                    ? 'Deep Search: digite um termo e pressione Enter para buscar em TODAS as tabelas do banco de dados.'
                    : 'Digite o nome de uma empresa, pessoa, politico ou noticia para visualizar conexoes.'
                  }
                </p>
                {!isDeepSearch && (
                  <button
                    type="button"
                    onClick={toggleDeepSearch}
                    className="mt-2 inline-flex items-center gap-2 px-4 py-2 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-lg text-xs font-medium hover:bg-amber-500/20 transition-colors"
                  >
                    <Radar className="h-4 w-4" />
                    Ativar Deep Search
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Loading */}
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0a0e1a]/80 z-10">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 text-cyan-400 animate-spin" />
                <span className="text-sm text-slate-400">
                  {isDeepSearch ? 'Buscando em todas as tabelas...' : 'Explorando conexoes...'}
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
              onInfoClick={() => pushModal({ type: 'info' })}
            />
          )}

          {/* Stats Badge */}
          {activeStats && !isLoading && !error && canvasData && (
            <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
              <div className={`border rounded-lg px-3 py-1.5 flex items-center gap-2 flex-wrap text-xs ${
                isDeepSearch
                  ? 'bg-[#0f1629]/90 border-amber-500/30'
                  : 'bg-[#0f1629]/90 border-cyan-500/20'
              }`}>
                {isDeepSearch ? (
                  <span className="text-amber-400 font-medium">Deep Search: &quot;{deepSearchData?.query}&quot;</span>
                ) : (
                  <span className="text-slate-400">Centro: <span className="text-cyan-400 font-medium">{graphData?.center?.label}</span></span>
                )}
                <span className="text-slate-600">|</span>
                {activeStats.empresas > 0 && <span className="text-red-400">{activeStats.empresas} empresa</span>}
                {activeStats.socios > 0 && <span className="text-orange-400">{activeStats.socios} socios</span>}
                {activeStats.politicos > 0 && <span className="text-blue-400">{activeStats.politicos} politicos</span>}
                {activeStats.mandatos > 0 && <span className="text-purple-400">{activeStats.mandatos} mandatos</span>}
                {activeStats.emendas > 0 && <span className="text-cyan-400">{activeStats.emendas} emendas</span>}
                {activeStats.noticias > 0 && <span className="text-green-400">{activeStats.noticias} noticias</span>}
                <span className="text-slate-600">|</span>
                <span className="text-slate-400">{activeStats.total_nodes} nos, {activeStats.total_edges} conexoes</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modal Stack */}
      {modalStack.map((modal, idx) => {
        const zIndex = 100 + idx * 10;
        const offset = idx * 16;

        // Category modal
        if (modal.type === 'category' && modal.category) {
          const cat = modal.category;
          const nodes = getNodesForCategory(cat);
          return (
            <div
              key={`modal-${idx}`}
              className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm"
              style={{ zIndex }}
              onClick={popModal}
            >
              <div
                className="relative w-full max-w-2xl max-h-[80vh] bg-[#0f1629] border border-cyan-500/20 rounded-xl shadow-2xl flex flex-col overflow-hidden mx-4"
                style={{ transform: `translate(${offset}px, ${offset}px)` }}
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700/50 flex-shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="h-4 w-4 rounded-full" style={{ backgroundColor: ENTITY_COLORS[cat] || '#6b7280' }} />
                    <h2 className="text-sm font-semibold text-slate-200">
                      {ENTITY_LABELS[cat] || cat}
                      <span className="ml-2 text-xs font-normal text-slate-500">({nodes.length} resultado{nodes.length !== 1 ? 's' : ''})</span>
                    </h2>
                  </div>
                  <button type="button" onClick={popModal} className="p-1 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors">
                    <X size={16} />
                  </button>
                </div>
                <div className="overflow-y-auto flex-1 p-2">
                  {nodes.length === 0 ? (
                    <p className="text-sm text-slate-500 text-center py-8">Nenhum resultado nesta categoria</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-[#0f1629]">
                        <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-700/50">
                          <th className="px-3 py-2 font-semibold">Nome</th>
                          <th className="px-3 py-2 font-semibold">Detalhe</th>
                          <th className="px-3 py-2 font-semibold text-right">Relevancia</th>
                          <th className="px-3 py-2 font-semibold text-right">Fontes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...nodes].sort((a, b) => getNodeRelevance(b) - getNodeRelevance(a)).map((node, nIdx) => {
                          const rel = typeof node.data?.relevance === 'number' ? node.data.relevance : null;
                          const srcCount = typeof node.data?.sourceCount === 'number' ? node.data.sourceCount : 0;
                          const sources = Array.isArray(node.data?.sources) ? (node.data.sources as string[]) : [];
                          const subtitle = typeof node.data?.subtitle === 'string' ? node.data.subtitle : '';
                          return (
                            <tr key={node.id || nIdx} className="border-b border-slate-800/30 hover:bg-slate-700/20 transition-colors">
                              <td className="px-3 py-2.5"><div className="text-slate-200 font-medium truncate max-w-[240px]">{node.label}</div></td>
                              <td className="px-3 py-2.5"><div className="text-slate-400 truncate max-w-[200px]">{subtitle || '—'}</div></td>
                              <td className="px-3 py-2.5 text-right">
                                {rel !== null ? (
                                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums ${rel >= 80 ? 'bg-green-500/15 text-green-400' : rel >= 50 ? 'bg-yellow-500/15 text-yellow-400' : 'bg-red-500/15 text-red-400'}`}>{rel}%</span>
                                ) : <span className="text-slate-600">—</span>}
                              </td>
                              <td className="px-3 py-2.5 text-right">
                                {srcCount > 0 ? <span className="text-slate-400 tabular-nums" title={sources.join(', ')}>{srcCount}</span> : <span className="text-slate-600">—</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          );
        }

        // Info modal (legend + toggles + eye icons)
        if (modal.type === 'info') {
          return (
            <div
              key={`modal-${idx}`}
              className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm"
              style={{ zIndex }}
              onClick={popModal}
            >
              <div
                className="relative w-full max-w-lg max-h-[85vh] bg-[#0f1629] border border-red-500/20 rounded-xl shadow-2xl flex flex-col overflow-hidden mx-4"
                style={{ transform: `translate(${offset}px, ${offset}px)` }}
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700/50 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <Info size={18} className="text-red-400" />
                    <h2 className="text-sm font-semibold text-slate-200">Legenda do Grafo</h2>
                  </div>
                  <button type="button" onClick={popModal} className="p-1 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors">
                    <X size={16} />
                  </button>
                </div>
                <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
                  {/* Categories with toggles */}
                  <div>
                    <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Categorias</h4>
                    <div className="space-y-1.5">
                      {Object.entries(ENTITY_COLORS).map(([type, color]) => {
                        const isHidden = hiddenCategories.has(type);
                        const nodeCount = allNodes.filter(n => n.type === type).length;
                        return (
                          <div key={type} className="flex items-center gap-2 text-xs">
                            <button
                              type="button"
                              onClick={() => setHiddenCategories(prev => {
                                const next = new Set(prev);
                                if (next.has(type)) next.delete(type); else next.add(type);
                                return next;
                              })}
                              className="flex-shrink-0"
                            >
                              <div
                                className={`h-3 w-3 rounded-full transition-all ${isHidden ? 'opacity-20 scale-75' : 'opacity-100'}`}
                                style={{ backgroundColor: color }}
                              />
                            </button>
                            <span className={`flex-1 min-w-0 truncate ${isHidden ? 'text-slate-600 line-through' : 'text-slate-300'}`}>
                              {ENTITY_LABELS[type]}
                            </span>
                            {nodeCount > 0 && <span className="text-[10px] text-slate-500 tabular-nums">{nodeCount}</span>}
                            {nodeCount > 0 && (
                              <button
                                type="button"
                                onClick={() => pushModal({ type: 'category', category: type })}
                                className="flex-shrink-0 p-0.5 rounded text-slate-600 hover:text-cyan-400 transition-colors"
                                title={`Ver variaveis de ${ENTITY_LABELS[type]}`}
                              >
                                <Eye size={12} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Edge styles */}
                  <div>
                    <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Conexoes</h4>
                    <div className="space-y-1">
                      {[
                        { style: 'solid', labels: 'Societaria, Fundador, Diretor' },
                        { style: 'dashed', labels: 'Fornecedor, Empregado, Beneficiario' },
                        { style: 'dotted', labels: 'Mencionado, Noticia menciona' },
                      ].map(({ style, labels }) => (
                        <div key={style} className="flex items-center gap-2 text-xs">
                          <svg width="24" height="8" className="flex-shrink-0">
                            <line x1="0" y1="4" x2="24" y2="4" stroke="#94a3b8" strokeWidth="2"
                              strokeDasharray={style === 'dashed' ? '4,3' : style === 'dotted' ? '1,3' : undefined} />
                          </svg>
                          <span className="text-slate-300">{labels}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Connection strength */}
                  <div>
                    <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Forca da Conexao</h4>
                    <div className="space-y-1.5 text-[10px] leading-tight text-slate-400">
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 h-3 w-3 rounded-full bg-cyan-400 flex-shrink-0" />
                        <span><strong className="text-slate-300">Perto do centro</strong> = conexao forte</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 h-2 w-2 rounded-full bg-cyan-400/40 flex-shrink-0" />
                        <span><strong className="text-slate-300">Longe do centro</strong> = conexao fraca</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <svg width="24" height="8" className="mt-0.5 flex-shrink-0"><line x1="0" y1="4" x2="24" y2="4" stroke="#06b6d4" strokeWidth="3" /></svg>
                        <span><strong className="text-slate-300">Linha grossa</strong> = mais mencoes</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <svg width="24" height="8" className="mt-0.5 flex-shrink-0"><line x1="0" y1="4" x2="24" y2="4" stroke="#06b6d4" strokeWidth="0.8" strokeOpacity="0.3" /></svg>
                        <span><strong className="text-slate-300">Linha fina</strong> = poucas mencoes</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 h-4 w-4 rounded-full border border-cyan-400/50 bg-cyan-400/20 flex-shrink-0" />
                        <span><strong className="text-slate-300">Circulo grande</strong> = no forte</span>
                      </div>
                      <div className="mt-1 border-t border-slate-700/50 pt-1 text-slate-500">
                        Nos conectados entre si = nome de um aparece no conteudo do outro
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        }

        // Bayesian Evidence Model modal
        if (modal.type === 'bayesian') {
          return (
            <div
              key={`modal-${idx}`}
              className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm"
              style={{ zIndex }}
              onClick={popModal}
            >
              <div
                className="relative w-full max-w-lg max-h-[85vh] bg-[#0f1629] border border-amber-500/20 rounded-xl shadow-2xl flex flex-col overflow-hidden mx-4"
                style={{ transform: `translate(${offset}px, ${offset}px)` }}
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700/50 flex-shrink-0">
                  <h2 className="text-sm font-semibold text-amber-400">Bayesian Evidence Model</h2>
                  <button type="button" onClick={popModal} className="p-1 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors">
                    <X size={16} />
                  </button>
                </div>
                <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4 text-xs text-slate-300 leading-relaxed">
                  <div>
                    <h4 className="text-sm font-semibold text-amber-400 mb-2">O que e?</h4>
                    <p className="text-slate-400">
                      O Bayesian Evidence Model e um modelo probabilistico que combina evidencias de multiplas fontes independentes
                      para calcular a probabilidade composta de uma conexao entre entidades no grafo.
                    </p>
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold text-amber-400 mb-2">Formula</h4>
                    <div className="bg-slate-800/60 rounded-lg px-4 py-3 font-mono text-center text-sm text-cyan-400">
                      C = 1 - ∏(1 - p<sub>i</sub>)
                    </div>
                    <p className="mt-2 text-slate-400">
                      Onde <strong className="text-slate-300">C</strong> e a confianca combinada e cada <strong className="text-slate-300">p<sub>i</sub></strong> e
                      a probabilidade individual de cada fonte de evidencia.
                    </p>
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold text-amber-400 mb-2">Como funciona no grafo</h4>
                    <ol className="space-y-2 text-slate-400 list-decimal list-inside">
                      <li>Cada fonte de dados (Contrato Social, Cadastro Gov, Noticias, etc.) atribui uma probabilidade <strong className="text-slate-300">p<sub>i</sub></strong> a cada relacao encontrada.</li>
                      <li>Se a mesma relacao aparece em multiplas fontes, as probabilidades sao combinadas usando a formula bayesiana.</li>
                      <li>Quanto mais fontes confirmam uma conexao, maior a confianca final <strong className="text-slate-300">C</strong>.</li>
                      <li>A relevancia (%) exibida nos nos do grafo reflete esse calculo.</li>
                    </ol>
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold text-amber-400 mb-2">Exemplo</h4>
                    <p className="text-slate-400">
                      Se &quot;Contrato Social&quot; indica 95% de certeza e &quot;Noticia&quot; indica 50%:
                    </p>
                    <div className="mt-2 bg-slate-800/60 rounded-lg px-4 py-2 font-mono text-[11px] text-slate-300">
                      C = 1 - (1 - 0.95) × (1 - 0.50) = 1 - 0.025 = <span className="text-green-400 font-bold">97.5%</span>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold text-amber-400 mb-2">Faixas de confianca</h4>
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 w-2.5 rounded-full bg-green-400 flex-shrink-0" />
                        <span className="text-slate-400"><strong className="text-green-400">&gt;80%</strong> — Forte: evidencia confirmada por multiplas fontes</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 w-2.5 rounded-full bg-yellow-400 flex-shrink-0" />
                        <span className="text-slate-400"><strong className="text-yellow-400">50-80%</strong> — Possivel: evidencia parcial, pode necessitar confirmacao</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 w-2.5 rounded-full bg-red-400 flex-shrink-0" />
                        <span className="text-slate-400"><strong className="text-red-400">&lt;50%</strong> — Fraco: poucas evidencias, baixa confianca</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold text-amber-400 mb-2">Pesos das fontes</h4>
                    <div className="bg-slate-800/60 rounded-lg px-4 py-3 space-y-1 text-[11px] font-mono">
                      <div className="flex justify-between"><span className="text-slate-400">Contrato Social</span><span className="text-cyan-400">1.00</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Cadastro Gov</span><span className="text-cyan-400">0.95</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Politicos</span><span className="text-cyan-400">0.90</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Emendas</span><span className="text-cyan-400">0.85</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Bens/Receitas</span><span className="text-cyan-400">0.80</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Noticias</span><span className="text-cyan-400">0.50</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Topicos</span><span className="text-cyan-400">0.40</span></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
