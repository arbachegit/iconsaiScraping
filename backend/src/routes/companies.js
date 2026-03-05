import { Router } from 'express';
import * as serper from '../services/serper.js';
import * as perplexity from '../services/perplexity.js';
import * as brasilapi from '../services/brasilapi.js';
import * as apollo from '../services/apollo.js';
import * as cnpja from '../services/cnpja.js';
import * as gemini from '../services/gemini.js';
import { supabase, insertCompany, insertPerson, insertTransacaoEmpresa, insertRegimeTributario, insertInferenciaLimites, insertRegimeHistorico, findCompanyByCnpj, listCompanies, getCompanyFullData, updateInferenciaLimites, registerDataSource, checkExistingCnpjs, invalidateApprovedCache } from '../database/supabase.js';
import { calcularInferenciaVAR, getPesosVAR, getLimitesRegime } from '../services/var_inference.js';
import { LINKEDIN_STATUS, DATA_SOURCES, RELATIONSHIP_TYPES } from '../constants.js';
import { enrichRelationshipsAfterApproval } from '../services/graph-pipeline.js';
import { getDirectRelationships, getNetworkGraph, getNetworkStats } from '../services/graph-queries.js';
import { hybridSearch, calculateSIS } from '../services/hybrid-search.js';
import { executeStreamingSearch } from '../services/sse-stream.js';
import { proxyToIntelligence } from '../services/intelligence-proxy.js';
import { searchCompanySchema, detailsCompanySchema, sociosSchema, approveCompanySchema, recalculateSchema, listCompaniesSchema, networkQuerySchema, relationshipsQuerySchema, hybridSearchSchema, streamSearchSchema, validateBody, validateQuery } from '../validation/schemas.js';
import logger from '../utils/logger.js';
// escapeLike moved to listCompanies() in supabase.js
import { analyzeQuery, estimateCardinality, rankResults, buildRefinementResponse, logEvidence } from '../services/search-orchestrator.js';

const router = Router();

// Register all data sources on startup (compliance)
(async () => {
  for (const [key, source] of Object.entries(DATA_SOURCES)) {
    await registerDataSource(source);
  }
  logger.info('Data sources registered for compliance');
})();

/**
 * POST /api/companies/search
 * Search for company by name and optional city, return candidates with CNPJ.
 * Integrates Search Orchestrator for query analysis, cardinality estimation,
 * refinement suggestions, ranking, and evidence logging.
 *
 * Query params (optional): page, pageSize
 */
router.post('/search', validateBody(searchCompanySchema), async (req, res) => {
  const requestId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startTime = Date.now();
  try {
    const { nome, cidade, segmento, regime } = req.body;
    const page = parseInt(req.body.page) || 1;
    const pageSize = Math.min(parseInt(req.body.pageSize) || 25, 50);

    // ── 1. Query Analysis ──
    const analysis = analyzeQuery({
      nome, cidade, segmento, regime,
      entityType: 'company'
    });

    // ── 2. Cardinality Estimation ──
    const cardinality = await estimateCardinality(analysis);

    // ── 3. Check if refinement is required ──
    const refinement = buildRefinementResponse(analysis, cardinality);

    if (refinement.status === 'REFINE_REQUIRED') {
      const durationMs = Date.now() - startTime;
      logEvidence({
        requestId,
        input: { nome, cidade, segmento, regime },
        analysis,
        cardinality,
        strategy: analysis.strategy,
        sourcesUsed: [],
        returnedCount: 0,
        durationMs
      });

      return res.json({
        found: false,
        status: 'REFINE_REQUIRED',
        message: refinement.message,
        suggestions: refinement.suggestions,
        estimatedMatches: refinement.estimatedMatches,
        analysis: {
          type: analysis.type,
          strength: analysis.strength,
          strategy: analysis.strategy,
          missingFields: analysis.missingFields
        },
        candidates: [],
        requestId,
        durationMs
      });
    }

    // ── 4. Build search query ──
    const queryParts = [];
    if (nome) queryParts.push(nome);
    if (cidade) queryParts.push(cidade);
    if (segmento) queryParts.push(segmento);
    if (regime) queryParts.push(regime);

    const searchName = nome || queryParts[0];
    const searchCity = cidade || null;
    const sourcesTried = [];

    logger.info('Company search started', {
      requestId,
      filters: { nome, cidade, segmento, regime },
      analysis: { strength: analysis.strength, strategy: analysis.strategy },
      page,
      pageSize
    });

    // ── 5. Federated Search: DB + External Sources ──
    // 5a. Internal DB search (always first)
    sourcesTried.push('database');
    let internalResults = [];
    let dbTotal = 0;
    try {
      const { data: internalData, total } = await listCompanies({
        nome: searchName,
        cidade: searchCity,
        limit: pageSize,
        offset: (page - 1) * pageSize
      });
      internalResults = internalData;
      dbTotal = total;
    } catch (err) {
      logger.warn('Internal DB search failed', { requestId, error: err.message });
    }
    const internalCnpjs = new Set(internalResults.map(r => r.cnpj));

    const internalCandidates = internalResults.map(r => ({
      cnpj: r.cnpj,
      cnpj_formatted: `${r.cnpj.slice(0,2)}.${r.cnpj.slice(2,5)}.${r.cnpj.slice(5,8)}/${r.cnpj.slice(8,12)}-${r.cnpj.slice(12)}`,
      razao_social: r.razao_social,
      nome_fantasia: r.nome_fantasia,
      localizacao: r.cidade && r.estado ? `${r.cidade} - ${r.estado}` : null,
      fonte: 'interno'
    }));

    // 5b. External sources (only on page 1 or if few DB results)
    let externalCandidates = [];
    let searchSource = 'database';

    if (page === 1 || internalResults.length < 5) {
      try {
      // Serper (Google search)
      sourcesTried.push('serper');
      let candidates = await serper.searchCompanyByName(searchName, searchCity);
      searchSource = 'serper';

      // Fallback: Perplexity AI
      if (candidates.length === 0) {
        sourcesTried.push('perplexity');
        candidates = await perplexity.searchCompanyByName(searchName, searchCity);
        searchSource = 'perplexity';
      }

      // Fallback: Serper exact query
      if (candidates.length === 0) {
        sourcesTried.push('serper_exact');
        const fullQuery = `${queryParts.join(' ')} CNPJ empresa`;
        const exactResults = await serper.search(fullQuery, 20);

        const cnpjPattern = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g;
        const seenCnpjs = new Set();

        for (const item of exactResults.organic || []) {
          const text = `${item.title || ''} ${item.snippet || ''}`;
          const matches = text.match(cnpjPattern) || [];

          for (const match of matches) {
            const cnpj = match.replace(/[^\d]/g, '');
            if (cnpj.length === 14 && !seenCnpjs.has(cnpj)) {
              seenCnpjs.add(cnpj);
              candidates.push({
                cnpj: cnpj,
                cnpj_formatted: `${cnpj.slice(0,2)}.${cnpj.slice(2,5)}.${cnpj.slice(5,8)}/${cnpj.slice(8,12)}-${cnpj.slice(12)}`,
                razao_social: item.title?.split('-')[0]?.trim() || nome,
                localizacao: null,
                fonte: 'serper_exact'
              });
            }
          }
        }
        searchSource = 'serper_exact';
      }

      // Enrich external candidates with BrasilAPI (limit to 10)
      sourcesTried.push('brasilapi');
      const limitedCandidates = candidates.slice(0, 10);

      externalCandidates = await Promise.all(
        limitedCandidates.map(async (c) => {
          const isInternal = internalCnpjs.has(c.cnpj);
          try {
            const brasilData = await brasilapi.getCompanyByCnpj(c.cnpj);
            return {
              cnpj: c.cnpj,
              cnpj_formatted: c.cnpj_formatted,
              razao_social: brasilData?.razao_social || c.razao_social,
              nome_fantasia: brasilData?.nome_fantasia || null,
              localizacao: brasilData ? `${brasilData.cidade} - ${brasilData.estado}` : c.localizacao,
              fonte: isInternal ? 'interno' : 'externo'
            };
          } catch (err) {
            return {
              cnpj: c.cnpj,
              cnpj_formatted: c.cnpj_formatted,
              razao_social: c.razao_social,
              nome_fantasia: null,
              localizacao: c.localizacao,
              fonte: isInternal ? 'interno' : 'externo'
            };
          }
        })
      );
      } catch (extErr) {
        logger.warn('External search failed, using DB results only', { requestId, error: extErr.message });
        searchSource = 'database_only';
      }
    }

    // ── 6. Merge + Dedup + Rank ──
    const seenFinal = new Set();
    const mergedRaw = [];

    // Internal first (higher trust)
    for (const c of internalCandidates) {
      if (!seenFinal.has(c.cnpj)) {
        seenFinal.add(c.cnpj);
        mergedRaw.push(c);
      }
    }
    // Then external
    for (const c of externalCandidates) {
      if (!seenFinal.has(c.cnpj)) {
        seenFinal.add(c.cnpj);
        mergedRaw.push(c);
      }
    }

    // Rank results
    const allCandidates = rankResults(mergedRaw, searchName);

    // ── 7. Badges ──
    const dbCount = allCandidates.filter(c => c.fonte === 'interno').length;
    const newCount = allCandidates.filter(c => c.fonte !== 'interno').length;
    const totalEstimate = dbTotal + newCount;
    const totalPages = Math.ceil(totalEstimate / pageSize);

    const durationMs = Date.now() - startTime;

    // ── 8. Evidence logging ──
    logEvidence({
      requestId,
      input: { nome, cidade, segmento, regime, page, pageSize },
      analysis,
      cardinality,
      strategy: analysis.strategy,
      sourcesUsed: sourcesTried,
      returnedCount: allCandidates.length,
      durationMs
    });

    if (allCandidates.length === 0) {
      return res.json({
        found: false,
        status: 'OK',
        message: 'Nenhuma empresa encontrada com estes critérios',
        candidates: [],
        sources_tried: sourcesTried,
        analysis: {
          type: analysis.type,
          strength: analysis.strength,
          strategy: analysis.strategy
        },
        pagination: { page, pageSize, total: 0, totalPages: 0, hasMore: false },
        badges: { total: 0, db: 0, new: 0 },
        requestId,
        durationMs
      });
    }

    if (allCandidates.length === 1) {
      return res.json({
        found: true,
        single_match: true,
        status: 'OK',
        message: 'Empresa encontrada. Selecione para ver detalhes.',
        company: allCandidates[0],
        candidates: allCandidates,
        analysis: {
          type: analysis.type,
          strength: analysis.strength,
          strategy: analysis.strategy
        },
        pagination: { page, pageSize, total: 1, totalPages: 1, hasMore: false },
        badges: { total: 1, db: dbCount, new: newCount },
        requestId,
        durationMs
      });
    }

    return res.json({
      found: true,
      single_match: false,
      status: 'OK',
      message: `${allCandidates.length} empresas encontradas. Selecione a correta.`,
      candidates: allCandidates,
      analysis: {
        type: analysis.type,
        strength: analysis.strength,
        strategy: analysis.strategy
      },
      pagination: {
        page,
        pageSize,
        total: totalEstimate,
        totalPages,
        hasMore: page < totalPages
      },
      badges: {
        total: allCandidates.length,
        db: dbCount,
        new: newCount
      },
      requestId,
      durationMs,
      searchSource,
      sources_tried: sourcesTried
    });

  } catch (error) {
    logger.error('Company search failed', {
      requestId,
      error: error.message,
      durationMs: Date.now() - startTime
    });
    res.status(500).json({
      error: 'Erro ao buscar empresa',
      details: error.message
    });
  }
});

/**
 * POST /api/companies/details
 * Get detailed info for a specific CNPJ
 * Sources: BrasilAPI (official) + Apollo + Serper (enrichment)
 * Returns: empresa (company data) separately from socios (people data)
 */
router.post('/details', validateBody(detailsCompanySchema), async (req, res) => {
  try {
    const { cnpj } = req.body;
    const cleanCnpj = cnpj; // Already cleaned by Zod schema

    // Check if already exists
    const existing = await findCompanyByCnpj(cleanCnpj);
    if (existing) {
      // Fetch socios from DB
      const { data: transacoes, error: transErr } = await supabase
        .from('fato_transacao_empresas')
        .select('*, dim_pessoas(*)')
        .eq('empresa_id', existing.id);

      if (transErr && transErr.code !== 'PGRST116') {
        console.error('[DETAILS] Error fetching transacoes:', transErr.message);
      }

      const dbSocios = transacoes || [];

      // Fetch QSA atual from BrasilAPI
      let qsaAtual = [];
      try {
        const brasilData = await brasilapi.getCompanyByCnpj(cleanCnpj);
        qsaAtual = brasilData?.socios || [];
      } catch (err) {
        console.warn('[DETAILS] Erro ao buscar QSA da Receita:', err.message);
      }

      // Normalize name for comparison (uppercase, remove accents)
      const normalizeName = (name) =>
        (name || '')
          .toUpperCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .trim();

      const qsaNomes = new Set(qsaAtual.map(s => normalizeName(s.nome)));

      // Cross-reference DB socios with QSA
      const sociosAtivos = [];
      const sociosInativos = [];

      for (const t of dbSocios) {
        const pessoa = t.dim_pessoas;
        const nomeNorm = normalizeName(pessoa?.nome_completo);
        const ativo = qsaNomes.has(nomeNorm);

        // Update ativo status in DB
        await supabase
          .from('fato_transacao_empresas')
          .update({ ativo })
          .eq('id', t.id);

        const socioData = {
          nome: pessoa?.nome_completo,
          cpf: pessoa?.cpf,
          qualificacao: t.qualificacao,
          cargo: t.cargo,
          linkedin: pessoa?.linkedin_url,
          email: pessoa?.email,
          foto_url: pessoa?.foto_url || t.logo_url,
          headline: t.headline,
          data_entrada: t.data_transacao,
          faixa_etaria: pessoa?.faixa_etaria,
          pais_origem: pessoa?.pais,
          ativo
        };

        if (ativo) sociosAtivos.push(socioData);
        else sociosInativos.push(socioData);
      }

      // Find new socios (in QSA but not in DB)
      const dbNomes = new Set(dbSocios.map(t => normalizeName(t.dim_pessoas?.nome_completo)));
      const sociosNovos = qsaAtual
        .filter(s => !dbNomes.has(normalizeName(s.nome)))
        .map(s => ({
          nome: s.nome,
          cpf: s.cpf,
          qualificacao: s.qualificacao,
          cargo: s.cargo,
          data_entrada: s.data_entrada,
          faixa_etaria: s.faixa_etaria,
          pais_origem: s.pais_origem,
          linkedin: null,
          email: null,
          foto_url: null,
          headline: null,
          ativo: true,
          novo: true
        }));

      return res.json({
        exists: true,
        message: 'Empresa ja cadastrada',
        empresa: existing,
        socios: [...sociosAtivos, ...sociosInativos],
        socios_ativos: sociosAtivos,
        socios_inativos: sociosInativos,
        socios_novos: sociosNovos
      });
    }

    // ========================================
    // 1. DADOS OFICIAIS - BrasilAPI (Receita Federal)
    // ========================================
    console.log(`[BRASILAPI] Buscando CNPJ: ${cleanCnpj}`);
    const brasilData = await brasilapi.getCompanyByCnpj(cleanCnpj);

    if (!brasilData) {
      return res.status(404).json({
        error: 'CNPJ nao encontrado na Receita Federal'
      });
    }

    // Clean company name for searches
    let searchName = brasilData.nome_fantasia || brasilData.razao_social;
    searchName = searchName
      .replace(/\s*[-–]\s*[A-Z0-9\s]+$/gi, '')
      .replace(/\s+(LTDA|S\.?A\.?|S\/A|ME|EPP|EIRELI|SOCIEDADE ANONIMA|LIMITADA)\.?$/gi, '')
      .replace(/\s+(COMERCIO|COMERCIAL|INDUSTRIA|SERVICOS|PARTICIPACOES|BRASILEIRO|BRASILEIRA).*$/gi, '')
      .trim();
    if (searchName.length > 30) {
      searchName = searchName.split(/\s+/)[0];
    }

    // ========================================
    // 2. ENRIQUECIMENTO - Apollo (LinkedIn empresa)
    // ========================================
    console.log(`[APOLLO] Buscando empresa: ${searchName}`);
    const apolloData = await apollo.searchCompany(searchName, brasilData.estado);

    // ========================================
    // 3. ENRIQUECIMENTO - Serper (Website via Google)
    // ========================================
    console.log(`[SERPER] Buscando website: ${searchName}`);
    let website = apolloData?.website || null;
    if (!website) {
      website = await serper.findCompanyWebsite(searchName, brasilData.cidade);
    }
    if (!website) {
      console.log(`[GEMINI] Buscando website: ${searchName}`);
      website = await gemini.findCompanyWebsite(searchName, brasilData.cidade, brasilData.estado);
    }

    // ========================================
    // 4. ENRIQUECIMENTO - LinkedIn empresa (Apollo → Serper → NAO_POSSUI)
    // ========================================
    let linkedin = apolloData?.linkedin || null;
    if (!linkedin) {
      console.log(`[SERPER] Buscando LinkedIn empresa: ${searchName}`);
      linkedin = await serper.findCompanyLinkedin(searchName);
    }
    // Mark as NAO_POSSUI if not found (important for analysis)
    if (!linkedin) {
      linkedin = LINKEDIN_STATUS.NAO_POSSUI;
    }

    // ========================================
    // 5. EXTRAIR CONTATOS DO WEBSITE
    // ========================================
    let websiteContacts = { emails: [], phones: [], social: {} };
    if (website && website !== LINKEDIN_STATUS.NAO_POSSUI) {
      console.log(`[SERPER] Extraindo contatos de: ${website}`);
      websiteContacts = await serper.extractContactsFromWebsite(website);
    }

    // ========================================
    // 6. REGIME TRIBUTÁRIO - CNPJá (histórico)
    // ========================================
    console.log(`[CNPJA] Buscando regime tributário: ${cleanCnpj}`);
    const cnpjaData = await cnpja.getRegimeTributario(cleanCnpj);

    // ========================================
    // 7. MONTAR DADOS DA EMPRESA (sem sócios)
    // ========================================
    const empresa = {
      // Identificação
      cnpj: brasilData.cnpj,
      razao_social: brasilData.razao_social,
      nome_fantasia: brasilData.nome_fantasia,

      // Classificação (Receita Federal)
      cnae_principal: brasilData.cnae_principal,
      cnae_descricao: brasilData.cnae_descricao,
      porte: brasilData.porte,
      natureza_juridica: brasilData.natureza_juridica,
      situacao_cadastral: brasilData.situacao_cadastral,
      capital_social: brasilData.capital_social,
      data_abertura: brasilData.data_abertura,
      simples_nacional: brasilData.simples_nacional,
      simei: brasilData.simei,

      // Endereço (Receita Federal)
      logradouro: brasilData.logradouro,
      numero: brasilData.numero,
      complemento: brasilData.complemento,
      bairro: brasilData.bairro,
      cidade: brasilData.cidade,
      estado: brasilData.estado,
      cep: brasilData.cep,
      codigo_municipio_ibge: brasilData.codigo_municipio_ibge,

      // Contato (Receita Federal + Website)
      telefone_1: brasilData.telefone_1,
      telefone_2: brasilData.telefone_2,
      email: brasilData.email || websiteContacts.emails[0] || null,
      emails_website: websiteContacts.emails,
      telefones_website: websiteContacts.phones,

      // Presença Digital (Apollo + Serper)
      website: website,
      linkedin: linkedin, // NAO_POSSUI se não encontrar
      twitter: apolloData?.twitter || websiteContacts.social?.twitter || null,
      facebook: apolloData?.facebook || websiteContacts.social?.facebook || null,
      instagram: websiteContacts.social?.instagram || null,

      // Informações Adicionais (Apollo)
      setor: apolloData?.industry || null,
      descricao: apolloData?.description || null,
      num_funcionarios: apolloData?.num_employees || null,
      logo_url: apolloData?.logo_url || null,
      ano_fundacao: apolloData?.founded_year || null,

      // Quantidade de sócios (para exibir botão "Ver Sócios")
      qtd_socios: brasilData.socios?.length || 0,

      // Regime Tributário (CNPJá)
      regime_tributario: cnpjaData?.regime_atual || null,
      simples_optante: cnpjaData?.simples_optante || brasilData.simples_nacional || false,
      simples_desde: cnpjaData?.simples_desde || null,
      mei_optante: cnpjaData?.mei_optante || brasilData.simei || false,
      mei_desde: cnpjaData?.mei_desde || null,
      historico_regimes: cnpjaData?.historico_regimes || [],
      qtd_mudancas_regime: cnpjaData?.qtd_mudancas_regime || 0,

      // Inferências sobre limites
      inferencias: cnpjaData?.inferencias || null,

      // Raw data
      raw_brasilapi: brasilData.raw_brasilapi,
      raw_apollo: apolloData?.raw_apollo || null,
      raw_cnpja: cnpjaData?.raw_cnpja || null
    };

    // ========================================
    // 7. MONTAR DADOS DOS SÓCIOS (separado)
    // ========================================
    const socios = (brasilData.socios || []).map(socio => ({
      nome: socio.nome,
      cpf: socio.cpf, // CPF mascarado da Receita Federal
      cargo: socio.cargo,
      qualificacao: socio.qualificacao,
      data_entrada: socio.data_entrada,
      faixa_etaria: socio.faixa_etaria,
      pais_origem: socio.pais_origem,
      // LinkedIn será buscado sob demanda via /socios endpoint
      linkedin: null,
      email: null
    }));

    return res.json({
      exists: false,
      message: 'Detalhes da empresa. Aguardando aprovacao.',
      empresa: empresa,
      socios: socios
    });

  } catch (error) {
    console.error('[DETAILS ERROR]', error);
    res.status(500).json({
      error: 'Erro ao buscar detalhes',
      details: error.message
    });
  }
});

/**
 * POST /api/companies/socios
 * Enrich socios with LinkedIn data (called on demand via "Ver Sócios" button)
 */
router.post('/socios', validateBody(sociosSchema), async (req, res) => {
  try {
    const { socios, empresa_nome } = req.body;

    // Clean company name for searches
    let searchName = empresa_nome || '';
    searchName = searchName
      .replace(/\s*[-–]\s*[A-Z0-9\s]+$/gi, '')
      .replace(/\s+(LTDA|S\.?A\.?|S\/A|ME|EPP|EIRELI|SOCIEDADE ANONIMA|LIMITADA)\.?$/gi, '')
      .trim();
    if (searchName.length > 30) {
      searchName = searchName.split(/\s+/)[0];
    }

    logger.info('Enriching socios', { count: socios.length, empresa: searchName });

    const enrichedSocios = [];

    for (const socio of socios.slice(0, 10)) { // Limit to 10
      console.log(`[APOLLO] Buscando pessoa: ${socio.nome}`);

      // Try Apollo first
      const apolloPerson = await apollo.searchPerson(socio.nome, searchName);

      if (apolloPerson) {
        enrichedSocios.push({
          ...socio,
          linkedin: apolloPerson.linkedin || LINKEDIN_STATUS.NAO_POSSUI,
          email: apolloPerson.email,
          foto_url: apolloPerson.photo_url,
          headline: apolloPerson.headline,
          titulo: apolloPerson.title,
          fonte_linkedin: 'apollo'
        });
      } else {
        // Fallback to Serper
        const linkedinUrl = await serper.findPersonLinkedin(socio.nome, searchName);
        enrichedSocios.push({
          ...socio,
          linkedin: linkedinUrl || LINKEDIN_STATUS.NAO_POSSUI,
          email: null,
          foto_url: null,
          headline: null,
          fonte_linkedin: linkedinUrl ? 'serper' : null
        });
      }

      // Rate limit: wait 200ms between requests
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return res.json({
      success: true,
      socios: enrichedSocios
    });

  } catch (error) {
    console.error('[SOCIOS ERROR]', error);
    res.status(500).json({
      error: 'Erro ao enriquecer socios',
      details: error.message
    });
  }
});

/**
 * POST /api/companies/approve
 * Approve and insert company + socios into database
 * Empresa and Socios are saved separately
 */
router.post('/approve', validateBody(approveCompanySchema), async (req, res) => {
  try {
    const { empresa, socios, aprovado_por } = req.body;
    const cleanCnpj = empresa.cnpj.replace(/[^\d]/g, '');

    logger.info('Approving company', { cnpj: cleanCnpj, aprovado_por });

    // Check if already exists
    const existing = await findCompanyByCnpj(cleanCnpj);
    if (existing) {
      return res.status(409).json({
        error: 'Empresa ja cadastrada',
        empresa: existing
      });
    }

    // Insert company (dim_empresas)
    const insertedCompany = await insertCompany({
      cnpj: cleanCnpj,
      razao_social: empresa.razao_social,
      nome_fantasia: empresa.nome_fantasia,
      situacao_cadastral: empresa.situacao_cadastral,
      data_fundacao: empresa.data_abertura,
      logradouro: empresa.logradouro,
      numero: empresa.numero,
      complemento: empresa.complemento,
      bairro: empresa.bairro,
      cidade: empresa.cidade,
      estado: empresa.estado,
      cep: empresa.cep,
      codigo_municipio_ibge: empresa.codigo_municipio_ibge,
      telefone_1: empresa.telefone_1,
      telefone_2: empresa.telefone_2,
      email: empresa.email,
      website: empresa.website,
      linkedin: empresa.linkedin,
      logo_url: empresa.logo_url,
      twitter: empresa.twitter,
      facebook: empresa.facebook,
      instagram: empresa.instagram,
      raw_brasilapi: empresa.raw_brasilapi || {},
      raw_apollo: empresa.raw_apollo || {},
      aprovado_por: aprovado_por
    });

    // Insert regime tributario (fato_regime_tributario)
    const regimeTributario = empresa.regime_tributario
      || (empresa.mei_optante ? 'MEI' : (empresa.simples_optante ? 'SIMPLES_NACIONAL' : 'LUCRO_PRESUMIDO'));

    await insertRegimeTributario({
      empresa_id: insertedCompany.id,
      porte: empresa.porte,
      natureza_juridica: empresa.natureza_juridica,
      capital_social: empresa.capital_social,
      cnae_principal: empresa.cnae_principal,
      cnae_descricao: empresa.cnae_descricao,
      regime_tributario: regimeTributario,
      setor: empresa.setor,
      descricao: empresa.descricao,
      qtd_funcionarios: empresa.num_funcionarios ? parseInt(empresa.num_funcionarios) : null,
      // CNPJá fields
      data_inicio: empresa.simples_desde || empresa.mei_desde,
      ativo: true,
      simples_optante: empresa.simples_optante,
      simples_desde: empresa.simples_desde,
      mei_optante: empresa.mei_optante,
      mei_desde: empresa.mei_desde,
      raw_cnpja: empresa.raw_cnpja || {}
    });

    // Insert historical regimes (if available)
    if (empresa.historico_regimes && empresa.historico_regimes.length > 0) {
      const historicoAntigo = empresa.historico_regimes.filter(h => !h.ativo);
      if (historicoAntigo.length > 0) {
        await insertRegimeHistorico(insertedCompany.id, historicoAntigo, {
          porte: empresa.porte,
          natureza_juridica: empresa.natureza_juridica,
          capital_social: empresa.capital_social,
          cnae_principal: empresa.cnae_principal,
          cnae_descricao: empresa.cnae_descricao
        });
      }
    }

    // Calculate VAR inference
    const regimes = [{
      empresa_id: insertedCompany.id,
      regime_tributario: regimeTributario,
      ativo: true,
      qtd_funcionarios: empresa.num_funcionarios ? parseInt(empresa.num_funcionarios) : 0,
      capital_social: empresa.capital_social,
      cnae_principal: empresa.cnae_principal
    }];

    const varInferencia = calcularInferenciaVAR(empresa, regimes, socios || []);

    // Insert VAR inference
    await insertInferenciaLimites({
      empresa_id: insertedCompany.id,
      ...varInferencia
    });

    // Insert socios
    const insertedSocios = [];

    if (socios && socios.length > 0) {
      for (const socio of socios) {
        const linkedinValue = socio.linkedin === LINKEDIN_STATUS.NAO_POSSUI ? null : socio.linkedin;

        // Insert person (dim_pessoas)
        const person = await insertPerson({
          nome: socio.nome,
          cpf: socio.cpf || null,
          linkedin: linkedinValue,
          email: socio.email || null,
          foto_url: socio.foto_url || null,
          faixa_etaria: socio.faixa_etaria,
          pais_origem: socio.pais_origem
        });

        // Insert transaction (fato_transacao_empresas)
        await insertTransacaoEmpresa({
          pessoa_id: person.id,
          empresa_id: insertedCompany.id,
          tipo_transacao: 'entrada_sociedade',
          data_transacao: socio.data_entrada || null,
          qualificacao: socio.qualificacao,
          cargo: socio.cargo || socio.qualificacao || 'Socio',
          headline: socio.headline || null,
          tipo: 'fundador',
          logo_url: socio.foto_url || null,
          ativo: true
        });

        insertedSocios.push(person);
      }
    }

    // Detect graph relationships (non-blocking, log errors)
    let graphResults = null;
    try {
      graphResults = await enrichRelationshipsAfterApproval({
        empresa_id: insertedCompany.id,
        socios: insertedSocios.map((s, i) => ({
          id: s.id,
          cargo: socios[i]?.cargo || socios[i]?.qualificacao,
          qualificacao: socios[i]?.qualificacao,
          data_entrada: socios[i]?.data_entrada
        })),
        cnae_principal: empresa.cnae_principal,
        cidade: empresa.cidade,
        estado: empresa.estado,
        nome: empresa.nome_fantasia || empresa.razao_social
      });
    } catch (graphError) {
      logger.warn('graph_enrichment_failed', { empresa_id: insertedCompany.id, error: graphError.message });
    }

    console.log(`[APPROVED] Empresa ${cleanCnpj} aprovada por ${aprovado_por} com ${insertedSocios.length} socios`);

    // Invalidate approved companies cache so new company appears in searches
    invalidateApprovedCache();

    return res.json({
      success: true,
      message: 'Empresa aprovada e cadastrada com sucesso',
      empresa: insertedCompany,
      socios: insertedSocios,
      graph: graphResults
    });

  } catch (error) {
    console.error('[APPROVE ERROR]', error);
    res.status(500).json({
      error: 'Erro ao aprovar empresa',
      details: error.message
    });
  }
});

/**
 * GET /api/companies/list
 * List all approved companies with optional filters
 * Query params: nome, cidade, segmento, regime, limit, offset
 */
router.get('/list', validateQuery(listCompaniesSchema), async (req, res) => {
  const requestId = `list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startTime = Date.now();
  try {
    const { nome, cidade, segmento, regime, limit, offset } = req.query;

    // Single query with nested JOIN — regime_tributario + cnae_descricao included
    const { data: companies, total } = await listCompanies({
      nome, cidade, segmento, regime, limit, offset
    });

    const durationMs = Date.now() - startTime;
    logger.info('DB search completed', {
      requestId,
      source: 'db',
      filters: { nome, cidade, segmento, regime },
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      offset,
      durationMs,
      returnedCount: companies.length,
      totalEstimate: total
    });

    return res.json({
      success: true,
      count: companies.length,
      total,
      empresas: companies,
      offset,
      limit,
      requestId,
      source: 'db',
      durationMs
    });
  } catch (error) {
    logger.error('List search failed', {
      requestId,
      error: error.message,
      code: error.code,
      durationMs: Date.now() - startTime
    });
    res.status(500).json({
      error: 'Erro ao listar empresas',
      details: error.message
    });
  }
});

/**
 * POST /api/companies/check-existing
 * Check which CNPJs already exist in the database (batch)
 * Body: { cnpjs: string[] }
 */
router.post('/check-existing', async (req, res) => {
  try {
    const { cnpjs } = req.body;
    if (!Array.isArray(cnpjs) || cnpjs.length === 0) {
      return res.json({ success: true, existing: [] });
    }

    // Limit to 500 per request
    const limited = cnpjs.slice(0, 500);
    const existingSet = await checkExistingCnpjs(limited);

    return res.json({
      success: true,
      existing: [...existingSet],
      checked: limited.length
    });
  } catch (error) {
    logger.error('Check existing failed', { error: error.message });
    res.status(500).json({
      error: 'Erro ao verificar CNPJs existentes',
      details: error.message
    });
  }
});

/**
 * GET /api/companies/:id/analysis
 * Get full VAR analysis for a company
 */
router.get('/:id/analysis', async (req, res) => {
  try {
    const { id } = req.params;

    // Get full company data
    const fullData = await getCompanyFullData(id);

    if (!fullData.empresa) {
      return res.status(404).json({ error: 'Empresa nao encontrada' });
    }

    // Calculate VAR inference
    const inferencia = calcularInferenciaVAR(
      fullData.empresa,
      fullData.regimes,
      fullData.socios
    );

    // Update inference in database
    await updateInferenciaLimites(id, inferencia);

    return res.json({
      success: true,
      empresa: fullData.empresa,
      regimes: fullData.regimes,
      socios: fullData.socios,
      inferencia: inferencia,
      modelo: {
        pesos_var: getPesosVAR(),
        limites_regime: getLimitesRegime()
      }
    });

  } catch (error) {
    console.error('[ANALYSIS ERROR]', error);
    res.status(500).json({
      error: 'Erro ao analisar empresa',
      details: error.message
    });
  }
});

/**
 * POST /api/companies/:id/recalculate
 * Recalculate VAR inference with updated data
 */
router.post('/:id/recalculate', validateBody(recalculateSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const { qtd_funcionarios, capital_social } = req.body;

    // Get full company data
    const fullData = await getCompanyFullData(id);

    if (!fullData.empresa) {
      return res.status(404).json({ error: 'Empresa nao encontrada' });
    }

    // Override with manual values if provided
    if (fullData.regimes.length > 0) {
      const regimeAtivo = fullData.regimes.find(r => r.ativo) || fullData.regimes[0];
      if (qtd_funcionarios !== undefined) {
        regimeAtivo.qtd_funcionarios = qtd_funcionarios;
      }
      if (capital_social !== undefined) {
        regimeAtivo.capital_social = capital_social;
      }
    }

    // Recalculate VAR inference
    const inferencia = calcularInferenciaVAR(
      fullData.empresa,
      fullData.regimes,
      fullData.socios
    );

    // Update in database
    await updateInferenciaLimites(id, inferencia);

    return res.json({
      success: true,
      message: 'Inferencia recalculada',
      inferencia: inferencia
    });

  } catch (error) {
    console.error('[RECALCULATE ERROR]', error);
    res.status(500).json({
      error: 'Erro ao recalcular inferencia',
      details: error.message
    });
  }
});

/**
 * POST /api/companies/:id/update-regime
 * Update regime tributario for existing company (fetch from CNPJá)
 */
router.post('/:id/update-regime', async (req, res) => {
  try {
    const { id } = req.params;

    // Get company
    const fullData = await getCompanyFullData(id);
    if (!fullData.empresa) {
      return res.status(404).json({ error: 'Empresa nao encontrada' });
    }

    const empresa = fullData.empresa;
    const cleanCnpj = empresa.cnpj.replace(/[^\d]/g, '');

    // Fetch CNPJá data
    console.log(`[CNPJA] Atualizando regime para CNPJ: ${cleanCnpj}`);
    const cnpjaData = await cnpja.getRegimeTributario(cleanCnpj);

    if (!cnpjaData) {
      return res.status(404).json({
        error: 'Dados CNPJá nao encontrados',
        message: 'Verifique se a API key está configurada'
      });
    }

    // Get data from raw
    const capitalSocial = empresa.raw_brasilapi?.capital_social || empresa.raw_cnpj_data?.capital_social || 0;
    const porte = empresa.raw_brasilapi?.porte || empresa.raw_cnpj_data?.porte || null;
    const naturezaJuridica = empresa.raw_brasilapi?.natureza_juridica || empresa.raw_cnpj_data?.natureza_juridica || null;
    const cnaePrincipal = empresa.raw_brasilapi?.cnae_fiscal?.toString() || empresa.raw_cnpj_data?.cnae_fiscal?.toString() || null;
    const cnaeDescricao = empresa.raw_brasilapi?.cnae_fiscal_descricao || empresa.raw_cnpj_data?.cnae_fiscal_descricao || null;

    // Insert current regime
    const regimeTributario = cnpjaData.regime_atual || 'LUCRO_PRESUMIDO';

    await insertRegimeTributario({
      empresa_id: id,
      porte: porte,
      natureza_juridica: naturezaJuridica,
      capital_social: capitalSocial,
      cnae_principal: cnaePrincipal,
      cnae_descricao: cnaeDescricao,
      regime_tributario: regimeTributario,
      qtd_funcionarios: cnpjaData.qtd_funcionarios || null,
      data_inicio: cnpjaData.simples_desde || cnpjaData.mei_desde,
      ativo: true,
      simples_optante: cnpjaData.simples_optante,
      simples_desde: cnpjaData.simples_desde,
      mei_optante: cnpjaData.mei_optante,
      mei_desde: cnpjaData.mei_desde,
      raw_cnpja: cnpjaData.raw_cnpja || {}
    });

    // Insert historical regimes
    if (cnpjaData.historico_regimes && cnpjaData.historico_regimes.length > 0) {
      const historicoAntigo = cnpjaData.historico_regimes.filter(h => !h.ativo);
      if (historicoAntigo.length > 0) {
        await insertRegimeHistorico(id, historicoAntigo, {
          porte: porte,
          natureza_juridica: naturezaJuridica,
          capital_social: capitalSocial,
          cnae_principal: cnaePrincipal,
          cnae_descricao: cnaeDescricao
        });
      }
    }

    // Recalculate VAR inference
    const regimes = [{
      empresa_id: id,
      regime_tributario: regimeTributario,
      ativo: true,
      qtd_funcionarios: cnpjaData.qtd_funcionarios || 0,
      capital_social: capitalSocial,
      cnae_principal: cnaePrincipal,
      mei_optante: cnpjaData.mei_optante,
      simples_optante: cnpjaData.simples_optante
    }];

    const varInferencia = calcularInferenciaVAR(empresa, regimes, fullData.socios);
    await updateInferenciaLimites(id, varInferencia);

    console.log(`[UPDATE-REGIME] Empresa ${cleanCnpj} atualizada: ${regimeTributario}`);

    return res.json({
      success: true,
      message: 'Regime tributario atualizado',
      regime: {
        atual: regimeTributario,
        simples_optante: cnpjaData.simples_optante,
        mei_optante: cnpjaData.mei_optante,
        historico: cnpjaData.historico_regimes
      },
      inferencia: varInferencia
    });

  } catch (error) {
    console.error('[UPDATE-REGIME ERROR]', error);
    res.status(500).json({
      error: 'Erro ao atualizar regime',
      details: error.message
    });
  }
});

/**
 * GET /api/companies/var-model
 * Get VAR model parameters
 */
router.get('/var-model', async (req, res) => {
  return res.json({
    pesos: getPesosVAR(),
    limites: getLimitesRegime(),
    descricao: {
      qtd_funcionarios: 'Número de funcionários (CAGED/eSocial)',
      capital_social: 'Capital social registrado (Receita Federal)',
      anos_operando: 'Anos desde a fundação',
      qtd_mudancas_regime: 'Quantidade de mudanças de regime tributário',
      qtd_socios: 'Quantidade de sócios no QSA',
      qtd_cnaes: 'Quantidade de CNAEs (principal + secundários)'
    }
  });
});

/**
 * GET /api/companies/:id/founders-history
 * Check if founders had other companies
 */
router.get('/:id/founders-history', async (req, res) => {
  try {
    const { id } = req.params;

    // Get company with socios
    const fullData = await getCompanyFullData(id);
    if (!fullData.empresa) {
      return res.status(404).json({ error: 'Empresa nao encontrada' });
    }

    const foundersHistory = [];

    for (const transacao of fullData.socios) {
      const pessoa = transacao.dim_pessoas;
      if (!pessoa) continue;

      // Search for other companies this person is associated with
      const { data: outrasEmpresas, error } = await supabase
        .from('fato_transacao_empresas')
        .select('*, dim_empresas(*)')
        .eq('pessoa_id', pessoa.id)
        .neq('empresa_id', id);

      if (error) {
        console.error('Error fetching other companies:', error);
        continue;
      }

      foundersHistory.push({
        pessoa: {
          id: pessoa.id,
          nome: pessoa.nome_completo,
          cpf: pessoa.cpf,
          linkedin: pessoa.linkedin_url
        },
        empresas_anteriores: (outrasEmpresas || []).map(t => ({
          empresa_id: t.empresa_id,
          razao_social: t.dim_empresas?.razao_social,
          cnpj: t.dim_empresas?.cnpj,
          cargo: t.cargo || t.qualificacao,
          data_entrada: t.data_transacao
        }))
      });
    }

    return res.json({
      success: true,
      empresa: {
        id: fullData.empresa.id,
        razao_social: fullData.empresa.razao_social,
        cnpj: fullData.empresa.cnpj
      },
      fundadores: foundersHistory
    });

  } catch (error) {
    console.error('[FOUNDERS-HISTORY ERROR]', error);
    res.status(500).json({
      error: 'Erro ao buscar historico dos fundadores',
      details: error.message
    });
  }
});

/**
 * GET /api/companies/segments
 * List all unique segments (setores) in the database
 */
router.get('/segments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('fato_regime_tributario')
      .select('setor, cnae_descricao')
      .not('setor', 'is', null);

    if (error) throw error;

    // Get unique segments
    const segments = [...new Set(data.map(d => d.setor).filter(Boolean))];
    const cnaes = [...new Set(data.map(d => d.cnae_descricao).filter(Boolean))];

    return res.json({
      success: true,
      segments: segments,
      cnaes: cnaes.slice(0, 20) // Limit
    });

  } catch (error) {
    console.error('[SEGMENTS ERROR]', error);
    res.status(500).json({
      error: 'Erro ao listar segmentos',
      details: error.message
    });
  }
});

/**
 * GET /api/companies/cnae
 * List CNAEs from raw_cnae table (main Supabase)
 */
router.get('/cnae', async (req, res) => {
  try {
    const { search = '', limit = 100, offset = 0 } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 2000);
    const parsedOffset = Math.max(parseInt(offset) || 0, 0);

    // Sanitize search input (remove SQL metacharacters)
    const sanitizedSearch = search.replace(/[%_\\]/g, '').trim().slice(0, 100);

    // Use main Supabase (raw_cnae is in scraping DB, not fiscal)
    let query = supabase
      .from('raw_cnae')
      .select('subclasse, codigo, descricao, descricao_secao, descricao_divisao, descricao_grupo, descricao_classe')
      .order('codigo', { ascending: true })
      .range(parsedOffset, parsedOffset + parsedLimit - 1);

    if (sanitizedSearch) {
      query = query.or(
        `codigo.ilike.%${sanitizedSearch}%,descricao.ilike.%${sanitizedSearch}%,` +
        `descricao_secao.ilike.%${sanitizedSearch}%,descricao_grupo.ilike.%${sanitizedSearch}%`
      );
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      success: true,
      data: data || [],
      count: data?.length || 0,
      offset: parsedOffset,
      limit: parsedLimit
    });

  } catch (error) {
    console.error('[CNAE ERROR]', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao listar CNAEs',
      details: error.message
    });
  }
});

// ============================================
// INTELLIGENCE PROXY ENDPOINTS
// ============================================

/**
 * POST /api/companies/intelligence
 * Proxy to Python intelligence API (full pipeline)
 */
router.post('/intelligence', async (req, res) => {
  try {
    const result = await proxyToIntelligence('/api/intelligence/query', req.body);
    return res.json(result);
  } catch (error) {
    logger.error('intelligence_proxy_error', { error: error.message });
    res.status(500).json({ error: 'Erro na inteligência', details: error.message });
  }
});

/**
 * POST /api/companies/intelligence/classify
 * Proxy to Python intent classification
 */
router.post('/intelligence/classify', async (req, res) => {
  try {
    const result = await proxyToIntelligence('/api/intelligence/classify', req.body);
    return res.json(result);
  } catch (error) {
    logger.error('intelligence_classify_error', { error: error.message });
    res.status(500).json({ error: 'Erro na classificação', details: error.message });
  }
});

// ============================================
// HYBRID SEARCH ENDPOINTS
// ============================================

/**
 * POST /api/companies/search/hybrid
 * Hybrid search combining text, vector, and relational signals with RRF
 */
router.post('/search/hybrid', validateBody(hybridSearchSchema), async (req, res) => {
  const startTime = Date.now();
  try {
    const { query, mode, filters, limit } = req.body;

    const result = await hybridSearch({ query, filters, mode, limit });

    return res.json({
      success: true,
      query,
      mode,
      total: result.results.length,
      results: result.results,
      signals: result.signals,
      timing: result.timing,
      durationMs: Date.now() - startTime
    });
  } catch (error) {
    logger.error('hybrid_search_error', { error: error.message });
    res.status(500).json({ error: 'Erro na busca híbrida', details: error.message });
  }
});

/**
 * GET /api/companies/search/stream
 * SSE streaming search with progressive results
 */
router.get('/search/stream', validateQuery(streamSearchSchema), async (req, res) => {
  try {
    const { q, limit, cidade, estado } = req.query;

    await executeStreamingSearch(res, {
      query: q,
      filters: { cidade, estado },
      limit
    });
  } catch (error) {
    logger.error('stream_search_error', { error: error.message });
    // If headers already sent (SSE started), we can't send JSON error
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro no streaming de busca', details: error.message });
    }
  }
});

/**
 * GET /api/companies/:id/sis
 * Get Strategic Impact Score for a company
 */
router.get('/:id/sis', async (req, res) => {
  const startTime = Date.now();
  try {
    const { id } = req.params;

    const sis = await calculateSIS(id);

    if (!sis) {
      return res.status(404).json({ error: 'SIS score não encontrado' });
    }

    return res.json({
      success: true,
      empresa_id: id,
      ...sis,
      durationMs: Date.now() - startTime
    });
  } catch (error) {
    logger.error('sis_error', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Erro ao calcular SIS', details: error.message });
  }
});

// ============================================
// GRAPH ENDPOINTS
// ============================================

/**
 * GET /api/companies/:id/relationships
 * Get direct (1-hop) relationships for a company
 */
router.get('/:id/relationships', validateQuery(relationshipsQuerySchema), async (req, res) => {
  const startTime = Date.now();
  try {
    const { id } = req.params;
    const { tipo_relacao, min_strength, limit } = req.query;

    const result = await getDirectRelationships('empresa', id, {
      tipo_relacao,
      min_strength,
      limit
    });

    return res.json({
      success: true,
      empresa_id: id,
      ...result,
      durationMs: Date.now() - startTime
    });
  } catch (error) {
    logger.error('relationships_error', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Erro ao buscar relacionamentos', details: error.message });
  }
});

/**
 * GET /api/companies/:id/network
 * Get multi-hop network graph for a company
 */
router.get('/:id/network', validateQuery(networkQuerySchema), async (req, res) => {
  const startTime = Date.now();
  try {
    const { id } = req.params;
    const { hops, limit } = req.query;

    const result = await getNetworkGraph('empresa', id, hops, limit);

    return res.json({
      success: true,
      empresa_id: id,
      ...result,
      durationMs: Date.now() - startTime
    });
  } catch (error) {
    logger.error('network_error', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Erro ao buscar rede', details: error.message });
  }
});

/**
 * GET /api/companies/:id/network-stats
 * Get aggregated network statistics for a company
 */
router.get('/:id/network-stats', async (req, res) => {
  const startTime = Date.now();
  try {
    const { id } = req.params;

    const stats = await getNetworkStats('empresa', id);

    return res.json({
      success: true,
      empresa_id: id,
      ...stats,
      durationMs: Date.now() - startTime
    });
  } catch (error) {
    logger.error('network_stats_error', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Erro ao buscar estatísticas da rede', details: error.message });
  }
});

export default router;
