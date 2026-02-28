/**
 * News Analyzer Service
 * Analisa notícias usando Claude para criar tópicos e relevância
 *
 * Fluxo:
 * 1. Recebe notícias do MCP (Perplexity)
 * 2. Claude analisa e cria tópicos
 * 3. Filtra citações/referências do Perplexity
 * 4. Salva em dim_noticias e fato_noticias_topicos
 */

import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { escapeLike } from '../utils/sanitize.js';

// Cliente Anthropic (Claude)
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Analisa uma notícia e extrai tópicos
 * @param {Object} noticia - Dados da notícia
 * @param {string} segmento - Segmento de mercado
 * @returns {Promise<Object>} Notícia analisada com tópicos
 */
export async function analyzeNews(noticia, segmento = 'geral') {
  logger.info('Analyzing news', { titulo: noticia.titulo, segmento });

  try {
    const prompt = `
Analise a seguinte notícia econômica e extraia informações estruturadas.

NOTÍCIA:
Título: ${noticia.titulo}
Resumo: ${noticia.resumo || noticia.conteudo || 'N/A'}
Fonte: ${noticia.fonte || 'N/A'}
Data: ${noticia.data_publicacao || 'N/A'}
Segmento: ${segmento}

INSTRUÇÕES:
1. Crie 2-5 tópicos relevantes para esta notícia
2. Para cada tópico, defina:
   - Nome do tópico (curto, até 50 caracteres)
   - Relevância para o segmento ${segmento} (1-10)
   - Sentimento (positivo/negativo/neutro)
   - Impacto no mercado (alto/medio/baixo)
   - Keywords relacionadas (array de strings)
   - Entidades mencionadas (empresas, pessoas, locais)

3. Crie um resumo executivo (2-3 frases)

4. Defina relevância geral da notícia (0-100)

RESPONDA APENAS EM JSON VÁLIDO:
{
  "resumo_executivo": "...",
  "relevancia_geral": 75,
  "topicos": [
    {
      "topico": "Nome do Tópico",
      "relevancia": 8,
      "relevancia_segmento": 7,
      "sentimento": "positivo",
      "impacto_mercado": "alto",
      "keywords": ["keyword1", "keyword2"],
      "entidades": ["Empresa X", "Pessoa Y"]
    }
  ],
  "empresas_mencionadas": ["Empresa A", "Empresa B"],
  "pessoas_mencionadas": ["Pessoa A"],
  "indicadores_mencionados": ["Selic", "IPCA"]
}
`;

    const message = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const responseText = message.content[0].text;
    const analysis = parseJsonResponse(responseText);

    if (!analysis) {
      logger.warn('Failed to parse Claude response', { response: responseText });
      return {
        success: false,
        error: 'Failed to parse analysis'
      };
    }

    return {
      success: true,
      noticia: {
        ...noticia,
        resumo: analysis.resumo_executivo,
        relevancia_geral: analysis.relevancia_geral,
        processado_claude: true
      },
      topicos: analysis.topicos || [],
      empresas_mencionadas: analysis.empresas_mencionadas || [],
      pessoas_mencionadas: analysis.pessoas_mencionadas || [],
      indicadores_mencionados: analysis.indicadores_mencionados || []
    };

  } catch (error) {
    logger.error('News analysis error', { error: error.message });
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Processa e salva notícias no banco
 * @param {Array} noticias - Lista de notícias do MCP
 * @param {string} segmento - Segmento de mercado
 * @returns {Promise<Object>} Estatísticas do processamento
 */
export async function processAndSaveNews(noticias, segmento = 'geral') {
  const stats = {
    total: noticias.length,
    saved: 0,
    duplicates: 0,
    errors: 0,
    topicos_created: 0
  };

  for (const noticia of noticias) {
    try {
      // Verificar duplicata por URL
      const urlHash = hashUrl(noticia.url);
      const existing = await supabase
        .from('dim_noticias')
        .select('id')
        .eq('url_hash', urlHash)
        .single();

      if (existing.data) {
        stats.duplicates++;
        continue;
      }

      // Analisar com Claude
      const analysis = await analyzeNews(noticia, segmento);

      if (!analysis.success) {
        stats.errors++;
        continue;
      }

      // Salvar notícia
      const noticiaData = {
        titulo: noticia.titulo,
        subtitulo: noticia.subtitulo,
        conteudo: noticia.conteudo,
        resumo: analysis.noticia.resumo,
        fonte_nome: noticia.fonte,
        fonte_handle: noticia.fonte_handle,
        url: noticia.url,
        url_hash: urlHash,
        segmento: segmento,
        categorias: noticia.categorias || [],
        data_publicacao: noticia.data_publicacao ? new Date(noticia.data_publicacao) : null,
        perplexity_citations: noticia.citations || [],
        perplexity_query: noticia.query,
        processado_claude: true,
        relevancia_geral: analysis.noticia.relevancia_geral,
        raw_perplexity: noticia.raw || {}
      };

      const { data: savedNoticia, error: noticiaError } = await supabase
        .from('dim_noticias')
        .insert(noticiaData)
        .select('id')
        .single();

      if (noticiaError) {
        logger.error('Error saving noticia', { error: noticiaError.message });
        stats.errors++;
        continue;
      }

      stats.saved++;

      // Salvar tópicos
      for (const topico of analysis.topicos) {
        const topicoData = {
          noticia_id: savedNoticia.id,
          topico: topico.topico,
          topico_slug: slugify(topico.topico),
          relevancia: topico.relevancia,
          relevancia_segmento: topico.relevancia_segmento,
          analise_resumo: null, // Pode ser expandido
          sentimento: topico.sentimento,
          impacto_mercado: topico.impacto_mercado,
          keywords: topico.keywords || [],
          entidades: topico.entidades || []
        };

        const { error: topicoError } = await supabase
          .from('fato_noticias_topicos')
          .insert(topicoData);

        if (!topicoError) {
          stats.topicos_created++;
        }
      }

      // Relacionar com empresas mencionadas (se existirem no banco)
      for (const empresaNome of analysis.empresas_mencionadas) {
        const escapedNome = escapeLike(empresaNome);
        const { data: empresa } = await supabase
          .from('dim_empresas')
          .select('id')
          .or(`razao_social.ilike.%${escapedNome}%,nome_fantasia.ilike.%${escapedNome}%`)
          .limit(1)
          .single();

        if (empresa) {
          await supabase
            .from('fato_noticias_empresas')
            .insert({
              noticia_id: savedNoticia.id,
              empresa_id: empresa.id,
              tipo_relacao: 'mencao',
              relevancia: 5 // Default
            })
            .onConflict('noticia_id,empresa_id')
            .ignore();
        }
      }

      // Relacionar com pessoas mencionadas (se existirem no banco)
      for (const pessoaNome of analysis.pessoas_mencionadas) {
        const { data: pessoa } = await supabase
          .from('dim_pessoas')
          .select('id')
          .ilike('nome_completo', `%${escapeLike(pessoaNome)}%`)
          .limit(1)
          .single();

        if (pessoa) {
          await supabase
            .from('fato_noticias_pessoas')
            .insert({
              noticia_id: savedNoticia.id,
              pessoa_id: pessoa.id,
              tipo_relacao: 'mencao'
            })
            .onConflict('noticia_id,pessoa_id')
            .ignore();
        }
      }

      // Rate limiting
      await sleep(500);

    } catch (error) {
      logger.error('Error processing noticia', { error: error.message, titulo: noticia.titulo });
      stats.errors++;
    }
  }

  logger.info('News processing complete', stats);
  return stats;
}

/**
 * Busca notícias relacionadas a uma empresa
 * @param {string} empresaId - ID da empresa
 * @param {number} limit - Limite de resultados
 * @returns {Promise<Array>} Lista de notícias
 */
export async function getCompanyNews(empresaId, limit = 10) {
  const { data, error } = await supabase
    .from('fato_noticias_empresas')
    .select(`
      noticia_id,
      tipo_relacao,
      relevancia,
      sentimento_empresa,
      dim_noticias (
        id,
        titulo,
        resumo,
        fonte_nome,
        url,
        data_publicacao,
        relevancia_geral
      )
    `)
    .eq('empresa_id', empresaId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Error fetching company news', { error: error.message });
    return [];
  }

  return data.map(item => ({
    ...item.dim_noticias,
    tipo_relacao: item.tipo_relacao,
    relevancia_empresa: item.relevancia,
    sentimento: item.sentimento_empresa
  }));
}

/**
 * Busca notícias por tópico
 * @param {string} topico - Tópico a buscar
 * @param {string} segmento - Segmento (opcional)
 * @param {number} limit - Limite de resultados
 * @returns {Promise<Array>} Lista de notícias
 */
export async function getNewsByTopic(topico, segmento = null, limit = 20) {
  let query = supabase
    .from('fato_noticias_topicos')
    .select(`
      topico,
      relevancia,
      sentimento,
      dim_noticias (
        id,
        titulo,
        resumo,
        fonte_nome,
        url,
        segmento,
        data_publicacao,
        relevancia_geral
      )
    `)
    .ilike('topico_slug', `%${escapeLike(slugify(topico))}%`)
    .order('relevancia', { ascending: false })
    .limit(limit);

  if (segmento) {
    query = query.eq('dim_noticias.segmento', segmento);
  }

  const { data, error } = await query;

  if (error) {
    logger.error('Error fetching news by topic', { error: error.message });
    return [];
  }

  return data.map(item => ({
    ...item.dim_noticias,
    topico: item.topico,
    relevancia_topico: item.relevancia,
    sentimento: item.sentimento
  }));
}

/**
 * Filtra citações/referências do Perplexity
 * @param {Array} citations - Citações do Perplexity
 * @returns {Array} Citações filtradas (apenas confiáveis)
 */
export function filterCitations(citations) {
  const trustedDomains = [
    'valoreconomico.com.br',
    'infomoney.com.br',
    'exame.com',
    'folha.uol.com.br',
    'estadao.com.br',
    'oglobo.globo.com',
    'g1.globo.com',
    'bloomberg.com',
    'reuters.com',
    'bcb.gov.br',
    'ibge.gov.br',
    'gov.br'
  ];

  return citations.filter(citation => {
    if (!citation.url) return false;
    return trustedDomains.some(domain => citation.url.includes(domain));
  });
}

// Helpers

function hashUrl(url) {
  if (!url) return null;
  return crypto.createHash('sha256').update(url).digest('hex');
}

function slugify(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);
}

function parseJsonResponse(text) {
  try {
    // Tentar extrair JSON da resposta
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    // Ignorar erro de parse
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default {
  analyzeNews,
  processAndSaveNews,
  getCompanyNews,
  getNewsByTopic,
  filterCitations
};
