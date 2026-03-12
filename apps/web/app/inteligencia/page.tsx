'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Brain,
  Search,
  Play,
  ArrowLeft,
  Building2,
  Loader2,
  RefreshCw,
  ChevronDown,
  CheckCircle2,
  X,
} from 'lucide-react';
import { isAuthenticated } from '@/lib/auth';
import {
  getBiProfile,
  getBiOpportunities,
  getBiEcosystem,
  executePipeline,
  getHealth,
} from '@/lib/api';
import type { PipelineRun, BiProfile, BiOpportunity, EcosystemData } from '@/lib/api';
import { fetchWithAuth } from '@/lib/auth';
import { PipelineStatus } from '@/components/bi/pipeline-status';
import { ProfileCards } from '@/components/bi/profile-cards';
import { OpportunityTable } from '@/components/bi/opportunity-table';
import { EcosystemMap } from '@/components/bi/ecosystem-map';
import { ReportViewer } from '@/components/bi/report-viewer';

const API_BASE = '/api';

interface CompanyOption {
  id: string;
  razao_social: string;
  nome_fantasia: string | null;
  cnpj: string;
  cidade: string | null;
  estado: string | null;
}

export default function InteligenciaPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [authReady, setAuthReady] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedCompany, setSelectedCompany] = useState<CompanyOption | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [pipelineRun, setPipelineRun] = useState<PipelineRun | null>(null);
  const [pipelineRunId, setPipelineRunId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'perfil' | 'ecossistema' | 'oportunidades' | 'relatorios'>('perfil');

  // Auth check
  useEffect(() => {
    if (!isAuthenticated()) {
      router.push('/');
      return;
    }
    setAuthReady(true);
  }, [router]);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Search companies
  const searchQuery = useQuery({
    queryKey: ['company-search-bi', debouncedSearch],
    queryFn: async () => {
      if (debouncedSearch.length < 2) return [];

      const query = debouncedSearch.trim();
      // Detect CNPJ: only digits, dots, slashes, dashes (min 8 digits)
      const digitsOnly = query.replace(/[^\d]/g, '');
      const isCnpj = digitsOnly.length >= 8 && /^[\d.\-/]+$/.test(query);

      if (isCnpj) {
        // Search by CNPJ via POST /companies/details
        try {
          const res = await fetchWithAuth(`${API_BASE}/companies/details`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cnpj: digitsOnly }),
          });
          if (res.ok) {
            const json = await res.json();
            const empresa = json.empresa;
            if (empresa?.id) {
              return [{
                id: empresa.id,
                razao_social: empresa.razao_social || '',
                nome_fantasia: empresa.nome_fantasia || null,
                cnpj: empresa.cnpj || digitsOnly,
                cidade: empresa.cidade || null,
                estado: empresa.estado || null,
              }] as CompanyOption[];
            }
          }
        } catch {
          // CNPJ lookup failed, fall through to name search
        }
      }

      // Search by name: try /companies/list first
      const res = await fetchWithAuth(
        `${API_BASE}/companies/list?nome=${encodeURIComponent(query)}&limit=20`
      );
      if (res.ok) {
        const json = await res.json();
        const empresas = json.empresas || [];
        if (empresas.length > 0) return empresas as CompanyOption[];
      }

      // Fallback: graph search (broader, no module permission needed)
      const fallback = await fetchWithAuth(
        `${API_BASE}/graph/search?q=${encodeURIComponent(query)}&limit=20`
      );
      if (!fallback.ok) return [];
      const fbJson = await fallback.json();
      const empresaResults = (fbJson.results || [])
        .filter((r: { type: string }) => r.type === 'empresa')
        .map((item: { id: string; label: string; subtitle: string }) => {
          const parts = (item.subtitle || '').split(' - ').map((s: string) => s.trim());
          return {
            id: item.id,
            razao_social: item.label || '',
            nome_fantasia: null,
            cnpj: parts[0] || '',
            cidade: parts[1] || null,
            estado: parts[2] || null,
          };
        });
      return empresaResults as CompanyOption[];
    },
    enabled: authReady && debouncedSearch.length >= 2,
    staleTime: 30_000,
  });

  // Fetch BI profile for selected company
  const profileQuery = useQuery({
    queryKey: ['bi-profile', selectedCompany?.id],
    queryFn: () => getBiProfile(selectedCompany!.id),
    enabled: !!selectedCompany,
    staleTime: 60_000,
  });

  // Fetch opportunities
  const opportunitiesQuery = useQuery({
    queryKey: ['bi-opportunities', selectedCompany?.id],
    queryFn: () => getBiOpportunities(selectedCompany!.id),
    enabled: !!selectedCompany && activeTab === 'oportunidades',
    staleTime: 60_000,
  });

  // Fetch ecosystem
  const ecosystemQuery = useQuery({
    queryKey: ['bi-ecosystem', selectedCompany?.id],
    queryFn: () => getBiEcosystem(selectedCompany!.id),
    enabled: !!selectedCompany && activeTab === 'ecossistema',
    staleTime: 60_000,
  });

  // Execute pipeline
  const pipelineMutation = useMutation({
    mutationFn: (options: { skip_crawl?: boolean; force_crawl?: boolean }) =>
      executePipeline(selectedCompany!.id, options),
    onSuccess: (data) => {
      if (data.status === 'running') {
        setPipelineRunId(data.runId || data.id);
        setPipelineRun(data);
      } else {
        setPipelineRun(data);
        setPipelineRunId(null);
        queryClient.invalidateQueries({ queryKey: ['bi-profile'] });
        queryClient.invalidateQueries({ queryKey: ['bi-opportunities'] });
        queryClient.invalidateQueries({ queryKey: ['bi-ecosystem'] });
      }
    },
  });

  const handlePipelineComplete = useCallback((run: PipelineRun) => {
    setPipelineRun(run);
    setPipelineRunId(null);
    queryClient.invalidateQueries({ queryKey: ['bi-profile'] });
    queryClient.invalidateQueries({ queryKey: ['bi-opportunities'] });
    queryClient.invalidateQueries({ queryKey: ['bi-ecosystem'] });
  }, [queryClient]);

  const handleSelectCompany = (company: CompanyOption) => {
    setSelectedCompany(company);
    setSearchTerm(company.nome_fantasia || company.razao_social);
    setShowDropdown(false);
    setPipelineRun(null);
    setPipelineRunId(null);
    setActiveTab('perfil');
  };

  if (!authReady) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0a0e1a]">
        <Loader2 className="h-6 w-6 text-cyan-400 animate-spin" />
      </div>
    );
  }

  const TABS = [
    { key: 'perfil' as const, label: 'Perfil' },
    { key: 'ecossistema' as const, label: 'Ecossistema' },
    { key: 'oportunidades' as const, label: 'Oportunidades' },
    { key: 'relatorios' as const, label: 'Relatórios' },
  ];

  return (
    <div className="h-screen flex flex-col bg-[#0a0e1a]">
      {/* Header */}
      <header className="flex-shrink-0 bg-[#0f1629]/80 border-b border-cyan-500/10 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/dashboard')}
              className="p-1.5 rounded-lg hover:bg-gray-800 transition-colors"
            >
              <ArrowLeft className="h-4 w-4 text-gray-400" />
            </button>
            <div className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-cyan-400" />
              <h1 className="text-base font-semibold text-white">Inteligência Empresarial</h1>
            </div>
          </div>

          {/* Version */}
          <span className="text-xs text-gray-600">BI Pipeline v1.0</span>
        </div>
      </header>

      {/* Company selector */}
      <div className="flex-shrink-0 bg-[#0f1629]/40 border-b border-gray-800 px-4 py-3">
        <div className="flex items-center gap-3">
          {/* Search input */}
          <div className="relative flex-1 max-w-lg">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setShowDropdown(true);
                if (selectedCompany && e.target.value !== (selectedCompany.nome_fantasia || selectedCompany.razao_social)) {
                  setSelectedCompany(null);
                }
              }}
              onFocus={() => setShowDropdown(true)}
              placeholder="Buscar empresa por nome, CNPJ..."
              className="w-full pl-9 pr-8 py-2 rounded-lg bg-[#0a0e1a] border border-gray-700 text-sm text-white placeholder-gray-500 focus:border-cyan-500/50 focus:outline-none"
            />
            {searchTerm && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2"
                onClick={() => {
                  setSearchTerm('');
                  setSelectedCompany(null);
                  setShowDropdown(false);
                }}
              >
                <X className="h-4 w-4 text-gray-500 hover:text-gray-300" />
              </button>
            )}

            {/* Dropdown */}
            {showDropdown && debouncedSearch.length >= 2 && (
              <div className="absolute z-50 mt-1 w-full rounded-lg bg-[#131a2e] border border-gray-700 shadow-xl max-h-[250px] overflow-y-auto">
                {searchQuery.isLoading ? (
                  <div className="px-3 py-4 text-center">
                    <Loader2 className="h-4 w-4 text-gray-400 animate-spin mx-auto" />
                  </div>
                ) : (searchQuery.data || []).length === 0 ? (
                  <div className="px-3 py-4 text-xs text-gray-500 text-center">
                    Nenhuma empresa encontrada
                  </div>
                ) : (
                  (searchQuery.data || []).map((company) => (
                    <button
                      key={company.id}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/50 transition-colors border-b border-gray-800/50 last:border-0"
                      onClick={() => handleSelectCompany(company)}
                    >
                      <Building2 className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-white truncate">
                          {company.nome_fantasia || company.razao_social}
                        </div>
                        <div className="text-[10px] text-gray-500 flex gap-2">
                          <span>{company.cnpj}</span>
                          {company.cidade && <span>{company.cidade}/{company.estado}</span>}
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Pipeline button */}
          {selectedCompany && (
            <button
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => pipelineMutation.mutate({})}
              disabled={pipelineMutation.isPending || pipelineRun?.status === 'running'}
            >
              {pipelineMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Executar Pipeline
            </button>
          )}
        </div>

        {/* Selected company info */}
        {selectedCompany && (
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
              <span className="text-xs text-gray-300 font-medium">
                {selectedCompany.nome_fantasia || selectedCompany.razao_social}
              </span>
            </div>
            <span className="text-xs text-gray-500 font-mono">{selectedCompany.cnpj}</span>
            {selectedCompany.cidade && (
              <span className="text-xs text-gray-500">{selectedCompany.cidade}/{selectedCompany.estado}</span>
            )}
          </div>
        )}
      </div>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        {!selectedCompany ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <Brain className="h-16 w-16 text-gray-700" />
            <div className="text-center">
              <h2 className="text-lg text-gray-400 font-medium">Pipeline de Inteligência</h2>
              <p className="text-sm text-gray-600 mt-1">
                Selecione uma empresa para analisar seu ecossistema, oportunidades e gerar relatórios.
              </p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 text-xs text-gray-500">
              {[
                { icon: '1', label: 'Website Crawl' },
                { icon: '2', label: 'Perfil CNAE/Geo/Fiscal' },
                { icon: '3', label: 'Scoring Oportunidades' },
                { icon: '4', label: 'Relatórios Contextuais' },
              ].map((step) => (
                <div key={step.icon} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-800">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-cyan-500/10 text-cyan-400 text-[10px] font-bold">
                    {step.icon}
                  </span>
                  {step.label}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="px-4 lg:px-6 py-4 space-y-4">
            {/* Pipeline status (if running or recently completed) */}
            {(pipelineRun || pipelineMutation.isPending) && (
              <PipelineStatus
                run={pipelineRun}
                runId={pipelineRunId}
                onComplete={handlePipelineComplete}
              />
            )}

            {/* Tabs */}
            <div className="flex items-center gap-1 border-b border-gray-800">
              {TABS.map((tab) => (
                <button
                  key={tab.key}
                  className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                    activeTab === tab.key
                      ? 'border-cyan-400 text-cyan-400'
                      : 'border-transparent text-gray-500 hover:text-gray-300'
                  }`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            {activeTab === 'perfil' && (
              <ProfileCards
                profile={profileQuery.data || null}
                isLoading={profileQuery.isLoading}
              />
            )}

            {activeTab === 'ecossistema' && (
              <EcosystemMap
                ecosystem={ecosystemQuery.data || null}
                isLoading={ecosystemQuery.isLoading}
              />
            )}

            {activeTab === 'oportunidades' && (
              <div className="space-y-4">
                <div className="flex items-center justify-end">
                  <button
                    className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
                    onClick={() => opportunitiesQuery.refetch()}
                  >
                    <RefreshCw className="h-3 w-3" />
                    Atualizar
                  </button>
                </div>
                <OpportunityTable
                  opportunities={opportunitiesQuery.data || []}
                  isLoading={opportunitiesQuery.isLoading}
                />
              </div>
            )}

            {activeTab === 'relatorios' && (
              <ReportViewer
                entityType="empresa"
                entityId={selectedCompany.id}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
