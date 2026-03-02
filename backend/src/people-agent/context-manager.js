/**
 * People Agent - Context Manager
 * In-memory session storage with TTL-based expiration.
 * Manages conversation history and entity resolution.
 */

import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';

// Session TTL in seconds (default 30 minutes)
const SESSION_TTL = parseInt(process.env.PEOPLE_AGENT_SESSION_TTL || '1800', 10);

// In-memory session store
const sessions = new Map();

/**
 * Get or create a session
 * @param {string} [sessionId] - Existing session ID
 * @returns {Object} - Session object
 */
export function getOrCreateSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.lastActivity = Date.now();
    return session;
  }

  const id = sessionId || randomUUID();
  const session = {
    id,
    lastQuery: null,
    conversationHistory: [],
    resolvedEntities: {
      currentPerson: null,  // { id, nome, cpf, empresa }
      currentCompany: null  // { nome, cnpj }
    },
    searchContext: null,  // { query, results, selectedPerson }
    createdAt: Date.now(),
    lastActivity: Date.now()
  };

  sessions.set(id, session);
  logger.debug('People Agent session created', { sessionId: id });
  return session;
}

/**
 * Get existing session
 * @param {string} sessionId
 * @returns {Object|null}
 */
export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/**
 * Add message to conversation history
 * @param {string} sessionId
 * @param {string} role - 'user' or 'assistant'
 * @param {string} content
 */
export function addMessage(sessionId, role, content) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.conversationHistory.push({
    role,
    content,
    timestamp: Date.now()
  });

  // Keep max 20 messages
  if (session.conversationHistory.length > 20) {
    session.conversationHistory = session.conversationHistory.slice(-20);
  }

  session.lastActivity = Date.now();
}

/**
 * Update session with last query result and resolve entities
 * @param {string} sessionId
 * @param {Object} queryResult
 */
export function updateLastQuery(sessionId, queryResult) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.lastQuery = queryResult;
  session.lastActivity = Date.now();

  // Update resolved entities from query result
  const { data, queryType } = queryResult;
  if (!data) return;

  // Extract person from results
  if (queryType === 'person_details' && data.profile) {
    session.resolvedEntities.currentPerson = {
      id: data.profile.id || null,
      nome: data.profile.nome_completo || data.profile.nome || null,
      cpf: data.profile.cpf || null,
      empresa: data.profile.empresa_atual || null
    };
  } else if (queryType === 'search_person' && Array.isArray(data) && data.length === 1) {
    // Single result from search → auto-resolve
    const person = data[0];
    session.resolvedEntities.currentPerson = {
      id: person.id || null,
      nome: person.nome_completo || person.nome || null,
      cpf: person.cpf || null,
      empresa: person.empresa_atual || null
    };
  }

  // Extract company reference
  if (data.profile?.empresa_atual) {
    session.resolvedEntities.currentCompany = {
      nome: data.profile.empresa_atual,
      cnpj: null
    };
  }
}

/**
 * Resolve pronoun/context references from session
 * @param {Object} entities - Currently extracted entities
 * @param {Object} session - Current session
 * @returns {Object} - Entities with resolved references
 */
export function resolveReferences(entities, session) {
  const resolved = { ...entities };

  if (!session?.resolvedEntities) return resolved;

  // Check for ordinal references to search context results
  // e.g. "o primeiro", "pessoa #2", "segundo resultado"
  if (session.searchContext?.results?.length > 0 && resolved.rawMessage) {
    const msg = resolved.rawMessage.toLowerCase();
    const ordinals = {
      'primeiro': 0, 'primeira': 0, '#1': 0, 'resultado 1': 0,
      'segundo': 1, 'segunda': 1, '#2': 1, 'resultado 2': 1,
      'terceiro': 2, 'terceira': 2, '#3': 2, 'resultado 3': 2,
      'quarto': 3, 'quarta': 3, '#4': 3, 'resultado 4': 3,
      'quinto': 4, 'quinta': 4, '#5': 4, 'resultado 5': 4,
      'último': -1, 'ultima': -1,
    };

    for (const [keyword, index] of Object.entries(ordinals)) {
      if (msg.includes(keyword)) {
        const results = session.searchContext.results;
        const resolvedIndex = index === -1 ? results.length - 1 : index;
        const person = results[resolvedIndex];

        if (person) {
          if (person.nome_completo) resolved.nome = person.nome_completo;
          if (person.empresa_atual && !resolved.empresa) resolved.empresa = person.empresa_atual;
          resolved._resolvedFromSearchContext = true;

          logger.debug('Resolved ordinal reference from search context', {
            sessionId: session.id,
            keyword,
            resolvedName: person.nome_completo
          });
          break;
        }
      }
    }
  }

  // If no name/cpf specified, use current person from context
  if (!resolved.nome && !resolved.cpf && session.resolvedEntities.currentPerson) {
    const person = session.resolvedEntities.currentPerson;
    if (person.nome) resolved.nome = person.nome;
    if (person.cpf) resolved.cpf = person.cpf;
    if (person.empresa && !resolved.empresa) resolved.empresa = person.empresa;

    logger.debug('Resolved person reference from context', {
      sessionId: session.id,
      resolvedName: person.nome
    });
  }

  // If no company specified, use current company from context
  if (!resolved.empresa && session.resolvedEntities.currentCompany) {
    resolved.empresa = session.resolvedEntities.currentCompany.nome;
  }

  return resolved;
}

/**
 * Get recent conversation context for LLM
 * @param {string} sessionId
 * @param {number} maxMessages
 * @returns {Array}
 */
export function getConversationContext(sessionId, maxMessages = 6) {
  const session = sessions.get(sessionId);
  if (!session) return [];

  return session.conversationHistory
    .slice(-maxMessages)
    .map(({ role, content }) => ({ role, content }));
}

/**
 * Set search context from modal results
 * @param {string} sessionId
 * @param {Object} searchContext - { query, results, selectedPerson }
 */
export function setSearchContext(sessionId, searchContext) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.searchContext = searchContext;
  session.lastActivity = Date.now();

  logger.debug('Search context set', {
    sessionId,
    query: searchContext?.query,
    resultsCount: searchContext?.results?.length || 0
  });
}

/**
 * Get search context for a session
 * @param {string} sessionId
 * @returns {Object|null}
 */
export function getSearchContext(sessionId) {
  const session = sessions.get(sessionId);
  return session?.searchContext || null;
}

/**
 * Clear a session
 * @param {string} sessionId
 */
export function clearSession(sessionId) {
  const deleted = sessions.delete(sessionId);
  if (deleted) {
    logger.debug('People Agent session cleared', { sessionId });
  }
  return deleted;
}

/**
 * Get session statistics
 * @returns {Object}
 */
export function getStats() {
  return {
    activeSessions: sessions.size,
    sessionTtl: SESSION_TTL
  };
}

// Auto-cleanup expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  const ttlMs = SESSION_TTL * 1000;
  let cleaned = 0;

  for (const [id, session] of sessions) {
    if (now - session.lastActivity > ttlMs) {
      sessions.delete(id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug('People Agent sessions cleaned', { cleaned, remaining: sessions.size });
  }
}, 5 * 60 * 1000);

export default {
  getOrCreateSession,
  getSession,
  addMessage,
  updateLastQuery,
  resolveReferences,
  getConversationContext,
  setSearchContext,
  getSearchContext,
  clearSession,
  getStats
};
