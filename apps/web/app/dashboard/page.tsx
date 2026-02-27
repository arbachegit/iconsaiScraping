'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Users,
  Flag,
  Newspaper,
  LogOut,
  Shield,
  Vote,
  CircleDollarSign,
} from 'lucide-react';
import { getUser, getHealth, getStatsCurrent, getStatsHistory, createStatsSnapshot, type StatItem, type CategoryHistory } from '@/lib/api';
import { isAuthenticated, clearTokens } from '@/lib/auth';
import { AtlasChat } from '@/components/atlas/atlas-chat';
import { CompanyModal } from '@/components/modals/company-modal';
import { CnaeModal } from '@/components/modals/cnae-modal';
import { RegimeModal } from '@/components/modals/regime-modal';
import { PeopleModal } from '@/components/modals/people-modal';
import { NewsModal } from '@/components/modals/news-modal';
import {
  EmpresasListingModal,
  PessoasListingModal,
  NoticiasListingModal,
  PoliticosListingModal,
} from '@/components/modals/listing-modal';
import { StatsBadgeCard, StatsCounterLine } from '@/components/stats/stats-badge-card';

const STATS_REFRESH_INTERVAL = 60000; // 1 minute
const COUNTDOWN_MAX = 60; // 1 minute in seconds

const categoryConfig = {
  empresas: { icon: Building2, color: 'red' as const, label: 'Empresas' },
  pessoas: { icon: Users, color: 'orange' as const, label: 'Pessoas' },
  politicos: { icon: Flag, color: 'blue' as const, label: 'Politicos' },
  mandatos: { icon: Vote, color: 'yellow' as const, label: 'Mandatos' },
  emendas: { icon: CircleDollarSign, color: 'purple' as const, label: 'Emendas' },
  noticias: { icon: Newspaper, color: 'green' as const, label: 'Noticias' },
};

type CategoryKey = keyof typeof categoryConfig;

export default function DashboardPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [userName, setUserName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [version, setVersion] = useState('v1.14.2026');
  const [countdown, setCountdown] = useState(COUNTDOWN_MAX);

  // Modal states
  const [companyModalOpen, setCompanyModalOpen] = useState(false);
  const [cnaeModalOpen, setCnaeModalOpen] = useState(false);
  const [regimeModalOpen, setRegimeModalOpen] = useState(false);
  const [peopleModalOpen, setPeopleModalOpen] = useState(false);
  const [newsModalOpen, setNewsModalOpen] = useState(false);
  const [empresasListingOpen, setEmpresasListingOpen] = useState(false);
  const [pessoasListingOpen, setPessoasListingOpen] = useState(false);
  const [noticiasListingOpen, setNoticiasListingOpen] = useState(false);
  const [politicosListingOpen, setPoliticosListingOpen] = useState(false);

  // Selected values from picker modals
  const [selectedCnae, setSelectedCnae] = useState<string>('');
  const [selectedRegime, setSelectedRegime] = useState<string>('');

  // Auth check
  useEffect(() => {
    if (!isAuthenticated()) {
      router.push('/');
      return;
    }
  }, [router]);

  // Load user info
  const userQuery = useQuery({
    queryKey: ['user'],
    queryFn: getUser,
    retry: false,
  });

  useEffect(() => {
    if (userQuery.data) {
      setUserName(userQuery.data.name || userQuery.data.email);
      setIsAdmin(userQuery.data.is_admin);
      // Redirect to profile completion if not complete (skip for admins)
      if (userQuery.data.profile_complete === false && !userQuery.data.is_admin) {
        router.push('/profile/complete');
        return;
      }
    }
    if (userQuery.isError) {
      handleLogout();
    }
  }, [userQuery.data, userQuery.isError]);

  // Load version
  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
  });

  useEffect(() => {
    if (healthQuery.data?.version) {
      setVersion('v' + healthQuery.data.version);
    }
  }, [healthQuery.data]);

  // Load stats
  const statsQuery = useQuery({
    queryKey: ['stats-current'],
    queryFn: async () => {
      // Create snapshot on each refresh to keep history updated
      await createStatsSnapshot().catch(() => {});
      return getStatsCurrent();
    },
    refetchInterval: STATS_REFRESH_INTERVAL,
  });

  // Load history (limit=365 to get all available data)
  const historyQuery = useQuery({
    queryKey: ['stats-history'],
    queryFn: () => getStatsHistory(365),
    refetchInterval: STATS_REFRESH_INTERVAL,
  });

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          return COUNTDOWN_MAX;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Reset countdown when stats refresh
  useEffect(() => {
    if (statsQuery.dataUpdatedAt) {
      setCountdown(COUNTDOWN_MAX);
    }
  }, [statsQuery.dataUpdatedAt]);

  function handleLogout() {
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
    // Stub: opens Atlas chat with emendas prompt
    const atlasBtn = document.querySelector('[data-atlas-toggle]') as HTMLButtonElement;
    if (atlasBtn) atlasBtn.click();
  }

  // Build stats data
  const statsMap = new Map<string, StatItem>();
  for (const stat of statsQuery.data?.stats || []) {
    statsMap.set(stat.categoria, stat);
  }

  const historyMap: Record<string, CategoryHistory> = historyQuery.data?.historico || {};
  const dataReferencia = statsQuery.data?.data_referencia || new Date().toISOString();
  const isOnline = statsQuery.data?.online ?? false;
  const isStatsLoading = statsQuery.isFetching || historyQuery.isFetching;

  // Callback when pie chart completes a cycle
  const handleRefreshComplete = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['stats-current'] });
    queryClient.invalidateQueries({ queryKey: ['stats-history'] });
  }, [queryClient]);

  // Counter line data
  const counterStats = Object.keys(categoryConfig).map((key) => {
    const cat = key as CategoryKey;
    return {
      label: categoryConfig[cat].label,
      value: statsMap.get(cat)?.total || 0,
      color: categoryConfig[cat].color,
    };
  });

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
            {isAdmin && (
              <a
                href="/admin"
                className="inline-flex items-center gap-1.5 h-9 px-3 bg-cyan-500/15 border border-cyan-500/50 text-cyan-400 rounded-lg text-xs font-semibold hover:bg-cyan-500 hover:text-white transition-colors"
              >
                <Shield className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Admin</span>
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

      {/* Stats Counter Line - Landing Page Style */}
      <div className="flex-shrink-0">
        <StatsCounterLine
          stats={counterStats}
          countdown={countdown}
          maxCountdown={COUNTDOWN_MAX}
          onRefreshComplete={handleRefreshComplete}
        />
      </div>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto px-4 lg:px-6 py-4">
        <div className="max-w-6xl mx-auto">
          {/* Compact Action Cards — 5 horizontal */}
          <div className="flex flex-nowrap gap-3 mb-5 overflow-x-auto">
            <CompactActionCard icon={Building2} label="Empresas" color="red" onClick={() => setCompanyModalOpen(true)} />
            <CompactActionCard icon={Users} label="Pessoas" color="orange" onClick={() => setPeopleModalOpen(true)} />
            <CompactActionCard icon={Flag} label="Politicos" color="blue" onClick={openPoliticosFromCard} />
            <CompactActionCard icon={CircleDollarSign} label="Emendas" color="purple" onClick={openEmendasFromCard} />
            <CompactActionCard icon={Newspaper} label="Noticias" color="green" onClick={() => setNewsModalOpen(true)} />
          </div>

          {/* Stats Badges */}
          <div className="mb-6">
            <h2 className="text-[25px] font-semibold text-slate-400 mb-3">Estatisticas em Tempo Real</h2>

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
                    countdown={countdown}
                    maxCountdown={COUNTDOWN_MAX}
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
                    countdown={countdown}
                    maxCountdown={COUNTDOWN_MAX}
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
                    countdown={countdown}
                    maxCountdown={COUNTDOWN_MAX}
                    size="large"
                    isLoading={isStatsLoading}
                  />
                );
              })}
            </div>
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

      <PeopleModal
        isOpen={peopleModalOpen}
        onClose={() => setPeopleModalOpen(false)}
        onOpenListingModal={() => setPessoasListingOpen(true)}
        userName={userName}
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
    </div>
  );
}

function CompactActionCard({
  icon: Icon,
  label,
  color,
  onClick,
}: {
  icon: typeof Building2;
  label: string;
  color: 'red' | 'orange' | 'blue' | 'green' | 'purple' | 'yellow';
  onClick: () => void;
}) {
  const colorMap: Record<string, { bg: string; text: string; border: string }> = {
    red: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
    orange: { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/30' },
    blue: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
    green: { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/30' },
    purple: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/30' },
    yellow: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', border: 'border-yellow-500/30' },
  };

  const c = colorMap[color];

  return (
    <button
      onClick={onClick}
      className={`flex-shrink-0 flex items-center gap-2 h-[60px] px-4 rounded-xl border ${c.border} ${c.bg} cursor-pointer transition-all duration-200 hover:scale-[1.03] hover:shadow-md`}
    >
      <Icon className={`w-5 h-5 flex-shrink-0 ${c.text}`} />
      <span className={`text-sm font-semibold whitespace-nowrap ${c.text}`}>{label}</span>
    </button>
  );
}
