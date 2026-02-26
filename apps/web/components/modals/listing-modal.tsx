'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Loader2, ExternalLink, ArrowUp, ArrowDown, ChevronRight, ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  listCompanies,
  listPeople,
  listNews,
  listPoliticians,
  searchPoliticians,
  getPoliticianDetails,
  formatRegime,
  type Company,
  type Person,
  type NewsItem,
  type Politician,
  type PoliticianMandate,
} from '@/lib/api';
import { normalizePoliticianName, ibgeToUF } from '@/lib/politicians-utils';

type SortDirection = 'asc' | 'desc';

// ============================================
// EMPRESAS LISTING MODAL
// ============================================

interface EmpresasListingModalProps {
  isOpen: boolean;
  onClose: () => void;
  filters?: {
    nome?: string;
    cidade?: string;
    segmento?: string;
    regime?: string;
  };
}

export function EmpresasListingModal({ isOpen, onClose, filters }: EmpresasListingModalProps) {
  const [search, setSearch] = useState('');
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const query = useQuery({
    queryKey: ['empresas', 'listing', filters],
    queryFn: () =>
      listCompanies({
        nome: filters?.nome,
        cidade: filters?.cidade,
        segmento: filters?.segmento,
        regime: filters?.regime,
        limit: 500,
      }),
    enabled: isOpen,
    retry: 1,
    staleTime: 30_000,
  });

  const filteredData = useMemo(() => {
    let data = query.data?.empresas || [];

    if (search) {
      const searchLower = search.toLowerCase();
      data = data.filter(
        (e) =>
          (e.razao_social || '').toLowerCase().includes(searchLower) ||
          (e.nome_fantasia || '').toLowerCase().includes(searchLower) ||
          (e.cidade || '').toLowerCase().includes(searchLower) ||
          (e.cnae_descricao || '').toLowerCase().includes(searchLower) ||
          (e.regime_tributario || '').toLowerCase().includes(searchLower)
      );
    }

    if (sortColumn) {
      data = [...data].sort((a, b) => {
        const valA = String(
          (a as unknown as Record<string, unknown>)[sortColumn] ?? ''
        ).toLowerCase();
        const valB = String(
          (b as unknown as Record<string, unknown>)[sortColumn] ?? ''
        ).toLowerCase();
        return sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      });
    }

    return data;
  }, [query.data?.empresas, search, sortColumn, sortDirection]);

  function handleSort(column: string) {
    if (sortColumn === column) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  }

  const filterInfo = useMemo(() => {
    const parts: string[] = [];
    if (filters?.nome) parts.push(`Nome: "${filters.nome}"`);
    if (filters?.cidade) parts.push(`Cidade: "${filters.cidade}"`);
    if (filters?.segmento) parts.push(`Segmento: "${filters.segmento}"`);
    if (filters?.regime) parts.push(`Regime: "${filters.regime}"`);
    return parts.length > 0 ? `Filtros: ${parts.join(', ')}` : '';
  }, [filters]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/85">
      <div className="w-[95%] max-w-6xl max-h-[90vh] overflow-hidden rounded-2xl border border-cyan-500/15 bg-gradient-to-b from-[#0f1629] to-[#0a0e1a] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <h2 className="text-lg font-semibold text-white flex items-center gap-3">
            <span className="w-1 h-5 bg-gradient-to-b from-cyan-400 to-blue-500 rounded" />
            Empresas
            <span className="bg-cyan-500/15 text-cyan-400 px-2.5 py-1 rounded text-sm">
              {filteredData.length}
            </span>
          </h2>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4 px-6 py-3 border-b border-white/5">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrar resultados..."
            className="max-w-xs"
          />
          {filterInfo && <span className="text-xs text-slate-500">{filterInfo}</span>}
        </div>

        {/* Table */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {query.isLoading ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Loader2 className="h-10 w-10 animate-spin text-cyan-400 mb-4" />
              <span>Carregando empresas...</span>
            </div>
          ) : query.isError ? (
            <div className="text-center py-12 text-red-400">
              Erro ao carregar empresas. Tente novamente mais tarde.
            </div>
          ) : filteredData.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              Nenhuma empresa encontrada com os filtros aplicados.
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-cyan-500/5">
                  <SortableHeader
                    label="Razao Social"
                    column="razao_social"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="Nome Fantasia"
                    column="nome_fantasia"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="Cidade"
                    column="cidade"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="UF"
                    column="estado"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="Segmento"
                    column="cnae_descricao"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="Regime"
                    column="regime_tributario"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                  />
                  <th className="text-left p-3 text-cyan-400 font-semibold text-xs uppercase">
                    LinkedIn
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredData.map((e) => (
                  <EmpresaRow key={e.id} empresa={e} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function EmpresaRow({ empresa }: { empresa: Company }) {
  const hasLinkedin =
    empresa.linkedin && empresa.linkedin !== 'NAO_POSSUI' && empresa.linkedin !== 'inexistente';

  return (
    <tr className="border-b border-white/5 hover:bg-cyan-500/5 transition-colors">
      <td className="p-3 text-slate-300">{empresa.razao_social || '-'}</td>
      <td className="p-3 text-slate-300">{empresa.nome_fantasia || '-'}</td>
      <td className="p-3 text-slate-300">{empresa.cidade || '-'}</td>
      <td className="p-3 text-slate-300">{empresa.estado || '-'}</td>
      <td className="p-3 text-slate-300">{empresa.cnae_descricao || '-'}</td>
      <td className="p-3">
        <RegimeBadge regime={empresa.regime_tributario} />
      </td>
      <td className="p-3">
        {hasLinkedin ? (
          <a
            href={empresa.linkedin}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-400 hover:underline inline-flex items-center gap-1"
          >
            Ver <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-slate-500">-</span>
        )}
      </td>
    </tr>
  );
}

// ============================================
// PESSOAS LISTING MODAL
// ============================================

interface PessoasListingModalProps {
  isOpen: boolean;
  onClose: () => void;
  filters?: {
    nome?: string;
    cidade?: string;
  };
}

export function PessoasListingModal({ isOpen, onClose, filters }: PessoasListingModalProps) {
  const [search, setSearch] = useState('');
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const query = useQuery({
    queryKey: ['pessoas', 'listing', filters],
    queryFn: () =>
      listPeople({
        nome: filters?.nome,
        cidade: filters?.cidade,
        limit: 500,
      }),
    enabled: isOpen,
    retry: 1,
    staleTime: 30_000,
  });

  const filteredData = useMemo(() => {
    let data = query.data?.people || [];

    if (search) {
      const searchLower = search.toLowerCase();
      data = data.filter(
        (p) =>
          (p.nome_completo || p.nome || '').toLowerCase().includes(searchLower) ||
          (p.email || '').toLowerCase().includes(searchLower) ||
          (p.pais || '').toLowerCase().includes(searchLower)
      );
    }

    if (sortColumn) {
      data = [...data].sort((a, b) => {
        const valA = ((a as unknown as Record<string, unknown>)[sortColumn] || '')
          .toString()
          .toLowerCase();
        const valB = ((b as unknown as Record<string, unknown>)[sortColumn] || '')
          .toString()
          .toLowerCase();
        return sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      });
    }

    return data;
  }, [query.data?.people, search, sortColumn, sortDirection]);

  function handleSort(column: string) {
    if (sortColumn === column) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/85">
      <div className="w-[95%] max-w-5xl max-h-[90vh] overflow-hidden rounded-2xl border border-orange-500/15 bg-gradient-to-b from-[#0f1629] to-[#0a0e1a] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <h2 className="text-lg font-semibold text-white flex items-center gap-3">
            <span className="w-1 h-5 bg-gradient-to-b from-orange-400 to-orange-600 rounded" />
            Pessoas
            <span className="bg-orange-500/15 text-orange-400 px-2.5 py-1 rounded text-sm">
              {filteredData.length}
            </span>
          </h2>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4 px-6 py-3 border-b border-white/5">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrar resultados..."
            className="max-w-xs"
          />
        </div>

        {/* Table */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {query.isLoading ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Loader2 className="h-10 w-10 animate-spin text-orange-400 mb-4" />
              <span>Carregando pessoas...</span>
            </div>
          ) : query.isError ? (
            <div className="text-center py-12 text-red-400">
              Erro ao carregar pessoas. Tente novamente mais tarde.
            </div>
          ) : filteredData.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              Nenhuma pessoa encontrada com os filtros aplicados.
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-orange-500/5">
                  <SortableHeader
                    label="Nome"
                    column="nome_completo"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                    color="orange"
                  />
                  <SortableHeader
                    label="Email"
                    column="email"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                    color="orange"
                  />
                  <SortableHeader
                    label="Pais"
                    column="pais"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                    color="orange"
                  />
                  <SortableHeader
                    label="Faixa Etaria"
                    column="faixa_etaria"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                    color="orange"
                  />
                  <th className="text-left p-3 text-orange-400 font-semibold text-xs uppercase">
                    LinkedIn
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredData.map((p) => (
                  <PessoaRow key={p.id} pessoa={p} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function PessoaRow({ pessoa }: { pessoa: Person }) {
  const hasLinkedin = pessoa.linkedin_url && pessoa.linkedin_url !== 'inexistente';

  return (
    <tr className="border-b border-white/5 hover:bg-orange-500/5 transition-colors">
      <td className="p-3 text-slate-300">{pessoa.nome_completo || pessoa.nome || '-'}</td>
      <td className="p-3 text-slate-300">{pessoa.email || '-'}</td>
      <td className="p-3 text-slate-300">{pessoa.pais || '-'}</td>
      <td className="p-3 text-slate-300">{pessoa.faixa_etaria || '-'}</td>
      <td className="p-3">
        {hasLinkedin ? (
          <a
            href={pessoa.linkedin_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-400 hover:underline inline-flex items-center gap-1"
          >
            Ver <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-slate-500">-</span>
        )}
      </td>
    </tr>
  );
}

// ============================================
// NOTICIAS LISTING MODAL
// ============================================

interface NoticiasListingModalProps {
  isOpen: boolean;
  onClose: () => void;
  filters?: {
    q?: string;
    data_inicio?: string;
    data_fim?: string;
    idioma?: string;
    pais?: string;
    fonte?: string;
    tipo?: string;
  };
}

export function NoticiasListingModal({ isOpen, onClose, filters }: NoticiasListingModalProps) {
  const [search, setSearch] = useState('');
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const query = useQuery({
    queryKey: ['noticias', 'listing', filters],
    queryFn: () =>
      listNews({
        q: filters?.q,
        data_inicio: filters?.data_inicio,
        data_fim: filters?.data_fim,
        idioma: filters?.idioma,
        pais: filters?.pais,
        fonte: filters?.fonte,
        tipo: filters?.tipo,
        limit: 500,
      }),
    enabled: isOpen,
    retry: 1,
    staleTime: 30_000,
  });

  const filteredData = useMemo(() => {
    let data = query.data?.news || [];

    if (search) {
      const searchLower = search.toLowerCase();
      data = data.filter(
        (n) =>
          (n.titulo || '').toLowerCase().includes(searchLower) ||
          (n.fonte_nome || '').toLowerCase().includes(searchLower) ||
          (n.tipo || '').toLowerCase().includes(searchLower)
      );
    }

    if (sortColumn) {
      data = [...data].sort((a, b) => {
        const valA = ((a as unknown as Record<string, unknown>)[sortColumn] || '')
          .toString()
          .toLowerCase();
        const valB = ((b as unknown as Record<string, unknown>)[sortColumn] || '')
          .toString()
          .toLowerCase();
        return sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      });
    }

    return data;
  }, [query.data?.news, search, sortColumn, sortDirection]);

  function handleSort(column: string) {
    if (sortColumn === column) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/85">
      <div className="w-[95%] max-w-6xl max-h-[90vh] overflow-hidden rounded-2xl border border-green-500/15 bg-gradient-to-b from-[#0f1629] to-[#0a0e1a] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <h2 className="text-lg font-semibold text-white flex items-center gap-3">
            <span className="w-1 h-5 bg-gradient-to-b from-green-400 to-green-600 rounded" />
            Noticias
            <span className="bg-green-500/15 text-green-400 px-2.5 py-1 rounded text-sm">
              {filteredData.length}
            </span>
          </h2>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4 px-6 py-3 border-b border-white/5">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrar resultados..."
            className="max-w-xs"
          />
        </div>

        {/* Table */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {query.isLoading ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Loader2 className="h-10 w-10 animate-spin text-green-400 mb-4" />
              <span>Carregando noticias...</span>
            </div>
          ) : query.isError ? (
            <div className="text-center py-12 text-red-400">
              Erro ao carregar noticias. Tente novamente mais tarde.
            </div>
          ) : filteredData.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              Nenhuma noticia encontrada com os filtros aplicados.
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-green-500/5">
                  <SortableHeader
                    label="Titulo"
                    column="titulo"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                    color="green"
                  />
                  <SortableHeader
                    label="Fonte"
                    column="fonte_nome"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                    color="green"
                  />
                  <SortableHeader
                    label="Data"
                    column="data_publicacao"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                    color="green"
                  />
                  <SortableHeader
                    label="Tipo"
                    column="tipo"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                    color="green"
                  />
                  <th className="text-left p-3 text-green-400 font-semibold text-xs uppercase">
                    Link
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredData.map((n) => (
                  <NoticiaRow key={n.id} noticia={n} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function NoticiaRow({ noticia }: { noticia: NewsItem }) {
  const data = noticia.data_publicacao
    ? new Date(noticia.data_publicacao).toLocaleDateString('pt-BR')
    : '-';

  return (
    <tr className="border-b border-white/5 hover:bg-green-500/5 transition-colors">
      <td className="p-3 text-slate-300 max-w-xs truncate">{noticia.titulo || '-'}</td>
      <td className="p-3 text-slate-300">{noticia.fonte_nome || '-'}</td>
      <td className="p-3 text-slate-300">{data}</td>
      <td className="p-3 text-slate-300">{noticia.tipo || '-'}</td>
      <td className="p-3">
        {noticia.url ? (
          <a
            href={noticia.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-400 hover:underline inline-flex items-center gap-1"
          >
            Abrir <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-slate-500">-</span>
        )}
      </td>
    </tr>
  );
}

// ============================================
// POLITICOS LISTING MODAL
// ============================================

interface PoliticosListingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PoliticosListingModal({ isOpen, onClose }: PoliticosListingModalProps) {
  const [nome, setNome] = useState('');
  const [partido, setPartido] = useState('');
  const [searchKey, setSearchKey] = useState('|');
  const [sortColumn, setSortColumn] = useState<string>('nome_completo');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const query = useQuery({
    queryKey: ['politicos', 'search', searchKey],
    queryFn: async () => {
      const [searchNome, searchPartido] = searchKey.split('|');

      if (searchNome && searchNome.length >= 2) {
        const result = await searchPoliticians(searchNome);
        if (searchPartido) {
          return {
            ...result,
            politicians: result.politicians.filter(
              (p) => (p.partido_sigla || '').toUpperCase() === searchPartido
            ),
          };
        }
        return result;
      }

      if (searchPartido) {
        return listPoliticians({ partido: searchPartido, limit: 100 });
      }

      return listPoliticians({ limit: 50 });
    },
    enabled: isOpen,
  });

  function handleSearch() {
    setSearchKey(`${nome.trim()}|${partido.trim().toUpperCase()}`);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      handleSearch();
    }
  }

  const sortedData = useMemo(() => {
    const data = [...(query.data?.politicians || [])];

    data.sort((a, b) => {
      const col = sortColumn || 'nome_completo';

      // Virtual column: sort by derived UF
      if (col === 'estado') {
        const valA = ibgeToUF(a.codigo_ibge).toLowerCase();
        const valB = ibgeToUF(b.codigo_ibge).toLowerCase();
        return sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }

      const valA = String(
        (a as unknown as Record<string, unknown>)[col] ?? ''
      ).toLowerCase();
      const valB = String(
        (b as unknown as Record<string, unknown>)[col] ?? ''
      ).toLowerCase();
      return sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    });

    return data;
  }, [query.data?.politicians, sortColumn, sortDirection]);

  function handleSort(column: string) {
    if (sortColumn === column) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/85">
      <div className="w-[95%] max-w-6xl max-h-[90vh] overflow-hidden rounded-2xl border border-blue-500/15 bg-gradient-to-b from-[#0f1629] to-[#0a0e1a] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <h2 className="text-lg font-semibold text-white flex items-center gap-3">
            <span className="w-1 h-5 bg-gradient-to-b from-blue-400 to-blue-600 rounded" />
            Politicos
            {!query.isLoading && (
              <span className="bg-blue-500/15 text-blue-400 px-2.5 py-1 rounded text-sm">
                {sortedData.length}
              </span>
            )}
          </h2>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search Fields */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-white/5">
          <Input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Nome do politico..."
            className="max-w-xs"
          />
          <Input
            value={partido}
            onChange={(e) => setPartido(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Partido (ex: PT, PL, MDB)"
            className="max-w-[180px]"
          />
          <button
            onClick={handleSearch}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors whitespace-nowrap"
          >
            Buscar
          </button>
        </div>

        {/* Table */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {query.isLoading ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Loader2 className="h-10 w-10 animate-spin text-blue-400 mb-4" />
              <span>Buscando politicos...</span>
            </div>
          ) : query.isError ? (
            <div className="text-center py-12 text-red-400">
              Erro ao buscar politicos. Verifique se o Brasil Data Hub esta configurado.
            </div>
          ) : sortedData.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              Nenhum politico encontrado. Tente outro nome ou partido.
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-blue-500/5">
                  <th className="w-8 p-3" />
                  <SortableHeader
                    label="Nome"
                    column="nome_completo"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                    color="blue"
                  />
                  <SortableHeader
                    label="Nome Urna"
                    column="nome_urna"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                    color="blue"
                  />
                  <SortableHeader
                    label="UF"
                    column="estado"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                    color="blue"
                  />
                  <SortableHeader
                    label="Municipio"
                    column="municipio"
                    currentColumn={sortColumn}
                    direction={sortDirection}
                    onSort={handleSort}
                    color="blue"
                  />
                </tr>
              </thead>
              <tbody>
                {sortedData.map((p) => (
                  <PoliticoRow key={p.id} politico={p} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function PoliticoRow({ politico }: { politico: Politician }) {
  const [expanded, setExpanded] = useState(false);

  const mandatesQuery = useQuery({
    queryKey: ['politico', 'details', politico.id],
    queryFn: () => getPoliticianDetails(politico.id),
    enabled: expanded,
    staleTime: 5 * 60 * 1000,
  });

  const uf = ibgeToUF(politico.codigo_ibge);

  return (
    <>
      <tr
        onClick={() => setExpanded((v) => !v)}
        className="border-b border-white/5 hover:bg-blue-500/5 transition-colors cursor-pointer"
      >
        <td className="p-3 w-8 text-slate-500">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-blue-400" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </td>
        <td className="p-3 text-slate-300">{normalizePoliticianName(politico.nome_completo) || '-'}</td>
        <td className="p-3 text-slate-300">{normalizePoliticianName(politico.nome_urna) || '-'}</td>
        <td className="p-3 text-slate-300">{uf || '-'}</td>
        <td className="p-3 text-slate-300">{normalizePoliticianName(politico.municipio) || '-'}</td>
      </tr>

      {expanded && (
        <tr className="border-b border-white/5">
          <td colSpan={5} className="p-0">
            <div className="bg-blue-500/5 px-8 py-3">
              {mandatesQuery.isLoading ? (
                <div className="flex items-center gap-2 py-2 text-slate-400 text-xs">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Carregando mandatos...
                </div>
              ) : mandatesQuery.isError ? (
                <div className="py-2 text-red-400 text-xs">
                  Erro ao carregar mandatos.
                </div>
              ) : (mandatesQuery.data?.mandatos || []).length === 0 ? (
                <div className="py-2 text-slate-500 text-xs">
                  Nenhum mandato encontrado.
                </div>
              ) : (
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="text-left py-1.5 px-2 font-medium uppercase">Cargo</th>
                      <th className="text-left py-1.5 px-2 font-medium uppercase">Ano</th>
                      <th className="text-left py-1.5 px-2 font-medium uppercase">Partido</th>
                      <th className="text-left py-1.5 px-2 font-medium uppercase">Eleito</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(mandatesQuery.data?.mandatos || []).map((m: PoliticianMandate) => (
                      <tr key={m.id} className="border-t border-white/5">
                        <td className="py-1.5 px-2 text-slate-300">
                          {normalizePoliticianName(m.cargo) || '-'}
                        </td>
                        <td className="py-1.5 px-2 text-slate-300 font-variant-numeric tabular-nums">
                          {m.ano_eleicao || '-'}
                        </td>
                        <td className="py-1.5 px-2">
                          {m.partido_sigla ? (
                            <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-500/15 text-blue-400">
                              {m.partido_sigla}
                            </span>
                          ) : (
                            <span className="text-slate-500">-</span>
                          )}
                        </td>
                        <td className="py-1.5 px-2">
                          {m.eleito === true ? (
                            <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-500/15 text-green-400">
                              Eleito
                            </span>
                          ) : m.eleito === false ? (
                            <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/15 text-red-400">
                              Nao eleito
                            </span>
                          ) : (
                            <span className="text-slate-500">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ============================================
// SHARED COMPONENTS
// ============================================

function SortableHeader({
  label,
  column,
  currentColumn,
  direction,
  onSort,
  color = 'cyan',
}: {
  label: string;
  column: string;
  currentColumn: string | null;
  direction: SortDirection;
  onSort: (column: string) => void;
  color?: 'cyan' | 'orange' | 'green' | 'blue';
}) {
  const isActive = currentColumn === column;
  const colorMap: Record<string, string> = {
    cyan: 'text-cyan-400',
    orange: 'text-orange-400',
    green: 'text-green-400',
    blue: 'text-blue-400',
  };
  const colorClass = colorMap[color] || 'text-cyan-400';

  return (
    <th
      onClick={() => onSort(column)}
      className={`text-left p-3 font-semibold text-xs uppercase cursor-pointer select-none hover:bg-white/5 transition-colors ${colorClass}`}
    >
      <div className="flex items-center gap-1">
        {label}
        {isActive ? (
          direction === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <span className="opacity-40">↕</span>
        )}
      </div>
    </th>
  );
}

function RegimeBadge({ regime }: { regime: string | undefined }) {
  if (!regime) return <span className="text-slate-500">-</span>;

  const colorMap: Record<string, string> = {
    MEI: 'bg-green-500/15 text-green-400',
    SIMPLES_NACIONAL: 'bg-blue-500/15 text-blue-400',
    LUCRO_PRESUMIDO: 'bg-yellow-500/15 text-yellow-400',
    LUCRO_REAL: 'bg-red-500/15 text-red-400',
    DESCONHECIDO: 'bg-slate-500/15 text-slate-400',
  };

  const colorClass = colorMap[regime] || 'bg-slate-500/15 text-slate-400';

  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colorClass}`}>
      {formatRegime(regime)}
    </span>
  );
}
