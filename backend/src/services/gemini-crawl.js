/**
 * Gemini Website Crawl Service
 * Extracts structured business data from company websites using Google Gemini.
 *
 * Outputs: products, services, contacts, team members, clients mentioned,
 * partners, technologies, commemorative dates, and estimated company size.
 *
 * Requires: GEMINI_API_KEY environment variable
 */

import logger from '../utils/logger.js';
import { supabase } from '../database/supabase.js';
import { sanitizeUUID, sanitizeForLog } from '../utils/sanitize.js';
import { createEvidence, createEvidenceBatch } from './evidence-manager.js';
import {
  EVIDENCE_TYPES,
  EVIDENCE_SOURCES,
  ECOSYSTEM_TYPES,
} from '../constants.js';

// Dynamic import to avoid crash if @google/generative-ai is not installed
let GoogleGenerativeAI = null;

async function loadSDK() {
  if (GoogleGenerativeAI) return true;
  try {
    const mod = await import('@google/generative-ai');
    GoogleGenerativeAI = mod.GoogleGenerativeAI;
    return true;
  } catch {
    logger.warn('gemini_crawl_sdk_not_installed');
    return false;
  }
}

/**
 * The structured extraction prompt for Gemini.
 * Asks for JSON output with all business intelligence fields.
 */
function buildExtractionPrompt(url, companyName) {
  return `Você é um analista de inteligência empresarial. Analise o website da empresa "${companyName}" na URL: ${url}

Extraia as seguintes informações em formato JSON estrito (sem markdown, sem explicações, APENAS o JSON):

{
  "resumo_atividade": "Resumo em 2-3 frases do que a empresa faz",
  "segmento_detectado": "Segmento principal (ex: tecnologia, alimentos, construção)",
  "porte_estimado": "MEI | ME | EPP | MEDIO | GRANDE (baseado no site)",
  "palavras_chave": ["keyword1", "keyword2", "keyword3"],
  "tecnologias_detectadas": ["tech1", "tech2"],
  "idiomas": ["pt-BR"],
  "tem_ecommerce": false,
  "tem_blog": false,
  "tem_area_cliente": false,
  "produtos": [
    {
      "nome": "Nome do produto/serviço",
      "descricao": "Descrição breve",
      "tipo": "produto | servico",
      "categoria": "Categoria",
      "preco_detectado": null
    }
  ],
  "contatos": [
    {
      "tipo": "email | telefone | whatsapp | linkedin | instagram | facebook",
      "valor": "contato@empresa.com",
      "departamento": "comercial | suporte | rh | geral",
      "pessoa_nome": null
    }
  ],
  "equipe": [
    {
      "nome": "Nome Completo",
      "cargo": "Cargo na empresa"
    }
  ],
  "clientes_mencionados": [
    {
      "nome": "Nome do cliente mencionado no site",
      "evidencia": "Trecho que menciona o cliente"
    }
  ],
  "parceiros_mencionados": [
    {
      "nome": "Nome do parceiro",
      "evidencia": "Trecho que menciona o parceiro"
    }
  ],
  "datas_comemorativas": [
    {
      "nome": "Aniversário da empresa",
      "tipo": "aniversario_empresa | evento_setor",
      "data_referencia": "2020-05-15",
      "descricao": "Empresa fundada em 2020"
    }
  ]
}

REGRAS:
- Se não encontrar informação, use null ou array vazio []
- Preços em BRL (número, sem R$)
- Telefones no formato original do site
- Não invente dados — só extraia o que está visível no site
- Se o site estiver inacessível, retorne {"error": "site_inacessivel"}`;
}

/**
 * Crawl a company website using Gemini and extract structured data.
 *
 * @param {string} empresaId - Company UUID
 * @param {Object} [options={}]
 * @param {boolean} [options.force=false] - Re-crawl even if already crawled
 * @returns {Promise<Object|null>} Crawl result or null
 */
export async function crawlCompanyWebsite(empresaId, options = {}) {
  const id = sanitizeUUID(empresaId);
  if (!id) return null;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn('gemini_crawl_no_api_key');
    return null;
  }

  const sdkLoaded = await loadSDK();
  if (!sdkLoaded) return null;

  try {
    // Fetch company data
    const { data: empresa, error } = await supabase
      .from('dim_empresas')
      .select('id, razao_social, nome_fantasia, website, cidade, estado')
      .eq('id', id)
      .single();

    if (error || !empresa) {
      logger.warn('gemini_crawl_empresa_not_found', { empresaId: id });
      return null;
    }

    const url = empresa.website;
    if (!url) {
      // Mark as sem_website
      await upsertCrawl(id, {
        url: '',
        status: 'sem_website',
      });
      return null;
    }

    // Check if already crawled (unless force)
    if (!options.force) {
      const { data: existing } = await supabase
        .from('fato_website_crawl')
        .select('id, status, updated_at')
        .eq('empresa_id', id)
        .eq('status', 'sucesso')
        .order('updated_at', { ascending: false })
        .limit(1);

      if (existing?.length > 0) {
        const age = Date.now() - new Date(existing[0].updated_at).getTime();
        const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
        if (age < maxAge) {
          logger.info('gemini_crawl_skip_recent', { empresaId: id });
          return existing[0];
        }
      }
    }

    // Mark as crawling
    await upsertCrawl(id, { url, status: 'crawling' });

    // Call Gemini
    const companyName = empresa.nome_fantasia || empresa.razao_social;
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = buildExtractionPrompt(url, companyName);
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Parse JSON response
    let extraction;
    try {
      // Remove markdown code fences if present
      const jsonText = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      extraction = JSON.parse(jsonText);
    } catch (parseErr) {
      logger.error('gemini_crawl_parse_error', {
        empresaId: id,
        text: text.substring(0, 200),
      });
      await upsertCrawl(id, { url, status: 'erro', raw_extraction: { raw: text } });
      return null;
    }

    if (extraction.error) {
      await upsertCrawl(id, { url, status: 'erro', raw_extraction: extraction });
      return null;
    }

    // Save crawl result
    const crawlRecord = await upsertCrawl(id, {
      url,
      status: 'sucesso',
      raw_extraction: extraction,
      resumo_atividade: extraction.resumo_atividade || null,
      segmento_detectado: extraction.segmento_detectado || null,
      porte_estimado: extraction.porte_estimado || null,
      palavras_chave: extraction.palavras_chave || [],
      tecnologias_detectadas: extraction.tecnologias_detectadas || [],
      idiomas: extraction.idiomas || [],
      tem_ecommerce: extraction.tem_ecommerce || false,
      tem_blog: extraction.tem_blog || false,
      tem_area_cliente: extraction.tem_area_cliente || false,
    });

    // Process extracted data into respective tables
    await Promise.all([
      saveProducts(id, extraction.produtos),
      saveContacts(id, extraction.contatos),
      saveTeamMembers(id, extraction.equipe),
      saveEcosystemRelations(id, extraction.clientes_mencionados, 'cliente'),
      saveEcosystemRelations(id, extraction.parceiros_mencionados, 'parceiro'),
      saveDates(id, extraction.datas_comemorativas),
    ]);

    logger.info('gemini_crawl_complete', {
      empresaId: id,
      produtos: extraction.produtos?.length || 0,
      contatos: extraction.contatos?.length || 0,
      equipe: extraction.equipe?.length || 0,
      clientes: extraction.clientes_mencionados?.length || 0,
      parceiros: extraction.parceiros_mencionados?.length || 0,
    });

    return crawlRecord;
  } catch (err) {
    logger.error('gemini_crawl_error', {
      empresaId: id,
      error: err.message,
    });
    await upsertCrawl(id, {
      url: '',
      status: 'erro',
      raw_extraction: { error: err.message },
    });
    return null;
  }
}

/**
 * Batch crawl companies that haven't been crawled yet.
 *
 * @param {number} [batchSize=10] - Companies per batch
 * @param {number} [delayMs=2000] - Delay between calls (rate limiting)
 * @returns {Promise<{ crawled: number, skipped: number, errors: number }>}
 */
export async function crawlBatch(batchSize = 10, delayMs = 2000) {
  let crawled = 0;
  let skipped = 0;
  let errors = 0;

  // Find companies with website but no crawl
  const { data: empresas, error } = await supabase
    .from('dim_empresas')
    .select('id, website')
    .not('website', 'is', null)
    .not('website', 'eq', '')
    .limit(batchSize);

  if (error || !empresas?.length) {
    logger.info('gemini_crawl_batch_no_companies');
    return { crawled, skipped, errors };
  }

  // Filter out already crawled
  const ids = empresas.map((e) => e.id);
  const { data: alreadyCrawled } = await supabase
    .from('fato_website_crawl')
    .select('empresa_id')
    .in('empresa_id', ids)
    .eq('status', 'sucesso');

  const crawledSet = new Set((alreadyCrawled || []).map((c) => c.empresa_id));

  for (const empresa of empresas) {
    if (crawledSet.has(empresa.id)) {
      skipped++;
      continue;
    }

    const result = await crawlCompanyWebsite(empresa.id);
    if (result) crawled++;
    else errors++;

    // Rate limiting
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  logger.info('gemini_crawl_batch_complete', { crawled, skipped, errors });
  return { crawled, skipped, errors };
}

// --- Internal helpers ---

async function upsertCrawl(empresaId, data) {
  const { data: existing } = await supabase
    .from('fato_website_crawl')
    .select('id')
    .eq('empresa_id', empresaId)
    .limit(1);

  if (existing?.length > 0) {
    const { data: updated, error } = await supabase
      .from('fato_website_crawl')
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq('empresa_id', empresaId)
      .select()
      .single();
    if (error) logger.error('crawl_upsert_error', { error: error.message });
    return updated;
  }

  const { data: inserted, error } = await supabase
    .from('fato_website_crawl')
    .insert({ empresa_id: empresaId, ...data })
    .select()
    .single();
  if (error) logger.error('crawl_insert_error', { error: error.message });
  return inserted;
}

async function saveProducts(empresaId, produtos) {
  if (!produtos?.length) return;

  const records = produtos.map((p) => ({
    empresa_id: empresaId,
    nome: p.nome,
    descricao: p.descricao || null,
    tipo: p.tipo || 'produto',
    categoria: p.categoria || null,
    preco_detectado: p.preco_detectado || null,
    fonte: 'gemini_crawl',
  }));

  const { error } = await supabase.from('dim_produtos').insert(records);
  if (error) logger.error('crawl_save_products_error', { error: error.message });
}

async function saveContacts(empresaId, contatos) {
  if (!contatos?.length) return;

  const records = contatos.map((c) => ({
    empresa_id: empresaId,
    tipo: c.tipo,
    valor: c.valor,
    departamento: c.departamento || 'geral',
    pessoa_nome: c.pessoa_nome || null,
    fonte: 'gemini_crawl',
  }));

  const { error } = await supabase.from('dim_contatos_website').insert(records);
  if (error) logger.error('crawl_save_contacts_error', { error: error.message });
}

async function saveTeamMembers(empresaId, equipe) {
  if (!equipe?.length) return;

  for (const member of equipe) {
    if (!member.nome) continue;

    // Check if person already exists
    const { data: existing } = await supabase
      .from('dim_pessoas')
      .select('id')
      .ilike('nome_completo', member.nome)
      .limit(1);

    let pessoaId;
    if (existing?.length > 0) {
      pessoaId = existing[0].id;
    } else {
      // Insert new person
      const { data: inserted, error } = await supabase
        .from('dim_pessoas')
        .insert({
          nome_completo: member.nome,
          cargo_atual: member.cargo || null,
          empresa_atual_nome: null, // Will be linked via transaction
          fonte: 'gemini_crawl',
        })
        .select('id')
        .single();

      if (error) {
        logger.error('crawl_save_person_error', { nome: member.nome, error: error.message });
        continue;
      }
      pessoaId = inserted.id;
    }

    // Create evidence for the relationship
    await createEvidence({
      entidade_origem_type: 'empresa',
      entidade_origem_id: empresaId,
      entidade_destino_type: 'pessoa',
      entidade_destino_id: pessoaId,
      tipo_evidencia: EVIDENCE_TYPES.MENCAO_WEBSITE,
      fonte: EVIDENCE_SOURCES.GEMINI_CRAWL,
      confianca: 0.7,
      metodo_extracao: 'ai_extraction',
      texto_evidencia: `${member.nome} - ${member.cargo || 'cargo não identificado'} (extraído do website)`,
    });
  }
}

async function saveEcosystemRelations(empresaId, mentions, tipo) {
  if (!mentions?.length) return;

  const evidences = [];
  const relations = [];

  for (const mention of mentions) {
    if (!mention.nome) continue;

    // Try to find the mentioned company in dim_empresas
    const { data: found } = await supabase
      .from('dim_empresas')
      .select('id, razao_social, cnpj')
      .or(`razao_social.ilike.%${mention.nome}%,nome_fantasia.ilike.%${mention.nome}%`)
      .limit(1);

    const relatedId = found?.[0]?.id || null;

    relations.push({
      empresa_id: empresaId,
      empresa_relacionada_id: relatedId,
      nome_empresa_relacionada: mention.nome,
      cnpj_relacionada: found?.[0]?.cnpj || null,
      tipo_relacao: tipo,
      fonte_deteccao: 'website',
    });

    evidences.push({
      entidade_origem_type: 'empresa',
      entidade_origem_id: empresaId,
      entidade_destino_type: relatedId ? 'empresa' : null,
      entidade_destino_id: relatedId,
      tipo_evidencia: EVIDENCE_TYPES.MENCAO_WEBSITE,
      fonte: EVIDENCE_SOURCES.GEMINI_CRAWL,
      confianca: 0.65,
      metodo_extracao: 'ai_extraction',
      texto_evidencia: mention.evidencia || `${mention.nome} mencionado como ${tipo} no website`,
    });
  }

  if (relations.length) {
    const { error } = await supabase.from('dim_ecossistema_empresas').insert(relations);
    if (error) logger.error('crawl_save_ecosystem_error', { error: error.message });
  }

  if (evidences.length) {
    await createEvidenceBatch(evidences);
  }
}

async function saveDates(empresaId, datas) {
  if (!datas?.length) return;

  const records = datas.map((d) => ({
    empresa_id: empresaId,
    tipo: d.tipo || 'aniversario_empresa',
    nome: d.nome,
    data_referencia: d.data_referencia || null,
    descricao: d.descricao || null,
    relevancia: 'media',
  }));

  const { error } = await supabase.from('dim_datas_comemorativas').insert(records);
  if (error) logger.error('crawl_save_dates_error', { error: error.message });
}
