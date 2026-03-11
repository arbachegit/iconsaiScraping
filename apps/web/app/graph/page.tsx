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
import { DraggableModal } from '@/components/graph/draggable-modal';
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
  HelpCircle,
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
  type ModalEntry = { type: 'category' | 'info' | 'bayesian' | 'stats'; category?: string };
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
          <div className="flex items-center gap-2 flex-1 max-w-lg mx-4">
          <div ref={dropdownRef} className="relative flex-1">
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

          {/* Deep Search Help Button */}
          {isDeepSearch && (
            <button
              type="button"
              onClick={() => pushModal({ type: 'bayesian' })}
              className="flex-shrink-0 flex items-center gap-1.5 h-8 px-2.5 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-lg text-[10px] font-medium hover:bg-amber-500/20 transition-colors"
              title="Como funciona o Deep Search?"
            >
              <HelpCircle size={14} />
              <span className="hidden sm:inline">Como funciona?</span>
            </button>
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
              onStatsClick={() => pushModal({ type: 'stats' })}
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

        // Info modal (legend + toggles + eye icons) — DRAGGABLE
        if (modal.type === 'info') {
          return (
            <DraggableModal key={`modal-${idx}`} zIndex={zIndex} onClose={popModal} className="w-full max-w-lg mx-4">
              <div className="relative max-h-[85vh] bg-[#0f1629] border border-red-500/20 rounded-xl shadow-2xl flex flex-col overflow-hidden">
                {/* Drag handle = header */}
                <div data-drag-handle className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700/50 flex-shrink-0 cursor-grab active:cursor-grabbing select-none">
                  <div className="flex items-center gap-2">
                    <Info size={18} className="text-red-400" />
                    <h2 className="text-sm font-semibold text-slate-200">Legenda do Grafo</h2>
                  </div>
                  <button type="button" onClick={popModal} className="p-1 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors cursor-pointer">
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
                              className={`relative flex-shrink-0 w-8 h-4 rounded-full transition-colors ${isHidden ? 'bg-slate-700' : 'bg-slate-600'}`}
                            >
                              <div
                                className={`absolute top-0.5 h-3 w-3 rounded-full transition-all ${isHidden ? 'left-0.5 opacity-40' : 'left-[18px]'}`}
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
            </DraggableModal>
          );
        }

        // Bayesian Evidence Model — comprehensive explanation modal
        if (modal.type === 'bayesian') {
          return (
            <div
              key={`modal-${idx}`}
              className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm"
              style={{ zIndex }}
              onClick={popModal}
            >
              <div
                className="relative w-full max-w-4xl max-h-[90vh] bg-[#0f1629] border border-amber-500/20 rounded-xl shadow-2xl flex flex-col overflow-hidden mx-4"
                style={{ transform: `translate(${offset}px, ${offset}px)` }}
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/50 flex-shrink-0">
                  <div className="flex items-center gap-3">
                    <Radar className="h-5 w-5 text-amber-400" />
                    <div>
                      <h2 className="text-base font-semibold text-amber-400">Deep Search — Bayesian Evidence Model</h2>
                      <p className="text-[11px] text-slate-500 mt-0.5">Como o grafo cruza informacoes e calcula conexoes</p>
                    </div>
                  </div>
                  <button type="button" onClick={popModal} className="p-1.5 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors">
                    <X size={18} />
                  </button>
                </div>
                <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">

                  {/* Section 1: What is Deep Search — with main SVG graph */}
                  <div>
                    <h3 className="text-sm font-semibold text-slate-200 mb-3">O que e o Deep Search?</h3>
                    <p className="text-xs text-slate-400 leading-relaxed mb-4">
                      Diferente da busca normal (que encontra uma entidade e expande suas conexoes diretas),
                      o <strong className="text-amber-400">Deep Search</strong> varre <strong className="text-slate-300">TODAS as tabelas do banco de dados</strong> simultaneamente —
                      empresas, socios, politicos, mandatos, emendas e noticias — procurando qualquer mencao ao termo buscado.
                      Em seguida, aplica o <strong className="text-amber-400">Modelo Bayesiano de Evidencia</strong> para calcular a forca de cada conexao encontrada.
                    </p>

                    {/* Main SVG — Example graph showing how evidence combines */}
                    <div className="flex flex-col lg:flex-row gap-5">
                      <div className="flex-1 bg-slate-800/40 rounded-xl p-4 border border-slate-700/30">
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider font-medium mb-3 text-center">Grafo Principal — Exemplo de busca: &quot;Construtora Alpha&quot;</p>
                        <svg viewBox="0 0 500 320" className="w-full" xmlns="http://www.w3.org/2000/svg">
                          {/* Edges with varying thickness = evidence strength */}
                          <line x1="250" y1="140" x2="100" y2="60" stroke="#22c55e" strokeWidth="4" strokeOpacity="0.7" />
                          <line x1="250" y1="140" x2="400" y2="60" stroke="#22c55e" strokeWidth="3.5" strokeOpacity="0.7" />
                          <line x1="250" y1="140" x2="80" y2="220" stroke="#eab308" strokeWidth="2" strokeOpacity="0.6" />
                          <line x1="250" y1="140" x2="420" y2="200" stroke="#eab308" strokeWidth="2.5" strokeOpacity="0.6" />
                          <line x1="250" y1="140" x2="250" y2="290" stroke="#ef4444" strokeWidth="1" strokeOpacity="0.4" />
                          <line x1="100" y1="60" x2="400" y2="60" stroke="#06b6d4" strokeWidth="1.5" strokeOpacity="0.3" strokeDasharray="4,3" />
                          <line x1="400" y1="60" x2="420" y2="200" stroke="#a855f7" strokeWidth="1.5" strokeOpacity="0.4" strokeDasharray="4,3" />
                          <line x1="80" y1="220" x2="250" y2="290" stroke="#06b6d4" strokeWidth="1" strokeOpacity="0.3" strokeDasharray="2,3" />

                          {/* Center node — empresa */}
                          <circle cx="250" cy="140" r="28" fill="#ef4444" fillOpacity="0.2" stroke="#ef4444" strokeWidth="2" />
                          <text x="250" y="136" textAnchor="middle" fill="#fca5a5" fontSize="9" fontWeight="600">Construtora</text>
                          <text x="250" y="148" textAnchor="middle" fill="#fca5a5" fontSize="9" fontWeight="600">Alpha</text>

                          {/* Socio 1 — strong evidence */}
                          <circle cx="100" cy="60" r="20" fill="#f97316" fillOpacity="0.2" stroke="#f97316" strokeWidth="2" />
                          <text x="100" y="57" textAnchor="middle" fill="#fdba74" fontSize="8" fontWeight="600">Joao Silva</text>
                          <text x="100" y="68" textAnchor="middle" fill="#22c55e" fontSize="8" fontWeight="700">97%</text>

                          {/* Socio 2 — strong evidence */}
                          <circle cx="400" cy="60" r="20" fill="#f97316" fillOpacity="0.2" stroke="#f97316" strokeWidth="2" />
                          <text x="400" y="57" textAnchor="middle" fill="#fdba74" fontSize="8" fontWeight="600">Maria Costa</text>
                          <text x="400" y="68" textAnchor="middle" fill="#22c55e" fontSize="8" fontWeight="700">92%</text>

                          {/* Politico — medium evidence */}
                          <circle cx="80" cy="220" r="18" fill="#3b82f6" fillOpacity="0.2" stroke="#3b82f6" strokeWidth="1.5" />
                          <text x="80" y="217" textAnchor="middle" fill="#93c5fd" fontSize="7.5" fontWeight="600">Dep. Santos</text>
                          <text x="80" y="228" textAnchor="middle" fill="#eab308" fontSize="7.5" fontWeight="700">65%</text>

                          {/* Emenda — medium evidence */}
                          <circle cx="420" cy="200" r="16" fill="#06b6d4" fillOpacity="0.2" stroke="#06b6d4" strokeWidth="1.5" />
                          <text x="420" y="197" textAnchor="middle" fill="#67e8f9" fontSize="7" fontWeight="600">Emenda</text>
                          <text x="420" y="208" textAnchor="middle" fill="#eab308" fontSize="7" fontWeight="700">72%</text>

                          {/* Noticia — weak evidence */}
                          <circle cx="250" cy="290" r="14" fill="#22c55e" fillOpacity="0.15" stroke="#22c55e" strokeWidth="1" />
                          <text x="250" y="287" textAnchor="middle" fill="#86efac" fontSize="7" fontWeight="600">Noticia</text>
                          <text x="250" y="298" textAnchor="middle" fill="#ef4444" fontSize="7" fontWeight="700">35%</text>

                          {/* Legend labels on edges */}
                          <text x="160" y="90" fill="#94a3b8" fontSize="7" transform="rotate(-25, 160, 90)">Contrato Social + Gov</text>
                          <text x="310" y="88" fill="#94a3b8" fontSize="7" transform="rotate(25, 310, 88)">Contrato + Emenda</text>
                          <text x="150" y="190" fill="#94a3b8" fontSize="7" transform="rotate(50, 150, 190)">Emenda beneficiario</text>
                          <text x="250" y="220" fill="#94a3b8" fontSize="7">Mencionado</text>
                        </svg>
                      </div>

                      {/* Side legend — how to read the graph */}
                      <div className="w-full lg:w-56 space-y-4 flex-shrink-0">
                        <div className="bg-slate-800/40 rounded-xl p-3 border border-slate-700/30">
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-medium mb-2">Como ler o grafo</p>
                          <div className="space-y-2 text-[11px] text-slate-400">
                            <div className="flex items-start gap-2">
                              <svg width="16" height="16" className="flex-shrink-0 mt-0.5"><circle cx="8" cy="8" r="7" fill="none" stroke="#ef4444" strokeWidth="1.5"/></svg>
                              <span><strong className="text-red-400">Circulo grande</strong> = entidade central (mais conexoes)</span>
                            </div>
                            <div className="flex items-start gap-2">
                              <svg width="16" height="16" className="flex-shrink-0 mt-0.5"><circle cx="8" cy="8" r="5" fill="none" stroke="#94a3b8" strokeWidth="1"/></svg>
                              <span><strong className="text-slate-300">Circulo pequeno</strong> = entidade periferica</span>
                            </div>
                            <div className="flex items-start gap-2">
                              <svg width="20" height="8" className="flex-shrink-0 mt-1"><line x1="0" y1="4" x2="20" y2="4" stroke="#22c55e" strokeWidth="3"/></svg>
                              <span><strong className="text-green-400">Linha grossa</strong> = conexao forte (&gt;80%)</span>
                            </div>
                            <div className="flex items-start gap-2">
                              <svg width="20" height="8" className="flex-shrink-0 mt-1"><line x1="0" y1="4" x2="20" y2="4" stroke="#eab308" strokeWidth="1.5"/></svg>
                              <span><strong className="text-yellow-400">Linha media</strong> = conexao possivel (50-80%)</span>
                            </div>
                            <div className="flex items-start gap-2">
                              <svg width="20" height="8" className="flex-shrink-0 mt-1"><line x1="0" y1="4" x2="20" y2="4" stroke="#ef4444" strokeWidth="0.8" strokeOpacity="0.5"/></svg>
                              <span><strong className="text-red-400">Linha fina</strong> = conexao fraca (&lt;50%)</span>
                            </div>
                            <div className="flex items-start gap-2">
                              <svg width="20" height="8" className="flex-shrink-0 mt-1"><line x1="0" y1="4" x2="20" y2="4" stroke="#94a3b8" strokeWidth="1" strokeDasharray="3,2"/></svg>
                              <span><strong className="text-slate-300">Tracejada</strong> = conexao indireta</span>
                            </div>
                          </div>
                        </div>

                        <div className="bg-slate-800/40 rounded-xl p-3 border border-slate-700/30">
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-medium mb-2">Cores dos nos</p>
                          <div className="space-y-1.5">
                            {Object.entries(ENTITY_COLORS).map(([type, color]) => (
                              <div key={type} className="flex items-center gap-2 text-[11px]">
                                <div className="h-3 w-3 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                                <span className="text-slate-300">{ENTITY_LABELS[type]}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Section 2: The Bayesian Formula — visual */}
                  <div className="border-t border-slate-700/50 pt-5">
                    <h3 className="text-sm font-semibold text-slate-200 mb-3">Como a evidencia e calculada?</h3>
                    <div className="flex flex-col lg:flex-row gap-5">
                      {/* Mini graph — single connection with multiple sources */}
                      <div className="flex-shrink-0 bg-slate-800/40 rounded-xl p-4 border border-slate-700/30 w-full lg:w-64">
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider font-medium mb-2 text-center">Evidencia combinada</p>
                        <svg viewBox="0 0 240 180" className="w-full" xmlns="http://www.w3.org/2000/svg">
                          {/* Source arrows pointing to the connection */}
                          <line x1="60" y1="90" x2="180" y2="90" stroke="#22c55e" strokeWidth="4" strokeOpacity="0.8" />

                          {/* Node A */}
                          <circle cx="60" cy="90" r="22" fill="#ef4444" fillOpacity="0.2" stroke="#ef4444" strokeWidth="2" />
                          <text x="60" y="87" textAnchor="middle" fill="#fca5a5" fontSize="8" fontWeight="600">Empresa</text>
                          <text x="60" y="98" textAnchor="middle" fill="#fca5a5" fontSize="8" fontWeight="600">Alpha</text>

                          {/* Node B */}
                          <circle cx="180" cy="90" r="18" fill="#f97316" fillOpacity="0.2" stroke="#f97316" strokeWidth="2" />
                          <text x="180" y="87" textAnchor="middle" fill="#fdba74" fontSize="8" fontWeight="600">Joao</text>
                          <text x="180" y="98" textAnchor="middle" fill="#fdba74" fontSize="8" fontWeight="600">Silva</text>

                          {/* Evidence sources feeding into the connection */}
                          <line x1="120" y1="30" x2="120" y2="78" stroke="#06b6d4" strokeWidth="1" strokeOpacity="0.5" strokeDasharray="3,2" />
                          <line x1="50" y1="155" x2="95" y2="102" stroke="#06b6d4" strokeWidth="1" strokeOpacity="0.5" strokeDasharray="3,2" />
                          <line x1="190" y1="155" x2="145" y2="102" stroke="#06b6d4" strokeWidth="1" strokeOpacity="0.5" strokeDasharray="3,2" />

                          {/* Source labels */}
                          <rect x="70" y="14" width="100" height="18" rx="4" fill="#0f1629" stroke="#334155" strokeWidth="0.5" />
                          <text x="120" y="27" textAnchor="middle" fill="#67e8f9" fontSize="8">Contrato Social (0.95)</text>

                          <rect x="2" y="148" width="96" height="18" rx="4" fill="#0f1629" stroke="#334155" strokeWidth="0.5" />
                          <text x="50" y="161" textAnchor="middle" fill="#67e8f9" fontSize="8">Cadastro Gov (0.90)</text>

                          <rect x="142" y="148" width="96" height="18" rx="4" fill="#0f1629" stroke="#334155" strokeWidth="0.5" />
                          <text x="190" y="161" textAnchor="middle" fill="#67e8f9" fontSize="8">Noticia (0.50)</text>

                          {/* Result badge */}
                          <rect x="87" y="67" width="66" height="18" rx="9" fill="#22c55e" fillOpacity="0.2" stroke="#22c55e" strokeWidth="1" />
                          <text x="120" y="79" textAnchor="middle" fill="#22c55e" fontSize="9" fontWeight="700">97.5%</text>
                        </svg>
                      </div>

                      {/* Explanation */}
                      <div className="flex-1 space-y-3">
                        <div className="bg-slate-800/40 rounded-lg px-4 py-3 border border-slate-700/30">
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-medium mb-2">Formula Bayesiana</p>
                          <div className="font-mono text-center text-base text-cyan-400 py-2">
                            C = 1 - ∏(1 - p<sub>i</sub>)
                          </div>
                          <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                            Cada fonte de dados atribui uma <strong className="text-slate-300">probabilidade independente</strong> (p<sub>i</sub>) de que a conexao exista.
                            A formula combina todas as evidencias: quanto mais fontes confirmam, mais forte a conexao.
                          </p>
                        </div>

                        <div className="bg-slate-800/40 rounded-lg px-4 py-3 border border-slate-700/30">
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-medium mb-2">Exemplo passo a passo</p>
                          <div className="space-y-1.5 text-[11px] text-slate-400 font-mono">
                            <p>Joao Silva aparece em 3 fontes:</p>
                            <div className="pl-2 border-l-2 border-cyan-500/30 space-y-1 mt-1">
                              <p>Contrato Social → p₁ = <span className="text-cyan-400">0.95</span></p>
                              <p>Cadastro Gov → p₂ = <span className="text-cyan-400">0.90</span></p>
                              <p>Noticia → p₃ = <span className="text-cyan-400">0.50</span></p>
                            </div>
                            <div className="mt-2 pt-2 border-t border-slate-700/50">
                              <p>C = 1 - (1-0.95) × (1-0.90) × (1-0.50)</p>
                              <p>C = 1 - 0.05 × 0.10 × 0.50</p>
                              <p>C = 1 - 0.0025 = <span className="text-green-400 font-bold">99.75%</span></p>
                            </div>
                          </div>
                        </div>

                        <p className="text-[11px] text-slate-500 leading-relaxed">
                          <strong className="text-slate-400">Intuicao:</strong> Se alguem consta no Contrato Social (95%) E no Cadastro do Governo (90%) E
                          foi mencionado em noticias (50%), a chance de ser socio real e praticamente 100%.
                          Cada fonte adicional <em>reduz a duvida restante</em>, nunca a aumenta.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Section 3: Source weights */}
                  <div className="border-t border-slate-700/50 pt-5">
                    <h3 className="text-sm font-semibold text-slate-200 mb-3">Pesos das fontes de dados</h3>
                    <p className="text-xs text-slate-400 mb-3 leading-relaxed">
                      Cada fonte de informacao tem um peso diferente conforme sua confiabilidade.
                      Fontes oficiais (governo, contratos) tem peso maior que fontes indiretas (noticias, topicos).
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {[
                        { name: 'Contrato Social', weight: 1.00, desc: 'Documento oficial da Junta Comercial', color: '#22c55e' },
                        { name: 'Cadastro Gov', weight: 0.95, desc: 'Receita Federal, CNPJ ativo', color: '#22c55e' },
                        { name: 'Politicos', weight: 0.90, desc: 'TSE, registros de candidatura', color: '#22c55e' },
                        { name: 'Emendas', weight: 0.85, desc: 'Portal da Transparencia', color: '#22c55e' },
                        { name: 'Bens/Receitas', weight: 0.80, desc: 'Declaracoes patrimoniais', color: '#eab308' },
                        { name: 'Noticias', weight: 0.50, desc: 'Mencoes em veiculos de imprensa', color: '#eab308' },
                        { name: 'Topicos', weight: 0.40, desc: 'Analise semantica de texto', color: '#ef4444' },
                      ].map(src => (
                        <div key={src.name} className="flex items-center gap-3 bg-slate-800/40 rounded-lg px-3 py-2 border border-slate-700/30">
                          <div className="flex-shrink-0 w-10 text-right font-mono text-sm font-bold" style={{ color: src.color }}>
                            {src.weight.toFixed(2)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-xs text-slate-200 font-medium truncate">{src.name}</div>
                            <div className="text-[10px] text-slate-500 truncate">{src.desc}</div>
                          </div>
                          {/* Visual bar */}
                          <div className="flex-shrink-0 w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${src.weight * 100}%`, backgroundColor: src.color }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Section 4: Confidence bands */}
                  <div className="border-t border-slate-700/50 pt-5">
                    <h3 className="text-sm font-semibold text-slate-200 mb-3">Faixas de confianca</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-3 text-center">
                        <div className="text-2xl font-bold text-green-400 mb-1">&gt;80%</div>
                        <div className="text-xs font-semibold text-green-400 mb-1">Forte</div>
                        <p className="text-[10px] text-slate-400 leading-relaxed">
                          Confirmado por multiplas fontes oficiais. Alta confianca — pode ser usado para tomada de decisao.
                        </p>
                      </div>
                      <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-lg p-3 text-center">
                        <div className="text-2xl font-bold text-yellow-400 mb-1">50-80%</div>
                        <div className="text-xs font-semibold text-yellow-400 mb-1">Possivel</div>
                        <p className="text-[10px] text-slate-400 leading-relaxed">
                          Evidencia parcial de fontes mistas. Recomenda-se verificacao adicional antes de conclusoes.
                        </p>
                      </div>
                      <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3 text-center">
                        <div className="text-2xl font-bold text-red-400 mb-1">&lt;50%</div>
                        <div className="text-xs font-semibold text-red-400 mb-1">Fraco</div>
                        <p className="text-[10px] text-slate-400 leading-relaxed">
                          Pouca evidencia, geralmente de fontes indiretas (noticias, topicos). Conexao nao confirmada.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Section 5: Real-world use cases */}
                  <div className="border-t border-slate-700/50 pt-5">
                    <h3 className="text-sm font-semibold text-slate-200 mb-3">Casos de uso praticos</h3>
                    <div className="space-y-3">
                      <div className="bg-slate-800/40 rounded-lg p-3 border border-slate-700/30">
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className="h-2 w-2 rounded-full bg-red-400 flex-shrink-0" />
                          <h4 className="text-xs font-semibold text-slate-200">Due Diligence empresarial</h4>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          Ao buscar &quot;Construtora Alpha&quot;, o Deep Search revela que o socio Joao Silva tambem aparece
                          como beneficiario de emendas parlamentares do Dep. Santos. A conexao empresa→politico,
                          que seria invisivel em buscas normais, emerge com 72% de confianca — suficiente para
                          investigacao aprofundada de possivel conflito de interesse.
                        </p>
                      </div>

                      <div className="bg-slate-800/40 rounded-lg p-3 border border-slate-700/30">
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className="h-2 w-2 rounded-full bg-blue-400 flex-shrink-0" />
                          <h4 className="text-xs font-semibold text-slate-200">Mapeamento de redes politicas</h4>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          Buscando o nome de um politico, o grafo mostra todas as empresas que receberam emendas,
                          os socios dessas empresas e suas conexoes com outros politicos. Conexoes com peso &gt;80%
                          indicam relacoes formais (sociedade, cargo). Conexoes 50-80% sugerem relacoes indiretas
                          que merecem atencao (beneficiario de emenda, mencionado junto em noticias).
                        </p>
                      </div>

                      <div className="bg-slate-800/40 rounded-lg p-3 border border-slate-700/30">
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className="h-2 w-2 rounded-full bg-orange-400 flex-shrink-0" />
                          <h4 className="text-xs font-semibold text-slate-200">Identificacao de pessoas-chave</h4>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          Ao buscar uma pessoa, o modelo cruza dados de contratos sociais, cadastros governamentais
                          e emendas para revelar todas as empresas e politicos associados. Um individuo que aparece
                          como socio em multiplas empresas que recebem emendas do mesmo politico cria um padrao
                          de &quot;hub&quot; no grafo — visualmente identificavel pelo tamanho do no e quantidade de conexoes.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Section 6: How to analyze */}
                  <div className="border-t border-slate-700/50 pt-5">
                    <h3 className="text-sm font-semibold text-slate-200 mb-3">Como analisar o grafo</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11px] text-slate-400">
                      <div className="space-y-2">
                        <p><strong className="text-amber-400">1. Comece pelo centro:</strong> O no central e o termo buscado. Nos maiores ao redor sao as conexoes mais fortes.</p>
                        <p><strong className="text-amber-400">2. Observe as cores:</strong> Vermelho = empresa, laranja = pessoa, azul = politico. Mistura de cores indica rede complexa.</p>
                        <p><strong className="text-amber-400">3. Avalie a espessura:</strong> Linhas grossas = multiplas fontes confirmam. Linhas finas = evidencia fragil.</p>
                      </div>
                      <div className="space-y-2">
                        <p><strong className="text-amber-400">4. Procure clusters:</strong> Grupos de nos conectados entre si sugerem estruturas organizacionais ou redes de influencia.</p>
                        <p><strong className="text-amber-400">5. Identifique hubs:</strong> Nos com muitas conexoes sao &quot;pontos de controle&quot; — pessoas ou empresas que conectam diferentes grupos.</p>
                        <p><strong className="text-amber-400">6. Verifique a %:</strong> Sempre confira a porcentagem de cada no. Conexoes &lt;50% precisam de verificacao manual.</p>
                      </div>
                    </div>
                  </div>

                </div>
              </div>
            </div>
          );
        }

        // Stats modal
        if (modal.type === 'stats') {
          return (
            <div
              key={`modal-${idx}`}
              className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm"
              style={{ zIndex }}
              onClick={popModal}
            >
              <div
                className="relative w-full max-w-lg max-h-[85vh] bg-[#0f1629] border border-cyan-500/20 rounded-xl shadow-2xl flex flex-col overflow-hidden mx-4"
                style={{ transform: `translate(${offset}px, ${offset}px)` }}
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700/50 flex-shrink-0">
                  <h2 className="text-sm font-semibold text-cyan-400">Estatisticas do Grafo</h2>
                  <button type="button" onClick={popModal} className="p-1 rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors">
                    <X size={16} />
                  </button>
                </div>
                <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
                  {/* Summary */}
                  {activeStats && (
                    <div>
                      <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Resumo</h4>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="bg-slate-800/60 rounded-lg px-3 py-2">
                          <div className="text-[10px] text-slate-500 uppercase">Total Nos</div>
                          <div className="text-lg font-bold text-cyan-400 tabular-nums">{activeStats.total_nodes}</div>
                        </div>
                        <div className="bg-slate-800/60 rounded-lg px-3 py-2">
                          <div className="text-[10px] text-slate-500 uppercase">Total Conexoes</div>
                          <div className="text-lg font-bold text-cyan-400 tabular-nums">{activeStats.total_edges}</div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Categories with toggles */}
                  <div>
                    <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Categorias</h4>
                    <div className="space-y-1.5">
                      {Object.entries(ENTITY_COLORS).map(([type, color]) => {
                        const count = activeStats ? getStatsCount(activeStats, type) : 0;
                        if (count === 0) return null;
                        const isHidden = hiddenCategories.has(type);
                        return (
                          <div key={type} className="flex items-center gap-2 text-xs">
                            <button
                              type="button"
                              onClick={() => setHiddenCategories(prev => {
                                const next = new Set(prev);
                                if (next.has(type)) next.delete(type); else next.add(type);
                                return next;
                              })}
                              className={`relative flex-shrink-0 w-8 h-4 rounded-full transition-colors ${isHidden ? 'bg-slate-700' : 'bg-slate-600'}`}
                            >
                              <div
                                className={`absolute top-0.5 h-3 w-3 rounded-full transition-all ${isHidden ? 'left-0.5 opacity-40' : 'left-[18px]'}`}
                                style={{ backgroundColor: color }}
                              />
                            </button>
                            <span className={`flex-1 min-w-0 truncate ${isHidden ? 'text-slate-600 line-through' : 'text-slate-300'}`}>
                              {ENTITY_LABELS[type]}
                            </span>
                            <span className="text-[10px] text-slate-500 tabular-nums flex-shrink-0">{count}</span>
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
                  </div>

                  {/* Bayesian model info (always shown) */}
                  <div>
                    <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Modelo de Evidencia</h4>
                    <div className="space-y-1.5 text-[10px] text-slate-400 leading-tight">
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 w-2.5 rounded-full bg-green-400 flex-shrink-0" />
                        <span>&gt;80% Forte</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 w-2.5 rounded-full bg-yellow-400 flex-shrink-0" />
                        <span>50-80% Possivel</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 w-2.5 rounded-full bg-red-400 flex-shrink-0" />
                        <span>&lt;50% Fraco</span>
                      </div>
                    </div>
                    <p className="mt-2 text-[10px] text-slate-500">
                      Bayesian: C = 1 - ∏(1 - p<sub>i</sub>)
                    </p>
                    <button
                      type="button"
                      onClick={() => pushModal({ type: 'bayesian' })}
                      className="mt-2 w-full text-left px-2 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-400 font-medium hover:bg-amber-500/20 transition-colors"
                    >
                      Bayesian Evidence Model →
                    </button>
                  </div>

                  {/* Sources */}
                  <div>
                    <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Fontes</h4>
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

                  {/* Legend button */}
                  <div className="pt-2 border-t border-slate-700/50">
                    <button
                      type="button"
                      onClick={() => pushModal({ type: 'info' })}
                      className="flex items-center gap-2 w-full px-3 py-2 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-400 font-medium hover:bg-red-500/20 transition-colors"
                    >
                      <Info size={14} />
                      Legenda do Grafo
                    </button>
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
