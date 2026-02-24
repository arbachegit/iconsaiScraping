'use client';

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { X, Search, ArrowLeft, Loader2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { listNews, listNewsSources, searchNewsAI, getNewsDetails, type NewsItem } from '@/lib/api';

interface NewsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenListingModal: () => void;
}

type ViewState = 'search' | 'details';

export function NewsModal({ isOpen, onClose, onOpenListingModal }: NewsModalProps) {
  const [view, setView] = useState<ViewState>('search');
  const [query, setQuery] = useState('');
  const [dataInicio, setDataInicio] = useState('');
  const [dataFim, setDataFim] = useState('');
  const [idioma, setIdioma] = useState('pt');
  const [pais, setPais] = useState('BR');
  const [fonte, setFonte] = useState('');
  const [tipo, setTipo] = useState('');
  const [selectedNewsId, setSelectedNewsId] = useState<string | null>(null);
  const [transformedQuery, setTransformedQuery] = useState<string | null>(null);
  const [citations, setCitations] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      // Set default date range
      const hoje = new Date();
      const umaSemanaAtras = new Date();
      umaSemanaAtras.setDate(hoje.getDate() - 7);
      setDataFim(hoje.toISOString().split('T')[0]);
      setDataInicio(umaSemanaAtras.toISOString().split('T')[0]);
    }
  }, [isOpen]);

  const sourcesQuery = useQuery({
    queryKey: ['news-sources'],
    queryFn: listNewsSources,
    enabled: isOpen,
  });

  const listQuery = useQuery({
    queryKey: ['news', 'list'],
    queryFn: () => listNews({ limit: 50 }),
    enabled: isOpen,
  });

  const searchMutation = useMutation({
    mutationFn: searchNewsAI,
    onSuccess: (data) => {
      setTransformedQuery(data.transformed_query || null);
      setCitations(data.citations || []);
    },
  });

  const detailsQuery = useQuery({
    queryKey: ['news', selectedNewsId],
    queryFn: () => getNewsDetails(selectedNewsId!),
    enabled: !!selectedNewsId && view === 'details',
  });

  const news = searchMutation.data?.news || listQuery.data?.news || [];
  const count = searchMutation.data?.count || listQuery.data?.count || 0;
  const isLoading = searchMutation.isPending || listQuery.isLoading;
  const sources = sourcesQuery.data?.sources || [];

  function handleSearch() {
    if (!query.trim()) {
      searchMutation.reset();
      setTransformedQuery(null);
      setCitations([]);
      return;
    }
    searchMutation.mutate({
      q: query,
      idioma,
      pais,
      fonte: fonte || undefined,
      data_inicio: dataInicio || undefined,
      data_fim: dataFim || undefined,
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearch();
    }
  }

  function handleSelectNews(newsId: string) {
    setSelectedNewsId(newsId);
    setView('details');
  }

  function handleBack() {
    setView('search');
    setSelectedNewsId(null);
  }

  function handleClose() {
    setView('search');
    setQuery('');
    setSelectedNewsId(null);
    setTransformedQuery(null);
    setCitations([]);
    searchMutation.reset();
    onClose();
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-cyan-500/15 bg-gradient-to-b from-[#0f1629] to-[#0a0e1a] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/5 flex-shrink-0">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <span className="w-1 h-5 bg-gradient-to-b from-green-400 to-green-600 rounded" />
            Noticias
          </h2>
          <button
            onClick={handleClose}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {view === 'search' ? (
            <>
              {/* Search Form */}
              <div className="space-y-3 mb-4">
                <Input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Termo(s) / query"
                />
                <div className="flex gap-2 flex-wrap">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-500">Data inicial</label>
                    <input
                      type="date"
                      value={dataInicio}
                      onChange={(e) => setDataInicio(e.target.value)}
                      className="px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:border-cyan-500/50"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-500">Data final</label>
                    <input
                      type="date"
                      value={dataFim}
                      onChange={(e) => setDataFim(e.target.value)}
                      className="px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:border-cyan-500/50"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-500">Idioma</label>
                    <select
                      value={idioma}
                      onChange={(e) => setIdioma(e.target.value)}
                      className="px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-white text-sm min-w-[100px] focus:outline-none focus:border-cyan-500/50"
                    >
                      <option value="pt">Portugues</option>
                      <option value="en">English</option>
                      <option value="es">Espanol</option>
                      <option value="">Todos</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-500">Pais</label>
                    <select
                      value={pais}
                      onChange={(e) => setPais(e.target.value)}
                      className="px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-white text-sm min-w-[100px] focus:outline-none focus:border-cyan-500/50"
                    >
                      <option value="BR">Brasil</option>
                      <option value="US">Estados Unidos</option>
                      <option value="PT">Portugal</option>
                      <option value="">Todos</option>
                    </select>
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-500">Fonte</label>
                    <select
                      value={fonte}
                      onChange={(e) => setFonte(e.target.value)}
                      className="px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-white text-sm min-w-[180px] focus:outline-none focus:border-cyan-500/50"
                    >
                      <option value="">Todas as fontes</option>
                      {sources.map((s) => (
                        <option key={s.id} value={s.nome || s.id}>
                          {s.nome || s.url}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-500">Tipo</label>
                    <select
                      value={tipo}
                      onChange={(e) => setTipo(e.target.value)}
                      className="px-3 py-2 bg-white/[0.03] border border-white/10 rounded-lg text-white text-sm min-w-[140px] focus:outline-none focus:border-cyan-500/50"
                    >
                      <option value="">Todos os tipos</option>
                      <option value="noticia">Noticia</option>
                      <option value="opiniao">Opiniao</option>
                      <option value="editorial">Editorial</option>
                      <option value="press_release">Press Release</option>
                      <option value="blog">Blog</option>
                      <option value="post_social">Post Social</option>
                    </select>
                  </div>
                  <div className="flex items-end gap-2">
                    <Button
                      onClick={handleSearch}
                      disabled={isLoading}
                      className="h-10 px-6 bg-cyan-500/15 border-2 border-cyan-500 text-cyan-400 hover:bg-cyan-500 hover:text-white"
                    >
                      {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      ) : (
                        <Search className="h-4 w-4 mr-2" />
                      )}
                      Buscar
                    </Button>
                    <Button onClick={onOpenListingModal} variant="outline" className="h-10 px-6">
                      Listar
                    </Button>
                  </div>
                </div>
              </div>

              {/* Transformed Query Info */}
              {transformedQuery && transformedQuery !== query && (
                <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm">
                  <strong className="text-blue-400">IA expandiu:</strong>{' '}
                  <span className="text-slate-300">&quot;{transformedQuery}&quot;</span>
                </div>
              )}

              {/* Loading */}
              {isLoading && (
                <div className="flex flex-col items-center justify-center py-10 text-slate-400">
                  <Loader2 className="h-10 w-10 animate-spin text-cyan-400 mb-4" />
                  <span>Buscando com IA em tempo real...</span>
                </div>
              )}

              {/* Results */}
              {!isLoading && news.length > 0 && (
                <>
                  <div className="text-slate-400 text-sm mb-4 pb-2 border-b border-white/5">
                    <strong>{count}</strong> noticia(s) encontrada(s)
                    {searchMutation.data ? ' em tempo real' : ''}
                  </div>
                  <div className="space-y-3">
                    {news.map((n) => (
                      <NewsCard key={n.id} news={n} onClick={() => handleSelectNews(n.id)} />
                    ))}
                  </div>

                  {/* Citations */}
                  {citations.length > 0 && (
                    <div className="mt-4 p-3 bg-white/[0.03] rounded-lg">
                      <strong className="text-xs text-slate-500">Fontes consultadas:</strong>
                      <div className="mt-1 space-y-1">
                        {citations.slice(0, 5).map((c, i) => (
                          <a
                            key={i}
                            href={c}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-400 block truncate hover:underline"
                          >
                            {c}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {!isLoading && news.length === 0 && (
                <div className="text-center py-10 text-slate-500">
                  {query
                    ? `Nenhuma noticia encontrada para "${query}".`
                    : 'Nenhuma noticia encontrada na base.'}
                </div>
              )}
            </>
          ) : (
            <>
              {/* News Details View */}
              <Button onClick={handleBack} variant="outline" className="mb-4">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Voltar
              </Button>

              {detailsQuery.isLoading && (
                <div className="flex flex-col items-center justify-center py-10 text-slate-400">
                  <Loader2 className="h-10 w-10 animate-spin text-cyan-400 mb-4" />
                  <span>Carregando detalhes...</span>
                </div>
              )}

              {detailsQuery.isError && (
                <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400">
                  Erro ao carregar detalhes
                </div>
              )}

              {detailsQuery.data?.success && detailsQuery.data.news && <NewsDetailsView news={detailsQuery.data.news} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NewsCard({ news, onClick }: { news: NewsItem; onClick: () => void }) {
  const titulo = news.titulo || 'Sem titulo';
  const resumo = news.resumo ? news.resumo.substring(0, 150) + '...' : '';
  const fonte = news.fonte_nome || news.fonte || '';
  const data = news.data_publicacao
    ? new Date(news.data_publicacao).toLocaleDateString('pt-BR')
    : news.data
      ? new Date(news.data).toLocaleDateString('pt-BR')
      : '';
  const relevancia = news.relevancia || 'media';
  const relevanciaColor =
    relevancia === 'alta'
      ? 'text-green-400'
      : relevancia === 'baixa'
        ? 'text-yellow-400'
        : 'text-slate-500';

  return (
    <div
      onClick={onClick}
      className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.06] cursor-pointer hover:border-cyan-500/40 hover:bg-cyan-500/5 transition-colors"
    >
      <div className="flex justify-between items-start gap-3 mb-1">
        <strong className="text-slate-200 text-sm">{titulo}</strong>
        {fonte && (
          <span className="text-xs text-slate-400 bg-slate-400/10 px-2 py-0.5 rounded whitespace-nowrap">
            {fonte}
          </span>
        )}
      </div>
      {resumo && <p className="text-slate-400 text-sm mb-2">{resumo}</p>}
      <div className="flex justify-between items-center">
        {data && <span className="text-slate-500 text-xs">{data}</span>}
        <span className={`text-xs uppercase ${relevanciaColor}`}>{relevancia}</span>
      </div>
    </div>
  );
}

function NewsDetailsView({ news }: { news: NewsItem }) {
  const titulo = news.titulo || 'Sem titulo';
  const data = news.data_publicacao
    ? new Date(news.data_publicacao).toLocaleDateString('pt-BR')
    : '';

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-semibold text-white mb-2">{titulo}</h3>
        <div className="flex gap-3 text-sm">
          {news.fonte_nome && (
            <span className="text-slate-400 bg-slate-400/10 px-2 py-1 rounded">
              {news.fonte_nome}
            </span>
          )}
          {data && <span className="text-slate-500">{data}</span>}
        </div>
      </div>

      {news.resumo && (
        <div className="p-4 bg-white/[0.02] border border-white/5 rounded-lg">
          <p className="text-slate-300 text-sm">{news.resumo}</p>
        </div>
      )}

      {news.conteudo && (
        <div className="p-4 bg-white/[0.02] border border-white/5 rounded-lg">
          <p className="text-slate-300 text-sm">{news.conteudo}</p>
        </div>
      )}

      {news.url && (
        <a
          href={news.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-cyan-500/15 border border-cyan-500 text-cyan-400 rounded-lg hover:bg-cyan-500 hover:text-white transition-colors"
        >
          Ver noticia original <ExternalLink className="h-4 w-4" />
        </a>
      )}
    </div>
  );
}
