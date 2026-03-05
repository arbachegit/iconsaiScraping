/**
 * Google Gemini service for finding company websites
 * Fallback after Apollo and Serper in the enrichment pipeline
 */

import logger from '../utils/logger.js';

// Dynamic import to avoid crash if @google/generative-ai is not installed
let GoogleGenerativeAI = null;

async function loadSDK() {
  if (GoogleGenerativeAI) return true;
  try {
    const mod = await import('@google/generative-ai');
    GoogleGenerativeAI = mod.GoogleGenerativeAI;
    return true;
  } catch {
    logger.warn('Google Generative AI SDK not installed — gemini fallback disabled');
    return false;
  }
}

/**
 * Validate that a URL looks like a real company website
 * @param {string} url
 * @returns {boolean}
 */
function isValidWebsiteUrl(url) {
  if (!url || typeof url !== 'string') return false;

  const trimmed = url.trim();
  if (!/^https?:\/\/.+\..+/.test(trimmed)) return false;

  const excludeDomains = [
    'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com',
    'youtube.com', 'tiktok.com', 'x.com',
    'cnpj.info', 'consultacnpj.com', 'casadosdados.com.br',
    'econodata.com.br', 'empresas.serasaexperian.com.br',
    'google.com', 'wikipedia.org'
  ];

  return !excludeDomains.some(domain => trimmed.includes(domain));
}

/**
 * Find a company's official website using Google Gemini
 * @param {string} companyName - Company name (nome_fantasia or razao_social)
 * @param {string|null} cidade - City
 * @param {string|null} estado - State
 * @returns {Promise<string|null>} Website URL or null
 */
export async function findCompanyWebsite(companyName, cidade = null, estado = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.debug('GEMINI_API_KEY not set — skipping Gemini website lookup');
    return null;
  }

  const sdkLoaded = await loadSDK();
  if (!sdkLoaded) return null;

  const location = [cidade, estado].filter(Boolean).join(', ');
  const locationStr = location ? ` localizada em ${location}, Brasil` : ' no Brasil';

  const prompt = `Voce e um assistente especializado em encontrar websites oficiais de empresas brasileiras.

Dado o nome da empresa "${companyName}"${locationStr}:

1. Retorne APENAS a URL do website oficial da empresa
2. Se nao souber com certeza, retorne "null"
3. NAO retorne URLs de redes sociais (linkedin, facebook, instagram, twitter)
4. NAO retorne URLs de sites de consulta de CNPJ
5. A URL deve comecar com http:// ou https://
6. Retorne APENAS a URL, sem explicacao adicional

URL:`;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    logger.info('[GEMINI] Website lookup', { companyName, cidade, estado, result: text });

    // Parse response — expect a URL or "null"
    if (!text || text.toLowerCase() === 'null' || text.toLowerCase().includes('não') || text.toLowerCase().includes('nao')) {
      return null;
    }

    // Extract URL if embedded in text
    const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/);
    const url = urlMatch ? urlMatch[0] : null;

    if (url && isValidWebsiteUrl(url)) {
      logger.info('[GEMINI] Website found', { companyName, website: url });
      return url;
    }

    return null;
  } catch (error) {
    logger.error('[GEMINI] Error finding website', { companyName, error });
    return null;
  }
}
