import { Router } from 'express';
import * as serper from '../services/serper.js';
import * as perplexity from '../services/perplexity.js';
import * as brasilapi from '../services/brasilapi.js';
import * as apollo from '../services/apollo.js';
import * as cnpja from '../services/cnpja.js';
import { supabase, insertCompany, insertPerson, insertTransacaoEmpresa, insertRegimeTributario, insertInferenciaLimites, insertRegimeHistorico, findCompanyByCnpj, listCompanies, getCompanyFullData, updateInferenciaLimites, registerDataSource, checkExistingCnpjs } from '../database/supabase.js';
import { calcularInferenciaVAR, getPesosVAR, getLimitesRegime } from '../services/var_inference.js';
import { LINKEDIN_STATUS, DATA_SOURCES } from '../constants.js';
import { searchCompanySchema, detailsCompanySchema, sociosSchema, approveCompanySchema, recalculateSchema, validateBody } from '../validation/schemas.js';
import logger from '../utils/logger.js';

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
 * Search for company by name and optional city, return candidates with CNPJ
 */
router.post('/search', validateBody(searchCompanySchema), async (req, res) => {
  const requestId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startTime = Date.now();
  try {
    const { nome, cidade, segmento, regime } = req.body;

    // Build search query from available fields
    const queryParts = [];
    if (nome) queryParts.push(nome);
    if (cidade) queryParts.push(cidade);
    if (segmento) queryParts.push(segmento);
    if (regime) queryParts.push(regime);

    // Use nome for primary search, others for context
    const searchName = nome || queryParts[0];
    const searchCity = cidade || null;

    logger.info('External search started', {
      requestId,
      source: 'external',
      filters: { nome, cidade, segmento, regime },
      searchName,
      searchCity
    });

    // 1. First try: Serper (Google search)
    let candidates = await serper.searchCompanyByName(searchName, searchCity);
    let searchSource = 'serper';

    // 2. Fallback: Perplexity AI (if Serper found nothing)
    if (candidates.length === 0) {
      console.log(`[SEARCH] Serper não encontrou. Tentando Perplexity...`);
      candidates = await perplexity.searchCompanyByName(searchName, searchCity);
      searchSource = 'perplexity';
    }

    // 3. Fallback: Serper with full query
    if (candidates.length === 0) {
      console.log(`[SEARCH] Perplexity não encontrou. Tentando Serper com query completa...`);
      const fullQuery = `${queryParts.join(' ')} CNPJ empresa`;
      const exactResults = await serper.search(fullQuery, 20);

      // Extract CNPJs from exact search
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

    if (candidates.length === 0) {
      return res.json({
        found: false,
        message: 'Nenhuma empresa encontrada com este nome',
        candidates: [],
        sources_tried: ['serper', 'perplexity', 'serper_exact']
      });
    }

    // Also search internal database (dim_empresas) - non-blocking
    let internalResults = [];
    try {
      const { data: internalData } = await listCompanies({ nome: searchName, cidade: searchCity, limit: 10 });
      internalResults = internalData;
    } catch (err) {
      console.warn('[SEARCH] Internal DB search failed:', err.message);
    }
    const internalCnpjs = new Set(internalResults.map(r => r.cnpj));

    // Add internal results as candidates (marked as 'interno')
    const internalCandidates = internalResults.map(r => ({
      cnpj: r.cnpj,
      cnpj_formatted: `${r.cnpj.slice(0,2)}.${r.cnpj.slice(2,5)}.${r.cnpj.slice(5,8)}/${r.cnpj.slice(8,12)}-${r.cnpj.slice(12)}`,
      razao_social: r.razao_social,
      nome_fantasia: r.nome_fantasia,
      localizacao: r.cidade && r.estado ? `${r.cidade} - ${r.estado}` : null,
      fonte: 'interno'
    }));

    // Enrich external candidates with city from BrasilAPI (limit to 10 for performance)
    const limitedCandidates = candidates.slice(0, 10);
    console.log(`[SEARCH] Enriquecendo ${limitedCandidates.length} candidatos com cidade da Receita Federal`);

    const enrichedCandidates = await Promise.all(
      limitedCandidates.map(async (c) => {
        // Check if this CNPJ is already in our database
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
          console.warn(`[SEARCH] Erro ao buscar cidade para ${c.cnpj}:`, err.message);
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

    // Merge: internal first (dedup by CNPJ), then external
    const seenFinal = new Set();
    const allCandidates = [];
    for (const c of internalCandidates) {
      if (!seenFinal.has(c.cnpj)) {
        seenFinal.add(c.cnpj);
        allCandidates.push(c);
      }
    }
    for (const c of enrichedCandidates) {
      if (!seenFinal.has(c.cnpj)) {
        seenFinal.add(c.cnpj);
        allCandidates.push(c);
      }
    }

    const durationMs = Date.now() - startTime;
    logger.info('External search completed', {
      requestId,
      source: 'external',
      filters: { nome, cidade, segmento, regime },
      durationMs,
      returnedCount: allCandidates.length,
      internalCount: internalCandidates.length,
      externalCount: enrichedCandidates.length,
      searchSource
    });

    if (allCandidates.length === 1) {
      return res.json({
        found: true,
        single_match: true,
        message: 'Empresa encontrada. Selecione para ver detalhes.',
        company: allCandidates[0],
        requestId,
        source: 'external',
        durationMs
      });
    }

    return res.json({
      found: true,
      single_match: false,
      message: `${allCandidates.length} empresas encontradas. Selecione a correta.`,
      candidates: allCandidates,
      requestId,
      source: 'external',
      durationMs,
      searchSource,
      limits: {
        serperMaxResults: 20,
        enrichmentLimit: 10,
        note: 'Serper retorna max 20 resultados orgânicos, enriquecimento BrasilAPI limitado a 10 candidatos'
      }
    });

  } catch (error) {
    logger.error('External search failed', {
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

    console.log(`[APPROVED] Empresa ${cleanCnpj} aprovada por ${aprovado_por} com ${insertedSocios.length} socios`);

    return res.json({
      success: true,
      message: 'Empresa aprovada e cadastrada com sucesso',
      empresa: insertedCompany,
      socios: insertedSocios
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
router.get('/list', async (req, res) => {
  const requestId = `list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startTime = Date.now();
  try {
    const { nome, cidade, segmento, regime, limit, offset } = req.query;

    const filters = {
      limit: limit && !isNaN(parseInt(limit)) ? Math.min(parseInt(limit), 200) : 100,
      offset: offset && !isNaN(parseInt(offset)) ? parseInt(offset) : 0
    };
    if (nome) filters.nome = nome;
    if (cidade) filters.cidade = cidade;

    const { data: companies, total } = await listCompanies(filters);

    const durationMs = Date.now() - startTime;
    logger.info('DB search completed', {
      requestId,
      source: 'db',
      filters: { nome, cidade, segmento, regime },
      page: Math.floor(filters.offset / filters.limit) + 1,
      pageSize: filters.limit,
      offset: filters.offset,
      durationMs,
      returnedCount: companies.length,
      totalEstimate: total
    });

    return res.json({
      success: true,
      count: companies.length,
      total,
      empresas: companies,
      offset: filters.offset,
      limit: filters.limit,
      requestId,
      source: 'db',
      durationMs
    });
  } catch (error) {
    logger.error('List search failed', {
      requestId,
      error: error.message,
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

export default router;
