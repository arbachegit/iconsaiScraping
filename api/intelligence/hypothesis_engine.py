"""
Hypothesis Engine - Generates strategic business hypotheses.

Takes company data, relationships, and market context to generate
actionable strategic hypotheses with confidence levels and evidence.
"""

import json
from typing import Optional

import structlog
from pydantic import BaseModel, Field

from api.intelligence.llm_client import call_llm
from api.intelligence.prompts.hypothesis_prompts import HYPOTHESIS_GENERATION_SYSTEM

logger = structlog.get_logger()


class Hypothesis(BaseModel):
    """A single strategic hypothesis."""

    title: str = Field(..., description="Short hypothesis title")
    description: str = Field(..., description="Detailed description")
    confidence: float = Field(default=0.5, ge=0, le=1, description="Confidence level 0-1")
    evidence: list[str] = Field(default_factory=list, description="Supporting evidence")
    risk_level: str = Field(default="medio", description="alto, medio, baixo")
    category: str = Field(default="general", description="Hypothesis category")
    actionable: bool = Field(default=True, description="Whether this can be acted upon")


class HypothesisResult(BaseModel):
    """Result of hypothesis generation."""

    empresa_id: Optional[str] = None
    hypotheses: list[Hypothesis]
    context_summary: str = ""
    total_data_points: int = 0
    model_used: str = ""
    latency_ms: int = 0


async def generate_hypotheses(
    company_data: Optional[dict] = None,
    relationships: Optional[list] = None,
    search_results: Optional[list] = None,
    query_context: str = "",
    max_hypotheses: int = 5,
) -> HypothesisResult:
    """
    Generate strategic hypotheses based on available data.

    Args:
        company_data: Company details (from dim_empresas)
        relationships: Graph relationships (from fato_relacoes_entidades)
        search_results: Recent search results
        query_context: User's original query for context
        max_hypotheses: Max number of hypotheses to generate

    Returns:
        HypothesisResult with ranked hypotheses
    """
    logger.info(
        "generate_hypotheses_start",
        has_company=company_data is not None,
        relationship_count=len(relationships or []),
        query=query_context[:100],
    )

    # Build context for LLM
    context_parts = []
    total_data_points = 0

    if company_data:
        context_parts.append(f"EMPRESA:\n{json.dumps(company_data, ensure_ascii=False, default=str)}")
        total_data_points += 1

    if relationships:
        rel_summary = _summarize_relationships(relationships)
        context_parts.append(f"RELACIONAMENTOS ({len(relationships)} total):\n{rel_summary}")
        total_data_points += len(relationships)

    if search_results:
        results_summary = _summarize_search_results(search_results[:10])
        context_parts.append(f"RESULTADOS DE BUSCA ({len(search_results)} total):\n{results_summary}")
        total_data_points += len(search_results)

    context = "\n\n".join(context_parts)

    user_prompt = f"""Contexto da analise:
{context}

Query do usuario: "{query_context}"

Gere ate {max_hypotheses} hipoteses estrategicas baseadas nos dados acima.
Retorne em formato JSON."""

    try:
        result = await call_llm(
            model="sonnet",
            system_prompt=HYPOTHESIS_GENERATION_SYSTEM,
            user_prompt=user_prompt,
            temperature=0.4,
            max_tokens=2000,
        )

        parsed = _extract_json(result["content"])

        if not parsed or "hypotheses" not in parsed:
            logger.warn("hypothesis_parse_failed", content=result["content"][:200])
            return HypothesisResult(
                empresa_id=company_data.get("id") if company_data else None,
                hypotheses=[],
                context_summary="Falha ao gerar hipoteses",
                total_data_points=total_data_points,
                model_used=result.get("model", ""),
                latency_ms=result.get("latency_ms", 0),
            )

        hypotheses = [
            Hypothesis(
                title=h.get("title", "Hipotese"),
                description=h.get("description", ""),
                confidence=min(max(h.get("confidence", 0.5), 0), 1),
                evidence=h.get("evidence", []),
                risk_level=h.get("risk_level", "medio"),
                category=h.get("category", "general"),
                actionable=h.get("actionable", True),
            )
            for h in parsed["hypotheses"][:max_hypotheses]
        ]

        return HypothesisResult(
            empresa_id=str(company_data.get("id")) if company_data else None,
            hypotheses=hypotheses,
            context_summary=parsed.get("context_summary", ""),
            total_data_points=total_data_points,
            model_used=result.get("model", ""),
            latency_ms=result.get("latency_ms", 0),
        )

    except Exception as e:
        logger.error("generate_hypotheses_error", error=str(e))
        return HypothesisResult(
            empresa_id=company_data.get("id") if company_data else None,
            hypotheses=[],
            context_summary=f"Erro: {str(e)}",
            total_data_points=total_data_points,
        )


def _summarize_relationships(relationships: list) -> str:
    """Summarize relationships for LLM context."""
    by_type: dict[str, int] = {}
    for rel in relationships:
        tipo = rel.get("tipo_relacao", "unknown")
        by_type[tipo] = by_type.get(tipo, 0) + 1

    lines = [f"- {tipo}: {count} relacionamentos" for tipo, count in by_type.items()]
    return "\n".join(lines) if lines else "Nenhum relacionamento encontrado"


def _summarize_search_results(results: list) -> str:
    """Summarize search results for LLM context."""
    lines = []
    for r in results[:10]:
        name = r.get("nome_fantasia") or r.get("razao_social") or "N/A"
        cidade = r.get("cidade", "")
        score = r.get("rrf_score") or r.get("text_score") or 0
        lines.append(f"- {name} ({cidade}) [score: {score:.3f}]")
    return "\n".join(lines) if lines else "Nenhum resultado"


def _extract_json(text: str) -> Optional[dict]:
    """Extract JSON from LLM response."""
    import re

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            pass

    return None
