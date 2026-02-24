import Anthropic from '@anthropic-ai/sdk';
import logger from '../utils/logger.js';

let anthropicClient = null;

function getApiKey() {
  return process.env.ANTHROPIC_API_KEY;
}

function getModel() {
  return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
}

function getClient() {
  const apiKey = getApiKey();
  if (!anthropicClient && apiKey) {
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

/**
 * Transform user keywords into an optimized search prompt for news
 * @param {string} keywords - User input keywords
 * @param {string} fonte - Optional source filter (e.g., "Valor Econômico")
 * @param {string} idioma - Language code (pt, en, es)
 * @param {string} pais - Country code (BR, US, PT)
 * @returns {Promise<Object>} Optimized search query and context
 */
export async function transformToSearchPrompt(keywords, fonte = null, idioma = 'pt', pais = 'BR') {
  const client = getClient();

  if (!client) {
    logger.warn('[ANTHROPIC] API key not configured, using keywords as-is');
    return {
      searchQuery: keywords,
      context: null,
      expanded: false
    };
  }

  try {
    const fonteInstruction = fonte
      ? `A busca deve ser restrita à fonte: ${fonte}. Use o operador site: se aplicável.`
      : 'A busca pode incluir qualquer fonte confiável de notícias.';

    const idiomaMap = {
      'pt': 'português brasileiro',
      'en': 'inglês',
      'es': 'espanhol'
    };

    const paisMap = {
      'BR': 'Brasil',
      'US': 'Estados Unidos',
      'PT': 'Portugal'
    };

    const prompt = `Você é um especialista em transformar palavras-chave em queries de busca otimizadas para encontrar notícias relevantes.

PALAVRAS-CHAVE DO USUÁRIO: "${keywords}"

CONFIGURAÇÕES:
- Idioma: ${idiomaMap[idioma] || 'português brasileiro'}
- País de foco: ${paisMap[pais] || 'Brasil'}
- ${fonteInstruction}

TAREFA:
Transforme as palavras-chave em uma query de busca otimizada que:
1. Expanda sinônimos relevantes
2. Adicione contexto temporal (notícias recentes)
3. Inclua termos relacionados ao mercado/economia se aplicável
4. Mantenha foco no país especificado

Retorne APENAS um JSON válido no formato:
{
  "searchQuery": "a query otimizada para buscar notícias",
  "keywords": ["lista", "de", "keywords", "expandidas"],
  "context": "breve explicação do que será buscado"
}`;

    const response = await client.messages.create({
      model: getModel(),
      max_tokens: 500,
      temperature: 0.3,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const content = response.content[0]?.text || '';

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      logger.info('[ANTHROPIC] Transformed keywords', {
        original: keywords,
        transformed: parsed.searchQuery
      });
      return {
        searchQuery: parsed.searchQuery,
        keywords: parsed.keywords || [keywords],
        context: parsed.context,
        expanded: true
      };
    }

    // Fallback if JSON parsing fails
    return {
      searchQuery: keywords,
      context: null,
      expanded: false
    };

  } catch (error) {
    logger.error('[ANTHROPIC] Error transforming keywords', { error: error.message });
    return {
      searchQuery: keywords,
      context: null,
      expanded: false
    };
  }
}

export function isConfigured() {
  return !!getApiKey();
}
