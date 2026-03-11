import { Router } from 'express';
import { supabase, enrichCompanyRows, resolveCodigosIbge } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { searchPerson as searchPersonApollo } from '../services/apollo.js';
import { searchPerson as searchPersonPerplexity } from '../services/perplexity.js';
import { search as serperSearch, findPersonLinkedin } from '../services/serper.js';
import { validateBody } from '../validation/schemas.js';
import { searchPersonByCpfSchema, searchPersonV2Schema, saveBatchSchema } from '../validation/schemas.js';
import { runGuardrail, maskCpf } from '../services/people-guardrail.js';
import { analyzeQuery, estimateCardinality, rankResults, buildRefinementResponse, logEvidence } from '../services/search-orchestrator.js';
import { runQualityGate } from '../services/quality-gate.js';
import { escapeLike, maskPII } from '../utils/sanitize.js';

const router = Router();

/**
 * Parse a localizacao string like "São Paulo - SP" or "São Paulo, SP, Brasil"
 * into { cidade, estado, pais }.
 */
function parseLocalizacao(localizacao) {
  if (!localizacao) return { cidade: null, estado: null, pais: 'Brasil' };

  const cleaned = localizacao.trim();
  // Try "Cidade - UF" or "Cidade, UF" patterns
  const match = cleaned.match(/^([^,\-–]+?)\s*[-–,]\s*([A-Z]{2})\b/i);
  if (match) {
    return {
      cidade: match[1].trim(),
      estado: match[2].toUpperCase(),
      pais: 'Brasil',
    };
  }

  // Fallback: if it looks like just a state abbreviation
  if (/^[A-Z]{2}$/.test(cleaned)) {
    return { cidade: null, estado: cleaned, pais: 'Brasil' };
  }

  // Fallback: treat entire string as cidade
  return { cidade: cleaned, estado: null, pais: 'Brasil' };
}

/**
 * GET /api/people/list
 * List all people in the database
 */
router.get('/list', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    const { data, error, count } = await supabase
      .from('dim_pessoas')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error('Error listing people', { error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count: count,
      people: data
    });

  } catch (error) {
    logger.error('Error listing people', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/people/list-enriched
 * List people with joined empresa data (nome, empresa, cidade, CNAE, telefone)
 */
router.get('/list-enriched', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const offset = parseInt(req.query.offset) || 0;
    const search = (req.query.search || '').trim();
    const normalizeCompanyNameKey = (value) =>
      String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\b(ltda|limitada|s a|sa|me|epp|eireli|holding|participacoes)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const getApolloCompanyName = (rawApollo) =>
      rawApollo?.organization_name ||
      rawApollo?.organization?.name ||
      rawApollo?.employment_history?.[0]?.organization_name ||
      '';
    const getApolloPhone = (rawApollo) => {
      const phones = rawApollo?.phone_numbers;
      if (Array.isArray(phones)) {
        return phones.find(Boolean) || '';
      }
      return typeof phones === 'string' ? phones : '';
    };

    // 1. Fetch pessoas (avoid full table scan on 22M rows)
    let pessoasQuery = supabase
      .from('dim_pessoas')
      .select('*')
      .order('nome_completo', { ascending: true });

    if (search.length >= 2) {
      const escaped = escapeLike(search);
      pessoasQuery = pessoasQuery.ilike('nome_completo', `%${escaped}%`);
    }

    const { data: pessoas, error: pessoasError } = await pessoasQuery
      .limit(limit)
      .range(offset, offset + limit - 1);
    const count = pessoas?.length || 0;

    if (pessoasError) {
      logger.error('Error listing enriched people', { error: pessoasError.message });
      return res.status(500).json({ success: false, error: pessoasError.message });
    }

    if (!pessoas || pessoas.length === 0) {
      return res.json({ success: true, count: 0, people: [] });
    }

    const fallbackCompanyNames = [
      ...new Set(
        pessoas
          .map((p) => getApolloCompanyName(p.raw_apollo_data))
          .filter(Boolean)
      ),
    ];

    // 2. Fetch transactions with empresa data for all pessoa IDs
    const personIds = pessoas.map(p => p.id);
    const { data: transactions } = await supabase
      .from('fato_transacao_empresas')
      .select(`
        empresa_id,
        pessoa_id,
        cargo,
        qualificacao,
        dim_empresas (
          id,
          cnpj,
          razao_social,
          nome_fantasia,
          cidade,
          estado,
          situacao_cadastral,
          cep,
          codigo_ibge,
          fonte,
          cnae_id,
          telefone_1
        )
      `)
      .in('pessoa_id', personIds)
      .order('data_transacao', { ascending: false });

    // 2b. Fallback company lookup by exact company name from raw_apollo_data
    const fallbackBaseCompanies = [];
    if (fallbackCompanyNames.length > 0) {
      const [byRazaoSocial, byNomeFantasia] = await Promise.all([
        supabase
          .from('dim_empresas')
          .select('id, cnpj, razao_social, nome_fantasia, cidade, estado, situacao_cadastral, cep, codigo_ibge, fonte, cnae_id, telefone_1')
          .in('razao_social', fallbackCompanyNames),
        supabase
          .from('dim_empresas')
          .select('id, cnpj, razao_social, nome_fantasia, cidade, estado, situacao_cadastral, cep, codigo_ibge, fonte, cnae_id, telefone_1')
          .in('nome_fantasia', fallbackCompanyNames),
      ]);

      fallbackBaseCompanies.push(...(byRazaoSocial.data || []), ...(byNomeFantasia.data || []));
    }

    const transactionCompanies = (transactions || [])
      .map((tx) => tx.dim_empresas)
      .filter(Boolean);
    const enrichedCompanies = await enrichCompanyRows([
      ...transactionCompanies,
      ...fallbackBaseCompanies,
    ]);

    const companyLookupById = new Map();
    const companyLookupByName = new Map();
    for (const company of enrichedCompanies) {
      if (company.id) companyLookupById.set(company.id, company);

      const fantasiaKey = normalizeCompanyNameKey(company.nome_fantasia);
      const razaoKey = normalizeCompanyNameKey(company.razao_social);
      if (fantasiaKey) companyLookupByName.set(fantasiaKey, company);
      if (razaoKey) companyLookupByName.set(razaoKey, company);
    }

    // Build latest transaction map (one empresa per pessoa)
    const latestTx = {};
    for (const tx of (transactions || [])) {
      if (!latestTx[tx.pessoa_id]) {
        latestTx[tx.pessoa_id] = tx;
      }
    }

    // 3. Resolve codigo_ibge → cidade/estado via iconsaiBrasil
    const ibgeCodes = enrichedCompanies
      .map(c => c.codigo_ibge)
      .filter(Boolean);
    const ibgeMap = await resolveCodigosIbge(ibgeCodes);

    // 4. Build enriched list
    const enriched = pessoas.map(p => {
      const tx = latestTx[p.id];
      const rawApollo = p.raw_apollo_data || {};
      const fallbackCompanyName = getApolloCompanyName(rawApollo);
      const txCompanyId = tx?.dim_empresas?.id || tx?.empresa_id || null;
      const fallbackCompany = companyLookupByName.get(normalizeCompanyNameKey(fallbackCompanyName)) || {};
      const emp = companyLookupById.get(txCompanyId) || fallbackCompany || {};
      const apolloPhone = getApolloPhone(rawApollo);
      const empIbge = String(emp.codigo_ibge || '');
      const geo = ibgeMap.get(empIbge) || {};
      return {
        id: p.id,
        nome: p.nome_completo || p.primeiro_nome || '',
        empresa: p.empresa_atual_nome || emp.nome_fantasia || emp.razao_social || fallbackCompanyName || '',
        cargo: tx?.cargo || tx?.qualificacao || '',
        codigo_ibge: p.codigo_ibge || emp.codigo_ibge || '',
        cidade: p.cidade || emp.cidade || geo.nome || rawApollo.city || '',
        estado: p.estado || emp.estado || geo.uf || rawApollo.state || '',
        cnae: emp.cnae_principal || emp.cnae_id || '',
        descricao: emp.cnae_descricao || '',
        cnae_descricao: emp.cnae_descricao || '',
        email: p.email || rawApollo.email || '',
        phone: p.telefone || apolloPhone || emp.telefone_1 || '',
        telefone: p.telefone || apolloPhone || emp.telefone_1 || '',
      };
    });

    res.json({
      success: true,
      count: count,
      people: enriched
    });

  } catch (error) {
    logger.error('Error listing enriched people', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/people/credit-bureaus
 * Return information about credit bureau integrations
 */
router.get('/credit-bureaus', async (req, res) => {
  res.json({
    success: true,
    available: false,
    message: 'Integração com bureaus de crédito requer contrato comercial',
    bureaus: [
      {
        nome: 'Serasa Experian',
        status: 'nao_integrado',
        tipo: 'bureau_credito',
        api: 'https://api.serasaexperian.com.br',
        documentacao: 'https://developers.serasaexperian.com.br',
        requisitos: ['Contrato comercial', 'CNPJ ativo', 'Finalidade declarada'],
        servicos: ['Score de crédito', 'Negativações', 'Protestos', 'Cheques devolvidos']
      },
      {
        nome: 'Boa Vista SCPC',
        status: 'nao_integrado',
        tipo: 'bureau_credito',
        api: 'https://api.boavistaservicos.com.br',
        documentacao: 'https://developers.boavistaservicos.com.br',
        requisitos: ['Contrato comercial', 'CNPJ ativo', 'Finalidade declarada'],
        servicos: ['Score de crédito', 'Restritivos', 'Protestos']
      },
      {
        nome: 'SPC Brasil',
        status: 'nao_integrado',
        tipo: 'bureau_credito',
        api: 'https://ws.spcbrasil.org.br',
        documentacao: 'https://www.spcbrasil.org.br/servicos-para-voce',
        requisitos: ['Afiliação CDL local', 'Contrato comercial'],
        servicos: ['Consulta débitos', 'Score', 'Protestos', 'Ações judiciais']
      },
      {
        nome: 'Quod',
        status: 'nao_integrado',
        tipo: 'bureau_credito',
        api: 'https://api.quod.com.br',
        documentacao: 'https://quod.com.br/para-empresas',
        requisitos: ['Contrato comercial', 'Integração técnica'],
        servicos: ['Score positivo', 'Histórico de pagamentos', 'Cadastro Positivo']
      }
    ],
    nota: 'Para integrar com bureaus de crédito é necessário estabelecer contrato comercial com cada provedor. Os dados de crédito estão sujeitos à LGPD e requerem consentimento do titular ou finalidade legítima.'
  });
});

/**
 * GET /api/people/:id
 * Get person details by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get person data from dim_pessoas
    const { data: pessoa, error: pessoaError } = await supabase
      .from('dim_pessoas')
      .select('*')
      .eq('id', id)
      .single();

    if (pessoaError || !pessoa) {
      return res.status(404).json({ success: false, error: 'Pessoa não encontrada' });
    }

    // Get relations from dim_pessoas
    const { data: relacoes } = await supabase
      .from('dim_pessoas')
      .select('*')
      .eq('pessoa_id', id)
      .order('created_at', { ascending: false });

    // Get company relationships
    const { data: empresas } = await supabase
      .from('fato_transacao_empresas')
      .select(`
        id,
        tipo_transacao,
        cargo,
        qualificacao,
        data_transacao,
        dim_empresas (
          id,
          cnpj,
          razao_social,
          nome_fantasia,
          cidade,
          estado
        )
      `)
      .eq('pessoa_id', id)
      .order('data_transacao', { ascending: false });

    res.json({
      success: true,
      pessoa,
      relacoes: relacoes || [],
      empresas: empresas || []
    });

  } catch (error) {
    logger.error('Error getting person', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/people/by-company/:empresaId
 * Get people related to a company
 */
router.get('/by-company/:empresaId', async (req, res) => {
  try {
    const { empresaId } = req.params;

    const { data, error } = await supabase
      .from('fato_transacao_empresas')
      .select(`
        tipo_transacao,
        cargo,
        qualificacao,
        data_transacao,
        ativo,
        dim_pessoas (*)
      `)
      .eq('empresa_id', empresaId)
      .order('data_transacao', { ascending: false });

    if (error) {
      logger.error('Error fetching company people', { error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count: data.length,
      people: data.map(item => ({
        ...item.dim_pessoas,
        tipo_transacao: item.tipo_transacao,
        cargo: item.cargo,
        qualificacao: item.qualificacao,
        data_transacao: item.data_transacao,
        ativo: item.ativo
      }))
    });

  } catch (error) {
    logger.error('Error fetching company people', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/people/search
 * Search people by name
 */
router.post('/search', async (req, res) => {
  try {
    const { nome } = req.body;

    if (!nome || nome.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Nome é obrigatório (mínimo 2 caracteres)'
      });
    }

    // Search in dim_pessoas by name (22M rows — avoid full scan)
    const upperNome = nome.trim().toUpperCase();
    const escapedNome = escapeLike(upperNome);
    let pessoaQuery = supabase.from('dim_pessoas').select('*');
    pessoaQuery = pessoaQuery.ilike('nome_completo', `%${escapedNome}%`);
    const { data, error } = await pessoaQuery.limit(20);

    if (error) {
      logger.error('Error searching people', { error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count: data.length,
      people: data
    });

  } catch (error) {
    logger.error('Error searching people', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/people/search-cpf
 * Search for person by CPF and/or nome using LinkedIn (Apollo) and Perplexity
 */
router.post('/search-cpf', validateBody(searchPersonByCpfSchema), async (req, res) => {
  try {
    const { cpf, nome } = req.body;
    const hasCpf = cpf && cpf.length === 11;
    const hasNome = nome && nome.trim().length >= 2;
    const sourcesTried = [];

    logger.info('Searching person', {
      cpf: hasCpf ? `***${cpf.slice(-4)}` : null,
      nome: hasNome ? maskPII(nome) : null
    });

    // =============================================
    // PRE-CHECK: Single name (no surname) without CPF
    // → Search DB first, avoid expensive external calls
    // =============================================
    const nameHasSpace = hasNome && nome.trim().includes(' ');

    if (hasNome && !nameHasSpace && !hasCpf) {
      const nameTrimmed = nome.trim();

      const upperName = nameTrimmed.toUpperCase();
      const escapedName = escapeLike(upperName);
      let cpfNameQuery = supabase.from('dim_pessoas').select('*');
      cpfNameQuery = cpfNameQuery.ilike('nome_completo', `%${escapedName}%`);
      const { data: dbMatches, error: dbError } = await cpfNameQuery.limit(10);

      if (!dbError && dbMatches && dbMatches.length > 0) {
        // Enrich with latest company/cargo per person
        const personIds = dbMatches.map(p => p.id);
        const { data: transactions } = await supabase
          .from('fato_transacao_empresas')
          .select(`
            pessoa_id,
            cargo,
            qualificacao,
            dim_empresas (
              razao_social,
              nome_fantasia
            )
          `)
          .in('pessoa_id', personIds)
          .order('data_transacao', { ascending: false });

        const latestTx = {};
        for (const tx of (transactions || [])) {
          if (!latestTx[tx.pessoa_id]) {
            latestTx[tx.pessoa_id] = tx;
          }
        }

        const enrichedMatches = dbMatches.map(p => {
          const tx = latestTx[p.id];
          return {
            ...p,
            cargo_atual: tx?.cargo || tx?.qualificacao || null,
            empresa_atual: tx?.dim_empresas?.nome_fantasia || tx?.dim_empresas?.razao_social || null
          };
        });

        logger.info('Single name pre-check: DB matches found', { nome: maskPII(nameTrimmed), count: enrichedMatches.length });
        return res.json({
          success: true,
          preliminary: true,
          db_matches: enrichedMatches,
          source: 'database',
          found: false,
          pessoa: null
        });
      }

      // No matches in DB → ask for surname
      logger.info('Single name pre-check: no DB matches, requesting surname', { nome: maskPII(nameTrimmed) });
      return res.json({
        success: true,
        needs_surname: true,
        source: 'none',
        found: false,
        pessoa: null,
        message: `Não encontramos "${nameTrimmed}" no banco de dados. Informe o nome completo (nome e sobrenome) para buscar em fontes externas.`
      });
    }

    // =============================================
    // 1. Search internal database (dim_pessoas)
    // =============================================
    sourcesTried.push('database');
    let existingPerson = null;

    if (hasCpf) {
      const { data, error } = await supabase
        .from('dim_pessoas')
        .select('*')
        .eq('cpf', cpf)
        .single();
      if (data && !error) existingPerson = data;
    }

    if (!existingPerson && hasNome) {
      const upperNomeCpf = nome.trim().toUpperCase();
      const escapedNomeCpf = escapeLike(upperNomeCpf);
      let fallbackQuery = supabase.from('dim_pessoas').select('*');
      fallbackQuery = fallbackQuery.ilike('nome_completo', `%${escapedNomeCpf}%`);
      const { data, error } = await fallbackQuery.limit(1).single();
      if (data && !error) existingPerson = data;
    }

    if (existingPerson) {
      logger.info('Person found in database', { id: existingPerson.id });
      return res.json({
        success: true,
        source: 'database',
        found: true,
        pessoa: existingPerson,
        message: 'Pessoa encontrada no banco de dados'
      });
    }

    // =============================================
    // 2. Search via Perplexity AI (online search)
    // =============================================
    sourcesTried.push('perplexity');
    let perplexityResult = null;
    try {
      perplexityResult = await searchPersonPerplexity(nome || 'pessoa', hasCpf ? cpf : null);
      logger.info('Perplexity result', {
        success: perplexityResult?.success,
        found: perplexityResult?.found,
        error: perplexityResult?.error || null
      });
    } catch (err) {
      logger.error('Perplexity search failed', { error: err.message });
    }

    if (perplexityResult?.success && perplexityResult?.found && perplexityResult?.pessoa) {
      logger.info('Person found via Perplexity', { nome: maskPII(perplexityResult.pessoa.nome_completo) });

      // Enrich with Apollo
      let apolloData = null;
      if (perplexityResult.pessoa.empresa_atual && perplexityResult.pessoa.nome_completo) {
        try {
          apolloData = await searchPersonApollo(
            perplexityResult.pessoa.nome_completo,
            perplexityResult.pessoa.empresa_atual
          );
        } catch (err) {
          logger.warn('Apollo enrichment failed', { error: err.message });
        }
      }

      return res.json({
        success: true,
        source: 'perplexity',
        found: true,
        pessoa: {
          cpf: cpf,
          nome_completo: perplexityResult.pessoa.nome_completo,
          cargo_atual: perplexityResult.pessoa.cargo_atual,
          empresa_atual: perplexityResult.pessoa.empresa_atual,
          linkedin_url: apolloData?.linkedin || perplexityResult.pessoa.linkedin_url,
          email: apolloData?.email || perplexityResult.pessoa.email,
          localizacao: perplexityResult.pessoa.localizacao,
          resumo_profissional: perplexityResult.pessoa.resumo_profissional,
          foto_url: apolloData?.photo_url || null
        },
        experiencias: perplexityResult.experiencias,
        fontes: perplexityResult.fontes,
        apollo_enriched: !!apolloData,
        sources_tried: sourcesTried
      });
    }

    // =============================================
    // 3. Fallback: Search via Serper (Google) + Apollo
    // =============================================
    if (hasNome) {
      sourcesTried.push('serper');
      try {
        const searchName = nome.trim();

        // Google search for person info
        const googleResults = await serperSearch(
          `"${searchName}" Brasil profissional LinkedIn cargo empresa`,
          10
        );

        const kg = googleResults.knowledgeGraph || {};
        const organic = googleResults.organic || [];

        // Try to find LinkedIn via Serper
        let linkedinUrl = null;
        try {
          linkedinUrl = await findPersonLinkedin(searchName);
        } catch (err) {
          logger.warn('Serper LinkedIn search failed', { error: err.message });
        }

        // Extract info from knowledge graph and organic results
        let empresa = kg.organization || kg.company || null;
        let cargo = kg.title || kg.jobTitle || null;
        let descricao = kg.description || null;
        let localizacao = null;

        // Parse organic results for additional info
        for (const item of organic.slice(0, 5)) {
          const text = `${item.title || ''} ${item.snippet || ''}`;

          // Try to extract company from LinkedIn snippets
          if (!empresa && item.link?.includes('linkedin.com')) {
            const match = text.match(/(?:at|na|em|@)\s+([A-ZÀ-Ú][A-Za-zÀ-ú\s&.,-]+?)(?:\s*[-–|·]|\s*$)/i);
            if (match) empresa = match[1].trim();
          }

          // Try to extract title/cargo
          if (!cargo && item.link?.includes('linkedin.com')) {
            const match = text.match(/[-–]\s*([A-Za-zÀ-ú\s,]+?)(?:\s*[-–|·]|\s*at\s|\s*na\s|\s*em\s)/i);
            if (match && match[1].length < 80) cargo = match[1].trim();
          }

          // Build description from snippets
          if (!descricao && item.snippet && item.snippet.length > 30) {
            descricao = item.snippet;
          }

          // Location
          if (!localizacao) {
            const locMatch = text.match(/([A-Za-zÀ-ú]+(?:\s+[A-Za-zÀ-ú]+)?)\s*[-,]\s*([A-Z]{2})\b/);
            if (locMatch) localizacao = `${locMatch[1]} - ${locMatch[2]}`;
          }
        }

        // Try Apollo for enrichment if we have enough info
        sourcesTried.push('apollo');
        let apolloData = null;
        try {
          if (empresa) {
            apolloData = await searchPersonApollo(searchName, empresa);
          }
        } catch (err) {
          logger.warn('Apollo search failed', { error: err.message });
        }

        // Build person from combined sources
        const hasData = empresa || cargo || linkedinUrl || apolloData || descricao;

        if (hasData) {
          logger.info('Person found via Serper+Apollo', { nome: maskPII(searchName), empresa, cargo });

          const fontes = organic.slice(0, 3).map(o => o.link).filter(Boolean);

          return res.json({
            success: true,
            source: 'serper',
            found: true,
            pessoa: {
              cpf: cpf || null,
              nome_completo: apolloData?.name || searchName,
              cargo_atual: apolloData?.title || cargo,
              empresa_atual: apolloData?.company?.name || empresa,
              linkedin_url: apolloData?.linkedin || linkedinUrl,
              email: apolloData?.email || null,
              localizacao: localizacao || (apolloData ? `${apolloData.city || ''} ${apolloData.state || ''}`.trim() : null),
              resumo_profissional: descricao,
              foto_url: apolloData?.photo_url || null
            },
            experiencias: [],
            fontes,
            apollo_enriched: !!apolloData,
            sources_tried: sourcesTried
          });
        }
      } catch (err) {
        logger.error('Serper search failed', { error: err.message });
      }
    }

    // =============================================
    // 4. Not found in any source
    // =============================================
    const errors = [];
    if (perplexityResult?.error) errors.push(`Perplexity: ${perplexityResult.error}`);

    logger.info('Person not found in any source', {
      cpf: hasCpf ? `***${cpf.slice(-4)}` : null,
      nome: hasNome ? maskPII(nome) : null,
      sources_tried: sourcesTried
    });

    return res.json({
      success: true,
      source: 'none',
      found: false,
      pessoa: null,
      message: `Pessoa não encontrada. Fontes consultadas: ${sourcesTried.join(', ')}`,
      sources_tried: sourcesTried,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    logger.error('Error searching person by CPF', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/people/save
 * Save a person to the database
 */
router.post('/save', async (req, res) => {
  try {
    const { pessoa, experiencias, aprovado_por } = req.body;

    if (!pessoa || !pessoa.nome_completo) {
      return res.status(400).json({
        success: false,
        error: 'Dados da pessoa são obrigatórios'
      });
    }

    logger.info('Saving person', { nome: maskPII(pessoa.nome_completo), aprovado_por });

    // Normalize CPF: remove non-digits
    const normalizedCpf = pessoa.cpf ? String(pessoa.cpf).replace(/[^\d]/g, '') : null;
    const cleanCpf = normalizedCpf && normalizedCpf.length === 11 ? normalizedCpf : null;

    // Check if person already exists by CPF in dim_pessoas
    if (cleanCpf) {
      const { data: existing } = await supabase
        .from('dim_pessoas')
        .select('id')
        .eq('cpf', cleanCpf)
        .single();

      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'Pessoa já cadastrada com este CPF',
          pessoa_id: existing.id
        });
      }
    }

    // Insert person into dim_pessoas (CPF already normalized above)
    const nomeParts = pessoa.nome_completo?.split(' ') || [];
    const loc = parseLocalizacao(pessoa.localizacao);
    const { data: novaPessoa, error: pessoaError } = await supabase
      .from('dim_pessoas')
      .insert({
        nome_completo: pessoa.nome_completo,
        primeiro_nome: nomeParts[0] || null,
        sobrenome: nomeParts.length > 1 ? nomeParts.slice(1).join(' ') : null,
        cpf: cleanCpf,
        email: pessoa.email || null,
        linkedin_url: pessoa.linkedin_url || null,
        foto_url: pessoa.foto_url || null,
        codigo_ibge: pessoa.codigo_ibge || null,
        codigo_ibge_uf: pessoa.codigo_ibge_uf || null,
        pais: loc.pais,
        cargo_atual: pessoa.cargo_atual || null,
        empresa_atual_nome: pessoa.empresa_atual || null,
        sobre: pessoa.resumo_profissional || null,
        telefone: pessoa.telefone || null,
        headline: pessoa.headline || null,
        senioridade: pessoa.senioridade || null,
        departamento: pessoa.departamento || null,
        twitter_url: pessoa.twitter_url || null,
        fonte: pessoa._provider || 'external',
        raw_apollo_data: pessoa.raw_apollo_data || null
      })
      .select()
      .single();

    if (pessoaError) {
      logger.error('Error saving person', { error: pessoaError.message });
      return res.status(500).json({ success: false, error: pessoaError.message });
    }

    // Insert relations into dim_pessoas if experiences provided
    if (experiencias && experiencias.length > 0) {
      const relacoesToInsert = experiencias.map(exp => ({
        pessoa_id: novaPessoa.id,
        tipo_relacao: 'experiencia_profissional',
        ano: exp.periodo ? parseInt(exp.periodo.match(/\d{4}/)?.[0]) || null : null
      }));

      const { error: relacoesError } = await supabase
        .from('dim_pessoas')
        .insert(relacoesToInsert);

      if (relacoesError) {
        logger.warn('Error saving relations', { error: relacoesError.message });
      }
    }

    logger.info('Person saved successfully', { id: novaPessoa.id });

    res.json({
      success: true,
      pessoa: novaPessoa,
      message: 'Pessoa cadastrada com sucesso'
    });

  } catch (error) {
    logger.error('Error saving person', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// V2 ENDPOINTS (Guardrail + Pagination + Batch)
// =============================================

/**
 * POST /api/people/search-v2
 * Search person with orchestrator (query analysis + cardinality + guardrail),
 * server-side pagination, federated search, ranking, and evidence logging.
 */
router.post('/search-v2', validateBody(searchPersonV2Schema), async (req, res) => {
  const startTime = Date.now();
  const requestId = `ppl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const plog = logger.child({ requestId });

  try {
    const { searchType, cpf, nome, dataNascimento, cidadeUf, page, pageSize } = req.body;

    plog.info('search-v2 request', {
      searchType,
      cpf: cpf ? maskCpf(cpf) : null,
      nome: nome || null,
      page,
      pageSize
    });

    // No restrictions — any name, any length, any format is accepted.
    // Always allowed. Normalize name with basic capitalization only.
    const normalizedNome = nome
      ? nome.trim()
          .toLowerCase()
          .replace(/\b(\w)/g, (_, c) => c.toUpperCase())
          .replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase())
      : '';

    const guardrail = {
      allowed: true,
      reason: 'Busca livre — sem restricoes',
      requiredFields: [],
      normalizedQuery: searchType === 'cpf' ? (cpf || '') : normalizedNome,
      durationMs: 0
    };

    const sourcesTried = [];
    const offset = (page - 1) * pageSize;

    // ── 5. Federated Search: DB + External Sources ──
    // 5a. Database search with pagination
    sourcesTried.push('database');
    let dbResults = [];
    let dbTotal = 0;

    if (searchType === 'cpf') {
      const { data, error, count } = await supabase
        .from('dim_pessoas')
        .select('*', { count: 'exact' })
        .eq('cpf', cpf)
        .range(offset, offset + pageSize - 1);

      if (!error && data) {
        dbResults = data;
        dbTotal = count || data.length;
      }
    } else {
      // CRITICAL: 22M rows — avoid full table scan.
      // - No count:exact (forces full scan)
      // - No order (forces full sort)
      // - Single word → primeiro_nome exact match (indexed) + nome_completo starts-with
      // - Multi word → nome_completo ilike (narrower, acceptable)
      const searchName = (guardrail.normalizedQuery || nome.trim()).toUpperCase();
      const escapedSearchName = escapeLike(searchName);
      plog.info('DB query debug', { searchName, escapedSearchName });

      const query = supabase
        .from('dim_pessoas')
        .select('*')
        .ilike('nome_completo', `%${escapedSearchName}%`);

      const { data, error } = await query
        .limit(pageSize)
        .range(offset, offset + pageSize - 1);

      plog.info('DB query result', {
        error: error?.message || null,
        rowsReturned: data?.length || 0,
      });

      if (!error && data) {
        dbResults = data;
        dbTotal = data.length;
      }
    }

    // 5b. Enrich DB results with cargo/empresa
    if (dbResults.length > 0) {
      const personIds = dbResults.map(p => p.id);
      const { data: transactions } = await supabase
        .from('fato_transacao_empresas')
        .select(`
          pessoa_id,
          cargo,
          qualificacao,
          dim_empresas (
            razao_social,
            nome_fantasia
          )
        `)
        .in('pessoa_id', personIds)
        .order('data_transacao', { ascending: false });

      const latestTx = {};
      for (const tx of (transactions || [])) {
        if (!latestTx[tx.pessoa_id]) {
          latestTx[tx.pessoa_id] = tx;
        }
      }

      dbResults = dbResults.map(p => {
        const tx = latestTx[p.id];
        return {
          ...p,
          cargo_atual: tx?.cargo || tx?.qualificacao || p.cargo_atual || null,
          empresa_atual: tx?.dim_empresas?.nome_fantasia || tx?.dim_empresas?.razao_social || p.empresa_atual || null,
          _source: 'db'
        };
      });
    }

    // 5c. External sources (page 1 + few DB results)
    let externalResults = [];
    if (page === 1 && dbResults.length < 5 && searchType === 'nome') {
      const searchName = guardrail.normalizedQuery || nome.trim();

      // Perplexity
      try {
        sourcesTried.push('perplexity');
        const ppxResult = await searchPersonPerplexity(searchName, cpf || null);
        if (ppxResult?.success && ppxResult?.found && ppxResult?.pessoa) {
          externalResults.push({
            ...ppxResult.pessoa,
            cpf: ppxResult.pessoa.cpf || cpf || null,
            _source: 'external',
            _provider: 'perplexity'
          });
        }
      } catch (err) {
        plog.warn('Perplexity search failed', { error: err.message });
      }

      // Serper + Apollo
      try {
        sourcesTried.push('serper');
        const googleResults = await serperSearch(
          `"${searchName}" Brasil profissional LinkedIn cargo empresa`,
          10
        );

        const kg = googleResults.knowledgeGraph || {};
        const organic = googleResults.organic || [];

        let linkedinUrl = null;
        try {
          linkedinUrl = await findPersonLinkedin(searchName);
        } catch (err) {
          plog.warn('Serper LinkedIn failed', { error: err.message });
        }

        let empresa = kg.organization || kg.company || null;
        let cargo = kg.title || kg.jobTitle || null;
        let descricao = kg.description || null;
        let localizacao = null;

        for (const item of organic.slice(0, 5)) {
          const text = `${item.title || ''} ${item.snippet || ''}`;
          if (!empresa && item.link?.includes('linkedin.com')) {
            const match = text.match(/(?:at|na|em|@)\s+([A-ZÀ-Ú][A-Za-zÀ-ú\s&.,-]+?)(?:\s*[-–|·]|\s*$)/i);
            if (match) empresa = match[1].trim();
          }
          if (!cargo && item.link?.includes('linkedin.com')) {
            const match = text.match(/[-–]\s*([A-Za-zÀ-ú\s,]+?)(?:\s*[-–|·]|\s*at\s|\s*na\s|\s*em\s)/i);
            if (match && match[1].length < 80) cargo = match[1].trim();
          }
          if (!descricao && item.snippet && item.snippet.length > 30) {
            descricao = item.snippet;
          }
          if (!localizacao) {
            const locMatch = text.match(/([A-Za-zÀ-ú]+(?:\s+[A-Za-zÀ-ú]+)?)\s*[-,]\s*([A-Z]{2})\b/);
            if (locMatch) localizacao = `${locMatch[1]} - ${locMatch[2]}`;
          }
        }

        // Apollo enrichment
        sourcesTried.push('apollo');
        let apolloData = null;
        try {
          if (empresa) {
            apolloData = await searchPersonApollo(searchName, empresa);
          }
        } catch (err) {
          plog.warn('Apollo search failed', { error: err.message });
        }

        const hasData = empresa || cargo || linkedinUrl || apolloData || descricao;
        if (hasData) {
          const apolloPhones = apolloData?.phone_numbers;
          const telefone = Array.isArray(apolloPhones)
            ? apolloPhones.find(Boolean) || null
            : (typeof apolloPhones === 'string' ? apolloPhones : null);

          externalResults.push({
            cpf: cpf || null,
            nome_completo: apolloData?.name || searchName,
            cargo_atual: apolloData?.title || cargo,
            empresa_atual: apolloData?.company?.name || empresa,
            linkedin_url: apolloData?.linkedin || linkedinUrl,
            email: apolloData?.email || null,
            localizacao: localizacao || (apolloData ? `${apolloData.city || ''} ${apolloData.state || ''}`.trim() : null),
            resumo_profissional: descricao,
            foto_url: apolloData?.photo_url || null,
            telefone: telefone,
            headline: apolloData?.headline || null,
            senioridade: apolloData?.seniority || null,
            departamento: Array.isArray(apolloData?.departments) ? apolloData.departments[0] || null : null,
            twitter_url: apolloData?.twitter || null,
            raw_apollo_data: apolloData?.raw_apollo || null,
            _source: 'external',
            _provider: 'serper+apollo'
          });
        }
      } catch (err) {
        plog.warn('Serper search failed', { error: err.message });
      }
    }

    // ── 6. Merge + Dedup ──
    const seenKeys = new Set();
    const merged = [];

    for (const r of dbResults) {
      const key = r.cpf || r.nome_completo?.toLowerCase();
      if (key) seenKeys.add(key);
      merged.push(r);
    }

    for (const r of externalResults) {
      const keyCpf = r.cpf;
      const keyName = r.nome_completo?.toLowerCase();
      if (keyCpf && seenKeys.has(keyCpf)) continue;
      if (keyName && seenKeys.has(keyName)) continue;
      if (keyCpf) seenKeys.add(keyCpf);
      if (keyName) seenKeys.add(keyName);
      merged.push(r);
    }

    // ── 7. Rank results ──
    let ranked = rankResults(merged, nome || cpf || '');

    // ── 7.5 Quality Gate (LLM batch scoring — page 1 only) ──
    let qualityGate = { enabled: false, processedCount: 0, filteredCount: 0, totalBeforeFilter: ranked.length, durationMs: 0 };

    if (ranked.length > 0 && page === 1) {
      const qg = await runQualityGate(ranked.slice(0, 10), nome || cpf || '');

      if (qg.scores.length > 0) {
        qualityGate.enabled = true;
        qualityGate.processedCount = qg.scores.length;
        qualityGate.durationMs = qg.durationMs;

        // Apply scores to results
        for (const s of qg.scores) {
          if (ranked[s.index]) {
            ranked[s.index].qualityScore = s.score;
            ranked[s.index].qualityLabel = s.label;

            // Enrich empty fields from LLM inferences
            if (s.enrichments && typeof s.enrichments === 'object') {
              ranked[s.index].enrichedFields = [];
              for (const [field, value] of Object.entries(s.enrichments)) {
                if (value && !ranked[s.index][field]) {
                  ranked[s.index][field] = value;
                  ranked[s.index].enrichedFields.push(field);
                }
              }
            }
          }
        }

        // Filter out low-quality results (score < 50)
        const beforeCount = ranked.length;
        ranked = ranked.filter(r => r.qualityScore === undefined || r.qualityScore >= 50);
        qualityGate.filteredCount = beforeCount - ranked.length;
      }
    }

    // ── 8. Badges + Pagination ──
    const dbCount = ranked.filter(r => r._source === 'db').length;
    const newCount = ranked.filter(r => r._source === 'external').length;
    const totalEstimate = dbTotal + newCount;
    const totalPages = Math.ceil(totalEstimate / pageSize);
    const durationMs = Date.now() - startTime;

    // ── 9. Log ──
    plog.info('search-v2 complete', {
      dbTotal,
      externalCount: newCount,
      mergedCount: ranked.length,
      page,
      durationMs
    });

    return res.json({
      success: true,
      status: 'OK',
      guardrail,
      results: ranked,
      pagination: {
        page,
        pageSize,
        total: totalEstimate,
        totalPages,
        hasMore: page < totalPages
      },
      badges: {
        total: ranked.length,
        db: dbCount,
        new: newCount
      },
      qualityGate,
      sources_tried: sourcesTried,
      requestId,
      durationMs
    });

  } catch (error) {
    plog.error('search-v2 error', { error: error.message, stack: error.stack });
    return res.status(500).json({
      success: false,
      error: error.message,
      requestId,
      durationMs: Date.now() - startTime
    });
  }
});

/**
 * POST /api/people/check-existing
 * Batch check if people already exist by IDs or CPFs
 */
router.post('/check-existing', async (req, res) => {
  try {
    const { ids, cpfs } = req.body;

    if ((!ids || ids.length === 0) && (!cpfs || cpfs.length === 0)) {
      return res.status(400).json({
        success: false,
        error: 'Informe ids ou cpfs para verificar'
      });
    }

    const existing = [];
    let checked = 0;

    // Check by IDs
    if (ids && ids.length > 0) {
      const batchIds = ids.slice(0, 500);
      checked += batchIds.length;

      const { data, error } = await supabase
        .from('dim_pessoas')
        .select('id')
        .in('id', batchIds);

      if (!error && data) {
        for (const row of data) {
          existing.push(row.id);
        }
      }
    }

    // Check by CPFs
    if (cpfs && cpfs.length > 0) {
      const batchCpfs = cpfs.slice(0, 500);
      checked += batchCpfs.length;

      const { data, error } = await supabase
        .from('dim_pessoas')
        .select('id, cpf')
        .in('cpf', batchCpfs);

      if (!error && data) {
        for (const row of data) {
          existing.push(row.cpf);
        }
      }
    }

    logger.info('People check-existing', { checked, found: existing.length });

    return res.json({
      success: true,
      existing,
      checked
    });

  } catch (error) {
    logger.error('check-existing error', { error: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/people/save-batch
 * Save multiple people at once (new only, skip existing)
 */
router.post('/save-batch', validateBody(saveBatchSchema), async (req, res) => {
  const startTime = Date.now();
  try {
    const { pessoas, aprovado_por } = req.body;

    logger.info('save-batch request', { count: pessoas.length, aprovado_por });

    const results = [];
    let inserted = 0;
    let existed = 0;
    let failed = 0;

    for (const pessoa of pessoas) {
      try {
        // Normalize CPF
        const batchRawCpf = pessoa.cpf ? String(pessoa.cpf).replace(/[^\d]/g, '') : null;
        const batchCleanCpf = batchRawCpf && batchRawCpf.length === 11 ? batchRawCpf : null;

        // Check if person already exists by CPF
        if (batchCleanCpf) {
          const { data: existing } = await supabase
            .from('dim_pessoas')
            .select('id')
            .eq('cpf', batchCleanCpf)
            .single();

          if (existing) {
            existed++;
            results.push({ nome: pessoa.nome_completo, status: 'existed', id: existing.id });
            continue;
          }
        }

        // Insert person
        const nomeParts = pessoa.nome_completo?.split(' ') || [];
        const loc = parseLocalizacao(pessoa.localizacao);
        const { data: novaPessoa, error: insertError } = await supabase
          .from('dim_pessoas')
          .insert({
            nome_completo: pessoa.nome_completo,
            primeiro_nome: nomeParts[0] || null,
            sobrenome: nomeParts.length > 1 ? nomeParts.slice(1).join(' ') : null,
            cpf: batchCleanCpf,
            email: pessoa.email || null,
            linkedin_url: pessoa.linkedin_url || null,
            foto_url: pessoa.foto_url || null,
            codigo_ibge: pessoa.codigo_ibge || null,
            codigo_ibge_uf: pessoa.codigo_ibge_uf || null,
            pais: loc.pais,
            cargo_atual: pessoa.cargo_atual || null,
            empresa_atual_nome: pessoa.empresa_atual || null,
            sobre: pessoa.resumo_profissional || null,
            telefone: pessoa.telefone || null,
            headline: pessoa.headline || null,
            senioridade: pessoa.senioridade || null,
            departamento: pessoa.departamento || null,
            twitter_url: pessoa.twitter_url || null,
            fonte: pessoa._provider || 'batch_insert',
            raw_apollo_data: pessoa.raw_apollo_data || null
          })
          .select('id')
          .single();

        if (insertError) {
          failed++;
          results.push({ nome: pessoa.nome_completo, status: 'failed', error: insertError.message });
        } else {
          inserted++;
          results.push({ nome: pessoa.nome_completo, status: 'inserted', id: novaPessoa.id });
        }

      } catch (err) {
        failed++;
        results.push({ nome: pessoa.nome_completo, status: 'failed', error: err.message });
      }
    }

    logger.info('save-batch complete', { inserted, existed, failed, durationMs: Date.now() - startTime });

    return res.json({
      success: true,
      inserted,
      existed,
      failed,
      results,
      durationMs: Date.now() - startTime
    });

  } catch (error) {
    logger.error('save-batch error', { error: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
