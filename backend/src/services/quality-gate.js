/**
 * Quality Gate Service
 * Validates and scores search results using LLM batch evaluation.
 * Filters out low-quality results (< 50% score).
 */

import { generate } from '../atlas/llm-service.js';
import logger from '../utils/logger.js';

const QUALITY_GATE_TIMEOUT_MS = parseInt(process.env.QUALITY_GATE_TIMEOUT_MS || '3000', 10);
const QUALITY_GATE_MAX_BATCH = 10;

/**
 * Build simplified result summaries for the LLM prompt
 * @param {Array} results - Search results
 * @returns {Array} - Simplified objects
 */
function simplifyResults(results) {
  return results.map((r, i) => ({
    index: i,
    nome: r.nome_completo || null,
    cargo: r.cargo_atual || null,
    empresa: r.empresa_atual || null,
    email: r.email || null,
    linkedin: r.linkedin_url ? 'sim' : 'nao',
    localizacao: r.localizacao || null,
    resumo: r.resumo_profissional ? r.resumo_profissional.slice(0, 120) : null,
    fonte: r._source || null,
  }));
}

/**
 * Run Quality Gate on search results via LLM batch evaluation
 * @param {Array} results - Ranked search results (max 10)
 * @param {string} searchQuery - Original search query
 * @param {Object} [options] - Options
 * @param {number} [options.timeoutMs] - Timeout override
 * @returns {Promise<Object>} - { scores, durationMs }
 */
export async function runQualityGate(results, searchQuery, options = {}) {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs || QUALITY_GATE_TIMEOUT_MS;
  const batch = results.slice(0, QUALITY_GATE_MAX_BATCH);

  if (batch.length === 0) {
    return {
      scores: [],
      durationMs: Date.now() - startTime,
    };
  }

  const simplified = simplifyResults(batch);

  const systemPrompt = `Você é um avaliador de qualidade de resultados de busca de pessoas.
Avalie cada resultado com base na query de busca e retorne APENAS um JSON array.

Critérios de pontuação (0-100):
- 90-100: Perfil completo (nome, cargo, empresa, contato)
- 70-89: Bom (nome + cargo ou empresa, algum contato)
- 50-69: Parcial (nome + alguma info relevante)
- 0-49: Baixa qualidade (dados insuficientes ou inconsistentes)

Avalie:
1. Consistência nome/cargo/empresa com a query
2. Completude dos dados (campos preenchidos)
3. Coerência geral do perfil

Retorne EXATAMENTE um JSON array (sem markdown, sem texto extra):
[{"index":0,"score":85,"label":"high","reasoning":"perfil completo com cargo e empresa","enrichments":{"campo":"valor_inferido"}}]

Labels: "high" (>=75), "medium" (50-74), "filtered" (<50)
enrichments: campos que podem ser inferidos dos dados existentes (ex: se tem empresa e cargo, inferir setor). Retorne {} se nada a inferir.`;

  const userMessage = `Query de busca: "${searchQuery}"

Resultados para avaliar:
${JSON.stringify(simplified, null, 2)}`;

  try {
    const llmPromise = generate(systemPrompt, [{ role: 'user', content: userMessage }]);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Quality Gate timeout')), timeoutMs)
    );

    const llmResult = await Promise.race([llmPromise, timeoutPromise]);

    if (!llmResult.success || !llmResult.text) {
      logger.warn('Quality Gate LLM returned no result');
      return {
        scores: [],
        durationMs: Date.now() - startTime,
      };
    }

    // Parse LLM response — extract JSON array
    let scores;
    try {
      const text = llmResult.text.trim();
      // Try to extract JSON array from response (handle markdown fences)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('No JSON array found in response');
      }
      scores = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      logger.warn('Quality Gate JSON parse failed', { error: parseError.message, raw: llmResult.text?.slice(0, 200) });
      return {
        scores: [],
        durationMs: Date.now() - startTime,
      };
    }

    // Validate and normalize scores
    const validScores = scores
      .filter(s => typeof s.index === 'number' && typeof s.score === 'number')
      .map(s => ({
        index: s.index,
        score: Math.max(0, Math.min(100, Math.round(s.score))),
        label: s.score >= 75 ? 'high' : s.score >= 50 ? 'medium' : 'filtered',
        enrichments: s.enrichments && typeof s.enrichments === 'object' ? s.enrichments : {},
        reasoning: s.reasoning || '',
      }));

    const durationMs = Date.now() - startTime;

    logger.info('Quality Gate completed', {
      batchSize: batch.length,
      scoredCount: validScores.length,
      filteredCount: validScores.filter(s => s.label === 'filtered').length,
      avgScore: validScores.length > 0
        ? Math.round(validScores.reduce((sum, s) => sum + s.score, 0) / validScores.length)
        : 0,
      durationMs,
    });

    return {
      scores: validScores,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.warn('Quality Gate failed (graceful degradation)', {
      error: error.message,
      durationMs,
    });

    // Graceful degradation — return empty scores (results pass through without filtering)
    return {
      scores: [],
      durationMs,
    };
  }
}
