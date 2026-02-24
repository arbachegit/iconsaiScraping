'use client';

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Image from 'next/image';
import {
  X,
  Search,
  Check,
  Users,
  Loader2,
  ExternalLink,
  UserCheck,
  UserX,
  UserPlus,
  Database,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  searchCompany,
  getCompanyDetails,
  enrichSocios,
  approveCompany,
  listCompanies,
  formatCnpj,
  type CompanyDetails,
  type Socio,
  type CompanyCandidate,
} from '@/lib/api';

const PAGE_SIZE = 100;
const DEBOUNCE_MS = 300;

interface CompanyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenCnaeModal: () => void;
  onOpenRegimeModal: () => void;
  onOpenListingModal: () => void;
  userName: string;
  selectedCnae?: string;
  selectedRegime?: string;
}

export function CompanyModal({
  isOpen,
  onClose,
  onOpenCnaeModal,
  onOpenRegimeModal,
  onOpenListingModal,
  userName,
  selectedCnae,
  selectedRegime,
}: CompanyModalProps) {
  const [nome, setNome] = useState('');
  const [cidade, setCidade] = useState('');
  const [segmento, setSegmento] = useState('');
  const [regime, setRegime] = useState('');
  const [debouncedNome, setDebouncedNome] = useState('');
  const [page, setPage] = useState(1);
  const [manualResults, setManualResults] = useState<CompanyCandidate[] | null>(null);
  const [detailCnpj, setDetailCnpj] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (selectedCnae) setSegmento(selectedCnae);
  }, [selectedCnae]);

  useEffect(() => {
    if (selectedRegime) setRegime(selectedRegime);
  }, [selectedRegime]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // Debounce nome for auto-search
  useEffect(() => {
    if (nome.length < 2) {
      setDebouncedNome('');
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedNome(nome);
      setPage(1);
      setManualResults(null);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [nome]);

  // Reset page on filter changes
  useEffect(() => {
    setPage(1);
    setManualResults(null);
  }, [cidade]);

  // Scroll to top on page change
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [page]);

  // DB auto-search (paginated)
  const dbQuery = useQuery({
    queryKey: ['companies-search', debouncedNome, cidade, page],
    queryFn: () =>
      listCompanies({
        nome: debouncedNome || undefined,
        cidade: cidade || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
    enabled: isOpen && debouncedNome.length >= 2,
  });

  // Manual search (external + DB via Serper/Perplexity)
  const searchMutation = useMutation({
    mutationFn: searchCompany,
    onSuccess: (data) => {
      setMessage(null);
      if (!data.found) {
        setMessage({ type: 'error', text: 'Nenhuma empresa encontrada' });
        setManualResults([]);
        return;
      }
      if (data.single_match && data.company) {
        setDetailCnpj(data.company.cnpj);
        return;
      }
      setManualResults(data.candidates || []);
    },
    onError: (error: Error) => {
      setMessage({ type: 'error', text: error.message });
    },
  });

  function handleSearch() {
    const campos = [
      { nome: 'Nome', valor: nome },
      { nome: 'Cidade', valor: cidade },
      { nome: 'Segmento/CNAE', valor: segmento },
      { nome: 'Regime', valor: regime },
    ];
    const preenchidos = campos.filter((c) => c.valor && c.valor.length >= 2);
    if (preenchidos.length < 1) {
      setMessage({ type: 'error', text: 'Preencha pelo menos 1 campo para buscar' });
      return;
    }
    setMessage(null);
    const payload: Record<string, string> = {};
    if (nome) payload.nome = nome;
    if (cidade) payload.cidade = cidade;
    if (segmento) payload.segmento = segmento;
    if (regime) payload.regime = regime;
    searchMutation.mutate(payload);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearch();
    }
  }

  function handleClose() {
    setNome('');
    setCidade('');
    setSegmento('');
    setRegime('');
    setDebouncedNome('');
    setPage(1);
    setManualResults(null);
    setMessage(null);
    setDetailCnpj(null);
    onClose();
  }

  function handleCloseDetail() {
    setDetailCnpj(null);
    queryClient.invalidateQueries({ queryKey: ['companies-search'] });
  }

  // Display data
  const showManual = manualResults !== null;
  const dbResults = dbQuery.data?.empresas || [];
  const dbTotal = dbQuery.data?.total || 0;
  const totalPages = Math.ceil(dbTotal / PAGE_SIZE);

  const badgeCadastradas = showManual
    ? manualResults.filter((c) => c.fonte === 'interno').length
    : dbTotal;
  const badgeNovas = showManual
    ? manualResults.filter((c) => c.fonte !== 'interno').length
    : 0;
  const badgeTotal = showManual ? manualResults.length : dbTotal;

  const isLoading = searchMutation.isPending || (dbQuery.isFetching && dbResults.length === 0);
  const showBadges = debouncedNome.length >= 2 || showManual;

  if (!isOpen) return null;

  return (
    <>
      {/* Modal 1: Buscar Empresa */}
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
        <div className="w-[800px] max-w-[95vw] max-h-[85vh] flex flex-col rounded-2xl border border-cyan-500/15 bg-gradient-to-b from-[#0f1629] to-[#0a0e1a] shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-white/5 flex-shrink-0">
            <h2 className="text-xl font-semibold text-white flex items-center gap-2">
              <span className="w-1 h-5 bg-gradient-to-b from-cyan-400 to-blue-500 rounded" />
              Buscar Empresa
            </h2>
            <button
              onClick={handleClose}
              className="flex items-center justify-center w-9 h-9 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Search Form (fixed) */}
          <div className="flex-shrink-0 px-6 pt-4 pb-3 space-y-3 border-b border-white/5">
            <div className="flex gap-3">
              <Input
                ref={inputRef}
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Nome da empresa (min. 2 letras)"
                className="flex-[2]"
              />
              <Input
                value={cidade}
                onChange={(e) => setCidade(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Cidade"
                className="flex-1"
              />
            </div>
            <div className="flex gap-3">
              <div className="relative flex-1">
                <Input
                  value={segmento}
                  onChange={(e) => setSegmento(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Segmento / CNAE"
                  className="pr-24"
                />
                <button
                  type="button"
                  onClick={onOpenCnaeModal}
                  className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1.5 text-xs font-semibold bg-purple-500/15 border border-purple-500 text-purple-400 rounded-md hover:bg-purple-500 hover:text-white transition-colors"
                >
                  Listar CNAE
                </button>
              </div>
              <div className="relative flex-1">
                <Input
                  value={regime}
                  onChange={(e) => setRegime(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Regime Tributario"
                  className="pr-20"
                />
                <button
                  type="button"
                  onClick={onOpenRegimeModal}
                  className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1.5 text-xs font-semibold bg-green-500/15 border border-green-500/30 text-green-400 rounded-md hover:bg-green-500 hover:text-white transition-colors"
                >
                  Listar
                </button>
              </div>
            </div>
            <div className="flex gap-3 items-center">
              <Button
                onClick={handleSearch}
                disabled={searchMutation.isPending}
                className="h-12 px-6 bg-cyan-500/15 border-2 border-cyan-500 text-cyan-400 hover:bg-cyan-500 hover:text-white"
              >
                {searchMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Search className="h-4 w-4 mr-2" />
                )}
                Buscar
              </Button>
              <Button onClick={onOpenListingModal} variant="outline" className="h-12 px-6">
                Listar
              </Button>

              {/* Badges */}
              {showBadges && (
                <div className="flex gap-2 ml-auto">
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-500/10 border border-slate-500/20 text-slate-300 text-xs font-medium">
                    Total: {badgeTotal}
                  </span>
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-medium">
                    <Database className="h-3 w-3" />
                    {badgeCadastradas}
                  </span>
                  {badgeNovas > 0 && (
                    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-medium">
                      <Sparkles className="h-3 w-3" />
                      {badgeNovas}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Scrollable Results Area */}
          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
          >
            <div className="p-6">
              {/* Message */}
              {message && (
                <div
                  className={cn(
                    'p-4 rounded-lg mb-4',
                    message.type === 'success'
                      ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                      : 'bg-red-500/10 border border-red-500/30 text-red-400'
                  )}
                >
                  {message.text}
                </div>
              )}

              {/* Loading */}
              {isLoading && (
                <div className="flex flex-col items-center justify-center py-10 text-slate-400">
                  <Loader2 className="h-10 w-10 animate-spin text-cyan-400 mb-4" />
                  <span>Buscando empresas...</span>
                </div>
              )}

              {/* Manual Search Results */}
              {showManual && !searchMutation.isPending && manualResults.length > 0 && (
                <div className="space-y-2">
                  {manualResults.map((c) => (
                    <CompanyRow
                      key={c.cnpj}
                      cnpj={c.cnpj}
                      cnpjFormatted={c.cnpj_formatted}
                      razaoSocial={c.razao_social}
                      nomeFantasia={c.nome_fantasia}
                      localizacao={c.localizacao}
                      fonte={c.fonte === 'interno' ? 'interno' : 'externo'}
                      onClick={() => setDetailCnpj(c.cnpj)}
                    />
                  ))}
                </div>
              )}

              {/* Auto-search DB Results */}
              {!showManual && debouncedNome.length >= 2 && !dbQuery.isLoading && dbResults.length > 0 && (
                <div className="space-y-2">
                  {dbResults.map((e) => (
                    <CompanyRow
                      key={e.id}
                      cnpj={e.cnpj}
                      cnpjFormatted={formatCnpj(e.cnpj)}
                      razaoSocial={e.razao_social}
                      nomeFantasia={e.nome_fantasia}
                      localizacao={e.cidade && e.estado ? `${e.cidade} - ${e.estado}` : e.cidade}
                      fonte="interno"
                      onClick={() => setDetailCnpj(e.cnpj)}
                    />
                  ))}
                </div>
              )}

              {/* Empty state */}
              {!isLoading &&
                debouncedNome.length >= 2 &&
                !showManual &&
                dbResults.length === 0 &&
                !dbQuery.isLoading && (
                  <div className="text-center py-10 text-slate-500">
                    Nenhuma empresa cadastrada encontrada. Use o botao &quot;Buscar&quot; para pesquisar
                    em fontes externas.
                  </div>
                )}

              {/* Pagination (auto-search only) */}
              {!showManual && totalPages > 1 && (
                <div className="flex items-center justify-center gap-3 mt-6 pt-4 border-t border-white/5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="h-9"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Anterior
                  </Button>
                  <span className="text-sm text-slate-400">
                    Pagina {page} de {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="h-9"
                  >
                    Proxima
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Modal 2: Detalhe da Empresa (empilhado) */}
      {detailCnpj && (
        <CompanyDetailModal cnpj={detailCnpj} onClose={handleCloseDetail} userName={userName} />
      )}
    </>
  );
}

// ============================================
// Company Row
// ============================================

function CompanyRow({
  cnpj,
  cnpjFormatted,
  razaoSocial,
  nomeFantasia,
  localizacao,
  fonte,
  onClick,
}: {
  cnpj: string;
  cnpjFormatted: string;
  razaoSocial: string;
  nomeFantasia?: string;
  localizacao?: string;
  fonte: 'interno' | 'externo';
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.06] cursor-pointer hover:border-cyan-500/40 hover:bg-cyan-500/5 transition-colors"
    >
      <div className="flex justify-between items-start gap-3 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          {fonte === 'interno' ? (
            <Database className="h-4 w-4 text-green-400 flex-shrink-0" />
          ) : (
            <Sparkles className="h-4 w-4 text-amber-400 flex-shrink-0" />
          )}
          <span className="text-slate-200 font-semibold text-sm truncate">
            {razaoSocial || 'Sem nome'}
          </span>
          <span
            className={cn(
              'flex-shrink-0 px-1.5 py-0.5 text-[10px] font-bold rounded',
              fonte === 'interno'
                ? 'bg-green-500/15 text-green-400 border border-green-500/30'
                : 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
            )}
          >
            {fonte === 'interno' ? 'Cadastrada' : 'Nova'}
          </span>
        </div>
        {localizacao && (
          <span className="text-xs text-slate-400 bg-slate-400/10 px-2 py-1 rounded border border-slate-400/20 whitespace-nowrap">
            {localizacao}
          </span>
        )}
      </div>
      <div className="flex justify-between items-center">
        <span className="text-slate-500 text-sm">{cnpjFormatted}</span>
        {nomeFantasia && (
          <span className="text-slate-500 text-sm truncate max-w-[200px]">{nomeFantasia}</span>
        )}
      </div>
    </div>
  );
}

// ============================================
// Company Detail Modal (stacked - Modal 2)
// ============================================

function CompanyDetailModal({
  cnpj,
  onClose,
  userName,
}: {
  cnpj: string;
  onClose: () => void;
  userName: string;
}) {
  const [showSocios, setShowSocios] = useState(false);
  const [enrichedSocios, setEnrichedSocios] = useState<Socio[] | null>(null);
  const [isApproved, setIsApproved] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const detailsQuery = useQuery({
    queryKey: ['company-detail', cnpj],
    queryFn: () => getCompanyDetails(cnpj),
    enabled: !!cnpj,
  });

  const enrichMutation = useMutation({
    mutationFn: enrichSocios,
    onSuccess: (data) => {
      if (data.success && data.socios) {
        setEnrichedSocios(data.socios);
        setShowSocios(true);
      }
    },
    onError: (error: Error) => {
      setMessage({ type: 'error', text: error.message });
    },
  });

  const approveMutation = useMutation({
    mutationFn: approveCompany,
    onSuccess: (data) => {
      if (data.success) {
        setMessage({
          type: 'success',
          text: `Empresa cadastrada com sucesso! ${data.socios?.length || 0} socio(s) adicionado(s)`,
        });
        setIsApproved(true);
      }
    },
    onError: (error: Error) => {
      setMessage({ type: 'error', text: error.message });
    },
  });

  const data = detailsQuery.data;
  const empresa = data?.empresa;
  const isExisting = data?.exists || isApproved;
  const socios = data?.socios || [];
  const sociosAtivos = data?.socios_ativos || [];
  const sociosInativos = data?.socios_inativos || [];
  const sociosNovos = data?.socios_novos || [];
  const displaySocios = enrichedSocios || socios;

  function handleLoadSocios() {
    if (!empresa || socios.length === 0) return;
    enrichMutation.mutate({
      socios: socios,
      empresa_nome: empresa.nome_fantasia || empresa.razao_social,
    });
  }

  function handleApprove() {
    if (!empresa) return;
    approveMutation.mutate({
      empresa: empresa,
      socios: displaySocios,
      aprovado_por: userName,
    });
  }

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60">
      <div className="w-[800px] max-w-[95vw] max-h-[85vh] flex flex-col rounded-2xl border border-cyan-500/15 bg-gradient-to-b from-[#0f1629] to-[#0a0e1a] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/5 flex-shrink-0">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <span className="w-1 h-5 bg-gradient-to-b from-cyan-400 to-blue-500 rounded" />
            Detalhes da Empresa
          </h2>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-6">
          {detailsQuery.isLoading ? (
            <div className="flex flex-col items-center justify-center py-10 text-slate-400">
              <Loader2 className="h-10 w-10 animate-spin text-cyan-400 mb-4" />
              <span>Carregando detalhes...</span>
            </div>
          ) : detailsQuery.isError ? (
            <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400">
              Erro ao carregar detalhes: {(detailsQuery.error as Error).message}
            </div>
          ) : empresa ? (
            <div className="space-y-4">
              {/* Messages */}
              {message && (
                <div
                  className={cn(
                    'p-4 rounded-lg',
                    message.type === 'success'
                      ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                      : 'bg-red-500/10 border border-red-500/30 text-red-400'
                  )}
                >
                  {message.text}
                </div>
              )}

              {isExisting && !isApproved && (
                <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm">
                  Empresa ja cadastrada no sistema. Socios cruzados com QSA atual da Receita Federal.
                </div>
              )}

              {/* Company Data */}
              <div className="bg-white/[0.02] border border-white/5 rounded-xl p-6">
                <DetailRow label="CNPJ" value={formatCnpj(empresa.cnpj)} />
                <DetailRow label="Razao Social" value={empresa.razao_social} />
                <DetailRow label="Nome Fantasia" value={empresa.nome_fantasia} />
                <DetailRow
                  label="CNAE"
                  value={`${empresa.cnae_principal || '-'} - ${empresa.cnae_descricao || ''}`}
                />
                <DetailRow label="Porte" value={empresa.porte} />
                <DetailRow label="Situacao" value={empresa.situacao_cadastral} />
                <DetailRow
                  label="Capital Social"
                  value={
                    empresa.capital_social
                      ? `R$ ${Number(empresa.capital_social).toLocaleString('pt-BR')}`
                      : '-'
                  }
                />
                <DetailRow
                  label="Endereco"
                  value={[
                    empresa.logradouro,
                    empresa.numero,
                    empresa.bairro,
                    empresa.cidade,
                    empresa.estado,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                />
                <DetailRow label="Telefone" value={empresa.telefone_1} />
                <DetailRow label="Email" value={empresa.email} />
                <DetailRow
                  label="Website"
                  value={
                    empresa.website && empresa.website !== 'NAO_POSSUI' ? (
                      <a
                        href={empresa.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-cyan-400 hover:underline inline-flex items-center gap-1"
                      >
                        {empresa.website} <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      '-'
                    )
                  }
                />
                <DetailRow
                  label="LinkedIn"
                  value={
                    empresa.linkedin && empresa.linkedin !== 'NAO_POSSUI' ? (
                      <a
                        href={empresa.linkedin}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-cyan-400 hover:underline inline-flex items-center gap-1"
                      >
                        Ver perfil <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : empresa.linkedin === 'NAO_POSSUI' ? (
                      <span className="text-red-400">Nao possui</span>
                    ) : (
                      <span className="text-slate-500">Nao informado</span>
                    )
                  }
                />

                {/* Socios - Existing company (categorized) */}
                {isExisting &&
                  !isApproved &&
                  (sociosAtivos.length > 0 ||
                    sociosInativos.length > 0 ||
                    sociosNovos.length > 0) && (
                    <div className="mt-6 pt-5 border-t border-white/5 space-y-5">
                      {sociosAtivos.length > 0 && (
                        <div>
                          <div className="text-slate-400 text-sm font-semibold mb-3 flex items-center gap-2">
                            <UserCheck className="h-4 w-4 text-green-400" />
                            Socios Ativos
                            <span className="bg-green-500/15 text-green-400 px-2 py-0.5 rounded text-xs">
                              {sociosAtivos.length}
                            </span>
                          </div>
                          <div className="space-y-3">
                            {sociosAtivos.map((s, i) => (
                              <SocioCard key={`ativo-${i}`} socio={s} variant="ativo" />
                            ))}
                          </div>
                        </div>
                      )}
                      {sociosInativos.length > 0 && (
                        <div>
                          <div className="text-slate-400 text-sm font-semibold mb-3 flex items-center gap-2">
                            <UserX className="h-4 w-4 text-red-400" />
                            Ex-Socios
                            <span className="bg-red-500/15 text-red-400 px-2 py-0.5 rounded text-xs">
                              {sociosInativos.length}
                            </span>
                          </div>
                          <div className="space-y-3">
                            {sociosInativos.map((s, i) => (
                              <SocioCard key={`inativo-${i}`} socio={s} variant="inativo" />
                            ))}
                          </div>
                        </div>
                      )}
                      {sociosNovos.length > 0 && (
                        <div>
                          <div className="text-slate-400 text-sm font-semibold mb-3 flex items-center gap-2">
                            <UserPlus className="h-4 w-4 text-blue-400" />
                            Novos Socios (QSA)
                            <span className="bg-blue-500/15 text-blue-400 px-2 py-0.5 rounded text-xs">
                              {sociosNovos.length}
                            </span>
                          </div>
                          <div className="space-y-3">
                            {sociosNovos.map((s, i) => (
                              <SocioCard key={`novo-${i}`} socio={s} variant="novo" />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                {/* Socios - New company */}
                {!isExisting && showSocios && displaySocios.length > 0 && (
                  <div className="mt-6 pt-5 border-t border-white/5">
                    <div className="text-slate-400 text-sm font-semibold mb-3 flex items-center gap-2">
                      Socios{' '}
                      <span className="bg-purple-500/15 text-purple-400 px-2 py-0.5 rounded text-xs">
                        {displaySocios.length}
                      </span>
                    </div>
                    <div className="space-y-3">
                      {displaySocios.map((s, i) => (
                        <SocioCard key={`socio-${i}`} socio={s} variant="default" />
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col gap-3">
                {!isExisting && socios.length > 0 && !showSocios && (
                  <Button
                    onClick={handleLoadSocios}
                    disabled={enrichMutation.isPending}
                    className="h-12 w-full bg-purple-500/15 border-2 border-purple-500 text-purple-400 hover:bg-purple-500 hover:text-white"
                  >
                    {enrichMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Users className="h-4 w-4 mr-2" />
                    )}
                    {enrichMutation.isPending
                      ? 'Buscando LinkedIn...'
                      : `Ver Socios (${socios.length})`}
                  </Button>
                )}

                {isExisting ? (
                  <Button
                    disabled
                    className="h-12 w-full bg-slate-500/15 border-2 border-slate-500/30 text-slate-400 cursor-not-allowed"
                  >
                    <Check className="h-4 w-4 mr-2" />
                    Ja Cadastrada
                  </Button>
                ) : (
                  <Button
                    onClick={handleApprove}
                    disabled={approveMutation.isPending || isApproved}
                    className="h-12 w-full bg-green-500/15 border-2 border-green-500 text-green-400 hover:bg-green-500 hover:text-white"
                  >
                    {approveMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Check className="h-4 w-4 mr-2" />
                    )}
                    {approveMutation.isPending ? 'Salvando...' : 'Aprovar e Cadastrar'}
                  </Button>
                )}

                <Button onClick={onClose} variant="outline" className="h-12 w-full">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Voltar
                </Button>
              </div>

              {/* Error message */}
              {message?.type === 'error' && (
                <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400">
                  {message.text}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ============================================
// Shared Components
// ============================================

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex py-2.5 border-b border-white/[0.04] last:border-b-0">
      <span className="text-slate-500 text-sm font-medium w-32 flex-shrink-0">{label}</span>
      <span className="text-slate-300 text-sm flex-1">{value || '-'}</span>
    </div>
  );
}

const SOCIO_VARIANT_STYLES = {
  ativo: { bg: 'bg-green-500/15', text: 'text-green-400', border: 'border-green-500/20' },
  inativo: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/20' },
  novo: { bg: 'bg-blue-500/15', text: 'text-blue-400', border: 'border-blue-500/20' },
  default: { bg: 'bg-purple-500/15', text: 'text-purple-400', border: 'border-white/5' },
} as const;

function SocioCard({
  socio: s,
  variant,
}: {
  socio: Socio;
  variant: keyof typeof SOCIO_VARIANT_STYLES;
}) {
  const style = SOCIO_VARIANT_STYLES[variant];

  return (
    <div className={cn('flex gap-3 p-4 bg-white/[0.02] border rounded-xl', style.border)}>
      <div
        className={cn(
          'w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden',
          style.bg
        )}
      >
        {s.foto_url ? (
          <Image
            src={s.foto_url}
            alt={s.nome}
            width={44}
            height={44}
            className="w-full h-full object-cover"
            unoptimized
          />
        ) : (
          <span className={cn('font-semibold', style.text)}>
            {s.nome?.charAt(0).toUpperCase() || '?'}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-slate-200 font-semibold text-sm truncate">{s.nome}</span>
          {variant === 'ativo' && (
            <span className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-bold rounded bg-green-500/15 text-green-400 border border-green-500/30">
              Ativo
            </span>
          )}
          {variant === 'inativo' && (
            <span className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-bold rounded bg-red-500/10 text-red-400 border border-red-500/30">
              Saiu
            </span>
          )}
          {variant === 'novo' && (
            <span className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-bold rounded bg-blue-500/15 text-blue-400 border border-blue-500/30">
              Novo no QSA
            </span>
          )}
        </div>
        <div className="text-slate-500 text-sm">{s.qualificacao || s.cargo || 'Socio'}</div>
        <div className="flex flex-wrap gap-2 text-sm mt-1">
          {s.cpf && (
            <span className="text-slate-500">
              CPF: ***{s.cpf.slice(-6, -2)}**-{s.cpf.slice(-2)}
            </span>
          )}
          {s.data_entrada && <span className="text-slate-500">Entrada: {s.data_entrada}</span>}
          {s.email && <span className="text-slate-500">{s.email}</span>}
          {s.linkedin && s.linkedin !== 'NAO_POSSUI' ? (
            <a
              href={s.linkedin}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-400 hover:underline"
            >
              LinkedIn
            </a>
          ) : s.linkedin === 'NAO_POSSUI' ? (
            <span className="text-red-400">Nao possui LinkedIn</span>
          ) : variant !== 'novo' ? (
            <span className="text-red-400">Sem LinkedIn</span>
          ) : null}
        </div>
        {s.headline && <div className="text-slate-400 text-xs mt-1">{s.headline}</div>}
      </div>
    </div>
  );
}
