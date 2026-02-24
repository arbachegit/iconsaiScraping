'use client';

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import Image from 'next/image';
import { X, Search, ArrowLeft, Loader2, ExternalLink, User, Building2, Briefcase, AlertCircle, Check, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  searchPersonByCpf,
  savePerson,
  type CpfSearchResponse,
  type CpfSearchPessoa,
  type CpfSearchExperiencia,
} from '@/lib/api';

interface PeopleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenListingModal: () => void;
  userName?: string;
}

type ViewState = 'search' | 'details';

export function PeopleModal({ isOpen, onClose, onOpenListingModal, userName = 'sistema' }: PeopleModalProps) {
  const [view, setView] = useState<ViewState>('search');
  const [cpf, setCpf] = useState('');
  const [nome, setNome] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [searchResult, setSearchResult] = useState<CpfSearchResponse | null>(null);
  const [saved, setSaved] = useState(false);
  const cpfInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      cpfInputRef.current?.focus();
    }
  }, [isOpen]);

  const searchMutation = useMutation({
    mutationFn: searchPersonByCpf,
    onSuccess: (data) => {
      setSearchResult(data);
      setSaved(false);
      if (data.found && data.pessoa) {
        setView('details');
        setMessage(null);
        // If from database, mark as already saved
        if (data.source === 'database') {
          setSaved(true);
        }
      } else {
        setMessage({ type: 'info', text: data.message || 'Pessoa não encontrada nas fontes disponíveis' });
      }
    },
    onError: (error: Error) => {
      setMessage({ type: 'error', text: error.message });
    },
  });

  const saveMutation = useMutation({
    mutationFn: savePerson,
    onSuccess: (data) => {
      if (data.success) {
        setSaved(true);
        setMessage({ type: 'success', text: data.message || 'Pessoa cadastrada com sucesso!' });
      }
    },
    onError: (error: Error) => {
      setMessage({ type: 'error', text: error.message });
    },
  });

  function formatCpfInput(value: string): string {
    const digits = value.replace(/\D/g, '');
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
    if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
  }

  function handleCpfChange(e: React.ChangeEvent<HTMLInputElement>) {
    setCpf(formatCpfInput(e.target.value));
  }

  function handleSearch() {
    const cpfDigits = cpf.replace(/\D/g, '');
    const hasCpf = cpfDigits.length === 11;
    const hasNome = nome.trim().length >= 2;

    if (!hasCpf && !hasNome) {
      setMessage({ type: 'error', text: 'Preencha pelo menos CPF ou nome (mínimo 2 caracteres)' });
      return;
    }

    if (cpfDigits.length > 0 && cpfDigits.length !== 11) {
      setMessage({ type: 'error', text: 'CPF deve ter 11 dígitos' });
      return;
    }

    setMessage(null);
    searchMutation.mutate({
      cpf: hasCpf ? cpfDigits : undefined,
      nome: hasNome ? nome.trim() : undefined
    });
  }

  function handleSave() {
    if (!searchResult?.pessoa) return;

    saveMutation.mutate({
      pessoa: searchResult.pessoa,
      experiencias: searchResult.experiencias,
      aprovado_por: userName
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearch();
    }
  }

  function handleBack() {
    setView('search');
    setSearchResult(null);
    setSaved(false);
    setMessage(null);
  }

  function handleClose() {
    setView('search');
    setCpf('');
    setNome('');
    setSearchResult(null);
    setMessage(null);
    setSaved(false);
    searchMutation.reset();
    saveMutation.reset();
    onClose();
  }

  if (!isOpen) return null;

  const isLoading = searchMutation.isPending;
  const isSaving = saveMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-2xl flex flex-col rounded-2xl border border-cyan-500/15 bg-gradient-to-b from-[#0f1629] to-[#0a0e1a] shadow-2xl" style={{ maxHeight: '85vh' }}>
        {/* Header - fixed */}
        <div className="flex-shrink-0 flex items-center justify-between p-6 border-b border-white/5">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <span className="w-1 h-5 bg-gradient-to-b from-orange-400 to-orange-600 rounded" />
            Buscar Pessoa
          </h2>
          <button
            onClick={handleClose}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {view === 'search' ? (
            <>
              {/* Search Form */}
              <div className="space-y-3 mb-4">
                <div className="flex gap-3">
                  <Input
                    ref={cpfInputRef}
                    value={cpf}
                    onChange={handleCpfChange}
                    onKeyDown={handleKeyDown}
                    placeholder="CPF (000.000.000-00)"
                    maxLength={14}
                    className="flex-1"
                  />
                  <Input
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Nome da pessoa"
                    className="flex-1"
                  />
                </div>
                <p className="text-slate-500 text-xs">Preencha pelo menos um campo para buscar</p>
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
                    Listar Cadastrados
                  </Button>
                </div>
              </div>

              {/* Info Box */}
              <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 mb-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-semibold mb-1">Fontes de busca:</p>
                    <ul className="list-disc list-inside space-y-1 text-blue-300">
                      <li>LinkedIn (via Apollo.io)</li>
                      <li>Perplexity AI (busca inteligente)</li>
                      <li>Base de dados interna</li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* Message */}
              {message && (
                <div
                  className={cn(
                    'p-4 rounded-lg mb-4',
                    message.type === 'success'
                      ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                      : message.type === 'info'
                      ? 'bg-yellow-500/10 border border-yellow-500/30 text-yellow-400'
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
                  <span>Buscando em LinkedIn e Perplexity...</span>
                </div>
              )}
            </>
          ) : (
            <>
              {/* Person Details View */}
              <Button onClick={handleBack} variant="outline" className="mb-4">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Voltar
              </Button>

              {/* Success/Error Message */}
              {message && (
                <div
                  className={cn(
                    'p-4 rounded-lg mb-4',
                    message.type === 'success'
                      ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                      : message.type === 'error'
                      ? 'bg-red-500/10 border border-red-500/30 text-red-400'
                      : 'bg-yellow-500/10 border border-yellow-500/30 text-yellow-400'
                  )}
                >
                  {message.text}
                </div>
              )}

              {searchResult?.pessoa && (
                <PersonDetailsView
                  pessoa={searchResult.pessoa}
                  experiencias={searchResult.experiencias || []}
                  source={searchResult.source}
                  apolloEnriched={searchResult.apollo_enriched}
                  fontes={searchResult.fontes}
                />
              )}

              {/* Save Button */}
              <div className="mt-6 pt-4 border-t border-white/5">
                {saved ? (
                  <div className="flex items-center justify-center gap-2 p-4 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400">
                    <Check className="h-5 w-5" />
                    <span className="font-semibold">Pessoa já cadastrada no banco de dados</span>
                  </div>
                ) : (
                  <Button
                    onClick={handleSave}
                    disabled={isSaving || !searchResult?.pessoa}
                    className="w-full h-12 bg-green-500/15 border-2 border-green-500 text-green-400 hover:bg-green-500 hover:text-white"
                  >
                    {isSaving ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    {isSaving ? 'Salvando...' : 'Cadastrar Pessoa'}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PersonDetailsView({
  pessoa,
  experiencias,
  source,
  apolloEnriched,
  fontes
}: {
  pessoa: CpfSearchPessoa;
  experiencias: CpfSearchExperiencia[];
  source: string;
  apolloEnriched?: boolean;
  fontes?: string[];
}) {
  const nome = pessoa.nome_completo || 'Nome não disponível';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 rounded-full bg-orange-500/15 flex items-center justify-center flex-shrink-0 overflow-hidden">
          {pessoa.foto_url ? (
            <Image
              src={pessoa.foto_url}
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
        <div>
          <h3 className="text-xl font-semibold text-white">{nome}</h3>
          {pessoa.cargo_atual && (
            <span className="text-slate-400 text-sm flex items-center gap-1">
              <Briefcase className="h-3 w-3" />
              {pessoa.cargo_atual}
            </span>
          )}
          {pessoa.empresa_atual && (
            <span className="text-slate-500 text-sm flex items-center gap-1">
              <Building2 className="h-3 w-3" />
              {pessoa.empresa_atual}
            </span>
          )}
        </div>
      </div>

      {/* Source Badge */}
      <div className="flex flex-wrap gap-2">
        <span
          className={cn(
            'px-1.5 py-0.5 text-[10px] font-bold rounded',
            source === 'database'
              ? 'bg-green-500/15 text-green-400 border border-green-500/30'
              : 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
          )}
        >
          {source === 'database' ? 'DB Interno' : 'DB Externo'}
        </span>
        {apolloEnriched && (
          <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-purple-500/15 text-purple-400 border border-purple-500/30">
            LinkedIn
          </span>
        )}
      </div>

      {/* Details Grid */}
      <div className="bg-white/[0.02] border border-white/5 rounded-xl p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {pessoa.cpf && (
            <DetailItem label="CPF" value={formatCpfDisplay(pessoa.cpf)} />
          )}
          {pessoa.email && (
            <DetailItem label="Email" value={pessoa.email} />
          )}
          {pessoa.localizacao && (
            <DetailItem label="Localização" value={pessoa.localizacao} />
          )}
          {pessoa.linkedin_url && (
            <div className="text-sm">
              <span className="text-slate-500 block mb-1">LinkedIn</span>
              <a
                href={pessoa.linkedin_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400 hover:underline inline-flex items-center gap-1"
              >
                Ver perfil <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>

        {pessoa.resumo_profissional && (
          <div className="mt-4 pt-4 border-t border-white/5">
            <span className="text-slate-500 text-sm block mb-2">Resumo Profissional</span>
            <p className="text-slate-300 text-sm">{pessoa.resumo_profissional}</p>
          </div>
        )}
      </div>

      {/* Experiences */}
      {experiencias && experiencias.length > 0 && (
        <div>
          <h4 className="text-slate-400 text-sm font-semibold mb-3">Experiências</h4>
          <div className="space-y-3">
            {experiencias.map((exp, i) => (
              <div key={i} className="p-3 bg-white/[0.02] border border-white/5 rounded-lg">
                <strong className="text-slate-200 text-sm">{exp.cargo}</strong>
                <span className="text-slate-400 text-sm"> - {exp.empresa}</span>
                {exp.periodo && (
                  <div className="text-slate-500 text-xs mt-1">{exp.periodo}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sources */}
      {fontes && fontes.length > 0 && (
        <div>
          <h4 className="text-slate-400 text-sm font-semibold mb-2">Fontes consultadas</h4>
          <ul className="space-y-1">
            {fontes.map((fonte, i) => (
              <li key={i} className="text-slate-500 text-xs truncate">
                {fonte.startsWith('http') ? (
                  <a href={fonte} target="_blank" rel="noopener noreferrer" className="hover:text-cyan-400">
                    {fonte}
                  </a>
                ) : (
                  fonte
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-sm">
      <span className="text-slate-500 block mb-1">{label}</span>
      <span className="text-slate-300">{value}</span>
    </div>
  );
}

function formatCpfDisplay(cpf: string): string {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11) return cpf;
  // Mask middle digits for privacy
  return `${digits.slice(0, 3)}.***.**${digits.slice(7, 9)}-${digits.slice(9)}`;
}
