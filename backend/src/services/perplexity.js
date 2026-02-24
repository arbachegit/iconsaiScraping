import logger from '../utils/logger.js';

const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';

function getApiKey() {
  return process.env.PERPLEXITY_API_KEY;
}

// Trusted sources for news search
const TRUSTED_SOURCES = {
  'Valor Econômico': 'site:valoreconomico.com.br',
  'InfoMoney': 'site:infomoney.com.br',
  'Folha de S.Paulo': 'site:folha.uol.com.br',
  'O Estado de S. Paulo': 'site:estadao.com.br',
  'O Globo': 'site:oglobo.globo.com',
  'Exame': 'site:exame.com',
  'G1': 'site:g1.globo.com',
  'UOL': 'site:uol.com.br',
  'Reuters Brasil': 'site:reuters.com',
  'Bloomberg': 'site:bloomberg.com',
  'CNN Brasil': 'site:cnnbrasil.com.br',
  'BBC Brasil': 'site:bbc.com/portuguese'
};

/**
 * Search for company CNPJ using Perplexity AI
 * @param {string} companyName - Company name
 * @param {string} cidade - Optional city
 * @returns {Promise<Array>} List of candidates with CNPJ
 */
export async function searchCompanyByName(companyName, cidade = null) {
  if (!getApiKey()) {
    console.warn('[PERPLEXITY] API key not configured');
    return [];
  }

  try {
    let query = `Qual é o CNPJ da empresa "${companyName}"`;
    if (cidade) {
      query += ` localizada em ${cidade}`;
    }
    query += `? Retorne apenas o CNPJ no formato XX.XXX.XXX/XXXX-XX e a razão social.`;

    const response = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-small-128k-online',
        messages: [
          {
            role: 'system',
            content: 'Você é um assistente que busca informações de empresas brasileiras. Retorne apenas dados factuais encontrados na internet.'
          },
          {
            role: 'user',
            content: query
          }
        ],
        temperature: 0.1,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      console.error('[PERPLEXITY] API error:', response.status);
      return [];
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    console.log(`[PERPLEXITY] Response for "${companyName}":`, content.substring(0, 200));

    // Extract CNPJ from response
    const cnpjPattern = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g;
    const matches = content.match(cnpjPattern) || [];

    const candidates = [];
    const seenCnpjs = new Set();

    for (const match of matches) {
      const cnpj = match.replace(/[^\d]/g, '');
      if (cnpj.length === 14 && !seenCnpjs.has(cnpj)) {
        seenCnpjs.add(cnpj);
        candidates.push({
          cnpj: cnpj,
          cnpj_formatted: formatCnpj(cnpj),
          razao_social: extractRazaoSocial(content, companyName),
          localizacao: cidade || null,
          fonte: 'perplexity'
        });
      }
    }

    return candidates;
  } catch (error) {
    console.error('[PERPLEXITY] Error:', error.message);
    return [];
  }
}

/**
 * Search for company details using Perplexity
 * @param {string} cnpj - Company CNPJ
 * @returns {Promise<Object|null>} Company details
 */
export async function getCompanyDetails(cnpj) {
  if (!getApiKey()) {
    return null;
  }

  try {
    const cnpjFormatted = formatCnpj(cnpj);
    const query = `Quais são os dados da empresa com CNPJ ${cnpjFormatted}?
    Retorne: razão social, nome fantasia, endereço, cidade, estado, telefone, email, website, setor de atuação.`;

    const response = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-small-128k-online',
        messages: [
          {
            role: 'system',
            content: 'Você é um assistente que busca informações de empresas brasileiras. Retorne dados estruturados.'
          },
          {
            role: 'user',
            content: query
          }
        ],
        temperature: 0.1,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    return {
      cnpj: cnpj,
      raw_response: content,
      fonte: 'perplexity'
    };
  } catch (error) {
    console.error('[PERPLEXITY] Error getting details:', error.message);
    return null;
  }
}

/**
 * Format CNPJ with punctuation
 */
function formatCnpj(cnpj) {
  const digits = cnpj.replace(/[^\d]/g, '');
  if (digits.length !== 14) return cnpj;
  return `${digits.slice(0,2)}.${digits.slice(2,5)}.${digits.slice(5,8)}/${digits.slice(8,12)}-${digits.slice(12)}`;
}

/**
 * Extract razao social from response
 */
function extractRazaoSocial(content, searchName) {
  // Try to find company name patterns
  const patterns = [
    /razão social[:\s]+([A-ZÀ-Ú][A-ZÀ-Ú\s\.\-&]+(?:LTDA|S\.?A\.?|ME|EPP|EIRELI)?)/i,
    /empresa[:\s]+([A-ZÀ-Ú][A-ZÀ-Ú\s\.\-&]+(?:LTDA|S\.?A\.?|ME|EPP|EIRELI)?)/i,
    /([A-ZÀ-Ú][A-ZÀ-Ú\s\.\-&]+(?:LTDA|S\.?A\.?|ME|EPP|EIRELI))/
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return searchName;
}

/**
 * Search for news using Perplexity AI
 * @param {string} searchQuery - Optimized search query
 * @param {Object} options - Search options
 * @param {string} options.fonte - Source filter (e.g., "Valor Econômico")
 * @param {string} options.idioma - Language (pt, en, es)
 * @param {string} options.dataInicio - Start date (YYYY-MM-DD)
 * @param {string} options.dataFim - End date (YYYY-MM-DD)
 * @param {number} options.limit - Max results
 * @returns {Promise<Object>} News results with citations
 */
export async function searchNews(searchQuery, options = {}) {
  if (!getApiKey()) {
    logger.warn('[PERPLEXITY] API key not configured');
    return { success: false, error: 'Perplexity API not configured', news: [] };
  }

  const {
    fonte = null,
    idioma = 'pt',
    dataInicio = null,
    dataFim = null,
    limit = 10
  } = options;

  try {
    // Build source filter
    let sourceFilter = '';
    if (fonte && TRUSTED_SOURCES[fonte]) {
      sourceFilter = TRUSTED_SOURCES[fonte];
    }

    // Build date filter description
    let dateFilter = '';
    if (dataInicio && dataFim) {
      dateFilter = `Período: de ${dataInicio} até ${dataFim}.`;
    } else if (dataInicio) {
      dateFilter = `Período: a partir de ${dataInicio}.`;
    } else if (dataFim) {
      dateFilter = `Período: até ${dataFim}.`;
    } else {
      dateFilter = 'Período: última semana.';
    }

    const idiomaMap = {
      'pt': 'em português brasileiro',
      'en': 'in English',
      'es': 'en español'
    };

    const systemPrompt = `Você é um assistente especializado em buscar e resumir notícias.
Sempre retorne as informações em formato JSON estruturado.
Inclua apenas notícias reais e verificáveis.
Priorize fontes confiáveis como: Valor Econômico, InfoMoney, Folha, Estadão, G1, Reuters.`;

    const userPrompt = `Busque notícias recentes sobre: ${searchQuery}
${sourceFilter ? `Fonte específica: ${sourceFilter}` : 'Fontes: qualquer fonte confiável de notícias'}
${dateFilter}
Idioma: ${idiomaMap[idioma] || 'em português brasileiro'}
Limite: ${limit} notícias mais relevantes

Retorne APENAS um JSON válido no formato:
{
  "news": [
    {
      "titulo": "Título da notícia",
      "resumo": "Resumo de 2-3 frases",
      "fonte": "Nome da fonte",
      "url": "URL da notícia",
      "data": "Data de publicação (YYYY-MM-DD)",
      "relevancia": "alta/media/baixa"
    }
  ],
  "total": número_de_resultados,
  "query_used": "query que foi usada na busca"
}`;

    logger.info('[PERPLEXITY] Searching news', { query: searchQuery, fonte, idioma });

    const response = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 4096
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[PERPLEXITY] API error', { status: response.status, error: errorText });
      return { success: false, error: `Perplexity API error: ${response.status}`, news: [] };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const citations = data.citations || [];

    logger.info('[PERPLEXITY] Response received', { contentLength: content.length, citations: citations.length });

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          success: true,
          news: parsed.news || [],
          total: parsed.total || parsed.news?.length || 0,
          query_used: parsed.query_used || searchQuery,
          citations: citations,
          raw_response: content
        };
      } catch (parseError) {
        logger.error('[PERPLEXITY] JSON parse error', { error: parseError.message });
      }
    }

    // Fallback: return raw content if JSON parsing fails
    return {
      success: true,
      news: [],
      total: 0,
      query_used: searchQuery,
      citations: citations,
      raw_response: content,
      parse_error: 'Could not parse structured response'
    };

  } catch (error) {
    logger.error('[PERPLEXITY] Error searching news', { error: error.message });
    return { success: false, error: error.message, news: [] };
  }
}

/**
 * Search for person information using Perplexity AI
 * @param {string} nome - Person name
 * @param {string} cpf - Person CPF (optional)
 * @returns {Promise<Object>} Person information
 */
export async function searchPerson(nome, cpf = null) {
  if (!getApiKey()) {
    logger.warn('[PERPLEXITY] API key not configured');
    return { success: false, error: 'Perplexity API not configured' };
  }

  try {
    let query = `Busque informações sobre a pessoa "${nome}"`;
    if (cpf) {
      const cpfFormatted = formatCpf(cpf);
      query += ` com CPF ${cpfFormatted}`;
    }
    query += ` no Brasil. Retorne: nome completo, cargo/profissão atual, empresa onde trabalha, LinkedIn (se disponível), email profissional (se público), histórico profissional resumido.`;

    logger.info('[PERPLEXITY] Searching person', { nome, hasCpf: !!cpf });

    const response = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: `Você é um assistente especializado em buscar informações profissionais de pessoas brasileiras.
Busque em fontes públicas como LinkedIn, sites de empresas, notícias.
Retorne APENAS um JSON válido no formato especificado.
Se não encontrar informações, retorne um JSON com found: false.`
          },
          {
            role: 'user',
            content: `${query}

Retorne APENAS um JSON válido no formato:
{
  "found": true/false,
  "pessoa": {
    "nome_completo": "Nome completo",
    "cargo_atual": "Cargo atual",
    "empresa_atual": "Empresa onde trabalha",
    "linkedin_url": "URL do LinkedIn ou null",
    "email": "Email profissional ou null",
    "localizacao": "Cidade/Estado",
    "resumo_profissional": "Breve resumo da carreira"
  },
  "experiencias": [
    {
      "cargo": "Cargo",
      "empresa": "Empresa",
      "periodo": "2020-2024"
    }
  ],
  "fontes": ["URLs das fontes consultadas"]
}`
          }
        ],
        temperature: 0.2,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[PERPLEXITY] API error', { status: response.status, error: errorText });
      return { success: false, error: `Perplexity API error: ${response.status}` };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const citations = data.citations || [];

    logger.info('[PERPLEXITY] Person search response', { contentLength: content.length });

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          success: true,
          found: parsed.found,
          pessoa: parsed.pessoa || null,
          experiencias: parsed.experiencias || [],
          fontes: parsed.fontes || citations,
          raw_response: content
        };
      } catch (parseError) {
        logger.error('[PERPLEXITY] JSON parse error', { error: parseError.message });
      }
    }

    return {
      success: true,
      found: false,
      pessoa: null,
      experiencias: [],
      fontes: citations,
      raw_response: content,
      parse_error: 'Could not parse structured response'
    };

  } catch (error) {
    logger.error('[PERPLEXITY] Error searching person', { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Format CPF with punctuation
 */
function formatCpf(cpf) {
  const digits = cpf.replace(/[^\d]/g, '');
  if (digits.length !== 11) return cpf;
  return `${digits.slice(0,3)}.${digits.slice(3,6)}.${digits.slice(6,9)}-${digits.slice(9)}`;
}

/**
 * Check if Perplexity is configured
 */
export function isConfigured() {
  return !!getApiKey();
}

/**
 * Get list of trusted sources
 */
export function getTrustedSources() {
  return Object.keys(TRUSTED_SOURCES);
}
