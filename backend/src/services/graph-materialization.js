import { supabase } from '../database/supabase.js';
import { enrichRelationshipsAfterApproval } from './graph-pipeline.js';
import logger from '../utils/logger.js';

function normalizeCompanyName(empresa) {
  return empresa?.nome_fantasia || empresa?.razao_social || null;
}

function dedupeSocios(socios) {
  const seen = new Set();
  return socios.filter((socio) => {
    const key = String(socio.id || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getCompanyGraphContext(empresaId) {
  const { data: empresa, error: empresaError } = await supabase
    .from('dim_empresas')
    .select('id, cnpj, razao_social, nome_fantasia, cidade, estado, cnae_principal, cnae_descricao, created_at')
    .eq('id', empresaId)
    .maybeSingle();

  if (empresaError) {
    throw new Error(`Failed to load company: ${empresaError.message}`);
  }

  if (!empresa) {
    return null;
  }

  const { data: regime, error: regimeError } = await supabase
    .from('fato_regime_tributario')
    .select('cnae_principal, cnae_descricao, data_registro, ativo')
    .eq('empresa_id', empresaId)
    .eq('ativo', true)
    .order('data_registro', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (regimeError && regimeError.code !== 'PGRST116') {
    logger.warn('company_graph_context_regime_error', { empresaId, error: regimeError.message });
  }

  const { data: transacoes, error: txError } = await supabase
    .from('fato_transacao_empresas')
    .select(`
      pessoa_id,
      cargo,
      qualificacao,
      data_transacao,
      ativo,
      dim_pessoas (
        id,
        nome_completo,
        cargo_atual,
        empresa_atual
      )
    `)
    .eq('empresa_id', empresaId);

  if (txError) {
    throw new Error(`Failed to load company transactions: ${txError.message}`);
  }

  let normalizedTransactions = transacoes || [];

  const missingPessoaRows = normalizedTransactions.filter((tx) => !tx.dim_pessoas?.id && tx.pessoa_id);
  if (missingPessoaRows.length > 0) {
    const pessoaIds = [...new Set(missingPessoaRows.map((tx) => String(tx.pessoa_id)).filter(Boolean))];
    const { data: fallbackPessoas, error: fallbackError } = await supabase
      .from('dim_pessoas')
      .select('id, nome_completo, cargo_atual, empresa_atual')
      .in('id', pessoaIds);

    if (fallbackError) {
      logger.warn('company_graph_context_socios_fallback_error', { empresaId, error: fallbackError.message });
    } else {
      const lookup = new Map((fallbackPessoas || []).map((pessoa) => [String(pessoa.id), pessoa]));
      normalizedTransactions = normalizedTransactions.map((tx) => {
        if (tx.dim_pessoas?.id || !tx.pessoa_id) return tx;
        const fallbackPessoa = lookup.get(String(tx.pessoa_id));
        return fallbackPessoa ? { ...tx, dim_pessoas: fallbackPessoa } : tx;
      });
    }
  }

  const socios = dedupeSocios(normalizedTransactions
    .filter((tx) => tx.dim_pessoas?.id)
    .map((tx) => ({
      id: String(tx.dim_pessoas.id),
      nome: tx.dim_pessoas.nome_completo,
      cargo: tx.cargo || tx.qualificacao || tx.dim_pessoas.cargo_atual,
      qualificacao: tx.qualificacao || null,
      data_entrada: tx.data_transacao || null,
      ativo: tx.ativo !== false,
    })));

  return {
    empresa,
    socios,
    nome: normalizeCompanyName(empresa),
    cidade: empresa.cidade || null,
    estado: empresa.estado || null,
    cnae_principal: regime?.cnae_principal || empresa.cnae_principal || null,
    cnae_descricao: regime?.cnae_descricao || empresa.cnae_descricao || null,
  };
}

export async function getCompanyGraphCoverage(empresaId) {
  const { data: edges, error } = await supabase
    .from('fato_relacoes_entidades')
    .select('source_type, source_id, target_type, target_id, tipo_relacao, strength, confidence, ativo')
    .eq('ativo', true)
    .or(
      `and(source_type.eq.empresa,source_id.eq.${empresaId}),and(target_type.eq.empresa,target_id.eq.${empresaId})`
    );

  if (error) {
    throw new Error(`Failed to load graph coverage: ${error.message}`);
  }

  const byRelationship = {};
  const neighborsByType = {};
  const uniqueNeighborKeys = new Set();
  const societariaPessoaIds = new Set();

  for (const edge of (edges || [])) {
    byRelationship[edge.tipo_relacao] = (byRelationship[edge.tipo_relacao] || 0) + 1;

    const isSourceEmpresa = edge.source_type === 'empresa' && String(edge.source_id) === String(empresaId);
    const neighborType = isSourceEmpresa ? edge.target_type : edge.source_type;
    const neighborId = isSourceEmpresa ? edge.target_id : edge.source_id;
    const neighborKey = `${neighborType}:${neighborId}`;

    uniqueNeighborKeys.add(neighborKey);
    neighborsByType[neighborType] = (neighborsByType[neighborType] || 0) + 1;

    if (edge.tipo_relacao === 'societaria' && neighborType === 'pessoa') {
      societariaPessoaIds.add(String(neighborId));
    }
  }

  return {
    total_edges: (edges || []).length,
    total_neighbors: uniqueNeighborKeys.size,
    by_relationship: byRelationship,
    neighbors_by_type: neighborsByType,
    societaria_pessoa_count: societariaPessoaIds.size,
  };
}

export function evaluateCompanyGraphCoverage(context, coverage) {
  const expectedSocios = context.socios.length;
  const reasons = [];

  if (coverage.total_edges === 0) {
    reasons.push('empresa_sem_arestas');
  }

  if (expectedSocios > 0 && coverage.societaria_pessoa_count < expectedSocios) {
    reasons.push('socios_nao_materializados');
  }

  if (expectedSocios === 0 && coverage.total_edges === 0) {
    reasons.push('empresa_sem_fontes_relacionais');
  }

  return {
    expected_socios: expectedSocios,
    materialized_socios: coverage.societaria_pessoa_count,
    needs_materialization: reasons.length > 0,
    reasons,
  };
}

export async function materializeCompanyGraph(empresaId, options = {}) {
  const force = options.force === true;
  const context = await getCompanyGraphContext(empresaId);
  if (!context) {
    throw new Error(`Company ${empresaId} not found`);
  }

  const before = await getCompanyGraphCoverage(empresaId);
  const evaluationBefore = evaluateCompanyGraphCoverage(context, before);

  if (!force && !evaluationBefore.needs_materialization) {
    return {
      empresa_id: String(empresaId),
      skipped: true,
      reason: 'already_materialized',
      context: {
        nome: context.nome,
        cidade: context.cidade,
        estado: context.estado,
        cnae_principal: context.cnae_principal,
        socios: context.socios.length,
      },
      before,
      after: before,
      evaluation: evaluationBefore,
      materialized: {
        societaria: 0,
        cnae_similar: 0,
        geografico: 0,
        mencionado_em: 0,
        emenda_beneficiario: 0,
        politico_empresarial: 0,
        mandatos: 0,
        total: 0,
      }
    };
  }

  const materialized = await enrichRelationshipsAfterApproval({
    empresa_id: empresaId,
    socios: context.socios,
    cnae_principal: context.cnae_principal || context.cnae_descricao,
    cidade: context.cidade,
    estado: context.estado,
    nome: context.nome,
  });

  const after = await getCompanyGraphCoverage(empresaId);
  const evaluationAfter = evaluateCompanyGraphCoverage(context, after);

  logger.info('company_graph_materialized', {
    empresa_id: empresaId,
    force,
    before_edges: before.total_edges,
    after_edges: after.total_edges,
    expected_socios: evaluationAfter.expected_socios,
    materialized_socios: evaluationAfter.materialized_socios,
    needs_materialization: evaluationAfter.needs_materialization,
    total_created: materialized.total,
  });

  return {
    empresa_id: String(empresaId),
    skipped: false,
    force,
    context: {
      nome: context.nome,
      cidade: context.cidade,
      estado: context.estado,
      cnae_principal: context.cnae_principal,
      socios: context.socios.length,
    },
    before,
    after,
    evaluation: evaluationAfter,
    materialized,
  };
}

export async function ensureCompanyGraphMaterialized(empresaId, options = {}) {
  return materializeCompanyGraph(empresaId, { ...options, force: options.force === true });
}
