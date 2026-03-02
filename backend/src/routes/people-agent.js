/**
 * People Agent - Express Routes
 * Endpoints for the people search conversational agent.
 */

import { Router } from 'express';
import logger from '../utils/logger.js';
import { validateBody, peopleAgentChatSchema, peopleAgentClearSessionSchema } from '../validation/schemas.js';
import { processChat, clearChatSession, getStatus } from '../people-agent/orchestrator.js';

const router = Router();

/**
 * POST /chat - Main conversation endpoint
 */
router.post('/chat', validateBody(peopleAgentChatSchema), async (req, res) => {
  try {
    const { message, sessionId, searchContext } = req.body;

    logger.info('People Agent chat request', {
      messageLength: message.length,
      hasSession: !!sessionId,
      hasSearchContext: !!searchContext
    });

    const result = await processChat({ message, sessionId, searchContext });

    if (!result.success && result.response.text.includes('não está configurado')) {
      return res.status(503).json(result);
    }

    return res.json(result);
  } catch (error) {
    logger.error('People Agent chat error', { error: error.message, stack: error.stack });
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /session/clear - Clear a chat session
 */
router.post('/session/clear', validateBody(peopleAgentClearSessionSchema), async (req, res) => {
  try {
    const { sessionId } = req.body;
    const result = clearChatSession(sessionId);
    return res.json(result);
  } catch (error) {
    logger.error('People Agent clear session error', { error: error.message });
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /status - Service status
 */
router.get('/status', (req, res) => {
  try {
    const status = getStatus();
    return res.json(status);
  } catch (error) {
    logger.error('People Agent status error', { error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

/**
 * GET /health - Health check
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'people-agent',
    timestamp: new Date().toISOString()
  });
});

export default router;
