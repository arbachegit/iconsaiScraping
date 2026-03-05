"""
Intent Classifier - Classifies user queries into strategic intent types.

Uses a two-phase approach:
1. Pattern-based classification (fast, no LLM call)
2. Claude Haiku fallback when pattern confidence < 0.7
"""

import json
import re
from enum import Enum

import structlog
from pydantic import BaseModel, Field

from api.intelligence.llm_client import call_llm
from api.intelligence.prompts.intent_prompts import INTENT_CLASSIFICATION_SYSTEM

logger = structlog.get_logger()


# ===========================================
# INTENT TYPES
# ===========================================


class IntentType(str, Enum):
    """Supported intent types for query classification."""

    DISCOVERY = "DISCOVERY"
    COMPARISON = "COMPARISON"
    RISK_ANALYSIS = "RISK_ANALYSIS"
    RELATIONSHIP_MAPPING = "RELATIONSHIP_MAPPING"
    TREND_ANALYSIS = "TREND_ANALYSIS"
    REGULATORY_CHECK = "REGULATORY_CHECK"
    ENRICHMENT = "ENRICHMENT"
    UNKNOWN = "UNKNOWN"


# ===========================================
# RESULT MODEL
# ===========================================


class IntentResult(BaseModel):
    """Result of intent classification."""

    intent: str = Field(..., description="Classified intent type")
    confidence: float = Field(
        ..., ge=0.0, le=1.0, description="Classification confidence (0.0-1.0)"
    )
    entities: list[str] = Field(
        default_factory=list, description="Extracted entities from the query"
    )
    filters: dict[str, str] = Field(
        default_factory=dict, description="Extracted filters (e.g., city, segment)"
    )
    method: str = Field(
        ..., description="Classification method used: 'pattern' or 'llm'"
    )


# ===========================================
# PATTERN DEFINITIONS
# ===========================================

# Each pattern maps to (intent_type, base_confidence).
# Patterns are evaluated in order; first match wins.
# Confidence is boosted by entity extraction and multiple keyword hits.

_INTENT_PATTERNS: list[tuple[IntentType, list[str], float]] = [
    (
        IntentType.COMPARISON,
        [
            r"\bcomparar\b",
            r"\bvs\.?\b",
            r"\bversus\b",
            r"\bdiferen[cç]a\s+entre\b",
            r"\bcompar(?:a[cç][aã]o|ativo)\b",
            r"\bmelhor\s+(?:que|do\s+que)\b",
        ],
        0.85,
    ),
    (
        IntentType.RISK_ANALYSIS,
        [
            r"\brisco\b",
            r"\bamea[cç]a\b",
            r"\bvulnerabilidade\b",
            r"\bcompliance\b",
            r"\bauditoria\b",
            r"\bfraud[e]?\b",
            r"\birregularidade\b",
            r"\bsanit[aá]ri[ao]\b",
        ],
        0.85,
    ),
    (
        IntentType.RELATIONSHIP_MAPPING,
        [
            r"\bquem\s+conhece\b",
            r"\bconectado\s+a\b",
            r"\brede\s+de\b",
            r"\bs[oó]cios?\s+d[eao]\b",
            r"\brela[cç][aã]o\s+(?:entre|com)\b",
            r"\bparticipa[cç][aã]o\s+(?:em|societ[aá]ria)\b",
            r"\bquadro\s+societ[aá]rio\b",
            r"\bligad[oa]\s+a\b",
        ],
        0.85,
    ),
    (
        IntentType.TREND_ANALYSIS,
        [
            r"\btend[eê]ncia\b",
            r"\bcrescimento\b",
            r"\bmercado\s+de\b",
            r"\bevolu[cç][aã]o\b",
            r"\bhist[oó]rico\b",
            r"\bproje[cç][aã]o\b",
            r"\bcen[aá]rio\b",
            r"\bsazonalidade\b",
        ],
        0.80,
    ),
    (
        IntentType.REGULATORY_CHECK,
        [
            r"\bregulat[oó]rio\b",
            r"\bconformidade\b",
            r"\blgpd\b",
            r"\blei\b",
            r"\bnorma(?:tiv[ao])?\b",
            r"\blegisla[cç][aã]o\b",
            r"\bfiscaliza[cç][aã]o\b",
            r"\blicen[cç]a\b",
            r"\balvar[aá]\b",
        ],
        0.80,
    ),
    (
        IntentType.ENRICHMENT,
        [
            r"\bmais\s+sobre\b",
            r"\bdetalhes?\s+d[eao]\b",
            r"\bperfil\s+d[eao]\b",
            r"\binforma[cç][oõ]es?\s+sobre\b",
            r"\bquem\s+[eé]\b",
            r"\bo\s+que\s+[eé]\b",
            r"\bdados?\s+d[eao]\b",
            r"\bcnpj\b",
        ],
        0.80,
    ),
    (
        IntentType.DISCOVERY,
        [
            r"\bencontrar\b",
            r"\bbuscar\b",
            r"\blistar\b",
            r"\bempresas?\s+d[eao]\b",
            r"\bempresas?\s+em\b",
            r"\bprocurar\b",
            r"\bquais?\b",
            r"\bonde\b",
            r"\bmostrar?\b",
            r"\bexibir\b",
        ],
        0.75,
    ),
]

# Entity extraction patterns
_ENTITY_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("city", re.compile(r"\bem\s+([A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]+(?:\s+[A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]+)*)", re.UNICODE)),
    ("segment", re.compile(r"\b(?:setor|segmento|[aá]rea)\s+(?:de\s+)?(.+?)(?:\s+em\b|\s+no\b|\s+na\b|$)", re.IGNORECASE | re.UNICODE)),
    ("company_name", re.compile(r"(?:empresa|companhia)\s+([A-Z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF\s&.]+)", re.UNICODE)),
    ("cnpj", re.compile(r"\b(\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2})\b")),
    ("person_name", re.compile(r"(?:s[oó]cios?\s+d[eao]|perfil\s+d[eao]|quem\s+[eé])\s+([A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]+(?:\s+[A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]+)+)", re.UNICODE)),
]

# Filter extraction patterns
_FILTER_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("cidade", re.compile(r"\bem\s+([A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]+(?:\s+[A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]+)*)", re.UNICODE)),
    ("estado", re.compile(r"\b(?:estado\s+d[eao]\s+|no\s+|em\s+)([A-Z]{2})\b")),
    ("segmento", re.compile(r"\b(?:setor|segmento|[aá]rea)\s+(?:de\s+)?(.+?)(?:\s+em\b|\s+no\b|\s+na\b|$)", re.IGNORECASE | re.UNICODE)),
    ("porte", re.compile(r"\b(micro|pequen[ao]|m[eé]di[ao]|grande)\s*(?:empresa|porte)?\b", re.IGNORECASE)),
]


# ===========================================
# PATTERN-BASED CLASSIFICATION
# ===========================================


def _extract_entities(query: str) -> list[str]:
    """Extract named entities from the query using regex patterns."""
    entities: list[str] = []
    for _label, pattern in _ENTITY_PATTERNS:
        match = pattern.search(query)
        if match:
            entity = match.group(1).strip()
            if entity and entity not in entities:
                entities.append(entity)
    return entities


def _extract_filters(query: str) -> dict[str, str]:
    """Extract structured filters from the query."""
    filters: dict[str, str] = {}
    for key, pattern in _FILTER_PATTERNS:
        match = pattern.search(query)
        if match:
            value = match.group(1).strip()
            if value:
                filters[key] = value
    return filters


def _classify_by_pattern(query: str) -> IntentResult:
    """
    Classify intent using regex pattern matching.

    Returns IntentResult with method='pattern'. Confidence is boosted
    when multiple patterns match for the same intent or when entities
    are extracted.
    """
    query_lower = query.lower()

    best_intent = IntentType.UNKNOWN
    best_confidence = 0.0
    best_match_count = 0

    for intent_type, patterns, base_confidence in _INTENT_PATTERNS:
        match_count = 0
        for pattern_str in patterns:
            if re.search(pattern_str, query_lower):
                match_count += 1

        if match_count == 0:
            continue

        # Boost confidence for multiple pattern matches (up to +0.15)
        confidence_boost = min(0.15, (match_count - 1) * 0.05)
        confidence = min(1.0, base_confidence + confidence_boost)

        if confidence > best_confidence or (
            confidence == best_confidence and match_count > best_match_count
        ):
            best_intent = intent_type
            best_confidence = confidence
            best_match_count = match_count

    entities = _extract_entities(query)
    filters = _extract_filters(query)

    # Boost confidence slightly when entities are found
    if entities and best_intent != IntentType.UNKNOWN:
        best_confidence = min(1.0, best_confidence + 0.05)

    logger.debug(
        "pattern_classification",
        query=query[:80],
        intent=best_intent.value,
        confidence=best_confidence,
        match_count=best_match_count,
        entities=entities,
    )

    return IntentResult(
        intent=best_intent.value,
        confidence=round(best_confidence, 2),
        entities=entities,
        filters=filters,
        method="pattern",
    )


# ===========================================
# LLM FALLBACK
# ===========================================


async def _classify_by_llm(query: str) -> IntentResult:
    """
    Classify intent using Claude Haiku via llm_client.

    Called when pattern-based confidence is below threshold (0.7).
    """
    valid_intents = [t.value for t in IntentType if t != IntentType.UNKNOWN]

    user_prompt = (
        f"Classify the following user query into one of these intent types: "
        f"{', '.join(valid_intents)}.\n\n"
        f"Query: \"{query}\"\n\n"
        f"Respond with a JSON object containing:\n"
        f"- intent: one of the intent types listed above\n"
        f"- confidence: float between 0.0 and 1.0\n"
        f"- entities: list of extracted entity strings\n"
        f"- filters: dict of extracted filters (e.g., cidade, segmento)\n\n"
        f"Respond ONLY with the JSON object, no other text."
    )

    try:
        raw_response: str = await call_llm(
            system_prompt=INTENT_CLASSIFICATION_SYSTEM,
            user_prompt=user_prompt,
            model="haiku",
        )

        # Parse JSON from response (handle markdown code blocks)
        cleaned = raw_response.strip()
        if cleaned.startswith("```"):
            # Remove ```json ... ``` wrapper
            lines = cleaned.split("\n")
            cleaned = "\n".join(lines[1:-1])

        parsed = json.loads(cleaned)

        intent_value = parsed.get("intent", IntentType.UNKNOWN.value)
        # Validate intent is a known type
        if intent_value not in [t.value for t in IntentType]:
            intent_value = IntentType.UNKNOWN.value

        confidence = float(parsed.get("confidence", 0.5))
        confidence = max(0.0, min(1.0, confidence))

        entities = parsed.get("entities", [])
        if not isinstance(entities, list):
            entities = []
        entities = [str(e) for e in entities]

        filters = parsed.get("filters", {})
        if not isinstance(filters, dict):
            filters = {}
        filters = {str(k): str(v) for k, v in filters.items()}

        logger.info(
            "llm_classification",
            query=query[:80],
            intent=intent_value,
            confidence=confidence,
            entities=entities,
        )

        return IntentResult(
            intent=intent_value,
            confidence=round(confidence, 2),
            entities=entities,
            filters=filters,
            method="llm",
        )

    except json.JSONDecodeError as e:
        logger.error(
            "llm_classification_json_error",
            query=query[:80],
            error=str(e),
            raw_response=raw_response[:200] if raw_response else "empty",
        )
        return IntentResult(
            intent=IntentType.UNKNOWN.value,
            confidence=0.0,
            entities=[],
            filters={},
            method="llm",
        )
    except Exception as e:
        logger.error(
            "llm_classification_error",
            query=query[:80],
            error=str(e),
        )
        # Fall back to UNKNOWN on LLM failure
        return IntentResult(
            intent=IntentType.UNKNOWN.value,
            confidence=0.0,
            entities=[],
            filters={},
            method="llm",
        )


# ===========================================
# MAIN CLASSIFIER
# ===========================================

PATTERN_CONFIDENCE_THRESHOLD = 0.7


async def classify_intent(query: str) -> IntentResult:
    """
    Classify a user query into an intent type.

    Strategy:
    1. Try fast pattern-based classification first
    2. If confidence >= 0.7, return pattern result immediately
    3. If confidence < 0.7, fall back to Claude Haiku via llm_client

    Args:
        query: The user's natural language query

    Returns:
        IntentResult with intent, confidence, entities, filters, and method
    """
    if not query or not query.strip():
        logger.warning("classify_intent_empty_query")
        return IntentResult(
            intent=IntentType.UNKNOWN.value,
            confidence=0.0,
            entities=[],
            filters={},
            method="pattern",
        )

    query = query.strip()

    # Phase 1: Pattern-based classification (fast, no API call)
    pattern_result = _classify_by_pattern(query)

    if pattern_result.confidence >= PATTERN_CONFIDENCE_THRESHOLD:
        logger.info(
            "intent_classified",
            query=query[:80],
            intent=pattern_result.intent,
            confidence=pattern_result.confidence,
            method="pattern",
        )
        return pattern_result

    # Phase 2: LLM fallback (Claude Haiku)
    logger.info(
        "pattern_low_confidence_falling_back_to_llm",
        query=query[:80],
        pattern_intent=pattern_result.intent,
        pattern_confidence=pattern_result.confidence,
    )

    llm_result = await _classify_by_llm(query)

    # If LLM also fails, prefer pattern result if it had any match
    if llm_result.intent == IntentType.UNKNOWN.value and pattern_result.intent != IntentType.UNKNOWN.value:
        logger.info(
            "llm_failed_using_pattern_fallback",
            pattern_intent=pattern_result.intent,
            pattern_confidence=pattern_result.confidence,
        )
        return pattern_result

    logger.info(
        "intent_classified",
        query=query[:80],
        intent=llm_result.intent,
        confidence=llm_result.confidence,
        method="llm",
    )
    return llm_result
