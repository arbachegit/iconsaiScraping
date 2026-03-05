"""
Summary Generator - Creates executive summaries with citations.

Generates structured summaries from search results, hypotheses,
and company data with proper source attribution.
"""

import json
from typing import Optional

import structlog
from pydantic import BaseModel, Field

from api.intelligence.llm_client import call_llm
from api.intelligence.prompts.summary_prompts import EXECUTIVE_SUMMARY_SYSTEM

logger = structlog.get_logger()


class Citation(BaseModel):
    """A source citation."""

    source: str = Field(..., description="Source name (e.g. BrasilAPI, Serper)")
    claim: str = Field(..., description="The specific claim being cited")
    url: Optional[str] = Field(default=None, description="Source URL if available")
    confidence: float = Field(default=0.8, ge=0, le=1)


class SummarySection(BaseModel):
    """A section of the executive summary."""

    title: str
    content: str
    citations: list[Citation] = Field(default_factory=list)


class SummaryResult(BaseModel):
    """Result of summary generation."""

    title: str = ""
    sections: list[SummarySection] = Field(default_factory=list)
    key_findings: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    opportunities: list[str] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    total_citations: int = 0
    model_used: str = ""
    latency_ms: int = 0


async def generate_summary(
    query: str,
    search_results: Optional[list] = None,
    hypotheses: Optional[list] = None,
    company_data: Optional[dict] = None,
    relationships: Optional[list] = None,
) -> SummaryResult:
    """
    Generate an executive summary from collected intelligence.

    Args:
        query: Original user query
        search_results: Hybrid search results
        hypotheses: Generated hypotheses
        company_data: Company details
        relationships: Graph relationships

    Returns:
        SummaryResult with structured sections and citations
    """
    logger.info(
        "generate_summary_start",
        query=query[:100],
        results_count=len(search_results or []),
        hypotheses_count=len(hypotheses or []),
    )

    # Build context
    context_parts = []

    if company_data:
        context_parts.append(
            f"EMPRESA PRINCIPAL:\n"
            f"- Razao Social: {company_data.get('razao_social', 'N/A')}\n"
            f"- CNPJ: {company_data.get('cnpj', 'N/A')}\n"
            f"- Cidade: {company_data.get('cidade', 'N/A')}/{company_data.get('estado', '')}\n"
            f"- CNAE: {company_data.get('cnae_descricao', 'N/A')}"
        )

    if search_results:
        results_text = "\n".join(
            f"- {r.get('nome_fantasia') or r.get('razao_social', 'N/A')} "
            f"(score: {r.get('rrf_score', 0):.3f}, fonte: {', '.join(r.get('sources', []))})"
            for r in (search_results or [])[:15]
        )
        context_parts.append(f"RESULTADOS DE BUSCA ({len(search_results)} total):\n{results_text}")

    if hypotheses:
        hyp_text = "\n".join(
            f"- [{h.get('confidence', 0):.0%}] {h.get('title', '')}: {h.get('description', '')[:100]}"
            for h in (hypotheses or [])[:5]
        )
        context_parts.append(f"HIPOTESES GERADAS:\n{hyp_text}")

    if relationships:
        rel_text = "\n".join(
            f"- {r.get('tipo_relacao', 'N/A')}: "
            f"{r.get('source_type', '')}:{r.get('source_id', '')} -> "
            f"{r.get('target_type', '')}:{r.get('target_id', '')} "
            f"(forca: {r.get('strength', 0):.2f})"
            for r in (relationships or [])[:10]
        )
        context_parts.append(f"RELACIONAMENTOS:\n{rel_text}")

    context = "\n\n".join(context_parts)

    user_prompt = f"""Query: "{query}"

Dados coletados:
{context}

Gere um resumo executivo completo com citacoes para cada afirmacao.
Retorne em formato JSON."""

    try:
        result = await call_llm(
            model="sonnet",
            system_prompt=EXECUTIVE_SUMMARY_SYSTEM,
            user_prompt=user_prompt,
            temperature=0.3,
            max_tokens=3000,
        )

        parsed = _extract_json(result["content"])

        if not parsed:
            logger.warn("summary_parse_failed", content=result["content"][:200])
            return SummaryResult(
                title=f"Resumo: {query[:80]}",
                sections=[
                    SummarySection(
                        title="Resumo",
                        content=result["content"][:2000],
                    )
                ],
                model_used=result.get("model", ""),
                latency_ms=result.get("latency_ms", 0),
            )

        sections = [
            SummarySection(
                title=s.get("title", ""),
                content=s.get("content", ""),
                citations=[
                    Citation(
                        source=c.get("source", ""),
                        claim=c.get("claim", ""),
                        url=c.get("url"),
                        confidence=c.get("confidence", 0.8),
                    )
                    for c in s.get("citations", [])
                ],
            )
            for s in parsed.get("sections", [])
        ]

        total_citations = sum(len(s.citations) for s in sections)

        return SummaryResult(
            title=parsed.get("title", f"Resumo: {query[:80]}"),
            sections=sections,
            key_findings=parsed.get("key_findings", []),
            risks=parsed.get("risks", []),
            opportunities=parsed.get("opportunities", []),
            recommendations=parsed.get("recommendations", []),
            total_citations=total_citations,
            model_used=result.get("model", ""),
            latency_ms=result.get("latency_ms", 0),
        )

    except Exception as e:
        logger.error("generate_summary_error", query=query, error=str(e))
        return SummaryResult(
            title=f"Erro no resumo: {query[:50]}",
            sections=[],
        )


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
