"""
Query Decomposer - Breaks complex queries into executable sub-queries.

Uses Claude Sonnet to analyze a user query and decompose it into
actionable sub-queries that can be executed against different data sources.
"""

import json
from typing import Optional

import structlog
from pydantic import BaseModel, Field

from api.intelligence.llm_client import call_llm
from api.intelligence.prompts.decomposition_prompts import QUERY_DECOMPOSITION_SYSTEM

logger = structlog.get_logger()


class SubQuery(BaseModel):
    """A single executable sub-query."""

    query: str = Field(..., description="The sub-query text")
    source: str = Field(
        ...,
        description="Data source: db_text, db_vector, graph, serper, perplexity, brasilapi",
    )
    priority: int = Field(default=1, ge=1, le=5, description="Execution priority (1=highest)")
    depends_on: Optional[list[int]] = Field(default=None, description="Indices of sub-queries this depends on")


class DecompositionResult(BaseModel):
    """Result of query decomposition."""

    original_query: str
    sub_queries: list[SubQuery]
    strategy: str = Field(..., description="Overall execution strategy")
    estimated_steps: int = Field(default=1, ge=1)
    parallel_groups: list[list[int]] = Field(
        default_factory=list,
        description="Groups of sub-query indices that can run in parallel",
    )
    model_used: str = ""
    latency_ms: int = 0


async def decompose_query(
    query: str,
    intent: str = "DISCOVERY",
    context: Optional[dict] = None,
) -> DecompositionResult:
    """
    Decompose a complex query into executable sub-queries.

    Args:
        query: The user's natural language query
        intent: Classified intent type
        context: Optional context (previous results, filters, etc.)

    Returns:
        DecompositionResult with ordered sub-queries
    """
    logger.info("decompose_query_start", query=query, intent=intent)

    user_prompt = f"""Query do usuario: "{query}"
Intent classificado: {intent}

Contexto adicional: {json.dumps(context or {}, ensure_ascii=False)}

Decomponha esta query em sub-queries executaveis."""

    try:
        result = await call_llm(
            model="sonnet",
            system_prompt=QUERY_DECOMPOSITION_SYSTEM,
            user_prompt=user_prompt,
            temperature=0.2,
            max_tokens=1500,
        )

        # Parse LLM response
        content = result["content"]

        # Extract JSON from response
        parsed = _extract_json(content)

        if not parsed:
            logger.warn("decompose_parse_failed", content=content[:200])
            # Fallback: single sub-query
            return DecompositionResult(
                original_query=query,
                sub_queries=[SubQuery(query=query, source="db_text", priority=1)],
                strategy="direct_search",
                estimated_steps=1,
                model_used=result.get("model", ""),
                latency_ms=result.get("latency_ms", 0),
            )

        sub_queries = [
            SubQuery(
                query=sq.get("query", query),
                source=sq.get("source", "db_text"),
                priority=sq.get("priority", 1),
                depends_on=sq.get("depends_on"),
            )
            for sq in parsed.get("sub_queries", [])
        ]

        if not sub_queries:
            sub_queries = [SubQuery(query=query, source="db_text", priority=1)]

        return DecompositionResult(
            original_query=query,
            sub_queries=sub_queries,
            strategy=parsed.get("strategy", "sequential"),
            estimated_steps=parsed.get("estimated_steps", len(sub_queries)),
            parallel_groups=parsed.get("parallel_groups", []),
            model_used=result.get("model", ""),
            latency_ms=result.get("latency_ms", 0),
        )

    except Exception as e:
        logger.error("decompose_query_error", query=query, error=str(e))
        # Graceful fallback
        return DecompositionResult(
            original_query=query,
            sub_queries=[SubQuery(query=query, source="db_text", priority=1)],
            strategy="fallback_direct",
            estimated_steps=1,
        )


def _extract_json(text: str) -> Optional[dict]:
    """Extract JSON object from LLM response text."""
    # Try direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try extracting from markdown code block
    import re

    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # Try finding first { to last }
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            pass

    return None
