"""
Intelligence Router - FastAPI endpoints for the LLM intelligence engine.

Endpoints:
- POST /api/intelligence/query - Full intelligence pipeline
- POST /api/intelligence/classify - Intent classification only
- POST /api/intelligence/hypotheses - Hypothesis generation
- POST /api/intelligence/summary - Executive summary
- GET /api/intelligence/stream - SSE streaming intelligence
"""

from typing import Optional

import structlog
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.intelligence.intent_classifier import classify_intent
from api.intelligence.query_decomposer import decompose_query
from api.intelligence.hypothesis_engine import generate_hypotheses
from api.intelligence.summary_generator import generate_summary

logger = structlog.get_logger()

router = APIRouter(prefix="/api/intelligence", tags=["Intelligence"])


# ============================================
# REQUEST/RESPONSE SCHEMAS
# ============================================


class IntelligenceQueryRequest(BaseModel):
    """Main intelligence query request."""

    query: str = Field(..., min_length=2, max_length=1000, description="Natural language query")
    context: Optional[dict] = Field(default=None, description="Additional context")
    include_hypotheses: bool = Field(default=True)
    include_summary: bool = Field(default=True)
    max_results: int = Field(default=20, ge=1, le=100)


class ClassifyRequest(BaseModel):
    """Intent classification request."""

    query: str = Field(..., min_length=2, max_length=1000)


class HypothesesRequest(BaseModel):
    """Hypothesis generation request."""

    empresa_id: Optional[str] = None
    company_data: Optional[dict] = None
    relationships: Optional[list] = None
    search_results: Optional[list] = None
    query_context: str = Field(default="", max_length=500)
    max_hypotheses: int = Field(default=5, ge=1, le=10)


class SummaryRequest(BaseModel):
    """Summary generation request."""

    query: str = Field(..., min_length=2, max_length=1000)
    search_results: Optional[list] = None
    hypotheses: Optional[list] = None
    company_data: Optional[dict] = None
    relationships: Optional[list] = None


# ============================================
# ENDPOINTS
# ============================================


@router.post("/query")
async def intelligence_query(request: IntelligenceQueryRequest):
    """
    Full intelligence pipeline:
    1. Classify intent
    2. Decompose query
    3. (Execute sub-queries - delegated to Node.js)
    4. Generate hypotheses (optional)
    5. Generate summary (optional)
    """
    logger.info("intelligence_query_start", query=request.query[:100])

    import time

    start = time.time()

    try:
        # Step 1: Classify intent
        intent_result = await classify_intent(request.query)

        # Step 2: Decompose query
        decomposition = await decompose_query(
            query=request.query,
            intent=intent_result.intent,
            context=request.context,
        )

        result = {
            "success": True,
            "query": request.query,
            "intent": intent_result.model_dump(),
            "decomposition": decomposition.model_dump(),
        }

        # Step 3: Generate hypotheses (if requested and we have context)
        if request.include_hypotheses and request.context:
            hypotheses_result = await generate_hypotheses(
                company_data=request.context.get("company_data"),
                relationships=request.context.get("relationships"),
                search_results=request.context.get("search_results"),
                query_context=request.query,
            )
            result["hypotheses"] = hypotheses_result.model_dump()

        # Step 4: Generate summary (if requested)
        if request.include_summary and request.context:
            summary_result = await generate_summary(
                query=request.query,
                search_results=request.context.get("search_results"),
                hypotheses=(
                    [h.model_dump() for h in hypotheses_result.hypotheses]
                    if request.include_hypotheses and request.context
                    else None
                ),
                company_data=request.context.get("company_data"),
                relationships=request.context.get("relationships"),
            )
            result["summary"] = summary_result.model_dump()

        result["latency_ms"] = int((time.time() - start) * 1000)

        logger.info(
            "intelligence_query_complete",
            query=request.query[:50],
            intent=intent_result.intent,
            latency_ms=result["latency_ms"],
        )

        return result

    except Exception as e:
        logger.error("intelligence_query_error", query=request.query[:50], error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/classify")
async def classify_query(request: ClassifyRequest):
    """Classify the intent of a query."""
    try:
        result = await classify_intent(request.query)
        return {
            "success": True,
            "query": request.query,
            **result.model_dump(),
        }
    except Exception as e:
        logger.error("classify_error", query=request.query[:50], error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/hypotheses")
async def generate_hypotheses_endpoint(request: HypothesesRequest):
    """Generate strategic hypotheses for a company or search context."""
    try:
        result = await generate_hypotheses(
            company_data=request.company_data,
            relationships=request.relationships,
            search_results=request.search_results,
            query_context=request.query_context,
            max_hypotheses=request.max_hypotheses,
        )
        return {
            "success": True,
            **result.model_dump(),
        }
    except Exception as e:
        logger.error("hypotheses_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/summary")
async def generate_summary_endpoint(request: SummaryRequest):
    """Generate an executive summary from collected intelligence."""
    try:
        result = await generate_summary(
            query=request.query,
            search_results=request.search_results,
            hypotheses=request.hypotheses,
            company_data=request.company_data,
            relationships=request.relationships,
        )
        return {
            "success": True,
            **result.model_dump(),
        }
    except Exception as e:
        logger.error("summary_error", query=request.query[:50], error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/stream")
async def stream_intelligence(
    q: str = Query(..., min_length=2, max_length=1000, description="Query"),
):
    """
    SSE streaming intelligence results.
    Progressive stages: classify -> decompose -> hypotheses -> summary
    """

    async def event_generator():
        import json
        import time

        try:
            # Stage 1: Classify
            start = time.time()
            intent = await classify_intent(q)
            yield f"event: intent\ndata: {json.dumps({'stage': 'intent', **intent.model_dump()}, default=str)}\n\n"

            # Stage 2: Decompose
            decomposition = await decompose_query(q, intent.intent)
            yield f"event: decomposition\ndata: {json.dumps({'stage': 'decomposition', **decomposition.model_dump()}, default=str)}\n\n"

            # Stage 3: Hypotheses (with empty context for stream mode)
            hypotheses = await generate_hypotheses(query_context=q)
            yield f"event: hypotheses\ndata: {json.dumps({'stage': 'hypotheses', **hypotheses.model_dump()}, default=str)}\n\n"

            # Stage 4: Summary
            summary = await generate_summary(query=q)
            yield f"event: summary\ndata: {json.dumps({'stage': 'summary', **summary.model_dump()}, default=str)}\n\n"

            # Complete
            latency = int((time.time() - start) * 1000)
            yield f"event: complete\ndata: {json.dumps({'stage': 'complete', 'latency_ms': latency})}\n\n"

        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
