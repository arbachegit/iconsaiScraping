'use client';

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import Image from 'next/image';
import { X, Search, ArrowLeft, Check, Users, Loader2, ExternalLink, UserCheck, UserX, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { cn } from '@/lib/utils';
import {
  searchCompany,
  getCompanyDetails,
  enrichSocios,
  approveCompany,
  formatCnpj,
  type CompanyDetails,
  type Socio,
  type CompanyCandidate,
} from '@/lib/api';

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

type ViewState = 'search' | 'details';

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
  const [view, setView] = useState<ViewState>('search');
  const [nome, setNome] = useState('');
  const [cidade, setCidade] = useState('');
  const [segmento, setSegmento] = useState('');
  const [regime, setRegime] = useState('');
  const [candidates, setCandidates] = useState<CompanyCandidate[]>([]);
  const [currentEmpresa, setCurrentEmpresa] = useState<CompanyDetails | null>(null);
  const [currentSocios, setCurrentSocios] = useState<Socio[]>([]);
  const [showSocios, setShowSocios] = useState(false);
  const [isExisting, setIsExisting] = useState(false);
  const [sociosAtivos, setSociosAtivos] = useState<Socio[]>([]);
  const [sociosInativos, setSociosInativos] = useState<Socio[]>([]);
  const [sociosNovos, setSociosNovos] = useState<Socio[]>([]);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync selected values from modals
  useEffect(() => {
    if (selectedCnae) setSegmento(selectedCnae);
  }, [selectedCnae]);

  useEffect(() => {
    if (selectedRegime) setRegime(selectedRegime);
  }, [selectedRegime]);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  const searchMutation = useMutation({
    mutationFn: searchCompany,
    onSuccess: async (data) => {
      setMessage(null);
      if (!data.found) {
        setMessage({ type: 'error', text: 'Nenhuma empresa encontrada' });
        setCandidates([]);
        return;
      }
      if (data.single_match && data.company) {
        await selectCompany(data.company.cnpj);
      } else {
        setCandidates(data.candidates || []);
      }
    },
    onError: (error: Error) => {
      setMessage({ type: 'error', text: error.message });
    },
  });

  const detailsMutation = useMutation({
    mutationFn: getCompanyDetails,
    onSuccess: (data) => {
      if (data.exists) {
        setIsExisting(true);
        setCurrentEmpresa(data.empresa);
        setCurrentSocios(data.socios || []);
        setSociosAtivos(data.socios_ativos || []);
        setSociosInativos(data.socios_inativos || []);
        setSociosNovos(data.socios_novos || []);
        setShowSocios(true);
        setMessage({ type: 'success', text: 'Empresa ja cadastrada no sistema' });
        setView('details');
        return;
      }
      setIsExisting(false);
      setSociosAtivos([]);
      setSociosInativos([]);
      setSociosNovos([]);
      setCurrentEmpresa(data.empresa);
      setCurrentSocios(data.socios || []);
      setView('details');
    },
    onError: (error: Error) => {
      setMessage({ type: 'error', text: error.message });
    },
  });

  const enrichMutation = useMutation({
    mutationFn: enrichSocios,
    onSuccess: (data) => {
      if (data.success && data.socios) {
        setCurrentSocios(data.socios);
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
        setCurrentEmpresa(null);
        setCurrentSocios([]);
      }
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
      setMessage({
        type: 'error',
        text: 'Preencha pelo menos 1 campo para buscar',
      });
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

  async function selectCompany(cnpj: string) {
    detailsMutation.mutate(cnpj);
  }

  function handleLoadSocios() {
    if (!currentEmpresa || currentSocios.length === 0) return;
    enrichMutation.mutate({
      socios: currentSocios,
      empresa_nome: currentEmpresa.nome_fantasia || currentEmpresa.razao_social,
    });
  }

  function handleApprove() {
    if (!currentEmpresa) return;
    approveMutation.mutate({
      empresa: currentEmpresa,
      socios: currentSocios,
      aprovado_por: userName,
    });
  }

  function handleBack() {
    setView('search');
    setCurrentEmpresa(null);
    setCurrentSocios([]);
    setShowSocios(false);
    setIsExisting(false);
    setSociosAtivos([]);
    setSociosInativos([]);
    setSociosNovos([]);
    setMessage(null);
  }

  function handleClose() {
    setView('search');
    setNome('');
    setCidade('');
    setSegmento('');
    setRegime('');
    setCandidates([]);
    setCurrentEmpresa(null);
    setCurrentSocios([]);
    setShowSocios(false);
    setIsExisting(false);
    setSociosAtivos([]);
    setSociosInativos([]);
    setSociosNovos([]);
    setMessage(null);
    onClose();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearch();
    }
  }

  if (!isOpen) return null;

  const isLoading = searchMutation.isPending || detailsMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-cyan-500/15 bg-gradient-to-b from-[#0f1629] to-[#0a0e1a] shadow-2xl">
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

        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {view === 'search' ? (
            <>
              {/* Search Form */}
              <div className="space-y-3 mb-4">
                <div className="flex gap-3">
                  <Input
                    ref={inputRef}
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Nome da empresa *"
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
                <div className="flex gap-3">
                  <Button
                    onClick={handleSearch}
                    disabled={isLoading}
                    className="h-12 px-6 bg-cyan-500/15 border-2 border-cyan-500 text-cyan-400 hover:bg-cyan-500 hover:text-white"
                  >
                    {isLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Search className="h-4 w-4 mr-2" />
                    )}
                    Buscar
                  </Button>
                  <Button onClick={onOpenListingModal} variant="outline" className="h-12 px-6">
                    Listar
                  </Button>
                </div>
              </div>

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

              {/* Results */}
              {!isLoading && candidates.length > 0 && (
                <div className="space-y-2">
                  {candidates.map((c) => (
                    <div
                      key={c.cnpj}
                      onClick={() => selectCompany(c.cnpj)}
                      className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.06] cursor-pointer hover:border-cyan-500/40 hover:bg-cyan-500/5 transition-colors"
                    >
                      <div className="flex justify-between items-start gap-3 mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-slate-200 font-semibold text-sm truncate">
                            {c.razao_social || 'Sem nome'}
                          </span>
                          <span
                            className={cn(
                              'flex-shrink-0 px-1.5 py-0.5 text-[10px] font-bold rounded',
                              c.fonte === 'interno'
                                ? 'bg-green-500/15 text-green-400 border border-green-500/30'
                                : 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                            )}
                          >
                            {c.fonte === 'interno' ? 'DB Interno' : 'DB Externo'}
                          </span>
                        </div>
                        {c.localizacao && (
                          <span className="text-xs text-slate-400 bg-slate-400/10 px-2 py-1 rounded border border-slate-400/20 whitespace-nowrap">
                            {c.localizacao}
                          </span>
                        )}
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-slate-500 text-sm">{c.cnpj_formatted}</span>
                        {c.nome_fantasia && (
                          <span className="text-slate-500 text-sm truncate max-w-[150px]">
                            {c.nome_fantasia}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {/* Company Details View */}
              {message?.type === 'success' && !currentEmpresa ? (
                <div className="text-center py-10">
                  <div className="text-4xl mb-2">✓</div>
                  <div className="text-lg font-semibold text-white mb-2">{message.text}</div>
                  <Button onClick={handleClose} variant="outline" className="mt-4">
                    Fechar
                  </Button>
                </div>
              ) : currentEmpresa ? (
                <div className="space-y-4">
                  <div className="bg-white/[0.02] border border-white/5 rounded-xl p-6">
                    <DetailRow label="CNPJ" value={formatCnpj(currentEmpresa.cnpj)} />
                    <DetailRow label="Razao Social" value={currentEmpresa.razao_social} />
                    <DetailRow label="Nome Fantasia" value={currentEmpresa.nome_fantasia} />
                    <DetailRow
                      label="CNAE"
                      value={`${currentEmpresa.cnae_principal || '-'} - ${currentEmpresa.cnae_descricao || ''}`}
                    />
                    <DetailRow label="Porte" value={currentEmpresa.porte} />
                    <DetailRow label="Situacao" value={currentEmpresa.situacao_cadastral} />
                    <DetailRow
                      label="Capital Social"
                      value={
                        currentEmpresa.capital_social
                          ? `R$ ${Number(currentEmpresa.capital_social).toLocaleString('pt-BR')}`
                          : '-'
                      }
                    />
                    <DetailRow
                      label="Endereco"
                      value={[
                        currentEmpresa.logradouro,
                        currentEmpresa.numero,
                        currentEmpresa.bairro,
                        currentEmpresa.cidade,
                        currentEmpresa.estado,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                    />
                    <DetailRow label="Telefone" value={currentEmpresa.telefone_1} />
                    <DetailRow label="Email" value={currentEmpresa.email} />
                    <DetailRow
                      label="Website"
                      value={
                        currentEmpresa.website && currentEmpresa.website !== 'NAO_POSSUI' ? (
                          <a
                            href={currentEmpresa.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-cyan-400 hover:underline inline-flex items-center gap-1"
                          >
                            {currentEmpresa.website} <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          '-'
                        )
                      }
                    />
                    <DetailRow
                      label="LinkedIn"
                      value={
                        currentEmpresa.linkedin && currentEmpresa.linkedin !== 'NAO_POSSUI' ? (
                          <a
                            href={currentEmpresa.linkedin}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-cyan-400 hover:underline inline-flex items-center gap-1"
                          >
                            Ver perfil <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : currentEmpresa.linkedin === 'NAO_POSSUI' ? (
                          <span className="text-red-400">Nao possui</span>
                        ) : (
                          <span className="text-slate-500">Nao informado</span>
                        )
                      }
                    />

                    {/* Socios Section */}
                    {showSocios && currentSocios.length > 0 && (
                      <div className="mt-6 pt-5 border-t border-white/5">
                        <div className="text-slate-400 text-sm font-semibold mb-3 flex items-center gap-2">
                          Socios{' '}
                          <span className="bg-purple-500/15 text-purple-400 px-2 py-0.5 rounded text-xs">
                            {currentSocios.length}
                          </span>
                        </div>
                        <div className="space-y-3">
                          {currentSocios.map((s, i) => (
                            <div
                              key={i}
                              className="flex gap-3 p-4 bg-white/[0.02] border border-white/5 rounded-xl"
                            >
                              <div className="w-11 h-11 rounded-full bg-purple-500/15 flex items-center justify-center flex-shrink-0 overflow-hidden">
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
                                  <span className="text-purple-400 font-semibold">
                                    {s.nome?.charAt(0).toUpperCase() || '?'}
                                  </span>
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-slate-200 font-semibold text-sm">{s.nome}</div>
                                <div className="text-slate-500 text-sm">
                                  {s.qualificacao || s.cargo || 'Socio'}
                                </div>
                                <div className="flex flex-wrap gap-2 text-sm mt-1">
                                  {s.cpf && (
                                    <span className="text-slate-500">
                                      CPF: ***{s.cpf.slice(-6, -2)}**-{s.cpf.slice(-2)}
                                    </span>
                                  )}
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
                                  ) : (
                                    <span className="text-red-400">Sem LinkedIn</span>
                                  )}
                                </div>
                                {s.headline && (
                                  <div className="text-slate-400 text-xs mt-1">{s.headline}</div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Action Buttons */}
                  <div className="flex flex-col gap-3">
                    {currentSocios.length > 0 && !showSocios && (
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
                          : `Ver Socios (${currentSocios.length})`}
                      </Button>
                    )}
                    <Button
                      onClick={handleApprove}
                      disabled={approveMutation.isPending}
                      className="h-12 w-full bg-green-500/15 border-2 border-green-500 text-green-400 hover:bg-green-500 hover:text-white"
                    >
                      {approveMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      ) : (
                        <Check className="h-4 w-4 mr-2" />
                      )}
                      {approveMutation.isPending ? 'Salvando...' : 'Aprovar e Cadastrar'}
                    </Button>
                    <Button onClick={handleBack} variant="outline" className="h-12 w-full">
                      <ArrowLeft className="h-4 w-4 mr-2" />
                      Voltar a Busca
                    </Button>
                  </div>

                  {/* Error Message */}
                  {message?.type === 'error' && (
                    <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400">
                      {message.text}
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex py-2.5 border-b border-white/[0.04] last:border-b-0">
      <span className="text-slate-500 text-sm font-medium w-32 flex-shrink-0">{label}</span>
      <span className="text-slate-300 text-sm flex-1">{value || '-'}</span>
    </div>
  );
}
