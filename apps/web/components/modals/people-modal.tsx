'use client';

import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import Image from 'next/image';
import {
  X, Search, Loader2, User, Building2, Briefcase,
  AlertCircle, Check, ChevronLeft, ChevronRight, Download,
  Database, Globe, Shield, ArrowLeft, ExternalLink,
  MessageCircle, Filter,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  searchPeopleV2,
  checkExistingPeople,
  savePerson,
  savePeopleBatch,
  type PeopleSearchV2Response,
  type PeopleSearchResult,
  type GuardrailResult,
  type QualityGateResult,
} from '@/lib/api';
import { PeopleAgentInlineChat } from '@/components/people-agent/people-agent-inline-chat';

interface PeopleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenListingModal: () => void;
  userName?: string;
}

export function PeopleModal({ isOpen, onClose, onOpenListingModal, userName = 'sistema' }: PeopleModalProps) {
  // Search state
  const [searchType, setSearchType] = useState<'cpf' | 'nome'>('cpf');
  const [cpf, setCpf] = useState('');
  const [nome, setNome] = useState('');
  const [cidadeUf, setCidadeUf] = useState('');
  const [dataNascimento, setDataNascimento] = useState('');
  const [page, setPage] = useState(1);

  // Results state
  const [response, setResponse] = useState<PeopleSearchV2Response | null>(null);
  const [guardrailResult, setGuardrailResult] = useState<GuardrailResult | null>(null);
  const [registeredIds, setRegisteredIds] = useState<Set<string>>(new Set());

  // Detail view state
  const [detailPerson, setDetailPerson] = useState<PeopleSearchResult | null>(null);

  // Loading states
  const [insertingId, setInsertingId] = useState<string | null>(null);
  const [massInserting, setMassInserting] = useState(false);

  // Feedback
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Chat panel
  const [chatOpen, setChatOpen] = useState(false);

  // Abort controller
  const abortControllerRef = useRef<AbortController | null>(null);
  const cpfInputRef = useRef<HTMLInputElement>(null);
  const nomeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      if (searchType === 'cpf') {
        cpfInputRef.current?.focus();
      } else {
        nomeInputRef.current?.focus();
      }
    }
  }, [isOpen, searchType]);

  // ---- Search mutation ----
  const searchMutation = useMutation({
    mutationFn: async (params: { pageOverride?: number }) => {
      // Abort previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const currentPage = params.pageOverride ?? page;

      const cpfDigits = cpf.replace(/\D/g, '');

      return searchPeopleV2({
        searchType,
        cpf: searchType === 'cpf' ? cpfDigits : undefined,
        nome: searchType === 'nome' ? nome.trim() : undefined,
        cidadeUf: cidadeUf.trim() || undefined,
        dataNascimento: dataNascimento.trim() || undefined,
        page: currentPage,
        pageSize: 100,
      }, controller.signal);
    },
    onSuccess: async (data) => {
      setResponse(data);
      setGuardrailResult(data.guardrail);
      setMessage(null);

      if (!data.guardrail.allowed) {
        // Guardrail blocked → show reason
        return;
      }

      if (data.results.length === 0) {
        setMessage({ type: 'info', text: 'Nenhuma pessoa encontrada nas fontes disponíveis' });
        return;
      }

      // Batch check existing
      const ids = data.results.filter(r => r.id).map(r => r.id!);
      const cpfs = data.results.filter(r => r.cpf).map(r => r.cpf!);

      if (ids.length > 0 || cpfs.length > 0) {
        try {
          const checkResult = await checkExistingPeople({ ids, cpfs });
          if (checkResult.success) {
            setRegisteredIds(new Set(checkResult.existing));
          }
        } catch {
          // Non-critical, continue
        }
      }
    },
    onError: (error: Error) => {
      if (error.name === 'AbortError') return;
      setMessage({ type: 'error', text: error.message });
    },
  });

  // ---- Actions ----
  const handleSearch = useCallback(() => {
    const cpfDigits = cpf.replace(/\D/g, '');

    if (searchType === 'cpf') {
      if (cpfDigits.length !== 11) {
        setMessage({ type: 'error', text: 'CPF deve ter 11 dígitos' });
        return;
      }
    } else {
      if (nome.trim().length < 2) {
        setMessage({ type: 'error', text: 'Nome deve ter pelo menos 2 caracteres' });
        return;
      }
    }

    setMessage(null);
    setPage(1);
    searchMutation.mutate({ pageOverride: 1 });
  }, [searchType, cpf, nome, searchMutation]);

  function handlePageChange(newPage: number) {
    setPage(newPage);
    searchMutation.mutate({ pageOverride: newPage });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearch();
    }
  }

  async function handleInsertSingle(pessoa: PeopleSearchResult) {
    const key = pessoa.id || pessoa.cpf || pessoa.nome_completo || '';
    setInsertingId(key);
    setMessage(null);

    try {
      const result = await savePerson({
        pessoa: {
          cpf: pessoa.cpf || '',
          nome_completo: pessoa.nome_completo,
          cargo_atual: pessoa.cargo_atual,
          empresa_atual: pessoa.empresa_atual,
          linkedin_url: pessoa.linkedin_url,
          email: pessoa.email,
          localizacao: pessoa.localizacao,
          resumo_profissional: pessoa.resumo_profissional,
          foto_url: pessoa.foto_url,
        },
        aprovado_por: userName,
      });

      if (result.success) {
        setRegisteredIds(prev => new Set([...prev, key]));
        setMessage({ type: 'success', text: `${pessoa.nome_completo} cadastrada com sucesso` });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Erro ao inserir';
      setMessage({ type: 'error', text: msg });
    } finally {
      setInsertingId(null);
    }
  }

  async function handleMassInsert() {
    if (!response?.results) return;

    const newPeople = response.results.filter(r => {
      const key = r.id || r.cpf || r.nome_completo || '';
      return r._source === 'external' && !registeredIds.has(key);
    });

    if (newPeople.length === 0) {
      setMessage({ type: 'info', text: 'Todas as pessoas já estão cadastradas' });
      return;
    }

    setMassInserting(true);
    setMessage(null);

    try {
      const result = await savePeopleBatch({
        pessoas: newPeople.map(p => ({
          cpf: p.cpf || '',
          nome_completo: p.nome_completo,
          cargo_atual: p.cargo_atual,
          empresa_atual: p.empresa_atual,
          linkedin_url: p.linkedin_url,
          email: p.email,
          localizacao: p.localizacao,
          resumo_profissional: p.resumo_profissional,
          foto_url: p.foto_url,
        })),
        aprovado_por: userName,
      });

      if (result.success) {
        // Mark all inserted as registered
        const newIds = new Set(registeredIds);
        for (const r of result.results) {
          if (r.status === 'inserted' || r.status === 'existed') {
            const pessoa = newPeople.find(p => p.nome_completo === r.nome);
            if (pessoa) {
              const key = pessoa.id || pessoa.cpf || pessoa.nome_completo || '';
              newIds.add(key);
            }
          }
        }
        setRegisteredIds(newIds);
        setMessage({
          type: 'success',
          text: `Inseridos: ${result.inserted} | Já existiam: ${result.existed} | Falhas: ${result.failed}`
        });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Erro no batch';
      setMessage({ type: 'error', text: msg });
    } finally {
      setMassInserting(false);
    }
  }

  function handleClose() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setCpf('');
    setNome('');
    setCidadeUf('');
    setDataNascimento('');
    setPage(1);
    setResponse(null);
    setGuardrailResult(null);
    setRegisteredIds(new Set());
    setInsertingId(null);
    setMassInserting(false);
    setMessage(null);
    setDetailPerson(null);
    setChatOpen(false);
    searchMutation.reset();
    onClose();
  }

  if (!isOpen) return null;

  const isLoading = searchMutation.isPending;
  const results = response?.results || [];
  const pagination = response?.pagination;
  const badges = response?.badges;
  const qualityGate = response?.qualityGate;
  const showAuxFields = guardrailResult && !guardrailResult.allowed &&
    (guardrailResult.requiredFields || []).some(f => f === 'cidadeUf' || f === 'dataNascimento');
  const newCount = results.filter(r => {
    const key = r.id || r.cpf || r.nome_completo || '';
    return r._source === 'external' && !registeredIds.has(key);
  }).length;

  // Build search context for chat panel
  const searchContext = response?.results ? {
    query: nome || cpf || '',
    results: response.results.slice(0, 10).map(r => ({
      nome_completo: r.nome_completo,
      cargo_atual: r.cargo_atual,
      empresa_atual: r.empresa_atual,
      qualityScore: r.qualityScore,
    })),
  } : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div
        className="flex flex-col rounded-2xl border border-cyan-500/15 bg-gradient-to-b from-[#0f1629] to-[#0a0e1a] shadow-2xl transition-all duration-300"
        style={{ width: chatOpen ? 1380 : 1000, maxWidth: '95vw', maxHeight: '90vh' }}
      >
        {/* ---- Header ---- */}
        <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-white/5">
          <div className="flex items-center gap-3">
            {detailPerson && (
              <button
                onClick={() => setDetailPerson(null)}
                className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <h2 className="text-xl font-semibold text-white flex items-center gap-2">
              <span className="w-1 h-5 bg-gradient-to-b from-orange-400 to-orange-600 rounded" />
              {detailPerson ? 'Detalhes da Pessoa' : 'Buscar Pessoa'}
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* ---- Detail View ---- */}
        {detailPerson && (
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 py-5">
            <PersonDetailView person={detailPerson} />
          </div>
        )}

        {/* ---- Search Bar ---- */}
        {!detailPerson && <div className="flex-shrink-0 px-6 py-4 border-b border-white/5 space-y-3">
          {/* Type toggle */}
          <div className="flex items-center gap-2">
            <span className="text-slate-400 text-sm mr-1">Tipo:</span>
            <button
              onClick={() => { setSearchType('cpf'); setResponse(null); setGuardrailResult(null); setMessage(null); }}
              className={cn(
                'px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors',
                searchType === 'cpf'
                  ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-400'
                  : 'bg-white/5 border-white/10 text-slate-400 hover:border-white/20'
              )}
            >
              CPF
            </button>
            <button
              onClick={() => { setSearchType('nome'); setResponse(null); setGuardrailResult(null); setMessage(null); }}
              className={cn(
                'px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors',
                searchType === 'nome'
                  ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-400'
                  : 'bg-white/5 border-white/10 text-slate-400 hover:border-white/20'
              )}
            >
              Nome
            </button>
          </div>

          {/* Input fields */}
          <div className="flex gap-3">
            {searchType === 'cpf' ? (
              <Input
                ref={cpfInputRef}
                value={cpf}
                onChange={(e) => setCpf(formatCpfInput(e.target.value))}
                onKeyDown={handleKeyDown}
                placeholder="000.000.000-00"
                maxLength={14}
                className="flex-1"
              />
            ) : (
              <Input
                ref={nomeInputRef}
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Nome completo da pessoa"
                className="flex-1"
              />
            )}
          </div>

          {/* Auxiliary fields (shown when guardrail demands them) */}
          {(showAuxFields || (searchType === 'nome' && (cidadeUf || dataNascimento))) && (
            <div className="flex gap-3">
              <Input
                value={cidadeUf}
                onChange={(e) => setCidadeUf(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Cidade/UF (ex: São Paulo - SP)"
                className="flex-1"
              />
              <Input
                value={dataNascimento}
                onChange={(e) => setDataNascimento(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Data nascimento (DD/MM/AAAA)"
                className="flex-1"
              />
            </div>
          )}

          {/* Action bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              onClick={handleSearch}
              disabled={isLoading}
              className="h-10 px-5 bg-cyan-500/15 border-2 border-cyan-500 text-cyan-400 hover:bg-cyan-500 hover:text-white"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Search className="h-4 w-4 mr-2" />
              )}
              Buscar
            </Button>

            <Button onClick={onOpenListingModal} variant="outline" className="h-10 px-4">
              Listar
            </Button>

            {newCount > 0 && (
              <Button
                onClick={handleMassInsert}
                disabled={massInserting}
                className="h-10 px-4 bg-green-500/15 border-2 border-green-500 text-green-400 hover:bg-green-500 hover:text-white"
              >
                {massInserting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Download className="h-4 w-4 mr-2" />
                )}
                Inserir {newCount} novo{newCount > 1 ? 's' : ''}
              </Button>
            )}

            {/* Chat toggle */}
            {results.length > 0 && (
              <Button
                onClick={() => setChatOpen(prev => !prev)}
                variant="outline"
                className={cn(
                  'h-10 px-4',
                  chatOpen
                    ? 'bg-violet-500/15 border-violet-500/50 text-violet-400'
                    : 'border-white/10 text-slate-400 hover:border-violet-500/30 hover:text-violet-400'
                )}
              >
                <MessageCircle className="h-4 w-4 mr-2" />
                Agent
              </Button>
            )}

            {/* Badges */}
            {badges && badges.total > 0 && (
              <div className="flex items-center gap-2 ml-auto">
                <span className="flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded bg-white/5 border border-white/10 text-slate-300">
                  Total: {badges.total}
                </span>
                <span className="flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded bg-green-500/10 border border-green-500/30 text-green-400">
                  <Database className="h-3 w-3" /> DB: {badges.db}
                </span>
                <span className="flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded bg-blue-500/10 border border-blue-500/30 text-blue-400">
                  <Globe className="h-3 w-3" /> Novos: {badges.new}
                </span>
                {qualityGate && qualityGate.filteredCount > 0 && (
                  <span className="flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded bg-yellow-500/10 border border-yellow-500/30 text-yellow-400">
                    <Filter className="h-3 w-3" /> Filtrados: {qualityGate.filteredCount}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Guardrail message */}
          {guardrailResult && !guardrailResult.allowed && (
            <div className="flex items-start gap-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-400">
              <Shield className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-semibold">Busca bloqueada pelo guardrail</p>
                <p className="text-yellow-300/80 mt-1">{guardrailResult.reason}</p>
              </div>
            </div>
          )}

          {/* User message */}
          {message && (
            <div
              className={cn(
                'p-3 rounded-lg text-sm',
                message.type === 'success'
                  ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                  : message.type === 'info'
                  ? 'bg-blue-500/10 border border-blue-500/30 text-blue-300'
                  : 'bg-red-500/10 border border-red-500/30 text-red-400'
              )}
            >
              {message.text}
            </div>
          )}
        </div>}

        {/* ---- Content area (results + chat) ---- */}
        {!detailPerson && (
        <div className="flex-1 min-h-0 flex flex-row">
          {/* Results table (scrollable) */}
          <div className="flex-1 min-w-0 overflow-y-auto overscroll-contain" style={{ maxHeight: '60vh' }}>
            {isLoading && (
              <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                <Loader2 className="h-10 w-10 animate-spin text-cyan-400 mb-4" />
                <span>Buscando em banco de dados e fontes externas...</span>
              </div>
            )}

            {!isLoading && results.length === 0 && response && guardrailResult?.allowed && (
              <div className="flex flex-col items-center justify-center py-16 text-slate-500">
                <AlertCircle className="h-10 w-10 mb-3 opacity-40" />
                <span>Nenhum resultado encontrado</span>
              </div>
            )}

            {!isLoading && results.length > 0 && (
              <div className="divide-y divide-white/5">
                {results.map((pessoa, i) => {
                  const key = pessoa.id || pessoa.cpf || pessoa.nome_completo || String(i);
                  const isRegistered = registeredIds.has(pessoa.id || '') || registeredIds.has(pessoa.cpf || '') || registeredIds.has(pessoa.nome_completo || '');
                  const isDb = pessoa._source === 'db';
                  const isInserting = insertingId === key;

                  return (
                    <div
                      key={key}
                      className="flex items-center gap-3 px-6 py-3 hover:bg-white/[0.02] transition-colors cursor-pointer"
                      onClick={() => setDetailPerson(pessoa)}
                    >
                      {/* Source badge */}
                      <span
                        className={cn(
                          'flex-shrink-0 px-1.5 py-0.5 text-[10px] font-bold rounded uppercase',
                          isDb
                            ? 'bg-green-500/15 text-green-400 border border-green-500/30'
                            : 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                        )}
                      >
                        {isDb ? 'DB' : 'NEW'}
                      </span>

                      {/* Avatar */}
                      <div className="w-9 h-9 rounded-full bg-orange-500/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                        {pessoa.foto_url ? (
                          <Image
                            src={pessoa.foto_url}
                            alt={pessoa.nome_completo || ''}
                            width={36}
                            height={36}
                            className="w-full h-full object-cover"
                            unoptimized
                          />
                        ) : (
                          <User className="h-4 w-4 text-orange-400" />
                        )}
                      </div>

                      {/* Name + role */}
                      <div className="min-w-0 flex-1">
                        <div className="text-white text-sm font-medium truncate">
                          {pessoa.nome_completo || 'Nome não disponível'}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-slate-500 min-w-0">
                          {pessoa.cargo_atual && (
                            <>
                              <Briefcase className="h-3 w-3 flex-shrink-0" />
                              <span className="truncate">{pessoa.cargo_atual}</span>
                            </>
                          )}
                          {pessoa.cargo_atual && pessoa.empresa_atual && (
                            <span className="flex-shrink-0 text-slate-600">@</span>
                          )}
                          {pessoa.empresa_atual && (
                            <>
                              <Building2 className="h-3 w-3 flex-shrink-0" />
                              <span className="truncate">{pessoa.empresa_atual}</span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Quality badge */}
                      {pessoa.qualityScore !== undefined && (
                        <span
                          className={cn(
                            'flex-shrink-0 px-1.5 py-0.5 text-[10px] font-bold rounded tabular-nums',
                            pessoa.qualityScore >= 75
                              ? 'bg-green-500/15 text-green-400 border border-green-500/30'
                              : 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/30'
                          )}
                        >
                          {pessoa.qualityScore}%
                        </span>
                      )}

                      {/* Action */}
                      <div className="flex-shrink-0">
                        {isRegistered || isDb ? (
                          <span className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded bg-green-500/10 text-green-400 border border-green-500/30 whitespace-nowrap">
                            <Check className="h-3 w-3" />
                            cadastrado
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => { e.stopPropagation(); handleInsertSingle(pessoa); }}
                            disabled={isInserting || massInserting}
                            className="h-7 px-2 text-xs border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/15"
                          >
                            {isInserting ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              'Inserir'
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Chat panel (slide-in from right) */}
          {chatOpen && (
            <div className="w-[380px] flex-shrink-0 border-l border-white/5" style={{ maxHeight: '60vh' }}>
              <PeopleAgentInlineChat
                searchContext={searchContext}
                onClose={() => setChatOpen(false)}
                isOpen={chatOpen}
              />
            </div>
          )}
        </div>
        )}

        {/* ---- Pagination footer ---- */}
        {!detailPerson && pagination && pagination.totalPages > 1 && (
          <div className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-t border-white/5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(page - 1)}
              disabled={page <= 1 || isLoading}
              className="h-8"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Ant
            </Button>
            <span className="text-slate-400 text-sm">
              Pág {pagination.page} de {pagination.totalPages} ({pagination.total} resultados)
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(page + 1)}
              disabled={page >= pagination.totalPages || isLoading}
              className="h-8"
            >
              Próx
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function formatCpfInput(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
}

function formatCpfDisplay(cpf: string): string {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11) return cpf;
  return `${digits.slice(0, 3)}.***.**${digits.slice(7, 9)}-${digits.slice(9)}`;
}

// ============================================
// PERSON DETAIL VIEW (stacked over results)
// ============================================

function PersonDetailView({ person }: { person: PeopleSearchResult }) {
  const nome = person.nome_completo || 'Nome nao disponivel';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 rounded-full bg-orange-500/15 flex items-center justify-center flex-shrink-0 overflow-hidden">
          {person.foto_url ? (
            <Image
              src={person.foto_url}
              alt={nome}
              width={64}
              height={64}
              className="w-full h-full object-cover"
              unoptimized
            />
          ) : (
            <User className="h-8 w-8 text-orange-400" />
          )}
        </div>
        <div className="min-w-0">
          <h3 className="text-xl font-semibold text-white truncate">{nome}</h3>
          {person.cargo_atual && (
            <span className="text-slate-400 text-sm flex items-center gap-1">
              <Briefcase className="h-3 w-3" />
              {person.cargo_atual}
            </span>
          )}
          {person.empresa_atual && (
            <span className="text-slate-500 text-sm flex items-center gap-1">
              <Building2 className="h-3 w-3" />
              {person.empresa_atual}
            </span>
          )}
        </div>
      </div>

      {/* Source badge */}
      <div className="flex flex-wrap gap-2">
        <span
          className={cn(
            'px-2 py-0.5 text-[10px] font-bold rounded',
            person._source === 'db'
              ? 'bg-green-500/15 text-green-400 border border-green-500/30'
              : 'bg-purple-500/15 text-purple-400 border border-purple-500/30'
          )}
        >
          {person._source === 'db' ? 'DB Interno' : 'Fonte Externa'}
        </span>
        {person._provider && (
          <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-blue-500/15 text-blue-400 border border-blue-500/30">
            {person._provider}
          </span>
        )}
      </div>

      {/* Details Grid */}
      <div className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {person.cpf && (
            <div className="text-sm">
              <span className="text-slate-500 block mb-1">CPF</span>
              <span className="text-slate-300">{formatCpfDisplay(person.cpf)}</span>
            </div>
          )}
          {person.email && (
            <div className="text-sm">
              <span className="text-slate-500 block mb-1">Email</span>
              <span className="text-slate-300">{person.email}</span>
            </div>
          )}
          {person.localizacao && (
            <div className="text-sm">
              <span className="text-slate-500 block mb-1">Localizacao</span>
              <span className="text-slate-300">{person.localizacao}</span>
            </div>
          )}
          {person.linkedin_url && (
            <div className="text-sm">
              <span className="text-slate-500 block mb-1">LinkedIn</span>
              <a
                href={person.linkedin_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400 hover:underline inline-flex items-center gap-1"
              >
                Ver perfil <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>

        {person.resumo_profissional && (
          <div className="mt-4 pt-4 border-t border-white/5">
            <span className="text-slate-500 text-sm block mb-2">Resumo Profissional</span>
            <p className="text-slate-300 text-sm">{person.resumo_profissional}</p>
          </div>
        )}
      </div>
    </div>
  );
}
