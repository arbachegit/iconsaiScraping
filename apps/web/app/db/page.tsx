'use client';

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  LayoutDashboard,
  Link2,
  Loader2,
  Network,
  Search,
} from 'lucide-react';
import {
  getDbModelOverview,
  getDbModelTableDetails,
  getUser,
  type DbModelTableDetailResponse,
} from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';
import { isAdminRole } from '@/lib/permissions';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DbDiagram } from '@/components/db-model/db-diagram';

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('pt-BR', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value);
}

function formatFullNumber(value: number) {
  return new Intl.NumberFormat('pt-BR').format(value);
}

function formatPercent(value: number | null) {
  if (value == null) return '-';
  return `${(value * 100).toFixed(value >= 0.995 ? 0 : 1)}%`;
}

function normalizeText(value: string) {
  return value.toLowerCase().trim();
}

export default function DbPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDomain, setSelectedDomain] = useState('all');
  const [showTechnical, setShowTechnical] = useState(false);
  const [selectedTableName, setSelectedTableName] = useState<string | null>(null);
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  const [infoTables, setInfoTables] = useState<Record<string, boolean>>({});
  const [tableDetails, setTableDetails] = useState<
    Record<string, DbModelTableDetailResponse['table']>
  >({});
  const [tableErrors, setTableErrors] = useState<Record<string, string>>({});
  const [loadingTables, setLoadingTables] = useState<Record<string, boolean>>({});
  const deferredSearch = useDeferredValue(searchQuery);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.push('/');
    }
  }, [router]);

  const userQuery = useQuery({
    queryKey: ['user'],
    queryFn: getUser,
    retry: false,
  });

  const isAdmin = Boolean(
    userQuery.data && (userQuery.data.is_admin || isAdminRole(userQuery.data.role))
  );

  useEffect(() => {
    if (userQuery.isError) {
      router.push('/');
      return;
    }

    if (userQuery.data && !isAdmin) {
      router.push('/dashboard');
    }
  }, [isAdmin, router, userQuery.data, userQuery.isError]);

  const overviewQuery = useQuery({
    queryKey: ['db-model-overview'],
    queryFn: getDbModelOverview,
    enabled: isAdmin,
  });

  const overview = overviewQuery.data;

  const visibleTables = useMemo(() => {
    const tables = overview?.tables || [];
    const query = normalizeText(deferredSearch);

    return tables.filter((table) => {
      if (!showTechnical && table.isHiddenByDefault) return false;
      if (selectedDomain !== 'all' && table.domain !== selectedDomain) return false;
      if (!query) return true;

      const haystack = normalizeText(
        `${table.name} ${table.friendlyName} ${table.description} ${table.domainLabel}`
      );
      return haystack.includes(query);
    });
  }, [deferredSearch, overview?.tables, selectedDomain, showTechnical]);

  const visibleRelationships = useMemo(() => {
    const visibleTableNames = new Set(visibleTables.map((table) => table.name));
    return (overview?.relationships || []).filter(
      (relationship) =>
        visibleTableNames.has(relationship.sourceTable) &&
        visibleTableNames.has(relationship.targetTable)
    );
  }, [overview?.relationships, visibleTables]);

  useEffect(() => {
    if (visibleTables.length === 0) {
      setSelectedTableName(null);
      return;
    }

    const selectedStillVisible = visibleTables.some((table) => table.name === selectedTableName);
    if (!selectedStillVisible) {
      setSelectedTableName(visibleTables[0].name);
    }
  }, [selectedTableName, visibleTables]);

  async function loadTableDetails(tableName: string) {
    if (tableDetails[tableName] || loadingTables[tableName]) return;

    setLoadingTables((current) => ({ ...current, [tableName]: true }));
    setTableErrors((current) => ({ ...current, [tableName]: '' }));

    try {
      const result = await getDbModelTableDetails(tableName);
      setTableDetails((current) => ({ ...current, [tableName]: result.table }));
    } catch (error) {
      setTableErrors((current) => ({
        ...current,
        [tableName]: error instanceof Error ? error.message : 'Falha ao carregar tabela',
      }));
    } finally {
      setLoadingTables((current) => ({ ...current, [tableName]: false }));
    }
  }

  function toggleExpanded(tableName: string) {
    const nextExpanded = !expandedTables[tableName];
    setExpandedTables((current) => ({ ...current, [tableName]: nextExpanded }));
    setSelectedTableName(tableName);

    if (nextExpanded) {
      void loadTableDetails(tableName);
    }
  }

  function toggleInfo(tableName: string) {
    setInfoTables((current) => ({ ...current, [tableName]: !current[tableName] }));
  }

  const selectedTable = selectedTableName
    ? visibleTables.find((table) => table.name === selectedTableName) || null
    : null;

  return (
    <div className="h-screen flex flex-col bg-[#0a0e1a] overflow-hidden">
      <header className="flex-shrink-0 bg-[#0f1629]/80 backdrop-blur-xl border-b border-cyan-500/10">
        <div className="flex items-center justify-between px-4 lg:px-6 py-2.5">
          <div className="flex items-center gap-3 min-w-0">
            <picture>
              <source srcSet="/iconsai-logo.webp" type="image/webp" />
              <img src="/iconsai-logo.png" alt="Iconsai" className="h-8 w-auto" />
            </picture>
            <div className="min-w-0">
              <h1 className="text-lg font-bold bg-gradient-to-r from-emerald-300 via-cyan-300 to-blue-400 bg-clip-text text-transparent hidden sm:block">
                Database Model
              </h1>
              <p className="text-[11px] text-slate-400 hidden lg:block">
                Tabelas de negocio primeiro. Governanca e infra escondidas por padrao.
              </p>
            </div>
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
              href="/graph"
              className="inline-flex items-center gap-1.5 h-9 px-3 bg-purple-500/15 border border-purple-500/50 text-purple-300 rounded-lg text-xs font-medium hover:bg-purple-500 hover:text-white transition-colors"
            >
              <Network className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Graph</span>
            </Link>
            <span className="inline-flex items-center gap-1.5 h-9 px-3 bg-emerald-500/15 border border-emerald-500/50 text-emerald-300 rounded-lg text-xs font-semibold">
              <Database className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">DB</span>
            </span>
          </nav>
        </div>
      </header>

      <main className="flex-1 overflow-hidden px-4 lg:px-6 py-4">
        {(!isAdmin && userQuery.isLoading) || overviewQuery.isLoading ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 text-cyan-400 animate-spin" />
              <span className="text-sm text-slate-400">Montando mapa do banco...</span>
            </div>
          </div>
        ) : overviewQuery.isError ? (
          <div className="h-full flex items-center justify-center">
            <div className="max-w-md rounded-2xl border border-red-500/20 bg-red-500/10 px-6 py-5 text-center">
              <AlertCircle className="h-8 w-8 text-red-300 mx-auto mb-3" />
              <p className="text-sm text-slate-200">
                {overviewQuery.error instanceof Error
                  ? overviewQuery.error.message
                  : 'Falha ao carregar o modelo do banco.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid h-full gap-4 xl:grid-cols-[420px,minmax(0,1fr)]">
            <section className="min-h-0 flex flex-col rounded-3xl border border-cyan-500/15 bg-[#0f1629]/85 shadow-[0_0_30px_rgba(34,211,238,0.08)] overflow-hidden">
              <div className="border-b border-cyan-500/10 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Catalogo de Tabelas</h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Clique no chevron para ver schema, colunas e cobertura estimada por campo.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowTechnical((current) => !current)}
                    className="inline-flex items-center gap-2 h-9 px-3 rounded-xl border border-cyan-500/20 bg-cyan-500/10 text-cyan-300 text-xs font-medium hover:bg-cyan-500/20 transition-colors"
                  >
                    {showTechnical ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    <span>{showTechnical ? 'Ocultar tecnicas' : 'Mostrar tecnicas'}</span>
                  </button>
                </div>

                <div className="mt-4 flex items-center bg-slate-900/70 border border-cyan-500/15 rounded-2xl px-3 h-12">
                  <Search className="h-4 w-4 text-slate-500 flex-shrink-0" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Buscar por tabela, dominio ou descricao"
                    className="flex-1 bg-transparent px-3 text-sm text-slate-200 placeholder-slate-500 outline-none"
                  />
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedDomain('all')}
                    className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors ${
                      selectedDomain === 'all'
                        ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-200'
                        : 'border-slate-700 bg-slate-900/70 text-slate-400 hover:border-slate-600 hover:text-slate-200'
                    }`}
                  >
                    Todos ({visibleTables.length}/{overview?.tables.length || 0})
                  </button>
                  {(overview?.domains || []).map((domain) => {
                    const count = showTechnical ? domain.tableCount : domain.visibleCount;
                    if (!showTechnical && domain.visibleCount === 0) return null;

                    return (
                      <button
                        key={domain.domain}
                        type="button"
                        onClick={() => setSelectedDomain(domain.domain)}
                        className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors ${
                          selectedDomain === domain.domain
                            ? 'text-white'
                            : 'border-slate-700 bg-slate-900/70 text-slate-400 hover:border-slate-600 hover:text-slate-200'
                        }`}
                        style={
                          selectedDomain === domain.domain
                            ? {
                                borderColor: `${domain.color}66`,
                                backgroundColor: `${domain.color}22`,
                              }
                            : undefined
                        }
                      >
                        {domain.label} ({count})
                      </button>
                    );
                  })}
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="rounded-2xl border border-cyan-500/10 bg-slate-950/50 px-3 py-2">
                    <p className="text-[11px] text-slate-500">Visiveis</p>
                    <p className="text-sm font-semibold text-cyan-200">{visibleTables.length}</p>
                  </div>
                  <div className="rounded-2xl border border-cyan-500/10 bg-slate-950/50 px-3 py-2">
                    <p className="text-[11px] text-slate-500">Relacoes</p>
                    <p className="text-sm font-semibold text-cyan-200">
                      {visibleRelationships.length}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-cyan-500/10 bg-slate-950/50 px-3 py-2">
                    <p className="text-[11px] text-slate-500">Modo</p>
                    <p className="text-sm font-semibold text-cyan-200">Estimado</p>
                  </div>
                </div>
              </div>

              <ScrollArea className="flex-1 min-h-0">
                <div className="p-4 space-y-3">
                  {visibleTables.length === 0 ? (
                    <div className="rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-6 text-center">
                      <Database className="h-8 w-8 text-slate-600 mx-auto mb-3" />
                      <p className="text-sm text-slate-300">
                        Nenhuma tabela combina com os filtros atuais.
                      </p>
                    </div>
                  ) : (
                    visibleTables.map((table) => {
                      const detail = tableDetails[table.name];
                      const isExpanded = Boolean(expandedTables[table.name]);
                      const isInfoOpen = Boolean(infoTables[table.name]);
                      const isSelected = selectedTableName === table.name;
                      const isLoading = Boolean(loadingTables[table.name]);
                      const errorMessage = tableErrors[table.name];

                      return (
                        <div
                          key={table.id}
                          className={`rounded-2xl border transition-colors ${
                            isSelected
                              ? 'border-cyan-400/40 bg-cyan-500/10'
                              : 'border-cyan-500/10 bg-slate-950/50'
                          }`}
                        >
                          <div className="flex items-start gap-3 px-4 py-4">
                            <button
                              type="button"
                              onClick={() => toggleExpanded(table.name)}
                              className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-cyan-500/15 bg-slate-900/70 text-slate-300 hover:border-cyan-400/30 hover:text-cyan-200 transition-colors"
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </button>

                            <button
                              type="button"
                              onClick={() => setSelectedTableName(table.name)}
                              className="min-w-0 flex-1 text-left"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                                  style={{ backgroundColor: table.domainColor }}
                                />
                                <h3 className="text-sm font-semibold text-white truncate">
                                  {table.name}
                                </h3>
                              </div>
                              <p className="mt-1 text-xs text-slate-400">{table.friendlyName}</p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <span className="rounded-full border border-slate-700 bg-slate-900/70 px-2 py-1 text-[11px] text-slate-300">
                                  {table.domainLabel}
                                </span>
                                <span className="rounded-full border border-slate-700 bg-slate-900/70 px-2 py-1 text-[11px] text-slate-300">
                                  {formatCompactNumber(table.estimatedRowCount)} registros
                                </span>
                                <span className="rounded-full border border-slate-700 bg-slate-900/70 px-2 py-1 text-[11px] text-slate-300">
                                  {table.columnCount} colunas
                                </span>
                              </div>
                            </button>

                            <button
                              type="button"
                              onClick={() => toggleInfo(table.name)}
                              className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-cyan-500/15 bg-slate-900/70 text-slate-300 hover:border-cyan-400/30 hover:text-cyan-200 transition-colors"
                            >
                              <Info className="h-4 w-4" />
                            </button>
                          </div>

                          {isInfoOpen && (
                            <div className="border-t border-cyan-500/10 px-4 py-3">
                              <p className="text-xs leading-6 text-slate-300">
                                {table.description}
                              </p>
                            </div>
                          )}

                          {isExpanded && (
                            <div className="border-t border-cyan-500/10 px-4 py-4">
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                                  <p className="text-slate-500">Schema</p>
                                  <p className="mt-1 font-medium text-slate-200">{table.schema}</p>
                                </div>
                                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                                  <p className="text-slate-500">FKs</p>
                                  <p className="mt-1 font-medium text-slate-200">
                                    {table.foreignKeyCount}
                                  </p>
                                </div>
                                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                                  <p className="text-slate-500">Registros</p>
                                  <p className="mt-1 font-medium text-slate-200">
                                    {formatFullNumber(table.estimatedRowCount)}
                                  </p>
                                </div>
                                <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                                  <p className="text-slate-500">Obrigatorias</p>
                                  <p className="mt-1 font-medium text-slate-200">
                                    {table.requiredColumnCount}
                                  </p>
                                </div>
                              </div>

                              {isLoading ? (
                                <div className="flex items-center gap-2 rounded-2xl border border-cyan-500/10 bg-slate-950/50 px-4 py-4 mt-4">
                                  <Loader2 className="h-4 w-4 text-cyan-400 animate-spin" />
                                  <span className="text-xs text-slate-300">
                                    Carregando cobertura estimada das colunas...
                                  </span>
                                </div>
                              ) : errorMessage ? (
                                <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-200">
                                  {errorMessage}
                                </div>
                              ) : detail ? (
                                <>
                                  <div className="mt-4 rounded-2xl border border-cyan-500/10 bg-slate-950/50 overflow-hidden">
                                    <div className="flex items-center justify-between px-4 py-3 border-b border-cyan-500/10">
                                      <span className="text-xs font-medium text-slate-300">
                                        Cobertura por coluna
                                      </span>
                                      <span className="text-[11px] text-slate-500">
                                        Contagens estimadas via catalogo do banco
                                      </span>
                                    </div>
                                    <ScrollArea className="h-80">
                                      <div className="p-4 space-y-3">
                                        {detail.columns.map((column) => (
                                          <div
                                            key={`${table.name}.${column.name}`}
                                            className="rounded-2xl border border-slate-800 bg-slate-950/60 px-3 py-3"
                                          >
                                            <div className="flex items-start justify-between gap-3">
                                              <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-2">
                                                  <p className="text-sm font-medium text-white break-all">
                                                    {column.name}
                                                  </p>
                                                  {column.isPrimaryKey && (
                                                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">
                                                      <KeyRound className="h-3 w-3" />
                                                      PK
                                                    </span>
                                                  )}
                                                  {column.isForeignKey && (
                                                    <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-200">
                                                      <Link2 className="h-3 w-3" />
                                                      FK
                                                    </span>
                                                  )}
                                                  <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400">
                                                    {column.nullable ? 'nullable' : 'not null'}
                                                  </span>
                                                </div>
                                                <p className="mt-1 text-[11px] text-slate-500">
                                                  {column.type}
                                                </p>
                                                {column.description && (
                                                  <p className="mt-2 text-[11px] leading-5 text-slate-400">
                                                    {column.description}
                                                  </p>
                                                )}
                                                {column.references && (
                                                  <p className="mt-2 text-[11px] text-cyan-300">
                                                    Relaciona com {column.references.table}.
                                                    {column.references.column}
                                                  </p>
                                                )}
                                              </div>
                                              <div className="text-right flex-shrink-0">
                                                <p className="text-sm font-semibold text-cyan-200">
                                                  {formatCompactNumber(column.nonNullCount)}
                                                </p>
                                                <p className="text-[11px] text-slate-500">
                                                  {formatPercent(column.coverageRatio)}
                                                </p>
                                              </div>
                                            </div>

                                            <div className="mt-3 h-2 rounded-full bg-slate-900/80 overflow-hidden">
                                              <div
                                                className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-emerald-300 to-blue-400"
                                                style={{
                                                  width: `${Math.max(
                                                    2,
                                                    Math.min(100, (column.coverageRatio || 0) * 100)
                                                  )}%`,
                                                }}
                                              />
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </ScrollArea>
                                  </div>

                                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                                    <div className="rounded-2xl border border-cyan-500/10 bg-slate-950/50 px-4 py-4">
                                      <p className="text-xs font-medium text-slate-300">
                                        FKs saindo da tabela
                                      </p>
                                      <div className="mt-3 space-y-2">
                                        {detail.outgoingRelationships.length === 0 ? (
                                          <p className="text-xs text-slate-500">
                                            Nenhuma FK saindo desta tabela.
                                          </p>
                                        ) : (
                                          detail.outgoingRelationships.map((relationship) => (
                                            <div
                                              key={relationship.id}
                                              className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs text-slate-300"
                                            >
                                              <span className="text-cyan-300">
                                                {relationship.sourceColumn}
                                              </span>{' '}
                                              aponta para{' '}
                                              <span className="text-white">
                                                {relationship.targetTable}
                                              </span>
                                              .{relationship.targetColumn}
                                            </div>
                                          ))
                                        )}
                                      </div>
                                    </div>

                                    <div className="rounded-2xl border border-cyan-500/10 bg-slate-950/50 px-4 py-4">
                                      <p className="text-xs font-medium text-slate-300">
                                        FKs chegando na tabela
                                      </p>
                                      <div className="mt-3 space-y-2">
                                        {detail.incomingRelationships.length === 0 ? (
                                          <p className="text-xs text-slate-500">
                                            Nenhuma tabela aponta para ela.
                                          </p>
                                        ) : (
                                          detail.incomingRelationships.map((relationship) => (
                                            <div
                                              key={relationship.id}
                                              className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs text-slate-300"
                                            >
                                              <span className="text-white">
                                                {relationship.sourceTable}
                                              </span>
                                              .
                                              <span className="text-cyan-300">
                                                {relationship.sourceColumn}
                                              </span>{' '}
                                              chega em {relationship.targetColumn}
                                            </div>
                                          ))
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                </>
                              ) : null}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </ScrollArea>
            </section>

            <section className="min-h-0 flex flex-col rounded-3xl border border-cyan-500/15 bg-[#0f1629]/85 shadow-[0_0_30px_rgba(34,211,238,0.08)] overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-cyan-500/10 px-4 py-4">
                <div>
                  <h2 className="text-sm font-semibold text-white">Diagrama de Relacoes</h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Cada caixa representa uma tabela. As setas mostram as FKs entre elas.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1.5 text-[11px] text-cyan-200">
                    {visibleTables.length} tabelas
                  </span>
                  <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1.5 text-[11px] text-cyan-200">
                    {visibleRelationships.length} FKs
                  </span>
                </div>
              </div>

              <div className="relative flex-1 min-h-[520px]">
                {visibleTables.length === 0 ? (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center max-w-sm px-6">
                      <Database className="h-12 w-12 text-slate-600 mx-auto mb-4" />
                      <p className="text-sm text-slate-300">
                        Ajuste os filtros do catalogo para voltar a desenhar o diagrama.
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    <DbDiagram
                      tables={visibleTables}
                      relationships={visibleRelationships}
                      selectedTableName={selectedTableName}
                      onSelectTable={setSelectedTableName}
                    />

                    {selectedTable && (
                      <div className="absolute top-3 left-3 right-3 xl:right-auto z-10">
                        <div className="rounded-2xl border border-cyan-500/20 bg-[#0f1629]/90 backdrop-blur-xl px-4 py-3 shadow-[0_0_20px_rgba(34,211,238,0.08)]">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span
                                  className="h-2.5 w-2.5 rounded-full"
                                  style={{ backgroundColor: selectedTable.domainColor }}
                                />
                                <p className="text-sm font-semibold text-white truncate">
                                  {selectedTable.name}
                                </p>
                              </div>
                              <p className="text-xs text-slate-400 mt-1">
                                {selectedTable.description}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => toggleExpanded(selectedTable.name)}
                              className="inline-flex h-9 items-center gap-2 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 transition-colors"
                            >
                              {expandedTables[selectedTable.name] ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                              Detalhes
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
