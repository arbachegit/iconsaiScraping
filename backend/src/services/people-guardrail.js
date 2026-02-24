/**
 * People Guardrail Service
 * Validates and normalizes person search queries before execution.
 * - CPF: modulo-11 check digit validation
 * - Nome: robustness evaluation (tokens, length, common names)
 * - LLM normalization: optional name cleanup via Anthropic/OpenAI (2s timeout)
 */

import { generate } from '../atlas/llm-service.js';
import logger from '../utils/logger.js';

// ~70 common Brazilian first names and surnames that are too ambiguous alone
const COMMON_NAMES = new Set([
  // First names
  'joao', 'maria', 'jose', 'ana', 'pedro', 'paulo', 'carlos', 'francisco',
  'antonio', 'lucas', 'marcos', 'rafael', 'gabriel', 'bruno', 'daniel',
  'fernando', 'felipe', 'rodrigo', 'anderson', 'andre', 'diego', 'thiago',
  'leandro', 'marcelo', 'ricardo', 'eduardo', 'gustavo', 'henrique', 'matheus',
  'patricia', 'juliana', 'camila', 'fernanda', 'aline', 'bruna', 'jessica',
  'amanda', 'larissa', 'leticia', 'vanessa', 'adriana', 'renata', 'tatiana',
  'claudia', 'cristina', 'sandra', 'lucia', 'rosa', 'mariana', 'carolina',
  // Common surnames (ambiguous alone)
  'silva', 'santos', 'souza', 'oliveira', 'pereira', 'costa', 'rodrigues',
  'almeida', 'nascimento', 'lima', 'araujo', 'fernandes', 'carvalho', 'gomes',
  'martins', 'rocha', 'ribeiro', 'alves', 'monteiro', 'mendes', 'barros',
  'freitas', 'barbosa', 'moura', 'nunes', 'moreira', 'aguiar'
]);

/**
 * Mask CPF for logs — never expose full CPF
 * Input: "12345678901" → Output: "***.456.***-**"
 * @param {string} cpf - Raw CPF (11 digits)
 * @returns {string} Masked CPF
 */
export function maskCpf(cpf) {
  if (!cpf || cpf.length !== 11) return '***.***.***-**';
  return `***.${cpf.slice(3, 6)}.***-**`;
}

/**
 * Validate CPF check digits using modulo-11 algorithm
 * @param {string} cpf - 11-digit string
 * @returns {boolean} true if check digits are valid
 */
export function isValidCpfCheckDigit(cpf) {
  if (!cpf || cpf.length !== 11) return false;

  // Reject all-same-digit CPFs (e.g., 11111111111)
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digits = cpf.split('').map(Number);

  // First check digit
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += digits[i] * (10 - i);
  }
  let remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  if (remainder !== digits[9]) return false;

  // Second check digit
  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += digits[i] * (11 - i);
  }
  remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  if (remainder !== digits[10]) return false;

  return true;
}

/**
 * Evaluate name robustness for search quality
 * A name is "robust" if it is specific enough to yield meaningful results.
 *
 * Criteria:
 * 1. Token count >= 3 (e.g., "Maria Clara Souza") → robust
 * 2. Token count >= 2 AND total chars >= 12 → robust
 * 3. Token count == 1 or all tokens are common names → weak (needs auxiliary fields)
 *
 * @param {string} nome - The name to evaluate
 * @param {{ cidadeUf?: string, dataNascimento?: string }} auxiliaryFields
 * @returns {{ robust: boolean, reason: string, requiredFields: string[] }}
 */
export function evaluateNameRobustness(nome, auxiliaryFields = {}) {
  if (!nome || nome.trim().length < 2) {
    return {
      robust: false,
      reason: 'Nome muito curto (mínimo 2 caracteres)',
      requiredFields: ['nome']
    };
  }

  const normalized = nome.trim().toLowerCase();
  const tokens = normalized.split(/\s+/).filter(t => t.length >= 2);
  const totalChars = tokens.join('').length;
  const hasAuxiliary = !!(auxiliaryFields.cidadeUf || auxiliaryFields.dataNascimento);

  // All tokens are common names?
  const allCommon = tokens.every(t => COMMON_NAMES.has(t));

  // Criterion 1: 3+ tokens → robust (regardless of commonality)
  if (tokens.length >= 3 && totalChars >= 12) {
    return { robust: true, reason: 'Nome com 3+ tokens e comprimento adequado', requiredFields: [] };
  }

  // Criterion 2: 2 tokens, >= 12 chars, not all common → robust
  if (tokens.length >= 2 && totalChars >= 12 && !allCommon) {
    return { robust: true, reason: 'Nome com 2 tokens distintos e comprimento adequado', requiredFields: [] };
  }

  // Criterion 3: 2 tokens but all common → needs auxiliary OR allow with warning
  if (tokens.length >= 2 && allCommon) {
    if (hasAuxiliary) {
      return { robust: true, reason: 'Nome comum mas com dados auxiliares (cidade/UF ou data nascimento)', requiredFields: [] };
    }
    return {
      robust: false,
      reason: `"${nome.trim()}" é um nome muito comum. Adicione cidade/UF ou data de nascimento para refinar a busca.`,
      requiredFields: ['cidadeUf', 'dataNascimento']
    };
  }

  // Criterion 4: 2 tokens, < 12 chars → needs auxiliary
  if (tokens.length >= 2) {
    if (hasAuxiliary) {
      return { robust: true, reason: 'Nome curto mas com dados auxiliares', requiredFields: [] };
    }
    return {
      robust: false,
      reason: `"${nome.trim()}" é um nome curto. Adicione cidade/UF ou data de nascimento para refinar a busca.`,
      requiredFields: ['cidadeUf', 'dataNascimento']
    };
  }

  // Single token → always weak
  if (hasAuxiliary) {
    return {
      robust: false,
      reason: 'Nome com apenas 1 palavra. Informe pelo menos nome e sobrenome.',
      requiredFields: ['nome']
    };
  }

  return {
    robust: false,
    reason: 'Informe nome completo (nome e sobrenome) para buscar.',
    requiredFields: ['nome']
  };
}

/**
 * Normalize a name using LLM (with 2s timeout)
 * Fixes casing, removes extra spaces, standardizes format.
 * Falls back to raw name if LLM fails or times out.
 *
 * @param {string} nome - Raw name input
 * @returns {Promise<string>} Normalized name
 */
async function normalizeName(nome) {
  const trimmed = nome.trim();

  try {
    const systemPrompt = `Você é um normalizador de nomes brasileiros. Sua ÚNICA tarefa é corrigir capitalização e formatação de nomes próprios brasileiros. Retorne APENAS o nome corrigido, sem explicações.

Regras:
- Primeira letra de cada nome maiúscula
- Preposições em minúscula: de, da, do, das, dos, e
- Remover espaços extras
- NÃO inventar nomes — apenas formatar o que recebeu

Exemplos:
"joao silva" → "João Silva"
"MARIA DA SILVA SANTOS" → "Maria da Silva Santos"
"pedro de oliveira" → "Pedro de Oliveira"`;

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('LLM timeout')), 2000)
    );

    const llmPromise = generate(systemPrompt, [
      { role: 'user', content: trimmed }
    ]);

    const result = await Promise.race([llmPromise, timeoutPromise]);

    if (result?.success && result?.text) {
      const normalized = result.text.trim();
      // Sanity check: LLM output should be similar length (not a hallucination)
      if (normalized.length > 0 && normalized.length < trimmed.length * 3) {
        return normalized;
      }
    }
  } catch (err) {
    logger.debug('LLM name normalization failed, using raw', { error: err.message });
  }

  // Fallback: basic capitalization
  return trimmed
    .toLowerCase()
    .replace(/\b(\w)/g, (_, c) => c.toUpperCase())
    .replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase());
}

/**
 * Run the full guardrail pipeline
 *
 * @param {{ searchType: 'cpf'|'nome', cpf?: string, nome?: string, dataNascimento?: string, cidadeUf?: string }} params
 * @returns {Promise<{ allowed: boolean, reason: string, requiredFields: string[], normalizedQuery: string, durationMs: number }>}
 */
export async function runGuardrail({ searchType, cpf, nome, dataNascimento, cidadeUf }) {
  const startTime = Date.now();

  // ---- CPF mode ----
  if (searchType === 'cpf') {
    if (!cpf || cpf.length !== 11) {
      return {
        allowed: false,
        reason: 'CPF deve ter exatamente 11 dígitos',
        requiredFields: ['cpf'],
        normalizedQuery: cpf || '',
        durationMs: Date.now() - startTime
      };
    }

    if (!isValidCpfCheckDigit(cpf)) {
      return {
        allowed: false,
        reason: 'CPF inválido (dígito verificador incorreto)',
        requiredFields: ['cpf'],
        normalizedQuery: maskCpf(cpf),
        durationMs: Date.now() - startTime
      };
    }

    return {
      allowed: true,
      reason: 'CPF válido',
      requiredFields: [],
      normalizedQuery: cpf,
      durationMs: Date.now() - startTime
    };
  }

  // ---- Nome mode ----
  if (!nome || nome.trim().length < 2) {
    return {
      allowed: false,
      reason: 'Nome é obrigatório (mínimo 2 caracteres)',
      requiredFields: ['nome'],
      normalizedQuery: '',
      durationMs: Date.now() - startTime
    };
  }

  const robustness = evaluateNameRobustness(nome, { cidadeUf, dataNascimento });

  if (!robustness.robust) {
    return {
      allowed: false,
      reason: robustness.reason,
      requiredFields: robustness.requiredFields,
      normalizedQuery: nome.trim(),
      durationMs: Date.now() - startTime
    };
  }

  // Name is robust → normalize via LLM
  const normalizedQuery = await normalizeName(nome);

  return {
    allowed: true,
    reason: robustness.reason,
    requiredFields: [],
    normalizedQuery,
    durationMs: Date.now() - startTime
  };
}

export default {
  maskCpf,
  isValidCpfCheckDigit,
  evaluateNameRobustness,
  runGuardrail
};
