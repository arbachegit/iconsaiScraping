"""
Multi-model LLM client supporting Claude (Anthropic) and OpenAI APIs.

Uses httpx directly (no SDK dependencies) for minimal footprint.
Dispatches to the correct API based on model shortcut.

Supported shortcuts:
    - "haiku"      -> claude-haiku-4-5-20251001
    - "sonnet"     -> claude-sonnet-4-6-20250320
    - "gpt-4o-mini" -> gpt-4o-mini
    - "gpt-4o"     -> gpt-4o
"""

import os
import time
from typing import Any

import httpx
import structlog

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------

MODEL_ALIASES: dict[str, str] = {
    "haiku": "claude-haiku-4-5-20251001",
    "sonnet": "claude-sonnet-4-6-20250320",
    "gpt-4o-mini": "gpt-4o-mini",
    "gpt-4o": "gpt-4o",
}

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_API_VERSION = "2023-06-01"
OPENAI_API_URL = "https://api.openai.com/v1"

# Timeout: 60s connect, 120s read (LLM responses can be slow)
_TIMEOUT = httpx.Timeout(connect=60.0, read=120.0, write=30.0, pool=30.0)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_model(model: str) -> str:
    """Resolve a shortcut to its full model identifier."""
    return MODEL_ALIASES.get(model, model)


def _is_anthropic(model: str) -> bool:
    """Return True if the resolved model belongs to Anthropic (Claude)."""
    return model.startswith("claude")


def _get_api_key(provider: str) -> str:
    """Fetch the API key from environment, raising clearly on absence."""
    env_var = "ANTHROPIC_API_KEY" if provider == "anthropic" else "OPENAI_API_KEY"
    key = os.getenv(env_var)
    if not key:
        raise EnvironmentError(
            f"Missing {env_var}. Set it as an environment variable."
        )
    return key


# ---------------------------------------------------------------------------
# Core: call_llm
# ---------------------------------------------------------------------------

async def call_llm(
    model: str,
    system_prompt: str,
    user_prompt: str,
    temperature: float = 0.3,
    max_tokens: int = 2000,
) -> dict[str, Any]:
    """
    Send a prompt to the appropriate LLM and return a standardised response.

    Args:
        model: Model shortcut ("haiku", "sonnet", "gpt-4o-mini", "gpt-4o")
               or a full model identifier.
        system_prompt: System-level instruction for the model.
        user_prompt: The user message / query.
        temperature: Sampling temperature (0.0 - 1.0).
        max_tokens: Maximum tokens in the response.

    Returns:
        dict with keys:
            content       (str)  - The model's text response.
            model         (str)  - Resolved model identifier used.
            usage         (dict) - {input_tokens: int, output_tokens: int}
            latency_ms    (int)  - Wall-clock latency in milliseconds.
    """
    resolved = _resolve_model(model)

    if _is_anthropic(resolved):
        return await _call_anthropic(
            resolved, system_prompt, user_prompt, temperature, max_tokens
        )
    return await _call_openai(
        resolved, system_prompt, user_prompt, temperature, max_tokens
    )


# ---------------------------------------------------------------------------
# Anthropic (Claude)
# ---------------------------------------------------------------------------

async def _call_anthropic(
    model: str,
    system_prompt: str,
    user_prompt: str,
    temperature: float,
    max_tokens: int,
) -> dict[str, Any]:
    """Call the Anthropic Messages API."""
    api_key = _get_api_key("anthropic")

    headers = {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
    }

    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }

    start = time.perf_counter()

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            response = await client.post(
                ANTHROPIC_API_URL, headers=headers, json=payload
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.error(
                "anthropic_api_error",
                status=exc.response.status_code,
                body=exc.response.text[:500],
                model=model,
            )
            raise
        except httpx.RequestError as exc:
            logger.error(
                "anthropic_request_error",
                error=str(exc),
                model=model,
            )
            raise

    latency_ms = int((time.perf_counter() - start) * 1000)
    data = response.json()

    # Anthropic returns content as a list of blocks; take the first text block.
    content_blocks = data.get("content", [])
    text = ""
    for block in content_blocks:
        if block.get("type") == "text":
            text = block.get("text", "")
            break

    usage_raw = data.get("usage", {})

    result = {
        "content": text,
        "model": data.get("model", model),
        "usage": {
            "input_tokens": usage_raw.get("input_tokens", 0),
            "output_tokens": usage_raw.get("output_tokens", 0),
        },
        "latency_ms": latency_ms,
    }

    logger.info(
        "llm_call_complete",
        provider="anthropic",
        model=model,
        input_tokens=result["usage"]["input_tokens"],
        output_tokens=result["usage"]["output_tokens"],
        latency_ms=latency_ms,
    )

    return result


# ---------------------------------------------------------------------------
# OpenAI
# ---------------------------------------------------------------------------

async def _call_openai(
    model: str,
    system_prompt: str,
    user_prompt: str,
    temperature: float,
    max_tokens: int,
) -> dict[str, Any]:
    """Call the OpenAI Chat Completions API."""
    api_key = _get_api_key("openai")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }

    start = time.perf_counter()

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            response = await client.post(
                f"{OPENAI_API_URL}/chat/completions",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.error(
                "openai_api_error",
                status=exc.response.status_code,
                body=exc.response.text[:500],
                model=model,
            )
            raise
        except httpx.RequestError as exc:
            logger.error(
                "openai_request_error",
                error=str(exc),
                model=model,
            )
            raise

    latency_ms = int((time.perf_counter() - start) * 1000)
    data = response.json()

    choices = data.get("choices", [])
    text = choices[0]["message"]["content"] if choices else ""

    usage_raw = data.get("usage", {})

    result = {
        "content": text,
        "model": data.get("model", model),
        "usage": {
            "input_tokens": usage_raw.get("prompt_tokens", 0),
            "output_tokens": usage_raw.get("completion_tokens", 0),
        },
        "latency_ms": latency_ms,
    }

    logger.info(
        "llm_call_complete",
        provider="openai",
        model=model,
        input_tokens=result["usage"]["input_tokens"],
        output_tokens=result["usage"]["output_tokens"],
        latency_ms=latency_ms,
    )

    return result


# ---------------------------------------------------------------------------
# Embeddings
# ---------------------------------------------------------------------------

async def generate_embedding(
    text: str,
    model: str = "text-embedding-3-small",
) -> list[float]:
    """
    Generate a vector embedding for the given text via OpenAI Embeddings API.

    Args:
        text: The input text to embed.
        model: OpenAI embedding model identifier.

    Returns:
        A list of floats representing the embedding vector.
    """
    api_key = _get_api_key("openai")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": model,
        "input": text,
    }

    start = time.perf_counter()

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            response = await client.post(
                f"{OPENAI_API_URL}/embeddings",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.error(
                "embedding_api_error",
                status=exc.response.status_code,
                body=exc.response.text[:500],
                model=model,
            )
            raise
        except httpx.RequestError as exc:
            logger.error(
                "embedding_request_error",
                error=str(exc),
                model=model,
            )
            raise

    latency_ms = int((time.perf_counter() - start) * 1000)
    data = response.json()

    embedding: list[float] = data["data"][0]["embedding"]
    tokens_used: int = data.get("usage", {}).get("total_tokens", 0)

    logger.info(
        "embedding_complete",
        model=model,
        dimensions=len(embedding),
        tokens=tokens_used,
        latency_ms=latency_ms,
    )

    return embedding
