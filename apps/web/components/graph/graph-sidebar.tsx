'use client';

import { useMemo, useEffect, useState, type ReactNode } from 'react';
import Image from 'next/image';
import {
  X, Building2, MapPin, Briefcase, Users,
  Phone, Mail, Globe, Linkedin, Loader2, Receipt, BadgeCheck, CalendarDays,
  Layers,
} from 'lucide-react';
import { getGraphEntityId, type GraphNode } from './types';
import { ENTITY_COLORS } from './styles';
import {
  getGraphNodeDetails,
  type GraphNodeDetailsResponse,
  type Socio,
} from '@/lib/api';

interface Connection {
  id: string;
  label: string;
  type: string;
  relationship: string;
  strength?: number | null;
  evidence?: string | null;
}

interface GraphSidebarProps {
  node: GraphNode;
  connections: Connection[];
  onClose: () => void;
}

function formatCnpj(cnpj: string): string {
  const d = cnpj.replace(/\D/g, '').padStart(14, '0');
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
}

function formatCapital(value: number): string {
  if (value >= 1_000_000) return `R$ ${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `R$ ${(value / 1_000).toFixed(1)}K`;
  return `R$ ${value.toFixed(2)}`;
}

/** Returns true if value is non-null, non-undefined, non-empty string */
function has(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return true;
}

function formatRelationshipName(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatStrength(value?: number | null): string | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value <= 1) return `${Math.round(value * 100)}%`;
  return `${Math.round(value)}%`;
}

type TabKey = 'empresa' | 'fiscal';

export function GraphSidebar({ node, connections, onClose }: GraphSidebarProps) {
  const entityColor = ENTITY_COLORS[node.type] || '#6b7280';
  const isEmpresa = node.type === 'empresa';
  const entityId = getGraphEntityId(node);

  const [details, setDetails] = useState<GraphNodeDetailsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('empresa');

  useEffect(() => { setActiveTab('empresa'); }, [node.id]);

  useEffect(() => {
    if (!isEmpresa) {
      setDetails(null);
      setDetailsError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setDetailsError(null);

    getGraphNodeDetails(entityId)
      .then((data) => { if (!cancelled) setDetails(data); })
      .catch((err) => { if (!cancelled) setDetailsError(err instanceof Error ? err.message : 'Erro ao carregar detalhes'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });

    return () => { cancelled = true; };
  }, [entityId, isEmpresa]);

  const empresa = details?.empresa;
  const regime = details?.regime;
  const cnae = details?.cnae;
  const socios = details?.socios || [];

  const dataEntries = useMemo(() => {
    if (isEmpresa && details) return [];
    if (!node.data) return [];
    const exclude = new Set(['id', 'label', 'type', 'hop', 'entityId', 'index', 'vx', 'vy', 'fx', 'fy', 'x', 'y']);
    return Object.entries(node.data).filter(
      ([key, value]) => !exclude.has(key) && value !== undefined && value !== null
    );
  }, [node.data, isEmpresa, details]);

  const cnpj = empresa?.cnpj || (node.data?.cnpj as string | undefined);

  // Fiscal tab: only show sections that have real non-null data
  const hasRegime = has(regime?.regime_tributario);
  const hasRegimeFields = hasRegime || has(regime?.natureza_juridica) || has(regime?.porte) ||
    (regime?.capital_social != null && regime.capital_social > 0) || has(regime?.data_inicio);
  const hasSimples = regime?.simples_optante === true;
  const hasMei = regime?.mei_optante === true;
  const hasCnae = cnae != null || has(regime?.cnae_principal) || has(empresa?.cnae_principal);
  const hasAdditional = (regime?.qtd_funcionarios != null && regime.qtd_funcionarios > 0) ||
    has(regime?.setor) || has(regime?.descricao);

  return (
    <div className="flex w-80 flex-col border-l border-cyan-500/10 bg-[#0f1629] h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-cyan-500/10 px-3 py-2 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: entityColor }} />
          <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">{node.type}</span>
        </div>
        <button onClick={onClose} className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white flex-shrink-0">
          <X size={14} />
        </button>
      </div>

      {/* Node title */}
      <div className="border-b border-cyan-500/10 px-3 py-2 flex-shrink-0">
        <h3 className="text-sm font-semibold text-white truncate">{node.label}</h3>
        {cnpj && <p className="mt-0.5 text-[10px] text-cyan-400/70 font-mono">{formatCnpj(cnpj)}</p>}
        {!cnpj && <p className="mt-0.5 text-[10px] text-slate-500">ID: {entityId}</p>}

        {/* Relevance badge (deep search nodes) */}
        {(() => {
          const rel = typeof node.data?.relevance === 'number' ? node.data.relevance : null;
          const srcCount = typeof node.data?.sourceCount === 'number' ? node.data.sourceCount : 0;
          const sources = Array.isArray(node.data?.sources) ? (node.data.sources as string[]) : [];
          if (rel === null) return null;
          return (
            <>
              <div className="mt-1.5 flex items-center gap-2">
                <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                  rel >= 80 ? 'bg-green-500/20 text-green-400' : rel >= 50 ? 'bg-yellow-500/20 text-yellow-400' : 'bg-red-500/20 text-red-400'
                }`}>
                  {rel}% confianca
                </div>
                {srcCount > 0 && (
                  <span className="text-[9px] text-slate-500">{srcCount} fonte{srcCount > 1 ? 's' : ''}</span>
                )}
              </div>
              {sources.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {sources.map((src) => (
                    <span key={src} className="inline-block px-1.5 py-0.5 text-[8px] bg-slate-700/50 text-slate-400 rounded">
                      {src.replace(/^(dim_|fato_|vw_)/, '')}
                    </span>
                  ))}
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* Tabs */}
      {isEmpresa && !isLoading && empresa && (
        <div className="flex border-b border-cyan-500/10 flex-shrink-0">
          <button
            onClick={() => setActiveTab('empresa')}
            className={`flex-1 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
              activeTab === 'empresa'
                ? 'text-cyan-400 border-b-2 border-cyan-400 bg-cyan-500/5'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Building2 size={11} className="inline mr-1 -mt-0.5" />
            Empresa
          </button>
          <button
            onClick={() => setActiveTab('fiscal')}
            className={`flex-1 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
              activeTab === 'fiscal'
                ? 'text-cyan-400 border-b-2 border-cyan-400 bg-cyan-500/5'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Receipt size={11} className="inline mr-1 -mt-0.5" />
            Fiscal
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">

        {isEmpresa && isLoading && (
          <div className="flex items-center justify-center gap-2 px-3 py-6">
            <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
            <span className="text-[10px] text-slate-400">Carregando detalhes...</span>
          </div>
        )}

        {isEmpresa && detailsError && !isLoading && (
          <div className="px-3 py-2 text-[10px] text-red-400/80">{detailsError}</div>
        )}

        {/* ═══════════════ TAB: Empresa ═══════════════ */}
        {empresa && !isLoading && activeTab === 'empresa' && (
          <div className="flex flex-col">
            {/* Company Info */}
            <Section icon={<Building2 size={10} />} title="Dados">
              {has(empresa.razao_social) && <Field label="Razao Social" value={empresa.razao_social} />}
              {has(empresa.nome_fantasia) && <Field label="Fantasia" value={empresa.nome_fantasia!} />}
              {has(empresa.situacao_cadastral) && <Field label="Situacao" value={empresa.situacao_cadastral!} />}
              {has(empresa.porte) && <Field label="Porte" value={empresa.porte!} />}
              {empresa.capital_social != null && empresa.capital_social > 0 && (
                <Field label="Capital" value={formatCapital(empresa.capital_social)} />
              )}
              {has(empresa.data_abertura) && <Field label="Abertura" value={empresa.data_abertura!} />}
            </Section>

            {/* Location */}
            {(has(empresa.cidade) || has(empresa.estado) || has(empresa.logradouro)) && (
              <Section icon={<MapPin size={10} />} title="Localizacao">
                {has(empresa.logradouro) && (
                  <Field label="Endereco" value={[empresa.logradouro, empresa.numero, empresa.bairro].filter(Boolean).join(', ')} />
                )}
                {(has(empresa.cidade) || has(empresa.estado)) && (
                  <Field label="Cidade" value={[empresa.cidade, empresa.estado].filter(Boolean).join(' - ')} />
                )}
                {has(empresa.cep) && <Field label="CEP" value={empresa.cep!} />}
              </Section>
            )}

            {/* Socios with personal contacts */}
            {socios.length > 0 && (
              <Section icon={<Users size={10} />} title={`Socios (${socios.length})`}>
                <ul className="space-y-1.5">
                  {socios.map((socio: Socio, i: number) => (
                    <li key={`${socio.nome}-${i}`} className="rounded bg-slate-800/40 px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        {socio.foto_url ? (
                          <Image
                            src={socio.foto_url}
                            alt={socio.nome}
                            width={20}
                            height={20}
                            className="h-5 w-5 flex-shrink-0 rounded-full object-cover"
                            unoptimized
                          />
                        ) : (
                          <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-orange-500/20 text-[9px] font-bold text-orange-400">
                            {socio.nome.charAt(0)}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[10px] font-medium text-slate-200">{socio.nome}</p>
                          {(has(socio.qualificacao) || has(socio.cargo)) && (
                            <p className="truncate text-[9px] text-slate-500">{socio.qualificacao || socio.cargo}</p>
                          )}
                        </div>
                      </div>
                      {/* Personal contacts — only if they exist */}
                      {has(socio.email) && (
                        <a href={`mailto:${socio.email}`} className="mt-1 flex items-center gap-1.5 pl-[26px] text-[9px] text-cyan-400/70 hover:text-cyan-300 truncate">
                          <Mail size={9} className="flex-shrink-0" />
                          <span className="truncate">{socio.email}</span>
                        </a>
                      )}
                      {has(socio.linkedin) && (
                        <a href={socio.linkedin!} target="_blank" rel="noopener noreferrer" className="mt-0.5 flex items-center gap-1.5 pl-[26px] text-[9px] text-blue-400/70 hover:text-blue-300 truncate">
                          <Linkedin size={9} className="flex-shrink-0" />
                          <span className="truncate">LinkedIn</span>
                        </a>
                      )}
                      {has(socio.headline) && (
                        <p className="mt-0.5 pl-[26px] text-[9px] text-slate-500 truncate">{socio.headline}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Company Contacts */}
            {(has(empresa.telefone_1) || has(empresa.email) || has(empresa.website) || has(empresa.linkedin)) && (
              <Section icon={<Phone size={10} />} title="Contatos">
                {has(empresa.telefone_1) && <ContactRow icon={<Phone size={10} />} text={empresa.telefone_1!} />}
                {has(empresa.telefone_2) && <ContactRow icon={<Phone size={10} />} text={empresa.telefone_2!} />}
                {has(empresa.email) && <ContactRow icon={<Mail size={10} />} text={empresa.email!} />}
                {has(empresa.website) && (
                  <ContactLink icon={<Globe size={10} />} text={empresa.website!} href={empresa.website!.startsWith('http') ? empresa.website! : `https://${empresa.website}`} />
                )}
                {has(empresa.linkedin) && (
                  <ContactLink icon={<Linkedin size={10} />} text="LinkedIn" href={empresa.linkedin!.startsWith('http') ? empresa.linkedin! : `https://${empresa.linkedin}`} />
                )}
              </Section>
            )}
          </div>
        )}

        {/* ═══════════════ TAB: Fiscal ═══════════════ */}
        {empresa && !isLoading && activeTab === 'fiscal' && (
          <div className="flex flex-col">
            {/* Regime Tributario — only if any field has data */}
            {hasRegimeFields && (
              <Section icon={<Receipt size={10} />} title="Regime Tributario">
                {hasRegime && (
                  <div className="flex items-center gap-2 mb-1">
                    <span className="inline-flex items-center gap-1 rounded bg-cyan-500/10 border border-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-400">
                      <BadgeCheck size={10} />
                      {regime!.regime_tributario!.replace(/_/g, ' ')}
                    </span>
                  </div>
                )}
                {has(regime?.natureza_juridica) && <Field label="Natureza Juridica" value={regime!.natureza_juridica!} />}
                {has(regime?.porte) && <Field label="Porte" value={regime!.porte!} />}
                {regime?.capital_social != null && regime.capital_social > 0 && (
                  <Field label="Capital Social" value={formatCapital(regime.capital_social)} />
                )}
                {has(regime?.data_inicio) && <Field label="Inicio" value={regime!.data_inicio!} />}
                {has(regime?.data_fim) && <Field label="Fim" value={regime!.data_fim!} />}
              </Section>
            )}

            {/* Simples Nacional — only if optante === true */}
            {hasSimples && (
              <Section icon={<CalendarDays size={10} />} title="Simples Nacional">
                <div className="flex items-center gap-2 mb-1">
                  <span className="inline-flex items-center gap-1 rounded bg-green-500/10 border border-green-500/20 px-2 py-0.5 text-[10px] font-semibold text-green-400">
                    <BadgeCheck size={10} />
                    Optante
                  </span>
                </div>
                {has(regime?.simples_desde) && <Field label="Desde" value={regime!.simples_desde!} />}
              </Section>
            )}

            {/* MEI — only if optante === true */}
            {hasMei && (
              <Section icon={<CalendarDays size={10} />} title="MEI">
                <div className="flex items-center gap-2 mb-1">
                  <span className="inline-flex items-center gap-1 rounded bg-green-500/10 border border-green-500/20 px-2 py-0.5 text-[10px] font-semibold text-green-400">
                    <BadgeCheck size={10} />
                    Optante
                  </span>
                </div>
                {has(regime?.mei_desde) && <Field label="Desde" value={regime!.mei_desde!} />}
              </Section>
            )}

            {/* CNAE — only if there's cnae data */}
            {hasCnae && (
              <Section icon={<Layers size={10} />} title="CNAE">
                {cnae ? (
                  <>
                    <Field label="Codigo" value={cnae.codigo} />
                    <p className="text-[10px] text-slate-300 leading-snug mb-1">{cnae.descricao}</p>
                    {has(cnae.descricao_secao) && (
                      <Field label="Secao" value={`${cnae.secao || ''} - ${cnae.descricao_secao}`} />
                    )}
                    {has(cnae.descricao_divisao) && (
                      <Field label="Divisao" value={`${cnae.divisao || ''} - ${cnae.descricao_divisao}`} />
                    )}
                    {has(cnae.descricao_grupo) && (
                      <Field label="Grupo" value={`${cnae.grupo || ''} - ${cnae.descricao_grupo}`} />
                    )}
                    {has(cnae.descricao_classe) && (
                      <Field label="Classe" value={`${cnae.classe || ''} - ${cnae.descricao_classe}`} />
                    )}
                  </>
                ) : (
                  <>
                    <Field label="CNAE" value={regime?.cnae_principal || empresa.cnae_principal || ''} />
                    {has(regime?.cnae_descricao || empresa.cnae_descricao) && (
                      <p className="text-[10px] text-slate-300 leading-snug">{regime?.cnae_descricao || empresa.cnae_descricao}</p>
                    )}
                  </>
                )}
              </Section>
            )}

            {/* Additional Info — only if any field has data */}
            {hasAdditional && (
              <Section icon={<Briefcase size={10} />} title="Informacoes Adicionais">
                {regime!.qtd_funcionarios != null && regime!.qtd_funcionarios > 0 && (
                  <Field label="Funcionarios" value={String(regime!.qtd_funcionarios)} />
                )}
                {has(regime?.setor) && <Field label="Setor" value={regime!.setor!} />}
                {has(regime?.descricao) && (
                  <p className="text-[10px] text-slate-400 leading-snug">{regime!.descricao}</p>
                )}
              </Section>
            )}

            {/* If no fiscal data at all */}
            {!hasRegimeFields && !hasSimples && !hasMei && !hasCnae && !hasAdditional && (
              <div className="px-3 py-6 text-center">
                <p className="text-[10px] text-slate-500">Nenhum dado fiscal disponivel</p>
              </div>
            )}
          </div>
        )}

        {/* Generic data entries (non-empresa) */}
        {dataEntries.length > 0 && (
          <Section icon={null} title="Detalhes">
            {dataEntries.map(([key, value]) => (
              <Field key={key} label={key.replace(/_/g, ' ')} value={String(value)} />
            ))}
          </Section>
        )}

        {/* Connections — only on Empresa tab or non-empresa nodes */}
        {(!isEmpresa || activeTab === 'empresa') && connections.length > 0 && (
          <div className="px-3 py-2">
            <h4 className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Conexoes ({connections.length})
            </h4>
            <ul className="space-y-0.5">
              {connections.map((conn) => (
                <li
                  key={conn.id}
                  className="rounded px-1.5 py-1.5 text-[10px] transition-colors hover:bg-cyan-500/5"
                >
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: ENTITY_COLORS[conn.type] || '#6b7280' }} />
                    <span className="min-w-0 flex-1 truncate text-slate-300">{conn.label}</span>
                    <span className="flex-shrink-0 text-slate-600">{formatRelationshipName(conn.relationship)}</span>
                  </div>
                  {(conn.strength != null || conn.evidence) && (
                    <div className="mt-1 flex items-center justify-between gap-2 pl-3">
                      <span className="truncate text-[9px] text-slate-500">
                        {conn.evidence || 'Relação do ecossistema'}
                      </span>
                      {formatStrength(conn.strength) && (
                        <span className="flex-shrink-0 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-medium text-cyan-300">
                          {formatStrength(conn.strength)}
                        </span>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Compact sub-components ── */

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="border-b border-cyan-500/10 px-3 py-2">
      <h4 className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        {icon}
        {title}
      </h4>
      <dl className="space-y-0.5">{children}</dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="flex-shrink-0 text-[10px] text-slate-500 whitespace-nowrap">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[10px] text-slate-300">{value}</dd>
    </div>
  );
}

function ContactRow({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-slate-300">
      <span className="flex-shrink-0 text-slate-500">{icon}</span>
      <span className="truncate">{text}</span>
    </div>
  );
}

function ContactLink({ icon, text, href }: { icon: ReactNode; text: string; href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-[10px] text-cyan-400 hover:text-cyan-300">
      <span className="flex-shrink-0">{icon}</span>
      <span className="truncate">{text}</span>
    </a>
  );
}
