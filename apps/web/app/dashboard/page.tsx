'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  Building2,
  Users,
  Flag,
  Newspaper,
  LogOut,
  Shield,
  Vote,
  Receipt,
  Network,
  Database,
  LayoutDashboard,
  BookOpen,
  Brain,
} from 'lucide-react';
import {
  getUser,
  getHealth,
  getStatsCurrent,
  getStatsHistory,
  createStatsSnapshot,
  type StatItem,
  type CategoryHistory,
} from '@/lib/api';
import { isAuthenticated, clearTokens } from '@/lib/auth';
import { hasModuleAccess, isAdminRole } from '@/lib/permissions';
import { AtlasChat } from '@/components/atlas/atlas-chat';
import { CompanyModal } from '@/components/modals/company-modal';
import { CnaeModal } from '@/components/modals/cnae-modal';
import { RegimeModal } from '@/components/modals/regime-modal';
import { NewsModal } from '@/components/modals/news-modal';
import {
  EmpresasListingModal,
  PessoasListingModal,
  NoticiasListingModal,
  PoliticosListingModal,
  MandatosListingModal,
  EmendasListingModal,
} from '@/components/modals/listing-modal';
import { StatsBadgeCard, StatsCounterLine } from '@/components/stats/stats-badge-card';

// ==========================================================================
// GOLDEN RULE 5: Stats Constants (IMMUTABLE)
// DO NOT change COUNTDOWN_MAX, categoryConfig colors, or category keys.
// ==========================================================================
const COUNTDOWN_MAX = 60;

const categoryConfig = {
  empresas: { icon: Building2, color: 'red' as const, label: 'Empresas' },
  pessoas: { icon: Users, color: 'orange' as const, label: 'Pessoas' },
  politicos: { icon: Flag, color: 'blue' as const, label: 'Políticos' },
  mandatos: { icon: Vote, color: 'purple' as const, label: 'Mandatos' },
  emendas: { icon: Receipt, color: 'cyan' as const, label: 'Emendas' },
  noticias: { icon: Newspaper, color: 'green' as const, label: 'Notícias' },
};

type CategoryKey = keyof typeof categoryConfig;
// ======================== END GOLDEN RULE 5 (constants) ==================

export default function DashboardPage() {
  const router = useRouter();
  const [userName, setUserName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [userPermissions, setUserPermissions] = useState<string[]>([]);
  const [version, setVersion] = useState('v1.14.2026');

  // Modal states
  const [companyModalOpen, setCompanyModalOpen] = useState(false);
  const [cnaeModalOpen, setCnaeModalOpen] = useState(false);
  const [regimeModalOpen, setRegimeModalOpen] = useState(false);
  const [newsModalOpen, setNewsModalOpen] = useState(false);
  const [empresasListingOpen, setEmpresasListingOpen] = useState(false);
  const [pessoasListingOpen, setPessoasListingOpen] = useState(false);
  const [noticiasListingOpen, setNoticiasListingOpen] = useState(false);
  const [politicosListingOpen, setPoliticosListingOpen] = useState(false);
  const [mandatosListingOpen, setMandatosListingOpen] = useState(false);
  const [emendasListingOpen, setEmendasListingOpen] = useState(false);

  // Selected values from picker modals
  const [selectedCnae, setSelectedCnae] = useState<string>('');
  const [selectedRegime, setSelectedRegime] = useState<string>('');

  // Auth check — gates all data fetching
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.push('/');
      return;
    }
    setAuthReady(true);
  }, [router]);

  // Load user info
  const userQuery = useQuery({
    queryKey: ['user'],
    queryFn: getUser,
    retry: false,
    enabled: authReady,
  });

  useEffect(() => {
    if (userQuery.data) {
      setUserName(userQuery.data.name || userQuery.data.email);
      const role = (userQuery.data as { role?: string }).role;
      setIsAdmin(isAdminRole(role) || userQuery.data.is_admin);
      setUserPermissions(userQuery.data.permissions || []);
    }
    if (userQuery.isError) {
      // Disable query gates first, then clear tokens and redirect
      setAuthReady(false);
      setSnapshotReady(false);
      clearTokens();
      router.push('/');
    }
  }, [userQuery.data, userQuery.isError]);

  // Load version
  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
    enabled: authReady,
  });

  useEffect(() => {
    if (healthQuery.data?.version) {
      setVersion('v' + healthQuery.data.version);
    }
  }, [healthQuery.data]);

  // ==========================================================================
  // GOLDEN RULE 5: Stats Load Pipeline (IMMUTABLE)
  //
  // Flow: snapshot → wait → fetch current + history → fill counters + charts
  //       → 60s countdown → re-snapshot → refetch (keep previous data)
  //
  // 1. createStatsSnapshot() writes to stats_historico FIRST
  // 2. snapshotReady gate ensures queries only fire AFTER snapshot completes
  // 3. placeholderData: keepPreviousData — numbers NEVER flash to zero on refetch
  // 4. Numbers only go UP (monotonic rule enforced by backend)
  // 5. Countdown ring: loading spinner during initial load, 60s cron after
  //
  // DO NOT remove snapshotReady — it prevents the race condition.
  // DO NOT remove placeholderData — it prevents zero-flash on refetch.
  // DO NOT move createStatsSnapshot() after the queries.
  // ==========================================================================
  const queryClient = useQueryClient();
  const [snapshotReady, setSnapshotReady] = useState(false);
  const snapshotDoneRef = useRef(false);
  const [countdown, setCountdown] = useState(COUNTDOWN_MAX);

  useEffect(() => {
    if (!authReady) return;
    if (!snapshotDoneRef.current) {
      snapshotDoneRef.current = true;
      createStatsSnapshot()
        .then((result) => {
          setSnapshotReady(true);
          // If snapshot failed (backend timeout), retry once
          if (!result.success) {
            createStatsSnapshot()
              .catch(() => {});
          }
        })
        .catch(() => {
          // Even on network error, enable queries so UI isn't stuck
          setSnapshotReady(true);
        });
    }
  }, [authReady]);

  // Countdown timer: starts after initial data loads
  useEffect(() => {
    if (!snapshotReady) return;
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 0) return COUNTDOWN_MAX;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [snapshotReady]);

  // Refresh handler: re-snapshot then invalidate queries (keepPreviousData prevents zero)
  const handleRefreshComplete = useCallback(() => {
    createStatsSnapshot()
      .catch(() => {})
      .finally(() => {
        queryClient.invalidateQueries({ queryKey: ['stats-current'] });
        queryClient.invalidateQueries({ queryKey: ['stats-history'] });
      });
  }, [queryClient]);

  const statsQuery = useQuery({
    queryKey: ['stats-current'],
    queryFn: () => getStatsCurrent(),
    enabled: snapshotReady,
    staleTime: 55_000,
    retry: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  const historyQuery = useQuery({
    queryKey: ['stats-history'],
    queryFn: () => getStatsHistory(365),
    enabled: snapshotReady,
    staleTime: 55_000,
    retry: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  // ======================== END GOLDEN RULE 5 ==============================

  function handleLogout() {
    // Disable all query gates BEFORE clearing tokens to prevent
    // React Query from firing requests with cleared credentials
    setAuthReady(false);
    setSnapshotReady(false);
    clearTokens();
    router.push('/');
  }

  function handleCnaeSelect(codigo: string) {
    setSelectedCnae(codigo);
  }

  function handleRegimeSelect(codigo: string) {
    setSelectedRegime(codigo);
  }

  function openPoliticosFromCard() {
    setPoliticosListingOpen(true);
  }

  function openEmendasFromCard() {
    router.push('/emendas');
  }

  // ==========================================================================
  // GOLDEN RULE 5 (cont.): Stats Data Mapping (IMMUTABLE)
  //
  // statsMap  → feeds StatsCounterLine (index numbers)
  // historyMap → feeds StatsBadgeCard (charts)
  //
  // DO NOT change the mapping logic or fallback values.
  // ==========================================================================
  const statsMap = new Map<string, StatItem>();
  for (const stat of statsQuery.data?.stats || []) {
    statsMap.set(stat.categoria, stat);
  }

  const historyMap: Record<string, CategoryHistory> = historyQuery.data?.historico || {};
  const dataReferencia = statsQuery.data?.data_referencia || '';
  const isOnline = statsQuery.data?.online ?? false;
  const isStatsLoading = statsQuery.isLoading || historyQuery.isLoading;
  const statsErrorMessage =
    (statsQuery.error instanceof Error && statsQuery.error.message) ||
    (historyQuery.error instanceof Error && historyQuery.error.message) ||
    '';

  const counterStats = Object.keys(categoryConfig).map((key) => {
    const cat = key as CategoryKey;
    return {
      label: categoryConfig[cat].label,
      value: statsMap.get(cat)?.total || 0,
      color: categoryConfig[cat].color,
    };
  });
  // ======================== END GOLDEN RULE 5 ==============================

  return (
    <div className="h-screen flex flex-col bg-[#0a0e1a] overflow-hidden">
      {/* Header - Compact */}
      <header className="flex-shrink-0 bg-[#0f1629]/80 backdrop-blur-xl border-b border-cyan-500/10">
        <div className="flex items-center justify-between px-4 lg:px-6 py-2.5">
          <div className="flex items-center gap-3">
            <picture>
              <source srcSet="/iconsai-logo.webp" type="image/webp" />
              <img src="/iconsai-logo.png" alt="Iconsai" className="h-8 w-auto" />
            </picture>
            <h1 className="text-lg font-bold bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-400 bg-clip-text text-transparent hidden sm:block">
              Scraping Hub
            </h1>
            <span className="px-2 py-0.5 text-[10px] text-slate-400 bg-slate-400/10 border border-slate-400/20 rounded">
              {version}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/graph"
              className="inline-flex items-center gap-1.5 h-9 px-3 bg-purple-500/15 border border-purple-500/50 text-purple-400 rounded-lg text-xs font-semibold hover:bg-purple-500 hover:text-white transition-colors"
            >
              <Network className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Graph</span>
            </a>
            <a
              href="/inteligencia"
              className="inline-flex items-center gap-1.5 h-9 px-3 bg-cyan-500/15 border border-cyan-500/50 text-cyan-400 rounded-lg text-xs font-semibold hover:bg-cyan-500 hover:text-white transition-colors"
            >
              <Brain className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Inteligência</span>
            </a>
            {isAdmin && (
              <a
                href="/db"
                className="inline-flex items-center gap-1.5 h-9 px-3 bg-emerald-500/15 border border-emerald-500/50 text-emerald-300 rounded-lg text-xs font-semibold hover:bg-emerald-500 hover:text-white transition-colors"
              >
                <Database className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">DB</span>
              </a>
            )}
            {isAdmin && (
              <a
                href="/admin"
                className="inline-flex items-center gap-1.5 h-9 px-3 bg-cyan-500/15 border border-cyan-500/50 text-cyan-400 rounded-lg text-xs font-semibold hover:bg-cyan-500 hover:text-white transition-colors"
              >
                <Shield className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Usuários</span>
              </a>
            )}
            <span className="inline-flex items-center justify-center h-9 px-3 bg-slate-400/15 border border-slate-400/30 rounded-lg text-slate-200 text-xs font-medium">
              {userName || '-'}
            </span>
            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 h-9 px-3 bg-red-500/15 border border-red-500/50 text-red-400 rounded-lg text-xs font-medium hover:bg-red-500 hover:text-white transition-colors"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Sair</span>
            </button>
          </div>
        </div>
      </header>

      {/* ================================================================ */}
      {/* GOLDEN RULE 5: Counter Line + Cron Ring (IMMUTABLE)             */}
      {/* Shows 6 animated counters + countdown ring on right side.       */}
      {/* Ring = loading spinner during initial load, 60s cron after.     */}
      {/* DO NOT remove countdown/maxCountdown/onRefreshComplete props.   */}
      {/* DO NOT change isLoading logic — it gates spinner vs ring.       */}
      {/* ================================================================ */}
      <div className="flex-shrink-0">
        <StatsCounterLine
          stats={counterStats}
          countdown={statsErrorMessage ? undefined : countdown}
          maxCountdown={statsErrorMessage ? undefined : COUNTDOWN_MAX}
          onRefreshComplete={statsErrorMessage ? undefined : handleRefreshComplete}
          isLoading={!statsQuery.data}
        />
      </div>
      {/* ==================== END GOLDEN RULE 5 (counter line) ========= */}

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto px-4 lg:px-6 py-4">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 lg:flex-row lg:items-start">
          <aside className="w-full lg:sticky lg:top-4 lg:w-64 lg:flex-shrink-0">
            <div className="overflow-hidden rounded-2xl border border-cyan-500/15 bg-[#0f1629]/90 shadow-[0_24px_80px_-40px_rgba(34,211,238,0.45)] backdrop-blur">
              <div className="border-b border-cyan-500/10 px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-400/80">
                  Navegação
                </p>
                <h2 className="mt-1 text-sm font-semibold text-slate-200">
                  Módulos analíticos
                </h2>
              </div>

              <nav className="p-3">
                <div className="grid gap-2">
                  <DashboardNavLink
                    href="/dashboard"
                    icon={LayoutDashboard}
                    title="Dashboard"

                    active
                  />
                  <DashboardNavLink
                    href="/graph"
                    icon={Network}
                    title="Graph"

                  />
                  <DashboardNavLink
                    href="/emendas"
                    icon={Receipt}
                    title="Emendas"

                  />
                  <DashboardNavLink
                    href="/noticias"
                    icon={Newspaper}
                    title="Notícias"

                  />
                  <DashboardNavLink
                    href="/inteligencia"
                    icon={Brain}
                    title="Inteligência"

                  />
                  <DashboardNavLink
                    href="/modelo-estatistico"
                    icon={BookOpen}
                    title="Modelo Estatístico"

                  />
                  {isAdmin && (
                    <DashboardNavLink
                      href="/db"
                      icon={Database}
                      title="DB"

                    />
                  )}
                </div>
              </nav>

              <div className="border-t border-cyan-500/10 px-4 py-3">
                <p className="text-[11px] leading-relaxed text-slate-400">
                  O modelo estatístico agora separa relevância do nó e confiança da relação. A documentação completa está em
                  {' '}
                  <Link href="/modelo-estatistico" className="text-cyan-400 hover:text-cyan-300">
                    Modelo Estatístico
                  </Link>
                  .
                </p>
              </div>
            </div>
          </aside>

          <div className="min-w-0 flex-1">
          {/* Intelligence Modules - Neo Glow Cards (filtered by permissions) */}
          <div className="py-4 mb-1 overflow-visible">
            <div className="flex flex-nowrap justify-center gap-2">
              {hasModuleAccess(userPermissions, 'empresas') && (
                <NeoGlowCompactCard
                  icon={Building2}
                  iconColor="red"
                  title="Empresas"

                  onClick={() => setCompanyModalOpen(true)}
                />
              )}
              {hasModuleAccess(userPermissions, 'pessoas') && (
                <NeoGlowCompactCard
                  icon={Users}
                  iconColor="orange"
                  title="Pessoas"

                  onClick={() => setPessoasListingOpen(true)}
                />
              )}
              {hasModuleAccess(userPermissions, 'politicos') && (
                <NeoGlowCompactCard
                  icon={Flag}
                  iconColor="blue"
                  title="Políticos"

                  onClick={openPoliticosFromCard}
                />
              )}
              {hasModuleAccess(userPermissions, 'politicos') && (
                <NeoGlowCompactCard
                  icon={Vote}
                  iconColor="purple"
                  title="Mandatos"

                  onClick={() => setMandatosListingOpen(true)}
                />
              )}
              {hasModuleAccess(userPermissions, 'emendas') && (
                <NeoGlowCompactCard
                  icon={Receipt}
                  iconColor="cyan"
                  title="Emendas"

                  onClick={openEmendasFromCard}
                />
              )}
              {hasModuleAccess(userPermissions, 'noticias') && (
                <NeoGlowCompactCard
                  icon={Newspaper}
                  iconColor="green"
                  title="Notícias"

                  onClick={() => router.push('/noticias')}
                />
              )}
            </div>
          </div>

          {/* ============================================================ */}
          {/* GOLDEN RULE 5: Stats Badge Charts (IMMUTABLE)                */}
          {/*                                                              */}
          {/* 3 rows x 2 cols of StatsBadgeCard with MiniSparkline charts. */}
          {/* Row 1: empresas (red) + pessoas (orange)                     */}
          {/* Row 2: politicos (blue) + mandatos (purple)                  */}
          {/* Row 3: emendas (cyan) + noticias (green)                     */}
          {/*                                                              */}
          {/* DO NOT change row layout, category order, or prop mapping.   */}
          {/* DO NOT remove any category or add new rows without approval. */}
          {/* ============================================================ */}
          <div className="mb-6">
            <h2 className="text-[25px] font-semibold text-slate-400 mb-3">
              Estatísticas em Tempo Real
            </h2>

            {statsErrorMessage && (
              <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                Falha ao carregar indicadores do banco: {statsErrorMessage}
              </div>
            )}

            {/* Row 1: Empresas + Pessoas (large) */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              {(['empresas', 'pessoas'] as CategoryKey[]).map((cat) => {
                const config = categoryConfig[cat];
                const stat = statsMap.get(cat);
                const catHistory = historyMap[cat];
                return (
                  <StatsBadgeCard
                    key={cat}
                    icon={config.icon}
                    label={config.label}
                    total={stat?.total || 0}
                    todayInserts={stat?.today_inserts ?? catHistory?.today ?? 0}
                    periodTotal={catHistory?.periodTotal ?? 0}
                    crescimento={stat?.crescimento_percentual || 0}
                    dataReferencia={dataReferencia}
                    online={isOnline}
                    history={catHistory?.points || []}
                    color={config.color}
                    size="large"
                    isLoading={isStatsLoading}
                  />
                );
              })}
            </div>

            {/* Row 2: Politicos + Mandatos (large) */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              {(['politicos', 'mandatos'] as CategoryKey[]).map((cat) => {
                const config = categoryConfig[cat];
                const stat = statsMap.get(cat);
                const catHistory = historyMap[cat];
                return (
                  <StatsBadgeCard
                    key={cat}
                    icon={config.icon}
                    label={config.label}
                    total={stat?.total || 0}
                    todayInserts={stat?.today_inserts ?? catHistory?.today ?? 0}
                    periodTotal={catHistory?.periodTotal ?? 0}
                    crescimento={stat?.crescimento_percentual || 0}
                    dataReferencia={dataReferencia}
                    online={isOnline}
                    history={catHistory?.points || []}
                    color={config.color}
                    size="large"
                    isLoading={isStatsLoading}
                  />
                );
              })}
            </div>

            {/* Row 3: Emendas + Noticias (large) */}
            <div className="grid grid-cols-2 gap-4">
              {(['emendas', 'noticias'] as CategoryKey[]).map((cat) => {
                const config = categoryConfig[cat];
                const stat = statsMap.get(cat);
                const catHistory = historyMap[cat];
                return (
                  <StatsBadgeCard
                    key={cat}
                    icon={config.icon}
                    label={config.label}
                    total={stat?.total || 0}
                    todayInserts={stat?.today_inserts ?? catHistory?.today ?? 0}
                    periodTotal={catHistory?.periodTotal ?? 0}
                    crescimento={stat?.crescimento_percentual || 0}
                    dataReferencia={dataReferencia}
                    online={isOnline}
                    history={catHistory?.points || []}
                    color={config.color}
                    size="large"
                    isLoading={isStatsLoading}
                  />
                );
              })}
            </div>
          </div>
          {/* ================ END GOLDEN RULE 5 (charts) ================ */}
        </div>
        </div>
      </main>

      {/* Atlas Chat */}
      <AtlasChat />

      {/* Modals */}
      <CompanyModal
        isOpen={companyModalOpen}
        onClose={() => setCompanyModalOpen(false)}
        onOpenCnaeModal={() => setCnaeModalOpen(true)}
        onOpenRegimeModal={() => setRegimeModalOpen(true)}
        onOpenListingModal={() => setEmpresasListingOpen(true)}
        userName={userName}
        selectedCnae={selectedCnae}
        selectedRegime={selectedRegime}
      />

      <CnaeModal
        isOpen={cnaeModalOpen}
        onClose={() => setCnaeModalOpen(false)}
        onSelect={handleCnaeSelect}
      />

      <RegimeModal
        isOpen={regimeModalOpen}
        onClose={() => setRegimeModalOpen(false)}
        onSelect={handleRegimeSelect}
      />

      <NewsModal
        isOpen={newsModalOpen}
        onClose={() => setNewsModalOpen(false)}
        onOpenListingModal={() => setNoticiasListingOpen(true)}
      />

      <EmpresasListingModal
        isOpen={empresasListingOpen}
        onClose={() => setEmpresasListingOpen(false)}
      />

      <PessoasListingModal
        isOpen={pessoasListingOpen}
        onClose={() => setPessoasListingOpen(false)}
      />

      <NoticiasListingModal
        isOpen={noticiasListingOpen}
        onClose={() => setNoticiasListingOpen(false)}
      />

      <PoliticosListingModal
        isOpen={politicosListingOpen}
        onClose={() => setPoliticosListingOpen(false)}
      />

      <MandatosListingModal
        isOpen={mandatosListingOpen}
        onClose={() => setMandatosListingOpen(false)}
      />

      <EmendasListingModal
        isOpen={emendasListingOpen}
        onClose={() => setEmendasListingOpen(false)}
      />
    </div>
  );
}

function DashboardNavLink({
  href,
  icon: Icon,
  title,
  active = false,
}: {
  href: string;
  icon: typeof Building2;
  title: string;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group flex items-start gap-3 rounded-xl border px-3 py-3 transition-all ${
        active
          ? 'border-cyan-400/40 bg-cyan-500/10 text-cyan-300'
          : 'border-slate-800 bg-slate-950/20 text-slate-300 hover:border-cyan-500/20 hover:bg-cyan-500/5 hover:text-white'
      }`}
    >
      <div className={`mt-0.5 rounded-lg p-2 ${active ? 'bg-cyan-500/15 text-cyan-300' : 'bg-slate-900/80 text-slate-500 group-hover:text-cyan-300'}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex items-center">
        <div className="text-sm font-semibold">{title}</div>
      </div>
    </Link>
  );
}

function NeoGlowCompactCard({
  icon: Icon,
  iconColor,
  title,
  badge,
  onClick,
}: {
  icon: typeof Building2;
  iconColor: 'red' | 'orange' | 'blue' | 'green' | 'cyan' | 'purple';
  title: string;
  badge?: string;
  onClick: () => void;
}) {
  const glowConfig = {
    red: {
      gradient: 'from-red-500/40 via-red-500/10 to-red-500/40',
      icon: 'bg-red-500/10 text-red-400',
    },
    orange: {
      gradient: 'from-orange-500/40 via-orange-500/10 to-orange-500/40',
      icon: 'bg-orange-500/10 text-orange-400',
    },
    blue: {
      gradient: 'from-blue-500/40 via-blue-500/10 to-blue-500/40',
      icon: 'bg-blue-500/10 text-blue-400',
    },
    green: {
      gradient: 'from-green-500/40 via-green-500/10 to-green-500/40',
      icon: 'bg-green-500/10 text-green-400',
    },
    cyan: {
      gradient: 'from-cyan-500/40 via-cyan-500/10 to-cyan-500/40',
      icon: 'bg-cyan-500/10 text-cyan-400',
    },
    purple: {
      gradient: 'from-purple-500/40 via-purple-500/10 to-purple-500/40',
      icon: 'bg-purple-500/10 text-purple-400',
    },
  };

  const glow = glowConfig[iconColor];

  return (
    <div onClick={onClick} className="relative group cursor-pointer min-w-0 flex-1 max-w-[160px] h-[80px]">
      {/* Neo Glow Layer */}
      <div
        className={`absolute -inset-[2px] rounded-lg bg-gradient-to-r ${glow.gradient} blur-sm opacity-50 group-hover:opacity-100 transition-opacity duration-500 animate-pulse`}
      />
      {/* Card */}
      <div className="relative bg-[#0f1629]/95 backdrop-blur-sm border border-white/10 rounded-lg p-3 h-full flex flex-col justify-center transition-all duration-300 group-hover:border-white/20 group-hover:-translate-y-0.5">
        <div className="flex items-center gap-2.5">
          <div
            className={`w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 ${glow.icon}`}
          >
            <Icon className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-semibold text-slate-300 truncate">{title}</h3>
              {badge && (
                <span className="flex-shrink-0 px-1.5 py-0.5 text-[8px] bg-green-500/10 border border-green-500/30 text-green-400 rounded">
                  {badge}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
