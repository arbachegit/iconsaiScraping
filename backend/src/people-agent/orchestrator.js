/**
 * People Agent - Orchestrator
 * Main coordinator that wires the 5-step pipeline:
 * 1. Parse Intent
 * 2. Resolve References
 * 3. Execute Query (parallel sources)
 * 4. Update Session
 * 5. Format Response
 */

import logger from '../utils/logger.js';
import { parseIntent, INTENTS } from './intent-parser.js';
import { executeQuery, isConfigured } from './query-builder.js';
import {
  getOrCreateSession,
  addMessage,
  updateLastQuery,
  resolveReferences,
  getConversationContext,
  setSearchContext,
  clearSession,
  getStats
} from './context-manager.js';
import { formatResponse, formatSimpleMessage } from './response-formatter.js';
import { getConfig } from '../atlas/llm-service.js';

/**
 * Process a chat message through the full pipeline
 * @param {Object} params
 * @param {string} params.message - User message
 * @param {string} [params.sessionId] - Existing session ID
 * @returns {Object} - { success, sessionId, response, metadata }
 */
export async function processChat({ message, sessionId, searchContext }) {
  const startTime = Date.now();

  try {
    // Get or create session
    const session = getOrCreateSession(sessionId);

    // If searchContext provided, store it in session
    if (searchContext?.results?.length > 0) {
      setSearchContext(session.id, searchContext);
    }

    // Store user message in history
    addMessage(session.id, 'user', message);

    // Step 1: Parse Intent
    const parsedIntent = parseIntent(message, { lastQuery: session.lastQuery });

    logger.info('People Agent intent parsed', {
      sessionId: session.id,
      intent: parsedIntent.intent,
      confidence: parsedIntent.confidence,
      entities: Object.keys(parsedIntent.entities)
    });

    // Step 2: Resolve References (pronoun/context resolution)
    parsedIntent.entities.rawMessage = message;
    parsedIntent.entities = resolveReferences(parsedIntent.entities, session);

    // Check if we have enough info to query
    if (!isConfigured()) {
      const response = {
        text: formatSimpleMessage('NOT_CONFIGURED'),
        data: null,
        suggestions: []
      };

      return {
        success: false,
        sessionId: session.id,
        response,
        metadata: {
          intent: parsedIntent.intent,
          entities: parsedIntent.entities,
          confidence: parsedIntent.confidence,
          usedLLM: false,
          processingTime: Date.now() - startTime
        }
      };
    }

    // Step 3: Execute Query (parallel across sources)
    const queryResult = await executeQuery(parsedIntent);

    // Step 4: Update Session with query result
    updateLastQuery(session.id, queryResult);

    // Step 5: Format Response (LLM with fallback)
    const conversationHistory = getConversationContext(session.id);
    const formattedResponse = await formatResponse(queryResult, message, conversationHistory);

    // Store assistant response in history
    addMessage(session.id, 'assistant', formattedResponse.text);

    const totalProcessingTime = Date.now() - startTime;

    logger.info('People Agent response generated', {
      sessionId: session.id,
      intent: parsedIntent.intent,
      queryType: queryResult.queryType,
      sources: queryResult.sources_used,
      usedLLM: formattedResponse.usedLLM,
      processingTime: totalProcessingTime
    });

    return {
      success: true,
      sessionId: session.id,
      response: {
        text: formattedResponse.text,
        data: formattedResponse.data,
        suggestions: formattedResponse.suggestions
      },
      metadata: {
        intent: parsedIntent.intent,
        entities: parsedIntent.entities,
        confidence: parsedIntent.confidence,
        usedLLM: formattedResponse.usedLLM,
        processingTime: totalProcessingTime
      }
    };
  } catch (error) {
    logger.error('People Agent processing error', {
      error: error.message,
      stack: error.stack,
      sessionId
    });

    return {
      success: false,
      sessionId: sessionId || null,
      response: {
        text: formatSimpleMessage('GENERAL_ERROR'),
        data: null,
        suggestions: []
      },
      metadata: {
        intent: null,
        entities: {},
        confidence: 0,
        usedLLM: false,
        processingTime: Date.now() - startTime
      }
    };
  }
}

/**
 * Clear a chat session
 * @param {string} sessionId
 * @returns {Object}
 */
export function clearChatSession(sessionId) {
  const deleted = clearSession(sessionId);
  return {
    success: true,
    cleared: deleted
  };
}

/**
 * Get People Agent status
 * @returns {Object}
 */
export function getStatus() {
  const llmConfig = getConfig();
  const sessionStats = getStats();

  return {
    status: 'operational',
    database: isConfigured(),
    llm: llmConfig,
    sessions: sessionStats
  };
}

export default {
  processChat,
  clearChatSession,
  getStatus
};
