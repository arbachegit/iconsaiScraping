import { Router } from 'express';
import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { searchPerson as searchPersonApollo } from '../services/apollo.js';
import { searchPerson as searchPersonPerplexity } from '../services/perplexity.js';
import { search as serperSearch, findPersonLinkedin } from '../services/serper.js';
import { validateBody } from '../validation/schemas.js';
import { searchPersonByCpfSchema } from '../validation/schemas.js';

const router = Router();

/**
 * GET /api/people/list
 * List all people in the database
 */
router.get('/list', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    const { data, error, count } = await supabase
      .from('fato_pessoas')
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

    // Get person data from fato_pessoas
    const { data: pessoa, error: pessoaError } = await supabase
      .from('fato_pessoas')
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
        fato_pessoas (*)
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
        ...item.fato_pessoas,
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

    // Search in fato_pessoas by name
    const { data, error } = await supabase
      .from('fato_pessoas')
      .select('*')
      .or(`nome_completo.ilike.%${nome.trim()}%,primeiro_nome.ilike.%${nome.trim()}%`)
      .limit(20);

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
      nome: hasNome ? nome : null
    });

    // =============================================
    // 1. Search internal database (fato_pessoas)
    // =============================================
    sourcesTried.push('database');
    let existingPerson = null;

    if (hasCpf) {
      const { data, error } = await supabase
        .from('fato_pessoas')
        .select('*')
        .eq('cpf', cpf)
        .single();
      if (data && !error) existingPerson = data;
    }

    if (!existingPerson && hasNome) {
      const { data, error } = await supabase
        .from('fato_pessoas')
        .select('*')
        .or(`nome_completo.ilike.%${nome.trim()}%,primeiro_nome.ilike.%${nome.trim()}%`)
        .limit(1)
        .single();
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
      logger.info('Person found via Perplexity', { nome: perplexityResult.pessoa.nome_completo });

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
          logger.info('Person found via Serper+Apollo', { nome: searchName, empresa, cargo });

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
      nome: hasNome ? nome : null,
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

    logger.info('Saving person', { nome: pessoa.nome_completo, aprovado_por });

    // Check if person already exists by CPF or nome in fato_pessoas
    if (pessoa.cpf) {
      const { data: existing } = await supabase
        .from('fato_pessoas')
        .select('id')
        .eq('cpf', pessoa.cpf)
        .single();

      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'Pessoa já cadastrada com este CPF',
          pessoa_id: existing.id
        });
      }
    }

    // Insert person into fato_pessoas
    const nomeParts = pessoa.nome_completo?.split(' ') || [];
    const { data: novaPessoa, error: pessoaError } = await supabase
      .from('fato_pessoas')
      .insert({
        nome_completo: pessoa.nome_completo,
        primeiro_nome: nomeParts[0] || null,
        sobrenome: nomeParts.length > 1 ? nomeParts.slice(1).join(' ') : null,
        cpf: pessoa.cpf || null,
        email: pessoa.email || null,
        linkedin_url: pessoa.linkedin_url || null,
        foto_url: pessoa.foto_url || null,
        pais: pessoa.localizacao?.includes(',') ? pessoa.localizacao.split(',').pop()?.trim() : 'Brasil',
        fonte: 'perplexity',
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

export default router;
